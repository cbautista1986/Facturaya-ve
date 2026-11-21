// Motor de correo de plataforma multi-inquilino (v4.7.0) para FacturaYa Venezuela.
// Maneja cadena de proveedores (Brevo -> Resend -> Zoho ZeptoMail), cuotas UTC, circuito de enfriamiento,
// conteo por inquilino sin limitar, fusible de seguridad, bloqueos por rebote/spam (HMAC-SHA256) y alertas.
import { comparacionConstante, hmacTextoPlataforma } from "./cifrado";
import { asegurarTablasMultiTenant, obtenerDbInquilino } from "./inquilinos";

export const PROVEEDORES_PLATAFORMA = ["BREVO", "RESEND", "ZEPTOMAIL"] as const;
export type ProveedorPlataforma = (typeof PROVEEDORES_PLATAFORMA)[number];

export type AlcanceCorreo = "PLATAFORMA" | "INQUILINO";
export type TipoCorreo = "DOCUMENTO" | "RECIBO" | "CIERRE" | "RECUPERACION" | "ALTA" | "PRUEBA" | "ALERTA" | "GENERAL";

export const CUOTAS_DIARIAS_DEFECTO: Record<ProveedorPlataforma, number> = {
  BREVO: 300,
  RESEND: 100,
  ZEPTOMAIL: 10_000,
};

export const ALERTA_DIARIA_DEFECTO = 100;
export const FUSIBLE_DIARIO_DEFECTO = 500;
export const PAUSA_REBOTE_BLANDO_SEG = 3600; // 1 hora tras 3 rebotes blandos
export const UMBRAL_REBOTES_BLANDOS = 3;

export type CircuitoEstado = {
  proveedor: ProveedorPlataforma;
  abierto_hasta: number;
  fallos_consecutivos: number;
  ultimo_error: string;
  ultimo_estado_http: number;
  actualizado_en?: string;
};

export type ConfigPlataformaCorreo = {
  activo: boolean;
  remitente: string;
  nombre_plataforma: string;
  claves: Record<ProveedorPlataforma, string>;
  cuotas: Record<ProveedorPlataforma, number>;
  proveedores_disponibles: ProveedorPlataforma[];
};

const txtEnv = (env: Record<string, unknown> | undefined, k: string): string =>
  typeof env?.[k] === "string" ? (env[k] as string).trim() : "";

const numEnv = (env: Record<string, unknown> | undefined, k: string, defecto: number): number => {
  const n = Number(env?.[k]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : defecto;
};

export function fechaUtcHoy(ahoraMs = Date.now()): string {
  return new Date(ahoraMs).toISOString().slice(0, 10);
}

export function mesUtcActual(ahoraMs = Date.now()): string {
  return new Date(ahoraMs).toISOString().slice(0, 7);
}

// Enmascara direcciones para paneles y alertas sin exponer correos en texto plano (ej. j***@gmail.com)
export function enmascararCorreo(email: string): string {
  const limpio = String(email ?? "").trim().toLowerCase();
  const idx = limpio.indexOf("@");
  if (idx <= 0) return "***";
  const local = limpio.slice(0, idx);
  const dom = limpio.slice(idx + 1);
  if (local.length <= 2) return `${local[0]}***@${dom}`;
  return `${local[0]}***${local.slice(-1)}@${dom}`;
}

export function leerConfigPlataforma(env?: Record<string, unknown>): ConfigPlataformaCorreo {
  const claves: Record<ProveedorPlataforma, string> = {
    BREVO: txtEnv(env, "BREVO_API_KEY"),
    RESEND: txtEnv(env, "RESEND_API_KEY"),
    ZEPTOMAIL: txtEnv(env, "ZEPTOMAIL_API_KEY"),
  };
  const cuotas: Record<ProveedorPlataforma, number> = {
    BREVO: numEnv(env, "BREVO_CUOTA_DIARIA", CUOTAS_DIARIAS_DEFECTO.BREVO),
    RESEND: numEnv(env, "RESEND_CUOTA_DIARIA", CUOTAS_DIARIAS_DEFECTO.RESEND),
    ZEPTOMAIL: numEnv(env, "ZEPTOMAIL_CUOTA_DIARIA", CUOTAS_DIARIAS_DEFECTO.ZEPTOMAIL),
  };
  const proveedores_disponibles = PROVEEDORES_PLATAFORMA.filter((p) => Boolean(claves[p]));
  const remitente = txtEnv(env, "EMAIL_REMITENTE") || txtEnv(env, "EMAIL_FROM") || "facturas@mail.facturayave.com";
  const nombre_plataforma = txtEnv(env, "EMAIL_NOMBRE_PLATAFORMA") || "FacturaYa Venezuela";
  return {
    activo: proveedores_disponibles.length > 0,
    remitente,
    nombre_plataforma,
    claves,
    cuotas,
    proveedores_disponibles,
  };
}

// Regla pura de selección y failover (Punto 5 + ajuste 90%):
// - Respeta orden estricto BREVO -> RESEND -> ZEPTOMAIL.
// - Salta proveedores con circuito abierto (abierto_hasta > ahoraSeg) o cuota local >= 100%.
// - Si un proveedor llega al 90% de su cuota diaria UTC, lo salta SOLO si existe otro proveedor sano configurado.
//   Si es el último proveedor disponible (ej. solo Brevo configurado), se permite hasta el 100% (o hasta HTTP 429/402).
export function seleccionarCadenaProveedores(
  disponibles: readonly ProveedorPlataforma[],
  usoHoyPorProveedor: Partial<Record<ProveedorPlataforma, number>>,
  circuitos: Partial<Record<ProveedorPlataforma, Pick<CircuitoEstado, "abierto_hasta">>>,
  cuotas: Record<ProveedorPlataforma, number>,
  ahoraSeg = Math.floor(Date.now() / 1000)
): { orden: ProveedorPlataforma[]; omitidos: { proveedor: ProveedorPlataforma; razon: string }[] } {
  const sanos: ProveedorPlataforma[] = [];
  const sobre90: ProveedorPlataforma[] = [];
  const omitidos: { proveedor: ProveedorPlataforma; razon: string }[] = [];

  for (const p of PROVEEDORES_PLATAFORMA) {
    if (!disponibles.includes(p)) continue;
    const circ = circuitos[p];
    if (circ && Number(circ.abierto_hasta || 0) > ahoraSeg) {
      omitidos.push({ proveedor: p, razon: "circuito_abierto" });
      continue;
    }
    const cuota = Math.max(1, Number(cuotas[p] || CUOTAS_DIARIAS_DEFECTO[p]));
    const usados = Math.max(0, Number(usoHoyPorProveedor[p] || 0));
    if (usados >= cuota) {
      omitidos.push({ proveedor: p, razon: "cuota_agotada" });
      continue;
    }
    if (usados >= Math.floor(cuota * 0.9)) {
      sobre90.push(p);
    } else {
      sanos.push(p);
    }
  }

  // Si hay proveedores por debajo del 90%, se priorizan y los >=90% quedan solo como respaldo final.
  // Si no hay ninguno debajo del 90% (ej. solo Brevo a 275/300), se usan los de sobre90 hasta llegar al 100%.
  return { orden: [...sanos, ...sobre90], omitidos };
}

export function clasificarFalloHttpProveedor(status: number): {
  abrirCircuito: boolean;
  segundosEnfriamiento: number;
  esCuota: boolean;
  reintentable: boolean;
} {
  if (status === 429 || status === 402) {
    return { abrirCircuito: true, segundosEnfriamiento: 1800, esCuota: true, reintentable: true };
  }
  if (status === 401 || status === 403) {
    return { abrirCircuito: true, segundosEnfriamiento: 600, esCuota: false, reintentable: true };
  }
  if (status >= 500 || status === 0) {
    return { abrirCircuito: true, segundosEnfriamiento: 300, esCuota: false, reintentable: true };
  }
  return { abrirCircuito: false, segundosEnfriamiento: 0, esCuota: false, reintentable: false };
}

export type PerfilIdentidadCorreo = {
  nombre_razon_social?: string | null;
  rif?: string | null;
  direccion_fiscal?: string | null;
  telefono?: string | null;
  email?: string | null;
};

export function construirIdentidadEnvio(
  alcance: AlcanceCorreo,
  cfgPlat: ConfigPlataformaCorreo,
  perfil: PerfilIdentidadCorreo | null,
  responderAManual?: string
): {
  remitente: string;
  nombreRemitente: string;
  responderA?: string;
  pieHtml: string;
  pieTexto: string;
} {
  const nombrePlat = cfgPlat.nombre_plataforma || "FacturaYa Venezuela";
  if (alcance === "INQUILINO" && perfil?.nombre_razon_social) {
    const nombreNeg = String(perfil.nombre_razon_social).trim();
    const esc = (s: string) =>
      s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
    const detalles = [
      perfil.rif ? `RIF: ${perfil.rif}` : "",
      perfil.telefono ? `Tel: ${perfil.telefono}` : "",
      perfil.direccion_fiscal ? perfil.direccion_fiscal : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const pieHtml = `<div style="margin-top:18px;padding-top:10px;border-top:1px solid #e5ebf2;font-size:11px;color:#6b7785;text-align:center">${
      detalles ? `<div>${esc(nombreNeg)} · ${esc(detalles)}</div>` : ""
    }<div style="margin-top:4px">Enviado mediante ${esc(nombrePlat)} · <a href="https://facturayave.com" style="color:#6b7785;text-decoration:none">facturayave.com</a></div></div>`;
    const pieTexto = `\n---\n${nombreNeg}${detalles ? ` · ${detalles}` : ""}\nEnviado mediante ${nombrePlat} (https://facturayave.com)`;
    return {
      remitente: cfgPlat.remitente,
      nombreRemitente: `${nombreNeg} (vía ${nombrePlat})`,
      responderA: responderAManual?.trim() || perfil.email?.trim() || undefined,
      pieHtml,
      pieTexto,
    };
  }
  return {
    remitente: cfgPlat.remitente,
    nombreRemitente: nombrePlat,
    responderA: responderAManual?.trim() || undefined,
    pieHtml: "",
    pieTexto: "",
  };
}

export function extraerContextoPlataforma(
  db: D1Database,
  env?: Record<string, unknown>,
  inquilinoOpc?: string
): { rawDb: D1Database; inquilinoCodigo: string } {
  const rawDb = (env?.__rawDb && typeof (env.__rawDb as D1Database).prepare === "function"
    ? (env.__rawDb as D1Database)
    : db) as D1Database;
  const inq =
    String(inquilinoOpc || (typeof env?.__inquilinoCodigo === "string" ? env.__inquilinoCodigo : "") || "principal").trim() ||
    "principal";
  return { rawDb, inquilinoCodigo: inq };
}

export async function asegurarEsquemaCorreos(rawDb: D1Database, env?: Record<string, unknown>) {
  await asegurarTablasMultiTenant(rawDb, env);
}

export type ColumnaUsoCorreo =
  | "enviados"
  | "entregados"
  | "fallidos"
  | "rebotes_duros"
  | "rebotes_blandos"
  | "quejas"
  | "bloqueados";

export async function incrementarUsoCorreo(
  rawDb: D1Database,
  proveedor: string,
  inquilinoCodigo: string,
  tipo: string,
  columna: ColumnaUsoCorreo,
  cantidad = 1,
  fechaUtc = fechaUtcHoy()
) {
  const colsPermitidas: ColumnaUsoCorreo[] = [
    "enviados",
    "entregados",
    "fallidos",
    "rebotes_duros",
    "rebotes_blandos",
    "quejas",
    "bloqueados",
  ];
  if (!colsPermitidas.includes(columna) || cantidad <= 0) return;
  await rawDb
    .prepare(
      `INSERT INTO _mt_correos_uso (fecha_utc, proveedor, inquilino_codigo, tipo, ${columna}, actualizado_en)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(fecha_utc, proveedor, inquilino_codigo, tipo)
       DO UPDATE SET ${columna} = ${columna} + excluded.${columna}, actualizado_en = datetime('now')`
    )
    .bind(fechaUtc, proveedor, inquilinoCodigo, tipo, cantidad)
    .run();
}

export async function registrarEnvioInquilino(
  dbInq: D1Database,
  datos: {
    tipo: string;
    destinatario: string;
    asunto: string;
    proveedor: string;
    estado: "ENVIADO" | "ENTREGADO" | "FALLIDO" | "REBOTADO" | "QUEJA" | "BLOQUEADO";
    motivo?: string;
    message_id?: string | null;
  }
) {
  await dbInq
    .prepare(
      `INSERT INTO correo_envios (tipo, destinatario, asunto, proveedor, estado, motivo, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      datos.tipo,
      datos.destinatario,
      datos.asunto.slice(0, 180),
      datos.proveedor,
      datos.estado,
      (datos.motivo || "").slice(0, 300),
      datos.message_id || null
    )
    .run()
    .catch(() => {});
}

export async function registrarAlertaCorreo(
  rawDb: D1Database,
  alerta: {
    clave: string;
    nivel: "AVISO" | "CRITICO";
    titulo: string;
    detalle: string;
    inquilino_codigo?: string;
    proveedor?: string;
  }
) {
  await rawDb
    .prepare(
      `INSERT INTO _mt_correos_alertas (clave, nivel, titulo, detalle, inquilino_codigo, proveedor, actualizado_en)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(clave) DO UPDATE SET
         nivel = excluded.nivel,
         titulo = excluded.titulo,
         detalle = excluded.detalle,
         actualizado_en = datetime('now')`
    )
    .bind(
      alerta.clave,
      alerta.nivel,
      alerta.titulo.slice(0, 140),
      alerta.detalle.slice(0, 400),
      alerta.inquilino_codigo || "",
      alerta.proveedor || ""
    )
    .run()
    .catch(() => {});
}

export async function verificarDestinatarioBloqueado(
  rawDb: D1Database,
  email: string,
  env?: Record<string, unknown>,
  ahoraSeg = Math.floor(Date.now() / 1000)
): Promise<{ bloqueado: boolean; hash: string; mensaje?: string; tipo?: string }> {
  const hash = await hmacTextoPlataforma("correo-bloqueo", email, env, rawDb);
  const fila = await rawDb
    .prepare(`SELECT tipo, motivo, contador, bloqueado_hasta FROM _mt_correos_bloqueos WHERE email_hash = ?`)
    .bind(hash)
    .first<{ tipo: string; motivo: string; contador: number; bloqueado_hasta: number }>()
    .catch(() => null);
  if (!fila) return { bloqueado: false, hash };

  if (fila.bloqueado_hasta === -1) {
    if (fila.tipo === "SPAM") {
      return {
        bloqueado: true,
        hash,
        tipo: fila.tipo,
        mensaje: `El correo a ${email} está bloqueado por una queja de spam previa. Contacta al administrador de la plataforma para revisarlo.`,
      };
    }
    return {
      bloqueado: true,
      hash,
      tipo: fila.tipo,
      mensaje: `El correo a ${email} rebotó: ${fila.motivo || "la dirección no existe o fue rechazada"}. Corrige el correo del cliente antes de reenviar.`,
    };
  }

  if (fila.bloqueado_hasta > ahoraSeg) {
    const mins = Math.max(1, Math.ceil((fila.bloqueado_hasta - ahoraSeg) / 60));
    return {
      bloqueado: true,
      hash,
      tipo: fila.tipo,
      mensaje: `El correo a ${email} tuvo ${fila.contador} rebotes temporales y está pausado por ${mins} min. Intenta más tarde.`,
    };
  }
  return { bloqueado: false, hash };
}

export async function leerLimitesInquilino(
  rawDb: D1Database,
  inquilinoCodigo: string
): Promise<{ alerta_diaria: number; fusible_diario: number }> {
  const fila = await rawDb
    .prepare(`SELECT alerta_diaria, fusible_diario FROM _mt_correos_limites WHERE inquilino_codigo = ?`)
    .bind(inquilinoCodigo)
    .first<{ alerta_diaria: number; fusible_diario: number }>()
    .catch(() => null);
  if (!fila) return { alerta_diaria: ALERTA_DIARIA_DEFECTO, fusible_diario: FUSIBLE_DIARIO_DEFECTO };
  return {
    alerta_diaria: Math.max(0, Number(fila.alerta_diaria ?? ALERTA_DIARIA_DEFECTO)),
    fusible_diario: Math.max(0, Number(fila.fusible_diario ?? FUSIBLE_DIARIO_DEFECTO)),
  };
}

export async function leerUsoHoy(
  rawDb: D1Database,
  inquilinoCodigo: string,
  fechaUtc = fechaUtcHoy()
): Promise<{ porProveedor: Partial<Record<ProveedorPlataforma, number>>; delInquilino: number }> {
  const [provRes, inqRow] = await Promise.all([
    rawDb
      .prepare(`SELECT proveedor, SUM(enviados) AS total FROM _mt_correos_uso WHERE fecha_utc = ? GROUP BY proveedor`)
      .bind(fechaUtc)
      .all<{ proveedor: string; total: number }>()
      .catch(() => ({ results: [] as { proveedor: string; total: number }[] })),
    rawDb
      .prepare(`SELECT COALESCE(SUM(enviados), 0) AS total FROM _mt_correos_uso WHERE fecha_utc = ? AND inquilino_codigo = ?`)
      .bind(fechaUtc, inquilinoCodigo)
      .first<{ total: number }>()
      .catch(() => ({ total: 0 })),
  ]);
  const porProveedor: Partial<Record<ProveedorPlataforma, number>> = {};
  for (const r of provRes.results || []) {
    if (r.proveedor === "BREVO" || r.proveedor === "RESEND" || r.proveedor === "ZEPTOMAIL") {
      porProveedor[r.proveedor] = Number(r.total || 0);
    }
  }
  return { porProveedor, delInquilino: Number(inqRow?.total || 0) };
}

export async function leerCircuitos(rawDb: D1Database): Promise<Partial<Record<ProveedorPlataforma, CircuitoEstado>>> {
  const { results } = await rawDb
    .prepare(`SELECT proveedor, abierto_hasta, fallos_consecutivos, ultimo_error, ultimo_estado_http, actualizado_en FROM _mt_correos_circuito`)
    .all<CircuitoEstado>()
    .catch(() => ({ results: [] as CircuitoEstado[] }));
  const mapa: Partial<Record<ProveedorPlataforma, CircuitoEstado>> = {};
  for (const r of results || []) {
    if (r.proveedor === "BREVO" || r.proveedor === "RESEND" || r.proveedor === "ZEPTOMAIL") {
      mapa[r.proveedor] = r;
    }
  }
  return mapa;
}

export async function registrarFalloCircuito(
  rawDb: D1Database,
  proveedor: ProveedorPlataforma,
  statusHttp: number,
  errorTexto: string,
  abrirSegundos: number,
  ahoraSeg = Math.floor(Date.now() / 1000)
) {
  const abiertoHasta = abrirSegundos > 0 ? ahoraSeg + abrirSegundos : 0;
  await rawDb
    .prepare(
      `INSERT INTO _mt_correos_circuito (proveedor, abierto_hasta, fallos_consecutivos, ultimo_error, ultimo_estado_http, actualizado_en)
       VALUES (?, ?, 1, ?, ?, datetime('now'))
       ON CONFLICT(proveedor) DO UPDATE SET
         abierto_hasta = CASE WHEN excluded.abierto_hasta > abierto_hasta THEN excluded.abierto_hasta ELSE abierto_hasta END,
         fallos_consecutivos = fallos_consecutivos + 1,
         ultimo_error = excluded.ultimo_error,
         ultimo_estado_http = excluded.ultimo_estado_http,
         actualizado_en = datetime('now')`
    )
    .bind(proveedor, abiertoHasta, errorTexto.slice(0, 260), statusHttp)
    .run()
    .catch(() => {});
}

export async function limpiarCircuito(rawDb: D1Database, proveedor: ProveedorPlataforma) {
  await rawDb
    .prepare(
      `INSERT INTO _mt_correos_circuito (proveedor, abierto_hasta, fallos_consecutivos, ultimo_error, ultimo_estado_http, actualizado_en)
       VALUES (?, 0, 0, '', 0, datetime('now'))
       ON CONFLICT(proveedor) DO UPDATE SET
         abierto_hasta = 0,
         fallos_consecutivos = 0,
         ultimo_error = '',
         ultimo_estado_http = 0,
         actualizado_en = datetime('now')`
    )
    .bind(proveedor)
    .run()
    .catch(() => {});
}

export async function evaluarAlertasDespuesEnvio(
  rawDb: D1Database,
  proveedor: ProveedorPlataforma,
  usadosProveedorHoy: number,
  cuotaProveedor: number,
  inquilinoCodigo: string,
  usadosInquilinoHoy: number,
  alertaDiariaInq: number,
  fechaUtc = fechaUtcHoy()
) {
  if (cuotaProveedor > 0 && usadosProveedorHoy >= Math.ceil(cuotaProveedor * 0.8)) {
    const pct = Math.min(100, Math.round((usadosProveedorHoy / cuotaProveedor) * 100));
    await registrarAlertaCorreo(rawDb, {
      clave: `cuota:${proveedor}:${fechaUtc}`,
      nivel: pct >= 95 ? "CRITICO" : "AVISO",
      titulo: `Cuota diaria de ${proveedor} al ${pct}%`,
      detalle: `${proveedor} lleva ${usadosProveedorHoy}/${cuotaProveedor} correos hoy (${fechaUtc} UTC).`,
      proveedor,
    });
  }
  if (alertaDiariaInq > 0 && usadosInquilinoHoy >= alertaDiariaInq) {
    await registrarAlertaCorreo(rawDb, {
      clave: `pico:${inquilinoCodigo}:${fechaUtc}`,
      nivel: "AVISO",
      titulo: `Pico de envíos en ${inquilinoCodigo}`,
      detalle: `El inquilino ${inquilinoCodigo} alcanzó ${usadosInquilinoHoy} correos hoy (${fechaUtc} UTC, alerta suave: ${alertaDiariaInq}).`,
      inquilino_codigo: inquilinoCodigo,
    });
  }
}

export async function evaluarAlertaRebotesInquilino(
  rawDb: D1Database,
  inquilinoCodigo: string,
  mesUtc = mesUtcActual()
) {
  const fila = await rawDb
    .prepare(
      `SELECT COALESCE(SUM(enviados), 0) AS env, COALESCE(SUM(rebotes_duros + rebotes_blandos), 0) AS reb
       FROM _mt_correos_uso WHERE inquilino_codigo = ? AND substr(fecha_utc, 1, 7) = ?`
    )
    .bind(inquilinoCodigo, mesUtc)
    .first<{ env: number; reb: number }>()
    .catch(() => null);
  const env = Number(fila?.env || 0);
  const reb = Number(fila?.reb || 0);
  if (env >= 20 && reb / env > 0.05) {
    const pct = ((reb / env) * 100).toFixed(1);
    await registrarAlertaCorreo(rawDb, {
      clave: `rebotes:${inquilinoCodigo}:${mesUtc}`,
      nivel: "CRITICO",
      titulo: `Tasa de rebotes alta en ${inquilinoCodigo} (${pct}%)`,
      detalle: `${inquilinoCodigo} registra ${reb} rebotes sobre ${env} envíos en ${mesUtc} (umbral: >5% con >=20 envíos).`,
      inquilino_codigo: inquilinoCodigo,
    });
  }
}

export type EventoWebhookNormalizado = {
  tipoEvento: "ENTREGADO" | "REBOTE_DURO" | "REBOTE_BLANDO" | "SPAM" | "IGNORAR";
  email: string;
  messageId: string;
  motivo: string;
  inquilinoTag?: string;
  tipoCorreoTag?: string;
};

function extraerTag(tags: unknown, prefijo: string): string | undefined {
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (typeof t === "string" && t.startsWith(prefijo)) return t.slice(prefijo.length);
      if (t && typeof t === "object") {
        const obj = t as Record<string, unknown>;
        if (obj.name === prefijo.replace(/:$/, "") && typeof obj.value === "string") return obj.value;
      }
    }
  } else if (tags && typeof tags === "object") {
    const val = (tags as Record<string, unknown>)[prefijo.replace(/:$/, "")];
    if (typeof val === "string") return val;
  }
  return undefined;
}

export function normalizarEventoWebhook(
  proveedor: ProveedorPlataforma,
  payload: Record<string, unknown>
): EventoWebhookNormalizado {
  if (proveedor === "BREVO") {
    const ev = String(payload.event ?? "").toLowerCase();
    const email = String(payload.email ?? "").trim().toLowerCase();
    const messageId = String(payload["message-id"] ?? payload.messageId ?? "").trim();
    const motivo = String(payload.reason ?? payload.subject ?? ev).trim();
    const tags = payload.tags ?? (payload.tag ? [payload.tag] : []);
    const inquilinoTag = extraerTag(tags, "inq:");
    const tipoCorreoTag = extraerTag(tags, "tipo:");
    if (ev === "delivered") return { tipoEvento: "ENTREGADO", email, messageId, motivo: "", inquilinoTag, tipoCorreoTag };
    if (ev === "hard_bounce" || ev === "invalid_email" || ev === "blocked" || ev === "error") {
      return { tipoEvento: "REBOTE_DURO", email, messageId, motivo: motivo || "Dirección inexistente o rechazada", inquilinoTag, tipoCorreoTag };
    }
    if (ev === "soft_bounce" || ev === "deferred") {
      return { tipoEvento: "REBOTE_BLANDO", email, messageId, motivo: motivo || "Fallo temporal de entrega", inquilinoTag, tipoCorreoTag };
    }
    if (ev === "spam" || ev === "complaint") {
      return { tipoEvento: "SPAM", email, messageId, motivo: motivo || "Reporte de spam", inquilinoTag, tipoCorreoTag };
    }
    return { tipoEvento: "IGNORAR", email, messageId, motivo: "" };
  }

  if (proveedor === "RESEND") {
    const ev = String(payload.type ?? "").toLowerCase();
    const data = (payload.data && typeof payload.data === "object" ? payload.data : {}) as Record<string, unknown>;
    const toList = Array.isArray(data.to) ? data.to : typeof data.to === "string" ? [data.to] : [];
    const email = String(toList[0] ?? data.email ?? "").trim().toLowerCase();
    const messageId = String(data.email_id ?? data.id ?? "").trim();
    const bounce = (data.bounce && typeof data.bounce === "object" ? data.bounce : {}) as Record<string, unknown>;
    const motivo = String(bounce.message ?? bounce.subType ?? data.reason ?? ev).trim();
    const tags = data.tags;
    const inquilinoTag = extraerTag(tags, "inq:");
    const tipoCorreoTag = extraerTag(tags, "tipo:");
    if (ev === "email.delivered") return { tipoEvento: "ENTREGADO", email, messageId, motivo: "", inquilinoTag, tipoCorreoTag };
    if (ev === "email.bounced") {
      const esBlando = /soft|temp|transient|full/i.test(String(bounce.type ?? bounce.subType ?? motivo));
      return {
        tipoEvento: esBlando ? "REBOTE_BLANDO" : "REBOTE_DURO",
        email,
        messageId,
        motivo: motivo || (esBlando ? "Rebote temporal" : "Dirección rechazada permanentemente"),
        inquilinoTag,
        tipoCorreoTag,
      };
    }
    if (ev === "email.complained") {
      return { tipoEvento: "SPAM", email, messageId, motivo: motivo || "Queja de spam", inquilinoTag, tipoCorreoTag };
    }
    return { tipoEvento: "IGNORAR", email, messageId, motivo: "" };
  }

  // ZEPTOMAIL
  const evName = Array.isArray(payload.event_name) ? String(payload.event_name[0] ?? "").toLowerCase() : String(payload.event_name ?? payload.event ?? "").toLowerCase();
  const msg = (payload.event_message && Array.isArray(payload.event_message) && payload.event_message[0] && typeof payload.event_message[0] === "object"
    ? payload.event_message[0]
    : payload) as Record<string, unknown>;
  const email = String(msg.email_address ?? payload.email ?? "").trim().toLowerCase();
  const messageId = String(msg.request_id ?? msg.message_id ?? payload.request_id ?? "").trim();
  const motivo = String(msg.reason ?? msg.diagnostic_message ?? evName).trim();
  if (evName.includes("deliver")) return { tipoEvento: "ENTREGADO", email, messageId, motivo: "" };
  if (evName.includes("hardbounce") || evName.includes("hard_bounce")) return { tipoEvento: "REBOTE_DURO", email, messageId, motivo: motivo || "Rebote duro" };
  if (evName.includes("softbounce") || evName.includes("soft_bounce")) return { tipoEvento: "REBOTE_BLANDO", email, messageId, motivo: motivo || "Rebote temporal" };
  if (evName.includes("spam") || evName.includes("complaint")) return { tipoEvento: "SPAM", email, messageId, motivo: motivo || "Reporte de spam" };
  return { tipoEvento: "IGNORAR", email, messageId, motivo: "" };
}

// Verificación criptográfica fail-closed de webhooks por proveedor
export async function verificarFirmaWebhook(
  proveedor: ProveedorPlataforma,
  req: Request,
  rawBody: string,
  env?: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; status: 401 | 503; error: string }> {
  const nombreSecreto =
    proveedor === "BREVO"
      ? "BREVO_WEBHOOK_SECRET"
      : proveedor === "RESEND"
        ? "RESEND_WEBHOOK_SECRET"
        : "ZEPTOMAIL_WEBHOOK_SECRET";
  const secreto = txtEnv(env, nombreSecreto);
  if (!secreto) {
    return {
      ok: false,
      status: 503,
      error: `Webhook de ${proveedor} deshabilitado: configura ${nombreSecreto} en Cloudflare (Variables and Secrets).`,
    };
  }

  // Firma Svix estándar para Resend cuando el secreto empieza con whsec_
  if (proveedor === "RESEND" && secreto.startsWith("whsec_")) {
    const svixId = req.headers.get("svix-id") || "";
    const svixTs = req.headers.get("svix-timestamp") || "";
    const svixSig = req.headers.get("svix-signature") || "";
    if (!svixId || !svixTs || !svixSig) {
      return { ok: false, status: 401, error: "Faltan cabeceras de firma Svix." };
    }
    const tsNum = Number(svixTs);
    if (!Number.isFinite(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 300) {
      return { ok: false, status: 401, error: "Timestamp de firma Svix expirado o inválido." };
    }
    try {
      const claveBytes = Uint8Array.from(atob(secreto.slice("whsec_".length)), (c) => c.charCodeAt(0));
      const key = await crypto.subtle.importKey("raw", claveBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signedBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${svixId}.${svixTs}.${rawBody}`));
      const esperadoB64 = btoa(String.fromCharCode(...new Uint8Array(signedBuf)));
      const firmas = svixSig.split(/\s+/).map((part) => {
        const [, sig] = part.split(",");
        return sig || "";
      });
      if (firmas.some((f) => comparacionConstante(f, esperadoB64))) {
        return { ok: true };
      }
      return { ok: false, status: 401, error: "Firma Svix inválida." };
    } catch {
      return { ok: false, status: 401, error: "Error verificando firma Svix." };
    }
  }

  // Verificación por cabecera X-Webhook-Secret, Authorization: Bearer <secreto>, o parámetro ?token=<secreto>
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const headerSec = req.headers.get("x-webhook-secret") || req.headers.get("x-brevo-secret") || "";
  const urlToken = new URL(req.url).searchParams.get("token") || "";
  const recibido = headerSec || bearer || urlToken;
  if (!recibido || !comparacionConstante(recibido, secreto)) {
    return { ok: false, status: 401, error: "Token de webhook inválido." };
  }
  return { ok: true };
}

export async function procesarEventoWebhook(
  rawDb: D1Database,
  env: Record<string, unknown>,
  proveedor: ProveedorPlataforma,
  payload: Record<string, unknown>,
  ahoraSeg = Math.floor(Date.now() / 1000)
): Promise<{ procesado: boolean; tipoEvento: string; inquilino: string }> {
  await asegurarEsquemaCorreos(rawDb, env);
  const ev = normalizarEventoWebhook(proveedor, payload);
  if (ev.tipoEvento === "IGNORAR") {
    return { procesado: false, tipoEvento: "IGNORAR", inquilino: "principal" };
  }

  // Localizar inquilino mediante tabla índice message_id -> inquilino o etiqueta inq:
  let inquilino = ev.inquilinoTag || "";
  let tipoCorreo = ev.tipoCorreoTag || "GENERAL";
  if (ev.messageId) {
    const idx = await rawDb
      .prepare(`SELECT inquilino_codigo, tipo FROM _mt_correos_indice WHERE message_id = ?`)
      .bind(ev.messageId)
      .first<{ inquilino_codigo: string; tipo: string }>()
      .catch(() => null);
    if (idx) {
      if (!inquilino) inquilino = idx.inquilino_codigo;
      if (!ev.tipoCorreoTag && idx.tipo) tipoCorreo = idx.tipo;
    }
  }
  if (!inquilino) inquilino = "principal";

  const fechaUtc = fechaUtcHoy(ahoraSeg * 1000);
  const mesUtc = mesUtcActual(ahoraSeg * 1000);

  if (ev.tipoEvento === "ENTREGADO") {
    await incrementarUsoCorreo(rawDb, proveedor, inquilino, tipoCorreo, "entregados", 1, fechaUtc);
    if (ev.messageId) {
      const dbInq = obtenerDbInquilino({ ...env, DB: rawDb }, inquilino);
      await dbInq
        .prepare(`UPDATE correo_envios SET estado = 'ENTREGADO', motivo = '' WHERE message_id = ? AND estado = 'ENVIADO'`)
        .bind(ev.messageId)
        .run()
        .catch(() => {});
    }
    return { procesado: true, tipoEvento: ev.tipoEvento, inquilino };
  }

  const emailHash = ev.email ? await hmacTextoPlataforma("correo-bloqueo", ev.email, env, rawDb) : "";
  const mascara = ev.email ? enmascararCorreo(ev.email) : "***";

  if (ev.tipoEvento === "REBOTE_DURO") {
    await incrementarUsoCorreo(rawDb, proveedor, inquilino, tipoCorreo, "rebotes_duros", 1, fechaUtc);
    if (emailHash) {
      await rawDb
        .prepare(
          `INSERT INTO _mt_correos_bloqueos (email_hash, mascara, tipo, motivo, contador, bloqueado_hasta, inquilino_origen, actualizado_en)
           VALUES (?, ?, 'REBOTE_DURO', ?, 1, -1, ?, datetime('now'))
           ON CONFLICT(email_hash) DO UPDATE SET
             mascara = excluded.mascara,
             tipo = 'REBOTE_DURO',
             motivo = excluded.motivo,
             contador = contador + 1,
             bloqueado_hasta = -1,
             inquilino_origen = excluded.inquilino_origen,
             actualizado_en = datetime('now')`
        )
        .bind(emailHash, mascara, ev.motivo.slice(0, 260), inquilino)
        .run();
    }
    await evaluarAlertaRebotesInquilino(rawDb, inquilino, mesUtc);
  } else if (ev.tipoEvento === "REBOTE_BLANDO") {
    await incrementarUsoCorreo(rawDb, proveedor, inquilino, tipoCorreo, "rebotes_blandos", 1, fechaUtc);
    if (emailHash) {
      const prev = await rawDb
        .prepare(`SELECT tipo, contador, bloqueado_hasta FROM _mt_correos_bloqueos WHERE email_hash = ?`)
        .bind(emailHash)
        .first<{ tipo: string; contador: number; bloqueado_hasta: number }>()
        .catch(() => null);
      if (!prev || prev.bloqueado_hasta !== -1) {
        // Si tenía una pausa temporal ya expirada, reinicia conteo desde 1; de lo contrario suma.
        const expirado = Boolean(prev && prev.bloqueado_hasta > 0 && prev.bloqueado_hasta <= ahoraSeg);
        const nuevoCont = expirado ? 1 : Number(prev?.contador || 0) + 1;
        const bloqueadoHasta = nuevoCont >= UMBRAL_REBOTES_BLANDOS ? ahoraSeg + PAUSA_REBOTE_BLANDO_SEG : 0;
        await rawDb
          .prepare(
            `INSERT INTO _mt_correos_bloqueos (email_hash, mascara, tipo, motivo, contador, bloqueado_hasta, inquilino_origen, actualizado_en)
             VALUES (?, ?, 'REBOTE_BLANDO', ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(email_hash) DO UPDATE SET
               mascara = excluded.mascara,
               tipo = 'REBOTE_BLANDO',
               motivo = excluded.motivo,
               contador = excluded.contador,
               bloqueado_hasta = excluded.bloqueado_hasta,
               inquilino_origen = excluded.inquilino_origen,
               actualizado_en = datetime('now')`
          )
          .bind(emailHash, mascara, ev.motivo.slice(0, 260), nuevoCont, bloqueadoHasta, inquilino)
          .run();
      }
    }
    await evaluarAlertaRebotesInquilino(rawDb, inquilino, mesUtc);
  } else if (ev.tipoEvento === "SPAM") {
    await incrementarUsoCorreo(rawDb, proveedor, inquilino, tipoCorreo, "quejas", 1, fechaUtc);
    if (emailHash) {
      await rawDb
        .prepare(
          `INSERT INTO _mt_correos_bloqueos (email_hash, mascara, tipo, motivo, contador, bloqueado_hasta, inquilino_origen, actualizado_en)
           VALUES (?, ?, 'SPAM', ?, 1, -1, ?, datetime('now'))
           ON CONFLICT(email_hash) DO UPDATE SET
             mascara = excluded.mascara,
             tipo = 'SPAM',
             motivo = excluded.motivo,
             contador = contador + 1,
             bloqueado_hasta = -1,
             inquilino_origen = excluded.inquilino_origen,
             actualizado_en = datetime('now')`
        )
        .bind(emailHash, mascara, ev.motivo.slice(0, 260), inquilino)
        .run();
    }
    await registrarAlertaCorreo(rawDb, {
      clave: `spam:${inquilino}:${fechaUtc}`,
      nivel: "CRITICO",
      titulo: `Queja de spam detectada (${inquilino})`,
      detalle: `Se recibió reporte de spam vía ${proveedor} para ${mascara} (origen: ${inquilino}). Dirección bloqueada permanentemente.`,
      inquilino_codigo: inquilino,
      proveedor,
    });
  }

  // Reflejar el rebote/queja en el historial privado del inquilino
  const dbInq = obtenerDbInquilino({ ...env, DB: rawDb }, inquilino);
  const estadoHist = ev.tipoEvento === "SPAM" ? "QUEJA" : "REBOTADO";
  const motivoHist =
    ev.tipoEvento === "REBOTE_DURO"
      ? `Rebote duro: ${ev.motivo}`
      : ev.tipoEvento === "REBOTE_BLANDO"
        ? `Rebote temporal: ${ev.motivo}`
        : `Queja de spam: ${ev.motivo}`;
  if (ev.messageId) {
    const upd = await dbInq
      .prepare(`UPDATE correo_envios SET estado = ?, motivo = ? WHERE message_id = ?`)
      .bind(estadoHist, motivoHist.slice(0, 300), ev.messageId)
      .run()
      .catch(() => null);
    if (!upd || Number(upd.meta?.changes ?? 0) === 0) {
      await registrarEnvioInquilino(dbInq, {
        tipo: tipoCorreo,
        destinatario: ev.email || mascara,
        asunto: "(Evento de entrega)",
        proveedor,
        estado: estadoHist,
        motivo: motivoHist,
        message_id: ev.messageId,
      });
    }
  } else if (ev.email) {
    await registrarEnvioInquilino(dbInq, {
      tipo: tipoCorreo,
      destinatario: ev.email,
      asunto: "(Evento de entrega)",
      proveedor,
      estado: estadoHist,
      motivo: motivoHist,
    });
  }

  return { procesado: true, tipoEvento: ev.tipoEvento, inquilino };
}
