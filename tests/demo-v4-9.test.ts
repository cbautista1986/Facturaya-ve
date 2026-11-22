import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import {
  CODIGO_DEMO,
  CORREOS_DEMO,
  calcularEstadoDemo,
  construirInvitacionWhatsappDemo,
  enmascararCorreo,
  generarPlanSemillaDemo,
  limpiarDemoExpiradaSiCorresponde,
  motivoBloqueoDemo,
} from "../src/demo";
import { createRequire } from "node:module";
import { construirPdf, nombreArchivo } from "../public/pdf.js";

const require = createRequire(import.meta.url);
const PDFLib = require("../public/vendor/pdf-lib.min.js");

function extraerCookies(res: Response, jar: Record<string, string>) {
  const hdrs = (res.headers as any).getSetCookie ? (res.headers as any).getSetCookie() : [];
  for (const h of hdrs) {
    const par = String(h).split(";")[0];
    const idx = par.indexOf("=");
    if (idx > 0) jar[par.slice(0, idx).trim()] = par.slice(idx + 1).trim();
  }
}

async function reqJson(
  env: Record<string, unknown>,
  jar: Record<string, string>,
  ruta: string,
  metodo = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {}
) {
  const cookieHeader = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const headers: Record<string, string> = { ...extraHeaders };
  if (cookieHeader) headers.cookie = cookieHeader;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(
    new Request(`http://localhost${ruta}`, {
      method: metodo,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env as any
  );
  extraerCookies(res, jar);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test("1. Lógica pura del Entorno Demo (plan semilla 3 meses, bloqueos, invitación WhatsApp y cálculo de vigencia)", () => {
  for (const regimen of ["FORMAL", "ORDINARIO", "ESPECIAL"] as const) {
    const plan = generarPlanSemillaDemo(regimen, 95.5, "2026-11-21");
    assert.equal(plan.clientes.length, 10, `${regimen}: 10 clientes`);
    assert.equal(plan.catalogo.length, 10, `${regimen}: 10 artículos`);
    assert.equal(plan.proveedores.length, 4, `${regimen}: 4 proveedores`);
    assert.equal(plan.facturas.length, 24, `${regimen}: 24 facturas en 3 meses`);

    // Verificar 3 meses distintos cubiertos por las 24 facturas
    const meses = new Set(plan.facturas.map((f) => f.mesOffset));
    assert.equal(meses.size, 3, `${regimen}: facturas distribuidas en 3 meses calendario`);

    // Verificar precisión en centavos enteros
    for (const item of plan.catalogo) {
      assert.ok(Number.isInteger(item.precio_centavos), "precio_centavos debe ser entero en centavos");
      assert.ok(Number.isInteger(item.costo_centavos), "costo_centavos debe ser entero en centavos");
      if (regimen === "FORMAL") {
        assert.equal(item.alicuota_iva, 0, "FORMAL solo puede tener IVA 0%");
      }
    }
    const conIgtf = plan.facturas.filter((f) => f.aplicaIgtf);
    if (regimen === "ESPECIAL") {
      assert.ok(conIgtf.length > 0, "ESPECIAL debe incluir facturas con IGTF 3%");
    } else {
      assert.equal(conIgtf.length, 0, `${regimen} nunca debe aplicar IGTF`);
    }
  }

  // Bloqueos de seguridad Demo
  assert.ok(motivoBloqueoDemo("POST", "/api/sistema/imprenta"));
  assert.ok(motivoBloqueoDemo("POST", "/api/sistema/correo"));
  assert.ok(motivoBloqueoDemo("GET", "/api/cuenta/2fa/estado"));
  assert.ok(motivoBloqueoDemo("POST", "/api/cuenta/clave"));
  assert.ok(motivoBloqueoDemo("GET", "/api/sistema/respaldo"));
  assert.ok(motivoBloqueoDemo("POST", "/api/sistema/restaurar/iniciar"));
  assert.ok(motivoBloqueoDemo("POST", "/api/sistema/reiniciar-fabrica"));
  assert.ok(motivoBloqueoDemo("POST", "/api/sistema/salir-en-vivo"));
  assert.ok(motivoBloqueoDemo("GET", "/api/inquilinos"));
  assert.ok(motivoBloqueoDemo("POST", "/api/demo/crear"));
  assert.ok(motivoBloqueoDemo("GET", "/api/correos/estado"));
  // Rutas operativas permitidas en Demo
  assert.equal(motivoBloqueoDemo("POST", "/api/documentos"), null);
  assert.equal(motivoBloqueoDemo("POST", "/api/pagos"), null);
  assert.equal(motivoBloqueoDemo("GET", "/api/informes/libro-ventas"), null);
  assert.equal(motivoBloqueoDemo("GET", "/api/correos/historial"), null);

  // Estado demo y WhatsApp
  const est = calcularEstadoDemo(
    {
      id: 1,
      activo: 1,
      regimen: "ESPECIAL",
      nombre_negocio: "Distribuidora Demo C.A.",
      email_prospecto: "prospecto@ejemplo.com",
      clave_demo: "Demo-2026-AB12",
      correos_enviados: 2,
      max_correos: 5,
      duracion_min: 120,
      creado_en: 1000,
      expira_en: 8200,
      limpiado: 0,
      actualizado_en: "2026-11-21T12:00:00Z",
    },
    2000
  );
  assert.equal(est.activo, true);
  assert.equal(est.expirado, false);
  assert.equal(est.correos_restantes, 3);
  assert.equal(est.segundos_restantes, 6200);
  assert.equal(enmascararCorreo("prospecto@ejemplo.com"), "pr***o@ejemplo.com");

  const inv = construirInvitacionWhatsappDemo({
    nombre_negocio: "Distribuidora Demo C.A.",
    regimen: "ESPECIAL",
    clave_demo: "Demo-2026-AB12",
    expira_hora_caracas: "21/11/2026, 04:00 p. m.",
    duracion_min: 120,
    email_prospecto: "prospecto@ejemplo.com",
    max_correos: 5,
  });
  assert.match(inv, /facturayave\.com/);
  assert.match(inv, /admin@demo\.facturayave\.com/);
  assert.match(inv, /cajero@demo\.facturayave\.com/);
  assert.match(inv, /contador@demo\.facturayave\.com/);
  assert.match(inv, /Demo-2026-AB12/);
  assert.match(inv, /prospecto@ejemplo\.com/);
});

test("2. E2E completo: aislamiento físico (DB principal + DB_1 real + DB_DEMO), RBAC, 403 bloqueos, guardrail 5 correos, PDF watermark, expiración y borrado limpio", async () => {
  const dbPrincipal = crearBaseDatosD1(":memory:");
  const dbReal1 = crearBaseDatosD1(":memory:");
  const dbDemo = crearBaseDatosD1(":memory:");

  const env: Record<string, unknown> = {
    DB: dbPrincipal,
    DB_1: dbReal1,
    DB_DEMO: dbDemo,
    MASTER_KEY: "clave-maestra-pruebas-demo-v490-0123456789",
    SUPER_ADMIN_EMAIL: "super@plataforma.test",
  };

  const jarSuper: Record<string, string> = {};

  // 2.1 Instalar empresa principal
  const inst = await reqJson(env, jarSuper, "/api/instalar", "POST", {
    nombre: "Empresa Principal Plataforma C.A.",
    rif: "J-11111111-1",
    direccion: "Av. Principal Caracas",
    telefono: "04141112233",
    email: "super@plataforma.test",
    clave: "SuperPassword123!",
    tipo_contribuyente: "ORDINARIO",
    medio_facturacion: "APP_SENIAT",
  });
  assert.equal(inst.status, 200, JSON.stringify(inst.data));

  // 2.2 Crear empresa cliente real en DB_1 (debe permanecer 100% intacta en todo momento)
  const altaReal = await reqJson(env, jarSuper, "/api/inquilinos", "POST", {
    nombre_negocio: "Cliente Real Pagador C.A.",
    rif: "J-22222222-2",
    direccion: "Valencia Carabobo",
    telefono: "04122223344",
    nombre_dueno: "Maria Real",
    cedula_dueno: "V-12345678",
    email_dueno: "dueno@clientereal.test",
    tipo_contribuyente: "ORDINARIO",
    medio_facturacion: "APP_SENIAT",
    modo_inicial: "REAL",
  });
  assert.equal(altaReal.status, 200, JSON.stringify(altaReal.data));
  assert.equal(altaReal.data.codigo || altaReal.data.credenciales?.codigo, "DB_1");

  // Configurar un cliente en DB_1 para verificar integridad antes y después de la Demo
  const cliRealAntes = await dbReal1.prepare(`SELECT COUNT(*) AS n FROM perfil_emisor`).first<{ n: number }>();
  assert.equal(cliRealAntes?.n, 1);
  const inqAntes = await dbPrincipal.prepare(`SELECT COUNT(*) AS n FROM _mt_inquilinos`).first<{ n: number }>();
  assert.equal(inqAntes?.n, 2); // principal + DB_1

  // 2.3 Super Admin crea una Demo ESPECIAL de 2 horas con correo del prospecto
  const crearDemo = await reqJson(env, jarSuper, "/api/demo/crear", "POST", {
    regimen: "ESPECIAL",
    duracion_min: 120,
    nombre_negocio: "Distribuidora Demo Los Andes C.A.",
    email_prospecto: "prospecto.real@cliente.test",
  });
  assert.equal(crearDemo.status, 200, JSON.stringify(crearDemo.data));
  assert.equal(crearDemo.data.ok, true);
  assert.equal(crearDemo.data.estado.regimen, "ESPECIAL");
  assert.equal(crearDemo.data.estado.activo, true);
  assert.equal(crearDemo.data.resumen_semilla.facturas, 24);
  assert.equal(crearDemo.data.resumen_semilla.clientes, 10);
  assert.equal(crearDemo.data.resumen_semilla.catalogo, 10);
  const claveDemo: string = crearDemo.data.credenciales.clave;
  assert.ok(claveDemo.startsWith("Demo-"), `clave generada inválida: ${claveDemo}`);

  // Confirmar que DB_DEMO jamás entró a _mt_inquilinos
  const mtDemo = await dbPrincipal
    .prepare(`SELECT COUNT(*) AS n FROM _mt_inquilinos WHERE codigo = ?`)
    .bind(CODIGO_DEMO)
    .first<{ n: number }>();
  assert.equal(mtDemo?.n, 0, "DB_DEMO nunca debe figurar en _mt_inquilinos");

  // 2.4 Prospecto inicia sesión como Administrador Demo (sin forzar cambio de clave)
  const jarDemoAdmin: Record<string, string> = {};
  const loginAdmin = await reqJson(env, jarDemoAdmin, "/api/login", "POST", {
    email: CORREOS_DEMO.ADMIN,
    clave: claveDemo,
  });
  assert.equal(loginAdmin.status, 200, JSON.stringify(loginAdmin.data));
  assert.equal(loginAdmin.data.inquilino_actual, CODIGO_DEMO);

  const estAdmin = await reqJson(env, jarDemoAdmin, "/api/estado");
  assert.equal(estAdmin.status, 200);
  assert.equal(estAdmin.data.sesion, true);
  assert.equal(estAdmin.data.usuario.debe_cambiar_clave, 0);
  assert.equal(estAdmin.data.demo?.activo, true);
  assert.equal(estAdmin.data.demo?.regimen, "ESPECIAL");
  assert.equal(estAdmin.data.demo?.max_correos, 5);
  assert.equal(estAdmin.data.negocio?.nombre_razon_social, "Distribuidora Demo Los Andes C.A.");

  // Revisar que el Libro de Ventas de los últimos 3 meses devuelve las facturas + NC + ND
  const hoy = new Date().toISOString().slice(0, 10);
  const hace4Meses = new Date(Date.now() - 120 * 86400_000).toISOString().slice(0, 10);
  const libroV = await reqJson(env, jarDemoAdmin, `/api/informes/ventas?desde=${hace4Meses}&hasta=${hoy}`);
  assert.equal(libroV.status, 200, JSON.stringify(libroV.data));
  const filasV = libroV.data.facturas || libroV.data.filas || libroV.data.documentos || [];
  assert.ok(Array.isArray(filasV) && filasV.length >= 24, `Esperaba >= 24 filas en Libro de Ventas, obtuvo ${filasV.length}`);

  // Verificar PDF con marca de agua DEMO
  const docsRes = await reqJson(env, jarDemoAdmin, "/api/documentos");
  assert.equal(docsRes.status, 200);
  const facEmitida = docsRes.data.documentos.find((x: any) => x.tipo === "FACTURA" && x.estado === "EMITIDO");
  assert.ok(facEmitida, "Debe existir al menos una factura emitida en Demo");
  const detFac = await reqJson(env, jarDemoAdmin, `/api/documentos/${facEmitida.id}`);
  assert.equal(detFac.status, 200);
  const docObj = detFac.data.documento || detFac.data.doc;
  assert.equal(JSON.parse(docObj.emisor_json).es_demo, true);
  const pdfBytes = await construirPdf(PDFLib, { ...detFac.data, doc: docObj, negocio: estAdmin.data.negocio, esDemo: true });
  assert.ok(pdfBytes instanceof Uint8Array && pdfBytes.byteLength > 1000);
  assert.ok(nombreArchivo(docObj, true).startsWith("DEMO-"));

  // 2.5 Verificar TODOS los bloqueos de seguridad en Demo (HTTP 403)
  const bloqueadas: [string, string, unknown?][] = [
    ["POST", "/api/sistema/imprenta", { proveedor: "HKA", url: "https://x.test", api_key: "abc" }],
    ["POST", "/api/sistema/medio", { medio: "IMPRENTA_DIGITAL" }],
    ["POST", "/api/sistema/correo", { proveedor: "BREVO", remitente: "a@b.com", clave: "x" }],
    ["POST", "/api/sistema/correo/probar", { para: "x@y.com" }],
    ["GET", "/api/cuenta/2fa/estado"],
    ["POST", "/api/cuenta/2fa/iniciar", { clave: claveDemo }],
    ["POST", "/api/cuenta/clave", { actual: claveDemo, nueva: "OtraClaveSegura999!" }],
    ["POST", "/api/cuenta/codigo-recuperacion", { clave: claveDemo }],
    ["GET", "/api/sistema/respaldo"],
    ["POST", "/api/sistema/restaurar/iniciar", {}],
    ["POST", "/api/sistema/reiniciar-fabrica", { clave: claveDemo, confirmo: true }],
    ["POST", "/api/sistema/salir-en-vivo", { confirmo: true }],
    ["GET", "/api/inquilinos"],
    ["GET", "/api/demo"],
    ["POST", "/api/demo/crear", { regimen: "FORMAL" }],
    ["GET", "/api/correos/estado"],
  ];
  for (const [metodo, ruta, body] of bloqueadas) {
    const r = await reqJson(env, jarDemoAdmin, ruta, metodo, body);
    assert.equal(r.status, 403, `Ruta sensible ${metodo} ${ruta} debió dar 403 en Demo, dio ${r.status}: ${JSON.stringify(r.data)}`);
  }

  // 2.6 Verificar RBAC Cajero (sin costos) y Contador (solo lectura libros)
  const jarCajero: Record<string, string> = {};
  const logCaj = await reqJson(env, jarCajero, "/api/login", "POST", { email: CORREOS_DEMO.CAJERO, clave: claveDemo });
  assert.equal(logCaj.status, 200);
  const catCaj = await reqJson(env, jarCajero, "/api/catalogo");
  assert.equal(catCaj.status, 200);
  const itemsCaj = catCaj.data.items || catCaj.data.catalogo || catCaj.data.articulos || [];
  assert.ok(itemsCaj.length >= 10, `Esperaba >= 10 artículos en catálogo, obtuvo ${itemsCaj.length}`);
  for (const a of itemsCaj) {
    assert.equal("costo_usd" in a, false, "Cajero en Demo jamás debe recibir costo_usd");
    assert.equal("costo_centavos" in a, false, "Cajero en Demo jamás debe recibir costo_centavos");
  }

  const jarContador: Record<string, string> = {};
  const logCont = await reqJson(env, jarContador, "/api/login", "POST", { email: CORREOS_DEMO.CONTADOR, clave: claveDemo });
  assert.equal(logCont.status, 200);
  const libCont = await reqJson(env, jarContador, `/api/informes/resumen-iva?desde=${hace4Meses}&hasta=${hoy}`);
  assert.equal(libCont.status, 200, JSON.stringify(libCont.data));
  const contNoFactura = await reqJson(env, jarContador, "/api/documentos", "POST", { tipo: "FACTURA" });
  assert.equal(contNoFactura.status, 403, "Contador no debe poder crear facturas");

  // 2.7 Guardrail de Correo Seguro en Demo (máx. 5 correos, 100% redirigidos al email_prospecto)
  env.BREVO_API_KEY = "xkeysib-demo-test-fake-key";
  env.EMAIL_REMITENTE = "facturas@mail.facturayave.com";
  const enviosInterceptados: Array<{ to: string[]; subject: string; html: string; cc?: unknown }> = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.brevo.com")) {
      const payload = JSON.parse(String(init?.body || "{}"));
      enviosInterceptados.push({
        to: (payload.to || []).map((x: any) => x.email),
        subject: String(payload.subject || ""),
        html: String(payload.htmlContent || ""),
        cc: payload.cc,
      });
      return new Response(JSON.stringify({ messageId: `<demo-${enviosInterceptados.length}@test>` }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return fetchOriginal(input, init);
  }) as typeof fetch;

  try {
    for (let i = 1; i <= 5; i++) {
      const rEnv = await reqJson(env, jarDemoAdmin, `/api/documentos/${facEmitida.id}/enviar-correo`, "POST", {
        email: `tercero.desconocido.${i}@spam.invalid`,
      });
      assert.equal(rEnv.status, 200, `Envío ${i}/5 falló: ${JSON.stringify(rEnv.data)}`);
      assert.equal(rEnv.data.demo_redirigido_a, "prospecto.real@cliente.test");
      assert.equal(rEnv.data.demo_restantes, 5 - i);
    }
    // El 6º correo DEBE ser rechazado sin llamar a Brevo
    const rSexto = await reqJson(env, jarDemoAdmin, `/api/documentos/${facEmitida.id}/enviar-correo`, "POST", {
      email: "otro@cliente.invalid",
    });
    assert.equal(rSexto.status, 400);
    assert.match(String(rSexto.data.error || ""), /límite de 5 correos/i);
    assert.equal(enviosInterceptados.length, 5, "Solo debieron salir 5 peticiones a Brevo");
    for (const ev of enviosInterceptados) {
      assert.deepEqual(ev.to, ["prospecto.real@cliente.test"], "Todos los correos Demo deben ir ÚNICAMENTE al prospecto");
      assert.equal(ev.cc, undefined, "CC debe eliminarse en Demo");
      assert.ok(ev.subject.startsWith("[DEMO] "), `Asunto debe iniciar con [DEMO]: ${ev.subject}`);
      assert.match(ev.html, /ENTORNO DEMO — SIN VALIDEZ FISCAL/i);
    }
  } finally {
    globalThis.fetch = fetchOriginal;
  }

  // 2.8 Extender +1 hora desde Super Admin
  const extRes = await reqJson(env, jarSuper, "/api/demo/extender", "POST", { minutos: 60 });
  assert.equal(extRes.status, 200);
  assert.equal(extRes.data.demo.duracion_min, 180);

  // 2.9 Probar Demo en régimen FORMAL (IVA 0%)
  const crearFormal = await reqJson(env, jarSuper, "/api/demo/crear", "POST", {
    regimen: "FORMAL",
    duracion_min: 30,
  });
  assert.equal(crearFormal.status, 200);
  assert.equal(crearFormal.data.estado.regimen, "FORMAL");
  const sumaIvaFormal = await dbDemo.prepare(`SELECT COALESCE(SUM(iva_bs), 0) AS s FROM documentos`).first<{ s: number }>();
  assert.equal(sumaIvaFormal?.s, 0, "En Demo FORMAL el IVA total debe ser 0");

  // 2.10 Simular vencimiento exacto del tiempo -> bloqueo inmediato + limpieza automática en Cron
  const claveFormal = crearFormal.data.credenciales.clave;
  const jarFormal: Record<string, string> = {};
  assert.equal((await reqJson(env, jarFormal, "/api/login", "POST", { email: CORREOS_DEMO.ADMIN, clave: claveFormal })).status, 200);

  // Adelantar expiración al pasado
  await dbPrincipal.prepare(`UPDATE _mt_demo_estado SET expira_en = 1000 WHERE id = 1`).run();

  // Sesión activa recibe 403 con demo_expirado: true y se limpia DB_DEMO automáticamente
  const reqExp = await reqJson(env, jarFormal, "/api/documentos");
  assert.equal(reqExp.status, 403);
  assert.equal(reqExp.data.demo_expirado, true);

  // Intento de login posterior también devuelve 403 demo_expirado
  const loginExp = await reqJson(env, {}, "/api/login", "POST", { email: CORREOS_DEMO.ADMIN, clave: claveFormal });
  assert.equal(loginExp.status, 403);
  assert.equal(loginExp.data.demo_expirado, true);

  // Verificar limpieza automática (limpiarDemoExpiradaSiCorresponde) y estado limpio de DB_DEMO
  await limpiarDemoExpiradaSiCorresponde(dbPrincipal, env);
  const tablasDemo = await dbDemo
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .first<{ n: number }>();
  assert.equal(tablasDemo?.n, 0, "DB_DEMO debe quedar completamente vacía tras expirar");

  // 2.11 Verificar que DB principal y DB_1 real siguen 100% intactas
  const prinPerfil = await dbPrincipal.prepare(`SELECT nombre_razon_social FROM perfil_emisor WHERE id = 1`).first<{ nombre_razon_social: string }>();
  assert.equal(prinPerfil?.nombre_razon_social, "Empresa Principal Plataforma C.A.");
  const real1Perfil = await dbReal1.prepare(`SELECT nombre_razon_social FROM perfil_emisor WHERE id = 1`).first<{ nombre_razon_social: string }>();
  assert.equal(real1Perfil?.nombre_razon_social, "Cliente Real Pagador C.A.");

  // 2.12 Crear nueva Demo y probar cierre manual inmediato (`POST /api/demo/cerrar`)
  const crearOrd = await reqJson(env, jarSuper, "/api/demo/crear", "POST", { regimen: "ORDINARIO", duracion_min: 60 });
  assert.equal(crearOrd.status, 200);
  const cerrarRes = await reqJson(env, jarSuper, "/api/demo/cerrar", "POST", {});
  assert.equal(cerrarRes.status, 200);
  assert.equal(cerrarRes.data.demo.activo, false);
  const tablasTrasCerrar = await dbDemo
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .first<{ n: number }>();
  assert.equal(tablasTrasCerrar?.n, 0, "DB_DEMO debe quedar completamente vacía tras cierre manual");

  // 2.13 v4.9.1: Un cliente real (ADMIN en DB_1) NO puede configurar API Key propia de correo ni usar salir-en-vivo (403),
  // pero SÍ conserva sus configuraciones fiscales propias (Condición Fiscal, Modalidad/Imprenta, estado de Correo de Plataforma).
  const jarClienteReal: Record<string, string> = {};
  const loginReal = await reqJson(env, jarClienteReal, "/api/login", "POST", {
    email: "dueno@clientereal.test",
    clave: altaReal.data.clave_temporal,
  });
  assert.equal(loginReal.status, 200);
  const cambioClaveReal = await reqJson(env, jarClienteReal, "/api/cuenta/clave", "POST", {
    actual: altaReal.data.clave_temporal,
    nueva: "ClaveClienteReal2026!",
  });
  assert.equal(cambioClaveReal.status, 200);

  const bloqCorreo = await reqJson(env, jarClienteReal, "/api/sistema/correo", "POST", {
    proveedor: "BREVO",
    remitente: "cliente@clientereal.test",
    clave: "xkeysib-no-permitida",
    password: "ClaveClienteReal2026!",
    confirmo: true,
  });
  assert.equal(bloqCorreo.status, 403, "Tenant ADMIN no debe poder guardar API Key propia de correo");

  const bloqVivo = await reqJson(env, jarClienteReal, "/api/sistema/salir-en-vivo", "POST", {
    primer_factura: 1,
    primer_control: 1,
    primer_presupuesto: 1,
    confirmo: true,
  });
  assert.equal(bloqVivo.status, 403, "Tenant ADMIN no debe poder invocar salir-en-vivo");

  const bloqInq = await reqJson(env, jarClienteReal, "/api/inquilinos");
  assert.equal(bloqInq.status, 403, "Tenant ADMIN jamás puede acceder a /api/inquilinos");

  const bloqDemoPanel = await reqJson(env, jarClienteReal, "/api/demo");
  assert.equal(bloqDemoPanel.status, 403, "Tenant ADMIN jamás puede acceder a /api/demo");

  const okCorreoGet = await reqJson(env, jarClienteReal, "/api/sistema/correo");
  assert.equal(okCorreoGet.status, 200, "Tenant ADMIN sí puede ver estado de Correo de Plataforma");

  const okMedioGet = await reqJson(env, jarClienteReal, "/api/sistema/medio");
  assert.equal(okMedioGet.status, 200, "Tenant ADMIN conserva acceso a Modalidad / Imprenta Digital");

  const okRegimen = await reqJson(env, jarClienteReal, "/api/config/regimen", "PUT", {
    tipo_contribuyente: "ESPECIAL",
    clave_actual: "ClaveClienteReal2026!",
    confirmo_regimen: true,
  });
  assert.equal(okRegimen.status, 200, "Tenant ADMIN conserva control de su propia Condición Fiscal");
});

test("v4.9.1 UI: sin formularios de API Key propia de correo y vista previa DB_DEMO limpia", () => {
  const appJs = readFileSync(resolve(process.cwd(), "public/app.js"), "utf8");
  assert.equal(appJs.includes("correo-legado-wrap"), false, "No debe existir formulario legado de API Key de correo en Ajustes");
  assert.equal(appJs.includes("correo-cfg-form"), false, "No debe existir #correo-cfg-form en Ajustes");
  assert.equal(appJs.includes('campo("correo_clave"'), false, "No debe existir campo correo_clave en Alta Cliente");
  assert.ok(appJs.includes('activo === "DB_DEMO"'), "Mis Inquilinos debe resolver el nombre real de DB_DEMO");
  assert.ok(appJs.includes('if (cod === "DB_DEMO") return ""'), "barraSuper no debe duplicarse sobre barraDemo");
});

