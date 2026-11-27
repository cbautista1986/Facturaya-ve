// Conector centralizado de Tasa Oficial BCV (1 consulta compartida para 100+ empresas)
// y Despachador de Cierre Contable Mensual por Correo (Brevo / Resend por inquilino).
// v5.6: Fuente oficial bcv.org.ve prioritaria con fecha_valor real, validación cruzada (>0.5%),
// tope de variación anómala (15% con aprobación manual), feriados BCV y bloqueo fiscal en modo REAL.
import { aTasaE8, aRifSeniat, estadoSemaforoTasaBcv } from "../public/dinero.js";
import { EMAIL, fechaCaracas, modoActual } from "./comun";
import { enviarCorreo, leerConfigCorreo } from "./correo";
import { normalizarTipoContribuyente, reglasRegimen } from "./regimen";
import { esSuperAdmin } from "./permisos";

export type TasaBcvGlobal = {
  tasa_bcv: string;
  fuente: string;
  fecha_valor: string;
  fecha_valor_asumida?: number; // 0 = extraída de la fuente oficial, 1 = asumida con fecha actual
  actualizado_en: string;
  desde_cache?: boolean;
  alerta_discrepancia?: string;
  pendiente_aprobacion?: boolean;
  tasa_pendiente?: TasaPendienteBcv | null;
};

export type TasaPendienteBcv = {
  tasa_bcv: string;
  fuente: string;
  fecha_valor: string;
  fecha_valor_asumida: number;
  tasa_anterior: string;
  variacion_pct: number;
  detectada_en: string;
};

export type ConfigSemaforoBcv = {
  feriados: string[];
  sin_publicacion_hoy: string; // YYYY-MM-DD o ""
};

export type ResultadoConsultaBcv = {
  tasa_bcv: string;
  fuente: string;
  fecha_valor: string;
  fecha_valor_asumida: number;
  alerta_discrepancia?: string;
};

const TTL_CACHE_BCV_MS = 4 * 60 * 60 * 1000; // 4 horas entre consultas externas
const CLAVE_FERIADOS_BCV = "tasa_bcv_feriados";
const CLAVE_TASA_PENDIENTE_BCV = "tasa_bcv_pendiente";
const FECHA_ISO_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const ahoraSqlUtc = () => new Date().toISOString().slice(0, 19).replace("T", " ");

function parsearFechaUtcMs(f: unknown): number {
  if (f === null || f === undefined) return 0;
  const s = String(f).trim();
  if (!s) return 0;
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    return s.length <= 10 ? n * 1000 : n;
  }
  const iso = s.replace(" ", "T");
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

export async function asegurarTablaTasaBcvGlobal(rawDb: D1Database): Promise<void> {
  await rawDb
    .prepare(
      `CREATE TABLE IF NOT EXISTS _mt_tasa_bcv_global (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tasa_bcv TEXT NOT NULL,
        fuente TEXT NOT NULL,
        fecha_valor TEXT NOT NULL,
        fecha_valor_asumida INTEGER NOT NULL DEFAULT 0,
        actualizado_en TEXT NOT NULL
      )`
    )
    .run();
  await rawDb
    .prepare(`ALTER TABLE _mt_tasa_bcv_global ADD COLUMN fecha_valor_asumida INTEGER NOT NULL DEFAULT 0`)
    .run()
    .catch(() => {});
}

function normalizarTasaTexto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const limpio = String(valor).trim().replace(/\s+/g, "").replace(",", ".");
  const num = Number(limpio);
  if (!Number.isFinite(num) || num <= 1 || num > 1_000_000) return null;
  // Redondea a máximo 4 decimales significativos (mínimo 2 decimales si tiene fracción)
  const fijo4 = num.toFixed(4).replace(/(\.\d{2})0+$/, "$1").replace(/\.00$/, "");
  const e8 = aTasaE8(fijo4);
  if (!e8 || Number.isNaN(e8) || e8 <= 0) return null;
  return fijo4;
}

const MESES_ES: Record<string, string> = {
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
  julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
};

function validarFechaIso(iso: string): string | null {
  if (!FECHA_ISO_RE.test(iso)) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

export function extraerFechaValorBcvHtml(html: string): string | null {
  // 1) Drupal date-display-single con content="2026-04-17T00:00:00-04:00" cerca de Fecha Valor
  const bloque = html.match(/Fecha\s*Valor[\s\S]{0,600}/i)?.[0] ?? html;
  const mIso = bloque.match(/content=["'](\d{4}-\d{2}-\d{2})(?:T[^"']*)?["']/i)
    || html.match(/date-display-single[^>]*content=["'](\d{4}-\d{2}-\d{2})/i);
  if (mIso?.[1]) {
    const ok = validarFechaIso(mIso[1]);
    if (ok) return ok;
  }
  // 2) Formato numérico DD/MM/YYYY o DD-MM-YYYY cerca de Fecha Valor
  const mDmy = bloque.match(/\b(\d{2})[/-](\d{2})[/-](\d{4})\b/);
  if (mDmy) {
    const ok = validarFechaIso(`${mDmy[3]}-${mDmy[2]}-${mDmy[1]}`);
    if (ok) return ok;
  }
  // 3) Formato en español "Viernes, 17 Abril 2026" o "17 de abril de 2026"
  const mEs = bloque.match(/\b(\d{1,2})\s+(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(?:de\s+)?(\d{4})\b/i);
  if (mEs) {
    const mm = MESES_ES[mEs[2].toLowerCase()];
    const dd = mEs[1].padStart(2, "0");
    if (mm) {
      const ok = validarFechaIso(`${mEs[3]}-${mm}-${dd}`);
      if (ok) return ok;
    }
  }
  return null;
}

async function consultarBcvDirecto(fetchFn: typeof fetch, hoy: string): Promise<ResultadoConsultaBcv | null> {
  try {
    const r = await fetchFn("https://www.bcv.org.ve/", {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m =
      html.match(/id=["']dolar["'][\s\S]{0,600}?<strong>\s*([0-9]+[.,][0-9]+)\s*<\/strong>/i) ||
      html.match(/USD[\s\S]{0,300}?<strong>\s*([0-9]+[.,][0-9]+)\s*<\/strong>/i);
    if (!m?.[1]) return null;
    const tasa = normalizarTasaTexto(m[1]);
    if (!tasa) return null;
    const fvReal = extraerFechaValorBcvHtml(html);
    return {
      tasa_bcv: tasa,
      fuente: "BCV Oficial (bcv.org.ve)",
      fecha_valor: fvReal ?? hoy,
      fecha_valor_asumida: fvReal ? 0 : 1,
    };
  } catch {
    return null;
  }
}

async function consultarDolarApi(fetchFn: typeof fetch, hoy: string): Promise<ResultadoConsultaBcv | null> {
  try {
    const r = await fetchFn("https://ve.dolarapi.com/v1/dolares/oficial", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3500),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { promedio?: unknown; fechaActualizacion?: string; fechaValor?: string };
    const tasa = normalizarTasaTexto(j?.promedio);
    if (!tasa) return null;
    const fvExplicita = typeof j.fechaValor === "string" ? validarFechaIso(j.fechaValor.slice(0, 10)) : null;
    const fvAct = typeof j.fechaActualizacion === "string" ? validarFechaIso(j.fechaActualizacion.slice(0, 10)) : null;
    return {
      tasa_bcv: tasa,
      fuente: "BCV Oficial (DolarApi VE)",
      fecha_valor: fvExplicita ?? fvAct ?? hoy,
      fecha_valor_asumida: fvExplicita ? 0 : 1,
    };
  } catch {
    return null;
  }
}

async function consultarPyDolarVe(fetchFn: typeof fetch, hoy: string): Promise<ResultadoConsultaBcv | null> {
  try {
    const r = await fetchFn("https://pydolarve.org/api/v1/dollar?page=bcv", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3500),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      monitors?: { usd?: { price?: unknown; last_update?: string } };
      price?: unknown;
    };
    const precio = j?.monitors?.usd?.price ?? j?.price;
    const tasa = normalizarTasaTexto(precio);
    if (!tasa) return null;
    return {
      tasa_bcv: tasa,
      fuente: "BCV Oficial (PyDolarVE)",
      fecha_valor: hoy,
      fecha_valor_asumida: 1,
    };
  } catch {
    return null;
  }
}

function diferenciaRelativaPct(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb) || na <= 0 || nb <= 0) return 0;
  return (Math.abs(na - nb) / Math.min(na, nb)) * 100;
}

export async function consultarFuentesBcvOficial(
  fetchFn: typeof fetch = fetch
): Promise<ResultadoConsultaBcv | null> {
  const hoy = fechaCaracas();

  // Orden oficial SENIAT/BCV: 1) bcv.org.ve directo, 2) DolarApi VE (cruce y respaldo), 3) PyDolarVE (segundo respaldo).
  const [oficial, dolarApi] = await Promise.all([
    consultarBcvDirecto(fetchFn, hoy),
    consultarDolarApi(fetchFn, hoy),
  ]);

  if (oficial) {
    if (dolarApi) {
      const diffPct = diferenciaRelativaPct(oficial.tasa_bcv, dolarApi.tasa_bcv);
      if (diffPct > 0.5) {
        return {
          ...oficial,
          alerta_discrepancia: `Discrepancia de ${diffPct.toFixed(2)}% entre ${oficial.fuente} (${oficial.tasa_bcv}) y ${dolarApi.fuente} (${dolarApi.tasa_bcv}). Se aplicó la fuente oficial BCV.`,
        };
      }
    }
    return oficial;
  }

  // Si bcv.org.ve no respondió, consultamos PyDolarVE para validación cruzada con DolarApi (o respaldo si DolarApi falló)
  const pyDolar = await consultarPyDolarVe(fetchFn, hoy);
  if (dolarApi && pyDolar) {
    const diffPct = diferenciaRelativaPct(dolarApi.tasa_bcv, pyDolar.tasa_bcv);
    if (diffPct > 0.5) {
      return {
        ...dolarApi,
        alerta_discrepancia: `Discrepancia de ${diffPct.toFixed(2)}% entre ${dolarApi.fuente} (${dolarApi.tasa_bcv}) y ${pyDolar.fuente} (${pyDolar.tasa_bcv}) con bcv.org.ve no disponible.`,
      };
    }
    return dolarApi;
  }

  return dolarApi ?? pyDolar ?? null;
}

async function registrarAuditoriaGlobal(rawDb: D1Database, accion: string, detalle: string): Promise<void> {
  await rawDb
    .prepare(`INSERT INTO auditoria (usuario_id, accion, detalle) VALUES (NULL, ?, ?)`)
    .bind(accion, detalle.slice(0, 400))
    .run()
    .catch(() => {});
}

export async function leerConfigSemaforoBcv(rawDb: D1Database): Promise<ConfigSemaforoBcv> {
  const fila = await rawDb
    .prepare(`SELECT valor FROM integraciones WHERE clave = ?`)
    .bind(CLAVE_FERIADOS_BCV)
    .first<{ valor: string }>()
    .catch(() => null);
  if (!fila?.valor) return { feriados: [], sin_publicacion_hoy: "" };
  try {
    const p = JSON.parse(fila.valor) as { feriados?: unknown; sin_publicacion_hoy?: unknown };
    const feriados = Array.isArray(p?.feriados)
      ? [...new Set(p.feriados.map((x) => String(x || "").trim().slice(0, 10)).filter((x) => !!validarFechaIso(x)))].sort()
      : [];
    const sinPub = validarFechaIso(String(p?.sin_publicacion_hoy || "").trim().slice(0, 10)) ?? "";
    return { feriados, sin_publicacion_hoy: sinPub };
  } catch {
    return { feriados: [], sin_publicacion_hoy: "" };
  }
}

export async function guardarConfigSemaforoBcv(
  rawDb: D1Database,
  datos: { feriados?: string[]; sin_publicacion_hoy?: string | null }
): Promise<ConfigSemaforoBcv> {
  const actual = await leerConfigSemaforoBcv(rawDb);
  const feriados =
    datos.feriados !== undefined
      ? [...new Set(datos.feriados.map((x) => String(x || "").trim().slice(0, 10)).filter((x) => !!validarFechaIso(x)))].sort().slice(0, 60)
      : actual.feriados;
  const sin_publicacion_hoy =
    datos.sin_publicacion_hoy !== undefined
      ? (validarFechaIso(String(datos.sin_publicacion_hoy || "").trim().slice(0, 10)) ?? "")
      : actual.sin_publicacion_hoy;
  const cfg: ConfigSemaforoBcv = { feriados, sin_publicacion_hoy };
  await rawDb
    .prepare(
      `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, datetime('now'))
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
    )
    .bind(CLAVE_FERIADOS_BCV, JSON.stringify(cfg))
    .run();
  return cfg;
}

export async function leerTasaPendienteBcv(rawDb: D1Database): Promise<TasaPendienteBcv | null> {
  const fila = await rawDb
    .prepare(`SELECT valor FROM integraciones WHERE clave = ?`)
    .bind(CLAVE_TASA_PENDIENTE_BCV)
    .first<{ valor: string }>()
    .catch(() => null);
  if (!fila?.valor) return null;
  try {
    const p = JSON.parse(fila.valor) as TasaPendienteBcv;
    return p && p.tasa_bcv ? p : null;
  } catch {
    return null;
  }
}

export async function resolverTasaPendienteBcv(
  rawDb: D1Database,
  aprobar: boolean
): Promise<{ ok: true; aprobada: boolean; tasa?: TasaBcvGlobal } | { ok: false; error: string }> {
  await asegurarTablaTasaBcvGlobal(rawDb);
  const pendiente = await leerTasaPendienteBcv(rawDb);
  if (!pendiente) return { ok: false, error: "No hay ninguna tasa BCV pendiente de aprobación." };

  if (!aprobar) {
    await rawDb.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(CLAVE_TASA_PENDIENTE_BCV).run().catch(() => {});
    await registrarAuditoriaGlobal(rawDb, "TASA_BCV_PENDIENTE_RECHAZADA", `${pendiente.tasa_bcv} (${pendiente.fuente})`);
    return { ok: true, aprobada: false };
  }

  const ts = ahoraSqlUtc();
  await rawDb.batch([
    rawDb
      .prepare(
        `INSERT INTO _mt_tasa_bcv_global (id, tasa_bcv, fuente, fecha_valor, fecha_valor_asumida, actualizado_en)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tasa_bcv = excluded.tasa_bcv,
           fuente = excluded.fuente,
           fecha_valor = excluded.fecha_valor,
           fecha_valor_asumida = excluded.fecha_valor_asumida,
           actualizado_en = excluded.actualizado_en`
      )
      .bind(pendiente.tasa_bcv, `${pendiente.fuente} [Aprobada]`, pendiente.fecha_valor, pendiente.fecha_valor_asumida ?? 0, ts),
    rawDb.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(CLAVE_TASA_PENDIENTE_BCV),
  ]);
  await registrarAuditoriaGlobal(rawDb, "TASA_BCV_PENDIENTE_APROBADA", `${pendiente.tasa_anterior} -> ${pendiente.tasa_bcv} (${pendiente.variacion_pct.toFixed(2)}%)`);
  return {
    ok: true,
    aprobada: true,
    tasa: {
      tasa_bcv: pendiente.tasa_bcv,
      fuente: `${pendiente.fuente} [Aprobada]`,
      fecha_valor: pendiente.fecha_valor,
      fecha_valor_asumida: pendiente.fecha_valor_asumida ?? 0,
      actualizado_en: ts,
      desde_cache: false,
    },
  };
}

export async function obtenerTasaBcvGlobal(
  rawDb: D1Database,
  opc?: { forzar?: boolean; permitirRed?: boolean; fetchFn?: typeof fetch; maxVariacionPct?: number; env?: Record<string, unknown> }
): Promise<TasaBcvGlobal | null> {
  await asegurarTablaTasaBcvGlobal(rawDb);
  const actual = await rawDb
    .prepare(`SELECT tasa_bcv, fuente, fecha_valor, COALESCE(fecha_valor_asumida, 0) AS fecha_valor_asumida, actualizado_en FROM _mt_tasa_bcv_global WHERE id = 1`)
    .first<{ tasa_bcv: string; fuente: string; fecha_valor: string; fecha_valor_asumida: number; actualizado_en: string }>()
    .catch(() => null);

  const ahoraMs = Date.now();
  const actMs = parsearFechaUtcMs(actual?.actualizado_en);
  const cacheVigente = !!actual?.tasa_bcv && actMs > 0 && ahoraMs - actMs < TTL_CACHE_BCV_MS;

  if (!opc?.forzar && cacheVigente && actual) {
    return { ...actual, actualizado_en: String(actual.actualizado_en), desde_cache: true };
  }

  if (opc?.permitirRed === false && !opc?.forzar) {
    return actual ? { ...actual, actualizado_en: String(actual.actualizado_en), desde_cache: true } : null;
  }

  const externa = await consultarFuentesBcvOficial(opc?.fetchFn);
  if (externa) {
    if (externa.alerta_discrepancia) {
      await registrarAuditoriaGlobal(rawDb, "TASA_BCV_DISCREPANCIA", externa.alerta_discrepancia);
    }

    // Guardia de salto anómalo (por defecto 15% respecto a la tasa vigente)
    const maxVar = Number(opc?.maxVariacionPct ?? opc?.env?.BCV_MAX_VARIACION_PCT ?? 15);
    const topePct = Number.isFinite(maxVar) && maxVar > 0 ? maxVar : 15;
    if (actual?.tasa_bcv) {
      const nPrev = Number(actual.tasa_bcv);
      const nNueva = Number(externa.tasa_bcv);
      if (Number.isFinite(nPrev) && nPrev > 0 && Number.isFinite(nNueva) && nNueva > 0) {
        const varPct = (Math.abs(nNueva - nPrev) / nPrev) * 100;
        if (varPct > topePct) {
          const pendiente: TasaPendienteBcv = {
            tasa_bcv: externa.tasa_bcv,
            fuente: externa.fuente,
            fecha_valor: externa.fecha_valor,
            fecha_valor_asumida: externa.fecha_valor_asumida,
            tasa_anterior: actual.tasa_bcv,
            variacion_pct: Number(varPct.toFixed(2)),
            detectada_en: ahoraSqlUtc(),
          };
          await rawDb
            .prepare(
              `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, datetime('now'))
               ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
            )
            .bind(CLAVE_TASA_PENDIENTE_BCV, JSON.stringify(pendiente))
            .run()
            .catch(() => {});
          await registrarAuditoriaGlobal(
            rawDb,
            "TASA_BCV_SALTO_ANOMALO",
            `Retenida tasa ${externa.tasa_bcv} (${externa.fuente}): variación de ${varPct.toFixed(2)}% respecto a ${actual.tasa_bcv} supera el tope de ${topePct}%.`
          );
          return {
            ...actual,
            actualizado_en: String(actual.actualizado_en),
            desde_cache: true,
            pendiente_aprobacion: true,
            tasa_pendiente: pendiente,
            ...(externa.alerta_discrepancia ? { alerta_discrepancia: externa.alerta_discrepancia } : {}),
          };
        }
      }
    }

    const ts = ahoraSqlUtc();
    await rawDb
      .prepare(
        `INSERT INTO _mt_tasa_bcv_global (id, tasa_bcv, fuente, fecha_valor, fecha_valor_asumida, actualizado_en)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tasa_bcv = excluded.tasa_bcv,
           fuente = excluded.fuente,
           fecha_valor = excluded.fecha_valor,
           fecha_valor_asumida = excluded.fecha_valor_asumida,
           actualizado_en = excluded.actualizado_en`
      )
      .bind(externa.tasa_bcv, externa.fuente, externa.fecha_valor, externa.fecha_valor_asumida, ts)
      .run();
    // Si había una pendiente previa y llegó una tasa normal dentro del rango, limpiamos la pendiente obsoleta
    await rawDb.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(CLAVE_TASA_PENDIENTE_BCV).run().catch(() => {});
    return {
      tasa_bcv: externa.tasa_bcv,
      fuente: externa.fuente,
      fecha_valor: externa.fecha_valor,
      fecha_valor_asumida: externa.fecha_valor_asumida,
      actualizado_en: ts,
      desde_cache: false,
      ...(externa.alerta_discrepancia ? { alerta_discrepancia: externa.alerta_discrepancia } : {}),
    };
  }

  return actual ? { ...actual, actualizado_en: String(actual.actualizado_en), desde_cache: true } : null;
}

// Replicación inteligente: si el negocio tiene tasa_bcv_modo = 'AUTOMATICO', copia la tasa global BCV sin hacer N consultas externas.
export async function sincronizarTasaInquilinoSiAuto(
  rawDb: D1Database,
  dbInq: D1Database,
  opc?: { forzarRed?: boolean; permitirRed?: boolean; fetchFn?: typeof fetch; env?: Record<string, unknown> }
): Promise<{ actualizado: boolean; tasa_bcv?: string; tasa_bcv_fecha?: string; fuente?: string; modo?: string; pendiente_aprobacion?: boolean }> {
  const perfil = await dbInq
    .prepare(`SELECT tasa_bcv, tasa_bcv_fecha, COALESCE(tasa_bcv_modo, 'AUTOMATICO') AS tasa_bcv_modo FROM perfil_emisor WHERE id = 1`)
    .first<{ tasa_bcv: string; tasa_bcv_fecha: string | null; tasa_bcv_modo: string }>()
    .catch(() => null);
  if (!perfil) return { actualizado: false };

  const modo = perfil.tasa_bcv_modo === "MANUAL" ? "MANUAL" : "AUTOMATICO";
  if (modo === "MANUAL" && !opc?.forzarRed) {
    return {
      actualizado: false,
      tasa_bcv: String(perfil.tasa_bcv ?? ""),
      tasa_bcv_fecha: perfil.tasa_bcv_fecha ? String(perfil.tasa_bcv_fecha) : undefined,
      modo,
    };
  }

  const global = await obtenerTasaBcvGlobal(rawDb, {
    forzar: opc?.forzarRed,
    permitirRed: opc?.permitirRed,
    fetchFn: opc?.fetchFn,
    env: opc?.env,
  });
  if (!global?.tasa_bcv) {
    return {
      actualizado: false,
      tasa_bcv: String(perfil.tasa_bcv ?? ""),
      tasa_bcv_fecha: perfil.tasa_bcv_fecha ? String(perfil.tasa_bcv_fecha) : undefined,
      modo,
    };
  }

  // Usar fecha_valor real (como YYYY-MM-DD) o actualizado_en según frescura, preservando fecha_valor si viene de bcv.org.ve
  const fechaAplicar = global.fecha_valor_asumida === 0 && global.fecha_valor
    ? global.fecha_valor
    : global.actualizado_en;
  const fechaInqMs = parsearFechaUtcMs(perfil.tasa_bcv_fecha);
  const fechaGlobMs = parsearFechaUtcMs(global.actualizado_en);
  const necesitaActualizar =
    opc?.forzarRed ||
    !perfil.tasa_bcv ||
    String(perfil.tasa_bcv) !== String(global.tasa_bcv) ||
    !perfil.tasa_bcv_fecha ||
    (fechaGlobMs > 0 && fechaGlobMs > fechaInqMs);

  if (necesitaActualizar) {
    await dbInq
      .prepare(`UPDATE perfil_emisor SET tasa_bcv = ?, tasa_bcv_fecha = ?, tasa_bcv_modo = 'AUTOMATICO' WHERE id = 1`)
      .bind(global.tasa_bcv, fechaAplicar)
      .run();
    return {
      actualizado: true,
      tasa_bcv: global.tasa_bcv,
      tasa_bcv_fecha: String(fechaAplicar),
      fuente: global.fuente,
      modo: "AUTOMATICO",
      ...(global.pendiente_aprobacion ? { pendiente_aprobacion: true } : {}),
    };
  }

  return {
    actualizado: false,
    tasa_bcv: String(perfil.tasa_bcv ?? ""),
    tasa_bcv_fecha: perfil.tasa_bcv_fecha ? String(perfil.tasa_bcv_fecha) : undefined,
    fuente: global.fuente,
    modo,
    ...(global.pendiente_aprobacion ? { pendiente_aprobacion: true } : {}),
  };
}

// Validación server-side de tasa BCV vigente para operaciones fiscales en MODO REAL (v5.6 · Sección 6):
// Bloquea con 409 TASA_DESACTUALIZADA si el semáforo está en rojo, salvo override explícito (confirmar_tasa_vieja: true) por ADMIN o SUPER_ADMIN.
export async function validarTasaFiscalVigente(
  rawDb: D1Database,
  perfil: { tasa_bcv?: unknown; tasa_bcv_fecha?: unknown } | null | undefined,
  modo: string,
  usuario: { rol: string; email?: string },
  envObj: Record<string, unknown>,
  body: Record<string, unknown> = {},
  ahoraMs: number = Date.now()
): Promise<
  | { ok: true; override: boolean; semaforo: ReturnType<typeof estadoSemaforoTasaBcv> }
  | { ok: false; status: 409; codigo: "TASA_DESACTUALIZADA"; error: string; puede_forzar: boolean; semaforo: ReturnType<typeof estadoSemaforoTasaBcv> }
> {
  const cfg = await leerConfigSemaforoBcv(rawDb);
  const semaforo = estadoSemaforoTasaBcv(perfil?.tasa_bcv, perfil?.tasa_bcv_fecha, ahoraMs, {
    feriados: cfg.feriados,
    sinPublicacionHoy: cfg.sin_publicacion_hoy,
  });

  if (String(modo || "").toUpperCase() !== "REAL") {
    return { ok: true, override: false, semaforo };
  }

  if (semaforo.estado === "verde" || semaforo.estado === "amarillo") {
    return { ok: true, override: false, semaforo };
  }

  const pideOverride =
    body?.confirmar_tasa_vieja === true ||
    body?.confirmar_tasa_vieja === 1 ||
    body?.confirmar_tasa_vieja === "1" ||
    body?.confirmar_tasa_vieja === "true";
  const puedeOverride = usuario.rol === "ADMIN" || esSuperAdmin(usuario.rol, usuario.email, envObj);

  if (pideOverride && puedeOverride) {
    return { ok: true, override: true, semaforo };
  }

  const msg = pideOverride && !puedeOverride
    ? "La tasa oficial BCV está desactualizada. Solo un Administrador puede autorizar la emisión fiscal REAL con tasa de un día anterior."
    : "La tasa oficial BCV está desactualizada para operaciones fiscales en Modo REAL. Sincroniza la tasa BCV de hoy en Ajustes antes de emitir (o autoriza explícitamente como Administrador).";

  return {
    ok: false,
    status: 409,
    codigo: "TASA_DESACTUALIZADA",
    error: msg,
    puede_forzar: puedeOverride,
    semaforo,
  };
}

export function mesAnteriorCaracas(fechaIso = fechaCaracas()): string {
  const [yStr, mStr] = fechaIso.slice(0, 7).split("-");
  let y = Number(yStr);
  let m = Number(mStr) - 1;
  if (m < 1) {
    m = 12;
    y -= 1;
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

function base64Utf8(textoCsv: string): string {
  const bytes = new TextEncoder().encode("\uFEFF" + textoCsv);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function celdaCsv(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function armarCsv(encabezados: string[], filas: unknown[][]): string {
  return [encabezados.map(celdaCsv).join(";"), ...filas.map((f) => f.map(celdaCsv).join(";"))].join("\r\n");
}

const fmtBs = (cent: number) =>
  `Bs. ${(Number(cent || 0) / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtUsd = (cent: number) =>
  `$ ${(Number(cent || 0) / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDec = (cent: number) => (Number(cent || 0) / 100).toFixed(2);
const escHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);

export async function enviarCierreMensualInquilino(
  db: D1Database,
  env: Record<string, string>,
  mes: string,
  paraExtra?: string
): Promise<{ ok: true; destinos: string[]; mes: string } | { ok: false; error: string }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) {
    return { ok: false, error: "Indica el mes en formato AAAA-MM (ejemplo: 2026-04)." };
  }

  const cfgCorreo = await leerConfigCorreo(db, env);
  if (!cfgCorreo.clave || !cfgCorreo.remitente) {
    return { ok: false, error: "Configura primero la API de Correo (Brevo o Resend) en Ajustes." };
  }

  const perfil = await db
    .prepare(`SELECT nombre_razon_social, rif, email, tipo_contribuyente, igtf_activo FROM perfil_emisor WHERE id = 1`)
    .first<{ nombre_razon_social: string; rif: string; email: string; tipo_contribuyente?: string; igtf_activo?: number }>();
  const tipoContrib = normalizarTipoContribuyente(perfil?.tipo_contribuyente, perfil?.igtf_activo);
  const reg = reglasRegimen(tipoContrib);
  const esFormal = tipoContrib === "FORMAL";

  const { results: usuariosDest } = await db
    .prepare(`SELECT email FROM usuarios WHERE activo = 1 AND rol IN ('SUPER_ADMIN', 'ADMIN', 'CONTADOR') ORDER BY id`)
    .all<{ email: string }>();

  const setDestinos = new Set<string>();
  if (paraExtra && EMAIL.test(paraExtra.trim().toLowerCase())) {
    setDestinos.add(paraExtra.trim().toLowerCase());
  }
  for (const u of usuariosDest) {
    const em = String(u.email ?? "").trim().toLowerCase();
    if (EMAIL.test(em)) setDestinos.add(em);
  }
  if (perfil?.email && EMAIL.test(perfil.email.trim().toLowerCase())) {
    setDestinos.add(perfil.email.trim().toLowerCase());
  }

  const destinos = [...setDestinos];
  if (!destinos.length) {
    return { ok: false, error: "No hay correos activos de Administrador o Contador para recibir el cierre mensual." };
  }

  const modo = await modoActual(db);
  const desde = `${mes}-01`;
  const hasta = `${mes}-31`;

  // 1) Ventas del mes (Facturas, Notas de Débito +, Notas de Crédito -) + desglose exacto exento/gravado desde documento_impuestos
  const [{ results: docsVentas }, { results: impVentas }] = await Promise.all([
    db
      .prepare(
        `SELECT d.id, d.numero, d.es_nota_credito, COALESCE(d.es_nota_debito, 0) AS es_nota_debito,
                d.control_interno, d.control_fiscal, d.medio, d.fecha_emision, d.estado,
                d.cliente_rif, d.cliente_nombre, d.subtotal_bs, d.iva_bs, d.igtf_bs, d.total_bs,
                d.subtotal_usd, d.iva_usd, d.igtf_usd, d.total_usd,
                (SELECT fa.numero FROM documentos fa WHERE fa.id = d.factura_afectada_id) AS factura_afectada_numero
         FROM documentos d
         WHERE d.tipo = 'FACTURA' AND d.modo = ? AND d.estado IN ('EMITIDO', 'ANULADO')
           AND d.fecha_emision >= ? AND d.fecha_emision <= ?
         ORDER BY d.fecha_emision ASC, d.id ASC`
      )
      .bind(modo, desde, hasta)
      .all<Record<string, any>>(),
    db
      .prepare(
        `SELECT i.documento_id,
                SUM(CASE WHEN i.alicuota_cent = 0 THEN i.base_bs ELSE 0 END) AS exenta_bs,
                SUM(CASE WHEN i.alicuota_cent > 0 THEN i.base_bs ELSE 0 END) AS gravada_bs
         FROM documento_impuestos i JOIN documentos d ON d.id = i.documento_id
         WHERE d.tipo = 'FACTURA' AND d.modo = ? AND d.estado IN ('EMITIDO', 'ANULADO')
           AND d.fecha_emision >= ? AND d.fecha_emision <= ?
         GROUP BY i.documento_id`
      )
      .bind(modo, desde, hasta)
      .all<Record<string, any>>(),
  ]);
  const impPorDoc = new Map<number, { exenta_bs: number; gravada_bs: number }>(
    impVentas.map((x) => [Number(x.documento_id), { exenta_bs: Number(x.exenta_bs || 0), gravada_bs: Number(x.gravada_bs || 0) }])
  );

  let baseVentasBs = 0, debitoIvaBs = 0, igtfVentasBs = 0, totalVentasBs = 0;
  let baseVentasUsd = 0, igtfVentasUsd = 0;
  const filasCsvVentas: unknown[][] = [];

  for (const d of docsVentas) {
    const anulado = d.estado === "ANULADO";
    const signo = anulado ? 0 : d.es_nota_credito ? -1 : 1;
    const impDoc = impPorDoc.get(Number(d.id));
    const exentaBs = signo * (impDoc ? impDoc.exenta_bs : 0);
    const gravadaBs = signo * (impDoc ? impDoc.gravada_bs : Number(d.subtotal_bs || 0));
    const subBs = signo * Number(d.subtotal_bs || 0);
    const ivaBs = signo * Number(d.iva_bs || 0);
    const igtfBs = signo * Number(d.igtf_bs || 0);
    const totBs = signo * Number(d.total_bs || 0);
    baseVentasBs += subBs;
    debitoIvaBs += ivaBs;
    igtfVentasBs += igtfBs;
    totalVentasBs += totBs;
    baseVentasUsd += signo * Number(d.subtotal_usd || 0);
    igtfVentasUsd += signo * Number(d.igtf_usd || 0);

    const tipoDoc = d.es_nota_credito ? "NOTA_CREDITO" : d.es_nota_debito ? "NOTA_DEBITO" : "FACTURA";
    const nroDoc = d.es_nota_credito
      ? `NC-${String(d.numero).padStart(8, "0")}`
      : d.es_nota_debito
        ? `ND-${String(d.numero).padStart(8, "0")}`
        : String(d.numero).padStart(8, "0");
    const ctrl =
      d.control_fiscal ||
      (d.medio === "IMPRENTA_DIGITAL" && modo === "REAL" ? "PENDIENTE" : `00-${String(d.control_interno ?? d.numero).padStart(8, "0")}`);
    filasCsvVentas.push([
      d.fecha_emision,
      tipoDoc,
      nroDoc,
      ctrl,
      d.factura_afectada_numero ? String(d.factura_afectada_numero).padStart(8, "0") : "",
      anulado ? "ANULADO" : d.cliente_rif,
      anulado ? "ANULADO" : d.cliente_nombre,
      fmtDec(exentaBs),
      fmtDec(gravadaBs),
      fmtDec(ivaBs),
      fmtDec(igtfBs),
      fmtDec(totBs),
      d.estado,
    ]);
  }

  // 2) Compras del mes
  const { results: docsCompras } = await db
    .prepare(
      `SELECT id, fecha, proveedor_rif, proveedor_nombre, factura_numero, control_numero,
              subtotal_bs, iva_bs, total_bs, subtotal_usd, iva_usd, total_usd
       FROM compras
       WHERE modo = ? AND estado = 'REGISTRADA' AND fecha >= ? AND fecha <= ?
       ORDER BY fecha ASC, id ASC`
    )
    .bind(modo, desde, hasta)
    .all<Record<string, any>>();

  let baseComprasBs = 0, creditoIvaBs = 0, totalComprasBs = 0;
  const filasCsvCompras: unknown[][] = [];
  for (const c of docsCompras) {
    baseComprasBs += Number(c.subtotal_bs || 0);
    creditoIvaBs += Number(c.iva_bs || 0);
    totalComprasBs += Number(c.total_bs || 0);
    filasCsvCompras.push([
      c.fecha,
      c.factura_numero,
      c.control_numero,
      c.proveedor_rif,
      c.proveedor_nombre,
      fmtDec(c.subtotal_bs),
      fmtDec(c.iva_bs),
      fmtDec(c.total_bs),
    ]);
  }

  // 3) Retenciones de IVA e ISLR recibidas en el mes (conversión exacta a centavos enteros de Bs.)
  const { results: retenciones } = await db
    .prepare(
      `SELECT p.fecha_pago, p.numero AS recibo_numero, p.es_retencion_iva, COALESCE(p.es_retencion_islr, 0) AS es_retencion_islr,
              p.comprobante_retencion, p.referencia,
              CASE WHEN p.moneda = 'BS' THEN p.monto_recibido ELSE (p.monto_usd * p.tasa_e8 + 50000000) / 100000000 END AS retenido_bs,
              p.monto_usd AS retenido_usd,
              d.numero AS factura_numero, COALESCE(d.es_nota_debito, 0) AS es_nota_debito, d.cliente_rif, d.cliente_nombre
       FROM pagos p JOIN documentos d ON d.id = p.documento_id
       WHERE p.modo = ? AND p.estado = 'VIGENTE' AND d.tipo = 'FACTURA'
         AND (p.es_retencion_iva = 1 OR COALESCE(p.es_retencion_islr, 0) = 1)
         AND p.fecha_pago >= ? AND p.fecha_pago <= ?
       ORDER BY p.fecha_pago ASC, p.id ASC`
    )
    .bind(modo, desde, hasta)
    .all<Record<string, any>>();

  let retIvaBs = 0, retIslrBs = 0;
  const filasCsvRet: unknown[][] = [];
  for (const r of retenciones) {
    if (r.es_retencion_iva) retIvaBs += Number(r.retenido_bs || 0);
    if (r.es_retencion_islr) retIslrBs += Number(r.retenido_bs || 0);
    const nroDocRet = r.es_nota_debito ? `ND-${String(r.factura_numero).padStart(8, "0")}` : String(r.factura_numero).padStart(8, "0");
    filasCsvRet.push([
      r.fecha_pago,
      r.es_retencion_iva ? "RETENCION_IVA" : "RETENCION_ISLR",
      r.comprobante_retencion || r.referencia || "",
      nroDocRet,
      r.cliente_rif,
      r.cliente_nombre,
      fmtDec(r.retenido_bs),
      fmtDec(r.retenido_usd),
    ]);
  }

  const cuotaNetaIvaBs = debitoIvaBs - creditoIvaBs - retIvaBs;
  const aPagarIvaBs = Math.max(cuotaNetaIvaBs, 0);
  const excedenteCreditoBs = cuotaNetaIvaBs < 0 ? -cuotaNetaIvaBs : 0;

  const csvVentas = armarCsv(
    ["Fecha", "Tipo", "Numero", "Control", "Factura_Afectada", "RIF_Cliente", "Cliente", "Base_Exenta_Bs", "Base_Gravada_Bs", "IVA_Bs", "IGTF_Bs", "Total_Bs", "Estado"],
    filasCsvVentas
  );
  const csvCompras = armarCsv(
    ["Fecha", "Factura_Proveedor", "Control", "RIF_Proveedor", "Proveedor", "Base_Bs", "IVA_Bs", "Total_Bs"],
    filasCsvCompras
  );
  const mostrarIgtfCorreo = reg.cobraIgtf || igtfVentasBs > 0;
  const filasResumenCsv: unknown[][] = [
    ["Ingresos Brutos Municipales (Ventas Netas sin IVA)", fmtDec(baseVentasBs), fmtDec(baseVentasUsd)],
    ...(!esFormal
      ? [
          ["Debito Fiscal IVA (Ventas)", fmtDec(debitoIvaBs), ""],
          ["Credito Fiscal IVA (Compras)", fmtDec(creditoIvaBs), ""],
          ["Retenciones de IVA Soportadas (75% / 100%)", fmtDec(retIvaBs), ""],
          ["Cuota Tributaria IVA a Pagar SENIAT", fmtDec(aPagarIvaBs), ""],
          ["Excedente Credito Fiscal Proximo Mes", fmtDec(excedenteCreditoBs), ""],
        ]
      : [["Condicion Fiscal", "CONTRIBUYENTE FORMAL (EXENTO DE IVA - ART. 8 LEY IVA)", ""]]),
    ...(mostrarIgtfCorreo ? [["IGTF 3% Percibido en Divisas", fmtDec(igtfVentasBs), fmtDec(igtfVentasUsd)]] : []),
    ["Retenciones de ISLR Soportadas (Decreto 1808)", fmtDec(retIslrBs), ""],
  ];
  const csvResumen = armarCsv(["Concepto", "Monto_Bs", "Monto_USD"], filasResumenCsv);
  const csvRetenciones = armarCsv(
    ["Fecha_Pago", "Tipo_Retencion", "Comprobante", "Factura", "RIF_Agente", "Agente_Retencion", "Monto_Retenido_Bs", "Equivalente_USD"],
    filasCsvRet
  );

  const nombreNegocio = perfil?.nombre_razon_social || "FacturaYa Venezuela";
  const rifNegocio = aRifSeniat(perfil?.rif || "");
  const introCorreo = esFormal
    ? `Adjuntamos los <b>4 reportes contables en CSV (compatibles con Excel)</b> correspondientes al período <b>${escHtml(mes)}</b> para Contribuyente Formal (Relación de Ventas, Relación de Compras, ISLR e Ingresos Brutos Municipales):`
    : mostrarIgtfCorreo
      ? `Adjuntamos los <b>4 libros y resúmenes fiscales en CSV (compatibles con Excel)</b> correspondientes al período <b>${escHtml(mes)}</b> para la declaración de IVA (Forma 30), IGTF (Forma 99032), ISLR e Ingresos Brutos Municipales:`
      : `Adjuntamos los <b>4 libros y resúmenes fiscales en CSV (compatibles con Excel)</b> correspondientes al período <b>${escHtml(mes)}</b> para la declaración de IVA (Forma 30), ISLR e Ingresos Brutos Municipales:`;

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:24px;border:1px solid #dde3ec;border-radius:16px;color:#1f2933">
    <div style="border-bottom:2px solid #1A73E8;padding-bottom:12px;margin-bottom:16px">
      <h2 style="margin:0;color:#1A73E8">📊 Cierre Contable y Fiscal SENIAT · ${escHtml(mes)}</h2>
      <p style="margin:4px 0 0;font-size:13px;color:#5f6b7a"><b>${escHtml(nombreNegocio)}</b> · RIF: ${escHtml(rifNegocio)} · ${escHtml(reg.etiqueta)} · Modo: ${escHtml(modo)}</p>
    </div>
    <p style="font-size:14px;color:#374151;margin:0 0 16px">${introCorreo}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px">
      <tbody>
        <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>🏛️ Ingresos Brutos Municipales (Ventas Netas)</b></td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right"><b>${fmtBs(baseVentasBs)}</b> (${fmtUsd(baseVentasUsd)})</td></tr>
        ${!esFormal ? `<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">📈 Débito Fiscal IVA (Ventas: ${docsVentas.length} doc.)</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtBs(debitoIvaBs)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">📉 Crédito Fiscal IVA (Compras: ${docsCompras.length} doc.)</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">- ${fmtBs(creditoIvaBs)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">🧾 Retenciones de IVA recibidas (Comprobantes)</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">- ${fmtBs(retIvaBs)}</td></tr>
        <tr style="background:#f8fafd"><td style="padding:10px;border-bottom:2px solid #dde3ec"><b>⚖️ ${aPagarIvaBs > 0 ? "Cuota Tributaria IVA a Pagar SENIAT" : "Excedente Crédito Fiscal Próximo Mes"}</b></td><td style="padding:10px;border-bottom:2px solid #dde3ec;text-align:right;font-size:15px"><b>${fmtBs(aPagarIvaBs > 0 ? aPagarIvaBs : excedenteCreditoBs)}</b></td></tr>` : `<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">🩺 Condición Fiscal</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">Contribuyente Formal (Exento de IVA)</td></tr>`}
        ${mostrarIgtfCorreo ? `<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">💵 IGTF 3% Percibido en Divisas</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtBs(igtfVentasBs)} (${fmtUsd(igtfVentasUsd)})</td></tr>` : ""}
        <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">📑 Retenciones de ISLR recibidas (Decreto 1.808)</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtBs(retIslrBs)}</td></tr>
      </tbody>
    </table>
    <p style="font-size:12px;color:#6b7280;margin:0">Archivos adjuntos: ${esFormal ? "Relación de Ventas, Relación de Compras, Resumen de Ingresos y Retenciones ISLR." : "Libro de Ventas, Libro de Compras, Resumen de IVA/Alcaldía y Relación de Retenciones IVA/ISLR."}</p>
  </div>`;

  const textoPlano = esFormal
    ? `Cierre Contable SENIAT ${mes} - ${nombreNegocio} (${rifNegocio}) · Contribuyente Formal\nIngresos Brutos: ${fmtBs(baseVentasBs)} (${fmtUsd(baseVentasUsd)})\nRet. ISLR: ${fmtBs(retIslrBs)}`
    : `Cierre Contable SENIAT ${mes} - ${nombreNegocio} (${rifNegocio}) · ${reg.etiqueta}\nIngresos Brutos: ${fmtBs(baseVentasBs)}\nDébito IVA: ${fmtBs(debitoIvaBs)} | Crédito IVA: ${fmtBs(creditoIvaBs)} | Ret. IVA: ${fmtBs(retIvaBs)}\nIVA a Pagar: ${fmtBs(aPagarIvaBs)}${mostrarIgtfCorreo ? ` | IGTF 3%: ${fmtBs(igtfVentasBs)}` : ""} | Ret. ISLR: ${fmtBs(retIslrBs)}`;

  const adjuntos = [
    { filename: `${esFormal ? "Relacion-Ventas" : "Libro-Ventas"}-${mes}.csv`, content: base64Utf8(csvVentas) },
    { filename: `${esFormal ? "Relacion-Compras" : "Libro-Compras"}-${mes}.csv`, content: base64Utf8(csvCompras) },
    { filename: `${esFormal ? "Resumen-Ingresos-Alcaldia" : "Resumen-IVA-Alcaldia"}-${mes}.csv`, content: base64Utf8(csvResumen) },
    { filename: `Retenciones-${esFormal ? "ISLR" : "IVA-ISLR"}-${mes}.csv`, content: base64Utf8(csvRetenciones) },
  ];

  let enviados = 0;
  let ultimoError = "";
  for (const dest of destinos) {
    const r = await enviarCorreo(db, env, {
      para: dest,
      alcance: "INQUILINO",
      tipo: "CIERRE",
      responderA: perfil?.email ? String(perfil.email).trim() : undefined,
      asunto: `📊 Cierre Contable SENIAT (${mes}) · ${nombreNegocio}`,
      html,
      texto: textoPlano,
      adjuntos,
    });
    if (r.ok) enviados++;
    else ultimoError = r.error;
  }

  if (enviados === 0) {
    return { ok: false, error: ultimoError || "No se pudo enviar el correo de cierre mensual." };
  }

  await db
    .prepare(`UPDATE perfil_emisor SET ultimo_cierre_correo = ? WHERE id = 1`)
    .bind(mes)
    .run()
    .catch(() => {});

  return { ok: true, destinos, mes };
}

// Reclama atómicamente el cierre automático del mes para evitar correos duplicados en peticiones concurrentes.
export async function intentarCierreMensualAutomatico(
  db: D1Database,
  env: Record<string, string>,
  mes: string
): Promise<boolean> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return false;
  const perfil = await db
    .prepare(`SELECT cierre_mensual_correo, ultimo_cierre_correo FROM perfil_emisor WHERE id = 1`)
    .first<{ cierre_mensual_correo: number; ultimo_cierre_correo: string | null }>()
    .catch(() => null);
  if (!perfil || Number(perfil.cierre_mensual_correo ?? 1) !== 1 || perfil.ultimo_cierre_correo === mes) {
    return false;
  }

  const cfgCorreo = await leerConfigCorreo(db, env);
  if (!cfgCorreo.clave || !cfgCorreo.remitente) return false;

  const previo = perfil.ultimo_cierre_correo ?? null;
  const reclamo = await db
    .prepare(`UPDATE perfil_emisor SET ultimo_cierre_correo = ? WHERE id = 1 AND COALESCE(ultimo_cierre_correo, '') <> ?`)
    .bind(mes, mes)
    .run()
    .catch(() => null);
  if (!reclamo || Number(reclamo.meta?.changes ?? 0) !== 1) return false;

  const res = await enviarCierreMensualInquilino(db, env, mes).catch(() => ({ ok: false as const, error: "Error enviando cierre." }));
  if (!res.ok) {
    await db
      .prepare(`UPDATE perfil_emisor SET ultimo_cierre_correo = ? WHERE id = 1 AND ultimo_cierre_correo = ?`)
      .bind(previo, mes)
      .run()
      .catch(() => {});
    return false;
  }
  return true;
}
