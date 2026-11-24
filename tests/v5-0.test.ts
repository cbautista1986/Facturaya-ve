import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { migrar } from "../src/migraciones";
import { asegurarTablasMultiTenant, generarWranglerTomlBindings } from "../src/inquilinos";
import {
  CRON_MANTENIMIENTO_NOCTURNO,
  esCronMantenimientoNocturno,
  esHorarioDiurnoCaracas,
  horaCaracas,
} from "../src/mantenimiento";
import {
  diagnosticarErrorBuild,
  guardarConfigCloudflare,
  relanzarBuildCloudflare,
  sincronizarBindingsD1Cloudflare,
} from "../src/cloudflare-api";

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
    .filter(([, v]) => v)
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

test("1. PWA Instalable: Manifest válido, 4 iconos PNG reales, Service Worker fiscalmente seguro e index.html completo", () => {
  const manifestPath = resolve("public/manifest.webmanifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.short_name.length <= 12, "short_name debe tener <= 12 caracteres");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);

  const tieneMaskable = manifest.icons.some((i: any) => i.purpose === "maskable" && i.sizes === "512x512");
  const tieneAny192 = manifest.icons.some((i: any) => i.purpose === "any" && i.sizes === "192x192");
  const tieneAny512 = manifest.icons.some((i: any) => i.purpose === "any" && i.sizes === "512x512");
  assert.equal(tieneMaskable, true, "Debe incluir ícono maskable 512x512 separado");
  assert.equal(tieneAny192, true, "Debe incluir ícono any 192x192");
  assert.equal(tieneAny512, true, "Debe incluir ícono any 512x512");

  // Verificar firma PNG (89 50 4E 47 0D 0A 1A 0A) y dimensiones IHDR exactas de los 4 iconos
  const iconosEsperados: Array<[string, number, number]> = [
    ["public/pwa-192x192.png", 192, 192],
    ["public/pwa-512x512.png", 512, 512],
    ["public/pwa-maskable-512x512.png", 512, 512],
    ["public/apple-touch-icon.png", 180, 180],
  ];
  for (const [ruta, wEsp, hEsp] of iconosEsperados) {
    const buf = readFileSync(resolve(ruta));
    assert.equal(buf[0], 0x89, `${ruta} firma PNG byte 0`);
    assert.equal(buf[1], 0x50, `${ruta} firma PNG byte 1 (P)`);
    assert.equal(buf[2], 0x4e, `${ruta} firma PNG byte 2 (N)`);
    assert.equal(buf[3], 0x47, `${ruta} firma PNG byte 3 (G)`);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(width, wEsp, `${ruta} ancho esperado ${wEsp}`);
    assert.equal(height, hEsp, `${ruta} alto esperado ${hEsp}`);
  }

  // Verificar que sw.js excluye explícitamente /api/ del caché
  const swTxt = readFileSync(resolve("public/sw.js"), "utf8");
  assert.ok(swTxt.includes('"/api/"'), "Service Worker jamás debe cachear /api/");
  assert.ok(swTxt.includes("skipWaiting"), "Service Worker debe activar actualizaciones limpiamente");

  // Verificar meta tags PWA y barra de conectividad global en index.html
  const html = readFileSync(resolve("public/index.html"), "utf8");
  assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'));
  assert.ok(html.includes('rel="apple-touch-icon" href="/apple-touch-icon.png"'));
  assert.ok(html.includes('id="barra-red"'));
});

test("2. Reloj Caracas (UTC-4), Silencio Diurno (6 AM–9 PM VET) y Cron Nocturno (2:00 AM VET = 0 6 * * *)", () => {
  // 06:00 AM VET = 10:00 UTC -> horario diurno protegido
  assert.equal(horaCaracas(new Date("2026-11-23T10:00:00Z")), 6);
  assert.equal(esHorarioDiurnoCaracas(new Date("2026-11-23T10:00:00Z")), true);

  // 08:59 PM VET = 00:59 UTC del día siguiente -> sigue siendo horario diurno protegido
  assert.equal(horaCaracas(new Date("2026-11-24T00:59:00Z")), 20);
  assert.equal(esHorarioDiurnoCaracas(new Date("2026-11-24T00:59:00Z")), true);

  // 09:00 PM VET = 01:00 UTC del día siguiente -> fuera de horario diurno (se permiten altas con binding inmediato)
  assert.equal(horaCaracas(new Date("2026-11-24T01:00:00Z")), 21);
  assert.equal(esHorarioDiurnoCaracas(new Date("2026-11-24T01:00:00Z")), false);

  // 02:00 AM VET = 06:00 UTC -> ventana nocturna
  assert.equal(horaCaracas(new Date("2026-11-23T06:00:00Z")), 2);
  assert.equal(esHorarioDiurnoCaracas(new Date("2026-11-23T06:00:00Z")), false);

  // Validación estricta de expresiones Cron
  assert.equal(esCronMantenimientoNocturno(CRON_MANTENIMIENTO_NOCTURNO), true);
  assert.equal(esCronMantenimientoNocturno("0 12,17,22 * * *"), false);

  // wrangler.toml debe declarar el doble cron (nocturno + diurno ultraligero)
  const wrangler = readFileSync(resolve("wrangler.toml"), "utf8");
  assert.ok(wrangler.includes('"0 6 * * *"'));
  assert.ok(wrangler.includes('"0 12,17,22 * * *"'));
});

test("3. Interruptor de Modo Mantenimiento para Despliegues: cierra sesiones de todos menos Súper Admin, bloquea 503 y reabre OK", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = {
    DB: db,
    MASTER_KEY: "llave-maestra-v500-mantenimiento",
    SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test",
  };
  const jarSuper: Record<string, string> = {};
  const jarCajero: Record<string, string> = {};

  // 1) Instalar negocio principal (Súper Admin)
  const inst = await reqJson(env, jarSuper, "/api/instalar", "POST", {
    nombre: "EMPRESA PRINCIPAL V5 C.A.",
    rif: "J-40123456-7",
    direccion: "Caracas, Venezuela",
    telefono: "0414-1112233",
    email: "superadmin@ejemplo.test",
    medio_facturacion: "APP_SENIAT",
    clave: "SuperClaveV500!",
  });
  assert.equal(inst.status, 200);

  // 2) Crear Cajero y autenticarlo en su propio jar
  const cajero = await reqJson(env, jarSuper, "/api/usuarios", "POST", {
    nombre: "Carlos Cajero",
    email: "cajero@ejemplo.test",
    rol: "CAJERO",
  });
  assert.equal(cajero.status, 200);
  await reqJson(env, jarSuper, `/api/usuarios/${cajero.data.id}/reset-clave`, "POST", {
    clave_nueva: "ClaveCajeroV500!",
    forzar_cambio: false,
  });
  const loginCaj = await reqJson(env, jarCajero, "/api/login", "POST", {
    email: "cajero@ejemplo.test",
    clave: "ClaveCajeroV500!",
  });
  assert.equal(loginCaj.status, 200);

  // Cajero NO puede activar mantenimiento (403 Forbidden)
  const intentoCaj = await reqJson(env, jarCajero, "/api/inquilinos/mantenimiento/despliegue/activar", "POST", {
    clave: "ClaveCajeroV500!",
  });
  assert.equal(intentoCaj.status, 403);

  // 3) Súper Admin activa Modo Mantenimiento con clave incorrecta -> 401
  const malClave = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/despliegue/activar", "POST", {
    clave: "ClaveEquivocada!",
  });
  assert.equal(malClave.status, 401);

  // 4) Súper Admin activa Modo Mantenimiento con clave correcta -> revoca sesión de Cajero y mantiene viva la de Súper Admin
  const act = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/despliegue/activar", "POST", {
    clave: "SuperClaveV500!",
    mensaje: "Desplegando actualización v5.0.0. Volvemos en 3 minutos.",
  });
  assert.equal(act.status, 200);
  assert.equal(act.data.ok, true);
  assert.equal(act.data.estado.activo, true);
  assert.equal(act.data.estado.etapa, "SESIONES_CERRADAS");
  assert.ok(act.data.sesiones_cerradas >= 1, "Debe haber revocado la sesión activa del cajero");

  // 5) Súper Admin sigue operando 100% normal
  const estSuper = await reqJson(env, jarSuper, "/api/estado");
  assert.equal(estSuper.status, 200);
  assert.equal(estSuper.data.sesion, true);
  assert.equal(estSuper.data.mantenimiento_despliegue?.activo, true);

  // 6) Cajero (con cookie anterior) es rechazado con HTTP 503 { mantenimiento: true } en rutas protegidas
  const cajBloqueado = await reqJson(env, jarCajero, "/api/clientes");
  assert.equal(cajBloqueado.status, 503);
  assert.equal(cajBloqueado.data.mantenimiento, true);

  // Cajero tampoco puede iniciar sesión mientras dure el mantenimiento (503)
  const cajRelogin = await reqJson(env, {}, "/api/login", "POST", {
    email: "cajero@ejemplo.test",
    clave: "ClaveCajeroV500!",
  });
  assert.equal(cajRelogin.status, 503);
  assert.equal(cajRelogin.data.mantenimiento, true);

  // Visitante anónimo en /api/estado recibe mantenimiento: true para pintar el aviso en portada
  const estAnon = await reqJson(env, {}, "/api/estado");
  assert.equal(estAnon.status, 200);
  assert.equal(estAnon.data.sesion, false);
  assert.equal(estAnon.data.mantenimiento, true);
  assert.ok(String(estAnon.data.mensaje_mantenimiento || "").includes("v5.0.0"));

  // 7) Avanzar etapas: DESPLEGANDO -> VERIFICADO_OK
  const et1 = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/despliegue/etapa", "POST", { etapa: "DESPLEGANDO" });
  assert.equal(et1.status, 200);
  assert.equal(et1.data.estado.etapa, "DESPLEGANDO");

  const et2 = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/despliegue/etapa", "POST", { etapa: "VERIFICADO_OK" });
  assert.equal(et2.status, 200);
  assert.equal(et2.data.estado.etapa, "VERIFICADO_OK");

  // 8) Desactivar mantenimiento -> sesiones listas para usar
  const desact = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/despliegue/desactivar", "POST", {
    clave: "SuperClaveV500!",
    sincronizar_bindings: false,
  });
  assert.equal(desact.status, 200);
  assert.equal(desact.data.estado.activo, false);
  assert.equal(desact.data.estado.etapa, "SESIONES_LISTAS");

  // 9) Cajero puede iniciar sesión y consultar /api/clientes nuevamente
  const jarCajeroNuevo: Record<string, string> = {};
  const reloginOk = await reqJson(env, jarCajeroNuevo, "/api/login", "POST", {
    email: "cajero@ejemplo.test",
    clave: "ClaveCajeroV500!",
  });
  assert.equal(reloginOk.status, 200);
  const cliOk = await reqJson(env, jarCajeroNuevo, "/api/clientes");
  assert.equal(cliOk.status, 200);

  // 10) Verificar logs registrados (DESPLIEGUE_INICIO y DESPLIEGUE_FIN)
  const estadoMant = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/estado");
  assert.equal(estadoMant.status, 200);
  const tipos = (estadoMant.data.logs || []).map((l: any) => l.tipo);
  assert.ok(tipos.includes("DESPLIEGUE_INICIO"));
  assert.ok(tipos.includes("DESPLIEGUE_FIN"));

  // 11) Cambiar etapa con mantenimiento inactivo -> 409 Conflict
  const etInactiva = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/despliegue/etapa", "POST", { etapa: "DESPLEGANDO" });
  assert.equal(etInactiva.status, 409);

  // 12) Regresión crítica: aunque el Súper Admin tenga rol='ADMIN' en la BD (autorizado vía SUPER_ADMIN_EMAIL), su sesión JAMÁS se revoca al activar mantenimiento
  await db.prepare(`UPDATE usuarios SET rol = 'ADMIN' WHERE email = 'super@ejemplo.test'`).run();
  const actRolAdmin = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/despliegue/activar", "POST", {
    clave: "SuperClaveV500!",
    mensaje: "Verificación de sesión Súper Admin por SUPER_ADMIN_EMAIL",
  });
  assert.equal(actRolAdmin.status, 200);
  const estSuperPost = await reqJson(env, jarSuper, "/api/estado");
  assert.equal(estSuperPost.status, 200);
  assert.equal(estSuperPost.data.sesion, true, "La sesión del Súper Admin (vía SUPER_ADMIN_EMAIL) debe permanecer activa");
  const desact2 = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/despliegue/desactivar", "POST", {
    clave: "SuperClaveV500!",
    sincronizar_bindings: false,
  });
  assert.equal(desact2.status, 200);
});

test("4. Mantenimiento Nocturno Manual, Preferencia de Correo y Silencio Diurno en Cron 0 12,17,22 * * *", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = {
    DB: db,
    MASTER_KEY: "llave-maestra-v500-nocturno",
    SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test",
  };
  const jarSuper: Record<string, string> = {};

  await reqJson(env, jarSuper, "/api/instalar", "POST", {
    nombre: "EMPRESA NOCTURNA C.A.",
    rif: "J-40998877-1",
    direccion: "Valencia, Carabobo",
    telefono: "0414-2223344",
    email: "superadmin@ejemplo.test",
    medio_facturacion: "APP_SENIAT",
    clave: "SuperClaveV500!",
  });

  // Configurar preferencia de correo resumen
  const modo = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/correo-modo", "POST", {
    modo: "SIEMPRE",
  });
  assert.equal(modo.status, 200);
  assert.equal(modo.data.mantenimiento.correo_resumen_modo, "SIEMPRE");

  // Cron diurno ("0 12,17,22 * * *") NO debe ejecutar mantenimiento pesado ni escribir log de NOCTURNO_AUTO
  const scheduledFn = (app as unknown as { scheduled: (ev: unknown, env: unknown) => Promise<void> }).scheduled;
  await scheduledFn({ cron: "0 12,17,22 * * *" }, env);
  const estTrasDiurno = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/estado");
  assert.equal(estTrasDiurno.data.logs.length, 0, "El cron diurno NO debe ejecutar mantenimiento nocturno");

  // Ejecutar mantenimiento manual desde el panel Súper Admin
  const ejec = await reqJson(env, jarSuper, "/api/inquilinos/mantenimiento/nocturno/ejecutar", "POST", {});
  assert.equal(ejec.status, 200);
  assert.equal(ejec.data.resultado.tipo, "NOCTURNO_MANUAL");
  assert.equal(ejec.data.resultado.empresas_revisadas, 1);
  assert.equal(ejec.data.resultado.empresas_sanas, 1);
  assert.ok(ejec.data.logs.some((l: any) => l.tipo === "NOCTURNO_MANUAL"));
});

test("5. Cloudflare API v5.0.0: Fix branch en relanzarBuildCloudflare, Auto-Bindings Nativos seguros (keep_bindings/keep_assets) y diagnóstico RAMA_NO_PRODUCCION", async () => {
  // Diagnóstico de rama no producción con workers_dev = false
  const diagRama = diagnosticarErrorBuild("Skipping preview deployment because workers_dev is false on branch Versión-4.9.1");
  assert.equal(diagRama?.codigo, "RAMA_NO_PRODUCCION");

  const db = crearBaseDatosD1(":memory:");
  await migrar(db);
  await asegurarTablasMultiTenant(db);
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "clave-maestra-v500-cf" };

  await guardarConfigCloudflare(db, env, {
    account_id: "00000000000000000000000000000001",
    api_token: "cf_token_v500_secret",
    worker_name: "facturaya",
  });

  // Insertar cliente DB_1 con d1_uuid real para probar sincronizarBindingsD1Cloudflare
  await db
    .prepare(
      `INSERT INTO _mt_inquilinos (codigo, tipo_db, d1_uuid, d1_nombre, nombre_negocio, rif, nombre_dueno, email_dueno, activo)
       VALUES ('DB_1', 'BINDING', 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb', 'facturaya_db_1', 'Cliente Uno C.A.', 'J-40111222-3', 'Juan', 'juan@uno.test', 1)`
    )
    .run();

  const TRIGGER_UUID = "11111111-2222-4333-8444-555555555555";
  let retryBodyCapturado: Record<string, unknown> | null = null;
  let patchSettingsCapturado: Record<string, unknown> | null = null;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();

    if (url.endsWith(`/builds/triggers/${TRIGGER_UUID}/builds`) && method === "POST") {
      retryBodyCapturado = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({ success: true, result: { build_uuid: "build-v5-ok" } }), { status: 200 });
    }
    if (url.endsWith("/workers/scripts/facturaya/settings") && method === "GET") {
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            bindings: [
              { type: "d1", name: "DB", id: "1c555fec-951d-48f9-bbb4-fc54bf6c2e84" },
              { type: "d1", name: "DB_DEMO", id: "e9d338be-05e8-4922-8b7c-33d14e8da116" },
              { type: "r2_bucket", name: "RESPALDOS_R2", bucket_name: "facturaya-respaldos" },
            ],
          },
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/workers/scripts/facturaya/settings") && method === "PATCH") {
      const fd = init?.body as FormData;
      const rawSettings = fd.get("settings");
      patchSettingsCapturado = JSON.parse(String(rawSettings || "{}"));
      return new Response(JSON.stringify({ success: true, result: patchSettingsCapturado }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false, errors: [{ message: "Not found" }] }), { status: 404 });
  };

  // 1) relanzarBuildCloudflare DEBE enviar { branch: "main" } (corrige Invalid request body)
  const retry = await relanzarBuildCloudflare(db, env, { trigger_uuid: TRIGGER_UUID, branch: "main" }, mockFetch);
  assert.equal(retry.ok, true);
  assert.equal(retryBodyCapturado?.branch, "main");

  // 2) sincronizarBindingsD1Cloudflare agrega DB_1 preservando DB, DB_DEMO, RESPALDOS_R2 y secretos/assets
  const sync = await sincronizarBindingsD1Cloudflare(db, env, undefined, mockFetch);
  assert.equal(sync.ok, true);
  assert.equal(sync.cambios, 1);
  assert.deepEqual(sync.enlazados, ["DB_1"]);
  assert.equal(patchSettingsCapturado?.keep_assets, true);
  assert.deepEqual(patchSettingsCapturado?.keep_bindings, ["secret_text", "assets"]);
  const bindingsEnviados = (patchSettingsCapturado?.bindings as Array<{ name: string; id?: string }>) || [];
  assert.ok(bindingsEnviados.some((b) => b.name === "DB"));
  assert.ok(bindingsEnviados.some((b) => b.name === "DB_DEMO"));
  assert.ok(bindingsEnviados.some((b) => b.name === "RESPALDOS_R2"));
  assert.ok(bindingsEnviados.some((b) => b.name === "DB_1" && b.id === "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb"));

  // 3) Protección de seguridad: si Cloudflare devolviera settings sin DB, debe abortar sin hacer PATCH
  const mockFetchPeligroso: typeof fetch = async () =>
    new Response(JSON.stringify({ success: true, result: { bindings: [] } }), { status: 200 });
  const syncAbortado = await sincronizarBindingsD1Cloudflare(db, env, undefined, mockFetchPeligroso);
  assert.equal(syncAbortado.ok, false);
  assert.ok(String(syncAbortado.error || "").includes("DB"));

  // 4) generador wrangler.toml preserva DB_DEMO, RESPALDOS_R2, DB_1 y doble cron
  const tomlRes = await generarWranglerTomlBindings(db, env);
  assert.ok(tomlRes.toml.includes('binding = "DB_DEMO"'));
  assert.ok(tomlRes.toml.includes('binding = "RESPALDOS_R2"'));
  assert.ok(tomlRes.toml.includes('binding = "DB_1"'));
  assert.ok(tomlRes.toml.includes('"0 6 * * *"'));
  assert.ok(tomlRes.toml.includes('"0 12,17,22 * * *"'));
});

test("6. Detección inteligente de App instalada (oculta franja si ya está instalada y solo aparece cuando realmente se puede instalar)", async () => {
  const { evaluarVisibilidadInstalacionPwa } = await import("../public/pwa.js");

  // 1) Abierta dentro de la App instalada (standalone / fullscreen / minimal-ui / iOS home screen): JAMÁS mostrar
  assert.equal(
    evaluarVisibilidadInstalacionPwa({ esStandalone: true, tienePromptNativo: true, esIos: true }),
    false
  );

  // 2) Ya confirmada como instalada (appinstalled o navigator.getInstalledRelatedApps): JAMÁS mostrar
  assert.equal(
    evaluarVisibilidadInstalacionPwa({ instaladaConfirmada: true, tienePromptNativo: false, esIos: false }),
    false
  );
  assert.equal(
    evaluarVisibilidadInstalacionPwa({ instaladaConfirmada: true, tienePromptNativo: true, esIos: true }),
    false
  );

  // 3) Abierta en navegador Chrome/Edge cuando la app YA está instalada (el navegador NO dispara beforeinstallprompt): NO mostrar
  assert.equal(
    evaluarVisibilidadInstalacionPwa({ esStandalone: false, instaladaConfirmada: false, instaladaLocal: false, tienePromptNativo: false, esIos: false }),
    false
  );

  // 4) Abierta en Chrome/Edge cuando NO está instalada (o fue desinstalada y el navegador dispara beforeinstallprompt): SÍ mostrar
  assert.equal(
    evaluarVisibilidadInstalacionPwa({ esStandalone: false, instaladaConfirmada: false, instaladaLocal: false, tienePromptNativo: true, esIos: false }),
    true
  );

  // 5) iOS Safari fuera de standalone y aún no marcada como instalada: SÍ mostrar guía de 2 pasos
  assert.equal(
    evaluarVisibilidadInstalacionPwa({ esStandalone: false, instaladaConfirmada: false, instaladaLocal: false, tienePromptNativo: false, esIos: true }),
    true
  );

  // 6) iOS Safari donde el usuario ya marcó "Ya la tengo instalada": NO mostrar
  assert.equal(
    evaluarVisibilidadInstalacionPwa({ esStandalone: false, instaladaConfirmada: false, instaladaLocal: true, tienePromptNativo: false, esIos: true }),
    false
  );

  // 7) Verificar manifest.webmanifest incluye related_applications para getInstalledRelatedApps()
  const manifest = JSON.parse(readFileSync(resolve("public/manifest.webmanifest"), "utf8"));
  assert.equal(manifest.prefer_related_applications, false);
  assert.ok(
    Array.isArray(manifest.related_applications) &&
      manifest.related_applications.some((r: any) => r.platform === "webapp" && String(r.url).endsWith("/manifest.webmanifest")),
    "manifest debe declarar related_applications webapp para detección nativa en navegador"
  );

  // 8) Verificar diagnóstico en español para desfase npm ci / package-lock.json
  const diagLock = diagnosticarErrorBuild("npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.");
  assert.equal(diagLock?.codigo, "LOCKFILE_DESFASADO");
  assert.ok(String(diagLock?.resumen || "").includes("package-lock.json"));
});

