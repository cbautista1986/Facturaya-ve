// Módulo CATÁLOGO (servicios y productos): /api/catalogo
import { Hono } from "hono";
import { aCantidadMilli } from "../../public/dinero.js";
import { aCentavos, auditar, comodin, esForanea, esUnico, falla, idParam, leerJson, requiereSesion, texto, type Env } from "../comun";
import { veCostos } from "../permisos";
import { leerTipoContribuyente, type TipoContribuyente } from "../regimen";
import { esTipoExencionValido, normalizarTipoExencion, type TipoExencion } from "../reglas-fiscales";

const catalogo = new Hono<Env>();
catalogo.use("*", requiereSesion);

const COLUMNAS_CON_COSTO = "id, codigo, nombre, tipo, costo_centavos, precio_centavos, alicuota_iva, tipo_exencion, activo, controla_stock, stock_minimo_milli, " +
  "(SELECT COALESCE(SUM(m.cantidad_milli), 0) FROM movimientos_stock m WHERE m.producto_id = catalogo.id) AS stock_milli";
const COLUMNAS_SIN_COSTO = "id, codigo, nombre, tipo, precio_centavos, alicuota_iva, tipo_exencion, activo, controla_stock, stock_minimo_milli, " +
  "(SELECT COALESCE(SUM(m.cantidad_milli), 0) FROM movimientos_stock m WHERE m.producto_id = catalogo.id) AS stock_milli";
const TIPOS = ["SERVICIO", "PRODUCTO"], IVAS = [0, 8, 16];

function validar(b: Record<string, unknown>, regimen: TipoContribuyente) {
  const nombre = texto(b.nombre, 120), tipo = texto(b.tipo, 10) || "SERVICIO";
  const codigo = texto(b.codigo, 30).toUpperCase() || null;
  const costo = aCentavos(b.costo_usd), precio = aCentavos(b.precio_usd);
  const ivaPorDefecto = regimen === "FORMAL" ? 0 : 16;
  const iva = b.alicuota_iva === undefined || b.alicuota_iva === "" || b.alicuota_iva === null ? ivaPorDefecto : Number(b.alicuota_iva);
  const activo = String(b.activo ?? "1") === "0" ? 0 : 1;
  if (nombre.length < 2) return "Escribe el nombre.";
  if (!TIPOS.includes(tipo)) return "El tipo no es válido.";
  if (Number.isNaN(costo) || Number.isNaN(precio)) return "Escribe los montos solo con números (ejemplo: 12,50).";
  if (tipo === "PRODUCTO" && !precio) return "Un producto necesita su precio de venta.";
  if (!IVAS.includes(iva)) return "El IVA no es válido.";
  if (regimen === "FORMAL" && iva !== 0) {
    return "Como Contribuyente Formal (Art. 8 Ley del IVA), los servicios y productos deben ser Exentos de IVA (0%).";
  }
  const teRaw = texto(b.tipo_exencion, 20).toUpperCase();
  if (iva === 0 && teRaw && !esTipoExencionValido(teRaw)) {
    return "La clasificación sin IVA debe ser Exenta (EXENTA), Exonerada (EXONERADA) o No Sujeta (NO_SUJETA).";
  }
  const tipo_exencion: TipoExencion = iva === 0 ? normalizarTipoExencion(teRaw) : "EXENTA";
  // Existencias: solo los productos las controlan. Si no se dice nada: al crear queda sin control; al editar se conserva lo que había.
  const cs = b.controla_stock, minimo = aCantidadMilli(b.stock_minimo);
  if (Number.isNaN(minimo)) return "El mínimo de existencias no es válido (ejemplo: 5).";
  const controla = tipo !== "PRODUCTO" ? 0 : cs === undefined ? undefined : String(cs) === "0" || cs === false ? 0 : 1;
  return { nombre, tipo, codigo, costo, precio, iva, tipo_exencion, activo, controla, minimo: tipo === "PRODUCTO" ? minimo : null }; // precio vacío en un servicio = "se define al facturar"
}

catalogo.get("/", async (c) => {
  const u = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  const cols = veCostos(u.rol, u.email, envObj) ? COLUMNAS_CON_COSTO : COLUMNAS_SIN_COSTO;
  const q = texto(c.req.query("q"), 60), like = `%${comodin(q)}%`, tipo = texto(c.req.query("tipo"), 10);
  const { results } = await c.env.DB.prepare(
    `SELECT ${cols} FROM catalogo
     WHERE (? = '' OR nombre LIKE ? ESCAPE '\\' OR codigo LIKE ? ESCAPE '\\') AND (? = '' OR tipo = ?)
     ORDER BY activo DESC, nombre COLLATE NOCASE LIMIT 200`
  ).bind(q, like, like, tipo, tipo).all();
  return c.json({ ok: true, items: results });
});

catalogo.get("/:id", async (c) => {
  const u = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  const cols = veCostos(u.rol, u.email, envObj) ? COLUMNAS_CON_COSTO : COLUMNAS_SIN_COSTO;
  const f = await c.env.DB.prepare(`SELECT ${cols} FROM catalogo WHERE id = ?`).bind(idParam(c)).first();
  return f ? c.json({ ok: true, item: f }) : falla(c, 404, "No encontrado.");
});

catalogo.post("/", async (c) => {
  const u = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  const puedeVerCostos = veCostos(u.rol, u.email, envObj);
  const regimen = await leerTipoContribuyente(c.env.DB);
  const v = validar(await leerJson(c), regimen);
  if (typeof v === "string") return falla(c, 400, v);
  try {
    const r = await c.env.DB.prepare(
      `INSERT INTO catalogo (codigo, nombre, tipo, costo_centavos, precio_centavos, alicuota_iva, tipo_exencion, activo, controla_stock, stock_minimo_milli) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(v.codigo, v.nombre, v.tipo, puedeVerCostos ? v.costo : null, v.precio, v.iva, v.tipo_exencion, v.activo, v.controla ?? 0, v.minimo).run();
    await auditar(c, u.id, "CATALOGO_CREAR", v.nombre);
    return c.json({ ok: true, id: r.meta.last_row_id });
  } catch (e) {
    if (esUnico(e)) return falla(c, 409, "Ya existe algo con ese código.");
    throw e;
  }
});

catalogo.put("/:id", async (c) => {
  const id = idParam(c), u = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  const puedeVerCostos = veCostos(u.rol, u.email, envObj);
  const regimen = await leerTipoContribuyente(c.env.DB), v = validar(await leerJson(c), regimen);
  if (typeof v === "string") return falla(c, 400, v);
  const mov = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM movimientos_stock WHERE producto_id = ?`).bind(id).first<{ n: number }>();
  if (mov && mov.n > 0 && (v.controla === 0 || v.tipo !== "PRODUCTO")) return falla(c, 409, "Este producto ya tiene movimientos de existencias: no se puede apagar el control ni convertirlo en servicio.");
  try {
    const r = puedeVerCostos
      ? await c.env.DB.prepare(
          `UPDATE catalogo SET codigo = ?, nombre = ?, tipo = ?, costo_centavos = ?, precio_centavos = ?, alicuota_iva = ?, tipo_exencion = ?, activo = ?,
             controla_stock = COALESCE(?, controla_stock), stock_minimo_milli = ? WHERE id = ?`
        ).bind(v.codigo, v.nombre, v.tipo, v.costo, v.precio, v.iva, v.tipo_exencion, v.activo, v.controla ?? null, v.minimo, id).run()
      : await c.env.DB.prepare(
          `UPDATE catalogo SET codigo = ?, nombre = ?, tipo = ?, precio_centavos = ?, alicuota_iva = ?, tipo_exencion = ?, activo = ?,
             controla_stock = COALESCE(?, controla_stock), stock_minimo_milli = ? WHERE id = ?`
        ).bind(v.codigo, v.nombre, v.tipo, v.precio, v.iva, v.tipo_exencion, v.activo, v.controla ?? null, v.minimo, id).run();
    if (!r.meta.changes) return falla(c, 404, "No encontrado.");
    await auditar(c, u.id, "CATALOGO_EDITAR", `${id} ${v.nombre}`);
    return c.json({ ok: true });
  } catch (e) {
    if (esUnico(e)) return falla(c, 409, "Ya existe otra cosa con ese código.");
    throw e;
  }
});

catalogo.delete("/:id", async (c) => {
  const id = idParam(c);
  try {
    const r = await c.env.DB.prepare(`DELETE FROM catalogo WHERE id = ?`).bind(id).run();
    if (!r.meta.changes) return falla(c, 404, "No encontrado.");
    await auditar(c, c.get("usuario").id, "CATALOGO_ELIMINAR", String(id));
    return c.json({ ok: true });
  } catch (e) {
    if (esForanea(e)) return falla(c, 409, "Ya se usó en documentos o en la bodega: desactívalo en lugar de eliminarlo.");
    throw e;
  }
});

export default catalogo;
