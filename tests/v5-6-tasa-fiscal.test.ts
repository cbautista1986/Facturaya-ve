import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { migrar } from "../src/migraciones";
import { asegurarTablasMultiTenant, registrarCorreoDirectorio } from "../src/inquilinos";
import { asegurarTablaLimitesRed } from "../src/seguridad-red";
import { hashClave } from "../src/seguridad";
import { fechaCaracas } from "../src/comun";
import { estadoSemaforoTasaBcv } from "../public/dinero.js";

const MASTER_KEY = "ClaveMaestraTestTasaFiscalV560!!";
const SUPER_EMAIL = "super@tasafiscal.test";
const PASS = "ClaveSegura2026!";

function diaAnteriorIso(iso: string, dias: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - dias));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

async function reqApi(
  env: Record<string, unknown>,
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {}
) {
  const headers: Record<string, string> = {};
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
  const json = (await res.json().catch(() => null)) as Record<string, any> | null;
  return { status: res.status, json, headers: res.headers };
}

async function loginComo(env: Record<string, unknown>, email: string): Promise<string> {
  const r = await reqApi(env, "/api/login", { method: "POST", body: { email, clave: PASS } });
  assert.equal(r.status, 200, `Login falló: ${JSON.stringify(r.json)}`);
  const setCookies = r.headers.getSetCookie?.() || [r.headers.get("set-cookie") || ""];
  return setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

test("v5.6 Semáforo Tasa BCV (dinero.js): hoy, vencida, fin de semana, feriado bancario y sin publicación", () => {
  // Miércoles 2026-11-18 14:00 VET (18:00 UTC)
  const miercoles = Date.UTC(2026, 10, 18, 18, 0, 0);
  assert.equal(estadoSemaforoTasaBcv(50, "2026-11-18", miercoles).estado, "verde");
  assert.equal(estadoSemaforoTasaBcv(50, "2026-11-16", miercoles).estado, "rojo");

  // Sábado 2026-11-21 con tasa del viernes 2026-11-20 -> amarillo (válido, no rojo)
  const sabado = Date.UTC(2026, 10, 21, 16, 0, 0);
  assert.equal(estadoSemaforoTasaBcv(50, "2026-11-20", sabado).estado, "amarillo");
  assert.equal(estadoSemaforoTasaBcv(50, "2026-11-18", sabado).estado, "rojo");

  // Lunes feriado 2026-11-23 con tasa del viernes 2026-11-20 -> amarillo (válido) si está marcado feriado
  const lunes = Date.UTC(2026, 10, 23, 16, 0, 0);
  assert.equal(estadoSemaforoTasaBcv(50, "2026-11-20", lunes).estado, "rojo");
  assert.equal(estadoSemaforoTasaBcv(50, "2026-11-20", lunes, { feriados: ["2026-11-23"] }).estado, "amarillo");

  // Día hábil con sinPublicacionHoy -> acepta tasa del día hábil anterior (amarillo, no rojo)
  assert.equal(estadoSemaforoTasaBcv(50, "2026-11-17", miercoles, { sinPublicacionHoy: "2026-11-18" }).estado, "amarillo");
});

test("v5.6 Bloqueo Tasa Vencida en Modo REAL: 409 en factura/NC/ND/pago Bs, override auditado solo ADMIN, permitido en PRACTICA y feriado", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = {
    DB: db,
    MASTER_KEY,
    SUPER_ADMIN_EMAIL: SUPER_EMAIL,
  };
  await migrar(db);
  await asegurarTablasMultiTenant(db);
  await asegurarTablaLimitesRed(db);

  const hoy = fechaCaracas();
  const vieja = diaAnteriorIso(hoy, 6);

  await db.batch([
    db.prepare(
      `INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv, tasa_bcv_fecha, tasa_bcv_modo, medio_facturacion, tipo_contribuyente, igtf_activo)
       VALUES (1, 1, 'Comercial Fiscal C.A.', 'J-33333333-3', 'Caracas', 50, ?, 'MANUAL', 'APP_SENIAT', 'ORDINARIO', 0)`
    ).bind(hoy),
    db.prepare(`INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('modo', 'REAL')`),
  ]);

  const hash = await hashClave(PASS, env);
  for (const [rol, email] of [
    ["SUPER_ADMIN", SUPER_EMAIL],
    ["ADMIN", "admin@tasafiscal.test"],
    ["CAJERO", "cajero@tasafiscal.test"],
  ] as const) {
    await db
      .prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES (?, ?, ?, ?, 1, 0)`)
      .bind(rol, email, hash, rol)
      .run();
    await registrarCorreoDirectorio(db, email, "principal", rol, env);
  }

  const cSuper = await loginComo(env, SUPER_EMAIL);
  const cAdmin = await loginComo(env, "admin@tasafiscal.test");
  const cCajero = await loginComo(env, "cajero@tasafiscal.test");

  const rCli = await reqApi(env, "/api/clientes", {
    method: "POST",
    cookie: cAdmin,
    body: { rif_cedula: "V-12345678-0", nombre_apellido: "Cliente Real" },
  });
  assert.equal(rCli.status, 200, JSON.stringify(rCli.json));
  const cliId = rCli.json!.id;

  const crearBorrador = async () => {
    const r = await reqApi(env, "/api/documentos", {
      method: "POST",
      cookie: cAdmin,
      body: {
        tipo: "FACTURA",
        cliente_id: cliId,
        lineas: [{ descripcion: "Servicio contable", cantidad: 1, precio_usd: "100.00", alicuota_iva: 16 }],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json!.id as number;
  };

  // 1) Con tasa de hoy en REAL -> emite 200
  const docOk = await crearBorrador();
  const rOk = await reqApi(env, `/api/documentos/${docOk}/emitir`, { method: "POST", cookie: cAdmin, body: {} });
  assert.equal(rOk.status, 200);

  // 2) Envejecer tasa 6 días -> REAL debe rechazar con 409 TASA_DESACTUALIZADA
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv_fecha = ? WHERE id = 1`).bind(vieja).run();

  const docBloq = await crearBorrador();
  const rBloq = await reqApi(env, `/api/documentos/${docBloq}/emitir`, { method: "POST", cookie: cCajero, body: {} });
  assert.equal(rBloq.status, 409);
  assert.equal(rBloq.json!.codigo, "TASA_DESACTUALIZADA");
  assert.equal(rBloq.json!.puede_forzar, false);

  // CAJERO intenta forzar override -> sigue rechazado 409
  const rCajForzar = await reqApi(env, `/api/documentos/${docBloq}/emitir`, {
    method: "POST",
    cookie: cCajero,
    body: { confirmar_tasa_vieja: true },
  });
  assert.equal(rCajForzar.status, 409);
  assert.equal(rCajForzar.json!.codigo, "TASA_DESACTUALIZADA");

  // ADMIN sin confirmar_tasa_vieja -> 409 con puede_forzar: true
  const rAdmSin = await reqApi(env, `/api/documentos/${docBloq}/emitir`, { method: "POST", cookie: cAdmin, body: {} });
  assert.equal(rAdmSin.status, 409);
  assert.equal(rAdmSin.json!.codigo, "TASA_DESACTUALIZADA");
  assert.equal(rAdmSin.json!.puede_forzar, true);

  // ADMIN con confirmar_tasa_vieja: true -> 200 y deja auditoría TASA_VIEJA_OVERRIDE
  const rAdmCon = await reqApi(env, `/api/documentos/${docBloq}/emitir`, {
    method: "POST",
    cookie: cAdmin,
    body: { confirmar_tasa_vieja: true },
  });
  assert.equal(rAdmCon.status, 200, JSON.stringify(rAdmCon.json));
  const auditRow = await db
    .prepare(`SELECT accion, detalle FROM auditoria WHERE accion = 'TASA_VIEJA_OVERRIDE' ORDER BY id DESC LIMIT 1`)
    .first<{ accion: string; detalle: string }>();
  assert.ok(auditRow, "Debe existir registro de auditoría TASA_VIEJA_OVERRIDE");
  assert.ok(auditRow.detalle.includes("FACTURA REAL") && auditRow.detalle.includes(vieja));

  // 3) NC (devolver), ND (tasa actual) y Pago en Bs fecha hoy también bloquean con 409 cuando tasa está vieja
  const rNc = await reqApi(env, `/api/documentos/${docOk}/devolver`, {
    method: "POST",
    cookie: cAdmin,
    body: { motivo: "Devolución de prueba", lineas: [{ orden: 1, cantidad: 1 }] },
  });
  assert.equal(rNc.status, 409, JSON.stringify(rNc.json));
  assert.equal(rNc.json!.codigo, "TASA_DESACTUALIZADA");

  const rNd = await reqApi(env, `/api/documentos/${docOk}/nota-debito`, {
    method: "POST",
    cookie: cAdmin,
    body: { motivo: "Recargo mora", monto_usd: "10.00", alicuota_iva: 16, usar_tasa_factura: false },
  });
  assert.equal(rNd.status, 409, JSON.stringify(rNd.json));
  assert.equal(rNd.json!.codigo, "TASA_DESACTUALIZADA");

  const rPagoBs = await reqApi(env, "/api/pagos", {
    method: "POST",
    cookie: cAdmin,
    body: {
      documento_id: docOk,
      fecha: hoy,
      metodo: "PAGO_MOVIL",
      moneda: "BS",
      monto: "500.00",
    },
  });
  assert.equal(rPagoBs.status, 409, JSON.stringify(rPagoBs.json));
  assert.equal(rPagoBs.json!.codigo, "TASA_DESACTUALIZADA");

  // 4) Feriado / sin publicación hoy configurado por SUPER_ADMIN permite operar con la tasa del día hábil anterior
  const rFeriado = await reqApi(env, "/api/sistema/tasa-bcv/feriados", {
    method: "POST",
    cookie: cSuper,
    body: { sin_publicacion_hoy: hoy },
  });
  assert.equal(rFeriado.status, 200);
  // Calcular día hábil anterior a hoy (si hoy es lunes -> viernes; si no -> ayer)
  const [yy, mm, dd] = hoy.split("-").map(Number);
  const dtHoy = new Date(Date.UTC(yy, mm - 1, dd, 12));
  const dow = dtHoy.getUTCDay();
  const diasAtras = dow === 1 ? 3 : dow === 0 ? 2 : 1;
  const habilAnterior = diaAnteriorIso(hoy, diasAtras);
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv_fecha = ? WHERE id = 1`).bind(habilAnterior).run();

  const docFer = await crearBorrador();
  const rFerOk = await reqApi(env, `/api/documentos/${docFer}/emitir`, { method: "POST", cookie: cCajero, body: {} });
  assert.equal(rFerOk.status, 200, `Con sin_publicacion_hoy debe permitir tasa de ${habilAnterior}: ${JSON.stringify(rFerOk.json)}`);

  // 5) En modo PRACTICA permite emitir aunque la tasa esté vieja
  await db.prepare(`UPDATE ajustes SET valor = 'PRACTICA' WHERE clave = 'modo'`).run();
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv_fecha = ? WHERE id = 1`).bind(vieja).run();
  const docPrac = await crearBorrador();
  const rPrac = await reqApi(env, `/api/documentos/${docPrac}/emitir`, { method: "POST", cookie: cCajero, body: {} });
  assert.equal(rPrac.status, 200);
});
