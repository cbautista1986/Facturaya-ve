import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { migrar } from "./migraciones";
import { CLAVE_FALSA, claveTemporal, codigoRecuperacion, hashClave, normalizarCodigo, sha256, tokenAleatorio, verificarClave } from "./seguridad";
import { EMAIL_SUPER_ADMIN, NOMBRE_ROL, esSuperAdmin, permisosDe, permitido, sinCostos, tiene, veCostos } from "./permisos";
import { enviarCorreo } from "./correo";
import { asegurarTablasMultiTenant, buscarInquilinoPorCorreo, obtenerDbInquilino, registrarCorreoDirectorio, type InquilinoInfo } from "./inquilinos";
import { usuarios, cuenta } from "./rutas/usuarios";
import { restaurar } from "./rutas/restaurar";
import { EMAIL, RIF, ahora, auditar, falla, ip, leerJson, modoActual, usuarioActual, type Ctx, type Env } from "./comun";
import { aRifSeniat } from "../public/dinero.js";
import clientes from "./rutas/clientes";
import catalogo from "./rutas/catalogo";
import documentos from "./rutas/documentos";
import sistema from "./rutas/sistema";
import pagos from "./rutas/pagos";
import proveedores from "./rutas/proveedores";
import compras from "./rutas/compras";
import existencias from "./rutas/existencias";
import informes from "./rutas/informes";
import inquilinos from "./rutas/inquilinos";

const app = new Hono<Env>();
const SESION_SEGUNDOS = 60 * 60 * 24 * 7;

// Campos del negocio que el administrador puede editar (lista blanca: nada más se puede tocar)
const OBLIGATORIOS = ["nombre_razon_social", "rif", "direccion_fiscal"];
const OPCIONALES = ["telefono", "email", "datos_pago_movil", "datos_transferencia", "datos_zelle", "datos_binance", "datos_paypal"];
const COLUMNAS_NEGOCIO = [...OBLIGATORIOS, ...OPCIONALES, "logo_base64", "tasa_bcv", "tasa_bcv_fecha", "medio_facturacion", "igtf_activo"].join(", ");

function fijarCookieInquilino(c: Ctx, codigo: string) {
  const url = new URL(c.req.url);
  const esHttps = c.req.header("x-forwarded-proto") === "https" || url.protocol === "https:";
  const enIframePreview = url.hostname.endsWith(".run.app");
  setCookie(c, "inq", codigo, {
    httpOnly: true, sameSite: enIframePreview && esHttps ? "None" : "Lax", path: "/", maxAge: SESION_SEGUNDOS,
    secure: enIframePreview ? esHttps : url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
  });
}

async function abrirSesion(c: Ctx, usuarioId: number, inquilinoCodigo = "principal") {
  const token = tokenAleatorio();
  await c.env.DB.prepare(`INSERT INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)`)
    .bind(await sha256(token), usuarioId, ahora() + SESION_SEGUNDOS).run();
  const url = new URL(c.req.url);
  const esHttps = c.req.header("x-forwarded-proto") === "https" || url.protocol === "https:";
  const enIframePreview = url.hostname.endsWith(".run.app");
  setCookie(c, "sid", token, {
    httpOnly: true, sameSite: enIframePreview && esHttps ? "None" : "Lax", path: "/", maxAge: SESION_SEGUNDOS,
    secure: enIframePreview ? esHttps : url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
  });
  fijarCookieInquilino(c, inquilinoCodigo);
}

// La base de datos principal y el enrutador Multi-Tenant se preparan en cada petición
let migradoPrincipal = false;
app.use("/api/*", async (c, next) => {
  const rawDb = c.env.DB;
  c.set("rawDb", rawDb);
  if (!migradoPrincipal) {
    await migrar(rawDb);
    await asegurarTablasMultiTenant(rawDb);
    migradoPrincipal = true;
  }
  const inqCookie = getCookie(c, "inq") || "principal";
  c.set("inquilinoCodigo", inqCookie);
  if (inqCookie !== "principal") {
    const dbInq = obtenerDbInquilino(c.env as unknown as Record<string, unknown>, inqCookie);
    c.env = { ...c.env, DB: dbInq };
  }
  await next();
  c.res.headers.set("Cache-Control", "no-store");
});

// CONTROL CENTRAL DE PERMISOS (Fase 7.1 + Multi-Tenant): toda petición a /api pasa por aquí antes de llegar a su módulo.
const PUBLICAS = new Set(["/api/estado", "/api/instalar", "/api/login", "/api/logout", "/api/recuperar", "/api/recuperar-correo"]);
app.use("/api/*", async (c, next) => {
  const ruta = c.req.path;
  if (PUBLICAS.has(ruta)) return next();
  const u = await usuarioActual(c);
  if (!u) return falla(c, 401, "Inicia sesión para continuar.");
  c.set("usuario", u);
  const inqCod = c.get("inquilinoCodigo") || "principal";
  if (inqCod !== "principal" && !esSuperAdmin(u.rol, u.email)) {
    const rawDb = c.get("rawDb") || c.env.DB;
    const estadoInq = await rawDb.prepare(`SELECT activo FROM _mt_inquilinos WHERE codigo = ?`).bind(inqCod).first<{ activo: number }>();
    if (estadoInq && estadoInq.activo === 0) {
      return falla(c, 403, "⚠️ El servicio de facturación de este negocio está temporalmente suspendido. Comunícate con soporte de FacturaYa Venezuela.");
    }
  }
  if (!permitido(u.rol, c.req.method, ruta, u.email)) return falla(c, 403, "Tu usuario no tiene permiso para esto.");
  if (u.debe_cambiar_clave && ruta !== "/api/cuenta/clave") return c.json({ ok: false, error: "Debes cambiar tu clave temporal antes de continuar.", cambiar_clave: true }, 403);
  // Mientras se restaura un respaldo nadie guarda nada (la restauración la hace UNA persona de principio a fin)
  if (c.req.method !== "GET" && !ruta.startsWith("/api/sistema/restaurar/") && (await c.env.DB.prepare(`SELECT 1 FROM ajustes WHERE clave = 'restauracion'`).first()))
    return c.json({ ok: false, error: "El sistema está restaurando un respaldo. Espera a que el administrador termine.", restaurando: true }, 423);
  await next();
  if (!veCostos(u.rol, u.email) && (c.res.headers.get("content-type") ?? "").includes("application/json")) { // quien no ve costos tampoco los recibe, aunque la pantalla no los pida
    const datos = await c.res.clone().json().catch(() => null);
    if (datos) c.res = new Response(JSON.stringify(sinCostos(datos)), { status: c.res.status, headers: c.res.headers });
  }
});

app.get("/api/estado", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const hayAdmin = await rawDb.prepare(`SELECT 1 AS x FROM usuarios LIMIT 1`).first();
  if (!hayAdmin) return c.json({ instalado: false });
  const usuario = await usuarioActual(c);
  if (!usuario) return c.json({ instalado: true, sesion: false });
  const inqCod = c.get("inquilinoCodigo") || "principal";
  if (inqCod !== "principal" && !esSuperAdmin(usuario.rol, usuario.email)) {
    const estadoInq = await rawDb.prepare(`SELECT activo FROM _mt_inquilinos WHERE codigo = ?`).bind(inqCod).first<{ activo: number }>();
    if (estadoInq && estadoInq.activo === 0) {
      return c.json({ instalado: true, sesion: false, suspendido: true });
    }
  }
  const negocio = await c.env.DB.prepare(`SELECT ${COLUMNAS_NEGOCIO} FROM perfil_emisor WHERE id = 1`).first<Record<string, unknown>>();
  if (negocio && typeof negocio.rif === "string") {
    const rifFormateado = aRifSeniat(negocio.rif);
    if (rifFormateado && rifFormateado !== negocio.rif) {
      negocio.rif = rifFormateado;
      await c.env.DB.prepare(`UPDATE perfil_emisor SET rif = ? WHERE id = 1`).bind(rifFormateado).run().catch(() => {});
    }
  }
  const esSuper = esSuperAdmin(usuario.rol, usuario.email);
  const rolEfectivo = esSuper ? "SUPER_ADMIN" : usuario.rol;
  let listaInquilinos: InquilinoInfo[] = [];
  if (esSuper) {
    await asegurarTablasMultiTenant(rawDb);
    const { results } = await rawDb.prepare(
      `SELECT codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, plan_usd, activo, creado_en
       FROM _mt_inquilinos ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en DESC`
    ).all<InquilinoInfo>();
    listaInquilinos = results;
  }
  return c.json({
    instalado: true, sesion: true,
    usuario: { ...usuario, rol_nombre: NOMBRE_ROL[rolEfectivo] ?? usuario.rol, es_super: esSuper },
    permisos: permisosDe(usuario.rol, usuario.email), ve_costos: veCostos(usuario.rol, usuario.email),
    restaurando: !!(await c.env.DB.prepare(`SELECT 1 FROM ajustes WHERE clave = 'restauracion'`).first()),
    negocio, modo: await modoActual(c.env.DB),
    inquilino_actual: inqCod,
    ...(esSuper ? { inquilinos: listaInquilinos } : {}),
  });
});

// Instalador inicial del negocio principal (solo funciona cuando la base principal aún no tiene usuarios).
app.post("/api/instalar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  c.env = { ...c.env, DB: rawDb };
  if (await rawDb.prepare(`SELECT 1 FROM usuarios LIMIT 1`).first()) return falla(c, 409, "El sistema ya está instalado.");
  const b = await leerJson(c);
  const t = (k: string) => String(b[k] ?? "").trim();
  const nombre = t("nombre").slice(0, 120), rifBruto = t("rif").toUpperCase(), direccion = t("direccion").slice(0, 200);
  const telefono = t("telefono").slice(0, 40) || null, email = t("email").toLowerCase();
  const clave = String(b.clave ?? "");
  if (nombre.length < 2) return falla(c, 400, "Escribe el nombre del negocio.");
  if (!RIF.test(rifBruto)) return falla(c, 400, "RIF no válido (ejemplo: V-18529773-6 o J-12345678-9).");
  const rif = aRifSeniat(rifBruto);
  if (direccion.length < 5) return falla(c, 400, "Escribe la dirección fiscal.");
  if (!EMAIL.test(email)) return falla(c, 400, "El correo no es válido.");
  if (clave.length < 10) return falla(c, 400, "La contraseña debe tener al menos 10 caracteres.");

  const medioElegido = t("medio_facturacion") === "IMPRENTA_DIGITAL" ? "IMPRENTA_DIGITAL" : "APP_SENIAT";
  const rolInicial = esSuperAdmin("ADMIN", email) ? "SUPER_ADMIN" : "ADMIN";
  const hash = await hashClave(clave), codigo = codigoRecuperacion();
  const r = await rawDb.batch([
    rawDb.prepare(
      `INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, telefono, email, tasa_bcv, medio_facturacion)
       SELECT 1, 1, ?, ?, ?, ?, ?, 0, ? WHERE NOT EXISTS (SELECT 1 FROM usuarios)`
    ).bind(nombre, rif, direccion, telefono, email, medioElegido),
    rawDb.prepare(
      `INSERT INTO usuarios (nombre, email, password_hash, rol, codigo_recuperacion_hash) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM usuarios)`
    ).bind(nombre, email, hash, rolInicial, await hashClave(codigo.replace(/-/g, ""))),
  ]);
  if (!r[1].meta.changes) return falla(c, 409, "El sistema ya está instalado.");
  const id = Number(r[1].meta.last_row_id);
  await asegurarTablasMultiTenant(rawDb);
  await rawDb.prepare(
    `INSERT OR REPLACE INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, plan_usd, activo)
     VALUES ('principal', 'PRINCIPAL', ?, ?, ?, ?, ?, ?, ?, 0, 1)`
  ).bind(nombre, rif, direccion, telefono || "", nombre, email, medioElegido).run();
  await registrarCorreoDirectorio(rawDb, email, "principal", rolInicial);
  await abrirSesion(c, id, "principal");
  await auditar(c, id, "INSTALAR", email);
  return c.json({ ok: true, codigo_recuperacion: codigo });
});

app.post("/api/login", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const b = await leerJson(c);
  const email = String(b.email ?? "").trim().toLowerCase(), clave = String(b.clave ?? "");
  if (!email || !clave) return falla(c, 400, "Escribe tu correo y tu contraseña.");

  const infoInq = await buscarInquilinoPorCorreo(rawDb, email);
  if (!infoInq.activo) {
    return falla(c, 403, "⚠️ El servicio de facturación de este negocio está temporalmente suspendido. Comunícate con soporte de FacturaYa Venezuela.");
  }
  const db = obtenerDbInquilino({ ...(c.env as unknown as Record<string, unknown>), DB: rawDb }, infoInq.codigo);
  await migrar(db);
  c.env = { ...c.env, DB: db };
  c.set("inquilinoCodigo", infoInq.codigo);

  const llave = `${email}|${ip(c)}`, t = ahora();
  const lim = await db.prepare(`SELECT fallos, bloqueado_hasta FROM intentos_login WHERE clave = ?`).bind(llave)
    .first<{ fallos: number; bloqueado_hasta: number }>();
  if (lim && lim.bloqueado_hasta > t) return falla(c, 429, "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.");

  let u = await db.prepare(`SELECT id, password_hash, activo FROM usuarios WHERE email = ?`).bind(email)
    .first<{ id: number; password_hash: string; activo: number }>();

  // Si es el Súper Admin entrando a un inquilino donde aún no estaba sincronizado su usuario, sincronizarlo desde principal
  if (!u && email === EMAIL_SUPER_ADMIN && infoInq.codigo !== "principal") {
    const uPrin = await rawDb.prepare(`SELECT nombre, email, password_hash, codigo_recuperacion_hash FROM usuarios WHERE email = ?`).bind(email).first<Record<string, any>>();
    if (uPrin) {
      await db.prepare(
        `INSERT OR IGNORE INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave, codigo_recuperacion_hash)
         VALUES (?, ?, ?, 'SUPER_ADMIN', 1, 0, ?)`
      ).bind(uPrin.nombre, email, uPrin.password_hash, uPrin.codigo_recuperacion_hash).run();
      u = await db.prepare(`SELECT id, password_hash, activo FROM usuarios WHERE email = ?`).bind(email).first<{ id: number; password_hash: string; activo: number }>();
    }
  }

  const ok = await verificarClave(clave, u?.password_hash ?? CLAVE_FALSA);
  if (!u || !u.activo || !ok) {
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
  await abrirSesion(c, u.id, infoInq.codigo);
  await auditar(c, u.id, "LOGIN", email);
  return c.json({ ok: true, inquilino_actual: infoInq.codigo });
});

// Recuperar la clave del ADMINISTRADOR con su código de recuperación.
app.post("/api/recuperar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB, b = await leerJson(c);
  const email = String(b.email ?? "").trim().toLowerCase(), codigo = normalizarCodigo(String(b.codigo ?? "")), nueva = String(b.clave_nueva ?? "");
  if (!email || !codigo) return falla(c, 400, "Escribe tu correo y tu código de recuperación.");
  if (nueva.length < 10) return falla(c, 400, "La clave nueva debe tener al menos 10 caracteres.");

  const infoInq = await buscarInquilinoPorCorreo(rawDb, email);
  if (!infoInq.activo) return falla(c, 403, "⚠️ El servicio de este negocio está temporalmente suspendido.");
  const db = obtenerDbInquilino({ ...(c.env as unknown as Record<string, unknown>), DB: rawDb }, infoInq.codigo);
  await migrar(db);
  c.env = { ...c.env, DB: db };

  const llave = `rec|${email}|${ip(c)}`, t = ahora();
  const lim = await db.prepare(`SELECT fallos, bloqueado_hasta FROM intentos_login WHERE clave = ?`).bind(llave).first<{ fallos: number; bloqueado_hasta: number }>();
  if (lim && lim.bloqueado_hasta > t) return falla(c, 429, "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.");
  const u = await db.prepare(`SELECT id, codigo_recuperacion_hash AS h FROM usuarios WHERE email = ? AND rol IN ('ADMIN', 'SUPER_ADMIN') AND activo = 1`).bind(email).first<{ id: number; h: string | null }>();
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

// Recuperación jerárquica por correo: cualquier usuario solicita recuperar su clave, y llega al correo del Dueño (ADMIN) del negocio.
app.post("/api/recuperar-correo", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB, b = await leerJson(c);
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) return falla(c, 400, "Escribe un correo electrónico válido.");

  const infoInq = await buscarInquilinoPorCorreo(rawDb, email);
  if (!infoInq.activo) return falla(c, 403, "⚠️ El servicio de este negocio está temporalmente suspendido.");
  const db = obtenerDbInquilino({ ...(c.env as unknown as Record<string, unknown>), DB: rawDb }, infoInq.codigo);
  await migrar(db);
  c.env = { ...c.env, DB: db };

  const llave = `reccor|${email}|${ip(c)}`, t = ahora();
  const lim = await db.prepare(`SELECT fallos, bloqueado_hasta FROM intentos_login WHERE clave = ?`).bind(llave).first<{ fallos: number; bloqueado_hasta: number }>();
  if (lim && lim.bloqueado_hasta > t) return falla(c, 429, "Ya se envió una solicitud recientemente. Espera 15 minutos.");

  const u = await db.prepare(`SELECT id, nombre, email, rol, activo FROM usuarios WHERE email = ? AND activo = 1`).bind(email).first<{ id: number; nombre: string; email: string; rol: string; activo: number }>();
  if (!u) {
    const fallos = (lim?.fallos ?? 0) + 1;
    await db.prepare(`INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta`).bind(llave, fallos >= 4 ? 0 : fallos, fallos >= 4 ? t + 900 : 0).run();
    return falla(c, 404, "No encontramos un usuario activo con ese correo.");
  }

  const admins = await db.prepare(`SELECT email, nombre FROM usuarios WHERE rol IN ('ADMIN', 'SUPER_ADMIN') AND activo = 1 ORDER BY CASE WHEN rol = 'ADMIN' THEN 0 ELSE 1 END, id ASC`).all<{ email: string; nombre: string }>();
  const perfil = await db.prepare(`SELECT nombre_razon_social, rif, email FROM perfil_emisor WHERE id = 1`).first<{ nombre_razon_social: string; rif: string; email: string | null }>();
  const destinatarios = [...new Set([
    ...admins.results.map((a) => a.email),
    ...(perfil?.email ? [perfil.email] : []),
    EMAIL_SUPER_ADMIN,
  ].filter(Boolean))];

  const temporal = claveTemporal();
  const envio = await enviarCorreo(db, c.env as unknown as Record<string, unknown>, {
    para: destinatarios,
    asunto: `🔐 Recuperación de clave (${u.nombre} - ${NOMBRE_ROL[u.rol] ?? u.rol}) · ${perfil?.nombre_razon_social ?? "FacturaYa"}`,
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:20px;border:1px solid #dde3ec;border-radius:16px">
      <h2 style="margin-top:0;color:#1A73E8">🔐 Solicitud de restablecimiento de contraseña</h2>
      <p>Se ha solicitado restablecer la contraseña en <b>${perfil?.nombre_razon_social ?? "FacturaYa"}</b> (${perfil?.rif ?? ""}).</p>
      <p>Por seguridad jerárquica, esta clave temporal se envía <b>exclusivamente al Administrador Principal / Dueño del negocio</b>:</p>
      <ul style="background:#f8fafd;padding:14px 28px;border-radius:12px">
        <li><b>Usuario solicitante:</b> ${u.nombre} (${u.email})</li>
        <li><b>Rol:</b> ${NOMBRE_ROL[u.rol] ?? u.rol}</li>
      </ul>
      <p style="margin-bottom:6px"><b>Clave temporal de un solo uso:</b></p>
      <div style="font:700 22px monospace;background:#fff4e0;padding:14px;text-align:center;border-radius:12px;border:1px dashed #e37400;letter-spacing:2px">${temporal}</div>
      <p style="font-size:13px;color:#5f6b7a;margin-top:14px">Al iniciar sesión con esta clave temporal, el sistema obligará a elegir una contraseña nueva.</p>
    </div>`,
    texto: `Recuperación de clave para ${u.nombre} (${u.email} - ${u.rol}). Clave temporal: ${temporal}`,
  });

  if (!envio.ok) return falla(c, 400, envio.error || "No se pudo enviar el correo de recuperación.");

  await db.batch([
    db.prepare(`UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 1 WHERE id = ?`).bind(await hashClave(temporal), u.id),
    db.prepare(`DELETE FROM sesiones WHERE usuario_id = ?`).bind(u.id),
    db.prepare(`INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, 0, ?)
      ON CONFLICT(clave) DO UPDATE SET fallos = 0, bloqueado_hasta = excluded.bloqueado_hasta`).bind(llave, t + 300),
  ]);
  await auditar(c, u.id, "RECUPERAR_CORREO", `${u.email} -> enviado a administrador`);
  return c.json({ ok: true, enviado_a: admins.results[0]?.email ?? EMAIL_SUPER_ADMIN });
});

app.post("/api/logout", async (c) => {
  const token = getCookie(c, "sid");
  if (token) await c.env.DB.prepare(`DELETE FROM sesiones WHERE token_hash = ?`).bind(await sha256(token)).run();
  const esHttps = c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
  deleteCookie(c, "sid", { path: "/", sameSite: esHttps ? "None" : "Lax", secure: esHttps });
  deleteCookie(c, "inq", { path: "/", sameSite: esHttps ? "None" : "Lax", secure: esHttps });
  return c.json({ ok: true });
});

app.put("/api/config", async (c) => {
  const usuario = c.get("usuario"), b = await leerJson(c);
  const rawDb = c.get("rawDb") || c.env.DB, inqCod = c.get("inquilinoCodigo") || "principal";
  if (!tiene(usuario.rol, "admin", usuario.email) && (!tiene(usuario.rol, "tasa", usuario.email) || Object.keys(b).some((k) => k !== "tasa_bcv")))
    return falla(c, 403, "Solo el administrador puede cambiar la configuración. Tú puedes actualizar la tasa BCV.");
  const sets: string[] = [], valores: unknown[] = [];

  for (const campo of OBLIGATORIOS) {
    if (!(campo in b)) continue;
    const v = String(b[campo] ?? "").trim().slice(0, 200);
    if (!v) return falla(c, 400, "Nombre, RIF y dirección fiscal no pueden quedar vacíos.");
    if (campo === "rif" && !RIF.test(v.toUpperCase())) return falla(c, 400, "RIF no válido (ejemplo: V-18529773-6 o J-12345678-9).");
    sets.push(`${campo} = ?`); valores.push(campo === "rif" ? aRifSeniat(v.toUpperCase()) : v);
  }
  for (const campo of OPCIONALES) {
    if (!(campo in b)) continue;
    sets.push(`${campo} = ?`); valores.push(String(b[campo] ?? "").trim().slice(0, 300) || null);
  }
  if ("logo_base64" in b) {
    const logo = String(b.logo_base64 ?? "").trim();
    if (logo && (!/^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(logo) || logo.length > 220_000)) {
      return falla(c, 400, "El logo debe ser una imagen PNG o JPG válida (máximo 150 KB).");
    }
    sets.push("logo_base64 = ?");
    valores.push(logo || null);
  }
  if ("tasa_bcv" in b) {
    const tasa = Number(String(b.tasa_bcv).replace(",", "."));
    if (!Number.isFinite(tasa) || tasa <= 0 || tasa > 1e9) return falla(c, 400, "La tasa BCV debe ser un número mayor que 0.");
    sets.push("tasa_bcv = ?", "tasa_bcv_fecha = datetime('now')"); valores.push(tasa);
  }
  if ("igtf_activo" in b) {
    sets.push("igtf_activo = ?");
    valores.push(b.igtf_activo === true || b.igtf_activo === 1 || b.igtf_activo === "1" || b.igtf_activo === "on" ? 1 : 0);
  }
  if (!sets.length) return falla(c, 400, "No hay cambios que guardar.");

  await c.env.DB.prepare(`UPDATE perfil_emisor SET ${sets.join(", ")} WHERE id = 1`).bind(...valores).run();
  if ("nombre_razon_social" in b || "rif" in b) {
    const p = await c.env.DB.prepare(`SELECT nombre_razon_social, rif, direccion_fiscal, telefono FROM perfil_emisor WHERE id = 1`).first<Record<string, any>>();
    if (p) {
      await rawDb.prepare(`UPDATE _mt_inquilinos SET nombre_negocio = ?, rif = ?, direccion = ?, telefono = ? WHERE codigo = ?`)
        .bind(p.nombre_razon_social, p.rif, p.direccion_fiscal || "", p.telefono || "", inqCod).run().catch(() => {});
    }
  }
  await auditar(c, usuario.id, "CONFIG", Object.keys(b).join(","));
  return c.json({ ok: true });
});

app.route("/api/inquilinos", inquilinos);
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
