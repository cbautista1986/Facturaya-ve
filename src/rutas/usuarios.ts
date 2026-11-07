// Módulo USUARIOS Y CUENTA (Fase 7.1): /api/usuarios (solo el administrador) y /api/cuenta (cada persona con su propia sesión).
// Los permisos de cada rol viven en permisos.ts. Las claves temporales y los códigos de recuperación se muestran UNA sola vez: solo se guarda su huella.
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { EMAIL, ahora, auditar, falla, idParam, leerJson, texto, type Env } from "../comun";
import { ROLES, NOMBRE_ROL } from "../permisos";
import { claveTemporal, codigoRecuperacion, hashClave, sha256, verificarClave } from "../seguridad";

export const usuarios = new Hono<Env>();
export const cuenta = new Hono<Env>();
const MAX_USUARIOS = 30;
const mata = (db: D1Database, id: number, salvo?: string) => // cierra las sesiones de una persona (todas, o todas menos la de este navegador)
  salvo ? db.prepare(`DELETE FROM sesiones WHERE usuario_id = ? AND token_hash <> ?`).bind(id, salvo) : db.prepare(`DELETE FROM sesiones WHERE usuario_id = ?`).bind(id);

// ------------------------------------------------------------------ /api/usuarios
usuarios.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, nombre, email, rol, activo, debe_cambiar_clave, creado_en FROM usuarios ORDER BY activo DESC, nombre COLLATE NOCASE`).all();
  return c.json({ ok: true, usuarios: results, roles: ROLES.map((r) => ({ clave: r, nombre: NOMBRE_ROL[r] })) });
});

usuarios.post("/", async (c) => {
  const b = await leerJson(c), db = c.env.DB, yo = c.get("usuario");
  const nombre = texto(b.nombre, 120), email = texto(b.email, 120).toLowerCase(), rol = texto(b.rol, 12);
  if (nombre.length < 2) return falla(c, 400, "Escribe el nombre de la persona.");
  if (!EMAIL.test(email)) return falla(c, 400, "El correo no es válido.");
  if (!(ROLES as readonly string[]).includes(rol)) return falla(c, 400, "Elige un rol: dueño, supervisor, cajero o bodega.");
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM usuarios`).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_USUARIOS) return falla(c, 409, `Ya hay ${MAX_USUARIOS} usuarios: desactiva o reutiliza alguno.`);
  const temporal = claveTemporal();
  try {
    const r = await db.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, debe_cambiar_clave) VALUES (?, ?, ?, ?, 1) RETURNING id`)
      .bind(nombre, email, await hashClave(temporal), rol).first<{ id: number }>();
    await auditar(c, yo.id, "USUARIO_CREAR", `${email} ${rol}`);
    return c.json({ ok: true, id: r!.id, clave_temporal: temporal });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return falla(c, 409, "Ya existe un usuario con ese correo.");
    throw e;
  }
});

usuarios.put("/:id", async (c) => {
  const id = idParam(c), b = await leerJson(c), db = c.env.DB, yo = c.get("usuario");
  const u = await db.prepare(`SELECT id, nombre, rol, activo FROM usuarios WHERE id = ?`).bind(id).first<{ id: number; nombre: string; rol: string; activo: number }>();
  if (!u) return falla(c, 404, "Usuario no encontrado.");
  const nombre = "nombre" in b ? texto(b.nombre, 120) : u.nombre, rol = "rol" in b ? texto(b.rol, 12) : u.rol, activo = "activo" in b ? (b.activo ? 1 : 0) : u.activo;
  if (nombre.length < 2) return falla(c, 400, "Escribe el nombre de la persona.");
  if (!(ROLES as readonly string[]).includes(rol)) return falla(c, 400, "Elige un rol: dueño, supervisor, cajero o bodega.");
  // Siempre debe quedar al menos un administrador activo. Va dentro del mismo UPDATE para que dos cambios a la vez no puedan dejar el sistema sin dueño.
  const sigueAdmin = rol === "ADMIN" && activo === 1 ? 1 : 0;
  const r = await db.prepare(
    `UPDATE usuarios SET nombre = ?, rol = ?, activo = ? WHERE id = ?
     AND (? = 1 OR NOT (rol = 'ADMIN' AND activo = 1) OR EXISTS (SELECT 1 FROM usuarios o WHERE o.id <> ? AND o.rol = 'ADMIN' AND o.activo = 1))`
  ).bind(nombre, rol, activo, id, sigueAdmin, id).run();
  if (!r.meta.changes) return falla(c, 409, "Debe quedar al menos un administrador activo.");
  if (!activo || rol !== u.rol) await mata(db, id).run(); // desactivado o con otro rol: debe entrar de nuevo (así no sigue con permisos viejos)
  await auditar(c, yo.id, "USUARIO_EDITAR", `${id} ${rol} ${activo ? "activo" : "desactivado"}`);
  return c.json({ ok: true });
});

usuarios.post("/:id/reset-clave", async (c) => {
  const id = idParam(c), db = c.env.DB, yo = c.get("usuario");
  if (id === yo.id) return falla(c, 400, "Para cambiar tu propia clave usa «Mi cuenta».");
  const u = await db.prepare(`SELECT id FROM usuarios WHERE id = ?`).bind(id).first();
  if (!u) return falla(c, 404, "Usuario no encontrado.");
  const temporal = claveTemporal();
  await db.batch([db.prepare(`UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 1 WHERE id = ?`).bind(await hashClave(temporal), id), mata(db, id)]);
  await auditar(c, yo.id, "USUARIO_RESET_CLAVE", String(id));
  return c.json({ ok: true, clave_temporal: temporal });
});

// ------------------------------------------------------------------ /api/cuenta (la persona que tiene la sesión abierta)
cuenta.post("/clave", async (c) => {
  const b = await leerJson(c), db = c.env.DB, yo = c.get("usuario");
  const actual = String(b.actual ?? ""), nueva = String(b.nueva ?? "");
  if (nueva.length < 10) return falla(c, 400, "La clave nueva debe tener al menos 10 caracteres.");
  if (nueva === actual) return falla(c, 400, "La clave nueva debe ser distinta de la actual.");
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(actual, u.password_hash))) return falla(c, 400, "La clave actual no es correcta.");
  const mia = await sha256(getCookie(c, "sid") ?? "");
  await db.batch([db.prepare(`UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 0 WHERE id = ?`).bind(await hashClave(nueva), yo.id), mata(db, yo.id, mia)]);
  await auditar(c, yo.id, "CLAVE_CAMBIAR", "");
  return c.json({ ok: true });
});

// Genera (o reemplaza) el código de recuperación del administrador. Pide la clave actual; el código se ve una sola vez.
cuenta.post("/codigo-recuperacion", async (c) => {
  const b = await leerJson(c), db = c.env.DB, yo = c.get("usuario");
  if (yo.rol !== "ADMIN") return falla(c, 403, "Solo el administrador tiene código de recuperación; si olvidas tu clave, pídele al administrador que la restablezca.");
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.clave ?? ""), u.password_hash))) return falla(c, 400, "La clave no es correcta.");
  const codigo = codigoRecuperacion();
  await db.prepare(`UPDATE usuarios SET codigo_recuperacion_hash = ? WHERE id = ?`).bind(await hashClave(codigo.replace(/-/g, "")), yo.id).run();
  await auditar(c, yo.id, "CODIGO_RECUPERACION", "");
  return c.json({ ok: true, codigo });
});
