// Arquitectura Multi-Tenant (Multi-Inquilino) con Ranuras D1 Dedicadas (DB_1..DB_9) y Control por API de Cloudflare para FacturaYa Venezuela.
// Estandariza que cada cliente nuevo ocupe su propia ranura dedicada (DB_1, DB_2... aprovechando las 9 bases D1 gratis restantes de Cloudflare y 50.000 en Plan Pro),
// operando ya sea por API directa de Cloudflare D1 (d1_uuid), por Binding nativo (env.DB_1) o por bóveda aislada local (db1_).
import { crearDbCloudflareHttp, eliminarBaseD1EnCloudflare, leerConfigCloudflare, obtenerUuidBdPrincipal } from "./cloudflare-api";
import { emailSuperAdminConfig } from "./permisos";

export const RANURAS_ESTANDAR_D1 = ["DB_1", "DB_2", "DB_3", "DB_4", "DB_5", "DB_6", "DB_7", "DB_8", "DB_9"] as const;

export const TABLAS_INQUILINO = [
  "_migraciones",
  "perfil_emisor",
  "emisor_logos",
  "usuarios",
  "sesiones",
  "intentos_login",
  "auditoria",
  "clientes",
  "catalogo",
  "ajustes",
  "contadores",
  "parametros_fiscales",
  "documentos",
  "documento_renglones",
  "documento_impuestos",
  "pagos",
  "metodos_cobro",
  "verificaciones",
  "proveedores",
  "compras",
  "compras_vieja",
  "movimientos_stock",
  "compra_impuestos",
  "medio_historial",
  "integraciones",
  "correo_envios",
] as const;

export const TRIGGERS_CONOCIDOS_INQUILINO = [
  "doc_no_borrar",
  "doc_inmutable",
  "documento_renglones_insert_emitido",
  "documento_renglones_update_emitido",
  "documento_renglones_delete_emitido",
  "documento_impuestos_insert_emitido",
  "documento_impuestos_update_emitido",
  "documento_impuestos_delete_emitido",
  "renglon_no_cambiar",
  "renglon_no_borrar",
  "impuesto_no_cambiar",
  "impuesto_no_borrar",
  "pago_no_borrar",
  "pago_inmutable",
  "mov_no_cambiar",
  "mov_no_borrar",
  "compra_no_borrar",
  "compra_inmutable",
  "compra_impuestos_no_cambiar",
  "compra_impuestos_no_borrar",
] as const;

export const OBJETOS_ESQUEMA_INQUILINO = [
  ...TABLAS_INQUILINO,
  "documento_pagos",
  ...TRIGGERS_CONOCIDOS_INQUILINO,
  "idx_catalogo_codigo",
  "idx_doc_numero",
  "idx_doc_control",
  "idx_doc_cliente",
  "idx_doc_estado",
  "idx_doc_afectada",
  "documentos_fiscal_unico",
  "idx_pago_numero",
  "idx_pago_documento",
  "idx_compra_factura",
  "idx_mov_producto",
  "idx_mov_documento",
  "idx_renglones_doc",
  "idx_doc_modo_fecha",
  "idx_doc_por_cobrar",
  "idx_pagos_modo_fecha",
  "idx_auditoria_fecha",
  "idx_sesiones_expira",
  "idx_correo_envios_fecha",
  "idx_correo_envios_msgid",
] as const;

const REGEX_OBJETOS = new RegExp(`\\b(${[...OBJETOS_ESQUEMA_INQUILINO].sort((a, b) => b.length - a.length).join("|")})\\b`, "g");

export function reescribirSqlInquilino(sql: string, prefijo: string): string {
  if (!prefijo) return sql;
  return sql.replace(REGEX_OBJETOS, `${prefijo}$1`);
}

export function prefijoTablaDeCodigo(codigo: string): string {
  if (!codigo || codigo === "principal") return "";
  if (/^DB_(\d+)$/i.test(codigo)) {
    const num = codigo.replace(/^DB_/i, "");
    return `db${num}_`;
  }
  if (/^t\d+$/i.test(codigo)) {
    return `${codigo.toLowerCase()}_`;
  }
  return `${codigo.toLowerCase().replace(/[^a-z0-9]/g, "")}_`;
}

// Envuelve una base D1 física para que todas las consultas operen sobre el espacio de tablas aislado del inquilino (ej. db1_documentos o t2_documentos)
export function crearDbInquilino(rawDb: D1Database, prefijo: string): D1Database {
  if (!prefijo) return rawDb;
  const r = rawDb as unknown as Record<string, (...args: unknown[]) => unknown>;
  return {
    prepare(query: string) {
      const sqlReescrito = reescribirSqlInquilino(query, prefijo);
      const stmt = rawDb.prepare(sqlReescrito);
      if (/sqlite_master/i.test(query)) {
        const bindOrig = stmt.bind.bind(stmt);
        stmt.bind = (...values: unknown[]) =>
          bindOrig(...values.map((v) => (typeof v === "string" ? reescribirSqlInquilino(v, prefijo) : v)));
      }
      return stmt;
    },
    batch(statements: D1PreparedStatement[]) {
      return rawDb.batch(statements);
    },
    exec(query: string) {
      return typeof r.exec === "function" ? r.exec(reescribirSqlInquilino(query, prefijo)) : Promise.resolve({ count: 0, duration: 0 });
    },
    dump() {
      return typeof r.dump === "function" ? r.dump() : Promise.resolve(new ArrayBuffer(0));
    },
  } as unknown as D1Database;
}

// Verifica si un código de inquilino tiene un binding D1 dedicado activo en `env` (nativo de Cloudflare o hidratado vía API D1)
export function tieneBindingDedicado(env: Record<string, unknown>, codigo: string): boolean {
  if (!codigo || codigo === "principal") return false;
  return Boolean(env[codigo] && typeof (env[codigo] as D1Database).prepare === "function");
}

// Caché en memoria de Isolate (TTL 60s) para evitar consultar `integraciones` y `_mt_inquilinos` en cada petición de 500 usuarios concurrentes
type CacheHidratacion = {
  ts: number;
  accountId: string;
  apiToken: string;
  adaptadores: Map<string, D1Database>;
  activos: Map<string, boolean>;
};
const CACHE_TTL_MS = 60_000;
const cachePorRawDb = new WeakMap<D1Database, CacheHidratacion>();
const ddlMtAsegurado = new WeakSet<D1Database>();
const principalSincronizado = new WeakSet<D1Database>();

export function invalidarCacheInquilinos(rawDb?: D1Database) {
  if (rawDb) {
    cachePorRawDb.delete(rawDb);
    principalSincronizado.delete(rawDb);
  }
}

export async function verificarInquilinoActivoCacheado(rawDb: D1Database, codigo: string): Promise<boolean> {
  if (!codigo || codigo === "principal") return true;
  const ahora = Date.now();
  const c = cachePorRawDb.get(rawDb);
  if (c && ahora - c.ts < CACHE_TTL_MS && c.activos.has(codigo)) {
    return c.activos.get(codigo)!;
  }
  const estadoInq = await rawDb
    .prepare(`SELECT activo FROM _mt_inquilinos WHERE codigo = ?`)
    .bind(codigo)
    .first<{ activo: number }>()
    .catch(() => null);
  const activo = !estadoInq || estadoInq.activo === 1;
  if (c && ahora - c.ts < CACHE_TTL_MS) {
    c.activos.set(codigo, activo);
  }
  return activo;
}

// Hidrata en `env` adaptadores D1 HTTP para todos los inquilinos que tengan `d1_uuid` creado por API de Cloudflare (cuando no tengan ya binding nativo en wrangler.toml)
export async function hidratarBindingsCloudflare(rawDb: D1Database, envObj: Record<string, unknown>, forzar = false) {
  try {
    const ahora = Date.now();
    const enCache = !forzar ? cachePorRawDb.get(rawDb) : undefined;
    if (enCache && ahora - enCache.ts < CACHE_TTL_MS) {
      for (const [cod, dbHttp] of enCache.adaptadores.entries()) {
        if (!tieneBindingDedicado(envObj, cod)) {
          envObj[cod] = dbHttp;
        }
      }
      return;
    }

    const cfg = await leerConfigCloudflare(rawDb, envObj);
    const adaptadores = new Map<string, D1Database>();
    const activos = new Map<string, boolean>();

    const { results } = await rawDb
      .prepare(`SELECT codigo, d1_uuid, activo FROM _mt_inquilinos`)
      .all<{ codigo: string; d1_uuid: string | null; activo: number }>()
      .catch(() => ({ results: [] as { codigo: string; d1_uuid: string | null; activo: number }[] }));

    for (const r of results) {
      if (!r.codigo) continue;
      activos.set(r.codigo, r.activo === 1);
      if (cfg.configurado && r.codigo !== "principal" && r.d1_uuid) {
        const dbHttp = crearDbCloudflareHttp(cfg.account_id, cfg.api_token, r.d1_uuid);
        adaptadores.set(r.codigo, dbHttp);
        if (!tieneBindingDedicado(envObj, r.codigo)) {
          envObj[r.codigo] = dbHttp;
        }
      }
    }

    cachePorRawDb.set(rawDb, {
      ts: ahora,
      accountId: cfg.account_id,
      apiToken: cfg.api_token,
      adaptadores,
      activos,
    });
  } catch {
    // Si aún no existen las tablas multi-tenant, se ignora silenciosamente
  }
}

export function obtenerDbInquilino(env: Record<string, unknown>, codigo: string): D1Database {
  const basePrincipal = env.DB as D1Database;
  if (!codigo || codigo === "principal") return basePrincipal;
  if (tieneBindingDedicado(env, codigo)) {
    return env[codigo] as D1Database;
  }
  const prefijo = prefijoTablaDeCodigo(codigo);
  if (prefijo) {
    return crearDbInquilino(basePrincipal, prefijo);
  }
  return basePrincipal;
}

export type InquilinoInfo = {
  codigo: string;
  tipo_db: "PRINCIPAL" | "BINDING" | "CLOUDFLARE_API" | "PREFIJO";
  d1_uuid?: string | null;
  d1_nombre?: string | null;
  nombre_negocio: string;
  rif: string;
  direccion: string;
  telefono: string;
  nombre_dueno: string;
  email_dueno: string;
  cedula_dueno?: string | null;
  zona_postal?: string | null;
  firma_personal?: string | null;
  respaldo_descargado_en?: string | null;
  medio_facturacion: string;
  tipo_contribuyente?: string;
  plan_usd: number;
  activo: number;
  creado_en: string;
};

export async function asegurarTablasMultiTenant(rawDb: D1Database, env: Record<string, unknown> = {}) {
  if (!ddlMtAsegurado.has(rawDb)) {
    await rawDb.batch([
      rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_inquilinos (
        codigo TEXT PRIMARY KEY,
        tipo_db TEXT NOT NULL DEFAULT 'BINDING',
        nombre_negocio TEXT NOT NULL,
        rif TEXT NOT NULL,
        direccion TEXT NOT NULL DEFAULT '',
        telefono TEXT NOT NULL DEFAULT '',
        nombre_dueno TEXT NOT NULL,
        email_dueno TEXT NOT NULL,
        medio_facturacion TEXT NOT NULL DEFAULT 'APP_SENIAT',
        tipo_contribuyente TEXT NOT NULL DEFAULT 'ORDINARIO',
        plan_usd INTEGER NOT NULL DEFAULT 10,
        activo INTEGER NOT NULL DEFAULT 1,
        creado_en TEXT NOT NULL DEFAULT (datetime('now')),
        d1_uuid TEXT DEFAULT NULL,
        d1_nombre TEXT DEFAULT NULL,
        cedula_dueno TEXT DEFAULT '',
        zona_postal TEXT DEFAULT '',
        firma_personal TEXT DEFAULT '',
        respaldo_descargado_en TEXT DEFAULT NULL
      )`),
      rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_directorio (
        email TEXT PRIMARY KEY,
        inquilino_codigo TEXT NOT NULL,
        rol TEXT NOT NULL DEFAULT 'ADMIN',
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_super_vista (
        email TEXT PRIMARY KEY,
        inquilino_codigo TEXT NOT NULL,
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_correos_uso (
        fecha_utc TEXT NOT NULL,
        proveedor TEXT NOT NULL,
        inquilino_codigo TEXT NOT NULL,
        tipo TEXT NOT NULL,
        enviados INTEGER NOT NULL DEFAULT 0,
        entregados INTEGER NOT NULL DEFAULT 0,
        fallidos INTEGER NOT NULL DEFAULT 0,
        rebotes_duros INTEGER NOT NULL DEFAULT 0,
        rebotes_blandos INTEGER NOT NULL DEFAULT 0,
        quejas INTEGER NOT NULL DEFAULT 0,
        bloqueados INTEGER NOT NULL DEFAULT 0,
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (fecha_utc, proveedor, inquilino_codigo, tipo)
      )`),
      rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_correos_bloqueos (
        email_hash TEXT PRIMARY KEY,
        mascara TEXT NOT NULL DEFAULT '',
        tipo TEXT NOT NULL DEFAULT 'REBOTE_BLANDO',
        motivo TEXT NOT NULL DEFAULT '',
        contador INTEGER NOT NULL DEFAULT 1,
        bloqueado_hasta INTEGER NOT NULL DEFAULT 0,
        inquilino_origen TEXT NOT NULL DEFAULT 'principal',
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_correos_circuito (
        proveedor TEXT PRIMARY KEY,
        abierto_hasta INTEGER NOT NULL DEFAULT 0,
        fallos_consecutivos INTEGER NOT NULL DEFAULT 0,
        ultimo_error TEXT NOT NULL DEFAULT '',
        ultimo_estado_http INTEGER NOT NULL DEFAULT 0,
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_correos_indice (
        message_id TEXT PRIMARY KEY,
        proveedor TEXT NOT NULL,
        inquilino_codigo TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'GENERAL',
        email_hash TEXT NOT NULL DEFAULT '',
        creado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_correos_limites (
        inquilino_codigo TEXT PRIMARY KEY,
        alerta_diaria INTEGER NOT NULL DEFAULT 100,
        fusible_diario INTEGER NOT NULL DEFAULT 500,
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_correos_alertas (
        clave TEXT PRIMARY KEY,
        nivel TEXT NOT NULL DEFAULT 'AVISO',
        titulo TEXT NOT NULL,
        detalle TEXT NOT NULL,
        inquilino_codigo TEXT NOT NULL DEFAULT '',
        proveedor TEXT NOT NULL DEFAULT '',
        notificado_correo INTEGER NOT NULL DEFAULT 0,
        creado_en TEXT NOT NULL DEFAULT (datetime('now')),
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
    ]);

    // Asegurar columnas adicionales en instalaciones previas
    await rawDb.prepare(`ALTER TABLE _mt_inquilinos ADD COLUMN d1_uuid TEXT DEFAULT NULL`).run().catch(() => {});
    await rawDb.prepare(`ALTER TABLE _mt_inquilinos ADD COLUMN d1_nombre TEXT DEFAULT NULL`).run().catch(() => {});
    await rawDb.prepare(`ALTER TABLE _mt_inquilinos ADD COLUMN cedula_dueno TEXT DEFAULT ''`).run().catch(() => {});
    await rawDb.prepare(`ALTER TABLE _mt_inquilinos ADD COLUMN zona_postal TEXT DEFAULT ''`).run().catch(() => {});
    await rawDb.prepare(`ALTER TABLE _mt_inquilinos ADD COLUMN firma_personal TEXT DEFAULT ''`).run().catch(() => {});
    await rawDb.prepare(`ALTER TABLE _mt_inquilinos ADD COLUMN respaldo_descargado_en TEXT DEFAULT NULL`).run().catch(() => {});
    await rawDb.prepare(`ALTER TABLE _mt_inquilinos ADD COLUMN tipo_contribuyente TEXT NOT NULL DEFAULT 'ORDINARIO'`).run().catch(() => {});
    ddlMtAsegurado.add(rawDb);
  }

  if (principalSincronizado.has(rawDb)) return;

  // Sincronizar el negocio principal con perfil_emisor
  const existePrincipal = await rawDb.prepare(`SELECT codigo, nombre_negocio FROM _mt_inquilinos WHERE codigo = 'principal'`).first<{ codigo: string; nombre_negocio: string }>();
  if (!existePrincipal) {
    try {
      const p = await rawDb.prepare(`SELECT instalado, nombre_razon_social, rif, direccion_fiscal, telefono, email, medio_facturacion, tipo_contribuyente, representante_cedula, zona_postal, firma_personal FROM perfil_emisor WHERE id = 1`).first<Record<string, any>>();
      if (p?.instalado === 1) {
        const u = await rawDb.prepare(`SELECT nombre, email, rol FROM usuarios ORDER BY id ASC`).all<{ nombre: string; email: string; rol: string }>();
        const dueno = u.results.find((x) => x.rol === "SUPER_ADMIN" || x.rol === "ADMIN") ?? u.results[0];
        await rawDb.prepare(
          `INSERT OR IGNORE INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, tipo_contribuyente, plan_usd, activo, d1_uuid, d1_nombre, cedula_dueno, zona_postal, firma_personal)
           VALUES ('principal', 'PRINCIPAL', ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL, 'facturacion_ve_db', ?, ?, ?)`
        ).bind(
          p.nombre_razon_social || "Mi Negocio Principal",
          p.rif || "",
          p.direccion_fiscal || "",
          p.telefono || "",
          dueno?.nombre || "Administrador",
          dueno?.email || "",
          p.medio_facturacion || "APP_SENIAT",
          p.tipo_contribuyente || "ORDINARIO",
          p.representante_cedula || "",
          p.zona_postal || "",
          p.firma_personal || ""
        ).run();
        for (const usr of u.results) {
          await registrarCorreoDirectorio(rawDb, usr.email, "principal", usr.rol, env);
        }
        principalSincronizado.add(rawDb);
      }
    } catch {
      // Si aún no se han corrido las migraciones de la base principal, se sincronizará al instalar
    }
  } else {
    principalSincronizado.add(rawDb);
  }
}

// Encuentra la primera ranura dedicada libre (DB_1, DB_2... hasta DB_9 en Plan Gratis, o DB_10..DB_50000 en Plan Workers Paid $5/mes)
export async function siguienteRanuraD1Libre(rawDb: D1Database): Promise<string> {
  const { results } = await rawDb.prepare(`SELECT codigo FROM _mt_inquilinos`).all<{ codigo: string }>();
  const ocupadas = new Set(results.map((r) => r.codigo.toUpperCase()));
  for (const ranura of RANURAS_ESTANDAR_D1) {
    if (!ocupadas.has(ranura)) return ranura;
  }
  let n = 10;
  while (ocupadas.has(`DB_${n}`)) n++;
  return `DB_${n}`;
}

// Genera dinámicamente la lista de ranuras D1 (DB_1..DB_9 en Plan Gratis y expande automáticamente a DB_10, DB_11, DB_12... hasta 50.000 en el Plan de $5/mes,
// garantizando que siempre se muestren todas las ocupadas más las siguientes ranuras libres listas para seleccionar sin tocar el código)
export function generarListaRanurasD1(
  codigosOcupados: Iterable<string>,
  minLibresAdicionales = 5,
  plan5UsdActivo = false
): string[] {
  const ocupadas = new Set<string>();
  let maxOcupadoReal = 0;
  for (const c of codigosOcupados) {
    const up = String(c || "").toUpperCase();
    if (!up || up === "PRINCIPAL") continue;
    ocupadas.add(up);
    const m = up.match(/^DB_(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      if (n > maxOcupadoReal) maxOcupadoReal = n;
    }
  }
  const pisoBase = plan5UsdActivo ? 15 : 9;
  const metaMinima = Math.max(
    pisoBase,
    maxOcupadoReal >= 7 ? maxOcupadoReal + minLibresAdicionales : pisoBase
  );
  const lista: string[] = [];
  let libresContadas = 0;
  let i = 1;
  while (i <= metaMinima || libresContadas < minLibresAdicionales) {
    const cod = `DB_${i}`;
    lista.push(cod);
    if (!ocupadas.has(cod)) libresContadas++;
    i++;
    if (i > 50_000) break;
  }
  return lista;
}

// Elimina definitivamente un cliente moroso/retirado, destruye sus tablas/triggers, borra su D1 remota (si aplica),
// libera todos sus correos en _mt_directorio y deja su ranura DB_X libre para el próximo cliente.
export async function eliminarInquilinoDefinitivo(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  codigo: string,
  borrarD1Remota = true
): Promise<{ ok: true; d1_remota_eliminada: boolean; advertencia_d1?: string }> {
  if (!codigo || codigo === "principal") {
    throw new Error("El negocio principal no puede darse de baja como inquilino.");
  }
  await asegurarTablasMultiTenant(rawDb);
  await hidratarBindingsCloudflare(rawDb, envObj);

  const info = await rawDb
    .prepare(`SELECT codigo, tipo_db, d1_uuid, d1_nombre FROM _mt_inquilinos WHERE codigo = ?`)
    .bind(codigo)
    .first<{ codigo: string; tipo_db: string; d1_uuid?: string | null; d1_nombre?: string | null }>();

  const dbInq = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);
  const ordenTablas = [
    "pagos", "movimientos_stock", "compra_impuestos", "compras", "compras_vieja",
    "documento_impuestos", "documento_renglones", "documentos", "catalogo", "clientes", "proveedores",
    "medio_historial", "metodos_cobro", "integraciones", "parametros_fiscales", "contadores", "ajustes",
    "verificaciones", "auditoria", "intentos_login", "sesiones", "usuarios", "emisor_logos", "perfil_emisor", "_migraciones",
  ];

  // 1) Destruir triggers y tablas del inquilino en su bóveda o base dedicada
  await dbInq.batch(TRIGGERS_CONOCIDOS_INQUILINO.map((t) => dbInq.prepare(`DROP TRIGGER IF EXISTS ${t}`))).catch(() => {});
  await dbInq.batch(ordenTablas.map((t) => dbInq.prepare(`DROP TABLE IF EXISTS ${t}`))).catch(() => {});

  // Si también quedaron tablas locales prefijadas (db1_ o t2_) en rawDb, limpiarlas por completo
  const prefijoLocal = prefijoTablaDeCodigo(codigo);
  if (prefijoLocal) {
    const dbPrefijo = crearDbInquilino(rawDb, prefijoLocal);
    await dbPrefijo.batch(TRIGGERS_CONOCIDOS_INQUILINO.map((t) => dbPrefijo.prepare(`DROP TRIGGER IF EXISTS ${t}`))).catch(() => {});
    await dbPrefijo.batch(ordenTablas.map((t) => dbPrefijo.prepare(`DROP TABLE IF EXISTS ${t}`))).catch(() => {});
  }

  // 2) Si tenía una base D1 física creada en Cloudflare vía API y se solicitó borrarla, eliminarla en Cloudflare para recuperar el cupo
  let d1RemotaEliminada = false;
  let advertenciaD1: string | undefined;
  const uuidPrincipal = obtenerUuidBdPrincipal(envObj);
  if (borrarD1Remota && info?.d1_uuid && (!uuidPrincipal || info.d1_uuid !== uuidPrincipal)) {
    const resCf = await eliminarBaseD1EnCloudflare(rawDb, envObj, info.d1_uuid);
    if (resCf.ok) {
      d1RemotaEliminada = true;
      delete envObj[codigo];
    } else {
      advertenciaD1 = resCf.error;
    }
  }

  // 3) Limpiar directorio de correos, registro del inquilino y vista del Súper Admin
  await rawDb.batch([
    rawDb.prepare(`DELETE FROM _mt_directorio WHERE inquilino_codigo = ?`).bind(codigo),
    rawDb.prepare(`DELETE FROM _mt_inquilinos WHERE codigo = ?`).bind(codigo),
    rawDb.prepare(`UPDATE _mt_super_vista SET inquilino_codigo = 'principal', actualizado_en = datetime('now') WHERE inquilino_codigo = ?`).bind(codigo),
  ]);
  invalidarCacheInquilinos(rawDb);

  return { ok: true, d1_remota_eliminada: d1RemotaEliminada, advertencia_d1: advertenciaD1 };
}

export async function obtenerSuperAdminPrincipal(
  rawDb: D1Database,
  env: Record<string, unknown>
): Promise<{ id: number; nombre: string; email: string; password_hash: string; codigo_recuperacion_hash: string | null } | null> {
  const cfg = emailSuperAdminConfig(env);
  if (cfg) {
    const porEnv = await rawDb
      .prepare(`SELECT id, nombre, email, password_hash, codigo_recuperacion_hash FROM usuarios WHERE lower(email) = ? LIMIT 1`)
      .bind(cfg)
      .first<{ id: number; nombre: string; email: string; password_hash: string; codigo_recuperacion_hash: string | null }>()
      .catch(() => null);
    if (porEnv) return porEnv;
  }
  return rawDb
    .prepare(`SELECT id, nombre, email, password_hash, codigo_recuperacion_hash FROM usuarios WHERE rol = 'SUPER_ADMIN' ORDER BY id ASC LIMIT 1`)
    .first<{ id: number; nombre: string; email: string; password_hash: string; codigo_recuperacion_hash: string | null }>()
    .catch(() => null);
}

export async function esCorreoSuperAdmin(
  rawDb: D1Database,
  email: string,
  env: Record<string, unknown>
): Promise<boolean> {
  const limpio = String(email || "").trim().toLowerCase();
  if (!limpio) return false;
  const cfg = emailSuperAdminConfig(env);
  if (cfg && limpio === cfg) return true;
  const fila = await rawDb
    .prepare(`SELECT 1 AS ok FROM usuarios WHERE lower(email) = ? AND rol = 'SUPER_ADMIN' LIMIT 1`)
    .bind(limpio)
    .first<{ ok: number }>()
    .catch(() => null);
  return Boolean(fila);
}

export async function registrarCorreoDirectorio(rawDb: D1Database, email: string, codigo: string, rol: string, env: Record<string, unknown>) {
  const limpio = String(email || "").trim().toLowerCase();
  if (!limpio) return;
  const esSuper = rol === "SUPER_ADMIN" || (await esCorreoSuperAdmin(rawDb, limpio, env));
  const destino = esSuper ? "principal" : codigo;
  await rawDb.prepare(
    `INSERT INTO _mt_directorio (email, inquilino_codigo, rol, actualizado_en) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(email) DO UPDATE SET inquilino_codigo = excluded.inquilino_codigo, rol = excluded.rol, actualizado_en = datetime('now')`
  ).bind(limpio, destino, rol).run();
}

export async function buscarInquilinoPorCorreo(rawDb: D1Database, email: string, env: Record<string, unknown>): Promise<{ codigo: string; activo: boolean; nombre_negocio: string }> {
  const limpio = String(email || "").trim().toLowerCase();
  await asegurarTablasMultiTenant(rawDb, env);
  if (await esCorreoSuperAdmin(rawDb, limpio, env)) {
    const vista = await rawDb.prepare(`SELECT inquilino_codigo FROM _mt_super_vista WHERE email = ?`).bind(limpio).first<{ inquilino_codigo: string }>();
    const cod = vista?.inquilino_codigo || "principal";
    const info = await rawDb.prepare(`SELECT nombre_negocio FROM _mt_inquilinos WHERE codigo = ?`).bind(cod).first<{ nombre_negocio: string }>();
    return { codigo: cod, activo: true, nombre_negocio: info?.nombre_negocio || "Negocio Principal" };
  }
  const dir = await rawDb.prepare(`SELECT inquilino_codigo FROM _mt_directorio WHERE email = ?`).bind(limpio).first<{ inquilino_codigo: string }>();
  const codigo = dir?.inquilino_codigo || "principal";
  if (codigo === "principal") {
    return { codigo: "principal", activo: true, nombre_negocio: "Negocio Principal" };
  }
  const inq = await rawDb.prepare(`SELECT activo, nombre_negocio FROM _mt_inquilinos WHERE codigo = ?`).bind(codigo).first<{ activo: number; nombre_negocio: string }>();
  if (!inq) return { codigo: "principal", activo: true, nombre_negocio: "Negocio Principal" };
  return { codigo, activo: inq.activo === 1, nombre_negocio: inq.nombre_negocio };
}

export async function fijarVistaSuperAdmin(rawDb: D1Database, codigo: string, emailSuper: string | undefined, env: Record<string, unknown>) {
  await asegurarTablasMultiTenant(rawDb, env);
  const superAdmin = emailSuper
    ? { email: emailSuper.trim().toLowerCase() }
    : await obtenerSuperAdminPrincipal(rawDb, env);
  const correo = superAdmin?.email || emailSuperAdminConfig(env);
  if (!correo) return;
  await rawDb.prepare(
    `INSERT INTO _mt_super_vista (email, inquilino_codigo, actualizado_en) VALUES (?, ?, datetime('now'))
     ON CONFLICT(email) DO UPDATE SET inquilino_codigo = excluded.inquilino_codigo, actualizado_en = datetime('now')`
  ).bind(correo, codigo).run();
}

// Genera el archivo wrangler.toml completo con Bindings Nativos D1 (1 ms de latencia, sin límite de 1.200 req/5min de la API REST)
// ideal para operar 100 empresas × 100 facturas/día con 500 usuarios simultáneos en Cloudflare Workers Paid ($5/mes).
export async function generarWranglerTomlBindings(rawDb: D1Database, envObj?: Record<string, unknown>) {
  await asegurarTablasMultiTenant(rawDb);
  const { results } = await rawDb
    .prepare(
      `SELECT codigo, nombre_negocio, rif, d1_uuid, d1_nombre, activo
       FROM _mt_inquilinos
       ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en ASC`
    )
    .all<{
      codigo: string;
      nombre_negocio: string;
      rif: string;
      d1_uuid: string | null;
      d1_nombre: string | null;
      activo: number;
    }>();

  const turnstileSiteKey = String(envObj?.TURNSTILE_SITE_KEY || "").trim();
  const filaPrin = results.find((r) => r.codigo === "principal");
  const uuidPrincipal = obtenerUuidBdPrincipal(envObj) || String(filaPrin?.d1_uuid || "").trim() || "PEGA_AQUI_UUID_D1_PRINCIPAL";
  const lineas: string[] = [
    `# FacturaYa Venezuela — Configuración wrangler.toml (uso privado / despliegue local)`,
    `# IMPORTANTE: No subas bindings ni UUIDs de clientes a repositorios públicos.`,
    `name = "facturaya"  # debe ser igual al nombre del Worker en Cloudflare`,
    `main = "src/index.ts"`,
    `compatibility_date = "2025-10-20"`,
    `# Cuando conectes tu dominio propio en Cloudflare, descomenta la línea de abajo para ocultar *.workers.dev:`,
    `# workers_dev = false`,
    ``,
    `# El front end (carpeta public/) se sirve gratis y sin límite; el Worker solo corre para /api/*`,
    `[assets]`,
    `directory = "./public"`,
    `binding = "ASSETS"`,
    `run_worker_first = ["/api/*"]`,
    ``,
    `[observability]`,
    `enabled = true`,
    ``,
    `# Variables públicas opcionales (los secretos MASTER_KEY, TURNSTILE_SECRET_KEY, SUPER_ADMIN_EMAIL y WHATSAPP_CONTACTO van SOLO en Cloudflare -> Variables and Secrets)`,
    `[vars]`,
    turnstileSiteKey ? `TURNSTILE_SITE_KEY = "${turnstileSiteKey}"` : `# TURNSTILE_SITE_KEY = "PEGA_AQUI_SITE_KEY"`,
    `# TURNSTILE_HOSTNAMES = "facturacion.tu-dominio.com"`,
    ``,
    `# Sincronización automática de Tasa BCV, Cierre Contable Mensual y Respaldo Diario/Mensual R2 (8:00 AM, 1:00 PM y 6:00 PM hora Caracas UTC-4)`,
    `[triggers]`,
    `crons = ["0 12,17,22 * * *"]`,
    ``,
    `# Base de datos principal (Directorio Maestro + Negocio Principal)`,
    `[[d1_databases]]`,
    `binding = "DB"`,
    `database_name = "facturacion_ve_db"`,
    `database_id = "${uuidPrincipal}"`,
    ``,
    `# Respaldo automático diario y archivo fiscal mensual en Cloudflare R2 (bucket privado)`,
    `[[r2_buckets]]`,
    `binding = "RESPALDOS_R2"`,
    `bucket_name = "facturaya-respaldos"`,
  ];

  let bindingsConUuid = 1;
  const sinUuid: string[] = [];

  for (const r of results) {
    if (!r.codigo || r.codigo === "principal") continue;
    const uuid = String(r.d1_uuid || "").trim();
    const dbName = String(r.d1_nombre || "").trim() || `facturaya_${r.codigo.toLowerCase()}`;
    lineas.push(``);
    lineas.push(`# Inquilino ${r.codigo}${r.activo ? "" : " [SUSPENDIDO]"}`);
    if (uuid && uuid !== uuidPrincipal) {
      lineas.push(`[[d1_databases]]`);
      lineas.push(`binding = "${r.codigo}"`);
      lineas.push(`database_name = "${dbName}"`);
      lineas.push(`database_id = "${uuid}"`);
      bindingsConUuid++;
    } else {
      sinUuid.push(r.codigo);
      lineas.push(`# (Opera en bóveda nativa aislada ${prefijoTablaDeCodigo(r.codigo)} sobre DB)`);
      lineas.push(`# [[d1_databases]]`);
      lineas.push(`# binding = "${r.codigo}"`);
      lineas.push(`# database_name = "${dbName}"`);
      lineas.push(`# database_id = "PEGA_AQUI_UUID_D1"`);
    }
  }

  return {
    ok: true as const,
    toml: lineas.join("\n") + "\n",
    total_empresas: results.length,
    bindings_con_uuid: bindingsConUuid,
    sin_uuid: sinUuid,
  };
}

