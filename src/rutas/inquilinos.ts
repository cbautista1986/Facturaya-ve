// Módulo INQUILINOS (Multi-Tenant · Exclusivo del Súper Administrador Cristian): /api/inquilinos
// Permite dar de alta nuevos clientes/negocios desde el panel web sin entrar a Cloudflare,
// asignarles su correo principal de dueño, cambiar de negocio activo para configurar su API de Brevo / Imprenta Digital,
// y suspender o reactivar clientes por pago mensual ($10/mes).
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { aRifSeniat } from "../../public/dinero.js";
import { EMAIL, RIF, ahora, auditar, falla, leerJson, requiereSesion, texto, type Env } from "../comun";
import { enviarCorreo } from "../correo";
import {
  asegurarTablasMultiTenant,
  fijarVistaSuperAdmin,
  obtenerDbInquilino,
  registrarCorreoDirectorio,
  type InquilinoInfo,
} from "../inquilinos";
import { migrar } from "../migraciones";
import { EMAIL_SUPER_ADMIN, esSuperAdmin } from "../permisos";
import { claveTemporal, codigoRecuperacion, hashClave, normalizarCodigo, sha256 } from "../seguridad";

const inquilinos = new Hono<Env>();
inquilinos.use("*", requiereSesion);

inquilinos.use("*", async (c, next) => {
  const yo = c.get("usuario");
  if (!esSuperAdmin(yo.rol, yo.email)) {
    return falla(c, 403, "Acceso exclusivo para el Súper Administrador de FacturaYa Venezuela.");
  }
  await next();
});

// Lista todos los negocios (inquilinos), cuál está viendo actualmente el Súper Admin y qué ranuras físicas D1 existen
inquilinos.get("/", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  await asegurarTablasMultiTenant(rawDb);
  const { results } = await rawDb.prepare(
    `SELECT codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, plan_usd, activo, creado_en
     FROM _mt_inquilinos ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en DESC`
  ).all<InquilinoInfo>();
  const vista = await rawDb.prepare(`SELECT inquilino_codigo FROM _mt_super_vista WHERE email = ?`).bind(EMAIL_SUPER_ADMIN).first<{ inquilino_codigo: string }>();
  const envObj = c.env as unknown as Record<string, unknown>;
  const bindingsFisicos: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const k = `DB_${i}`;
    if (envObj[k] && typeof (envObj[k] as D1Database).prepare === "function") bindingsFisicos.push(k);
  }
  return c.json({
    ok: true,
    inquilino_actual: vista?.inquilino_codigo || "principal",
    inquilinos: results,
    bindings_fisicos: bindingsFisicos,
  });
});

// Dar de alta e inicializar un nuevo negocio/cliente (una sola vez por cliente)
inquilinos.post("/", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  await asegurarTablasMultiTenant(rawDb);
  const b = await leerJson(c);
  const nombre_negocio = texto(b.nombre_negocio, 120);
  const rifEntrada = texto(b.rif, 20).toUpperCase();
  const rif = aRifSeniat(rifEntrada);
  const direccion = texto(b.direccion, 250);
  const telefono = texto(b.telefono, 40);
  const nombre_dueno = texto(b.nombre_dueno, 120);
  const email_dueno = texto(b.email_dueno, 120).toLowerCase();
  const medio_facturacion = texto(b.medio_facturacion, 20) === "IMPRENTA_DIGITAL" ? "IMPRENTA_DIGITAL" : "APP_SENIAT";
  const modo_inicial = texto(b.modo_inicial, 12) === "PRACTICA" ? "PRACTICA" : "REAL";
  const plan_usd = Math.max(0, Math.min(999, Number(b.plan_usd ?? 10) || 10));
  const ranura = texto(b.ranura_db, 20).toUpperCase();

  if (nombre_negocio.length < 2) return falla(c, 400, "Escribe el nombre o razón social del negocio.");
  if (!RIF.test(rifEntrada)) return falla(c, 400, "RIF no válido. Usa formato V-12345678-9 o J-12345678-9.");
  if (direccion.length < 4) return falla(c, 400, "Escribe la dirección fiscal del negocio.");
  if (nombre_dueno.length < 2) return falla(c, 400, "Escribe el nombre del dueño del negocio.");
  if (!EMAIL.test(email_dueno)) return falla(c, 400, "Escribe un correo válido para el dueño.");
  if (email_dueno === EMAIL_SUPER_ADMIN) return falla(c, 400, "El correo del dueño del cliente debe ser distinto a tu correo de Súper Administrador.");

  const correoOcupado = await rawDb.prepare(`SELECT inquilino_codigo FROM _mt_directorio WHERE email = ?`).bind(email_dueno).first<{ inquilino_codigo: string }>();
  if (correoOcupado) {
    return falla(c, 409, `El correo ${email_dueno} ya está asignado al negocio «${correoOcupado.inquilino_codigo}». Usa un correo único para cada dueño.`);
  }

  // Determinar el código de base de datos aislada (Modo Instantáneo t2, t3... o Binding físico DB_1, DB_2...)
  let codigo = "";
  let tipo_db: "PREFIJO" | "BINDING" = "PREFIJO";
  if (/^DB_\d+$/.test(ranura)) {
    const yaUsada = await rawDb.prepare(`SELECT 1 FROM _mt_inquilinos WHERE codigo = ?`).bind(ranura).first();
    if (yaUsada) return falla(c, 409, `La ranura física ${ranura} ya está asignada a otro negocio.`);
    codigo = ranura;
    tipo_db = "BINDING";
  } else {
    const { results } = await rawDb.prepare(`SELECT codigo FROM _mt_inquilinos WHERE codigo LIKE 't%'`).all<{ codigo: string }>();
    const nums = results.map((r) => Number(r.codigo.slice(1)) || 1);
    const sig = Math.max(1, ...nums) + 1;
    codigo = `t${sig}`;
    tipo_db = "PREFIJO";
  }

  const envObj = c.env as unknown as Record<string, unknown>;
  const dbInquilino = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);

  // 1) Correr todas las migraciones en la bóveda aislada del nuevo inquilino
  await migrar(dbInquilino);

  // 2) Obtener el hash de contraseña actual del Súper Admin para que Cristian también pueda entrar a esta bóveda
  const superUser = await rawDb.prepare(`SELECT nombre, email, password_hash, codigo_recuperacion_hash FROM usuarios WHERE lower(email) = ?`).bind(EMAIL_SUPER_ADMIN).first<{
    nombre: string; email: string; password_hash: string; codigo_recuperacion_hash: string | null;
  }>();

  const tempClave = claveTemporal();
  const codRecup = codigoRecuperacion();
  const hashTemp = await hashClave(tempClave);
  const hashRecup = await hashClave(normalizarCodigo(codRecup));

  const lotes: D1PreparedStatement[] = [
    dbInquilino.prepare(
      `INSERT INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, telefono, email, medio_facturacion)
       VALUES (1, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET instalado = 1, nombre_razon_social = excluded.nombre_razon_social, rif = excluded.rif,
         direccion_fiscal = excluded.direccion_fiscal, telefono = excluded.telefono, email = excluded.email, medio_facturacion = excluded.medio_facturacion`
    ).bind(nombre_negocio, rif, direccion, telefono, email_dueno, medio_facturacion),
    dbInquilino.prepare(`UPDATE ajustes SET valor = ? WHERE clave = 'modo'`).bind(modo_inicial),
  ];

  if (superUser) {
    lotes.push(
      dbInquilino.prepare(
        `INSERT OR IGNORE INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave, codigo_recuperacion_hash)
         VALUES (?, ?, ?, 'SUPER_ADMIN', 1, 0, ?)`
      ).bind(superUser.nombre, EMAIL_SUPER_ADMIN, superUser.password_hash, superUser.codigo_recuperacion_hash)
    );
  }

  lotes.push(
    dbInquilino.prepare(
      `INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave, codigo_recuperacion_hash)
       VALUES (?, ?, ?, 'ADMIN', 1, 1, ?)`
    ).bind(nombre_dueno, email_dueno, hashTemp, hashRecup)
  );

  await dbInquilino.batch(lotes);

  // 3) Registrar el inquilino y su correo en el directorio maestro
  await rawDb.batch([
    rawDb.prepare(
      `INSERT INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, plan_usd, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, plan_usd),
  ]);
  await registrarCorreoDirectorio(rawDb, email_dueno, codigo, "ADMIN");

  // 4) Enviar correo de bienvenida al dueño si el correo está configurado
  let correo_enviado = false;
  const resCorreo = await enviarCorreo(dbInquilino, envObj, {
    para: email_dueno,
    asunto: `🎉 Bienvenido a FacturaYa Venezuela · Acceso de ${nombre_negocio}`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #dde3ec;border-radius:16px;color:#1f2933">
      <h2 style="margin:0 0 12px;color:#1A73E8">🇻🇪 Bienvenido a FacturaYa Venezuela</h2>
      <p>Hola <b>${nombre_dueno}</b>, tu sistema de facturación digital para <b>${nombre_negocio} (${rif})</b> ya está activo y configurado.</p>
      <div style="background:#f8fafd;border:1px dashed #9aa7b6;border-radius:12px;padding:16px;margin:16px 0">
        <p style="margin:0 0 8px"><b>✉️ Usuario (Correo):</b> ${email_dueno}</p>
        <p style="margin:0 0 8px"><b>🔑 Clave temporal de primer ingreso:</b> <code style="font-size:18px;font-weight:700">${tempClave}</code></p>
        <p style="margin:0"><b>🔐 Código Maestro de Recuperación (guárdalo en secreto):</b> <code style="font-size:15px;font-weight:700">${codRecup}</code></p>
      </div>
      <p style="font-size:13px;color:#5f6b7a">Al iniciar sesión por primera vez con tu clave temporal, el sistema te pedirá elegir tu propia contraseña privada.</p>
    </div>`,
    texto: `Bienvenido a FacturaYa Venezuela (${nombre_negocio} - ${rif}).\nUsuario: ${email_dueno}\nClave temporal: ${tempClave}\nCódigo Maestro de Recuperación: ${codRecup}`,
  });
  if (resCorreo.ok) correo_enviado = true;

  await auditar(c, c.get("usuario").id, "INQUILINO_CREAR", `${codigo} ${nombre_negocio} (${rif}) -> ${email_dueno}`);
  return c.json({
    ok: true,
    codigo,
    nombre_negocio,
    rif,
    nombre_dueno,
    email_dueno,
    clave_temporal: tempClave,
    codigo_recuperacion: codRecup,
    correo_enviado,
  });
});

// Cambiar el negocio activo que el Súper Administrador está viendo / configurando en este momento
inquilinos.post("/cambiar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  await asegurarTablasMultiTenant(rawDb);
  const b = await leerJson(c);
  const codigo = texto(b.codigo, 20) || "principal";
  if (codigo !== "principal") {
    const existe = await rawDb.prepare(`SELECT codigo FROM _mt_inquilinos WHERE codigo = ?`).bind(codigo).first();
    if (!existe) return falla(c, 404, "Ese inquilino o negocio no existe.");
  }

  // Asegurar que la cuenta y sesión actual del Súper Admin existan en la bóveda destino para no cerrar su sesión al cambiar
  const envObj = c.env as unknown as Record<string, unknown>;
  const dbDestino = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);
  await migrar(dbDestino);

  const superOrig = await rawDb.prepare(`SELECT nombre, email, password_hash, codigo_recuperacion_hash FROM usuarios WHERE lower(email) = ?`).bind(EMAIL_SUPER_ADMIN).first<{
    nombre: string; email: string; password_hash: string; codigo_recuperacion_hash: string | null;
  }>();
  if (superOrig) {
    await dbDestino.prepare(
      `INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave, codigo_recuperacion_hash)
       VALUES (?, ?, ?, 'SUPER_ADMIN', 1, 0, ?)
       ON CONFLICT(email) DO UPDATE SET rol = 'SUPER_ADMIN', activo = 1`
    ).bind(superOrig.nombre, EMAIL_SUPER_ADMIN, superOrig.password_hash, superOrig.codigo_recuperacion_hash).run();
    const uDest = await dbDestino.prepare(`SELECT id FROM usuarios WHERE lower(email) = ?`).bind(EMAIL_SUPER_ADMIN).first<{ id: number }>();
    const tok = getCookie(c, "sid");
    if (uDest && tok) {
      await dbDestino.prepare(
        `INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)`
      ).bind(await sha256(tok), uDest.id, ahora() + 7 * 86400).run();
    }
  }

  await fijarVistaSuperAdmin(rawDb, codigo);
  const url = new URL(c.req.url);
  const esHttps = c.req.header("x-forwarded-proto") === "https" || url.protocol === "https:";
  const enIframePreview = url.hostname.endsWith(".run.app");
  setCookie(c, "inq", codigo, {
    httpOnly: true, sameSite: enIframePreview && esHttps ? "None" : "Lax", path: "/", maxAge: 7 * 86400,
    secure: enIframePreview ? esHttps : url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
  });
  return c.json({ ok: true, inquilino_actual: codigo });
});

// Suspender o reactivar el servicio de un inquilino (ej. control de pago de mensualidad de $10)
inquilinos.put("/:codigo/estado", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  await asegurarTablasMultiTenant(rawDb);
  const codigo = texto(c.req.param("codigo"), 20);
  if (codigo === "principal") return falla(c, 400, "Tu negocio principal no se puede suspender.");
  const b = await leerJson(c);
  const activo = b.activo ? 1 : 0;
  const r = await rawDb.prepare(`UPDATE _mt_inquilinos SET activo = ? WHERE codigo = ?`).bind(activo, codigo).run();
  if (!r.meta.changes) return falla(c, 404, "Inquilino no encontrado.");
  if (!activo) {
    const envObj = c.env as unknown as Record<string, unknown>;
    const dbInq = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);
    await dbInq.prepare(`DELETE FROM sesiones WHERE usuario_id NOT IN (SELECT id FROM usuarios WHERE lower(email) = ?)`).bind(EMAIL_SUPER_ADMIN).run();
  }
  await auditar(c, c.get("usuario").id, "INQUILINO_ESTADO", `${codigo} -> ${activo ? "ACTIVO" : "SUSPENDIDO"}`);
  return c.json({ ok: true, activo: !!activo });
});

export default inquilinos;
