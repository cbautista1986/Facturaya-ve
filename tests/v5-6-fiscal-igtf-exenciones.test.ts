import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { migrar } from "../src/migraciones";
import { asegurarTablasMultiTenant, registrarCorreoDirectorio } from "../src/inquilinos";
import { asegurarTablaLimitesRed } from "../src/seguridad-red";
import { hashClave } from "../src/seguridad";
import { fechaCaracas } from "../src/comun";
import { calcular, aTasaE8 } from "../public/dinero.js";
import { construirModelo } from "../public/informe-tabla.js";
import {
  normalizarTipoExencion,
  resolverBaseIgtfFacturaUsd,
  calcularBaseIgtfNcSugerida,
  validarIgtfNotaCredito,
} from "../src/reglas-fiscales";
import { construirDocumentoElectronicoTfhka } from "../src/imprenta-tfhka";
import { construirPayloadFacturaCg, type PayloadImprentaDocumento } from "../src/imprenta-cg";
import { diagnosticarInquilino } from "../src/salud-bd";

const MASTER_KEY = "ClaveMaestraTestSeccion8V561!!";
const SUPER_EMAIL = "super@seccion8.test";
const PASS = "ClaveSegura2026!";

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

async function prepararEntornoSPE() {
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
      `INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv, tasa_bcv_fecha, tasa_bcv_modo, medio_facturacion, tipo_contribuyente, igtf_activo)
       VALUES (1, 1, 'Distribuidora Especial C.A.', 'J-40123456-7', 'Caracas, Venezuela', 50, ?, 'MANUAL', 'APP_SENIAT', 'ESPECIAL', 1)`
    ).bind(hoy),
    db.prepare(`INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('modo', 'REAL')`),
  ]);

  const hash = await hashClave(PASS, env);
  await db
    .prepare(
      `INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES ('Super Admin', ?, ?, 'SUPER_ADMIN', 1, 0)`
    )
    .bind(SUPER_EMAIL, hash)
    .run();
  await registrarCorreoDirectorio(db, SUPER_EMAIL, "principal", "SUPER_ADMIN", env);

  const cookie = await loginComo(env, SUPER_EMAIL);
  return { db, env, cookie, hoy };
}

test("v5.6.1 Pure math (dinero.js & reglas-fiscales): IGTF parcial, validaciones y separación IVA 0%", () => {
  const tasaE8 = aTasaE8("50")!;

  // 1) IGTF parcial: $100 subtotal + $16 IVA = $116 total con IVA; cliente paga $40 en divisas
  const parcial = calcular(
    [{ cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600, costo_usd: 6000 }],
    tasaE8,
    { aplica_igtf: true, igtf_base_usd: 4000 }
  );
  assert.equal(parcial.subtotal_usd, 10000);
  assert.equal(parcial.iva_usd, 1600);
  assert.equal(parcial.igtf_base_usd, 4000);
  assert.equal(parcial.igtf_usd, 120); // 3% de $40.00 = $1.20
  assert.equal(parcial.total_usd, 11720); // $116.00 + $1.20
  assert.equal(parcial.igtf_base_bs, 200000); // $40 * 50 = Bs 2.000,00
  assert.equal(parcial.igtf_bs, 6000); // 3% de Bs 2.000,00 = Bs 60,00
  assert.equal(parcial.total_bs, parcial.subtotal_bs! + parcial.iva_bs! + parcial.igtf_bs!);

  // 2) IGTF completo por omisión: 100% de $116 = $3.48
  const completo = calcular(
    [{ cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600, costo_usd: 6000 }],
    tasaE8,
    { aplica_igtf: true }
  );
  assert.equal(completo.igtf_base_usd, 11600);
  assert.equal(completo.igtf_usd, 348);
  assert.equal(completo.total_usd, 11948);
  assert.equal(completo.igtf_base_bs, completo.subtotal_bs! + completo.iva_bs!);

  // 3) Rechaza base IGTF mayor al total con IVA o negativa/no entera
  assert.throws(
    () =>
      calcular([{ cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600, costo_usd: null }], tasaE8, {
        aplica_igtf: true,
        igtf_base_usd: 11601,
      }),
    /no puede superar/i
  );
  assert.throws(
    () =>
      calcular([{ cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600, costo_usd: null }], tasaE8, {
        aplica_igtf: true,
        igtf_base_usd: -100,
      }),
    /no es válida/i
  );

  // 4) Desglose IVA 0%: Exento + Exonerado + No Sujeto + 16%
  const mix = calcular(
    [
      { cantidad_milli: 1000, precio_usd: 2500, alicuota_cent: 0, tipo_exencion: "EXENTA" },
      { cantidad_milli: 1000, precio_usd: 3500, alicuota_cent: 0, tipo_exencion: "EXONERADA" },
      { cantidad_milli: 1000, precio_usd: 1500, alicuota_cent: 0, tipo_exencion: "NO_SUJETA" },
      { cantidad_milli: 1000, precio_usd: 5000, alicuota_cent: 1600 },
    ],
    tasaE8
  );
  const imp0 = mix.impuestos.find((i: any) => i.alicuota_cent === 0)!;
  assert.equal(imp0.base_usd, 7500);
  assert.equal(imp0.exenta_usd, 2500);
  assert.equal(imp0.exonerada_usd, 3500);
  assert.equal(imp0.no_sujeta_usd, 1500);
  assert.equal(imp0.base_usd, imp0.exenta_usd + imp0.exonerada_usd + imp0.no_sujeta_usd);
  assert.equal(imp0.base_bs, imp0.exenta_bs! + imp0.exonerada_bs! + imp0.no_sujeta_bs!);

  // 5) Reglas fiscales auxiliares (base IGTF NC proporcional y topes)
  assert.equal(normalizarTipoExencion("exonerada"), "EXONERADA");
  assert.equal(normalizarTipoExencion("no_sujeta"), "NO_SUJETA");
  assert.equal(normalizarTipoExencion("desconocido"), "EXENTA");

  assert.equal(resolverBaseIgtfFacturaUsd({ aplica_igtf: 1, igtf_base_usd: 4000, subtotal_usd: 10000, iva_usd: 1600 }), 4000);
  assert.equal(resolverBaseIgtfFacturaUsd({ aplica_igtf: 1, igtf_base_usd: 0, subtotal_usd: 10000, iva_usd: 1600 }), 11600);

  // Devolución del 50% ($58 de $116) sobre factura con base IGTF $40 -> sugiere $20
  const sug = calcularBaseIgtfNcSugerida(5800, 11600, 4000, 0);
  assert.equal(sug, 2000);

  // Validación NC rechaza exceder base IGTF disponible
  const errNc = validarIgtfNotaCredito(true, true, {
    baseIgtfNcUsd: 2500,
    totalConIvaNcUsd: 5800,
    baseIgtfDisponibleUsd: 2000,
  });
  assert.equal(errNc.ok, false);
  if (!errNc.ok) {
    assert.match(errNc.error, /supera el monto en divisas disponible/i);
  }
});

test("v5.6.1 End-to-end IGTF parcial: factura SPE, inmutabilidad D1, informe IGTF, NC proporcional y TFHKA split FormasPago", async () => {
  const { db, env, cookie, hoy } = await prepararEntornoSPE();

  // Crear cliente
  const cRes = await reqApi(env, "/api/clientes", {
    method: "POST",
    cookie,
    body: { rif_cedula: "J-50111222-3", nombre_apellido: "Cliente Mixto C.A.", direccion: "Caracas" },
  });
  assert.equal(cRes.status, 200, JSON.stringify(cRes.json));
  const clienteId = cRes.json!.id;

  // Crear borrador de factura SPE con pago mixto: 2 unidades × $50 = $100 + 16% IVA ($16) = $116, pero solo $40 en divisas
  const fRes = await reqApi(env, "/api/documentos", {
    method: "POST",
    cookie,
    body: {
      tipo: "FACTURA",
      cliente_id: clienteId,
      condicion: "CONTADO",
      aplica_igtf: 1,
      igtf_base_usd: "40,00",
      lineas: [{ tipo: "SERVICIO", descripcion: "Consultoría Fiscal", cantidad: "2", precio_usd: "50,00", alicuota_iva: 16 }],
    },
  });
  assert.equal(fRes.status, 200, `Error creando borrador: ${JSON.stringify(fRes.json)}`);
  const docId = fRes.json!.id;

  // Emitir en Modo REAL
  const emRes = await reqApi(env, `/api/documentos/${docId}/emitir`, { method: "POST", cookie });
  assert.equal(emRes.status, 200, `Error emitiendo: ${JSON.stringify(emRes.json)}`);

  // Verificar detalle del documento emitido
  const det = await reqApi(env, `/api/documentos/${docId}`, { cookie });
  assert.equal(det.status, 200);
  const D = det.json!.documento;
  assert.equal(D.subtotal_usd, 10000);
  assert.equal(D.iva_usd, 1600);
  assert.equal(D.igtf_base_usd, 4000);
  assert.equal(D.igtf_base_bs, 200000);
  assert.equal(D.igtf_usd, 120);
  assert.equal(D.igtf_bs, 6000);
  assert.equal(D.total_usd, 11720);
  assert.equal(D.total_bs, D.subtotal_bs + D.iva_bs + D.igtf_bs);
  assert.equal(det.json!.igtf_base_disponible_usd, 4000);

  // Trigger doc_inmutable DEBE rechazar alterar igtf_base_usd o igtf_base_bs en REAL
  await assert.rejects(
    async () => {
      await db.prepare(`UPDATE documentos SET igtf_base_usd = 5000 WHERE id = ?`).bind(docId).run();
    },
    /no se puede modificar/i
  );
  await assert.rejects(
    async () => {
      await db.prepare(`UPDATE documentos SET igtf_base_bs = 250000 WHERE id = ?`).bind(docId).run();
    },
    /no se puede modificar/i
  );

  // Informe /api/informes/igtf debe reportar la base parcial exacta ($40 / Bs 2.000) y no los $116
  const infIgtf = await reqApi(env, `/api/informes/igtf?desde=${hoy}&hasta=${hoy}`, { cookie });
  assert.equal(infIgtf.status, 200);
  assert.equal(infIgtf.json!.base_divisas_usd, 4000);
  assert.equal(infIgtf.json!.base_divisas_bs, 200000);
  assert.equal(infIgtf.json!.igtf_usd, 120);
  assert.equal(infIgtf.json!.igtf_bs, 6000);
  assert.equal(infIgtf.json!.filas[0].es_igtf_parcial, true);

  // Nota de Crédito parcial (1 de 2 unidades -> $50 + $8 IVA = $58) SIN especificar igtf_base_usd -> proporcional automático = $20 ($0.60 IGTF)
  const nc1 = await reqApi(env, `/api/documentos/${docId}/devolver`, {
    method: "POST",
    cookie,
    body: {
      motivo: "Devolución parcial del 50% del servicio",
      aplica_igtf: true,
      lineas: [{ orden: 1, cantidad: "1" }],
    },
  });
  assert.equal(nc1.status, 200, `Error NC1: ${JSON.stringify(nc1.json)}`);
  const detNc1 = await reqApi(env, `/api/documentos/${nc1.json!.id}`, { cookie });
  assert.equal(detNc1.json!.documento.igtf_base_usd, 2000);
  assert.equal(detNc1.json!.documento.igtf_usd, 60);
  assert.equal(detNc1.json!.documento.total_usd, 5860);

  // Disponible restante debe ser $20 (2000 centavos)
  const detPostNc1 = await reqApi(env, `/api/documentos/${docId}`, { cookie });
  assert.equal(detPostNc1.json!.igtf_base_disponible_usd, 2000);

  // Intento de segunda NC intentando reversar $30 de base IGTF (supera los $20 disponibles) -> DEBE fallar con 400
  const ncExceso = await reqApi(env, `/api/documentos/${docId}/devolver`, {
    method: "POST",
    cookie,
    body: {
      motivo: "Intento exceso IGTF parcial",
      aplica_igtf: true,
      igtf_base_usd: "30,00",
      lineas: [{ orden: 1, cantidad: "1" }],
    },
  });
  assert.equal(ncExceso.status, 400);
  assert.match(String(ncExceso.json?.error || ""), /supera el monto en divisas disponible/i);

  // Payload TFHKA para factura con IGTF parcial: BaseImponibleImp parcial y FormasPago dividido ("09" USD + "02" VES)
  const payloadBase: PayloadImprentaDocumento = {
    documento_id: D.id,
    tipo_documento: "FACTURA",
    numero: D.numero,
    control_interno: D.control_interno,
    fecha_emision: D.fecha_emision,
    cliente_rif: "J-50111222-3",
    cliente_nombre: "Cliente Mixto C.A.",
    subtotal_bs: D.subtotal_bs,
    iva_bs: D.iva_bs,
    igtf_base_bs: D.igtf_base_bs,
    igtf_bs: D.igtf_bs,
    total_bs: D.total_bs,
    subtotal_usd: D.subtotal_usd,
    iva_usd: D.iva_usd,
    igtf_base_usd: D.igtf_base_usd,
    igtf_usd: D.igtf_usd,
    total_usd: D.total_usd,
    tasa_e8: D.tasa_e8,
    condicion: "CONTADO",
    renglones: det.json!.lineas,
    impuestos: det.json!.impuestos,
  };
  const tfParcial = construirDocumentoElectronicoTfhka(payloadBase);
  const encParcial = (tfParcial.DocumentoElectronico as any).Encabezado;
  const totParcial = encParcial.Totales;
  const impIgtf = totParcial.ImpuestosSubtotal.find((x: any) => x.CodigoTotalImp === "IGTF");
  assert.ok(impIgtf, "Debe existir bloque ImpuestosSubtotal IGTF");
  assert.equal(impIgtf.BaseImponibleImp, "2000.00");
  assert.equal(impIgtf.ValorTotalImp, "60.00");
  assert.equal(totParcial.FormasPago.length, 2, "IGTF parcial debe dividir FormasPago en USD (09) y VES (02)");
  assert.equal(totParcial.FormasPago[0].Forma, "09");
  assert.equal(totParcial.FormasPago[0].Moneda, "USD");
  assert.equal(totParcial.FormasPago[0].Monto, "41.20"); // $40.00 + $1.20 IGTF
  assert.equal(totParcial.FormasPago[1].Forma, "02");
  assert.equal(totParcial.FormasPago[1].Moneda, "VES");
  assert.equal(totParcial.FormasPago[1].Monto, "3800.00"); // 5860 - 2060 = 3800 Bs

  // Payload TFHKA con IGTF 100% conserva 1 sola entrada FormasPago ("09")
  const tfFull = construirDocumentoElectronicoTfhka({
    ...payloadBase,
    igtf_base_bs: 580000,
    igtf_base_usd: 11600,
    igtf_bs: 17400,
    igtf_usd: 348,
    total_bs: 597400,
    total_usd: 11948,
  });
  const totFull = (tfFull.DocumentoElectronico as any).Encabezado.Totales;
  assert.equal(totFull.FormasPago.length, 1);
  assert.equal(totFull.FormasPago[0].Forma, "09");

  // Salud BD verifica migración 0024 y triggers intactos sin descuadres de centavos
  const salud = await diagnosticarInquilino(db, env, { codigo: "principal" });
  assert.equal(salud.sano, true, `Salud BD falló: ${JSON.stringify(salud)}`);
  assert.equal(salud.migraciones_ok, true);
  assert.equal(salud.triggers_ok, true);
  assert.equal(salud.descuadres_centavos, 0);
});

test("v5.6.1 Separación fiscal IVA 0% (Exento / Exonerado / No Sujeto): Catálogo, Ventas, Compras, Resumen IVA, legacy e Imprentas", async () => {
  const { db, env, cookie, hoy } = await prepararEntornoSPE();

  // 1) Catálogo con las 3 clasificaciones de IVA 0%
  const catEx = await reqApi(env, "/api/catalogo", {
    method: "POST",
    cookie,
    body: { tipo: "PRODUCTO", nombre: "Medicina Básica", precio_usd: "20,00", alicuota_iva: "0", tipo_exencion: "EXENTA" },
  });
  const catExo = await reqApi(env, "/api/catalogo", {
    method: "POST",
    cookie,
    body: { tipo: "PRODUCTO", nombre: "Equipo Agrícola Decreto", precio_usd: "30,00", alicuota_iva: "0", tipo_exencion: "EXONERADA" },
  });
  const catNs = await reqApi(env, "/api/catalogo", {
    method: "POST",
    cookie,
    body: { tipo: "SERVICIO", nombre: "Reembolso de Gasto No Sujeto", precio_usd: "10,00", alicuota_iva: "0", tipo_exencion: "NO_SUJETA" },
  });
  assert.equal(catEx.status, 200, JSON.stringify(catEx.json));
  assert.equal(catExo.status, 200, JSON.stringify(catExo.json));
  assert.equal(catNs.status, 200, JSON.stringify(catNs.json));

  const getExo = await reqApi(env, `/api/catalogo/${catExo.json!.id}`, { cookie });
  assert.equal(getExo.json!.item.tipo_exencion, "EXONERADA");

  // 2) Factura mixta con 16% + Exenta + Exonerada + No Sujeta
  const cli = await reqApi(env, "/api/clientes", {
    method: "POST",
    cookie,
    body: { rif_cedula: "J-50999888-1", nombre_apellido: "Comprador RLIVA C.A.", direccion: "Valencia" },
  });
  const fac = await reqApi(env, "/api/documentos", {
    method: "POST",
    cookie,
    body: {
      tipo: "FACTURA",
      cliente_id: cli.json!.id,
      condicion: "CONTADO",
      aplica_igtf: 0,
      lineas: [
        { catalogo_id: catEx.json!.id, descripcion: "Medicina Básica", cantidad: "1", precio_usd: "20,00", alicuota_iva: 0, tipo_exencion: "EXENTA" },
        { catalogo_id: catExo.json!.id, descripcion: "Equipo Agrícola Decreto", cantidad: "1", precio_usd: "30,00", alicuota_iva: 0, tipo_exencion: "EXONERADA" },
        { catalogo_id: catNs.json!.id, descripcion: "Reembolso de Gasto No Sujeto", cantidad: "1", precio_usd: "10,00", alicuota_iva: 0, tipo_exencion: "NO_SUJETA" },
        { tipo: "SERVICIO", descripcion: "Soporte Gravado", cantidad: "1", precio_usd: "40,00", alicuota_iva: 16 },
      ],
    },
  });
  assert.equal(fac.status, 200, JSON.stringify(fac.json));
  const em = await reqApi(env, `/api/documentos/${fac.json!.id}/emitir`, { method: "POST", cookie });
  assert.equal(em.status, 200);

  const detFac = await reqApi(env, `/api/documentos/${fac.json!.id}`, { cookie });
  const imp0Fac = detFac.json!.impuestos.find((i: any) => i.alicuota_cent === 0);
  assert.equal(imp0Fac.base_usd, 6000);
  assert.equal(imp0Fac.exenta_usd, 2000);
  assert.equal(imp0Fac.exonerada_usd, 3000);
  assert.equal(imp0Fac.no_sujeta_usd, 1000);

  // 3) Libro de Ventas (API + modelo frontend)
  const libV = await reqApi(env, `/api/informes/ventas?desde=${hoy}&hasta=${hoy}`, { cookie });
  assert.equal(libV.status, 200);
  // Tasa 50 Bs/USD -> Exenta $20 = 1000 Bs (100000 cent), Exonerada $30 = 1500 Bs (150000), No Sujeta $10 = 500 Bs (50000)
  assert.equal(libV.json!.ventas_exentas_bs, 100000);
  assert.equal(libV.json!.ventas_exoneradas_bs, 150000);
  assert.equal(libV.json!.ventas_no_sujetas_bs, 50000);
  const modV = construirModelo("ventas", libV.json!);
  const colsV = modV.secciones[0].columnas.map((c: any) => c.t);
  assert.ok(colsV.includes("Exentas (Bs)"));
  assert.ok(colsV.includes("Exoneradas (Bs)"));
  assert.ok(colsV.includes("No Sujetas (Bs)"));

  // 4) Compra con GASTO Exenta + Exonerada + No Sujeta + Gravada 16%
  const prov = await reqApi(env, "/api/proveedores", {
    method: "POST",
    cookie,
    body: { rif: "J-40888777-2", nombre: "Proveedor Mixto C.A." },
  });
  const comp = await reqApi(env, "/api/compras", {
    method: "POST",
    cookie,
    body: {
      proveedor_id: prov.json!.id,
      factura_numero: "FAC-PROV-001",
      fecha: hoy,
      tasa_bcv: "50",
      lineas: [
        { tipo: "GASTO", categoria: "SERVICIOS", descripcion: "Gasto exento", cantidad: "1", costo_usd: "10,00", alicuota_iva: 0, tipo_exencion: "EXENTA" },
        { tipo: "GASTO", categoria: "FLETE", descripcion: "Gasto exonerado", cantidad: "1", costo_usd: "15,00", alicuota_iva: 0, tipo_exencion: "EXONERADA" },
        { tipo: "GASTO", categoria: "OTRO", descripcion: "Tasa municipal no sujeta", cantidad: "1", costo_usd: "5,00", alicuota_iva: 0, tipo_exencion: "NO_SUJETA" },
        { tipo: "GASTO", categoria: "ALQUILER", descripcion: "Alquiler gravado", cantidad: "1", costo_usd: "20,00", alicuota_iva: 16 },
      ],
    },
  });
  assert.equal(comp.status, 200, `Error compra: ${JSON.stringify(comp.json)}`);

  const libC = await reqApi(env, `/api/informes/compras?desde=${hoy}&hasta=${hoy}`, { cookie });
  assert.equal(libC.status, 200);
  assert.equal(libC.json!.compras_exentas_bs, 50000);
  assert.equal(libC.json!.compras_exoneradas_bs, 75000);
  assert.equal(libC.json!.compras_no_sujetas_bs, 25000);
  const modC = construirModelo("compras", libC.json!);
  const colsC = modC.secciones[0].columnas.map((c: any) => c.t);
  assert.ok(colsC.includes("Exentas (Bs)"));
  assert.ok(colsC.includes("Exoneradas (Bs)"));
  assert.ok(colsC.includes("No Sujetas (Bs)"));

  // 5) Resumen IVA y Alcaldía
  const resIva = await reqApi(env, `/api/informes/resumen-iva?desde=${hoy}&hasta=${hoy}`, { cookie });
  assert.equal(resIva.status, 200);
  const totIva = resIva.json!.total;
  assert.equal(totIva.ventas_gravadas_bs, 200000); // $40 * 50
  assert.equal(totIva.ventas_exentas_bs, 100000);
  assert.equal(totIva.ventas_exoneradas_bs, 150000);
  assert.equal(totIva.ventas_no_sujetas_bs, 50000);
  assert.equal(totIva.ventas_sin_iva_bs, 300000);
  assert.equal(totIva.ingresos_brutos_bs, 500000); // gravadas + exentas + exoneradas + no sujetas
  assert.equal(totIva.compras_exentas_bs, 50000);
  assert.equal(totIva.compras_exoneradas_bs, 75000);
  assert.equal(totIva.compras_no_sujetas_bs, 25000);
  const modIva = construirModelo("resumen-iva", resIva.json!);
  const colsIva = modIva.secciones[0].columnas.map((c: any) => c.t);
  assert.ok(colsIva.includes("Vtas. exoner."));
  assert.ok(colsIva.includes("Vtas. no suj."));
  assert.ok(colsIva.includes("Comp. exoner."));
  assert.ok(colsIva.includes("Comp. no suj."));

  // 6) Compatibilidad hacia atrás (fila histórica pre-0024 al 0% con exenta=0, exonerada=0, no_sujeta=0 -> clasifica 100% como EXENTA)
  const legacyIns = await db
    .prepare(
      `INSERT INTO documentos (tipo, estado, modo, numero, fecha_emision, cliente_id, condicion, tasa_e8, subtotal_usd, iva_usd, igtf_usd, total_usd, subtotal_bs, iva_bs, igtf_bs, total_bs)
       VALUES ('FACTURA', 'BORRADOR', 'REAL', '00000099', ?, ?, 'CONTADO', 5000000000, 1000, 0, 0, 1000, 50000, 0, 0, 50000)`
    )
    .bind(hoy, cli.json!.id)
    .run();
  const legacyId = Number(legacyIns.meta.last_row_id);
  await db
    .prepare(
      `INSERT INTO documento_impuestos (documento_id, alicuota_cent, base_usd, iva_usd, base_bs, iva_bs, exonerada_usd, no_sujeta_usd, exonerada_bs, no_sujeta_bs)
       VALUES (?, 0, 1000, 0, 50000, 0, 0, 0, 0, 0)`
    )
    .bind(legacyId)
    .run();
  await db.prepare(`UPDATE documentos SET estado = 'EMITIDO' WHERE id = ?`).bind(legacyId).run();

  const libVLegacy = await reqApi(env, `/api/informes/ventas?desde=${hoy}&hasta=${hoy}`, { cookie });
  // La factura original aporta 100000 exenta + 150000 exonerada + 50000 no sujeta; la histórica suma 50000 como exenta
  assert.equal(libVLegacy.json!.ventas_exentas_bs, 150000);
  assert.equal(libVLegacy.json!.ventas_exoneradas_bs, 150000);
  assert.equal(libVLegacy.json!.ventas_no_sujetas_bs, 50000);

  // 7) Imprentas Digitales (CG y TFHKA) mapean las 3 categorías IVA 0% a "E" / MontoExentoTotal
  const D = detFac.json!.documento;
  const payloadImp: PayloadImprentaDocumento = {
    documento_id: D.id,
    tipo_documento: "FACTURA",
    numero: D.numero,
    control_interno: D.control_interno,
    fecha_emision: D.fecha_emision,
    cliente_rif: "J-50999888-1",
    cliente_nombre: "Comprador RLIVA C.A.",
    subtotal_bs: D.subtotal_bs,
    iva_bs: D.iva_bs,
    igtf_bs: 0,
    total_bs: D.total_bs,
    subtotal_usd: D.subtotal_usd,
    iva_usd: D.iva_usd,
    igtf_usd: 0,
    total_usd: D.total_usd,
    tasa_e8: D.tasa_e8,
    renglones: detFac.json!.lineas,
    impuestos: detFac.json!.impuestos,
  };
  const cg = construirPayloadFacturaCg(payloadImp) as any;
  const tiposCg = cg.facturas[0].productos.map((p: any) => p.tipoImpuesto);
  assert.deepEqual(tiposCg, ["E", "E", "E", "G"]);

  const tf = construirDocumentoElectronicoTfhka(payloadImp);
  const detItems = (tf.DocumentoElectronico as any).DetallesItems;
  assert.deepEqual(detItems.map((it: any) => it.CodigoImpuesto), ["E", "E", "E", "G"]);
  assert.equal((tf.DocumentoElectronico as any).Encabezado.Totales.MontoExentoTotal, "3000.00");
});
