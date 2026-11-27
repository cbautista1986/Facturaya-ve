// Módulo PAGOS: cobros recibidos, por cobrar, recibos y datos de cobro: /api/pagos
// Reglas: el saldo NUNCA se guarda (se calcula: total del documento - pagos vigentes), un pago no se edita ni se borra (se anula con
// motivo), los bolívares se convierten a dólares con la tasa del día del pago y cada pago lleva su recibo con correlativo propio.
import { Hono } from "hono";
import { aCentavos, aRifSeniat, aTasaE8, bsAUsd } from "../../public/dinero.js";
import { enviarCorreo } from "../correo";
import { EMAIL, PAGADO, RIF, auditar, comodin, falla, fechaCaracas, idParam, leerJson, modoActual, normalizarWhatsapp, parametrosVigentes, requiereAdmin, requiereSesion, texto, type Env } from "../comun";
import { leerTipoContribuyente } from "../regimen";
import { evaluarAnulacionPago } from "../reglas-fiscales";
import { validarTasaFiscalVigente } from "../tasa-bcv";

const pagos = new Hono<Env>();
pagos.use("*", requiereSesion);
type Fila = Record<string, any>;

const METODOS: Record<string, string[]> = {
  PAGO_MOVIL: ["BS"],
  TRANSFERENCIA: ["BS", "USD"],
  EFECTIVO: ["BS", "USD"],
  ZELLE: ["USD"],
  BINANCE: ["USD"],
  PAYPAL: ["USD"],
  RETENCION_IVA: ["BS"],
  RETENCION_ISLR: ["BS"],
  OTRO: ["BS", "USD"],
};
const dolares = (c: number) => `$ ${(c / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function porCobrar(db: D1Database) {
  const hoy = fechaCaracas(), modo = await modoActual(db);
  const { results } = await db.prepare(
    `SELECT * FROM (SELECT d.id, d.numero, COALESCE(d.es_nota_debito, 0) AS es_nota_debito, d.cliente_nombre, d.fecha_emision, d.vence_el, d.condicion, d.dias_credito, d.subtotal_usd, d.subtotal_bs, d.iva_bs, d.tasa_e8, d.total_usd, ${PAGADO} AS pagado_usd
       FROM documentos d WHERE d.tipo = 'FACTURA' AND d.es_nota_credito = 0 AND d.estado = 'EMITIDO' AND d.modo = ?) WHERE total_usd - pagado_usd > 0 ORDER BY vence_el, id`
  ).bind(modo).all<Fila>();
  return results.map((r) => {
    const vencida = !!r.vence_el && r.vence_el < hoy;
    return { ...r, saldo_usd: r.total_usd - r.pagado_usd, vencida, dias_atraso: vencida ? Math.round((Date.parse(hoy) - Date.parse(r.vence_el)) / 86400000) : 0 };
  });
}

pagos.get("/por-cobrar", async (c) => c.json({ ok: true, facturas: await porCobrar(c.env.DB) }));

pagos.get("/resumen", async (c) => {
  const lista = await porCobrar(c.env.DB), mes = fechaCaracas().slice(0, 7), modo = await modoActual(c.env.DB);
  const venc = lista.filter((x) => x.vencida);
  const cobrado = await c.env.DB.prepare(`SELECT COALESCE(SUM(monto_usd), 0) AS t FROM pagos WHERE estado = 'VIGENTE' AND modo = ? AND substr(fecha_pago, 1, 7) = ?`).bind(modo, mes).first<{ t: number }>();
  return c.json({ ok: true, por_cobrar_usd: lista.reduce((s, x) => s + x.saldo_usd, 0), por_cobrar_n: lista.length,
    vencidas_n: venc.length, vencidas_usd: venc.reduce((s, x) => s + x.saldo_usd, 0), cobrado_mes_usd: cobrado?.t ?? 0 });
});

// ---------------------------------------------------------------- datos de cobro (campos fijos por método)
const CAMPOS: Record<string, string[]> = { PAGO_MOVIL: ["banco", "documento", "telefono"], TRANSFERENCIA: ["banco", "cuenta", "tipo", "titular", "documento"],
  ZELLE: ["contacto", "titular"], BINANCE: ["contacto", "titular"], PAYPAL: ["contacto"], EFECTIVO: [] };

function limpiarDatos(metodo: string, bruto: Record<string, unknown>) {
  const campos = CAMPOS[metodo];
  if (!campos) return "Método no válido.";
  const out: Record<string, string> = {};
  for (const k of [...campos, "nota"]) { const v = texto(bruto[k], k === "nota" ? 300 : 80); if (v) out[k] = v; }
  if (out.telefono) {
    const n = normalizarWhatsapp(out.telefono);
    if (typeof n !== "string" || !n.startsWith("58")) return "El teléfono del pago móvil no es válido (ejemplo: 0414-1234567).";
    out.telefono = "0" + n.slice(2);
  }
  if (out.cuenta) { const d = out.cuenta.replace(/\D/g, ""); if (d.length !== 20) return "El número de cuenta debe tener 20 dígitos."; out.cuenta = d; }
  if (out.documento) { out.documento = out.documento.toUpperCase(); if (!RIF.test(out.documento)) return "La cédula o el RIF no es válido (ejemplo: V-12345678)."; }
  return out;
}

pagos.get("/metodos", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT metodo, activo, datos_json FROM metodos_cobro ORDER BY rowid`).all<Fila>();
  return c.json({ ok: true, metodos: results.map((r) => ({ metodo: r.metodo, activo: !!r.activo, datos: JSON.parse(r.datos_json || "{}") })) });
});

pagos.put("/metodos/:metodo", requiereAdmin, async (c) => {
  const metodo = c.req.param("metodo") ?? "", b = await leerJson(c);
  const datos = limpiarDatos(metodo, ((b.datos ?? {}) as Record<string, unknown>));
  if (typeof datos === "string") return falla(c, 400, datos);
  const activo = b.activo === true || b.activo === "1" ? 1 : 0;
  const r = await c.env.DB.prepare(`UPDATE metodos_cobro SET activo = ?, datos_json = ? WHERE metodo = ?`).bind(activo, JSON.stringify(datos), metodo).run();
  if (!r.meta.changes) return falla(c, 404, "Método no encontrado.");
  await auditar(c, c.get("usuario").id, "COBRO_DATOS", metodo);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- cobros (con paginación y filtro por mes/fechas v4.0)
pagos.get("/", async (c) => {
  const q = texto(c.req.query("q"), 60), like = `%${comodin(q)}%`;
  const mes = texto(c.req.query("mes"), 7);
  const desde = texto(c.req.query("desde"), 10);
  const hasta = texto(c.req.query("hasta"), 10);
  const pagina = Math.max(0, Math.floor(Number(c.req.query("pagina") || 0) || 0));
  const limite = Math.max(1, Math.min(200, Math.floor(Number(c.req.query("limite") || 100) || 100)));
  const offset = pagina * limite;

  const conds: string[] = [
    `(? = '' OR d.cliente_nombre LIKE ? ESCAPE '\\' OR CAST(p.numero AS TEXT) LIKE ? ESCAPE '\\' OR p.referencia LIKE ? ESCAPE '\\' OR p.comprobante_retencion LIKE ? ESCAPE '\\')`,
  ];
  const binds: (string | number)[] = [q, like, like, like, like];

  if (/^\d{4}-\d{2}$/.test(mes)) {
    conds.push(`substr(p.fecha_pago, 1, 7) = ?`);
    binds.push(mes);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
    conds.push(`p.fecha_pago >= ?`);
    binds.push(desde);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    conds.push(`p.fecha_pago <= ?`);
    binds.push(hasta);
  }

  binds.push(limite + 1, offset);
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.numero,
            CASE WHEN p.es_retencion_iva = 1 THEN 'RETENCION_IVA' WHEN COALESCE(p.es_retencion_islr, 0) = 1 THEN 'RETENCION_ISLR' ELSE p.metodo END AS metodo,
            p.es_retencion_iva, COALESCE(p.es_retencion_islr, 0) AS es_retencion_islr, p.porcentaje_retencion, p.comprobante_retencion,
            p.moneda, p.monto_recibido, p.tasa_e8, p.monto_usd, p.fecha_pago, p.estado, p.modo,
            d.tipo AS doc_tipo, COALESCE(d.es_nota_debito, 0) AS doc_es_nota_debito, d.numero AS doc_numero, d.cliente_nombre
     FROM pagos p JOIN documentos d ON d.id = p.documento_id
     WHERE ${conds.join(" AND ")}
     ORDER BY p.fecha_pago DESC, p.id DESC LIMIT ? OFFSET ?`
  ).bind(...binds).all();

  const hayMas = results.length > limite;
  const filas = hayMas ? results.slice(0, limite) : results;
  return c.json({ ok: true, pagos: filas, pagina, limite, hay_mas: hayMas });
});

pagos.post("/", async (c) => {
  const db = c.env.DB, u = c.get("usuario"), b = await leerJson(c), hoy = fechaCaracas();
  const docId = Number(b.documento_id) || 0, metodo = texto(b.metodo, 20), moneda = texto(b.moneda, 3).toUpperCase();
  if (!METODOS[metodo] || !METODOS[metodo].includes(moneda)) return falla(c, 400, "El método de pago y la moneda no son compatibles.");
  const D = await db.prepare(`SELECT d.id, d.tipo, d.es_nota_credito, COALESCE(d.es_nota_debito, 0) AS es_nota_debito, d.estado, d.modo, d.total_usd, d.subtotal_bs, d.iva_bs, d.tasa_e8, d.fecha_emision, ${PAGADO} AS pagado FROM documentos d WHERE d.id = ?`).bind(docId).first<Fila>();
  if (!D) return falla(c, 404, "Documento no encontrado.");
  if (D.es_nota_credito) return falla(c, 409, "No se registran cobros sobre una nota de crédito.");
  if (D.tipo !== "FACTURA") {
    return falla(c, 409, "No se pueden registrar pagos sobre un presupuesto: primero conviértelo en factura y emítela (Art. 13 LIVA · SNAT/2011/0071).");
  }
  if (D.estado !== "EMITIDO") return falla(c, 409, "Solo se registran pagos en documentos emitidos y vigentes.");
  const esRetencionIva = metodo === "RETENCION_IVA" || b.es_retencion_iva === true ? 1 : 0;
  const esRetencionIslr = !esRetencionIva && (metodo === "RETENCION_ISLR" || b.es_retencion_islr === true) ? 1 : 0;
  const esRetencion = esRetencionIva || esRetencionIslr ? 1 : 0;
  let comprobanteRetencion: string | null = null;
  let porcentajeRetencion: number | null = null;

  if (esRetencionIva) {
    if ((await leerTipoContribuyente(db)) === "FORMAL") {
      return falla(c, 400, "Un Contribuyente Formal no cobra IVA, por lo que no recibe retenciones de IVA.");
    }
    if (D.tipo !== "FACTURA") return falla(c, 400, "Las retenciones de IVA solo se aplican sobre facturas emitidas.");
    if ((D.iva_bs ?? 0) <= 0) return falla(c, 400, "Esta factura es exenta y no tiene IVA para retener.");
    const brutoComp = String(b.comprobante_retencion ?? b.referencia ?? "").replace(/[\s-]/g, "");
    const mComp = /^(\d{4})(0[1-9]|1[0-2])\d{8}$/.exec(brutoComp);
    if (!mComp || Number(mComp[1]) < 2000 || Number(mComp[1]) > 2100) {
      return falla(c, 400, "Escribe el N.º de Comprobante de Retención SENIAT de 14 dígitos con año y mes válidos (formato AAAAMM00000001).");
    }
    comprobanteRetencion = brutoComp;
    const dupComp = await db.prepare(`SELECT 1 AS x FROM pagos WHERE documento_id = ? AND estado = 'VIGENTE' AND comprobante_retencion = ?`).bind(docId, comprobanteRetencion).first();
    if (dupComp) return falla(c, 409, "Ese N.º de Comprobante de Retención ya está registrado en esta factura.");
  }

  if (esRetencionIslr) {
    if (D.tipo !== "FACTURA") return falla(c, 400, "Las retenciones de ISLR solo se aplican sobre facturas emitidas.");
    if ((D.subtotal_bs ?? 0) <= 0) return falla(c, 400, "Esta factura no tiene base imponible para retener ISLR.");
    const brutoComp = texto(b.comprobante_retencion ?? b.referencia, 30).toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9][A-Z0-9-]{5,29}$/.test(brutoComp)) {
      return falla(c, 400, "Escribe el N.º de Comprobante de Retención de ISLR (mínimo 6 caracteres, ej.: ISLR-202604-001 o 20260400000001).");
    }
    comprobanteRetencion = brutoComp;
    const dupComp = await db.prepare(`SELECT 1 AS x FROM pagos WHERE documento_id = ? AND estado = 'VIGENTE' AND comprobante_retencion = ?`).bind(docId, comprobanteRetencion).first();
    if (dupComp) return falla(c, 409, "Ese N.º de Comprobante de Retención de ISLR ya está registrado en esta factura.");
    const porc = Number(b.porcentaje_retencion ?? 0);
    if (!Number.isInteger(porc) || porc < 1 || porc > 34) {
      return falla(c, 400, "El porcentaje de retención de ISLR debe ser un entero entre 1% y 34% (Decreto 1.808).");
    }
    porcentajeRetencion = porc;
  }

  const saldoAntes = D.total_usd - D.pagado;
  if (saldoAntes <= 0) return falla(c, 409, "Este documento ya está pagado por completo.");

  const monto = aCentavos(b.monto);
  if (!monto || Number.isNaN(monto)) return falla(c, 400, "Escribe el monto recibido (ejemplo: 12,50).");
  if (esRetencionIva) {
    const [retPrev, ncPrev] = await Promise.all([
      db.prepare(`SELECT COALESCE(SUM(monto_recibido), 0) AS s FROM pagos WHERE documento_id = ? AND estado = 'VIGENTE' AND es_retencion_iva = 1`).bind(docId).first<{ s: number }>(),
      db.prepare(`SELECT COALESCE(SUM(iva_bs), 0) AS s FROM documentos WHERE factura_afectada_id = ? AND es_nota_credito = 1 AND estado = 'EMITIDO'`).bind(docId).first<{ s: number }>(),
    ]);
    const ivaNetoBs = Math.max(0, (D.iva_bs ?? 0) - (ncPrev?.s ?? 0));
    const ivaDispBs = Math.max(0, ivaNetoBs - (retPrev?.s ?? 0));
    if (monto > ivaDispBs + 1) {
      return falla(c, 400, `La retención de IVA supera el IVA disponible de la factura (máximo retenible: Bs. ${(ivaDispBs / 100).toLocaleString("es-VE", { minimumFractionDigits: 2 })}).`);
    }
    if ((retPrev?.s ?? 0) > 0) {
      return falla(c, 400, "Esta factura ya tiene una retención de IVA vigente registrada. Si necesitas corregirla, anula primero la retención anterior.");
    }
    const ret75Bs = Math.round((ivaNetoBs * 75) / 100);
    const ret100Bs = ivaNetoBs;
    const es75 = Math.abs(monto - ret75Bs) <= 2;
    const es100 = Math.abs(monto - ret100Bs) <= 2;
    if (!es75 && !es100) {
      return falla(
        c,
        400,
        `Según la Providencia SENIAT SNAT/2025/000054, la retención de IVA debe corresponder al 75% (Bs. ${(ret75Bs / 100).toLocaleString("es-VE", { minimumFractionDigits: 2 })}) o al 100% (Bs. ${(ret100Bs / 100).toLocaleString("es-VE", { minimumFractionDigits: 2 })}) del IVA neto facturado.`
      );
    }
  }
  if (esRetencionIslr) {
    const [retIslrPrev, ncSubPrev] = await Promise.all([
      db.prepare(`SELECT COALESCE(SUM(monto_recibido), 0) AS s FROM pagos WHERE documento_id = ? AND estado = 'VIGENTE' AND COALESCE(es_retencion_islr, 0) = 1`).bind(docId).first<{ s: number }>(),
      db.prepare(`SELECT COALESCE(SUM(subtotal_bs), 0) AS s FROM documentos WHERE factura_afectada_id = ? AND es_nota_credito = 1 AND estado = 'EMITIDO'`).bind(docId).first<{ s: number }>(),
    ]);
    const baseNetaBs = Math.max(0, (D.subtotal_bs ?? 0) - (ncSubPrev?.s ?? 0));
    const maxPorPorcentaje = Math.ceil((baseNetaBs * (porcentajeRetencion ?? 34)) / 100);
    const maxLegalGlobal = Math.ceil((baseNetaBs * 34) / 100);
    const maxIslrDispBs = Math.max(0, Math.min(maxPorPorcentaje, maxLegalGlobal - (retIslrPrev?.s ?? 0)));
    if (monto > maxIslrDispBs + 1) {
      return falla(c, 400, `La retención de ISLR (${porcentajeRetencion}%) supera el límite legal sobre la base imponible neta (máximo retenible: Bs. ${(maxIslrDispBs / 100).toLocaleString("es-VE", { minimumFractionDigits: 2 })}).`);
    }
  }
  const fecha = texto(b.fecha, 10) || hoy;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha > hoy || fecha < D.fecha_emision) return falla(c, 400, "La fecha del pago no es válida (no puede ser futura ni anterior a la emisión).");

  let tasa: number | null = null, montoUsd = monto;
  let usoOverrideTasaPago = false;
  let perfilPagoTasa: { tasa_bcv?: string | null; tasa_bcv_fecha?: string | null } | null = null;
  if (moneda === "BS") {
    if (D.modo === "REAL" && !esRetencion && fecha === hoy) {
      perfilPagoTasa = await db.prepare(`SELECT tasa_bcv, tasa_bcv_fecha FROM perfil_emisor WHERE id = 1`).first<{ tasa_bcv?: string | null; tasa_bcv_fecha?: string | null }>();
      const rawDb = c.get("rawDb") || db;
      const valTasa = await validarTasaFiscalVigente(rawDb, perfilPagoTasa, D.modo, u, c.env as unknown as Record<string, unknown>, b);
      if (!valTasa.ok) {
        return c.json({ ok: false, error: valTasa.error, codigo: valTasa.codigo, puede_forzar: valTasa.puede_forzar, semaforo: valTasa.semaforo }, 409);
      }
      usoOverrideTasaPago = valTasa.override;
    }
    tasa = aTasaE8(b.tasa) || (perfilPagoTasa?.tasa_bcv ? aTasaE8(perfilPagoTasa.tasa_bcv) : null) || (esRetencion && D.tasa_e8 ? Number(D.tasa_e8) : null);
    if (!tasa || Number.isNaN(tasa)) return falla(c, 400, "Escribe la tasa BCV del día del pago (ejemplo: 123,45).");
    try { montoUsd = bsAUsd(monto, tasa); } catch (e) { return falla(c, 400, (e as Error).message); }
    if (montoUsd < 1) return falla(c, 400, "El monto es demasiado pequeño para esa tasa.");
    if (Math.abs(saldoAntes - montoUsd) <= 1) montoUsd = saldoAntes; // diferencia de redondeo de un centavo: se cierra el saldo
  }
  if (montoUsd > saldoAntes) return falla(c, 400, `El pago (${dolares(montoUsd)}) es mayor que el saldo (${dolares(saldoAntes)}).`);

  const params = await parametrosVigentes(db, hoy), claveRecibo = `RECIBO:${D.modo}`;
  const reglas = JSON.stringify({
    leyenda_recibo: params.leyenda_recibo,
    plantilla_version: Number(params.plantilla_version ?? 1),
    ...(esRetencionIva ? { es_retencion_iva: true } : {}),
    ...(esRetencionIslr ? { es_retencion_islr: true, porcentaje_retencion: porcentajeRetencion } : {}),
  });
  const metodoDb = esRetencion ? "OTRO" : metodo;
  const refFinal = comprobanteRetencion || texto(b.referencia, 60) || null;
  // Solo se registra si el saldo sigue siendo el que vimos (dos cobros a la vez no pueden pasarse del total).
  const guarda = `(SELECT d.total_usd - ${PAGADO} FROM documentos d WHERE d.id = ?) = ?`;
  const r = await db.batch([
    db.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${guarda}`).bind(claveRecibo, docId, saldoAntes),
    db.prepare(
      `INSERT INTO pagos (documento_id, modo, numero, metodo, es_retencion_iva, es_retencion_islr, porcentaje_retencion, comprobante_retencion, moneda, monto_recibido, tasa_e8, monto_usd, saldo_despues_usd, referencia, nota, fecha_pago, registrado_en, registrado_por, reglas_json)
       SELECT ?, ?, (SELECT valor FROM contadores WHERE clave = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guarda} RETURNING id, numero`
    ).bind(
      docId, D.modo, claveRecibo, metodoDb, esRetencionIva, esRetencionIslr, porcentajeRetencion, comprobanteRetencion,
      moneda, monto, tasa, montoUsd, saldoAntes - montoUsd, refFinal, texto(b.nota, 200) || null,
      fecha, new Date().toISOString(), u.id, reglas, docId, saldoAntes
    ),
  ]);
  const nuevo = (r[1].results as Fila[])[0];
  if (!nuevo) return falla(c, 409, "El saldo cambió mientras registrabas el pago. Revisa y vuelve a intentarlo.");
  if (usoOverrideTasaPago) {
    await auditar(c, u.id, "TASA_VIEJA_OVERRIDE", `PAGO BS ${D.modo} recibo ${nuevo.numero} -> doc ${docId} · tasa=${perfilPagoTasa?.tasa_bcv ?? ""} fecha=${perfilPagoTasa?.tasa_bcv_fecha ?? ""}`);
  }
  const accionAudit = esRetencionIva ? "RETENCION_IVA_REGISTRAR" : esRetencionIslr ? "RETENCION_ISLR_REGISTRAR" : "PAGO_REGISTRAR";
  await auditar(c, u.id, accionAudit, `${metodo} ${moneda} ${monto} -> doc ${docId} recibo ${nuevo.numero}`);
  return c.json({ ok: true, id: nuevo.id, numero: nuevo.numero, saldo_usd: saldoAntes - montoUsd });
});

pagos.get("/:id", async (c) => {
  const p = await c.env.DB.prepare(`SELECT * FROM pagos WHERE id = ?`).bind(idParam(c)).first<Fila>();
  if (!p) return falla(c, 404, "Pago no encontrado.");
  if (p.es_retencion_iva) p.metodo = "RETENCION_IVA";
  else if (p.es_retencion_islr) p.metodo = "RETENCION_ISLR";
  const d = await c.env.DB.prepare(
    `SELECT d.id, d.tipo, COALESCE(d.es_nota_debito, 0) AS es_nota_debito, d.numero, d.control_interno, d.control_fiscal, d.presupuesto_id,
            (SELECT p0.numero FROM documentos p0 WHERE p0.id = d.presupuesto_id) AS presupuesto_numero,
            d.aplica_igtf, d.igtf_usd, d.igtf_bs, d.estado, d.modo, d.cliente_id, d.cliente_nombre, d.cliente_rif, d.cliente_whatsapp, d.cliente_email, d.emisor_json, d.total_usd, d.fecha_emision
     FROM documentos d WHERE d.id = ?`).bind(p.documento_id).first<Fila>();
  const perfilActual = await c.env.DB.prepare(`SELECT nombre_razon_social, rif, direccion_fiscal, telefono, email, logo_base64 FROM perfil_emisor WHERE id = 1`).first<Fila>();
  if (d && perfilActual) {
    let emisorPrevio: Fila = {};
    try { emisorPrevio = JSON.parse(d.emisor_json || "{}"); } catch {}
    const congelado = d.modo === "REAL" && d.estado !== "BORRADOR";
    let logoResuelto = emisorPrevio?.logo_base64 || null;
    if (!logoResuelto && emisorPrevio?.logo_hash) {
      const filaLogo = await c.env.DB
        .prepare(`SELECT logo_base64 FROM emisor_logos WHERE hash = ?`)
        .bind(String(emisorPrevio.logo_hash))
        .first<{ logo_base64: string }>()
        .catch(() => null);
      logoResuelto = filaLogo?.logo_base64 || null;
    }
    if (!logoResuelto) logoResuelto = perfilActual.logo_base64 ?? null;
    d.emisor_json = JSON.stringify({
      ...emisorPrevio,
      nombre_razon_social: congelado ? (emisorPrevio.nombre_razon_social || perfilActual.nombre_razon_social) : (perfilActual.nombre_razon_social || emisorPrevio.nombre_razon_social),
      rif: aRifSeniat(congelado ? (emisorPrevio.rif || perfilActual.rif || "") : (perfilActual.rif || emisorPrevio.rif || "")),
      direccion_fiscal: congelado ? (emisorPrevio.direccion_fiscal || perfilActual.direccion_fiscal) : (perfilActual.direccion_fiscal || emisorPrevio.direccion_fiscal),
      telefono: emisorPrevio.telefono ?? perfilActual.telefono,
      email: emisorPrevio.email ?? perfilActual.email,
      logo_base64: logoResuelto,
    });
  }
  const evalAnul = evaluarAnulacionPago(p, d, fechaCaracas());
  return c.json({
    ok: true,
    pago: p,
    documento: d,
    puede_anular_fiscal: evalAnul.permitida,
    motivo_bloqueo_anular: evalAnul.motivo,
  });
});

pagos.post("/:id/enviar-correo", async (c) => {
  const id = idParam(c), db = c.env.DB, b = await leerJson(c, 1_500_000), u = c.get("usuario");
  if (b.__demasiadoGrande) return falla(c, 413, "El adjunto PDF excede el tamaño máximo permitido (1,5 MB).");
  const p = await db.prepare(`SELECT * FROM pagos WHERE id = ?`).bind(id).first<Fila>();
  if (!p) return falla(c, 404, "Recibo de pago no encontrado.");
  const d = await db.prepare(
    `SELECT d.id, d.tipo, COALESCE(d.es_nota_debito, 0) AS es_nota_debito, d.numero, d.modo, d.cliente_id, d.cliente_nombre, d.cliente_rif, d.cliente_email
     FROM documentos d WHERE d.id = ?`
  ).bind(p.documento_id).first<Fila>();
  if (!d) return falla(c, 404, "Documento asociado no encontrado.");

  const destino = texto(b.email || d.cliente_email, 120).toLowerCase();
  if (!EMAIL.test(destino)) return falla(c, 400, "Escribe un correo electrónico válido del cliente.");

  if (d.cliente_id && destino !== d.cliente_email) {
    await db.prepare(`UPDATE clientes SET email = ? WHERE id = ? AND (email IS NULL OR email = '')`).bind(destino, d.cliente_id).run().catch(() => {});
    if (d.modo === "PRACTICA") {
      await db.prepare(`UPDATE documentos SET cliente_email = ? WHERE id = ?`).bind(destino, d.id).run().catch(() => {});
    }
  }

  const perfil = await db.prepare(`SELECT nombre_razon_social, rif, telefono, email FROM perfil_emisor WHERE id = 1`).first<Fila>();
  const nombreNegocio = perfil?.nombre_razon_social || "FacturaYa Venezuela";
  const rifNegocio = aRifSeniat(perfil?.rif || "");
  const nroRecibo = String(p.numero ?? 1).padStart(8, "0");
  const docEtiqueta = d.es_nota_debito
    ? `Nota de Débito ND-${String(d.numero).padStart(8, "0")}`
    : d.tipo === "FACTURA"
      ? `Factura ${String(d.numero).padStart(8, "0")}`
      : `Presupuesto P-${String(d.numero).padStart(6, "0")}`;
  const metodoNombre = p.es_retencion_iva
    ? "Comprobante de Retención IVA"
    : p.es_retencion_islr
      ? "Comprobante de Retención ISLR (Decreto 1.808)"
      : String(p.metodo || "Pago");
  const fmtBs = (cent: number) => `Bs. ${(Number(cent || 0) / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtUsd = (cent: number) => `$ ${(Number(cent || 0) / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const escHtml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
  const montoRecibidoTxt = p.moneda === "BS" ? `${fmtBs(p.monto_recibido)} (${fmtUsd(p.monto_usd)})` : fmtUsd(p.monto_usd);

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:580px;margin:0 auto;padding:24px;border:1px solid #dde3ec;border-radius:16px;color:#1f2933">
    <div style="border-bottom:2px solid #1A73E8;padding-bottom:12px;margin-bottom:16px">
      <h2 style="margin:0;color:#1A73E8">${escHtml(nombreNegocio)}</h2>
      <p style="margin:4px 0 0;font-size:13px;color:#5f6b7a">RIF: ${escHtml(rifNegocio)}${perfil?.telefono ? ` · Tel: ${escHtml(perfil.telefono)}` : ""}</p>
    </div>
    <h3 style="margin:0 0 8px">🧾 Recibo de Pago N.º ${escHtml(nroRecibo)}</h3>
    <p style="margin:0 0 16px;font-size:14px;color:#4b5563">
      <b>Cliente:</b> ${escHtml(d.cliente_nombre)} (${escHtml(d.cliente_rif)})<br>
      <b>Fecha de pago:</b> ${escHtml(p.fecha_pago)} · <b>Aplicado a:</b> ${escHtml(docEtiqueta)}
    </p>
    <div style="background:#f8fafd;padding:14px;border-radius:12px;font-size:14px">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>Método:</span><b>${escHtml(metodoNombre)}${p.referencia ? ` · Ref: ${escHtml(p.referencia)}` : ""}</b></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>Monto abonado:</span><b>${montoRecibidoTxt}</b></div>
      <div style="display:flex;justify-content:space-between;padding-top:6px;border-top:1px solid #dde3ec"><span>Saldo restante del documento:</span><b>${fmtUsd(p.saldo_despues_usd)}</b></div>
    </div>
  </div>`;

  const textoPlano = `${nombreNegocio} (RIF ${rifNegocio})\nRecibo de Pago N.º ${nroRecibo}\nCliente: ${d.cliente_nombre} (${d.cliente_rif})\nDocumento: ${docEtiqueta}\nMétodo: ${metodoNombre}\nMonto abonado: ${montoRecibidoTxt}\nSaldo restante: ${fmtUsd(p.saldo_despues_usd)}`;
  const pdfBase64 = typeof b.pdf_base64 === "string" && b.pdf_base64.length > 10 && b.pdf_base64.length < 4_000_000 ? b.pdf_base64 : null;
  const nombrePdf = texto(b.nombre_archivo, 80) || `Recibo-${nroRecibo}.pdf`;

  const res = await enviarCorreo(db, c.env as unknown as Record<string, unknown>, {
    para: destino,
    alcance: "INQUILINO",
    tipo: "RECIBO",
    responderA: perfil?.email ? String(perfil.email).trim() : undefined,
    asunto: `Recibo de Pago ${nroRecibo} · ${nombreNegocio}`,
    html,
    texto: textoPlano,
    adjuntos: pdfBase64 ? [{ filename: nombrePdf, content: pdfBase64 }] : undefined,
  });
  if (!res.ok) return falla(c, 400, res.error);
  await auditar(c, u.id, "PAGO_CORREO", `Recibo ${nroRecibo} -> ${res.demo_redirigido_a || destino}`);
  return c.json({
    ok: true,
    email: res.demo_redirigido_a || destino,
    ...(res.demo_redirigido_a ? { demo_redirigido_a: res.demo_redirigido_a, demo_restantes: res.demo_restantes } : {}),
  });
});

pagos.post("/:id/anular", async (c) => {
  const id = idParam(c), motivo = texto((await leerJson(c)).motivo, 200), u = c.get("usuario"), db = c.env.DB;
  if (motivo.length < 5) return falla(c, 400, "Escribe el motivo de la anulación (mínimo 5 letras).");
  const p = await db
    .prepare(`SELECT id, documento_id, estado, fecha_pago, es_retencion_iva, COALESCE(es_retencion_islr, 0) AS es_retencion_islr FROM pagos WHERE id = ?`)
    .bind(id)
    .first<Fila>();
  if (!p) return falla(c, 404, "Pago no encontrado.");
  const d = await db.prepare(`SELECT tipo, estado, modo FROM documentos WHERE id = ?`).bind(p.documento_id).first<Fila>();
  const evalAnul = evaluarAnulacionPago(p, d, fechaCaracas());
  if (!evalAnul.permitida) return falla(c, 409, evalAnul.motivo || "No se puede anular este pago.");
  const r = await db.prepare(
    `UPDATE pagos SET estado = 'ANULADO', anulado_en = ?, anulado_por = ?, motivo_anulacion = ? WHERE id = ? AND estado = 'VIGENTE'`
  ).bind(new Date().toISOString(), u.id, motivo, id).run();
  if (!r.meta.changes) return falla(c, 409, "Ese pago no existe o ya estaba anulado.");
  await auditar(c, u.id, "PAGO_ANULAR", `${id}: ${motivo}`);
  return c.json({ ok: true });
});

export default pagos;
