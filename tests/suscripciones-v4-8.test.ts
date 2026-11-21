import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { aTasaE8 } from "../public/dinero.js";
import { NOMBRE_ROL } from "../src/permisos";
import {
  calcularCobroSuscripcion,
  ejecutarCobroAutomaticoDia1,
} from "../src/suscripciones";

type EnvTest = Record<string, unknown> & {
  DB: ReturnType<typeof crearBaseDatosD1>;
  DB_1?: ReturnType<typeof crearBaseDatosD1>;
  DB_2?: ReturnType<typeof crearBaseDatosD1>;
};

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

async function reqJson(
  env: EnvTest,
  jar: CookieJar,
  ruta: string,
  metodo = "GET",
  body?: unknown,
  headersExtra: Record<string, string> = {}
) {
  const headers: Record<string, string> = { ...headersExtra };
  const ck = jar.cabecera();
  if (ck) headers.Cookie = ck;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const req = new Request(`https://facturayave.com${ruta}`, {
    method: metodo,
    headers,
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const res = await app.fetch(req, env as unknown as Parameters<typeof app.fetch>[1]);
  jar.guardar(res);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data as Record<string, any>, res };
}

test("1. Reglas puras calcularCobroSuscripcion: prorrateo día 1 en centavos enteros, transición promo $5 -> regular $10, IVA vs Formal", () => {
  const tasa50 = aTasaE8("50"); // Bs 50,00 por USD exacto

  // Alta el día 1 -> mes completo promo $5.00 (500 centavos) sin prorrateo
  const cDia1 = calcularCobroSuscripcion({
    fecha_alta: "2026-11-01",
    periodo_ym: "2026-11",
    tasa_e8: tasa50,
    alicuota_cent: 0,
  });
  assert.equal(cDia1.indice_mes, 1);
  assert.equal(cDia1.es_promo, true);
  assert.equal(cDia1.prorrateado, false);
  assert.equal(cDia1.dias_cobrados, 30);
  assert.equal(cDia1.dias_mes, 30);
  assert.equal(cDia1.subtotal_usd_cent, 500);
  assert.equal(cDia1.iva_usd_cent, 0);
  assert.equal(cDia1.total_usd_cent, 500);
  assert.equal(cDia1.total_bs_cent, 25000); // Bs 250,00 exactos

  // Alta el día 16 de noviembre (30 días) -> 15/30 días = 250 centavos exactos ($2.50)
  const cDia16 = calcularCobroSuscripcion({
    fecha_alta: "2026-11-16",
    periodo_ym: "2026-11",
    tasa_e8: tasa50,
    alicuota_cent: 0,
  });
  assert.equal(cDia16.prorrateado, true);
  assert.equal(cDia16.dias_cobrados, 15);
  assert.equal(cDia16.dias_mes, 30);
  assert.equal(cDia16.subtotal_usd_cent, 250);
  assert.equal(cDia16.total_usd_cent, 250);
  assert.equal(cDia16.total_bs_cent, 12500); // Bs 125,00 exactos
  assert.ok(cDia16.concepto.includes("15/30 días"));

  // Alta el día 2 de noviembre (30 días) -> 29/30 días = round(500*29/30) = 483 centavos exactos ($4.83)
  const cDia2 = calcularCobroSuscripcion({
    fecha_alta: "2026-11-02",
    periodo_ym: "2026-11",
    tasa_e8: tasa50,
    alicuota_cent: 0,
  });
  assert.equal(cDia2.prorrateado, true);
  assert.equal(cDia2.dias_cobrados, 29);
  assert.equal(cDia2.subtotal_usd_cent, 483);
  assert.equal(cDia2.total_bs_cent, 24150); // 483 * 50 = Bs 241,50 exactos

  // Mes 3 (2027-01) sigue en promo $5.00
  const cMes3 = calcularCobroSuscripcion({
    fecha_alta: "2026-11-15",
    periodo_ym: "2027-01",
    tasa_e8: tasa50,
    alicuota_cent: 0,
  });
  assert.equal(cMes3.indice_mes, 3);
  assert.equal(cMes3.es_promo, true);
  assert.equal(cMes3.prorrateado, false);
  assert.equal(cMes3.subtotal_usd_cent, 500);

  // Mes 4 (2027-02) pasa automáticamente a tarifa regular $10.00 (1000 centavos) + IVA 16% (contribuyente ordinario)
  const cMes4Iva = calcularCobroSuscripcion({
    fecha_alta: "2026-11-15",
    periodo_ym: "2027-02",
    tasa_e8: tasa50,
    alicuota_cent: 1600,
  });
  assert.equal(cMes4Iva.indice_mes, 4);
  assert.equal(cMes4Iva.es_promo, false);
  assert.equal(cMes4Iva.subtotal_usd_cent, 1000);
  assert.equal(cMes4Iva.iva_usd_cent, 160);
  assert.equal(cMes4Iva.total_usd_cent, 1160);
  assert.equal(cMes4Iva.total_bs_cent, 58000); // Bs 580,00 exactos

  // Período anterior a la fecha de alta lanza error claro
  assert.throws(
    () =>
      calcularCobroSuscripcion({
        fecha_alta: "2026-11-10",
        periodo_ym: "2026-10",
        tasa_e8: tasa50,
      }),
    /posterior al período/
  );
});

test("2. Motor SaaS E2E: alta con fecha_alta, vista previa, factura atómica + correo Reply-To pagos@, idempotencia, recibo, cron día 1 y suspensión manual con contraseña", async () => {
  const dbMain = crearBaseDatosD1(":memory:");
  const dbInq1 = crearBaseDatosD1(":memory:");
  const dbInq2 = crearBaseDatosD1(":memory:");
  const MASTER_KEY = "llave-maestra-super-secreta-v48-pruebas-32chars!!";
  const SUPER_CLAVE = "SuperAdminClave123!";
  const env: EnvTest = {
    DB: dbMain,
    DB_1: dbInq1,
    DB_2: dbInq2,
    MASTER_KEY,
    SUPER_ADMIN_EMAIL: "super@facturayave.com",
    EMAIL_REMITENTE: "facturas@mail.facturayave.com",
    EMAIL_NOMBRE_PLATAFORMA: "FacturaYa Venezuela",
    BREVO_API_KEY: "xkeysib-test-v48",
    WHATSAPP_CONTACTO: "584120001122",
  };

  // 1) Instalar empresa principal (Súper Admin) como Contribuyente Formal (IVA 0%)
  const jarSuper = new CookieJar();
  const inst = await reqJson(env, jarSuper, "/api/instalar", "POST", {
    nombre: "EXENET Soluciones CA",
    rif: "J-50001122-3",
    direccion: "Av. Bolívar, Caracas",
    telefono: "0412-0001122",
    email: "super@facturayave.com",
    clave: SUPER_CLAVE,
    tipo_contribuyente: "FORMAL",
  });
  assert.equal(inst.status, 200);

  // Configurar tasa BCV y métodos de cobro (Pago Móvil + Binance) en la empresa principal
  const rTasa = await reqJson(env, jarSuper, "/api/config", "PUT", { tasa_bcv: "60", tasa_bcv_modo: "MANUAL" });
  assert.equal(rTasa.status, 200);
  await dbMain
    .prepare(
      `INSERT OR REPLACE INTO metodos_cobro (metodo, activo, datos_json) VALUES
       ('PAGO_MOVIL', 1, '{"banco":"Banesco (0134)","telefono":"0412-0001122","documento":"V-12345678"}'),
       ('BINANCE', 1, '{"contacto":"pagos@facturayave.com","nota":"USDT sin comisión"}')`
    )
    .run();

  // Mock de fetch para capturar envío de Brevo sin tocar la red
  const llamadasCorreo: { url: string; body: Record<string, any> }[] = [];
  const fetchOrig = globalThis.fetch;
  let msgSeq = 1;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes("api.brevo.com")) {
      llamadasCorreo.push({ url, body });
      return new Response(JSON.stringify({ messageId: `<saas-v48-${msgSeq++}@mail.facturayave.com>` }), { status: 201 });
    }
    return new Response("Not mocked", { status: 500 });
  }) as typeof fetch;

  try {
    // 2) Dar de alta 2 empresas clientes: DB_1 (alta día 16, auto=OFF) y DB_2 (alta día 01, auto=ON)
    const alta1 = await reqJson(env, jarSuper, "/api/inquilinos", "POST", {
      codigo: "DB_1",
      nombre_negocio: "Clínica Dental Sonrisa CA",
      rif: "J-40112233-4",
      direccion: "Valencia, Carabobo",
      telefono: "0414-5550001",
      nombre_dueno: "Dra. Elena Torres",
      email_dueno: "elena@sonrisa.test",
      fecha_alta: "2026-11-16",
      precio_promo_usd_cent: 500,
      meses_promo: 3,
      precio_regular_usd_cent: 1000,
      cobro_auto_dia1: false,
    });
    assert.equal(alta1.status, 200, JSON.stringify(alta1.data));
    assert.equal(alta1.data.fecha_alta, "2026-11-16");
    assert.equal(Boolean(alta1.data.cobro_auto_dia1), false);

    const alta2 = await reqJson(env, jarSuper, "/api/inquilinos", "POST", {
      codigo: "DB_2",
      nombre_negocio: "Taller Automotriz Norte SRL",
      rif: "J-40998877-5",
      direccion: "Maracay, Aragua",
      telefono: "0414-5550002",
      nombre_dueno: "Carlos Pérez",
      email_dueno: "carlos@tallernorte.test",
      fecha_alta: "2026-11-01",
      precio_promo_usd_cent: 500,
      meses_promo: 3,
      precio_regular_usd_cent: 1000,
      cobro_auto_dia1: true,
    });
    assert.equal(alta2.status, 200, JSON.stringify(alta2.data));
    assert.equal(Boolean(alta2.data.cobro_auto_dia1), true);

    // 3) Vista previa de cobro para DB_1 en 2026-11 -> prorrateo 15/30 = $2.50 (250 centavos) sin emitir factura todavía
    const prev1 = await reqJson(env, jarSuper, "/api/inquilinos/DB_1/cobrar", "POST", {
      periodo_ym: "2026-11",
      solo_vista_previa: true,
    });
    assert.equal(prev1.status, 200);
    assert.equal(prev1.data.vista_previa, true);
    assert.equal(prev1.data.calculo.prorrateado, true);
    assert.equal(prev1.data.calculo.total_usd_cent, 250);
    assert.equal(prev1.data.calculo.total_bs_cent, 15000); // 250 * 60 = Bs 150,00
    assert.equal(prev1.data.metodos.length, 2);

    const docsAntes = await dbMain.prepare(`SELECT COUNT(*) AS n FROM documentos`).first<{ n: number }>();
    assert.equal(docsAntes?.n, 0, "Vista previa nunca debe crear documentos en D1");

    // 4) Emitir y enviar cobro real para DB_1 (2026-11)
    const cobro1 = await reqJson(env, jarSuper, "/api/inquilinos/DB_1/cobrar", "POST", {
      periodo_ym: "2026-11",
    });
    assert.equal(cobro1.status, 200, JSON.stringify(cobro1.data));
    assert.equal(cobro1.data.ya_existia, false);
    assert.equal(cobro1.data.cobro.numero_factura, 1);
    assert.equal(cobro1.data.cobro.total_usd_cent, 250);
    assert.equal(cobro1.data.cobro.total_bs_cent, 15000);
    assert.equal(cobro1.data.cobro.correo_enviado, 1);
    assert.equal(cobro1.data.correo.enviado, true);

    // Verificar cliente sincronizado y factura atómica emitida en empresa principal
    const cliMain = await dbMain
      .prepare(`SELECT rif_cedula, nombre_apellido, email FROM clientes WHERE upper(rif_cedula) = 'J-40112233-4'`)
      .first<Record<string, string>>();
    assert.equal(cliMain?.nombre_apellido, "Clínica Dental Sonrisa CA");

    const docMain = await dbMain
      .prepare(`SELECT tipo, estado, numero, total_usd, total_bs FROM documentos WHERE id = ?`)
      .bind(cobro1.data.cobro.documento_id)
      .first<Record<string, any>>();
    assert.equal(docMain?.tipo, "FACTURA");
    assert.equal(docMain?.estado, "EMITIDO");
    assert.equal(docMain?.numero, 1);
    assert.equal(docMain?.total_usd, 250);
    assert.equal(docMain?.total_bs, 15000);

    // Verificar correo de bienvenida (soporte@) y correo de factura SaaS (Reply-To pagos@ + Pago Móvil/Binance)
    const mailBienv = llamadasCorreo.find((c) => c.body.to?.[0]?.email === "elena@sonrisa.test" && String(c.body.subject).includes("Bienvenido"));
    assert.ok(mailBienv, "Debe haberse enviado el correo de bienvenida a la administradora de DB_1");
    assert.equal(mailBienv!.body.replyTo.email, "soporte@facturayave.com");

    const mailCobro = llamadasCorreo.find((c) => c.body.to?.[0]?.email === "elena@sonrisa.test" && String(c.body.subject).includes("Factura N.º"));
    assert.ok(mailCobro, "Debe haberse enviado el correo de factura SaaS a la administradora de DB_1");
    assert.equal(mailCobro!.body.replyTo.email, "pagos@facturayave.com");
    assert.ok(String(mailCobro!.body.htmlContent).includes("Pago Móvil"));
    assert.ok(String(mailCobro!.body.htmlContent).includes("Binance"));
    assert.ok(String(mailCobro!.body.htmlContent).includes("pagos@facturayave.com"));
    assert.ok(String(mailCobro!.body.htmlContent).includes("Imprenta Digital"));

    // 5) Idempotencia estricta: segundo POST sin reenviar_correo NO crea segunda factura ni envía correo duplicado
    const correosAntesDup = llamadasCorreo.length;
    const cobro1Dup = await reqJson(env, jarSuper, "/api/inquilinos/DB_1/cobrar", "POST", {
      periodo_ym: "2026-11",
    });
    assert.equal(cobro1Dup.status, 200);
    assert.equal(cobro1Dup.data.ya_existia, true);
    assert.equal(cobro1Dup.data.cobro.numero_factura, 1);
    assert.equal(llamadasCorreo.length, correosAntesDup);
    const docsDespuesDup = await dbMain.prepare(`SELECT COUNT(*) AS n FROM documentos`).first<{ n: number }>();
    assert.equal(docsDespuesDup?.n, 1, "Idempotencia: jamás duplicar factura para el mismo período");

    // 6) Registrar pago recibido -> emite recibo atómico en principal y marca PAGADO
    const pago1 = await reqJson(env, jarSuper, `/api/inquilinos/DB_1/cobros/${cobro1.data.cobro.id}/pagar`, "POST", {
      metodo: "PAGO_MOVIL",
      moneda: "BS",
      referencia: "PM-987654",
    });
    assert.equal(pago1.status, 200, JSON.stringify(pago1.data));
    assert.equal(pago1.data.recibo_numero, 1);
    assert.equal(pago1.data.cobro.estado, "PAGADO");
    assert.equal(pago1.data.cobro.referencia_pago, "PM-987654");

    const pagoRow = await dbMain.prepare(`SELECT numero, metodo, monto_usd, referencia FROM pagos WHERE documento_id = ?`).bind(cobro1.data.cobro.documento_id).first<Record<string, any>>();
    assert.equal(pagoRow?.numero, 1);
    assert.equal(pagoRow?.metodo, "PAGO_MOVIL");
    assert.equal(pagoRow?.monto_usd, 250);

    // 7) Cron automático día 1:
    // - En día 15 NO ejecuta nada
    const cronDia15 = await ejecutarCobroAutomaticoDia1(dbMain as unknown as D1Database, env, "2026-12-15");
    assert.equal(cronDia15.ejecutados, 0);
    // - En día 1 de 2026-12 ejecuta SOLO DB_2 (cobro_auto_dia1 = 1) y salta DB_1 (cobro_auto_dia1 = 0)
    const cronDia1 = await ejecutarCobroAutomaticoDia1(dbMain as unknown as D1Database, env, "2026-12-01");
    assert.equal(cronDia1.ejecutados, 1);
    assert.equal(cronDia1.errores, 0);
    const cobroDb2 = await dbMain
      .prepare(`SELECT * FROM _mt_cobros_saas WHERE inquilino_codigo = 'DB_2' AND periodo_ym = '2026-12'`)
      .first<Record<string, any>>();
    assert.ok(cobroDb2, "Cron día 1 debe facturar a DB_2 (switch encendido)");
    assert.equal(cobroDb2!.total_usd_cent, 500);
    const cobroDb1Dic = await dbMain
      .prepare(`SELECT * FROM _mt_cobros_saas WHERE inquilino_codigo = 'DB_1' AND periodo_ym = '2026-12'`)
      .first();
    assert.equal(cobroDb1Dic, null, "Cron día 1 NO debe facturar a DB_1 (switch apagado)");

    // Verificar que el cron jamás suspendió ninguna empresa
    const estadosTrasCron = await dbMain.prepare(`SELECT codigo, activo FROM _mt_inquilinos`).all<{ codigo: string; activo: number }>();
    assert.ok(estadosTrasCron.results.every((r) => r.activo === 1));

    // 8) Suspensión y reactivación 100% manual protegida con contraseña del Súper Admin + cierre inmediato de sesiones
    // Primero inicia sesión la administradora de DB_1
    const jarElena = new CookieJar();
    const loginElena = await reqJson(env, jarElena, "/api/login", "POST", {
      email: "elena@sonrisa.test",
      clave: alta1.data.clave_temporal,
    });
    assert.equal(loginElena.status, 200);
    const cambioElena = await reqJson(env, jarElena, "/api/cuenta/clave", "POST", {
      actual: alta1.data.clave_temporal,
      nueva: "ElenaClaveNueva123!",
    });
    assert.equal(cambioElena.status, 200);
    const estElenaActivo = await reqJson(env, jarElena, "/api/estado");
    assert.equal(estElenaActivo.status, 200);
    assert.equal(estElenaActivo.data.usuario?.email, "elena@sonrisa.test");

    // Intentar suspender SIN contraseña -> 403
    const suspSinClave = await reqJson(env, jarSuper, "/api/inquilinos/DB_1/estado", "PUT", {
      activo: false,
      motivo: "FALTA_PAGO",
    });
    assert.equal(suspSinClave.status, 403);

    // Intentar suspender con contraseña INCORRECTA -> 403
    const suspClaveMala = await reqJson(env, jarSuper, "/api/inquilinos/DB_1/estado", "PUT", {
      activo: false,
      motivo: "FALTA_PAGO",
      clave: "ClaveIncorrecta999!",
    });
    assert.equal(suspClaveMala.status, 403);

    // Suspender con contraseña VÁLIDA -> 200 + cierra sesiones activas en DB_1
    const suspOk = await reqJson(env, jarSuper, "/api/inquilinos/DB_1/estado", "PUT", {
      activo: false,
      motivo: "FALTA_PAGO",
      clave: SUPER_CLAVE,
    });
    assert.equal(suspOk.status, 200, JSON.stringify(suspOk.data));
    assert.equal(suspOk.data.activo, false);
    assert.equal(suspOk.data.motivo_suspension, "FALTA_PAGO");
    assert.ok(suspOk.data.sesiones_cerradas >= 1, "Debe revocar inmediatamente las sesiones activas del inquilino");

    // La sesión que ya tenía abierta Elena en DB_1 queda revocada y bloqueada con aviso de falta de pago
    const estElenaBloq = await reqJson(env, jarElena, "/api/estado");
    assert.equal(estElenaBloq.data.sesion, false);
    assert.equal(estElenaBloq.data.suspendido, true);
    assert.ok(String(estElenaBloq.data.mensaje_suspension || "").toLowerCase().includes("falta de pago"));
    const cliElenaBloq = await reqJson(env, jarElena, "/api/clientes");
    assert.ok(cliElenaBloq.status === 401 || cliElenaBloq.status === 403, `Esperado 401 o 403, recibido ${cliElenaBloq.status}`);

    // Intentar volver a iniciar sesión en DB_1 devuelve 403 con aviso claro de falta de pago y pagos@facturayave.com
    const loginElenaSusp = await reqJson(env, new CookieJar(), "/api/login", "POST", {
      email: "elena@sonrisa.test",
      clave: "ElenaClaveNueva123!",
    });
    assert.equal(loginElenaSusp.status, 403);
    assert.ok(String(loginElenaSusp.data.error).toLowerCase().includes("falta de pago"), loginElenaSusp.data.error);
    assert.ok(String(loginElenaSusp.data.error).includes("pagos@facturayave.com"), loginElenaSusp.data.error);

    // Reactivar también exige contraseña válida
    const reactMala = await reqJson(env, jarSuper, "/api/inquilinos/DB_1/estado", "PUT", {
      activo: true,
      clave: "mal",
    });
    assert.equal(reactMala.status, 403);

    const reactOk = await reqJson(env, jarSuper, "/api/inquilinos/DB_1/estado", "PUT", {
      activo: true,
      clave: SUPER_CLAVE,
    });
    assert.equal(reactOk.status, 200);
    assert.equal(reactOk.data.activo, true);

    // Elena puede volver a entrar normalmente tras la reactivación manual
    const loginElenaRestaurado = await reqJson(env, new CookieJar(), "/api/login", "POST", {
      email: "elena@sonrisa.test",
      clave: "ElenaClaveNueva123!",
    });
    assert.equal(loginElenaRestaurado.status, 200);
  } finally {
    globalThis.fetch = fetchOrig;
  }
});

test("3. WhatsApp diferenciado (público vs soporte interno) sin exponer teléfono y terminología Administrador + SEO", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: EnvTest = {
    DB: db,
    MASTER_KEY: "llave-maestra-super-secreta-v48-wa-32chars!!",
    SUPER_ADMIN_EMAIL: "super@facturayave.com",
    WHATSAPP_CONTACTO: "584129998877",
  };

  // Redirección pública (prospecto comercial)
  const rPub = await app.fetch(
    new Request("https://facturayave.com/api/contacto/whatsapp"),
    env as unknown as Parameters<typeof app.fetch>[1]
  );
  assert.equal(rPub.status, 302);
  const locPub = rPub.headers.get("location") || "";
  assert.ok(locPub.startsWith("https://wa.me/584129998877?text="));
  assert.ok(decodeURIComponent(locPub).includes("información para activar"));

  // Redirección interna (cliente activo solicitando soporte)
  const rSop = await app.fetch(
    new Request("https://facturayave.com/api/contacto/whatsapp?modo=soporte"),
    env as unknown as Parameters<typeof app.fetch>[1]
  );
  assert.equal(rSop.status, 302);
  const locSop = rSop.headers.get("location") || "";
  assert.ok(locSop.startsWith("https://wa.me/584129998877?text="));
  assert.ok(decodeURIComponent(locSop).includes("cliente activo"));
  assert.ok(!decodeURIComponent(locSop).includes("información para activar"));

  // /api/estado nunca expone el número de WhatsApp
  const est = await reqJson(env, new CookieJar(), "/api/estado");
  assert.equal(est.status, 200);
  assert.ok(!JSON.stringify(est.data).includes("584129998877"));

  // Terminología: ADMIN se muestra como "Administrador", cero textos visibles "Dueño"
  assert.equal(NOMBRE_ROL.ADMIN, "Administrador");
  const raiz = process.cwd();
  for (const rel of ["public/app.js", "public/usuarios.js", "public/medio.js", "public/index.html"]) {
    const contenido = fs.readFileSync(path.join(raiz, rel), "utf8");
    assert.ok(!/Dueñ[oa]/i.test(contenido), `${rel} no debe mostrar la palabra "Dueño" al usuario`);
  }

  // Archivos SEO estáticos presentes y válidos (v4.8.1: Googlebot-safe + PNG 1200x630 + Cloudflare Insights CSP)
  const html = fs.readFileSync(path.join(raiz, "public/index.html"), "utf8");
  assert.ok(html.includes('property="og:image" content="https://facturayave.com/og-facturaya.png"'));
  assert.ok(html.includes('application/ld+json'));
  assert.ok(html.includes('"SoftwareApplication"'));
  assert.ok(html.includes('"FAQPage"'));
  assert.ok(fs.existsSync(path.join(raiz, "public/sitemap.xml")));
  assert.ok(fs.existsSync(path.join(raiz, "public/og-facturaya.svg")));
  assert.ok(fs.existsSync(path.join(raiz, "public/og-facturaya.png")));
  const pngBuf = fs.readFileSync(path.join(raiz, "public/og-facturaya.png"));
  assert.equal(pngBuf.readUInt32BE(16), 1200);
  assert.equal(pngBuf.readUInt32BE(20), 630);
  const robots = fs.readFileSync(path.join(raiz, "public/robots.txt"), "utf8");
  assert.ok(robots.includes("Allow: /api/estado"), "robots.txt debe permitir /api/estado para Googlebot");
  assert.ok(robots.includes("Disallow: /api/"));
  assert.ok(robots.includes("Sitemap: https://facturayave.com/sitemap.xml"));
  const headers = fs.readFileSync(path.join(raiz, "public/_headers"), "utf8");
  assert.ok(headers.includes("https://static.cloudflareinsights.com"));
  assert.ok(headers.includes("https://cloudflareinsights.com"));
  const appJs = fs.readFileSync(path.join(raiz, "public/app.js"), "utf8");
  assert.ok(appJs.includes("esRutaPublica") && appJs.includes("return vistaLogin();"), "Portada debe sobrevivir si un rastreador cancela /api/estado");
});
