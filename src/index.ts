import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { migrar } from "./migraciones";
import { CLAVE_FALSA, codigoRecuperacion, hashClave, normalizarCodigo, sha256, tokenAleatorio, verificarClave } from "./seguridad";
import { NOMBRE_ROL, permisosDe, permitido, sinCostos, tiene, veCostos } from "./permisos";
import { usuarios, cuenta } from "./rutas/usuarios";
import { restaurar } from "./rutas/restaurar";
import { EMAIL, RIF, ahora, auditar, falla, ip, leerJson, modoActual, usuarioActual, type Ctx, type Env } from "./comun";
import clientes from "./rutas/clientes";
import catalogo from "./rutas/catalogo";
import documentos from "./rutas/documentos";
import sistema from "./rutas/sistema";
import pagos from "./rutas/pagos";
import proveedores from "./rutas/proveedores";
import compras from "./rutas/compras";
import existencias from "./rutas/existencias";
import informes from "./rutas/informes";

const app = new Hono<Env>();
const SESION_SEGUNDOS = 60 * 60 * 24 * 7;

// Campos del negocio que el administrador puede editar (lista blanca: nada más se puede tocar)
const OBLIGATORIOS = ["nombre_razon_social", "rif", "direccion_fiscal"];
const OPCIONALES = ["telefono", "email", "datos_pago_movil", "datos_transferencia", "datos_zelle", "datos_binance", "datos_paypal"];
const COLUMNAS_NEGOCIO = [...OBLIGATORIOS, ...OPCIONALES, "tasa_bcv", "tasa_bcv_fecha", "medio_facturacion"].join(", ");

async function abrirSesion(c: Ctx, usuarioId: number) {
  const token = tokenAleatorio();
  await c.env.DB.prepare(`INSERT INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)`)
    .bind(await sha256(token), usuarioId, ahora() + SESION_SEGUNDOS).run();
  setCookie(c, "sid", token, {
    httpOnly: true, sameSite: "Strict", path: "/", maxAge: SESION_SEGUNDOS,
    secure: new URL(c.req.url).protocol === "https:",
  });
}

// La base de datos se prepara sola en la primera petición (ver migraciones.ts)
let migrado = false;
app.use("/api/*", async (c, next) => {
  if (!migrado) { await migrar(c.env.DB); migrado = true; }
  await next();
  c.res.headers.set("Cache-Control", "no-store");
});

// CONTROL CENTRAL DE PERMISOS (Fase 7.1): toda petición a /api pasa por aquí (sesión viva + permiso del rol, ver permisos.ts) antes de llegar a su módulo.
const PUBLICAS = new Set(["/api/estado", "/api/instalar", "/api/login", "/api/logout", "/api/recuperar"]);
app.use("/api/*", async (c, next) => {
  const ruta = c.req.path;
  if (PUBLICAS.has(ruta)) return next();
  const u = await usuarioActual(c);
  if (!u) return falla(c, 401, "Inicia sesión para continuar.");
  c.set("usuario", u);
  if (!permitido(u.rol, c.req.method, ruta)) return falla(c, 403, "Tu usuario no tiene permiso para esto.");
  if (u.debe_cambiar_clave && ruta !== "/api/cuenta/clave") return c.json({ ok: false, error: "Debes cambiar tu clave temporal antes de continuar.", cambiar_clave: true }, 403);
  // Mientras se restaura un respaldo nadie guarda nada (la restauración la hace UNA persona de principio a fin)
  if (c.req.method !== "GET" && !ruta.startsWith("/api/sistema/restaurar/") && (await c.env.DB.prepare(`SELECT 1 FROM ajustes WHERE clave = 'restauracion'`).first()))
    return c.json({ ok: false, error: "El sistema está restaurando un respaldo. Espera a que el administrador termine.", restaurando: true }, 423);
  await next();
  if (!veCostos(u.rol) && (c.res.headers.get("content-type") ?? "").includes("application/json")) { // quien no ve costos tampoco los recibe, aunque la pantalla no los pida
    const datos = await c.res.clone().json().catch(() => null);
    if (datos) c.res = new Response(JSON.stringify(sinCostos(datos)), { status: c.res.status, headers: c.res.headers });
  }
});

app.get("/api/estado", async (c) => {
  const hayAdmin = await c.env.DB.prepare(`SELECT 1 AS x FROM usuarios LIMIT 1`).first();
  if (!hayAdmin) return c.json({ instalado: false });
  const usuario = await usuarioActual(c);
  if (!usuario) return c.json({ instalado: true, sesion: false });
  const negocio = await c.env.DB.prepare(`SELECT ${COLUMNAS_NEGOCIO} FROM perfil_emisor WHERE id = 1`).first();
  return c.json({ instalado: true, sesion: true, usuario: { ...usuario, rol_nombre: NOMBRE_ROL[usuario.rol] ?? usuario.rol }, permisos: permisosDe(usuario.rol), ve_costos: veCostos(usuario.rol), restaurando: !!(await c.env.DB.prepare(`SELECT 1 FROM ajustes WHERE clave = 'restauracion'`).first()), negocio, modo: await modoActual(c.env.DB) });
});

// Instalador tipo WordPress: solo funciona UNA vez; después responde 409 (nadie puede crear otro admin).
app.post("/api/instalar", async (c) => {
  const db = c.env.DB;
  if (await db.prepare(`SELECT 1 FROM usuarios LIMIT 1`).first()) return falla(c, 409, "El sistema ya está instalado.");
  const b = await leerJson(c);
  const t = (k: string) => String(b[k] ?? "").trim();
  const nombre = t("nombre").slice(0, 120), rif = t("rif").toUpperCase(), direccion = t("direccion").slice(0, 200);
  const telefono = t("telefono").slice(0, 40) || null, email = t("email").toLowerCase();
  const clave = String(b.clave ?? "");
  if (nombre.length < 2) return falla(c, 400, "Escribe el nombre del negocio.");
  if (!RIF.test(rif)) return falla(c, 400, "RIF o cédula no válido (ejemplo: J-12345678-9).");
  if (direccion.length < 5) return falla(c, 400, "Escribe la dirección fiscal.");
  if (!EMAIL.test(email)) return falla(c, 400, "El correo no es válido.");
  if (clave.length < 10) return falla(c, 400, "La contraseña debe tener al menos 10 caracteres.");

  const hash = await hashClave(clave), codigo = codigoRecuperacion();
  // Las dos inserciones llevan la misma condición: si dos personas instalan a la vez, solo gana una.
  const r = await db.batch([
    db.prepare(
      `INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, telefono, email, tasa_bcv)
       SELECT 1, 1, ?, ?, ?, ?, ?, 0 WHERE NOT EXISTS (SELECT 1 FROM usuarios)`
    ).bind(nombre, rif, direccion, telefono, email),
    db.prepare(
      `INSERT INTO usuarios (nombre, email, password_hash, rol, codigo_recuperacion_hash) SELECT ?, ?, ?, 'ADMIN', ? WHERE NOT EXISTS (SELECT 1 FROM usuarios)`
    ).bind(nombre, email, hash, await hashClave(codigo.replace(/-/g, ""))),
  ]);
  if (!r[1].meta.changes) return falla(c, 409, "El sistema ya está instalado.");
  const id = Number(r[1].meta.last_row_id);
  await abrirSesion(c, id);
  await auditar(c, id, "INSTALAR", email);
  return c.json({ ok: true, codigo_recuperacion: codigo }); // se muestra UNA vez: sirve para recuperar la clave del administrador
});

app.post("/api/login", async (c) => {
  const db = c.env.DB;
  const b = await leerJson(c);
  const email = String(b.email ?? "").trim().toLowerCase(), clave = String(b.clave ?? "");
  if (!email || !clave) return falla(c, 400, "Escribe tu correo y tu contraseña.");
  const llave = `${email}|${ip(c)}`, t = ahora();

  const lim = await db.prepare(`SELECT fallos, bloqueado_hasta FROM intentos_login WHERE clave = ?`).bind(llave)
    .first<{ fallos: number; bloqueado_hasta: number }>();
  if (lim && lim.bloqueado_hasta > t) return falla(c, 429, "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.");

  const u = await db.prepare(`SELECT id, password_hash, activo FROM usuarios WHERE email = ?`).bind(email)
    .first<{ id: number; password_hash: string; activo: number }>();
  const ok = await verificarClave(clave, u?.password_hash ?? CLAVE_FALSA);
  if (!u || !u.activo || !ok) { // un usuario desactivado recibe el mismo mensaje que una clave mala (no se revela quién existe)
    const fallos = (lim?.fallos ?? 0) + 1, bloquear = fallos >= 5;
    await db.prepare(
      `INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, ?, ?)
       ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta`
    ).bind(llave, bloquear ? 0 : fallos, bloquear ? t + 900 : 0).run();
    return falla(c, 401, "Correo o contraseña incorrectos.");
  }
  await db.batch([
    db.prepare(`DELETE FROM intentos_login WHERE clave = ?`).bind(llave),
    db.prepare(`DELETE FROM sesiones WHERE expira_en < ?`).bind(t),
  ]);
  await abrirSesion(c, u.id);
  await auditar(c, u.id, "LOGIN", email);
  return c.json({ ok: true });
});

// Recuperar la clave del ADMINISTRADOR con su código de recuperación (los demás usuarios piden al administrador que restablezca su clave).
// Mismo límite de intentos que el login. Al usarlo se cierran todas sus sesiones y se entrega un código NUEVO (el anterior queda sin uso).
app.post("/api/recuperar", async (c) => {
  const db = c.env.DB, b = await leerJson(c);
  const email = String(b.email ?? "").trim().toLowerCase(), codigo = normalizarCodigo(String(b.codigo ?? "")), nueva = String(b.clave_nueva ?? "");
  if (!email || !codigo) return falla(c, 400, "Escribe tu correo y tu código de recuperación.");
  if (nueva.length < 10) return falla(c, 400, "La clave nueva debe tener al menos 10 caracteres.");
  const llave = `rec|${email}|${ip(c)}`, t = ahora();
  const lim = await db.prepare(`SELECT fallos, bloqueado_hasta FROM intentos_login WHERE clave = ?`).bind(llave).first<{ fallos: number; bloqueado_hasta: number }>();
  if (lim && lim.bloqueado_hasta > t) return falla(c, 429, "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.");
  const u = await db.prepare(`SELECT id, codigo_recuperacion_hash AS h FROM usuarios WHERE email = ? AND rol = 'ADMIN' AND activo = 1`).bind(email).first<{ id: number; h: string | null }>();
  const ok = await verificarClave(codigo, u?.h ?? CLAVE_FALSA);
  if (!u || !u.h || !ok) {
    const fallos = (lim?.fallos ?? 0) + 1, bloquear = fallos >= 5;
    await db.prepare(`INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta`).bind(llave, bloquear ? 0 : fallos, bloquear ? t + 900 : 0).run();
    return falla(c, 401, "El correo o el código de recuperación no son correctos.");
  }
  const nuevoCodigo = codigoRecuperacion();
  await db.batch([
    db.prepare(`UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 0, codigo_recuperacion_hash = ? WHERE id = ?`).bind(await hashClave(nueva), await hashClave(nuevoCodigo.replace(/-/g, "")), u.id),
    db.prepare(`DELETE FROM sesiones WHERE usuario_id = ?`).bind(u.id),
    db.prepare(`DELETE FROM intentos_login WHERE clave = ?`).bind(llave),
  ]);
  await auditar(c, u.id, "RECUPERAR_CLAVE", email);
  return c.json({ ok: true, codigo_recuperacion: nuevoCodigo });
});

app.post("/api/logout", async (c) => {
  const token = getCookie(c, "sid");
  if (token) await c.env.DB.prepare(`DELETE FROM sesiones WHERE token_hash = ?`).bind(await sha256(token)).run();
  deleteCookie(c, "sid", { path: "/" });
  return c.json({ ok: true });
});

app.put("/api/config", async (c) => {
  const usuario = c.get("usuario"), b = await leerJson(c); // ya con sesión y permiso (control central)
  if (usuario.rol !== "ADMIN" && (!tiene(usuario.rol, "tasa") || Object.keys(b).some((k) => k !== "tasa_bcv")))
    return falla(c, 403, "Solo el administrador puede cambiar la configuración. Tú puedes actualizar la tasa BCV.");
  const sets: string[] = [], valores: unknown[] = [];

  for (const campo of OBLIGATORIOS) {
    if (!(campo in b)) continue;
    const v = String(b[campo] ?? "").trim().slice(0, 200);
    if (!v) return falla(c, 400, "Nombre, RIF y dirección fiscal no pueden quedar vacíos.");
    sets.push(`${campo} = ?`); valores.push(campo === "rif" ? v.toUpperCase() : v);
  }
  for (const campo of OPCIONALES) {
    if (!(campo in b)) continue;
    sets.push(`${campo} = ?`); valores.push(String(b[campo] ?? "").trim().slice(0, 300) || null);
  }
  if ("tasa_bcv" in b) {
    const tasa = Number(String(b.tasa_bcv).replace(",", "."));
    if (!Number.isFinite(tasa) || tasa <= 0 || tasa > 1e9) return falla(c, 400, "La tasa BCV debe ser un número mayor que 0.");
    sets.push("tasa_bcv = ?", "tasa_bcv_fecha = datetime('now')"); valores.push(tasa);
  }
  if (!sets.length) return falla(c, 400, "No hay cambios que guardar.");

  await c.env.DB.prepare(`UPDATE perfil_emisor SET ${sets.join(", ")} WHERE id = 1`).bind(...valores).run();
  await auditar(c, usuario.id, "CONFIG", Object.keys(b).join(","));
  return c.json({ ok: true });
});

app.route("/api/clientes", clientes);
app.route("/api/catalogo", catalogo);
app.route("/api/documentos", documentos);
app.route("/api/sistema", sistema);
app.route("/api/pagos", pagos);
app.route("/api/proveedores", proveedores);
app.route("/api/compras", compras);
app.route("/api/existencias", existencias);
app.route("/api/informes", informes);
app.route("/api/usuarios", usuarios);
app.route("/api/cuenta", cuenta);
app.route("/api/sistema/restaurar", restaurar);

app.notFound((c) => c.json({ ok: false, error: "No encontrado." }, 404));
app.onError((e, c) => {
  console.error(e);
  return c.json({ ok: false, error: "Error interno del servidor." }, 500);
});

export default app;
