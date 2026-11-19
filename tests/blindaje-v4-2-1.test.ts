// Pruebas v4.2.1: llave maestra obligatoria (sin llaves en memoria), recifrado de secretos heredados, firma de respaldos,
// Turnstile estricto y retenciones de IVA del Libro de Ventas que cruzan de mes.
import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import {
  asegurarLlavePlataforma,
  cifrarSecreto,
  descifrarSecreto,
  ErrorLlaveMaestra,
  firmarHmacRespaldo,
  verificarHmacRespaldo,
} from "../src/cifrado";
import { recifrarSecretosHeredados } from "../src/recifrado";
import { verificarTurnstile } from "../src/seguridad-red";
import { migrar } from "../src/migraciones";

const SEMILLA_PUBLICA = "facturaya-ve-default-envelope-key-2026";
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

async function cifrarConSemilla(semilla: string, kid: string | null, texto: string) {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(semilla));
  const key = await crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(texto));
  return kid ? `enc:v2:${kid}:${b64(iv)}:${b64(new Uint8Array(buf))}` : `enc:v1:${b64(iv)}:${b64(new Uint8Array(buf))}`;
}

function extraerCookies(res: Response, jar: Record<string, string>) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  for (const c of raw) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (m) jar[m[1].trim()] = m[2].trim();
  }
}
async function reqJson(env: Record<string, unknown>, jar: Record<string, string>, ruta: string, metodo = "GET", body?: unknown) {
  const headers: Record<string, string> = {};
  const ck = Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
  if (ck) headers["Cookie"] = ck;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.fetch(
    new Request(`http://localhost${ruta}`, { method: metodo, headers, body: body !== undefined ? JSON.stringify(body) : undefined }),
    env as any
  );
  extraerCookies(res, jar);
  const data = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, data };
}
const instalarConEmail = (env: Record<string, unknown>, jar: Record<string, string>, email: string) =>
  reqJson(env, jar, "/api/instalar", "POST", {
    nombre: "EMPRESA PRUEBA C.A.", rif: "V-12345678-1", direccion: "Caracas", telefono: "0414-0000000",
    email, medio_facturacion: "APP_SENIAT", clave: "ClavePruebaSegura2026!",
  });

test("v4.2.1-1. Sin MASTER_KEY falla cerrado: no cifra, no crea llaves en la base ni cae a una llave en memoria", async () => {
  await assert.rejects(() => cifrarSecreto("token", {}), ErrorLlaveMaestra);
  await assert.rejects(() => cifrarSecreto("token", { TURNSTILE_SECRET_KEY: "secreto-turnstile" }), ErrorLlaveMaestra);

  const db = crearBaseDatosD1(":memory:");
  assert.equal(await asegurarLlavePlataforma(db, { DB: db }), "");
  const tabla = await db.prepare(`SELECT name FROM sqlite_master WHERE name = '_mt_llave_plataforma'`).first();
  assert.equal(tabla, null, "Sin la bandera de desarrollo no debe generarse ninguna llave dentro de la base");

  // Con MASTER_KEY todo funciona y el valor guardado usa kid "mk"
  const env = { MASTER_KEY: "llave-maestra-de-prueba-2026-con-longitud" };
  const c = await cifrarSecreto("token-real", env);
  assert.ok(c.startsWith("enc:v2:mk:"));
  assert.equal(await descifrarSecreto(c, env), "token-real");

  // Un error transitorio de D1 en modo desarrollo lanza error: jamás devuelve un valor cifrado con llave efímera
  const dbCaida = { prepare: () => { throw new Error("D1 caída"); } } as unknown as D1Database;
  await assert.rejects(() => cifrarSecreto("token", { DB: dbCaida, PERMITIR_LLAVE_EN_BD: "1" }), /D1 caída/);
});

test("v4.2.1-2. Respaldos: sin MASTER_KEY salen sin firma y las firmas hechas con la semilla pública no se aceptan", async () => {
  assert.equal(await firmarHmacRespaldo("REAL", {}, {}, {}), "");

  const env = { MASTER_KEY: "llave-maestra-de-prueba-2026-con-longitud" };
  const firma = await firmarHmacRespaldo("REAL", { a: 1 }, { b: 2 }, env);
  assert.ok(firma.startsWith("hmac:v1:mk:"));
  assert.equal(await verificarHmacRespaldo(firma, "REAL", { a: 1 }, { b: 2 }, env), true);
  // Se firmó con otra llave maestra (por ejemplo, la base fue restaurada con otro secret) -> inválida
  assert.equal(await verificarHmacRespaldo(firma, "REAL", { a: 1 }, { b: 2 }, { MASTER_KEY: "otra-llave" }), false);

  // Un atacante que conoce la semilla pública del repositorio NO puede fabricar una firma válida
  const claveHmac = await crypto.subtle.importKey("raw", enc.encode(`hmac-respaldo:${SEMILLA_PUBLICA}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = JSON.stringify({ modo_origen: "REAL", conteos: {}, sumas: {} });
  const hex = Buffer.from(await crypto.subtle.sign("HMAC", claveHmac, enc.encode(msg))).toString("hex");
  assert.equal(await verificarHmacRespaldo(`hmac:v1:def:${hex}`, "REAL", {}, {}, env), false);
  assert.equal(await verificarHmacRespaldo(`hmac:v1:mk:${hex}`, "REAL", {}, {}, env), false);
});

test("v4.2.1-3. Recifrado: v1, kid def (v4.1) y llave de la base (v4.2) pasan a MASTER_KEY; idempotente; no toca lo ilegible", async () => {
  const env = { MASTER_KEY: "llave-maestra-de-prueba-2026-con-longitud" };
  const db = crearBaseDatosD1(":memory:");
  await migrar(db);
  const pkBd = "a".repeat(64);
  await db.prepare(`CREATE TABLE IF NOT EXISTS _mt_llave_plataforma (id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL, creado_en TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  await db.prepare(`INSERT INTO _mt_llave_plataforma (id, secret) VALUES (1, ?)`).bind(pkBd).run();

  const filas: [string, string][] = [
    ["correo_clave", await cifrarConSemilla(SEMILLA_PUBLICA, "def", "xkeysib-correo-v41")],
    ["imprenta_clave", await cifrarConSemilla(SEMILLA_PUBLICA, null, "token-imprenta-v1")],
    ["cf_api_token", await cifrarConSemilla(`facturaya-platform:${pkBd}`, "pk", "cf-token-v42")],
  ];
  for (const [k, v] of filas) {
    await db.prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?)`).bind(k, v, "2026-01-01").run();
  }

  // Antes del recifrado (sin MASTER_KEY disponible para cifrar) la migración no hace nada
  const sinLlave = await recifrarSecretosHeredados(db, {}, db);
  assert.equal(sinLlave.omitido, "SIN_MASTER_KEY");

  const r1 = await recifrarSecretosHeredados(db, env, db);
  assert.equal(r1.recifrados, 3);
  assert.deepEqual(r1.ilegibles, []);
  const esperado: Record<string, string> = { correo_clave: "xkeysib-correo-v41", imprenta_clave: "token-imprenta-v1", cf_api_token: "cf-token-v42" };
  for (const k of Object.keys(esperado)) {
    const fila = await db.prepare(`SELECT valor FROM integraciones WHERE clave = ?`).bind(k).first<{ valor: string }>();
    assert.ok(fila!.valor.startsWith("enc:v2:mk:"), `${k} debe quedar con kid mk`);
    assert.equal(await descifrarSecreto(fila!.valor, env), esperado[k]);
  }
  const r2 = await recifrarSecretosHeredados(db, env, db);
  assert.equal(r2.recifrados, 0, "Segunda pasada: idempotente");

  // Secreto guardado en claro -> se cifra; valor ilegible -> se informa el nombre y no se modifica
  const db2 = crearBaseDatosD1(":memory:");
  await migrar(db2);
  await db2.prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('cf_api_token', 'token-en-claro', '2026-01-01')`).run();
  await db2.prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('correo_clave', 'enc:v2:pk:AAAA:BBBB', '2026-01-01')`).run();
  const r3 = await recifrarSecretosHeredados(db2, env, db2);
  assert.equal(r3.cifrados_en_claro, 1);
  assert.deepEqual(r3.ilegibles, ["correo_clave"]);
  const intacto = await db2.prepare(`SELECT valor FROM integraciones WHERE clave = 'correo_clave'`).first<{ valor: string }>();
  assert.equal(intacto!.valor, "enc:v2:pk:AAAA:BBBB");
});

test("v4.2.1-4. API: guardar claves sin MASTER_KEY responde 503 claro; /api/estado avisa solo al Súper Admin", async () => {
  const db = crearBaseDatosD1(":memory:");
  const sinMk: Record<string, unknown> = { DB: db, SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test" };
  const jar: Record<string, string> = {};
  assert.equal((await instalarConEmail(sinMk, jar, "superadmin@ejemplo.test")).status, 200);

  const est = await reqJson(sinMk, jar, "/api/estado");
  assert.equal(est.data.seguridad.master_key, false);

  const cfg = await reqJson(sinMk, jar, "/api/sistema/correo", "POST", {
    proveedor: "BREVO", remitente: "facturacion@ejemplo.test", nombre_remitente: "EMPRESA DEMO", clave: "xkeysib-prueba",
    password: "ClavePruebaSegura2026!", confirmo: true,
  });
  assert.equal(cfg.status, 503);
  assert.equal(cfg.data.codigo, "SIN_MASTER_KEY");

  const conMk: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-maestra-de-prueba-2026-con-longitud" };
  assert.equal((await reqJson(conMk, jar, "/api/estado")).data.seguridad.master_key, true);
  const cfg2 = await reqJson(conMk, jar, "/api/sistema/correo", "POST", {
    proveedor: "BREVO", remitente: "facturacion@ejemplo.test", nombre_remitente: "EMPRESA DEMO", clave: "xkeysib-prueba",
    password: "ClavePruebaSegura2026!", confirmo: true,
  });
  assert.equal(cfg2.status, 200);
});

test("v4.2.1-5. Restaurar: borrar `firma_hmac` ya no evita la verificación; sin firma solo el Súper Admin", async () => {
  const env: Record<string, unknown> = { DB: crearBaseDatosD1(":memory:"), MASTER_KEY: "llave-maestra-de-prueba-2026-con-longitud", SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test" };
  const jarSuperInit: Record<string, string> = {};
  assert.equal((await instalarConEmail(env, jarSuperInit, "superadmin@ejemplo.test")).status, 200);
  // Crear un usuario ADMIN normal (que NO es Súper Admin) e iniciar sesión como ese ADMIN
  const creadoAdmin = await reqJson(env, jarSuperInit, "/api/usuarios", "POST", {
    nombre: "Dueño Empresa", email: "dueno@empresa-prueba.com", rol: "ADMIN",
  });
  assert.equal(creadoAdmin.status, 200);
  const claveTemp = String(creadoAdmin.data.clave_temporal);
  const jar: Record<string, string> = {};
  const loginAdmin = await reqJson(env, jar, "/api/login", "POST", {
    email: "dueno@empresa-prueba.com", clave: claveTemp,
  });
  assert.equal(loginAdmin.status, 200);
  const cambio = await reqJson(env, jar, "/api/cuenta/clave", "POST", {
    actual: claveTemp, nueva: "ClaveAdminNormal2026!",
  });
  assert.equal(cambio.status, 200);

  const manifiesto = { version: 2, modo_origen: "REAL", conteos: {}, sumas: {} };
  const sinCampo = await reqJson(env, jar, "/api/sistema/restaurar/iniciar", "POST", { clave: "ClaveAdminNormal2026!", manifiesto });
  assert.equal(sinCampo.status, 403);
  assert.match(String(sinCampo.data.error), /no está firmado/);
  const vacia = await reqJson(env, jar, "/api/sistema/restaurar/iniciar", "POST", { clave: "ClaveAdminNormal2026!", manifiesto: { ...manifiesto, firma_hmac: "" } });
  assert.equal(vacia.status, 403);
  const legada = await reqJson(env, jar, "/api/sistema/restaurar/iniciar", "POST", { clave: "ClaveAdminNormal2026!", manifiesto: { ...manifiesto, firma_hmac: `hmac:v1:def:${"0".repeat(64)}` } });
  assert.equal(legada.status, 403, "Una firma v4.1 (semilla pública) cuenta como respaldo sin firma");
  const falsa = await reqJson(env, jar, "/api/sistema/restaurar/iniciar", "POST", { clave: "ClaveAdminNormal2026!", manifiesto: { ...manifiesto, firma_hmac: `hmac:v1:mk:${"0".repeat(64)}` } });
  assert.equal(falsa.status, 400);

  // El Súper Admin sí puede restaurar un respaldo sin firma (descargado sin MASTER_KEY)
  const envSuper: Record<string, unknown> = { DB: crearBaseDatosD1(":memory:"), SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test" };
  const jarSuper: Record<string, string> = {};
  assert.equal((await instalarConEmail(envSuper, jarSuper, "superadmin@ejemplo.test")).status, 200);
  const ok = await reqJson(envSuper, jarSuper, "/api/sistema/restaurar/iniciar", "POST", { clave: "ClavePruebaSegura2026!", manifiesto });
  assert.equal(ok.status, 200);
  await reqJson(envSuper, jarSuper, "/api/sistema/restaurar/cancelar", "POST", {});
  const okLegada = await reqJson(envSuper, jarSuper, "/api/sistema/restaurar/iniciar", "POST", { clave: "ClavePruebaSegura2026!", manifiesto: { ...manifiesto, firma_hmac: `hmac:v1:def:${"0".repeat(64)}` } });
  assert.equal(okLegada.status, 200, "El Súper Admin puede restaurar un respaldo de la v4.1 de forma deliberada");
  await reqJson(envSuper, jarSuper, "/api/sistema/restaurar/cancelar", "POST", {});
});

test("v4.2.1-6. Turnstile estricto: con clave pública y sin secreto se rechaza (instalar); sin ninguna de las dos sigue siendo opcional", async () => {
  assert.equal((await verificarTurnstile(undefined, "", "1.1.1.1", fetch, { produccionEstricto: true })).ok, false);
  assert.equal((await verificarTurnstile(undefined, "", "1.1.1.1", fetch, {})).ok, true);

  const db = crearBaseDatosD1(":memory:");
  const prod: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-maestra-de-prueba-2026-con-longitud", SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test", TURNSTILE_SITE_KEY: "0x4AAAAAAA-prueba" };
  const rechazo = await instalarConEmail(prod, {}, "superadmin@ejemplo.test");
  assert.ok(rechazo.status >= 400, `Debe rechazar la instalación sin TURNSTILE_SECRET_KEY, recibido ${rechazo.status}`);
  const hay = await db.prepare(`SELECT 1 AS x FROM usuarios LIMIT 1`).first();
  assert.equal(hay, null, "No debe haberse creado ningún usuario");
});

test("v4.2.1-7. Libro de Ventas: las retenciones de IVA recibidas este mes por facturas de otro mes se listan aparte y cuadran con el total", async () => {
  const env: Record<string, unknown> = { DB: crearBaseDatosD1(":memory:"), MASTER_KEY: "llave-maestra-de-prueba-2026-con-longitud", SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test" };
  const db = env.DB as D1Database;
  const jar: Record<string, string> = {};
  assert.equal((await instalarConEmail(env, jar, "superadmin@ejemplo.test")).status, 200);
  await reqJson(env, jar, "/api/config", "PUT", { tasa_bcv_modo: "MANUAL", tasa_bcv: "100,00" });
  const cli = await reqJson(env, jar, "/api/clientes", "POST", { rif_cedula: "J-40123987-0", nombre_apellido: "Cliente Retenedor C.A." });
  const fac = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA", cliente_id: cli.data.id,
    lineas: [{ tipo: "SERVICIO", descripcion: "Soporte", cantidad: "1", precio_usd: "100,00", alicuota_iva: 16 }],
  });
  assert.equal((await reqJson(env, jar, `/api/documentos/${fac.data.id}/emitir`, "POST", {})).status, 200);
  const ret = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: fac.data.id, metodo: "RETENCION_IVA", moneda: "BS", monto: "1200,00", tasa: "100,00", comprobante_retencion: "20261100000001",
  });
  assert.equal(ret.status, 200, JSON.stringify(ret.data));

  // Modo práctica (sin triggers): la factura es de octubre y la retención se recibió en noviembre
  await db.prepare(`UPDATE documentos SET fecha_emision = '2026-10-10' WHERE id = ?`).bind(fac.data.id).run();
  await db.prepare(`UPDATE pagos SET fecha_pago = '2026-11-05' WHERE documento_id = ? AND es_retencion_iva = 1`).bind(fac.data.id).run();

  const nov = await reqJson(env, jar, "/api/informes/ventas?desde=2026-11-01&hasta=2026-11-30");
  assert.equal(nov.status, 200);
  assert.equal(nov.data.filas.length, 0, "La factura es de octubre: no hay fila en noviembre");
  assert.equal(nov.data.retenciones_periodo.length, 1, "La retención recibida en noviembre debe aparecer en su sección");
  assert.equal(nov.data.retenciones_periodo[0].factura_en_periodo, false);
  assert.equal(nov.data.retenciones_periodo[0].comprobante_retencion, "20261100000001");
  assert.equal(nov.data.iva_retenido_bs, 120000);
  assert.equal(nov.data.iva_retenido_otros_periodos_bs, 120000);

  const oct = await reqJson(env, jar, "/api/informes/ventas?desde=2026-10-01&hasta=2026-10-31");
  assert.equal(oct.data.filas.length, 1);
  assert.equal(oct.data.filas[0].iva_retenido_bs, 0, "En octubre todavía no se había recibido la retención");
  assert.equal(oct.data.retenciones_periodo.length, 0);
  assert.equal(oct.data.iva_retenido_bs, 0);
});
