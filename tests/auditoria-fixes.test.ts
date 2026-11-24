import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { guardarConfigCloudflare } from "../src/cloudflare-api";
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
  return { status: res.status, data };
}

async function instalarBase(env: Record<string, unknown>, jar: Record<string, string>) {
  if (!env.SUPER_ADMIN_EMAIL) env.SUPER_ADMIN_EMAIL = "superadmin@ejemplo.test";
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
}

test("1. NC: bloqueo de PUT en borrador NC, concurrencia /devolver sin huérfanos y anulación por pagos de presupuesto o mes cerrado", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db };
  const jar: Record<string, string> = {};
  await instalarBase(env, jar);

  // Tasa rápida sin confirmo_fiscal debe seguir funcionando (Inicio)
  const tasaRapida = await reqJson(env, jar, "/api/config", "PUT", { tasa_bcv: "100,00" });
  assert.equal(tasaRapida.status, 200);

  // Editar datos fiscales/logo SIN confirmo_fiscal debe fallar con 400
  const fiscalSinConfirmar = await reqJson(env, jar, "/api/config", "PUT", {
    nombre_razon_social: "EMPRESA DEMO MODIFICADO C.A.",
    rif: "V-12345678-1",
    direccion_fiscal: "Caracas, Distrito Capital",
  });
  assert.equal(fiscalSinConfirmar.status, 400);

  // Editar datos fiscales CON confirmo_fiscal: true debe pasar
  const fiscalConfirmado = await reqJson(env, jar, "/api/config", "PUT", {
    nombre_razon_social: "EMPRESA DEMO VERIFICADO C.A.",
    rif: "V-12345678-1",
    direccion_fiscal: "Caracas, Distrito Capital",
    confirmo_fiscal: true,
  });
  assert.equal(fiscalConfirmado.status, 200);

  const enVivo = await reqJson(env, jar, "/api/sistema/salir-en-vivo", "POST", {
    primer_factura: 1,
    primer_nota_credito: 1,
    primer_control: 1,
    primer_presupuesto: 1,
    primer_recibo: 1,
    confirmo: true,
  });
  assert.equal(enVivo.status, 200);

  const cli = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "J-40112233-4",
    nombre_apellido: "Cliente Prueba S.A.",
  });
  assert.equal(cli.status, 200);

  const prod = await reqJson(env, jar, "/api/catalogo", "POST", {
    tipo: "PRODUCTO",
    nombre: "Switch Gigabit 8P",
    precio_usd: "40,00",
    costo_usd: "20,00",
    alicuota_iva: 16,
    controla_stock: 1,
  });
  assert.equal(prod.status, 200);
  await reqJson(env, jar, "/api/existencias/carga", "POST", {
    producto_id: prod.data.id,
    cantidad: "5",
    costo_usd: "20,00",
    nota: "Stock inicial",
  });

  // Crear y emitir factura de 2 unidades
  const fac = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    lineas: [{ catalogo_id: prod.data.id, cantidad: "2", precio_usd: "40,00" }],
  });
  assert.equal(fac.status, 200);
  const em = await reqJson(env, jar, `/api/documentos/${fac.data.id}/emitir`, "POST", {});
  assert.equal(em.status, 200);

  // Devolución concurrente por 2 unidades: solo UNA puede ganar, la otra falla con 409 y no deja borradores huérfanos
  const [rA, rB] = await Promise.all([
    reqJson(env, jar, `/api/documentos/${fac.data.id}/devolver`, "POST", {
      motivo: "Devolución simultánea A",
      lineas: [{ orden: 1, cantidad: "2" }],
    }),
    reqJson(env, jar, `/api/documentos/${fac.data.id}/devolver`, "POST", {
      motivo: "Devolución simultánea B",
      lineas: [{ orden: 1, cantidad: "2" }],
    }),
  ]);
  const estados = [rA.status, rB.status].sort((a, b) => a - b);
  assert.deepEqual(estados, [200, 409]);

  const huerfanos = await db
    .prepare(`SELECT COUNT(*) AS n FROM documentos WHERE es_nota_credito = 1 AND estado = 'BORRADOR'`)
    .first<{ n: number }>();
  assert.equal(huerfanos?.n, 0, "No deben quedar borradores huérfanos tras un fallo en /devolver");

  const movs = await reqJson(env, jar, `/api/existencias/${prod.data.id}/movimientos`);
  assert.equal(movs.data.stock_milli, 5000, "El stock debe volver exactamente a 5 unidades sin duplicarse");

  // Un borrador de Nota de Crédito jamás debe ser editable por PUT /:id
  await db
    .prepare(
      `INSERT INTO documentos (tipo, es_nota_credito, factura_afectada_id, motivo_nc, estado, modo, cliente_id, subtotal_usd, iva_usd, total_usd, costo_total_usd)
       VALUES ('FACTURA', 1, ?, 'Prueba', 'BORRADOR', 'REAL', ?, 1000, 160, 1160, 0)`
    )
    .bind(fac.data.id, cli.data.id)
    .run();
  const ncBorrador = await db
    .prepare(`SELECT id FROM documentos WHERE es_nota_credito = 1 AND estado = 'BORRADOR' LIMIT 1`)
    .first<{ id: number }>();
  assert.ok(ncBorrador);
  const intentoPutNc = await reqJson(env, jar, `/api/documentos/${ncBorrador.id}`, "PUT", {
    cliente_id: cli.data.id,
    lineas: [{ catalogo_id: prod.data.id, cantidad: "1", precio_usd: "40,00" }],
  });
  assert.equal(intentoPutNc.status, 409);
  await db.prepare(`DELETE FROM documentos WHERE id = ? AND estado = 'BORRADOR'`).bind(ncBorrador.id).run();

  // Nota de Crédito emitida en un mes fiscal anterior NO puede anularse
  const ncEmitidaId = rA.status === 200 ? rA.data.id : rB.data.id;
  const { results: triggersNc } = await db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'documentos'`)
    .all<{ name: string; sql: string }>();
  // Simular cierre de mes de la NC para probar la regla de mes anterior
  await db.prepare(`DROP TRIGGER IF EXISTS doc_inmutable`).run();
  await db.prepare(`UPDATE documentos SET fecha_emision = '2025-01-15' WHERE id = ?`).bind(ncEmitidaId).run();
  for (const tr of triggersNc) {
    if (tr.name === "doc_inmutable" && tr.sql) await db.prepare(tr.sql).run();
  }
  const anularNcCerrada = await reqJson(env, jar, `/api/documentos/${ncEmitidaId}/anular`, "POST", {
    motivo: "Intento de anular NC de mes cerrado",
  });
  assert.equal(anularNcCerrada.status, 409);
  assert.ok(String(anularNcCerrada.data.error || "").includes("período fiscal anterior"));

  // Presupuesto: cobrar directamente sobre presupuesto está bloqueado (Art. 13 LIVA -> debe convertirse primero en factura)
  const pres = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "PRESUPUESTO",
    cliente_id: cli.data.id,
    lineas: [{ catalogo_id: prod.data.id, cantidad: "1", precio_usd: "40,00" }],
  });
  assert.equal(pres.status, 200);
  await reqJson(env, jar, `/api/documentos/${pres.data.id}/emitir`, "POST", {});
  const abonoBloqueado = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: pres.data.id,
    metodo: "PAGO_MOVIL",
    moneda: "BS",
    monto: "1000,00",
    tasa: "100,00",
    referencia: "123456",
  });
  assert.equal(abonoBloqueado.status, 409);
  assert.ok(String(abonoBloqueado.data.error || "").includes("presupuesto"));

  // Retrocompatibilidad histórica: si existía un abono heredado previo de presupuesto, anular la factura convertida sigue bloqueado
  await db
    .prepare(
      `INSERT INTO pagos (documento_id, modo, numero, metodo, moneda, monto_recibido, tasa_e8, monto_usd, saldo_despues_usd, referencia, fecha_pago, registrado_en, registrado_por, estado, reglas_json)
       VALUES (?, 'PRACTICA', 9901, 'PAGO_MOVIL', 'BS', 100000, 10000000000, 1000, 3000, 'LEGACY1', ?, ?, 1, 'VIGENTE', '{}')`
    )
    .bind(pres.data.id, new Date().toISOString().slice(0, 10), new Date().toISOString())
    .run();
  const conv = await reqJson(env, jar, `/api/documentos/${pres.data.id}/convertir`, "POST", {});
  assert.equal(conv.status, 200);
  const emFacConv = await reqJson(env, jar, `/api/documentos/${conv.data.id}/emitir`, "POST", {});
  assert.equal(emFacConv.status, 200);

  const anularConPagoPresupuesto = await reqJson(env, jar, `/api/documentos/${conv.data.id}/anular`, "POST", {
    motivo: "Intento de anular con abono previo",
  });
  assert.equal(anularConPagoPresupuesto.status, 409);
  assert.ok(String(anularConPagoPresupuesto.data.error || "").includes("pagos registrados"));
});

test("2. Sistema confirmo obligatorio en /correo y /imprenta, tipo_db PREFIJO sin binding y borrado D1 en reiniciar-fabrica", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-auditoria-2026" };
  const jar: Record<string, string> = {};
  await instalarBase(env, jar);

  // /api/sistema/correo sin campo confirmo debe rechazar con 400
  const correoSinCampo = await reqJson(env, jar, "/api/sistema/correo", "POST", {
    proveedor: "BREVO",
    remitente: "facturacion@ejemplo.test",
    nombre_remitente: "EMPRESA DEMO",
    clave: "xkeysib-secreto-1234",
    password: "ClavePruebaSegura2026!",
  });
  assert.equal(correoSinCampo.status, 400);

  // /api/sistema/imprenta sin campo confirmo debe rechazar con 400
  const imprentaSinCampo = await reqJson(env, jar, "/api/sistema/imprenta", "POST", {
    proveedor: "The Factory HKA",
    url: "https://demoemision.thefactoryhka.com.ve/api",
    usuario: "V123456781",
    clave: "token_imprenta_123",
    ambiente: "PRUEBAS",
    password: "ClavePruebaSegura2026!",
  });
  assert.equal(imprentaSinCampo.status, 400);

  // Alta sin API de Cloudflare ni binding dedicado -> tipo_db debe ser PREFIJO (y welcome HTML escapado)
  let ultimoHtml = "";
  const fetchOrig = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.brevo.com") || url.includes("api.resend.com")) {
        ultimoHtml = String(JSON.parse(String(init?.body || "{}")).htmlContent || "");
        return new Response(JSON.stringify({ messageId: "ok" }), { status: 201 });
      }
      return fetchOrig(input, init);
    }) as typeof fetch;

    const altaPref = await reqJson(env, jar, "/api/inquilinos", "POST", {
      nombre_negocio: `Empresa <Seguro> & "C.A."`,
      rif: "J-40998877-1",
      direccion: "Calle Principal 10, Distrito Capital",
      telefono: "0414-1112233",
      nombre_dueno: `Pedro <Admin>`,
      email_dueno: "pedro@seguro.com",
      correo_proveedor: "BREVO",
      correo_remitente: "facturacion@seguro.com",
      correo_clave: "xkeysib-prueba-segura",
    });
    assert.equal(altaPref.status, 200);
    assert.equal(altaPref.data.codigo, "DB_1");
    assert.ok(ultimoHtml.includes("&lt;Admin&gt;"));
    assert.ok(!ultimoHtml.includes("<Admin>"));
    assert.ok(ultimoHtml.includes("&lt;Seguro&gt;"));
  } finally {
    globalThis.fetch = fetchOrig;
  }

  const rowInq = await db.prepare(`SELECT tipo_db FROM _mt_inquilinos WHERE codigo = 'DB_1'`).first<{ tipo_db: string }>();
  assert.equal(rowInq?.tipo_db, "PREFIJO");

  // Simular inquilino secundario DB_2 respaldado por D1 remoto en Cloudflare y probar DELETE en /reiniciar-fabrica
  await migrar(db);
  await guardarConfigCloudflare(db, env, {
    account_id: "00000000000000000000000000000001",
    api_token: "cf_token_auditoria_9999",
    worker_name: "facturaya",
  });
  const remoteSql = crearBaseDatosD1(":memory:");
  await migrar(remoteSql);

  const uuidRemoto = "uuid-d1-remoto-db2";
  await db
    .prepare(
      `INSERT INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, d1_uuid, d1_nombre)
       VALUES ('DB_2', 'BINDING', 'Inquilino Remoto C.A.', 'J-40123456-7', 'Caracas', '0412-0001122', 'Ana', 'ana@remoto.com', ?, 'facturaya_db_2')`
    )
    .bind(uuidRemoto)
    .run();

  let d1DeleteLlamado = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if (url.endsWith(`/d1/database/${uuidRemoto}/query`) && method === "POST") {
      const payload = JSON.parse(String(init?.body || "{}"));
      if (Array.isArray(payload.batch)) {
        const res = await remoteSql.batch(
          payload.batch.map((q: { sql: string; params?: unknown[] }) => {
            const st = remoteSql.prepare(q.sql);
            return q.params?.length ? st.bind(...q.params) : st;
          })
        );
        return new Response(
          JSON.stringify({
            success: true,
            result: res.map((r) => ({ results: r.results ?? [], success: true, meta: r.meta ?? { changes: 0, last_row_id: 0 } })),
          }),
          { status: 200 }
        );
      }
      const st = remoteSql.prepare(payload.sql);
      const r = await (payload.params?.length ? st.bind(...payload.params) : st).all();
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ results: r.results ?? [], success: true, meta: r.meta ?? { changes: 0, last_row_id: 0 } }],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith(`/d1/database/${uuidRemoto}`) && method === "DELETE") {
      d1DeleteLlamado = true;
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }) as typeof fetch;

  try {
    const cambiar = await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "DB_2" });
    assert.equal(cambiar.status, 200);

    const reiniciar = await reqJson(env, jar, "/api/sistema/reiniciar-fabrica", "POST", {
      clave: "ClavePruebaSegura2026!",
      confirmo: true,
    });
    assert.equal(reiniciar.status, 200);
    assert.equal(reiniciar.data.regreso_a_principal, true);
    assert.equal(d1DeleteLlamado, true, "reiniciar-fabrica debe eliminar la base D1 remota en Cloudflare si tenía d1_uuid");
  } finally {
    globalThis.fetch = fetchOrig;
  }
});

test("3. Cookie inq huérfana/rota, restaurar con PREFIJO db1_, correo_nombre en Alta, rollback D1 y sync clave Súper Admin", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-auditoria-v2-2026" };
  const jar: Record<string, string> = {};
  await instalarBase(env, jar);

  // A) Crear inquilino DB_1 (PREFIJO) enviando correo_nombre (como lo envía public/app.js)
  const alta = await reqJson(env, jar, "/api/inquilinos", "POST", {
    nombre_negocio: "Comercial Prueba C.A.",
    rif: "J-40991122-3",
    direccion: "Caracas",
    telefono: "0414-2223344",
    nombre_dueno: "Luis Dueño",
    email_dueno: "luis@prueba.com",
    correo_proveedor: "BREVO",
    correo_remitente: "fact@prueba.com",
    correo_nombre: "Mi Remitente Custom",
    correo_clave: "xkeysib-prueba-custom",
    modo_inicial: "PRACTICA",
  });
  assert.equal(alta.status, 200);

  // Verificar que correo_nombre se preservó al cambiar a DB_1
  await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "DB_1" });
  const cfgCorreo = await reqJson(env, jar, "/api/sistema/correo");
  assert.equal(cfgCorreo.status, 200);
  assert.equal(cfgCorreo.data.nombre_remitente, "Mi Remitente Custom");

  // B) Verificar que /api/sistema/restaurar/estado permite restaurar tanto en principal como en DB_1 (PREFIJO db1_)
  const estRestDb1 = await reqJson(env, jar, "/api/sistema/restaurar/estado");
  assert.equal(estRestDb1.status, 200);
  assert.equal(estRestDb1.data.vacio, true, `No debe bloquear restauración en DB_1: ${JSON.stringify(estRestDb1.data.razones)}`);

  await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "principal" });
  const estRestPrin = await reqJson(env, jar, "/api/sistema/restaurar/estado");
  assert.equal(estRestPrin.status, 200);
  assert.equal(estRestPrin.data.vacio, true, `No debe bloquear restauración en principal por db1_: ${JSON.stringify(estRestPrin.data.razones)}`);

  // C) Sincronizar cambio de clave del Súper Admin hacia inquilinos existentes al usar /cambiar
  const camClave = await reqJson(env, jar, "/api/cuenta/clave", "POST", {
    actual: "ClavePruebaSegura2026!",
    nueva: "NuevaSuperClave2027!",
  });
  assert.equal(camClave.status, 200);
  await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "DB_1" });
  const hashPrin = await db.prepare(`SELECT password_hash FROM usuarios WHERE lower(email) = 'superadmin@ejemplo.test'`).first<{ password_hash: string }>();
  const hashDb1 = await db.prepare(`SELECT password_hash FROM db1_usuarios WHERE lower(email) = 'superadmin@ejemplo.test'`).first<{ password_hash: string }>();
  assert.equal(hashDb1?.password_hash, hashPrin?.password_hash);
  await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "principal" });

  // D) Cookie inq huérfana (DB_999) o tablas de DB_1 borradas externamente -> NO debe dar 500 sino autocurar a principal
  const jarHuerfano: Record<string, string> = { ...jar, inq: "DB_999" };
  const estInex = await reqJson(env, jarHuerfano, "/api/estado");
  assert.equal(estInex.status, 200);
  assert.equal(estInex.data.sesion, true);
  assert.equal(estInex.data.inquilino_actual, "principal");

  await db.prepare(`DROP TABLE IF EXISTS db1_sesiones`).run();
  await db.prepare(`DROP TABLE IF EXISTS db1_perfil_emisor`).run();
  const jarRoto: Record<string, string> = { ...jar, inq: "DB_1" };
  const estRoto = await reqJson(env, jarRoto, "/api/estado");
  assert.equal(estRoto.status, 200);
  assert.equal(estRoto.data.sesion, true);
  assert.equal(estRoto.data.inquilino_actual, "principal");

  // E) Rollback automático de D1 en Cloudflare si falla el batch inicial durante /api/inquilinos
  await guardarConfigCloudflare(db, env, {
    account_id: "00000000000000000000000000000001",
    api_token: "cf_token_rollback_test",
    worker_name: "facturaya",
  });
  const uuidNueva = "uuid-d1-fallo-rollback";
  let rollbackDeleteLlamado = false;
  const fetchOrig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if (url.includes("/d1/database") && !url.includes("/query") && method === "GET") {
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
    }
    if (url.endsWith("/d1/database") && method === "POST") {
      return new Response(JSON.stringify({ success: true, result: { uuid: uuidNueva, name: "facturaya_db_demo" } }), { status: 200 });
    }
    if (url.endsWith(`/d1/database/${uuidNueva}/query`) && method === "POST") {
      const payload = JSON.parse(String(init?.body || "{}"));
      // Simular que migrar() pasa, pero el batch inicial con perfil_emisor falla
      if (Array.isArray(payload.batch) && payload.batch.some((q: { sql: string }) => q.sql.includes("INSERT INTO perfil_emisor"))) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: "Fallo simulado en batch" }] }), { status: 500 });
      }
      if (Array.isArray(payload.batch)) {
        return new Response(
          JSON.stringify({
            success: true,
            result: payload.batch.map(() => ({ results: [], success: true, meta: { changes: 0, last_row_id: 0 } })),
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ success: true, result: [{ results: [], success: true, meta: { changes: 0 } }] }), { status: 200 });
    }
    if (url.endsWith(`/d1/database/${uuidNueva}`) && method === "DELETE") {
      rollbackDeleteLlamado = true;
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }) as typeof fetch;

  try {
    const altaFallida = await reqJson(env, jar, "/api/inquilinos", "POST", {
      nombre_negocio: "Fallo Rollback C.A.",
      rif: "J-40887766-1",
      direccion: "Caracas",
      telefono: "0414-8887766",
      nombre_dueno: "Carlos",
      email_dueno: "carlos@rollback.com",
    });
    assert.equal(altaFallida.status, 502);
    assert.equal(rollbackDeleteLlamado, true, "Debe eliminar la D1 recién creada en Cloudflare si falla el batch inicial");
  } finally {
    globalThis.fetch = fetchOrig;
  }
});

test("4. Auditoría v2: enviar-correo en REAL sin violar doc_inmutable, cifrado fallback TURNSTILE_SECRET_KEY, emisor histórico congelado, CONTADOR en restaurar y RIF normalizado", async () => {
  const { cifrarSecreto, descifrarSecreto } = await import("../src/cifrado");

  // 1) Fallback de descifrado cuando se cifró con TURNSTILE_SECRET_KEY y luego se agregó MASTER_KEY
  const envAntes = { TURNSTILE_SECRET_KEY: "ts-secret-original-999", PERMITIR_LLAVE_EN_BD: "1" }; // v4.2.1: sin MASTER_KEY solo se cifra con la bandera de desarrollo
  const envDespues = { MASTER_KEY: "nueva-master-key-2026", TURNSTILE_SECRET_KEY: "ts-secret-original-999" };
  const cifradoTs = await cifrarSecreto("xkeysib-clave-brevo-antigua", envAntes);
  const descifradoConMaster = await descifrarSecreto(cifradoTs, envDespues);
  assert.equal(descifradoConMaster, "xkeysib-clave-brevo-antigua", "Debe descifrar secretos cifrados con TURNSTILE_SECRET_KEY tras agregar MASTER_KEY");

  // 2) Restauración: preservar rol CONTADOR y limpiar medio_historial + _mt_directorio al cancelar
  const dbRest = crearBaseDatosD1(":memory:");
  const envRest: Record<string, unknown> = { DB: dbRest, MASTER_KEY: "llave-rest-2026" };
  const jarRest: Record<string, string> = {};
  await instalarBase(envRest, jarRest);

  const iniRest = await reqJson(envRest, jarRest, "/api/sistema/restaurar/iniciar", "POST", {
    clave: "ClavePruebaSegura2026!",
    manifiesto: { version: 2, modo_origen: "PRACTICA", conteos: {}, sumas: {} },
  });
  assert.equal(iniRest.status, 200);

  const loteUsr = await reqJson(envRest, jarRest, "/api/sistema/restaurar/lote", "POST", {
    tabla: "usuarios",
    filas: [{ id: 50, nombre: "María Contadora", email: "contador@ejemplo.test", rol: "CONTADOR", activo: 1 }],
  });
  assert.equal(loteUsr.status, 200);
  const usrRest = await dbRest.prepare(`SELECT rol FROM usuarios WHERE email = 'contador@ejemplo.test'`).first<{ rol: string }>();
  assert.equal(usrRest?.rol, "CONTADOR", "El rol CONTADOR debe conservarse al restaurar usuarios");
  const dirRest = await dbRest.prepare(`SELECT rol FROM _mt_directorio WHERE email = 'contador@ejemplo.test'`).first<{ rol: string }>();
  assert.equal(dirRest?.rol, "CONTADOR", "El usuario restaurado debe quedar en _mt_directorio");

  const loteHist = await reqJson(envRest, jarRest, "/api/sistema/restaurar/lote", "POST", {
    tabla: "medio_historial",
    filas: [{ id: 99, medio_anterior: "MAQUINA_FISCAL", medio_nuevo: "IMPRENTA_DIGITAL", motivo: "Cambio en respaldo", cambiado_por: 50 }],
  });
  assert.equal(loteHist.status, 200);

  const cancRest = await reqJson(envRest, jarRest, "/api/sistema/restaurar/cancelar", "POST", {});
  assert.equal(cancRest.status, 200);
  const histDespues = await dbRest.prepare(`SELECT COUNT(*) AS n FROM medio_historial WHERE motivo = 'Cambio en respaldo'`).first<{ n: number }>();
  assert.equal(histDespues?.n, 0, "Cancelar restauración debe limpiar medio_historial insertado durante el lote");
  const dirDespues = await dbRest.prepare(`SELECT COUNT(*) AS n FROM _mt_directorio WHERE email = 'contador@ejemplo.test'`).first<{ n: number }>();
  assert.equal(dirDespues?.n, 0, "Cancelar restauración debe limpiar correos creados en _mt_directorio");

  // 3) Normalización de RIF y Cédula en /api/clientes y /api/proveedores
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-auditoria-v4-2026" };
  const jar: Record<string, string> = {};
  await instalarBase(env, jar);
  await reqJson(env, jar, "/api/config", "PUT", { tasa_bcv: "100,00" });

  const cliSinGuion = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "J401122334",
    nombre_apellido: "Inversiones Los Andes C.A.",
  });
  assert.equal(cliSinGuion.status, 200);
  const cliDetalle = await reqJson(env, jar, `/api/clientes/${cliSinGuion.data.id}`);
  assert.equal(cliDetalle.data.cliente.rif_cedula, "J-40112233-4");

  const cliDuplicadoConGuion = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "J-40112233-4",
    nombre_apellido: "Inversiones Los Andes Duplicado",
  });
  assert.equal(cliDuplicadoConGuion.status, 409, "No debe permitir duplicar el mismo RIF con o sin guiones");

  const cliCedula = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "V12345678",
    nombre_apellido: "Persona Natural",
  });
  assert.equal(cliCedula.status, 200);
  const cliCedDetalle = await reqJson(env, jar, `/api/clientes/${cliCedula.data.id}`);
  assert.equal(cliCedDetalle.data.cliente.rif_cedula, "V-12345678");

  const provSinGuion = await reqJson(env, jar, "/api/proveedores", "POST", {
    rif: "J309988776",
    nombre: "Distribuidora Mayorista C.A.",
  });
  assert.equal(provSinGuion.status, 200);
  const provDetalle = await reqJson(env, jar, `/api/proveedores/${provSinGuion.data.id}`);
  assert.equal(provDetalle.data.proveedor.rif, "J-30998877-6");

  // 4) Resumen de documentos y pagos filtrados por modo activo (PRACTICA vs REAL)
  const prod = await reqJson(env, jar, "/api/catalogo", "POST", {
    tipo: "SERVICIO",
    nombre: "Soporte Técnico",
    precio_usd: "50,00",
    alicuota_iva: 16,
  });
  assert.equal(prod.status, 200);

  const facPractica = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cliSinGuion.data.id,
    lineas: [{ catalogo_id: prod.data.id, cantidad: "1", precio_usd: "50,00" }],
  });
  await reqJson(env, jar, `/api/documentos/${facPractica.data.id}/emitir`, "POST", {});

  // Salir en vivo a modo REAL
  const enVivo = await reqJson(env, jar, "/api/sistema/salir-en-vivo", "POST", {
    primer_factura: 1,
    primer_nota_credito: 1,
    primer_control: 1,
    primer_presupuesto: 1,
    primer_recibo: 1,
    confirmo: true,
  });
  assert.equal(enVivo.status, 200);

  // En modo REAL recién activado sin documentos reales, el resumen de documentos y pagos por cobrar debe ser 0
  const resDocsRealVacio = await reqJson(env, jar, "/api/documentos/resumen");
  assert.equal(resDocsRealVacio.data.total, 0, "En modo REAL no debe contar facturas de PRACTICA en ganancia del mes");
  const resPagosRealVacio = await reqJson(env, jar, "/api/pagos/resumen");
  assert.equal(resPagosRealVacio.data.por_cobrar_n, 0, "En modo REAL pagos/resumen no debe contar documentos de PRACTICA");

  // 5) Emitir factura REAL sin email de cliente y luego enviarla por correo con un email nuevo (no debe disparar doc_inmutable)
  const facReal = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cliSinGuion.data.id,
    lineas: [{ catalogo_id: prod.data.id, cantidad: "1", precio_usd: "50,00" }],
  });
  assert.equal(facReal.status, 200);
  const emReal = await reqJson(env, jar, `/api/documentos/${facReal.data.id}/emitir`, "POST", {});
  assert.equal(emReal.status, 200);

  await reqJson(env, jar, "/api/sistema/correo", "POST", {
    proveedor: "BREVO",
    remitente: "facturacion@ejemplo.test",
    nombre_remitente: "EMPRESA DEMO",
    clave: "xkeysib-correo-test",
    password: "ClavePruebaSegura2026!",
    confirmo: true,
  });

  const fetchOrig = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ messageId: "ok-123" }), { status: 201 })) as typeof fetch;
    const envCorreo = await reqJson(env, jar, `/api/documentos/${facReal.data.id}/enviar-correo`, "POST", {
      email: "administracion@losandes.com",
    });
    assert.equal(envCorreo.status, 200, `Enviar correo en factura REAL emitida no debe disparar doc_inmutable: ${JSON.stringify(envCorreo.data)}`);
  } finally {
    globalThis.fetch = fetchOrig;
  }

  const cliActualizado = await reqJson(env, jar, `/api/clientes/${cliSinGuion.data.id}`);
  assert.equal(cliActualizado.data.cliente.email, "administracion@losandes.com", "La ficha del cliente sí debe guardar el correo nuevo");

  // 6) Inmutabilidad histórica de emisor_json en facturas REALES emitidas cuando cambia perfil_emisor después
  await reqJson(env, jar, "/api/config", "PUT", {
    nombre_razon_social: "NUEVA RAZON SOCIAL FUTURA C.A.",
    rif: "V-12345678-1",
    direccion_fiscal: "Nueva Dirección Futura 2028",
    confirmo_fiscal: true,
  });
  const docCongelado = await reqJson(env, jar, `/api/documentos/${facReal.data.id}`);
  assert.equal(docCongelado.status, 200);
  const emisorSnapshot = JSON.parse(docCongelado.data.documento.emisor_json);
  assert.equal(emisorSnapshot.nombre_razon_social, "EMPRESA DEMO C.A.", "La factura REAL emitida debe conservar la razón social histórica del momento de emisión");
  assert.equal(emisorSnapshot.direccion_fiscal, "Caracas, Distrito Capital", "La factura REAL emitida debe conservar la dirección fiscal histórica");

  // 7) Cambio de clave del Súper Admin dentro de un inquilino secundario sincroniza también la base principal
  await reqJson(env, jar, "/api/inquilinos", "POST", {
    nombre_negocio: "Sucursal Sur C.A.",
    rif: "J-40776655-2",
    direccion: "Mérida",
    telefono: "0414-9998877",
    nombre_dueno: "Ana Sur",
    email_dueno: "ana@sur.com",
    modo_inicial: "PRACTICA",
  });
  await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "DB_1" });
  const cambioEnInq = await reqJson(env, jar, "/api/cuenta/clave", "POST", {
    actual: "ClavePruebaSegura2026!",
    nueva: "ClaveDesdeInquilino2026!",
  });
  assert.equal(cambioEnInq.status, 200);
  await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "principal" });
  const hashPrin = await db.prepare(`SELECT password_hash FROM usuarios WHERE lower(email) = 'superadmin@ejemplo.test'`).first<{ password_hash: string }>();
  const hashInq = await db.prepare(`SELECT password_hash FROM db1_usuarios WHERE lower(email) = 'superadmin@ejemplo.test'`).first<{ password_hash: string }>();
  assert.equal(hashPrin?.password_hash, hashInq?.password_hash, "Cambiar clave en DB_1 siendo Súper Admin debe actualizar también principal");
});

test("5. SENIAT Libros Contables v2: Retención de IVA (75%/100%), Declaración IGTF 3%, Ingresos Brutos Alcaldía y Corte X / Cierre Z de Caja", async () => {
  const { diagnosticarInquilino } = await import("../src/salud-bd");
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-seniat-v2-2026" };
  const jar: Record<string, string> = {};
  await instalarBase(env, jar);
  await reqJson(env, jar, "/api/config", "PUT", { tasa_bcv: "100,00" });
  const regEsp = await reqJson(env, jar, "/api/config/regimen", "PUT", {
    tipo_contribuyente: "ESPECIAL",
    clave_actual: "ClavePruebaSegura2026!",
    confirmo_regimen: true,
  });
  assert.equal(regEsp.status, 200);

  // Salir en vivo a modo REAL para probar inmutabilidad y libros reales
  const enVivo = await reqJson(env, jar, "/api/sistema/salir-en-vivo", "POST", {
    primer_factura: 1,
    primer_nota_credito: 1,
    primer_control: 1,
    primer_presupuesto: 1,
    primer_recibo: 1,
    confirmo: true,
  });
  assert.equal(enVivo.status, 200);

  const cli = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "J-29998877-0",
    nombre_apellido: "Corporación Especial C.A.",
  });
  assert.equal(cli.status, 200);

  const serv = await reqJson(env, jar, "/api/catalogo", "POST", {
    tipo: "SERVICIO",
    nombre: "Consultoría Cloud",
    precio_usd: "100,00",
    alicuota_iva: 16,
  });
  assert.equal(serv.status, 200);

  // 1) Emitir Factura N.º 1 con IGTF 3% ($100 base + $16 IVA + $3.48 IGTF = $119.48; a tasa 100 -> base 10.000 Bs, IVA 1.600 Bs, IGTF 348 Bs)
  const fac1 = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    aplica_igtf: true,
    lineas: [{ catalogo_id: serv.data.id, cantidad: "1", precio_usd: "100,00" }],
  });
  assert.equal(fac1.status, 200);
  const em1 = await reqJson(env, jar, `/api/documentos/${fac1.data.id}/emitir`, "POST", {});
  assert.equal(em1.status, 200);

  // 2) Validaciones de Retención de IVA (SNAT/2015/0049 y SNAT/2025/000054)
  const retSinComprobante14 = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: fac1.data.id,
    metodo: "RETENCION_IVA",
    moneda: "BS",
    monto: "1200,00",
    tasa: "100,00",
    comprobante_retencion: "12345",
  });
  assert.equal(retSinComprobante14.status, 400, "Debe exigir comprobante SENIAT de 14 dígitos (AAAAMMSSSSSSSS)");

  const retMayorAlIva = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: fac1.data.id,
    metodo: "RETENCION_IVA",
    moneda: "BS",
    monto: "1700,00",
    tasa: "100,00",
    comprobante_retencion: "20261100000001",
  });
  assert.equal(retMayorAlIva.status, 400, "No debe permitir retener más del 100% del IVA facturado");

  // Registrar Retención del 75% del IVA (75% de 1.600,00 Bs = 1.200,00 Bs = $12.00)
  const ret75 = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: fac1.data.id,
    metodo: "RETENCION_IVA",
    moneda: "BS",
    monto: "1200,00",
    tasa: "100,00",
    comprobante_retencion: "20261100000001",
  });
  assert.equal(ret75.status, 200);

  // Impedir duplicar el mismo comprobante de retención en la misma factura
  const retDuplicado = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: fac1.data.id,
    metodo: "RETENCION_IVA",
    moneda: "BS",
    monto: "100,00",
    tasa: "100,00",
    comprobante_retencion: "20261100000001",
  });
  assert.equal(retDuplicado.status, 409, "No debe permitir registrar dos veces el mismo comprobante de retención");

  // Impedir una segunda retención que supere el IVA remanente disponible (quedan 400 Bs de IVA, intentar 500 Bs)
  const retExcesoAcumulado = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: fac1.data.id,
    metodo: "RETENCION_IVA",
    moneda: "BS",
    monto: "500,00",
    tasa: "100,00",
    comprobante_retencion: "20261100000002",
  });
  assert.equal(retExcesoAcumulado.status, 400, "No debe permitir que la suma de retenciones supere el 100% del IVA neto de la factura");

  // Registrar cobro del resto en Zelle ($107.48 USD)
  const cobroZelle = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: fac1.data.id,
    metodo: "ZELLE",
    moneda: "USD",
    monto: "107,48",
    referencia: "ZELLE-998877",
  });
  assert.equal(cobroZelle.status, 200);

  // Verificar que el trigger pago_inmutable protege comprobante_retencion en modo REAL
  await assert.rejects(
    async () => {
      await db.prepare(`UPDATE pagos SET comprobante_retencion = '20261199999999' WHERE id = ?`).bind(ret75.data.id).run();
    },
    /no se puede modificar/i,
    "El trigger pago_inmutable debe impedir alterar comprobante_retencion en modo REAL"
  );

  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  // 3) Libro de Ventas (Art. 72 RLIVA) incluye comprobante_retencion e iva_retenido_bs
  const libroVentas = await reqJson(env, jar, `/api/informes/ventas?desde=${hoy}&hasta=${hoy}`);
  assert.equal(libroVentas.status, 200);
  assert.equal(libroVentas.data.iva_retenido_bs, 120000);
  assert.equal(libroVentas.data.filas[0].comprobante_retencion, "20261100000001");
  assert.equal(libroVentas.data.filas[0].iva_retenido_bs, 120000);

  // 4) Resumen mensual de IVA y Alcaldía incluye retenciones_bs, cuota_tributaria_bs e ingresos_brutos_bs
  const resumenIva = await reqJson(env, jar, `/api/informes/resumen-iva?desde=${hoy}&hasta=${hoy}`);
  assert.equal(resumenIva.status, 200);
  assert.equal(resumenIva.data.total.debito_bs, 160000);
  assert.equal(resumenIva.data.total.retenciones_bs, 120000);
  assert.equal(resumenIva.data.total.cuota_tributaria_bs, 40000, "Cuota tributaria neta = Débito (1.600 Bs) - Retención 75% (1.200 Bs) = 400 Bs");
  assert.equal(resumenIva.data.total.ingresos_brutos_bs, 1000000, "Ingresos brutos municipales = Base imponible sin IVA ni IGTF (10.000 Bs)");
  assert.equal(resumenIva.data.total.ingresos_brutos_usd, 10000);

  // 5) Declaración de IGTF 3% (SNAT/2022/000013)
  const infIgtf = await reqJson(env, jar, `/api/informes/igtf?desde=${hoy}&hasta=${hoy}`);
  assert.equal(infIgtf.status, 200);
  assert.equal(infIgtf.data.n_documentos, 1);
  assert.equal(infIgtf.data.igtf_bs, 34800);
  assert.equal(infIgtf.data.igtf_usd, 348);

  // 6) Corte X y Cierre Diario Z de Caja
  const cierreCaja = await reqJson(env, jar, `/api/informes/cierre-caja?desde=${hoy}&hasta=${hoy}`);
  assert.equal(cierreCaja.status, 200);
  assert.equal(cierreCaja.data.numeracion.factura_desde, 1);
  assert.equal(cierreCaja.data.numeracion.factura_hasta, 1);
  assert.equal(cierreCaja.data.numeracion.recibo_desde, 1);
  assert.equal(cierreCaja.data.numeracion.recibo_hasta, 2);
  assert.equal(cierreCaja.data.recaudacion.retenciones_iva_bs, 120000);
  assert.equal(cierreCaja.data.recaudacion.cobrado_divisas_usd, 10748);
  assert.equal(cierreCaja.data.recaudacion.total_equiv_usd, 11948);

  // 7) Salud de BD: 16/16 triggers OK y 15/15 migraciones OK
  const diag = await diagnosticarInquilino(db, env, { codigo: "principal", nombre_negocio: "EMPRESA DEMO C.A.", rif: "V-12345678-1" });
  assert.equal(diag.sano, true, `Diagnóstico debe ser sano: ${JSON.stringify(diag.problemas)}`);
  assert.equal(diag.triggers_ok, true);
  assert.equal(diag.migraciones_ok, true);
  assert.equal(diag.problemas.length, 0);
});

test("6. Paquete v3.4: Tasa BCV Centralizada (Auto vs Manual), Notas de Débito (ND-00000001), Retención ISLR (Decreto 1.808), Correo de Recibo y Cierre Mensual Automático/Manual", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-v34-2026" };
  const jar: Record<string, string> = {};
  await instalarBase(env, jar);

  // Configurar correo Brevo en principal
  await reqJson(env, jar, "/api/sistema/correo", "POST", {
    proveedor: "BREVO",
    remitente: "facturacion@ejemplo.test",
    nombre_remitente: "EMPRESA DEMO",
    clave: "xkeysib-v34-key",
    password: "ClavePruebaSegura2026!",
    confirmo: true,
  });

  // Crear dos inquilinos: DB_1 (quedará en AUTOMATICO) y DB_2 (pasará a MANUAL con tasa 95,00)
  await reqJson(env, jar, "/api/inquilinos", "POST", {
    nombre_negocio: "Inquilino Auto C.A.",
    rif: "J-40111111-1",
    direccion: "Caracas",
    telefono: "0414-1111111",
    nombre_dueno: "Auto Admin",
    email_dueno: "auto@empresa.com",
    modo_inicial: "PRACTICA",
  });
  await reqJson(env, jar, "/api/inquilinos", "POST", {
    nombre_negocio: "Inquilino Manual C.A.",
    rif: "J-40222222-2",
    direccion: "Valencia",
    telefono: "0414-2222222",
    nombre_dueno: "Manual Admin",
    email_dueno: "manual@empresa.com",
    modo_inicial: "PRACTICA",
  });

  await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "DB_2" });
  const cfgManual = await reqJson(env, jar, "/api/config", "PUT", {
    tasa_bcv_modo: "MANUAL",
    tasa_bcv: "95,00",
  });
  assert.equal(cfgManual.status, 200);
  await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "principal" });

  // 1) Sincronizar Tasa BCV Centralizada: 1 sola consulta externa replica a principal y DB_1 (AUTOMATICO), pero respeta DB_2 (MANUAL = 95,00)
  let llamadasBcvExternas = 0;
  let ultimoCorreoPayload: any = null;
  const fetchOrig = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("dolarapi.com")) {
        llamadasBcvExternas++;
        return new Response(JSON.stringify({ promedio: 78.45, fechaActualizacion: "2026-11-16T12:00:00.000Z" }), { status: 200 });
      }
      if (url.includes("api.brevo.com")) {
        ultimoCorreoPayload = JSON.parse(String(init?.body || "{}"));
        return new Response(JSON.stringify({ messageId: "msg-v34" }), { status: 201 });
      }
      return fetchOrig(input, init);
    }) as typeof fetch;

    const syncRes = await reqJson(env, jar, "/api/sistema/tasa-bcv/sincronizar", "POST", {});
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.data.tasa_bcv, "78.45");
    assert.equal(llamadasBcvExternas, 1, "Debe realizar 1 sola consulta externa al BCV");

    // En v5.0.0 las demás empresas en AUTOMATICO heredan la tasa global de forma perezosa en /api/estado (sin bucle N-empresas)
    await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "DB_1" });
    await reqJson(env, jar, "/api/estado");
    await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "DB_2" });
    await reqJson(env, jar, "/api/estado");
    await reqJson(env, jar, "/api/inquilinos/cambiar", "POST", { codigo: "principal" });
    assert.equal(llamadasBcvExternas, 1, "La herencia perezosa no debe realizar nuevas llamadas externas al BCV");

    const filaPrin = await db.prepare(`SELECT tasa_bcv, tasa_bcv_modo FROM perfil_emisor WHERE id = 1`).first<{ tasa_bcv: number | string; tasa_bcv_modo: string }>();
    const filaDb1 = await db.prepare(`SELECT tasa_bcv, tasa_bcv_modo FROM db1_perfil_emisor WHERE id = 1`).first<{ tasa_bcv: number | string; tasa_bcv_modo: string }>();
    const filaDb2 = await db.prepare(`SELECT tasa_bcv, tasa_bcv_modo FROM db2_perfil_emisor WHERE id = 1`).first<{ tasa_bcv: number | string; tasa_bcv_modo: string }>();
    assert.equal(String(filaPrin?.tasa_bcv), "78.45");
    assert.equal(String(filaDb1?.tasa_bcv), "78.45", "DB_1 en modo AUTOMATICO debe recibir la tasa 78.45");
    assert.equal(String(filaDb2?.tasa_bcv), "95", "DB_2 en modo MANUAL debe preservar su tasa manual de 95");

    // Fijar tasa 100,00 en modo MANUAL en principal para pruebas exactas de centavos en ND e ISLR
    await reqJson(env, jar, "/api/config", "PUT", { tasa_bcv_modo: "MANUAL", tasa_bcv: "100,00" });

    // Salir en vivo a modo REAL incluyendo primer_nota_debito
    const enVivo = await reqJson(env, jar, "/api/sistema/salir-en-vivo", "POST", {
      primer_factura: 1,
      primer_nota_credito: 1,
      primer_nota_debito: 1,
      primer_control: 1,
      primer_presupuesto: 1,
      primer_recibo: 1,
      confirmo: true,
    });
    assert.equal(enVivo.status, 200);

    const cli = await reqJson(env, jar, "/api/clientes", "POST", {
      rif_cedula: "J-31223344-5",
      nombre_apellido: " Constructora Andina C.A.",
      email: "pagos@constructora.com",
    });
    assert.equal(cli.status, 200);

    const srv = await reqJson(env, jar, "/api/catalogo", "POST", {
      tipo: "SERVICIO",
      nombre: "Proyecto Redes Fibra",
      precio_usd: "200,00",
      alicuota_iva: 16,
    });
    assert.equal(srv.status, 200);

    // Emitir Factura N.º 1 ($200 base + $32 IVA = $232.00; Bs 20.000 base + Bs 3.200 IVA = Bs 23.200)
    const fac = await reqJson(env, jar, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ catalogo_id: srv.data.id, cantidad: "1", precio_usd: "200,00" }],
    });
    await reqJson(env, jar, `/api/documentos/${fac.data.id}/emitir`, "POST", {});

    // 2) Emitir Nota de Débito ND-00000001 sobre Factura N.º 1 por $50 base + 16% IVA ($58 total = Bs 5.800)
    const nd = await reqJson(env, jar, `/api/documentos/${fac.data.id}/nota-debito`, "POST", {
      motivo: "Recargo por flete especial fuera de ruta",
      aplica_igtf: false,
      lineas: [{ descripcion: "Flete especial adicional", cantidad: "1", precio_usd: "50,00", alicuota_iva: 16 }],
    });
    assert.equal(nd.status, 200, `Emisión de ND debe responder 200: ${JSON.stringify(nd.data)}`);
    assert.equal(nd.data.numero, 1);
    assert.equal(nd.data.total_usd, 5800);

    // Verificar que la Factura original lista la ND vinculada y que la ND aparece en Cuentas por Cobrar
    const detFac = await reqJson(env, jar, `/api/documentos/${fac.data.id}`);
    assert.equal(detFac.data.notas_debito.length, 1);
    assert.equal(detFac.data.notas_debito[0].id, nd.data.id);

    const porCobrar = await reqJson(env, jar, "/api/pagos/por-cobrar");
    assert.equal(porCobrar.data.facturas.length, 2, "Tanto la Factura como la Nota de Débito deben estar por cobrar");
    assert.ok(porCobrar.data.facturas.some((f: any) => f.id === nd.data.id && f.es_nota_debito === 1));

    // 3) Registrar Retención de ISLR (Decreto 1.808 — 2% de la base imponible sin IVA de la Factura = 2% de Bs 20.000 = Bs 400,00 = $4.00)
    const pagoIslr = await reqJson(env, jar, "/api/pagos", "POST", {
      documento_id: fac.data.id,
      metodo: "RETENCION_ISLR",
      moneda: "BS",
      monto: "400,00",
      tasa: "100,00",
      comprobante_retencion: "ISLR-202611-001",
      porcentaje_retencion: 2,
    });
    assert.equal(pagoIslr.status, 200, `Pago con RETENCION_ISLR debe responder 200: ${JSON.stringify(pagoIslr.data)}`);

    const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

    // Verificar reporte GET /api/informes/islr
    const repIslr = await reqJson(env, jar, `/api/informes/islr?desde=${hoy}&hasta=${hoy}`);
    assert.equal(repIslr.status, 200);
    assert.equal(repIslr.data.n_retenciones, 1);
    assert.equal(repIslr.data.total_retenido_bs, 40000);
    assert.equal(repIslr.data.filas[0].porcentaje_retencion, 2);
    assert.equal(repIslr.data.filas[0].comprobante_retencion, "ISLR-202611-001");

    // Verificar que Libro de Ventas suma Factura ($200 base) + Nota de Débito ($50 base) = $250 base (Bs 25.000)
    const repVentas = await reqJson(env, jar, `/api/informes/ventas?desde=${hoy}&hasta=${hoy}`);
    assert.equal(repVentas.status, 200);
    assert.equal(repVentas.data.n_notas_debito, 1);
    assert.equal(repVentas.data.total_bs, 2900000, "Libro de Ventas debe sumar Factura (23.200 Bs) + ND (5.800 Bs) = 29.000,00 Bs");

    // 4) Enviar recibo de pago por correo con PDF adjunto
    ultimoCorreoPayload = null;
    const envRecibo = await reqJson(env, jar, `/api/pagos/${pagoIslr.data.id}/enviar-correo`, "POST", {
      email: "pagos@constructora.com",
      pdf_base64: Buffer.from("%PDF-1.4 recibo prueba").toString("base64"),
      nombre_archivo: "Recibo-00000001.pdf",
    });
    assert.equal(envRecibo.status, 200);
    assert.ok(ultimoCorreoPayload);
    assert.equal(ultimoCorreoPayload.attachment?.[0]?.name, "Recibo-00000001.pdf");

    // 5) Enviar Cierre Contable Mensual por correo con los 4 CSV adjuntos
    ultimoCorreoPayload = null;
    const mesActual = hoy.slice(0, 7);
    const envCierre = await reqJson(env, jar, "/api/informes/enviar-cierre", "POST", {
      mes: mesActual,
      email: "contador@ejemplo.test",
    });
    assert.equal(envCierre.status, 200, `Envío de cierre contable debe responder 200: ${JSON.stringify(envCierre.data)}`);
    assert.ok(ultimoCorreoPayload);
    assert.equal(ultimoCorreoPayload.attachment?.length, 4, "El cierre contable mensual debe adjuntar los 4 libros en CSV");
  } finally {
    globalThis.fetch = fetchOrig;
  }
});

test("7. Paquete v3.4.1: ISLR 1..34% estricto, CSV seguro con ; y prefijo ND-, cierre mensual atómico concurrente, primer_nota_debito, migración inquilino y salud pago_inmutable", async () => {
  const { diagnosticarInquilino, repararInquilino } = await import("../src/salud-bd");
  const { intentarCierreMensualAutomatico } = await import("../src/tasa-bcv");
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-v341-2026" };
  const jar: Record<string, string> = {};
  await instalarBase(env, jar);

  await reqJson(env, jar, "/api/config", "PUT", { tasa_bcv_modo: "MANUAL", tasa_bcv: "100,00" });
  await reqJson(env, jar, "/api/sistema/salir-en-vivo", "POST", {
    primer_factura: 1,
    primer_nota_credito: 1,
    primer_nota_debito: 1,
    primer_control: 1,
    primer_presupuesto: 1,
    primer_recibo: 1,
    confirmo: true,
  });

  // 1) Cliente con fórmula peligrosa en nombre para verificar neutralización CSV
  const cli = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "J-40556677-8",
    nombre_apellido: "=SUM(A1:A2) Distribuidora C.A.",
    email: "cli@distribuidora.com",
  });
  assert.equal(cli.status, 200);

  const srv = await reqJson(env, jar, "/api/catalogo", "POST", {
    tipo: "SERVICIO",
    nombre: "Honorarios Profesionales",
    precio_usd: "100,00",
    alicuota_iva: 16,
  });
  assert.equal(srv.status, 200);

  // Emitir Factura N.º 1 ($100 base + $16 IVA = Bs 11.600) y Nota de Débito ND-00000001 ($50 base + $8 IVA = Bs 5.800)
  const fac = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    lineas: [{ catalogo_id: srv.data.id, cantidad: "1", precio_usd: "100,00" }],
  });
  assert.equal(fac.status, 200);
  await reqJson(env, jar, `/api/documentos/${fac.data.id}/emitir`, "POST", {});

  const nd = await reqJson(env, jar, `/api/documentos/${fac.data.id}/nota-debito`, "POST", {
    motivo: "Ajuste por honorarios adicionales",
    lineas: [{ descripcion: "Ajuste servicio", cantidad: "1", precio_usd: "50,00", alicuota_iva: 16 }],
  });
  assert.equal(nd.status, 200);
  assert.equal(nd.data.numero, 1);

  // 2) Validación estricta ISLR 1..34% (rechaza 0, 35, decimales y omitido; acepta 15% y 34%)
  for (const pctMalo of [0, 35, 2.5, undefined]) {
    const malo = await reqJson(env, jar, "/api/pagos", "POST", {
      documento_id: fac.data.id,
      metodo: "RETENCION_ISLR",
      moneda: "BS",
      monto: "100,00",
      tasa: "100,00",
      comprobante_retencion: "ISLR-BAD-001",
      ...(pctMalo === undefined ? {} : { porcentaje_retencion: pctMalo }),
    });
    assert.equal(malo.status, 400, `porcentaje_retencion=${String(pctMalo)} debe ser rechazado con 400`);
  }

  // Exceder el porcentaje declarado (ej. declarar 15% sobre Bs 10.000 = máx Bs 1.500, intentar Bs 2.000) -> 400
  const islrExceso = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: fac.data.id,
    metodo: "RETENCION_ISLR",
    moneda: "BS",
    monto: "2000,00",
    tasa: "100,00",
    comprobante_retencion: "ISLR-202611-EX",
    porcentaje_retencion: 15,
  });
  assert.equal(islrExceso.status, 400);

  // Registrar 15% sobre Factura N.º 1 (15% de Bs 10.000 = Bs 1.500,00) y 34% sobre ND-00000001 (34% de Bs 5.000 = Bs 1.700,00)
  const islr15 = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: fac.data.id,
    metodo: "RETENCION_ISLR",
    moneda: "BS",
    monto: "1500,00",
    tasa: "100,00",
    comprobante_retencion: "ISLR-202611-15",
    porcentaje_retencion: 15,
  });
  assert.equal(islr15.status, 200);

  const islr34Nd = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: nd.data.id,
    metodo: "RETENCION_ISLR",
    moneda: "BS",
    monto: "1700,00",
    tasa: "100,00",
    comprobante_retencion: "ISLR-202611-34",
    porcentaje_retencion: 34,
  });
  assert.equal(islr34Nd.status, 200);

  // 3) Cierre mensual: verificar CSV con `;`, sanitización de `=SUM(...)`, prefijo `ND-00000001`, e idempotencia atómica concurrente
  await reqJson(env, jar, "/api/sistema/correo", "POST", {
    proveedor: "BREVO",
    remitente: "facturacion@ejemplo.test",
    nombre_remitente: "EMPRESA DEMO",
    clave: "xkeysib-v341-key",
    password: "ClavePruebaSegura2026!",
    confirmo: true,
  });

  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const mesActual = hoy.slice(0, 7);
  const envStr = env as Record<string, string>;
  const fetchOrig = globalThis.fetch;
  let enviosBrevo = 0;
  let adjuntosCapturados: { name: string; content: string }[] = [];

  try {
    // 3a) Si Brevo falla, intentarCierreMensualAutomatico debe devolver false y revertir ultimo_cierre_correo para reintentar luego
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "error" }), { status: 500 })) as typeof fetch;
    const falloAuto = await intentarCierreMensualAutomatico(db, envStr, mesActual);
    assert.equal(falloAuto, false);
    const pTrasFallo = await db.prepare(`SELECT ultimo_cierre_correo FROM perfil_emisor WHERE id = 1`).first<{ ultimo_cierre_correo: string | null }>();
    assert.equal(pTrasFallo?.ultimo_cierre_correo ?? null, null);

    // 3b) Dos ejecuciones concurrentes de intentarCierreMensualAutomatico solo envían UN cierre mensual
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      enviosBrevo++;
      const payload = JSON.parse(String(init?.body || "{}"));
      if (Array.isArray(payload.attachment)) adjuntosCapturados = payload.attachment;
      return new Response(JSON.stringify({ messageId: `msg-${enviosBrevo}` }), { status: 201 });
    }) as typeof fetch;

    const [c1, c2] = await Promise.all([
      intentarCierreMensualAutomatico(db, envStr, mesActual),
      intentarCierreMensualAutomatico(db, envStr, mesActual),
    ]);
    assert.deepEqual([c1, c2].sort(), [false, true], "Solo una ejecución concurrente debe reclamar el cierre mensual");
    assert.equal(enviosBrevo, 1);

    const decodeCsv = (name: string) => {
      const f = adjuntosCapturados.find((a) => a.name.startsWith(name));
      assert.ok(f, `Falta adjunto ${name}`);
      return Buffer.from(f.content, "base64").toString("utf-8");
    };
    const csvVentas = decodeCsv("Libro-Ventas-");
    const csvRet = decodeCsv("Retenciones-IVA-ISLR-");
    assert.ok(csvVentas.includes(";"), "CSV debe usar separador ';' para Excel en español");
    assert.ok(csvVentas.includes("'=SUM(A1:A2) Distribuidora C.A."), "CSV debe neutralizar fórmulas que empiezan por =");
    assert.ok(csvRet.includes("ND-00000001"), "CSV de retenciones debe prefijar ND- cuando proviene de Nota de Débito");
  } finally {
    globalThis.fetch = fetchOrig;
  }

  // 4) primer_nota_debito en Alta Multi-Tenant
  const badAltaNd = await reqJson(env, jar, "/api/inquilinos", "POST", {
    nombre_negocio: "Inquilino Malo ND C.A.",
    rif: "J-40123123-0",
    direccion: "Caracas",
    telefono: "0414-0000000",
    nombre_dueno: "Pedro",
    email_dueno: "malond@empresa.com",
    primer_nota_debito: 0,
  });
  assert.equal(badAltaNd.status, 400);

  const altaNd = await reqJson(env, jar, "/api/inquilinos", "POST", {
    nombre_negocio: "Inquilino Con ND C.A.",
    rif: "J-40889900-1",
    direccion: "Caracas",
    telefono: "0414-7776655",
    nombre_dueno: "Laura",
    email_dueno: "laura@empresa.com",
    primer_nota_debito: 12,
    modo_inicial: "REAL",
  });
  assert.equal(altaNd.status, 200);
  assert.equal(altaNd.data.correlativos_iniciales.primer_nota_debito, 12);
  const contNd = await db.prepare(`SELECT valor FROM db1_contadores WHERE clave = 'NOTA_DEBITO:REAL'`).first<{ valor: number }>();
  assert.equal(contNd?.valor, 11);

  // 5) Middleware auto-migra dbInq si una base dedicada iba por migración 0014 al desplegar nueva versión con 0015
  const { MIGRACIONES } = await import("../src/migraciones");
  const dbInqAntigua = crearBaseDatosD1(":memory:");
  await dbInqAntigua.prepare(`CREATE TABLE IF NOT EXISTS _migraciones (id TEXT PRIMARY KEY, aplicada_en TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  for (const m of MIGRACIONES.filter((x) => x.id !== "0015_paquete_v3_4")) {
    await dbInqAntigua.batch([...m.sql.map((s) => dbInqAntigua.prepare(s)), dbInqAntigua.prepare(`INSERT INTO _migraciones (id) VALUES (?)`).bind(m.id)]);
  }
  await dbInqAntigua.prepare(`INSERT INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv) VALUES (1, 1, 'Inquilino Antiguo C.A.', 'J-40000099-9', 'Caracas', 100)`).run();
  await db.prepare(
    `INSERT INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, activo)
     VALUES ('DB_9', 'BINDING', 'Inquilino Antiguo C.A.', 'J-40000099-9', 'Caracas', '0414-0000099', 'Dueño Antiguo', 'antiguo@empresa.com', 1)`
  ).run();
  const superOrig = await db.prepare(`SELECT nombre, email, password_hash, codigo_recuperacion_hash FROM usuarios WHERE lower(email) = 'superadmin@ejemplo.test'`).first<any>();
  await dbInqAntigua.prepare(
    `INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave, codigo_recuperacion_hash)
     VALUES (?, ?, ?, 'SUPER_ADMIN', 1, 0, ?)`
  ).bind(superOrig.nombre, superOrig.email, superOrig.password_hash, superOrig.codigo_recuperacion_hash).run();
  const uAnt = await dbInqAntigua.prepare(`SELECT id FROM usuarios WHERE lower(email) = 'superadmin@ejemplo.test'`).first<{ id: number }>();
  const { sha256 } = await import("../src/seguridad");
  await dbInqAntigua.prepare(`INSERT INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)`).bind(await sha256(jar.sid), uAnt!.id, Math.floor(Date.now() / 1000) + 3600).run();

  const envUpgrade: Record<string, unknown> = { ...env, DB_9: dbInqAntigua };
  const jarDb9: Record<string, string> = { ...jar, inq: "DB_9" };
  const estDb9 = await reqJson(envUpgrade, jarDb9, "/api/estado");
  assert.equal(estDb9.status, 200);
  assert.equal(estDb9.data.negocio?.nombre_razon_social, "Inquilino Antiguo C.A.", "Middleware debe migrar DB_9 antes de consultar columnas de 0015");
  assert.equal(estDb9.data.negocio?.tasa_bcv_modo, "AUTOMATICO");
  const migDb9 = await dbInqAntigua.prepare(`SELECT 1 AS ok FROM _migraciones WHERE id = '0015_paquete_v3_4'`).first<{ ok: number }>();
  assert.equal(migDb9?.ok, 1);

  // 6) salud-bd detecta y repara pago_inmutable legado (sin es_retencion_islr)
  await migrar(db);
  await db.prepare(`DROP TRIGGER IF EXISTS pago_inmutable`).run();
  await db
    .prepare(
      `CREATE TRIGGER pago_inmutable BEFORE UPDATE ON pagos WHEN old.modo = 'REAL' AND old.estado <> 'ANULADO'
       BEGIN SELECT RAISE(ABORT, 'Trigger legado sin ISLR'); END`
    )
    .run();
  const diagLegado = await diagnosticarInquilino(db, env, { codigo: "principal", nombre_negocio: "EMPRESA DEMO", rif: "V-12345678-1" });
  assert.equal(diagLegado.sano, false);
  assert.ok(diagLegado.triggers_faltantes.includes("pago_inmutable"), "Debe detectar pago_inmutable legado sin soporte ISLR/motivo");

  const rep = await repararInquilino(db, env, "principal");
  assert.equal(rep.diagnostico.sano, true);
  assert.equal(rep.diagnostico.triggers_ok, true);
  await assert.rejects(
    async () => {
      await db.prepare(`UPDATE pagos SET es_retencion_islr = 0 WHERE id = ?`).bind(islr15.data.id).run();
    },
    /no se puede modificar/i,
    "El trigger pago_inmutable reparado debe proteger es_retencion_islr"
  );
});





