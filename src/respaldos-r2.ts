// Respaldos Automáticos Diarios y Archivo Fiscal Mensual en Cloudflare R2 (v4.5).
// - Diarios (`respaldos/diarios/YYYY-MM-DD/`): 1 archivo por empresa (evita pico de RAM en Workers), podados a los 30 días.
// - Archivo Fiscal Mensual (`respaldos/mensuales/YYYY-MM/`): conservación a largo plazo (10+ años, Art. 55 y 155 COT), NUNCA podados automáticamente.
// - Manuales (`respaldos/manuales/YYYY-MM-DD/`): bajo demanda, nunca podados automáticamente.
// - Descargas en streaming vía `obj.body` y registro de errores de Cron visible para el Súper Administrador.
import { fechaCaracas } from "./comun";
import { asegurarTablasMultiTenant, hidratarBindingsCloudflare, obtenerDbInquilino } from "./inquilinos";
import { migrar } from "./migraciones";
import { crearHasherSha256Streaming, emitirRespaldoEmpresaStreaming } from "./salud-bd";
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

export interface ParteMultipartR2 {
  partNumber: number;
  etag: string;
}

export interface SubidaMultipartR2 {
  key: string;
  uploadId: string;
  uploadPart(partNumber: number, value: Uint8Array | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | string): Promise<ParteMultipartR2>;
  complete(uploadedParts: ParteMultipartR2[]): Promise<ObjetoR2>;
  abort(): Promise<void>;
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
  createMultipartUpload?(
    key: string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ): Promise<SubidaMultipartR2>;
}

export const PREFIJO_R2_DIARIOS = "respaldos/diarios/";
export const PREFIJO_R2_MANUALES = "respaldos/manuales/";
export const PREFIJO_R2_MENSUALES = "respaldos/mensuales/";
export const PREFIJO_R2_RETENCION = "respaldos/archivo-retencion/";
export const RETENCION_DIAS_R2 = 30;
export const CONSERVACION_FISCAL_ANIOS = 10;
const TAM_PARTE_MULTIPART_DEFECTO = 5 * 1024 * 1024; // 5 MiB (mínimo oficial de R2/S3 excepto última parte)

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
  if (!k || k.length > 220) return false;
  if (k.includes("..") || k.includes("\\") || /[\x00-\x1f]/.test(k)) return false;
  const prefijoOk =
    k.startsWith(PREFIJO_R2_DIARIOS) ||
    k.startsWith(PREFIJO_R2_MANUALES) ||
    k.startsWith(PREFIJO_R2_MENSUALES) ||
    k.startsWith(PREFIJO_R2_RETENCION);
  return prefijoOk && (k.endsWith(".json") || k.endsWith(".json.gz"));
}

function extraerFechaDeClave(key: string): string | null {
  const mDia = key.match(/^respaldos\/(?:diarios|manuales)\/(\d{4}-\d{2}-\d{2})\//);
  if (mDia) return mDia[1];
  const mMes = key.match(/^respaldos\/(?:mensuales|archivo-retencion)\/(\d{4}-\d{2})\//);
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
  errores_empresas?: string[];
  partes_subidas?: number;
};

function concatenarChunks(chunks: Uint8Array[], totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const ch of chunks) {
    out.set(ch, pos);
    pos += ch.byteLength;
  }
  return out;
}

// Comprime en streaming con CompressionStream('gzip') y sube por partes (createMultipartUpload) cuando el bucket lo soporta
// o hace fallback limpio a bucket.put con el buffer comprimido cuando el almacenamiento local/mock no expone multipart.
async function subirStreamComprimidoR2(
  bucket: AlmacenR2,
  key: string,
  productor: (escribir: (texto: string) => Promise<void>) => Promise<{
    sha256_datos: string;
    firma_hmac: string;
    generado_en: string;
  }>,
  baseMetadata: Record<string, string>,
  tamParteBytes = TAM_PARTE_MULTIPART_DEFECTO
): Promise<{ bytes: number; partes: number; sha256_gz: string; firmado: boolean }> {
  const encUtf8 = new TextEncoder();
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const hasherGz = crearHasherSha256Streaming();

  type MetaProd = { sha256_datos: string; firma_hmac: string; generado_en: string };
  let errorProductor: unknown = null;

  const tareaProductor: Promise<MetaProd | null> = (async () => {
    try {
      const m = await productor(async (textoChunk: string) => {
        if (!textoChunk) return;
        await writer.write(encUtf8.encode(textoChunk));
      });
      await writer.close();
      return m;
    } catch (e) {
      errorProductor = e;
      await writer.abort(e).catch(() => {});
      return null;
    }
  })();

  const soportaMultipart = typeof bucket.createMultipartUpload === "function";
  let multipart: SubidaMultipartR2 | null = null;
  const partesSubidas: ParteMultipartR2[] = [];
  let bufChunks: Uint8Array[] = [];
  let bufBytes = 0;
  let totalBytes = 0;
  const todosFallback: Uint8Array[] = [];
  const metaInicial: Record<string, string> = {
    ...baseMetadata,
    formato: "json.gz.v2",
    version: "5.6",
  };

  try {
    if (soportaMultipart) {
      multipart = await bucket.createMultipartUpload!(key, {
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: metaInicial,
      });
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      await hasherGz.update(chunk);
      totalBytes += chunk.byteLength;

      if (multipart) {
        bufChunks.push(chunk);
        bufBytes += chunk.byteLength;
        while (bufBytes >= tamParteBytes) {
          const unido = concatenarChunks(bufChunks, bufBytes);
          const parteBytes = unido.subarray(0, tamParteBytes);
          const resto = unido.subarray(tamParteBytes);
          const partNumber = partesSubidas.length + 1;
          const uploaded = await multipart.uploadPart(partNumber, parteBytes);
          partesSubidas.push(uploaded);
          bufChunks = resto.byteLength ? [resto] : [];
          bufBytes = resto.byteLength;
        }
      } else {
        todosFallback.push(chunk);
      }
    }

    const metaProd = await tareaProductor;
    if (errorProductor) throw errorProductor;

    const sha256_gz = await hasherGz.digestHex();
    const metaFinal: Record<string, string> = {
      ...metaInicial,
      generado_en: metaProd?.generado_en || baseMetadata.generado_en || new Date().toISOString(),
      firmado: metaProd?.firma_hmac ? "1" : "0",
      huella: String(metaProd?.sha256_datos || "").slice(0, 64),
      sha256_datos: String(metaProd?.sha256_datos || "").slice(0, 64),
      sha256_gz,
      ...(metaProd?.firma_hmac ? { firma_hmac: metaProd.firma_hmac } : {}),
    };

    if (multipart) {
      if (bufBytes > 0 || partesSubidas.length === 0) {
        const ultimo = concatenarChunks(bufChunks, bufBytes);
        const partNumber = partesSubidas.length + 1;
        const uploaded = await multipart.uploadPart(partNumber, ultimo);
        partesSubidas.push(uploaded);
      }
      await multipart.complete(partesSubidas);
      return { bytes: totalBytes, partes: partesSubidas.length, sha256_gz, firmado: Boolean(metaProd?.firma_hmac) };
    }

    const cuerpoFinal = concatenarChunks(todosFallback, totalBytes);
    await bucket.put(key, cuerpoFinal, {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: metaFinal,
    });
    return { bytes: totalBytes, partes: 1, sha256_gz, firmado: Boolean(metaProd?.firma_hmac) };
  } catch (e) {
    if (multipart) await multipart.abort().catch(() => {});
    await tareaProductor.catch(() => {});
    throw e;
  }
}

// Genera y sube a R2 un archivo .json.gz independiente por cada empresa en streaming (keyset pagination + gzip + multipart + HMAC v2).
// Aísla fallos por empresa con try/catch: si una BD falla, las restantes completan su respaldo sin abortar el lote.
export async function ejecutarRespaldoR2(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  opts?: {
    tipo?: "diario" | "manual" | "mensual";
    hoyIso?: string;
    mesIso?: string;
    retencionDias?: number;
    codigos?: string[];
    omitirPoda?: boolean;
    tamParteBytes?: number;
    pageSize?: number;
  }
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
  await hidratarBindingsCloudflare(rawDb, envObj);
  const [resInq, resDir] = await Promise.all([
    rawDb.prepare(`SELECT * FROM _mt_inquilinos ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en ASC`).all<Record<string, unknown>>().catch(() => ({ results: [] as Record<string, unknown>[] })),
    rawDb.prepare(`SELECT * FROM _mt_directorio ORDER BY email ASC`).all<Record<string, unknown>>().catch(() => ({ results: [] as Record<string, unknown>[] })),
  ]);
  const mtInq = resInq.results ?? [];
  const mtDir = resDir.results ?? [];

  let codigos: string[];
  if (Array.isArray(opts?.codigos) && opts.codigos.length > 0) {
    codigos = opts.codigos.map((c) => String(c || "").trim()).filter((c) => c && c !== "DB_DEMO");
  } else {
    codigos = (mtInq.length ? mtInq.map((r) => String(r.codigo)) : ["principal"]).filter((c) => c !== "DB_DEMO");
  }

  const claves: string[] = [];
  const erroresEmpresas: string[] = [];
  let bytesTotales = 0;
  let partesTotales = 0;
  const totalEmpresas = codigos.length;
  let firmado = true;

  for (const cod of codigos) {
    try {
      const dbInq = cod === "principal" ? rawDb : obtenerDbInquilino({ ...envObj, DB: rawDb }, cod);
      await migrar(dbInq);
      const codSeguro = sanitizarCodigo(cod);
      const key =
        tipo === "mensual"
          ? `${PREFIJO_R2_MENSUALES}${mesIso}/respaldo-fiscal-${mesIso}-${codSeguro}.json.gz`
          : tipo === "diario"
            ? `${PREFIJO_R2_DIARIOS}${hoyIso}/respaldo-${hoyIso}-${codSeguro}.json.gz`
            : `${PREFIJO_R2_MANUALES}${hoyIso}/respaldo-${stamp}-${codSeguro}.json.gz`;

      const subida = await subirStreamComprimidoR2(
        bucket,
        key,
        (escribir) =>
          emitirRespaldoEmpresaStreaming(
            rawDb,
            dbInq,
            envObj,
            cod,
            { mtInq, mtDir, totalEmpresas: mtInq.length || 1 },
            escribir,
            { pageSize: opts?.pageSize }
          ),
        {
          tipo,
          fecha: etiquetaFecha,
          empresa: cod,
          generado_en: generadoEn,
          total_empresas: String(totalEmpresas),
          empresas_en_archivo: "1",
          firmado: String(envObj?.MASTER_KEY ?? "").trim() ? "1" : "0",
          conservacion: tipo === "mensual" ? `${CONSERVACION_FISCAL_ANIOS}_anios` : `${RETENCION_DIAS_R2}_dias`,
        },
        opts?.tamParteBytes ?? TAM_PARTE_MULTIPART_DEFECTO
      );

      if (!subida.firmado) firmado = false;
      claves.push(key);
      bytesTotales += subida.bytes;
      partesTotales += subida.partes;
    } catch (errEmp) {
      const msg = String((errEmp as Error)?.message || errEmp || "Error en respaldo").slice(0, 180);
      erroresEmpresas.push(`${cod}: ${msg}`);
    }
  }

  if (claves.length === 0 && erroresEmpresas.length > 0) {
    throw new Error(`Ninguna empresa pudo respaldarse en R2 (${erroresEmpresas.slice(0, 3).join(" | ")})`);
  }

  const podados =
    tipo === "diario" && !opts?.omitirPoda
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
    partes_subidas: partesTotales,
    ...(erroresEmpresas.length ? { errores_empresas: erroresEmpresas } : {}),
  };
  await rawDb
    .prepare(
      `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?)
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
    )
    .bind(CLAVE_META_AUTO, JSON.stringify(meta), generadoEn)
    .run()
    .catch(() => {});

  if (erroresEmpresas.length > 0) {
    await registrarErrorR2(rawDb, tipo, etiquetaFecha, new Error(`Respaldo parcial (${claves.length}/${totalEmpresas}): ${erroresEmpresas.slice(0, 3).join(" | ")}`));
  } else {
    await limpiarErrorR2(rawDb);
  }

  return { ok: true, ...meta };
}

// Archiva en R2 (gzip) registros históricos de retención (>12 meses) de auditoria y correo_envios antes de purgarlos de D1 (v5.6 · Sección 9.4).
export async function archivarRetencionR2(
  bucket: AlmacenR2,
  codigo: string,
  tabla: "auditoria" | "correo_envios",
  filas: Record<string, unknown>[],
  hoyIso = fechaCaracas()
): Promise<{ key: string; bytes: number; filas: number }> {
  const mesIso = hoyIso.slice(0, 7);
  const codSeguro = sanitizarCodigo(codigo);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const key = `${PREFIJO_R2_RETENCION}${mesIso}/${codSeguro}-${tabla}-${stamp}.json.gz`;
  const payload = JSON.stringify({
    formato: "archivo-retencion-facturaya",
    version: 1,
    empresa: codigo,
    tabla,
    archivado_en: new Date().toISOString(),
    corte_fecha: hoyIso,
    total_filas: filas.length,
    filas,
  });
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  const writeP = writer.write(new TextEncoder().encode(payload)).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = cs.readable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value?.byteLength) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  await writeP;
  const gz = concatenarChunks(chunks, total);
  await bucket.put(key, gz, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: {
      tipo: "archivo_retencion",
      formato: "json.gz.v2",
      empresa: codigo,
      tabla,
      fecha: mesIso,
      filas: String(filas.length),
      conservacion: `${CONSERVACION_FISCAL_ANIOS}_anios`,
      version: "5.6",
    },
  });
  return { key, bytes: gz.byteLength, filas: filas.length };
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
            : o.key.startsWith(PREFIJO_R2_RETENCION)
              ? "archivo_retencion"
              : "diario");
      const uploaded = o.uploaded instanceof Date ? o.uploaded.toISOString() : String(o.uploaded || m.generado_en || "");
      return {
        key: o.key,
        nombre: o.key.split("/").pop() || o.key,
        tipo,
        formato: m.formato || (o.key.endsWith(".json.gz") ? "json.gz.v2" : "json.v1"),
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
