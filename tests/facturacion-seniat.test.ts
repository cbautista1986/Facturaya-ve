import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { diagnosticarTodoElSistema } from "../src/salud-bd";

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

test("Suite Integral SENIAT: Facturación en centavos, Stock, Nota de Crédito, Inmutabilidad, Libros y Aislamiento de Costos", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, SUPER_ADMIN_EMAIL: "superadmin@ejemplo.test" };
  const jarAdmin: Record<string, string> = {};

  // 1) Instalación inicial y configuración de tasa BCV (Bs 100,00 por USD -> tasa_e8 = 10_000_000_000)
  const inst = await reqJson(env, jarAdmin, "/api/instalar", "POST", {
    nombre: "EMPRESA DEMO C.A.",
    rif: "V-12345678-1",
    direccion: "Caracas, Distrito Capital",
    telefono: "0414-0000000",
    email: "superadmin@ejemplo.test",
    medio_facturacion: "APP_SENIAT",
    clave: "ClavePruebaSegura2026!",
  });
  assert.equal(inst.status, 200);

  await reqJson(env, jarAdmin, "/api/config", "PUT", { tasa_bcv: "100,00", igtf_activo: 1 });

  // Pasar a Modo REAL iniciando numeración oficial desde 00000001
  const enVivo = await reqJson(env, jarAdmin, "/api/sistema/salir-en-vivo", "POST", {
    primer_factura: 1,
    primer_nota_credito: 1,
    primer_control: 1,
    primer_presupuesto: 1,
    primer_recibo: 1,
    confirmo: true,
  });
  assert.equal(enVivo.status, 200);

  // 2) Crear cliente, producto gravado (IVA 16%) con carga de stock y servicio exento (IVA 0%)
  const cli = await reqJson(env, jarAdmin, "/api/clientes", "POST", {
    rif_cedula: "J-12345678-9",
    nombre_apellido: "Comercial Andina C.A.",
    direccion: "Av. Libertador, Caracas",
    whatsapp: "0414-5556677",
  });
  assert.equal(cli.status, 200);
  const clienteId = cli.data.id;

  const prod = await reqJson(env, jarAdmin, "/api/catalogo", "POST", {
    tipo: "PRODUCTO",
    nombre: "Router WiFi 6 Empresarial",
    precio_usd: "50,00",
    costo_usd: "30,00",
    alicuota_iva: 16,
    controla_stock: 1,
    stock_minimo: 2,
  });
  assert.equal(prod.status, 200);
  const prodId = prod.data.id;

  // Cargar 5 unidades al inventario a $30.00 c/u
  const cargaStock = await reqJson(env, jarAdmin, "/api/existencias/carga", "POST", {
    producto_id: prodId,
    cantidad: "5",
    costo_usd: "30,00",
    nota: "Inventario inicial de routers",
  });
  assert.equal(cargaStock.status, 200);
  assert.equal(cargaStock.data.stock_milli, 5000);

  const serv = await reqJson(env, jarAdmin, "/api/catalogo", "POST", {
    tipo: "SERVICIO",
    nombre: "Instalación y Configuración de Red",
    precio_usd: "25,00",
    costo_usd: "5,00",
    alicuota_iva: 0,
  });
  assert.equal(serv.status, 200);
  const servId = serv.data.id;

  // 3) Rechazar emisión de factura si supera el stock disponible (pide 10 routers cuando solo hay 5)
  const borradorSinStock = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: clienteId,
    lineas: [{ catalogo_id: prodId, cantidad: "10", precio_usd: "50,00" }],
  });
  assert.equal(borradorSinStock.status, 200);
  const emitirSinStock = await reqJson(env, jarAdmin, `/api/documentos/${borradorSinStock.data.id}/emitir`, "POST", {});
  assert.equal(emitirSinStock.status, 409);

  // 4) Crear y Emitir Factura #1 en Modo REAL con 2 Routers ($50 c/u = $100 gravado 16% -> IVA $16) + 1 Servicio Exento ($25 -> IVA $0)
  // Subtotal = $125.00 (12500 centavos), IVA = $16.00 (1600), IGTF 3% sobre ($125 + $16 = $141) = $4.23 (423 centavos), Total = $145.23 (14523 centavos)
  const borrador1 = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: clienteId,
    aplica_igtf: true,
    lineas: [
      { catalogo_id: prodId, cantidad: "2", precio_usd: "50,00" },
      { catalogo_id: servId, cantidad: "1", precio_usd: "25,00" },
    ],
  });
  assert.equal(borrador1.status, 200);
  const facId = borrador1.data.id;

  const emision1 = await reqJson(env, jarAdmin, `/api/documentos/${facId}/emitir`, "POST", {});
  assert.equal(emision1.status, 200);
  assert.equal(emision1.data.numero, 1);
  assert.equal(emision1.data.control_interno, 1);

  const det1 = await reqJson(env, jarAdmin, `/api/documentos/${facId}`);
  assert.equal(det1.status, 200);
  assert.equal(det1.data.documento.subtotal_usd, 12500);
  assert.equal(det1.data.documento.iva_usd, 1600);
  assert.equal(det1.data.documento.igtf_usd, 423);
  assert.equal(det1.data.documento.total_usd, 14523);
  assert.equal(det1.data.documento.total_bs, 1452300); // $145.23 * Bs 100.00 = Bs 14.523,00 (1452300 céntimos)

  // Verificar descuento de inventario (5000 - 2000 = 3000 milli = 3 unidades)
  const movs1 = await reqJson(env, jarAdmin, `/api/existencias/${prodId}/movimientos`);
  assert.equal(movs1.data.stock_milli, 3000);

  // 5) Verificar candados SQLite de Inmutabilidad Fiscal SENIAT (prohibido borrar o alterar montos de una factura emitida)
  await assert.rejects(
    async () => {
      await db.prepare(`DELETE FROM documentos WHERE id = ?`).bind(facId).run();
    },
    /Documento emitido/i
  );
  await assert.rejects(
    async () => {
      await db.prepare(`UPDATE documentos SET total_usd = 100 WHERE id = ?`).bind(facId).run();
    },
    /Documento emitido/i
  );

  // 6) Emitir Nota de Crédito (n.º 1, control 2) devolviendo 1 Router ($50 + 16% IVA) con retorno automático al inventario
  const nc1 = await reqJson(env, jarAdmin, `/api/documentos/${facId}/devolver`, "POST", {
    motivo: "Devolución de 1 Router por cambio de modelo",
    aplica_igtf: true,
    lineas: [{ orden: 1, cantidad: "1" }],
  });
  assert.equal(nc1.status, 200);
  assert.equal(nc1.data.numero, 1);
  const detNc = await reqJson(env, jarAdmin, `/api/documentos/${nc1.data.id}`);
  assert.equal(detNc.data.documento.control_interno, 2);

  // El stock debe haber subido de 3000 a 4000 milli (4 unidades) por la devolución
  const movs2 = await reqJson(env, jarAdmin, `/api/existencias/${prodId}/movimientos`);
  assert.equal(movs2.data.stock_milli, 4000);

  // 7) Verificar Libro de Ventas y Resumen IVA (Art. 72 RLIVA)
  const libroVentas = await reqJson(env, jarAdmin, `/api/informes/ventas`);
  assert.equal(libroVentas.status, 200);
  assert.equal(libroVentas.data.filas.length, 2); // Factura #1 + Nota de Crédito #1
  assert.equal(libroVentas.data.n_vigentes, 1);
  assert.equal(libroVentas.data.n_notas_credito, 1);

  const resumenIva = await reqJson(env, jarAdmin, `/api/informes/resumen-iva`);
  assert.equal(resumenIva.status, 200);
  assert.equal(resumenIva.data.filas.length, 1);
  // Base gravada neta en Bs: ($100 - $50) * Bs 100 = Bs 5.000,00 (500000 céntimos); IVA neto = Bs 800,00 (80000 céntimos)
  assert.equal(resumenIva.data.filas[0].ventas_gravadas_bs, 500000);
  assert.equal(resumenIva.data.filas[0].debito_bs, 80000);

  // 8) Verificar aislamiento de costos en el servidor (CAJERO jamás recibe costo_usd ni costo_total_usd)
  const crearCajero = await reqJson(env, jarAdmin, "/api/usuarios", "POST", {
    nombre: "Cajero Principal",
    email: "cajero@ejemplo.test",
    rol: "CAJERO",
  });
  assert.equal(crearCajero.status, 200);
  const jarCajero: Record<string, string> = {};
  const loginCaj = await reqJson(env, jarCajero, "/api/login", "POST", {
    email: "cajero@ejemplo.test",
    clave: crearCajero.data.clave_temporal,
  });
  assert.equal(loginCaj.status, 200);
  const cambioCaj = await reqJson(env, jarCajero, "/api/cuenta/clave", "POST", {
    actual: crearCajero.data.clave_temporal,
    nueva: "ClaveCajeroSegura2026!",
  });
  assert.equal(cambioCaj.status, 200);

  const detComoCajero = await reqJson(env, jarCajero, `/api/documentos/${facId}`);
  assert.equal(detComoCajero.status, 200);
  assert.equal("costo_total_usd" in detComoCajero.data.documento, false, "El cajero jamás debe recibir costo_total_usd");
  for (const it of detComoCajero.data.lineas) {
    assert.equal("costo_usd" in it, false, "El cajero jamás debe recibir costo_usd en los renglones");
  }

  // 9) Verificar Diagnóstico de Salud BD: 100% SANA (16/16 triggers, correlativos exactos, centavos exactos)
  const salud = await diagnosticarTodoElSistema(db, env);
  assert.equal(salud.sano_global, true);
  assert.equal(salud.reportes[0].triggers_ok, true);
  assert.equal(salud.reportes[0].correlativos_ok, true);
});
