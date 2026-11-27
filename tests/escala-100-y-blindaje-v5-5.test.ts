import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import app from "../src/index";
import { crearBaseDatosD1 } from "../src/d1";
import { migrar } from "../src/migraciones";
import { asegurarTablasMultiTenant } from "../src/inquilinos";
import { asegurarTablaLimitesRed, limitePayloadPorRuta } from "../src/seguridad-red";
import { enviarCorreo } from "../src/correo";
import { consultarEstadoCloudflare } from "../src/cloudflare-api";
import { ejecutarRespaldoR2, type AlmacenR2 } from "../src/respaldos-r2";
import {
  CRON_MANTENIMIENTO_NOCTURNO,
  CRON_MANTENIMIENTO_NOCTURNO_LOTES,
  ejecutarMantenimientoNocturno,
  esCronMantenimientoNocturno,
} from "../src/mantenimiento";
import { hashClave } from "../src/seguridad";

const MASTER_KEY_TEST = "ClaveMaestraTestEscala100v550Seguro!!";
const SUPER_EMAIL = "super@facturayave.com";
const SUPER_PASS = "SuperClave2026!";

function crearBucketR2Memoria(): AlmacenR2 & { objetos: Map<string, string> } {
  const objetos = new Map<string, string>();
  return {
    objetos,
    async put(key, value) {
      const texto = typeof value === "string" ? value : "";
      objetos.set(key, texto);
      return { key, size: Buffer.byteLength(texto, "utf8"), uploaded: new Date() };
    },
    async get(key) {
      const texto = objetos.get(key);
      if (texto === undefined) return null;
      return {
        key,
        size: Buffer.byteLength(texto, "utf8"),
        uploaded: new Date(),
        async text() { return texto; },
        async arrayBuffer() { return new TextEncoder().encode(texto).buffer; },
      };
    },
    async list(opts) {
      const pref = opts?.prefix || "";
      const list = [...objetos.entries()]
        .filter(([k]) => k.startsWith(pref))
        .map(([key, v]) => ({ key, size: Buffer.byteLength(v, "utf8"), uploaded: new Date() }));
      return { objects: list, truncated: false };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objetos.delete(k);
    },
  };
}

async function reqApi(
  env: Record<string, unknown>,
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  let bodyStr: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(opts.body);
  }
  const res = await app.fetch(
    new Request(`https://facturayave.com${path}`, {
      method: opts.method || "GET",
      headers,
      body: bodyStr,
    }),
    env as never
  );
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

function extraerCookies(headers: Headers): string {
  const setCookie = headers.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  return setCookie.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

async function instalarPrincipal(env: Record<string, unknown>) {
  const r = await reqApi(env, "/api/instalar", {
    method: "POST",
    body: {
      nombre: "EXENET Principal C.A.",
      rif: "J-12345678-9",
      direccion: "Av. Principal Caracas",
      telefono: "04141234567",
      email: SUPER_EMAIL,
      clave: SUPER_PASS,
    },
  });
  assert.equal(r.status, 200, `Instalación falló: ${JSON.stringify(r.json)}`);
  return extraerCookies(r.headers);
}

test("v5.5.0 #1: enviar-correo permite PDFs Base64 con logo >300 KB hasta 1.5 MB y rechaza >1.5 MB con 413", async () => {
  assert.equal(limitePayloadPorRuta("/api/documentos/42/enviar-correo"), 1_500_000);
  assert.equal(limitePayloadPorRuta("/api/pagos/7/enviar-correo"), 1_500_000);
  assert.equal(limitePayloadPorRuta("/api/clientes"), 262_144);

  const db = crearBaseDatosD1(":memory:");
  const env = { DB: db, SUPER_ADMIN_EMAIL: SUPER_EMAIL, MASTER_KEY: MASTER_KEY_TEST };
  const cookie = await instalarPrincipal(env);

  // Enviar un payload de ~420 KB a /api/documentos/999/enviar-correo: NO debe dar 413 (debe pasar el límite de payload y llegar a validar la existencia del documento -> 404)
  const pdfGrande = "A".repeat(420_000);
  const rOkLimite = await reqApi(env, "/api/documentos/999/enviar-correo", {
    method: "POST",
    cookie,
    body: { pdf_base64: pdfGrande, email: "cliente@ejemplo.com" },
  });
  assert.notEqual(rOkLimite.status, 413, "No debe rechazar PDF Base64 de 420 KB con 413");
  assert.equal(rOkLimite.status, 404);

  // Payload de >1.5 MB SÍ debe rechazarse con 413
  const pdfExcesivo = "A".repeat(1_600_000);
  const r413 = await reqApi(env, "/api/documentos/999/enviar-correo", {
    method: "POST",
    cookie,
    body: { pdf_base64: pdfExcesivo, email: "cliente@ejemplo.com" },
  });
  assert.equal(r413.status, 413);
});

test("v5.5.0 #2: SUPER_ADMIN cambiando /sistema/medio e /sistema/imprenta en BD inquilino valida su clave principal aunque la copia local difiera", async () => {
  const rawDb = crearBaseDatosD1(":memory:");
  const dbInq = crearBaseDatosD1(":memory:");
  await migrar(dbInq);
  const env: Record<string, unknown> = {
    DB: rawDb,
    DB_1: dbInq,
    SUPER_ADMIN_EMAIL: SUPER_EMAIL,
    MASTER_KEY: MASTER_KEY_TEST,
  };
  const cookieSuper = await instalarPrincipal(env);

  // Registrar inquilino DB_1 y un hash viejo/distinto para el super admin dentro de DB_1 (simulando rotación de clave en principal)
  await rawDb
    .prepare(
      `INSERT INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, tipo_contribuyente, plan_usd, activo)
       VALUES ('DB_1', 'DEDICADA', 'Cliente Uno C.A.', 'J-22222222-1', 'Valencia', '04120000001', 'Dueño Uno', 'dueno1@cliente.com', 'APP_SENIAT', 'ORDINARIO', 1000, 1)`
    )
    .run();
  await dbInq
    .prepare(
      `INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv, medio_facturacion)
       VALUES (1, 1, 'Cliente Uno C.A.', 'J-22222222-1', 'Valencia', 5000, 'APP_SENIAT')`
    )
    .run();
  const hashViejo = await hashClave("ClaveViejaDesincronizada99!");
  await dbInq
    .prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo) VALUES ('Super', ?, ?, 'SUPER_ADMIN', 1)`)
    .bind(SUPER_EMAIL, hashViejo)
    .run();

  // Cambiar vista del Súper Admin a DB_1
  const rSw = await reqApi(env, "/api/inquilinos/cambiar", {
    method: "POST",
    cookie: cookieSuper,
    body: { codigo: "DB_1" },
  });
  assert.equal(rSw.status, 200);
  const cookieInq = `${cookieSuper.split("; ").filter((p) => !p.startsWith("inq=")).join("; ")}; inq=DB_1`;

  // Debe aceptar la contraseña ACTUAL de rawDb en POST /api/sistema/medio
  const rMedio = await reqApi(env, "/api/sistema/medio", {
    method: "POST",
    cookie: cookieInq,
    body: { medio: "IMPRENTA_DIGITAL", clave: SUPER_PASS, motivo: "Activación de imprenta autorizada", confirmo: true },
  });
  assert.equal(rMedio.status, 200, `Debe aceptar clave principal del SUPER_ADMIN: ${JSON.stringify(rMedio.json)}`);

  // Debe RECHAZAR la clave vieja que quedó rezagada en DB_1
  const rVieja = await reqApi(env, "/api/sistema/imprenta", {
    method: "POST",
    cookie: cookieInq,
    body: {
      confirmo: true,
      password: "ClaveViejaDesincronizada99!",
      proveedor_tipo: "CG_IMPRENTA",
      url: "https://calidad.cgimprenta.digital",
      ambiente: "PRUEBAS",
      usuario: "demo_cg",
      clave: "secret_cg_123",
    },
  });
  assert.equal(rVieja.status, 400, "No debe aceptar la clave vieja desincronizada del tenant");

  // Debe ACEPTAR la contraseña vigente de rawDb en POST /api/sistema/imprenta y /imprenta/recarga
  const rImp = await reqApi(env, "/api/sistema/imprenta", {
    method: "POST",
    cookie: cookieInq,
    body: {
      confirmo: true,
      password: SUPER_PASS,
      proveedor_tipo: "CG_IMPRENTA",
      url: "https://calidad.cgimprenta.digital",
      ambiente: "PRUEBAS",
      usuario: "demo_cg",
      clave: "secret_cg_123",
    },
  });
  assert.equal(rImp.status, 200, `POST /sistema/imprenta falló: ${JSON.stringify(rImp.json)}`);

  const rRec = await reqApi(env, "/api/sistema/imprenta/recarga", {
    method: "POST",
    cookie: cookieInq,
    body: { confirmo: true, password: SUPER_PASS, cantidad_numeros: 500, plan_nombre: "Lote 500" },
  });
  assert.equal(rRec.status, 200, `POST /sistema/imprenta/recarga falló: ${JSON.stringify(rRec.json)}`);
});

test("v5.5.0 #3: Failover de correo con AbortSignal.timeout cambia al proveedor secundario si el primero aborta/falla", async () => {
  const db = crearBaseDatosD1(":memory:");
  await migrar(db);
  await asegurarTablasMultiTenant(db);

  const envObj: Record<string, unknown> = {
    MASTER_KEY: MASTER_KEY_TEST,
    BREVO_API_KEY: "xkeysib-test-brevo",
    RESEND_API_KEY: "re_test_resend",
    EMAIL_REMITENTE: "facturas@mail.facturayave.com",
    EMAIL_NOMBRE_PLATAFORMA: "FacturaYa Venezuela",
    __rawDb: db,
    __inquilinoCodigo: "principal",
  };

  let llamadas = 0;
  let tuvoSignal = false;
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas++;
    if (init?.signal) tuvoSignal = true;
    const u = String(url);
    if (u.includes("brevo.com")) {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    if (u.includes("resend.com")) {
      return new Response(JSON.stringify({ id: "resend-msg-ok-1" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  let r: Awaited<ReturnType<typeof enviarCorreo>>;
  try {
    r = await enviarCorreo(db, envObj, {
      para: "cliente@correo.com",
      asunto: "Factura de prueba",
      html: "<p>Hola</p>",
      alcance: "PLATAFORMA",
      tipo: "DOCUMENTO",
    });
  } finally {
    globalThis.fetch = fetchOriginal;
  }

  assert.equal(r.ok, true, `Debe completar por failover: ${JSON.stringify(r)}`);
  assert.equal(tuvoSignal, true, "Debe adjuntar AbortSignal.timeout a las llamadas de proveedores de correo");
  assert.equal(llamadas, 2, "Debe intentar Brevo y hacer failover inmediato a Resend");
  if (r.ok) assert.equal(r.proveedor, "RESEND");
});

test("v5.5.0 #4 y #5: Mantenimiento nocturno purga _mt_rate_limit y procesa múltiples empresas por lotes con cursor persistente", async () => {
  const rawDb = crearBaseDatosD1(":memory:");
  await migrar(rawDb);
  await asegurarTablasMultiTenant(rawDb);
  await asegurarTablaLimitesRed(rawDb);

  // Verificar reconocimiento de ambos crons nocturnos y compatibilidad con wrangler.toml
  assert.equal(esCronMantenimientoNocturno(CRON_MANTENIMIENTO_NOCTURNO), true);
  assert.equal(esCronMantenimientoNocturno(CRON_MANTENIMIENTO_NOCTURNO_LOTES), true);
  assert.equal(esCronMantenimientoNocturno("0 12,17,22 * * *"), false);
  const wranglerTxt = fs.readFileSync("wrangler.toml", "utf8");
  assert.ok(wranglerTxt.includes(CRON_MANTENIMIENTO_NOCTURNO_LOTES), "wrangler.toml debe incluir el cron de lotes nocturnos");

  // Insertar registro vencido y vigente en _mt_rate_limit
  const ahoraSeg = Math.floor(Date.now() / 1000);
  await rawDb
    .prepare(`INSERT INTO _mt_rate_limit (clave, intentos, ventana_inicio, bloqueado_hasta) VALUES (?, ?, ?, ?)`)
    .bind("login_ip|1.1.1.1", 5, ahoraSeg - 7200, ahoraSeg - 3600)
    .run();
  await rawDb
    .prepare(`INSERT INTO _mt_rate_limit (clave, intentos, ventana_inicio, bloqueado_hasta) VALUES (?, ?, ?, ?)`)
    .bind("login_ip|2.2.2.2", 2, ahoraSeg - 60, 0)
    .run();

  // Sembrar empresa principal + 4 empresas dedicadas (5 en total) para probar lotes de 2 en 2
  const bucket = crearBucketR2Memoria();
  const env: Record<string, unknown> = {
    DB: rawDb,
    RESPALDOS_R2: bucket,
    MASTER_KEY: MASTER_KEY_TEST,
    SUPER_ADMIN_EMAIL: SUPER_EMAIL,
  };
  await instalarPrincipal(env);

  for (let i = 1; i <= 4; i++) {
    const dbN = crearBaseDatosD1(":memory:");
    await migrar(dbN);
    await dbN
      .prepare(
        `INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv)
         VALUES (1, 1, ?, ?, 'Caracas', 5000)`
      )
      .bind(`Empresa Lote ${i} C.A.`, `J-3000000${i}-0`)
      .run();
    env[`DB_${i}`] = dbN;
    await rawDb
      .prepare(
        `INSERT INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, activo)
         VALUES (?, 'DEDICADA', ?, ?, 'Caracas', '04140000000', 'Dueño', ?, 1)`
      )
      .bind(`DB_${i}`, `Empresa Lote ${i} C.A.`, `J-3000000${i}-0`, `emp${i}@ejemplo.com`)
      .run();
  }

  // Lote 1 (2 empresas de 5)
  const r1 = await ejecutarMantenimientoNocturno(rawDb, env, {
    tipo: "NOCTURNO_AUTO",
    hoyIso: "2026-11-27",
    maxEmpresasLote: 2,
  });
  assert.equal(r1.lote_parcial, true);
  assert.equal(r1.empresas_revisadas, 2);
  assert.equal(r1.pendientes_lote, 3);
  assert.equal(r1.respaldos_diarios_ok, 2);

  // Lote 2 (4 empresas acumuladas de 5)
  const r2 = await ejecutarMantenimientoNocturno(rawDb, env, {
    tipo: "NOCTURNO_AUTO",
    hoyIso: "2026-11-27",
    maxEmpresasLote: 2,
  });
  assert.equal(r2.lote_parcial, true);
  assert.equal(r2.empresas_revisadas, 4);
  assert.equal(r2.pendientes_lote, 1);
  assert.equal(r2.respaldos_diarios_ok, 4);

  // Lote 3 (final: 5/5 empresas completadas, limpia _mt_rate_limit)
  const r3 = await ejecutarMantenimientoNocturno(rawDb, env, {
    tipo: "NOCTURNO_AUTO",
    hoyIso: "2026-11-27",
    maxEmpresasLote: 2,
  });
  assert.equal(r3.lote_parcial, undefined);
  assert.equal(r3.empresas_revisadas, 5);
  assert.equal(r3.respaldos_diarios_ok, 5);

  // Verificar purga correcta de _mt_rate_limit (1.1.1.1 borrado, 2.2.2.2 conservado)
  const { results: lims } = await rawDb.prepare(`SELECT clave FROM _mt_rate_limit`).all<{ clave: string }>();
  assert.deepEqual(lims.map((l) => l.clave), ["login_ip|2.2.2.2"]);

  // Tick 4 el mismo día: ya completado -> debe omitir inmediatamente sin trabajo
  const r4 = await ejecutarMantenimientoNocturno(rawDb, env, {
    tipo: "NOCTURNO_AUTO",
    hoyIso: "2026-11-27",
    maxEmpresasLote: 2,
  });
  assert.equal(r4.omitido_ya_completado, true);
  assert.equal(r4.empresas_revisadas, 0);
});

test("v5.5.0 #6: ejecutarRespaldoR2 aísla fallos por empresa y completa los respaldos de las demás", async () => {
  const rawDb = crearBaseDatosD1(":memory:");
  const dbBuena = crearBaseDatosD1(":memory:");
  await migrar(dbBuena);
  await dbBuena
    .prepare(`INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv) VALUES (1, 1, 'Sana C.A.', 'J-44444444-1', 'Caracas', 5000)`)
    .run();

  // BD corrupta que lanza error en cualquier consulta
  const dbRota = {
    prepare() {
      throw new Error("D1_TRANSIENT_FAILURE");
    },
  } as unknown as D1Database;

  const bucket = crearBucketR2Memoria();
  const env: Record<string, unknown> = {
    DB: rawDb,
    DB_1: dbRota,
    DB_2: dbBuena,
    RESPALDOS_R2: bucket,
    MASTER_KEY: MASTER_KEY_TEST,
    SUPER_ADMIN_EMAIL: SUPER_EMAIL,
  };
  await instalarPrincipal(env);
  await rawDb
    .prepare(`INSERT INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, activo) VALUES ('DB_1', 'DEDICADA', 'Rota C.A.', 'J-11111111-1', 'X', '0', 'X', 'r@x.com', 1)`)
    .run();
  await rawDb
    .prepare(`INSERT INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, activo) VALUES ('DB_2', 'DEDICADA', 'Sana C.A.', 'J-44444444-1', 'X', '0', 'X', 's@x.com', 1)`)
    .run();

  const res = await ejecutarRespaldoR2(rawDb, env, { tipo: "diario", hoyIso: "2026-11-27" });
  assert.equal(res.ok, true);
  assert.equal(res.claves.length, 2, "Debe respaldar principal y DB_2 aunque DB_1 falle");
  assert.ok(res.claves.some((k) => k.includes("principal.json")));
  assert.ok(res.claves.some((k) => k.includes("db_2.json")));
  assert.equal(res.errores_empresas?.length, 1);
  assert.ok(res.errores_empresas![0].startsWith("DB_1:"));
});

test("v5.5.0 #7: Escaneo dinámico D1 soporta DB_25/DB_100, historial SaaS no trunca a 400 filas y CSRF bloquea cross-origin", async () => {
  const rawDb = crearBaseDatosD1(":memory:");
  const dbDummy = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = {
    DB: rawDb,
    DB_25: dbDummy,
    DB_100: dbDummy,
    SUPER_ADMIN_EMAIL: SUPER_EMAIL,
    MASTER_KEY: MASTER_KEY_TEST,
  };
  const cookie = await instalarPrincipal(env);

  // 1) Escaneo dinámico más allá de DB_20
  const estadoCf = await consultarEstadoCloudflare(rawDb, env);
  assert.ok(estadoCf.bindings_locales.includes("DB_25"), "Debe detectar DB_25 dinámicamente");
  assert.ok(estadoCf.bindings_locales.includes("DB_100"), "Debe detectar DB_100 dinámicamente");
  assert.equal(
    estadoCf.bindings_locales.indexOf("DB_25") < estadoCf.bindings_locales.indexOf("DB_100"),
    true,
    "Debe ordenar ranuras numéricamente (DB_25 antes de DB_100)"
  );

  // 2) Historial SaaS sin truncamiento global de 400 filas (crear 70 empresas con 7 cobros c/u = 490 filas)
  const stmtsInq: D1PreparedStatement[] = [];
  const stmtsCob: D1PreparedStatement[] = [];
  for (let i = 1; i <= 70; i++) {
    const cod = `DB_${i}`;
    stmtsInq.push(
      rawDb
        .prepare(
          `INSERT INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, activo)
           VALUES (?, 'DEDICADA', ?, ?, 'Caracas', '0414', 'Owner', ?, 1)`
        )
        .bind(cod, `Empresa ${i}`, `J-${String(10000000 + i)}-0`, `e${i}@mail.com`)
    );
    for (let m = 1; m <= 7; m++) {
      stmtsCob.push(
        rawDb
          .prepare(
            `INSERT INTO _mt_cobros_saas (inquilino_codigo, periodo_ym, monto_usd_cent, total_usd_cent, total_bs_cent, tasa_e8, estado, concepto)
             VALUES (?, ?, 1000, 1000, 50000, 5000000000, 'EMITIDO', 'Mensualidad')`
          )
          .bind(cod, `2026-0${m}`)
      );
    }
  }
  await rawDb.batch(stmtsInq);
  await rawDb.batch(stmtsCob);

  const rInq = await reqApi(env, "/api/inquilinos", { cookie });
  assert.equal(rInq.status, 200);
  const lista = ((rInq.json as { inquilinos?: Array<{ codigo: string; cobros_recientes?: unknown[] }> }).inquilinos || []).filter(
    (x) => x.codigo.startsWith("DB_")
  );
  assert.equal(lista.length, 70, "Deben aparecer las 70 empresas registradas");
  const con6Cobros = lista.filter((x) => (x.cobros_recientes?.length ?? 0) === 6);
  assert.equal(con6Cobros.length, 70, "Todas las 70 empresas deben recibir sus 6 periodos más recientes sin truncamiento global");

  // 3) Protección Same-Origin CSRF
  const rCross = await reqApi(env, "/api/clientes", {
    method: "POST",
    cookie,
    headers: { Origin: "https://sitio-malicioso.example" },
    body: { nombre: "Atacante", rif_cedula: "V-12345678" },
  });
  assert.equal(rCross.status, 403, "Debe bloquear mutación cross-origin con HTTP 403");

  const rSame = await reqApi(env, "/api/clientes", {
    method: "POST",
    cookie,
    headers: { Origin: "https://facturayave.com" },
    body: { nombre_apellido: "Cliente Legitimo", rif_cedula: "V-12345678" },
  });
  assert.notEqual(rSame.status, 403, "No debe rechazar mutación same-origin con 403");
  assert.equal(rSame.status, 200, `Debe permitir mutación same-origin: ${JSON.stringify(rSame.json)}`);
});
