// Módulo SISTEMA (solo administrador): salir del modo práctica, servicio de correo, respaldo completo y reinicio de fábrica (solo Super Admin).
import { Hono } from "hono";
import { EMAIL, auditar, falla, fechaCaracas, leerJson, modoActual, requiereAdmin, requiereSesion, texto, type Env } from "../comun";
import { enviarCorreo, leerConfigCorreo } from "../correo";
import { migrar } from "../migraciones";
import { esSuperAdmin } from "../permisos";
import { verificarClave } from "../seguridad";
import { calcularSumas } from "./restaurar";

const sistema = new Hono<Env>();
sistema.use("*", requiereSesion, requiereAdmin);

const entero = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 999999999 ? n : 0; };

// Sale del modo práctica UNA vez: borra los documentos de prueba y fija con qué número empieza lo real.
sistema.post("/salir-en-vivo", async (c) => {
  const db = c.env.DB, b = await leerJson(c);
  const medio = await db.prepare(`SELECT medio_facturacion AS m FROM perfil_emisor WHERE id = 1`).first<{ m: string }>();
  if (medio?.m === "SIN_DEFINIR") return falla(c, 400, "Antes de salir en vivo elige tu modalidad de facturación digital (App SENIAT o Imprenta Digital) en Ajustes.");
  const f = entero(b.primer_factura), k = entero(b.primer_control), p = entero(b.primer_presupuesto), rec = entero(b.primer_recibo ?? 1), nc = entero(b.primer_nota_credito ?? 1);
  if (!f || !k || !p || !rec || !nc) return falla(c, 400, "Escribe los números iniciales (mínimo 1).");
  if (b.confirmo !== true) return falla(c, 400, "Marca la casilla para confirmar.");
  if ((await modoActual(db)) !== "PRACTICA") return falla(c, 409, "El sistema ya está en vivo.");
  await db.batch([
    db.prepare(`DELETE FROM pagos WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM movimientos_stock WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM compra_impuestos WHERE compra_id IN (SELECT id FROM compras WHERE modo = 'PRACTICA')`),
    db.prepare(`DELETE FROM compras WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM documento_impuestos WHERE documento_id IN (SELECT id FROM documentos WHERE modo = 'PRACTICA')`),
    db.prepare(`DELETE FROM documento_renglones WHERE documento_id IN (SELECT id FROM documentos WHERE modo = 'PRACTICA')`),
    db.prepare(`UPDATE documentos SET presupuesto_id = NULL, factura_afectada_id = NULL WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM documentos WHERE modo = 'PRACTICA'`),
    db.prepare(`UPDATE contadores SET valor = 0 WHERE clave LIKE '%:PRACTICA'`),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'FACTURA:REAL'`).bind(f - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'CONTROL:REAL'`).bind(k - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'PRESUPUESTO:REAL'`).bind(p - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'RECIBO:REAL'`).bind(rec - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'NOTA_CREDITO:REAL'`).bind(nc - 1),
    db.prepare(`UPDATE catalogo SET controla_stock = 0 WHERE controla_stock = 1 AND NOT EXISTS (SELECT 1 FROM movimientos_stock m WHERE m.producto_id = catalogo.id)`),
    db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`),
  ]);
  await auditar(c, c.get("usuario").id, "SALIR_EN_VIVO", `factura ${f}, control ${k}, presupuesto ${p}, nc ${nc}`);
  return c.json({ ok: true });
});

// MODALIDAD DE FACTURACIÓN DIGITAL: Aplicación Digital SENIAT (APP_SENIAT) o Imprenta Digital Autorizada (IMPRENTA_DIGITAL).
// Solo el dueño lo cambia, con su contraseña y un motivo; queda en el historial.
const MEDIOS = ["APP_SENIAT", "IMPRENTA_DIGITAL"];
sistema.get("/medio", async (c) => {
  const db = c.env.DB, p = await db.prepare(`SELECT medio_facturacion AS medio FROM perfil_emisor WHERE id = 1`).first<{ medio: string }>();
  const { results } = await db.prepare(`SELECT h.medio_anterior, h.medio_nuevo, h.motivo, h.cambiado_en, u.nombre AS por FROM medio_historial h LEFT JOIN usuarios u ON u.id = h.cambiado_por ORDER BY h.id DESC LIMIT 10`).all();
  return c.json({ ok: true, medio: p?.medio ?? "APP_SENIAT", historial: results, imprenta: await leerImprenta(db) });
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

// SERVICIO DE CORREO ELECTRÓNICO (Resend / Brevo) para enviar facturas a clientes y recuperación jerárquica de claves.
sistema.get("/correo", async (c) => {
  const cfg = await leerConfigCorreo(c.env.DB, c.env as unknown as Record<string, string>);
  return c.json({
    ok: true,
    proveedor: cfg.proveedor,
    remitente: cfg.remitente,
    nombre_remitente: cfg.nombre_remitente,
    clave_configurada: !!cfg.clave,
    clave_final: cfg.clave ? cfg.clave.slice(-4) : "",
  });
});

sistema.post("/correo", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario");
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.password ?? ""), u.password_hash))) return falla(c, 400, "La contraseña no es correcta.");
  const proveedor = texto(b.proveedor, 20).toUpperCase() === "BREVO" ? "BREVO" : "RESEND";
  const remitente = texto(b.remitente, 120).toLowerCase();
  const nombre_remitente = texto(b.nombre_remitente, 80);
  const clave = texto(b.clave, 200);
  if (!EMAIL.test(remitente)) return falla(c, 400, "Escribe un correo remitente válido (ejemplo: facturacion@tudominio.com o onboarding@resend.dev).");
  const previa = (await db.prepare(`SELECT valor FROM integraciones WHERE clave = 'correo_clave'`).first<{ valor: string }>())?.valor;
  if (!clave && !previa) return falla(c, 400, `Escribe la API Key de ${proveedor}.`);
  const ahora = new Date().toISOString();
  const pares: [string, string][] = [
    ["correo_proveedor", proveedor],
    ["correo_remitente", remitente],
    ["correo_nombre_remitente", nombre_remitente],
  ];
  if (clave) pares.push(["correo_clave", clave]);
  await db.batch(
    pares.map(([k, val]) =>
      db.prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`).bind(k, val, ahora)
    )
  );
  await auditar(c, yo.id, "CORREO_CONFIG", `${proveedor} <${remitente}>${clave ? " (API key actualizada)" : ""}`);
  const cfg = await leerConfigCorreo(db, c.env as unknown as Record<string, string>);
  return c.json({ ok: true, proveedor: cfg.proveedor, remitente: cfg.remitente, nombre_remitente: cfg.nombre_remitente, clave_configurada: !!cfg.clave, clave_final: cfg.clave ? cfg.clave.slice(-4) : "" });
});

sistema.post("/correo/probar", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario");
  const destino = texto(b.para || yo.email, 120).toLowerCase();
  if (!EMAIL.test(destino)) return falla(c, 400, "Escribe un correo de destino válido.");
  const r = await enviarCorreo(db, c.env as unknown as Record<string, string>, {
    para: destino,
    asunto: "✅ Prueba de correo · FacturaYa Venezuela",
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #dde3ec;border-radius:16px">
      <h2 style="margin:0 0 12px;color:#1A73E8">✉️ Servicio de correo activo</h2>
      <p>Tu configuración de correo en <b>FacturaYa Venezuela</b> funciona correctamente.</p>
      <p style="font-size:13px;color:#5f6b7a">Ya puedes enviar facturas, presupuestos y notas de crédito con PDF adjunto a tus clientes, así como recibir recuperaciones de contraseña.</p>
    </div>`,
    texto: "Servicio de correo activo en FacturaYa Venezuela. Ya puedes enviar facturas a tus clientes y recuperar contraseñas por correo.",
  });
  if (!r.ok) return falla(c, 400, r.error);
  await auditar(c, yo.id, "CORREO_PRUEBA", destino);
  return c.json({ ok: true, destino });
});

sistema.post("/medio", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario");
  const medio = texto(b.medio, 20), motivo = texto(b.motivo, 300);
  if (!MEDIOS.includes(medio)) return falla(c, 400, "Elige Aplicación Digital SENIAT o Imprenta Digital.");
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.clave ?? ""), u.password_hash))) return falla(c, 400, "La contraseña no es correcta.");
  if (motivo.length < 5) return falla(c, 400, "Escribe el motivo del cambio (mínimo 5 letras).");
  if (b.confirmo !== true) return falla(c, 400, "Confirma que entiendes el cambio.");
  const actual = (await db.prepare(`SELECT medio_facturacion AS m FROM perfil_emisor WHERE id = 1`).first<{ m: string }>())?.m ?? "APP_SENIAT";
  if (actual === medio) return falla(c, 409, "Esa ya es tu modalidad de facturación.");
  await db.batch([
    db.prepare(`UPDATE perfil_emisor SET medio_facturacion = ? WHERE id = 1 AND medio_facturacion = ?`).bind(medio, actual),
    db.prepare(`INSERT INTO medio_historial (medio_anterior, medio_nuevo, motivo, cambiado_por, cambiado_en) VALUES (?, ?, ?, ?, ?)`).bind(actual, medio, motivo, yo.id, new Date().toISOString()),
  ]);
  await auditar(c, yo.id, "MEDIO_FACTURACION", `${actual} -> ${medio}`);
  return c.json({ ok: true, medio });
});

// REINICIAR BASE DE DATOS DE FÁBRICA (EXCLUSIVO DEL SÚPER ADMINISTRADOR CRISTIAN):
// elimina triggers y tablas del inquilino actual y vuelve a correr las migraciones desde cero para dejar el negocio recién instalado.
sistema.post("/reiniciar-fabrica", async (c) => {
  const db = c.env.DB, rawDb = c.get("rawDb") || db, inqCod = c.get("inquilinoCodigo") || "principal";
  const b = await leerJson(c), yo = c.get("usuario");
  if (!esSuperAdmin(yo.rol, yo.email)) {
    return falla(c, 403, "Solo el Súper Administrador del sistema tiene permiso para reiniciar la base de datos de fábrica.");
  }
  if (b.confirmo !== true) return falla(c, 400, "Marca la casilla de confirmación para borrar toda la base de datos.");
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.clave ?? ""), u.password_hash))) return falla(c, 400, "La contraseña del Súper Administrador no es correcta.");
  const triggersConocidos = [
    "doc_no_borrar", "doc_inmutable", "renglon_no_cambiar", "renglon_no_borrar",
    "impuesto_no_cambiar", "impuesto_no_borrar", "pago_no_borrar", "pago_inmutable",
    "mov_no_cambiar", "mov_no_borrar", "compra_no_borrar", "compra_inmutable",
    "compra_impuestos_no_cambiar", "compra_impuestos_no_borrar",
  ];
  await db.batch(triggersConocidos.map((t) => db.prepare(`DROP TRIGGER IF EXISTS ${t}`)));
  const ordenTablas = [
    "pagos", "movimientos_stock", "compra_impuestos", "compras", "compras_vieja",
    "documento_impuestos", "documento_renglones", "documentos", "catalogo", "clientes", "proveedores",
    "medio_historial", "metodos_cobro", "integraciones", "parametros_fiscales", "contadores", "ajustes",
    "verificaciones", "auditoria", "intentos_login", "sesiones", "usuarios", "perfil_emisor", "_migraciones",
  ];
  await db.batch(ordenTablas.map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)));
  await migrar(db);
  if (inqCod === "principal") {
    await rawDb.prepare(`DELETE FROM _mt_inquilinos WHERE codigo = 'principal'`).run().catch(() => {});
    await rawDb.prepare(`DELETE FROM _mt_directorio WHERE inquilino_codigo = 'principal'`).run().catch(() => {});
  }
  return c.json({ ok: true });
});

// Copia completa de los datos del negocio actual (sin contraseñas ni sesiones) para guardarla fuera del sistema.
const huellaHex = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const TABLAS_EXPORTAR = [
  "ajustes", "auditoria", "catalogo", "clientes", "compra_impuestos", "compras",
  "contadores", "documento_impuestos", "documento_renglones", "documentos",
  "medio_historial", "metodos_cobro", "movimientos_stock", "pagos", "perfil_emisor", "proveedores",
];
sistema.get("/respaldo", async (c) => {
  const db = c.env.DB, datos: Record<string, Record<string, unknown>[]> = {};
  for (const name of TABLAS_EXPORTAR) {
    datos[name] = (await db.prepare(`SELECT * FROM ${name}`).all()).results;
  }
  datos.usuarios = (await db.prepare(`SELECT id, nombre, email, rol, activo, creado_en FROM usuarios`).all()).results;
  const conteos = Object.fromEntries(Object.entries(datos).map(([t, f]) => [t, f.length]));
  const cuerpo = JSON.stringify({ formato: "respaldo-facturacion", version: 2, generado_en: new Date().toISOString(), huella: await huellaHex(JSON.stringify(datos)),
    modo_origen: await modoActual(db), conteos, sumas: calcularSumas(datos), datos });
  await auditar(c, c.get("usuario").id, "RESPALDO");
  return new Response(cuerpo, { headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="respaldo-${fechaCaracas()}.json"` } });
});

export default sistema;
