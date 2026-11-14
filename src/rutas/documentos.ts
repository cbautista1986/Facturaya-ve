// Módulo DOCUMENTOS (presupuestos, facturas y notas de crédito): /api/documentos
// Ciclo de vida: BORRADOR (editable, sin número) -> EMITIDO (número asignado, ya no se modifica) -> ANULADO.
// Un presupuesto emitido pasa a FACTURADO cuando se emite la factura creada desde él.
// Una factura emitida puede recibir Devoluciones mediante Nota de Crédito (es_nota_credito = 1) conforme a la Providencia SENIAT SNAT/2011/0071.
import { Hono } from "hono";
import { aCantidadMilli, aTasaE8, calcular, cantidadTexto, redondear } from "../../public/dinero.js";
import { costoPromedio, guardaSaldo, movimiento, saldos, valorSalida } from "../stock";
import { veCostos } from "../permisos";
import { PAGADO, aCentavos, auditar, comodin, falla, fechaCaracas, idParam, leerJson, masDias, modoActual, parametrosVigentes, requiereSesion, texto, type Ctx, type Env } from "../comun";

const documentos = new Hono<Env>();
documentos.use("*", requiereSesion);

type Linea = { catalogo_id: number | null; tipo: "SERVICIO" | "PRODUCTO"; descripcion: string; cantidad_milli: number; precio_usd: number; costo_usd: number | null; alicuota_cent: number };
type Fila = Record<string, any>;

const COLUMNAS = `id, tipo, es_nota_credito, factura_afectada_id, motivo_nc, estado, modo, numero, control_interno, control_fiscal, fiscal_serial, medio,
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
  const permitidas = (params.iva_alicuotas_cent ?? "0,800,1600").split(",").map(Number);
  const alicuotaIgtf = Number(params.igtf_alicuota_cent ?? 300) || 300;
  const clienteId = Number(b.cliente_id) || null;
  if (clienteId && !(await db.prepare(`SELECT 1 AS x FROM clientes WHERE id = ?`).bind(clienteId).first())) return "El cliente elegido ya no existe.";
  const lineas = await normalizarLineas(c, b.lineas, permitidas, Number(params.max_renglones ?? 30));
  if (typeof lineas === "string") return lineas;
  let condicion = "CONTADO", dias: number | null = null;
  if (tipo === "FACTURA" && texto(b.condicion, 10) === "CREDITO") {
    dias = Number(b.dias_credito);
    if (!Number.isInteger(dias) || dias < 1 || dias > 365) return "Escribe los días de crédito (un número entre 1 y 365).";
    condicion = "CREDITO";
  }
  const aplicaIgtf = tipo === "FACTURA" && (b.aplica_igtf === true || b.aplica_igtf === 1 || b.aplica_igtf === "1" || b.aplica_igtf === "on") ? 1 : 0;
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

// ---------------------------------------------------------------- consultas
documentos.get("/", async (c) => {
  const q = texto(c.req.query("q"), 60), like = `%${comodin(q)}%`, tipo = texto(c.req.query("tipo"), 16);
  const filtroTipo = tipo === "NOTA_CREDITO"
    ? `d.tipo = 'FACTURA' AND d.es_nota_credito = 1`
    : tipo === "FACTURA"
      ? `d.tipo = 'FACTURA' AND d.es_nota_credito = 0`
      : tipo === "PRESUPUESTO"
        ? `d.tipo = 'PRESUPUESTO'`
        : `1 = 1`;
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.tipo, d.es_nota_credito, d.factura_afectada_id, d.motivo_nc, d.estado, d.modo, d.numero, d.control_interno,
            COALESCE(d.cliente_nombre, c.nombre_apellido) AS cliente,
            d.fecha_emision, d.aplica_igtf, d.igtf_usd, d.igtf_bs, d.total_usd, d.total_bs, d.creado_en, d.vence_el, d.condicion,
            (SELECT fa.numero FROM documentos fa WHERE fa.id = d.factura_afectada_id) AS factura_afectada_numero,
            ${PAGADO} AS pagado_usd
     FROM documentos d LEFT JOIN clientes c ON c.id = d.cliente_id
     WHERE (${filtroTipo})
       AND (? = '' OR COALESCE(d.cliente_nombre, c.nombre_apellido) LIKE ? ESCAPE '\\' OR CAST(d.numero AS TEXT) LIKE ? ESCAPE '\\')
     ORDER BY COALESCE(d.emitido_en, d.creado_en) DESC, d.id DESC LIMIT 100`
  ).bind(q, like, like).all();
  return c.json({ ok: true, documentos: results });
});

// Ganancia del mes (facturas emitidas menos notas de crédito emitidas del mes).
documentos.get("/resumen", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.tipo,
            SUM(CASE WHEN d.es_nota_credito = 1 THEN -r.monto_usd ELSE r.monto_usd END) AS ingresos,
            SUM(CASE WHEN d.es_nota_credito = 1 THEN -((r.cantidad_milli * COALESCE(r.costo_usd, 0) + 500) / 1000) ELSE ((r.cantidad_milli * COALESCE(r.costo_usd, 0) + 500) / 1000) END) AS costos
     FROM documento_renglones r JOIN documentos d ON d.id = r.documento_id
     WHERE d.tipo = 'FACTURA' AND d.estado = 'EMITIDO' AND substr(d.fecha_emision, 1, 7) = ? GROUP BY r.tipo`
  ).bind(fechaCaracas().slice(0, 7)).all<{ tipo: string; ingresos: number; costos: number }>();
  const g = (t: string) => { const f = results.find((x) => x.tipo === t); return f ? f.ingresos - f.costos : 0; };
  return c.json({ ok: true, servicios: g("SERVICIO"), productos: g("PRODUCTO"), total: g("SERVICIO") + g("PRODUCTO") });
});

documentos.get("/:id", async (c) => {
  const id = idParam(c), db = c.env.DB, r = await cargar(c, id);
  if (!r) return falla(c, 404, "Documento no encontrado.");
  const { results } = await db.prepare(
    `SELECT id, documento_id, numero, metodo, moneda, monto_recibido, tasa_e8, monto_usd, saldo_despues_usd, referencia, fecha_pago, estado, motivo_anulacion
     FROM pagos WHERE documento_id IN (?, ?) ORDER BY id`).bind(id, r.doc.presupuesto_id ?? 0).all<Fila>();
  const { results: notasCredito } = r.doc.tipo === "FACTURA" && !r.doc.es_nota_credito
    ? await db.prepare(`SELECT id, numero, control_interno, control_fiscal, fecha_emision, estado, motivo_nc, total_usd, total_bs
                        FROM documentos WHERE factura_afectada_id = ? AND es_nota_credito = 1 ORDER BY id`).bind(id).all<Fila>()
    : { results: [] as Fila[] };
  const facturaAfectada = r.doc.factura_afectada_id
    ? await db.prepare(`SELECT id, numero, control_interno, control_fiscal, fiscal_serial, fecha_emision, total_usd, total_bs, tasa_e8
                        FROM documentos WHERE id = ?`).bind(r.doc.factura_afectada_id).first<Fila>()
    : null;
  // Cantidades ya devueltas por renglón (orden) en notas de crédito vigentes
  const { results: rengsDev } = r.doc.tipo === "FACTURA" && !r.doc.es_nota_credito
    ? await db.prepare(`SELECT dr.orden, COALESCE(SUM(dr.cantidad_milli), 0) AS devuelto_milli
                        FROM documento_renglones dr JOIN documentos nc ON nc.id = dr.documento_id
                        WHERE nc.factura_afectada_id = ? AND nc.es_nota_credito = 1 AND nc.estado = 'EMITIDO'
                        GROUP BY dr.orden`).bind(id).all<{ orden: number; devuelto_milli: number }>()
    : { results: [] as { orden: number; devuelto_milli: number }[] };
  const mapaDev = new Map(rengsDev.map((x) => [x.orden, x.devuelto_milli]));
  const lineasConDev = r.lineas.map((l) => ({ ...l, devuelto_milli: mapaDev.get(l.orden) ?? 0 }));
  const pagadoEfectivo = results.filter((p) => p.estado === "VIGENTE").reduce((s, p) => s + p.monto_usd, 0);
  const acreditadoNc = notasCredito.filter((n) => n.estado === "EMITIDO").reduce((s, n) => s + (n.total_usd ?? 0), 0);
  const pagadoTotal = pagadoEfectivo + acreditadoNc;
  return c.json({
    ok: true, documento: r.doc, lineas: lineasConDev, impuestos: r.impuestos,
    pagos: results, notas_credito: notasCredito, factura_afectada: facturaAfectada,
    pagado_usd: pagadoTotal, acreditado_nc_usd: acreditadoNc,
    saldo_usd: r.doc.estado === "BORRADOR" || r.doc.es_nota_credito ? null : Math.max((r.doc.total_usd ?? 0) - pagadoTotal, 0),
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
  const d = await db.prepare(`SELECT estado, tipo, es_nota_credito FROM documentos WHERE id = ?`).bind(id).first<{ estado: string; tipo: string; es_nota_credito: number }>();
  if (!d) return falla(c, 404, "Documento no encontrado.");
  if (d.estado !== "BORRADOR") return falla(c, 409, "Solo se puede editar un borrador: un documento emitido no se modifica.");
  const cuerpo = await leerJson(c);
  if (!veCostos(c.get("usuario").rol) && Array.isArray(cuerpo.lineas)) {
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

  const perfil = await db.prepare(`SELECT nombre_razon_social, rif, direccion_fiscal, telefono, email, tasa_bcv, tasa_bcv_fecha, medio_facturacion FROM perfil_emisor WHERE id = 1`).first<Fila>();
  const tasa = aTasaE8(String(perfil?.tasa_bcv ?? ""));
  if (!tasa || Number.isNaN(tasa)) return falla(c, 400, "Define la tasa BCV de hoy en el Inicio antes de emitir.");
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
  const emisor = { nombre_razon_social: perfil!.nombre_razon_social, rif: perfil!.rif, direccion_fiscal: perfil!.direccion_fiscal, telefono: perfil!.telefono, email: perfil!.email };
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

  const pasos = [db.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${sigueBorrador}`).bind(claveNum, id)];
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
    if (!r[posEmision].meta.changes) return falla(c, 409, "Este documento ya fue emitido.");
  } catch (e) {
    if (/Documento emitido|UNIQUE|PRIMARY KEY/.test(String(e))) return falla(c, 409, "Este documento ya fue emitido.");
    if (/CHECK constraint failed/.test(String(e))) return falla(c, 409, "Las existencias cambiaron mientras emitías. Revisa y vuelve a intentarlo.");
    throw e;
  }
  const f = await db.prepare(`SELECT numero, control_interno FROM documentos WHERE id = ?`).bind(id).first<Fila>();
  await auditar(c, u.id, "DOC_EMITIR", `${doc.tipo} ${doc.modo} n.º ${f?.numero}`);
  return c.json({ ok: true, numero: f?.numero, control_interno: f?.control_interno });
});

// ---------------------------------------------------------------- devolución (Nota de Crédito según ley venezolana SENIAT)
documentos.post("/:id/devolver", async (c) => {
  const id = idParam(c), db = c.env.DB, u = c.get("usuario"), b = await leerJson(c);
  const motivo = texto(b.motivo, 200);
  if (motivo.length < 5) return falla(c, 400, "Escribe el motivo de la devolución / nota de crédito (mínimo 5 letras).");

  const origen = await cargar(c, id);
  if (!origen) return falla(c, 404, "Factura no encontrada.");
  const { doc: F, lineas: rengsOrigen } = origen;
  if (F.tipo !== "FACTURA" || F.es_nota_credito || F.estado !== "EMITIDO") {
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

  const perfil = await db.prepare(`SELECT nombre_razon_social, rif, direccion_fiscal, telefono, email, tasa_bcv, tasa_bcv_fecha, medio_facturacion FROM perfil_emisor WHERE id = 1`).first<Fila>();
  const tasa = aTasaE8(String(perfil?.tasa_bcv ?? "")) || F.tasa_e8;
  if (!tasa || Number.isNaN(tasa)) return falla(c, 400, "Define la tasa BCV en el Inicio antes de emitir la Nota de Crédito.");

  const fecha = fechaCaracas(), params = await parametrosVigentes(db, fecha);
  const aplicaIgtf = b.aplica_igtf === undefined ? !!F.aplica_igtf : (b.aplica_igtf === true || b.aplica_igtf === 1 || b.aplica_igtf === "1" || b.aplica_igtf === "on");
  const alicuotaIgtf = Number(params.igtf_alicuota_cent ?? F.igtf_alicuota_cent ?? 300) || 300;
  const calc = calcular(lineasNc, tasa, { aplica_igtf: aplicaIgtf, igtf_alicuota_cent: alicuotaIgtf });

  const emisor = { nombre_razon_social: perfil!.nombre_razon_social, rif: perfil!.rif, direccion_fiscal: perfil!.direccion_fiscal, telefono: perfil!.telefono, email: perfil!.email };
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

  const pasos: D1PreparedStatement[] = [
    db.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${sigueBorrador}`).bind(claveNum, ncId),
    db.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${sigueBorrador}`).bind(claveCtl, ncId),
  ];
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

  await db.batch(pasos);
  const emitida = await db.prepare(`SELECT numero FROM documentos WHERE id = ?`).bind(ncId).first<{ numero: number }>();
  await auditar(c, u.id, "NOTA_CREDITO_EMITIR", `NC ${emitida?.numero} -> Factura ${F.numero}: ${motivo}`);
  return c.json({ ok: true, id: ncId, numero: emitida?.numero });
});

// ---------------------------------------------------------------- anular, convertir, copiar
documentos.post("/:id/anular", async (c) => {
  const id = idParam(c), cuerpo = await leerJson(c), motivo = texto(cuerpo.motivo, 200), u = c.get("usuario"), db = c.env.DB;
  if (motivo.length < 5) return falla(c, 400, "Escribe el motivo de la anulación (mínimo 5 letras).");
  const doc = await db.prepare(`SELECT id, tipo, es_nota_credito, modo, estado, fecha_emision, medio, control_fiscal FROM documentos WHERE id = ?`).bind(id).first<Fila>();
  if (!doc) return falla(c, 404, "Documento no encontrado.");
  if (doc.estado !== "EMITIDO") return falla(c, 409, "Solo se puede anular un documento emitido (no un borrador, ni uno ya anulado o facturado).");

  const conPagos = await db.prepare(`SELECT COUNT(*) AS n FROM pagos WHERE documento_id = ? AND estado = 'VIGENTE'`).bind(id).first<{ n: number }>();
  if (conPagos && conPagos.n > 0) return falla(c, 409, "Este documento tiene pagos registrados: anula primero sus pagos o emite una Nota de Crédito por devolución.");

  const conNc = await db.prepare(`SELECT COUNT(*) AS n FROM documentos WHERE factura_afectada_id = ? AND es_nota_credito = 1 AND estado = 'EMITIDO'`).bind(id).first<{ n: number }>();
  if (conNc && conNc.n > 0) return falla(c, 409, "Esta factura ya tiene Notas de Crédito emitidas: según la normativa SENIAT no se puede anular directamente.");

  if (doc.tipo === "FACTURA" && !doc.es_nota_credito) {
    if (doc.medio === "MAQUINA_FISCAL" && doc.control_fiscal) {
      return falla(c, 409, "Según la Providencia SENIAT SNAT/2011/0071, una factura ya impresa en Máquina Fiscal no puede anularse directamente: debes emitir una Nota de Crédito («↩️ Devolver»).");
    }
    const mesDoc = String(doc.fecha_emision ?? "").slice(0, 7), mesActual = fechaCaracas().slice(0, 7);
    if (mesDoc && mesDoc !== mesActual) {
      return falla(c, 409, "Según la normativa SENIAT, una factura de un período fiscal anterior no puede anularse directamente porque altera el Libro de Ventas cerrado: debes emitir una Nota de Crédito («↩️ Devolver»).");
    }
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
  await auditar(c, u.id, "DOC_ANULAR", `${id}: ${motivo}`);
  return c.json({ ok: true });
});

async function clonar(c: Ctx, origenId: number, tipo: "FACTURA" | "PRESUPUESTO", presupuestoId: number | null) {
  const db = c.env.DB;
  const nuevo = await db.prepare(
    `INSERT INTO documentos (tipo, estado, modo, cliente_id, nota, presupuesto_id, subtotal_usd, iva_usd, aplica_igtf, igtf_alicuota_cent, igtf_usd, total_usd, costo_total_usd, creado_por, condicion, dias_credito)
     SELECT ?, 'BORRADOR', ?, cliente_id, nota, ?, subtotal_usd, iva_usd, aplica_igtf, igtf_alicuota_cent, igtf_usd, total_usd, costo_total_usd, ?, condicion, dias_credito FROM documentos WHERE id = ? RETURNING id`
  ).bind(tipo, await modoActual(db), presupuestoId, c.get("usuario").id, origenId).first<{ id: number }>();
  await db.prepare(
    `INSERT INTO documento_renglones (documento_id, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd)
     SELECT ?, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd
     FROM documento_renglones WHERE documento_id = ? ORDER BY orden`
  ).bind(nuevo!.id, origenId).run();
  return nuevo!.id;
}

documentos.post("/:id/fiscal", async (c) => {
  const id = idParam(c), b = await leerJson(c), db = c.env.DB, u = c.get("usuario");
  const d = await db.prepare(`SELECT tipo, es_nota_credito, estado, medio, control_fiscal FROM documentos WHERE id = ?`).bind(id).first<Fila>();
  if (!d) return falla(c, 404, "Documento no encontrado.");
  if (d.tipo !== "FACTURA" || d.estado !== "EMITIDO") return falla(c, 409, "El número fiscal se registra en una factura o nota de crédito emitida y vigente.");
  if (!d.medio) return falla(c, 409, "Este documento se emitió antes de definir el medio de facturación: no se le puede registrar número fiscal aquí.");
  if (d.control_fiscal) return falla(c, 409, "Este documento ya tiene su número fiscal; no se puede cambiar.");
  let numero = texto(b.numero, 30).toUpperCase(), serial: string | null = null;
  if (d.medio === "MAQUINA_FISCAL") {
    const p = await db.prepare(`SELECT maquina_serial AS serial, maquina_ultimo AS ultimo FROM perfil_emisor WHERE id = 1`).first<{ serial: string | null; ultimo: number }>();
    if (!p?.serial) return falla(c, 409, "Primero configura el serial de tu máquina fiscal en Ajustes (solo el dueño puede).");
    if (!/^[0-9]{1,10}$/.test(numero)) return falla(c, 400, "El número fiscal de la máquina fiscal son solo números.");
    const n = Number(numero), pad = (x: number) => String(x).padStart(7, "0");
    if (n <= p.ultimo) return falla(c, 409, `El número fiscal debe ser mayor que el último registrado (${pad(p.ultimo)}).`);
    if (n > p.ultimo + 1 && b.confirmar_salto !== true) return c.json({ ok: false, error: `Se salta del ${pad(p.ultimo)} al ${pad(n)}. Si la máquina anuló o reimprimió documentos, confirma el salto.`, salto: true, esperado: p.ultimo + 1 }, 409);
    numero = pad(n); serial = p.serial;
  } else if (!/^[0-9A-Z][0-9A-Z-]{0,29}$/.test(numero)) return falla(c, 400, "Escribe el número de control (solo letras, números y guiones).");
  try {
    const r = await db.batch([
      db.prepare(`UPDATE documentos SET control_fiscal = ?, fiscal_serial = ? WHERE id = ? AND control_fiscal IS NULL AND estado = 'EMITIDO'`).bind(numero, serial, id),
      db.prepare(`UPDATE perfil_emisor SET maquina_ultimo = ? WHERE id = 1 AND ? IS NOT NULL AND maquina_ultimo < ? AND EXISTS (SELECT 1 FROM documentos WHERE id = ? AND control_fiscal = ?)`).bind(Number(numero) || 0, serial, Number(numero) || 0, id, numero),
    ]);
    if (!r[0].meta.changes) return falla(c, 409, "Este documento ya tiene su número fiscal; no se puede cambiar.");
  } catch (e) {
    if (String(e).includes("UNIQUE")) return falla(c, 409, "Ese número fiscal ya está registrado en otro documento.");
    throw e;
  }
  await auditar(c, u.id, "FISCAL_REGISTRAR", `${id} ${d.medio} ${numero}`);
  return c.json({ ok: true });
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
  const o = await c.env.DB.prepare(`SELECT tipo, es_nota_credito, estado FROM documentos WHERE id = ?`).bind(id).first<Fila>();
  if (!o) return falla(c, 404, "Documento no encontrado.");
  if (o.es_nota_credito) return falla(c, 409, "Una nota de crédito no se copia como borrador.");
  if (o.estado === "BORRADOR") return falla(c, 409, "Un borrador ya se puede editar.");
  const nuevo = await clonar(c, id, o.tipo, null);
  await auditar(c, c.get("usuario").id, "DOC_COPIAR", `${id} -> ${nuevo}`);
  return c.json({ ok: true, id: nuevo });
});

export default documentos;
