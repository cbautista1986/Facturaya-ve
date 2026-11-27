// Motor de Mantenimiento Nocturno Automático (2:00 AM VET) y Modo Mantenimiento para Despliegues (v5.0.0).
// Reglas inquebrantables:
// - De 6:00 AM a 9:00 PM (hora Caracas UTC-4) NUNCA corre mantenimiento pesado ni respaldos automáticos.
// - Las rutinas de auto-sanación JAMÁS modifican ni borran facturas, notas, pagos ni compras reales (SENIAT).
// - El Modo Mantenimiento para Despliegues revoca sesiones de todas las empresas EXCEPTO el Súper Administrador.
import { consultarDesplieguesYBuilds, leerConfigCloudflare, sincronizarBindingsD1Cloudflare } from "./cloudflare-api";
import { ahora, fechaCaracas } from "./comun";
import { enviarCorreo } from "./correo";
import { CODIGO_DEMO, limpiarDemoExpiradaSiCorresponde, obtenerDbDemoAislada } from "./demo";
import {
  asegurarTablasMultiTenant,
  hidratarBindingsCloudflare,
  obtenerDbInquilino,
  obtenerSuperAdminPrincipal,
} from "./inquilinos";
import { migrar } from "./migraciones";
import { emailSuperAdminConfig } from "./permisos";
import { recifrarSecretosHeredados } from "./recifrado";
import { archivarRetencionR2, ejecutarRespaldoR2, intentarArchivoMensualR2, intentarRespaldoDiarioR2, obtenerBucketR2 } from "./respaldos-r2";
import { diagnosticarInquilino, repararInquilino } from "./salud-bd";
import { ejecutarCobroAutomaticoDia1 } from "./suscripciones";
import { intentarCierreMensualAutomatico, mesAnteriorCaracas, obtenerTasaBcvGlobal } from "./tasa-bcv";

export const HORA_INICIO_DIURNO_VET = 6;  // 6:00 AM Caracas
export const HORA_FIN_DIURNO_VET = 21;    // 9:00 PM Caracas (exclusive -> 06:00..20:59 es horario diurno protegido)
export const CRON_MANTENIMIENTO_NOCTURNO = "0 6 * * *"; // 2:00 AM hora Venezuela (UTC-4)
export const CRON_MANTENIMIENTO_NOCTURNO_LOTES = "15,30,45 6 * * *"; // Continuación por lotes 2:15/2:30/2:45 AM VET (escala 100+ empresas)
export const MAX_EMPRESAS_LOTE_NOCTURNO = 25;
export const MAX_LOTES_NOCTURNO_DIA = 4; // 4 ticks/noche × 25 = 100 empresas/noche con rotación circular multi-día
const CLAVE_CURSOR_NOCTURNO = "mant_nocturno_cursor";
const CLAVE_ROTACION_NOCTURNA = "mant_nocturno_rotacion";
export const MAX_DIAS_SIN_RESPALDO_ALERTA = 2;
export const MENSAJE_MANTENIMIENTO_DEFECTO =
  "Estamos realizando una actualización programada de FacturaYa Venezuela para mantener el sistema rápido y al día. Volvemos en unos minutos; tus facturas y datos están 100% seguros.";

export type EtapaDespliegue =
  | "NORMAL"
  | "SESIONES_CERRADAS"
  | "DESPLEGANDO"
  | "VERIFICADO_OK"
  | "SESIONES_LISTAS";

export type ModoCorreoResumen = "SOLO_ALERTAS" | "SIEMPRE" | "DESACTIVADO";

export type EstadoMantenimientoDespliegue = {
  activo: boolean;
  etapa: EtapaDespliegue;
  mensaje: string;
  activado_en: string;
  activado_por: string;
  desactivado_en: string;
  sesiones_cerradas_total: number;
  empresas_cerradas: number;
  ultimo_build_uuid: string;
  ultimo_build_estado: string;
  correo_resumen_modo: ModoCorreoResumen;
};

export type RegistroMantenimientoLog = {
  id: number;
  tipo: "NOCTURNO_AUTO" | "NOCTURNO_MANUAL" | "DESPLIEGUE_INICIO" | "DESPLIEGUE_FIN" | "BINDINGS_SYNC";
  estado: "OK" | "ADVERTENCIA" | "ERROR";
  iniciado_en: string;
  finalizado_en: string;
  duracion_ms: number;
  empresas_revisadas: number;
  empresas_sanas: number;
  bindings_sanados: number;
  respaldos_ok: number;
  sesiones_purgadas: number;
  alertas_count: number;
  resumen: string;
  detalle_json: string;
};

// Hora actual (0..23) en Caracas (UTC-4, Venezuela no cambia horario de verano)
export function horaCaracas(fecha: Date = new Date()): number {
  const msCaracas = fecha.getTime() - 4 * 3600 * 1000;
  return new Date(msCaracas).getUTCHours();
}

// Devuelve true entre 6:00 AM y 8:59 PM hora de Venezuela (horario comercial protegido sin tareas pesadas)
export function esHorarioDiurnoCaracas(fecha: Date = new Date()): boolean {
  const h = horaCaracas(fecha);
  return h >= HORA_INICIO_DIURNO_VET && h < HORA_FIN_DIURNO_VET;
}

// Determina si una invocación de Cron corresponde a la ventana de mantenimiento nocturno (2:00..2:45 AM VET)
export function esCronMantenimientoNocturno(cronExpr?: string, fecha: Date = new Date()): boolean {
  const c = String(cronExpr || "").trim();
  if (c === CRON_MANTENIMIENTO_NOCTURNO || c === CRON_MANTENIMIENTO_NOCTURNO_LOTES) return true;
  if (c) return false;
  // Fallback por hora Caracas (ventana contractual 1:00 AM - 4:59 AM VET)
  const h = horaCaracas(fecha);
  return h >= 1 && h < 5;
}

// Micro-caché en memoria de Isolate (15 segundos, v5.6 · Sección 9.3) para validar Modo Mantenimiento en el middleware con latencia ~0ms
const CACHE_MANT_TTL_MS = 15_000;
const cacheMantPorDb = new WeakMap<D1Database, { ts: number; estado: EstadoMantenimientoDespliegue }>();

export function invalidarCacheMantenimiento(rawDb?: D1Database) {
  if (rawDb) cacheMantPorDb.delete(rawDb);
}

const ESTADO_MANT_DEFECTO: EstadoMantenimientoDespliegue = {
  activo: false,
  etapa: "NORMAL",
  mensaje: MENSAJE_MANTENIMIENTO_DEFECTO,
  activado_en: "",
  activado_por: "",
  desactivado_en: "",
  sesiones_cerradas_total: 0,
  empresas_cerradas: 0,
  ultimo_build_uuid: "",
  ultimo_build_estado: "",
  correo_resumen_modo: "SOLO_ALERTAS",
};

export async function leerEstadoMantenimiento(
  rawDb: D1Database,
  opts?: { omitirCache?: boolean }
): Promise<EstadoMantenimientoDespliegue> {
  const ahoraMs = Date.now();
  if (!opts?.omitirCache) {
    const cached = cacheMantPorDb.get(rawDb);
    if (cached && ahoraMs - cached.ts < CACHE_MANT_TTL_MS) {
      return cached.estado;
    }
  }
  const fila = await rawDb
    .prepare(
      `SELECT activo, etapa, mensaje, activado_en, activado_por, desactivado_en,
              sesiones_cerradas_total, empresas_cerradas, ultimo_build_uuid, ultimo_build_estado, correo_resumen_modo
       FROM _mt_mantenimiento_estado WHERE id = 1`
    )
    .first<Record<string, unknown>>()
    .catch(() => null);

  const etapaRaw = String(fila?.etapa || "NORMAL").toUpperCase();
  const etapa: EtapaDespliegue =
    etapaRaw === "SESIONES_CERRADAS" ||
    etapaRaw === "DESPLEGANDO" ||
    etapaRaw === "VERIFICADO_OK" ||
    etapaRaw === "SESIONES_LISTAS"
      ? etapaRaw
      : "NORMAL";
  const modoRaw = String(fila?.correo_resumen_modo || "SOLO_ALERTAS").toUpperCase();
  const correo_resumen_modo: ModoCorreoResumen =
    modoRaw === "SIEMPRE" || modoRaw === "DESACTIVADO" ? modoRaw : "SOLO_ALERTAS";

  const estado: EstadoMantenimientoDespliegue = fila
    ? {
        activo: Number(fila.activo ?? 0) === 1,
        etapa,
        mensaje: String(fila.mensaje || "").trim() || MENSAJE_MANTENIMIENTO_DEFECTO,
        activado_en: String(fila.activado_en || ""),
        activado_por: String(fila.activado_por || ""),
        desactivado_en: String(fila.desactivado_en || ""),
        sesiones_cerradas_total: Number(fila.sesiones_cerradas_total || 0),
        empresas_cerradas: Number(fila.empresas_cerradas || 0),
        ultimo_build_uuid: String(fila.ultimo_build_uuid || ""),
        ultimo_build_estado: String(fila.ultimo_build_estado || ""),
        correo_resumen_modo,
      }
    : { ...ESTADO_MANT_DEFECTO };

  cacheMantPorDb.set(rawDb, { ts: ahoraMs, estado });
  return estado;
}

export async function guardarLogMantenimiento(
  rawDb: D1Database,
  entrada: Omit<RegistroMantenimientoLog, "id">
): Promise<void> {
  await asegurarTablasMultiTenant(rawDb);
  await rawDb
    .prepare(
      `INSERT INTO _mt_mantenimiento_logs
       (tipo, estado, iniciado_en, finalizado_en, duracion_ms, empresas_revisadas, empresas_sanas, bindings_sanados, respaldos_ok, sesiones_purgadas, alertas_count, resumen, detalle_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      entrada.tipo,
      entrada.estado,
      entrada.iniciado_en,
      entrada.finalizado_en,
      Math.max(0, Math.round(entrada.duracion_ms)),
      entrada.empresas_revisadas,
      entrada.empresas_sanas,
      entrada.bindings_sanados,
      entrada.respaldos_ok,
      entrada.sesiones_purgadas,
      entrada.alertas_count,
      entrada.resumen.slice(0, 400),
      entrada.detalle_json.slice(0, 60_000)
    )
    .run()
    .catch(() => {});

  // Conservar últimos 90 días de logs de mantenimiento
  await rawDb
    .prepare(`DELETE FROM _mt_mantenimiento_logs WHERE iniciado_en < datetime('now', '-90 days')`)
    .run()
    .catch(() => {});
}

export async function listarLogsMantenimiento(rawDb: D1Database, limite = 30): Promise<RegistroMantenimientoLog[]> {
  await asegurarTablasMultiTenant(rawDb);
  const lim = Math.max(1, Math.min(100, Math.trunc(limite) || 30));
  const { results } = await rawDb
    .prepare(`SELECT * FROM _mt_mantenimiento_logs ORDER BY id DESC LIMIT ?`)
    .bind(lim)
    .all<RegistroMantenimientoLog>()
    .catch(() => ({ results: [] as RegistroMantenimientoLog[] }));
  return results || [];
}

export async function configurarCorreoResumenMantenimiento(
  rawDb: D1Database,
  modo: ModoCorreoResumen
): Promise<EstadoMantenimientoDespliegue> {
  await asegurarTablasMultiTenant(rawDb);
  const m: ModoCorreoResumen = modo === "SIEMPRE" || modo === "DESACTIVADO" ? modo : "SOLO_ALERTAS";
  await rawDb
    .prepare(
      `INSERT INTO _mt_mantenimiento_estado (id, correo_resumen_modo, actualizado_en) VALUES (1, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET correo_resumen_modo = excluded.correo_resumen_modo, actualizado_en = excluded.actualizado_en`
    )
    .bind(m)
    .run();
  invalidarCacheMantenimiento(rawDb);
  return leerEstadoMantenimiento(rawDb, { omitirCache: true });
}

// ============================================================================
// INTERRUPTOR «MODO MANTENIMIENTO PARA DESPLIEGUES» (Cierra sesiones menos Súper Admin)
// ============================================================================
export async function activarModoMantenimientoDespliegue(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  opts: { emailSuper: string; mensaje?: string }
): Promise<{ estado: EstadoMantenimientoDespliegue; sesiones_cerradas: number; empresas_procesadas: number; errores_empresas: string[] }> {
  const t0 = Date.now();
  const iniciadoEn = new Date().toISOString();
  await asegurarTablasMultiTenant(rawDb);
  await hidratarBindingsCloudflare(rawDb, envObj);

  const msg = String(opts.mensaje || "").trim().slice(0, 280) || MENSAJE_MANTENIMIENTO_DEFECTO;

  // 1) Activar bloqueo de mantenimiento PRIMERO (fail-closed inmediato para todos los demás usuarios)
  await rawDb
    .prepare(
      `INSERT INTO _mt_mantenimiento_estado (id, activo, etapa, mensaje, activado_en, activado_por, sesiones_cerradas_total, empresas_cerradas, actualizado_en)
       VALUES (1, 1, 'SESIONES_CERRADAS', ?, ?, ?, 0, 0, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         activo = 1,
         etapa = 'SESIONES_CERRADAS',
         mensaje = excluded.mensaje,
         activado_en = excluded.activado_en,
         activado_por = excluded.activado_por,
         actualizado_en = excluded.actualizado_en`
    )
    .bind(msg, iniciadoEn, opts.emailSuper.toLowerCase())
    .run();
  invalidarCacheMantenimiento(rawDb);

  // 2) Revocar sesiones activas de TODAS las empresas excepto usuarios SUPER_ADMIN
  const { results: inqs } = await rawDb
    .prepare(`SELECT codigo FROM _mt_inquilinos ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en ASC`)
    .all<{ codigo: string }>()
    .catch(() => ({ results: [{ codigo: "principal" }] }));

  const correosSuperProtegidos = Array.from(
    new Set(
      [String(opts.emailSuper || "").trim().toLowerCase(), emailSuperAdminConfig(envObj)].filter(Boolean)
    )
  );
  const clausulaSuper = correosSuperProtegidos.length
    ? `rol = 'SUPER_ADMIN' OR LOWER(email) IN (${correosSuperProtegidos.map(() => "?").join(", ")})`
    : `rol = 'SUPER_ADMIN'`;
  const sqlRevocar = `DELETE FROM sesiones WHERE usuario_id NOT IN (SELECT id FROM usuarios WHERE ${clausulaSuper})`;

  const codigos = inqs.length ? inqs.map((r) => r.codigo) : ["principal"];
  let sesionesCerradas = 0;
  let empresasProcesadas = 0;
  const erroresEmpresas: string[] = [];

  for (const cod of codigos) {
    try {
      const dbInq = cod === "principal" ? rawDb : obtenerDbInquilino({ ...envObj, DB: rawDb }, cod);
      const stmt = dbInq.prepare(sqlRevocar);
      const del = await (correosSuperProtegidos.length ? stmt.bind(...correosSuperProtegidos) : stmt).run();
      sesionesCerradas += Number(del.meta?.changes || 0);
      empresasProcesadas++;
    } catch (e) {
      erroresEmpresas.push(`${cod}: ${(e as Error).message}`);
    }
  }

  // También cerrar sesiones del entorno Demo si está montado
  const dbDemo = obtenerDbDemoAislada(envObj, rawDb);
  if (dbDemo) {
    try {
      const stmtDemo = dbDemo.prepare(sqlRevocar);
      const delDemo = await (correosSuperProtegidos.length ? stmtDemo.bind(...correosSuperProtegidos) : stmtDemo).run();
      sesionesCerradas += Number(delDemo.meta?.changes || 0);
    } catch {
      // Si la Demo está vacía o sin tablas, no es error
    }
  }

  // 3) Actualizar contadores y registrar log
  await rawDb
    .prepare(
      `UPDATE _mt_mantenimiento_estado
       SET sesiones_cerradas_total = ?, empresas_cerradas = ?, actualizado_en = datetime('now')
       WHERE id = 1`
    )
    .bind(sesionesCerradas, empresasProcesadas)
    .run();
  invalidarCacheMantenimiento(rawDb);

  const finalizadoEn = new Date().toISOString();
  await guardarLogMantenimiento(rawDb, {
    tipo: "DESPLIEGUE_INICIO",
    estado: erroresEmpresas.length ? "ADVERTENCIA" : "OK",
    iniciado_en: iniciadoEn,
    finalizado_en: finalizadoEn,
    duracion_ms: Date.now() - t0,
    empresas_revisadas: empresasProcesadas,
    empresas_sanas: empresasProcesadas,
    bindings_sanados: 0,
    respaldos_ok: 0,
    sesiones_purgadas: sesionesCerradas,
    alertas_count: erroresEmpresas.length,
    resumen: `Modo Mantenimiento ACTIVADO por ${opts.emailSuper}: ${sesionesCerradas} sesión(es) cerrada(s) en ${empresasProcesadas} empresa(s). Solo Súper Admin activo.`,
    detalle_json: JSON.stringify({ mensaje: msg, empresas_procesadas: empresasProcesadas, sesiones_cerradas: sesionesCerradas, errores: erroresEmpresas }),
  });

  const estado = await leerEstadoMantenimiento(rawDb, { omitirCache: true });
  return { estado, sesiones_cerradas: sesionesCerradas, empresas_procesadas: empresasProcesadas, errores_empresas: erroresEmpresas };
}

export async function actualizarEtapaDespliegue(
  rawDb: D1Database,
  etapa: EtapaDespliegue,
  extra?: { ultimo_build_uuid?: string; ultimo_build_estado?: string }
): Promise<EstadoMantenimientoDespliegue> {
  await asegurarTablasMultiTenant(rawDb);
  await rawDb
    .prepare(
      `INSERT INTO _mt_mantenimiento_estado (id, etapa, ultimo_build_uuid, ultimo_build_estado, actualizado_en)
       VALUES (1, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         etapa = excluded.etapa,
         ultimo_build_uuid = COALESCE(NULLIF(excluded.ultimo_build_uuid, ''), _mt_mantenimiento_estado.ultimo_build_uuid),
         ultimo_build_estado = COALESCE(NULLIF(excluded.ultimo_build_estado, ''), _mt_mantenimiento_estado.ultimo_build_estado),
         actualizado_en = excluded.actualizado_en`
    )
    .bind(etapa, extra?.ultimo_build_uuid || "", extra?.ultimo_build_estado || "")
    .run();
  invalidarCacheMantenimiento(rawDb);
  return leerEstadoMantenimiento(rawDb, { omitirCache: true });
}

export async function desactivarModoMantenimientoDespliegue(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  opts: { emailSuper: string; sincronizarBindings?: boolean }
): Promise<{ estado: EstadoMantenimientoDespliegue; bindings_sanados: number; aviso_bindings?: string }> {
  const t0 = Date.now();
  const iniciadoEn = new Date().toISOString();
  await asegurarTablasMultiTenant(rawDb);
  const previo = await leerEstadoMantenimiento(rawDb, { omitirCache: true });

  let bindingsSanados = 0;
  let avisoBindings: string | undefined;
  if (opts.sincronizarBindings !== false) {
    const sync = await sincronizarBindingsD1Cloudflare(rawDb, envObj).catch((e) => ({
      ok: false as const,
      cambios: 0,
      enlazados: [] as string[],
      error: (e as Error).message,
    }));
    if (sync.ok) {
      bindingsSanados = sync.cambios;
    } else if (sync.error) {
      avisoBindings = sync.error;
    }
  }

  const finalizadoEn = new Date().toISOString();
  await rawDb
    .prepare(
      `INSERT INTO _mt_mantenimiento_estado (id, activo, etapa, desactivado_en, actualizado_en)
       VALUES (1, 0, 'SESIONES_LISTAS', ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         activo = 0,
         etapa = 'SESIONES_LISTAS',
         desactivado_en = excluded.desactivado_en,
         actualizado_en = excluded.actualizado_en`
    )
    .bind(finalizadoEn)
    .run();
  invalidarCacheMantenimiento(rawDb);

  const durVentanaSeg =
    previo.activado_en && Number.isFinite(Date.parse(previo.activado_en))
      ? Math.max(0, Math.round((Date.now() - Date.parse(previo.activado_en)) / 1000))
      : 0;

  await guardarLogMantenimiento(rawDb, {
    tipo: "DESPLIEGUE_FIN",
    estado: avisoBindings ? "ADVERTENCIA" : "OK",
    iniciado_en: iniciadoEn,
    finalizado_en: finalizadoEn,
    duracion_ms: Date.now() - t0,
    empresas_revisadas: previo.empresas_cerradas,
    empresas_sanas: previo.empresas_cerradas,
    bindings_sanados: bindingsSanados,
    respaldos_ok: 0,
    sesiones_purgadas: 0,
    alertas_count: avisoBindings ? 1 : 0,
    resumen: `Despliegue finalizado y acceso reabierto por ${opts.emailSuper} (ventana: ${durVentanaSeg}s · bindings nativos sanados: ${bindingsSanados}). Sesiones listas para usar.`,
    detalle_json: JSON.stringify({
      duracion_ventana_seg: durVentanaSeg,
      bindings_sanados: bindingsSanados,
      aviso_bindings: avisoBindings || null,
    }),
  });

  const estado = await leerEstadoMantenimiento(rawDb, { omitirCache: true });
  return { estado, bindings_sanados: bindingsSanados, aviso_bindings: avisoBindings };
}

// ============================================================================
// RUTINA DE MANTENIMIENTO NOCTURNO AUTOMÁTICO (2:00 AM VET / Manual Súper Admin)
// ============================================================================
export type ResultadoMantenimientoNocturno = {
  ok: boolean;
  estado: "OK" | "ADVERTENCIA" | "ERROR";
  tipo: "NOCTURNO_AUTO" | "NOCTURNO_MANUAL";
  iniciado_en: string;
  finalizado_en: string;
  duracion_ms: number;
  empresas_revisadas: number;
  empresas_sanas: number;
  bindings_sanados: number;
  respaldos_diarios_ok: number;
  respaldo_mensual_ok: boolean;
  sesiones_purgadas: number;
  demo_limpiada: boolean;
  tasa_bcv_actualizada: number | null;
  estado_despliegue_cf: string;
  alertas: string[];
  acciones_sanacion: string[];
  correo_resumen_enviado: boolean;
  resumen: string;
  lote_parcial?: boolean;
  pendientes_lote?: number;
  pendientes_codigos?: string[];
  omitido_ya_completado?: boolean;
  retencion_archivados?: number;
};

type CursorMantenimientoNocturno = {
  fecha: string;
  offset: number;
  completado: boolean;
  lotes_ejecutados?: number;
  procesadas_hoy?: string[];
  empresas_revisadas: number;
  empresas_sanas: number;
  bindings_sanados: number;
  respaldos_diarios_ok: number;
  sesiones_purgadas: number;
  tasa_bcv_actualizada: number | null;
  tasa_bcv_actualizado_en: string | null;
  estado_despliegue_cf: string;
  alertas: string[];
  acciones_sanacion: string[];
};

type RotacionNocturna = {
  proximo_offset: number;
  ultimo_respaldo_por_empresa: Record<string, string>;
  primera_vista_por_empresa: Record<string, string>;
};

async function leerCursorNocturno(rawDb: D1Database): Promise<CursorMantenimientoNocturno | null> {
  const fila = await rawDb
    .prepare(`SELECT valor FROM integraciones WHERE clave = ?`)
    .bind(CLAVE_CURSOR_NOCTURNO)
    .first<{ valor: string }>()
    .catch(() => null);
  if (!fila?.valor) return null;
  try {
    return JSON.parse(fila.valor) as CursorMantenimientoNocturno;
  } catch {
    return null;
  }
}

async function guardarCursorNocturno(rawDb: D1Database, cursor: CursorMantenimientoNocturno): Promise<void> {
  const ahoraIso = new Date().toISOString();
  await rawDb
    .prepare(
      `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?)
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
    )
    .bind(CLAVE_CURSOR_NOCTURNO, JSON.stringify(cursor), ahoraIso)
    .run()
    .catch(() => {});
}

async function leerRotacionNocturna(rawDb: D1Database): Promise<RotacionNocturna> {
  const fila = await rawDb
    .prepare(`SELECT valor FROM integraciones WHERE clave = ?`)
    .bind(CLAVE_ROTACION_NOCTURNA)
    .first<{ valor: string }>()
    .catch(() => null);
  if (!fila?.valor) return { proximo_offset: 0, ultimo_respaldo_por_empresa: {}, primera_vista_por_empresa: {} };
  try {
    const p = JSON.parse(fila.valor) as Partial<RotacionNocturna>;
    return {
      proximo_offset: Number.isInteger(p?.proximo_offset) && (p.proximo_offset as number) >= 0 ? (p.proximo_offset as number) : 0,
      ultimo_respaldo_por_empresa:
        p?.ultimo_respaldo_por_empresa && typeof p.ultimo_respaldo_por_empresa === "object"
          ? { ...p.ultimo_respaldo_por_empresa }
          : {},
      primera_vista_por_empresa:
        p?.primera_vista_por_empresa && typeof p.primera_vista_por_empresa === "object"
          ? { ...p.primera_vista_por_empresa }
          : {},
    };
  } catch {
    return { proximo_offset: 0, ultimo_respaldo_por_empresa: {}, primera_vista_por_empresa: {} };
  }
}

async function guardarRotacionNocturna(rawDb: D1Database, rot: RotacionNocturna): Promise<void> {
  const ahoraIso = new Date().toISOString();
  await rawDb
    .prepare(
      `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?)
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
    )
    .bind(CLAVE_ROTACION_NOCTURNA, JSON.stringify(rot), ahoraIso)
    .run()
    .catch(() => {});
}

function diasEntreFechasIso(desdeIso: string, hastaIso: string): number {
  const t1 = Date.parse(`${desdeIso.slice(0, 10)}T12:00:00Z`);
  const t2 = Date.parse(`${hastaIso.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 999;
  return Math.round((t2 - t1) / 86_400_000);
}

function fechaHaceMesesIso(hoyIso: string, meses: number): string {
  const d = new Date(`${hoyIso.slice(0, 10)}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - meses);
  return d.toISOString().slice(0, 10);
}

// Archiva en R2 (gzip) auditoria y correo_envios > 12 meses antes de purgar en D1 (v5.6 · Sección 9.4).
// Si R2 no está vinculado o falla la subida, jamás borra registros.
async function archivarRetencionEmpresa(
  dbInq: D1Database,
  envObj: Record<string, unknown>,
  codigo: string,
  hoyIso: string
): Promise<number> {
  const bucket = obtenerBucketR2(envObj);
  if (!bucket) return 0;
  const corte12m = `${fechaHaceMesesIso(hoyIso, 12)} 00:00:00`;
  let totalArchivadas = 0;

  for (const tabla of ["auditoria", "correo_envios"] as const) {
    try {
      const { results: viejas } = await dbInq
        .prepare(`SELECT * FROM ${tabla} WHERE creado_en < ? ORDER BY id ASC LIMIT 1000`)
        .bind(corte12m)
        .all<Record<string, unknown>>();
      if (!viejas?.length) continue;
      await archivarRetencionR2(bucket, codigo, tabla, viejas, hoyIso);
      const ids = viejas.map((r) => Number(r.id)).filter((id) => Number.isInteger(id) && id > 0);
      for (let i = 0; i < ids.length; i += 80) {
        const chunk = ids.slice(i, i + 80);
        await dbInq
          .prepare(`DELETE FROM ${tabla} WHERE id IN (${chunk.map(() => "?").join(",")})`)
          .bind(...chunk)
          .run();
      }
      totalArchivadas += ids.length;
    } catch {
      // Fall-safe: si falla el archivado en R2 o la tabla no existe aún, no borramos nada
    }
  }
  return totalArchivadas;
}

export async function ejecutarMantenimientoNocturno(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  opts?: {
    tipo?: "NOCTURNO_AUTO" | "NOCTURNO_MANUAL";
    hoyIso?: string;
    forzarRespaldo?: boolean;
    fetchFn?: typeof fetch;
    maxEmpresasLote?: number;
    maxLotesDia?: number;
  }
): Promise<ResultadoMantenimientoNocturno> {
  const t0 = Date.now();
  const iniciadoEn = new Date().toISOString();
  const tipo = opts?.tipo === "NOCTURNO_MANUAL" ? "NOCTURNO_MANUAL" : "NOCTURNO_AUTO";
  const hoyIso = opts?.hoyIso || fechaCaracas();
  const diaMes = Number(hoyIso.slice(8, 10));
  const mesAnt = mesAnteriorCaracas(hoyIso);
  const tAhora = ahora();
  const fetchFn = opts?.fetchFn ?? fetch;

  await migrar(rawDb);
  await asegurarTablasMultiTenant(rawDb);

  // En invocaciones automáticas (2:15/2:30/2:45 AM VET), si el mantenimiento de hoy ya terminó, salir en <5ms sin trabajo redundante.
  const cursorPrev = tipo === "NOCTURNO_AUTO" ? await leerCursorNocturno(rawDb) : null;
  if (tipo === "NOCTURNO_AUTO" && cursorPrev?.fecha === hoyIso && cursorPrev.completado === true) {
    const finalizadoEn = new Date().toISOString();
    return {
      ok: true,
      estado: "OK",
      tipo,
      iniciado_en: iniciadoEn,
      finalizado_en: finalizadoEn,
      duracion_ms: Date.now() - t0,
      empresas_revisadas: 0,
      empresas_sanas: 0,
      bindings_sanados: 0,
      respaldos_diarios_ok: 0,
      respaldo_mensual_ok: false,
      sesiones_purgadas: 0,
      demo_limpiada: false,
      tasa_bcv_actualizada: cursorPrev.tasa_bcv_actualizada ?? null,
      estado_despliegue_cf: cursorPrev.estado_despliegue_cf || "SIN_CONECTAR",
      alertas: [],
      acciones_sanacion: [],
      correo_resumen_enviado: false,
      omitido_ya_completado: true,
      resumen: `Mantenimiento nocturno del ${hoyIso} ya completado; lote adicional omitido.`,
    };
  }

  await recifrarSecretosHeredados(rawDb, envObj, rawDb).catch(() => {});
  await hidratarBindingsCloudflare(rawDb, envObj, true);

  const { results: filasInq } = await rawDb
    .prepare(
      `SELECT codigo, tipo_db, nombre_negocio, rif, activo
       FROM _mt_inquilinos
       ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en ASC`
    )
    .all<{ codigo: string; tipo_db: string; nombre_negocio: string; rif: string; activo: number }>()
    .catch(() => ({ results: [{ codigo: "principal", tipo_db: "PRINCIPAL", nombre_negocio: "Negocio Principal", rif: "", activo: 1 }] }));

  const listaOperativa = (
    filasInq.length
      ? filasInq
      : [{ codigo: "principal", tipo_db: "PRINCIPAL", nombre_negocio: "Negocio Principal", rif: "", activo: 1 }]
  ).filter((emp) => emp.codigo !== CODIGO_DEMO);

  const totalOp = listaOperativa.length;
  const rotacion = await leerRotacionNocturna(rawDb);
  const continuarLote =
    tipo === "NOCTURNO_AUTO" &&
    cursorPrev?.fecha === hoyIso &&
    cursorPrev.completado === false &&
    Number.isInteger(cursorPrev.offset);

  const lotesEjecutadosAntes = continuarLote ? Number(cursorPrev!.lotes_ejecutados || 1) : 0;
  const lotesEjecutadosAhora = lotesEjecutadosAntes + 1;
  const maxLotesDia =
    opts?.maxLotesDia && opts.maxLotesDia > 0
      ? Math.trunc(opts.maxLotesDia)
      : MAX_LOTES_NOCTURNO_DIA;

  const procesadasSet = new Set<string>(continuarLote && Array.isArray(cursorPrev!.procesadas_hoy) ? cursorPrev!.procesadas_hoy : []);
  const offsetInicial = continuarLote
    ? ((cursorPrev!.offset % totalOp) + totalOp) % totalOp
    : tipo === "NOCTURNO_AUTO"
      ? ((rotacion.proximo_offset % totalOp) + totalOp) % totalOp
      : 0;

  const tamLote =
    opts?.maxEmpresasLote && opts.maxEmpresasLote > 0
      ? Math.trunc(opts.maxEmpresasLote)
      : tipo === "NOCTURNO_AUTO"
        ? MAX_EMPRESAS_LOTE_NOCTURNO
        : Math.max(1, totalOp);

  // Selección circular multi-día (Opción B · Sección 4): nunca repite empresas ya procesadas hoy y retoma mañana donde quedó
  const sliceEmpresas: typeof listaOperativa = [];
  let cursorCircular = offsetInicial;
  let pasosExplorados = 0;
  while (sliceEmpresas.length < tamLote && pasosExplorados < totalOp && procesadasSet.size + sliceEmpresas.length < totalOp) {
    const cand = listaOperativa[cursorCircular];
    cursorCircular = (cursorCircular + 1) % totalOp;
    pasosExplorados++;
    if (procesadasSet.has(cand.codigo)) continue;
    sliceEmpresas.push(cand);
  }
  for (const e of sliceEmpresas) procesadasSet.add(e.codigo);

  const siguienteOffsetCircular = cursorCircular % totalOp;
  const todasProcesadasHoy = procesadasSet.size >= totalOp;
  const alcanzoTopeDiario = tipo === "NOCTURNO_AUTO" && lotesEjecutadosAhora >= maxLotesDia;
  const esUltimoLote = todasProcesadasHoy || alcanzoTopeDiario;
  const modoLotes = totalOp > tamLote || continuarLote;
  const pendientesCodigos = listaOperativa.filter((e) => !procesadasSet.has(e.codigo)).map((e) => e.codigo);

  const alertas: string[] = continuarLote ? [...(cursorPrev!.alertas || [])] : [];
  const accionesSanacion: string[] = continuarLote ? [...(cursorPrev!.acciones_sanacion || [])] : [];
  let bindingsSanados = continuarLote ? Number(cursorPrev!.bindings_sanados || 0) : 0;
  let sesionesPurgadas = continuarLote ? Number(cursorPrev!.sesiones_purgadas || 0) : 0;
  let empresasRevisadas = continuarLote ? Number(cursorPrev!.empresas_revisadas || 0) : 0;
  let empresasSanas = continuarLote ? Number(cursorPrev!.empresas_sanas || 0) : 0;
  let respaldosDiariosOk = continuarLote ? Number(cursorPrev!.respaldos_diarios_ok || 0) : 0;
  let retencionArchivados = 0;
  let respaldoMensualOk = false;
  let demoLimpiada = false;
  let tasaBcvActualizada: number | null = continuarLote ? (cursorPrev!.tasa_bcv_actualizada ?? null) : null;
  let tasaBcvActualizadoEn: string | null = continuarLote ? (cursorPrev!.tasa_bcv_actualizado_en ?? null) : null;
  let estadoDespliegueCf = continuarLote ? (cursorPrev!.estado_despliegue_cf || "SIN_CONECTAR") : "SIN_CONECTAR";

  // 1) Sincronizar Bindings Nativos D1 y revisar builds en Cloudflare (solo en el primer lote de la noche)
  if (!continuarLote) {
    const cfgCf = await leerConfigCloudflare(rawDb, envObj);
    if (cfgCf.configurado) {
      const syncRes = await sincronizarBindingsD1Cloudflare(rawDb, envObj, undefined, fetchFn).catch((e) => ({
        ok: false as const,
        cambios: 0,
        enlazados: [] as string[],
        error: (e as Error).message,
      }));
      if (syncRes.ok) {
        bindingsSanados = syncRes.cambios;
        if (syncRes.cambios > 0) {
          accionesSanacion.push(`Auto-enlace Nativo D1 conectado en Cloudflare: ${syncRes.enlazados.join(", ")}`);
        }
      } else if (syncRes.error) {
        alertas.push(`Bindings Cloudflare: ${syncRes.error}`);
      }

      // Revisar salud del último build/despliegue en Cloudflare
      const buildsRes = await consultarDesplieguesYBuilds(rawDb, envObj, fetchFn).catch(() => null);
      if (buildsRes?.configurado) {
        estadoDespliegueCf = buildsRes.estado_general || "SIN_BUILDS";
        if (buildsRes.estado_general === "ERROR_BUILD") {
          const ultimo = buildsRes.builds?.[0];
          if (ultimo && (ultimo.branch || "main") === "main") {
            alertas.push(`Última compilación de producción (main) falló: ${ultimo.commit_message || ultimo.build_uuid}`);
          }
        }
      }
    }

    // 2) Tasa BCV oficial global (1 consulta externa al inicio de la ventana)
    const bcvGlobal = await obtenerTasaBcvGlobal(rawDb, { forzar: true, permitirRed: true }).catch(() => null);
    if (bcvGlobal?.tasa_bcv) {
      const nTasa = Number(bcvGlobal.tasa_bcv);
      tasaBcvActualizada = Number.isFinite(nTasa) && nTasa > 0 ? nTasa : null;
      tasaBcvActualizadoEn = bcvGlobal.actualizado_en || new Date().toISOString();
    }
  }

  // 3) Diagnóstico, auto-sanación NO DESTRUCTIVA, purga de sesiones y PRAGMA optimize en cada BD del lote
  for (const emp of sliceEmpresas) {
    empresasRevisadas++;
    try {
      const dbInq = emp.codigo === "principal" ? rawDb : obtenerDbInquilino({ ...envObj, DB: rawDb }, emp.codigo);
      await migrar(dbInq).catch(() => {});
      await recifrarSecretosHeredados(dbInq, envObj, rawDb).catch(() => {});

      // Purga de sesiones expiradas e intentos de login viejos
      const delSes = await dbInq.prepare(`DELETE FROM sesiones WHERE expira_en < ?`).bind(tAhora).run().catch(() => ({ meta: { changes: 0 } }));
      sesionesPurgadas += Number(delSes.meta?.changes || 0);
      await dbInq.prepare(`DELETE FROM intentos_login WHERE bloqueado_hasta > 0 AND bloqueado_hasta < ?`).bind(tAhora - 86400).run().catch(() => {});

      // Actualizar tasa BCV en empresas en modo AUTOMATICO
      if (tasaBcvActualizada && emp.activo === 1) {
        await dbInq
          .prepare(`UPDATE perfil_emisor SET tasa_bcv = ?, tasa_bcv_fecha = ? WHERE id = 1 AND COALESCE(tasa_bcv_modo, 'AUTOMATICO') = 'AUTOMATICO'`)
          .bind(tasaBcvActualizada, tasaBcvActualizadoEn || new Date().toISOString())
          .run()
          .catch(() => {});
      }

      // Diagnóstico completo de salud SENIAT
      let diag = await diagnosticarInquilino(rawDb, envObj, emp);
      if (diag.reparables > 0) {
        const rep = await repararInquilino(rawDb, envObj, emp.codigo);
        if (rep.acciones.length) {
          accionesSanacion.push(`${emp.codigo}: ${rep.acciones.join("; ")}`);
        }
        diag = rep.diagnostico;
      }

      if (diag.sano) {
        empresasSanas++;
      } else {
        const criticos = diag.problemas.filter((p) => p.nivel === "CRITICO").map((p) => p.mensaje);
        alertas.push(`${emp.codigo} (${emp.nombre_negocio}): ${criticos.join(" | ")}`);
      }

      // Optimizar índices SQLite/D1 de madrugada para máxima velocidad diurna
      await dbInq.prepare(`PRAGMA optimize`).run().catch(() => {});

      // Retención > 12 meses: archivar auditoria y correo_envios en R2 antes de purgar en D1 (Sección 9.4)
      retencionArchivados += await archivarRetencionEmpresa(dbInq, envObj, emp.codigo, hoyIso);

      // Cierre mensual automático (solo días 1–5 en empresas activas, exclusivamente de madrugada)
      if (emp.activo === 1 && diaMes >= 1 && diaMes <= 5) {
        await intentarCierreMensualAutomatico(
          dbInq,
          { ...envObj, __rawDb: rawDb, __inquilinoCodigo: emp.codigo } as unknown as Record<string, string>,
          mesAnt
        ).catch(() => false);
      }
    } catch (e) {
      alertas.push(`${emp.codigo} (${emp.nombre_negocio}): Error de mantenimiento — ${(e as Error).message}`);
    }
  }

  // En modo por lotes (>25 empresas), respaldamos en R2 únicamente el lote actual para mantener CPU/subrequests acotados
  if (modoLotes) {
    const bucketR2 = obtenerBucketR2(envObj);
    if (bucketR2) {
      try {
        const codigosLote = sliceEmpresas.map((e) => e.codigo);
        const rSlice = await ejecutarRespaldoR2(rawDb, envObj, {
          tipo: "diario",
          hoyIso,
          codigos: codigosLote,
          omitirPoda: !esUltimoLote,
        });
        respaldosDiariosOk += rSlice.claves.length;
        // Registrar fecha de respaldo exitoso por empresa (excluyendo las que reportaron error)
        const fallidasSet = new Set((rSlice.errores_empresas || []).map((err) => err.split(":")[0].trim()));
        for (const codOk of codigosLote) {
          if (!fallidasSet.has(codOk)) rotacion.ultimo_respaldo_por_empresa[codOk] = hoyIso;
        }
        if (rSlice.errores_empresas?.length) {
          alertas.push(`Respaldo diario R2 parcial en lote: ${rSlice.errores_empresas.join(" | ")}`);
        }
        if (esUltimoLote) {
          const ahoraIso = new Date().toISOString();
          await rawDb
            .prepare(
              `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('ultimo_respaldo_r2_fecha', ?, ?)
               ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
            )
            .bind(hoyIso, ahoraIso)
            .run()
            .catch(() => {});
          accionesSanacion.push(
            `Respaldo diario R2 por lotes completado: ${respaldosDiariosOk} archivo(s)${rSlice.podados ? ` · ${rSlice.podados} vencido(s) podado(s)` : ""}.`
          );
        }
      } catch (e) {
        alertas.push(`Error en respaldo diario R2 (lote ${lotesEjecutadosAhora}): ${(e as Error).message}`);
      }
    } else if (!continuarLote) {
      alertas.push("Respaldo R2 omitido: el bucket RESPALDOS_R2 no está vinculado.");
    }

    // Persistir avance circular para evitar pérdida de progreso entre ticks
    rotacion.proximo_offset = siguienteOffsetCircular;
    await guardarRotacionNocturna(rawDb, rotacion);

    // Si aún quedan empresas pendientes Y no llegamos al tope diario de ticks, continuar en el siguiente tick de hoy
    if (!esUltimoLote) {
      await guardarCursorNocturno(rawDb, {
        fecha: hoyIso,
        offset: siguienteOffsetCircular,
        completado: false,
        lotes_ejecutados: lotesEjecutadosAhora,
        procesadas_hoy: [...procesadasSet],
        empresas_revisadas: empresasRevisadas,
        empresas_sanas: empresasSanas,
        bindings_sanados: bindingsSanados,
        respaldos_diarios_ok: respaldosDiariosOk,
        sesiones_purgadas: sesionesPurgadas,
        tasa_bcv_actualizada: tasaBcvActualizada,
        tasa_bcv_actualizado_en: tasaBcvActualizadoEn,
        estado_despliegue_cf: estadoDespliegueCf,
        alertas,
        acciones_sanacion: accionesSanacion,
      });
      const pendientes = pendientesCodigos.length;
      const finalizadoEn = new Date().toISOString();
      return {
        ok: true,
        estado: alertas.length > 0 ? "ADVERTENCIA" : "OK",
        tipo,
        iniciado_en: iniciadoEn,
        finalizado_en: finalizadoEn,
        duracion_ms: Date.now() - t0,
        empresas_revisadas: empresasRevisadas,
        empresas_sanas: empresasSanas,
        bindings_sanados: bindingsSanados,
        respaldos_diarios_ok: respaldosDiariosOk,
        respaldo_mensual_ok: false,
        sesiones_purgadas: sesionesPurgadas,
        demo_limpiada: false,
        tasa_bcv_actualizada: tasaBcvActualizada,
        estado_despliegue_cf: estadoDespliegueCf,
        alertas,
        acciones_sanacion: accionesSanacion,
        correo_resumen_enviado: false,
        lote_parcial: true,
        pendientes_lote: pendientes,
        pendientes_codigos: pendientesCodigos,
        retencion_archivados: retencionArchivados,
        resumen: `Lote nocturno parcial (${empresasRevisadas}/${totalOp} empresas procesadas; ${pendientes} pendiente(s) para el siguiente tick).`,
      };
    }
  }

  // 4) Cobro automático SaaS (SOLO día 1 hora Caracas y SOLO empresas con cobro_auto_dia1 = 1; NUNCA suspende)
  if (diaMes === 1) {
    await ejecutarCobroAutomaticoDia1(rawDb, envObj, hoyIso).catch((e) => {
      alertas.push(`Cobro SaaS día 1: ${(e as Error).message}`);
    });
  }

  // 5) Limpieza automática de Entorno Demo expirado
  const resDemo = await limpiarDemoExpiradaSiCorresponde(rawDb, envObj).catch(() => null);
  if (resDemo && typeof resDemo === "object" && "limpiado" in resDemo && (resDemo as { limpiado?: boolean }).limpiado) {
    demoLimpiada = true;
    accionesSanacion.push("Entorno Demo expirado limpiado automáticamente.");
  }

  // 6) Respaldos automáticos en Cloudflare R2 (flujo estándar en 1 pasada para <=25 empresas + archivo mensual 10 años)
  if (!modoLotes) {
    try {
      const rDiario = await intentarRespaldoDiarioR2(rawDb, envObj, hoyIso);
      if (rDiario.ejecutado && rDiario.resultado) {
        respaldosDiariosOk = rDiario.resultado.claves.length;
        const fallidasSet = new Set((rDiario.resultado.errores_empresas || []).map((err) => err.split(":")[0].trim()));
        for (const emp of sliceEmpresas) {
          if (!fallidasSet.has(emp.codigo)) rotacion.ultimo_respaldo_por_empresa[emp.codigo] = hoyIso;
        }
        if (rDiario.resultado.errores_empresas?.length) {
          alertas.push(`Respaldo diario R2 parcial: ${rDiario.resultado.errores_empresas.join(" | ")}`);
        }
        accionesSanacion.push(
          `Respaldo diario R2 completado: ${rDiario.resultado.claves.length} archivo(s) (${Math.round(rDiario.resultado.bytes_totales / 1024)} KB)${rDiario.resultado.podados ? ` · ${rDiario.resultado.podados} vencido(s) podado(s)` : ""}.`
        );
      } else if (rDiario.motivo === "YA_RESPALDADO_HOY") {
        respaldosDiariosOk = empresasRevisadas;
      } else if (rDiario.motivo === "SIN_BUCKET_R2") {
        alertas.push("Respaldo R2 omitido: el bucket RESPALDOS_R2 no está vinculado.");
      }
    } catch (e) {
      alertas.push(`Error en respaldo diario R2: ${(e as Error).message}`);
    }
  }

  // Verificar cobertura de respaldos R2: alertar si alguna empresa activa lleva > 2 días sin respaldo R2 (Sección 4)
  if (obtenerBucketR2(envObj)) {
    const atrasadas: string[] = [];
    for (const emp of listaOperativa) {
      if (emp.activo !== 1) continue;
      if (!rotacion.primera_vista_por_empresa[emp.codigo]) {
        rotacion.primera_vista_por_empresa[emp.codigo] = hoyIso;
      }
      const ult = rotacion.ultimo_respaldo_por_empresa[emp.codigo];
      if (ult) {
        if (diasEntreFechasIso(ult, hoyIso) > MAX_DIAS_SIN_RESPALDO_ALERTA) {
          atrasadas.push(`${emp.codigo} (último: ${ult})`);
        }
      } else {
        const vista = rotacion.primera_vista_por_empresa[emp.codigo];
        if (vista && diasEntreFechasIso(vista, hoyIso) >= MAX_DIAS_SIN_RESPALDO_ALERTA) {
          atrasadas.push(`${emp.codigo} (sin respaldo desde ${vista})`);
        }
      }
    }
    if (atrasadas.length > 0) {
      alertas.push(
        `Empresas activas con más de ${MAX_DIAS_SIN_RESPALDO_ALERTA} días sin respaldo R2 (${atrasadas.length}): ${atrasadas.slice(0, 10).join(", ")}`
      );
    }
  }

  // Persistir rotación circular para la próxima noche (si quedaron pendientes hoy, mañana inicia justo donde quedó)
  rotacion.proximo_offset = todasProcesadasHoy ? 0 : siguienteOffsetCircular;
  await guardarRotacionNocturna(rawDb, rotacion);

  if (pendientesCodigos.length > 0) {
    accionesSanacion.push(
      `Rotación multi-día: ${pendientesCodigos.length} empresa(s) diferida(s) para continuar automáticamente en la próxima ventana nocturna desde offset ${rotacion.proximo_offset}.`
    );
  }

  try {
    const rMensual = await intentarArchivoMensualR2(rawDb, envObj, hoyIso, mesAnt);
    if (rMensual.ejecutado) {
      respaldoMensualOk = true;
      accionesSanacion.push(`Archivo fiscal mensual R2 (${mesAnt}) respaldado para conservación de 10 años.`);
    }
  } catch (e) {
    alertas.push(`Error en archivo fiscal mensual R2: ${(e as Error).message}`);
  }

  // 7) Limpieza de registros de rate-limit vencidos en base principal (_mt_rate_limit)
  await rawDb
    .prepare(`DELETE FROM _mt_rate_limit WHERE bloqueado_hasta <= ? AND (? - ventana_inicio) > 1800`)
    .bind(tAhora, tAhora)
    .run()
    .catch(() => {});

  // Marcar cursor diario como completado para que los ticks de continuación salgan inmediatamente
  if (tipo === "NOCTURNO_AUTO") {
    await guardarCursorNocturno(rawDb, {
      fecha: hoyIso,
      offset: rotacion.proximo_offset,
      completado: true,
      lotes_ejecutados: lotesEjecutadosAhora,
      procesadas_hoy: [...procesadasSet],
      empresas_revisadas: empresasRevisadas,
      empresas_sanas: empresasSanas,
      bindings_sanados: bindingsSanados,
      respaldos_diarios_ok: respaldosDiariosOk,
      sesiones_purgadas: sesionesPurgadas,
      tasa_bcv_actualizada: tasaBcvActualizada,
      tasa_bcv_actualizado_en: tasaBcvActualizadoEn,
      estado_despliegue_cf: estadoDespliegueCf,
      alertas: [],
      acciones_sanacion: [],
    });
  }

  const finalizadoEn = new Date().toISOString();
  const duracionMs = Date.now() - t0;
  const hayErroresCriticos = empresasSanas < empresasRevisadas || alertas.some((a) => /Error en respaldo|Error de mantenimiento/i.test(a));
  const estadoFinal: "OK" | "ADVERTENCIA" | "ERROR" = hayErroresCriticos ? "ERROR" : alertas.length > 0 ? "ADVERTENCIA" : "OK";

  const resumen =
    estadoFinal === "OK"
      ? `✅ Todo óptimo: ${empresasSanas}/${empresasRevisadas} BD sanas · ${respaldosDiariosOk} respaldo(s) R2 · ${bindingsSanados} binding(s) sanados · ${sesionesPurgadas} sesión(es) vencida(s) limpiada(s).`
      : `⚠️ Revisado con ${alertas.length} alerta(s): ${empresasSanas}/${empresasRevisadas} BD sanas · ${respaldosDiariosOk} respaldo(s) R2 · ${bindingsSanados} binding(s) sanados.`;

  const detalle = {
    hoy_caracas: hoyIso,
    estado_despliegue_cf: estadoDespliegueCf,
    tasa_bcv_actualizada: tasaBcvActualizada,
    demo_limpiada: demoLimpiada,
    respaldo_mensual_ok: respaldoMensualOk,
    retencion_archivados: retencionArchivados,
    proximo_offset_rotacion: rotacion.proximo_offset,
    pendientes_codigos: pendientesCodigos,
    acciones_sanacion: accionesSanacion,
    alertas,
  };

  await guardarLogMantenimiento(rawDb, {
    tipo,
    estado: estadoFinal,
    iniciado_en: iniciadoEn,
    finalizado_en: finalizadoEn,
    duracion_ms: duracionMs,
    empresas_revisadas: empresasRevisadas,
    empresas_sanas: empresasSanas,
    bindings_sanados: bindingsSanados,
    respaldos_ok: respaldosDiariosOk,
    sesiones_purgadas: sesionesPurgadas,
    alertas_count: alertas.length,
    resumen,
    detalle_json: JSON.stringify(detalle),
  });

  // 8) Correo resumen al Súper Admin (configurable: SOLO_ALERTAS | SIEMPRE | DESACTIVADO)
  let correoResumenEnviado = false;
  const estadoMant = await leerEstadoMantenimiento(rawDb, { omitirCache: true });
  const debeEnviarCorreo =
    estadoMant.correo_resumen_modo === "SIEMPRE" ||
    (estadoMant.correo_resumen_modo === "SOLO_ALERTAS" && estadoFinal !== "OK");

  if (debeEnviarCorreo) {
    const superAdmin = await obtenerSuperAdminPrincipal(rawDb, envObj);
    if (superAdmin?.email) {
      const escHtml = (s: unknown) =>
        String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
      const icono = estadoFinal === "OK" ? "✅" : estadoFinal === "ADVERTENCIA" ? "⚠️" : "🔴";
      const resMail = await enviarCorreo(rawDb, { ...envObj, __rawDb: rawDb, __inquilinoCodigo: "principal" }, {
        para: superAdmin.email,
        alcance: "PLATAFORMA",
        tipo: "ALERTA",
        inquilinoCodigo: "principal",
        asunto: `${icono} Reporte Mantenimiento Nocturno (${hoyIso}) · FacturaYa Venezuela`,
        html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:580px;margin:0 auto;padding:22px;border:1px solid #dde3ec;border-radius:16px;color:#1f2933">
          <h2 style="margin:0 0 10px;color:#0A1F3C">${icono} Mantenimiento Nocturno · ${escHtml(hoyIso)}</h2>
          <p style="margin:0 0 14px">${escHtml(resumen)}</p>
          <ul style="background:#f8fafd;padding:14px 26px;border-radius:12px;margin:0 0 14px">
            <li><b>Empresas sanas:</b> ${empresasSanas} de ${empresasRevisadas}</li>
            <li><b>Respaldos R2 guardados:</b> ${respaldosDiariosOk}${respaldoMensualOk ? " (+ archivo fiscal mensual 10 años)" : ""}</li>
            <li><b>Bindings Nativos D1 sanados:</b> ${bindingsSanados}</li>
            <li><b>Sesiones vencidas purgadas:</b> ${sesionesPurgadas}</li>
            <li><b>Duración total:</b> ${(duracionMs / 1000).toFixed(2)}s</li>
          </ul>
          ${accionesSanacion.length ? `<p style="margin:0 0 6px"><b>Acciones automáticas realizadas:</b></p><ul>${accionesSanacion.map((a) => `<li>${escHtml(a)}</li>`).join("")}</ul>` : ""}
          ${alertas.length ? `<div style="background:#fef2f2;border:1px solid #fca5a5;padding:12px;border-radius:10px;color:#991b1b"><b>Alertas detectadas:</b><ul>${alertas.map((a) => `<li>${escHtml(a)}</li>`).join("")}</ul></div>` : ""}
          <p style="font-size:12px;color:#64748b;margin-top:16px">FacturaYa Venezuela · Ventana de mantenimiento automático 1:00 AM – 5:00 AM (VET).</p>
        </div>`,
        texto: `${icono} Mantenimiento Nocturno ${hoyIso}\n${resumen}\nAlertas: ${alertas.join(" | ") || "Ninguna"}`,
      }).catch(() => ({ ok: false }));
      correoResumenEnviado = Boolean(resMail?.ok);
    }
  }

  return {
    ok: estadoFinal !== "ERROR",
    estado: estadoFinal,
    tipo,
    iniciado_en: iniciadoEn,
    finalizado_en: finalizadoEn,
    duracion_ms: duracionMs,
    empresas_revisadas: empresasRevisadas,
    empresas_sanas: empresasSanas,
    bindings_sanados: bindingsSanados,
    respaldos_diarios_ok: respaldosDiariosOk,
    respaldo_mensual_ok: respaldoMensualOk,
    sesiones_purgadas: sesionesPurgadas,
    demo_limpiada: demoLimpiada,
    tasa_bcv_actualizada: tasaBcvActualizada,
    estado_despliegue_cf: estadoDespliegueCf,
    alertas,
    acciones_sanacion: accionesSanacion,
    correo_resumen_enviado: correoResumenEnviado,
    pendientes_codigos: pendientesCodigos,
    retencion_archivados: retencionArchivados,
    resumen,
  };
}
