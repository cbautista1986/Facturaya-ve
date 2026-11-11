// Módulo SISTEMA (solo administrador): salir del modo práctica y respaldo completo.
import { Hono } from "hono";
import { auditar, falla, fechaCaracas, leerJson, modoActual, requiereAdmin, requiereSesion, texto, type Env } from "../comun";
import { verificarClave } from "../seguridad";
import { calcularSumas } from "./restaurar";

const sistema = new Hono<Env>();
sistema.use("*", requiereSesion, requiereAdmin);

const entero = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 999999999 ? n : 0; };

// Sale del modo práctica UNA vez: borra los documentos de prueba y fija con qué número empieza lo real.
sistema.post("/salir-en-vivo", async (c) => {
  const db = c.env.DB, b = await leerJson(c);
  const medio = await db.prepare(`SELECT medio_facturacion AS m FROM perfil_emisor WHERE id = 1`).first<{ m: string }>();
  if (medio?.m === "SIN_DEFINIR") return falla(c, 400, "Antes de salir en vivo elige tu medio de facturación (máquina fiscal o imprenta digital) en Ajustes.");
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

// MEDIO DE FACTURACIÓN: máquina fiscal o imprenta digital, uno solo a la vez. Solo el dueño lo cambia, con su contraseña y un motivo; queda en un historial.
// El cambio vale para las facturas NUEVAS: cada factura emitida guarda con qué medio se emitió y eso no se toca.
const MEDIOS = ["MAQUINA_FISCAL", "IMPRENTA_DIGITAL"];
sistema.get("/medio", async (c) => {
  const db = c.env.DB, p = await db.prepare(`SELECT medio_facturacion AS medio FROM perfil_emisor WHERE id = 1`).first<{ medio: string }>();
  const { results } = await db.prepare(`SELECT h.medio_anterior, h.medio_nuevo, h.motivo, h.cambiado_en, u.nombre AS por FROM medio_historial h LEFT JOIN usuarios u ON u.id = h.cambiado_por ORDER BY h.id DESC LIMIT 10`).all();
  const pm = await db.prepare(`SELECT maquina_serial, maquina_ultimo FROM perfil_emisor WHERE id = 1`).first<{ maquina_serial: string | null; maquina_ultimo: number }>();
  return c.json({ ok: true, medio: p?.medio ?? "SIN_DEFINIR", historial: results, maquina: { serial: pm?.maquina_serial ?? null, ultimo: pm?.maquina_ultimo ?? 0 }, imprenta: await leerImprenta(db) });
});

// MÁQUINA FISCAL: se configura UNA vez. El serial es siempre el mismo y el número fiscal debe ser correlativo, así que se guarda el ÚLTIMO número usado
// (si la máquina ya imprimió facturas, aquí se anota hasta cuál va). Solo el dueño, con su contraseña.
sistema.post("/medio/maquina", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario");
  const serial = texto(b.serial, 30).toUpperCase(), ultimo = Number(b.ultimo ?? 0);
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.clave ?? ""), u.password_hash))) return falla(c, 400, "La contraseña no es correcta.");
  const p = await db.prepare(`SELECT medio_facturacion AS m, maquina_serial AS s, maquina_ultimo AS u FROM perfil_emisor WHERE id = 1`).first<{ m: string; s: string | null; u: number }>();
  if (p?.m !== "MAQUINA_FISCAL") return falla(c, 409, "Primero elige «Máquina fiscal» como tu medio de facturación.");
  if (!/^[0-9A-Z][0-9A-Z-]{2,29}$/.test(serial)) return falla(c, 400, "Escribe el serial de la máquina fiscal (el que sale impreso en sus facturas).");
  if (!Number.isInteger(ultimo) || ultimo < 0 || ultimo > 9999999999) return falla(c, 400, "El último número fiscal usado debe ser un número entero (0 si la máquina es nueva).");
  const reg = await db.prepare(`SELECT COALESCE(MAX(CAST(control_fiscal AS INTEGER)), 0) AS m FROM documentos WHERE fiscal_serial = ? AND control_fiscal GLOB '[0-9]*'`).bind(serial).first<{ m: number }>();
  if (ultimo < (reg?.m ?? 0)) return falla(c, 409, `Con ese serial ya hay facturas registradas hasta el N.º ${reg!.m}: el último usado no puede ser menor.`);
  const cambio = p.s && p.s !== serial ? `Serial de la máquina: ${p.s} -> ${serial}` : p.s ? `Último número fiscal: ${p.u} -> ${ultimo}` : `Máquina configurada: serial ${serial}, último N.º ${ultimo}`;
  await db.batch([
    db.prepare(`UPDATE perfil_emisor SET maquina_serial = ?, maquina_ultimo = ? WHERE id = 1`).bind(serial, ultimo),
    db.prepare(`INSERT INTO medio_historial (medio_anterior, medio_nuevo, motivo, cambiado_por, cambiado_en) VALUES ('MAQUINA_FISCAL', 'MAQUINA_FISCAL', ?, ?, ?)`).bind(cambio, yo.id, new Date().toISOString()),
  ]);
  await auditar(c, yo.id, "MAQUINA_FISCAL_CONFIG", cambio);
  return c.json({ ok: true, serial, ultimo });
});

// IMPRENTA DIGITAL: datos de conexión (proveedor, dirección de su API, usuario, clave, ambiente). La clave se guarda aparte, NO sale en los respaldos
// y nunca se devuelve entera (solo los últimos 4 caracteres). Hoy solo se guardan: la conexión automática se activa cuando se integre la imprenta elegida.
const CLAVES_IMPRENTA = ["proveedor", "url", "usuario", "clave", "ambiente"] as const;
async function leerImprenta(db: D1Database) {
  const { results } = await db.prepare(`SELECT clave, valor FROM integraciones WHERE clave LIKE 'imprenta_%'`).all<{ clave: string; valor: string }>();
  const m = Object.fromEntries(results.map((r) => [r.clave.replace("imprenta_", ""), r.valor]));
  return { proveedor: m.proveedor ?? "", url: m.url ?? "", usuario: m.usuario ?? "", ambiente: m.ambiente ?? "PRUEBAS", clave_configurada: !!m.clave, clave_final: m.clave ? m.clave.slice(-4) : "" };
}
sistema.get("/imprenta", async (c) => c.json({ ok: true, ...(await leerImprenta(c.env.DB)) }));
sistema.post("/imprenta", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario");
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.password ?? ""), u.password_hash))) return falla(c, 400, "La contraseña no es correcta.");
  const v = { proveedor: texto(b.proveedor, 60), url: texto(b.url, 200), usuario: texto(b.usuario, 100), clave: texto(b.clave, 200), ambiente: texto(b.ambiente, 12) };
  if (v.proveedor.length < 2) return falla(c, 400, "Escribe el nombre de tu imprenta digital.");
  if (!/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(\/[^\s]*)?$/i.test(v.url)) return falla(c, 400, "La dirección de la API debe empezar por https:// (ejemplo: https://api.miimprenta.com/v1).");
  if (!["PRUEBAS", "PRODUCCION"].includes(v.ambiente)) return falla(c, 400, "Elige el ambiente: pruebas o producción.");
  const previa = (await db.prepare(`SELECT valor FROM integraciones WHERE clave = 'imprenta_clave'`).first<{ valor: string }>())?.valor;
  if (!v.clave && !previa) return falla(c, 400, "Escribe la clave (token) de la API de tu imprenta.");
  const ahora = new Date().toISOString(), pasos = CLAVES_IMPRENTA.filter((k) => k !== "clave" || v.clave).map((k) =>
    db.prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`).bind(`imprenta_${k}`, v[k], ahora));
  await db.batch(pasos);
  await auditar(c, yo.id, "IMPRENTA_CONFIG", `${v.proveedor} ${v.ambiente}${v.clave ? " (clave nueva)" : ""}`);
  return c.json({ ok: true, ...(await leerImprenta(db)) });
});
sistema.post("/medio", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario");
  const medio = texto(b.medio, 20), motivo = texto(b.motivo, 300);
  if (!MEDIOS.includes(medio)) return falla(c, 400, "Elige máquina fiscal o imprenta digital.");
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.clave ?? ""), u.password_hash))) return falla(c, 400, "La contraseña no es correcta.");
  if (motivo.length < 5) return falla(c, 400, "Escribe el motivo del cambio (mínimo 5 letras).");
  if (b.confirmo !== true) return falla(c, 400, "Confirma que entiendes el cambio.");
  const actual = (await db.prepare(`SELECT medio_facturacion AS m FROM perfil_emisor WHERE id = 1`).first<{ m: string }>())?.m ?? "SIN_DEFINIR";
  if (actual === medio) return falla(c, 409, "Ese ya es tu medio de facturación.");
  await db.batch([
    db.prepare(`UPDATE perfil_emisor SET medio_facturacion = ? WHERE id = 1 AND medio_facturacion = ?`).bind(medio, actual),
    db.prepare(`INSERT INTO medio_historial (medio_anterior, medio_nuevo, motivo, cambiado_por, cambiado_en) VALUES (?, ?, ?, ?, ?)`).bind(actual, medio, motivo, yo.id, new Date().toISOString()),
  ]);
  await auditar(c, yo.id, "MEDIO_FACTURACION", `${actual} -> ${medio}`);
  return c.json({ ok: true, medio });
});

// Copia completa de los datos (sin contraseñas ni sesiones) para guardarla fuera del sistema. FORMATO 2 (Fase 7.2):
// exporta TODAS las tablas que existan (una tabla nueva nunca se queda fuera) y lleva conteos, sumas de control y una huella para detectar archivos dañados o editados.
const huellaHex = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const NO_EXPORTAR = new Set(["_migraciones", "sesiones", "intentos_login", "verificaciones", "usuarios", "integraciones"]); // integraciones guarda claves: nunca salen en un respaldo
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
