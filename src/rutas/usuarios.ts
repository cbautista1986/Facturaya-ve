// Módulo USUARIOS Y CUENTA (Fase 7.1 + 2FA Administradores con Rate Limiting): /api/usuarios y /api/cuenta.
// Los permisos de cada rol viven en permisos.ts. Las claves temporales y los códigos de recuperación se muestran UNA sola vez: solo se guarda su huella.
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { cifrarSecreto, descifrarSecreto, exigirLlaveMaestra, llaveMaestraConfigurada } from "../cifrado";
import { EMAIL, ahora, auditar, falla, idParam, ip, leerJson, texto, type Ctx, type Env } from "../comun";
import { asegurarTablasMultiTenant, obtenerSuperAdminPrincipal, registrarCorreoDirectorio } from "../inquilinos";
import { ROLES, NOMBRE_ROL, esSuperAdmin, tiene } from "../permisos";
import { claveTemporal, codigoRecuperacion, hashClave, sha256, verificarClave } from "../seguridad";
import {
  construirUriOtpauth,
  generarCodigosRespaldo2fa,
  generarSecretoTotp,
  hashCodigoRespaldo2fa,
  verificarCodigoTotp,
  verificarYConsumirCodigoRespaldo2fa,
} from "../totp";

export const usuarios = new Hono<Env>();
export const cuenta = new Hono<Env>();
const MAX_USUARIOS = 30;
const mata = (db: D1Database, id: number, salvo?: string) => // cierra las sesiones de una persona (todas, o todas menos la de este navegador)
  salvo ? db.prepare(`DELETE FROM sesiones WHERE usuario_id = ? AND token_hash <> ?`).bind(id, salvo) : db.prepare(`DELETE FROM sesiones WHERE usuario_id = ?`).bind(id);

// ------------------------------------------------------------------ /api/usuarios
usuarios.get("/", async (c) => {
  const yo = c.get("usuario");
  const envObj = c.env as unknown as Record<string, unknown>;
  const esSuper = esSuperAdmin(yo.rol, yo.email, envObj);
  const { results } = await c.env.DB.prepare(`SELECT id, nombre, email, rol, activo, debe_cambiar_clave, creado_en FROM usuarios ORDER BY activo DESC, nombre COLLATE NOCASE`).all();
  const rolesDisponibles = ROLES.filter((r) => r !== "SUPER_ADMIN" || esSuper);
  return c.json({ ok: true, usuarios: results, roles: rolesDisponibles.map((r) => ({ clave: r, nombre: NOMBRE_ROL[r] })) });
});

usuarios.post("/", async (c) => {
  const b = await leerJson(c), db = c.env.DB, rawDb = c.get("rawDb") || db, inqCod = c.get("inquilinoCodigo") || "principal", yo = c.get("usuario");
  const envObj = c.env as unknown as Record<string, unknown>;
  const nombre = texto(b.nombre, 120), email = texto(b.email, 120).toLowerCase(), rol = texto(b.rol, 16);
  if (nombre.length < 2) return falla(c, 400, "Escribe el nombre de la persona.");
  if (!EMAIL.test(email)) return falla(c, 400, "El correo no es válido.");
  if (!(ROLES as readonly string[]).includes(rol)) return falla(c, 400, "Elige un rol válido: administrador, supervisor, cajero, bodega o contador.");
  if (rol === "SUPER_ADMIN" && !esSuperAdmin(yo.rol, yo.email, envObj)) return falla(c, 403, "Solo el Súper Administrador puede asignar ese rol.");
  await asegurarTablasMultiTenant(rawDb);
  const otroNegocio = await rawDb.prepare(`SELECT inquilino_codigo FROM _mt_directorio WHERE email = ?`).bind(email).first<{ inquilino_codigo: string }>();
  if (otroNegocio && otroNegocio.inquilino_codigo !== inqCod) {
    return falla(c, 409, "Ese correo ya está registrado en otro negocio del sistema. Usa un correo único.");
  }
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM usuarios`).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_USUARIOS) return falla(c, 409, `Ya hay ${MAX_USUARIOS} usuarios: desactiva o reutiliza alguno.`);
  const temporal = claveTemporal();
  try {
    const r = await db.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, debe_cambiar_clave) VALUES (?, ?, ?, ?, 1) RETURNING id`)
      .bind(nombre, email, await hashClave(temporal, envObj), rol).first<{ id: number }>();
    await registrarCorreoDirectorio(rawDb, email, inqCod, rol, envObj);
    await auditar(c, yo.id, "USUARIO_CREAR", `${email} ${rol}`);
    return c.json({ ok: true, id: r!.id, clave_temporal: temporal });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return falla(c, 409, "Ya existe un usuario con ese correo.");
    throw e;
  }
});

usuarios.put("/:id", async (c) => {
  const id = idParam(c), b = await leerJson(c), db = c.env.DB, rawDb = c.get("rawDb") || db, inqCod = c.get("inquilinoCodigo") || "principal", yo = c.get("usuario");
  const envObj = c.env as unknown as Record<string, unknown>;
  const u = await db.prepare(`SELECT id, nombre, email, rol, activo FROM usuarios WHERE id = ?`).bind(id).first<{ id: number; nombre: string; email: string; rol: string; activo: number }>();
  if (!u) return falla(c, 404, "Usuario no encontrado.");
  if (esSuperAdmin(u.rol, u.email, envObj) && !esSuperAdmin(yo.rol, yo.email, envObj)) return falla(c, 403, "No puedes modificar la cuenta del Súper Administrador.");
  const nombre = "nombre" in b ? texto(b.nombre, 120) : u.nombre, rol = "rol" in b ? texto(b.rol, 16) : u.rol, activo = "activo" in b ? (b.activo ? 1 : 0) : u.activo;
  if (nombre.length < 2) return falla(c, 400, "Escribe el nombre de la persona.");
  if (!(ROLES as readonly string[]).includes(rol)) return falla(c, 400, "Elige un rol válido.");
  if (rol === "SUPER_ADMIN" && !esSuperAdmin(yo.rol, yo.email, envObj)) return falla(c, 403, "Solo el Súper Administrador puede asignar ese rol.");
  // Siempre debe quedar al menos un administrador activo.
  const sigueAdmin = (rol === "ADMIN" || rol === "SUPER_ADMIN") && activo === 1 ? 1 : 0;
  const r = await db.prepare(
    `UPDATE usuarios SET nombre = ?, rol = ?, activo = ? WHERE id = ?
     AND (? = 1 OR NOT (rol IN ('ADMIN', 'SUPER_ADMIN') AND activo = 1) OR EXISTS (SELECT 1 FROM usuarios o WHERE o.id <> ? AND o.rol IN ('ADMIN', 'SUPER_ADMIN') AND o.activo = 1))`
  ).bind(nombre, rol, activo, id, sigueAdmin, id).run();
  if (!r.meta.changes) return falla(c, 409, "Debe quedar al menos un administrador activo.");
  if (!activo || rol !== u.rol) await mata(db, id).run();
  await asegurarTablasMultiTenant(rawDb);
  await registrarCorreoDirectorio(rawDb, u.email, inqCod, rol, envObj);
  await auditar(c, yo.id, "USUARIO_EDITAR", `${id} ${rol} ${activo ? "activo" : "desactivado"}`);
  return c.json({ ok: true });
});

usuarios.post("/:id/reset-clave", async (c) => {
  const id = idParam(c), db = c.env.DB, yo = c.get("usuario"), b = await leerJson(c).catch(() => ({} as Record<string, unknown>));
  const envObj = c.env as unknown as Record<string, unknown>;
  if (id === yo.id) return falla(c, 400, "Para cambiar tu propia clave usa «Mi cuenta».");
  const u = await db.prepare(`SELECT id, email, rol FROM usuarios WHERE id = ?`).bind(id).first<{ id: number; email: string; rol: string }>();
  if (!u) return falla(c, 404, "Usuario no encontrado.");
  if (esSuperAdmin(u.rol, u.email, envObj) && !esSuperAdmin(yo.rol, yo.email, envObj)) return falla(c, 403, "No puedes restablecer la clave del Súper Administrador.");
  const directa = String(b.clave_nueva ?? "").trim();
  if (directa && directa.length < 10) return falla(c, 400, "La contraseña nueva del empleado debe tener al menos 10 caracteres.");
  const claveFinal = directa || claveTemporal();
  const exigirCambio = directa ? 0 : 1;
  await db.batch([db.prepare(`UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = ? WHERE id = ?`).bind(await hashClave(claveFinal, envObj), exigirCambio, id), mata(db, id)]);
  await auditar(c, yo.id, "USUARIO_RESET_CLAVE", `${id}${directa ? " (directa)" : " (temporal)"}`);
  return c.json({ ok: true, clave_temporal: claveFinal, directa: !!directa });
});

// ------------------------------------------------------------------ /api/cuenta (la persona que tiene la sesión abierta)
cuenta.post("/clave", async (c) => {
  const b = await leerJson(c), db = c.env.DB, rawDb = c.get("rawDb") || db, yo = c.get("usuario");
  const envObj = c.env as unknown as Record<string, unknown>;
  const actual = String(b.actual ?? ""), nueva = String(b.nueva ?? "");
  if (nueva.length < 10) return falla(c, 400, "La clave nueva debe tener al menos 10 caracteres.");
  if (nueva === actual) return falla(c, 400, "La clave nueva debe ser distinta de la actual.");
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(actual, u.password_hash, envObj))) return falla(c, 400, "La clave actual no es correcta.");
  const mia = await sha256(getCookie(c, "sid") ?? ""), nuevoHash = await hashClave(nueva, envObj);
  await db.batch([db.prepare(`UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 0 WHERE id = ?`).bind(nuevoHash, yo.id), mata(db, yo.id, mia)]);
  if (esSuperAdmin(yo.rol, yo.email, envObj) && rawDb !== db) {
    const emailSuper = yo.email.trim().toLowerCase();
    await rawDb.prepare(`UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 0 WHERE lower(email) = ?`).bind(nuevoHash, emailSuper).run();
  }
  await auditar(c, yo.id, "CLAVE_CAMBIAR", "");
  return c.json({ ok: true });
});

// Genera (o reemplaza) el código de recuperación del administrador. Pide la clave actual; el código se ve una sola vez.
cuenta.post("/codigo-recuperacion", async (c) => {
  const b = await leerJson(c), db = c.env.DB, rawDb = c.get("rawDb") || db, yo = c.get("usuario");
  const envObj = c.env as unknown as Record<string, unknown>;
  if (!tiene(yo.rol, "admin", yo.email, envObj)) return falla(c, 403, "Solo el administrador tiene código de recuperación; si olvidas tu clave, pídele al administrador que la restablezca.");
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.clave ?? ""), u.password_hash, envObj))) return falla(c, 400, "La clave no es correcta.");
  const codigo = codigoRecuperacion(), hashCod = await hashClave(codigo.replace(/-/g, ""), envObj);
  await db.prepare(`UPDATE usuarios SET codigo_recuperacion_hash = ? WHERE id = ?`).bind(hashCod, yo.id).run();
  if (esSuperAdmin(yo.rol, yo.email, envObj) && rawDb !== db) {
    const emailSuper = yo.email.trim().toLowerCase();
    await rawDb.prepare(`UPDATE usuarios SET codigo_recuperacion_hash = ? WHERE lower(email) = ?`).bind(hashCod, emailSuper).run();
  }
  await auditar(c, yo.id, "CODIGO_RECUPERACION", "");
  return c.json({ ok: true, codigo });
});

// ------------------------------------------------------------------ /api/cuenta/2fa/* (TOTP RFC 6238 · SUPER_ADMIN y ADMIN con Rate Limiting)
type FilaTotp = {
  id: number;
  email: string;
  password_hash: string;
  totp_activo?: number | null;
  totp_secreto?: string | null;
  totp_pendiente?: string | null;
  totp_ultimo_paso?: number | null;
  totp_respaldo_json?: string | null;
};

async function resolverCuenta2fa(c: Ctx): Promise<{ dbTotp: D1Database; usuario: FilaTotp } | null> {
  const yo = c.get("usuario");
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const esSuper = esSuperAdmin(yo.rol, yo.email, envObj);
  if (!esSuper && yo.rol !== "ADMIN") return null;

  if (esSuper) {
    const superPrin = await obtenerSuperAdminPrincipal(rawDb, envObj);
    const emailObjetivo = (superPrin?.email || yo.email).trim().toLowerCase();
    const fila = await rawDb
      .prepare(
        `SELECT id, email, password_hash, totp_activo, totp_secreto, totp_pendiente, totp_ultimo_paso, totp_respaldo_json
         FROM usuarios WHERE lower(email) = ? LIMIT 1`
      )
      .bind(emailObjetivo)
      .first<FilaTotp>();
    return fila ? { dbTotp: rawDb, usuario: fila } : null;
  }

  const fila = await c.env.DB
    .prepare(
      `SELECT id, email, password_hash, totp_activo, totp_secreto, totp_pendiente, totp_ultimo_paso, totp_respaldo_json
       FROM usuarios WHERE id = ? LIMIT 1`
    )
    .bind(yo.id)
    .first<FilaTotp>();
  return fila ? { dbTotp: c.env.DB, usuario: fila } : null;
}

function contarRespaldos(json: string | null | undefined): number {
  if (!json) return 0;
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? a.length : 0;
  } catch {
    return 0;
  }
}

async function verificarBloqueo2fa(db: D1Database, email: string, ipCliente: string, t: number) {
  const llave = `2fa|${email}|${ipCliente}`;
  const llaveCuenta = `2fa_cuenta|${email}`;
  const [lim, limCuenta] = await Promise.all([
    db.prepare(`SELECT fallos, bloqueado_hasta FROM intentos_login WHERE clave = ?`).bind(llave).first<{ fallos: number; bloqueado_hasta: number }>(),
    db.prepare(`SELECT fallos, bloqueado_hasta FROM intentos_login WHERE clave = ?`).bind(llaveCuenta).first<{ fallos: number; bloqueado_hasta: number }>(),
  ]);
  const bloqueado = Boolean((lim && lim.bloqueado_hasta > t) || (limCuenta && limCuenta.bloqueado_hasta > t));
  return { bloqueado, lim, limCuenta, llave, llaveCuenta };
}

async function registrarFallo2fa(
  db: D1Database,
  estadoLim: Awaited<ReturnType<typeof verificarBloqueo2fa>>,
  t: number
) {
  const fallos = (estadoLim.lim?.fallos ?? 0) + 1;
  const bloquear = fallos >= 5;
  const fallosCuenta = (estadoLim.limCuenta?.fallos ?? 0) + 1;
  const bloquearCuenta = fallosCuenta >= 10;
  await db.batch([
    db
      .prepare(
        `INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, ?, ?)
         ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta`
      )
      .bind(estadoLim.llave, bloquear ? 0 : fallos, bloquear ? t + 900 : 0),
    db
      .prepare(
        `INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, ?, ?)
         ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta`
      )
      .bind(estadoLim.llaveCuenta, bloquearCuenta ? 0 : fallosCuenta, bloquearCuenta ? t + 900 : 0),
  ]);
}

async function limpiarIntentos2fa(db: D1Database, llave: string, llaveCuenta: string) {
  await db.prepare(`DELETE FROM intentos_login WHERE clave IN (?, ?)`).bind(llave, llaveCuenta).run().catch(() => {});
}

cuenta.get("/2fa/estado", async (c) => {
  const ctx2fa = await resolverCuenta2fa(c);
  if (!ctx2fa) return falla(c, 403, "La autenticación en 2 pasos (2FA) está disponible para Administradores y Súper Administrador.");
  const envObj = c.env as unknown as Record<string, unknown>;
  const u = ctx2fa.usuario;
  return c.json({
    ok: true,
    activo: Boolean(Number(u.totp_activo ?? 0) === 1 && u.totp_secreto),
    pendiente: Boolean(u.totp_pendiente),
    codigos_respaldo_restantes: contarRespaldos(u.totp_respaldo_json),
    master_key_lista: llaveMaestraConfigurada(envObj) || String(envObj.PERMITIR_LLAVE_EN_BD ?? "") === "1",
  });
});

cuenta.post("/2fa/iniciar", async (c) => {
  const yo = c.get("usuario"), b = await leerJson(c), ipCliente = ip(c), t = ahora();
  const ctx2fa = await resolverCuenta2fa(c);
  if (!ctx2fa) return falla(c, 403, "La autenticación en 2 pasos (2FA) está disponible para Administradores y Súper Administrador.");
  const { dbTotp, usuario: u } = ctx2fa;
  const emailLimpio = u.email.trim().toLowerCase();

  const lim = await verificarBloqueo2fa(dbTotp, emailLimpio, ipCliente, t);
  if (lim.bloqueado) return falla(c, 429, "Demasiados intentos en verificación 2FA. Espera 15 minutos e inténtalo de nuevo.");

  const envObj = { ...(c.env as unknown as Record<string, unknown>), DB: dbTotp };
  exigirLlaveMaestra(envObj);
  if (!(await verificarClave(String(b.clave ?? ""), u.password_hash, envObj))) {
    await registrarFallo2fa(dbTotp, lim, t);
    return falla(c, 401, "Tu contraseña actual no es correcta.");
  }
  await limpiarIntentos2fa(dbTotp, lim.llave, lim.llaveCuenta);

  const secreto = generarSecretoTotp();
  const cifrado = await cifrarSecreto(secreto, envObj);
  await dbTotp.prepare(`UPDATE usuarios SET totp_pendiente = ? WHERE id = ?`).bind(cifrado, u.id).run();
  await auditar(c, yo.id, "2FA_INICIAR", emailLimpio);
  return c.json({
    ok: true,
    secreto,
    otpauth_uri: construirUriOtpauth({ secreto, email: emailLimpio, emisor: "FacturaYa Venezuela" }),
  });
});

cuenta.post("/2fa/activar", async (c) => {
  const yo = c.get("usuario"), b = await leerJson(c), ipCliente = ip(c), t = ahora();
  const ctx2fa = await resolverCuenta2fa(c);
  if (!ctx2fa) return falla(c, 403, "La autenticación en 2 pasos (2FA) está disponible para Administradores y Súper Administrador.");
  const { dbTotp, usuario: u } = ctx2fa;
  const emailLimpio = u.email.trim().toLowerCase();

  const lim = await verificarBloqueo2fa(dbTotp, emailLimpio, ipCliente, t);
  if (lim.bloqueado) return falla(c, 429, "Demasiados intentos en verificación 2FA. Espera 15 minutos e inténtalo de nuevo.");

  if (!u.totp_pendiente) {
    return falla(c, 400, "Primero inicia la configuración 2FA para generar tu código QR.");
  }
  const envObj = { ...(c.env as unknown as Record<string, unknown>), DB: dbTotp };
  const secretoPlano = await descifrarSecreto(u.totp_pendiente, envObj);
  if (!secretoPlano) return falla(c, 400, "No se pudo leer el secreto 2FA pendiente. Inicia la configuración nuevamente.");
  const ver = await verificarCodigoTotp(secretoPlano, String(b.codigo ?? ""), { ventana: 1 });
  if (!ver.ok || !ver.paso) {
    await registrarFallo2fa(dbTotp, lim, t);
    return falla(c, 400, "El código de 6 dígitos no coincide. Revisa la hora de tu teléfono e inténtalo otra vez.");
  }
  await limpiarIntentos2fa(dbTotp, lim.llave, lim.llaveCuenta);

  const codigosRespaldo = generarCodigosRespaldo2fa(8);
  const hashes = await Promise.all(codigosRespaldo.map((cod) => hashCodigoRespaldo2fa(cod, emailLimpio)));
  await dbTotp
    .prepare(
      `UPDATE usuarios
       SET totp_activo = 1, totp_secreto = ?, totp_pendiente = NULL, totp_ultimo_paso = ?, totp_respaldo_json = ?
       WHERE id = ?`
    )
    .bind(u.totp_pendiente, ver.paso, JSON.stringify(hashes), u.id)
    .run();
  await auditar(c, yo.id, "2FA_ACTIVAR", emailLimpio);
  return c.json({ ok: true, codigos_respaldo: codigosRespaldo });
});

cuenta.post("/2fa/desactivar", async (c) => {
  const yo = c.get("usuario"), b = await leerJson(c), ipCliente = ip(c), t = ahora();
  const ctx2fa = await resolverCuenta2fa(c);
  if (!ctx2fa) return falla(c, 403, "La autenticación en 2 pasos (2FA) está disponible para Administradores y Súper Administrador.");
  const { dbTotp, usuario: u } = ctx2fa;
  const emailLimpio = u.email.trim().toLowerCase();

  const lim = await verificarBloqueo2fa(dbTotp, emailLimpio, ipCliente, t);
  if (lim.bloqueado) return falla(c, 429, "Demasiados intentos en verificación 2FA. Espera 15 minutos e inténtalo de nuevo.");

  const envObj = { ...(c.env as unknown as Record<string, unknown>), DB: dbTotp };
  if (!(await verificarClave(String(b.clave ?? ""), u.password_hash, envObj))) {
    await registrarFallo2fa(dbTotp, lim, t);
    return falla(c, 401, "Tu contraseña actual no es correcta.");
  }
  if (Number(u.totp_activo ?? 0) === 1 && u.totp_secreto) {
    const codigo = String(b.codigo ?? "").trim();
    if (!codigo) return falla(c, 400, "Escribe un código de 6 dígitos de tu autenticador (o un código de respaldo) para desactivar el 2FA.");
    const secretoPlano = await descifrarSecreto(u.totp_secreto, envObj);
    const verTotp = secretoPlano
      ? await verificarCodigoTotp(secretoPlano, codigo, { ultimoPaso: Number(u.totp_ultimo_paso ?? 0) })
      : { ok: false };
    const verRespaldo = !verTotp.ok
      ? await verificarYConsumirCodigoRespaldo2fa(codigo, emailLimpio, u.totp_respaldo_json)
      : { ok: false };
    if (!verTotp.ok && !verRespaldo.ok) {
      await registrarFallo2fa(dbTotp, lim, t);
      return falla(c, 401, "El código 2FA o de respaldo no es válido.");
    }
  }
  await limpiarIntentos2fa(dbTotp, lim.llave, lim.llaveCuenta);

  await dbTotp
    .prepare(
      `UPDATE usuarios
       SET totp_activo = 0, totp_secreto = NULL, totp_pendiente = NULL, totp_ultimo_paso = 0, totp_respaldo_json = NULL
       WHERE id = ?`
    )
    .bind(u.id)
    .run();
  await auditar(c, yo.id, "2FA_DESACTIVAR", emailLimpio);
  return c.json({ ok: true });
});
