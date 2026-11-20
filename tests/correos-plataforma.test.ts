import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { enviarCorreo, leerConfigCorreo } from "../src/correo";
import {
  construirIdentidadEnvio,
  enmascararCorreo,
  fechaUtcHoy,
  leerConfigPlataforma,
  normalizarEventoWebhook,
  seleccionarCadenaProveedores,
} from "../src/correo-plataforma";

type EnvTest = Record<string, unknown> & { DB: ReturnType<typeof crearBaseDatosD1> };

class CookieJar {
  private m = new Map<string, string>();
  guardar(res: Response) {
    const sc = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const lista = sc.length ? sc : res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : [];
    for (const h of lista) {
      const [par] = h.split(";");
      const idx = par.indexOf("=");
      if (idx > 0) {
        const k = par.slice(0, idx).trim();
        const v = par.slice(idx + 1).trim();
        if (!v) this.m.delete(k);
        else this.m.set(k, v);
      }
    }
  }
  cabecera(): string {
    return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function reqJson(env: EnvTest, jar: CookieJar, ruta: string, metodo = "GET", body?: unknown, headersExtra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...headersExtra };
  const ck = jar.cabecera();
  if (ck) headers.Cookie = ck;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const req = new Request(`https://facturaya.test${ruta}`, {
    method: metodo,
    headers,
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const res = await app.fetch(req, env as unknown as Parameters<typeof app.fetch>[1]);
  jar.guardar(res);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data as Record<string, any> };
}

test("1. Reglas puras del correo de plataforma: cadena 90%/100%, circuitos, identidad inquilino vs plataforma y máscara", () => {
  // Máscara nunca expone dirección completa
  assert.equal(enmascararCorreo("cliente.demo@gmail.com"), "c***o@gmail.com");
  assert.equal(enmascararCorreo("ab@ejemplo.com"), "a***@ejemplo.com");

  // Si Brevo llega al 90% (270/300) y Resend está sano, prioriza Resend primero
  const p1 = seleccionarCadenaProveedores(
    ["BREVO", "RESEND"],
    { BREVO: 270, RESEND: 10 },
    {},
    { BREVO: 300, RESEND: 100, ZEPTOMAIL: 10_000 },
    1000
  );
  assert.deepEqual(p1.orden, ["RESEND", "BREVO"]);

  // Si SOLO Brevo está configurado y está al 92% (276/300), NO se detiene en 270: permite hasta 100%
  const p2 = seleccionarCadenaProveedores(
    ["BREVO"],
    { BREVO: 276 },
    {},
    { BREVO: 300, RESEND: 100, ZEPTOMAIL: 10_000 },
    1000
  );
  assert.deepEqual(p2.orden, ["BREVO"]);

  // Si Brevo tiene circuito abierto, se salta directamente a Resend -> ZeptoMail
  const p3 = seleccionarCadenaProveedores(
    ["BREVO", "RESEND", "ZEPTOMAIL"],
    { BREVO: 5, RESEND: 5, ZEPTOMAIL: 0 },
    { BREVO: { abierto_hasta: 2000 } },
    { BREVO: 300, RESEND: 100, ZEPTOMAIL: 10_000 },
    1000
  );
  assert.deepEqual(p3.orden, ["RESEND", "ZEPTOMAIL"]);
  assert.equal(p3.omitidos[0]?.razon, "circuito_abierto");

  // Identidad de correo: inquilino lleva nombre negocio + Reply-To + pie discreto; plataforma lleva FacturaYa
  const cfgPlat = leerConfigPlataforma({
    BREVO_API_KEY: "xkeysib-demo",
    EMAIL_REMITENTE: "facturas@facturayave.org",
    EMAIL_NOMBRE_PLATAFORMA: "FacturaYa Venezuela",
  });
  const idInq = construirIdentidadEnvio("INQUILINO", cfgPlat, {
    nombre_razon_social: "Consultorio Demo",
    rif: "V-12345678-0",
    telefono: "0414-0000000",
    direccion_fiscal: "Caracas",
    email: "contacto@consultorio.test",
  });
  assert.equal(idInq.remitente, "facturas@facturayave.org");
  assert.equal(idInq.nombreRemitente, "Consultorio Demo (vía FacturaYa Venezuela)");
  assert.equal(idInq.responderA, "contacto@consultorio.test");
  assert.ok(idInq.pieHtml.includes("Enviado mediante FacturaYa Venezuela"));

  const idPlat = construirIdentidadEnvio("PLATAFORMA", cfgPlat, null);
  assert.equal(idPlat.nombreRemitente, "FacturaYa Venezuela");
  assert.equal(idPlat.pieHtml, "");

  // Normalización de eventos webhook Brevo y Resend
  const evBrevo = normalizarEventoWebhook("BREVO", {
    event: "hard_bounce",
    email: "NoExiste@Ejemplo.Test",
    "message-id": "<msg-1>",
    reason: "User unknown",
    tags: ["inq:DB_1", "tipo:DOCUMENTO"],
  });
  assert.equal(evBrevo.tipoEvento, "REBOTE_DURO");
  assert.equal(evBrevo.email, "noexiste@ejemplo.test");
  assert.equal(evBrevo.inquilinoTag, "DB_1");

  const evResend = normalizarEventoWebhook("RESEND", {
    type: "email.complained",
    data: { email_id: "re_123", to: ["queja@ejemplo.test"], tags: [{ name: "inq", value: "principal" }] },
  });
  assert.equal(evResend.tipoEvento, "SPAM");
  assert.equal(evResend.messageId, "re_123");
});

test("2. Correo de Plataforma E2E: retrocompatibilidad, failover Brevo->Resend, identidad Reply-To, webhooks fail-closed, rebotes duros/blandos/spam, fusible, HMAC sin PII y RBAC", async () => {
  const db = crearBaseDatosD1(":memory:");
  const MASTER_KEY = "llave-maestra-super-secreta-de-prueba-v47-32chars!!";
  const envBase: EnvTest = {
    DB: db,
    MASTER_KEY,
    SUPER_ADMIN_EMAIL: "super@plataforma.test",
    EMAIL_REMITENTE: "facturas@facturayave.org",
    EMAIL_NOMBRE_PLATAFORMA: "FacturaYa Venezuela",
    BREVO_API_KEY: "xkeysib-plataforma-test",
    RESEND_API_KEY: "re_plataforma_test",
    BREVO_WEBHOOK_SECRET: "sec-brevo-123456",
    RESEND_WEBHOOK_SECRET: "sec-resend-123456",
    BREVO_CUOTA_DIARIA: "10",
    RESEND_CUOTA_DIARIA: "10",
  };

  const jarSuper = new CookieJar();
  const inst = await reqJson(envBase, jarSuper, "/api/instalar", "POST", {
    nombre: "Clinica Principal CA",
    rif: "J-12345678-9",
    direccion: "Av. Principal, Caracas",
    telefono: "0414-1234567",
    email: "super@plataforma.test",
    clave: "ClaveSegura123!",
    tipo_contribuyente: "ORDINARIO",
  });
  assert.equal(inst.status, 200);

  // Actualizar email del negocio para comprobar Reply-To distinto al remitente de plataforma
  await db.prepare(`UPDATE perfil_emisor SET email = 'facturacion@clinicaprincipal.test' WHERE id = 1`).run();

  // Crear un Cajero para verificar RBAC de /api/correos/panel y /api/correos/historial
  const crCajero = await reqJson(envBase, jarSuper, "/api/usuarios", "POST", {
    nombre: "Cajero Uno",
    email: "cajero@clinicaprincipal.test",
    rol: "CAJERO",
  });
  assert.equal(crCajero.status, 200);

  const jarCajero = new CookieJar();
  const logCajero = await reqJson(envBase, jarCajero, "/api/login", "POST", {
    email: "cajero@clinicaprincipal.test",
    clave: crCajero.data.clave_temporal,
  });
  assert.equal(logCajero.status, 200);
  const cambioCajero = await reqJson(envBase, jarCajero, "/api/cuenta/clave", "POST", {
    actual: crCajero.data.clave_temporal,
    nueva: "ClaveCajero123!",
  });
  assert.equal(cambioCajero.status, 200);
  const cajeroPanel = await reqJson(envBase, jarCajero, "/api/correos/panel");
  assert.equal(cajeroPanel.status, 403, "Cajero no puede acceder al panel global de correos");
  const cajeroHist = await reqJson(envBase, jarCajero, "/api/correos/historial");
  assert.equal(cajeroHist.status, 403, "Cajero no puede leer historial administrativo de correos");

  // 1) Interceptar fetch para simular Brevo y Resend sin red externa
  const llamadas: { url: string; headers: Record<string, string>; body: Record<string, any> }[] = [];
  let brevoStatus = 201;
  let resendStatus = 200;
  let seq = 1;
  const fetchOrig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    if (init?.headers && typeof init.headers === "object") {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k.toLowerCase()] = v;
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    llamadas.push({ url, headers, body });

    if (url.includes("api.brevo.com")) {
      if (brevoStatus >= 400) return new Response(JSON.stringify({ message: "Quota exceeded" }), { status: brevoStatus });
      return new Response(JSON.stringify({ messageId: `<brevo-msg-${seq++}@facturayave.org>` }), { status: 201 });
    }
    if (url.includes("api.resend.com")) {
      if (resendStatus >= 400) return new Response(JSON.stringify({ message: "Resend error" }), { status: resendStatus });
      return new Response(JSON.stringify({ id: `re_msg_${seq++}` }), { status: 200 });
    }
    return new Response("Not mocked", { status: 500 });
  }) as typeof fetch;

  try {
    // 2) Retrocompatibilidad: sin secretos de plataforma debe reportar modo_plataforma = false y no fallar
    const envLegado: EnvTest = { DB: db, MASTER_KEY, SUPER_ADMIN_EMAIL: "super@plataforma.test" };
    const cfgLeg = await leerConfigCorreo(db, envLegado);
    assert.equal(cfgLeg.modo_plataforma, false);

    // Con secretos de plataforma: GET /api/sistema/correo reporta modo_plataforma = true
    const cfgPlatApi = await reqJson(envBase, jarSuper, "/api/sistema/correo");
    assert.equal(cfgPlatApi.status, 200);
    assert.equal(cfgPlatApi.data.modo_plataforma, true);
    assert.equal(cfgPlatApi.data.remitente_plataforma, "facturas@facturayave.org");
    assert.equal(cfgPlatApi.data.reply_to, "facturacion@clinicaprincipal.test");

    // 3) Envío de documento (INQUILINO) sale por Brevo con nombre del negocio + Reply-To + pie discreto + tags
    const rDoc = await enviarCorreo(db, { ...envBase, __rawDb: db, __inquilinoCodigo: "principal" }, {
      para: "cliente1@ejemplo.test",
      alcance: "INQUILINO",
      tipo: "DOCUMENTO",
      asunto: "Factura 00000001",
      html: "<p>Su factura</p>",
      texto: "Su factura",
    });
    assert.equal(rDoc.ok, true);
    if (rDoc.ok) assert.equal(rDoc.proveedor, "BREVO");
    const call1 = llamadas[llamadas.length - 1];
    assert.ok(call1.url.includes("api.brevo.com"));
    assert.equal(call1.body.sender.email, "facturas@facturayave.org");
    assert.equal(call1.body.sender.name, "Clinica Principal CA (vía FacturaYa Venezuela)");
    assert.equal(call1.body.replyTo.email, "facturacion@clinicaprincipal.test");
    assert.ok(String(call1.body.htmlContent).includes("Enviado mediante FacturaYa Venezuela"));
    assert.deepEqual(call1.body.tags, ["inq:principal", "tipo:DOCUMENTO"]);
    const msgIdBrevo1 = rDoc.ok ? rDoc.messageId! : "";

    // 4) Failover automático: si Brevo responde HTTP 429, reintenta de inmediato con Resend (con Idempotency-Key) y abre circuito en Brevo
    brevoStatus = 429;
    const rFailover = await enviarCorreo(db, { ...envBase, __rawDb: db, __inquilinoCodigo: "principal" }, {
      para: "cliente2@ejemplo.test",
      alcance: "INQUILINO",
      tipo: "RECIBO",
      asunto: "Recibo 00000001",
      html: "<p>Su recibo</p>",
      texto: "Su recibo",
    });
    assert.equal(rFailover.ok, true);
    if (rFailover.ok) assert.equal(rFailover.proveedor, "RESEND");
    const callResend = llamadas[llamadas.length - 1];
    assert.ok(callResend.url.includes("api.resend.com"));
    assert.ok(callResend.headers["idempotency-key"], "Resend debe recibir Idempotency-Key");
    assert.equal(callResend.body.reply_to, "facturacion@clinicaprincipal.test");

    // Como el circuito de Brevo quedó abierto, el siguiente envío salta directo a Resend SIN llamar a Brevo
    brevoStatus = 201;
    const antesN = llamadas.length;
    const rSalto = await enviarCorreo(db, { ...envBase, __rawDb: db, __inquilinoCodigo: "principal" }, {
      para: "cliente3@ejemplo.test",
      alcance: "PLATAFORMA",
      tipo: "PRUEBA",
      asunto: "Prueba circuito",
      html: "<p>Hola</p>",
    });
    assert.equal(rSalto.ok, true);
    assert.equal(llamadas.length, antesN + 1, "Debe saltar Brevo y hacer 1 sola llamada directa a Resend");
    assert.ok(llamadas[llamadas.length - 1].url.includes("api.resend.com"));

    // Reiniciar circuito desde el Panel Súper Admin
    const resetRes = await reqJson(envBase, jarSuper, "/api/correos/circuitos/reiniciar", "POST", { proveedor: "BREVO" });
    assert.equal(resetRes.status, 200);

    // 5) Webhooks fail-closed: sin secreto responde 503; con secreto malo responde 401; con secreto válido procesa
    const envSinSec = { ...envBase, BREVO_WEBHOOK_SECRET: "" };
    const wh503 = await reqJson(envSinSec, new CookieJar(), "/api/correo/eventos/brevo", "POST", { event: "delivered" });
    assert.equal(wh503.status, 503);
    const wh401 = await reqJson(envBase, new CookieJar(), "/api/correo/eventos/brevo", "POST", { event: "delivered" }, { "x-webhook-secret": "malo" });
    assert.equal(wh401.status, 401);

    // 6) Rebote duro por webhook -> bloquea de inmediato, guarda HMAC-SHA256 (sin texto plano en _mt_correos_bloqueos) y actualiza historial del inquilino
    const whHard = await reqJson(
      envBase,
      new CookieJar(),
      "/api/correo/eventos/brevo",
      "POST",
      {
        event: "hard_bounce",
        email: "cliente1@ejemplo.test",
        "message-id": msgIdBrevo1,
        reason: "550 5.1.1 User unknown",
        tags: ["inq:principal", "tipo:DOCUMENTO"],
      },
      { "x-webhook-secret": "sec-brevo-123456" }
    );
    assert.equal(whHard.status, 200);
    assert.equal(whHard.data.procesados, 1);

    // Verificar que NO existe el correo en texto plano en _mt_correos_bloqueos
    const bloqRow = await db.prepare(`SELECT email_hash, mascara, tipo FROM _mt_correos_bloqueos`).first<Record<string, string>>();
    assert.ok(bloqRow?.email_hash && bloqRow.email_hash.length === 64);
    assert.ok(!bloqRow.email_hash.includes("cliente1"));
    assert.equal(bloqRow.mascara, "c***1@ejemplo.test");
    assert.equal(bloqRow.tipo, "REBOTE_DURO");

    // Reintentar enviar a cliente1 debe bloquear con mensaje claro
    const rBloqHard = await enviarCorreo(db, { ...envBase, __rawDb: db, __inquilinoCodigo: "principal" }, {
      para: "cliente1@ejemplo.test",
      alcance: "INQUILINO",
      tipo: "DOCUMENTO",
      asunto: "Reintento",
      html: "<p>Reintento</p>",
    });
    assert.equal(rBloqHard.ok, false);
    if (!rBloqHard.ok) assert.ok(rBloqHard.error.includes("rebotó"), rBloqHard.error);

    // 7) Rebote blando: 1 y 2 NO bloquean; al 3er rebote blando pausa por 1 hora
    for (let i = 1; i <= 2; i++) {
      await reqJson(
        envBase,
        new CookieJar(),
        "/api/correo/eventos/brevo",
        "POST",
        { event: "soft_bounce", email: "lleno@ejemplo.test", reason: "Mailbox full", tags: ["inq:principal", "tipo:DOCUMENTO"] },
        { "x-webhook-secret": "sec-brevo-123456" }
      );
    }
    const rBlando2 = await enviarCorreo(db, { ...envBase, __rawDb: db, __inquilinoCodigo: "principal" }, {
      para: "lleno@ejemplo.test",
      alcance: "INQUILINO",
      tipo: "DOCUMENTO",
      asunto: "Intento tras 2 blandos",
      html: "<p>Hola</p>",
    });
    assert.equal(rBlando2.ok, true, "Con 2 rebotes blandos todavía debe permitir enviar");

    await reqJson(
      envBase,
      new CookieJar(),
      "/api/correo/eventos/brevo",
      "POST",
      { event: "soft_bounce", email: "lleno@ejemplo.test", reason: "Mailbox full", tags: ["inq:principal", "tipo:DOCUMENTO"] },
      { "x-webhook-secret": "sec-brevo-123456" }
    );
    const rBlando3 = await enviarCorreo(db, { ...envBase, __rawDb: db, __inquilinoCodigo: "principal" }, {
      para: "lleno@ejemplo.test",
      alcance: "INQUILINO",
      tipo: "DOCUMENTO",
      asunto: "Intento tras 3 blandos",
      html: "<p>Hola</p>",
    });
    assert.equal(rBlando3.ok, false, "Al 3er rebote blando debe pausar por 1 hora");
    if (!rBlando3.ok) assert.ok(rBlando3.error.includes("3 rebotes temporales"), rBlando3.error);

    // 8) Queja de spam -> bloqueo permanente + alerta crítica inmediata al Súper Admin
    await reqJson(
      envBase,
      new CookieJar(),
      "/api/correo/eventos/resend",
      "POST",
      { type: "email.complained", data: { email_id: "re_spam_1", to: ["spammer@ejemplo.test"], tags: [{ name: "inq", value: "principal" }] } },
      { "x-webhook-secret": "sec-resend-123456" }
    );
    const rSpam = await enviarCorreo(db, { ...envBase, __rawDb: db, __inquilinoCodigo: "principal" }, {
      para: "spammer@ejemplo.test",
      alcance: "INQUILINO",
      tipo: "DOCUMENTO",
      asunto: "Tras spam",
      html: "<p>Hola</p>",
    });
    assert.equal(rSpam.ok, false);
    if (!rSpam.ok) assert.ok(rSpam.error.includes("spam"), rSpam.error);

    // 9) Fusible diario configurable por inquilino
    const setLim = await reqJson(envBase, jarSuper, "/api/correos/limites/principal", "PUT", {
      alerta_diaria: 2,
      fusible_diario: 4,
    });
    assert.equal(setLim.status, 200);
    // Ya llevamos 4 envíos hoy en principal -> el 5to debe disparar el fusible
    const rFusible = await enviarCorreo(db, { ...envBase, __rawDb: db, __inquilinoCodigo: "principal" }, {
      para: "nuevo@ejemplo.test",
      alcance: "INQUILINO",
      tipo: "DOCUMENTO",
      asunto: "Excede fusible",
      html: "<p>Hola</p>",
    });
    assert.equal(rFusible.ok, false);
    if (!rFusible.ok) assert.ok(rFusible.error.includes("tope diario de seguridad"), rFusible.error);

    // Quitar el fusible (0 = sin tope) permite enviar de nuevo
    await reqJson(envBase, jarSuper, "/api/correos/limites/principal", "PUT", { alerta_diaria: 100, fusible_diario: 0 });
    const rSinFus = await enviarCorreo(db, { ...envBase, __rawDb: db, __inquilinoCodigo: "principal" }, {
      para: "nuevo@ejemplo.test",
      alcance: "INQUILINO",
      tipo: "DOCUMENTO",
      asunto: "Sin fusible",
      html: "<p>Hola</p>",
    });
    assert.equal(rSinFus.ok, true);

    // 10) Desbloquear correo desde el panel y verificar que vuelve a enviarse
    const desb = await reqJson(envBase, jarSuper, "/api/correos/bloqueos/desbloquear", "POST", { email: "cliente1@ejemplo.test" });
    assert.equal(desb.status, 200);
    assert.equal(desb.data.eliminados, 1);

    // 11) Verificar Panel Global Súper Admin (sin exponer secretos ni correos planos) e Historial del inquilino
    const panel = await reqJson(envBase, jarSuper, "/api/correos/panel");
    assert.equal(panel.status, 200);
    assert.equal(panel.data.fecha_utc, fechaUtcHoy());
    assert.equal(panel.data.secretos.BREVO_API_KEY, true);
    assert.equal(panel.data.secretos.RESEND_API_KEY, true);
    assert.equal(panel.data.secretos.ZEPTOMAIL_API_KEY, false);
    const jsonPanel = JSON.stringify(panel.data);
    assert.ok(!jsonPanel.includes("xkeysib-plataforma-test"), "Nunca exponer claves API en el panel");
    assert.ok(!jsonPanel.includes("spammer@ejemplo.test"), "Nunca exponer correos en texto plano en bloqueos del panel");
    assert.ok(panel.data.alertas.some((a: any) => String(a.clave).startsWith("spam:")), "Debe existir alerta crítica de spam");

    const hist = await reqJson(envBase, jarSuper, "/api/correos/historial");
    assert.equal(hist.status, 200);
    assert.ok(hist.data.envios.some((e: any) => e.destinatario === "cliente1@ejemplo.test" && e.estado === "REBOTADO"));

    // 12) Verificar escenario de SOLO Brevo agotado al 100% -> mensaje claro de cuota diaria agotada
    const envSoloBrevo: EnvTest = {
      DB: db,
      MASTER_KEY,
      SUPER_ADMIN_EMAIL: "super@plataforma.test",
      EMAIL_REMITENTE: "facturas@facturayave.org",
      BREVO_API_KEY: "xkeysib-plataforma-test",
      BREVO_CUOTA_DIARIA: "1",
    };
    const rCuota = await enviarCorreo(db, { ...envSoloBrevo, __rawDb: db, __inquilinoCodigo: "principal" }, {
      para: "cuota@ejemplo.test",
      alcance: "PLATAFORMA",
      tipo: "PRUEBA",
      asunto: "Cuota agotada",
      html: "<p>Test</p>",
    });
    assert.equal(rCuota.ok, false);
    if (!rCuota.ok) assert.ok(rCuota.error.includes("Cuota diaria"), rCuota.error);
  } finally {
    globalThis.fetch = fetchOrig;
  }
});
