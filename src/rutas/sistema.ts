// Módulo SISTEMA (solo administrador): salir del modo práctica, servicio de correo, respaldo completo y reinicio de fábrica (solo Super Admin).
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cifrarSecreto, descifrarSecreto } from "../cifrado";
import { EMAIL, ahora, auditar, falla, fechaCaracas, leerJson, modoActual, requiereAdmin, requiereSesion, texto, type Env } from "../comun";
import { enviarCorreo, leerConfigCorreo } from "../correo";
import { eliminarBaseD1EnCloudflare, obtenerUuidBdPrincipal } from "../cloudflare-api";
import { fijarVistaSuperAdmin, hidratarBindingsCloudflare, obtenerSuperAdminPrincipal } from "../inquilinos";
import { migrar } from "../migraciones";
import { esSuperAdmin } from "../permisos";
import { sha256, verificarClave } from "../seguridad";
import { generarRespaldoNegocio, obtenerFirmaCoberturaReal } from "../salud-bd";

const sistema = new Hono<Env>();
sistema.use("*", requiereSesion, requiereAdmin);

const entero = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 999999999 ? n : 0; };

// Sale del modo práctica UNA vez: borra los documentos de prueba y fija con qué número empieza lo real.
sistema.post("/salir-en-vivo", async (c) => {
  const db = c.env.DB, b = await leerJson(c);
  const medio = await db.prepare(`SELECT medio_facturacion AS m FROM perfil_emisor WHERE id = 1`).first<{ m: string }>();
  if (medio?.m === "SIN_DEFINIR") return falla(c, 400, "Antes de salir en vivo elige tu modalidad de facturación digital (App SENIAT o Imprenta Digital) en Ajustes.");
  const f = entero(b.primer_factura), k = entero(b.primer_control), p = entero(b.primer_presupuesto), rec = entero(b.primer_recibo ?? 1), nc = entero(b.primer_nota_credito ?? 1), nd = entero(b.primer_nota_debito ?? 1);
  if (!f || !k || !p || !rec || !nc || !nd) return falla(c, 400, "Escribe los números iniciales (mínimo 1).");
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
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'NOTA_DEBITO:REAL'`).bind(nd - 1),
    db.prepare(`UPDATE catalogo SET controla_stock = 0 WHERE controla_stock = 1 AND NOT EXISTS (SELECT 1 FROM movimientos_stock m WHERE m.producto_id = catalogo.id)`),
    db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`),
  ]);
  await auditar(c, c.get("usuario").id, "SALIR_EN_VIVO", `factura ${f}, control ${k}, presupuesto ${p}, nc ${nc}, nd ${nd}`);
  return c.json({ ok: true });
});

// MODALIDAD DE FACTURACIÓN DIGITAL: Aplicación Digital SENIAT (APP_SENIAT) o Imprenta Digital Autorizada (IMPRENTA_DIGITAL).
// Solo el dueño lo cambia, con su contraseña y un motivo; queda en el historial.
const MEDIOS = ["APP_SENIAT", "IMPRENTA_DIGITAL"];
sistema.get("/medio", async (c) => {
  const db = c.env.DB, p = await db.prepare(`SELECT medio_facturacion AS medio FROM perfil_emisor WHERE id = 1`).first<{ medio: string }>();
  const { results } = await db.prepare(`SELECT h.medio_anterior, h.medio_nuevo, h.motivo, h.cambiado_en, u.nombre AS por FROM medio_historial h LEFT JOIN usuarios u ON u.id = h.cambiado_por ORDER BY h.id DESC LIMIT 10`).all();
  return c.json({ ok: true, medio: p?.medio ?? "APP_SENIAT", historial: results, imprenta: await leerImprenta(db, c.env as unknown as Record<string, unknown>) });
});

// IMPRENTA DIGITAL: datos de conexión (proveedor, dirección de su API, usuario, clave, ambiente). La clave se guarda cifrada (AES-256-GCM), NO sale en los respaldos
// y nunca se devuelve entera (solo los últimos 4 caracteres).
const CLAVES_IMPRENTA = ["proveedor", "url", "usuario", "clave", "ambiente"] as const;
async function leerImprenta(db: D1Database, env?: Record<string, unknown>) {
  const { results } = await db.prepare(`SELECT clave, valor FROM integraciones WHERE clave LIKE 'imprenta_%'`).all<{ clave: string; valor: string }>();
  const m = Object.fromEntries(results.map((r) => [r.clave.replace("imprenta_", ""), r.valor]));
  const claveClara = await descifrarSecreto(m.clave, env);
  return { proveedor: m.proveedor ?? "", url: m.url ?? "", usuario: m.usuario ?? "", ambiente: m.ambiente ?? "PRUEBAS", clave_configurada: !!claveClara, clave_final: claveClara ? claveClara.slice(-4) : "" };
}

// Conector HTTP en vivo para Imprenta Digital Autorizada (SNAT/2026/00093 / SNAT/2024/000121).
// Se invoca exclusivamente cuando medio_facturacion === 'IMPRENTA_DIGITAL' (APP_SENIAT no se toca).
export async function solicitarControlImprentaDigital(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  payload: {
    documento_id: number;
    tipo_documento: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO";
    modo?: string;
    numero: number;
    control_interno: number;
    fecha_emision: string;
    cliente_rif: string;
    cliente_nombre: string;
    subtotal_bs: number;
    iva_bs: number;
    igtf_bs: number;
    total_bs: number;
    subtotal_usd: number;
    iva_usd: number;
    igtf_usd: number;
    total_usd: number;
    tasa_e8: number;
    factura_afectada_numero?: number | null;
    emisor?: { rif: string; nombre_razon_social: string; direccion_fiscal?: string };
    renglones?: Record<string, unknown>[];
    impuestos?: Record<string, unknown>[];
  }
): Promise<{ ok: boolean; control_fiscal: string | null; proveedor?: string; error?: string; idempotency_key?: string }> {
  const { results } = await db
    .prepare(`SELECT clave, valor FROM integraciones WHERE clave LIKE 'imprenta_%'`)
    .all<{ clave: string; valor: string }>()
    .catch(() => ({ results: [] as { clave: string; valor: string }[] }));
  const m = Object.fromEntries(results.map((r) => [r.clave.replace("imprenta_", ""), r.valor]));
  const url = String(m.url ?? "").trim();
  const claveClara = await descifrarSecreto(m.clave, env);
  if (!url || !claveClara) {
    return { ok: false, control_fiscal: null, error: "Imprenta Digital no configurada" };
  }

  let emisor = payload.emisor;
  if (!emisor) {
    const p = await db
      .prepare(`SELECT rif, nombre_razon_social, direccion_fiscal FROM perfil_emisor WHERE id = 1`)
      .first<{ rif: string; nombre_razon_social: string; direccion_fiscal: string }>()
      .catch(() => null);
    emisor = {
      rif: String(p?.rif ?? ""),
      nombre_razon_social: String(p?.nombre_razon_social ?? ""),
      direccion_fiscal: String(p?.direccion_fiscal ?? ""),
    };
  }
  const renglones =
    payload.renglones ??
    (
      await db
        .prepare(
          `SELECT orden, tipo, descripcion, cantidad_milli, precio_usd, alicuota_cent, monto_usd, monto_bs
           FROM documento_renglones WHERE documento_id = ? ORDER BY orden ASC`
        )
        .bind(payload.documento_id)
        .all<Record<string, unknown>>()
        .catch(() => ({ results: [] as Record<string, unknown>[] }))
    ).results;
  const impuestos =
    payload.impuestos ??
    (
      await db
        .prepare(
          `SELECT alicuota_cent, base_usd, iva_usd, base_bs, iva_bs
           FROM documento_impuestos WHERE documento_id = ? ORDER BY alicuota_cent ASC`
        )
        .bind(payload.documento_id)
        .all<Record<string, unknown>>()
        .catch(() => ({ results: [] as Record<string, unknown>[] }))
    ).results;

  const idempotencyKey = `${(emisor.rif || "EMISOR").replace(/[^A-Z0-9]/gi, "")}-${payload.tipo_documento}-${payload.modo || "REAL"}-${payload.numero}`;
  const registrarPendiente = async (motivoError: string) => {
    const ahoraIso = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?)
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
      )
      .bind(`imprenta_pendiente_${payload.documento_id}`, JSON.stringify({ error: motivoError, idempotency_key: idempotencyKey, en: ahoraIso }), ahoraIso)
      .run()
      .catch(() => {});
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${claveClara}`,
        "Idempotency-Key": idempotencyKey,
        "X-Imprenta-Usuario": String(m.usuario ?? ""),
        "X-Imprenta-Ambiente": String(m.ambiente ?? "PRUEBAS"),
      },
      body: JSON.stringify({
        proveedor: m.proveedor ?? "",
        ambiente: m.ambiente ?? "PRUEBAS",
        usuario: m.usuario ?? "",
        idempotency_key: idempotencyKey,
        emisor,
        documento: {
          ...payload,
          emisor,
          renglones,
          impuestos,
        },
      }),
    });
    if (!res.ok) {
      const errMsg = `HTTP ${res.status}`;
      await registrarPendiente(errMsg);
      return { ok: false, control_fiscal: null, proveedor: m.proveedor, error: errMsg, idempotency_key: idempotencyKey };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    const rawCtrl = String(
      data?.control_fiscal ??
        data?.numero_control ??
        data?.control ??
        data?.resultado?.control_fiscal ??
        data?.resultado?.numero_control ??
        ""
    )
      .trim()
      .toUpperCase();
    if (!/^[0-9A-Z][0-9A-Z-]{0,29}$/.test(rawCtrl)) {
      const errMsg = "Formato de número de control inválido";
      await registrarPendiente(errMsg);
      return { ok: false, control_fiscal: null, proveedor: m.proveedor, error: errMsg, idempotency_key: idempotencyKey };
    }
    await db.batch([
      db
        .prepare(`UPDATE documentos SET control_fiscal = ? WHERE id = ? AND control_fiscal IS NULL AND estado = 'EMITIDO'`)
        .bind(rawCtrl, payload.documento_id),
      db.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(`imprenta_pendiente_${payload.documento_id}`),
    ]);
    return { ok: true, control_fiscal: rawCtrl, proveedor: m.proveedor, idempotency_key: idempotencyKey };
  } catch (err) {
    const errMsg = (err as Error).message || "Error de red o timeout con la Imprenta Digital";
    await registrarPendiente(errMsg);
    return { ok: false, control_fiscal: null, proveedor: m.proveedor, error: errMsg, idempotency_key: idempotencyKey };
  }
}
sistema.get("/imprenta", async (c) => c.json({ ok: true, ...(await leerImprenta(c.env.DB, c.env as unknown as Record<string, unknown>)) }));
sistema.post("/imprenta", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  if (b.confirmo !== true && b.confirmo !== "on" && b.confirmo !== 1) {
    return falla(c, 400, "Marca la casilla «Estoy seguro» para guardar la configuración de la API de Imprenta Digital.");
  }
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.password ?? ""), u.password_hash))) return falla(c, 400, "La contraseña no es correcta.");
  const v: Record<string, string> = { proveedor: texto(b.proveedor, 60), url: texto(b.url, 200), usuario: texto(b.usuario, 100), clave: texto(b.clave, 200), ambiente: texto(b.ambiente, 12) };
  if (v.proveedor.length < 2) return falla(c, 400, "Escribe el nombre de tu imprenta digital.");
  if (!/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(\/[^\s]*)?$/i.test(v.url)) return falla(c, 400, "La dirección de la API debe empezar por https:// (ejemplo: https://api.miimprenta.com/v1).");
  if (!["PRUEBAS", "PRODUCCION"].includes(v.ambiente)) return falla(c, 400, "Elige el ambiente: pruebas o producción.");
  const previa = (await db.prepare(`SELECT valor FROM integraciones WHERE clave = 'imprenta_clave'`).first<{ valor: string }>())?.valor;
  if (!v.clave && !previa) return falla(c, 400, "Escribe la clave (token) de la API de tu imprenta.");
  if (v.clave) v.clave = await cifrarSecreto(v.clave, envObj);
  const ahora = new Date().toISOString(), pasos = CLAVES_IMPRENTA.filter((k) => k !== "clave" || v.clave).map((k) =>
    db.prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`).bind(`imprenta_${k}`, v[k], ahora));
  await db.batch(pasos);
  await auditar(c, yo.id, "IMPRENTA_CONFIG", `${v.proveedor} ${v.ambiente}${v.clave ? " (clave nueva)" : ""}`);
  return c.json({ ok: true, ...(await leerImprenta(db, envObj)) });
});

// SERVICIO DE CORREO ELECTRÓNICO (Resend / Brevo) para enviar facturas a clientes y recuperación jerárquica de claves.
sistema.get("/correo", async (c) => {
  const db = c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const [cfg, perfil] = await Promise.all([
    leerConfigCorreo(db, envObj),
    db.prepare(`SELECT nombre_razon_social, email FROM perfil_emisor WHERE id = 1`).first<{ nombre_razon_social: string; email: string | null }>().catch(() => null),
  ]);
  return c.json({
    ok: true,
    proveedor: cfg.proveedor,
    remitente: cfg.remitente,
    nombre_remitente: cfg.nombre_remitente,
    clave_configurada: !!cfg.clave,
    clave_final: cfg.clave ? cfg.clave.slice(-4) : "",
    modo_plataforma: cfg.modo_plataforma,
    proveedores_plataforma: cfg.proveedores_plataforma,
    remitente_plataforma: cfg.remitente_plataforma,
    nombre_plataforma: cfg.nombre_plataforma,
    negocio_nombre: perfil?.nombre_razon_social || "",
    reply_to: perfil?.email || "",
  });
});

sistema.post("/correo", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  if (b.confirmo !== true && b.confirmo !== "on" && b.confirmo !== 1) {
    return falla(c, 400, "Marca la casilla «Estoy seguro» para guardar la configuración de la API de Correo.");
  }
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
  if (clave) pares.push(["correo_clave", await cifrarSecreto(clave, envObj)]);
  await db.batch(
    pares.map(([k, val]) =>
      db.prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`).bind(k, val, ahora)
    )
  );
  await auditar(c, yo.id, "CORREO_CONFIG", `${proveedor} <${remitente}>${clave ? " (API key actualizada)" : ""}`);
  const cfg = await leerConfigCorreo(db, envObj);
  return c.json({ ok: true, proveedor: cfg.proveedor, remitente: cfg.remitente, nombre_remitente: cfg.nombre_remitente, clave_configurada: !!cfg.clave, clave_final: cfg.clave ? cfg.clave.slice(-4) : "" });
});

sistema.post("/correo/probar", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario");
  const destino = texto(b.para || yo.email, 120).toLowerCase();
  if (!EMAIL.test(destino)) return falla(c, 400, "Escribe un correo de destino válido.");
  const r = await enviarCorreo(db, c.env as unknown as Record<string, unknown>, {
    para: destino,
    alcance: "PLATAFORMA",
    tipo: "PRUEBA",
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
  return c.json({ ok: true, destino, proveedor: r.proveedor });
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

// REINICIAR BASE DE DATOS DE FÁBRICA (EXCLUSIVO DEL SÚPER ADMINISTRADOR):
// elimina triggers y tablas del inquilino actual y vuelve a correr las migraciones desde cero para dejar el negocio recién instalado.
sistema.post("/reiniciar-fabrica", async (c) => {
  const db = c.env.DB, rawDb = c.get("rawDb") || db, inqCod = c.get("inquilinoCodigo") || "principal";
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c), yo = c.get("usuario");
  if (!esSuperAdmin(yo.rol, yo.email, envObj)) {
    return falla(c, 403, "Solo el Súper Administrador del sistema tiene permiso para reiniciar la base de datos de fábrica.");
  }
  if (b.confirmo !== true) return falla(c, 400, "Marca la casilla de confirmación para borrar toda la base de datos.");
  const modo = await modoActual(db).catch(() => "PRACTICA");
  const cob = await obtenerFirmaCoberturaReal(db);
  const realesN = cob.n;
  if (inqCod === "principal" || (modo === "REAL" && realesN > 0)) {
    if (texto(b.frase_confirmacion, 40) !== "REINICIAR-DEFINITIVAMENTE") {
      return falla(c, 400, "Por seguridad fiscal SENIAT, escribe exactamente REINICIAR-DEFINITIVAMENTE para confirmar el borrado.");
    }
  }
  if (modo === "REAL" && realesN > 0) {
    const respLocal = await db
      .prepare(`SELECT valor FROM integraciones WHERE clave = 'ultimo_respaldo_descargado'`)
      .first<{ valor: string }>()
      .catch(() => null);
    const cobLocal = await db
      .prepare(`SELECT valor FROM integraciones WHERE clave = 'ultimo_respaldo_cobertura'`)
      .first<{ valor: string }>()
      .catch(() => null);
    const respInq = await rawDb
      .prepare(`SELECT respaldo_descargado_en FROM _mt_inquilinos WHERE codigo = ?`)
      .bind(inqCod)
      .first<{ respaldo_descargado_en?: string | null }>()
      .catch(() => null);
    if (!respLocal?.valor && !respInq?.respaldo_descargado_en) {
      return falla(
        c,
        409,
        "⚠️ Candado de Respaldo Obligatorio: Esta empresa tiene documentos fiscales REALES emitidos. Descarga primero el respaldo completo («📦 Guardar respaldo ahora» o «📦 1. Descargar BD Cliente») para entregárselo al cliente antes de vaciar o dar de baja su base de datos."
      );
    }
    const cobInq = respInq?.respaldo_descargado_en?.includes("|") ? respInq.respaldo_descargado_en.split("|")[1] : "";
    const coberturaCoincide = cobLocal?.valor === cob.firma || cobInq === cob.firma;
    if (!coberturaCoincide) {
      return falla(
        c,
        409,
        "⚠️ Candado de Respaldo Obligatorio: Se emitieron nuevos documentos fiscales REALES después del último respaldo descargado. Descarga un respaldo completo actualizado antes de reiniciar la base de datos."
      );
    }
  }
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.clave ?? ""), u.password_hash))) return falla(c, 400, "La contraseña del Súper Administrador no es correcta.");

  let d1UuidRemota: string | null = null;
  if (inqCod !== "principal") {
    await hidratarBindingsCloudflare(rawDb, envObj);
    const infoInq = await rawDb
      .prepare(`SELECT d1_uuid FROM _mt_inquilinos WHERE codigo = ?`)
      .bind(inqCod)
      .first<{ d1_uuid?: string | null }>()
      .catch(() => null);
    d1UuidRemota = infoInq?.d1_uuid ?? null;
  }

  const triggersConocidos = [
    "doc_no_borrar", "doc_inmutable",
    "documento_renglones_insert_emitido", "documento_renglones_update_emitido", "documento_renglones_delete_emitido",
    "documento_impuestos_insert_emitido", "documento_impuestos_update_emitido", "documento_impuestos_delete_emitido",
    "renglon_no_cambiar", "renglon_no_borrar",
    "impuesto_no_cambiar", "impuesto_no_borrar", "pago_no_borrar", "pago_inmutable",
    "mov_no_cambiar", "mov_no_borrar", "compra_no_borrar", "compra_inmutable",
    "compra_impuestos_no_cambiar", "compra_impuestos_no_borrar",
  ];
  await db.batch(triggersConocidos.map((t) => db.prepare(`DROP TRIGGER IF EXISTS ${t}`))).catch(() => {});
  const ordenTablas = [
    "pagos", "movimientos_stock", "compra_impuestos", "compras", "compras_vieja",
    "documento_impuestos", "documento_renglones", "documentos", "catalogo", "clientes", "proveedores",
    "medio_historial", "metodos_cobro", "integraciones", "parametros_fiscales", "contadores", "ajustes",
    "verificaciones", "auditoria", "intentos_login", "sesiones", "usuarios", "emisor_logos", "perfil_emisor", "_migraciones",
  ];
  await db.batch(ordenTablas.map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`))).catch(() => {});
  if (inqCod === "principal") {
    await migrar(db);
    await rawDb.prepare(`DELETE FROM _mt_inquilinos WHERE codigo = 'principal'`).run().catch(() => {});
    await rawDb.prepare(`DELETE FROM _mt_directorio WHERE inquilino_codigo = 'principal'`).run().catch(() => {});
    await rawDb.prepare(`DELETE FROM _mt_super_vista`).run().catch(() => {});
  } else {
    const uuidPrincipal = obtenerUuidBdPrincipal(envObj);
    if (d1UuidRemota && (!uuidPrincipal || d1UuidRemota !== uuidPrincipal)) {
      await eliminarBaseD1EnCloudflare(rawDb, envObj, d1UuidRemota).catch(() => {});
      delete envObj[inqCod];
    }
    // Al borrar un inquilino secundario, eliminar su registro y devolver al Súper Admin a 'principal' con su sesión intacta
    await rawDb.prepare(`DELETE FROM _mt_inquilinos WHERE codigo = ?`).bind(inqCod).run().catch(() => {});
    await rawDb.prepare(`DELETE FROM _mt_directorio WHERE inquilino_codigo = ?`).bind(inqCod).run().catch(() => {});
    await fijarVistaSuperAdmin(rawDb, "principal", yo.email, envObj);
    const tok = getCookie(c, "sid");
    const uPrin = await obtenerSuperAdminPrincipal(rawDb, envObj);
    if (tok && uPrin) {
      await rawDb.prepare(`INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)`)
        .bind(await sha256(tok), uPrin.id, ahora() + 7 * 86400).run().catch(() => {});
    }
    const url = new URL(c.req.url);
    const esHttps = c.req.header("x-forwarded-proto") === "https" || url.protocol === "https:";
    const enIframePreview = url.hostname.endsWith(".run.app");
    setCookie(c, "inq", "principal", {
      httpOnly: true, sameSite: enIframePreview && esHttps ? "None" : "Lax", path: "/", maxAge: 7 * 86400,
      secure: enIframePreview ? esHttps : url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    });
  }
  return c.json({ ok: true, regreso_a_principal: inqCod !== "principal" });
});

// Copia completa (o filtrada por ?anio=YYYY para bases multi-anuales grandes) de los datos del negocio actual.
sistema.get("/respaldo", async (c) => {
  const db = c.env.DB, rawDb = c.get("rawDb") || db, inqCod = c.get("inquilinoCodigo") || "principal";
  const envObj = c.env as unknown as Record<string, unknown>;
  const anioParam = Number(c.req.query("anio") || 0);
  const anio = Number.isInteger(anioParam) && anioParam >= 2000 && anioParam <= 2100 ? anioParam : undefined;
  const respaldo = await generarRespaldoNegocio(db, { ...(anio ? { anio } : {}), env: envObj });
  if (!anio) {
    const ahoraIso = new Date().toISOString();
    const firmaCob = respaldo.cobertura_real?.firma ?? "0:0";
    await db
      .batch([
        db
          .prepare(
            `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('ultimo_respaldo_descargado', ?, ?)
             ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
          )
          .bind(ahoraIso, ahoraIso),
        db
          .prepare(
            `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('ultimo_respaldo_cobertura', ?, ?)
             ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
          )
          .bind(firmaCob, ahoraIso),
      ])
      .catch(() => {});
    await rawDb
      .prepare(`UPDATE _mt_inquilinos SET respaldo_descargado_en = ? WHERE codigo = ?`)
      .bind(`${ahoraIso}|${firmaCob}`, inqCod)
      .run()
      .catch(() => {});
  }
  await auditar(c, c.get("usuario").id, "RESPALDO", anio ? `Año ${anio}` : "Completo");
  const sufijoAnio = anio ? `-${anio}` : "";
  return new Response(JSON.stringify(respaldo), { headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="respaldo${sufijoAnio}-${fechaCaracas()}.json"` } });
});

export default sistema;
