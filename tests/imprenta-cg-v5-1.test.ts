import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import {
  alicuotaATipoImpuestoCg,
  calcularResumenPlanImprenta,
  claveNumeroCg,
  codigoProductoCg,
  construirPayloadAnulacionCg,
  construirPayloadFacturaCg,
  construirPayloadNcParcialCg,
  construirPayloadNcTotalCg,
  construirPayloadNdCg,
  ejecutarSuiteCertificacionCg,
  extraerListaDocumentosCg,
  extraerRespuestaCg,
  formatearCantidadMilliCg,
  formatearCentavosCg,
  formatearFechaDdMmYyyy,
  formatearTasaCg,
  limpiarDocumentoIdentidadCg,
  normalizarCorreoCg,
  normalizarHostCg,
  normalizarTelefonoCg,
  normalizarTipoDocumentoCg,
  numeroDocumentoCg,
  validarUrlImprentaSegura,
  validarUrlPdfSegura,
} from "../src/imprenta-cg";

const CLAVE_TEST = "ClaveFiscalCgTest2026!";

async function reqJson(
  env: Record<string, unknown>,
  jar: Record<string, string>,
  ruta: string,
  method = "GET",
  body?: unknown
) {
  const headers: Record<string, string> = {};
  const cookie = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (cookie) headers["Cookie"] = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.fetch(
    new Request(`http://local${ruta}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env
  );
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    for (const part of setCookie.split(/,(?=\s*[a-zA-Z0-9_-]+=)/)) {
      const m = /^\s*([^=]+)=([^;]*)/.exec(part);
      if (m) {
        if (m[2] === "") delete jar[m[1].trim()];
        else jar[m[1].trim()] = m[2].trim();
      }
    }
  }
  const text = await res.text();
  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

// =========================================================================
// 1. Pruebas unitarias puras: SSRF, formateo en centavos y payloads CG v14
// =========================================================================
test("1. CG v14 puro: validación SSRF, URLs PDF, formateadores enteros y payloads exactos", () => {
  // SSRF y validación de URLs
  assert.equal(validarUrlImprentaSegura("https://calidad.cgimprenta.digital/").ok, true);
  assert.equal(validarUrlImprentaSegura("http://calidad.cgimprenta.digital/").ok, false);
  assert.equal(validarUrlImprentaSegura("https://localhost/api").ok, false);
  assert.equal(validarUrlImprentaSegura("https://127.0.0.1/api").ok, false);
  assert.equal(validarUrlImprentaSegura("https://169.254.169.254/latest/meta-data").ok, false);
  assert.equal(validarUrlImprentaSegura("https://user:pass@calidad.cgimprenta.digital/").ok, false);

  assert.equal(
    normalizarHostCg("https://calidad.cgimprenta.digital/api/Invoice/add_list_invoice"),
    "https://calidad.cgimprenta.digital/"
  );

  // Validación estricta de PDF URLs
  assert.equal(validarUrlPdfSegura("https://calidad.cgimprenta.digital/storage/doc.pdf"), "https://calidad.cgimprenta.digital/storage/doc.pdf");
  assert.equal(validarUrlPdfSegura("javascript:alert(1)"), null);
  assert.equal(validarUrlPdfSegura("http://calidad.cgimprenta.digital/doc.pdf"), null);
  assert.equal(validarUrlPdfSegura("https://127.0.0.1/doc.pdf"), null);

  // Formateadores con aritmética entera
  assert.equal(formatearFechaDdMmYyyy("2026-11-24"), "24-11-2026");
  assert.equal(formatearTasaCg(50_12340000), "50.1234");
  assert.equal(formatearCentavosCg(123456), "1234.56");
  assert.equal(formatearCentavosCg(5), "0.05");
  assert.equal(formatearCantidadMilliCg(2000), "2");
  assert.equal(formatearCantidadMilliCg(1250), "1.25");
  assert.equal(alicuotaATipoImpuestoCg(1600), "G");
  assert.equal(alicuotaATipoImpuestoCg(800), "R");
  assert.equal(alicuotaATipoImpuestoCg(3100), "A");
  assert.equal(alicuotaATipoImpuestoCg(0), "E");
  assert.equal(codigoProductoCg(42, 1), "PROD-42");
  assert.equal(codigoProductoCg(null, 3), "ITEM-3");
  assert.equal(codigoProductoCg(4, 1, "G"), "PROD-4-G");
  assert.equal(codigoProductoCg(4, 1, "E"), "PROD-4-E");
  assert.equal(codigoProductoCg(null, 1, "R"), "ITEM-1-R");
  assert.ok(codigoProductoCg(1234567890123, 1).length <= 13);
  assert.ok(codigoProductoCg(1234567890123, 1, "G").length <= 13);
  assert.ok(codigoProductoCg(1234567890123, 1, "G").endsWith("-G"));
  assert.equal(limpiarDocumentoIdentidadCg("J-40123456-7"), "J401234567");
  assert.equal(limpiarDocumentoIdentidadCg("19123456"), "V19123456");
  assert.equal(numeroDocumentoCg(7), "000007");

  // Payload Factura CG v14 (conversión exacta USD -> Bs. vía usdABs)
  const payloadFac = construirPayloadFacturaCg(
    {
      documento_id: 10,
      tipo_documento: "FACTURA",
      numero: 7,
      control_interno: 7,
      fecha_emision: "2026-11-24",
      cliente_rif: "J-30111222-3",
      cliente_nombre: "INVERSIONES CARACAS C.A.",
      cliente_email: "cliente@ejemplo.ve",
      cliente_direccion: "Chacao, Caracas",
      cliente_telefono: "0414-5551234",
      nota: "Servicio mensual",
      subtotal_bs: 500000,
      iva_bs: 80000,
      igtf_bs: 0,
      total_bs: 580000,
      subtotal_usd: 10000,
      iva_usd: 1600,
      igtf_usd: 0,
      total_usd: 11600,
      tasa_e8: 50_00000000,
      renglones: [
        { orden: 1, catalogo_id: 5, descripcion: "Soporte técnico", cantidad_milli: 2000, precio_usd: 5000, alicuota_cent: 1600 },
      ],
    },
    "A"
  );
  assert.equal(payloadFac.numeroSerie, "A");
  assert.equal(payloadFac.cantidadFactura, 1);
  const f0 = (payloadFac.facturas as any[])[0];
  assert.equal(f0.numeroFactura, "000007");
  assert.equal(f0.documentoIdentidadCliente, "J301112223");
  assert.equal(f0.tasa_del_dia, "50.0000");
  assert.equal(f0.fecha_tasa, "24-11-2026");
  assert.equal(f0.productos[0].codigoProducto, "PROD-5-G");
  assert.equal(f0.productos[0].tipoImpuesto, "G");
  assert.equal(f0.productos[0].cantidadAdquirida, "2");
  assert.equal(f0.productos[0].precioProducto, "2500.00"); // $50.00 * Bs 50.00 = Bs 2500.00

  // NC Total, NC Parcial, ND y Anulación
  const ncTot = construirPayloadNcTotalCg({
    documento_id: 11,
    tipo_documento: "NOTA_CREDITO",
    numero: 1,
    control_interno: 8,
    fecha_emision: "2026-11-24",
    cliente_rif: "J-30111222-3",
    cliente_nombre: "INVERSIONES CARACAS C.A.",
    factura_afectada_numero: 7,
    motivo_nc: "Devolución íntegra",
    es_nc_total: true,
    subtotal_bs: 0,
    iva_bs: 0,
    igtf_bs: 0,
    total_bs: 0,
    subtotal_usd: 0,
    iva_usd: 0,
    igtf_usd: 0,
    total_usd: 0,
    tasa_e8: 50_00000000,
  });
  assert.deepEqual(ncTot, {
    numeroFactura: "000007",
    numeroNotaCredito: "000001",
    descripcion: "Devolución íntegra",
  });

  const ncParc = construirPayloadNcParcialCg({
    documento_id: 12,
    tipo_documento: "NOTA_CREDITO",
    numero: 2,
    control_interno: 9,
    fecha_emision: "2026-11-24",
    cliente_rif: "J-30111222-3",
    cliente_nombre: "INVERSIONES CARACAS C.A.",
    factura_afectada_numero: 7,
    motivo_nc: "Devolución parcial",
    es_nc_total: false,
    subtotal_bs: 0,
    iva_bs: 0,
    igtf_bs: 0,
    total_bs: 0,
    subtotal_usd: 0,
    iva_usd: 0,
    igtf_usd: 0,
    total_usd: 0,
    tasa_e8: 50_00000000,
    renglones: [{ orden: 1, catalogo_id: 5, descripcion: "Soporte técnico", cantidad_milli: 1000 }],
  });
  assert.equal((ncParc.productos as any[])[0].codigo, "PROD-5");
  assert.equal((ncParc.productos as any[])[0].cantidad, "1");

  const ncParcConAlic = construirPayloadNcParcialCg({
    documento_id: 12,
    tipo_documento: "NOTA_CREDITO",
    numero: 2,
    control_interno: 9,
    fecha_emision: "2026-11-24",
    cliente_rif: "J-30111222-3",
    cliente_nombre: "INVERSIONES CARACAS C.A.",
    factura_afectada_numero: 7,
    motivo_nc: "Devolución parcial con alícuota",
    es_nc_total: false,
    subtotal_bs: 0,
    iva_bs: 0,
    igtf_bs: 0,
    total_bs: 0,
    subtotal_usd: 0,
    iva_usd: 0,
    igtf_usd: 0,
    total_usd: 0,
    tasa_e8: 50_00000000,
    renglones: [{ orden: 1, catalogo_id: 5, descripcion: "Soporte técnico", cantidad_milli: 1000, alicuota_cent: 1600 }],
  });
  assert.equal((ncParcConAlic.productos as any[])[0].codigo, "PROD-5-G");

  const ndPay = construirPayloadNdCg({
    documento_id: 13,
    tipo_documento: "NOTA_DEBITO",
    numero: 1,
    control_interno: 10,
    fecha_emision: "2026-11-24",
    cliente_rif: "J-30111222-3",
    cliente_nombre: "INVERSIONES CARACAS C.A.",
    factura_afectada_numero: 7,
    motivo_nc: "Recargo de envío",
    subtotal_bs: 0,
    iva_bs: 0,
    igtf_bs: 0,
    total_bs: 0,
    subtotal_usd: 0,
    iva_usd: 0,
    igtf_usd: 0,
    total_usd: 0,
    tasa_e8: 50_00000000,
    renglones: [{ orden: 1, descripcion: "Envío expreso", cantidad_milli: 1000, precio_usd: 1000, alicuota_cent: 1600 }],
  });
  assert.equal(ndPay.numeroNotaDebito, "000001");
  assert.equal((ndPay.productos_nuevos as any[])[0].precioProducto, "500.00");

  const anulPay = construirPayloadAnulacionCg(7, "00-00000123");
  assert.deepEqual(anulPay, { numero_documento: "000007", numero_control: "00-00000123" });

  // Parseo de respuesta exitosa y errores (incluyendo sin cupo)
  const okRes = extraerRespuestaCg({
    invoice_list_success: [
      { invoice_number: "000007", control_number: "00-00001001", invoice_pdf: "https://calidad.cgimprenta.digital/pdf/1001.pdf" },
    ],
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.control_fiscal, "00-00001001");
  assert.equal(okRes.pdf_url, "https://calidad.cgimprenta.digital/pdf/1001.pdf");

  const sinCupo = extraerRespuestaCg({
    invoice_errors: [{ message: "El contribuyente no posee más números de control disponibles" }],
  });
  assert.equal(sinCupo.ok, false);
  assert.equal(sinCupo.sin_cupo, true);

  // CG v14 reales: nested invoices[0], normalización de tipos, 50-char NC/ND, credit_note_pdf, debit_note_pdf, duplicada y Coletilla
  const listaPlana = extraerListaDocumentosCg({
    success: true,
    invoices: [
      [
        { document: "FACTURA", invoice_number: "000005", control_number: "00-00000456", invoice_pdf: "https://calidad.cgimprenta.digital/readonly/export_pdf/5" },
        { document: "NOTA DE CREDITO", invoice_number: "000001", control_number: "00-00000457", credit_note_pdf: "https://calidad.cgimprenta.digital/readonly/export_pdf/nc1" },
      ],
    ],
  });
  assert.equal(listaPlana.length, 2);
  assert.equal(listaPlana[0].invoice_number, "000005");
  assert.equal(normalizarTipoDocumentoCg("FACTURA"), "FACTURA");
  assert.equal(normalizarTipoDocumentoCg("NOTA DE CREDITO"), "NOTA_CREDITO");
  assert.equal(normalizarTipoDocumentoCg("Nota de Débito"), "NOTA_DEBITO");
  assert.equal(normalizarTipoDocumentoCg("ORDEN DE ENTREGA"), "OTRO");
  assert.equal(claveNumeroCg("000005"), "5");
  assert.equal(claveNumeroCg("00000005"), "5");

  // Factura sin nota omite `descripcionFactura` para no chocar con Coletilla/Mensaje Fijo en CG
  const facSinNota = construirPayloadFacturaCg(
    {
      documento_id: 20,
      tipo_documento: "FACTURA",
      numero: 8,
      control_interno: 8,
      fecha_emision: "2026-11-25",
      cliente_rif: "J-30111222-3",
      cliente_nombre: "CLIENTE SIN NOTA",
      nota: "",
      subtotal_bs: 10000,
      iva_bs: 1600,
      igtf_bs: 0,
      total_bs: 11600,
      subtotal_usd: 200,
      iva_usd: 32,
      igtf_usd: 0,
      total_usd: 232,
      tasa_e8: 50_00000000,
      renglones: [{ orden: 1, descripcion: "Consulta", cantidad_milli: 1000, precio_usd: 200, alicuota_cent: 1600 }],
    },
    "A"
  );
  assert.equal("descripcionFactura" in (facSinNota.facturas as any[])[0], false);

  // Límite estricto de 50 caracteres en NC/ND según validación CG v14
  const motivoLargo = "Devolución por mercancía con empaque averiado durante el transporte interurbano hacia el cliente";
  const ncLarga = construirPayloadNcTotalCg({
    documento_id: 21,
    tipo_documento: "NOTA_CREDITO",
    numero: 3,
    control_interno: 11,
    fecha_emision: "2026-11-25",
    cliente_rif: "J-30111222-3",
    cliente_nombre: "CLIENTE",
    factura_afectada_numero: 8,
    motivo_nc: motivoLargo,
    subtotal_bs: 0,
    iva_bs: 0,
    igtf_bs: 0,
    total_bs: 0,
    subtotal_usd: 0,
    iva_usd: 0,
    igtf_usd: 0,
    total_usd: 0,
    tasa_e8: 50_00000000,
  });
  assert.ok(String(ncLarga.descripcion).length <= 50);

  // Respuesta real de factura duplicada en CG (`invoice_errors: ["000005"]`)
  const dupRes = extraerRespuestaCg({
    success: true,
    message: "Error: facturas ya registradas.",
    invoice_errors: ["000005"],
    invoice_list_success: [],
  });
  assert.equal(dupRes.ok, false);
  assert.equal(dupRes.duplicada, true);
  assert.match(String(dupRes.error), /facturas ya registradas.*000005/i);

  // Respuestas reales NC (`credit_note_pdf`) y ND (`debit_note_pdf`) a nivel raíz
  const ncPdfRes = extraerRespuestaCg({
    success: true,
    control_number: "00-00002001",
    credit_note_pdf: "https://calidad.cgimprenta.digital/readonly/export_pdf/nc-2001",
  });
  assert.equal(ncPdfRes.ok, true);
  assert.equal(ncPdfRes.pdf_url, "https://calidad.cgimprenta.digital/readonly/export_pdf/nc-2001");

  const ndPdfRes = extraerRespuestaCg({
    success: true,
    control_number: "00-00002002",
    debit_note_pdf: "https://calidad.cgimprenta.digital/readonly/export_pdf/nd-2002",
  });
  assert.equal(ndPdfRes.ok, true);
  assert.equal(ndPdfRes.pdf_url, "https://calidad.cgimprenta.digital/readonly/export_pdf/nd-2002");

  // Conflicto de Coletilla / Mensaje Fijo
  const colRes = extraerRespuestaCg(
    {
      success: false,
      message: "No se puede procesar la factura N° 000005 con Descripción de Factura, ya que la empresa tiene una Coletilla / Mensaje Fijo activo.",
    },
    "FACTURA",
    400
  );
  assert.equal(colRes.ok, false);
  assert.equal(colRes.coletilla_conflicto, true);
});

// =========================================================================
// 2. Pruebas unitarias puras del medidor/visor de plan y alertas
// =========================================================================
test("2. Medidor de plan CG: umbrales SIN_PLAN, OK, AVISO, CRITICO, AGOTADO, VENCIDO y cómputo de anuladas", () => {
  const base = {
    plan_nombre: "Emprende II (500 números)",
    plan_cupo_total: 500,
    plan_consumo_previo: 0,
    plan_fecha_pago: "2026-01-15",
    plan_fecha_vence: "2027-01-15",
    facturas_ok: 10,
    nc_ok: 2,
    nd_ok: 1,
    anuladas_ok: 2,
    pendientes: 1,
    errores: 0,
    total_intentos_envio: 16,
    hoyIso: "2026-11-24",
  };

  // Sin plan
  const rSin = calcularResumenPlanImprenta({ ...base, plan_cupo_total: 0 });
  assert.equal(rSin.nivel_alerta, "SIN_PLAN");
  assert.equal(rSin.disponibles, null);

  // OK (10 + 2 + 1 + 2 = 15 consumidas -> 485 disponibles)
  const rOk = calcularResumenPlanImprenta(base);
  assert.equal(rOk.enviadas_ok, 15);
  assert.equal(rOk.consumidas_total, 15);
  assert.equal(rOk.disponibles, 485);
  assert.equal(rOk.nivel_alerta, "OK");

  // AVISO al 80%
  const rAviso = calcularResumenPlanImprenta({ ...base, facturas_ok: 400, nc_ok: 0, nd_ok: 0, anuladas_ok: 0 });
  assert.equal(rAviso.porcentaje_uso, 80);
  assert.equal(rAviso.nivel_alerta, "AVISO");

  // CRITICO al quedar <= 10 o >= 95%
  const rCrit = calcularResumenPlanImprenta({ ...base, facturas_ok: 492, nc_ok: 0, nd_ok: 0, anuladas_ok: 0 });
  assert.equal(rCrit.disponibles, 8);
  assert.equal(rCrit.nivel_alerta, "CRITICO");

  // AGOTADO al consumir el 100% (incluyendo consumo previo)
  const rAgot = calcularResumenPlanImprenta({ ...base, plan_consumo_previo: 485 });
  assert.equal(rAgot.disponibles, 0);
  assert.equal(rAgot.nivel_alerta, "AGOTADO");

  // VENCIDO por fecha de vigencia anual superada
  const rVenc = calcularResumenPlanImprenta({ ...base, plan_fecha_vence: "2026-11-20" });
  assert.equal(rVenc.nivel_alerta, "VENCIDO");
  assert.equal(rVenc.dias_restantes_plan, -4);
});

// =========================================================================
// 3. Flujo integral HTTP E2E con CG v14 mockeado, contador ida/vuelta, conciliación, recargas y RBAC
// =========================================================================
test("3. Flujo E2E CG La Imprenta Digital: config cifrada, emitir/NC/ND/anular, 401 refresh, conciliación, recarga y RBAC", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-maestra-cg-test-v510" };
  const jarAdmin: Record<string, string> = {};

  // Instalar empresa en modalidad IMPRENTA_DIGITAL
  env.SUPER_ADMIN_EMAIL = "admin@cgtest.ve";
  const inst = await reqJson(env, jarAdmin, "/api/instalar", "POST", {
    nombre: "SOLUCIONES DIGITALES VE C.A.",
    rif: "J-40998877-1",
    direccion: "Av. Libertador, Caracas",
    telefono: "0414-5550000",
    email: "admin@cgtest.ve",
    clave: CLAVE_TEST,
    tipo_contribuyente: "ORDINARIO",
    medio_facturacion: "IMPRENTA_DIGITAL",
  });
  assert.equal(inst.status, 200);
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv = '50.00', tasa_bcv_fecha = ? WHERE id = 1`).bind(new Date().toISOString()).run();
  await db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`).run();

  // Rechazo SSRF en configuración de imprenta
  const ssrf1 = await reqJson(env, jarAdmin, "/api/sistema/imprenta", "POST", {
    proveedor_tipo: "CG_IMPRENTA",
    proveedor: "CG La Imprenta Digital",
    url: "http://127.0.0.1:8080/",
    usuario: "demo@prueba.invalid",
    clave: "clave-api-falsa-9999",
    password: CLAVE_TEST,
    confirmo: true,
  });
  assert.equal(ssrf1.status, 400);

  const ssrf2 = await reqJson(env, jarAdmin, "/api/sistema/imprenta", "POST", {
    proveedor_tipo: "CG_IMPRENTA",
    proveedor: "CG La Imprenta Digital",
    url: "https://169.254.169.254/latest",
    usuario: "demo@prueba.invalid",
    clave: "clave-api-falsa-9999",
    password: CLAVE_TEST,
    confirmo: true,
  });
  assert.equal(ssrf2.status, 400);

  // Configurar CG La Imprenta Digital con plan 500 y fecha pagada (credenciales sintéticas de prueba)
  const cfgSave = await reqJson(env, jarAdmin, "/api/sistema/imprenta", "POST", {
    proveedor_tipo: "CG_IMPRENTA",
    proveedor: "CG La Imprenta Digital",
    url: "https://calidad.cgimprenta.digital/",
    usuario: "usuario-sintetico@prueba.invalid",
    clave: "secreto-sintetico-cg-2026",
    ambiente: "PRUEBAS",
    serie: "A",
    plan_nombre: "Emprende II (500 números)",
    plan_cupo_total: 500,
    plan_fecha_pago: "2026-11-01",
    plan_fecha_vence: "2027-11-01",
    plan_consumo_previo: 0,
    plan_nota: "Plan contratado de prueba",
    password: CLAVE_TEST,
    confirmo: true,
  });
  assert.equal(cfgSave.status, 200, `Error guardando config CG: ${JSON.stringify(cfgSave.data)}`);

  // Verificar que la contraseña API está cifrada en D1 y nunca en texto claro
  const rowClave = await db.prepare(`SELECT valor FROM integraciones WHERE clave = 'imprenta_clave'`).first<{ valor: string }>();
  assert.ok(rowClave?.valor && !rowClave.valor.includes("secreto-sintetico-cg-2026"), "La clave API debe cifrarse en reposo");

  // Verificar que GET /api/sistema/medio nunca expone la contraseña clara
  const medioGet = await reqJson(env, jarAdmin, "/api/sistema/medio");
  assert.equal(medioGet.status, 200);
  assert.equal(medioGet.data.imprenta.proveedor_tipo, "CG_IMPRENTA");
  assert.equal(medioGet.data.imprenta.clave_configurada, true);
  assert.equal(medioGet.data.imprenta.clave_clara, undefined);

  // Mock de la API Gateway CG v14
  const llamadas: { url: string; method: string; body: any; auth: string | null }[] = [];
  let tokenNum = 0;
  let forzar401UnaVez = false;
  let fallarAddInvoice = false;
  const remotosCg: any[] = [];
  let seqCtrl = 1000;

  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    llamadas.push({ url, method, body, auth });

    if (url.endsWith("/api/Invoice/create_token_authenticator")) {
      tokenNum++;
      return new Response(JSON.stringify({ success: true, token: `jwt-sintetico-${tokenNum}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (forzar401UnaVez) {
      forzar401UnaVez = false;
      return new Response(JSON.stringify({ message: "Token expirado" }), { status: 401 });
    }

    if (url.includes("/api/Invoice/payments_methods")) {
      return new Response(JSON.stringify({ payment_methods: [{ id: 1, name: "Efectivo" }, { id: 2, name: "Pago Móvil" }] }), {
        status: 200,
      });
    }

    if (url.endsWith("/api/Invoice/add_list_invoice")) {
      const f = body.facturas[0];
      if (fallarAddInvoice) {
        // Simula caída de red después de que CG sí la timbró (para probar conciliación)
        seqCtrl++;
        const ctrl = `00-0000${seqCtrl}`;
        remotosCg.push({
          invoice_number: f.numeroFactura,
          control_number: ctrl,
          invoice_pdf: `https://calidad.cgimprenta.digital/pdf/${ctrl}.pdf`,
          status: "EMITIDA",
        });
        return new Response(JSON.stringify({ message: "Gateway timeout" }), { status: 503 });
      }
      seqCtrl++;
      const ctrl = `00-0000${seqCtrl}`;
      const pdf = `https://calidad.cgimprenta.digital/pdf/${ctrl}.pdf`;
      remotosCg.push({ invoice_number: f.numeroFactura, control_number: ctrl, invoice_pdf: pdf, status: "EMITIDA" });
      return new Response(
        JSON.stringify({
          invoice_list_success: [{ invoice_number: f.numeroFactura, control_number: ctrl, invoice_pdf: pdf }],
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/Invoice/add_credit_note_with_products") || url.endsWith("/api/Invoice/add_credit_note")) {
      seqCtrl++;
      const ctrl = `00-0000${seqCtrl}`;
      return new Response(
        JSON.stringify({
          success: true,
          control_number: ctrl,
          credit_note_pdf: `https://calidad.cgimprenta.digital/readonly/export_pdf/nc-${ctrl}`,
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/Invoice/add_debit_note")) {
      seqCtrl++;
      const ctrl = `00-0000${seqCtrl}`;
      return new Response(
        JSON.stringify({
          success: true,
          control_number: ctrl,
          debit_note_pdf: `https://calidad.cgimprenta.digital/readonly/export_pdf/nd-${ctrl}`,
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/Invoice/cancel_invoice")) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Factura anulada exitosamente.",
          details: {
            pdf_factura: `https://calidad.cgimprenta.digital/readonly/export_pdf/anulada-${body.numero_control}`,
          },
        }),
        { status: 200 }
      );
    }

    if (url.includes("/api/Invoice/get_list_invoices")) {
      // Formato real oficial CG v14: arreglo bidimensional `invoices: [ [ ... ] ]`
      return new Response(JSON.stringify({ success: true, invoices: [remotosCg] }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "Ruta mock no contemplada" }), { status: 404 });
  }) as typeof fetch;

  try {
    // 1) Probar conexión CG (genera y cachea JWT cifrado)
    const probar = await reqJson(env, jarAdmin, "/api/sistema/imprenta/probar", "POST", {});
    assert.equal(probar.status, 200, `Probar falló: ${JSON.stringify(probar.data)}`);
    assert.equal(probar.data.ok, true);
    assert.equal(probar.data.metodos_pago, 2);

    const jwtRow = await db.prepare(`SELECT valor FROM integraciones WHERE clave = 'imprenta_cg_jwt'`).first<{ valor: string }>();
    assert.ok(jwtRow?.valor && !jwtRow.valor.includes("jwt-sintetico-1"), "El JWT cacheado debe almacenarse cifrado");

    // 2) Crear cliente y emitir Factura #1
    const cli = await reqJson(env, jarAdmin, "/api/clientes", "POST", {
      rif_cedula: "J-30111222-3",
      nombre_apellido: "COMERCIAL ANDINA C.A.",
      direccion: "Mérida, Venezuela",
      email: "compras@andina.test",
      telefono: "0412-1234567",
    });
    assert.equal(cli.status, 200);

    const f1 = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Licencia anual", cantidad: "2", precio_usd: "40,00", alicuota_iva: 16 }],
    });
    const em1 = await reqJson(env, jarAdmin, `/api/documentos/${f1.data.id}/emitir`, "POST", {});
    assert.equal(em1.status, 200);
    assert.equal(em1.data.control_fiscal, "00-00001001");
    assert.equal(em1.data.imprenta_pdf_url, "https://calidad.cgimprenta.digital/pdf/00-00001001.pdf");

    // Verificar payload exacto enviado a add_list_invoice
    const callFac1 = llamadas.find((l) => l.url.endsWith("/api/Invoice/add_list_invoice"));
    assert.ok(callFac1);
    assert.equal(callFac1.body.numeroSerie, "A");
    assert.equal(callFac1.body.facturas[0].productos[0].precioProducto, "2000.00"); // $40 * 50 Bs

    // Verificar detalle del documento incluye imprenta_envio + pdf_url oficial
    const det1 = await reqJson(env, jarAdmin, `/api/documentos/${f1.data.id}`);
    assert.equal(det1.status, 200);
    assert.equal(det1.data.imprenta_envio.estado, "ENVIADO_OK");
    assert.equal(det1.data.imprenta_envio.pdf_url, "https://calidad.cgimprenta.digital/pdf/00-00001001.pdf");

    // 3) Emitir Nota de Crédito PARCIAL (1 de 2 unidades) -> usa add_credit_note_with_products
    const ncParcial = await reqJson(env, jarAdmin, `/api/documentos/${f1.data.id}/devolver`, "POST", {
      motivo: "Devolución de una licencia",
      lineas: [{ orden: 1, cantidad: "1" }],
    });
    assert.equal(ncParcial.status, 200, `NC parcial falló: ${JSON.stringify(ncParcial.data)}`);
    assert.equal(ncParcial.data.control_fiscal, "00-00001002");
    assert.ok(llamadas.some((l) => l.url.endsWith("/api/Invoice/add_credit_note_with_products")));

    // 4) Emitir Nota de Débito -> usa add_debit_note
    const nd1 = await reqJson(env, jarAdmin, `/api/documentos/${f1.data.id}/nota-debito`, "POST", {
      motivo: "Ajuste por soporte extendido",
      lineas: [{ descripcion: "Soporte extra", cantidad: "1", precio_usd: "10,00", alicuota_iva: 16 }],
    });
    assert.equal(nd1.status, 200, `ND falló: ${JSON.stringify(nd1.data)}`);
    assert.equal(nd1.data.control_fiscal, "00-00001003");
    assert.ok(llamadas.some((l) => l.url.endsWith("/api/Invoice/add_debit_note")));

    // 5) Emitir Factura #2 con 401 transitorio (valida auto-renovación JWT) y luego ANULARLA en CG
    forzar401UnaVez = true;
    const f2 = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Instalación", cantidad: "1", precio_usd: "25,00", alicuota_iva: 16 }],
    });
    const em2 = await reqJson(env, jarAdmin, `/api/documentos/${f2.data.id}/emitir`, "POST", {});
    assert.equal(em2.status, 200);
    assert.equal(em2.data.control_fiscal, "00-00001004");
    assert.ok(tokenNum >= 2, "Debe haber renovado automáticamente el JWT tras HTTP 401");

    const an2 = await reqJson(env, jarAdmin, `/api/documentos/${f2.data.id}/anular`, "POST", {
      motivo: "Error de carga del cliente en el mismo día",
    });
    assert.equal(an2.status, 200, `Anulación falló: ${JSON.stringify(an2.data)}`);
    assert.equal(an2.data.imprenta_anulacion.ok, true);
    assert.ok(llamadas.some((l) => l.url.endsWith("/api/Invoice/cancel_invoice")));

    // Verificar contadores antes de la falla de red (1 fac + 1 NC + 1 ND + 1 anulada = 4 consumidas -> 496 disponibles)
    const est1 = await reqJson(env, jarAdmin, "/api/sistema/imprenta/estado");
    assert.equal(est1.status, 200);
    assert.equal(est1.data.resumen.facturas_ok, 1);
    assert.equal(est1.data.resumen.nc_ok, 1);
    assert.equal(est1.data.resumen.nd_ok, 1);
    assert.equal(est1.data.resumen.anuladas_ok, 1);
    assert.equal(est1.data.resumen.enviadas_ok, 4);
    assert.equal(est1.data.resumen.disponibles, 496);

    // 6) Emitir Factura #3 con timeout 503 simulado -> queda PENDIENTE y luego se recupera por Conciliación
    fallarAddInvoice = true;
    const f3 = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Mantenimiento", cantidad: "1", precio_usd: "30,00", alicuota_iva: 16 }],
    });
    const em3 = await reqJson(env, jarAdmin, `/api/documentos/${f3.data.id}/emitir`, "POST", {});
    assert.equal(em3.status, 200);
    assert.equal(em3.data.control_fiscal, undefined);
    fallarAddInvoice = false;

    const estPend = await reqJson(env, jarAdmin, "/api/sistema/imprenta/estado");
    assert.equal(estPend.data.resumen.pendientes, 1);

    // Conciliar contra CG -> recupera automáticamente control_fiscal y pdf_url de Factura #3
    const conc = await reqJson(env, jarAdmin, "/api/sistema/imprenta/conciliar", "POST", {});
    assert.equal(conc.status, 200, `Conciliar falló: ${JSON.stringify(conc.data)}`);
    assert.equal(conc.data.ok, true);
    assert.equal(conc.data.conciliacion.recuperados, 1);

    const det3 = await reqJson(env, jarAdmin, `/api/documentos/${f3.data.id}`);
    assert.equal(det3.data.documento.control_fiscal, "00-00001005");
    assert.equal(det3.data.imprenta_envio.estado, "ENVIADO_OK");

    const estRecup = await reqJson(env, jarAdmin, "/api/sistema/imprenta/estado");
    assert.equal(estRecup.data.resumen.pendientes, 0);
    assert.equal(estRecup.data.resumen.enviadas_ok, 5);
    assert.equal(estRecup.data.resumen.disponibles, 495);

    // 7) Registrar una recarga de +500 números de control -> exige confirmación explícita y luego suma al cupo
    const recSinConf = await reqJson(env, jarAdmin, "/api/sistema/imprenta/recarga", "POST", {
      cantidad_numeros: 500,
      fecha_pago: "2026-11-24",
    });
    assert.equal(recSinConf.status, 400);

    const rec = await reqJson(env, jarAdmin, "/api/sistema/imprenta/recarga", "POST", {
      plan_nombre: "Recarga Emprende II (+500)",
      cantidad_numeros: 500,
      fecha_pago: "2026-11-24",
      fecha_vence: "2027-11-24",
      monto_usd_centavos: 12000,
      referencia: "ZELLE-778899",
      nota: "Ampliación de lote",
      password: CLAVE_TEST,
      confirmo: true,
    });
    assert.equal(rec.status, 200, `Recarga falló: ${JSON.stringify(rec.data)}`);
    assert.equal(rec.data.nuevo_cupo, 1000);
    assert.equal(rec.data.imprenta_estado.resumen.disponibles, 995);
    assert.equal(rec.data.imprenta_estado.recargas.length, 2);
    assert.equal(rec.data.imprenta_estado.recargas[0].monto_usd_centavos, 12000);

    // 8) RBAC: CAJERO puede leer el visor (/api/imprenta/visor sin secretos) pero recibe 403 en configuración/recargas
    const crearCajero = await reqJson(env, jarAdmin, "/api/usuarios", "POST", {
      nombre: "Cajero Caja 1",
      email: "cajero@cgtest.ve",
      rol: "CAJERO",
    });
    assert.equal(crearCajero.status, 200);
    const claveCajero = String(crearCajero.data.clave_temporal ?? "");
    assert.ok(claveCajero.length >= 6);

    const jarCajero: Record<string, string> = {};
    const loginCaj = await reqJson(env, jarCajero, "/api/login", "POST", {
      email: "cajero@cgtest.ve",
      clave: claveCajero,
    });
    assert.equal(loginCaj.status, 200);
    const cambioCaj = await reqJson(env, jarCajero, "/api/cuenta/clave", "POST", {
      actual: claveCajero,
      nueva: CLAVE_TEST,
    });
    assert.equal(cambioCaj.status, 200);

    const visorCaj = await reqJson(env, jarCajero, "/api/imprenta/visor");
    assert.equal(visorCaj.status, 200);
    assert.equal(visorCaj.data.resumen.plan_cupo_total, 1000);
    assert.equal(visorCaj.data.resumen.enviadas_ok, 5);
    assert.equal(visorCaj.data.resumen.disponibles, 995);
    assert.equal(visorCaj.data.config, undefined);

    const cajBloq1 = await reqJson(env, jarCajero, "/api/sistema/imprenta/recarga", "POST", {
      cantidad_numeros: 100,
      fecha_pago: "2026-11-24",
    });
    assert.equal(cajBloq1.status, 403);

    const cajBloq2 = await reqJson(env, jarCajero, "/api/sistema/imprenta", "POST", {
      proveedor_tipo: "CG_IMPRENTA",
      url: "https://calidad.cgimprenta.digital/",
      password: CLAVE_TEST,
      confirmo: true,
    });
    assert.equal(cajBloq2.status, 403);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

// =========================================================================
// 4. Regresiones reales CG Calidad v14: duplicada auto-recuperada, Coletilla auto-retry y 404 vacío
// =========================================================================
test("4. Regresiones CG Calidad v14: auto-recuperación de factura duplicada, reintento sin descripcionFactura por Coletilla y 404 vacío en conciliación", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-maestra-cg-test-v511", SUPER_ADMIN_EMAIL: "admin@cgv511.ve" };
  const jarAdmin: Record<string, string> = {};

  const inst = await reqJson(env, jarAdmin, "/api/instalar", "POST", {
    nombre: "LABORATORIO CLINICO PRUEBA C.A.",
    rif: "J-40123999-0",
    direccion: "Av. Bolívar, Valencia",
    telefono: "0414-5559999",
    email: "admin@cgv511.ve",
    clave: CLAVE_TEST,
    tipo_contribuyente: "ORDINARIO",
    medio_facturacion: "IMPRENTA_DIGITAL",
  });
  assert.equal(inst.status, 200);
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv = '50.00', tasa_bcv_fecha = ? WHERE id = 1`).bind(new Date().toISOString()).run();
  await db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`).run();

  const cfgSave = await reqJson(env, jarAdmin, "/api/sistema/imprenta", "POST", {
    proveedor_tipo: "CG_IMPRENTA",
    proveedor: "CG La Imprenta Digital",
    url: "https://calidad.cgimprenta.digital/",
    usuario: "usuario-calidad-sintetico@prueba.invalid",
    clave: "clave-calidad-sintetica-2026",
    ambiente: "PRUEBAS",
    serie: "A",
    plan_nombre: "Emprende I (100 números)",
    plan_cupo_total: 100,
    plan_fecha_pago: "2026-11-24",
    plan_fecha_vence: "2027-11-24",
    password: CLAVE_TEST,
    confirmo: true,
  });
  assert.equal(cfgSave.status, 200);

  const cli = await reqJson(env, jarAdmin, "/api/clientes", "POST", {
    rif_cedula: "J-41111222-3",
    nombre_apellido: "LABORATORIO AVILAB",
    direccion: "Caracas",
    email: "contacto@avilab.test",
    telefono: "0414-1112222",
  });
  assert.equal(cli.status, 200);

  let remotos: any[] = [];
  let intentosAddFac2 = 0;

  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (url.endsWith("/api/Invoice/create_token_authenticator")) {
      return new Response(JSON.stringify({ success: true, token: "jwt-v511-sintetico" }), { status: 200 });
    }

    if (url.includes("/api/Invoice/get_list_invoices")) {
      // Cuando no hay documentos, CG v14 responde HTTP 404 ("No se encontraron datos")
      if (remotos.length === 0) {
        return new Response(JSON.stringify({ status: false, message: "No se encontraron datos" }), { status: 404 });
      }
      return new Response(JSON.stringify({ success: true, invoices: [remotos] }), { status: 200 });
    }

    if (url.endsWith("/api/Invoice/add_list_invoice")) {
      const f = body.facturas[0];
      // Factura 000001: ya existe en servidor CG -> responde con `invoice_errors: ["000001"]`
      if (f.numeroFactura === "000001") {
        remotos = [
          {
            document: "FACTURA",
            invoice_number: "000001",
            control_number: "00-00009001",
            status: "Emitida",
            invoice_pdf: "https://calidad.cgimprenta.digital/readonly/export_pdf/9001",
          },
        ];
        return new Response(
          JSON.stringify({
            success: true,
            message: "Error: facturas ya registradas.",
            invoice_errors: ["000001"],
            invoice_list_success: [],
          }),
          { status: 200 }
        );
      }

      // Factura 000002: tiene nota -> primer intento trae descripcionFactura y choca con Coletilla fija en CG
      if (f.numeroFactura === "000002") {
        intentosAddFac2++;
        if (f.descripcionFactura) {
          return new Response(
            JSON.stringify({
              success: false,
              message: "No se puede procesar la factura N° 000002 con Descripción de Factura, ya que la empresa tiene una Coletilla / Mensaje Fijo activo.",
            }),
            { status: 400 }
          );
        }
        const pdf2 = "https://calidad.cgimprenta.digital/readonly/export_pdf/9002";
        remotos.push({
          document: "FACTURA",
          invoice_number: "000002",
          control_number: "00-00009002",
          status: "Emitida",
          invoice_pdf: pdf2,
        });
        return new Response(
          JSON.stringify({
            success: true,
            invoice_list_success: [{ invoice_number: "000002", control_number: "00-00009002", invoice_pdf: pdf2 }],
          }),
          { status: 200 }
        );
      }
    }

    return new Response(JSON.stringify({ error: "Ruta no esperada" }), { status: 404 });
  }) as typeof fetch;

  try {
    // Escenario C: Conciliar cuando el servidor CG aún tiene 0 facturas (HTTP 404) -> debe responder 200 OK con 0
    const concVacia = await reqJson(env, jarAdmin, "/api/sistema/imprenta/conciliar", "POST", {});
    assert.equal(concVacia.status, 200, `Conciliar vacío no debe fallar con 404: ${JSON.stringify(concVacia.data)}`);
    assert.equal(concVacia.data.conciliacion.total_cg, 0);

    // Escenario A: Emitir Factura #1 -> CG devuelve `invoice_errors: ["000001"]` -> FacturaYa auto-recupera vía get_list_invoices
    const f1 = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Análisis de sangre", cantidad: "1", precio_usd: "15,00", alicuota_iva: 0 }],
    });
    const em1 = await reqJson(env, jarAdmin, `/api/documentos/${f1.data.id}/emitir`, "POST", {});
    assert.equal(em1.status, 200);
    assert.equal(em1.data.control_fiscal, "00-00009001");
    assert.equal(em1.data.imprenta_pdf_url, "https://calidad.cgimprenta.digital/readonly/export_pdf/9001");

    const det1 = await reqJson(env, jarAdmin, `/api/documentos/${f1.data.id}`);
    assert.equal(det1.data.documento.control_fiscal, "00-00009001");
    assert.equal(det1.data.imprenta_envio.estado, "ENVIADO_OK");

    // Escenario B: Emitir Factura #2 CON nota -> primer intento choca con Coletilla y reintenta automáticamente sin `descripcionFactura`
    const f2 = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      nota: "Garantía 30 días",
      lineas: [{ tipo: "SERVICIO", descripcion: "Perfil bioquímico", cantidad: "1", precio_usd: "20,00", alicuota_iva: 0 }],
    });
    const em2 = await reqJson(env, jarAdmin, `/api/documentos/${f2.data.id}/emitir`, "POST", {});
    assert.equal(em2.status, 200);
    assert.equal(intentosAddFac2, 2, "Debe reintentar automáticamente sin descripcionFactura tras error de Coletilla");
    assert.equal(em2.data.control_fiscal, "00-00009002");

    // Verificar conciliación final con 2 documentos en el arreglo bidimensional `invoices: [[...]]`
    const concFinal = await reqJson(env, jarAdmin, "/api/sistema/imprenta/conciliar", "POST", {});
    assert.equal(concFinal.status, 200);
    assert.equal(concFinal.data.conciliacion.total_cg, 2);
    assert.equal(concFinal.data.conciliacion.total_local, 2);
    assert.equal(concFinal.data.conciliacion.diferencia, 0);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

// =========================================================================
// 5. Compatibilidad universal Multi-Tenant / Cualquier API de CG (cero hardcodeo por usuario)
// =========================================================================
test("5. Compatibilidad universal CG: cualquier host/serie/usuario, saneamiento de correo/teléfono y aislamiento de JWT por usuario", async () => {
  // Normalización universal de cualquier host CG (Producción, Calidad, /doc/, /api/, subruta custom)
  assert.equal(normalizarHostCg("https://produccion.cgimprenta.digital"), "https://produccion.cgimprenta.digital/");
  assert.equal(normalizarHostCg("https://calidad.cgimprenta.digital/doc/endpoints/factura.html"), "https://calidad.cgimprenta.digital/");
  assert.equal(normalizarHostCg("https://gateway.miempresa.ve/cg/api/Invoice/add_list_invoice"), "https://gateway.miempresa.ve/cg/");
  assert.equal(normalizarHostCg("https://cgimprenta.digital/api"), "https://cgimprenta.digital/");

  // Saneamiento de correo y teléfono para cualquier cliente sin provocar HTTP 400
  assert.equal(normalizarCorreoCg("cliente@empresa.ve", "emisor@negocio.ve"), "cliente@empresa.ve");
  assert.equal(normalizarCorreoCg("no tiene", "emisor@negocio.ve"), "emisor@negocio.ve");
  assert.equal(normalizarCorreoCg("N/A", ""), "sin-correo@facturayave.com");
  assert.equal(normalizarTelefonoCg("+58 414-123.45.67"), "+584141234567");
  assert.equal(normalizarTelefonoCg("N/A"), "00000000000");

  // Dos empresas (dos BD aisladas) con distintos hosts CG, distintas series ("A" y "B2") y distintos usuarios API
  const dbA = crearBaseDatosD1(":memory:");
  const dbB = crearBaseDatosD1(":memory:");
  const envA: Record<string, unknown> = { DB: dbA, MASTER_KEY: "llave-universal-a", SUPER_ADMIN_EMAIL: "dueno-a@tenant-a.test" };
  const envB: Record<string, unknown> = { DB: dbB, MASTER_KEY: "llave-universal-b", SUPER_ADMIN_EMAIL: "dueno-b@tenant-b.test" };
  const jarA: Record<string, string> = {};
  const jarB: Record<string, string> = {};

  for (const [envX, jarX, nom, rif, email] of [
    [envA, jarA, "FARMACIA EL SOL C.A.", "J-30100100-1", "dueno-a@tenant-a.test"],
    [envB, jarB, "FERRETERIA LA LUNA C.A.", "J-40200200-2", "dueno-b@tenant-b.test"],
  ] as const) {
    const inst = await reqJson(envX, jarX, "/api/instalar", "POST", {
      nombre: nom,
      rif,
      direccion: "Venezuela",
      telefono: "0414-0001122",
      email,
      clave: CLAVE_TEST,
      tipo_contribuyente: "ORDINARIO",
      medio_facturacion: "IMPRENTA_DIGITAL",
    });
    assert.equal(inst.status, 200);
    await (envX.DB as D1Database)
      .prepare(`UPDATE perfil_emisor SET tasa_bcv = '50.00', tasa_bcv_fecha = ? WHERE id = 1`)
      .bind(new Date().toISOString())
      .run();
    await (envX.DB as D1Database).prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`).run();
  }

  // Configurar Tenant A en Calidad serie "A" y Tenant B en Producción custom serie "B2"
  assert.equal(
    (
      await reqJson(envA, jarA, "/api/sistema/imprenta", "POST", {
        proveedor_tipo: "CG_IMPRENTA",
        url: "https://calidad.cgimprenta.digital/doc/endpoints/factura.html",
        usuario: "api-tenant-a@cg.invalid",
        clave: "secret-tenant-a",
        ambiente: "PRUEBAS",
        serie: "A",
        plan_cupo_total: 100,
        password: CLAVE_TEST,
        confirmo: true,
      })
    ).status,
    200
  );
  assert.equal(
    (
      await reqJson(envB, jarB, "/api/sistema/imprenta", "POST", {
        proveedor_tipo: "CG_IMPRENTA",
        url: "https://produccion.cgimprenta.digital/api/Invoice/add_list_invoice",
        usuario: "api-tenant-b@cg.invalid",
        clave: "secret-tenant-b",
        ambiente: "PRODUCCION",
        serie: "B2",
        plan_cupo_total: 5000,
        password: CLAVE_TEST,
        confirmo: true,
      })
    ).status,
    200
  );

  const authLog: { host: string; user: string }[] = [];
  const invoiceLog: { host: string; serie: string; correo: string; tel: string; auth: string | null }[] = [];
  let ctrlSeq = 0;
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const auth = new Headers(init?.headers).get("Authorization");

    if (u.pathname.endsWith("/api/Invoice/create_token_authenticator")) {
      authLog.push({ host: u.origin, user: body.userName });
      return new Response(JSON.stringify({ success: true, token: `tok-${u.hostname}-${body.userName}` }), { status: 200 });
    }
    if (u.pathname.endsWith("/api/Invoice/add_list_invoice")) {
      const f0 = body.facturas[0];
      invoiceLog.push({
        host: u.origin,
        serie: body.numeroSerie,
        correo: f0.correoCliente,
        tel: f0.telefonoCliente,
        auth,
      });
      ctrlSeq += 1;
      const ctrl = `${body.numeroSerie}-${String(ctrlSeq).padStart(6, "0")}`;
      return new Response(
        JSON.stringify({
          success: true,
          invoice_list_success: [
            {
              invoice_number: f0.numeroFactura,
              control_number: ctrl,
              invoice_pdf: `${u.origin}/readonly/export_pdf/${ctrl}`,
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  }) as typeof fetch;

  try {
    // Emitir factura en Tenant A (con cliente sin correo y teléfono heredado "N/A" -> cae al correo del emisor A y teléfono válido)
    const cliA = await reqJson(envA, jarA, "/api/clientes", "POST", {
      rif_cedula: "V-12345678",
      nombre_apellido: "PEDRO PEREZ",
      direccion: "Caracas, Venezuela",
      email: "",
      whatsapp: "",
    });
    assert.equal(cliA.status, 200, `cliA falló: ${JSON.stringify(cliA.data)}`);
    // Simular dato heredado de respaldo/importación con teléfono inválido "N/A"
    await dbA.prepare(`UPDATE clientes SET whatsapp = 'N/A' WHERE id = ?`).bind(cliA.data.id).run();
    const docA = await reqJson(envA, jarA, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cliA.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Consulta", cantidad: "1", precio_usd: "10,00", alicuota_iva: 0 }],
    });
    assert.equal(docA.status, 200, `docA falló: ${JSON.stringify(docA.data)}`);
    const emA = await reqJson(envA, jarA, `/api/documentos/${docA.data.id}/emitir`, "POST", {});
    assert.equal(emA.status, 200, `emA falló: ${JSON.stringify(emA.data)}`);
    assert.equal(emA.data.control_fiscal, "A-000001");

    // Emitir factura en Tenant B (host Producción + serie B2 + correo propio del cliente)
    const cliB = await reqJson(envB, jarB, "/api/clientes", "POST", {
      rif_cedula: "J-50111222-3",
      nombre_apellido: "CONSTRUCTORA B C.A.",
      direccion: "Valencia, Carabobo",
      email: "pagos@constructora-b.ve",
      whatsapp: "0424-9876543",
    });
    assert.equal(cliB.status, 200, `cliB falló: ${JSON.stringify(cliB.data)}`);
    const docB = await reqJson(envB, jarB, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cliB.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Materiales", cantidad: "1", precio_usd: "25,00", alicuota_iva: 16 }],
    });
    assert.equal(docB.status, 200, `docB falló: ${JSON.stringify(docB.data)}`);
    const emB = await reqJson(envB, jarB, `/api/documentos/${docB.data.id}/emitir`, "POST", {});
    assert.equal(emB.status, 200, `emB falló: ${JSON.stringify(emB.data)}`);
    assert.equal(emB.data.control_fiscal, "B2-000002");

    assert.equal(invoiceLog.length, 2);
    assert.equal(invoiceLog[0].host, "https://calidad.cgimprenta.digital");
    assert.equal(invoiceLog[0].serie, "A");
    assert.equal(invoiceLog[0].correo, "sin-correo@facturayave.com");
    assert.equal(invoiceLog[0].tel, "00000000000");
    assert.equal(invoiceLog[0].auth, "Bearer tok-calidad.cgimprenta.digital-api-tenant-a@cg.invalid");

    assert.equal(invoiceLog[1].host, "https://produccion.cgimprenta.digital");
    assert.equal(invoiceLog[1].serie, "B2");
    assert.equal(invoiceLog[1].correo, "pagos@constructora-b.ve");
    assert.equal(invoiceLog[1].tel, "584249876543");
    assert.equal(invoiceLog[1].auth, "Bearer tok-produccion.cgimprenta.digital-api-tenant-b@cg.invalid");

    // Cambiar de usuario API en el MISMO host (Tenant A) -> debe renovar JWT automáticamente y no reusar el del usuario anterior
    assert.equal(
      (
        await reqJson(envA, jarA, "/api/sistema/imprenta", "POST", {
          proveedor_tipo: "CG_IMPRENTA",
          url: "https://calidad.cgimprenta.digital/",
          usuario: "nuevo-api-tenant-a@cg.invalid",
          clave: "nuevo-secret-tenant-a",
          ambiente: "PRUEBAS",
          serie: "A",
          password: CLAVE_TEST,
          confirmo: true,
        })
      ).status,
      200
    );
    const docA2 = await reqJson(envA, jarA, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cliA.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Control", cantidad: "1", precio_usd: "12,00", alicuota_iva: 0 }],
    });
    const emA2 = await reqJson(envA, jarA, `/api/documentos/${docA2.data.id}/emitir`, "POST", {});
    assert.equal(emA2.status, 200);
    assert.equal(invoiceLog[2].auth, "Bearer tok-calidad.cgimprenta.digital-nuevo-api-tenant-a@cg.invalid");
    assert.equal(authLog.length, 3);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

// =========================================================================
// 6. Blindaje anti-500 en emisión (v5.1.3): colisión UNIQUE de control_fiscal en CG jamás rompe /emitir
// =========================================================================
test("6. Blindaje anti-500 al emitir: si CG devuelve un control_number ya usado en otro documento local, emitir devuelve 200 con aviso claro", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-anti500-v513", SUPER_ADMIN_EMAIL: "admin@anti500.test" };
  const jar: Record<string, string> = {};

  assert.equal(
    (
      await reqJson(env, jar, "/api/instalar", "POST", {
        nombre: "COMERCIAL TEST ANTI500 C.A.",
        rif: "J-50999888-1",
        direccion: "Caracas",
        telefono: "0414-5556677",
        email: "admin@anti500.test",
        clave: CLAVE_TEST,
        tipo_contribuyente: "ORDINARIO",
        medio_facturacion: "IMPRENTA_DIGITAL",
      })
    ).status,
    200
  );
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv = '922.56', tasa_bcv_fecha = ? WHERE id = 1`).bind(new Date().toISOString()).run();
  await db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`).run();
  assert.equal(
    (
      await reqJson(env, jar, "/api/sistema/imprenta", "POST", {
        proveedor_tipo: "CG_IMPRENTA",
        url: "https://calidad.cgimprenta.digital/",
        usuario: "api@anti500.invalid",
        clave: "clave-api-test",
        ambiente: "PRUEBAS",
        serie: "A",
        plan_cupo_total: 100,
        password: CLAVE_TEST,
        confirmo: true,
      })
    ).status,
    200
  );

  const cli = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "V-19876543",
    nombre_apellido: "CARLOS GOMEZ",
    direccion: "Caracas",
    email: "carlos@test.ve",
    whatsapp: "0414-1112233",
  });
  assert.equal(cli.status, 200);

  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/api/Invoice/create_token_authenticator")) {
      return new Response(JSON.stringify({ success: true, token: "tok-anti500" }), { status: 200 });
    }
    if (u.pathname.endsWith("/api/Invoice/add_list_invoice")) {
      // Simular que CG devuelve el MISMO control_number para dos facturas distintas (colisión UNIQUE en documentos_fiscal_unico)
      return new Response(
        JSON.stringify({
          success: true,
          invoice_list_success: [
            {
              invoice_number: "000001",
              control_number: "00-00000077",
              invoice_pdf: "https://calidad.cgimprenta.digital/readonly/export_pdf/77",
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  }) as typeof fetch;

  try {
    // Factura #1 recibe 00-00000077 normalmente
    const d1 = await reqJson(env, jar, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Servicio 1", cantidad: "1", precio_usd: "34,80", alicuota_iva: 0 }],
    });
    const e1 = await reqJson(env, jar, `/api/documentos/${d1.data.id}/emitir`, "POST", {});
    assert.equal(e1.status, 200);
    assert.equal(e1.data.control_fiscal, "00-00000077");

    // Factura #2: CG vuelve a devolver 00-00000077 -> JAMÁS debe responder HTTP 500; responde 200 con imprenta_aviso claro
    const d2 = await reqJson(env, jar, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Servicio 2", cantidad: "1", precio_usd: "34,80", alicuota_iva: 0 }],
    });
    const e2 = await reqJson(env, jar, `/api/documentos/${d2.data.id}/emitir`, "POST", {});
    assert.equal(e2.status, 200, `Emitir con colisión CG no debe dar 500: ${JSON.stringify(e2.data)}`);
    assert.equal(e2.data.ok, true);
    assert.equal(e2.data.control_fiscal, undefined);
    assert.match(String(e2.data.imprenta_aviso ?? ""), /00-00000077.*ya est[aá] asignado/i);

    const det2 = await reqJson(env, jar, `/api/documentos/${d2.data.id}`);
    assert.equal(det2.status, 200);
    assert.equal(det2.data.documento.estado, "EMITIDO");
    assert.equal(det2.data.imprenta_envio.estado, "ERROR");
    assert.match(String(det2.data.imprenta_envio.ultimo_error), /00-00000077/i);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

// =========================================================================
// 7. Auto-recuperación v5.1.4: invoice_list_success 2D, timeout post-timbrado y HTTP 200 sin control_number en línea
// =========================================================================
test("7. Auto-recuperación CG v5.1.4: invoice_list_success bidimensional, corte de red tras timbrado y 200 sin control_number inline", async () => {
  // 7A) Parseo puro de invoice_list_success bidimensional [[ { ... } ]] y details anidado
  const res2D = extraerRespuestaCg({
    success: true,
    invoice_list_success: [
      [
        {
          invoice_number: "000001",
          details: {
            control_number: "00-00005140",
            invoice_pdf: "https://calidad.cgimprenta.digital/readonly/export_pdf/5140",
          },
        },
      ],
    ],
  });
  assert.equal(res2D.ok, true);
  assert.equal(res2D.control_fiscal, "00-00005140");
  assert.equal(res2D.pdf_url, "https://calidad.cgimprenta.digital/readonly/export_pdf/5140");

  // 7B) Parseo puro de HTTP 200 con invoice_list_success: ["000002"] sin control_number inline -> marca sin_control_en_200
  const resSinCtrl = extraerRespuestaCg(
    {
      success: true,
      message: "Facturas procesadas",
      invoice_list_success: ["000002"],
    },
    "FACTURA",
    200
  );
  assert.equal(resSinCtrl.ok, false);
  assert.equal(resSinCtrl.sin_control_en_200, true);

  // 7C) Flujo E2E: (i) corte/timeout en add_list_invoice tras timbrado CG y (ii) HTTP 200 sin control_number inline
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-v514-recup", SUPER_ADMIN_EMAIL: "admin@v514.test" };
  const jar: Record<string, string> = {};

  assert.equal(
    (
      await reqJson(env, jar, "/api/instalar", "POST", {
        nombre: "COMERCIAL RECUPERACION V514 C.A.",
        rif: "J-50888777-2",
        direccion: "Caracas",
        telefono: "0414-5551122",
        email: "admin@v514.test",
        clave: CLAVE_TEST,
        tipo_contribuyente: "ORDINARIO",
        medio_facturacion: "IMPRENTA_DIGITAL",
      })
    ).status,
    200
  );
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv = '922.56', tasa_bcv_fecha = ? WHERE id = 1`).bind(new Date().toISOString()).run();
  await db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`).run();
  assert.equal(
    (
      await reqJson(env, jar, "/api/sistema/imprenta", "POST", {
        proveedor_tipo: "CG_IMPRENTA",
        url: "https://calidad.cgimprenta.digital/",
        usuario: "api@v514.invalid",
        clave: "clave-v514-test",
        ambiente: "PRUEBAS",
        serie: "A",
        plan_cupo_total: 100,
        password: CLAVE_TEST,
        confirmo: true,
      })
    ).status,
    200
  );

  const cli = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "V-20112233",
    nombre_apellido: "MARIA PEREZ",
    direccion: "Caracas",
    email: "maria@test.ve",
    telefono: "0412-2223344",
  });
  assert.equal(cli.status, 200);

  const remotos: any[] = [];
  let consultasLista = 0;

  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (u.pathname.endsWith("/api/Invoice/create_token_authenticator")) {
      return new Response(JSON.stringify({ success: true, token: "tok-v514" }), { status: 200 });
    }

    if (u.pathname.endsWith("/api/Invoice/add_list_invoice")) {
      const f = body.facturas[0];
      if (f.numeroFactura === "000001") {
        // Simular que CG SÍ timbró la factura pero se cortó la red / expiró el timeout antes de responder
        remotos.push({
          document: "FACTURA",
          invoice_number: "000001",
          control_number: "00-00005141",
          status: "Emitida",
          invoice_pdf: "https://calidad.cgimprenta.digital/readonly/export_pdf/5141",
        });
        throw new Error("AbortError: timeout simulado tras timbrado CG");
      }
      if (f.numeroFactura === "000002") {
        // Simular que CG responde HTTP 200 con solo el número de factura (sin control_number en línea)
        remotos.push({
          document: "FACTURA",
          invoice_number: "000002",
          control_number: "00-00005142",
          status: "Emitida",
          invoice_pdf: "https://calidad.cgimprenta.digital/readonly/export_pdf/5142",
        });
        return new Response(
          JSON.stringify({
            success: true,
            message: "Facturas procesadas correctamente",
            invoice_list_success: ["000002"],
          }),
          { status: 200 }
        );
      }
    }

    if (u.pathname.includes("/api/Invoice/get_list_invoices")) {
      consultasLista++;
      return new Response(JSON.stringify({ success: true, invoices: [remotos] }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  }) as typeof fetch;

  try {
    // Caso 1: timeout/corte de red tras timbrado -> FacturaYa consulta get_list_invoices y retorna 200 con control_fiscal
    const d1 = await reqJson(env, jar, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Consulta general", cantidad: "1", precio_usd: "25,00", alicuota_iva: 0 }],
    });
    const e1 = await reqJson(env, jar, `/api/documentos/${d1.data.id}/emitir`, "POST", {});
    assert.equal(e1.status, 200, `Timeout post-timbrado no debe fallar: ${JSON.stringify(e1.data)}`);
    assert.equal(e1.data.control_fiscal, "00-00005141");
    assert.equal(e1.data.imprenta_pdf_url, "https://calidad.cgimprenta.digital/readonly/export_pdf/5141");

    // Caso 2: HTTP 200 sin control_number inline -> FacturaYa consulta get_list_invoices y retorna 200 con control_fiscal
    const d2 = await reqJson(env, jar, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Control posterior", cantidad: "1", precio_usd: "30,00", alicuota_iva: 0 }],
    });
    const e2 = await reqJson(env, jar, `/api/documentos/${d2.data.id}/emitir`, "POST", {});
    assert.equal(e2.status, 200, `200 sin control inline debe auto-recuperarse: ${JSON.stringify(e2.data)}`);
    assert.equal(e2.data.control_fiscal, "00-00005142");
    assert.equal(e2.data.imprenta_pdf_url, "https://calidad.cgimprenta.digital/readonly/export_pdf/5142");
    assert.equal(consultasLista, 2, "Debe haber consultado get_list_invoices automáticamente en ambos casos");

    // Verificar visor del plan actualizado con 2 facturas retornadas OK y 98 disponibles
    const est = await reqJson(env, jar, "/api/sistema/imprenta/estado");
    assert.equal(est.status, 200);
    assert.equal(est.data.resumen.facturas_ok, 2);
    assert.equal(est.data.resumen.enviadas_ok, 2);
    assert.equal(est.data.resumen.disponibles, 98);
    assert.equal(est.data.resumen.pendientes, 0);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

// =========================================================================
// 8. Suite de Certificación Calidad en 1 clic para CG La Imprenta Digital
// =========================================================================
test("8. Suite de Certificación Calidad CG: bloqueo en PRODUCCION, 13 escenarios OK, PDF seguro y cero escritura en documentos locales", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-cg-cert-v531", SUPER_ADMIN_EMAIL: "admin-cg@ejemplo.com" };
  const jar: Record<string, string> = {};

  // Inicializar empresa con modalidad Imprenta Digital
  const reg = await reqJson(env, jar, "/api/instalar", "POST", {
    nombre: "COMERCIAL CG CERT C.A.",
    rif: "J-40123999-1",
    direccion: "Caracas",
    telefono: "04141234567",
    email: "admin-cg@ejemplo.com",
    clave: CLAVE_TEST,
    tipo_contribuyente: "ORDINARIO",
    medio_facturacion: "IMPRENTA_DIGITAL",
  });
  assert.equal(reg.status, 200);

  // 1) Bloqueo duro en PRODUCCION (función pura + ruta)
  const cfgProd = {
    proveedor_tipo: "CG_IMPRENTA" as const,
    proveedor: "CG La Imprenta Digital",
    url: "https://produccion.cgimprenta.digital/",
    usuario: "demo@cg.com",
    ambiente: "PRODUCCION" as const,
    serie: "A",
    sucursal: "",
    reservar_previo: false,
    clave_configurada: true,
    clave_final: "1234",
    clave_clara: "ClaveDemoCg1234",
    plan_nombre: "",
    plan_cupo_total: 100,
    plan_fecha_pago: "",
    plan_fecha_vence: "",
    plan_consumo_previo: 0,
    plan_nota: "",
    ultima_conciliacion: null,
  };
  let llamadasFetch = 0;
  const resProd = await ejecutarSuiteCertificacionCg(db, env, cfgProd, { numero_inicio: 500 }, (async () => {
    llamadasFetch++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch);
  assert.equal(resProd.ok, false);
  assert.equal(llamadasFetch, 0, "Jamás debe llamar a la API de CG si el ambiente es PRODUCCION");

  // Guardar config CG en PRODUCCION y verificar que la ruta responde 403
  await reqJson(env, jar, "/api/sistema/imprenta", "POST", {
    proveedor_tipo: "CG_IMPRENTA",
    proveedor: "CG La Imprenta Digital",
    url: "https://produccion.cgimprenta.digital/",
    usuario: "demo@cg.com",
    clave: "ClaveDemoCg1234",
    ambiente: "PRODUCCION",
    serie: "A",
    password: CLAVE_TEST,
    confirmo: true,
  });
  const rProdHttp = await reqJson(env, jar, "/api/sistema/imprenta/certificar-cg", "POST", {
    numero_inicio: 500,
    password: CLAVE_TEST,
    confirmo: true,
  });
  assert.equal(rProdHttp.status, 403);

  // Cambiar a PRUEBAS (Calidad) y validar contraseña incorrecta / sin confirmación
  await reqJson(env, jar, "/api/sistema/imprenta", "POST", {
    proveedor_tipo: "CG_IMPRENTA",
    proveedor: "CG La Imprenta Digital",
    url: "https://calidad.cgimprenta.digital/",
    usuario: "demo@cg.com",
    clave: "ClaveDemoCg1234",
    ambiente: "PRUEBAS",
    serie: "A",
    password: CLAVE_TEST,
    confirmo: true,
  });
  const rSinConf = await reqJson(env, jar, "/api/sistema/imprenta/certificar-cg", "POST", {
    numero_inicio: 500,
    password: CLAVE_TEST,
    confirmo: false,
  });
  assert.equal(rSinConf.status, 400);
  const rMalClave = await reqJson(env, jar, "/api/sistema/imprenta/certificar-cg", "POST", {
    numero_inicio: 500,
    password: "Incorrecta999!",
    confirmo: true,
  });
  assert.equal(rMalClave.status, 400);

  // 2) Ejecución completa de los 13 escenarios contra mock CG v14 (incluyendo regla real de CG:
  // cada codigoProducto queda atado de por vida a su primera alícuota, con PROD-2 y PROD-4 pre-registrados como G).
  const emitidas = new Set<string>();
  const controlesPorDoc: Record<string, string> = {};
  const productosRegistrados = new Map<string, string>([
    ["PROD-2", "G"],
    ["PROD-4", "G"],
  ]);
  let seqCtrl = 9001;
  let ncParcialBody: Record<string, any> | null = null;
  let anulBody: Record<string, any> | null = null;

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const bodyTxt = typeof init?.body === "string" ? init.body : "";
    const body = bodyTxt ? JSON.parse(bodyTxt) : {};

    if (u.pathname.endsWith("/api/Invoice/create_token_authenticator")) {
      return new Response(JSON.stringify({ success: true, token: "jwt-cg-calidad-mock-token-123456" }), { status: 200 });
    }
    if (u.pathname.endsWith("/api/Invoice/add_list_invoice")) {
      const fac = body?.facturas?.[0];
      if (!fac?.numeroFactura || !Array.isArray(fac?.productos) || fac.productos.length === 0) {
        return new Response(JSON.stringify({ success: false, message: "Campos obligatorios faltantes" }), { status: 400 });
      }
      if (emitidas.has(fac.numeroFactura)) {
        return new Response(JSON.stringify({ success: false, message: "Factura duplicada", invoice_errors: [fac.numeroFactura] }), { status: 409 });
      }
      for (const p of fac.productos) {
        const prev = productosRegistrados.get(p.codigoProducto);
        if (prev && prev !== p.tipoImpuesto) {
          return new Response(
            JSON.stringify({
              success: false,
              message: `El producto con código ${p.codigoProducto} ya está registrado en el sistema con la alícuota ${prev}, pero en la petición se envió con la alícuota ${p.tipoImpuesto}.`,
            }),
            { status: 400 }
          );
        }
        productosRegistrados.set(p.codigoProducto, p.tipoImpuesto);
      }
      emitidas.add(fac.numeroFactura);
      const ctrl = `00-${String(seqCtrl++).padStart(8, "0")}`;
      controlesPorDoc[fac.numeroFactura] = ctrl;
      // En FAC_IVA_8 devolver intencionalmente URL insegura javascript: para verificar sanitización
      const pdfUrl =
        fac.numeroFactura === "000501"
          ? "javascript:alert(1)"
          : `https://calidad.cgimprenta.digital/readonly/export_pdf/${fac.numeroFactura}`;
      return new Response(
        JSON.stringify({
          success: true,
          invoice_list_success: [{ control_number: ctrl, invoice_pdf: pdfUrl }],
        }),
        { status: 200 }
      );
    }
    if (u.pathname.endsWith("/api/Invoice/add_credit_note")) {
      const ctrl = `00-${String(seqCtrl++).padStart(8, "0")}`;
      return new Response(
        JSON.stringify({
          success: true,
          credit_note_list_success: [{ control_number: ctrl, credit_note_pdf: "https://calidad.cgimprenta.digital/readonly/nc_total.pdf" }],
        }),
        { status: 200 }
      );
    }
    if (u.pathname.endsWith("/api/Invoice/add_credit_note_with_products")) {
      ncParcialBody = body;
      const ctrl = `00-${String(seqCtrl++).padStart(8, "0")}`;
      return new Response(
        JSON.stringify({
          success: true,
          credit_note_list_success: [{ control_number: ctrl, credit_note_pdf: "https://calidad.cgimprenta.digital/readonly/nc_parcial.pdf" }],
        }),
        { status: 200 }
      );
    }
    if (u.pathname.endsWith("/api/Invoice/add_debit_note")) {
      const ctrl = `00-${String(seqCtrl++).padStart(8, "0")}`;
      return new Response(
        JSON.stringify({
          success: true,
          debit_note_list_success: [{ control_number: ctrl, debit_note_pdf: "https://calidad.cgimprenta.digital/readonly/nd.pdf" }],
        }),
        { status: 200 }
      );
    }
    if (u.pathname.endsWith("/api/Invoice/cancel_invoice")) {
      anulBody = body;
      return new Response(
        JSON.stringify({
          success: true,
          details: { pdf_factura: "https://calidad.cgimprenta.digital/readonly/anulada.pdf" },
        }),
        { status: 200 }
      );
    }
    if (u.pathname.includes("/api/Invoice/get_list_invoices")) {
      const lista = Object.entries(controlesPorDoc).map(([num, ctrl]) => ({
        document: "FACTURA",
        invoice_number: num,
        control_number: ctrl,
        invoice_pdf: `https://calidad.cgimprenta.digital/readonly/export_pdf/${num}`,
      }));
      return new Response(JSON.stringify({ success: true, invoices: [lista] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  }) as typeof fetch;

  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    const rOk = await reqJson(env, jar, "/api/sistema/imprenta/certificar-cg", "POST", {
      numero_inicio: 500,
      email_prueba: "pruebas@ejemplo.com",
      incluir_anulacion: true,
      incluir_errores: true,
      password: CLAVE_TEST,
      confirmo: true,
    });
    assert.equal(rOk.status, 200, `Suite CG Calidad debe responder 200: ${JSON.stringify(rOk.data)}`);
    assert.equal(rOk.data.ok, true);
    assert.equal(rOk.data.resumen.total, 13);
    assert.equal(rOk.data.resumen.aprobados, 11);
    assert.equal(rOk.data.resumen.errores_controlados_ok, 2);
    assert.equal(rOk.data.resumen.fallidos, 0);

    // Verificar NC parcial enlazó PROD-9101-G y ANULACION usó el control exacto de FAC_EXENTA (doc 000503)
    assert.equal(ncParcialBody?.productos?.[0]?.codigo, "PROD-9101-G");
    assert.equal(anulBody?.numero_documento, "000503");
    assert.equal(anulBody?.numero_control, controlesPorDoc["000503"]);

    // Verificar sanitización de PDF URL insegura en FAC_IVA_8 y preservación HTTPS en FAC_IVA_16
    const resFac16 = rOk.data.resultados.find((x: any) => x.codigo === "FAC_IVA_16");
    const resFac8 = rOk.data.resultados.find((x: any) => x.codigo === "FAC_IVA_8");
    assert.equal(resFac16.pdf_url, "https://calidad.cgimprenta.digital/readonly/export_pdf/000500");
    assert.equal(resFac8.pdf_url, null);

    // Reporte de texto listo para copiar y enviar a CG
    assert.match(rOk.data.reporte_texto, /CG LA IMPRENTA DIGITAL/);
    assert.match(rOk.data.reporte_texto, /13\/13 OK/);

    // Cero documentos ni envíos locales creados (correlativos intactos)
    const docsCount = await db.prepare(`SELECT COUNT(*) AS n FROM documentos`).first<{ n: number }>();
    const enviosCount = await db.prepare(`SELECT COUNT(*) AS n FROM imprenta_envios`).first<{ n: number }>();
    assert.equal(docsCount?.n, 0);
    assert.equal(enviosCount?.n, 0);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});


