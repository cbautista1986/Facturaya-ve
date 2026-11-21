// Suite de pruebas v4.3–v4.5 (Lanzamiento Comercial + Endurecimiento Seguridad y Privacidad):
// 1. Compras de gastos y servicios sin afectar inventario + Libro de Compras + Resumen IVA.
// 2. 2FA TOTP (RFC 6238) para Súper Admin Y Administradores (Dueños) + QR local SVG + anti-replay + rate limiting (429) + respaldos + recuperación.
// 3. Respaldo automático en Cloudflare R2: 1 archivo por empresa, diario (30 días), archivo mensual fiscal (10 años), descarga en streaming y alerta de error Cron.
// 4. Privacidad y cabeceras: Strict-Transport-Security (HSTS), WHATSAPP_CONTACTO por entorno y /api/estado sin fugas sin sesión.
import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import {
  codificarBase32,
  decodificarBase32,
  generarCodigoTotp,
  generarHotp,
  generarCodigosRespaldo2fa,
  hashCodigoRespaldo2fa,
  verificarCodigoTotp,
  verificarYConsumirCodigoRespaldo2fa,
} from "../src/totp";
import {
  claveR2Valida,
  intentarArchivoMensualR2,
  intentarRespaldoDiarioR2,
  podarRespaldosDiariosAntiguos,
  registrarErrorR2,
  type AlmacenR2,
} from "../src/respaldos-r2";
import { esSuperAdmin, tiene, veCostos } from "../src/permisos";
import { generarMatrizQr, generarQrSvg } from "../public/qr.js";
import { construirModelo } from "../public/informe-tabla.js";

const MASTER_KEY_TEST = "mk-test-facturaya-v4-5-super-secreta-32bytes-min";
const EMAIL_SUPER_TEST = "superadmin@ejemplo.test";
const CLAVE_SUPER = "ClaveSuperSeguro2026!";

function crearBucketR2Memoria(): AlmacenR2 & {
  mapa: Map<string, { texto: string; size: number; uploaded: Date; customMetadata?: Record<string, string> }>;
  streamsConsumidos: number;
} {
  const mapa = new Map<string, { texto: string; size: number; uploaded: Date; customMetadata?: Record<string, string> }>();
  const bucket = {
    mapa,
    streamsConsumidos: 0,
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | Blob | null, options?: { customMetadata?: Record<string, string> }) {
      const texto = typeof value === "string" ? value : "";
      const size = Buffer.byteLength(texto, "utf8");
      const uploaded = new Date();
      mapa.set(key, { texto, size, uploaded, customMetadata: options?.customMetadata });
      return { key, size, uploaded, customMetadata: options?.customMetadata };
    },
    async get(key: string) {
      const it = mapa.get(key);
      if (!it) return null;
      const bytes = new TextEncoder().encode(it.texto);
      return {
        key,
        size: it.size,
        uploaded: it.uploaded,
        customMetadata: it.customMetadata,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            bucket.streamsConsumidos++;
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        async text() { return it.texto; },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      };
    },
    async list(options?: { prefix?: string; limit?: number }) {
      const pref = options?.prefix || "";
      const lim = options?.limit ?? 100;
      const objects = [...mapa.entries()]
        .filter(([k]) => k.startsWith(pref))
        .slice(0, lim)
        .map(([key, v]) => ({ key, size: v.size, uploaded: v.uploaded, customMetadata: v.customMetadata }));
      return { objects, truncated: false };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) mapa.delete(k);
    },
  };
  return bucket;
}

function cookieDe(res: Response): string {
  const setCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") || ""].filter(Boolean);
  return setCookies.map((s) => s.split(";")[0]).filter(Boolean).join("; ");
}

async function req(
  env: Record<string, unknown>,
  metodo: string,
  ruta: string,
  body?: unknown,
  cookie?: string
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers["cookie"] = cookie;
  return app.fetch(
    new Request(`http://localhost${ruta}`, {
      method: metodo,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env as any
  );
}

async function instalarSuper(env: Record<string, unknown>) {
  if (!env.SUPER_ADMIN_EMAIL) env.SUPER_ADMIN_EMAIL = EMAIL_SUPER_TEST;
  const r = await req(env, "POST", "/api/instalar", {
    nombre: "EMPRESA DEMO C.A.",
    rif: "V-12345678-1",
    direccion: "Av. Principal Caracas",
    telefono: "0414-0000000",
    email: EMAIL_SUPER_TEST,
    clave: CLAVE_SUPER,
  });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { ok: boolean; codigo_recuperacion: string };
  assert.equal(j.ok, true);
  return { cookie: cookieDe(r), codigoRecuperacion: j.codigo_recuperacion };
}

// =====================================================================
// 1. PRUEBAS PURAS DE TOTP (RFC 6238) Y QR LOCAL SVG
// =====================================================================
test("TOTP RFC 6238: Base32, vectores oficiales SHA-1, ventana +-1, anti-replay y respaldos", async () => {
  const ascii = new TextEncoder().encode("12345678901234567890");
  const b32 = codificarBase32(ascii);
  assert.equal(b32, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(decodificarBase32(b32), ascii);

  // Vectores oficiales RFC 6238 Appendix B (SHA-1, 6 dígitos finales)
  assert.equal(await generarHotp(ascii, Math.floor(59 / 30), 6), "287082");
  assert.equal(await generarHotp(ascii, Math.floor(1111111109 / 30), 6), "081804");
  assert.equal(await generarHotp(ascii, Math.floor(1234567890 / 30), 6), "005924");

  // Ventana de tolerancia +-1 paso (30s) y rechazo en +-2
  const tBase = 1_750_000_000_000;
  const { codigo: cPrev, paso: pPrev } = await generarCodigoTotp(b32, tBase - 30_000);
  const { codigo: cMuyViejo } = await generarCodigoTotp(b32, tBase - 60_000);
  const vOk = await verificarCodigoTotp(b32, cPrev, { tiempoMs: tBase, ventana: 1 });
  assert.equal(vOk.ok, true);
  assert.equal(vOk.paso, pPrev);

  const vViejo = await verificarCodigoTotp(b32, cMuyViejo, { tiempoMs: tBase, ventana: 1 });
  assert.equal(vViejo.ok, false);

  // Anti-replay: el mismo paso no puede volver a usarse
  const vReplay = await verificarCodigoTotp(b32, cPrev, { tiempoMs: tBase, ventana: 1, ultimoPaso: pPrev });
  assert.equal(vReplay.ok, false);
  assert.equal(vReplay.repetido, true);

  // Códigos de respaldo de un solo uso
  const cods = generarCodigosRespaldo2fa(8);
  assert.equal(cods.length, 8);
  assert.equal(new Set(cods).size, 8);
  const hashes = await Promise.all(cods.map((c) => hashCodigoRespaldo2fa(c, EMAIL_SUPER_TEST)));
  const json0 = JSON.stringify(hashes);
  const u1 = await verificarYConsumirCodigoRespaldo2fa(cods[3], EMAIL_SUPER_TEST, json0);
  assert.equal(u1.ok, true);
  assert.equal(u1.restantes, 7);
  // Reusar el mismo código consumido falla
  const u2 = await verificarYConsumirCodigoRespaldo2fa(cods[3], EMAIL_SUPER_TEST, u1.restantesJson);
  assert.equal(u2.ok, false);
});

test("QR local SVG: genera matriz y SVG válido para URI otpauth://totp sin dependencias", () => {
  const uri = `otpauth://totp/FacturaYa%20Venezuela:${encodeURIComponent(EMAIL_SUPER_TEST)}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=FacturaYa+Venezuela&algorithm=SHA1&digits=6&period=30`;
  const { version, size, matriz } = generarMatrizQr(uri);
  assert.ok(version >= 5 && version <= 10);
  assert.equal(size, version * 4 + 17);
  // Verificar esquina superior izquierda del patrón buscador 7x7
  assert.equal(matriz[0][0], 1);
  assert.equal(matriz[1][1], 0);
  assert.equal(matriz[3][3], 1);
  const svg = generarQrSvg(uri, { tamPx: 200 });
  assert.ok(svg.startsWith("<svg "));
  assert.ok(svg.includes(`viewBox="0 0 ${size + 8} ${size + 8}"`));
  assert.ok(svg.includes("<path d=\"M"));
});

// =====================================================================
// 2. COMPRAS DE GASTOS Y SERVICIOS + LIBRO DE COMPRAS + IVA CRÉDITO FISCAL
// =====================================================================
test("Compras de gastos/servicios y mixtas: centavos exactos, cero movimientos de stock, Libro de Compras y anulación", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env = { DB: db, MASTER_KEY: MASTER_KEY_TEST };
  const { cookie } = await instalarSuper(env);

  // Configurar tasa BCV
  const rCfg = await req(env, "PUT", "/api/config", { tasa_bcv_modo: "MANUAL", tasa_bcv: "50,00" }, cookie);
  assert.equal(rCfg.status, 200);

  // Crear proveedor y un producto de inventario
  const rProv = await req(env, "POST", "/api/proveedores", { rif: "J-30112233-4", nombre: "Inmobiliaria y Fibra C.A." }, cookie);
  assert.equal(rProv.status, 200);
  const provId = ((await rProv.json()) as { id: number }).id;

  const rProd = await req(env, "POST", "/api/catalogo", { tipo: "PRODUCTO", nombre: "Router WiFi 6", precio_usd: "40,00", alicuota_iva: 16 }, cookie);
  assert.equal(rProd.status, 200);
  const prodId = ((await rProd.json()) as { id: number }).id;

  // 2A) Compra 100% GASTO (Alquiler $100 + Internet $50 al 16% IVA, tasa 50 Bs/USD)
  const rGasto = await req(env, "POST", "/api/compras", {
    proveedor_id: provId,
    factura_numero: "F-GASTO-001",
    control_numero: "00-000123",
    tasa_bcv: "50,00",
    lineas: [
      { tipo: "GASTO", categoria: "ALQUILER", descripcion: "Alquiler mensual oficina", cantidad: "1", costo_usd: "100,00", alicuota_iva: 16 },
      { tipo: "GASTO", categoria: "SERVICIOS", descripcion: "Internet fibra óptica", cantidad: "1", costo_usd: "50,00", alicuota_iva: 16 },
    ],
  }, cookie);
  assert.equal(rGasto.status, 200);
  const jGasto = (await rGasto.json()) as { ok: boolean; id: number; tipo_compra: string; activados: string[] };
  assert.equal(jGasto.tipo_compra, "GASTO");
  assert.deepEqual(jGasto.activados, []);

  // Verificar cero movimientos en inventario
  const movs0 = await db.prepare(`SELECT COUNT(*) AS n FROM movimientos_stock`).first<{ n: number }>();
  assert.equal(movs0?.n, 0);

  // Verificar detalle en centavos enteros exactos: base $150 (15000), IVA $24 (2400), total $174 (17400); en Bs * 50 -> 750000, 120000, 870000
  const rDet = await req(env, "GET", `/api/compras/${jGasto.id}`, undefined, cookie);
  assert.equal(rDet.status, 200);
  const jDet = (await rDet.json()) as any;
  assert.equal(jDet.compra.tipo_compra, "GASTO");
  assert.equal(jDet.compra.subtotal_usd, 15000);
  assert.equal(jDet.compra.iva_usd, 2400);
  assert.equal(jDet.compra.total_usd, 17400);
  assert.equal(jDet.compra.subtotal_bs, 750000);
  assert.equal(jDet.compra.iva_bs, 120000);
  assert.equal(jDet.compra.total_bs, 870000);

  // 2B) Compra MIXTA (2 Routers a $25 + Flete $10 exento)
  const rMixta = await req(env, "POST", "/api/compras", {
    proveedor_id: provId,
    factura_numero: "F-MIXTA-002",
    tasa_bcv: "50,00",
    lineas: [
      { tipo: "PRODUCTO", producto_id: prodId, cantidad: "2", costo_usd: "25,00", alicuota_iva: 16 },
      { tipo: "GASTO", categoria: "FLETE", descripcion: "Envío encomienda MRW", cantidad: "1", costo_usd: "10,00", alicuota_iva: 0 },
    ],
  }, cookie);
  assert.equal(rMixta.status, 200);
  const jMixta = (await rMixta.json()) as { id: number; tipo_compra: string };
  assert.equal(jMixta.tipo_compra, "MIXTA");

  // Solo 1 movimiento de stock (2 unidades del Router) — el flete NO toca inventario
  const movs1 = await db.prepare(`SELECT producto_id, cantidad_milli, valor_usd FROM movimientos_stock`).all<any>();
  assert.equal(movs1.results.length, 1);
  assert.equal(movs1.results[0].producto_id, prodId);
  assert.equal(movs1.results[0].cantidad_milli, 2000);
  assert.equal(movs1.results[0].valor_usd, 5000);

  // 2C) Libro de Compras y Resumen IVA incluyen ambas compras con su clasificación
  const rLibro = await req(env, "GET", "/api/informes/compras", undefined, cookie);
  assert.equal(rLibro.status, 200);
  const jLibro = (await rLibro.json()) as any;
  assert.equal(jLibro.n_vigentes, 2);
  assert.equal(jLibro.filas[0].tipo_compra, "GASTO");
  assert.equal(jLibro.filas[1].tipo_compra, "MIXTA");
  // Crédito fiscal IVA Bs = 120000 (gasto) + 40000 (routers: $8 * 50) = 160000 centavos (Bs. 1.600,00)
  assert.equal(jLibro.iva_bs, 160000);
  const modelo = construirModelo("compras", jLibro);
  assert.equal(modelo.secciones[0].columnas.length, modelo.secciones[0].totales[0].length);
  assert.equal(modelo.secciones[0].filas[0][5], "Gasto / Servicio");
  assert.equal(modelo.secciones[0].filas[1][5], "Mixta");

  const rIva = await req(env, "GET", "/api/informes/resumen-iva", undefined, cookie);
  const jIva = (await rIva.json()) as any;
  assert.equal(jIva.total.credito_bs, 160000);

  // 2D) Validación de gastos inválidos
  const rBad = await req(env, "POST", "/api/compras", {
    proveedor_id: provId,
    factura_numero: "F-BAD-003",
    tasa_bcv: "50,00",
    lineas: [{ tipo: "GASTO", categoria: "INVALIDA", descripcion: "Algo", cantidad: "1", costo_usd: "10,00", alicuota_iva: 16 }],
  }, cookie);
  assert.equal(rBad.status, 400);

  // 2E) Anular compra de gasto pura funciona limpiamente y descuenta crédito fiscal
  const rAnul = await req(env, "POST", `/api/compras/${jGasto.id}/anular`, { motivo: "Factura emitida con RIF errado" }, cookie);
  assert.equal(rAnul.status, 200);
  const rIva2 = await req(env, "GET", "/api/informes/resumen-iva", undefined, cookie);
  const jIva2 = (await rIva2.json()) as any;
  assert.equal(jIva2.total.credito_bs, 40000);
});

// =====================================================================
// 3. 2FA TOTP PARA SÚPER ADMIN Y ADMINISTRADORES + RATE LIMITING (429)
// =====================================================================
test("2FA TOTP (v4.5): Súper Admin y Admin empresa con 2FA, 403 a Cajero, rate limit 429 en activar/desactivar, anti-replay y recuperación", async () => {
  const db = crearBaseDatosD1(":memory:");
  const envSinMk = { DB: db };
  const env = { DB: db, MASTER_KEY: MASTER_KEY_TEST };
  const { cookie, codigoRecuperacion } = await instalarSuper(env);

  // 3A) Crear un CAJERO (debe recibir 403 en /api/cuenta/2fa/*)
  const rCrearCaj = await req(env, "POST", "/api/usuarios", { nombre: "Cajero Uno", email: "cajero@ejemplo.test", rol: "CAJERO" }, cookie);
  assert.equal(rCrearCaj.status, 200);
  const { clave_temporal: claveCaj } = (await rCrearCaj.json()) as { clave_temporal: string };
  const rLogCaj = await req(env, "POST", "/api/login", { email: "cajero@ejemplo.test", clave: claveCaj });
  const cookieCaj = cookieDe(rLogCaj);
  await req(env, "POST", "/api/cuenta/clave", { actual: claveCaj, nueva: "ClaveCajeroSegura2026!" }, cookieCaj);
  const r2faCaj = await req(env, "GET", "/api/cuenta/2fa/estado", undefined, cookieCaj);
  assert.equal(r2faCaj.status, 403);

  // 3B) Crear un ADMIN de empresa -> en v4.5 SÍ puede configurar y usar 2FA
  const rCrearAdmin = await req(env, "POST", "/api/usuarios", { nombre: "Socio Admin", email: "socio@ejemplo.test", rol: "ADMIN" }, cookie);
  assert.equal(rCrearAdmin.status, 200);
  const { clave_temporal: claveSocio } = (await rCrearAdmin.json()) as { clave_temporal: string };
  const rLogSocio = await req(env, "POST", "/api/login", { email: "socio@ejemplo.test", clave: claveSocio });
  const cookieSocio = cookieDe(rLogSocio);
  await req(env, "POST", "/api/cuenta/clave", { actual: claveSocio, nueva: "ClaveSocioSegura2026!" }, cookieSocio);
  const r2faSocioEst = await req(env, "GET", "/api/cuenta/2fa/estado", undefined, cookieSocio);
  assert.equal(r2faSocioEst.status, 200);

  const rSocioIni = await req(env, "POST", "/api/cuenta/2fa/iniciar", { clave: "ClaveSocioSegura2026!" }, cookieSocio);
  assert.equal(rSocioIni.status, 200);
  const jSocioIni = (await rSocioIni.json()) as { secreto: string };

  // Rate limiting en /api/cuenta/2fa/activar: 5 intentos fallidos -> 6to bloqueado con 429
  for (let i = 0; i < 5; i++) {
    const rBad = await req(env, "POST", "/api/cuenta/2fa/activar", { codigo: "000000" }, cookieSocio);
    assert.equal(rBad.status, 400);
  }
  const rBloqAct = await req(env, "POST", "/api/cuenta/2fa/activar", { codigo: "000000" }, cookieSocio);
  assert.equal(rBloqAct.status, 429);

  // Limpiar intentos de socio para completar activación, login 2FA y rate limit de desactivación
  await db.prepare(`DELETE FROM intentos_login WHERE clave LIKE '2fa%'`).run();
  const { codigo: codActSocio } = await generarCodigoTotp(jSocioIni.secreto, Date.now() - 30_000);
  const rSocioAct = await req(env, "POST", "/api/cuenta/2fa/activar", { codigo: codActSocio }, cookieSocio);
  assert.equal(rSocioAct.status, 200);
  const jSocioAct = (await rSocioAct.json()) as { codigos_respaldo: string[] };

  // Login de ADMIN ahora exige 2FA
  const rLogSocioP1 = await req(env, "POST", "/api/login", { email: "socio@ejemplo.test", clave: "ClaveSocioSegura2026!" });
  assert.equal(rLogSocioP1.status, 200);
  assert.equal(((await rLogSocioP1.json()) as any).requiere_2fa, true);

  // Rate limit en /api/cuenta/2fa/desactivar: 5 intentos fallidos -> 6to 429
  for (let i = 0; i < 5; i++) {
    const rOffBad = await req(env, "POST", "/api/cuenta/2fa/desactivar", { clave: "ClaveSocioSegura2026!", codigo: "999999" }, cookieSocio);
    assert.equal(rOffBad.status, 401);
  }
  const rBloqOff = await req(env, "POST", "/api/cuenta/2fa/desactivar", { clave: "ClaveSocioSegura2026!", codigo: "999999" }, cookieSocio);
  assert.equal(rBloqOff.status, 429);

  await db.prepare(`DELETE FROM intentos_login WHERE clave LIKE '2fa%'`).run();
  const rOffSocioOk = await req(env, "POST", "/api/cuenta/2fa/desactivar", { clave: "ClaveSocioSegura2026!", codigo: jSocioAct.codigos_respaldo[0] }, cookieSocio);
  assert.equal(rOffSocioOk.status, 200);

  // 3C) Flujo completo Súper Admin: sin MASTER_KEY falla cerrado (503)
  const rSinMk = await req(envSinMk, "POST", "/api/cuenta/2fa/iniciar", { clave: CLAVE_SUPER }, cookie);
  assert.equal(rSinMk.status, 503);

  // Iniciar 2FA con MASTER_KEY -> cifra en BD
  const rIni = await req(env, "POST", "/api/cuenta/2fa/iniciar", { clave: CLAVE_SUPER }, cookie);
  assert.equal(rIni.status, 200);
  const jIni = (await rIni.json()) as { secreto: string; otpauth_uri: string };
  assert.ok(jIni.secreto.length >= 32);
  assert.ok(jIni.otpauth_uri.startsWith("otpauth://totp/"));

  const filaPend = await db.prepare(`SELECT totp_pendiente, totp_activo FROM usuarios WHERE lower(email) = ?`).bind(EMAIL_SUPER_TEST).first<any>();
  assert.equal(filaPend.totp_activo, 0);
  assert.ok(String(filaPend.totp_pendiente).startsWith("enc:v2:mk:"));

  // Activar con código de 6 dígitos
  const ahoraMs = Date.now();
  const { codigo: codAct, paso: pasoAct } = await generarCodigoTotp(jIni.secreto, ahoraMs - 30_000);
  const rAct = await req(env, "POST", "/api/cuenta/2fa/activar", { codigo: codAct }, cookie);
  assert.equal(rAct.status, 200);
  const jAct = (await rAct.json()) as { ok: boolean; codigos_respaldo: string[] };
  assert.equal(jAct.codigos_respaldo.length, 8);

  // Login sin codigo_2fa -> requiere_2fa: true y SIN cookie
  const rLogPaso1 = await req(env, "POST", "/api/login", { email: EMAIL_SUPER_TEST, clave: CLAVE_SUPER });
  assert.equal(rLogPaso1.status, 200);
  const jPaso1 = (await rLogPaso1.json()) as any;
  assert.equal(jPaso1.requiere_2fa, true);
  assert.equal(cookieDe(rLogPaso1), "");

  // Login con código inválido -> 401
  const rLogBad = await req(env, "POST", "/api/login", { email: EMAIL_SUPER_TEST, clave: CLAVE_SUPER, codigo_2fa: "000000" });
  assert.equal(rLogBad.status, 401);

  // Login con código TOTP válido (paso actual > pasoAct) -> 200 + cookie
  const { codigo: codLogin, paso: pasoLogin } = await generarCodigoTotp(jIni.secreto, ahoraMs);
  assert.ok(pasoLogin > pasoAct);
  const rLogOk = await req(env, "POST", "/api/login", { email: EMAIL_SUPER_TEST, clave: CLAVE_SUPER, codigo_2fa: codLogin });
  assert.equal(rLogOk.status, 200);
  assert.ok(cookieDe(rLogOk).includes("sid="));

  // Anti-replay: reusar el mismo código TOTP -> 401
  const rLogReplay = await req(env, "POST", "/api/login", { email: EMAIL_SUPER_TEST, clave: CLAVE_SUPER, codigo_2fa: codLogin });
  assert.equal(rLogReplay.status, 401);

  // Login con código de respaldo (1 solo uso) -> 200 y baja de 8 a 7
  const rLogBk = await req(env, "POST", "/api/login", { email: EMAIL_SUPER_TEST, clave: CLAVE_SUPER, codigo_2fa: jAct.codigos_respaldo[0] });
  assert.equal(rLogBk.status, 200);
  const cookieNueva = cookieDe(rLogBk);
  const rEst2 = await req(env, "GET", "/api/cuenta/2fa/estado", undefined, cookieNueva);
  const jEst2 = (await rEst2.json()) as any;
  assert.equal(jEst2.activo, true);
  assert.equal(jEst2.codigos_respaldo_restantes, 7);

  // Reusar ese mismo código de respaldo -> 401
  const rLogBkReplay = await req(env, "POST", "/api/login", { email: EMAIL_SUPER_TEST, clave: CLAVE_SUPER, codigo_2fa: jAct.codigos_respaldo[0] });
  assert.equal(rLogBkReplay.status, 401);

  // Desactivar 2FA con contraseña + otro código de respaldo
  const rOff = await req(env, "POST", "/api/cuenta/2fa/desactivar", { clave: CLAVE_SUPER, codigo: jAct.codigos_respaldo[1] }, cookieNueva);
  assert.equal(rOff.status, 200);

  // Reactivar 2FA y probar válvula anti-bloqueo con /api/recuperar (Código Maestro offline)
  const rLogSin2fa = await req(env, "POST", "/api/login", { email: EMAIL_SUPER_TEST, clave: CLAVE_SUPER });
  assert.equal(rLogSin2fa.status, 200);
  const rIni2 = await req(env, "POST", "/api/cuenta/2fa/iniciar", { clave: CLAVE_SUPER }, cookieDe(rLogSin2fa));
  const jIni2 = (await rIni2.json()) as { secreto: string };
  const { codigo: codAct2 } = await generarCodigoTotp(jIni2.secreto);
  assert.equal((await req(env, "POST", "/api/cuenta/2fa/activar", { codigo: codAct2 }, cookieDe(rLogSin2fa))).status, 200);

  const rRec = await req(env, "POST", "/api/recuperar", {
    email: EMAIL_SUPER_TEST,
    codigo: codigoRecuperacion,
    clave_nueva: "NuevaClaveSuper2026!",
  });
  assert.equal(rRec.status, 200);
  const filaPostRec = await db.prepare(`SELECT totp_activo, totp_secreto FROM usuarios WHERE lower(email) = ?`).bind(EMAIL_SUPER_TEST).first<any>();
  assert.equal(filaPostRec.totp_activo, 0);
  assert.equal(filaPostRec.totp_secreto, null);
});

// =====================================================================
// 4. RESPALDO R2 (v4.5): 1 ARCHIVO/EMPRESA, MENSUAL 10 AÑOS, STREAMING Y ALERTA CRON
// =====================================================================
test("Respaldo R2 (v4.5): 1 archivo/empresa, archivo mensual 10 años inmutable, descarga en streaming y alerta de error Cron", async () => {
  const db = crearBaseDatosD1(":memory:");
  const bucket = crearBucketR2Memoria();
  const envSinR2 = { DB: db, MASTER_KEY: MASTER_KEY_TEST };
  const env = { DB: db, MASTER_KEY: MASTER_KEY_TEST, RESPALDOS_R2: bucket };
  const { cookie } = await instalarSuper(env);

  // Sin bucket R2 devuelve configurado: false y 400 en ejecutar
  const rSin = await req(envSinR2, "GET", "/api/inquilinos/respaldos-r2", undefined, cookie);
  assert.equal(rSin.status, 200);
  assert.equal(((await rSin.json()) as any).configurado, false);
  const rSinEj = await req(envSinR2, "POST", "/api/inquilinos/respaldos-r2/ejecutar", {}, cookie);
  assert.equal(rSinEj.status, 400);

  // Respaldo manual con R2 vinculado -> 1 archivo por empresa
  const rMan = await req(env, "POST", "/api/inquilinos/respaldos-r2/ejecutar", {}, cookie);
  assert.equal(rMan.status, 200);
  const jMan = (await rMan.json()) as any;
  assert.equal(jMan.resultado.firmado, true);
  assert.equal(jMan.resultado.claves.length, 1);
  const keyMan = jMan.resultado.claves[0];
  assert.ok(claveR2Valida(keyMan));
  assert.ok(keyMan.endsWith("-principal.json"));

  // Descargar respaldo desde R2 en streaming (obj.body ReadableStream) y verificar firma HMAC
  const streamsAntes = bucket.streamsConsumidos;
  const rDl = await req(env, "GET", `/api/inquilinos/respaldos-r2/descargar?key=${encodeURIComponent(keyMan)}`, undefined, cookie);
  assert.equal(rDl.status, 200);
  const respaldoDescargado = (await rDl.json()) as any;
  assert.equal(respaldoDescargado.formato, "respaldo-maestro-facturaya");
  assert.equal(respaldoDescargado.empresas_en_archivo, 1);
  assert.ok(respaldoDescargado.negocios?.principal);
  assert.ok(String(respaldoDescargado.firma_hmac || "").startsWith("hmac:"));
  assert.ok(bucket.streamsConsumidos > streamsAntes, "La descarga debe transmitir obj.body en streaming");

  // Rechazo de path traversal
  assert.equal(claveR2Valida("respaldos/diarios/../../secreto.json"), false);
  const rTrav = await req(env, "GET", `/api/inquilinos/respaldos-r2/descargar?key=${encodeURIComponent("respaldos/diarios/../../secreto.json")}`, undefined, cookie);
  assert.equal(rTrav.status, 400);

  // Idempotencia diaria del Cron Trigger (3 turnos en el mismo día -> solo 1 respaldo)
  const c1 = await intentarRespaldoDiarioR2(db, env, "2026-11-18");
  assert.equal(c1.ejecutado, true);
  const c2 = await intentarRespaldoDiarioR2(db, env, "2026-11-18");
  assert.equal(c2.ejecutado, false);
  assert.equal(c2.motivo, "YA_RESPALDADO_HOY");
  const c3 = await intentarRespaldoDiarioR2(db, env, "2026-11-19");
  assert.equal(c3.ejecutado, true);

  // Archivo Mensual Fiscal (10 años) — archiva el mes cerrado anterior (2026-10), idempotente por mes y nunca podado
  const m1 = await intentarArchivoMensualR2(db, env, "2026-11-01");
  assert.equal(m1.ejecutado, true);
  assert.equal(m1.mes, "2026-10");
  assert.ok(m1.resultado?.claves[0].startsWith("respaldos/mensuales/2026-10/"));
  const m2 = await intentarArchivoMensualR2(db, env, "2026-11-15");
  assert.equal(m2.ejecutado, false);
  assert.equal(m2.motivo, "YA_ARCHIVADO_MES");

  // Retención de 30 días: poda solo diarios viejos, preserva mensuales (10 años) y manuales
  await bucket.put("respaldos/diarios/2026-10-01/respaldo-2026-10-01-principal.json", "{}");
  await bucket.put("respaldos/manuales/2026-10-01/respaldo-manual-principal.json", "{}");
  await bucket.put("respaldos/mensuales/2025-01/archivo-fiscal-2025-01-principal.json", "{}");
  const podados = await podarRespaldosDiariosAntiguos(bucket, "2026-11-19", 30);
  assert.equal(podados, 1);
  assert.equal(bucket.mapa.has("respaldos/diarios/2026-10-01/respaldo-2026-10-01-principal.json"), false);
  assert.equal(bucket.mapa.has("respaldos/manuales/2026-10-01/respaldo-manual-principal.json"), true);
  assert.equal(bucket.mapa.has("respaldos/mensuales/2025-01/archivo-fiscal-2025-01-principal.json"), true);

  // Alerta persistente cuando falla un respaldo Cron -> visible SOLO para Súper Admin en /api/estado
  await registrarErrorR2(db, "mensual", "2026-11", new Error("Fallo simulado de cuota R2"));
  const rEstSinSesion = await req(env, "GET", "/api/estado");
  const jSinSesion = (await rEstSinSesion.json()) as any;
  assert.equal(jSinSesion.seguridad, undefined);
  assert.equal(jSinSesion.inquilinos, undefined);

  const rEstSuper = await req(env, "GET", "/api/estado", undefined, cookie);
  const jSuper = (await rEstSuper.json()) as any;
  assert.equal(jSuper.seguridad.ultimo_error_r2.tipo, "mensual");
  assert.match(jSuper.seguridad.ultimo_error_r2.mensaje, /cuota R2/);
});

// =====================================================================
// 5. CABECERA HSTS Y WHATSAPP CONFIGURABLE POR ENTORNO (ZERO-PII)
// =====================================================================
test("Seguridad v4.5: HSTS en API, /api/estado limpio sin sesión y WHATSAPP_CONTACTO opcional por entorno", async () => {
  const db = crearBaseDatosD1(":memory:");
  const envSinWa = { DB: db, MASTER_KEY: MASTER_KEY_TEST };
  await instalarSuper(envSinWa);

  const r1 = await req(envSinWa, "GET", "/api/estado");
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  const j1 = (await r1.json()) as any;
  assert.equal(j1.whatsapp_contacto ?? null, null);
  assert.equal(j1.seguridad, undefined);

  const rWaSin = await req(envSinWa, "GET", "/api/contacto/whatsapp");
  assert.equal(rWaSin.status, 404);

  const envConWa = { DB: db, MASTER_KEY: MASTER_KEY_TEST, WHATSAPP_CONTACTO: "+58 414-000-0000" };
  const r2 = await req(envConWa, "GET", "/api/estado");
  const textoEstado = await r2.text();
  assert.equal(textoEstado.includes("584140000000"), false, "El número de WhatsApp jamás debe filtrarse en /api/estado");
  assert.equal(textoEstado.includes("0414-000-0000"), false, "El número formateado jamás debe filtrarse en /api/estado");
  const j2 = JSON.parse(textoEstado) as any;
  assert.deepEqual(j2.whatsapp_contacto, { activo: true });

  const rWa = await req(envConWa, "GET", "/api/contacto/whatsapp");
  assert.equal(rWa.status, 302);
  assert.equal(rWa.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(rWa.headers.get("cache-control"), "no-store");
  assert.match(rWa.headers.get("location") || "", /^https:\/\/wa\.me\/584140000000\?text=/);
});

// =====================================================================
// 6. BLINDAJE v4.5.1: SÚPER ADMIN SOLO POR VARIABLE + INSTALACIÓN SEGURA
// =====================================================================
test("Seguridad v4.5.1: Súper Admin solo por SUPER_ADMIN_EMAIL (con rol ADMIN/CAJERO en BD) funciona en restaurar sin firma, /api/config y veCostos en borradores", async () => {
  const db = crearBaseDatosD1(":memory:");
  const envInit: Record<string, unknown> = { DB: db, MASTER_KEY: MASTER_KEY_TEST, SUPER_ADMIN_EMAIL: EMAIL_SUPER_TEST };
  const { cookie: cookieInit } = await instalarSuper(envInit);

  // Crear un usuario con rol CAJERO en BD cuyo correo será promovido a Súper Admin ÚNICAMENTE por env.SUPER_ADMIN_EMAIL
  const emailPorEnv = "super-solo-env@ejemplo.test";
  const clavePorEnv = "ClaveSuperEnv2026!";
  const rUsr = await req(envInit, "POST", "/api/usuarios", {
    nombre: "Super Por Variable",
    email: emailPorEnv,
    rol: "CAJERO",
  }, cookieInit);
  assert.equal(rUsr.status, 200);
  const claveTemp = String(((await rUsr.json()) as any).clave_temporal);

  // Verificar helpers puros con env obligatorio
  const envPromovido: Record<string, unknown> = { DB: db, MASTER_KEY: MASTER_KEY_TEST, SUPER_ADMIN_EMAIL: emailPorEnv };
  assert.equal(esSuperAdmin("CAJERO", emailPorEnv, envPromovido), true);
  assert.equal(esSuperAdmin("CAJERO", emailPorEnv, {}), false);
  assert.equal(tiene("CAJERO", "admin", emailPorEnv, envPromovido), true);
  assert.equal(veCostos("CAJERO", emailPorEnv, envPromovido), true);

  // Iniciar sesión con ese usuario usando el entorno donde él es SUPER_ADMIN_EMAIL y fijar su clave permanente
  const rLogin = await req(envPromovido, "POST", "/api/login", { email: emailPorEnv, clave: claveTemp });
  assert.equal(rLogin.status, 200);
  const cookiePorEnv = cookieDe(rLogin);
  const rCambio = await req(envPromovido, "POST", "/api/cuenta/clave", { actual: claveTemp, nueva: clavePorEnv }, cookiePorEnv);
  assert.equal(rCambio.status, 200);

  // 1) restaurar.ts:120 -> Súper Admin solo por variable puede iniciar restauración de un respaldo SIN firma
  const manifiestoSinFirma = { version: 2, modo_origen: "REAL", conteos: {}, sumas: {} };
  const rRest = await req(envPromovido, "POST", "/api/sistema/restaurar/iniciar", {
    clave: clavePorEnv,
    manifiesto: manifiestoSinFirma,
  }, cookiePorEnv);
  assert.equal(rRest.status, 200, "Súper Admin por SUPER_ADMIN_EMAIL debe poder restaurar respaldo sin firma");
  await req(envPromovido, "POST", "/api/sistema/restaurar/cancelar", {}, cookiePorEnv);

  // 2) index.ts:751 -> PUT /api/config con campos fiscales (bloqueado para CAJERO normal, permitido por SUPER_ADMIN_EMAIL)
  const rCfg = await req(envPromovido, "PUT", "/api/config", {
    nombre_razon_social: "EMPRESA ACTUALIZADA POR SUPER ENV C.A.",
    confirmo_fiscal: true,
    tasa_bcv_modo: "MANUAL",
    tasa_bcv: "100,00",
  }, cookiePorEnv);
  assert.equal(rCfg.status, 200, "Súper Admin por SUPER_ADMIN_EMAIL debe poder editar configuración fiscal");

  // 3) documentos.ts:295 -> PUT /api/documentos/:id debe respetar veCostos() con env (no reinyectar costo anterior cuando el Súper Admin lo deja vacío)
  const rCli = await req(envPromovido, "POST", "/api/clientes", {
    rif_cedula: "J-40998877-1",
    nombre_apellido: "Cliente Prueba Env C.A.",
  }, cookiePorEnv);
  assert.equal(rCli.status, 200);
  const cliId = ((await rCli.json()) as any).id;

  const rDoc = await req(envPromovido, "POST", "/api/documentos", {
    tipo: "FACTURA",
    cliente_id: cliId,
    lineas: [{ tipo: "PRODUCTO", descripcion: "Equipo Especial", cantidad: "1", precio_usd: "100,00", costo_usd: "45,00", alicuota_iva: 16 }],
  }, cookiePorEnv);
  assert.equal(rDoc.status, 200);
  const docId = ((await rDoc.json()) as any).id;

  // Al editar el borrador dejando costo_usd vacío: un usuario que NO ve costos preserva 4500; un usuario con veCostos=true lo limpia a null
  const rEdit = await req(envPromovido, "PUT", `/api/documentos/${docId}`, {
    cliente_id: cliId,
    lineas: [{ tipo: "PRODUCTO", descripcion: "Equipo Especial", cantidad: "1", precio_usd: "100,00", costo_usd: "", alicuota_iva: 16 }],
  }, cookiePorEnv);
  assert.equal(rEdit.status, 200);
  const renglon = await db.prepare(`SELECT costo_usd FROM documento_renglones WHERE documento_id = ?`).bind(docId).first<{ costo_usd: number | null }>();
  assert.equal(renglon?.costo_usd ?? null, null, "Con veCostos(rol, email, env)=true el costo vacío debe respetarse y no reinyectarse");
});

test("Seguridad v4.5.1: /api/instalar bloquea 'el primero gana' exigiendo SUPER_ADMIN_EMAIL configurado y coincidente", async () => {
  const db = crearBaseDatosD1(":memory:");
  const payload = {
    nombre: "EMPRESA NUEVA C.A.",
    rif: "J-40111222-3",
    direccion: "Av. Francisco de Miranda, Caracas",
    telefono: "0414-0000000",
    email: "atacante@externo.test",
    clave: "ClaveSeguraTest2026!",
  };

  // Sin SUPER_ADMIN_EMAIL configurado -> 503 y no crea usuarios
  const rSinVar = await req({ DB: db, MASTER_KEY: MASTER_KEY_TEST }, "POST", "/api/instalar", payload);
  assert.equal(rSinVar.status, 503);
  assert.equal(await db.prepare(`SELECT COUNT(*) AS n FROM usuarios`).first<{ n: number }>().then((x) => x?.n), 0);

  // Con SUPER_ADMIN_EMAIL configurado pero distinto al correo enviado -> 403 y no crea usuarios
  const envCfg = { DB: db, MASTER_KEY: MASTER_KEY_TEST, SUPER_ADMIN_EMAIL: EMAIL_SUPER_TEST };
  const rDistinto = await req(envCfg, "POST", "/api/instalar", payload);
  assert.equal(rDistinto.status, 403);
  assert.equal(await db.prepare(`SELECT COUNT(*) AS n FROM usuarios`).first<{ n: number }>().then((x) => x?.n), 0);

  // Con el correo exacto de SUPER_ADMIN_EMAIL -> 200 y asigna rol SUPER_ADMIN
  const rOk = await req(envCfg, "POST", "/api/instalar", { ...payload, email: EMAIL_SUPER_TEST });
  assert.equal(rOk.status, 200);
  const u = await db.prepare(`SELECT rol, email FROM usuarios LIMIT 1`).first<{ rol: string; email: string }>();
  assert.equal(u?.rol, "SUPER_ADMIN");
  assert.equal(u?.email, EMAIL_SUPER_TEST);
});
