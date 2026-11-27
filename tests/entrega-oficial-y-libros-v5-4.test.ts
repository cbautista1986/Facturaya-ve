import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { construirModelo, aCsv } from "../public/informe-tabla.js";
import { enviarCierreMensualInquilino } from "../src/tasa-bcv";
import { cifrarSecreto } from "../src/cifrado";
import { estadoSemaforoTasaBcv } from "../public/dinero.js";
import { construirPayloadFacturaCg } from "../src/imprenta-cg";
import { construirDocumentoElectronicoTfhka } from "../src/imprenta-tfhka";

const CLAVE_TEST = "ClaveLibrosOficial2026!";

async function reqJson(
  env: Record<string, unknown>,
  jar: Record<string, string>,
  ruta: string,
  method = "GET",
  body?: unknown
) {
  const headers: Record<string, string> = {};
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
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
    const m = setCookie.match(/^([^=]+)=([^;]+)/);
    if (m) jar[m[1]] = m[2];
  }
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function reqRaw(
  env: Record<string, unknown>,
  jar: Record<string, string>,
  ruta: string
) {
  const headers: Record<string, string> = {};
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookie) headers["Cookie"] = cookie;
  return app.fetch(new Request(`http://local${ruta}`, { method: "GET", headers }), env);
}

async function prepararInquilinoReal(opts: {
  tipo_contribuyente?: "FORMAL" | "ORDINARIO" | "ESPECIAL";
  medio?: "APP_SENIAT" | "IMPRENTA_DIGITAL";
}) {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = {
    DB: db,
    MASTER_KEY: "llave-maestra-v540-pruebas",
    SUPER_ADMIN_EMAIL: "admin-v540@ejemplo.com",
  };
  const jar: Record<string, string> = {};

  const inst = await reqJson(env, jar, "/api/instalar", "POST", {
    nombre: "CORPORACION EXENET C.A.",
    rif: "J-40123456-7",
    direccion: "Av. Francisco de Miranda, Caracas",
    telefono: "0414-5550000",
    email: "admin-v540@ejemplo.com",
    tipo_contribuyente: opts.tipo_contribuyente ?? "ESPECIAL",
    medio_facturacion: opts.medio ?? "IMPRENTA_DIGITAL",
    clave: CLAVE_TEST,
  });
  assert.equal(inst.status, 200, `Instalar falló: ${JSON.stringify(inst.data)}`);

  // Configurar tasa BCV exacta Bs. 50,0000, modo REAL y correo Resend cifrado
  const ahoraTest = new Date().toISOString();
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv = '50.00', tasa_bcv_fecha = ? WHERE id = 1`).bind(ahoraTest).run();
  await db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`).run();
  const resendCif = await cifrarSecreto("re_test_v540_1234567890", env);
  await db.prepare(`INSERT OR REPLACE INTO integraciones (clave, valor, actualizado_en) VALUES ('correo_proveedor', 'RESEND', ?)`).bind(ahoraTest).run();
  await db.prepare(`INSERT OR REPLACE INTO integraciones (clave, valor, actualizado_en) VALUES ('correo_clave', ?, ?)`).bind(resendCif, ahoraTest).run();
  await db.prepare(`INSERT OR REPLACE INTO integraciones (clave, valor, actualizado_en) VALUES ('correo_remitente', 'facturacion@exenet.ve', ?)`).bind(ahoraTest).run();

  return { db, env, jar };
}

test("1. Entrega Oficial Exclusiva v5.4.0: CG /imprenta-pdf proxy real, correo adjunta SOLO PDF de CG (jamás PDF interno) y Presupuesto/APP_SENIAT mantienen PDF FacturaYa", async () => {
  const { db, env, jar } = await prepararInquilinoReal({ tipo_contribuyente: "ORDINARIO", medio: "IMPRENTA_DIGITAL" });

  // Configurar CG La Imprenta Digital (Calidad)
  const cfgCg = await reqJson(env, jar, "/api/sistema/imprenta", "POST", {
    proveedor_tipo: "CG_IMPRENTA",
    proveedor: "CG La Imprenta Digital",
    ambiente: "PRUEBAS",
    url: "https://calidad.cgimprenta.digital",
    usuario: "demo_cg",
    clave: "clave_cg_123456",
    serie: "A",
    password: CLAVE_TEST,
    confirmo: true,
  });
  assert.equal(cfgCg.status, 200, `Config CG falló: ${JSON.stringify(cfgCg.data)}`);

  const cli = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "J-30111222-3",
    nombre_apellido: "CLIENTE PRUEBA C.A.",
    email: "cliente@prueba.ve",
    direccion: "Chacao, Caracas",
  });
  assert.equal(cli.status, 200);
  const clienteId = cli.data.id;

  const pdfCgBytes = new TextEncoder().encode("%PDF-1.4\n%PDF-OFICIAL-CG-CON-QR-SNAT-2024-000102\n1 0 obj<<>>endobj\n%%EOF\n");
  let cgPdfCaido = false;
  const correosEnviados: any[] = [];

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    if (u.hostname === "api.resend.com") {
      const payload = JSON.parse(String(init?.body || "{}"));
      correosEnviados.push(payload);
      return new Response(JSON.stringify({ id: `email_${correosEnviados.length}` }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.pathname.endsWith("/api/Invoice/create_token_authenticator")) {
      return new Response(JSON.stringify({ success: true, token: "jwt-cg-v540-ok" }), { status: 200 });
    }
    if (u.pathname.endsWith("/api/Invoice/add_list_invoice")) {
      const reqBody = init?.body ? JSON.parse(String(init.body)) : {};
      const numFac = reqBody?.facturas?.[0]?.numeroFactura || "00000001";
      return new Response(
        JSON.stringify({
          success: true,
          invoice_list_success: [
            {
              invoice_number: numFac,
              control_number: "00-00000777",
              invoice_pdf: "https://calidad.cgimprenta.digital/readonly/export_pdf/uuid-oficial-777",
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (u.pathname === "/readonly/export_pdf/uuid-oficial-777") {
      if (cgPdfCaido) return new Response("Service Unavailable", { status: 503 });
      return new Response(pdfCgBytes, { status: 200, headers: { "Content-Type": "application/pdf" } });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  try {
    // 1.1 Crear y emitir factura real en Imprenta Digital CG
    const bor = await reqJson(env, jar, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: clienteId,
      condicion: "CONTADO",
      lineas: [{ tipo: "SERVICIO", descripcion: "Consultoría fiscal", cantidad: "1", precio_usd: "100,00", alicuota_iva: 16 }],
    });
    assert.equal(bor.status, 200);
    const em = await reqJson(env, jar, `/api/documentos/${bor.data.id}/emitir`, "POST", {});
    assert.equal(em.status, 200, `Emitir CG falló: ${JSON.stringify(em.data)}`);
    assert.equal(em.data.control_fiscal, "00-00000777");

    // 1.2 GET /api/documentos/:id/imprenta-pdf transmite los bytes reales del PDF de CG (sin 302 redirect)
    const pdfResp = await reqRaw(env, jar, `/api/documentos/${bor.data.id}/imprenta-pdf?descarga=1`);
    assert.equal(pdfResp.status, 200);
    assert.equal(pdfResp.headers.get("content-type"), "application/pdf");
    assert.match(pdfResp.headers.get("content-disposition") || "", /attachment; filename="Factura-00000001-Oficial\.pdf"/);
    const rawTxt = new TextDecoder().decode(new Uint8Array(await pdfResp.arrayBuffer()));
    assert.ok(rawTxt.includes("PDF-OFICIAL-CG-CON-QR"), "Debe devolver los bytes reales del PDF oficial de CG");

    // 1.3 POST /:id/enviar-correo IGNORA cualquier pdf_base64 interno del cliente y adjunta EXCLUSIVAMENTE el PDF oficial de CG
    const pdfInternoFalso = Buffer.from("%PDF-1.7\n%PDF-INTERNO-SIN-QR-NO-ENVIAR\n%%EOF\n").toString("base64");
    const mailCg = await reqJson(env, jar, `/api/documentos/${bor.data.id}/enviar-correo`, "POST", {
      email: "cliente@prueba.ve",
      pdf_base64: pdfInternoFalso,
      nombre_archivo: "Factura-interna.pdf",
    });
    assert.equal(mailCg.status, 200, `Correo CG falló: ${JSON.stringify(mailCg.data)}`);
    assert.equal(mailCg.data.pdf_origen, "IMPRENTA_OFICIAL");
    assert.equal(mailCg.data.nombre_archivo, "Factura-00000001-Oficial.pdf");
    assert.equal(correosEnviados.length, 1);
    const adjCg = Buffer.from(correosEnviados[0].attachments[0].content, "base64").toString("utf8");
    assert.ok(adjCg.includes("PDF-OFICIAL-CG-CON-QR"), "El correo debe llevar el PDF oficial de CG");
    assert.ok(!adjCg.includes("PDF-INTERNO-SIN-QR"), "Jamás debe adjuntar el PDF interno cuando hay Imprenta Digital");

    // 1.4 Si CG falla al entregar el PDF oficial (503), el correo rechaza con 502 (jamás filtra PDF interno sin QR)
    cgPdfCaido = true;
    const mailFallido = await reqJson(env, jar, `/api/documentos/${bor.data.id}/enviar-correo`, "POST", {
      email: "cliente@prueba.ve",
      pdf_base64: pdfInternoFalso,
    });
    assert.equal(mailFallido.status, 502);
    assert.equal(correosEnviados.length, 1, "No debe enviarse correo si falló la obtención del PDF oficial");
    cgPdfCaido = false;

    // 1.5 Un PRESUPUESTO NO es documento fiscal de imprenta: sigue enviando el PDF generado por FacturaYa
    const presBor = await reqJson(env, jar, "/api/documentos", "POST", {
      tipo: "PRESUPUESTO",
      cliente_id: clienteId,
      lineas: [{ tipo: "SERVICIO", descripcion: "Cotización proyecto", cantidad: "1", precio_usd: "250,00", alicuota_iva: 16 }],
    });
    assert.equal(presBor.status, 200);
    const presEm = await reqJson(env, jar, `/api/documentos/${presBor.data.id}/emitir`, "POST", {});
    assert.equal(presEm.status, 200);
    const pdfPresBase64 = Buffer.from("%PDF-1.7\n%PDF-PRESUPUESTO-FACTURAYA-OK\n" + "A".repeat(40) + "\n%%EOF\n").toString("base64");
    const mailPres = await reqJson(env, jar, `/api/documentos/${presBor.data.id}/enviar-correo`, "POST", {
      email: "cliente@prueba.ve",
      pdf_base64: pdfPresBase64,
      nombre_archivo: "Presupuesto-000001.pdf",
    });
    assert.equal(mailPres.status, 200, `Correo presupuesto falló: ${JSON.stringify(mailPres.data)}`);
    assert.equal(mailPres.data.pdf_origen, "FACTURAYA");
    assert.equal(correosEnviados.length, 2);
    const adjPres = Buffer.from(correosEnviados[1].attachments[0].content, "base64").toString("utf8");
    assert.ok(adjPres.includes("PDF-PRESUPUESTO-FACTURAYA-OK"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("2. Auditoría Contable Total v5.4.0: Libros de Ventas, Compras, Resumen IVA/Alcaldía, IGTF, ISLR, Cierre Z y Cierre Mensual CSV cuadran al centavo exacto", async () => {
  const { db, env, jar } = await prepararInquilinoReal({ tipo_contribuyente: "ESPECIAL", medio: "APP_SENIAT" });
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(new Date());
  const mes = hoy.slice(0, 7);

  // Cliente y Proveedor
  const cli = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "J-30555666-9",
    nombre_apellido: "COMERCIAL ANDINA S.A.",
    email: "contabilidad@andina.ve",
  });
  assert.equal(cli.status, 200);
  const clienteId = cli.data.id;

  const prov = await reqJson(env, jar, "/api/proveedores", "POST", {
    rif: "J-30999888-1",
    nombre: "DISTRIBUIDORA MAYORISTA C.A.",
  });
  assert.equal(prov.status, 200);
  const proveedorId = prov.data.id;

  // Tasa BCV = Bs 50,0000 (50_00000000 e8)
  // Factura #1: 2 x $50,00 = $100,00 (IVA 16% = $16,00, Sub+IVA = $116,00, IGTF 3% = $3,48, Total = $119,48)
  // En Bs: Base 16% = Bs 5.000,00 (500000), IVA = Bs 800,00 (80000), IGTF = Bs 174,00 (17400), Total = Bs 5.974,00 (597400)
  const f1b = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: clienteId,
    condicion: "CONTADO",
    aplica_igtf: 1,
    lineas: [{ tipo: "SERVICIO", descripcion: "Licencia anual", cantidad: "2", precio_usd: "50,00", alicuota_iva: 16 }],
  });
  assert.equal(f1b.status, 200);
  const f1 = await reqJson(env, jar, `/api/documentos/${f1b.data.id}/emitir`, "POST", {});
  assert.equal(f1.status, 200);
  const cf1 = await reqJson(env, jar, `/api/documentos/${f1b.data.id}/fiscal`, "POST", { numero: "00-00000101" });
  assert.equal(cf1.status, 200);

  // Factura #2 (Mixta: 16% + 8% + Exento 0%, sin IGTF):
  // - $100 (16%): Base Bs 5.000,00 (500000), IVA Bs 800,00 (80000)
  // - $50 (8%):   Base Bs 2.500,00 (250000), IVA Bs 200,00 (20000)
  // - $40 (0%):   Base Bs 2.000,00 (200000), IVA Bs 0,00
  // Subtotal = $190 (Bs 9.500,00), IVA = $20 (Bs 1.000,00), Total = $210 (Bs 10.500,00)
  const f2b = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: clienteId,
    condicion: "CONTADO",
    aplica_igtf: 0,
    lineas: [
      { tipo: "SERVICIO", descripcion: "Soporte 16%", cantidad: "1", precio_usd: "100,00", alicuota_iva: 16 },
      { tipo: "SERVICIO", descripcion: "Insumo 8%", cantidad: "1", precio_usd: "50,00", alicuota_iva: 8 },
      { tipo: "SERVICIO", descripcion: "Servicio médico exento", cantidad: "1", precio_usd: "40,00", alicuota_iva: 0 },
    ],
  });
  assert.equal(f2b.status, 200);
  const f2 = await reqJson(env, jar, `/api/documentos/${f2b.data.id}/emitir`, "POST", {});
  assert.equal(f2.status, 200);
  const cf2 = await reqJson(env, jar, `/api/documentos/${f2b.data.id}/fiscal`, "POST", { numero: "00-00000102" });
  assert.equal(cf2.status, 200);

  // Factura #3 con IGTF 3% que luego ANULAMOS (NO debe sumar en Ventas, IVA, IGTF ni Cierre Z)
  const f3b = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: clienteId,
    condicion: "CONTADO",
    aplica_igtf: 1,
    lineas: [{ tipo: "SERVICIO", descripcion: "Factura anulada prueba", cantidad: "1", precio_usd: "200,00", alicuota_iva: 16 }],
  });
  assert.equal(f3b.status, 200);
  const f3 = await reqJson(env, jar, `/api/documentos/${f3b.data.id}/emitir`, "POST", {});
  assert.equal(f3.status, 200);
  const cf3 = await reqJson(env, jar, `/api/documentos/${f3b.data.id}/fiscal`, "POST", { numero: "00-00000103" });
  assert.equal(cf3.status, 200);
  const an3 = await reqJson(env, jar, `/api/documentos/${f3b.data.id}/anular`, "POST", { motivo: "Error de carga del cliente" });
  assert.equal(an3.status, 200);

  // Nota de Crédito parcial sobre Factura #1 (devuelve 1 de las 2 unidades = -$50 base, -$8 IVA, -$1,74 IGTF, Total -$59,74)
  // En Bs: Base -250000, IVA -40000, IGTF -8700, Total -298700
  const nc1 = await reqJson(env, jar, `/api/documentos/${f1b.data.id}/devolver`, "POST", {
    motivo: "Devolución parcial de 1 licencia",
    aplica_igtf: true,
    lineas: [{ orden: 1, cantidad: "1" }],
  });
  assert.equal(nc1.status, 200, `NC falló: ${JSON.stringify(nc1.data)}`);
  const cfNc = await reqJson(env, jar, `/api/documentos/${nc1.data.id}/fiscal`, "POST", { numero: "00-00000104" });
  assert.equal(cfNc.status, 200);

  // Nota de Débito sobre Factura #2 (+$20 base 16% = +Bs 1.000,00, +$3,20 IVA = +Bs 160,00, Total +$23,20 = +Bs 1.160,00)
  const nd1 = await reqJson(env, jar, `/api/documentos/${f2b.data.id}/nota-debito`, "POST", {
    motivo: "Recargo por instalación express",
    aplica_igtf: false,
    lineas: [{ descripcion: "Recargo express", cantidad: "1", precio_usd: "20,00", alicuota_iva: 16 }],
  });
  assert.equal(nd1.status, 200, `ND falló: ${JSON.stringify(nd1.data)}`);
  const cfNd = await reqJson(env, jar, `/api/documentos/${nd1.data.id}/fiscal`, "POST", { numero: "00-00000105" });
  assert.equal(cfNd.status, 200);

  // Compra registrada con IVA 16% ($80 base = Bs 4.000,00 = 400000, IVA $12,80 = Bs 640,00 = 64000, Total Bs 4.640,00 = 464000)
  const comp = await reqJson(env, jar, "/api/compras", "POST", {
    proveedor_id: proveedorId,
    factura_numero: "FAC-PROV-001",
    control_numero: "00-00009001",
    fecha: hoy,
    tasa_bcv: "50,00",
    lineas: [{ descripcion: "Servidores y licencias", cantidad: "1", costo_usd: "80,00", alicuota_iva: 16 }],
  });
  assert.equal(comp.status, 200, `Compra falló: ${JSON.stringify(comp.data)}`);

  // Retención de IVA 75% sobre Factura #1 (75% de IVA neto Bs 400 -> pongamos Bs 300,00 = 30000 centavos)
  const retIva = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: f1b.data.id,
    metodo: "RETENCION_IVA",
    moneda: "BS",
    monto: "300,00",
    tasa_bcv: "50,00",
    fecha_pago: hoy,
    porcentaje_retencion: 75,
    comprobante_retencion: "20261100000001",
  });
  assert.equal(retIva.status, 200, `Retención IVA falló: ${JSON.stringify(retIva.data)}`);

  // Retención ISLR 2% vigente sobre Factura #2 (2% de Bs 9.500,00 = Bs 190,00 = 19000 centavos)
  const retIslrOk = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: f2b.data.id,
    metodo: "RETENCION_ISLR",
    moneda: "BS",
    monto: "190,00",
    tasa_bcv: "50,00",
    fecha_pago: hoy,
    porcentaje_retencion: 2,
    comprobante_retencion: "ISLR-2026-0001",
  });
  assert.equal(retIslrOk.status, 200, `Retención ISLR 1 falló: ${JSON.stringify(retIslrOk.data)}`);

  // Segunda Retención ISLR que luego ANULAMOS (para validar que modeloIslr deja vacíos sus montos y cuadra con TOTAL!)
  const retIslrAnul = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: f2b.data.id,
    metodo: "RETENCION_ISLR",
    moneda: "BS",
    monto: "50,00",
    tasa_bcv: "50,00",
    fecha_pago: hoy,
    porcentaje_retencion: 1,
    comprobante_retencion: "ISLR-2026-ERR",
  });
  assert.equal(retIslrAnul.status, 200);
  const anulPago = await reqJson(env, jar, `/api/pagos/${retIslrAnul.data.id}/anular`, "POST", { motivo: "Comprobante duplicado" });
  assert.equal(anulPago.status, 200);

  // ---------------- VERIFICACIÓN EXACTA DE LOS 6 LIBROS ----------------
  const qs = `?desde=${mes}-01&hasta=${hoy}`;
  const [rVentas, rCompras, rIva, rIgtf, rIslr, rCaja] = await Promise.all([
    reqJson(env, jar, `/api/informes/ventas${qs}`),
    reqJson(env, jar, `/api/informes/compras${qs}`),
    reqJson(env, jar, `/api/informes/resumen-iva${qs}`),
    reqJson(env, jar, `/api/informes/igtf${qs}`),
    reqJson(env, jar, `/api/informes/islr${qs}`),
    reqJson(env, jar, `/api/informes/cierre-caja${qs}`),
  ]);
  for (const r of [rVentas, rCompras, rIva, rIgtf, rIslr, rCaja]) assert.equal(r.status, 200);

  // Matemática esperada (en centavos enteros de Bs.):
  // Base 16% = 500000 (F1) + 500000 (F2) - 250000 (NC1) + 100000 (ND1) = 850000 (Bs 8.500,00)
  // IVA 16%  =  80000 (F1) +  80000 (F2) -  40000 (NC1) +  16000 (ND1) = 136000 (Bs 1.360,00)
  // Base 8%  = 250000 (F2), IVA 8% = 20000 (F2)
  // Base 0%  = 200000 (F2)
  // Total Base Gravada Bs = 850000 + 250000 = 1100000 (Bs 11.000,00)
  // Total Base Exenta Bs  = 200000 (Bs 2.000,00)
  // Ingresos Brutos Alcaldía Bs = 1300000 (Bs 13.000,00)
  // Total Débito Fiscal IVA Bs  = 136000 + 20000 = 156000 (Bs 1.560,00)
  // Total IGTF Bs = 17400 (F1) - 8700 (NC1) = 8700 (Bs 87,00) [F3 anulada = 0]
  // Total Ventas Netas Bs = 1300000 + 156000 + 8700 = 1464700 (Bs 14.647,00)
  assert.equal(rVentas.data.n_vigentes, 2);
  assert.equal(rVentas.data.n_notas_credito, 1);
  assert.equal(rVentas.data.n_notas_debito, 1);
  assert.equal(rVentas.data.n_anuladas, 1);
  assert.equal(rVentas.data.total_bs, 1464700);
  assert.equal(rVentas.data.igtf_bs, 8700);
  assert.equal(rVentas.data.iva_retenido_bs, 30000);

  // Compras: Base 400000, Crédito Fiscal 64000, Total 464000
  assert.equal(rCompras.data.subtotal_bs, 400000);
  assert.equal(rCompras.data.iva_bs, 64000);
  assert.equal(rCompras.data.total_bs, 464000);

  // Resumen IVA y Alcaldía: cuadre 100% con Ventas y Compras
  assert.equal(rIva.data.total.ventas_gravadas_bs, 1100000);
  assert.equal(rIva.data.total.ventas_exentas_bs, 200000);
  assert.equal(rIva.data.total.ingresos_brutos_bs, 1300000);
  assert.equal(rIva.data.total.debito_bs, 156000);
  assert.equal(rIva.data.total.credito_bs, 64000);
  assert.equal(rIva.data.total.diferencia_bs, 92000);
  assert.equal(rIva.data.total.retenciones_bs, 30000);
  assert.equal(rIva.data.total.cuota_tributaria_bs, 62000); // 1560 - 640 - 300 = Bs 620,00

  // IGTF: F1 (17400) + NC1 (-8700) + F3 (ANULADA -> 0) = 8700 Bs
  assert.equal(rIgtf.data.n_documentos, 2);
  assert.equal(rIgtf.data.n_anuladas, 1);
  assert.equal(rIgtf.data.igtf_bs, 8700);
  const modIgtf = construirModelo("igtf", rIgtf.data);
  const filaIgtfAnulada = modIgtf.secciones[0].filas.find((f: string[]) => f.includes("ANULADA"));
  assert.ok(filaIgtfAnulada, "modeloIgtf debe marcar la fila anulada con Estado = ANULADA");
  assert.equal(filaIgtfAnulada[10], "", "modeloIgtf debe dejar vacío IGTF Bs en fila anulada para que cuadre con TOTAL");

  // ISLR: 1 vigente (19000 Bs) + 1 anulado (5000 Bs -> excluido del total y vacío en tabla)
  assert.equal(rIslr.data.n_retenciones, 1);
  assert.equal(rIslr.data.n_anulados, 1);
  assert.equal(rIslr.data.total_retenido_bs, 19000);
  const modIslr = construirModelo("islr", rIslr.data);
  const filaIslrAnul = modIslr.secciones[0].filas.find((f: string[]) => f.includes("ANULADA"));
  assert.ok(filaIslrAnul, "modeloIslr debe marcar el comprobante anulado con Estado = ANULADA");
  assert.equal(filaIslrAnul[10], "", "modeloIslr debe dejar vacío ISLR Retenido Bs en fila anulada para que cuadre con TOTAL");

  // Cierre de Caja Z: correlativos fiscales reales 00-00000101 al 00-00000105 y facturación neta exacta
  assert.equal(rCaja.data.numeracion.control_fiscal_desde, "00-00000101");
  assert.equal(rCaja.data.numeracion.control_fiscal_hasta, "00-00000105");
  assert.equal(rCaja.data.facturacion.total_bs, 1464700);
  const modCaja = construirModelo("cierre-caja", rCaja.data);
  const filaCtrlCaja = modCaja.secciones[0].filas.find((f: string[]) => f[0] === "Números de Control Fiscal");
  assert.equal(filaCtrlCaja?.[1], "00-00000101");
  assert.equal(filaCtrlCaja?.[2], "00-00000105");

  // Exportación CSV Libro de Ventas sin errores
  const modVentas = construirModelo("ventas", rVentas.data, { tipo_contribuyente: "ESPECIAL" });
  const csvVentasUi = aCsv(modVentas, { nombre_razon_social: "CORPORACION EXENET C.A.", rif: "J-40123456-7" });
  assert.ok(csvVentasUi.includes("00-00000101"));
  assert.ok(csvVentasUi.includes("ANULADA"));

  // Cierre Mensual por Correo (enviarCierreMensualInquilino): CSV de Ventas con Base_Exenta_Bs y Base_Gravada_Bs cuadrando al centavo
  const origFetch = globalThis.fetch;
  let cierreEnviado: any = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    if (u.hostname === "api.resend.com") {
      cierreEnviado = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({ id: "cierre_v540_ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  try {
    const resCierre = await enviarCierreMensualInquilino(db, env as Record<string, string>, mes);
    assert.equal(resCierre.ok, true, `Cierre mensual falló: ${JSON.stringify(resCierre)}`);
    assert.ok(cierreEnviado && Array.isArray(cierreEnviado.attachments));
    const adjVentas = cierreEnviado.attachments.find((a: any) => String(a.filename).startsWith("Libro-Ventas-"));
    const adjResumen = cierreEnviado.attachments.find((a: any) => String(a.filename).startsWith("Resumen-IVA-Alcaldia-"));
    assert.ok(adjVentas, `Debe adjuntar Libro-Ventas CSV (recibidos: ${cierreEnviado.attachments.map((a: any) => a.filename).join(", ")})`);
    assert.ok(adjResumen, "Debe adjuntar Resumen-IVA-Alcaldia CSV");

    const txtVentas = Buffer.from(adjVentas.content, "base64").toString("utf8");
    assert.ok(txtVentas.includes("Base_Exenta_Bs;Base_Gravada_Bs;IVA_Bs;IGTF_Bs;Total_Bs"), "CSV de cierre mensual debe separar Base_Exenta_Bs y Base_Gravada_Bs");
    // Factura #2: Exenta 2000.00 y Gravada 7500.00 (5000 + 2500)
    assert.ok(txtVentas.includes("2000.00;7500.00;1000.00;0.00;10500.00"), `CSV Ventas debe reflejar desglose exacto de F2:\n${txtVentas}`);
    // Nota de Crédito #1: montos negativos numéricos limpios (sin apóstrofe) para que Excel sume correctamente
    assert.ok(txtVentas.includes("0.00;-2500.00;-400.00;-87.00;-2987.00"), `CSV Ventas debe exportar NC con números negativos limpios para Excel:\n${txtVentas}`);

    const txtResumen = Buffer.from(adjResumen.content, "base64").toString("utf8");
    assert.ok(txtResumen.includes("13000.00"), `Resumen CSV debe cuadrar Ingresos Brutos = 13000.00:\n${txtResumen}`);
    assert.ok(txtResumen.includes("1560.00"), "Resumen CSV debe cuadrar Débito Fiscal = 1560.00");
    assert.ok(txtResumen.includes("640.00"), "Resumen CSV debe cuadrar Crédito Fiscal = 640.00");
    assert.ok(txtResumen.includes("300.00"), "Resumen CSV debe cuadrar Retenciones IVA = 300.00");
    assert.ok(txtResumen.includes("620.00"), "Resumen CSV debe cuadrar Cuota Tributaria a Pagar = 620.00");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("3. Semáforo de Tasa Oficial BCV (v5.4.1): verde al día, amarillo fin de semana, rojo sin actualizar y frontera UTC-4 Caracas", () => {
  // Viernes 27/11/2026 08:00 AM VET = 2026-11-27T12:00:00Z
  const vieManana = Date.parse("2026-11-27T12:00:00Z");
  // Actualizada el mismo viernes 2:00 AM VET (06:00:00Z) -> VERDE
  const rVerde = estadoSemaforoTasaBcv(926.36, "2026-11-27 06:00:00", vieManana);
  assert.equal(rVerde.estado, "verde");
  assert.equal(rVerde.clase, "tasa-verde");
  assert.equal(rVerde.punto, "🟢");

  // Viernes con tasa del jueves -> ROJO (sin actualizar hoy)
  const rVieVieja = estadoSemaforoTasaBcv(920.1, "2026-11-26 22:00:00", vieManana);
  assert.equal(rVieVieja.estado, "rojo");
  assert.equal(rVieVieja.clase, "tasa-rojo");
  assert.equal(rVieVieja.punto, "🔴");

  // Sin tasa o sin fecha -> ROJO
  assert.equal(estadoSemaforoTasaBcv(0, "2026-11-27 06:00:00", vieManana).estado, "rojo");
  assert.equal(estadoSemaforoTasaBcv(926.36, null, vieManana).estado, "rojo");

  // Sábado 28/11/2026 10:00 AM VET (14:00:00Z) con tasa del viernes -> AMARILLO (fin de semana)
  const sabado = Date.parse("2026-11-28T14:00:00Z");
  const rSab = estadoSemaforoTasaBcv(926.36, "2026-11-27 06:00:00", sabado);
  assert.equal(rSab.estado, "amarillo");
  assert.equal(rSab.clase, "tasa-amarillo");
  assert.equal(rSab.punto, "🟡");

  // Sábado con tasa sincronizada el mismo sábado -> AMARILLO (sigue siendo fin de semana BCV)
  assert.equal(estadoSemaforoTasaBcv(926.36, "2026-11-28 06:00:00", sabado).estado, "amarillo");

  // Domingo 29/11/2026 03:00 PM VET (19:00:00Z) con tasa del viernes -> AMARILLO
  const domingo = Date.parse("2026-11-29T19:00:00Z");
  assert.equal(estadoSemaforoTasaBcv(926.36, "2026-11-27 22:00:00", domingo).estado, "amarillo");

  // Domingo pero la última actualización fue el jueves (ni siquiera se actualizó el viernes) -> ROJO
  assert.equal(estadoSemaforoTasaBcv(920.1, "2026-11-26 22:00:00", domingo).estado, "rojo");

  // Lunes 30/11/2026 08:30 AM VET (12:30:00Z) todavía con tasa del viernes -> ROJO hasta que actualice lunes
  const lunes = Date.parse("2026-11-30T12:30:00Z");
  assert.equal(estadoSemaforoTasaBcv(926.36, "2026-11-27 22:00:00", lunes).estado, "rojo");

  // Frontera medianoche UTC vs Caracas: 2026-11-28T02:30:00Z es Viernes 27/11 10:30 PM VET -> VERDE (aún es viernes en Venezuela)
  const vieNocheVet = Date.parse("2026-11-28T02:30:00Z");
  assert.equal(estadoSemaforoTasaBcv(926.36, "2026-11-27 06:00:00", vieNocheVet).estado, "verde");
});

test("4. Aislamiento de correo del cliente en CG/TFHKA (jamás filtra correo del emisor) y RBAC exclusivo SUPER_ADMIN en Suite de Certificación (v5.4.2)", async () => {
  // 4.1 Payloads CG y TFHKA: cliente SIN correo usa sin-correo@facturayave.com (JAMÁS el correo del emisor)
  const basePayload: any = {
    documento_id: 13,
    tipo_documento: "FACTURA",
    numero: 13,
    control_interno: 13,
    fecha_emision: "2026-11-27",
    cliente_rif: "J-00179817-0",
    cliente_nombre: "LABORATORIO AVILAB",
    cliente_email: null,
    cliente_direccion: "Caracas",
    cliente_telefono: "584123169520",
    condicion: "CONTADO",
    emisor: { rif: "J-18529773-6", nombre_razon_social: "FACTURAYA", email: "dueno-privado@emisor.com" },
    tasa_e8: 50_00000000,
    subtotal_bs: 500000,
    iva_bs: 80000,
    igtf_bs: 0,
    total_bs: 580000,
    subtotal_usd: 10000,
    iva_usd: 1600,
    igtf_usd: 0,
    total_usd: 11600,
    renglones: [{ orden: 1, descripcion: "Configuración router", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600, monto_usd: 10000, iva_usd: 1600, monto_bs: 500000, iva_bs: 80000 }],
  };
  const cgSinCorreo: any = construirPayloadFacturaCg(basePayload, "A");
  assert.equal(cgSinCorreo.facturas[0].correoCliente, "sin-correo@facturayave.com");
  assert.notEqual(cgSinCorreo.facturas[0].correoCliente, "dueno-privado@emisor.com");

  const tfSinCorreo: any = construirDocumentoElectronicoTfhka(basePayload, { serie: "" });
  assert.equal(tfSinCorreo.DocumentoElectronico.Encabezado.Comprador.Correo[0], "sin-correo@facturayave.com");
  assert.equal(tfSinCorreo.DocumentoElectronico.Encabezado.Comprador.Notificar, "No");

  // Con correo real del cliente, envía estrictamente el correo del cliente
  const conCorreo = { ...basePayload, cliente_email: "pagos@avilab.ve" };
  assert.equal((construirPayloadFacturaCg(conCorreo, "A") as any).facturas[0].correoCliente, "pagos@avilab.ve");
  const tfConCorreo: any = construirDocumentoElectronicoTfhka(conCorreo, { serie: "" });
  assert.equal(tfConCorreo.DocumentoElectronico.Encabezado.Comprador.Correo[0], "pagos@avilab.ve");
  assert.equal(tfConCorreo.DocumentoElectronico.Encabezado.Comprador.Notificar, "Si");

  // 4.2 RBAC: un usuario ADMIN normal NO puede ejecutar certificar-cg ni certificar-tfhka (HTTP 403)
  const { env, jar: jarSuper } = await prepararInquilinoReal({ tipo_contribuyente: "ORDINARIO", medio: "IMPRENTA_DIGITAL" });
  const crearAdm = await reqJson(env, jarSuper, "/api/usuarios", "POST", {
    nombre: "Admin Cliente",
    email: "admin-cliente@prueba.ve",
    rol: "ADMIN",
  });
  assert.equal(crearAdm.status, 200, `Crear ADMIN falló: ${JSON.stringify(crearAdm.data)}`);
  const claveTempAdm = String(crearAdm.data.clave_temporal ?? "");
  assert.ok(claveTempAdm.length >= 6);

  const jarAdmin: Record<string, string> = {};
  const loginAdm = await reqJson(env, jarAdmin, "/api/login", "POST", {
    email: "admin-cliente@prueba.ve",
    clave: claveTempAdm,
  });
  assert.equal(loginAdm.status, 200);
  const cambioAdm = await reqJson(env, jarAdmin, "/api/cuenta/clave", "POST", {
    actual: claveTempAdm,
    nueva: "ClaveAdminCliente2026!",
  });
  assert.equal(cambioAdm.status, 200);

  const rCg403 = await reqJson(env, jarAdmin, "/api/sistema/imprenta/certificar-cg", "POST", {
    numero_inicio: 300,
    password: "ClaveAdminCliente2026!",
    confirmo: true,
  });
  assert.equal(rCg403.status, 403);

  const rTf403 = await reqJson(env, jarAdmin, "/api/sistema/imprenta/certificar-tfhka", "POST", {
    numero_inicio: 300,
    password: "ClaveAdminCliente2026!",
    confirmo: true,
  });
  assert.equal(rTf403.status, 403);
});


