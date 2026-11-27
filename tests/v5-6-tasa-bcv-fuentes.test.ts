import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { migrar } from "../src/migraciones";
import { asegurarTablasMultiTenant, registrarCorreoDirectorio } from "../src/inquilinos";
import { asegurarTablaLimitesRed } from "../src/seguridad-red";
import { hashClave } from "../src/seguridad";
import {
  consultarFuentesBcvOficial,
  extraerFechaValorBcvHtml,
  leerTasaPendienteBcv,
  obtenerTasaBcvGlobal,
  resolverTasaPendienteBcv,
} from "../src/tasa-bcv";

const MASTER_KEY = "ClaveMaestraTestBcvFuentesV560!!";
const SUPER_EMAIL = "super@bcvfuentes.test";
const PASS = "ClaveSegura2026!";

const HTML_BCV_OK = `
<html><body>
  <div id="dolar"><strong> 51,4285 </strong></div>
  <div class="pull-right dinpro center">
    Fecha Valor: <span class="date-display-single" content="2026-11-20T00:00:00-04:00">Viernes, 20 Noviembre 2026</span>
  </div>
</body></html>
`;

test("v5.6 BCV Fuentes: bcv.org.ve es prioridad #1 y extrae fecha_valor real sin asumirla", async () => {
  assert.equal(extraerFechaValorBcvHtml(HTML_BCV_OK), "2026-11-20");

  const urlsLlamadas: string[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    urlsLlamadas.push(url);
    if (url.includes("bcv.org.ve")) {
      return new Response(HTML_BCV_OK, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (url.includes("dolarapi.com")) {
      return new Response(JSON.stringify({ promedio: 51.43, fechaActualizacion: "2026-11-20T18:00:00Z" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const res = await consultarFuentesBcvOficial(fetchMock);
  assert.ok(res);
  assert.equal(urlsLlamadas[0], "https://www.bcv.org.ve/");
  assert.equal(res.fuente, "BCV Oficial (bcv.org.ve)");
  assert.equal(res.tasa_bcv, "51.4285");
  assert.equal(res.fecha_valor, "2026-11-20");
  assert.equal(res.fecha_valor_asumida, 0);
  assert.equal(res.alerta_discrepancia, undefined);
});

test("v5.6 BCV Fuentes: fallback a DolarApi cuando bcv.org.ve cae y cross-check >0.5% prioriza BCV oficial", async () => {
  // Caso 1: bcv.org.ve caído -> usa DolarApi
  const fetchCaido: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("bcv.org.ve")) return new Response("Service Unavailable", { status: 503 });
    if (url.includes("dolarapi.com")) {
      return new Response(JSON.stringify({ promedio: 52.1, fechaActualizacion: "2026-11-20T15:00:00Z" }), { status: 200 });
    }
    return new Response("err", { status: 500 });
  };
  const fallback = await consultarFuentesBcvOficial(fetchCaido);
  assert.ok(fallback);
  assert.equal(fallback.fuente, "BCV Oficial (DolarApi VE)");
  assert.equal(Number(fallback.tasa_bcv), 52.1);

  // Caso 2: discrepancia >0.5% entre BCV (51.4285) y DolarApi (53.00 -> ~3%) -> alerta y gana BCV oficial
  const fetchDiscrep: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("bcv.org.ve")) return new Response(HTML_BCV_OK, { status: 200 });
    if (url.includes("dolarapi.com")) {
      return new Response(JSON.stringify({ promedio: 53.0, fechaActualizacion: "2026-11-20T15:00:00Z" }), { status: 200 });
    }
    return new Response("err", { status: 500 });
  };
  const disc = await consultarFuentesBcvOficial(fetchDiscrep);
  assert.ok(disc);
  assert.equal(disc.fuente, "BCV Oficial (bcv.org.ve)");
  assert.equal(disc.tasa_bcv, "51.4285");
  assert.ok(disc.alerta_discrepancia, "Debe reportar alerta de discrepancia > 0.5%");
});

test("v5.6 BCV Guardia Anti-Anomalías: variación >15% queda pendiente hasta aprobación/rechazo de SUPER_ADMIN", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = {
    DB: db,
    MASTER_KEY,
    SUPER_ADMIN_EMAIL: SUPER_EMAIL,
  };
  await migrar(db);
  await asegurarTablasMultiTenant(db);
  await asegurarTablaLimitesRed(db);

  // Sembrar tasa previa de 50.0000
  const fetch50: typeof fetch = async (input) => {
    if (String(input).includes("bcv.org.ve")) {
      return new Response(`<div id="dolar"><strong>50,0000</strong></div><span class="date-display-single" content="2026-11-19T00:00:00-04:00"></span>`, { status: 200 });
    }
    return new Response(JSON.stringify({ promedio: 50.0 }), { status: 200 });
  };
  const inicial = await obtenerTasaBcvGlobal(db, { forzar: true, permitirRed: true, fetchFn: fetch50, env });
  assert.equal(Number(inicial?.tasa_bcv), 50);

  // Ahora BCV devuelve 80.0000 (+60% > 15% umbral) -> debe retenerse como pendiente y conservar 50 activa
  const fetch80: typeof fetch = async (input) => {
    if (String(input).includes("bcv.org.ve")) {
      return new Response(`<div id="dolar"><strong>80,0000</strong></div><span class="date-display-single" content="2026-11-20T00:00:00-04:00"></span>`, { status: 200 });
    }
    return new Response(JSON.stringify({ promedio: 80.0 }), { status: 200 });
  };
  const anomala = await obtenerTasaBcvGlobal(db, { forzar: true, permitirRed: true, fetchFn: fetch80, env });
  assert.ok(anomala);
  assert.equal(Number(anomala.tasa_bcv), 50, "La tasa activa no debe sobreescribirse sin aprobación");
  assert.equal(anomala.pendiente_aprobacion, true);
  assert.equal(Number(anomala.tasa_pendiente?.tasa_bcv), 80);

  const pendGuardada = await leerTasaPendienteBcv(db);
  assert.equal(Number(pendGuardada?.tasa_bcv), 80);

  // Probar endpoint HTTP POST /api/sistema/tasa-bcv/aprobar-pendiente (solo SUPER_ADMIN)
  const hash = await hashClave(PASS, env);
  await db.prepare(`INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv, tasa_bcv_modo) VALUES (1, 1, 'Emp', 'J-12345678-9', 'Caracas', 50, 'AUTOMATICO')`).run();
  await db.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES ('Super', ?, ?, 'SUPER_ADMIN', 1, 0)`).bind(SUPER_EMAIL, hash).run();
  await db.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES ('Admin', 'admin@bcv.test', ?, 'ADMIN', 1, 0)`).bind(hash).run();
  await registrarCorreoDirectorio(db, SUPER_EMAIL, "principal", "SUPER_ADMIN", env);
  await registrarCorreoDirectorio(db, "admin@bcv.test", "principal", "ADMIN", env);

  const login = async (email: string) => {
    const r = await app.fetch(
      new Request("https://facturayave.com/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, clave: PASS }),
      }),
      env as never
    );
    const sc = r.headers.getSetCookie?.() || [r.headers.get("set-cookie") || ""];
    return sc.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  };

  const cAdmin = await login("admin@bcv.test");
  const rAdminForb = await app.fetch(
    new Request("https://facturayave.com/api/sistema/tasa-bcv/aprobar-pendiente", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cAdmin },
      body: JSON.stringify({ aprobar: true }),
    }),
    env as never
  );
  assert.equal(rAdminForb.status, 403, "Solo SUPER_ADMIN puede aprobar tasas anómalas");

  const cSuper = await login(SUPER_EMAIL);
  const rAprobar = await app.fetch(
    new Request("https://facturayave.com/api/sistema/tasa-bcv/aprobar-pendiente", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cSuper },
      body: JSON.stringify({ aprobar: true }),
    }),
    env as never
  );
  assert.equal(rAprobar.status, 200);
  const jAp = (await rAprobar.json()) as any;
  assert.equal(jAp.aprobada, true);
  assert.equal(Number(jAp.tasa.tasa_bcv), 80);
  assert.equal(await leerTasaPendienteBcv(db), null);

  // Verificar que resolver sin pendiente devuelve ok: false
  const rVacio = await resolverTasaPendienteBcv(db, false);
  assert.equal(rVacio.ok, false);
});
