// Módulo SISTEMA (solo administrador): salir del modo práctica y respaldo completo.
import { Hono } from "hono";
import { auditar, falla, fechaCaracas, leerJson, modoActual, requiereAdmin, requiereSesion, type Env } from "../comun";
import { calcularSumas } from "./restaurar";

const sistema = new Hono<Env>();
sistema.use("*", requiereSesion, requiereAdmin);

const entero = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 999999999 ? n : 0; };

// Sale del modo práctica UNA vez: borra los documentos de prueba y fija con qué número empieza lo real.
sistema.post("/salir-en-vivo", async (c) => {
  const db = c.env.DB, b = await leerJson(c);
  const f = entero(b.primer_factura), k = entero(b.primer_control), p = entero(b.primer_presupuesto), rec = entero(b.primer_recibo ?? 1);
  if (!f || !k || !p || !rec) return falla(c, 400, "Escribe los tres números iniciales (mínimo 1).");
  if (b.confirmo !== true) return falla(c, 400, "Marca la casilla para confirmar.");
  if ((await modoActual(db)) !== "PRACTICA") return falla(c, 409, "El sistema ya está en vivo.");
  await db.batch([
    db.prepare(`DELETE FROM pagos WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM movimientos_stock WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM compra_impuestos WHERE compra_id IN (SELECT id FROM compras WHERE modo = 'PRACTICA')`),
    db.prepare(`DELETE FROM compras WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM documento_impuestos WHERE documento_id IN (SELECT id FROM documentos WHERE modo = 'PRACTICA')`),
    db.prepare(`DELETE FROM documento_renglones WHERE documento_id IN (SELECT id FROM documentos WHERE modo = 'PRACTICA')`),
    db.prepare(`UPDATE documentos SET presupuesto_id = NULL WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM documentos WHERE modo = 'PRACTICA'`),
    db.prepare(`UPDATE contadores SET valor = 0 WHERE clave LIKE '%:PRACTICA'`),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'FACTURA:REAL'`).bind(f - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'CONTROL:REAL'`).bind(k - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'PRESUPUESTO:REAL'`).bind(p - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'RECIBO:REAL'`).bind(rec - 1),
    db.prepare(`UPDATE catalogo SET controla_stock = 0 WHERE controla_stock = 1 AND NOT EXISTS (SELECT 1 FROM movimientos_stock m WHERE m.producto_id = catalogo.id)`),
    db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`),
  ]);
  await auditar(c, c.get("usuario").id, "SALIR_EN_VIVO", `factura ${f}, control ${k}, presupuesto ${p}`);
  return c.json({ ok: true });
});

// Copia completa de los datos (sin contraseñas ni sesiones) para guardarla fuera del sistema. FORMATO 2 (Fase 7.2):
// exporta TODAS las tablas que existan (una tabla nueva nunca se queda fuera) y lleva conteos, sumas de control y una huella para detectar archivos dañados o editados.
const huellaHex = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const NO_EXPORTAR = new Set(["_migraciones", "sesiones", "intentos_login", "verificaciones", "usuarios"]);
sistema.get("/respaldo", async (c) => {
  const db = c.env.DB, datos: Record<string, Record<string, unknown>[]> = {};
  const { results } = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).all<{ name: string }>();
  for (const { name } of results) if (/^[a-z_]+$/.test(name) && !NO_EXPORTAR.has(name)) datos[name] = (await db.prepare(`SELECT * FROM ${name}`).all()).results;
  datos.usuarios = (await db.prepare(`SELECT id, nombre, email, rol, activo, creado_en FROM usuarios`).all()).results;
  const conteos = Object.fromEntries(Object.entries(datos).map(([t, f]) => [t, f.length]));
  const cuerpo = JSON.stringify({ formato: "respaldo-facturacion", version: 2, generado_en: new Date().toISOString(), huella: await huellaHex(JSON.stringify(datos)),
    modo_origen: await modoActual(db), conteos, sumas: calcularSumas(datos), datos });
  await auditar(c, c.get("usuario").id, "RESPALDO");
  return new Response(cuerpo, { headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="respaldo-${fechaCaracas()}.json"` } });
});

export default sistema;
