// Módulo INFORMES (Fase 6 + IGTF y Notas de Crédito): libros de ventas y compras, resumen mensual de IVA, ganancias, por cobrar, inventario valorizado: /api/informes
// SOLO LECTURA: ningún informe escribe en la base. Todo sale de los mismos datos que ya guardan los demás módulos.
import { Hono } from "hono";
import { redondear } from "../../public/dinero.js";
import { PAGADO, auditar, falla, fechaCaracas, leerJson, modoActual, requiereSesion, texto, type Ctx, type Env } from "../comun";
import { enviarCierreMensualInquilino } from "../tasa-bcv";
import { leerTipoContribuyente } from "../regimen";
import { clasificarRenglonesCompra } from "./compras";

const informes = new Hono<Env>();
informes.use("*", requiereSesion);
type Fila = Record<string, any>;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fechaValida = (f: string) => FECHA.test(f) && new Date(`${f}T12:00:00Z`).toISOString().slice(0, 10) === f;

function rango(c: Ctx): { desde: string; hasta: string } | string {
  const hoy = fechaCaracas();
  const desde = c.req.query("desde") ?? `${hoy.slice(0, 8)}01`, hasta = c.req.query("hasta") ?? hoy;
  if (!fechaValida(desde) || !fechaValida(hasta)) return "Las fechas deben tener la forma AAAA-MM-DD.";
  if (desde > hasta) return "La fecha «desde» no puede ser posterior a «hasta».";
  if (Date.parse(hasta) - Date.parse(desde) > 366 * 86400000) return "El periodo no puede pasar de un año.";
  return { desde, hasta };
}
const suma = (xs: Fila[], k: string) => xs.reduce((s, x) => s + (x[k] ?? 0), 0);

// ---------------------------------------------------------------- libro de ventas (facturas, notas de crédito y retenciones de IVA, montos legales en Bs)
informes.get("/ventas", async (c) => {
  const r = rango(c); if (typeof r === "string") return falla(c, 400, r);
  const modo = await modoActual(c.env.DB), db = c.env.DB;
  const [docs, imp, rets] = await Promise.all([
    db.prepare(`SELECT d.id, d.es_nota_credito, COALESCE(d.es_nota_debito, 0) AS es_nota_debito, d.factura_afectada_id,
          (SELECT fa.numero FROM documentos fa WHERE fa.id = d.factura_afectada_id) AS factura_afectada_numero,
          d.numero, d.control_interno, d.control_fiscal, d.medio, d.fecha_emision,
          d.cliente_rif, d.cliente_nombre, d.estado, d.tasa_e8, d.aplica_igtf, d.igtf_usd, d.igtf_bs, d.total_usd, d.total_bs
        FROM documentos d WHERE d.tipo = 'FACTURA' AND d.modo = ? AND d.estado IN ('EMITIDO', 'ANULADO') AND d.fecha_emision BETWEEN ? AND ? ORDER BY d.fecha_emision, d.id`)
      .bind(modo, r.desde, r.hasta).all<Fila>(),
    db.prepare(`SELECT i.documento_id, i.alicuota_cent, i.base_bs, i.iva_bs FROM documento_impuestos i JOIN documentos d ON d.id = i.documento_id
        WHERE d.tipo = 'FACTURA' AND d.modo = ? AND d.estado IN ('EMITIDO', 'ANULADO') AND d.fecha_emision BETWEEN ? AND ?`)
      .bind(modo, r.desde, r.hasta).all<Fila>(),
    // v4.2.1: una fila por retención recibida en el período (por fecha del pago/comprobante), aunque la factura sea de otro mes.
    db.prepare(`SELECT p.id AS pago_id, p.documento_id, p.fecha_pago, p.comprobante_retencion,
          d.numero AS factura_numero, d.es_nota_credito, d.cliente_rif, d.cliente_nombre, d.fecha_emision AS factura_fecha_emision,
          CASE WHEN p.moneda = 'BS' THEN p.monto_recibido ELSE (p.monto_usd * p.tasa_e8 + 50000000) / 100000000 END AS iva_retenido_bs
        FROM pagos p JOIN documentos d ON d.id = p.documento_id
        WHERE p.estado = 'VIGENTE' AND p.es_retencion_iva = 1 AND d.tipo = 'FACTURA' AND d.modo = ? AND p.fecha_pago BETWEEN ? AND ?
        ORDER BY p.fecha_pago, p.id`)
      .bind(modo, r.desde, r.hasta).all<Fila>(),
  ]);
  const porDoc = new Map<number, Fila[]>();
  for (const i of imp.results) porDoc.set(i.documento_id, [...(porDoc.get(i.documento_id) ?? []), i]);
  const retPorDoc = new Map<number, { comprobante_retencion: string; iva_retenido_bs: number }>();
  const retenciones_periodo: Fila[] = [];
  let totalRetenidoPeriodoBs = 0;
  for (const rt of rets.results) {
    const montoRet = Number(rt.iva_retenido_bs ?? 0) || 0;
    totalRetenidoPeriodoBs += montoRet;
    const facturaEnPeriodo = String(rt.factura_fecha_emision ?? "") >= r.desde && String(rt.factura_fecha_emision ?? "") <= r.hasta;
    retenciones_periodo.push({ ...rt, iva_retenido_bs: montoRet, factura_en_periodo: facturaEnPeriodo });
    if (!facturaEnPeriodo) continue;
    const previa = retPorDoc.get(rt.documento_id);
    retPorDoc.set(rt.documento_id, {
      comprobante_retencion: [previa?.comprobante_retencion, rt.comprobante_retencion].filter(Boolean).join(" / "),
      iva_retenido_bs: (previa?.iva_retenido_bs ?? 0) + montoRet,
    });
  }
  const ivaRetenidoOtrosPeriodosBs = retenciones_periodo.filter((x) => !x.factura_en_periodo).reduce((t, x) => t + x.iva_retenido_bs, 0);
  const filas: Fila[] = docs.results.map((d) => {
    const signo = d.es_nota_credito ? -1 : 1;
    const rt = retPorDoc.get(d.id);
    return {
      ...d,
      comprobante_retencion: d.estado === "EMITIDO" ? (rt?.comprobante_retencion ?? "") : "",
      iva_retenido_bs: d.estado === "EMITIDO" ? (rt?.iva_retenido_bs ?? 0) : 0,
      igtf_bs: (d.igtf_bs ?? 0) * signo,
      igtf_usd: (d.igtf_usd ?? 0) * signo,
      total_bs: (d.total_bs ?? 0) * signo,
      total_usd: (d.total_usd ?? 0) * signo,
      impuestos: (porDoc.get(d.id) ?? []).map((i) => ({
        alicuota_cent: i.alicuota_cent,
        base_bs: i.base_bs * signo,
        iva_bs: i.iva_bs * signo,
      })),
    };
  });
  // Totales: las anuladas se listan (para que la numeración no tenga saltos) pero NO suman; las Notas de Crédito vigentes restan y las Notas de Débito suman.
  const vigentes = filas.filter((f) => f.estado === "EMITIDO"), porAlicuota = new Map<number, { base_bs: number; iva_bs: number }>();
  for (const f of vigentes) for (const i of f.impuestos) {
    const t = porAlicuota.get(i.alicuota_cent) ?? { base_bs: 0, iva_bs: 0 };
    porAlicuota.set(i.alicuota_cent, { base_bs: t.base_bs + i.base_bs, iva_bs: t.iva_bs + i.iva_bs });
  }
  const alicuotas = [...porAlicuota].sort((a, b) => a[0] - b[0]).map(([alicuota_cent, t]) => ({ alicuota_cent, ...t }));
  const tipo_contribuyente = await leerTipoContribuyente(db);
  return c.json({
    ok: true, modo, tipo_contribuyente, desde: r.desde, hasta: r.hasta, filas, alicuotas,
    n_vigentes: vigentes.filter((f) => !f.es_nota_credito && !f.es_nota_debito).length,
    n_notas_credito: vigentes.filter((f) => f.es_nota_credito).length,
    n_notas_debito: vigentes.filter((f) => f.es_nota_debito).length,
    n_anuladas: filas.length - vigentes.length,
    n_sin_fiscal: vigentes.filter((f) => f.medio && !f.control_fiscal).length,
    iva_retenido_bs: totalRetenidoPeriodoBs,
    // Retenciones del período cuya factura es de otro mes: no tienen fila en el libro, por eso se listan aparte.
    iva_retenido_otros_periodos_bs: ivaRetenidoOtrosPeriodosBs,
    retenciones_periodo,
    igtf_bs: suma(vigentes, "igtf_bs"), igtf_usd: suma(vigentes, "igtf_usd"),
    total_bs: suma(vigentes, "total_bs"), total_usd: suma(vigentes, "total_usd"),
  });
});

// ---------------------------------------------------------------- libro de compras
informes.get("/compras", async (c) => {
  const r = rango(c); if (typeof r === "string") return falla(c, 400, r);
  const modo = await modoActual(c.env.DB), db = c.env.DB;
  const [docs, imp] = await Promise.all([
    db.prepare(`SELECT id, fecha, proveedor_rif, proveedor_nombre, factura_numero, control_numero, estado, tasa_e8, subtotal_usd, iva_usd, total_usd, subtotal_bs, iva_bs, total_bs, renglones_json
        FROM compras WHERE modo = ? AND fecha BETWEEN ? AND ? ORDER BY fecha, id`).bind(modo, r.desde, r.hasta).all<Fila>(),
    db.prepare(`SELECT i.compra_id, i.alicuota_cent, i.base_bs, i.iva_bs FROM compra_impuestos i JOIN compras c ON c.id = i.compra_id
        WHERE c.modo = ? AND c.fecha BETWEEN ? AND ?`).bind(modo, r.desde, r.hasta).all<Fila>(),
  ]);
  const porCompra = new Map<number, Fila[]>();
  for (const i of imp.results) porCompra.set(i.compra_id, [...(porCompra.get(i.compra_id) ?? []), i]);
  const filas: Fila[] = docs.results.map(({ renglones_json, ...d }) => ({
    ...d,
    tipo_compra: clasificarRenglonesCompra(renglones_json),
    impuestos: (porCompra.get(d.id) ?? []).map((i) => ({ alicuota_cent: i.alicuota_cent, base_bs: i.base_bs, iva_bs: i.iva_bs })),
  }));
  const vigentes = filas.filter((f) => f.estado === "REGISTRADA"), porAlicuota = new Map<number, { base_bs: number; iva_bs: number }>();
  for (const f of vigentes) for (const i of f.impuestos) {
    const t = porAlicuota.get(i.alicuota_cent) ?? { base_bs: 0, iva_bs: 0 };
    porAlicuota.set(i.alicuota_cent, { base_bs: t.base_bs + i.base_bs, iva_bs: t.iva_bs + i.iva_bs });
  }
  const alicuotas = [...porAlicuota].sort((a, b) => a[0] - b[0]).map(([alicuota_cent, t]) => ({ alicuota_cent, ...t }));
  return c.json({ ok: true, modo, desde: r.desde, hasta: r.hasta, filas, alicuotas, n_vigentes: vigentes.length, n_anuladas: filas.length - vigentes.length,
    n_sin_tasa: vigentes.filter((f) => f.tasa_e8 == null).length,
    subtotal_bs: suma(vigentes, "subtotal_bs"), iva_bs: suma(vigentes, "iva_bs"), total_bs: suma(vigentes, "total_bs"),
    subtotal_usd: suma(vigentes, "subtotal_usd"), iva_usd: suma(vigentes, "iva_usd"), total_usd: suma(vigentes, "total_usd") });
});

// ---------------------------------------------------------------- resumen mensual de IVA + Ingresos Brutos Municipales (Alcaldía)
informes.get("/resumen-iva", async (c) => {
  const r = rango(c); if (typeof r === "string") return falla(c, 400, r);
  const modo = await modoActual(c.env.DB), db = c.env.DB;
  const signo = `(CASE WHEN d.es_nota_credito = 1 THEN -1 ELSE 1 END)`;
  const [ventas, compras, sinTasa, retenciones] = await Promise.all([
    db.prepare(`SELECT substr(d.fecha_emision, 1, 7) AS mes,
        SUM(CASE WHEN i.alicuota_cent > 0 THEN i.base_bs * ${signo} ELSE 0 END) AS gravadas_bs,
        SUM(CASE WHEN i.alicuota_cent = 0 THEN i.base_bs * ${signo} ELSE 0 END) AS exentas_bs,
        SUM(CASE WHEN i.alicuota_cent > 0 THEN i.base_usd * ${signo} ELSE 0 END) AS gravadas_usd,
        SUM(CASE WHEN i.alicuota_cent = 0 THEN i.base_usd * ${signo} ELSE 0 END) AS exentas_usd,
        SUM(i.iva_bs * ${signo}) AS iva_bs
        FROM documento_impuestos i JOIN documentos d ON d.id = i.documento_id
        WHERE d.tipo = 'FACTURA' AND d.estado = 'EMITIDO' AND d.modo = ? AND d.fecha_emision BETWEEN ? AND ? GROUP BY mes`).bind(modo, r.desde, r.hasta).all<Fila>(),
    db.prepare(`SELECT substr(c.fecha, 1, 7) AS mes, SUM(CASE WHEN i.alicuota_cent > 0 THEN i.base_bs ELSE 0 END) AS gravadas_bs,
        SUM(CASE WHEN i.alicuota_cent = 0 THEN i.base_bs ELSE 0 END) AS exentas_bs, SUM(i.iva_bs) AS iva_bs
        FROM compra_impuestos i JOIN compras c ON c.id = i.compra_id
        WHERE c.estado = 'REGISTRADA' AND c.modo = ? AND c.fecha BETWEEN ? AND ? GROUP BY mes`).bind(modo, r.desde, r.hasta).all<Fila>(),
    db.prepare(`SELECT substr(fecha, 1, 7) AS mes, COUNT(*) AS n FROM compras WHERE estado = 'REGISTRADA' AND tasa_e8 IS NULL AND modo = ? AND fecha BETWEEN ? AND ? GROUP BY mes`)
      .bind(modo, r.desde, r.hasta).all<Fila>(),
    db.prepare(`SELECT substr(fecha_pago, 1, 7) AS mes, COALESCE(SUM(monto_recibido), 0) AS retenido_bs
        FROM pagos WHERE estado = 'VIGENTE' AND es_retencion_iva = 1 AND modo = ? AND fecha_pago BETWEEN ? AND ? GROUP BY mes`)
      .bind(modo, r.desde, r.hasta).all<Fila>(),
  ]);
  const V = new Map(ventas.results.map((x) => [x.mes, x])), C = new Map(compras.results.map((x) => [x.mes, x]));
  const S = new Map(sinTasa.results.map((x) => [x.mes, x.n])), R = new Map(retenciones.results.map((x) => [x.mes, x.retenido_bs]));
  const meses = [...new Set([...V.keys(), ...C.keys(), ...S.keys(), ...R.keys()])].sort();
  const filas = meses.map((mes) => {
    const v = V.get(mes) ?? {}, k = C.get(mes) ?? {}, debito_bs = v.iva_bs ?? 0, credito_bs = k.iva_bs ?? 0, retenciones_bs = R.get(mes) ?? 0;
    const ventas_gravadas_bs = v.gravadas_bs ?? 0, ventas_exentas_bs = v.exentas_bs ?? 0;
    const ventas_gravadas_usd = v.gravadas_usd ?? 0, ventas_exentas_usd = v.exentas_usd ?? 0;
    const diferencia_bs = debito_bs - credito_bs;
    const cuota_tributaria_bs = diferencia_bs - retenciones_bs;
    return {
      mes, ventas_gravadas_bs, ventas_exentas_bs, debito_bs,
      compras_gravadas_bs: k.gravadas_bs ?? 0, compras_exentas_bs: k.exentas_bs ?? 0,
      credito_bs, diferencia_bs, retenciones_bs, cuota_tributaria_bs,
      ingresos_brutos_bs: ventas_gravadas_bs + ventas_exentas_bs,
      ingresos_brutos_usd: ventas_gravadas_usd + ventas_exentas_usd,
      ventas_gravadas_usd, ventas_exentas_usd,
      compras_sin_tasa: S.get(mes) ?? 0,
    };
  });
  const t = (k: string) => suma(filas, k);
  const tipo_contribuyente = await leerTipoContribuyente(db);
  return c.json({
    ok: true, modo, tipo_contribuyente, desde: r.desde, hasta: r.hasta, filas,
    total: {
      ventas_gravadas_bs: t("ventas_gravadas_bs"), ventas_exentas_bs: t("ventas_exentas_bs"), debito_bs: t("debito_bs"),
      compras_gravadas_bs: t("compras_gravadas_bs"), compras_exentas_bs: t("compras_exentas_bs"), credito_bs: t("credito_bs"),
      diferencia_bs: t("diferencia_bs"), retenciones_bs: t("retenciones_bs"), cuota_tributaria_bs: t("cuota_tributaria_bs"),
      ingresos_brutos_bs: t("ingresos_brutos_bs"), ingresos_brutos_usd: t("ingresos_brutos_usd"),
      ventas_gravadas_usd: t("ventas_gravadas_usd"), ventas_exentas_usd: t("ventas_exentas_usd"),
      compras_sin_tasa: t("compras_sin_tasa"),
    },
  });
});

// ---------------------------------------------------------------- declaración de IGTF (3% SNAT/2022/000013)
informes.get("/igtf", async (c) => {
  const r = rango(c); if (typeof r === "string") return falla(c, 400, r);
  const modo = await modoActual(c.env.DB), db = c.env.DB;
  const { results } = await db.prepare(
    `SELECT d.id, d.es_nota_credito, COALESCE(d.es_nota_debito, 0) AS es_nota_debito, d.factura_afectada_id,
            (SELECT fa.numero FROM documentos fa WHERE fa.id = d.factura_afectada_id) AS factura_afectada_numero,
            d.numero, d.control_interno, d.control_fiscal, d.medio, d.fecha_emision,
            d.cliente_rif, d.cliente_nombre, d.estado, d.tasa_e8,
            d.subtotal_usd, d.iva_usd, d.subtotal_bs, d.iva_bs,
            d.igtf_alicuota_cent, d.igtf_usd, d.igtf_bs, d.total_usd, d.total_bs
     FROM documentos d
     WHERE d.tipo = 'FACTURA' AND d.modo = ? AND d.aplica_igtf = 1 AND d.igtf_bs > 0
       AND d.estado IN ('EMITIDO', 'ANULADO') AND d.fecha_emision BETWEEN ? AND ?
     ORDER BY d.fecha_emision, d.id`
  ).bind(modo, r.desde, r.hasta).all<Fila>();
  const filas: Fila[] = results.map((d) => {
    const signo = d.es_nota_credito ? -1 : 1;
    const base_divisas_usd = ((d.subtotal_usd ?? 0) + (d.iva_usd ?? 0)) * signo;
    const base_divisas_bs = ((d.subtotal_bs ?? 0) + (d.iva_bs ?? 0)) * signo;
    return {
      ...d,
      base_divisas_usd,
      base_divisas_bs,
      base_igtf_usd: base_divisas_usd,
      base_igtf_bs: base_divisas_bs,
      igtf_usd: (d.igtf_usd ?? 0) * signo,
      igtf_bs: (d.igtf_bs ?? 0) * signo,
      total_usd: (d.total_usd ?? 0) * signo,
      total_bs: (d.total_bs ?? 0) * signo,
    };
  });
  const vigentes = filas.filter((f) => f.estado === "EMITIDO");
  const base_divisas_bs = suma(vigentes, "base_divisas_bs");
  const base_divisas_usd = suma(vigentes, "base_divisas_usd");
  const tipo_contribuyente = await leerTipoContribuyente(db);
  return c.json({
    ok: true, modo, tipo_contribuyente, desde: r.desde, hasta: r.hasta, filas,
    n_documentos: vigentes.length,
    n_vigentes: vigentes.filter((f) => !f.es_nota_credito && !f.es_nota_debito).length,
    n_notas_credito: vigentes.filter((f) => f.es_nota_credito).length,
    n_notas_debito: vigentes.filter((f) => f.es_nota_debito).length,
    n_anuladas: filas.length - vigentes.length,
    base_divisas_bs,
    base_divisas_usd,
    base_igtf_bs: base_divisas_bs,
    base_igtf_usd: base_divisas_usd,
    igtf_bs: suma(vigentes, "igtf_bs"),
    igtf_usd: suma(vigentes, "igtf_usd"),
  });
});

// ---------------------------------------------------------------- corte X y cierre Z de caja y facturación
informes.get("/cierre-caja", async (c) => {
  const r = rango(c); if (typeof r === "string") return falla(c, 400, r);
  const modo = await modoActual(c.env.DB), db = c.env.DB;
  const [docsRes, impRes, pagosRes] = await Promise.all([
    db.prepare(
      `SELECT id, tipo, es_nota_credito, COALESCE(es_nota_debito, 0) AS es_nota_debito, estado, numero, control_interno, control_fiscal, fecha_emision,
              subtotal_usd, iva_usd, igtf_usd, total_usd, subtotal_bs, iva_bs, igtf_bs, total_bs
       FROM documentos
       WHERE modo = ? AND estado IN ('EMITIDO', 'FACTURADO', 'ANULADO') AND fecha_emision BETWEEN ? AND ?
       ORDER BY id`
    ).bind(modo, r.desde, r.hasta).all<Fila>(),
    db.prepare(
      `SELECT i.alicuota_cent,
              SUM(CASE WHEN d.es_nota_credito = 1 THEN -i.base_bs ELSE i.base_bs END) AS base_bs,
              SUM(CASE WHEN d.es_nota_credito = 1 THEN -i.iva_bs ELSE i.iva_bs END) AS iva_bs,
              SUM(CASE WHEN d.es_nota_credito = 1 THEN -i.base_usd ELSE i.base_usd END) AS base_usd,
              SUM(CASE WHEN d.es_nota_credito = 1 THEN -i.iva_usd ELSE i.iva_usd END) AS iva_usd
       FROM documento_impuestos i JOIN documentos d ON d.id = i.documento_id
       WHERE d.tipo = 'FACTURA' AND d.modo = ? AND d.estado = 'EMITIDO' AND d.fecha_emision BETWEEN ? AND ?
       GROUP BY i.alicuota_cent ORDER BY i.alicuota_cent`
    ).bind(modo, r.desde, r.hasta).all<Fila>(),
    db.prepare(
      `SELECT p.id, p.numero,
              CASE WHEN p.es_retencion_iva = 1 THEN 'RETENCION_IVA' WHEN COALESCE(p.es_retencion_islr, 0) = 1 THEN 'RETENCION_ISLR' ELSE p.metodo END AS metodo,
              p.es_retencion_iva, COALESCE(p.es_retencion_islr, 0) AS es_retencion_islr, p.porcentaje_retencion, p.comprobante_retencion,
              p.moneda, p.monto_recibido, p.tasa_e8, p.monto_usd,
              p.referencia, p.fecha_pago, p.estado, d.tipo AS doc_tipo, COALESCE(d.es_nota_debito, 0) AS doc_es_nota_debito, d.numero AS doc_numero, d.cliente_nombre, d.cliente_rif
       FROM pagos p JOIN documentos d ON d.id = p.documento_id
       WHERE p.modo = ? AND p.fecha_pago BETWEEN ? AND ?
       ORDER BY p.id`
    ).bind(modo, r.desde, r.hasta).all<Fila>(),
  ]);

  const docs = docsRes.results;
  const facturas = docs.filter((d) => d.tipo === "FACTURA" && !d.es_nota_credito && !d.es_nota_debito);
  const notasDebito = docs.filter((d) => d.tipo === "FACTURA" && d.es_nota_debito);
  const notasCredito = docs.filter((d) => d.tipo === "FACTURA" && d.es_nota_credito);
  const docFiscales = docs.filter((d) => d.tipo === "FACTURA");

  const facVig = facturas.filter((d) => d.estado === "EMITIDO");
  const ndVig = notasDebito.filter((d) => d.estado === "EMITIDO");
  const ncVig = notasCredito.filter((d) => d.estado === "EMITIDO");

  const minMax = (xs: Fila[], campo = "numero") => {
    const nums = xs.map((x) => x[campo]).filter((n) => n != null) as number[];
    return nums.length ? [Math.min(...nums), Math.max(...nums)] : [null, null];
  };
  const [factura_desde, factura_hasta] = minMax(facturas);
  const [nd_desde, nd_hasta] = minMax(notasDebito);
  const [nc_desde, nc_hasta] = minMax(notasCredito);
  const [control_desde, control_hasta] = minMax(docFiscales, "control_interno");

  const pagos = pagosRes.results;
  const pagosVig = pagos.filter((p) => p.estado === "VIGENTE");
  const [recibo_desde, recibo_hasta] = minMax(pagos);

  const porMetodoMap = new Map<string, { metodo: string; moneda: string; operaciones: number; monto_moneda: number; equiv_bs: number; equiv_usd: number }>();
  for (const p of pagosVig) {
    const k = `${p.metodo}:${p.moneda}`;
    const actual = porMetodoMap.get(k) ?? { metodo: p.metodo, moneda: p.moneda, operaciones: 0, monto_moneda: 0, equiv_bs: 0, equiv_usd: 0 };
    actual.operaciones += 1;
    actual.monto_moneda += p.monto_recibido ?? 0;
    const eqBs = p.moneda === "BS" ? (p.monto_recibido ?? 0) : (p.tasa_e8 ? redondear(p.monto_recibido ?? 0, p.tasa_e8, 1e8) : 0);
    actual.equiv_bs += eqBs;
    actual.equiv_usd += p.monto_usd ?? 0;
    porMetodoMap.set(k, actual);
  }
  const metodos = [...porMetodoMap.values()];

  const neta = (k: string) => suma(facVig, k) + suma(ndVig, k) - suma(ncVig, k);
  const recaudacion = {
    metodos,
    cobrado_bs: pagosVig.filter((p) => p.moneda === "BS" && !p.es_retencion_iva && !p.es_retencion_islr).reduce((s, p) => s + (p.monto_recibido ?? 0), 0),
    retenciones_iva_bs: pagosVig.filter((p) => p.es_retencion_iva).reduce((s, p) => s + (p.monto_recibido ?? 0), 0),
    retenciones_islr_bs: pagosVig.filter((p) => p.es_retencion_islr).reduce((s, p) => s + (p.monto_recibido ?? 0), 0),
    cobrado_divisas_usd: pagosVig.filter((p) => p.moneda === "USD").reduce((s, p) => s + (p.monto_recibido ?? 0), 0),
    total_equiv_bs: suma(metodos, "equiv_bs"),
    total_equiv_usd: suma(pagosVig, "monto_usd"),
    pagos,
  };

  return c.json({
    ok: true,
    modo,
    desde: r.desde,
    hasta: r.hasta,
    numeracion: {
      factura_desde,
      factura_hasta,
      facturas_vigentes: facVig.length,
      facturas_anuladas: facturas.length - facVig.length,
      nd_desde,
      nd_hasta,
      nd_vigentes: ndVig.length,
      nd_anuladas: notasDebito.length - ndVig.length,
      nc_desde,
      nc_hasta,
      nc_vigentes: ncVig.length,
      nc_anuladas: notasCredito.length - ncVig.length,
      control_desde,
      control_hasta,
      recibo_desde,
      recibo_hasta,
      recibos_vigentes: pagosVig.length,
      recibos_anuladas: pagos.length - pagosVig.length,
    },
    facturacion: {
      subtotal_bs: neta("subtotal_bs"),
      iva_bs: neta("iva_bs"),
      igtf_bs: neta("igtf_bs"),
      total_bs: neta("total_bs"),
      subtotal_usd: neta("subtotal_usd"),
      iva_usd: neta("iva_usd"),
      igtf_usd: neta("igtf_usd"),
      total_usd: neta("total_usd"),
      alicuotas: impRes.results,
    },
    recaudacion,
  });
});

// ---------------------------------------------------------------- ganancias (privadas: solo para el dueño; netas de notas de crédito)
const SIGNO = `(CASE WHEN d.es_nota_credito = 1 THEN -1 ELSE 1 END)`;
const COSTO = `(((r.cantidad_milli * COALESCE(r.costo_usd, 0) + 500) / 1000) * ${SIGNO})`;
const INGRESO = `(r.monto_usd * ${SIGNO})`;
informes.get("/ganancias", async (c) => {
  const r = rango(c); if (typeof r === "string") return falla(c, 400, r);
  const modo = await modoActual(c.env.DB), db = c.env.DB;
  const base = `FROM documento_renglones r JOIN documentos d ON d.id = r.documento_id
    WHERE d.tipo = 'FACTURA' AND d.estado = 'EMITIDO' AND d.modo = ? AND d.fecha_emision BETWEEN ? AND ?`;
  const [tipos, items, clientes] = await Promise.all([
    db.prepare(`SELECT r.tipo, SUM(${INGRESO}) AS ingresos, SUM(${COSTO}) AS costos ${base} GROUP BY r.tipo`).bind(modo, r.desde, r.hasta).all<Fila>(),
    db.prepare(`SELECT r.tipo, MIN(r.descripcion) AS nombre, SUM(r.cantidad_milli * ${SIGNO}) AS cantidad_milli, SUM(${INGRESO}) AS ingresos, SUM(${COSTO}) AS costos ${base}
        GROUP BY r.tipo, COALESCE(CAST(r.catalogo_id AS TEXT), r.descripcion) ORDER BY SUM(${INGRESO}) - SUM(${COSTO}) DESC LIMIT 100`).bind(modo, r.desde, r.hasta).all<Fila>(),
    db.prepare(`SELECT COALESCE(d.cliente_rif, '') AS rif, MIN(d.cliente_nombre) AS nombre, SUM(${INGRESO}) AS ingresos, SUM(${COSTO}) AS costos ${base}
        GROUP BY COALESCE(d.cliente_rif, '') ORDER BY SUM(${INGRESO}) - SUM(${COSTO}) DESC LIMIT 100`).bind(modo, r.desde, r.hasta).all<Fila>(),
  ]);
  const con = (f: Fila): Fila => ({ ...f, ganancia: f.ingresos - f.costos });
  const t = (x: string) => con(tipos.results.find((f) => f.tipo === x) ?? { tipo: x, ingresos: 0, costos: 0 });
  const servicios = t("SERVICIO"), productos = t("PRODUCTO");
  return c.json({ ok: true, modo, desde: r.desde, hasta: r.hasta, servicios, productos,
    total: { ingresos: servicios.ingresos + productos.ingresos, costos: servicios.costos + productos.costos, ganancia: servicios.ganancia + productos.ganancia },
    por_item: items.results.map(con), por_cliente: clientes.results.map(con) });
});

// ---------------------------------------------------------------- cuentas por cobrar: estado de cuenta por cliente y antigüedad
const TRAMOS = [["SIN_VENCER", "Al día"], ["D1_30", "1 a 30 días"], ["D31_60", "31 a 60 días"], ["D61_90", "61 a 90 días"], ["D91_MAS", "Más de 90 días"]] as const;
const tramo = (atraso: number) => (atraso <= 0 ? "SIN_VENCER" : atraso <= 30 ? "D1_30" : atraso <= 60 ? "D31_60" : atraso <= 90 ? "D61_90" : "D91_MAS");
informes.get("/por-cobrar", async (c) => {
  const modo = await modoActual(c.env.DB), hoy = fechaCaracas();
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM (SELECT d.id, d.numero, COALESCE(d.es_nota_debito, 0) AS es_nota_debito, d.cliente_rif, d.cliente_nombre, d.fecha_emision, d.vence_el, d.condicion, d.total_usd, ${PAGADO} AS pagado_usd
       FROM documentos d WHERE d.tipo = 'FACTURA' AND d.es_nota_credito = 0 AND d.estado = 'EMITIDO' AND d.modo = ?) WHERE total_usd - pagado_usd > 0 ORDER BY cliente_nombre COLLATE NOCASE, fecha_emision, id`
  ).bind(modo).all<Fila>();
  const vacios = () => Object.fromEntries(TRAMOS.map(([k]) => [k, 0])) as Record<string, number>;
  const clientes = new Map<string, Fila>(), tramos = vacios();
  for (const f of results) {
    const atraso = f.vence_el && f.vence_el < hoy ? Math.round((Date.parse(hoy) - Date.parse(f.vence_el)) / 86400000) : 0, saldo = f.total_usd - f.pagado_usd, t = tramo(atraso);
    const k = f.cliente_rif ?? "", cli = clientes.get(k) ?? { rif: k, nombre: f.cliente_nombre, saldo_usd: 0, tramos: vacios(), facturas: [] };
    cli.saldo_usd += saldo; cli.tramos[t] += saldo; tramos[t] += saldo;
    cli.facturas.push({ id: f.id, numero: f.numero, es_nota_debito: f.es_nota_debito, fecha_emision: f.fecha_emision, vence_el: f.vence_el, condicion: f.condicion, total_usd: f.total_usd, pagado_usd: f.pagado_usd, saldo_usd: saldo, dias_atraso: atraso, tramo: t });
    clientes.set(k, cli);
  }
  const lista = [...clientes.values()].sort((a, b) => b.saldo_usd - a.saldo_usd);
  return c.json({ ok: true, modo, hoy, tramos: TRAMOS.map(([clave, etiqueta]) => ({ clave, etiqueta, saldo_usd: tramos[clave] })),
    total_usd: lista.reduce((s, x) => s + x.saldo_usd, 0), n_facturas: results.length, clientes: lista });
});

// ---------------------------------------------------------------- inventario valorizado y movimientos del periodo
informes.get("/inventario", async (c) => {
  const r = rango(c); if (typeof r === "string") return falla(c, 400, r);
  const modo = await modoActual(c.env.DB), db = c.env.DB;
  const [prod, movs, resumen] = await Promise.all([
    db.prepare(`SELECT c.id, c.codigo, c.nombre, COALESCE(SUM(m.cantidad_milli), 0) AS stock_milli, COALESCE(SUM(m.valor_usd), 0) AS valor_usd
        FROM catalogo c LEFT JOIN movimientos_stock m ON m.producto_id = c.id AND m.modo = ?
        WHERE c.tipo = 'PRODUCTO' AND c.controla_stock = 1 GROUP BY c.id HAVING c.activo = 1 OR stock_milli <> 0 ORDER BY c.nombre COLLATE NOCASE`).bind(modo).all<Fila>(),
    db.prepare(`SELECT m.id, m.fecha, c.nombre AS producto, m.tipo, m.motivo, m.cantidad_milli, m.valor_usd FROM movimientos_stock m JOIN catalogo c ON c.id = m.producto_id
        WHERE m.modo = ? AND m.fecha BETWEEN ? AND ? ORDER BY m.fecha DESC, m.id DESC LIMIT 300`).bind(modo, r.desde, r.hasta).all<Fila>(),
    db.prepare(`SELECT tipo, COUNT(*) AS n, SUM(valor_usd) AS valor_usd FROM movimientos_stock WHERE modo = ? AND fecha BETWEEN ? AND ? GROUP BY tipo ORDER BY tipo`)
      .bind(modo, r.desde, r.hasta).all<Fila>(),
  ]);
  const items = prod.results.map((p) => ({ ...p, costo_prom_usd: p.stock_milli > 0 ? redondear(1000, p.valor_usd, p.stock_milli) : 0 }));
  const nMovs = suma(resumen.results, "n");
  return c.json({ ok: true, modo, desde: r.desde, hasta: r.hasta, items, valor_total_usd: suma(items, "valor_usd"), movimientos: movs.results,
    movimientos_n: nMovs, movimientos_recortados: nMovs > movs.results.length, resumen_movimientos: resumen.results });
});

// ---------------------------------------------------------------- retenciones de ISLR recibidas (Decreto 1.808 / Relación ARC)
informes.get("/islr", async (c) => {
  const r = rango(c); if (typeof r === "string") return falla(c, 400, r);
  const modo = await modoActual(c.env.DB), db = c.env.DB;
  const { results } = await db.prepare(
    `SELECT p.id, p.numero AS recibo_numero, p.fecha_pago, p.comprobante_retencion, p.referencia,
            p.porcentaje_retencion, p.monto_recibido AS retenido_bs, p.monto_usd AS retenido_usd, p.tasa_e8, p.estado,
            d.id AS factura_id, d.numero AS factura_numero, COALESCE(d.es_nota_debito, 0) AS es_nota_debito,
            d.control_interno, d.control_fiscal, d.fecha_emision, d.cliente_rif, d.cliente_nombre,
            d.subtotal_bs AS base_imponible_bs, d.subtotal_usd AS base_imponible_usd
     FROM pagos p JOIN documentos d ON d.id = p.documento_id
     WHERE p.modo = ? AND COALESCE(p.es_retencion_islr, 0) = 1 AND p.fecha_pago BETWEEN ? AND ?
     ORDER BY p.fecha_pago ASC, p.id ASC`
  ).bind(modo, r.desde, r.hasta).all<Fila>();

  const vigentes = results.filter((x) => x.estado === "VIGENTE");
  const totalRetBs = suma(vigentes, "retenido_bs");
  const totalRetUsd = suma(vigentes, "retenido_usd");
  return c.json({
    ok: true,
    modo,
    desde: r.desde,
    hasta: r.hasta,
    filas: results,
    n_retenciones: vigentes.length,
    n_comprobantes: vigentes.length,
    n_anulados: results.length - vigentes.length,
    base_imponible_bs: suma(vigentes, "base_imponible_bs"),
    base_imponible_usd: suma(vigentes, "base_imponible_usd"),
    retenido_bs: totalRetBs,
    retenido_usd: totalRetUsd,
    total_retenido_bs: totalRetBs,
    total_retenido_usd: totalRetUsd,
  });
});

// ---------------------------------------------------------------- envío de cierre contable mensual con CSV adjuntos por correo
informes.post("/enviar-cierre", async (c) => {
  const b = await leerJson(c), u = c.get("usuario");
  const mes = texto(b.mes, 7) || fechaCaracas().slice(0, 7);
  const emailExtra = texto(b.email, 120).toLowerCase() || undefined;
  const res = await enviarCierreMensualInquilino(c.env.DB, c.env as unknown as Record<string, string>, mes, emailExtra);
  if (!res.ok) return falla(c, 400, res.error);
  await auditar(c, u.id, "CIERRE_MENSUAL_CORREO", `${mes} -> ${res.destinos.join(",")}`);
  return c.json({ ok: true, mes: res.mes, destinos: res.destinos, destinatarios: res.destinos });
});

export default informes;
