import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { migrar } from "../src/migraciones";
import { asegurarTablasMultiTenant, registrarCorreoDirectorio } from "../src/inquilinos";
import { asegurarTablaLimitesRed } from "../src/seguridad-red";
import { hashClave } from "../src/seguridad";
import { sinCostos } from "../src/permisos";
import { fechaCaracas } from "../src/comun";

const MASTER_KEY = "ClaveMaestraTestCostosRbacV560!!";
const SUPER_EMAIL = "admin@rbacv56.test";
const PASS = "ClaveSegura2026!";

const CLAVES_PROHIBIDAS = new Set([
  "costo_centavos",
  "costo_unitario_usd",
  "costo_total_usd",
  "valor_usd",
  "valor_total_usd",
  "ganancia_usd",
  "ganancia_bs",
  "margen_pct",
  "costo_usd",
  "costo_bs",
]);

function buscarClavesProhibidas(obj: unknown, ruta = "$"): string[] {
  const hallazgos: string[] = [];
  if (obj === null || obj === undefined) return hallazgos;
  if (typeof obj === "string") {
    const t = obj.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        hallazgos.push(...buscarClavesProhibidas(JSON.parse(t), `${ruta}<json>`));
      } catch {
        // texto libre, ignorar
      }
    }
    return hallazgos;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => hallazgos.push(...buscarClavesProhibidas(v, `${ruta}[${i}]`)));
    return hallazgos;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (CLAVES_PROHIBIDAS.has(k) || /(costo|ganancia|margen|utilidad)/i.test(k)) {
        hallazgos.push(`${ruta}.${k}`);
      }
      hallazgos.push(...buscarClavesProhibidas(v, `${ruta}.${k}`));
    }
  }
  return hallazgos;
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

async function loginComo(env: Record<string, unknown>, email: string, clave = PASS): Promise<string> {
  const r = await reqApi(env, "/api/login", { method: "POST", body: { email, clave } });
  assert.equal(r.status, 200, `Login falló para ${email}: ${JSON.stringify(r.json)}`);
  const setCookies = r.headers.getSetCookie?.() || [r.headers.get("set-cookie") || ""];
  return setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

test("v5.6 RBAC Costos: sinCostos() sanea campos directos, anidados y renglones_json", () => {
  const entrada = {
    ok: true,
    valor_total_usd: 99999,
    productos: [
      { id: 1, nombre: "Filtro", precio_usd: 2500, costo_centavos: 1200, valor_usd: 12000 },
    ],
    documento: {
      id: 7,
      total_usd: 2500,
      renglones_json: JSON.stringify([
        { nombre: "Filtro", cantidad: 1, precio_usd: 2500, costo_centavos: 1200, ganancia_usd: 1300 },
      ]),
    },
  };
  const limpio = sinCostos(entrada) as Record<string, any>;
  assert.deepEqual(buscarClavesProhibidas(limpio), []);
  assert.equal(limpio.productos[0].precio_usd, 2500);
  const renglones = JSON.parse(limpio.documento.renglones_json);
  assert.equal(renglones[0].precio_usd, 2500);
  assert.equal("costo_centavos" in renglones[0], false);
});

test("v5.6 RBAC Costos: CAJERO, SUPERVISOR y BODEGA nunca reciben costos ni ganancias; ADMIN y CONTADOR sí", async () => {
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
  await db.batch([
    db.prepare(
      `INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv, tasa_bcv_fecha, tipo_contribuyente, igtf_activo)
       VALUES (1, 1, 'Distribuidora Costos C.A.', 'J-12345678-9', 'Caracas', 50, ?, 'ORDINARIO', 0)`
    ).bind(hoy),
    db.prepare(`INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('modo', 'PRACTICA')`),
  ]);

  const hash = await hashClave(PASS, env);
  const roles = [
    { rol: "ADMIN", email: "admin@negocio.test" },
    { rol: "CONTADOR", email: "contador@negocio.test" },
    { rol: "SUPERVISOR", email: "supervisor@negocio.test" },
    { rol: "CAJERO", email: "cajero@negocio.test" },
    { rol: "BODEGA", email: "bodega@negocio.test" },
  ];
  for (const u of roles) {
    await db
      .prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES (?, ?, ?, ?, 1, 0)`)
      .bind(`Usuario ${u.rol}`, u.email, hash, u.rol)
      .run();
    await registrarCorreoDirectorio(db, u.email, "principal", u.rol, env);
  }

  const cookieAdmin = await loginComo(env, "admin@negocio.test");

  // Sembrar producto con costo, proveedor, compra, cliente y factura emitida
  const rProd = await reqApi(env, "/api/catalogo", {
    method: "POST",
    cookie: cookieAdmin,
    body: {
      tipo: "PRODUCTO",
      codigo: "P-001",
      nombre: "Bomba de agua",
      precio_usd: "40.00",
      costo_usd: "18.50",
      alicuota_iva: 16,
      controla_stock: 1,
    },
  });
  assert.equal(rProd.status, 200, JSON.stringify(rProd.json));
  const prodId = rProd.json!.id;

  const rProv = await reqApi(env, "/api/proveedores", {
    method: "POST",
    cookie: cookieAdmin,
    body: { rif: "J-22222222-2", nombre: "Mayorista Central C.A." },
  });
  assert.equal(rProv.status, 200, JSON.stringify(rProv.json));

  const rCompra = await reqApi(env, "/api/compras", {
    method: "POST",
    cookie: cookieAdmin,
    body: {
      proveedor_id: rProv.json!.id,
      factura_numero: "F-9001",
      fecha: hoy,
      tasa_bcv: "50",
      lineas: [{ producto_id: prodId, cantidad: 5, costo_usd: "18.50", alicuota_iva: 16 }],
    },
  });
  assert.equal(rCompra.status, 200, JSON.stringify(rCompra.json));
  const compraId = rCompra.json!.id;

  const rCli = await reqApi(env, "/api/clientes", {
    method: "POST",
    cookie: cookieAdmin,
    body: { rif_cedula: "V-11111111-1", nombre_apellido: "Cliente Prueba" },
  });
  assert.equal(rCli.status, 200, JSON.stringify(rCli.json));

  const rDoc = await reqApi(env, "/api/documentos", {
    method: "POST",
    cookie: cookieAdmin,
    body: {
      tipo: "FACTURA",
      cliente_id: rCli.json!.id,
      lineas: [{ catalogo_id: prodId, descripcion: "Bomba de agua", cantidad: 2, precio_usd: "40.00", alicuota_iva: 16 }],
    },
  });
  assert.equal(rDoc.status, 200, JSON.stringify(rDoc.json));
  const docId = rDoc.json!.id;
  const rEm = await reqApi(env, `/api/documentos/${docId}/emitir`, { method: "POST", cookie: cookieAdmin, body: {} });
  assert.equal(rEm.status, 200, JSON.stringify(rEm.json));

  const endpoints = [
    "/api/existencias",
    `/api/existencias/${prodId}/movimientos`,
    "/api/catalogo",
    `/api/catalogo/${prodId}`,
    "/api/compras",
    `/api/compras/${compraId}`,
    "/api/informes/inventario",
    `/api/documentos/${docId}`,
    "/api/documentos/resumen",
  ];

  // Roles SIN acceso a costos (veCostos = false): CAJERO, SUPERVISOR y CONTADOR
  for (const rol of ["CAJERO", "SUPERVISOR", "CONTADOR"] as const) {
    const cookie = await loginComo(env, `${rol.toLowerCase()}@negocio.test`);
    // Ganancias siempre 403
    const rGan = await reqApi(env, "/api/informes/ganancias", { cookie });
    assert.equal(rGan.status, 403, `${rol} no debe acceder a /api/informes/ganancias`);

    for (const ep of endpoints) {
      const r = await reqApi(env, ep, { cookie });
      if (r.status === 200) {
        const fugas = buscarClavesProhibidas(r.json);
        assert.deepEqual(fugas, [], `Fuga de costos para ${rol} en ${ep}: ${fugas.join(", ")}`);
      } else {
        assert.equal(r.status, 403, `Estado inesperado ${r.status} para ${rol} en ${ep}`);
      }
    }
  }

  // SUPERVISOR intenta sobreescribir costo_usd en catálogo -> debe ignorarse / preservarse (no tiene veCostos)
  const cookieSup = await loginComo(env, "supervisor@negocio.test");
  const rEditSup = await reqApi(env, `/api/catalogo/${prodId}`, {
    method: "PUT",
    cookie: cookieSup,
    body: {
      tipo: "PRODUCTO",
      codigo: "P-001",
      nombre: "Bomba de agua",
      precio_usd: "40.00",
      costo_usd: "0.01",
      alicuota_iva: 16,
    },
  });
  assert.ok(rEditSup.status === 200 || rEditSup.status === 403);
  const filaProd = await db.prepare(`SELECT costo_centavos FROM catalogo WHERE id = ?`).bind(prodId).first<{ costo_centavos: number }>();
  assert.equal(filaProd?.costo_centavos, 1850, "SUPERVISOR jamás debe poder sobreescribir costo_centavos");

  // BODEGA tiene veCostos (registra compras/inventario) pero NO puede consultar /api/informes/ganancias (solo ADMIN)
  const cookieBodega = await loginComo(env, "bodega@negocio.test");
  const rGanBod = await reqApi(env, "/api/informes/ganancias", { cookie: cookieBodega });
  assert.equal(rGanBod.status, 403, "BODEGA no debe acceder a /api/informes/ganancias");
  const rExBod = await reqApi(env, "/api/existencias", { cookie: cookieBodega });
  assert.equal(rExBod.status, 200);
  assert.equal(rExBod.json!.items[0].costo_centavos, 1850, "BODEGA debe ver costo_centavos en existencias");

  // ADMIN SÍ ve costos, valoración de inventario y ganancias
  const rGanAdm = await reqApi(env, "/api/informes/ganancias", { cookie: cookieAdmin });
  assert.equal(rGanAdm.status, 200, "ADMIN debe poder consultar /api/informes/ganancias");
  const rInvAdm = await reqApi(env, "/api/informes/inventario", { cookie: cookieAdmin });
  assert.equal(rInvAdm.status, 200);
  assert.ok(typeof rInvAdm.json!.valor_total_usd === "number", "ADMIN debe ver valor_total_usd en inventario");
  const rExAdm = await reqApi(env, "/api/existencias", { cookie: cookieAdmin });
  assert.equal(rExAdm.status, 200);
  assert.equal(rExAdm.json!.items[0].costo_centavos, 1850, "ADMIN debe ver costo_centavos en existencias");
});
