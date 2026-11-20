import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { asegurarLlavePlataforma, cargarLlavesLegadas, descifrarSecreto, ErrorLlaveMaestra, llaveMaestraConfigurada } from "./cifrado";
import { recifrarSecretosHeredados } from "./recifrado";
import { migrar } from "./migraciones";
import { CLAVE_FALSA, claveTemporal, codigoRecuperacion, hashClave, normalizarCodigo, sha256, tokenAleatorio, verificarClave } from "./seguridad";
import { NOMBRE_ROL, emailSuperAdminConfig, esSuperAdmin, permisosDe, permitido, sinCostos, tiene, veCostos } from "./permisos";
import { enviarCorreo } from "./correo";
import { asegurarTablasMultiTenant, buscarInquilinoPorCorreo, esCorreoSuperAdmin, fijarVistaSuperAdmin, hidratarBindingsCloudflare, invalidarCacheInquilinos, obtenerDbInquilino, obtenerSuperAdminPrincipal, registrarCorreoDirectorio, tieneBindingDedicado, verificarInquilinoActivoCacheado, type InquilinoInfo } from "./inquilinos";
import { usuarios, cuenta } from "./rutas/usuarios";
import { restaurar } from "./rutas/restaurar";
import { EMAIL, RIF, ahora, auditar, falla, fechaCaracas, ip, leerJson, modoActual, usuarioActual, type Ctx, type Env } from "./comun";
import {
  POLITICA_LIMITE,
  asegurarTablaLimitesRed,
  limitePayloadPorRuta,
  limpiarLimiteIp,
  registrarEventoIp,
  verificarLimiteIp,
  verificarTurnstile,
} from "./seguridad-red";
import { aRifSeniat } from "../public/dinero.js";
import { intentarCierreMensualAutomatico, mesAnteriorCaracas, obtenerTasaBcvGlobal, sincronizarTasaInquilinoSiAuto } from "./tasa-bcv";
import { intentarArchivoMensualR2, intentarRespaldoDiarioR2, leerUltimoErrorR2, obtenerBucketR2 } from "./respaldos-r2";
import { verificarCodigoTotp, verificarYConsumirCodigoRespaldo2fa } from "./totp";
import { normalizarTipoContribuyente, reglasRegimen, validarTipoContribuyenteEstricto } from "./regimen";
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
const OPCIONALES = [
  "telefono", "email", "datos_pago_movil", "datos_transferencia", "datos_zelle", "datos_binance", "datos_paypal",
  "firma_personal", "zona_postal", "sector_seniat", "rif_comprobante", "rif_fecha_inscripcion", "rif_fecha_actualizacion", "rif_codigo_firma",
  "representante_nombre", "representante_cedula", "representante_fecha_nac", "representante_estado_civil", "representante_cedula_venc",
];
const COLUMNAS_NEGOCIO = [...OBLIGATORIOS, ...OPCIONALES, "logo_base64", "tasa_bcv", "tasa_bcv_fecha", "tasa_bcv_modo", "cierre_mensual_correo", "ultimo_cierre_correo", "medio_facturacion", "igtf_activo", "tipo_contribuyente"].join(", ");

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
const migrados = new WeakSet<object>();
const migradosPorDb = new WeakMap<object, Set<string>>();
app.use("/api/*", async (c, next) => {
  const maxBody = limitePayloadPorRuta(c.req.path);
  const contentLen = Number(c.req.header("Content-Length") || 0);
  if (contentLen > maxBody) {
    return falla(c, 413, "La petición excede el tamaño máximo permitido.");
  }
  const rawDb = c.env.DB;
  c.set("rawDb", rawDb);
  if (!migrados.has(rawDb)) {
    await migrar(rawDb);
    await asegurarTablasMultiTenant(rawDb);
    await asegurarTablaLimitesRed(rawDb);
    await asegurarLlavePlataforma(rawDb, c.env as unknown as Record<string, unknown>);
    await cargarLlavesLegadas(rawDb);
    await recifrarSecretosHeredados(rawDb, c.env as unknown as Record<string, unknown>, rawDb).catch((e) => console.error("[recifrado] principal:", e));
    migrados.add(rawDb);
  }
  const inqHeader = String(c.req.header("X-Inquilino") || "").trim();
  const inqDeTab = /^(principal|DB_\d+|t\d+)$/i.test(inqHeader)
    ? (inqHeader.toLowerCase() === "principal" ? "principal" : inqHeader.toUpperCase().startsWith("DB_") ? inqHeader.toUpperCase() : inqHeader.toLowerCase())
    : "";
  let inqCookie = inqDeTab || getCookie(c, "inq") || "principal";
  const envObj = c.env as unknown as Record<string, unknown>;
  const rutaApi = c.req.path;
  const requiereHidratacionCf =
    rutaApi === "/api/login" ||
    rutaApi === "/api/recuperar" ||
    rutaApi === "/api/recuperar-correo" ||
    rutaApi.startsWith("/api/inquilinos") ||
    rutaApi === "/api/sistema/reiniciar-fabrica" ||
    (inqCookie !== "principal" && !tieneBindingDedicado(envObj, inqCookie));
  if (requiereHidratacionCf) {
    await hidratarBindingsCloudflare(rawDb, envObj);
  }
  if (inqCookie !== "principal") {
    const existeInq = tieneBindingDedicado(envObj, inqCookie)
      || Boolean(await rawDb.prepare(`SELECT 1 FROM _mt_inquilinos WHERE codigo = ?`).bind(inqCookie).first().catch(() => null));
    if (!existeInq) {
      await fijarVistaSuperAdmin(rawDb, "principal", undefined, envObj).catch(() => {});
      fijarCookieInquilino(c, "principal");
      inqCookie = "principal";
    } else {
      const dbInq = obtenerDbInquilino(envObj, inqCookie);
      let setInq = migradosPorDb.get(rawDb);
      if (!setInq) {
        setInq = new Set(["principal"]);
        migradosPorDb.set(rawDb, setInq);
      }
      if (!setInq.has(inqCookie)) {
        try {
          await migrar(dbInq);
          await recifrarSecretosHeredados(dbInq, envObj, rawDb).catch((e) => console.error(`[recifrado] ${inqCookie}:`, e));
          setInq.add(inqCookie);
        } catch {
          // Si falla transitoriamente D1, no marcar como migrado para reintentar en la siguiente petición
        }
      }
      c.env = { ...c.env, DB: dbInq };
    }
  }
  c.set("inquilinoCodigo", inqCookie);
  await next();
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  c.res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
});

function leerWhatsappPublico(raw?: string): { digitos: string; bonito: string } | null {
  const dig = String(raw ?? "").replace(/\D/g, "");
  if (dig.length < 10 || dig.length > 15) return null;
  if (dig.startsWith("58") && dig.length === 12) {
    return { digitos: dig, bonito: `0${dig.slice(2, 5)}-${dig.slice(5, 8)}-${dig.slice(8)}` };
  }
  return { digitos: dig, bonito: `+${dig}` };
}

// CONTROL CENTRAL DE PERMISOS (Fase 7.1 + Multi-Tenant): toda petición a /api pasa por aquí antes de llegar a su módulo.
const PUBLICAS = new Set(["/api/estado", "/api/instalar", "/api/login", "/api/logout", "/api/recuperar", "/api/recuperar-correo"]);
app.use("/api/*", async (c, next) => {
  const ruta = c.req.path;
  if (PUBLICAS.has(ruta)) return next();
  const u = await usuarioActual(c).catch(() => null);
  if (!u) return falla(c, 401, "Inicia sesión para continuar.");
  c.set("usuario", u);
  const envObj = c.env as unknown as Record<string, unknown>;
  const inqCod = c.get("inquilinoCodigo") || "principal";
  if (inqCod !== "principal" && !esSuperAdmin(u.rol, u.email, envObj)) {
    const rawDb = c.get("rawDb") || c.env.DB;
    const activo = await verificarInquilinoActivoCacheado(rawDb, inqCod);
    if (!activo) {
      return falla(c, 403, "⚠️ El servicio de facturación de este negocio está temporalmente suspendido. Comunícate con soporte de FacturaYa Venezuela.");
    }
  }
  if (!permitido(u.rol, c.req.method, ruta, u.email, envObj)) return falla(c, 403, "Tu usuario no tiene permiso para esto.");
  if (u.debe_cambiar_clave && ruta !== "/api/cuenta/clave") return c.json({ ok: false, error: "Debes cambiar tu clave temporal antes de continuar.", cambiar_clave: true }, 403);
  // Mientras se restaura un respaldo nadie guarda nada (la restauración la hace UNA persona de principio a fin)
  if (c.req.method !== "GET" && !ruta.startsWith("/api/sistema/restaurar/") && (await c.env.DB.prepare(`SELECT 1 FROM ajustes WHERE clave = 'restauracion'`).first()))
    return c.json({ ok: false, error: "El sistema está restaurando un respaldo. Espera a que el administrador termine.", restaurando: true }, 423);
  await next();
  if (!veCostos(u.rol, u.email, envObj) && (c.res.headers.get("content-type") ?? "").includes("application/json")) { // quien no ve costos tampoco los recibe, aunque la pantalla no los pida
    const datos = await c.res.clone().json().catch(() => null);
    if (datos) c.res = new Response(JSON.stringify(sinCostos(datos)), { status: c.res.status, headers: c.res.headers });
  }
});

app.get("/api/estado", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const turnstileKey = String(c.env.TURNSTILE_SITE_KEY ?? "").trim() || null;
  const whatsappContacto = leerWhatsappPublico(c.env.WHATSAPP_CONTACTO);
  const hayAdmin = await rawDb.prepare(`SELECT 1 AS x FROM usuarios LIMIT 1`).first();
  if (!hayAdmin) return c.json({ instalado: false, turnstile_site_key: turnstileKey, ...(whatsappContacto ? { whatsapp_contacto: whatsappContacto } : {}) });
  let tenantRoto = false;
  let usuario = await usuarioActual(c).catch(() => {
    tenantRoto = true;
    return null;
  });
  let inqCod = c.get("inquilinoCodigo") || "principal";
  if (!usuario && tenantRoto && inqCod !== "principal") {
    const tok = getCookie(c, "sid");
    const uPrin = tok
      ? await rawDb
          .prepare(
            `SELECT u.id, u.nombre, u.email, u.rol, u.debe_cambiar_clave FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
             WHERE s.token_hash = ? AND s.expira_en > ? AND u.activo = 1`
          )
          .bind(await sha256(tok), ahora())
          .first<{ id: number; nombre: string; email: string; rol: string; debe_cambiar_clave: number }>()
          .catch(() => null)
      : null;
    if (uPrin && esSuperAdmin(uPrin.rol, uPrin.email, envObj)) {
      usuario = uPrin;
    } else {
      fijarCookieInquilino(c, "principal");
    }
  }
  if (!usuario) {
    return c.json({
      instalado: true,
      sesion: false,
      turnstile_site_key: turnstileKey,
      ...(whatsappContacto ? { whatsapp_contacto: whatsappContacto } : {}),
    });
  }
  if (inqCod !== "principal" && !esSuperAdmin(usuario.rol, usuario.email, envObj)) {
    const estadoInq = await rawDb.prepare(`SELECT activo FROM _mt_inquilinos WHERE codigo = ?`).bind(inqCod).first<{ activo: number }>();
    if (estadoInq && estadoInq.activo === 0) {
      return c.json({ instalado: true, sesion: false, suspendido: true });
    }
  }
  let negocio = await c.env.DB.prepare(`SELECT ${COLUMNAS_NEGOCIO} FROM perfil_emisor WHERE id = 1`).first<Record<string, unknown>>().catch(() => null);
  // Autocuración segura (nunca destructiva en un GET): si el Súper Admin apuntaba a un inquilino vacío o con error transitorio de red, regresarlo a 'principal' sin borrar el registro del cliente
  if (!negocio && inqCod !== "principal" && esSuperAdmin(usuario.rol, usuario.email, envObj)) {
    const tok = getCookie(c, "sid");
    const uPrin = await obtenerSuperAdminPrincipal(rawDb, envObj);
    if (tok && uPrin) {
      await rawDb.prepare(`INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)`)
        .bind(await sha256(tok), uPrin.id, ahora() + SESION_SEGUNDOS).run().catch(() => {});
    }
    await fijarVistaSuperAdmin(rawDb, "principal", usuario.email, envObj).catch(() => {});
    fijarCookieInquilino(c, "principal");
    inqCod = "principal";
    c.env = { ...c.env, DB: rawDb };
    negocio = await rawDb.prepare(`SELECT ${COLUMNAS_NEGOCIO} FROM perfil_emisor WHERE id = 1`).first<Record<string, unknown>>().catch(() => null);
  }
  if (negocio && typeof negocio.rif === "string") {
    const rifFormateado = aRifSeniat(negocio.rif);
    if (rifFormateado && rifFormateado !== negocio.rif) {
      negocio.rif = rifFormateado;
      await c.env.DB.prepare(`UPDATE perfil_emisor SET rif = ? WHERE id = 1`).bind(rifFormateado).run().catch(() => {});
    }
  }
  if (negocio) {
    const esNavegador = Boolean(c.req.header("user-agent"));
    const tasaVacia = !negocio.tasa_bcv || Number(negocio.tasa_bcv) <= 0;
    const syncBcv = await sincronizarTasaInquilinoSiAuto(rawDb, c.env.DB, {
      permitirRed: tasaVacia,
    }).catch(() => null);
    if (syncBcv?.actualizado && syncBcv.tasa_bcv) {
      negocio.tasa_bcv = syncBcv.tasa_bcv;
      negocio.tasa_bcv_fecha = syncBcv.tasa_bcv_fecha ?? negocio.tasa_bcv_fecha;
      negocio.tasa_bcv_modo = "AUTOMATICO";
    }
    if (esNavegador && !tasaVacia && negocio.tasa_bcv_modo !== "MANUAL") {
      const promBcv = sincronizarTasaInquilinoSiAuto(rawDb, c.env.DB, { permitirRed: true }).catch(() => null);
      try {
        c.executionCtx?.waitUntil?.(promBcv);
      } catch {
        // En entorno local sin executionCtx se ejecuta en segundo plano
      }
    }
    negocio.tasa_bcv_modo = negocio.tasa_bcv_modo === "MANUAL" ? "MANUAL" : "AUTOMATICO";
    negocio.tasa_bcv_fuente = syncBcv?.fuente || (negocio.tasa_bcv_modo === "MANUAL" ? "Manual" : "BCV Oficial");

    // Envío automático de cierre mensual en los primeros 5 días del mes si aún no se ha despachado el mes anterior
    const hoyIso = fechaCaracas();
    const diaMes = Number(hoyIso.slice(8, 10));
    const mesAnt = mesAnteriorCaracas(hoyIso);
    if (esNavegador && Number(negocio.cierre_mensual_correo ?? 1) === 1 && diaMes >= 1 && diaMes <= 5 && negocio.ultimo_cierre_correo !== mesAnt) {
      const envStr = c.env as unknown as Record<string, string>;
      const promCierre = intentarCierreMensualAutomatico(c.env.DB, envStr, mesAnt).catch(() => false);
      try {
        c.executionCtx?.waitUntil?.(promCierre);
      } catch {
        // En entorno local sin executionCtx se ejecuta en segundo plano
      }
    }
  }
  const esSuper = esSuperAdmin(usuario.rol, usuario.email, envObj);
  const rolEfectivo = esSuper ? "SUPER_ADMIN" : usuario.rol;
  const tipoContrib = normalizarTipoContribuyente(negocio?.tipo_contribuyente, negocio?.igtf_activo);
  if (negocio) {
    negocio.tipo_contribuyente = tipoContrib;
    negocio.igtf_activo = tipoContrib === "ESPECIAL" ? 1 : 0;
  }
  const tieneDocumentosIgtf = Boolean(
    await c.env.DB.prepare(`SELECT 1 AS x FROM documentos WHERE tipo = 'FACTURA' AND aplica_igtf = 1 AND igtf_bs > 0 LIMIT 1`).first().catch(() => null),
  );
  let listaInquilinos: InquilinoInfo[] = [];
  let facturasRealesN = 0;
  let totpActivoUsuario = false;
  let ultimoErrorR2 = null;
  if (esSuper) {
    await asegurarTablasMultiTenant(rawDb);
    const { results } = await rawDb.prepare(
      `SELECT codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, cedula_dueno, zona_postal, firma_personal, respaldo_descargado_en, medio_facturacion, tipo_contribuyente, plan_usd, activo, creado_en, d1_uuid, d1_nombre
       FROM _mt_inquilinos ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en DESC`
    ).all<InquilinoInfo>();
    listaInquilinos = results;
    facturasRealesN = (
      await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM documentos WHERE modo = 'REAL' AND estado <> 'BORRADOR'`).first<{ n: number }>().catch(() => null)
    )?.n ?? 0;
    const superPrin = await obtenerSuperAdminPrincipal(rawDb, envObj);
    const filaTotp = await rawDb
      .prepare(`SELECT totp_activo, totp_secreto FROM usuarios WHERE lower(email) = ? LIMIT 1`)
      .bind((superPrin?.email || usuario.email).trim().toLowerCase())
      .first<{ totp_activo?: number | null; totp_secreto?: string | null }>()
      .catch(() => null);
    totpActivoUsuario = Boolean(filaTotp && Number(filaTotp.totp_activo ?? 0) === 1 && filaTotp.totp_secreto);
    ultimoErrorR2 = await leerUltimoErrorR2(rawDb);
  } else if (usuario.rol === "ADMIN") {
    const filaTotp = await c.env.DB
      .prepare(`SELECT totp_activo, totp_secreto FROM usuarios WHERE id = ? LIMIT 1`)
      .bind(usuario.id)
      .first<{ totp_activo?: number | null; totp_secreto?: string | null }>()
      .catch(() => null);
    totpActivoUsuario = Boolean(filaTotp && Number(filaTotp.totp_activo ?? 0) === 1 && filaTotp.totp_secreto);
  }
  return c.json({
    instalado: true, sesion: true,
    turnstile_site_key: turnstileKey,
    ...(whatsappContacto ? { whatsapp_contacto: whatsappContacto } : {}),
    usuario: { ...usuario, rol_nombre: NOMBRE_ROL[rolEfectivo] ?? usuario.rol, es_super: esSuper, totp_activo: totpActivoUsuario },
    permisos: permisosDe(usuario.rol, usuario.email, envObj), ve_costos: veCostos(usuario.rol, usuario.email, envObj),
    restaurando: !!(await c.env.DB.prepare(`SELECT 1 FROM ajustes WHERE clave = 'restauracion'`).first()),
    negocio, regimen: reglasRegimen(tipoContrib), tiene_documentos_igtf: tieneDocumentosIgtf, modo: await modoActual(c.env.DB),
    inquilino_actual: inqCod,
    ...(esSuper ? {
      inquilinos: listaInquilinos, facturas_reales_n: facturasRealesN,
      seguridad: {
        master_key: llaveMaestraConfigurada(envObj),
        turnstile_secreto: Boolean(String(c.env.TURNSTILE_SECRET_KEY ?? "").trim()) || !String(c.env.TURNSTILE_SITE_KEY ?? "").trim(),
        totp_activo: totpActivoUsuario,
        r2_respaldos: Boolean(obtenerBucketR2(envObj)),
        ultimo_error_r2: ultimoErrorR2,
      },
    } : {}),
  });
});

// Instalador inicial del negocio principal (solo funciona cuando la base principal aún no tiene usuarios).
app.post("/api/instalar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const ipCliente = ip(c);
  const limIp = await verificarLimiteIp(rawDb, POLITICA_LIMITE.INSTALAR_IP, ipCliente);
  if (limIp.bloqueado) return falla(c, 429, "Demasiados intentos desde esta red. Espera 15 minutos.");
  c.env = { ...c.env, DB: rawDb };
  if (await rawDb.prepare(`SELECT 1 FROM usuarios LIMIT 1`).first()) return falla(c, 409, "El sistema ya está instalado.");
  const b = await leerJson(c);
  if (b.__demasiadoGrande) return falla(c, 413, "La petición es demasiado grande.");
  const ts = await verificarTurnstile(c.env.TURNSTILE_SECRET_KEY, String(b.cf_turnstile_response ?? ""), ipCliente, fetch, {
    expectedAction: "instalar",
    allowedHostnames: c.env.TURNSTILE_HOSTNAMES,
    produccionEstricto: Boolean(String(c.env.TURNSTILE_SITE_KEY ?? "").trim()),
  });
  if (!ts.ok) {
    await registrarEventoIp(rawDb, POLITICA_LIMITE.INSTALAR_IP, ipCliente);
    return falla(c, 403, ts.error || "Verificación anti-bots fallida.");
  }
  const t = (k: string) => String(b[k] ?? "").trim();
  const nombre = t("nombre").slice(0, 120), rifBruto = t("rif").toUpperCase(), direccion = t("direccion").slice(0, 200);
  const telefono = t("telefono").slice(0, 40) || null, email = t("email").toLowerCase();
  const clave = String(b.clave ?? "");
  if (nombre.length < 2) return falla(c, 400, "Escribe el nombre del negocio.");
  if (!RIF.test(rifBruto)) return falla(c, 400, "RIF no válido (ejemplo: V-12345678-0 o J-12345678-9).");
  const rif = aRifSeniat(rifBruto);
  if (direccion.length < 5) return falla(c, 400, "Escribe la dirección fiscal.");
  if (!EMAIL.test(email)) return falla(c, 400, "El correo no es válido.");
  if (clave.length < 10) return falla(c, 400, "La contraseña debe tener al menos 10 caracteres.");

  const envObj = c.env as unknown as Record<string, unknown>;
  const medioElegido = t("medio_facturacion") === "IMPRENTA_DIGITAL" ? "IMPRENTA_DIGITAL" : "APP_SENIAT";
  const tipoContribRaw = t("tipo_contribuyente");
  const tipoContrib = tipoContribRaw ? validarTipoContribuyenteEstricto(tipoContribRaw) : "ORDINARIO";
  if (!tipoContrib) return falla(c, 400, "Tipo de contribuyente no válido. Elige FORMAL, ORDINARIO o ESPECIAL.");
  const igtfInicial = tipoContrib === "ESPECIAL" ? 1 : 0;
  const cfgSuper = emailSuperAdminConfig(envObj);
  if (!cfgSuper) {
    return falla(c, 503, "Falta configurar el secreto SUPER_ADMIN_EMAIL en Cloudflare (Variables and Secrets) antes de instalar la plataforma.");
  }
  if (email !== cfgSuper) {
    return falla(c, 403, "Solo el correo configurado en SUPER_ADMIN_EMAIL puede completar la instalación inicial de la plataforma.");
  }
  const rolInicial = "SUPER_ADMIN";
  const hash = await hashClave(clave), codigo = codigoRecuperacion();
  const r = await rawDb.batch([
    rawDb.prepare(
      `INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, telefono, email, tasa_bcv, medio_facturacion, tipo_contribuyente, igtf_activo)
       SELECT 1, 1, ?, ?, ?, ?, ?, 0, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM usuarios)`
    ).bind(nombre, rif, direccion, telefono, email, medioElegido, tipoContrib, igtfInicial),
    rawDb.prepare(
      `INSERT INTO usuarios (nombre, email, password_hash, rol, codigo_recuperacion_hash) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM usuarios)`
    ).bind(nombre, email, hash, rolInicial, await hashClave(codigo.replace(/-/g, ""))),
  ]);
  if (!r[1].meta.changes) return falla(c, 409, "El sistema ya está instalado.");
  const id = Number(r[1].meta.last_row_id);
  await asegurarTablasMultiTenant(rawDb);
  await rawDb.prepare(
    `INSERT OR REPLACE INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, tipo_contribuyente, plan_usd, activo)
     VALUES ('principal', 'PRINCIPAL', ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`
  ).bind(nombre, rif, direccion, telefono || "", nombre, email, medioElegido, tipoContrib).run();
  await registrarCorreoDirectorio(rawDb, email, "principal", rolInicial, envObj);
  await abrirSesion(c, id, "principal");
  await auditar(c, id, "INSTALAR", email);
  return c.json({ ok: true, codigo_recuperacion: codigo });
});

app.post("/api/login", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const ipCliente = ip(c), t = ahora();
  const limGlobal = await verificarLimiteIp(rawDb, POLITICA_LIMITE.LOGIN_IP, ipCliente, t);
  if (limGlobal.bloqueado) return falla(c, 429, "Demasiados intentos desde esta dirección IP. Espera 15 minutos e inténtalo de nuevo.");

  const b = await leerJson(c);
  if (b.__demasiadoGrande) return falla(c, 413, "La petición excede el tamaño máximo permitido.");
  const ts = await verificarTurnstile(c.env.TURNSTILE_SECRET_KEY, String(b.cf_turnstile_response ?? ""), ipCliente, fetch, {
    expectedAction: "login",
    allowedHostnames: c.env.TURNSTILE_HOSTNAMES,
    produccionEstricto: Boolean(String(c.env.TURNSTILE_SITE_KEY ?? "").trim()),
  });
  if (!ts.ok) {
    await registrarEventoIp(rawDb, POLITICA_LIMITE.LOGIN_IP, ipCliente, t);
    return falla(c, 403, ts.error || "Verificación de seguridad inválida.");
  }

  const email = String(b.email ?? "").trim().toLowerCase(), clave = String(b.clave ?? "");
  if (!email || !clave) return falla(c, 400, "Escribe tu correo y tu contraseña.");

  const envObjLogin = c.env as unknown as Record<string, unknown>;
  const esSuperLogin = await esCorreoSuperAdmin(rawDb, email, envObjLogin);
  let infoInq = await buscarInquilinoPorCorreo(rawDb, email, envObjLogin);
  if (!infoInq.activo) {
    return falla(c, 403, "⚠️ El servicio de facturación de este negocio está temporalmente suspendido. Comunícate con soporte de FacturaYa Venezuela.");
  }
  let db = obtenerDbInquilino({ ...envObjLogin, DB: rawDb }, infoInq.codigo);
  await migrar(db).catch(() => {});
  if (infoInq.codigo !== "principal" && esSuperLogin) {
    const tienePerfil = await db.prepare(`SELECT 1 FROM perfil_emisor WHERE id = 1`).first().catch(() => null);
    if (!tienePerfil) {
      await fijarVistaSuperAdmin(rawDb, "principal", email, envObjLogin);
      infoInq = { codigo: "principal", activo: true, nombre_negocio: "Negocio Principal" };
      db = rawDb;
    }
  }
  c.env = { ...c.env, DB: db };
  c.set("inquilinoCodigo", infoInq.codigo);

  const llave = `${email}|${ipCliente}`;
  const llaveCuenta = `cuenta|${email}`;
  const [lim, limCuenta] = await Promise.all([
    db.prepare(`SELECT fallos, bloqueado_hasta FROM intentos_login WHERE clave = ?`).bind(llave).first<{ fallos: number; bloqueado_hasta: number }>(),
    db.prepare(`SELECT fallos, bloqueado_hasta FROM intentos_login WHERE clave = ?`).bind(llaveCuenta).first<{ fallos: number; bloqueado_hasta: number }>(),
  ]);
  if ((lim && lim.bloqueado_hasta > t) || (limCuenta && limCuenta.bloqueado_hasta > t)) {
    return falla(c, 429, "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.");
  }
  if ((limCuenta?.fallos ?? 0) >= 3 && String(c.env.TURNSTILE_SECRET_KEY ?? "").trim() && !String(b.cf_turnstile_response ?? "").trim()) {
    return falla(c, 403, "Se detectaron varios intentos fallidos sobre esta cuenta. Completa la verificación anti-bots para continuar.");
  }

  let u = await db.prepare(`SELECT id, rol, password_hash, clave_temporal_hash, clave_temporal_expira, activo FROM usuarios WHERE email = ?`).bind(email)
    .first<{ id: number; rol: string; password_hash: string; clave_temporal_hash?: string | null; clave_temporal_expira?: number | null; activo: number }>();

  // Si es el Súper Admin entrando a un inquilino donde aún no estaba sincronizado su usuario, sincronizarlo desde principal
  if (!u && esSuperLogin && infoInq.codigo !== "principal") {
    const uPrin = await rawDb.prepare(`SELECT nombre, email, password_hash, codigo_recuperacion_hash FROM usuarios WHERE lower(email) = ?`).bind(email).first<Record<string, any>>();
    if (uPrin) {
      await db.prepare(
        `INSERT OR IGNORE INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave, codigo_recuperacion_hash)
         VALUES (?, ?, ?, 'SUPER_ADMIN', 1, 0, ?)`
      ).bind(uPrin.nombre, email, uPrin.password_hash, uPrin.codigo_recuperacion_hash).run();
      u = await db.prepare(`SELECT id, rol, password_hash, clave_temporal_hash, clave_temporal_expira, activo FROM usuarios WHERE email = ?`).bind(email)
        .first<{ id: number; rol: string; password_hash: string; clave_temporal_hash?: string | null; clave_temporal_expira?: number | null; activo: number }>();
    }
  }

  const okNormal = await verificarClave(clave, u?.password_hash ?? CLAVE_FALSA);
  const okTemporal = !okNormal
    && Boolean(u?.clave_temporal_hash && Number(u.clave_temporal_expira ?? 0) > t)
    && (await verificarClave(clave, String(u!.clave_temporal_hash)));

  if (!u || !u.activo || (!okNormal && !okTemporal)) {
    const fallos = (lim?.fallos ?? 0) + 1, bloquear = fallos >= 5;
    const fallosCuenta = (limCuenta?.fallos ?? 0) + 1, bloquearCuenta = fallosCuenta >= 12;
    await db.batch([
      db.prepare(
        `INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, ?, ?)
         ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta`
      ).bind(llave, bloquear ? 0 : fallos, bloquear ? t + 900 : 0),
      db.prepare(
        `INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, ?, ?)
         ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta`
      ).bind(llaveCuenta, bloquearCuenta ? 0 : fallosCuenta, bloquearCuenta ? t + 900 : 0),
    ]);
    await registrarEventoIp(rawDb, POLITICA_LIMITE.LOGIN_IP, ipCliente, t);
    return falla(c, 401, "Correo o contraseña incorrectos.");
  }

  // Verificación 2FA TOTP (Súper Admin en rawDb; Dueño/ADMIN en la base de su empresa)
  let usoRespaldo2fa = false;
  const db2fa = esSuperLogin || esSuperAdmin(u.rol, email, envObjLogin) ? rawDb : db;
  if (esSuperLogin || u.rol === "SUPER_ADMIN" || u.rol === "ADMIN") {
    const fila2fa = await db2fa
      .prepare(`SELECT id, totp_activo, totp_secreto, totp_ultimo_paso, totp_respaldo_json FROM usuarios WHERE lower(email) = ? LIMIT 1`)
      .bind(email)
      .first<{
        id: number;
        totp_activo?: number | null;
        totp_secreto?: string | null;
        totp_ultimo_paso?: number | null;
        totp_respaldo_json?: string | null;
      }>()
      .catch(() => null);

    if (fila2fa && Number(fila2fa.totp_activo ?? 0) === 1 && fila2fa.totp_secreto) {
      const codigo2fa = String(b.codigo_2fa ?? "").trim();
      if (!codigo2fa) {
        return c.json({
          ok: true,
          requiere_2fa: true,
          mensaje: "Ingresa el código de 6 dígitos de tu app autenticadora (o un código de respaldo).",
        });
      }
      const envObj2fa = { ...envObjLogin, DB: db2fa };
      const secretoPlano = await descifrarSecreto(fila2fa.totp_secreto, envObj2fa);
      const verTotp = secretoPlano
        ? await verificarCodigoTotp(secretoPlano, codigo2fa, { ultimoPaso: Number(fila2fa.totp_ultimo_paso ?? 0) })
        : { ok: false };

      if (verTotp.ok && verTotp.paso) {
        await db2fa.prepare(`UPDATE usuarios SET totp_ultimo_paso = ? WHERE id = ?`).bind(verTotp.paso, fila2fa.id).run();
      } else {
        const verRespaldo = !verTotp.repetido
          ? await verificarYConsumirCodigoRespaldo2fa(codigo2fa, email, fila2fa.totp_respaldo_json)
          : { ok: false };
        if (verRespaldo.ok && verRespaldo.restantesJson !== undefined) {
          usoRespaldo2fa = true;
          await db2fa
            .prepare(`UPDATE usuarios SET totp_respaldo_json = ? WHERE id = ?`)
            .bind(verRespaldo.restantesJson, fila2fa.id)
            .run();
        } else {
          const fallos = (lim?.fallos ?? 0) + 1, bloquear = fallos >= 5;
          const fallosCuenta = (limCuenta?.fallos ?? 0) + 1, bloquearCuenta = fallosCuenta >= 12;
          await db.batch([
            db.prepare(
              `INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, ?, ?)
               ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta`
            ).bind(llave, bloquear ? 0 : fallos, bloquear ? t + 900 : 0),
            db.prepare(
              `INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, ?, ?)
               ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta`
            ).bind(llaveCuenta, bloquearCuenta ? 0 : fallosCuenta, bloquearCuenta ? t + 900 : 0),
          ]);
          await registrarEventoIp(rawDb, POLITICA_LIMITE.LOGIN_IP, ipCliente, t);
          return falla(
            c,
            401,
            verTotp.repetido
              ? "Ese código de 6 dígitos ya fue usado. Espera el próximo código en tu app autenticadora."
              : "Código de verificación 2FA incorrecto."
          );
        }
      }
    }
  }

  const pasosLimpieza: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM intentos_login WHERE clave IN (?, ?) OR (bloqueado_hasta > 0 AND bloqueado_hasta < ?)`).bind(llave, llaveCuenta, t - 3600),
    db.prepare(`DELETE FROM sesiones WHERE expira_en < ?`).bind(t),
  ];
  if (okTemporal) {
    // El usuario acaba de confirmar el uso de la clave temporal: ahora sí promovemos la clave temporal y exigimos elegir una nueva
    pasosLimpieza.push(
      db.prepare(`UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 1, clave_temporal_hash = NULL, clave_temporal_expira = 0 WHERE id = ?`)
        .bind(u.clave_temporal_hash, u.id),
      db.prepare(`DELETE FROM sesiones WHERE usuario_id = ?`).bind(u.id)
    );
  } else if (u.clave_temporal_hash) {
    // Inició sesión con su contraseña habitual: descartar cualquier solicitud temporal pendiente
    pasosLimpieza.push(
      db.prepare(`UPDATE usuarios SET clave_temporal_hash = NULL, clave_temporal_expira = 0 WHERE id = ?`).bind(u.id)
    );
  }
  await db.batch(pasosLimpieza);
  await limpiarLimiteIp(rawDb, POLITICA_LIMITE.LOGIN_IP, ipCliente);
  await abrirSesion(c, u.id, infoInq.codigo);
  await auditar(c, u.id, okTemporal ? "LOGIN_CLAVE_TEMPORAL" : usoRespaldo2fa ? "LOGIN_2FA_RESPALDO" : "LOGIN", email);
  return c.json({ ok: true, inquilino_actual: infoInq.codigo });
});

// Recuperar la clave del ADMINISTRADOR con su código de recuperación.
app.post("/api/recuperar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB, ipCliente = ip(c), t = ahora();
  const limGlobal = await verificarLimiteIp(rawDb, POLITICA_LIMITE.RECUPERAR_IP, ipCliente, t);
  if (limGlobal.bloqueado) return falla(c, 429, "Demasiados intentos desde esta dirección IP. Espera 15 minutos.");

  const b = await leerJson(c);
  if (b.__demasiadoGrande) return falla(c, 413, "La petición excede el tamaño máximo permitido.");
  const ts = await verificarTurnstile(c.env.TURNSTILE_SECRET_KEY, String(b.cf_turnstile_response ?? ""), ipCliente, fetch, {
    expectedAction: "recuperar_codigo",
    allowedHostnames: c.env.TURNSTILE_HOSTNAMES,
    produccionEstricto: Boolean(String(c.env.TURNSTILE_SITE_KEY ?? "").trim()),
  });
  if (!ts.ok) {
    await registrarEventoIp(rawDb, POLITICA_LIMITE.RECUPERAR_IP, ipCliente, t);
    return falla(c, 403, ts.error || "Verificación de seguridad inválida.");
  }

  const email = String(b.email ?? "").trim().toLowerCase(), codigo = normalizarCodigo(String(b.codigo ?? "")), nueva = String(b.clave_nueva ?? "");
  if (!email || !codigo) return falla(c, 400, "Escribe tu correo y tu código de recuperación.");
  if (nueva.length < 10) return falla(c, 400, "La clave nueva debe tener al menos 10 caracteres.");

  const envObjRec = c.env as unknown as Record<string, unknown>;
  const infoInq = await buscarInquilinoPorCorreo(rawDb, email, envObjRec);
  if (!infoInq.activo) return falla(c, 403, "⚠️ El servicio de este negocio está temporalmente suspendido.");
  const db = obtenerDbInquilino({ ...envObjRec, DB: rawDb }, infoInq.codigo);
  await migrar(db).catch(() => {});
  c.env = { ...c.env, DB: db };

  const llave = `rec|${email}|${ipCliente}`;
  const lim = await db.prepare(`SELECT fallos, bloqueado_hasta FROM intentos_login WHERE clave = ?`).bind(llave).first<{ fallos: number; bloqueado_hasta: number }>();
  if (lim && lim.bloqueado_hasta > t) return falla(c, 429, "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.");
  const u = await db.prepare(`SELECT id, rol, codigo_recuperacion_hash AS h, totp_activo FROM usuarios WHERE email = ? AND rol IN ('ADMIN', 'SUPER_ADMIN') AND activo = 1`).bind(email).first<{ id: number; rol: string; h: string | null; totp_activo?: number | null }>();
  const ok = await verificarClave(codigo, u?.h ?? CLAVE_FALSA);
  if (!u || !u.h || !ok) {
    const fallos = (lim?.fallos ?? 0) + 1, bloquear = fallos >= 5;
    await db.prepare(`INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta`).bind(llave, bloquear ? 0 : fallos, bloquear ? t + 900 : 0).run();
    await registrarEventoIp(rawDb, POLITICA_LIMITE.RECUPERAR_IP, ipCliente, t);
    return falla(c, 401, "El correo o el código de recuperación no son correctos.");
  }
  const nuevoCodigo = codigoRecuperacion();
  const esSuperRec = await esCorreoSuperAdmin(rawDb, email, envObjRec);
  await db.batch([
    db.prepare(
      `UPDATE usuarios
       SET password_hash = ?, debe_cambiar_clave = 0, codigo_recuperacion_hash = ?,
           totp_activo = 0, totp_secreto = NULL, totp_pendiente = NULL, totp_ultimo_paso = 0, totp_respaldo_json = NULL
       WHERE id = ?`
    ).bind(await hashClave(nueva), await hashClave(nuevoCodigo.replace(/-/g, "")), u.id),
    db.prepare(`DELETE FROM sesiones WHERE usuario_id = ?`).bind(u.id),
    db.prepare(`DELETE FROM intentos_login WHERE clave = ?`).bind(llave),
  ]);
  if (esSuperRec && rawDb !== db) {
    // Válvula anti-bloqueo: recuperar con el Código Maestro offline también reinicia 2FA en la base principal
    await rawDb
      .prepare(
        `UPDATE usuarios
         SET totp_activo = 0, totp_secreto = NULL, totp_pendiente = NULL, totp_ultimo_paso = 0, totp_respaldo_json = NULL
         WHERE lower(email) = ?`
      )
      .bind(email)
      .run()
      .catch(() => {});
  }
  await limpiarLimiteIp(rawDb, POLITICA_LIMITE.RECUPERAR_IP, ipCliente);
  await auditar(c, u.id, esSuperRec || Number(u.totp_activo ?? 0) === 1 ? "RECUPERAR_CLAVE_Y_RESET_2FA" : "RECUPERAR_CLAVE", email);
  return c.json({ ok: true, codigo_recuperacion: nuevoCodigo });
});

// Recuperación jerárquica por correo: cualquier usuario solicita recuperar su clave, y llega al correo del Dueño (ADMIN) del negocio.
app.post("/api/recuperar-correo", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB, ipCliente = ip(c), t = ahora();
  const limGlobal = await verificarLimiteIp(rawDb, POLITICA_LIMITE.CORREO_REC_IP, ipCliente, t);
  if (limGlobal.bloqueado) return falla(c, 429, "Demasiadas solicitudes de recuperación desde esta red. Espera 15 minutos.");

  const b = await leerJson(c);
  if (b.__demasiadoGrande) return falla(c, 413, "La petición excede el tamaño máximo permitido.");
  const ts = await verificarTurnstile(c.env.TURNSTILE_SECRET_KEY, String(b.cf_turnstile_response ?? ""), ipCliente, fetch, {
    expectedAction: "recuperar_correo",
    allowedHostnames: c.env.TURNSTILE_HOSTNAMES,
    produccionEstricto: Boolean(String(c.env.TURNSTILE_SITE_KEY ?? "").trim()),
  });
  if (!ts.ok) {
    await registrarEventoIp(rawDb, POLITICA_LIMITE.CORREO_REC_IP, ipCliente, t);
    return falla(c, 403, ts.error || "Verificación de seguridad inválida.");
  }

  const email = String(b.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) return falla(c, 400, "Escribe un correo electrónico válido.");

  // Contar cada solicitud válida de recuperación por IP para proteger cuota de correo Brevo/Resend contra bots
  await registrarEventoIp(rawDb, POLITICA_LIMITE.CORREO_REC_IP, ipCliente, t);

  const envObjRecCor = c.env as unknown as Record<string, unknown>;
  const infoInq = await buscarInquilinoPorCorreo(rawDb, email, envObjRecCor);
  if (!infoInq.activo) return falla(c, 403, "⚠️ El servicio de este negocio está temporalmente suspendido.");
  const db = obtenerDbInquilino({ ...envObjRecCor, DB: rawDb }, infoInq.codigo);
  await migrar(db).catch(() => {});
  c.env = { ...c.env, DB: db };

  const llave = `reccor|${email}|${ipCliente}`;
  const lim = await db.prepare(`SELECT fallos, bloqueado_hasta FROM intentos_login WHERE clave = ?`).bind(llave).first<{ fallos: number; bloqueado_hasta: number }>();
  if (lim && lim.bloqueado_hasta > t) return falla(c, 429, "Ya se envió una solicitud recientemente. Espera 15 minutos.");

  const msgGenerico = "Si el correo pertenece a un usuario activo, se ha enviado una clave temporal al Administrador del negocio.";
  const u = await db.prepare(`SELECT id, nombre, email, rol, activo FROM usuarios WHERE email = ? AND activo = 1`).bind(email).first<{ id: number; nombre: string; email: string; rol: string; activo: number }>();
  if (!u) {
    const fallos = (lim?.fallos ?? 0) + 1;
    await db.prepare(`INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET fallos = excluded.fallos, bloqueado_hasta = excluded.bloqueado_hasta`).bind(llave, fallos >= 4 ? 0 : fallos, fallos >= 4 ? t + 900 : 0).run();
    return c.json({ ok: true, mensaje: msgGenerico });
  }

  const admins = await db.prepare(`SELECT email, nombre, rol FROM usuarios WHERE rol IN ('ADMIN', 'SUPER_ADMIN') AND activo = 1 ORDER BY CASE WHEN rol = 'ADMIN' THEN 0 ELSE 1 END, id ASC`).all<{ email: string; nombre: string; rol: string }>();
  const perfil = await db.prepare(`SELECT nombre_razon_social, rif, email FROM perfil_emisor WHERE id = 1`).first<{ nombre_razon_social: string; rif: string; email: string | null }>();
  const superPrin = await obtenerSuperAdminPrincipal(rawDb, envObjRecCor);
  const correosDueno = [
    ...admins.results.filter((a) => infoInq.codigo === "principal" || a.rol !== "SUPER_ADMIN").map((a) => a.email),
    ...(perfil?.email ? [perfil.email] : []),
  ].filter(Boolean);
  const destinatarios = [...new Set(correosDueno.length ? correosDueno : superPrin?.email ? [superPrin.email] : [])];
  if (!destinatarios.length) return falla(c, 400, "No hay un correo de administrador configurado para recibir la recuperación.");

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
      <p style="margin-bottom:6px"><b>Clave temporal de un solo uso (válida por 30 minutos):</b></p>
      <div style="font:700 22px monospace;background:#fff4e0;padding:14px;text-align:center;border-radius:12px;border:1px dashed #e37400;letter-spacing:2px">${temporal}</div>
      <p style="font-size:13px;color:#5f6b7a;margin-top:14px">Si tú o el usuario no solicitaron este cambio, ignora este mensaje: <b>la contraseña actual y las sesiones activas siguen funcionando sin cambios</b> hasta que alguien inicie sesión con esta clave temporal.</p>
    </div>`,
    texto: `Recuperación de clave para ${u.nombre} (${u.email} - ${u.rol}). Clave temporal (válida 30 min): ${temporal}`,
  });

  if (!envio.ok) return falla(c, 400, envio.error || "No se pudo enviar el correo de recuperación.");

  // Recuperación NO destructiva (anti-DoS): NO pisamos password_hash ni cerramos sesiones activas hasta que el usuario inicie sesión con la clave temporal
  await db.batch([
    db.prepare(`UPDATE usuarios SET clave_temporal_hash = ?, clave_temporal_expira = ? WHERE id = ?`).bind(await hashClave(temporal), t + 1800, u.id),
    db.prepare(`INSERT INTO intentos_login (clave, fallos, bloqueado_hasta) VALUES (?, 0, ?)
      ON CONFLICT(clave) DO UPDATE SET fallos = 0, bloqueado_hasta = excluded.bloqueado_hasta`).bind(llave, t + 300),
  ]);
  await auditar(c, u.id, "RECUPERAR_CORREO", `${u.email} -> clave temporal pendiente (30m)`);
  return c.json({ ok: true, mensaje: msgGenerico });
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
  const usuario = c.get("usuario"), b = await leerJson(c, 380_000);
  if (b.__demasiadoGrande) return falla(c, 413, "La configuración o el logo exceden el tamaño permitido.");
  const rawDb = c.get("rawDb") || c.env.DB, inqCod = c.get("inquilinoCodigo") || "principal";
  const CAMPOS_TASA = new Set(["tasa_bcv", "tasa_bcv_modo"]);
  const envObjCfg = c.env as unknown as Record<string, unknown>;
  if (!tiene(usuario.rol, "admin", usuario.email, envObjCfg) && (!tiene(usuario.rol, "tasa", usuario.email, envObjCfg) || Object.keys(b).some((k) => !CAMPOS_TASA.has(k))))
    return falla(c, 403, "Solo el administrador puede cambiar la configuración. Tú puedes actualizar la tasa BCV.");
  const CAMPOS_FISCALES = new Set([...OBLIGATORIOS, ...OPCIONALES, "logo_base64"]);
  const tocaFiscal = Object.keys(b).some((k) => CAMPOS_FISCALES.has(k));
  if (tocaFiscal && b.confirmo_fiscal !== true && b.confirmo_fiscal !== "on" && b.confirmo_fiscal !== 1) {
    return falla(c, 400, "Marca la casilla «Estoy seguro» para guardar la configuración fiscal y logo del negocio.");
  }
  const sets: string[] = [], valores: unknown[] = [];

  for (const campo of OBLIGATORIOS) {
    if (!(campo in b)) continue;
    const v = String(b[campo] ?? "").trim().slice(0, 200);
    if (!v) return falla(c, 400, "Nombre, RIF y dirección fiscal no pueden quedar vacíos.");
    if (campo === "rif" && !RIF.test(v.toUpperCase())) return falla(c, 400, "RIF no válido (ejemplo: V-12345678-0 o J-12345678-9).");
    sets.push(`${campo} = ?`); valores.push(campo === "rif" ? aRifSeniat(v.toUpperCase()) : v);
  }
  for (const campo of OPCIONALES) {
    if (!(campo in b)) continue;
    sets.push(`${campo} = ?`); valores.push(String(b[campo] ?? "").trim().slice(0, 300) || null);
  }
  let logoNuevoGuardar: string | null = null;
  if ("logo_base64" in b) {
    const logo = String(b.logo_base64 ?? "").trim();
    if (logo && (!/^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(logo) || logo.length > 220_000)) {
      return falla(c, 400, "El logo debe ser una imagen PNG o JPG válida (máximo 150 KB).");
    }
    sets.push("logo_base64 = ?");
    valores.push(logo || null);
    if (logo) logoNuevoGuardar = logo;
  }
  let modoTasaNuevo: "AUTOMATICO" | "MANUAL" | null = null;
  if ("tasa_bcv_modo" in b) {
    const m = String(b.tasa_bcv_modo ?? "").trim().toUpperCase();
    if (m !== "AUTOMATICO" && m !== "MANUAL") {
      return falla(c, 400, "El modo de la tasa BCV debe ser AUTOMATICO o MANUAL.");
    }
    modoTasaNuevo = m;
    sets.push("tasa_bcv_modo = ?");
    valores.push(m);
  }
  if ("tasa_bcv" in b && modoTasaNuevo !== "AUTOMATICO") {
    const tasa = Number(String(b.tasa_bcv).replace(",", "."));
    if (!Number.isFinite(tasa) || tasa <= 0 || tasa > 1e9) return falla(c, 400, "La tasa BCV debe ser un número mayor que 0.");
    sets.push("tasa_bcv = ?", "tasa_bcv_fecha = datetime('now')"); valores.push(tasa);
  }
  if ("tipo_contribuyente" in b || "igtf_activo" in b) {
    return falla(c, 400, "Para cambiar la condición fiscal (Formal, Ordinario o Especial) usa la sección «Condición Fiscal» en Ajustes con tu contraseña y confirmación.");
  }
  if ("cierre_mensual_correo" in b) {
    sets.push("cierre_mensual_correo = ?");
    valores.push(b.cierre_mensual_correo === true || b.cierre_mensual_correo === 1 || b.cierre_mensual_correo === "1" || b.cierre_mensual_correo === "on" ? 1 : 0);
  }
  if (!sets.length) return falla(c, 400, "No hay cambios que guardar.");

  await c.env.DB.prepare(`UPDATE perfil_emisor SET ${sets.join(", ")} WHERE id = 1`).bind(...valores).run();
  if (logoNuevoGuardar) {
    const hLogo = await sha256(logoNuevoGuardar);
    await c.env.DB.prepare(`INSERT OR IGNORE INTO emisor_logos (hash, logo_base64) VALUES (?, ?)`).bind(hLogo, logoNuevoGuardar).run().catch(() => {});
  }
  if (modoTasaNuevo === "AUTOMATICO") {
    await sincronizarTasaInquilinoSiAuto(rawDb, c.env.DB, { permitirRed: true }).catch(() => null);
  }
  if ("nombre_razon_social" in b || "rif" in b || "direccion_fiscal" in b || "representante_cedula" in b || "zona_postal" in b || "firma_personal" in b) {
    const p = await c.env.DB.prepare(`SELECT nombre_razon_social, rif, direccion_fiscal, telefono, representante_cedula, zona_postal, firma_personal FROM perfil_emisor WHERE id = 1`).first<Record<string, any>>();
    if (p) {
      await rawDb.prepare(`UPDATE _mt_inquilinos SET nombre_negocio = ?, rif = ?, direccion = ?, telefono = ?, cedula_dueno = ?, zona_postal = ?, firma_personal = ? WHERE codigo = ?`)
        .bind(p.nombre_razon_social, p.rif, p.direccion_fiscal || "", p.telefono || "", p.representante_cedula || "", p.zona_postal || "", p.firma_personal || "", inqCod).run().catch(() => {});
      invalidarCacheInquilinos(rawDb);
    }
  }
  await auditar(c, usuario.id, "CONFIG", Object.keys(b).join(","));
  return c.json({ ok: true });
});

app.put("/api/config/regimen", async (c) => {
  const usuario = c.get("usuario"), b = await leerJson(c);
  if (b.__demasiadoGrande) return falla(c, 413, "La petición excede el tamaño permitido.");
  const rawDb = c.get("rawDb") || c.env.DB, inqCod = c.get("inquilinoCodigo") || "principal";
  const envObj = c.env as unknown as Record<string, unknown>;
  if (!tiene(usuario.rol, "admin", usuario.email, envObj)) {
    return falla(c, 403, "Solo el Dueño / Administrador o el Súper Administrador puede cambiar el tipo de contribuyente.");
  }
  const nuevoTipo = validarTipoContribuyenteEstricto(b.tipo_contribuyente);
  if (!nuevoTipo) return falla(c, 400, "Tipo de contribuyente no válido. Elige FORMAL, ORDINARIO o ESPECIAL.");
  const confirmo = b.confirmo_regimen === true || b.confirmo_regimen === "on" || b.confirmo_regimen === 1 || b.confirmo_regimen === "1";
  if (!confirmo) return falla(c, 400, "Marca la casilla «Estoy seguro» para cambiar la condición fiscal del negocio.");
  const claveActual = String(b.clave_actual ?? b.password ?? "");
  if (!claveActual) return falla(c, 400, "Escribe tu contraseña actual para confirmar el cambio de condición fiscal.");

  let hashReal: string | null = null;
  if (esSuperAdmin(usuario.rol, usuario.email, envObj)) {
    const filaSuper = await rawDb
      .prepare(`SELECT password_hash FROM usuarios WHERE lower(email) = ? AND activo = 1 LIMIT 1`)
      .bind(usuario.email.trim().toLowerCase())
      .first<{ password_hash: string }>()
      .catch(() => null);
    hashReal = filaSuper?.password_hash ?? null;
  }
  if (!hashReal) {
    const filaLocal = await c.env.DB
      .prepare(`SELECT password_hash FROM usuarios WHERE id = ? AND activo = 1 LIMIT 1`)
      .bind(usuario.id)
      .first<{ password_hash: string }>()
      .catch(() => null);
    hashReal = filaLocal?.password_hash ?? null;
  }
  if (!hashReal || !(await verificarClave(claveActual, hashReal))) {
    return falla(c, 403, "Contraseña incorrecta. No se modificó el tipo de contribuyente.");
  }

  const previo = await c.env.DB
    .prepare(`SELECT tipo_contribuyente, igtf_activo FROM perfil_emisor WHERE id = 1`)
    .first<{ tipo_contribuyente?: string | null; igtf_activo?: number | null }>()
    .catch(() => null);
  const tipoPrevio = normalizarTipoContribuyente(previo?.tipo_contribuyente, previo?.igtf_activo);
  const nuevoIgtf = nuevoTipo === "ESPECIAL" ? 1 : 0;

  await c.env.DB
    .prepare(`UPDATE perfil_emisor SET tipo_contribuyente = ?, igtf_activo = ? WHERE id = 1`)
    .bind(nuevoTipo, nuevoIgtf)
    .run();
  await rawDb
    .prepare(`UPDATE _mt_inquilinos SET tipo_contribuyente = ? WHERE codigo = ?`)
    .bind(nuevoTipo, inqCod)
    .run()
    .catch(() => {});
  invalidarCacheInquilinos(rawDb);
  await auditar(c, usuario.id, "TIPO_CONTRIBUYENTE_CAMBIO", `${tipoPrevio} -> ${nuevoTipo}`);
  return c.json({ ok: true, tipo_contribuyente: nuevoTipo, igtf_activo: nuevoIgtf, regimen: reglasRegimen(nuevoTipo) });
});

app.post("/api/sistema/tasa-bcv/sincronizar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const usuario = c.get("usuario");
  const global = await obtenerTasaBcvGlobal(rawDb, { forzar: true, permitirRed: true });
  if (!global?.tasa_bcv) {
    return falla(c, 502, "No se pudo consultar la tasa oficial del BCV en este momento; se mantiene la última tasa registrada.");
  }
  await c.env.DB
    .prepare(`UPDATE perfil_emisor SET tasa_bcv = ?, tasa_bcv_fecha = ?, tasa_bcv_modo = 'AUTOMATICO' WHERE id = 1`)
    .bind(global.tasa_bcv, global.actualizado_en)
    .run();

  // Replicar en las demás empresas que estén en modo AUTOMATICO (1 sola consulta externa compartida para todas)
  try {
    const envObj = c.env as unknown as Record<string, unknown>;
    const { results: inqs } = await rawDb.prepare(`SELECT codigo FROM _mt_inquilinos WHERE activo = 1`).all<{ codigo: string }>();
    for (const r of inqs) {
      const dbInq = obtenerDbInquilino({ ...envObj, DB: rawDb }, r.codigo);
      await dbInq
        .prepare(`UPDATE perfil_emisor SET tasa_bcv = ?, tasa_bcv_fecha = ? WHERE id = 1 AND COALESCE(tasa_bcv_modo, 'AUTOMATICO') = 'AUTOMATICO'`)
        .bind(global.tasa_bcv, global.actualizado_en)
        .run()
        .catch(() => {});
    }
  } catch {
    // Ignorar si aún no existen múltiples inquilinos
  }

  await auditar(c, usuario.id, "TASA_BCV_SYNC", `${global.tasa_bcv} (${global.fuente})`);
  return c.json({
    ok: true,
    tasa_bcv: global.tasa_bcv,
    fuente: global.fuente,
    fecha_valor: global.fecha_valor,
    actualizado_en: global.actualizado_en,
  });
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
  if (e instanceof ErrorLlaveMaestra) {
    return c.json({ ok: false, error: e.message, codigo: e.codigo }, 503);
  }
  console.error(e);
  return c.json({ ok: false, error: "Error interno del servidor." }, 500);
});

// Tarea programada (Cron Trigger de Cloudflare Workers v4.0 Escala Pro 100 Empresas):
// 1. Consulta la tasa oficial del BCV una sola vez y la guarda en `_mt_tasa_bcv_global` (de donde cada empresa la toma al instante en `/api/estado`).
// 2. Procesa las empresas en lotes seguros de hasta 15 por invocación usando un cursor persistente (`cron_cursor_inq`) para nunca superar el límite de subrequests de Cloudflare con 100+ empresas.
// 3. Purga sesiones vencidas (`sesiones.expira_en < ahora()`) e intentos de login antiguos para mantener las tablas D1 ultraligeras.
const MAX_LOTE_CRON = 15;
(app as unknown as { scheduled: (event: unknown, env: Env["Bindings"]) => Promise<void> }).scheduled = async (_event, env) => {
  const rawDb = env.DB;
  if (!rawDb) return;
  await migrar(rawDb);
  await asegurarTablasMultiTenant(rawDb);
  const envObj = env as unknown as Record<string, unknown>;
  await cargarLlavesLegadas(rawDb);
  await recifrarSecretosHeredados(rawDb, envObj, rawDb).catch((e) => console.error("[recifrado] cron principal:", e));
  await hidratarBindingsCloudflare(rawDb, envObj);
  const global = await obtenerTasaBcvGlobal(rawDb, { forzar: true, permitirRed: true }).catch(() => null);
  const hoyIso = fechaCaracas();
  const diaMes = Number(hoyIso.slice(8, 10));
  const mesAnt = mesAnteriorCaracas(hoyIso);
  const tAhora = ahora();

  const { results: inqsTodos } = await rawDb
    .prepare(`SELECT codigo FROM _mt_inquilinos WHERE activo = 1 ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en ASC`)
    .all<{ codigo: string }>()
    .catch(() => ({ results: [{ codigo: "principal" }] }));

  const listaInqs = inqsTodos.length ? inqsTodos : [{ codigo: "principal" }];
  let cursor = 0;
  if (listaInqs.length > MAX_LOTE_CRON) {
    const filaCur = await rawDb
      .prepare(`SELECT valor FROM integraciones WHERE clave = 'cron_cursor_inq'`)
      .first<{ valor: string }>()
      .catch(() => null);
    cursor = Math.max(0, Number(filaCur?.valor || 0) || 0);
    if (cursor >= listaInqs.length) cursor = 0;
  }

  const loteInqs = listaInqs.length > MAX_LOTE_CRON
    ? listaInqs.slice(cursor, cursor + MAX_LOTE_CRON)
    : listaInqs;

  if (listaInqs.length > MAX_LOTE_CRON) {
    const sigCursor = cursor + loteInqs.length >= listaInqs.length ? 0 : cursor + loteInqs.length;
    await rawDb
      .prepare(
        `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('cron_cursor_inq', ?, datetime('now'))
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
      )
      .bind(String(sigCursor))
      .run()
      .catch(() => {});
  }

  let setInq = migradosPorDb.get(rawDb);
  if (!setInq) {
    setInq = new Set(["principal"]);
    migradosPorDb.set(rawDb, setInq);
  }
  for (const r of loteInqs) {
    const dbInq = obtenerDbInquilino(envObj, r.codigo);
    if (!setInq.has(r.codigo)) {
      await migrar(dbInq).catch(() => {});
      setInq.add(r.codigo);
    }
    await recifrarSecretosHeredados(dbInq, envObj, rawDb).catch((e) => console.error(`[recifrado] cron ${r.codigo}:`, e));
    // Purga preventiva de sesiones expiradas e intentos de login antiguos
    await dbInq.prepare(`DELETE FROM sesiones WHERE expira_en < ?`).bind(tAhora).run().catch(() => {});
    await dbInq.prepare(`DELETE FROM intentos_login WHERE bloqueado_hasta > 0 AND bloqueado_hasta < ?`).bind(tAhora - 86400).run().catch(() => {});

    if (global?.tasa_bcv) {
      await dbInq
        .prepare(`UPDATE perfil_emisor SET tasa_bcv = ?, tasa_bcv_fecha = ? WHERE id = 1 AND COALESCE(tasa_bcv_modo, 'AUTOMATICO') = 'AUTOMATICO'`)
        .bind(global.tasa_bcv, global.actualizado_en)
        .run()
        .catch(() => {});
    }
    if (diaMes >= 1 && diaMes <= 5) {
      await intentarCierreMensualAutomatico(dbInq, env as unknown as Record<string, string>, mesAnt).catch(() => false);
    }
  }
  // Respaldo automático diario firmado + archivo fiscal mensual de conservación (10+ años) en Cloudflare R2
  await intentarRespaldoDiarioR2(rawDb, envObj, hoyIso).catch((e) => console.error("[respaldo-r2] cron diario:", e));
  await intentarArchivoMensualR2(rawDb, envObj, hoyIso, mesAnt).catch((e) => console.error("[respaldo-r2] cron mensual:", e));
};

export default app;
