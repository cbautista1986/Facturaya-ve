// Respaldos Automáticos Diarios y Archivo Fiscal Mensual en Cloudflare R2 (v4.5).
// - Diarios (`respaldos/diarios/YYYY-MM-DD/`): 1 archivo por empresa (evita pico de RAM en Workers), podados a los 30 días.
// - Archivo Fiscal Mensual (`respaldos/mensuales/YYYY-MM/`): conservación a largo plazo (10+ años, Art. 55 y 155 COT), NUNCA podados automáticamente.
// - Manuales (`respaldos/manuales/YYYY-MM-DD/`): bajo demanda, nunca podados automáticamente.
// - Descargas en streaming vía `obj.body` y registro de errores de Cron visible para el Súper Administrador.
import { fechaCaracas } from "./comun";
import { asegurarTablasMultiTenant } from "./inquilinos";
import { generarRespaldoMaestro } from "./salud-bd";
import { mesAnteriorCaracas } from "./tasa-bcv";

export interface ObjetoR2 {
  key: string;
  size: number;
  uploaded?: Date | string;
  httpEtag?: string;
  customMetadata?: Record<string, string>;
}

export interface CuerpoObjetoR2 extends ObjetoR2 {
  body?: ReadableStream | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AlmacenR2 {
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ): Promise<ObjetoR2 | null>;
  get(key: string): Promise<CuerpoObjetoR2 | null>;
  list(options?: { prefix?: string; limit?: number; cursor?: string; include?: string[] }): Promise<{
    objects: ObjetoR2[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

export const PREFIJO_R2_DIARIOS = "respaldos/diarios/";
export const PREFIJO_R2_MANUALES = "respaldos/manuales/";
export const PREFIJO_R2_MENSUALES = "respaldos/mensuales/";
export const RETENCION_DIAS_R2 = 30;
export const CONSERVACION_FISCAL_ANIOS = 10;

const CLAVE_FECHA_AUTO = "ultimo_respaldo_r2_fecha";
const CLAVE_MES_ARCHIVO = "ultimo_archivo_mensual_r2";
const CLAVE_META_AUTO = "ultimo_respaldo_r2_meta";
const CLAVE_ERROR_R2 = "ultimo_error_respaldo_r2";

export function obtenerBucketR2(env?: Record<string, unknown>): AlmacenR2 | null {
  const b = env?.RESPALDOS_R2 as Partial<AlmacenR2> | undefined;
  if (!b || typeof b.put !== "function" || typeof b.get !== "function" || typeof b.list !== "function" || typeof b.delete !== "function") {
    return null;
  }
  return b as AlmacenR2;
}

export function claveR2Valida(key: string): boolean {
  const k = String(key ?? "").trim();
  if (!k || k.length > 200) return false;
  if (k.includes("..") || k.includes("\\") || /[\x00-\x1f]/.test(k)) return false;
  return (
    (k.startsWith(PREFIJO_R2_DIARIOS) ||
      k.startsWith(PREFIJO_R2_MANUALES) ||
      k.startsWith(PREFIJO_R2_MENSUALES)) &&
    k.endsWith(".json")
  );
}

function extraerFechaDeClave(key: string): string | null {
  const mDia = key.match(/^respaldos\/(?:diarios|manuales)\/(\d{4}-\d{2}-\d{2})\//);
  if (mDia) return mDia[1];
  const mMes = key.match(/^respaldos\/mensuales\/(\d{4}-\d{2})\//);
  return mMes ? mMes[1] : null;
}

function restarDiasIso(fechaIso: string, dias: number): string {
  const f = new Date(`${fechaIso}T12:00:00Z`);
  f.setUTCDate(f.getUTCDate() - dias);
  return f.toISOString().slice(0, 10);
}

function sanitizarCodigo(cod: string): string {
  return String(cod || "principal").toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 32) || "principal";
}

export type ErrorRespaldoR2 = {
  tipo: "diario" | "mensual" | "manual";
  fecha: string;
  mensaje: string;
  registrado_en: string;
};

export async function registrarErrorR2(
  rawDb: D1Database,
  tipo: "diario" | "mensual" | "manual",
  fecha: string,
  err: unknown
) {
  const mensaje = String((err as Error)?.message || err || "Error desconocido en respaldo R2").slice(0, 300);
  const ahoraIso = new Date().toISOString();
  const payload: ErrorRespaldoR2 = { tipo, fecha, mensaje, registrado_en: ahoraIso };
  await rawDb
    .prepare(
      `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?)
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
    )
    .bind(CLAVE_ERROR_R2, JSON.stringify(payload), ahoraIso)
    .run()
    .catch(() => {});
  await rawDb
    .prepare(`INSERT INTO auditoria (usuario_id, accion, detalle, ip) VALUES (NULL, 'RESPALDO_R2_ERROR', ?, 'cron')`)
    .bind(`${tipo} ${fecha}: ${mensaje}`)
    .run()
    .catch(() => {});
}

export async function limpiarErrorR2(rawDb: D1Database) {
  await rawDb.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(CLAVE_ERROR_R2).run().catch(() => {});
}

export async function leerUltimoErrorR2(rawDb: D1Database): Promise<ErrorRespaldoR2 | null> {
  const fila = await rawDb
    .prepare(`SELECT valor FROM integraciones WHERE clave = ?`)
    .bind(CLAVE_ERROR_R2)
    .first<{ valor: string }>()
    .catch(() => null);
  if (!fila?.valor) return null;
  try {
    return JSON.parse(fila.valor) as ErrorRespaldoR2;
  } catch {
    return null;
  }
}

// Poda ÚNICAMENTE respaldos diarios antiguos (> 30 días). NUNCA toca `respaldos/mensuales/` (conservación fiscal 10 años) ni `respaldos/manuales/`.
export async function podarRespaldosDiariosAntiguos(
  bucket: AlmacenR2,
  hoyIso = fechaCaracas(),
  retencionDias = RETENCION_DIAS_R2
): Promise<number> {
  const corte = restarDiasIso(hoyIso, Math.max(1, retencionDias));
  let cursor: string | undefined;
  const aBorrar: string[] = [];
  for (let pagina = 0; pagina < 10; pagina++) {
    const res = await bucket.list({ prefix: PREFIJO_R2_DIARIOS, limit: 200, cursor });
    for (const obj of res.objects || []) {
      if (!obj.key.startsWith(PREFIJO_R2_DIARIOS)) continue;
      const fechaObj = extraerFechaDeClave(obj.key);
      if (fechaObj && fechaObj.length === 10 && fechaObj < corte) {
        aBorrar.push(obj.key);
      }
    }
    if (!res.truncated || !res.cursor) break;
    cursor = res.cursor;
  }
  if (!aBorrar.length) return 0;
  for (let i = 0; i < aBorrar.length; i += 100) {
    await bucket.delete(aBorrar.slice(i, i + 100));
  }
  return aBorrar.length;
}

export type ResultadoRespaldoR2 = {
  ok: true;
  tipo: "diario" | "manual" | "mensual";
  fecha: string;
  generado_en: string;
  claves: string[];
  bytes_totales: number;
  total_empresas: number;
  firmado: boolean;
  podados: number;
};

// Genera y sube a R2 un archivo JSON independiente por cada empresa para mantener el consumo de memoria acotado en Workers.
export async function ejecutarRespaldoR2(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  opts?: { tipo?: "diario" | "manual" | "mensual"; hoyIso?: string; mesIso?: string; retencionDias?: number }
): Promise<ResultadoRespaldoR2> {
  const bucket = obtenerBucketR2(envObj);
  if (!bucket) {
    throw new Error("El bucket Cloudflare R2 (RESPALDOS_R2) no está vinculado en este Worker.");
  }
  const tipo: "diario" | "manual" | "mensual" =
    opts?.tipo === "manual" ? "manual" : opts?.tipo === "mensual" ? "mensual" : "diario";
  const hoyIso = opts?.hoyIso || fechaCaracas();
  const mesIso = opts?.mesIso || hoyIso.slice(0, 7);
  const etiquetaFecha = tipo === "mensual" ? mesIso : hoyIso;
  const generadoEn = new Date().toISOString();
  const stamp = generadoEn.replace(/[:.]/g, "-").slice(0, 19) + "Z";

  await asegurarTablasMultiTenant(rawDb);
  const { results: filasInq } = await rawDb
    .prepare(`SELECT codigo FROM _mt_inquilinos ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en ASC`)
    .all<{ codigo: string }>()
    .catch(() => ({ results: [] as { codigo: string }[] }));
  const codigos = (filasInq.length ? filasInq.map((r) => String(r.codigo)) : ["principal"]).filter((c) => c !== "DB_DEMO");

  const claves: string[] = [];
  let bytesTotales = 0;
  const totalEmpresas = codigos.length;
  let firmado = true;

  for (const cod of codigos) {
    const maestro = await generarRespaldoMaestro(rawDb, envObj, { codigo: cod });
    if (!maestro.firma_hmac) firmado = false;
    const codSeguro = sanitizarCodigo(cod);
    const key =
      tipo === "mensual"
        ? `${PREFIJO_R2_MENSUALES}${mesIso}/respaldo-fiscal-${mesIso}-${codSeguro}.json`
        : tipo === "diario"
          ? `${PREFIJO_R2_DIARIOS}${hoyIso}/respaldo-${hoyIso}-${codSeguro}.json`
          : `${PREFIJO_R2_MANUALES}${hoyIso}/respaldo-${stamp}-${codSeguro}.json`;

    const cuerpo = JSON.stringify(maestro);
    const tamBytes = new TextEncoder().encode(cuerpo).length;
    await bucket.put(key, cuerpo, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {
        tipo,
        fecha: etiquetaFecha,
        empresa: cod,
        generado_en: maestro.generado_en,
        total_empresas: String(totalEmpresas),
        empresas_en_archivo: "1",
        firmado: maestro.firma_hmac ? "1" : "0",
        conservacion: tipo === "mensual" ? `${CONSERVACION_FISCAL_ANIOS}_anios` : `${RETENCION_DIAS_R2}_dias`,
        huella: String(maestro.huella || "").slice(0, 64),
        version: "4.5",
      },
    });
    claves.push(key);
    bytesTotales += tamBytes;
  }

  const podados =
    tipo === "diario"
      ? await podarRespaldosDiariosAntiguos(bucket, hoyIso, opts?.retencionDias ?? RETENCION_DIAS_R2).catch(() => 0)
      : 0;

  const meta = {
    tipo,
    fecha: etiquetaFecha,
    generado_en: generadoEn,
    claves,
    bytes_totales: bytesTotales,
    total_empresas: totalEmpresas,
    firmado,
    podados,
  };
  await rawDb
    .prepare(
      `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?)
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
    )
    .bind(CLAVE_META_AUTO, JSON.stringify(meta), generadoEn)
    .run()
    .catch(() => {});
  await limpiarErrorR2(rawDb);

  return { ok: true, ...meta };
}

// Ejecutado desde el Cron Trigger: garantiza como máximo 1 respaldo diario automático por día (hora Caracas).
export async function intentarRespaldoDiarioR2(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  hoyIso = fechaCaracas()
): Promise<{ ejecutado: boolean; resultado?: ResultadoRespaldoR2; motivo?: string }> {
  const bucket = obtenerBucketR2(envObj);
  if (!bucket) return { ejecutado: false, motivo: "SIN_BUCKET_R2" };

  const previo = await rawDb
    .prepare(`SELECT valor FROM integraciones WHERE clave = ?`)
    .bind(CLAVE_FECHA_AUTO)
    .first<{ valor: string }>()
    .catch(() => null);
  if (previo?.valor === hoyIso) {
    return { ejecutado: false, motivo: "YA_RESPALDADO_HOY" };
  }

  const ahoraIso = new Date().toISOString();
  await rawDb
    .prepare(`INSERT OR IGNORE INTO integraciones (clave, valor, actualizado_en) VALUES (?, '', ?)`)
    .bind(CLAVE_FECHA_AUTO, ahoraIso)
    .run()
    .catch(() => {});
  const reclamo = await rawDb
    .prepare(`UPDATE integraciones SET valor = ?, actualizado_en = ? WHERE clave = ? AND valor <> ?`)
    .bind(hoyIso, ahoraIso, CLAVE_FECHA_AUTO, hoyIso)
    .run()
    .catch(() => null);
  if (!reclamo || Number(reclamo.meta?.changes ?? 0) !== 1) {
    return { ejecutado: false, motivo: "YA_RECLAMADO" };
  }

  try {
    const resultado = await ejecutarRespaldoR2(rawDb, envObj, { tipo: "diario", hoyIso });
    await rawDb
      .prepare(`INSERT INTO auditoria (usuario_id, accion, detalle, ip) VALUES (NULL, 'RESPALDO_R2_AUTO', ?, 'cron')`)
      .bind(`${hoyIso} · ${resultado.total_empresas} emp · ${resultado.bytes_totales} B · ${resultado.firmado ? "HMAC" : "SIN_FIRMA"}`)
      .run()
      .catch(() => {});
    return { ejecutado: true, resultado };
  } catch (e) {
    await rawDb
      .prepare(`UPDATE integraciones SET valor = ? WHERE clave = ? AND valor = ?`)
      .bind(previo?.valor ?? "", CLAVE_FECHA_AUTO, hoyIso)
      .run()
      .catch(() => {});
    await registrarErrorR2(rawDb, "diario", hoyIso, e);
    throw e;
  }
}

// Archivo Fiscal Mensual inmutable en R2 (conservación 10+ años, jamás podado automáticamente).
// Archiva el mes anterior cerrado (YYYY-MM) de forma atómica e idempotente en cada inicio de mes.
export async function intentarArchivoMensualR2(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  hoyIso = fechaCaracas(),
  mesForzado?: string
): Promise<{ ejecutado: boolean; resultado?: ResultadoRespaldoR2; motivo?: string; mes?: string }> {
  const bucket = obtenerBucketR2(envObj);
  if (!bucket) return { ejecutado: false, motivo: "SIN_BUCKET_R2" };

  const mesObjetivo = mesForzado || mesAnteriorCaracas(hoyIso);
  const previo = await rawDb
    .prepare(`SELECT valor FROM integraciones WHERE clave = ?`)
    .bind(CLAVE_MES_ARCHIVO)
    .first<{ valor: string }>()
    .catch(() => null);
  if (previo?.valor === mesObjetivo) {
    return { ejecutado: false, motivo: "YA_ARCHIVADO_MES", mes: mesObjetivo };
  }

  const ahoraIso = new Date().toISOString();
  await rawDb
    .prepare(`INSERT OR IGNORE INTO integraciones (clave, valor, actualizado_en) VALUES (?, '', ?)`)
    .bind(CLAVE_MES_ARCHIVO, ahoraIso)
    .run()
    .catch(() => {});
  const reclamo = await rawDb
    .prepare(`UPDATE integraciones SET valor = ?, actualizado_en = ? WHERE clave = ? AND valor <> ?`)
    .bind(mesObjetivo, ahoraIso, CLAVE_MES_ARCHIVO, mesObjetivo)
    .run()
    .catch(() => null);
  if (!reclamo || Number(reclamo.meta?.changes ?? 0) !== 1) {
    return { ejecutado: false, motivo: "YA_RECLAMADO_MES", mes: mesObjetivo };
  }

  try {
    const resultado = await ejecutarRespaldoR2(rawDb, envObj, { tipo: "mensual", hoyIso, mesIso: mesObjetivo });
    await rawDb
      .prepare(`INSERT INTO auditoria (usuario_id, accion, detalle, ip) VALUES (NULL, 'RESPALDO_R2_MENSUAL', ?, 'cron')`)
      .bind(`${mesObjetivo} · ${resultado.total_empresas} emp · ${resultado.bytes_totales} B · ${resultado.firmado ? "HMAC" : "SIN_FIRMA"}`)
      .run()
      .catch(() => {});
    return { ejecutado: true, resultado, mes: mesObjetivo };
  } catch (e) {
    await rawDb
      .prepare(`UPDATE integraciones SET valor = ? WHERE clave = ? AND valor = ?`)
      .bind(previo?.valor ?? "", CLAVE_MES_ARCHIVO, mesObjetivo)
      .run()
      .catch(() => {});
    await registrarErrorR2(rawDb, "mensual", mesObjetivo, e);
    throw e;
  }
}

export async function listarRespaldosR2(rawDb: D1Database, envObj: Record<string, unknown>, limite = 60) {
  const bucket = obtenerBucketR2(envObj);
  const [filaMeta, ultimoError] = await Promise.all([
    rawDb
      .prepare(`SELECT valor FROM integraciones WHERE clave = ?`)
      .bind(CLAVE_META_AUTO)
      .first<{ valor: string }>()
      .catch(() => null),
    leerUltimoErrorR2(rawDb),
  ]);
  let ultimo: Record<string, unknown> | null = null;
  if (filaMeta?.valor) {
    try {
      ultimo = JSON.parse(filaMeta.valor) as Record<string, unknown>;
    } catch {}
  }

  if (!bucket) {
    return {
      ok: true,
      configurado: false,
      retencion_dias: RETENCION_DIAS_R2,
      conservacion_fiscal_anios: CONSERVACION_FISCAL_ANIOS,
      ultimo_respaldo: ultimo,
      ultimo_error: ultimoError,
      objetos: [] as Record<string, unknown>[],
    };
  }

  const res = await bucket.list({ prefix: "respaldos/", limit: Math.min(200, Math.max(1, limite)), include: ["customMetadata"] });
  const objetos = (res.objects || [])
    .filter((o) => claveR2Valida(o.key))
    .map((o) => {
      const m = o.customMetadata || {};
      const fecha = m.fecha || extraerFechaDeClave(o.key) || "";
      const tipo =
        m.tipo ||
        (o.key.startsWith(PREFIJO_R2_MENSUALES)
          ? "mensual"
          : o.key.startsWith(PREFIJO_R2_MANUALES)
            ? "manual"
            : "diario");
      const uploaded = o.uploaded instanceof Date ? o.uploaded.toISOString() : String(o.uploaded || m.generado_en || "");
      return {
        key: o.key,
        nombre: o.key.split("/").pop() || o.key,
        tipo,
        empresa: m.empresa || null,
        fecha,
        size: Number(o.size || 0),
        uploaded,
        total_empresas: Number(m.total_empresas || 0) || null,
        firmado: m.firmado === "1",
      };
    })
    .sort((a, b) => String(b.uploaded || b.key).localeCompare(String(a.uploaded || a.key)));

  return {
    ok: true,
    configurado: true,
    retencion_dias: RETENCION_DIAS_R2,
    conservacion_fiscal_anios: CONSERVACION_FISCAL_ANIOS,
    ultimo_respaldo: ultimo,
    ultimo_error: ultimoError,
    objetos,
  };
}
