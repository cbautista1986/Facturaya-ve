// Módulo DOCUMENTOS (presupuestos, facturas y notas de crédito): /api/documentos
// Ciclo de vida: BORRADOR (editable, sin número) -> EMITIDO (número asignado, ya no se modifica) -> ANULADO.
// Un presupuesto emitido pasa a FACTURADO cuando se emite la factura creada desde él.
// Una factura emitida puede recibir Devoluciones mediante Nota de Crédito (es_nota_credito = 1) conforme a la Providencia SENIAT SNAT/2011/0071.
import { Hono } from "hono";
import { aCantidadMilli, aRifSeniat, aTasaE8, calcular, cantidadTexto, redondear } from "../../public/dinero.js";
import { enviarCorreo } from "../correo";
import { costoPromedio, guardaSaldo, movimiento, saldos, valorSalida } from "../stock";
import { veCostos } from "../permisos";
import { sha256 } from "../seguridad";
import { anularFacturaImprentaDigital, solicitarControlImprentaDigital } from "./sistema";
import { EMAIL, PAGADO, aCentavos, auditar, comodin, falla, fechaCaracas, idParam, leerJson, masDias, modoActual, parametrosVigentes, requiereSesion, texto, type Ctx, type Env } from "../comun";
import { leerTipoContribuyente, normalizarTipoContribuyente, reglasRegimen } from "../regimen";
import { evaluarAnulacionDocumento, puedeInvocarImprentaDigital, validarIgtfNotaCredito } from "../reglas-fiscales";

const documentos = new Hono<Env>();
documentos.use("*", requiereSesion);

async function prepararEmisorDeduplicado(db: D1Database, perfil: Record<string, any>) {
  const logoRaw = typeof perfil?.logo_base64 === "string" && perfil.logo_base64.trim() ? perfil.logo_base64.trim() : null;
  const logoHash = logoRaw ? await sha256(logoRaw) : null;
  const stmtLogo = logoHash && logoRaw
    ? db.prepare(`INSERT OR IGNORE INTO emisor_logos (hash, logo_base64) VALUES (?, ?)`).bind(logoHash, logoRaw)
    : null;
  return {
    stmtLogo,
    emisor: {
      nombre_razon_social: perfil?.nombre_razon_social,
      rif: aRifSeniat(perfil?.rif || ""),
      direccion_fiscal: perfil?.direccion_fiscal,
      telefono: perfil?.telefono,
      email: perfil?.email,
      tipo_contribuyente: normalizarTipoContribuyente(perfil?.tipo_contribuyente, perfil?.igtf_activo),
      logo_hash: logoHash,
      logo_base64: null as string | null,
    },
  };
}

async function resolverLogoEmisor(db: D1Database, emisorPrevio: Record<string, any>, perfilActual: Record<string, any> | null) {
  if (emisorPrevio?.logo_base64) return String(emisorPrevio.logo_base64);
  if (emisorPrevio?.logo_hash) {
    const fila = await db
      .prepare(`SELECT logo_base64 FROM emisor_logos WHERE hash = ?`)
      .bind(String(emisorPrevio.logo_hash))
      .first<{ logo_base64: string }>()
      .catch(() => null);
    if (fila?.logo_base64) return fila.logo_base64;
  }
  return perfilActual?.logo_base64 ?? null;
}

type Linea = { catalogo_id: number | null; tipo: "SERVICIO" | "PRODUCTO"; descripcion: string; cantidad_milli: number; precio_usd: number; costo_usd: number | null; alicuota_cent: number };
type Fila = Record<string, any>;

const COLUMNAS = `id, tipo, es_nota_credito, COALESCE(es_nota_debito, 0) AS es_nota_debito, factura_afectada_id, motivo_nc, estado, modo, numero, control_interno, control_fiscal, medio,
  presupuesto_id, cliente_id, cliente_rif, cliente_nombre, cliente_direccion, cliente_whatsapp, cliente_email, nota, fecha_emision, emitido_en,
  tasa_e8, tasa_cargada_en, subtotal_usd, iva_usd, aplica_igtf, igtf_alicuota_cent, igtf_usd, total_usd,
  subtotal_bs, iva_bs, igtf_bs, total_bs, costo_total_usd, parametros_json, emisor_json, anulado_en, motivo_anulacion, creado_en, condicion, dias_credito, vence_el`;

async function cargar(c: Ctx, id: number) {
  const db = c.env.DB;
  const doc = await db.prepare(`SELECT ${COLUMNAS} FROM documentos WHERE id = ?`).bind(id).first<Fila>();
  if (!doc) return null;
  const [l, i] = await db.batch([
    db.prepare(`SELECT id, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd, monto_bs
                FROM documento_renglones WHERE documento_id = ? ORDER BY orden`).bind(id),
    db.prepare(`SELECT alicuota_cent, base_usd, iva_usd, base_bs, iva_bs FROM documento_impuestos WHERE documento_id = ? ORDER BY alicuota_cent`).bind(id),
  ]);
  return { doc, lineas: l.results as Fila[], impuestos: i.results as Fila[] };
}

async function normalizarLineas(c: Ctx, bruto: unknown, permitidas: number[], max: number): Promise<Linea[] | string> {
  if (!Array.isArray(bruto) || bruto.length === 0) return "Agrega al menos un renglón.";
  if (bruto.length > max) return `Máximo ${max} renglones por documento: divide la venta en dos documentos.`;
  type Item = { id: number; nombre: string; tipo: "SERVICIO" | "PRODUCTO"; costo_centavos: number | null; alicuota_iva: number; activo: number };
  const ids = [...new Set(bruto.map((r) => Number(((r ?? {}) as Record<string, unknown>).catalogo_id) || 0).filter(Boolean))];
  const items = new Map<number, Item>();
  if (ids.length) {
    const { results } = await c.env.DB.prepare(`SELECT id, nombre, tipo, costo_centavos, alicuota_iva, activo FROM catalogo WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all<Item>();
    for (const it of results) items.set(it.id, it);
  }
  const salida: Linea[] = [];
  for (const [n, r] of bruto.entries()) {
    const b = (r ?? {}) as Record<string, unknown>, pos = `Renglón ${n + 1}`;
    const cant = aCantidadMilli(b.cantidad), precio = aCentavos(b.precio_usd);
    if (cant === null || Number.isNaN(cant)) return `${pos}: la cantidad no es válida (ejemplos: 1 o 1,5).`;
    if (precio === null || Number.isNaN(precio)) return `${pos}: escribe el precio en USD (ejemplo: 12,50).`;
    const catId = Number(b.catalogo_id) || 0;
    let tipo: "SERVICIO" | "PRODUCTO" = "SERVICIO", costo: number | null = null, alic: number, desc = texto(b.descripcion, 200);
    if (catId) {
      const it = items.get(catId);
      if (!it) return `${pos}: ese producto o servicio ya no existe.`;
      if (!it.activo) return `${pos}: «${it.nombre}» está desactivado en el inventario.`;
      tipo = it.tipo; costo = it.costo_centavos; alic = it.alicuota_iva * 100; desc = desc || it.nombre;
    } else {
      const alVuelo = texto(b.tipo, 10) === "PRODUCTO";
      if (desc.length < 2) return `${pos}: escribe la descripción del ${alVuelo ? "producto" : "servicio"}.`;
      alic = Math.round(Number(b.alicuota_iva) * 100);
      if (alVuelo) {
        const c0 = aCentavos(b.costo_usd);
        if (Number.isNaN(c0)) return `${pos}: el costo no es válido (ejemplo: 8,50).`;
        tipo = "PRODUCTO"; costo = c0;
      }
    }
    if (!permitidas.includes(alic)) return `${pos}: el IVA no es válido.`;
    salida.push({ catalogo_id: catId || null, tipo, descripcion: desc, cantidad_milli: cant, precio_usd: precio, costo_usd: costo, alicuota_cent: alic });
  }
  return salida;
}

async function validarBorrador(c: Ctx, b: Record<string, unknown>, tipo: string) {
  const db = c.env.DB;
  const params = await parametrosVigentes(db, fechaCaracas());
  const tipoContrib = await leerTipoContribuyente(db);
  const reglasTipo = reglasRegimen(tipoContrib);
  const permitidas = (params.iva_alicuotas_cent ?? "0,800,1600").split(",").map(Number);
  const alicuotaIgtf = Number(params.igtf_alicuota_cent ?? 300) || 300;
  const clienteId = Number(b.cliente_id) || null;
  if (clienteId && !(await db.prepare(`SELECT 1 AS x FROM clientes WHERE id = ?`).bind(clienteId).first())) return "El cliente elegido ya no existe.";
  const lineas = await normalizarLineas(c, b.lineas, permitidas, Number(params.max_renglones ?? 30));
  if (typeof lineas === "string") return lineas;
  if (!reglasTipo.cobraIva && lineas.some((l) => l.alicuota_cent !== 0)) {
    return "Como Contribuyente Formal (Art. 8 Ley del IVA), todos los renglones deben ser Exentos de IVA (0%).";
  }
  let condicion = "CONTADO", dias: number | null = null;
  if (tipo === "FACTURA" && texto(b.condicion, 10) === "CREDITO") {
    dias = Number(b.dias_credito);
    if (!Number.isInteger(dias) || dias < 1 || dias > 365) return "Escribe los días de crédito (un número entre 1 y 365).";
    condicion = "CREDITO";
  }
  const aplicaIgtf = tipo === "FACTURA" && (b.aplica_igtf === true || b.aplica_igtf === 1 || b.aplica_igtf === "1" || b.aplica_igtf === "on") ? 1 : 0;
  if (aplicaIgtf && !reglasTipo.cobraIgtf) {
    return `Solo los Contribuyentes Especiales (SPE) designados por el SENIAT pueden cobrar IGTF (3%). Tu negocio es Contribuyente ${reglasTipo.etiquetaCorta}.`;
  }
  try {
    return {
      clienteId, nota: texto(b.nota, 500) || null, lineas,
      calculo: calcular(lineas, null, { aplica_igtf: aplicaIgtf === 1, igtf_alicuota_cent: alicuotaIgtf }),
      condicion, dias, aplicaIgtf,
    };
  } catch (e) { return (e as Error).message; }
}

const insertarLineas = (c: Ctx, id: number, lineas: Linea[], montos: { monto_usd: number }[]) =>
  lineas.map((l, i) => c.env.DB.prepare(
    `INSERT INTO documento_renglones (documento_id, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, i + 1, l.catalogo_id, l.tipo, l.descripcion, l.cantidad_milli, l.precio_usd, l.costo_usd, l.alicuota_cent, montos[i].monto_usd));

// ---------------------------------------------------------------- consultas (con paginación y filtro por mes/fechas v4.0)
documentos.get("/", async (c) => {
  const q = texto(c.req.query("q"), 60), like = `%${comodin(q)}%`, tipo = texto(c.req.query("tipo"), 16);
  const estado = texto(c.req.query("estado"), 16).toUpperCase();
  const mes = texto(c.req.query("mes"), 7);
  const desde = texto(c.req.query("desde"), 10);
  const hasta = texto(c.req.query("hasta"), 10);
  const pagina = Math.max(0, Math.floor(Number(c.req.query("pagina") || 0) || 0));
  const limite = Math.max(1, Math.min(200, Math.floor(Number(c.req.query("limite") || 100) || 100)));
  const offset = pagina * limite;

  const filtroTipo = tipo === "NOTA_CREDITO"
    ? `d.tipo = 'FACTURA' AND d.es_nota_credito = 1`
    : tipo === "NOTA_DEBITO"
      ? `d.tipo = 'FACTURA' AND COALESCE(d.es_nota_debito, 0) = 1`
      : tipo === "FACTURA"
        ? `d.tipo = 'FACTURA' AND d.es_nota_credito = 0 AND COALESCE(d.es_nota_debito, 0) = 0`
        : tipo === "PRESUPUESTO"
          ? `d.tipo = 'PRESUPUESTO'`
          : `1 = 1`;

  const conds: string[] = [
    `(${filtroTipo})`,
    `(? = '' OR COALESCE(d.cliente_nombre, c.nombre_apellido) LIKE ? ESCAPE '\\' OR COALESCE(d.cliente_rif, c.rif_cedula) LIKE ? ESCAPE '\\' OR CAST(d.numero AS TEXT) LIKE ? ESCAPE '\\')`,
  ];
  const binds: (string | number)[] = [q, like, like, like];

  if (["BORRADOR", "EMITIDO", "ANULADO", "FACTURADO"].includes(estado)) {
    conds.push(`d.estado = ?`);
    binds.push(estado);
  }
  if (/^\d{4}-\d{2}$/.test(mes)) {
    conds.push(`substr(COALESCE(d.fecha_emision, d.creado_en), 1, 7) = ?`);
    binds.push(mes);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
    conds.push(`substr(COALESCE(d.fecha_emision, d.creado_en), 1, 10) >= ?`);
    binds.push(desde);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    conds.push(`substr(COALESCE(d.fecha_emision, d.creado_en), 1, 10) <= ?`);
    binds.push(hasta);
  }

  binds.push(limite + 1, offset);
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.tipo, d.es_nota_credito, COALESCE(d.es_nota_debito, 0) AS es_nota_debito, d.factura_afectada_id, d.motivo_nc, d.estado, d.modo, d.numero, d.control_interno,
            COALESCE(d.cliente_nombre, c.nombre_apellido) AS cliente,
            d.fecha_emision, d.aplica_igtf, d.igtf_usd, d.igtf_bs, d.total_usd, d.total_bs, d.creado_en, d.vence_el, d.condicion,
            (SELECT fa.numero FROM documentos fa WHERE fa.id = d.factura_afectada_id) AS factura_afectada_numero,
            ${PAGADO} AS pagado_usd
     FROM documentos d LEFT JOIN clientes c ON c.id = d.cliente_id
     WHERE ${conds.join(" AND ")}
     ORDER BY COALESCE(d.emitido_en, d.creado_en) DESC, d.id DESC LIMIT ? OFFSET ?`
  ).bind(...binds).all();

  const hayMas = results.length > limite;
  const filas = hayMas ? results.slice(0, limite) : results;
  return c.json({ ok: true, documentos: filas, pagina, limite, hay_mas: hayMas });
});

// Ganancia del mes (facturas emitidas menos notas de crédito emitidas del mes en el modo actual).
documentos.get("/resumen", async (c) => {
  const modo = await modoActual(c.env.DB);
  const { results } = await c.env.DB.prepare(
    `SELECT r.tipo,
            SUM(CASE WHEN d.es_nota_credito = 1 THEN -r.monto_usd ELSE r.monto_usd END) AS ingresos,
            SUM(CASE WHEN d.es_nota_credito = 1 THEN -((r.cantidad_milli * COALESCE(r.costo_usd, 0) + 500) / 1000) ELSE ((r.cantidad_milli * COALESCE(r.costo_usd, 0) + 500) / 1000) END) AS costos
     FROM documento_renglones r JOIN documentos d ON d.id = r.documento_id
     WHERE d.tipo = 'FACTURA' AND d.estado = 'EMITIDO' AND d.modo = ? AND substr(d.fecha_emision, 1, 7) = ? GROUP BY r.tipo`
  ).bind(modo, fechaCaracas().slice(0, 7)).all<{ tipo: string; ingresos: number; costos: number }>();
  const g = (t: string) => { const f = results.find((x) => x.tipo === t); return f ? f.ingresos - f.costos : 0; };
  return c.json({ ok: true, servicios: g("SERVICIO"), productos: g("PRODUCTO"), total: g("SERVICIO") + g("PRODUCTO") });
});

documentos.get("/:id", async (c) => {
  const id = idParam(c), db = c.env.DB, r = await cargar(c, id);
  if (!r) return falla(c, 404, "Documento no encontrado.");
  const { results: resultsRaw } = await db.prepare(
    `SELECT id, documento_id, numero, CASE WHEN es_retencion_iva = 1 THEN 'RETENCION_IVA' WHEN COALESCE(es_retencion_islr, 0) = 1 THEN 'RETENCION_ISLR' ELSE metodo END AS metodo, es_retencion_iva, COALESCE(es_retencion_islr, 0) AS es_retencion_islr, porcentaje_retencion, comprobante_retencion, moneda, monto_recibido, tasa_e8, monto_usd, saldo_despues_usd, referencia, fecha_pago, estado, motivo_anulacion
     FROM pagos WHERE documento_id IN (?, ?) ORDER BY id`).bind(id, r.doc.presupuesto_id ?? 0).all<Fila>();
  const results = resultsRaw;
  const esFacturaBase = r.doc.tipo === "FACTURA" && !r.doc.es_nota_credito && !r.doc.es_nota_debito;
  const { results: notasCredito } = esFacturaBase
    ? await db.prepare(`SELECT id, numero, control_interno, control_fiscal, fecha_emision, estado, motivo_nc, total_usd, total_bs
                        FROM documentos WHERE factura_afectada_id = ? AND es_nota_credito = 1 ORDER BY id`).bind(id).all<Fila>()
    : { results: [] as Fila[] };
  const { results: notasDebito } = esFacturaBase
    ? await db.prepare(`SELECT id, numero, control_interno, control_fiscal, fecha_emision, estado, motivo_nc, total_usd, total_bs
                        FROM documentos WHERE factura_afectada_id = ? AND COALESCE(es_nota_debito, 0) = 1 ORDER BY id`).bind(id).all<Fila>()
    : { results: [] as Fila[] };
  const facturaAfectada = r.doc.factura_afectada_id
    ? await db.prepare(`SELECT id, numero, control_interno, control_fiscal, fecha_emision, total_usd, total_bs, tasa_e8
                        FROM documentos WHERE id = ?`).bind(r.doc.factura_afectada_id).first<Fila>()
    : null;
  // Cantidades ya devueltas por renglón (orden) en notas de crédito vigentes
  const { results: rengsDev } = esFacturaBase
    ? await db.prepare(`SELECT dr.orden, COALESCE(SUM(dr.cantidad_milli), 0) AS devuelto_milli
                        FROM documento_renglones dr JOIN documentos nc ON nc.id = dr.documento_id
                        WHERE nc.factura_afectada_id = ? AND nc.es_nota_credito = 1 AND nc.estado = 'EMITIDO'
                        GROUP BY dr.orden`).bind(id).all<{ orden: number; devuelto_milli: number }>()
    : { results: [] as { orden: number; devuelto_milli: number }[] };
  const mapaDev = new Map(rengsDev.map((x) => [x.orden, x.devuelto_milli]));
  const lineasConDev = r.lineas.map((l) => ({ ...l, devuelto_milli: mapaDev.get(l.orden) ?? 0 }));
  const perfilActual = await db.prepare(`SELECT nombre_razon_social, rif, direccion_fiscal, telefono, email, logo_base64, tipo_contribuyente FROM perfil_emisor WHERE id = 1`).first<Fila>();
  if (perfilActual) {
    let emisorPrevio: Fila = {};
    try { emisorPrevio = JSON.parse(r.doc.emisor_json || "{}"); } catch {}
    const congelado = r.doc.modo === "REAL" && r.doc.estado !== "BORRADOR";
    const logoResuelto = await resolverLogoEmisor(db, emisorPrevio, perfilActual);
    r.doc.emisor_json = JSON.stringify({
      ...emisorPrevio,
      nombre_razon_social: congelado ? (emisorPrevio.nombre_razon_social || perfilActual.nombre_razon_social) : (perfilActual.nombre_razon_social || emisorPrevio.nombre_razon_social),
      rif: aRifSeniat(congelado ? (emisorPrevio.rif || perfilActual.rif || "") : (perfilActual.rif || emisorPrevio.rif || "")),
      direccion_fiscal: congelado ? (emisorPrevio.direccion_fiscal || perfilActual.direccion_fiscal) : (perfilActual.direccion_fiscal || emisorPrevio.direccion_fiscal),
      telefono: emisorPrevio.telefono ?? perfilActual.telefono,
      email: emisorPrevio.email ?? perfilActual.email,
      logo_base64: logoResuelto,
    });
  }
  const pagadoEfectivo = results.filter((p) => p.estado === "VIGENTE").reduce((s, p) => s + p.monto_usd, 0);
  const acreditadoNc = notasCredito.filter((n) => n.estado === "EMITIDO").reduce((s, n) => s + (n.total_usd ?? 0), 0);
  const pagadoTotal = pagadoEfectivo + acreditadoNc;
  const hoyCcs = fechaCaracas();
  const evalAnul = evaluarAnulacionDocumento(r.doc, {
    pagosVigentes: results.filter((p) => p.estado === "VIGENTE").length,
    notasVigentes: notasCredito.filter((n) => n.estado === "EMITIDO").length + notasDebito.filter((n) => n.estado === "EMITIDO").length,
    mesActualCaracas: hoyCcs.slice(0, 7),
    fechaActualCaracas: hoyCcs,
    tipoContribuyente: perfilActual?.tipo_contribuyente ?? null,
  });
  const imprentaEnvio = await db
    .prepare(
      `SELECT proveedor, proveedor_tipo, ambiente, numero_documento, numero_serie, control_fiscal, pdf_url, estado, intentos, ultimo_error, enviado_en, retornado_en, anulado_en,
              fecha_asignacion, hora_asignacion, imprenta_razon_social, imprenta_autorizacion
       FROM imprenta_envios WHERE documento_id = ?`
    )
    .bind(id)
    .first<Fila>()
    .catch(() => null);
  return c.json({
    ok: true, documento: r.doc, lineas: lineasConDev, impuestos: r.impuestos,
    pagos: results, notas_credito: notasCredito, notas_debito: notasDebito, factura_afectada: facturaAfectada,
    imprenta_envio: imprentaEnvio,
    pagado_usd: pagadoTotal, acreditado_nc_usd: acreditadoNc,
    saldo_usd: r.doc.estado === "BORRADOR" || r.doc.es_nota_credito ? null : Math.max((r.doc.total_usd ?? 0) - pagadoTotal, 0),
    anulacion: {
      permitida: evalAnul.permitida,
      codigo: evalAnul.codigo,
      motivo: evalAnul.motivo,
      sugerir_nota_credito: evalAnul.sugerirNotaCredito,
    },
  });
});

// ---------------------------------------------------------------- borradores
documentos.post("/", async (c) => {
  const b = await leerJson(c), tipo = texto(b.tipo, 12);
  if (tipo !== "FACTURA" && tipo !== "PRESUPUESTO") return falla(c, 400, "El tipo de documento no es válido.");
  const v = await validarBorrador(c, b, tipo);
  if (typeof v === "string") return falla(c, 400, v);
  const t = v.calculo, u = c.get("usuario");
  const fila = await c.env.DB.prepare(
    `INSERT INTO documentos (tipo, estado, modo, cliente_id, nota, subtotal_usd, iva_usd, aplica_igtf, igtf_alicuota_cent, igtf_usd, total_usd, costo_total_usd, creado_por, condicion, dias_credito)
     VALUES (?, 'BORRADOR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(tipo, await modoActual(c.env.DB), v.clienteId, v.nota, t.subtotal_usd, t.iva_usd, v.aplicaIgtf, t.igtf_alicuota_cent, t.igtf_usd, t.total_usd, t.costo_total_usd, u.id, v.condicion, v.dias).first<{ id: number }>();
  await c.env.DB.batch(insertarLineas(c, fila!.id, v.lineas, t.renglones));
  await auditar(c, u.id, "DOC_CREAR", `${tipo} ${fila!.id}`);
  return c.json({ ok: true, id: fila!.id });
});

documentos.put("/:id", async (c) => {
  const id = idParam(c), db = c.env.DB;
  const d = await db.prepare(`SELECT estado, tipo, es_nota_credito, COALESCE(es_nota_debito, 0) AS es_nota_debito FROM documentos WHERE id = ?`).bind(id).first<{ estado: string; tipo: string; es_nota_credito: number; es_nota_debito: number }>();
  if (!d) return falla(c, 404, "Documento no encontrado.");
  if (d.estado !== "BORRADOR") return falla(c, 409, "Solo se puede editar un borrador: un documento emitido no se modifica.");
  if (d.es_nota_credito || d.es_nota_debito) return falla(c, 409, "Una nota de crédito o débito no se edita como borrador.");
  const cuerpo = await leerJson(c);
  if (!veCostos(c.get("usuario").rol, c.get("usuario").email, c.env as unknown as Record<string, unknown>) && Array.isArray(cuerpo.lineas)) {
    const { results } = await db.prepare(`SELECT descripcion, costo_usd FROM documento_renglones WHERE documento_id = ? AND catalogo_id IS NULL AND tipo = 'PRODUCTO' AND costo_usd IS NOT NULL ORDER BY orden`).bind(id).all<{ descripcion: string; costo_usd: number }>();
    for (const l of cuerpo.lineas as Record<string, unknown>[]) {
      if (l && !l.catalogo_id && l.tipo === "PRODUCTO" && !String(l.costo_usd ?? "").trim()) {
        const k = results.findIndex((r) => r.descripcion === texto(l.descripcion, 200));
        if (k >= 0) l.costo_usd = (results.splice(k, 1)[0].costo_usd / 100).toFixed(2).replace(".", ",");
      }
    }
  }
  const v = await validarBorrador(c, cuerpo, d.tipo);
  if (typeof v === "string") return falla(c, 400, v);
  const t = v.calculo;
  await db.batch([
    db.prepare(`DELETE FROM documento_renglones WHERE documento_id = ?`).bind(id),
    ...insertarLineas(c, id, v.lineas, t.renglones),
    db.prepare(`UPDATE documentos SET cliente_id = ?, nota = ?, subtotal_usd = ?, iva_usd = ?, aplica_igtf = ?, igtf_alicuota_cent = ?, igtf_usd = ?, total_usd = ?, costo_total_usd = ?, condicion = ?, dias_credito = ?
                WHERE id = ? AND estado = 'BORRADOR'`).bind(v.clienteId, v.nota, t.subtotal_usd, t.iva_usd, v.aplicaIgtf, t.igtf_alicuota_cent, t.igtf_usd, t.total_usd, t.costo_total_usd, v.condicion, v.dias, id),
  ]);
  await auditar(c, c.get("usuario").id, "DOC_EDITAR", String(id));
  return c.json({ ok: true });
});

documentos.delete("/:id", async (c) => {
  const id = idParam(c), db = c.env.DB;
  const d = await db.prepare(`SELECT estado FROM documentos WHERE id = ?`).bind(id).first<{ estado: string }>();
  if (!d) return falla(c, 404, "Documento no encontrado.");
  if (d.estado !== "BORRADOR") return falla(c, 409, "Un documento emitido no se borra: se anula.");
  await db.batch([db.prepare(`DELETE FROM documento_renglones WHERE documento_id = ?`).bind(id),
    db.prepare(`DELETE FROM documentos WHERE id = ? AND estado = 'BORRADOR'`).bind(id)]);
  await auditar(c, c.get("usuario").id, "DOC_BORRAR_BORRADOR", String(id));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- emitir
documentos.post("/:id/emitir", async (c) => {
  const id = idParam(c), db = c.env.DB, u = c.get("usuario");
  const cargado = await cargar(c, id);
  if (!cargado) return falla(c, 404, "Documento no encontrado.");
  const { doc, lineas } = cargado;
  if (doc.estado !== "BORRADOR") return falla(c, 409, "Este documento ya fue emitido.");
  if (!doc.cliente_id) return falla(c, 400, "Elige el cliente antes de emitir.");
  if (!lineas.length) return falla(c, 400, "Agrega al menos un renglón.");
  if (lineas.some((l) => l.precio_usd <= 0)) return falla(c, 400, "Todos los renglones deben tener un precio mayor que 0.");

  const perfil = await db.prepare(`SELECT nombre_razon_social, rif, direccion_fiscal, telefono, email, tasa_bcv, tasa_bcv_fecha, medio_facturacion, tipo_contribuyente, igtf_activo, logo_base64 FROM perfil_emisor WHERE id = 1`).first<Fila>();
  if (doc.tipo === "FACTURA" && doc.modo === "REAL" && (!perfil?.medio_facturacion || perfil.medio_facturacion === "SIN_DEFINIR")) {
    return falla(c, 400, "Antes de emitir facturas fiscales reales, elige tu modalidad digital (Sistema Digital SENIAT o Imprenta Digital) en Ajustes.");
  }
  const reglasTipo = reglasRegimen(perfil?.tipo_contribuyente, perfil?.igtf_activo);
  if (!reglasTipo.cobraIva && lineas.some((l) => Number(l.alicuota_cent) !== 0)) {
    return falla(c, 400, "Este borrador tiene renglones con IVA, pero el negocio es Contribuyente Formal (Art. 8 Ley del IVA). Edita el borrador para dejarlos Exentos (0%).");
  }
  if (doc.aplica_igtf && !reglasTipo.cobraIgtf) {
    return falla(c, 400, `Este borrador incluye IGTF (3%), pero el negocio es Contribuyente ${reglasTipo.etiquetaCorta}. Solo los Contribuyentes Especiales (SPE) pueden cobrar IGTF.`);
  }
  const tasa = aTasaE8(String(perfil?.tasa_bcv ?? ""));
  if (!tasa || Number.isNaN(tasa)) return falla(c, 400, "Define la tasa BCV de hoy en Ajustes antes de emitir.");
  const cli = await db.prepare(`SELECT rif_cedula, nombre_apellido, direccion, whatsapp, email FROM clientes WHERE id = ?`).bind(doc.cliente_id).first<Fila>();
  if (!cli) return falla(c, 400, "El cliente ya no existe.");

  const fecha = fechaCaracas(), params = await parametrosVigentes(db, fecha);
  const alicuotaIgtf = Number(params.igtf_alicuota_cent ?? 300) || 300;
  let calc;
  try { calc = calcular(lineas as Linea[], tasa, { aplica_igtf: !!doc.aplica_igtf, igtf_alicuota_cent: alicuotaIgtf }); }
  catch (e) { return falla(c, 400, (e as Error).message); }

  const esFactura = doc.tipo === "FACTURA", vence = esFactura ? (doc.condicion === "CREDITO" ? masDias(fecha, Number(doc.dias_credito)) : fecha) : null;
  const claveNum = `${doc.es_nota_credito ? "NOTA_CREDITO" : doc.tipo}:${doc.modo}`, claveCtl = `CONTROL:${doc.modo}`;
  const sigueBorrador = `EXISTS (SELECT 1 FROM documentos WHERE id = ? AND estado = 'BORRADOR')`;
  const { emisor, stmtLogo } = await prepararEmisorDeduplicado(db, perfil!);
  const reglas = {
    iva_alicuotas_cent: params.iva_alicuotas_cent, igtf_alicuota_cent: params.igtf_alicuota_cent ?? "300",
    titulo_sin_control: params.titulo_sin_control, leyenda_sin_control: params.leyenda_sin_control,
    leyenda_cambio: params.leyenda_cambio, validez_presupuesto_dias: Number(params.validez_presupuesto_dias ?? 15), plantilla_version: Number(params.plantilla_version ?? 1),
  };

  // Existencias: los productos con control descuentan lo vendido; si no alcanza, no se emite.
  const idsProd = [...new Set(lineas.filter((l: Fila) => l.catalogo_id).map((l: Fila) => l.catalogo_id as number))];
  const salidas = new Map<number, { nombre: string; cant: number }>();
  if (doc.tipo === "FACTURA" && !doc.es_nota_credito && idsProd.length) {
    const { results: ctrl } = await db.prepare(`SELECT id, nombre FROM catalogo WHERE tipo = 'PRODUCTO' AND controla_stock = 1 AND id IN (${idsProd.map(() => "?").join(",")})`).bind(...idsProd).all<Fila>();
    for (const p of ctrl) salidas.set(p.id, { nombre: p.nombre, cant: lineas.filter((l: Fila) => l.catalogo_id === p.id).reduce((t: number, l: Fila) => t + l.cantidad_milli, 0) });
  }
  const sal = await saldos(db, [...salidas.keys()]);
  for (const [pid, sd] of salidas) {
    const hay = sal.get(pid)!.stock;
    if (hay < sd.cant) return falla(c, 409, `No hay existencias suficientes de «${sd.nombre}»: hay ${cantidadTexto(Math.max(hay, 0))} y quieres vender ${cantidadTexto(sd.cant)}.`);
  }

  const pasos: D1PreparedStatement[] = [];
  if (stmtLogo) pasos.push(stmtLogo);
  pasos.push(db.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${sigueBorrador}`).bind(claveNum, id));
  if (esFactura) pasos.push(db.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${sigueBorrador}`).bind(claveCtl, id));
  calc.renglones.forEach((r: Fila, i: number) => pasos.push(
    db.prepare(`UPDATE documento_renglones SET monto_usd = ?, monto_bs = ? WHERE id = ?`).bind(r.monto_usd, r.monto_bs, lineas[i].id)));
  calc.impuestos.forEach((x: Fila) => pasos.push(
    db.prepare(`INSERT INTO documento_impuestos (documento_id, alicuota_cent, base_usd, iva_usd, base_bs, iva_bs) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, x.alicuota_cent, x.base_usd, x.iva_usd, x.base_bs, x.iva_bs)));
  for (const [pid, sd] of salidas) {
    const saldo = sal.get(pid)!;
    pasos.push(guardaSaldo(db, pid, saldo), movimiento(db, { producto_id: pid, modo: doc.modo, tipo: "VENTA", cantidad_milli: -sd.cant, valor_usd: -valorSalida(saldo, sd.cant), documento_id: id, fecha, uid: u.id }));
  }
  const posEmision = pasos.length;
  pasos.push(db.prepare(
    `UPDATE documentos SET estado = 'EMITIDO', numero = (SELECT valor FROM contadores WHERE clave = ?),
       control_interno = ${esFactura ? "(SELECT valor FROM contadores WHERE clave = ?)" : "NULL"},
       cliente_rif = ?, cliente_nombre = ?, cliente_direccion = ?, cliente_whatsapp = ?, cliente_email = ?,
       fecha_emision = ?, emitido_en = ?, tasa_e8 = ?, tasa_cargada_en = ?,
       subtotal_usd = ?, iva_usd = ?, igtf_alicuota_cent = ?, igtf_usd = ?, total_usd = ?,
       subtotal_bs = ?, iva_bs = ?, igtf_bs = ?, total_bs = ?, costo_total_usd = ?,
       parametros_json = ?, emisor_json = ?, vence_el = ?, medio = ?
     WHERE id = ? AND estado = 'BORRADOR'`
  ).bind(...[claveNum, ...(esFactura ? [claveCtl] : []), cli.rif_cedula, cli.nombre_apellido, cli.direccion, cli.whatsapp, cli.email,
    fecha, new Date().toISOString(), tasa, perfil!.tasa_bcv_fecha,
    calc.subtotal_usd, calc.iva_usd, calc.igtf_alicuota_cent, calc.igtf_usd, calc.total_usd,
    calc.subtotal_bs, calc.iva_bs, calc.igtf_bs ?? 0, calc.total_bs, calc.costo_total_usd,
    JSON.stringify(reglas), JSON.stringify(emisor), vence, esFactura && perfil!.medio_facturacion !== "SIN_DEFINIR" ? perfil!.medio_facturacion : null, id]));
  if (esFactura && doc.presupuesto_id)
    pasos.push(db.prepare(`UPDATE documentos SET estado = 'FACTURADO' WHERE id = ? AND estado = 'EMITIDO'`).bind(doc.presupuesto_id));

  try {
    const r = await db.batch(pasos);
    if (!r?.[posEmision]?.meta?.changes) return falla(c, 409, "Este documento ya fue emitido.");
  } catch (e) {
    if (/Documento emitido|UNIQUE|PRIMARY KEY/.test(String(e))) return falla(c, 409, "Este documento ya fue emitido.");
    if (/CHECK constraint failed/.test(String(e))) return falla(c, 409, "Las existencias cambiaron mientras emitías. Revisa y vuelve a intentarlo.");
    console.error("[emitir] db.batch:", e);
    throw e;
  }
  const f = await db.prepare(`SELECT numero, control_interno FROM documentos WHERE id = ?`).bind(id).first<Fila>();
  let controlFiscalAsignado: string | null = null;
  let imprentaPdfUrl: string | null = null;
  let imprentaAviso: string | null = null;
  if (esFactura && puedeInvocarImprentaDigital(perfil?.medio_facturacion, doc.modo) && f?.numero) {
    try {
      const resImp = await solicitarControlImprentaDigital(db, c.env as unknown as Record<string, unknown>, {
        documento_id: id,
        tipo_documento: "FACTURA",
        modo: String(doc.modo),
        numero: Number(f.numero),
        control_interno: Number(f.control_interno ?? f.numero),
        fecha_emision: fecha,
        cliente_rif: cli.rif_cedula,
        cliente_nombre: cli.nombre_apellido,
        cliente_email: cli.email ?? null,
        cliente_direccion: cli.direccion ?? null,
        cliente_telefono: cli.whatsapp ?? null,
        nota: doc.nota ?? null,
        subtotal_bs: calc.subtotal_bs,
        iva_bs: calc.iva_bs,
        igtf_bs: calc.igtf_bs ?? 0,
        total_bs: calc.total_bs,
        subtotal_usd: calc.subtotal_usd,
        iva_usd: calc.iva_usd,
        igtf_usd: calc.igtf_usd ?? 0,
        total_usd: calc.total_usd,
        tasa_e8: tasa,
        condicion: doc.condicion ?? "CONTADO",
        vendedor_nombre: u.nombre ?? null,
      });
      if (resImp.ok && resImp.control_fiscal) {
        controlFiscalAsignado = resImp.control_fiscal;
        imprentaPdfUrl = resImp.pdf_url ?? null;
        await auditar(c, u.id, "FISCAL_IMPRENTA_AUTO", `${id} IMPRENTA_DIGITAL ${controlFiscalAsignado}`).catch((e) => console.error("[auditar]", e));
      } else if (resImp.error) {
        imprentaAviso = resImp.error;
      }
    } catch (e) {
      console.error("[emitir] imprenta:", e);
      imprentaAviso = "La factura se emitió, pero ocurrió un error al comunicarse con la Imprenta Digital. Puedes reintentar desde el detalle.";
    }
  }
  await auditar(c, u.id, "DOC_EMITIR", `${doc.tipo} ${doc.modo} n.º ${f?.numero}`).catch((e) => console.error("[auditar]", e));
  return c.json({
    ok: true,
    numero: f?.numero,
    control_interno: f?.control_interno,
    ...(controlFiscalAsignado ? { control_fiscal: controlFiscalAsignado } : {}),
    ...(imprentaPdfUrl ? { imprenta_pdf_url: imprentaPdfUrl } : {}),
    ...(imprentaAviso ? { imprenta_aviso: imprentaAviso } : {}),
  });
});

// ---------------------------------------------------------------- devolución (Nota de Crédito según ley venezolana SENIAT)
documentos.post("/:id/devolver", async (c) => {
  const id = idParam(c), db = c.env.DB, u = c.get("usuario"), b = await leerJson(c);
  const motivo = texto(b.motivo, 200);
  if (motivo.length < 5) return falla(c, 400, "Escribe el motivo de la devolución / nota de crédito (mínimo 5 letras).");

  const origen = await cargar(c, id);
  if (!origen) return falla(c, 404, "Factura no encontrada.");
  const { doc: F, lineas: rengsOrigen } = origen;
  if (F.tipo !== "FACTURA" || F.es_nota_credito || F.es_nota_debito || F.estado !== "EMITIDO") {
    return falla(c, 409, "Solo se puede emitir una Nota de Crédito sobre una factura emitida y vigente.");
  }

  // Cantidades ya devueltas en otras notas de crédito vigentes de esta factura
  const { results: previas } = await db.prepare(
    `SELECT dr.orden, COALESCE(SUM(dr.cantidad_milli), 0) AS devuelto_milli
     FROM documento_renglones dr JOIN documentos nc ON nc.id = dr.documento_id
     WHERE nc.factura_afectada_id = ? AND nc.es_nota_credito = 1 AND nc.estado = 'EMITIDO'
     GROUP BY dr.orden`
  ).bind(id).all<{ orden: number; devuelto_milli: number }>();
  const yaDevuelto = new Map(previas.map((x) => [x.orden, x.devuelto_milli]));

  const pedidas = Array.isArray(b.lineas) ? (b.lineas as Record<string, unknown>[]) : [];
  const lineasNc: (Linea & { orden_origen: number })[] = [];
  for (const item of pedidas) {
    const orden = Number(item?.orden) || 0;
    const orig = rengsOrigen.find((r) => r.orden === orden);
    if (!orig) continue;
    const cant = aCantidadMilli(item?.cantidad);
    if (cant === null || cant === 0) continue;
    if (Number.isNaN(cant) || cant < 0) return falla(c, 400, `Renglón «${orig.descripcion}»: la cantidad a devolver no es válida.`);
    const disponible = orig.cantidad_milli - (yaDevuelto.get(orden) ?? 0);
    if (cant > disponible) {
      return falla(c, 409, `En «${orig.descripcion}» solo quedan ${cantidadTexto(Math.max(disponible, 0))} disponibles por devolver.`);
    }
    lineasNc.push({
      orden_origen: orig.orden,
      catalogo_id: orig.catalogo_id,
      tipo: orig.tipo,
      descripcion: orig.descripcion,
      cantidad_milli: cant,
      precio_usd: orig.precio_usd,
      costo_usd: orig.costo_usd,
      alicuota_cent: orig.alicuota_cent,
    });
  }
  if (!lineasNc.length) return falla(c, 400, "Indica al menos un renglón con cantidad a devolver mayor que 0.");

  const perfil = await db.prepare(`SELECT nombre_razon_social, rif, direccion_fiscal, telefono, email, tasa_bcv, tasa_bcv_fecha, medio_facturacion, tipo_contribuyente, igtf_activo, logo_base64 FROM perfil_emisor WHERE id = 1`).first<Fila>();
  const tasa = aTasaE8(String(perfil?.tasa_bcv ?? "")) || F.tasa_e8;
  if (!tasa || Number.isNaN(tasa)) return falla(c, 400, "Define la tasa BCV en Ajustes antes de emitir la Nota de Crédito.");

  const fecha = fechaCaracas(), params = await parametrosVigentes(db, fecha);
  const aplicaIgtf = b.aplica_igtf === undefined ? !!F.aplica_igtf : (b.aplica_igtf === true || b.aplica_igtf === 1 || b.aplica_igtf === "1" || b.aplica_igtf === "on");
  const validacionIgtf = validarIgtfNotaCredito(aplicaIgtf, Boolean(F.aplica_igtf));
  if (!validacionIgtf.ok) {
    return falla(c, 400, validacionIgtf.error);
  }
  const alicuotaIgtf = Number(params.igtf_alicuota_cent ?? F.igtf_alicuota_cent ?? 300) || 300;
  const calc = calcular(lineasNc, tasa, { aplica_igtf: aplicaIgtf, igtf_alicuota_cent: alicuotaIgtf });

  const { emisor, stmtLogo } = await prepararEmisorDeduplicado(db, perfil!);
  const reglas = {
    iva_alicuotas_cent: params.iva_alicuotas_cent, igtf_alicuota_cent: String(alicuotaIgtf),
    titulo_sin_control: "NOTA DE CRÉDITO", leyenda_sin_control: params.leyenda_sin_control,
    leyenda_cambio: params.leyenda_cambio, plantilla_version: Number(params.plantilla_version ?? 1),
    factura_afectada_numero: F.numero, factura_afectada_fecha: F.fecha_emision, factura_afectada_control: F.control_fiscal || F.control_interno,
    factura_afectada_total_usd: F.total_usd, factura_afectada_total_bs: F.total_bs,
  };

  // Crear borrador temporal de la Nota de Crédito y emitirlo en lote junto con la devolución de existencias
  const borrador = await db.prepare(
    `INSERT INTO documentos (tipo, es_nota_credito, factura_afectada_id, motivo_nc, estado, modo, cliente_id, nota,
       subtotal_usd, iva_usd, aplica_igtf, igtf_alicuota_cent, igtf_usd, total_usd, costo_total_usd, creado_por, condicion)
     VALUES ('FACTURA', 1, ?, ?, 'BORRADOR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONTADO') RETURNING id`
  ).bind(id, motivo, F.modo, F.cliente_id, `Nota de crédito sobre Factura ${String(F.numero).padStart(8, "0")}: ${motivo}`,
    calc.subtotal_usd, calc.iva_usd, aplicaIgtf ? 1 : 0, calc.igtf_alicuota_cent, calc.igtf_usd, calc.total_usd, calc.costo_total_usd, u.id).first<{ id: number }>();
  const ncId = borrador!.id;

  const idsProd = [...new Set(lineasNc.filter((l) => l.catalogo_id && l.tipo === "PRODUCTO").map((l) => l.catalogo_id as number))];
  const entradas = new Map<number, { cant: number; valor: number }>();
  if (idsProd.length) {
    const { results: ctrl } = await db.prepare(`SELECT id, costo_centavos FROM catalogo WHERE tipo = 'PRODUCTO' AND controla_stock = 1 AND id IN (${idsProd.map(() => "?").join(",")})`).bind(...idsProd).all<Fila>();
    for (const p of ctrl) {
      const rengsProd = lineasNc.filter((l) => l.catalogo_id === p.id);
      const cant = rengsProd.reduce((s, l) => s + l.cantidad_milli, 0);
      const valor = rengsProd.reduce((s, l) => s + redondear(l.cantidad_milli, l.costo_usd ?? p.costo_centavos ?? 0, 1000), 0);
      if (cant > 0) entradas.set(p.id, { cant, valor });
    }
  }
  const sal = await saldos(db, [...entradas.keys()]);
  const claveNum = `NOTA_CREDITO:${F.modo}`, claveCtl = `CONTROL:${F.modo}`;
  const sigueBorrador = `EXISTS (SELECT 1 FROM documentos WHERE id = ? AND estado = 'BORRADOR')`;

  const pasos: D1PreparedStatement[] = [];
  if (stmtLogo) pasos.push(stmtLogo);
  for (const l of lineasNc) {
    const origCant = rengsOrigen.find((r) => r.orden === l.orden_origen)!.cantidad_milli;
    pasos.push(
      db.prepare(
        `INSERT INTO verificaciones (ok) SELECT 0 WHERE
           NOT EXISTS (SELECT 1 FROM documentos WHERE id = ? AND tipo = 'FACTURA' AND es_nota_credito = 0 AND COALESCE(es_nota_debito, 0) = 0 AND estado = 'EMITIDO')
           OR (SELECT COALESCE(SUM(dr.cantidad_milli), 0)
               FROM documento_renglones dr JOIN documentos nc ON nc.id = dr.documento_id
               WHERE nc.factura_afectada_id = ? AND nc.es_nota_credito = 1 AND nc.estado = 'EMITIDO' AND dr.orden = ?) + ? > ?`
      ).bind(id, id, l.orden_origen, l.cantidad_milli, origCant)
    );
  }
  pasos.push(
    db.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${sigueBorrador}`).bind(claveNum, ncId),
    db.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${sigueBorrador}`).bind(claveCtl, ncId),
  );
  lineasNc.forEach((l, i) => pasos.push(
    db.prepare(
      `INSERT INTO documento_renglones (documento_id, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd, monto_bs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(ncId, l.orden_origen, l.catalogo_id, l.tipo, l.descripcion, l.cantidad_milli, l.precio_usd, l.costo_usd, l.alicuota_cent, calc.renglones[i].monto_usd, calc.renglones[i].monto_bs)
  ));
  calc.impuestos.forEach((x: Fila) => pasos.push(
    db.prepare(`INSERT INTO documento_impuestos (documento_id, alicuota_cent, base_usd, iva_usd, base_bs, iva_bs) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(ncId, x.alicuota_cent, x.base_usd, x.iva_usd, x.base_bs, x.iva_bs)
  ));
  for (const [pid, ent] of entradas) {
    const saldo = sal.get(pid)!;
    pasos.push(
      guardaSaldo(db, pid, saldo),
      movimiento(db, {
        producto_id: pid, modo: F.modo, tipo: "DEVOLUCION_VENTA",
        cantidad_milli: ent.cant, valor_usd: ent.valor, documento_id: ncId,
        nota: `Nota de crédito (Factura ${String(F.numero).padStart(8, "0")})`, fecha, uid: u.id,
      }),
      costoPromedio(db, pid)
    );
  }
  const posEmision = pasos.length;
  pasos.push(db.prepare(
    `UPDATE documentos SET estado = 'EMITIDO',
       numero = (SELECT valor FROM contadores WHERE clave = ?),
       control_interno = (SELECT valor FROM contadores WHERE clave = ?),
       cliente_rif = ?, cliente_nombre = ?, cliente_direccion = ?, cliente_whatsapp = ?, cliente_email = ?,
       fecha_emision = ?, emitido_en = ?, tasa_e8 = ?, tasa_cargada_en = ?,
       subtotal_usd = ?, iva_usd = ?, igtf_alicuota_cent = ?, igtf_usd = ?, total_usd = ?,
       subtotal_bs = ?, iva_bs = ?, igtf_bs = ?, total_bs = ?, costo_total_usd = ?,
       parametros_json = ?, emisor_json = ?, vence_el = ?, medio = ?
     WHERE id = ? AND estado = 'BORRADOR'`
  ).bind(
    claveNum, claveCtl, F.cliente_rif, F.cliente_nombre, F.cliente_direccion, F.cliente_whatsapp, F.cliente_email,
    fecha, new Date().toISOString(), tasa, perfil!.tasa_bcv_fecha,
    calc.subtotal_usd, calc.iva_usd, calc.igtf_alicuota_cent, calc.igtf_usd, calc.total_usd,
    calc.subtotal_bs, calc.iva_bs, calc.igtf_bs ?? 0, calc.total_bs, calc.costo_total_usd,
    JSON.stringify(reglas), JSON.stringify(emisor), fecha,
    perfil!.medio_facturacion !== "SIN_DEFINIR" ? perfil!.medio_facturacion : F.medio, ncId
  ));

  const limpiarBorradorNc = () =>
    db.batch([
      db.prepare(`DELETE FROM documento_impuestos WHERE documento_id = ?`).bind(ncId),
      db.prepare(`DELETE FROM documento_renglones WHERE documento_id = ?`).bind(ncId),
      db.prepare(`DELETE FROM documentos WHERE id = ? AND estado = 'BORRADOR'`).bind(ncId),
    ]).catch(() => {});

  try {
    const r = await db.batch(pasos);
    if (!r[posEmision]?.meta.changes) {
      await limpiarBorradorNc();
      return falla(c, 409, "No se pudo emitir la Nota de Crédito porque el estado cambió. Vuelve a intentarlo.");
    }
  } catch (e) {
    await limpiarBorradorNc();
    if (/CHECK constraint failed/.test(String(e))) {
      return falla(c, 409, "Las cantidades disponibles para devolución o el inventario cambiaron mientras emitías. Revisa y vuelve a intentarlo.");
    }
    throw e;
  }
  const emitida = await db.prepare(`SELECT numero, control_interno FROM documentos WHERE id = ?`).bind(ncId).first<{ numero: number; control_interno: number }>();
  let controlFiscalNc: string | null = null;
  let imprentaPdfNc: string | null = null;
  if (puedeInvocarImprentaDigital(perfil?.medio_facturacion, F.modo) && emitida?.numero) {
    const devueltoPrevTotal = [...previas].reduce((s, p) => s + Number(p.devuelto_milli ?? 0), 0);
    const totalOrigMilli = rengsOrigen.reduce((s, l) => s + Number(l.cantidad_milli ?? 0), 0);
    const totalNcMilli = lineasNc.reduce((s, l) => s + Number(l.cantidad_milli ?? 0), 0);
    const esNcTotal = devueltoPrevTotal === 0 && totalNcMilli === totalOrigMilli && lineasNc.length === rengsOrigen.length;
    try {
      const resImp = await solicitarControlImprentaDigital(db, c.env as unknown as Record<string, unknown>, {
        documento_id: ncId,
        tipo_documento: "NOTA_CREDITO",
        modo: String(F.modo),
        numero: Number(emitida.numero),
        control_interno: Number(emitida.control_interno ?? emitida.numero),
        fecha_emision: fecha,
        cliente_rif: F.cliente_rif,
        cliente_nombre: F.cliente_nombre,
        cliente_email: F.cliente_email ?? null,
        cliente_direccion: F.cliente_direccion ?? null,
        cliente_telefono: F.cliente_whatsapp ?? null,
        motivo_nc: motivo,
        es_nc_total: esNcTotal,
        subtotal_bs: calc.subtotal_bs,
        iva_bs: calc.iva_bs,
        igtf_bs: calc.igtf_bs ?? 0,
        total_bs: calc.total_bs,
        subtotal_usd: calc.subtotal_usd,
        iva_usd: calc.iva_usd,
        igtf_usd: calc.igtf_usd ?? 0,
        total_usd: calc.total_usd,
        tasa_e8: tasa,
        factura_afectada_numero: F.numero,
        factura_afectada_fecha: F.fecha_emision ?? null,
        factura_afectada_monto_bs: Number(F.total_bs ?? 0),
        condicion: "CONTADO",
        vendedor_nombre: u.nombre ?? null,
      });
      if (resImp.ok && resImp.control_fiscal) {
        controlFiscalNc = resImp.control_fiscal;
        imprentaPdfNc = resImp.pdf_url ?? null;
      }
    } catch (e) {
      console.error("[devolver] imprenta:", e);
    }
  }
  await auditar(c, u.id, "NOTA_CREDITO_EMITIR", `NC ${emitida?.numero} -> Factura ${F.numero}: ${motivo}`).catch((e) => console.error("[auditar]", e));
  return c.json({
    ok: true,
    id: ncId,
    numero: emitida?.numero,
    ...(controlFiscalNc ? { control_fiscal: controlFiscalNc } : {}),
    ...(imprentaPdfNc ? { imprenta_pdf_url: imprentaPdfNc } : {}),
  });
});

// ---------------------------------------------------------------- Nota de Débito (Recargo / Ajuste positivo Art. 72 RLIVA y SNAT/2011/0071)
documentos.post("/:id/nota-debito", async (c) => {
  const id = idParam(c), db = c.env.DB, u = c.get("usuario"), b = await leerJson(c);
  const motivo = texto(b.motivo, 200);
  if (motivo.length < 5) return falla(c, 400, "Escribe el motivo de la Nota de Débito (mínimo 5 letras, ej.: Intereses de mora o ajuste de precio).");

  const origen = await cargar(c, id);
  if (!origen) return falla(c, 404, "Factura no encontrada.");
  const { doc: F } = origen;
  if (F.tipo !== "FACTURA" || F.es_nota_credito || F.es_nota_debito || F.estado !== "EMITIDO") {
    return falla(c, 409, "Solo se puede emitir una Nota de Débito sobre una factura emitida y vigente.");
  }

  const perfil = await db.prepare(`SELECT nombre_razon_social, rif, direccion_fiscal, telefono, email, tasa_bcv, tasa_bcv_fecha, medio_facturacion, tipo_contribuyente, igtf_activo, logo_base64 FROM perfil_emisor WHERE id = 1`).first<Fila>();
  const reglasTipo = reglasRegimen(perfil?.tipo_contribuyente, perfil?.igtf_activo);
  const fecha = fechaCaracas(), params = await parametrosVigentes(db, fecha);
  const permitidas = (params.iva_alicuotas_cent ?? "0,800,1600").split(",").map(Number);
  const brutoLineas = Array.isArray(b.lineas) && b.lineas.length > 0
    ? b.lineas
    : [{
        descripcion: texto(b.concepto || motivo, 200),
        cantidad: b.cantidad ?? "1",
        precio_usd: b.monto_usd ?? b.precio_usd,
        alicuota_iva: b.alicuota_iva ?? (reglasTipo.cobraIva ? 16 : 0),
        tipo: "SERVICIO",
      }];

  const lineasNd = await normalizarLineas(c, brutoLineas, permitidas, Number(params.max_renglones ?? 30));
  if (typeof lineasNd === "string") return falla(c, 400, lineasNd);
  if (lineasNd.some((l) => l.precio_usd <= 0)) return falla(c, 400, "El monto de la Nota de Débito debe ser mayor que 0.");
  if (!reglasTipo.cobraIva && lineasNd.some((l) => l.alicuota_cent !== 0)) {
    return falla(c, 400, "Como Contribuyente Formal (Art. 8 Ley del IVA), la Nota de Débito debe ser Exenta de IVA (0%).");
  }

  const tasaActual = aTasaE8(String(perfil?.tasa_bcv ?? ""));
  const tasa = b.usar_tasa_factura === true ? Number(F.tasa_e8) : (tasaActual && !Number.isNaN(tasaActual) ? tasaActual : Number(F.tasa_e8));
  const aplicaIgtf = b.aplica_igtf !== undefined
    ? (b.aplica_igtf === true || b.aplica_igtf === 1 || b.aplica_igtf === "1" || b.aplica_igtf === "on")
    : (reglasTipo.cobraIgtf && Boolean(F.aplica_igtf));
  if (aplicaIgtf && !reglasTipo.cobraIgtf) {
    return falla(c, 400, `Solo los Contribuyentes Especiales (SPE) pueden aplicar IGTF (3%) en Notas de Débito. Tu negocio es Contribuyente ${reglasTipo.etiquetaCorta}.`);
  }
  const alicuotaIgtf = Number(F.igtf_alicuota_cent || params.igtf_alicuota_cent || 300) || 300;

  let calc;
  try {
    calc = calcular(lineasNd, tasa, { aplica_igtf: aplicaIgtf, igtf_alicuota_cent: alicuotaIgtf });
  } catch (e) {
    return falla(c, 400, (e as Error).message);
  }

  const { emisor, stmtLogo } = await prepararEmisorDeduplicado(db, perfil!);
  const reglas = {
    iva_alicuotas_cent: params.iva_alicuotas_cent,
    igtf_alicuota_cent: String(alicuotaIgtf),
    titulo_sin_control: "NOTA DE DÉBITO",
    leyenda_sin_control: params.leyenda_sin_control,
    leyenda_cambio: params.leyenda_cambio,
    validez_presupuesto_dias: Number(params.validez_presupuesto_dias ?? 15),
    plantilla_version: Number(params.plantilla_version ?? 1),
    factura_afectada_numero: F.numero,
    factura_afectada_fecha: F.fecha_emision,
    factura_afectada_control: F.control_fiscal || F.control_interno,
    factura_afectada_total_usd: F.total_usd,
    factura_afectada_total_bs: F.total_bs,
  };

  const notaTexto = `Nota de débito sobre Factura N.º ${String(F.numero).padStart(8, "0")} — Motivo: ${motivo}`;
  const borrador = await db.prepare(
    `INSERT INTO documentos (tipo, es_nota_credito, es_nota_debito, factura_afectada_id, motivo_nc, estado, modo, cliente_id, nota, subtotal_usd, iva_usd, aplica_igtf, igtf_alicuota_cent, igtf_usd, total_usd, costo_total_usd, creado_por, condicion, dias_credito)
     VALUES ('FACTURA', 0, 1, ?, ?, 'BORRADOR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONTADO', NULL) RETURNING id`
  ).bind(
    id, motivo, F.modo, F.cliente_id, notaTexto,
    calc.subtotal_usd, calc.iva_usd, aplicaIgtf ? 1 : 0, calc.igtf_alicuota_cent, calc.igtf_usd, calc.total_usd, calc.costo_total_usd, u.id
  ).first<{ id: number }>();

  const ndId = borrador!.id;
  const claveNum = `NOTA_DEBITO:${F.modo}`, claveCtl = `CONTROL:${F.modo}`;
  const sigueBorrador = `EXISTS (SELECT 1 FROM documentos WHERE id = ? AND estado = 'BORRADOR')`;

  const pasos: D1PreparedStatement[] = [];
  if (stmtLogo) pasos.push(stmtLogo);
  pasos.push(
    db.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${sigueBorrador}`).bind(claveNum, ndId),
    db.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${sigueBorrador}`).bind(claveCtl, ndId),
  );
  lineasNd.forEach((l, i) => pasos.push(
    db.prepare(
      `INSERT INTO documento_renglones (documento_id, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd, monto_bs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(ndId, i + 1, l.catalogo_id, l.tipo, l.descripcion, l.cantidad_milli, l.precio_usd, l.costo_usd, l.alicuota_cent, calc.renglones[i].monto_usd, calc.renglones[i].monto_bs)
  ));
  calc.impuestos.forEach((x: Fila) => pasos.push(
    db.prepare(`INSERT INTO documento_impuestos (documento_id, alicuota_cent, base_usd, iva_usd, base_bs, iva_bs) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(ndId, x.alicuota_cent, x.base_usd, x.iva_usd, x.base_bs, x.iva_bs)
  ));

  const posEmision = pasos.length;
  pasos.push(db.prepare(
    `UPDATE documentos SET estado = 'EMITIDO',
       numero = (SELECT valor FROM contadores WHERE clave = ?),
       control_interno = (SELECT valor FROM contadores WHERE clave = ?),
       cliente_rif = ?, cliente_nombre = ?, cliente_direccion = ?, cliente_whatsapp = ?, cliente_email = ?,
       fecha_emision = ?, emitido_en = ?, tasa_e8 = ?, tasa_cargada_en = ?,
       subtotal_usd = ?, iva_usd = ?, igtf_alicuota_cent = ?, igtf_usd = ?, total_usd = ?,
       subtotal_bs = ?, iva_bs = ?, igtf_bs = ?, total_bs = ?, costo_total_usd = ?,
       parametros_json = ?, emisor_json = ?, vence_el = ?, medio = ?
     WHERE id = ? AND estado = 'BORRADOR'`
  ).bind(
    claveNum, claveCtl, F.cliente_rif, F.cliente_nombre, F.cliente_direccion, F.cliente_whatsapp, F.cliente_email,
    fecha, new Date().toISOString(), tasa, perfil!.tasa_bcv_fecha,
    calc.subtotal_usd, calc.iva_usd, calc.igtf_alicuota_cent, calc.igtf_usd, calc.total_usd,
    calc.subtotal_bs, calc.iva_bs, calc.igtf_bs ?? 0, calc.total_bs, calc.costo_total_usd,
    JSON.stringify(reglas), JSON.stringify(emisor), fecha,
    perfil!.medio_facturacion !== "SIN_DEFINIR" ? perfil!.medio_facturacion : F.medio, ndId
  ));

  const limpiarBorradorNd = () =>
    db.batch([
      db.prepare(`DELETE FROM documento_impuestos WHERE documento_id = ?`).bind(ndId),
      db.prepare(`DELETE FROM documento_renglones WHERE documento_id = ?`).bind(ndId),
      db.prepare(`DELETE FROM documentos WHERE id = ? AND estado = 'BORRADOR'`).bind(ndId),
    ]).catch(() => {});

  try {
    const r = await db.batch(pasos);
    if (!r[posEmision]?.meta.changes) {
      await limpiarBorradorNd();
      return falla(c, 409, "No se pudo emitir la Nota de Débito porque el estado cambió. Vuelve a intentarlo.");
    }
  } catch (e) {
    await limpiarBorradorNd();
    throw e;
  }
  const emitida = await db.prepare(`SELECT numero, control_interno FROM documentos WHERE id = ?`).bind(ndId).first<{ numero: number; control_interno: number }>();
  let controlFiscalNd: string | null = null;
  if (puedeInvocarImprentaDigital(perfil?.medio_facturacion, F.modo) && emitida?.numero) {
    try {
      const resImp = await solicitarControlImprentaDigital(db, c.env as unknown as Record<string, unknown>, {
        documento_id: ndId,
        tipo_documento: "NOTA_DEBITO",
        modo: String(F.modo),
        numero: Number(emitida.numero),
        control_interno: Number(emitida.control_interno ?? emitida.numero),
        fecha_emision: fecha,
        cliente_rif: F.cliente_rif,
        cliente_nombre: F.cliente_nombre,
        subtotal_bs: calc.subtotal_bs,
        iva_bs: calc.iva_bs,
        cliente_email: F.cliente_email ?? null,
        cliente_direccion: F.cliente_direccion ?? null,
        cliente_telefono: F.cliente_whatsapp ?? null,
        motivo_nc: motivo,
        igtf_bs: calc.igtf_bs ?? 0,
        total_bs: calc.total_bs,
        subtotal_usd: calc.subtotal_usd,
        iva_usd: calc.iva_usd,
        igtf_usd: calc.igtf_usd ?? 0,
        total_usd: calc.total_usd,
        tasa_e8: tasa,
        factura_afectada_numero: F.numero,
        factura_afectada_fecha: F.fecha_emision ?? null,
        factura_afectada_monto_bs: Number(F.total_bs ?? 0),
        condicion: "CONTADO",
        vendedor_nombre: u.nombre ?? null,
      });
      if (resImp.ok && resImp.control_fiscal) controlFiscalNd = resImp.control_fiscal;
    } catch (e) {
      console.error("[nota-debito] imprenta:", e);
    }
  }
  await auditar(c, u.id, "NOTA_DEBITO_EMITIR", `ND ${emitida?.numero} -> Factura ${F.numero}: ${motivo}`).catch((e) => console.error("[auditar]", e));
  return c.json({ ok: true, id: ndId, numero: emitida?.numero, control_interno: emitida?.control_interno, total_usd: calc.total_usd, total_bs: calc.total_bs, ...(controlFiscalNd ? { control_fiscal: controlFiscalNd } : {}) });
});

// ---------------------------------------------------------------- anular, convertir, copiar
documentos.post("/:id/anular", async (c) => {
  const id = idParam(c), cuerpo = await leerJson(c), motivo = texto(cuerpo.motivo, 200), u = c.get("usuario"), db = c.env.DB;
  if (motivo.length < 5) return falla(c, 400, "Escribe el motivo de la anulación (mínimo 5 letras).");
  const doc = await db.prepare(`SELECT id, tipo, es_nota_credito, COALESCE(es_nota_debito, 0) AS es_nota_debito, presupuesto_id, modo, estado, numero, fecha_emision, medio, control_fiscal FROM documentos WHERE id = ?`).bind(id).first<Fila>();
  if (!doc) return falla(c, 404, "Documento no encontrado.");

  const conPagos = await db.prepare(`SELECT COUNT(*) AS n FROM pagos WHERE (documento_id = ? OR (? IS NOT NULL AND documento_id = ?)) AND estado = 'VIGENTE'`)
    .bind(id, doc.presupuesto_id ?? null, doc.presupuesto_id ?? null).first<{ n: number }>();
  const conNc = await db.prepare(`SELECT COUNT(*) AS n FROM documentos WHERE factura_afectada_id = ? AND (es_nota_credito = 1 OR COALESCE(es_nota_debito, 0) = 1) AND estado = 'EMITIDO'`).bind(id).first<{ n: number }>();
  const hoyCcs = fechaCaracas();
  const tipoContrib = await leerTipoContribuyente(db);
  const evalAnul = evaluarAnulacionDocumento(doc, {
    pagosVigentes: conPagos?.n ?? 0,
    notasVigentes: conNc?.n ?? 0,
    mesActualCaracas: hoyCcs.slice(0, 7),
    fechaActualCaracas: hoyCcs,
    tipoContribuyente: tipoContrib,
  });
  if (!evalAnul.permitida) {
    return falla(c, 409, evalAnul.motivo || "Este documento no puede anularse directamente.");
  }

  if (doc.es_nota_credito) {
    // Anular una Nota de Crédito revierte el reingreso de stock (verifica primero que aún haya existencias)
    const { results: movs } = await db.prepare(
      `SELECT m.producto_id, m.cantidad_milli, m.valor_usd, c.nombre
       FROM movimientos_stock m JOIN catalogo c ON c.id = m.producto_id
       WHERE m.documento_id = ? AND m.tipo = 'DEVOLUCION_VENTA'`
    ).bind(id).all<Fila>();
    const sal = await saldos(db, movs.map((m) => m.producto_id));
    for (const m of movs) {
      if ((sal.get(m.producto_id)?.stock ?? 0) < m.cantidad_milli) {
        return falla(c, 409, `No hay existencias suficientes de «${m.nombre}» para revertir esta Nota de Crédito.`);
      }
    }
    const pasos: D1PreparedStatement[] = [
      db.prepare(`UPDATE documentos SET estado = 'ANULADO', anulado_en = ?, anulado_por = ?, motivo_anulacion = ? WHERE id = ? AND estado = 'EMITIDO'`).bind(new Date().toISOString(), u.id, motivo, id),
    ];
    for (const m of movs) {
      pasos.push(
        guardaSaldo(db, m.producto_id, sal.get(m.producto_id)!),
        movimiento(db, {
          producto_id: m.producto_id, modo: doc.modo, tipo: "VENTA",
          cantidad_milli: -m.cantidad_milli, valor_usd: -m.valor_usd, documento_id: id,
          nota: "Nota de crédito anulada", fecha: fechaCaracas(), uid: u.id,
        }),
        costoPromedio(db, m.producto_id)
      );
    }
    await db.batch(pasos);
    await auditar(c, u.id, "NC_ANULAR", `${id}: ${motivo}`);
    return c.json({ ok: true });
  }

  const rr = await db.batch([
    db.prepare(`UPDATE documentos SET estado = 'ANULADO', anulado_en = ?, anulado_por = ?, motivo_anulacion = ? WHERE id = ? AND estado = 'EMITIDO'`).bind(new Date().toISOString(), u.id, motivo, id),
    db.prepare(`INSERT INTO movimientos_stock (producto_id, modo, tipo, cantidad_milli, valor_usd, documento_id, nota, fecha, creado_en, creado_por)
      SELECT m.producto_id, m.modo, 'DEVOLUCION_VENTA', -m.cantidad_milli, -m.valor_usd, m.documento_id, 'Factura anulada', ?, ?, ?
      FROM movimientos_stock m WHERE m.documento_id = ? AND m.tipo = 'VENTA'
        AND EXISTS (SELECT 1 FROM documentos WHERE id = ? AND estado = 'ANULADO')
        AND NOT EXISTS (SELECT 1 FROM movimientos_stock r WHERE r.documento_id = m.documento_id AND r.producto_id = m.producto_id AND r.tipo = 'DEVOLUCION_VENTA')`
    ).bind(fechaCaracas(), new Date().toISOString(), u.id, id, id),
    db.prepare(`UPDATE catalogo SET costo_centavos = (SELECT CASE WHEN SUM(m.cantidad_milli) > 0 THEN (SUM(m.valor_usd) * 2000 + SUM(m.cantidad_milli)) / (2 * SUM(m.cantidad_milli))
      ELSE catalogo.costo_centavos END FROM movimientos_stock m WHERE m.producto_id = catalogo.id)
      WHERE id IN (SELECT producto_id FROM movimientos_stock WHERE documento_id = ? AND tipo = 'DEVOLUCION_VENTA')`).bind(id),
  ]);
  if (!rr[0].meta.changes) return falla(c, 409, "Solo se puede anular un documento emitido (no un borrador, ni uno ya anulado o facturado).");
  let imprentaAnulacion: { ok: boolean; error?: string } | null = null;
  if (
    doc.tipo === "FACTURA" &&
    !doc.es_nota_credito &&
    !doc.es_nota_debito &&
    puedeInvocarImprentaDigital(doc.medio, doc.modo) &&
    doc.control_fiscal &&
    doc.numero
  ) {
    try {
      const resAnul = await anularFacturaImprentaDigital(db, c.env as unknown as Record<string, unknown>, {
        documento_id: id,
        tipo_documento: "FACTURA",
        numero_documento: Number(doc.numero),
        control_fiscal: String(doc.control_fiscal),
        motivo,
      });
      if (!resAnul.omitido) {
        imprentaAnulacion = { ok: resAnul.ok, ...(resAnul.error ? { error: resAnul.error } : {}) };
      }
    } catch (e) {
      console.error("[anular] imprenta:", e);
      imprentaAnulacion = { ok: false, error: "Error inesperado al notificar la anulación a la Imprenta Digital." };
    }
  }
  await auditar(c, u.id, "DOC_ANULAR", `${id}: ${motivo}${imprentaAnulacion ? ` [CG:${imprentaAnulacion.ok ? "OK" : "PEND"}]` : ""}`).catch((e) => console.error("[auditar]", e));
  return c.json({ ok: true, ...(imprentaAnulacion ? { imprenta_anulacion: imprentaAnulacion } : {}) });
});

async function clonar(c: Ctx, origenId: number, tipo: "FACTURA" | "PRESUPUESTO", presupuestoId: number | null) {
  const db = c.env.DB;
  const origen = await cargar(c, origenId);
  const reglasTipo = reglasRegimen(await leerTipoContribuyente(db));
  const params = await parametrosVigentes(db, fechaCaracas());
  const alicuotaIgtf = Number(params.igtf_alicuota_cent ?? 300) || 300;
  const origDoc = origen!.doc;
  const aplicaIgtf = tipo === "FACTURA" && reglasTipo.cobraIgtf && Boolean(origDoc.aplica_igtf) ? 1 : 0;
  const lineasSanitizadas: Linea[] = origen!.lineas.map((l) => ({
    catalogo_id: l.catalogo_id ?? null,
    tipo: l.tipo,
    descripcion: l.descripcion,
    cantidad_milli: l.cantidad_milli,
    precio_usd: l.precio_usd,
    costo_usd: l.costo_usd ?? null,
    alicuota_cent: reglasTipo.cobraIva ? Number(l.alicuota_cent ?? 0) : 0,
  }));
  const calc = calcular(lineasSanitizadas, null, { aplica_igtf: aplicaIgtf === 1, igtf_alicuota_cent: alicuotaIgtf });
  const nuevo = await db.prepare(
    `INSERT INTO documentos (tipo, estado, modo, cliente_id, nota, presupuesto_id, subtotal_usd, iva_usd, aplica_igtf, igtf_alicuota_cent, igtf_usd, total_usd, costo_total_usd, creado_por, condicion, dias_credito)
     VALUES (?, 'BORRADOR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(
    tipo,
    await modoActual(db),
    origDoc.cliente_id ?? null,
    origDoc.nota ?? null,
    presupuestoId,
    calc.subtotal_usd,
    calc.iva_usd,
    aplicaIgtf,
    calc.igtf_alicuota_cent,
    calc.igtf_usd,
    calc.total_usd,
    calc.costo_total_usd,
    c.get("usuario").id,
    tipo === "FACTURA" ? (origDoc.condicion ?? "CONTADO") : "CONTADO",
    tipo === "FACTURA" ? (origDoc.dias_credito ?? null) : null
  ).first<{ id: number }>();
  if (lineasSanitizadas.length) {
    await db.batch(insertarLineas(c, nuevo!.id, lineasSanitizadas, calc.renglones));
  }
  return nuevo!.id;
}

documentos.post("/:id/fiscal", async (c) => {
  const id = idParam(c), b = await leerJson(c), db = c.env.DB, u = c.get("usuario");
  const d = await db
    .prepare(
      `SELECT id, tipo, es_nota_credito, COALESCE(es_nota_debito, 0) AS es_nota_debito, modo, estado, medio, control_fiscal,
              numero, control_interno, fecha_emision, cliente_rif, cliente_nombre, cliente_email, cliente_direccion, cliente_whatsapp,
              nota, motivo_nc,
              subtotal_bs, iva_bs, COALESCE(igtf_bs, 0) AS igtf_bs, total_bs,
              subtotal_usd, iva_usd, COALESCE(igtf_usd, 0) AS igtf_usd, total_usd, tasa_e8, factura_afectada_id
       FROM documentos WHERE id = ?`
    )
    .bind(id)
    .first<Fila>();
  if (!d) return falla(c, 404, "Documento no encontrado.");
  if (d.tipo !== "FACTURA" || d.estado !== "EMITIDO") return falla(c, 409, "El número de control se registra en una factura o nota de crédito emitida y vigente.");
  if (!d.medio) return falla(c, 409, "Este documento se emitió antes de definir el medio de facturación.");
  if (d.control_fiscal) return falla(c, 409, "Este documento ya tiene su número de control definitivo asignado; no se puede cambiar.");

  const numeroManual = texto(b.numero, 30).toUpperCase();
  const esImprentaReal = d.medio === "IMPRENTA_DIGITAL" && d.modo === "REAL";

  // Candado legal estricto SNAT/2024/000102: en Imprenta Digital + REAL JAMÁS se admite ingreso o edición manual del N.º de Control.
  // En APP_SENIAT y en modo PRACTICA el ingreso manual sigue funcionando exactamente igual.
  if (esImprentaReal && numeroManual && b.reintentar_imprenta !== true) {
    return falla(
      c,
      403,
      "Por normativa SNAT/2024/000102, en modalidad Imprenta Digital el N.º de Control solo puede ser asignado automáticamente por la API de tu Imprenta Digital (no se admite carga manual). Usa «Reintentar con Imprenta» o «Conciliar»."
    );
  }

  if (d.medio === "IMPRENTA_DIGITAL" && (b.reintentar_imprenta === true || !numeroManual)) {
    if (!puedeInvocarImprentaDigital(d.medio, d.modo)) {
      return falla(c, 409, "La Imprenta Digital en vivo solo se invoca en documentos fiscales reales (modo REAL). En modo práctica registra un número de control de prueba.");
    }
    let facAfectadaNum: number | null = null;
    let facAfectadaFecha: string | null = null;
    let facAfectadaMontoBs: number | null = null;
    let esNcTotalRetry = false;
    if (d.factura_afectada_id) {
      const fa = await db
        .prepare(`SELECT numero, fecha_emision, total_usd, total_bs FROM documentos WHERE id = ?`)
        .bind(d.factura_afectada_id)
        .first<{ numero: number; fecha_emision: string | null; total_usd: number; total_bs: number }>()
        .catch(() => null);
      facAfectadaNum = fa?.numero ?? null;
      facAfectadaFecha = fa?.fecha_emision ?? null;
      facAfectadaMontoBs = fa ? Number(fa.total_bs ?? 0) : null;
      if (d.es_nota_credito && fa && Number(d.total_usd) === Number(fa.total_usd)) esNcTotalRetry = true;
    }
    const resImp = await solicitarControlImprentaDigital(db, c.env as unknown as Record<string, unknown>, {
      documento_id: id,
      tipo_documento: d.es_nota_credito ? "NOTA_CREDITO" : d.es_nota_debito ? "NOTA_DEBITO" : "FACTURA",
      modo: String(d.modo ?? "REAL"),
      numero: Number(d.numero ?? 1),
      control_interno: Number(d.control_interno ?? d.numero ?? 1),
      fecha_emision: String(d.fecha_emision ?? fechaCaracas()),
      cliente_rif: String(d.cliente_rif ?? ""),
      cliente_nombre: String(d.cliente_nombre ?? ""),
      cliente_email: d.cliente_email ?? null,
      cliente_direccion: d.cliente_direccion ?? null,
      cliente_telefono: d.cliente_whatsapp ?? null,
      nota: d.nota ?? null,
      motivo_nc: d.motivo_nc ?? null,
      es_nc_total: esNcTotalRetry,
      subtotal_bs: Number(d.subtotal_bs ?? 0),
      iva_bs: Number(d.iva_bs ?? 0),
      igtf_bs: Number(d.igtf_bs ?? 0),
      total_bs: Number(d.total_bs ?? 0),
      subtotal_usd: Number(d.subtotal_usd ?? 0),
      iva_usd: Number(d.iva_usd ?? 0),
      igtf_usd: Number(d.igtf_usd ?? 0),
      total_usd: Number(d.total_usd ?? 0),
      tasa_e8: Number(d.tasa_e8 ?? 0),
      factura_afectada_numero: facAfectadaNum,
      factura_afectada_fecha: facAfectadaFecha,
      factura_afectada_monto_bs: facAfectadaMontoBs,
      vendedor_nombre: u.nombre ?? null,
    });
    if (!resImp.ok || !resImp.control_fiscal) {
      return falla(c, 502, `No se pudo obtener el número de control de la Imprenta Digital (${resImp.error || "sin respuesta"}). Revisa la conexión o reintenta.`);
    }
    await auditar(c, u.id, "FISCAL_IMPRENTA_REINTENTO", `${id} IMPRENTA_DIGITAL ${resImp.control_fiscal}`);
    return c.json({
      ok: true,
      control_fiscal: resImp.control_fiscal,
      ...(resImp.pdf_url ? { pdf_url: resImp.pdf_url } : {}),
      ...(resImp.fecha_asignacion ? { fecha_asignacion: resImp.fecha_asignacion } : {}),
      ...(resImp.hora_asignacion ? { hora_asignacion: resImp.hora_asignacion } : {}),
      ...(resImp.imprenta_razon_social ? { imprenta_razon_social: resImp.imprenta_razon_social } : {}),
      ...(resImp.imprenta_autorizacion ? { imprenta_autorizacion: resImp.imprenta_autorizacion } : {}),
      idempotency_key: resImp.idempotency_key,
    });
  }

  if (!/^[0-9A-Z][0-9A-Z-]{0,29}$/.test(numeroManual)) return falla(c, 400, "Escribe el número de control (ejemplo: 00-00000001).");
  try {
    const r = await db.prepare(`UPDATE documentos SET control_fiscal = ? WHERE id = ? AND control_fiscal IS NULL AND estado = 'EMITIDO'`).bind(numeroManual, id).run();
    if (!r.meta.changes) return falla(c, 409, "Este documento ya tiene su número de control asignado; no se puede cambiar.");
    await db.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(`imprenta_pendiente_${id}`).run().catch(() => {});
  } catch (e) {
    if (String(e).includes("UNIQUE")) return falla(c, 409, "Ese número de control ya está registrado en otro documento.");
    throw e;
  }
  await auditar(c, u.id, "FISCAL_REGISTRAR", `${id} ${d.medio} ${numeroManual}`);
  return c.json({ ok: true, control_fiscal: numeroManual });
});

documentos.post("/:id/convertir", async (c) => {
  const id = idParam(c);
  const o = await c.env.DB.prepare(`SELECT tipo, estado FROM documentos WHERE id = ?`).bind(id).first<Fila>();
  if (!o) return falla(c, 404, "Documento no encontrado.");
  if (o.tipo !== "PRESUPUESTO" || o.estado !== "EMITIDO") return falla(c, 409, "Solo un presupuesto emitido (y no facturado) se convierte en factura.");
  const previo = await c.env.DB.prepare(`SELECT id FROM documentos WHERE presupuesto_id = ? AND estado = 'BORRADOR'`).bind(id).first<{ id: number }>();
  if (previo) return c.json({ ok: true, id: previo.id });
  const nuevo = await clonar(c, id, "FACTURA", id);
  await auditar(c, c.get("usuario").id, "DOC_CONVERTIR", `${id} -> ${nuevo}`);
  return c.json({ ok: true, id: nuevo });
});

documentos.post("/:id/copiar", async (c) => {
  const id = idParam(c);
  const o = await c.env.DB.prepare(`SELECT tipo, es_nota_credito, COALESCE(es_nota_debito, 0) AS es_nota_debito, estado FROM documentos WHERE id = ?`).bind(id).first<Fila>();
  if (!o) return falla(c, 404, "Documento no encontrado.");
  if (o.es_nota_credito || o.es_nota_debito) return falla(c, 409, "Una nota de crédito o débito no se copia como borrador.");
  if (o.estado === "BORRADOR") return falla(c, 409, "Un borrador ya se puede editar.");
  const nuevo = await clonar(c, id, o.tipo, null);
  await auditar(c, c.get("usuario").id, "DOC_COPIAR", `${id} -> ${nuevo}`);
  return c.json({ ok: true, id: nuevo });
});

// Enviar factura, nota de crédito, nota de débito o presupuesto por correo electrónico al cliente (con detalle HTML y PDF adjunto)
documentos.post("/:id/enviar-correo", async (c) => {
  const id = idParam(c), db = c.env.DB, b = await leerJson(c), u = c.get("usuario");
  const cargado = await cargar(c, id);
  if (!cargado) return falla(c, 404, "Documento no encontrado.");
  const { doc, lineas } = cargado;
  if (doc.estado === "BORRADOR") return falla(c, 409, "Emite el documento antes de enviarlo por correo.");
  // Candado legal SNAT/2024/000102: en Imprenta Digital + REAL no se entrega documento fiscal al cliente hasta tener control_fiscal oficial.
  // APP_SENIAT, PRESUPUESTO y PRACTICA siguen intactos.
  if (doc.tipo === "FACTURA" && doc.medio === "IMPRENTA_DIGITAL" && doc.modo === "REAL" && !doc.control_fiscal) {
    return falla(
      c,
      409,
      "No puedes enviar este documento fiscal al cliente todavía: en modalidad Imprenta Digital (SNAT/2024/000102) requiere primero el N.º de Control oficial asignado por tu Imprenta Digital."
    );
  }
  const destino = texto(b.email || doc.cliente_email, 120).toLowerCase();
  if (!EMAIL.test(destino)) return falla(c, 400, "Escribe un correo electrónico válido del cliente.");
  if (doc.cliente_id && destino !== doc.cliente_email) {
    await db.prepare(`UPDATE clientes SET email = ? WHERE id = ? AND (email IS NULL OR email = '')`).bind(destino, doc.cliente_id).run().catch(() => {});
    if (doc.modo === "PRACTICA") {
      await db.prepare(`UPDATE documentos SET cliente_email = ? WHERE id = ?`).bind(destino, id).run().catch(() => {});
    }
  }
  const perfil = await db.prepare(`SELECT nombre_razon_social, rif, telefono, email FROM perfil_emisor WHERE id = 1`).first<Fila>();
  const nombreNegocio = perfil?.nombre_razon_social || "FacturaYa Venezuela";
  const rifNegocio = aRifSeniat(perfil?.rif || "");
  const esNc = !!doc.es_nota_credito;
  const esNd = !!doc.es_nota_debito;
  const tituloDoc = esNc ? "Nota de Crédito" : esNd ? "Nota de Débito" : doc.tipo === "FACTURA" ? "Factura" : "Presupuesto";
  const nroDoc = esNc
    ? `NC-${String(doc.numero ?? 1).padStart(8, "0")}`
    : esNd
      ? `ND-${String(doc.numero ?? 1).padStart(8, "0")}`
      : doc.tipo === "FACTURA"
        ? String(doc.numero ?? 1).padStart(8, "0")
        : `P-${String(doc.numero ?? 1).padStart(6, "0")}`;
  const nroControl = doc.tipo === "FACTURA" ? (doc.control_fiscal || `00-${String(doc.control_interno ?? doc.numero ?? 1).padStart(8, "0")}`) : null;
  const fmtBs = (cent: number) => `Bs. ${(Number(cent || 0) / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtUsd = (cent: number) => `$ ${(Number(cent || 0) / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const escHtml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);

  const filasHtml = lineas.map((l) => `<tr>
    <td style="padding:8px;border-bottom:1px solid #e5e7eb">${escHtml(l.descripcion)}</td>
    <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">${escHtml(cantidadTexto(l.cantidad_milli))}</td>
    <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtBs(l.monto_bs)}<br><small style="color:#6b7280">${fmtUsd(l.monto_usd)}</small></td>
  </tr>`).join("");

  const impLegal =
    doc.tipo === "FACTURA" && doc.medio === "IMPRENTA_DIGITAL" && doc.modo === "REAL" && doc.control_fiscal
      ? await db
          .prepare(`SELECT fecha_asignacion, hora_asignacion, imprenta_razon_social, imprenta_autorizacion FROM imprenta_envios WHERE documento_id = ?`)
          .bind(id)
          .first<Fila>()
          .catch(() => null)
      : null;
  const pieLegalHtml = impLegal
    ? `<div style="margin-top:16px;padding:10px 12px;border-top:1px dashed #cbd5e1;font-size:12px;color:#475569;line-height:1.5">
         <b>Sello Digital Autorizado (SNAT/2024/000102):</b> ${escHtml(impLegal.imprenta_razon_social || "Imprenta Digital Autorizada")}<br>
         N.º de Control Fiscal: <b>${escHtml(doc.control_fiscal)}</b>${impLegal.fecha_asignacion ? ` · Asignado: ${escHtml(impLegal.fecha_asignacion)} ${escHtml(impLegal.hora_asignacion || "")}` : ""}<br>
         ${impLegal.imprenta_autorizacion ? escHtml(impLegal.imprenta_autorizacion) : ""}
       </div>`
    : "";

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #dde3ec;border-radius:16px;color:#1f2933">
    <div style="border-bottom:2px solid #1A73E8;padding-bottom:12px;margin-bottom:16px">
      <h2 style="margin:0;color:#1A73E8">${escHtml(nombreNegocio)}</h2>
      <p style="margin:4px 0 0;font-size:13px;color:#5f6b7a">RIF: ${escHtml(rifNegocio)}${perfil?.telefono ? ` · Tel: ${escHtml(perfil.telefono)}` : ""}</p>
    </div>
    <h3 style="margin:0 0 8px">${tituloDoc} N.º ${escHtml(nroDoc)}${nroControl ? ` <span style="font-weight:normal;color:#5f6b7a">(Control: ${escHtml(nroControl)})</span>` : ""}</h3>
    <p style="margin:0 0 16px;font-size:14px;color:#4b5563">
      <b>Cliente:</b> ${escHtml(doc.cliente_nombre)} (${escHtml(doc.cliente_rif)})<br>
      <b>Fecha de emisión:</b> ${escHtml(doc.fecha_emision)} · <b>Tasa BCV:</b> Bs. ${(Number(doc.tasa_e8 || 0) / 1e8).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px">
      <thead><tr style="background:#f8fafd;text-align:left">
        <th style="padding:8px;border-bottom:2px solid #dde3ec">Descripción</th>
        <th style="padding:8px;border-bottom:2px solid #dde3ec;text-align:right">Cant.</th>
        <th style="padding:8px;border-bottom:2px solid #dde3ec;text-align:right">Monto</th>
      </tr></thead>
      <tbody>${filasHtml}</tbody>
    </table>
    <div style="background:#f8fafd;padding:14px;border-radius:12px;font-size:14px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>Subtotal:</span><b>${fmtBs(doc.subtotal_bs)} (${fmtUsd(doc.subtotal_usd)})</b></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>IVA:</span><b>${fmtBs(doc.iva_bs)} (${fmtUsd(doc.iva_usd)})</b></div>
      ${doc.aplica_igtf && doc.igtf_usd > 0 ? `<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>IGTF (3%):</span><b>${fmtBs(doc.igtf_bs)} (${fmtUsd(doc.igtf_usd)})</b></div>` : ""}
      <div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:2px solid #dde3ec;font-size:16px"><span><b>TOTAL:</b></span><b>${fmtBs(doc.total_bs)} (${fmtUsd(doc.total_usd)})</b></div>
    </div>
    ${doc.nota ? `<p style="margin:14px 0 0;font-size:13px;color:#5f6b7a"><b>Nota:</b> ${escHtml(doc.nota)}</p>` : ""}
    ${pieLegalHtml}
  </div>`;

  const textoPlano = `${nombreNegocio} (RIF ${rifNegocio})\n${tituloDoc} N.º ${nroDoc}${nroControl ? ` | Control: ${nroControl}` : ""}\nCliente: ${doc.cliente_nombre} (${doc.cliente_rif})\nTotal: ${fmtBs(doc.total_bs)} (${fmtUsd(doc.total_usd)})`;
  const pdfBase64 = typeof b.pdf_base64 === "string" && b.pdf_base64.length > 50 && b.pdf_base64.length < 4_000_000 ? b.pdf_base64 : null;
  const nombrePdf = texto(b.nombre_archivo, 80) || `${tituloDoc.replace(/\s+/g, "-")}-${nroDoc}.pdf`;

  const res = await enviarCorreo(db, c.env as unknown as Record<string, unknown>, {
    para: destino,
    alcance: "INQUILINO",
    tipo: "DOCUMENTO",
    responderA: perfil?.email ? String(perfil.email).trim() : undefined,
    asunto: `${tituloDoc} ${nroDoc} · ${nombreNegocio}`,
    html,
    texto: textoPlano,
    adjuntos: pdfBase64 ? [{ filename: nombrePdf, content: pdfBase64 }] : undefined,
  });
  if (!res.ok) return falla(c, 400, res.error);
  await auditar(c, u.id, "DOC_CORREO", `${tituloDoc} ${nroDoc} -> ${res.demo_redirigido_a || destino}`);
  return c.json({
    ok: true,
    email: res.demo_redirigido_a || destino,
    ...(res.demo_redirigido_a ? { demo_redirigido_a: res.demo_redirigido_a, demo_restantes: res.demo_restantes } : {}),
  });
});

export default documentos;
