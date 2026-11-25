import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { cifrarSecreto, descifrarSecreto, estaCifrado } from "../src/cifrado";
import {
  consultarDesplieguesYBuilds,
  consultarEstadoCloudflare,
  consultarLogBuildCloudflare,
  crearBaseD1EnCloudflare,
  crearDbCloudflareHttp,
  descubrirAccountIdCloudflare,
  diagnosticarErrorBuild,
  eliminarBaseD1EnCloudflare,
  guardarConfigCloudflare,
  relanzarBuildCloudflare,
  rollbackWorkerCloudflare,
} from "../src/cloudflare-api";
import { generarListaRanurasD1 } from "../src/inquilinos";
import { migrar } from "../src/migraciones";

function extraerCookies(res: Response, jar: Record<string, string>) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  for (const c of raw) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (m) jar[m[1].trim()] = m[2].trim();
  }
}

function headerCookie(jar: Record<string, string>) {
  return Object.entries(jar)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function reqJson(
  env: Record<string, unknown>,
  jar: Record<string, string>,
  ruta: string,
  metodo = "GET",
  body?: unknown
) {
  const headers: Record<string, string> = {};
  const ck = headerCookie(jar);
  if (ck) headers["Cookie"] = ck;
  if (body !== undefined) headers["Content-Type"] = "application/json";
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
  return { status: res.status, data, headers: res.headers };
}

test("1. Cifrado AES-256-GCM en reposo y retrocompatibilidad con secretos en texto plano", async () => {
  const env = { MASTER_KEY: "clave-maestra-prueba-facturaya-2026" };
  const secretoOriginal = "xkeysib-9f8e7d6c5b4a3210-secreto-brevo";

  const cifrado = await cifrarSecreto(secretoOriginal, env);
  assert.equal(estaCifrado(cifrado), true);
  assert.ok(cifrado.startsWith("enc:v2:mk:"));
  assert.notEqual(cifrado, secretoOriginal);

  const descifrado = await descifrarSecreto(cifrado, env);
  assert.equal(descifrado, secretoOriginal);

  // Retrocompatibilidad: si en la BD había una clave antigua en texto plano, se lee sin romperse
  const textoPlanoAntiguo = "re_clave_antigua_sin_cifrar_12345";
  assert.equal(await descifrarSecreto(textoPlanoAntiguo, env), textoPlanoAntiguo);

  // Si cambia la llave maestra, no lanza excepción no controlada y devuelve vacío de forma segura
  assert.equal(await descifrarSecreto(cifrado, { MASTER_KEY: "otra-llave-distinta" }), "");
});

test("2. Adaptador Cloudflare API y D1 HTTP (auto-detección de Account ID, cuota 10 D1 gratis, crear/borrar D1)", async () => {
  const db = crearBaseDatosD1(":memory:");
  await migrar(db);
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-maestra-cloudflare-2026" };

  const basesRemotas: Array<{ uuid: string; name: string; created_at: string; file_size: number }> = [
    { uuid: "1c555fec-951d-48f9-bbb4-fc54bf6c2e84", name: "facturacion_ve_db", created_at: "2026-11-01T00:00:00Z", file_size: 163840 },
  ];

  const remotoSqlite = crearBaseDatosD1(":memory:");
  let subrequestsQuery = 0;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();

    if (url.includes("/client/v4/accounts?") && method === "GET") {
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "00000000000000000000000000000001", name: "Cuenta Demo Cloudflare" }],
        }),
        { status: 200 }
      );
    }
    if (url.includes("/d1/database") && !url.includes("/query") && method === "GET") {
      return new Response(JSON.stringify({ success: true, result: basesRemotas }), { status: 200 });
    }
    if (url.endsWith("/d1/database") && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}"));
      const nueva = {
        uuid: `uuid-${basesRemotas.length + 1}`,
        name: body.name,
        created_at: new Date().toISOString(),
        file_size: 24576,
      };
      basesRemotas.push(nueva);
      return new Response(JSON.stringify({ success: true, result: nueva }), { status: 200 });
    }
    if (url.includes("/d1/database/") && method === "DELETE") {
      const uuid = url.split("/d1/database/")[1];
      const idx = basesRemotas.findIndex((b) => b.uuid === uuid);
      if (idx >= 0) basesRemotas.splice(idx, 1);
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
    }
    if (url.includes("/challenges/widgets")) {
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ sitekey: "0x4AAAAAACp1", name: "FacturaYa Login", domains: ["facturacion.ejemplo.test"], mode: "managed" }],
        }),
        { status: 200 }
      );
    }
    if (url.includes("/workers/scripts/")) {
      return new Response(
        JSON.stringify({
          success: true,
          result: { bindings: [{ type: "d1", name: "DB" }] },
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/query") && method === "POST") {
      subrequestsQuery++;
      const payload = JSON.parse(String(init?.body || "{}"));
      if (Array.isArray(payload.batch)) {
        const resBatch = await remotoSqlite.batch(
          payload.batch.map((q: { sql: string; params?: unknown[] }) => {
            const st = remotoSqlite.prepare(q.sql);
            return q.params?.length ? st.bind(...q.params) : st;
          })
        );
        return new Response(
          JSON.stringify({
            success: true,
            result: resBatch.map((r) => ({ results: r.results ?? [], success: true, meta: r.meta ?? { changes: 0, last_row_id: 0 } })),
          }),
          { status: 200 }
        );
      }
      const st = remotoSqlite.prepare(payload.sql);
      const bound = payload.params?.length ? st.bind(...payload.params) : st;
      const r = await bound.all();
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ results: r.results ?? [], success: true, meta: r.meta ?? { changes: 0, last_row_id: 0 } }],
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ success: false, errors: [{ message: "No soportado" }] }), { status: 404 });
  };

  // Auto-descubrir Account ID usando solo el API Token
  const desc = await descubrirAccountIdCloudflare("cf_token_secreto_1234", mockFetch);
  assert.equal(desc.ok, true);
  if (desc.ok) {
    assert.equal(desc.account_id, "00000000000000000000000000000001");
  }

  // Guardar configuración cifrada en D1
  await guardarConfigCloudflare(db, env, {
    account_id: "00000000000000000000000000000001",
    api_token: "cf_token_secreto_1234",
    worker_name: "facturaya",
  });

  // Consultar estado general en Cloudflare
  const estadoInicial = await consultarEstadoCloudflare(db, env, mockFetch);
  assert.equal(estadoInicial.ok, true);
  assert.equal(estadoInicial.cuota_d1.usadas, 1);
  assert.equal(estadoInicial.cuota_d1.libres_gratis, 9);
  assert.equal(estadoInicial.turnstile_widgets.length, 1);

  // Crear base física facturaya_db_1 en Cloudflare
  const creada = await crearBaseD1EnCloudflare(db, env, "facturaya_db_1", mockFetch);
  assert.equal(creada.ok, true);
  if (creada.ok) {
    assert.equal(creada.name, "facturaya_db_1");

    const estadoDespues = await consultarEstadoCloudflare(db, env, mockFetch);
    assert.equal(estadoDespues.cuota_d1.usadas, 2);
    assert.equal(estadoDespues.cuota_d1.libres_gratis, 8);

    // Probar adaptador D1 HTTP con migraciones completas (0001..0021) + batch sobre esa base remota
    const dbHttp = crearDbCloudflareHttp("00000000000000000000000000000001", "cf_token_secreto_1234", creada.uuid, mockFetch);
    await migrar(dbHttp);
    assert.ok(subrequestsQuery <= 28, `Se esperaban <= 28 subrequests en migrar(dbHttp), fueron ${subrequestsQuery}`);
    const fila = await dbHttp.prepare("SELECT 1 AS ok, ? AS total").bind(5000).first<{ ok: number; total: number }>();
    assert.equal(fila?.ok, 1);
    assert.equal(fila?.total, 5000);
    const conteoMigraciones = await dbHttp.prepare("SELECT COUNT(*) AS n FROM _migraciones").first<{ n: number }>();
    assert.equal(conteoMigraciones?.n, 21);

    // Eliminar base física y recuperar cuota
    const borrada = await eliminarBaseD1EnCloudflare(db, env, creada.uuid, mockFetch);
    assert.equal(borrada.ok, true);
    const estadoFinal = await consultarEstadoCloudflare(db, env, mockFetch);
    assert.equal(estadoFinal.cuota_d1.usadas, 1);
    assert.equal(estadoFinal.cuota_d1.libres_gratis, 9);
  }
});

test("3. Estandarización de ranuras DB_1..DB_9, Respaldo de Entrega al Cliente y Baja Definitiva con Liberación de Ranura", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test" };
  const jar: Record<string, string> = {};

  // 1) Instalar negocio principal de SuperAdmin
  const inst = await reqJson(env, jar, "/api/instalar", "POST", {
    nombre: "EMPRESA DEMO C.A.",
    rif: "V-12345678-1",
    direccion: "Caracas, Distrito Capital",
    telefono: "0414-0000000",
    email: "superadmin@ejemplo.test",
    medio_facturacion: "APP_SENIAT",
    clave: "ClavePruebaSegura2026!",
  });
  assert.equal(inst.status, 200);
  assert.equal(inst.data.ok, true);

  // 2) Verificar que las ranuras estándar sugeridas son DB_1..DB_9 y la próxima es DB_1 (nunca t2)
  const listado0 = await reqJson(env, jar, "/api/inquilinos");
  assert.equal(listado0.status, 200);
  assert.equal(listado0.data.proxima_ranura, "DB_1");
  assert.equal(listado0.data.ranuras_d1.length, 9);

  // 3) Crear Cliente #1 sin indicar ranura -> debe asignarse automáticamente DB_1
  const alta1 = await reqJson(env, jar, "/api/inquilinos", "POST", {
    nombre_negocio: "Panadería Tachirense C.A.",
    rif: "J-40112233-4",
    direccion: "Av. Carabobo, Caracas",
    telefono: "0414-1234567",
    nombre_dueno: "Pedro Pérez",
    email_dueno: "pedro@panaderia.com",
    medio_facturacion: "APP_SENIAT",
    modo_inicial: "REAL",
    plan_usd: 10,
  });
  assert.equal(alta1.status, 200);
  assert.equal(alta1.data.codigo, "DB_1");
  assert.equal(alta1.data.d1_nombre, "facturaya_db_1");

  // 4) Crear Cliente #2 -> debe asignarse automáticamente DB_2
  const alta2 = await reqJson(env, jar, "/api/inquilinos", "POST", {
    nombre_negocio: "Ferretería El Clavo C.A.",
    rif: "J-50223344-5",
    direccion: "Calle 10, Mérida",
    telefono: "0424-7654321",
    nombre_dueno: "María Gómez",
    email_dueno: "maria@ferreteria.com",
    medio_facturacion: "APP_SENIAT",
    modo_inicial: "REAL",
    plan_usd: 10,
  });
  assert.equal(alta2.status, 200);
  assert.equal(alta2.data.codigo, "DB_2");

  // 5) Descargar Respaldo de Entrega del Cliente #1 (DB_1) antes de darlo de baja por falta de pago
  const respCliente1 = await app.fetch(
    new Request("http://localhost/api/inquilinos/DB_1/respaldo", {
      headers: { Cookie: headerCookie(jar) },
    }),
    env as any
  );
  assert.equal(respCliente1.status, 200);
  const jsonEntrega = await respCliente1.json();
  assert.equal(jsonEntrega.tipo, "entrega-base-datos-cliente");
  assert.equal(jsonEntrega.codigo_ranura, "DB_1");
  assert.equal(jsonEntrega.nombre_negocio, "Panadería Tachirense C.A.");
  assert.ok(typeof jsonEntrega.sha256 === "string" && jsonEntrega.sha256.length === 64);

  // 6) Dar de baja definitiva al Cliente #1 (DB_1) liberando su ranura y su correo
  const baja1 = await reqJson(env, jar, "/api/inquilinos/DB_1/eliminar", "POST", {
    clave: "ClavePruebaSegura2026!",
    confirmar: "ELIMINAR",
  });
  assert.equal(baja1.status, 200);
  assert.equal(baja1.data.ok, true);
  assert.equal(baja1.data.codigo_liberado, "DB_1");

  // 7) Verificar que DB_1 volvió a quedar libre como próxima ranura para el siguiente cliente nuevo
  const listadoDespuesBaja = await reqJson(env, jar, "/api/inquilinos");
  assert.equal(listadoDespuesBaja.data.proxima_ranura, "DB_1");
  const codigosActivos = listadoDespuesBaja.data.inquilinos.map((i: any) => i.codigo);
  assert.ok(!codigosActivos.includes("DB_1"));
  assert.ok(codigosActivos.includes("DB_2"));

  // 8) Crear un nuevo Cliente #3 -> reutiliza limpiamente la ranura DB_1 recién liberada
  const alta3 = await reqJson(env, jar, "/api/inquilinos", "POST", {
    nombre_negocio: "Clínica Los Andes C.A.",
    rif: "J-30998877-6",
    direccion: "Barrio Obrero, Caracas",
    telefono: "0412-9988776",
    nombre_dueno: "Dr. Luis Rivas",
    email_dueno: "luis@clinica.com",
    medio_facturacion: "APP_SENIAT",
    modo_inicial: "REAL",
    plan_usd: 10,
  });
  assert.equal(alta3.status, 200);
  assert.equal(alta3.data.codigo, "DB_1");
});

test("4. Ficha RIF SENIAT + Cédula + APIs en Alta, Candado Obligatorio de Respaldo antes de Baja y Permisos Dueño vs Empleado con Checkmark", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-maestra-test-2026", SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test" };
  const jarSuper: Record<string, string> = {};

  // 1) Instalar principal (SuperAdmin)
  const inst = await reqJson(env, jarSuper, "/api/instalar", "POST", {
    nombre: "EMPRESA DEMO PRINCIPAL C.A.",
    rif: "V-12345678-1",
    direccion: "AV PRINCIPAL EDIF CENTRO LOCAL 1 CARACAS DISTRITO CAPITAL ZONA POSTAL 1010",
    telefono: "0414-0000000",
    email: "superadmin@ejemplo.test",
    medio_facturacion: "APP_SENIAT",
    clave: "ClavePruebaSegura2026!",
  });
  assert.equal(inst.status, 200);

  // 2) Dar de alta a un cliente con Ficha RIF SENIAT completa + Cédula + Logo + API Brevo + API Imprenta Digital
  const logoTest = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const altaCompleta = await reqJson(env, jarSuper, "/api/inquilinos", "POST", {
    ranura_db: "DB_1",
    nombre_negocio: "INVERSIONES DEMO CENTRO C.A.",
    rif: "J-41223344-5",
    firma_personal: "COMERCIAL DEMO CENTRO",
    direccion: "AV BOLIVAR LOCAL 12 CARACAS DISTRITO CAPITAL",
    zona_postal: "1010",
    sector_seniat: "SECTOR CAPITAL",
    rif_comprobante: "2025101312345678000000001",
    rif_fecha_inscripcion: "18/05/2006",
    rif_fecha_actualizacion: "13/10/2025",
    rif_codigo_firma: "00000000000001",
    nombre_dueno: "Carlos Eduardo Mendoza",
    cedula_dueno: "V-15.443.221",
    representante_fecha_nac: "22/04/1986",
    representante_estado_civil: "Soltero",
    representante_cedula_venc: "18/10/2031",
    telefono: "0414-1234567",
    email_dueno: "carlos@empresademo.test",
    logo_base64: logoTest,
    medio_facturacion: "IMPRENTA_DIGITAL",
    imprenta_proveedor: "The Factory HKA",
    imprenta_url: "https://demoemision.thefactoryhka.com.ve/api",
    imprenta_usuario: "J412233445",
    imprenta_clave: "token_imprenta_cliente_1234",
    imprenta_ambiente: "PRUEBAS",
    correo_proveedor: "BREVO",
    correo_remitente: "facturacion@empresademo.test",
    correo_nombre: "Inversiones Demo Centro",
    correo_clave: "xkeysib-clave-brevo-cliente-9876",
    modo_inicial: "REAL",
    plan_usd: 15,
    primer_factura: 341,
    primer_control: 511,
  });
  assert.equal(altaCompleta.status, 200);
  assert.equal(altaCompleta.data.codigo, "DB_1");
  assert.equal(altaCompleta.data.correlativos_iniciales.primer_factura, 341);
  assert.equal(altaCompleta.data.correlativos_iniciales.primer_control, 511);

  // 3) CANDADO DE BAJA: Intentar borrar DB_1 SIN haber descargado antes su respaldo -> debe rechazar con 409 Conflict
  const intentoBajaSinRespaldo = await reqJson(env, jarSuper, "/api/inquilinos/DB_1/eliminar", "POST", {
    clave: "ClavePruebaSegura2026!",
    confirmar: "ELIMINAR",
  });
  assert.equal(intentoBajaSinRespaldo.status, 409);
  assert.ok(String(intentoBajaSinRespaldo.data.error || "").includes("Descargar BD Cliente"));

  // 4) Verificar que el Dueño (ADMIN) del negocio DB_1 puede iniciar sesión, ver sus datos RIF y editar sus APIs con Checkmark, pero NO puede usar sin Checkmark
  const jarDueno: Record<string, string> = {};
  const loginTemp = await reqJson(env, jarDueno, "/api/login", "POST", {
    email: "carlos@empresademo.test",
    clave: altaCompleta.data.clave_temporal,
  });
  assert.equal(loginTemp.status, 200);

  const cambioClave = await reqJson(env, jarDueno, "/api/cuenta/clave", "POST", {
    actual: altaCompleta.data.clave_temporal,
    nueva: "ClaveFuerteDueno2026!",
  });
  assert.equal(cambioClave.status, 200);

  // Verificar que los datos del RIF, Cédula, Logo y APIs quedaron guardados en DB_1
  const estDueno = await reqJson(env, jarDueno, "/api/estado");
  assert.equal(estDueno.status, 200);
  assert.equal(estDueno.data.negocio.representante_cedula, "V-15.443.221");
  assert.equal(estDueno.data.negocio.logo_base64, logoTest);

  // v4.9.1: Los clientes (ADMIN de inquilino) usan el Correo de Plataforma; NO pueden escribir API Keys propias ni invocar salir-en-vivo (403)
  const correoClienteBloqueado = await reqJson(env, jarDueno, "/api/sistema/correo", "POST", {
    proveedor: "BREVO",
    remitente: "facturacion@empresademo.test",
    nombre_remitente: "Demo Centro",
    clave: "xkeysib-nueva-clave-1111",
    password: "ClaveFuerteDueno2026!",
    confirmo: true,
  });
  assert.equal(correoClienteBloqueado.status, 403);

  const salirVivoClienteBloqueado = await reqJson(env, jarDueno, "/api/sistema/salir-en-vivo", "POST", {
    primer_factura: 1,
    primer_control: 1,
    primer_presupuesto: 1,
    confirmo: true,
  });
  assert.equal(salirVivoClienteBloqueado.status, 403);

  // El Dueño (ADMIN) SÍ puede consultar el estado de Correo de Plataforma (GET)
  const estadoCorreoDueno = await reqJson(env, jarDueno, "/api/sistema/correo");
  assert.equal(estadoCorreoDueno.status, 200);
  assert.equal(estadoCorreoDueno.data.ok, true);

  // El Dueño crea un empleado Cajero y le asigna una contraseña directa
  const crearCajero = await reqJson(env, jarDueno, "/api/usuarios", "POST", {
    nombre: "Ana Cajera",
    email: "ana@empresademo.test",
    rol: "CAJERO",
  });
  assert.equal(crearCajero.status, 200);

  const fijarClaveCajero = await reqJson(env, jarDueno, `/api/usuarios/${crearCajero.data.id}/reset-clave`, "POST", {
    clave_nueva: "ClaveDirectaCajera2026!",
    forzar_cambio: false,
  });
  assert.equal(fijarClaveCajero.status, 200);

  // El empleado Cajero inicia sesión con la clave asignada por el Dueño, pero NO puede ver ni editar APIs (403 Forbidden)
  const jarCajero: Record<string, string> = {};
  const loginCajero = await reqJson(env, jarCajero, "/api/login", "POST", {
    email: "ana@empresademo.test",
    clave: "ClaveDirectaCajera2026!",
  });
  assert.equal(loginCajero.status, 200);
  const intentoCajeroApi = await reqJson(env, jarCajero, "/api/sistema/correo");
  assert.equal(intentoCajeroApi.status, 403);

  // Verificar que los contadores de Mis Inquilinos (usadas_d1, libres_d1 y directorio de correos) se actualizan en caliente:
  const panelSuper = await reqJson(env, jarSuper, "/api/inquilinos");
  assert.equal(panelSuper.status, 200);
  assert.equal(panelSuper.data.usadas_d1, 2); // principal + DB_1
  assert.equal(panelSuper.data.libres_d1, 8); // 8 de 10 libres en Plan Gratis
  assert.equal(panelSuper.data.directorio.length, 3); // SuperAdmin + Carlos (Dueño DB_1) + Ana (Cajera DB_1)

  // Verificar escalabilidad automática de 10 BD (Plan Gratis) a 50.000 BD (Plan Workers Paid $5/mes) sin cambiar código:
  const ranurasIniciales = generarListaRanurasD1(["PRINCIPAL"], 5, false);
  assert.equal(ranurasIniciales.length, 9); // DB_1 .. DB_9 en Plan Gratis inicial
  const ranurasAlCrecer = generarListaRanurasD1(["PRINCIPAL", "DB_1", "DB_2", "DB_3", "DB_4", "DB_5", "DB_6", "DB_7", "DB_8", "DB_9"], 5, false);
  assert.equal(ranurasAlCrecer.includes("DB_10"), true);
  assert.equal(ranurasAlCrecer.includes("DB_14"), true);
  const ranurasPlan5Usd = generarListaRanurasD1(["PRINCIPAL"], 5, true);
  assert.equal(ranurasPlan5Usd.length, 15); // Al activar Plan $5/mes muestra de inmediato DB_1..DB_15 y sigue expandiendo hasta DB_50000
});

test("5. Escalabilidad a 100+ BD: Auditoría /salud por lotes, Respaldo Maestro paginado y ranuras DB_100+", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-maestra-100bd-2026", SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test" };
  const jar: Record<string, string> = {};

  const inst = await reqJson(env, jar, "/api/instalar", "POST", {
    nombre: "EMPRESA DEMO C.A.",
    rif: "V-12345678-1",
    direccion: "Caracas, Distrito Capital",
    telefono: "0414-0000000",
    email: "superadmin@ejemplo.test",
    medio_facturacion: "APP_SENIAT",
    clave: "ClavePruebaSegura2026!",
  });
  assert.equal(inst.status, 200);

  // Crear 3 clientes (total 4 empresas con principal)
  for (let i = 1; i <= 3; i++) {
    const r = await reqJson(env, jar, "/api/inquilinos", "POST", {
      nombre_negocio: `Empresa Demo ${i} C.A.`,
      rif: `J-4000000${i}-1`,
      direccion: `Calle ${i}, Miranda`,
      telefono: `0414-000000${i}`,
      nombre_dueno: `Dueño ${i}`,
      email_dueno: `dueno${i}@demo${i}.com`,
      medio_facturacion: "APP_SENIAT",
      modo_inicial: "REAL",
      plan_usd: 10,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.codigo, `DB_${i}`);
  }

  // Auditoría paginada por lotes de 2 BD
  const lote1 = await reqJson(env, jar, "/api/inquilinos/salud?desde=0&limite=2");
  assert.equal(lote1.status, 200);
  assert.equal(lote1.data.total_empresas, 4);
  assert.equal(lote1.data.auditadas_en_lote, 2);
  assert.equal(lote1.data.hay_mas, true);
  assert.equal(lote1.data.sano_global, true);
  assert.equal(lote1.data.reportes[0].codigo, "principal");
  assert.equal(lote1.data.reportes[1].codigo, "DB_1");

  const lote2 = await reqJson(env, jar, "/api/inquilinos/salud?desde=2&limite=2");
  assert.equal(lote2.status, 200);
  assert.equal(lote2.data.auditadas_en_lote, 2);
  assert.equal(lote2.data.hay_mas, false);
  assert.equal(lote2.data.reportes[0].codigo, "DB_2");
  assert.equal(lote2.data.reportes[1].codigo, "DB_3");

  // Respaldo Maestro paginado por lotes de 2 BD
  const respLote = await app.fetch(
    new Request("http://localhost/api/inquilinos/respaldo-maestro?desde=0&limite=2", {
      headers: { Cookie: headerCookie(jar) },
    }),
    env as any
  );
  assert.equal(respLote.status, 200);
  const maestroJson = await respLote.json();
  assert.equal(maestroJson.total_empresas, 4);
  assert.equal(maestroJson.empresas_en_archivo, 2);
  assert.equal(maestroJson.hay_mas, true);
  assert.deepEqual(Object.keys(maestroJson.negocios), ["principal", "DB_1"]);

  // Ranuras con 100 empresas activas -> genera DB_101..DB_105 listas sin tope
  const cienOcupadas = ["PRINCIPAL", ...Array.from({ length: 100 }, (_, i) => `DB_${i + 1}`)];
  const ranurasCien = generarListaRanurasD1(cienOcupadas, 5, true);
  assert.equal(ranurasCien.includes("DB_101"), true);
  assert.equal(ranurasCien.includes("DB_105"), true);
});

test("6. Cloudflare Builds: Diagnóstico automático en español, consulta de builds/logs, reintentar con purge cache y rollback", async () => {
  // 6A) Función pura diagnosticarErrorBuild
  assert.equal(diagnosticarErrorBuild("All checks passed successfully."), null);
  assert.equal(diagnosticarErrorBuild(""), null);

  const dLock = diagnosticarErrorBuild("error: lockfile had changes, but lockfile is frozen");
  assert.equal(dLock?.codigo, "LOCKFILE_DESFASADO");

  const dBuild = diagnosticarErrorBuild('npm error Missing script: "build"');
  assert.equal(dBuild?.codigo, "FALTA_SCRIPT_BUILD");

  const dTs = diagnosticarErrorBuild("src/d1.ts(4,24): error TS2307: Cannot find module 'better-sqlite3'.");
  assert.equal(dTs?.codigo, "ERROR_TYPESCRIPT");
  assert.ok(dTs?.resumen.includes("src/d1.ts"));

  const dPerm = diagnosticarErrorBuild("API responded with HTTP 403 Authentication error");
  assert.equal(dPerm?.codigo, "PERMISO_TOKEN");

  const dGen = diagnosticarErrorBuild("Step 1\n✘ [ERROR] Could not resolve entry point\nBuild failed");
  assert.equal(dGen?.codigo, "FALLO_COMPILACION");

  // 6B) Flujo completo sobre fetch simulado de Cloudflare Workers Builds & Deployments API
  const db = crearBaseDatosD1(":memory:");
  await migrar(db);
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "clave-maestra-builds-2026" };

  // Sin configurar -> SIN_CONECTAR limpio
  const sinCfg = await consultarDesplieguesYBuilds(db, env);
  assert.equal(sinCfg.ok, true);
  assert.equal(sinCfg.configurado, false);
  assert.equal(sinCfg.estado_general, "SIN_CONECTAR");

  await guardarConfigCloudflare(db, env, {
    account_id: "00000000000000000000000000000001",
    api_token: "cf_user_token_builds_9999",
    worker_name: "facturaya",
  });

  const SCRIPT_TAG = "11223344556677889900aabbccddeeff";
  const TRIGGER_UUID = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";
  const BUILD_FAIL_UUID = "11111111-2222-4333-8444-555555555555";
  const BUILD_OK_UUID = "66666666-7777-4888-8999-000000000000";
  const VER_OLD = "d312bf96-0000-4000-8000-000000000001";
  const VER_CUR = "080e65be-0000-4000-8000-000000000002";

  let purgoCache = false;
  let buildRelanzado = false;
  let versionRollback = "";

  const mockFetchBuilds: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();

    if (url.endsWith("/workers/scripts") && method === "GET") {
      return new Response(
        JSON.stringify({ success: true, result: [{ id: "facturaya", tag: SCRIPT_TAG }] }),
        { status: 200 }
      );
    }
    if (url.endsWith("/workers/scripts/facturaya/deployments") && method === "GET") {
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            deployments: [
              {
                id: "dep-cur",
                created_on: "2026-11-16T22:16:00Z",
                source: "workers_builds",
                author_email: "superadmin@ejemplo.test",
                annotations: { "workers/message": "Versión estable actual" },
                versions: [{ version_id: VER_CUR, percentage: 100 }],
              },
              {
                id: "dep-old",
                created_on: "2026-11-16T21:30:00Z",
                source: "workers_builds",
                author_email: "superadmin@ejemplo.test",
                annotations: { "workers/message": "v3.3 estable" },
                versions: [{ version_id: VER_OLD, percentage: 0 }],
              },
            ],
          },
        }),
        { status: 200 }
      );
    }
    if (url.includes(`/builds/workers/${SCRIPT_TAG}/builds`) && method === "GET") {
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              build_uuid: BUILD_FAIL_UUID,
              trigger_uuid: TRIGGER_UUID,
              status: "stopped",
              build_outcome: "fail",
              created_on: "2026-11-16T22:20:00Z",
              running_on: "2026-11-16T22:20:02Z",
              stopped_on: "2026-11-16T22:20:21Z",
              build_trigger_metadata: {
                branch: "main",
                commit_hash: "ceab95b12345",
                commit_message: "Fix bun.lock build",
                author: "desarrollador-demo",
              },
            },
            {
              build_uuid: BUILD_OK_UUID,
              trigger_uuid: TRIGGER_UUID,
              status: "stopped",
              build_outcome: "success",
              created_on: "2026-11-16T22:00:00Z",
              running_on: "2026-11-16T22:00:02Z",
              stopped_on: "2026-11-16T22:00:39Z",
              build_trigger_metadata: {
                branch: "main",
                commit_hash: "080e65be9999",
                commit_message: "Remove SQLite D1 adapter",
                author: "desarrollador-demo",
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.includes(`/builds/workers/${SCRIPT_TAG}/triggers`) && method === "GET") {
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              trigger_uuid: TRIGGER_UUID,
              trigger_name: "Producción main",
              branch_includes: ["main"],
              build_command: "bun run build",
              deploy_command: "npx wrangler deploy",
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith(`/builds/builds/${BUILD_FAIL_UUID}/logs`) && method === "GET") {
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            truncated: false,
            lines: [
              [1763331602, "Running bun install --frozen-lockfile"],
              [1763331605, "error: lockfile had changes, but lockfile is frozen"],
            ],
          },
        }),
        { status: 200 }
      );
    }
    if (url.endsWith(`/builds/triggers/${TRIGGER_UUID}/purge_build_cache`) && method === "POST") {
      purgoCache = true;
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
    }
    if (url.endsWith(`/builds/triggers/${TRIGGER_UUID}/builds`) && method === "POST") {
      buildRelanzado = true;
      return new Response(
        JSON.stringify({ success: true, result: { build_uuid: "99999999-1111-4222-8333-444444444444" } }),
        { status: 200 }
      );
    }
    if (url.endsWith("/workers/scripts/facturaya/deployments") && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}"));
      versionRollback = String(body.versions?.[0]?.version_id || "");
      assert.equal(body.strategy, "percentage");
      assert.equal(body.versions?.[0]?.percentage, 100);
      return new Response(JSON.stringify({ success: true, result: { id: "dep-rb-1" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  };

  const estado = await consultarDesplieguesYBuilds(db, env, mockFetchBuilds);
  assert.equal(estado.ok, true);
  assert.equal(estado.configurado, true);
  assert.equal(estado.script_tag, SCRIPT_TAG);
  assert.equal(estado.estado_general, "ERROR_BUILD");
  assert.equal(estado.builds.length, 2);
  assert.equal(estado.builds[0].duracion_seg, 19);
  assert.equal(estado.triggers.length, 1);
  assert.equal(estado.deployments.length, 2);
  assert.equal(estado.deployments[0].activa, true);
  assert.equal(estado.deployments[1].activa, false);

  const logRes = await consultarLogBuildCloudflare(db, env, BUILD_FAIL_UUID, mockFetchBuilds);
  assert.equal(logRes.ok, true);
  if (logRes.ok) {
    assert.equal(logRes.diagnostico?.codigo, "LOCKFILE_DESFASADO");
    assert.ok(logRes.texto.includes("lockfile is frozen"));
  }

  // Validación defensiva de UUID inválido
  const badLog = await consultarLogBuildCloudflare(db, env, "../etc/passwd", mockFetchBuilds);
  assert.equal(badLog.ok, false);

  const retryRes = await relanzarBuildCloudflare(db, env, { trigger_uuid: TRIGGER_UUID, purgar_cache: true }, mockFetchBuilds);
  assert.equal(retryRes.ok, true);
  assert.equal(purgoCache, true);
  assert.equal(buildRelanzado, true);

  const rbRes = await rollbackWorkerCloudflare(db, env, VER_OLD, "Volver a v3.3", mockFetchBuilds);
  assert.equal(rbRes.ok, true);
  assert.equal(versionRollback, VER_OLD);
});

test("7. RBAC y Contraseña Súper Admin en endpoints HTTP /api/inquilinos/cloudflare/builds y rollback", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test" };
  const jarSuper: Record<string, string> = {};

  const inst = await reqJson(env, jarSuper, "/api/instalar", "POST", {
    nombre: "EMPRESA DEMO C.A.",
    rif: "V-12345678-1",
    direccion: "Caracas, Distrito Capital",
    telefono: "0414-0000000",
    email: "superadmin@ejemplo.test",
    medio_facturacion: "APP_SENIAT",
    clave: "ClavePruebaSegura2026!",
  });
  assert.equal(inst.status, 200);

  // Súper Admin consulta builds sin token conectado -> 200 SIN_CONECTAR
  const buildsSuper = await reqJson(env, jarSuper, "/api/inquilinos/cloudflare/builds");
  assert.equal(buildsSuper.status, 200);
  assert.equal(buildsSuper.data.estado_general, "SIN_CONECTAR");

  // Contraseña incorrecta en relanzar build o rollback -> 401
  const badRetry = await reqJson(env, jarSuper, "/api/inquilinos/cloudflare/builds/reintentar", "POST", {
    clave: "ClaveIncorrecta!",
  });
  assert.equal(badRetry.status, 401);

  const badRb = await reqJson(env, jarSuper, "/api/inquilinos/cloudflare/rollback", "POST", {
    version_id: "d312bf96-0000-4000-8000-000000000001",
    clave: "ClaveIncorrecta!",
  });
  assert.equal(badRb.status, 401);

  // Crear usuario CAJERO en principal y verificar que tiene 403 Forbidden en builds/rollback
  const cajeroRes = await reqJson(env, jarSuper, "/api/usuarios", "POST", {
    nombre: "Luis Cajero",
    email: "luis.cajero@ejemplo.test",
    rol: "CAJERO",
  });
  assert.equal(cajeroRes.status, 200);

  await reqJson(env, jarSuper, `/api/usuarios/${cajeroRes.data.id}/reset-clave`, "POST", {
    clave_nueva: "ClaveCajero2026!",
    forzar_cambio: false,
  });

  const jarCajero: Record<string, string> = {};
  const loginCaj = await reqJson(env, jarCajero, "/api/login", "POST", {
    email: "luis.cajero@ejemplo.test",
    clave: "ClaveCajero2026!",
  });
  assert.equal(loginCaj.status, 200);

  assert.equal((await reqJson(env, jarCajero, "/api/inquilinos/cloudflare/builds")).status, 403);
  assert.equal((await reqJson(env, jarCajero, "/api/inquilinos/cloudflare/builds/reintentar", "POST", { clave: "x" })).status, 403);
  assert.equal((await reqJson(env, jarCajero, "/api/inquilinos/cloudflare/rollback", "POST", { version_id: "d312bf96-0000-4000-8000-000000000001", clave: "x" })).status, 403);
});

test("8. Paquete v4.0 Escala Pro (100 Empresas × 100 Facturas/día): Deduplicación SHA-256 de Logos, Paginación, Generador wrangler.toml, Respaldo por Año y Cron por Lotes", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test" };
  const jar: Record<string, string> = {};

  const inst = await reqJson(env, jar, "/api/instalar", "POST", {
    nombre: "EMPRESA DEMO ESCALA PRO C.A.",
    rif: "J-41234567-8",
    direccion: "Caracas",
    telefono: "0414-0000000",
    email: "superadmin@ejemplo.test",
    medio_facturacion: "APP_SENIAT",
    clave: "SuperClave2026!",
  });
  assert.equal(inst.status, 200);

  // 1) Guardar un logo Base64 de ~40 KB y tasa BCV en configuración y verificar que entra en emisor_logos
  const logoPesado = "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".repeat(400);
  const cfgLogo = await reqJson(env, jar, "/api/config", "PUT", {
    logo_base64: logoPesado,
    tasa_bcv_modo: "MANUAL",
    tasa_bcv: "42,50",
    confirmo_fiscal: true,
  });
  assert.equal(cfgLogo.status, 200);

  const cli = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "J-29999999-1",
    nombre_apellido: "Corporación Andina C.A.",
    direccion: "Valencia",
  });
  assert.equal(cli.status, 200);

  // 2) Emitir 3 facturas y comprobar que el logo NO se duplica en documentos.emisor_json
  const docIds: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const borrador = await reqJson(env, jar, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      condicion: "CONTADO",
      lineas: [{ tipo: "SERVICIO", descripcion: `Servicio Cloud Mes ${i}`, cantidad: "1", precio_usd: `${100 * i},00`, alicuota_iva: 16 }],
    });
    assert.equal(borrador.status, 200);
    const em = await reqJson(env, jar, `/api/documentos/${borrador.data.id}/emitir`, "POST", {});
    assert.equal(em.status, 200);
    docIds.push(borrador.data.id);
  }

  // En D1 hay solo 1 fila en emisor_logos, y documentos.emisor_json pesa < 400 bytes (sin los 40 KB del logo inline)
  const nLogos = await db.prepare("SELECT COUNT(*) AS n FROM emisor_logos").first<{ n: number }>();
  assert.equal(nLogos?.n, 1);
  const rawDoc = await db.prepare("SELECT emisor_json FROM documentos WHERE id = ?").bind(docIds[0]).first<{ emisor_json: string }>();
  assert.ok(rawDoc && rawDoc.emisor_json.length < 450, `Se esperaba emisor_json < 450 bytes en BD, pero midió ${rawDoc?.emisor_json.length}`);
  const parsedRaw = JSON.parse(rawDoc!.emisor_json);
  assert.equal(parsedRaw.logo_base64, null);
  assert.equal(typeof parsedRaw.logo_hash, "string");

  // Pero al consultar GET /api/documentos/:id, el logo_base64 se hidrata transparentemente desde emisor_logos
  const detDoc = await reqJson(env, jar, `/api/documentos/${docIds[0]}`);
  assert.equal(detDoc.status, 200);
  const emisorHidratado = JSON.parse(detDoc.data.documento.emisor_json);
  assert.equal(emisorHidratado.logo_base64, logoPesado);

  // 3) Probar paginación y filtro por mes en GET /api/documentos
  const pag0 = await reqJson(env, jar, "/api/documentos?tipo=FACTURA&pagina=0&limite=2");
  assert.equal(pag0.status, 200);
  assert.equal(pag0.data.documentos.length, 2);
  assert.equal(pag0.data.hay_mas, true);
  assert.equal(pag0.data.pagina, 0);

  const pag1 = await reqJson(env, jar, "/api/documentos?tipo=FACTURA&pagina=1&limite=2");
  assert.equal(pag1.status, 200);
  assert.equal(pag1.data.documentos.length, 1);
  assert.equal(pag1.data.hay_mas, false);

  const mesActual = String(detDoc.data.documento.fecha_emision).slice(0, 7);
  const porMes = await reqJson(env, jar, `/api/documentos?tipo=FACTURA&mes=${mesActual}`);
  assert.equal(porMes.status, 200);
  assert.equal(porMes.data.documentos.length, 3);

  const porMesVacio = await reqJson(env, jar, "/api/documentos?tipo=FACTURA&mes=2020-01");
  assert.equal(porMesVacio.status, 200);
  assert.equal(porMesVacio.data.documentos.length, 0);

  // 4) Probar Generador de wrangler.toml con Bindings Nativos
  const tomlRes = await reqJson(env, jar, "/api/inquilinos/cloudflare/wrangler-toml");
  assert.equal(tomlRes.status, 200);
  assert.equal(tomlRes.data.ok, true);
  assert.ok(String(tomlRes.data.toml).includes('binding = "DB"'));
  assert.ok(String(tomlRes.data.toml).includes('database_name = "facturacion_ve_db"'));

  // 5) Probar Respaldo filtrado por año (?anio=YYYY)
  const anioActual = String(detDoc.data.documento.fecha_emision).slice(0, 4);
  const respAnio = await reqJson(env, jar, `/api/sistema/respaldo?anio=${anioActual}`);
  assert.equal(respAnio.status, 200);
  assert.equal(respAnio.data.anio_filtro, Number(anioActual));
  assert.equal(respAnio.data.conteos.documentos, 3);

  const respOtroAnio = await reqJson(env, jar, "/api/sistema/respaldo?anio=2021");
  assert.equal(respOtroAnio.status, 200);
  assert.equal(respOtroAnio.data.anio_filtro, 2021);
  assert.equal(respOtroAnio.data.conteos.documentos, 0);

  // 6) Probar Cron Nocturno (2:00 AM VET = "0 6 * * *"): purga de sesiones vencidas + bitácora de mantenimiento
  await db.prepare("INSERT INTO sesiones (token_hash, usuario_id, expira_en) VALUES ('expirada_hash_123', 1, 100)").run();
  for (let i = 1; i <= 18; i++) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, nombre_dueno, email_dueno, activo)
         VALUES (?, 'PREFIJO', ?, ?, 'Dueño', ?, 1)`
      )
      .bind(`DB_${i}`, `Empresa ${i}`, `J-400000${String(i).padStart(2, "0")}-1`, `emp${i}@test.com`)
      .run();
  }
  const scheduledFn = (app as unknown as { scheduled: (ev: unknown, env: unknown) => Promise<void> }).scheduled;
  await scheduledFn({ cron: "0 6 * * *" }, env);

  const sesExpirada = await db.prepare("SELECT 1 FROM sesiones WHERE token_hash = 'expirada_hash_123'").first();
  assert.equal(sesExpirada, null, "La sesión expirada debió purgarse en el Cron nocturno 0 6 * * *");

  const logNocturno = await db.prepare("SELECT tipo, empresas_revisadas FROM _mt_mantenimiento_logs ORDER BY id DESC LIMIT 1").first<{ tipo: string; empresas_revisadas: number }>();
  assert.equal(logNocturno?.tipo, "NOCTURNO_AUTO");
  assert.ok((logNocturno?.empresas_revisadas || 0) >= 18, "El mantenimiento nocturno debe auditar todas las empresas activas");
});

test("9. Paquete v4.2 Blindaje de Auditoría Claude: Llave Privada por Instancia D1 (_mt_llave_plataforma), Recuperación de Un Solo Uso, Cobertura Exacta de Respaldo antes de Reinicio en REAL, Retenciones 75%/100% e ISLR y Conector Imprenta Digital con Idempotency-Key y Reintento sin alterar APP_SENIAT", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-maestra-blindaje-v42-2026", SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test" };
  const jar: Record<string, string> = {};

  const inst = await reqJson(env, jar, "/api/instalar", "POST", {
    nombre: "EMPRESA DEMO BLINDAJE V4.1 C.A.",
    rif: "V-12345678-1",
    direccion: "Caracas, Distrito Capital",
    telefono: "0414-0000000",
    email: "superadmin@ejemplo.test",
    medio_facturacion: "APP_SENIAT",
    clave: "ClavePruebaSegura2026!",
  });
  assert.equal(inst.status, 200);

  await reqJson(env, jar, "/api/config", "PUT", { tasa_bcv_modo: "MANUAL", tasa_bcv: "100,00" });
  await reqJson(env, jar, "/api/sistema/correo", "POST", {
    proveedor: "BREVO",
    remitente: "facturacion@ejemplo.test",
    nombre_remitente: "EMPRESA DEMO",
    clave: "xkeysib-v41-test",
    password: "ClavePruebaSegura2026!",
    confirmo: true,
  });

  // 1) Recuperación de correo NO destructiva y anti-enumeración:
  // Pedir recuperación para un correo inexistente devuelve 200 genérico (no 404).
  const recInexistente = await reqJson(env, {}, "/api/recuperar-correo", "POST", { email: "noexiste@dominio.com" });
  assert.equal(recInexistente.status, 200);
  assert.equal(recInexistente.data.ok, true);

  // Pedir recuperación para el Súper Admin NO invalida su sesión activa ni sobrescribe su password_hash hasta que se use la clave temporal.
  let correoRecupTexto = "";
  const fetchOrig = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      correoRecupTexto = String(payload.textContent || "");
      return new Response(JSON.stringify({ messageId: "rec-v41" }), { status: 201 });
    }) as typeof fetch;

    const recReal = await reqJson(env, {}, "/api/recuperar-correo", "POST", { email: "superadmin@ejemplo.test" });
    assert.equal(recReal.status, 200);
    assert.ok(correoRecupTexto.includes("Clave temporal"), "Debe enviar la clave temporal al administrador");
  } finally {
    globalThis.fetch = fetchOrig;
  }

  // La sesión actual (jar) sigue 100% activa (un atacante NO pudo desconectar a SuperAdmin pidiendo recuperación)
  const estSigueActivo = await reqJson(env, jar, "/api/estado");
  assert.equal(estSigueActivo.status, 200);
  assert.equal(estSigueActivo.data.sesion, true, "La sesión activa no debe cerrarse por una solicitud no confirmada de /api/recuperar-correo");

  // Y la contraseña original sigue funcionando (y limpia la clave temporal pendiente)
  const jarLoginNormal: Record<string, string> = {};
  const loginNormal = await reqJson(env, jarLoginNormal, "/api/login", "POST", {
    email: "superadmin@ejemplo.test",
    clave: "ClavePruebaSegura2026!",
  });
  assert.equal(loginNormal.status, 200);
  const filaUsrTrasNormal = await db.prepare("SELECT clave_temporal_hash, clave_temporal_expira FROM usuarios WHERE id = 1").first<{ clave_temporal_hash: string | null; clave_temporal_expira: number }>();
  assert.equal(filaUsrTrasNormal?.clave_temporal_hash, null, "Al entrar con su clave normal, la clave temporal no solicitada se descarta");

  // 2) Salir en vivo en APP_SENIAT y comprobar que APP_SENIAT sigue intacto
  await reqJson(env, jar, "/api/sistema/salir-en-vivo", "POST", {
    primer_factura: 1,
    primer_nota_credito: 1,
    primer_nota_debito: 1,
    primer_control: 1,
    primer_presupuesto: 1,
    primer_recibo: 1,
    confirmo: true,
  });

  const cli = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "J-40123987-0",
    nombre_apellido: "Cliente Blindaje C.A.",
  });
  assert.equal(cli.status, 200);

  const facAppSeniat = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    lineas: [{ tipo: "SERVICIO", descripcion: "Soporte Mensual", cantidad: "1", precio_usd: "100,00", alicuota_iva: 16 }],
  });
  const emAppSeniat = await reqJson(env, jar, `/api/documentos/${facAppSeniat.data.id}/emitir`, "POST", {});
  assert.equal(emAppSeniat.status, 200);
  assert.equal(emAppSeniat.data.numero, 1);
  assert.equal(emAppSeniat.data.control_fiscal, undefined, "En modo APP_SENIAT no se toca la emisión ni se invoca imprenta externa");

  // 3) Validación exacta de Retención de IVA (solo 75% o 100% del IVA neto = Bs 1.200 o Bs 1.600)
  const ret50Invalida = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: facAppSeniat.data.id,
    metodo: "RETENCION_IVA",
    moneda: "BS",
    monto: "800,00", // 50% del IVA -> inválido según Providencia SNAT/2015/0049
    tasa: "100,00",
    comprobante_retencion: "20261100000099",
  });
  assert.equal(ret50Invalida.status, 400);
  assert.ok(String(ret50Invalida.data.error || "").includes("75%"));

  // 4) Candado de Respaldo antes de Reinicio en Modo REAL (Punto 3 acordado con SuperAdmin):
  // Con facturas REALES emitidas, intentar reiniciar-fabrica SIN haber descargado respaldo devuelve 409 Conflict
  const reinicioSinRespaldo = await reqJson(env, jar, "/api/sistema/reiniciar-fabrica", "POST", {
    clave: "ClavePruebaSegura2026!",
    confirmo: true,
    frase_confirmacion: "REINICIAR-DEFINITIVAMENTE",
  });
  assert.equal(reinicioSinRespaldo.status, 409, "Debe exigir descargar el respaldo antes de reiniciar una BD con facturas REALES");
  assert.ok(String(reinicioSinRespaldo.data.error || "").includes("Candado de Respaldo Obligatorio"));

  // Descargar el respaldo completo registra ultimo_respaldo_descargado, ultimo_respaldo_cobertura (1:1) y firma_hmac con MASTER_KEY (mk)
  const respParcial = await reqJson(env, jar, "/api/sistema/respaldo");
  assert.equal(respParcial.status, 200);
  assert.equal(typeof respParcial.data.firma_hmac, "string");
  assert.ok(respParcial.data.firma_hmac.startsWith("hmac:v1:mk:"), `Se esperaba firma_hmac con kid mk (MASTER_KEY), recibido: ${respParcial.data.firma_hmac}`);
  assert.equal(respParcial.data.cobertura_real?.n, 1);

  // 4b) Confirmar que clave_temporal es de UN SOLO USO (y se invalida tras usarse):
  let claveTempExtraida = "";
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      const txt = String(payload.textContent || "");
      const m = txt.match(/Clave temporal \(válida 30 min\):\s*([^\s<]+)/);
      if (m) claveTempExtraida = m[1];
      return new Response(JSON.stringify({ messageId: "rec-v42-uso-unico" }), { status: 201 });
    }) as typeof fetch;
    // Limpiar enfriamiento previo de reccor para solicitar una nueva clave temporal
    await db.prepare("DELETE FROM intentos_login").run();
    await db.prepare("DELETE FROM _mt_rate_limit").run();
    const rec2 = await reqJson(env, {}, "/api/recuperar-correo", "POST", { email: "superadmin@ejemplo.test" });
    assert.equal(rec2.status, 200);
    assert.ok(claveTempExtraida.length >= 8, "Debe haberse extraído la clave temporal enviada al correo");
  } finally {
    globalThis.fetch = fetchOrig;
  }

  // Primer login con clave_temporal -> funciona (200), activa debe_cambiar_clave=1 y limpia clave_temporal_hash
  const jarTemp: Record<string, string> = {};
  const loginConTemp1 = await reqJson(env, jarTemp, "/api/login", "POST", {
    email: "superadmin@ejemplo.test",
    clave: claveTempExtraida,
  });
  assert.equal(loginConTemp1.status, 200);
  const filaTrasTemp = await db.prepare("SELECT clave_temporal_hash, debe_cambiar_clave FROM usuarios WHERE id = 1").first<{ clave_temporal_hash: string | null; debe_cambiar_clave: number }>();
  assert.equal(filaTrasTemp?.clave_temporal_hash, null, "clave_temporal_hash debe limpiarse inmediatamente al usarse");
  assert.equal(filaTrasTemp?.debe_cambiar_clave, 1);

  // Cambiar a la clave definitiva y verificar que intentar reutilizar claveTempExtraida falla con 401
  const cambioDef = await reqJson(env, jarTemp, "/api/cuenta/clave", "POST", {
    actual: claveTempExtraida,
    nueva: "ClavePruebaSegura2026!",
  });
  assert.equal(cambioDef.status, 200);
  const loginReusoTemp = await reqJson(env, {}, "/api/login", "POST", {
    email: "superadmin@ejemplo.test",
    clave: claveTempExtraida,
  });
  assert.equal(loginReusoTemp.status, 401, "La clave temporal ya usada y reemplazada NO debe volver a funcionar");

  // Reautenticar sesión principal jar tras rotación de sesión
  await reqJson(env, jar, "/api/login", "POST", {
    email: "superadmin@ejemplo.test",
    clave: "ClavePruebaSegura2026!",
  });

  // 5) Probar Conector HTTP en Vivo de Imprenta Digital (con fallo inicial + reintento idempotente con renglones e impuestos)
  await reqJson(env, jar, "/api/sistema/imprenta", "POST", {
    proveedor: "The Factory HKA",
    url: "https://imprenta-test.ejemplo.test/api/emitir",
    usuario: "V123456781",
    clave: "token-secreto-hka-2026",
    ambiente: "PRUEBAS",
    password: "ClavePruebaSegura2026!",
    confirmo: true,
  });
  await reqJson(env, jar, "/api/sistema/medio", "POST", {
    medio: "IMPRENTA_DIGITAL",
    motivo: "Prueba de conector automático de Imprenta Digital",
    clave: "ClavePruebaSegura2026!",
    confirmo: true,
  });

  const facImprenta = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    lineas: [{ tipo: "SERVICIO", descripcion: "Licencia Anual", cantidad: "1", precio_usd: "250,00", alicuota_iva: 16 }],
  });
  assert.equal(facImprenta.status, 200);

  let payloadImprentaRecibido: any = null;
  let idempotencyHeaderRecibido = "";
  let simularFalloImprenta = true;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://imprenta-test.ejemplo.test/api/emitir") {
        const hdrs = new Headers(init?.headers);
        idempotencyHeaderRecibido = hdrs.get("Idempotency-Key") || "";
        payloadImprentaRecibido = JSON.parse(String(init?.body || "{}"));
        if (simularFalloImprenta) {
          return new Response(JSON.stringify({ error: "Imprenta ocupada" }), { status: 503 });
        }
        return new Response(JSON.stringify({ ok: true, control_fiscal: "00-00987654" }), { status: 200 });
      }
      return fetchOrig(input, init);
    }) as typeof fetch;

    // 5a) Primer intento: la imprenta responde 503 -> el documento queda emitido sin control_fiscal y registrado en imprenta_pendiente_<id>
    const emImp = await reqJson(env, jar, `/api/documentos/${facImprenta.data.id}/emitir`, "POST", {});
    assert.equal(emImp.status, 200);
    assert.equal(emImp.data.control_fiscal, undefined);
    const pendRow = await db.prepare("SELECT valor FROM integraciones WHERE clave = ?").bind(`imprenta_pendiente_${facImprenta.data.id}`).first<{ valor: string }>();
    assert.ok(pendRow?.valor, "Debe registrar el estado pendiente de control fiscal cuando la imprenta falla");

    // 5b) Reintento idempotente mediante POST /api/documentos/:id/fiscal con { reintentar_imprenta: true }
    simularFalloImprenta = false;
    const reintImp = await reqJson(env, jar, `/api/documentos/${facImprenta.data.id}/fiscal`, "POST", { reintentar_imprenta: true });
    assert.equal(reintImp.status, 200);
    assert.equal(reintImp.data.control_fiscal, "00-00987654", "El reintento debe asignar el control_fiscal devuelto por la Imprenta Digital");
    assert.equal(idempotencyHeaderRecibido, "V123456781-FACTURA-REAL-2", "Debe enviar cabecera Idempotency-Key determinista");
    assert.equal(payloadImprentaRecibido?.documento?.tipo_documento, "FACTURA");
    assert.equal(payloadImprentaRecibido?.documento?.numero, 2);
    assert.equal(payloadImprentaRecibido?.emisor?.rif, "V-12345678-1");
    assert.equal(Array.isArray(payloadImprentaRecibido?.documento?.renglones), true);
    assert.equal(payloadImprentaRecibido.documento.renglones.length, 1);
    assert.equal(Array.isArray(payloadImprentaRecibido?.documento?.impuestos), true);
    const pendDespues = await db.prepare("SELECT valor FROM integraciones WHERE clave = ?").bind(`imprenta_pendiente_${facImprenta.data.id}`).first();
    assert.equal(pendDespues, null, "Al obtener el control fiscal debe limpiar imprenta_pendiente_<id>");
  } finally {
    globalThis.fetch = fetchOrig;
  }

  const detFacImp = await reqJson(env, jar, `/api/documentos/${facImprenta.data.id}`);
  assert.equal(detFacImp.data.documento.control_fiscal, "00-00987654");

  // 6) Candado de Cobertura Exacta de Respaldo (Punto 3 de Claude):
  // Como se emitió una 2da factura (facImprenta) DESPUÉS de haber descargado respParcial (que solo cubría 1 factura),
  // intentar reiniciar-fabrica ahora DEBE rechazarse con 409 hasta descargar un respaldo actualizado.
  const reinicioConRespaldoViejo = await reqJson(env, jar, "/api/sistema/reiniciar-fabrica", "POST", {
    clave: "ClavePruebaSegura2026!",
    confirmo: true,
    frase_confirmacion: "REINICIAR-DEFINITIVAMENTE",
  });
  assert.equal(reinicioConRespaldoViejo.status, 409, "Debe rechazar el reinicio si se emitieron nuevas facturas REALES después del último respaldo");
  assert.ok(String(reinicioConRespaldoViejo.data.error || "").includes("nuevos documentos fiscales REALES"));

  // Descargar el respaldo actualizado (ahora cubre las 2 facturas REALES)
  const respCompleto = await reqJson(env, jar, "/api/sistema/respaldo");
  assert.equal(respCompleto.status, 200);
  assert.equal(respCompleto.data.cobertura_real?.n, 2);

  // Ahora sí permite reiniciar-fabrica porque el respaldo descargado cubre exactamente los 2 documentos REALES actuales
  const reinicioConRespaldo = await reqJson(env, jar, "/api/sistema/reiniciar-fabrica", "POST", {
    clave: "ClavePruebaSegura2026!",
    confirmo: true,
    frase_confirmacion: "REINICIAR-DEFINITIVAMENTE",
  });
  assert.equal(reinicioConRespaldo.status, 200);

  // Reinstalar y verificar que restaurar/iniciar rechaza un manifiesto con firma_hmac adulterada pero acepta el legítimo
  await reqJson(env, jar, "/api/instalar", "POST", {
    nombre: "EMPRESA DEMO REINSTALADO C.A.",
    rif: "V-12345678-1",
    direccion: "Miranda",
    telefono: "0414-0000000",
    email: "superadmin@ejemplo.test",
    medio_facturacion: "APP_SENIAT",
    clave: "ClavePruebaSegura2026!",
  });

  const restFirmaFalsa = await reqJson(env, jar, "/api/sistema/restaurar/iniciar", "POST", {
    clave: "ClavePruebaSegura2026!",
    manifiesto: {
      version: 2,
      modo_origen: "REAL",
      conteos: respCompleto.data.conteos,
      sumas: respCompleto.data.sumas,
      huella: respCompleto.data.huella,
      firma_hmac: "hmac:v1:mk:" + "0".repeat(64),
    },
  });
  assert.equal(restFirmaFalsa.status, 400, "Debe rechazar un respaldo cuya firma_hmac haya sido falsificada");

  const restFirmaValida = await reqJson(env, jar, "/api/sistema/restaurar/iniciar", "POST", {
    clave: "ClavePruebaSegura2026!",
    manifiesto: {
      version: 2,
      modo_origen: respCompleto.data.modo_origen,
      conteos: respCompleto.data.conteos,
      sumas: respCompleto.data.sumas,
      huella: respCompleto.data.huella,
      firma_hmac: respCompleto.data.firma_hmac,
    },
  });
  assert.equal(restFirmaValida.status, 200, "Debe aceptar un respaldo con firma_hmac auténtica firmada con MASTER_KEY");
  await reqJson(env, jar, "/api/sistema/restaurar/cancelar", "POST", {});
});






