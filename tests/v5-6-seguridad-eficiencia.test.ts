import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { migrar } from "../src/migraciones";
import {
  asegurarTablasMultiTenant,
  invalidarCacheInquilinos,
  obtenerEstadoInquilino,
  registrarCorreoDirectorio,
} from "../src/inquilinos";
import { asegurarTablaLimitesRed } from "../src/seguridad-red";
import { hashClave, necesitaRehashClave, verificarClave } from "../src/seguridad";
import { invalidarCacheMantenimiento, leerEstadoMantenimiento } from "../src/mantenimiento";
import { estaRestaurandoCacheado, invalidarCacheRestauracion } from "../src/rutas/restaurar";
import { enviarCorreo } from "../src/correo";

const MASTER_KEY = "ClaveMaestraTestSeguridadV560!!";
const SUPER_EMAIL = "super@seguridad56.test";
const PASS = "ClaveSegura2026!";

test("v5.6 CSRF: ignora X-Forwarded-Host falsificado y rechaza Sec-Fetch-Site: cross-site con cookie sid", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY, SUPER_ADMIN_EMAIL: SUPER_EMAIL };
  await migrar(db);
  await asegurarTablasMultiTenant(db);
  await asegurarTablaLimitesRed(db);

  const hash = await hashClave(PASS, env);
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv) VALUES (1, 1, 'Seg C.A.', 'J-77777777-7', 'Caracas', 50)`),
    db.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES ('Super', ?, ?, 'SUPER_ADMIN', 1, 0)`).bind(SUPER_EMAIL, hash),
  ]);
  await registrarCorreoDirectorio(db, SUPER_EMAIL, "principal", "SUPER_ADMIN", env);

  const rLogin = await app.fetch(
    new Request("https://facturayave.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://facturayave.com" },
      body: JSON.stringify({ email: SUPER_EMAIL, clave: PASS }),
    }),
    env as never
  );
  assert.equal(rLogin.status, 200);
  const cookie = (rLogin.headers.getSetCookie?.() || [rLogin.headers.get("set-cookie") || ""])
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");

  // 1) Atacante envía Origin malicioso + X-Forwarded-Host spoofed igual al Origin -> debe rechazarse 403
  const rSpoof = await app.fetch(
    new Request("https://facturayave.com/api/clientes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: "https://atacante.evil",
        "X-Forwarded-Host": "atacante.evil",
      },
      body: JSON.stringify({ rif_cedula: "V-11111111-1", nombre_apellido: "Evil" }),
    }),
    env as never
  );
  assert.equal(rSpoof.status, 403);

  // 2) Sec-Fetch-Site: cross-site con cookie sid -> 403 incluso sin Origin
  const rCross = await app.fetch(
    new Request("https://facturayave.com/api/clientes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ rif_cedula: "V-11111111-1", nombre_apellido: "Evil2" }),
    }),
    env as never
  );
  assert.equal(rCross.status, 403);

  // 3) Same-origin válido -> 200
  const rOk = await app.fetch(
    new Request("https://facturayave.com/api/clientes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: "https://facturayave.com",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ rif_cedula: "V-12345678-0", nombre_apellido: "Legitimo" }),
    }),
    env as never
  );
  assert.equal(rOk.status, 200);
});

test("v5.6 PBKDF2 Pepper: genera pbkdf2p$ con MASTER_KEY, falla cerrado sin MASTER_KEY y migra pbkdf2$ legado en login", async () => {
  const envCon = { MASTER_KEY };
  const hPepper = await hashClave(PASS, envCon);
  assert.ok(hPepper.startsWith("pbkdf2p$"));
  assert.equal(await verificarClave(PASS, hPepper, envCon), true);
  assert.equal(await verificarClave(PASS, hPepper, {}), false, "pbkdf2p$ debe fallar cerrado sin MASTER_KEY");

  const hLegado = await hashClave(PASS);
  assert.ok(hLegado.startsWith("pbkdf2$"));
  assert.equal(necesitaRehashClave(hLegado, envCon), true);
  assert.equal(necesitaRehashClave(hPepper, envCon), false);

  // Login con cuenta legada pbkdf2$ debe funcionar y rehashear transparentemente a pbkdf2p$
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY, SUPER_ADMIN_EMAIL: SUPER_EMAIL };
  await migrar(db);
  await asegurarTablasMultiTenant(db);
  await asegurarTablaLimitesRed(db);
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv) VALUES (1, 1, 'Mig C.A.', 'J-88888888-8', 'Caracas', 50)`),
    db.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES ('Legado', ?, ?, 'SUPER_ADMIN', 1, 0)`).bind(SUPER_EMAIL, hLegado),
  ]);
  await registrarCorreoDirectorio(db, SUPER_EMAIL, "principal", "SUPER_ADMIN", env);

  const rLogin = await app.fetch(
    new Request("https://facturayave.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: SUPER_EMAIL, clave: PASS }),
    }),
    env as never
  );
  assert.equal(rLogin.status, 200);

  const fila = await db.prepare(`SELECT password_hash FROM usuarios WHERE email = ?`).bind(SUPER_EMAIL).first<{ password_hash: string }>();
  assert.ok(fila?.password_hash.startsWith("pbkdf2p$"), `Debe haberse migrado a pbkdf2p$, actual: ${fila?.password_hash}`);
  assert.equal(await verificarClave(PASS, fila!.password_hash, envCon), true);
});

test("v5.6 Cachés de Isolate (15–20s): mantenimiento, inquilino y restauración cachean lecturas y respetan invalidación; sesiones NO se cachean", async () => {
  const realDb = crearBaseDatosD1(":memory:");
  await migrar(realDb);
  await asegurarTablasMultiTenant(realDb);
  await asegurarTablaLimitesRed(realDb);
  await realDb
    .prepare(
      `INSERT INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, plan_usd, activo, motivo_suspension)
       VALUES ('DB_99', 'BINDING', 'Cache Test', 'J-99999999-1', 'Caracas', '0414', 'D', 'd@c.ve', 'APP_SENIAT', 10, 1, '')`
    )
    .run();

  let consultas = 0;
  const dbContada = new Proxy(realDb, {
    get(target, prop, recv) {
      if (prop === "prepare") {
        return (...args: unknown[]) => {
          consultas++;
          return (target.prepare as (...a: unknown[]) => unknown)(...args);
        };
      }
      const val = Reflect.get(target, prop, recv);
      return typeof val === "function" ? val.bind(target) : val;
    },
  }) as unknown as D1Database;

  // 1) Mantenimiento (15s cache)
  invalidarCacheMantenimiento(dbContada);
  consultas = 0;
  await leerEstadoMantenimiento(dbContada);
  const cMant1 = consultas;
  await leerEstadoMantenimiento(dbContada);
  await leerEstadoMantenimiento(dbContada);
  assert.equal(consultas, cMant1, "leerEstadoMantenimiento debe servirse desde caché de isolate");

  // 2) Estado de inquilino (20s cache) + invalidación
  invalidarCacheInquilinos(dbContada);
  consultas = 0;
  const e1 = await obtenerEstadoInquilino(dbContada, "DB_99");
  assert.equal(e1.activo, true);
  const cInq1 = consultas;
  await obtenerEstadoInquilino(dbContada, "DB_99");
  await obtenerEstadoInquilino(dbContada, "DB_99");
  assert.equal(consultas, cInq1, "obtenerEstadoInquilino debe servirse desde caché de isolate");

  await realDb.prepare(`UPDATE _mt_inquilinos SET activo = 0, motivo_suspension = 'FALTA_PAGO' WHERE codigo = 'DB_99'`).run();
  invalidarCacheInquilinos(dbContada);
  const e2 = await obtenerEstadoInquilino(dbContada, "DB_99");
  assert.equal(e2.activo, false);
  assert.equal(e2.motivo_suspension, "FALTA_PAGO");

  // 3) Restauración (15s cache) + invalidación
  invalidarCacheRestauracion(dbContada);
  consultas = 0;
  assert.equal(await estaRestaurandoCacheado(dbContada), false);
  const cRest1 = consultas;
  assert.equal(await estaRestaurandoCacheado(dbContada), false);
  assert.equal(consultas, cRest1, "estaRestaurandoCacheado debe servirse desde caché");
  await realDb.prepare(`INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('restauracion', '1')`).run();
  invalidarCacheRestauracion(dbContada);
  assert.equal(await estaRestaurandoCacheado(dbContada), true);
  await realDb.prepare(`DELETE FROM ajustes WHERE clave = 'restauracion'`).run();
  invalidarCacheRestauracion(dbContada);

  // 4) Sesiones NUNCA cacheadas: revocar sesión debe surtir efecto inmediato
  const env: Record<string, unknown> = { DB: realDb, MASTER_KEY, SUPER_ADMIN_EMAIL: SUPER_EMAIL };
  const hash = await hashClave(PASS, env);
  await realDb.batch([
    realDb.prepare(`INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv) VALUES (1, 1, 'Ses C.A.', 'J-12312312-3', 'Caracas', 50)`),
    realDb.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES ('Super', ?, ?, 'SUPER_ADMIN', 1, 0)`).bind(SUPER_EMAIL, hash),
  ]);
  await registrarCorreoDirectorio(realDb, SUPER_EMAIL, "principal", "SUPER_ADMIN", env);
  const rLog = await app.fetch(
    new Request("https://facturayave.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: SUPER_EMAIL, clave: PASS }),
    }),
    env as never
  );
  const cookie = (rLog.headers.getSetCookie?.() || [rLog.headers.get("set-cookie") || ""])
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  assert.equal(
    (await app.fetch(new Request("https://facturayave.com/api/clientes", { headers: { Cookie: cookie } }), env as never)).status,
    200
  );
  await realDb.prepare(`DELETE FROM sesiones`).run();
  assert.equal(
    (await app.fetch(new Request("https://facturayave.com/api/clientes", { headers: { Cookie: cookie } }), env as never)).status,
    401,
    "Una sesión revocada debe rechazarse inmediatamente sin caché"
  );
});

test("v5.6 Correo Failover: envía Message-ID RFC 5322 + Idempotency-Key y registra INTENTANDO/INDETERMINADO antes de failover", async () => {
  const db = crearBaseDatosD1(":memory:");
  await migrar(db);
  await asegurarTablasMultiTenant(db);

  const env: Record<string, unknown> = {
    DB: db,
    MASTER_KEY,
    BREVO_API_KEY: "brevo-key-test",
    RESEND_API_KEY: "resend-key-test",
    EMAIL_REMITENTE: "facturas@mail.facturayave.com",
  };

  const llamadas: { url: string; headers: Record<string, string>; body: Record<string, any> }[] = [];
  const fetchOrig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers || {}).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    llamadas.push({ url, headers, body });
    if (url.includes("brevo.com")) {
      throw new Error("ETIMEDOUT simulado en Brevo");
    }
    if (url.includes("resend.com")) {
      return new Response(JSON.stringify({ id: "resend_msg_999" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const res = await enviarCorreo(db, env, {
      para: "cliente@empresa.ve",
      asunto: "Factura #0001",
      html: "<p>Adjunto factura</p>",
      tipo: "DOCUMENTO",
      idempotencyKey: "fac-0001-unico",
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.proveedor, "RESEND");
    }
    assert.equal(llamadas.length, 2);
    const msgIdBrevo = llamadas[0].body.headers?.["Message-ID"];
    const msgIdResend = llamadas[1].body.headers?.["Message-ID"];
    assert.ok(msgIdBrevo && msgIdBrevo.startsWith("<fac-0001-unico@"), `Brevo debe recibir Message-ID RFC 5322 (${msgIdBrevo})`);
    assert.equal(msgIdResend, msgIdBrevo, "Resend en failover debe reutilizar exactamente el mismo Message-ID");
    assert.equal(llamadas[1].headers["idempotency-key"], "fac-0001-unico");

    // Verificar registro pre-despacho (INTENTANDO), INDETERMINADO en Brevo y ENVIADO en Resend
    const logs = await db
      .prepare(`SELECT proveedor, estado, message_id FROM correo_envios ORDER BY id ASC`)
      .all<{ proveedor: string; estado: string; message_id: string }>();
    const estados = logs.results.map((r) => `${r.proveedor}:${r.estado}`);
    assert.deepEqual(estados, [
      "BREVO:INTENTANDO",
      "BREVO:INDETERMINADO",
      "RESEND:INTENTANDO",
      "RESEND:ENVIADO",
    ]);
  } finally {
    globalThis.fetch = fetchOrig;
  }
});
