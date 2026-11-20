// Conector centralizado de Tasa Oficial BCV (1 consulta compartida para 100+ empresas)
// y Despachador de Cierre Contable Mensual por Correo (Brevo / Resend por inquilino).
import { aTasaE8, aRifSeniat } from "../public/dinero.js";
import { EMAIL, fechaCaracas, modoActual } from "./comun";
import { enviarCorreo, leerConfigCorreo } from "./correo";
import { normalizarTipoContribuyente, reglasRegimen } from "./regimen";

export type TasaBcvGlobal = {
  tasa_bcv: string;
  fuente: string;
  fecha_valor: string;
  actualizado_en: string;
  desde_cache?: boolean;
};

const TTL_CACHE_BCV_MS = 4 * 60 * 60 * 1000; // 4 horas entre consultas externas

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
        actualizado_en TEXT NOT NULL
      )`
    )
    .run();
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

export async function consultarFuentesBcvOficial(
  fetchFn: typeof fetch = fetch
): Promise<{ tasa_bcv: string; fuente: string; fecha_valor: string } | null> {
  const hoy = fechaCaracas();

  // Fuente 1: DolarApi Venezuela (Oficial BCV)
  try {
    const r1 = await fetchFn("https://ve.dolarapi.com/v1/dolares/oficial", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3500),
    });
    if (r1.ok) {
      const j1 = (await r1.json()) as { promedio?: unknown; fechaActualizacion?: string };
      const t1 = normalizarTasaTexto(j1?.promedio);
      if (t1) {
        const fv = typeof j1.fechaActualizacion === "string" && j1.fechaActualizacion.length >= 10
          ? j1.fechaActualizacion.slice(0, 10)
          : hoy;
        return { tasa_bcv: t1, fuente: "BCV Oficial (DolarApi VE)", fecha_valor: fv };
      }
    }
  } catch {
    // Continúa a la fuente de respaldo 2
  }

  // Fuente 2: PyDolarVE (Monitor BCV Oficial)
  try {
    const r2 = await fetchFn("https://pydolarve.org/api/v1/dollar?page=bcv", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3500),
    });
    if (r2.ok) {
      const j2 = (await r2.json()) as {
        monitors?: { usd?: { price?: unknown; last_update?: string } };
        price?: unknown;
      };
      const precio = j2?.monitors?.usd?.price ?? j2?.price;
      const t2 = normalizarTasaTexto(precio);
      if (t2) {
        return { tasa_bcv: t2, fuente: "BCV Oficial (PyDolarVE)", fecha_valor: hoy };
      }
    }
  } catch {
    // Continúa a la fuente de respaldo 3
  }

  // Fuente 3: Portal oficial del Banco Central de Venezuela (bcv.org.ve)
  try {
    const r3 = await fetchFn("https://www.bcv.org.ve/", {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(3500),
    });
    if (r3.ok) {
      const html = await r3.text();
      const m =
        html.match(/id=["']dolar["'][\s\S]{0,600}?<strong>\s*([0-9]+[.,][0-9]+)\s*<\/strong>/i) ||
        html.match(/USD[\s\S]{0,300}?<strong>\s*([0-9]+[.,][0-9]+)\s*<\/strong>/i);
      if (m?.[1]) {
        const t3 = normalizarTasaTexto(m[1]);
        if (t3) {
          return { tasa_bcv: t3, fuente: "BCV Oficial (bcv.org.ve)", fecha_valor: hoy };
        }
      }
    }
  } catch {
    // Si las 3 fallan, se conserva la última tasa válida en caché
  }

  return null;
}

export async function obtenerTasaBcvGlobal(
  rawDb: D1Database,
  opc?: { forzar?: boolean; permitirRed?: boolean; fetchFn?: typeof fetch }
): Promise<TasaBcvGlobal | null> {
  await asegurarTablaTasaBcvGlobal(rawDb);
  const actual = await rawDb
    .prepare(`SELECT tasa_bcv, fuente, fecha_valor, actualizado_en FROM _mt_tasa_bcv_global WHERE id = 1`)
    .first<{ tasa_bcv: string; fuente: string; fecha_valor: string; actualizado_en: string }>()
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
    const ts = ahoraSqlUtc();
    await rawDb
      .prepare(
        `INSERT INTO _mt_tasa_bcv_global (id, tasa_bcv, fuente, fecha_valor, actualizado_en)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tasa_bcv = excluded.tasa_bcv,
           fuente = excluded.fuente,
           fecha_valor = excluded.fecha_valor,
           actualizado_en = excluded.actualizado_en`
      )
      .bind(externa.tasa_bcv, externa.fuente, externa.fecha_valor, ts)
      .run();
    return {
      tasa_bcv: externa.tasa_bcv,
      fuente: externa.fuente,
      fecha_valor: externa.fecha_valor,
      actualizado_en: ts,
      desde_cache: false,
    };
  }

  return actual ? { ...actual, actualizado_en: String(actual.actualizado_en), desde_cache: true } : null;
}

// Replicación inteligente: si el negocio tiene tasa_bcv_modo = 'AUTOMATICO', copia la tasa global BCV sin hacer N consultas externas.
export async function sincronizarTasaInquilinoSiAuto(
  rawDb: D1Database,
  dbInq: D1Database,
  opc?: { forzarRed?: boolean; permitirRed?: boolean; fetchFn?: typeof fetch }
): Promise<{ actualizado: boolean; tasa_bcv?: string; tasa_bcv_fecha?: string; fuente?: string; modo?: string }> {
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
  });
  if (!global?.tasa_bcv) {
    return {
      actualizado: false,
      tasa_bcv: String(perfil.tasa_bcv ?? ""),
      tasa_bcv_fecha: perfil.tasa_bcv_fecha ? String(perfil.tasa_bcv_fecha) : undefined,
      modo,
    };
  }

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
      .bind(global.tasa_bcv, global.actualizado_en)
      .run();
    return {
      actualizado: true,
      tasa_bcv: global.tasa_bcv,
      tasa_bcv_fecha: String(global.actualizado_en),
      fuente: global.fuente,
      modo: "AUTOMATICO",
    };
  }

  return {
    actualizado: false,
    tasa_bcv: String(perfil.tasa_bcv ?? ""),
    tasa_bcv_fecha: perfil.tasa_bcv_fecha ? String(perfil.tasa_bcv_fecha) : undefined,
    fuente: global.fuente,
    modo,
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
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
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

  // 1) Ventas del mes (Facturas, Notas de Débito +, Notas de Crédito -)
  const { results: docsVentas } = await db
    .prepare(
      `SELECT d.id, d.numero, d.es_nota_credito, COALESCE(d.es_nota_debito, 0) AS es_nota_debito,
              d.control_interno, d.control_fiscal, d.fecha_emision, d.estado,
              d.cliente_rif, d.cliente_nombre, d.subtotal_bs, d.iva_bs, d.igtf_bs, d.total_bs,
              d.subtotal_usd, d.iva_usd, d.igtf_usd, d.total_usd,
              (SELECT fa.numero FROM documentos fa WHERE fa.id = d.factura_afectada_id) AS factura_afectada_numero
       FROM documentos d
       WHERE d.tipo = 'FACTURA' AND d.modo = ? AND d.estado IN ('EMITIDO', 'ANULADO')
         AND d.fecha_emision >= ? AND d.fecha_emision <= ?
       ORDER BY d.fecha_emision ASC, d.id ASC`
    )
    .bind(modo, desde, hasta)
    .all<Record<string, any>>();

  let baseVentasBs = 0, debitoIvaBs = 0, igtfVentasBs = 0, totalVentasBs = 0;
  let baseVentasUsd = 0, igtfVentasUsd = 0;
  const filasCsvVentas: unknown[][] = [];

  for (const d of docsVentas) {
    const anulado = d.estado === "ANULADO";
    const signo = anulado ? 0 : d.es_nota_credito ? -1 : 1;
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
    const ctrl = d.control_fiscal || `00-${String(d.control_interno ?? d.numero).padStart(8, "0")}`;
    filasCsvVentas.push([
      d.fecha_emision,
      tipoDoc,
      nroDoc,
      ctrl,
      d.factura_afectada_numero ? String(d.factura_afectada_numero).padStart(8, "0") : "",
      anulado ? "ANULADO" : d.cliente_rif,
      anulado ? "ANULADO" : d.cliente_nombre,
      fmtDec(subBs),
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

  // 3) Retenciones de IVA e ISLR recibidas en el mes
  const { results: retenciones } = await db
    .prepare(
      `SELECT p.fecha_pago, p.numero AS recibo_numero, p.es_retencion_iva, COALESCE(p.es_retencion_islr, 0) AS es_retencion_islr,
              p.comprobante_retencion, p.referencia, p.monto_recibido AS retenido_bs, p.monto_usd AS retenido_usd,
              d.numero AS factura_numero, COALESCE(d.es_nota_debito, 0) AS es_nota_debito, d.cliente_rif, d.cliente_nombre
       FROM pagos p JOIN documentos d ON d.id = p.documento_id
       WHERE p.modo = ? AND p.estado = 'VIGENTE'
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
    ["Fecha", "Tipo", "Numero", "Control", "Factura_Afectada", "RIF_Cliente", "Cliente", "Base_Bs", "IVA_Bs", "IGTF_Bs", "Total_Bs", "Estado"],
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
