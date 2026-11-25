import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import {
  alicuotaATipoImpuestoCg,
  calcularResumenPlanImprenta,
  codigoProductoCg,
  construirPayloadAnulacionCg,
  construirPayloadFacturaCg,
  construirPayloadNcParcialCg,
  construirPayloadNcTotalCg,
  construirPayloadNdCg,
  extraerRespuestaCg,
  formatearCantidadMilliCg,
  formatearCentavosCg,
  formatearFechaDdMmYyyy,
  formatearTasaCg,
  limpiarDocumentoIdentidadCg,
  normalizarHostCg,
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
  assert.ok(codigoProductoCg(1234567890123, 1).length <= 13);
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
  assert.equal(f0.productos[0].codigoProducto, "PROD-5");
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
          credit_note_list_success: [
            { control_number: ctrl, pdf_nota_credito: `https://calidad.cgimprenta.digital/pdf/nc-${ctrl}.pdf` },
          ],
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/Invoice/add_debit_note")) {
      seqCtrl++;
      const ctrl = `00-0000${seqCtrl}`;
      return new Response(
        JSON.stringify({
          debit_note_list_success: [
            { control_number: ctrl, pdf_nota_debito: `https://calidad.cgimprenta.digital/pdf/nd-${ctrl}.pdf` },
          ],
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/Invoice/cancel_invoice")) {
      return new Response(
        JSON.stringify({
          success: true,
          pdf_factura: `https://calidad.cgimprenta.digital/pdf/anulada-${body.numero_control}.pdf`,
        }),
        { status: 200 }
      );
    }

    if (url.includes("/api/Invoice/get_list_invoices")) {
      return new Response(JSON.stringify({ invoices: remotosCg }), { status: 200 });
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
