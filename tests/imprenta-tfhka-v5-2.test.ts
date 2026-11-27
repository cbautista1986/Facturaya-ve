import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import {
  HOST_TFHKA_DEMO,
  HOST_TFHKA_PROD,
  TFHKA_AUTORIZACION_DEFECTO,
  TFHKA_RAZON_SOCIAL_DEFECTO,
  aplicarRetencionTfhka,
  construirComprobanteRetencionIslrTfhka,
  construirComprobanteRetencionIvaTfhka,
  construirDocumentoElectronicoTfhka,
  construirGuiaDespachoTfhka,
  dividirRifTfhka,
  extraerRespuestaEmisionTfhka,
  extraerTokenTfhka,
  formatearFechaTfhka,
  montoEnLetrasEntero,
  normalizarHostTfhka,
  numeroDocumentoTfhka,
  tipoDocumentoTfhka,
} from "../src/imprenta-tfhka";
import { cifrarSecreto } from "../src/cifrado";

const CLAVE_TEST = "ClaveTfhkaTest2026!";

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
// 1. Pruebas unitarias puras: normalizadores, monto en letras entero y payload TFHKA emisionv2
// =========================================================================
test("1. TFHKA emisionv2 puro: normalizadores, montoEnLetrasEntero y payloads Factura/NC/ND/IGTF", () => {
  // Normalización de host
  assert.equal(normalizarHostTfhka("https://demoemisionv2.thefactoryhka.com.ve/Emision"), HOST_TFHKA_DEMO);
  assert.equal(normalizarHostTfhka("https://emisionv2.thefactoryhka.com.ve/Autenticacion"), HOST_TFHKA_PROD);
  assert.equal(normalizarHostTfhka("https://emisionv2.thefactoryhka.com.ve/api/Autenticacion"), "https://emisionv2.thefactoryhka.com.ve/api/");
  assert.equal(normalizarHostTfhka("https://emisionv2.thefactoryhka.com.ve/api/DescargaArchivo"), "https://emisionv2.thefactoryhka.com.ve/api/");

  // Tipos y números de documento
  assert.equal(tipoDocumentoTfhka("FACTURA"), "01");
  assert.equal(tipoDocumentoTfhka("NOTA_CREDITO"), "02");
  assert.equal(tipoDocumentoTfhka("NOTA_DEBITO"), "03");
  assert.equal(numeroDocumentoTfhka(7), "00000007");
  assert.equal(numeroDocumentoTfhka("42"), "00000042");

  // División de RIF/CI
  assert.deepEqual(dividirRifTfhka("J-40123456-7"), { tipo: "J", numero: "401234567" });
  assert.deepEqual(dividirRifTfhka("v-19.123.456"), { tipo: "V", numero: "19123456" });
  assert.deepEqual(dividirRifTfhka("12345678"), { tipo: "V", numero: "12345678" });

  // Fecha DD/MM/YYYY
  assert.equal(formatearFechaTfhka("2026-11-26"), "26/11/2026");
  assert.equal(formatearFechaTfhka("26-11-2026"), "26/11/2026");
  assert.equal(formatearFechaTfhka("26/11/2026"), "26/11/2026");

  // Monto en letras 100% entero (VES y USD)
  assert.equal(montoEnLetrasEntero(0, "VES"), "CERO BOLIVARES CON 00/100");
  assert.equal(montoEnLetrasEntero(1, "VES"), "CERO BOLIVARES CON 01/100");
  assert.equal(montoEnLetrasEntero(100, "VES"), "UN BOLIVAR CON 00/100");
  assert.equal(montoEnLetrasEntero(100, "USD"), "UN DOLAR CON 00/100");
  assert.equal(montoEnLetrasEntero(123456, "VES"), "MIL DOSCIENTOS TREINTA Y CUATRO BOLIVARES CON 56/100");
  assert.equal(montoEnLetrasEntero(100_000_000, "USD"), "UN MILLON DOLARES CON 00/100");

  // Payload Factura gravada 16% + IGTF 3% con TotalesOtraMoneda USD
  const payloadFac = construirDocumentoElectronicoTfhka(
    {
      documento_id: 101,
      tipo_documento: "FACTURA",
      numero: 7,
      control_interno: 7,
      fecha_emision: "2026-11-26",
      cliente_rif: "J-30111222-3",
      cliente_nombre: "INVERSIONES CARACAS C.A.",
      cliente_email: "cliente@ejemplo.ve",
      cliente_direccion: "Chacao, Caracas",
      cliente_telefono: "0414-5551234",
      nota: "Servicio mensual",
      condicion: "CONTADO",
      vendedor_nombre: "Ana Ventas",
      subtotal_bs: 500000, // Bs. 5000.00
      iva_bs: 80000, // Bs. 800.00
      igtf_bs: 17400, // Bs. 174.00
      total_bs: 597400, // Bs. 5974.00
      subtotal_usd: 10000, // $100.00
      iva_usd: 1600, // $16.00
      igtf_usd: 348, // $3.48
      total_usd: 11948, // $119.48
      tasa_e8: 50_00000000,
      renglones: [
        { orden: 1, catalogo_id: 5, descripcion: "Soporte técnico", cantidad_milli: 2000, precio_usd: 5000, alicuota_cent: 1600 },
      ],
    },
    { serie: "", sucursal: "0001" }
  );

  const enc = (payloadFac.DocumentoElectronico as any).Encabezado;
  const idDoc = enc.IdentificacionDocumento;
  const comp = enc.Comprador;
  const tot = enc.Totales;
  const totUsd = enc.TotalesOtraMoneda;
  const items = (payloadFac.DocumentoElectronico as any).DetallesItems;

  assert.equal(idDoc.TipoDocumento, "01");
  assert.equal(idDoc.NumeroDocumento, "00000007");
  assert.equal(idDoc.Serie, "");
  assert.equal(idDoc.Sucursal, "0001");
  assert.equal(idDoc.FechaEmision, "26/11/2026");
  assert.equal(idDoc.Moneda, "VES");
  assert.equal(idDoc.TipoDePago, "Inmediato");
  assert.equal(comp.TipoIdentificacion, "J");
  assert.equal(comp.NumeroIdentificacion, "301112223");
  assert.equal(comp.Correo[0], "cliente@ejemplo.ve");
  assert.equal(tot.MontoGravadoTotal, "5000.00");
  assert.equal(tot.MontoExentoTotal, "0.00");
  assert.equal(tot.TotalIVA, "800.00");
  assert.equal(tot.TotalIGTF, "174.00");
  assert.equal(tot.TotalAPagar, "5974.00");
  assert.equal(tot.ImpuestosSubtotal.length, 2); // IVA G + IGTF
  assert.equal(tot.ImpuestosSubtotal[0].CodigoTotalImp, "G");
  assert.equal(tot.ImpuestosSubtotal[1].CodigoTotalImp, "IGTF");
  assert.equal(totUsd.Moneda, "USD");
  assert.equal(totUsd.TipoCambio, "50.0000");
  assert.equal(totUsd.TotalAPagar, "119.48");
  assert.equal(items.length, 1);
  assert.equal(items[0].CodigoPLU, "PROD-5");
  assert.equal(items[0].CodigoImpuesto, "G");
  assert.equal(items[0].Cantidad, "2");
  assert.equal(items[0].PrecioUnitario, "2500.00");

  // Payload Factura Exenta
  const payloadExenta = construirDocumentoElectronicoTfhka(
    {
      documento_id: 102,
      tipo_documento: "FACTURA",
      numero: 8,
      control_interno: 8,
      fecha_emision: "2026-11-26",
      cliente_rif: "V-12345678",
      cliente_nombre: "JUAN PEREZ",
      subtotal_bs: 250000,
      iva_bs: 0,
      igtf_bs: 0,
      total_bs: 250000,
      subtotal_usd: 5000,
      iva_usd: 0,
      igtf_usd: 0,
      total_usd: 5000,
      tasa_e8: 50_00000000,
      renglones: [
        { orden: 1, catalogo_id: null, descripcion: "Consulta médica exenta", cantidad_milli: 1000, precio_usd: 5000, alicuota_cent: 0 },
      ],
    },
    { serie: "A", sucursal: "0002" }
  );
  const totEx = (payloadExenta.DocumentoElectronico as any).Encabezado.Totales;
  assert.equal(totEx.MontoExentoTotal, "2500.00");
  assert.equal(totEx.MontoGravadoTotal, "0.00");
  assert.equal(totEx.ImpuestosSubtotal[0].CodigoTotalImp, "E");
  assert.equal((payloadExenta.DocumentoElectronico as any).Encabezado.IdentificacionDocumento.Serie, "A");

  // Payload Nota de Crédito (02) con factura afectada
  const payloadNc = construirDocumentoElectronicoTfhka(
    {
      documento_id: 103,
      tipo_documento: "NOTA_CREDITO",
      numero: 1,
      control_interno: 9,
      fecha_emision: "2026-11-26",
      cliente_rif: "J-30111222-3",
      cliente_nombre: "INVERSIONES CARACAS C.A.",
      subtotal_bs: 500000,
      iva_bs: 80000,
      igtf_bs: 0,
      total_bs: 580000,
      subtotal_usd: 10000,
      iva_usd: 1600,
      igtf_usd: 0,
      total_usd: 11600,
      tasa_e8: 50_00000000,
      factura_afectada_numero: 7,
      factura_afectada_fecha: "2026-11-25",
      factura_afectada_monto_bs: 580000,
      motivo_nc: "Devolución total por garantía",
      renglones: [
        { orden: 1, catalogo_id: 5, descripcion: "Soporte técnico", cantidad_milli: 2000, precio_usd: 5000, alicuota_cent: 1600 },
      ],
    },
    { serie: "", sucursal: "0001" }
  );
  const idNc = (payloadNc.DocumentoElectronico as any).Encabezado.IdentificacionDocumento;
  assert.equal(idNc.TipoDocumento, "02");
  assert.equal(idNc.NumeroFacturaAfectada, "00000007");
  assert.equal(idNc.FechaFacturaAfectada, "25/11/2026");
  assert.equal(idNc.MontoFacturaAfectada, "5800.00");
  assert.equal(idNc.ComentarioFacturaAfectada, "Devolución total por garantía");

  // Payload Nota de Débito (03)
  const payloadNd = construirDocumentoElectronicoTfhka(
    {
      documento_id: 104,
      tipo_documento: "NOTA_DEBITO",
      numero: 2,
      control_interno: 10,
      fecha_emision: "2026-11-26",
      cliente_rif: "J-30111222-3",
      cliente_nombre: "INVERSIONES CARACAS C.A.",
      subtotal_bs: 100000,
      iva_bs: 16000,
      igtf_bs: 0,
      total_bs: 116000,
      subtotal_usd: 2000,
      iva_usd: 320,
      igtf_usd: 0,
      total_usd: 2320,
      tasa_e8: 50_00000000,
      factura_afectada_numero: 7,
      factura_afectada_fecha: "2026-11-25",
      factura_afectada_monto_bs: 580000,
      motivo_nc: "Recargo por traslado adicional",
      renglones: [
        { orden: 1, catalogo_id: null, descripcion: "Traslado", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 1600 },
      ],
    },
    { serie: "", sucursal: "0001" }
  );
  assert.equal((payloadNd.DocumentoElectronico as any).Encabezado.IdentificacionDocumento.TipoDocumento, "03");

  // Extractores de respuesta TFHKA
  assert.equal(extraerTokenTfhka("", { codigo: "200", token: "eyJ-tfhka-token-largo-2026" }), "eyJ-tfhka-token-largo-2026");
  assert.equal(extraerTokenTfhka("", { data: { token: "eyJ-nested-token-largo-2026" } }), "eyJ-nested-token-largo-2026");
  assert.equal(extraerTokenTfhka('"eyJ-raw-token-string-2026"', null), "eyJ-raw-token-string-2026");

  const parsedOk = extraerRespuestaEmisionTfhka({
    codigo: "200",
    mensaje: "Documento procesado exitosamente",
    resultado: {
      numeroControl: "00-00004512",
      fechaAsignacion: "26/11/2026",
      horaAsignacion: "10:15:30 AM",
      urlPdf: "https://demoemisionv2.thefactoryhka.com.ve/pdf/00-00004512.pdf",
      imprenta: "THE FACTORY HKA VENEZUELA, C.A.",
      autorizacion: "Providencia Administrativa SNAT/INTI/2024/000999",
    },
  });
  assert.equal(parsedOk.ok, true);
  assert.equal(parsedOk.control_fiscal, "00-00004512");
  assert.equal(parsedOk.fecha_asignacion, "26/11/2026");
  assert.equal(parsedOk.hora_asignacion, "10:15:30 AM");
  assert.equal(parsedOk.pdf_url, "https://demoemisionv2.thefactoryhka.com.ve/pdf/00-00004512.pdf");
  assert.equal(parsedOk.imprenta_razon_social, "THE FACTORY HKA VENEZUELA, C.A.");
  assert.equal(parsedOk.imprenta_autorizacion, "Providencia Administrativa SNAT/INTI/2024/000999");

  // Enlace PDF inseguro debe descartarse
  const parsedUnsafePdf = extraerRespuestaEmisionTfhka({
    codigo: "200",
    resultado: { numeroControl: "00-00004513", urlPdf: "http://127.0.0.1/evil.pdf" },
  });
  assert.equal(parsedUnsafePdf.control_fiscal, "00-00004513");
  assert.equal(parsedUnsafePdf.pdf_url, null);
});

// =========================================================================
// 2. Flujo E2E The Factory HKA Venezuela + Candado Legal SNAT/2024/000102
// =========================================================================
test("2. Flujo E2E TFHKA emisionv2: config cifrada, emitir/NC/ND/anular, 401 refresh, timeout+conciliar y candado legal estricto", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = {
    DB: db,
    MASTER_KEY: "llave-maestra-tfhka-test-v520",
    SUPER_ADMIN_EMAIL: "admin@tfhkatest.ve",
  };
  const jarAdmin: Record<string, string> = {};

  // Instalar empresa en IMPRENTA_DIGITAL + REAL
  const inst = await reqJson(env, jarAdmin, "/api/instalar", "POST", {
    nombre: "TECNOLOGIA VENEZUELA C.A.",
    rif: "J-40112233-4",
    direccion: "Av. Francisco de Miranda, Caracas",
    telefono: "0414-7778899",
    email: "admin@tfhkatest.ve",
    clave: CLAVE_TEST,
    tipo_contribuyente: "ORDINARIO",
    medio_facturacion: "IMPRENTA_DIGITAL",
  });
  assert.equal(inst.status, 200);
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv = '50.00', tasa_bcv_fecha = ? WHERE id = 1`).bind(new Date().toISOString()).run();
  await db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`).run();

  // Configurar correo Resend cifrado en D1 para probar POST /:id/enviar-correo
  const ahoraTest = new Date().toISOString();
  const resendCif = await cifrarSecreto("re_sintetico_test_key_v520", env);
  await db.prepare(`INSERT OR REPLACE INTO integraciones (clave, valor, actualizado_en) VALUES ('correo_proveedor', 'RESEND', ?)`).bind(ahoraTest).run();
  await db.prepare(`INSERT OR REPLACE INTO integraciones (clave, valor, actualizado_en) VALUES ('correo_clave', ?, ?)`).bind(resendCif, ahoraTest).run();
  await db.prepare(`INSERT OR REPLACE INTO integraciones (clave, valor, actualizado_en) VALUES ('correo_remitente', 'facturacion@tfhkatest.ve', ?)`).bind(ahoraTest).run();

  // Guardar configuración TFHKA (serie vacía permitida, sucursal 0001, reservar_previo=true)
  const cfgSave = await reqJson(env, jarAdmin, "/api/sistema/imprenta", "POST", {
    proveedor_tipo: "THE_FACTORY_HKA",
    proveedor: "The Factory HKA Venezuela",
    url: HOST_TFHKA_DEMO,
    usuario: "demo_tfhka_user",
    clave: "clave-tfhka-sintetica-2026",
    ambiente: "PRUEBAS",
    serie: "",
    sucursal: "0001",
    reservar_previo: true,
    plan_nombre: "Plan TFHKA 200",
    plan_cupo_total: 200,
    plan_fecha_pago: "2026-11-01",
    plan_fecha_vence: "2027-11-01",
    password: CLAVE_TEST,
    confirmo: true,
  });
  assert.equal(cfgSave.status, 200, `Error guardando config TFHKA: ${JSON.stringify(cfgSave.data)}`);

  // Verificar secreto cifrado y no expuesto en GET /api/sistema/medio
  const rowClave = await db.prepare(`SELECT valor FROM integraciones WHERE clave = 'imprenta_clave'`).first<{ valor: string }>();
  assert.ok(rowClave?.valor && !rowClave.valor.includes("clave-tfhka-sintetica-2026"));

  const medioGet = await reqJson(env, jarAdmin, "/api/sistema/medio");
  assert.equal(medioGet.status, 200);
  assert.equal(medioGet.data.imprenta.proveedor_tipo, "THE_FACTORY_HKA");
  assert.equal(medioGet.data.imprenta.serie, "");
  assert.equal(medioGet.data.imprenta.sucursal, "0001");
  assert.equal(medioGet.data.imprenta.reservar_previo, true);
  assert.equal(medioGet.data.imprenta.clave_configurada, true);
  assert.equal(medioGet.data.imprenta.clave_clara, undefined);

  // Crear cliente de prueba
  const cli = await reqJson(env, jarAdmin, "/api/clientes", "POST", {
    rif_cedula: "J-30998877-5",
    nombre_apellido: "COMERCIAL ANDINA C.A.",
    direccion: "Altamira, Caracas",
    telefono: "0412-5559988",
    email: "pagos@andina.ve",
  });
  assert.equal(cli.status, 200, `Error creando cliente: ${JSON.stringify(cli.data)}`);
  const clienteId = cli.data.id;

  // Mock globalThis.fetch para TFHKA emisionv2 y Resend
  const llamadas: { url: string; method: string; body: any; auth: string | null }[] = [];
  const correosEnviados: { to: string[]; subject: string; html: string; attachments?: any[] }[] = [];
  let tokenNum = 0;
  let forzar401UnaVez = false;
  let modoEmision: "OK" | "TIMEOUT_PERO_REMOTO_OK" | "CAIDO_TOTAL" = "OK";
  let seqControl = 500;
  const remotosTfhka = new Map<string, { control: string; fecha: string; hora: string; anulado?: boolean }>();

  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    llamadas.push({ url, method, body, auth });

    // Resend mock
    if (url === "https://api.resend.com/emails") {
      correosEnviados.push({ to: body.to, subject: body.subject, html: body.html, attachments: body.attachments });
      return new Response(JSON.stringify({ id: "email-tfhka-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Autenticacion TFHKA
    if (url.endsWith("/Autenticacion")) {
      tokenNum++;
      return new Response(JSON.stringify({ codigo: "200", token: `eyJhbGciOiJIUzI1NiJ9.tfhka-jwt-sintetico-${tokenNum}`, mensaje: "OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (forzar401UnaVez) {
      forzar401UnaVez = false;
      return new Response(JSON.stringify({ codigo: "401", mensaje: "Token vencido" }), { status: 401 });
    }

    if (url.endsWith("/ListadoAsignaciones")) {
      return new Response(
        JSON.stringify({
          codigo: "200",
          mensaje: "OK",
          asignaciones: [{ serie: "", inicio: "00-00000501", fin: "00-00000700" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.endsWith("/AsignarNumeraciones")) {
      if (modoEmision === "CAIDO_TOTAL") {
        throw new Error("The operation was aborted due to timeout");
      }
      return new Response(JSON.stringify({ codigo: "200", mensaje: "Numeración asignada" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/Emision")) {
      const idDoc = body?.DocumentoElectronico?.Encabezado?.IdentificacionDocumento;
      const key = `${idDoc?.TipoDocumento}|${idDoc?.NumeroDocumento}`;
      if (modoEmision === "CAIDO_TOTAL") {
        throw new Error("The operation was aborted due to timeout");
      }
      seqControl++;
      const ctrl = `00-${String(seqControl).padStart(8, "0")}`;
      const reg = { control: ctrl, fecha: "26/11/2026", hora: "10:45:00 AM" };
      remotosTfhka.set(key, reg);

      if (modoEmision === "TIMEOUT_PERO_REMOTO_OK") {
        throw new Error("The operation was aborted due to timeout");
      }
      return new Response(
        JSON.stringify({
          codigo: "200",
          mensaje: "Emitido correctamente",
          resultado: {
            numeroControl: ctrl,
            fechaAsignacion: reg.fecha,
            horaAsignacion: reg.hora,
            urlPdf: `https://demoemisionv2.thefactoryhka.com.ve/pdf/${ctrl}.pdf`,
            imprenta: TFHKA_RAZON_SOCIAL_DEFECTO,
            autorizacion: TFHKA_AUTORIZACION_DEFECTO,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.endsWith("/EstadoDocumento")) {
      if (modoEmision === "CAIDO_TOTAL") {
        throw new Error("The operation was aborted due to timeout");
      }
      const key = `${body?.tipoDocumento}|${body?.numeroDocumento}`;
      const reg = remotosTfhka.get(key);
      if (!reg) {
        return new Response(JSON.stringify({ codigo: "404", mensaje: "Documento no encontrado" }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          codigo: "200",
          resultado: {
            numeroControl: reg.control,
            fechaAsignacion: reg.fecha,
            horaAsignacion: reg.hora,
            urlPdf: `https://demoemisionv2.thefactoryhka.com.ve/pdf/${reg.control}.pdf`,
            imprenta: TFHKA_RAZON_SOCIAL_DEFECTO,
            autorizacion: TFHKA_AUTORIZACION_DEFECTO,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.endsWith("/Anular")) {
      const key = `${body?.tipoDocumento}|${body?.numeroDocumento}`;
      const reg = remotosTfhka.get(key);
      if (reg) reg.anulado = true;
      return new Response(JSON.stringify({ codigo: "200", mensaje: "Documento anulado" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/DescargaArchivo")) {
      const pdfBytes = new TextEncoder().encode("%PDF-1.4\n%TFHKA-OFICIAL-TEST\n1 0 obj<<>>endobj\n%%EOF\n");
      let bin = "";
      for (const b of pdfBytes) bin += String.fromCharCode(b);
      return new Response(
        JSON.stringify({ codigo: "200", mensaje: "OK", archivo: btoa(bin) }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  try {
    // 2.1 Probar conexión TFHKA (Autenticacion + ListadoAsignaciones)
    const probar = await reqJson(env, jarAdmin, "/api/sistema/imprenta/probar", "POST", {});
    assert.equal(probar.status, 200, `Probar TFHKA falló: ${JSON.stringify(probar.data)}`);
    assert.equal(probar.data.ok, true);
    assert.equal(tokenNum, 1);

    // 2.2 Emitir Factura #1 -> AsignarNumeraciones + Emision + sello legal inmutable
    const fac1Borr = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: clienteId,
      condicion: "CONTADO",
      lineas: [{ tipo: "SERVICIO", descripcion: "Implementación servidor", cantidad: "2", precio_usd: "50,00", alicuota_iva: 16 }],
    });
    assert.equal(fac1Borr.status, 200);
    const fac1 = await reqJson(env, jarAdmin, `/api/documentos/${fac1Borr.data.id}/emitir`, "POST", {});
    assert.equal(fac1.status, 200, `Error emitiendo Factura 1: ${JSON.stringify(fac1.data)}`);
    assert.equal(fac1.data.control_fiscal, "00-00000501");
    assert.ok(llamadas.some((l) => l.url.endsWith("/AsignarNumeraciones")));
    assert.ok(llamadas.some((l) => l.url.endsWith("/Emision")));

    const det1 = await reqJson(env, jarAdmin, `/api/documentos/${fac1Borr.data.id}`);
    assert.equal(det1.status, 200);
    assert.equal(det1.data.documento.control_fiscal, "00-00000501");
    assert.equal(det1.data.imprenta_envio.fecha_asignacion, "26/11/2026");
    assert.equal(det1.data.imprenta_envio.hora_asignacion, "10:45:00 AM");
    assert.equal(det1.data.imprenta_envio.imprenta_razon_social, TFHKA_RAZON_SOCIAL_DEFECTO);
    assert.equal(det1.data.imprenta_envio.imprenta_autorizacion, TFHKA_AUTORIZACION_DEFECTO);

    // 2.3 Nota de Crédito (02) con 401 refresh automático de JWT
    forzar401UnaVez = true;
    const nc1 = await reqJson(env, jarAdmin, `/api/documentos/${fac1Borr.data.id}/devolver`, "POST", {
      motivo: "Ajuste parcial acordado con el cliente",
      lineas: [{ orden: 1, cantidad: "1" }],
    });
    assert.equal(nc1.status, 200, `Error emitiendo NC: ${JSON.stringify(nc1.data)}`);
    assert.equal(nc1.data.control_fiscal, "00-00000502");
    assert.equal(tokenNum, 2, "Debe haber renovado el JWT tras el 401");

    // 2.4 Nota de Débito (03)
    const nd1 = await reqJson(env, jarAdmin, `/api/documentos/${fac1Borr.data.id}/nota-debito`, "POST", {
      motivo: "Cargo extra por configuración urgente",
      lineas: [{ descripcion: "Urgencia", cantidad: "1", precio_usd: "15,00", alicuota_iva: 16 }],
    });
    assert.equal(nd1.status, 200, `Error emitiendo ND: ${JSON.stringify(nd1.data)}`);
    assert.equal(nd1.data.control_fiscal, "00-00000503");

    // 2.5 Factura #2 con timeout de red pero ya registrada en TFHKA -> auto-recuperación vía /EstadoDocumento
    modoEmision = "TIMEOUT_PERO_REMOTO_OK";
    const fac2Borr = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: clienteId,
      condicion: "CONTADO",
      lineas: [{ tipo: "SERVICIO", descripcion: "Mantenimiento preventivo", cantidad: "1", precio_usd: "50,00", alicuota_iva: 16 }],
    });
    const fac2 = await reqJson(env, jarAdmin, `/api/documentos/${fac2Borr.data.id}/emitir`, "POST", {});
    assert.equal(fac2.status, 200, `Factura 2 no debe devolver 500 ante timeout: ${JSON.stringify(fac2.data)}`);
    assert.equal(fac2.data.control_fiscal, "00-00000504", "Debe autorrecuperar control_fiscal vía /EstadoDocumento");
    assert.ok(llamadas.some((l) => l.url.endsWith("/EstadoDocumento")));

    // 2.6 Anular Factura #2 -> debe notificar a TFHKA /Anular
    modoEmision = "OK";
    const anul2 = await reqJson(env, jarAdmin, `/api/documentos/${fac2Borr.data.id}/anular`, "POST", {
      motivo: "Cliente solicitó cancelar el servicio hoy",
    });
    assert.equal(anul2.status, 200, `Error anulando Factura 2: ${JSON.stringify(anul2.data)}`);
    assert.equal(anul2.data.imprenta_anulacion?.ok, true);
    assert.ok(llamadas.some((l) => l.url.endsWith("/Anular")));

    // 2.7 CANDADO LEGAL ESTRICTO SNAT/2024/000102 en IMPRENTA_DIGITAL + REAL:
    // Simular caída total de TFHKA al emitir Factura #3 -> queda PENDIENTE sin control_fiscal
    modoEmision = "CAIDO_TOTAL";
    const fac3Borr = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: clienteId,
      condicion: "CONTADO",
      lineas: [{ tipo: "SERVICIO", descripcion: "Auditoría de redes", cantidad: "1", precio_usd: "80,00", alicuota_iva: 16 }],
    });
    const fac3 = await reqJson(env, jarAdmin, `/api/documentos/${fac3Borr.data.id}/emitir`, "POST", {});
    assert.equal(fac3.status, 200);
    assert.equal(fac3.data.control_fiscal, undefined, "Al estar caída la imprenta debe quedar pendiente sin control_fiscal");

    // (a) Intentar escribir manualmente el número de control en IMPRENTA_DIGITAL + REAL -> HTTP 403
    const manualBloq = await reqJson(env, jarAdmin, `/api/documentos/${fac3Borr.data.id}/fiscal`, "POST", {
      numero: "00-99999999",
    });
    assert.equal(manualBloq.status, 403, "En IMPRENTA_DIGITAL + REAL debe prohibirse el ingreso manual del N.º de Control");

    // (b) Intentar enviar correo al cliente sin control_fiscal oficial -> HTTP 409
    const correoBloq = await reqJson(env, jarAdmin, `/api/documentos/${fac3Borr.data.id}/enviar-correo`, "POST", {
      email: "pagos@andina.ve",
    });
    assert.equal(correoBloq.status, 409, "En IMPRENTA_DIGITAL + REAL no se debe entregar al cliente sin N.º de Control");
    assert.equal(correosEnviados.length, 0);

    // (c) Vuelve la imprenta -> reintentar asignación oficial vía API TFHKA
    modoEmision = "OK";
    const reintento = await reqJson(env, jarAdmin, `/api/documentos/${fac3Borr.data.id}/fiscal`, "POST", {
      reintentar_imprenta: true,
    });
    assert.equal(reintento.status, 200, `Reintento imprenta falló: ${JSON.stringify(reintento.data)}`);
    assert.equal(reintento.data.control_fiscal, "00-00000505");
    assert.equal(reintento.data.fecha_asignacion, "26/11/2026");
    assert.equal(reintento.data.imprenta_razon_social, TFHKA_RAZON_SOCIAL_DEFECTO);

    // (d) Ya con control_fiscal oficial, el envío por correo SÍ procede, incluye Sello Digital Autorizado y adjunta el PDF oficial de TFHKA
    const correoOk = await reqJson(env, jarAdmin, `/api/documentos/${fac3Borr.data.id}/enviar-correo`, "POST", {
      email: "pagos@andina.ve",
    });
    assert.equal(correoOk.status, 200, `Envío correo tras sello falló: ${JSON.stringify(correoOk.data)}`);
    assert.equal(correoOk.data.pdf_origen, "IMPRENTA_OFICIAL");
    assert.equal(correosEnviados.length, 1);
    assert.ok(Array.isArray(correosEnviados[0].attachments) && correosEnviados[0].attachments.length === 1);
    assert.ok(Buffer.from(correosEnviados[0].attachments[0].content, "base64").toString("utf8").includes("TFHKA-OFICIAL-TEST"));
    assert.ok(correosEnviados[0].html.includes("00-00000505"));
    assert.ok(correosEnviados[0].html.includes("Sello Digital Autorizado"));
    assert.ok(correosEnviados[0].html.includes(TFHKA_RAZON_SOCIAL_DEFECTO));

    // 2.8 Conciliación por lote TFHKA (recupera factura pendiente cuyo estado remoto ya existe)
    modoEmision = "CAIDO_TOTAL";
    const fac4Borr = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: clienteId,
      condicion: "CONTADO",
      lineas: [{ tipo: "SERVICIO", descripcion: "Respaldo cloud", cantidad: "1", precio_usd: "40,00", alicuota_iva: 16 }],
    });
    const fac4 = await reqJson(env, jarAdmin, `/api/documentos/${fac4Borr.data.id}/emitir`, "POST", {});
    assert.equal(fac4.status, 200);
    assert.equal(fac4.data.control_fiscal, undefined);

    // Simular que TFHKA sí tenía procesada la Factura #4 al volver en línea
    const doc4Num = String(fac4.data.numero).padStart(8, "0");
    remotosTfhka.set(`01|${doc4Num}`, { control: "00-00000506", fecha: "26/11/2026", hora: "11:00:00 AM" });
    modoEmision = "OK";

    const conc = await reqJson(env, jarAdmin, "/api/sistema/imprenta/conciliar", "POST", {});
    assert.equal(conc.status, 200, `Conciliación TFHKA falló: ${JSON.stringify(conc.data)}`);
    assert.equal(conc.data.ok, true);
    assert.equal(conc.data.conciliacion?.recuperados, 1);

    const det4 = await reqJson(env, jarAdmin, `/api/documentos/${fac4Borr.data.id}`);
    assert.equal(det4.data.documento.control_fiscal, "00-00000506");
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

// =========================================================================
// 3. Regresión APP_SENIAT: el flujo manual y el envío al cliente siguen 100% intactos
// =========================================================================
test("3. APP_SENIAT + REAL: flujo manual de control_fiscal y correo siguen 100% intactos sin bloqueos de Imprenta Digital", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = {
    DB: db,
    MASTER_KEY: "llave-maestra-seniat-v520",
    SUPER_ADMIN_EMAIL: "admin@seniattest.ve",
  };
  const jarAdmin: Record<string, string> = {};

  const inst = await reqJson(env, jarAdmin, "/api/instalar", "POST", {
    nombre: "SERVICIOS EXPRESS VE C.A.",
    rif: "J-40556677-8",
    direccion: "Valencia, Carabobo",
    telefono: "0414-2223344",
    email: "admin@seniattest.ve",
    clave: CLAVE_TEST,
    tipo_contribuyente: "ORDINARIO",
    medio_facturacion: "APP_SENIAT",
  });
  assert.equal(inst.status, 200);
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv = '50.00', tasa_bcv_fecha = ? WHERE id = 1`).bind(new Date().toISOString()).run();
  await db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`).run();

  const ahoraTest2 = new Date().toISOString();
  const resendCif = await cifrarSecreto("re_sintetico_seniat_v520", env);
  await db.prepare(`INSERT OR REPLACE INTO integraciones (clave, valor, actualizado_en) VALUES ('correo_proveedor', 'RESEND', ?)`).bind(ahoraTest2).run();
  await db.prepare(`INSERT OR REPLACE INTO integraciones (clave, valor, actualizado_en) VALUES ('correo_clave', ?, ?)`).bind(resendCif, ahoraTest2).run();
  await db.prepare(`INSERT OR REPLACE INTO integraciones (clave, valor, actualizado_en) VALUES ('correo_remitente', 'facturacion@seniattest.ve', ?)`).bind(ahoraTest2).run();

  const cli = await reqJson(env, jarAdmin, "/api/clientes", "POST", {
    rif_cedula: "V-18777666",
    nombre_apellido: "MARIA GONZALEZ",
    direccion: "Naguanagua",
    telefono: "0424-1112233",
    email: "maria@cliente.ve",
  });
  assert.equal(cli.status, 200, `Error creando cliente APP_SENIAT: ${JSON.stringify(cli.data)}`);

  const correos: any[] = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://api.resend.com/emails") {
      correos.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "email-seniat-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  try {
    // Emitir factura en APP_SENIAT + REAL (queda sin control_fiscal hasta cargarlo desde la app del SENIAT)
    const facBorr = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      condicion: "CONTADO",
      lineas: [{ tipo: "SERVICIO", descripcion: "Reparación de equipo", cantidad: "1", precio_usd: "30,00", alicuota_iva: 16 }],
    });
    assert.equal(facBorr.status, 200);
    const fac = await reqJson(env, jarAdmin, `/api/documentos/${facBorr.data.id}/emitir`, "POST", {});
    assert.equal(fac.status, 200);
    assert.equal(fac.data.control_fiscal, undefined);

    // En APP_SENIAT el correo sigue funcionando incluso antes de cargar el control manual
    const correoAntes = await reqJson(env, jarAdmin, `/api/documentos/${facBorr.data.id}/enviar-correo`, "POST", {
      email: "maria@cliente.ve",
    });
    assert.equal(correoAntes.status, 200, `APP_SENIAT no debe bloquear correo: ${JSON.stringify(correoAntes.data)}`);
    assert.equal(correos.length, 1);

    // Registrar manualmente el número de control obtenido en la app del SENIAT -> HTTP 200
    const regManual = await reqJson(env, jarAdmin, `/api/documentos/${facBorr.data.id}/fiscal`, "POST", {
      numero: "00-77777777",
    });
    assert.equal(regManual.status, 200, `APP_SENIAT debe permitir registrar control manual: ${JSON.stringify(regManual.data)}`);
    assert.equal(regManual.data.control_fiscal, "00-77777777");

    // Una vez registrado, sigue siendo inmutable (409 si intenta sobreescribir)
    const regDup = await reqJson(env, jarAdmin, `/api/documentos/${facBorr.data.id}/fiscal`, "POST", {
      numero: "00-88888888",
    });
    assert.equal(regDup.status, 409);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

// =========================================================================
// 4. Unicidad Fiscal por Ámbito (v5.2.1 · Migración 0023): sin falsos choques entre App SENIAT / Práctica / Sandbox / Producción / CG / TFHKA
// =========================================================================
test("4. Unicidad fiscal por ámbito (v5.2.1): 00-00000005/00-00000006 en APP_SENIAT o heredado no bloquean a CG ni TFHKA, pero mismo ámbito sí bloquea duplicados", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = {
    DB: db,
    MASTER_KEY: "llave-maestra-ambito-v521",
    SUPER_ADMIN_EMAIL: "admin@ambito.ve",
  };
  const jarAdmin: Record<string, string> = {};

  const inst = await reqJson(env, jarAdmin, "/api/instalar", "POST", {
    nombre: "NEGOCIO TRANSICION VE C.A.",
    rif: "J-40991122-3",
    direccion: "Caracas",
    telefono: "0414-3334455",
    email: "admin@ambito.ve",
    clave: CLAVE_TEST,
    tipo_contribuyente: "ORDINARIO",
    medio_facturacion: "APP_SENIAT",
  });
  assert.equal(inst.status, 200);
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv = '50.00', tasa_bcv_fecha = ? WHERE id = 1`).bind(new Date().toISOString()).run();
  await db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`).run();

  const cli = await reqJson(env, jarAdmin, "/api/clientes", "POST", {
    rif_cedula: "J-424296928-6",
    nombre_apellido: "Nostimo Cafe",
    direccion: "Caracas",
    telefono: "0412-1112233",
    email: "nostimo@cliente.ve",
  });
  assert.equal(cli.status, 200);

  // 4.1 Emitir Factura #1 en APP_SENIAT + REAL y registrar manualmente 00-00000005
  const fSeniat = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    lineas: [{ tipo: "SERVICIO", descripcion: "Servicio en App SENIAT", cantidad: "1", precio_usd: "15,00", alicuota_iva: 16 }],
  });
  assert.equal((await reqJson(env, jarAdmin, `/api/documentos/${fSeniat.data.id}/emitir`, "POST", {})).status, 200);
  assert.equal((await reqJson(env, jarAdmin, `/api/documentos/${fSeniat.data.id}/fiscal`, "POST", { numero: "00-00000005" })).status, 200);

  // 4.2 Cambiar modalidad a IMPRENTA_DIGITAL y configurar CG Calidad (PRUEBAS, Serie A)
  const modRes = await reqJson(env, jarAdmin, "/api/sistema/medio", "POST", {
    medio: "IMPRENTA_DIGITAL",
    motivo: "Migración oficial a CG Imprenta Digital",
    clave: CLAVE_TEST,
    confirmo: true,
  });
  assert.equal(modRes.status, 200);

  const cfgCg = await reqJson(env, jarAdmin, "/api/sistema/imprenta", "POST", {
    proveedor_tipo: "CG_IMPRENTA",
    proveedor: "CG La Imprenta Digital",
    url: "https://calidad.cgimprenta.digital/",
    usuario: "demo@cg.ve",
    clave: "clave-cg-ambito-2026",
    ambiente: "PRUEBAS",
    serie: "A",
    password: CLAVE_TEST,
    confirmo: true,
  });
  assert.equal(cfgCg.status, 200);

  // Simular también un documento heredado de IMPRENTA_DIGITAL sin fiscal_serial (v5.1) con control 00-00000006
  const fLegado = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    lineas: [{ tipo: "SERVICIO", descripcion: "Servicio legado v5.1", cantidad: "1", precio_usd: "15,00", alicuota_iva: 16 }],
  });
  // Emitir sin mock CG aún (queda pendiente), y simular que v5.1 tenía 00-00000006 con fiscal_serial = NULL
  const fetchOrig = globalThis.fetch;
  let ctrlADevolver = "00-00000005";
  let modoMock: "FALLAR" | "CG_OK" | "TFHKA_OK" = "FALLAR";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (modoMock === "FALLAR") throw new Error("Simulated offline");
    if (url.endsWith("/api/Invoice/create_token_authenticator")) {
      return new Response(JSON.stringify({ success: true, token: "eyJhbGciOiJIUzI1NiJ9.cg-ambito-jwt-1" }), { status: 200 });
    }
    if (url.endsWith("/api/Invoice/add_list_invoice")) {
      return new Response(
        JSON.stringify({
          success: true,
          invoice_list_success: [{ control_number: ctrlADevolver, invoice_pdf: `https://calidad.cgimprenta.digital/pdf/${ctrlADevolver}.pdf` }],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/Autenticacion")) {
      return new Response(JSON.stringify({ codigo: "200", token: "eyJhbGciOiJIUzI1NiJ9.tfhka-ambito-jwt-1" }), { status: 200 });
    }
    if (url.endsWith("/Emision")) {
      return new Response(
        JSON.stringify({
          codigo: "200",
          resultado: { numeroControl: ctrlADevolver, fechaAsignacion: "26/11/2026", horaAsignacion: "07:05:00 PM" },
        }),
        { status: 200 }
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;

  try {
    await reqJson(env, jarAdmin, `/api/documentos/${fLegado.data.id}/emitir`, "POST", {});
    await db.prepare(`UPDATE documentos SET control_fiscal = '00-00000006' WHERE id = ?`).bind(fLegado.data.id).run();

    // 4.3 Ahora CG Calidad devuelve 00-00000005 (mismo que APP_SENIAT) y 00-00000006 (mismo que legado fiscal_serial=NULL): AMBOS DEBEN PASAR
    modoMock = "CG_OK";
    ctrlADevolver = "00-00000005";
    const fCg5 = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Cambio SSD", cantidad: "1", precio_usd: "15,00", alicuota_iva: 16 }],
    });
    const emCg5 = await reqJson(env, jarAdmin, `/api/documentos/${fCg5.data.id}/emitir`, "POST", {});
    assert.equal(emCg5.status, 200);
    assert.equal(emCg5.data.control_fiscal, "00-00000005", "CG PRUEBAS no debe chocar con APP_SENIAT 00-00000005");

    const rowCg5 = await db.prepare(`SELECT control_fiscal, fiscal_serial FROM documentos WHERE id = ?`).bind(fCg5.data.id).first<{ control_fiscal: string; fiscal_serial: string }>();
    assert.equal(rowCg5?.fiscal_serial, "CG_IMPRENTA:PRUEBAS:A");

    // Verificar inmutabilidad de fiscal_serial una vez sellado
    await assert.rejects(
      () => db.prepare(`UPDATE documentos SET fiscal_serial = 'OTRO' WHERE id = ?`).bind(fCg5.data.id).run(),
      /Documento emitido/
    );

    ctrlADevolver = "00-00000006";
    const fCg6 = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Cambio RAM", cantidad: "1", precio_usd: "15,00", alicuota_iva: 16 }],
    });
    const emCg6 = await reqJson(env, jarAdmin, `/api/documentos/${fCg6.data.id}/emitir`, "POST", {});
    assert.equal(emCg6.status, 200);
    assert.equal(emCg6.data.control_fiscal, "00-00000006", "CG PRUEBAS no debe chocar con registro legado sin fiscal_serial");

    // 4.4 Un duplicado REAL dentro del MISMO ámbito (CG_IMPRENTA:PRUEBAS:A devolviendo 00-00000005 otra vez) SÍ DEBE RECHAZARSE
    ctrlADevolver = "00-00000005";
    const fCgDup = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Duplicado mismo ámbito", cantidad: "1", precio_usd: "15,00", alicuota_iva: 16 }],
    });
    const emCgDup = await reqJson(env, jarAdmin, `/api/documentos/${fCgDup.data.id}/emitir`, "POST", {});
    assert.equal(emCgDup.status, 200);
    assert.equal(emCgDup.data.control_fiscal, undefined, "Duplicado en el mismo ámbito CG_IMPRENTA:PRUEBAS:A debe rechazarse");

    // 4.5 Cambiar a The Factory HKA (PRUEBAS) -> su serie propia también arranca en 00-00000005 sin chocar con CG
    const cfgTf = await reqJson(env, jarAdmin, "/api/sistema/imprenta", "POST", {
      proveedor_tipo: "THE_FACTORY_HKA",
      proveedor: "The Factory HKA Venezuela",
      url: HOST_TFHKA_DEMO,
      usuario: "tfhka_user",
      clave: "clave-tfhka-ambito-2026",
      ambiente: "PRUEBAS",
      serie: "",
      sucursal: "0001",
      password: CLAVE_TEST,
      confirmo: true,
    });
    assert.equal(cfgTf.status, 200);

    modoMock = "TFHKA_OK";
    ctrlADevolver = "00-00000005";
    const fTf5 = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Servicio con TFHKA", cantidad: "1", precio_usd: "20,00", alicuota_iva: 16 }],
    });
    const emTf5 = await reqJson(env, jarAdmin, `/api/documentos/${fTf5.data.id}/emitir`, "POST", {});
    assert.equal(emTf5.status, 200);
    assert.equal(emTf5.data.control_fiscal, "00-00000005", "TFHKA PRUEBAS no debe chocar con CG PRUEBAS");
    const rowTf5 = await db.prepare(`SELECT fiscal_serial FROM documentos WHERE id = ?`).bind(fTf5.data.id).first<{ fiscal_serial: string }>();
    assert.equal(rowTf5?.fiscal_serial, "THE_FACTORY_HKA:PRUEBAS");
  } finally {
    globalThis.fetch = fetchOrig;
  }
});

// =========================================================================
// 5. v5.3.0: Constructores puros TFHKA (5 alícuotas G/R/A/E/P, descuentos, USD+VES, IGTF Forma 09, Retenciones 05/06, Guía 04)
// =========================================================================
test("5. v5.3.0 puro: 5 alícuotas G/R/A/E/P, descuentos, moneda base USD, IGTF Forma 09, Sucursal vacía, Retenciones IVA/ISLR y Guía de Despacho", () => {
  // 5.1 Mixta completa con las 5 alícuotas + Sucursal y Serie vacías (confirmado por soporte TFHKA)
  const mixta = construirDocumentoElectronicoTfhka({
    documento_id: 201,
    tipo_documento: "FACTURA",
    numero: 105,
    control_interno: 105,
    fecha_emision: "2026-11-26",
    cliente_rif: "J-30111222-3",
    cliente_nombre: "COMERCIAL MIXTA C.A.",
    subtotal_bs: 500000,
    iva_bs: 55000,
    igtf_bs: 0,
    total_bs: 555000,
    subtotal_usd: 10000,
    iva_usd: 1100,
    igtf_usd: 0,
    total_usd: 11100,
    tasa_e8: 50_00000000,
    renglones: [
      { orden: 1, descripcion: "Item 16%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 1600 },
      { orden: 2, descripcion: "Item 8%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 800 },
      { orden: 3, descripcion: "Item 31%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 3100 },
      { orden: 4, descripcion: "Item Exento", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 0 },
      { orden: 5, descripcion: "Item Percibido", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 0, es_percibido: true },
    ],
  });
  const encM = (mixta.DocumentoElectronico as any).Encabezado;
  const itemsM = (mixta.DocumentoElectronico as any).DetallesItems;
  assert.equal(encM.IdentificacionDocumento.Serie, "");
  assert.equal(encM.IdentificacionDocumento.Sucursal, "");
  assert.deepEqual(itemsM.map((x: any) => x.CodigoImpuesto), ["G", "R", "A", "E", "P"]);
  assert.deepEqual(itemsM.map((x: any) => x.TasaIVA), ["16", "8", "31", "0", "0"]);
  assert.equal(encM.Totales.MontoGravadoTotal, "3000.00");
  assert.equal(encM.Totales.MontoExentoTotal, "1000.00");
  assert.equal(encM.Totales.MontoPercibidoTotal, "1000.00");
  assert.deepEqual(
    encM.Totales.ImpuestosSubtotal.map((x: any) => [x.CodigoTotalImp, x.AlicuotaImp]),
    [
      ["G", "16.00"],
      ["R", "8.00"],
      ["A", "31.00"],
      ["E", "00.00"],
      ["P", "00.00"],
    ]
  );

  // 5.2 Descuento por renglón + Descuento global + IGTF 3% (Forma "09" USD)
  const descIgtf = construirDocumentoElectronicoTfhka({
    documento_id: 202,
    tipo_documento: "FACTURA",
    numero: 106,
    control_interno: 106,
    fecha_emision: "2026-11-26",
    cliente_rif: "J-30111222-3",
    cliente_nombre: "CLIENTE IGTF C.A.",
    descuento_global_bs: 50000,
    descuento_global_usd: 1000,
    descuento_global_desc: "Pronto pago",
    subtotal_bs: 400000,
    iva_bs: 64000,
    igtf_bs: 13920,
    total_bs: 477920,
    subtotal_usd: 8000,
    iva_usd: 1280,
    igtf_usd: 278,
    total_usd: 9558,
    tasa_e8: 50_00000000,
    renglones: [
      {
        orden: 1,
        descripcion: "Servicio con descuento",
        cantidad_milli: 1000,
        precio_usd: 10000,
        descuento_usd: 1000,
        descuento_bs: 50000,
        monto_usd: 9000,
        monto_bs: 450000,
        alicuota_cent: 1600,
      },
    ],
  });
  const encD = (descIgtf.DocumentoElectronico as any).Encabezado;
  const itemD = (descIgtf.DocumentoElectronico as any).DetallesItems[0];
  assert.equal(itemD.PrecioAntesDescuento, "5000.00");
  assert.equal(itemD.DescuentoMonto, "500.00");
  assert.equal(itemD.PrecioItem, "4500.00");
  assert.equal(encD.Totales.SubtotalAntesDescuento, "4500.00");
  assert.equal(encD.Totales.TotalDescuento, "500.00");
  assert.deepEqual(encD.Totales.ListaDescBonificacion, [{ DescDescuento: "Pronto pago", MontoDescuento: "500.00" }]);
  assert.equal(encD.Totales.FormasPago[0].Forma, "09");
  assert.equal(encD.Totales.FormasPago[0].Moneda, "USD");
  assert.equal(encD.Totales.FormasPago[0].TipoCambio, "50.0000");

  // 5.3 Factura moneda base USD pagada en VES sin IGTF (con TotalesOtraMoneda en VES)
  const usdEnBs = construirDocumentoElectronicoTfhka({
    documento_id: 203,
    tipo_documento: "FACTURA",
    numero: 107,
    control_interno: 107,
    fecha_emision: "2026-11-26",
    cliente_rif: "J-30111222-3",
    cliente_nombre: "CLIENTE USD BS C.A.",
    moneda_base: "USD",
    subtotal_bs: 500000,
    iva_bs: 80000,
    igtf_bs: 0,
    total_bs: 580000,
    subtotal_usd: 10000,
    iva_usd: 1600,
    igtf_usd: 0,
    total_usd: 11600,
    tasa_e8: 50_00000000,
    renglones: [{ orden: 1, descripcion: "Suscripción USD", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600 }],
  });
  const encU = (usdEnBs.DocumentoElectronico as any).Encabezado;
  assert.equal(encU.IdentificacionDocumento.Moneda, "USD");
  assert.equal(encU.Totales.TotalAPagar, "116.00");
  assert.equal(encU.Totales.FormasPago[0].Forma, "02");
  assert.equal(encU.Totales.FormasPago[0].Moneda, "VES");
  assert.equal(encU.Totales.FormasPago[0].TipoCambio, "50.0000");
  assert.equal(encU.TotalesOtraMoneda.Moneda, "VES");
  assert.equal(encU.TotalesOtraMoneda.TotalAPagar, "5800.00");

  // 5.4 Retención IVA 75% (05), Retención ISLR (06) y Guía de Despacho (04)
  const retIva = construirComprobanteRetencionIvaTfhka({
    numero: 201,
    numero_comprobante: "20261100000001",
    fecha_emision: "2026-11-26",
    sujeto_rif: "J-30111222-3",
    sujeto_nombre: "PROVEEDOR DEMO C.A.",
    factura_fecha: "2026-11-26",
    factura_numero: 105,
    factura_control: "00-00000105",
    monto_total_bs: 580000,
    monto_exento_bs: 0,
    base_imponible_bs: 500000,
    alicuota_iva_cent: 1600,
    porcentaje_retencion_cent: 7500,
    monto_iva_bs: 80000,
    monto_retenido_bs: 60000,
  });
  assert.equal((retIva.DocumentoElectronico as any).Encabezado.IdentificacionDocumento.TipoDocumento, "05");
  assert.equal((retIva.DocumentoElectronico as any).DetallesRetencion[0].Porcentaje, "0.16");
  assert.equal((retIva.DocumentoElectronico as any).DetallesRetencion[0].PorcentajeRetencion, "0.75");
  assert.equal((retIva.DocumentoElectronico as any).DetallesRetencion[0].Percibido, "200.00");

  const retIslr = construirComprobanteRetencionIslrTfhka({
    numero: 202,
    numero_comprobante: "20261100000002",
    fecha_emision: "2026-11-26",
    sujeto_rif: "J-30111222-3",
    sujeto_nombre: "PROVEEDOR SERVICIOS C.A.",
    factura_fecha: "2026-11-26",
    factura_numero: 105,
    factura_control: "00-00000105",
    monto_total_bs: 580000,
    base_imponible_bs: 500000,
    porcentaje_retencion_cent: 200,
    monto_retenido_bs: 10000,
  });
  assert.equal((retIslr.DocumentoElectronico as any).Encabezado.IdentificacionDocumento.TipoDocumento, "06");
  assert.equal((retIslr.DocumentoElectronico as any).Encabezado.TotalesRetencion.TotalISRL, "100.00");
  assert.equal((retIslr.DocumentoElectronico as any).Encabezado.TotalesRetencion.TipoComprobante, "1");

  const guia = construirGuiaDespachoTfhka({
    numero: 203,
    fecha_emision: "2026-11-26",
    cliente_rif: "J-30111222-3",
    cliente_nombre: "DESTINATARIO C.A.",
    motivo_traslado: "Traslado mercancía",
    origen_producto: "Caracas",
    destino_producto: "Valencia",
    conductor_nombre: "Pedro Chofer",
    conductor_rif: "V-15000000",
    vehiculo_placa: "AA123BB",
    renglones: [{ descripcion: "Servidores", cantidad_milli: 2000 }],
  });
  assert.equal((guia.DocumentoElectronico as any).Encabezado.IdentificacionDocumento.TipoDocumento, "04");
  assert.equal((guia.DocumentoElectronico as any).GuiaDespacho.esGuiaDespacho, "1");
  assert.equal((guia.DocumentoElectronico as any).GuiaDespacho.numeroPlaca, "AA123BB");
});

// =========================================================================
// 6. v5.3.0 E2E: /api/ auto-fallback, ConsultaNumeraciones, DescargaArchivo PDF, AplicarRetencion y Suite Certificación 21 pruebas
// =========================================================================
test("6. v5.3.0 E2E TFHKA: /api/ auto-prefix, ConsultaNumeraciones, DescargaArchivo PDF, AplicarRetencion y Suite Demo 21 casos (403 en PRODUCCION)", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = {
    DB: db,
    MASTER_KEY: "llave-maestra-tfhka-v530-test",
    SUPER_ADMIN_EMAIL: "admin@v530.ve",
  };
  const jarAdmin: Record<string, string> = {};

  const inst = await reqJson(env, jarAdmin, "/api/instalar", "POST", {
    nombre: "EXENET CERTIFICACION C.A.",
    rif: "J-40998877-6",
    direccion: "Caracas, Venezuela",
    telefono: "0414-1234567",
    email: "admin@v530.ve",
    clave: CLAVE_TEST,
    tipo_contribuyente: "ESPECIAL",
    medio_facturacion: "IMPRENTA_DIGITAL",
  });
  assert.equal(inst.status, 200);
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv = '50.00', tasa_bcv_fecha = ? WHERE id = 1`).bind(new Date().toISOString()).run();
  await db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`).run();

  // Configurar TFHKA con Serie="" y Sucursal="" (ambos vacíos opcionales) y host raíz (para probar auto-fallback a /api/)
  const cfgSave = await reqJson(env, jarAdmin, "/api/sistema/imprenta", "POST", {
    proveedor_tipo: "THE_FACTORY_HKA",
    proveedor: "The Factory HKA Venezuela",
    url: HOST_TFHKA_DEMO,
    usuario: "demo_v530",
    clave: "clave-v530-sintetica",
    ambiente: "PRUEBAS",
    serie: "",
    sucursal: "",
    reservar_previo: false,
    password: CLAVE_TEST,
    confirmo: true,
  });
  assert.equal(cfgSave.status, 200);
  assert.equal(cfgSave.data.sucursal, "");
  assert.equal(cfgSave.data.serie, "");

  const cli = await reqJson(env, jarAdmin, "/api/clientes", "POST", {
    rif_cedula: "J-30111222-3",
    nombre_apellido: "CLIENTE DEMO V530 C.A.",
    direccion: "Caracas",
    email: "cli@v530.ve",
  });
  assert.equal(cli.status, 200);

  const fetchOrig = globalThis.fetch;
  const emitidosMock = new Set<string>();
  let ctrlSeq = 900;
  const rutasVistas: string[] = [];
  const pdfSintetico = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    rutasVistas.push(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    // Simular servidor que expone endpoints bajo /api/... (devolviendo 404 en /Autenticacion sin /api/)
    if (url === `${HOST_TFHKA_DEMO}Autenticacion`) {
      return new Response(JSON.stringify({ mensaje: "Not found" }), { status: 404 });
    }
    if (url === `${HOST_TFHKA_DEMO}api/Autenticacion`) {
      return new Response(JSON.stringify({ codigo: "200", token: "eyJ-tfhka-v530-api-prefix-jwt" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === `${HOST_TFHKA_DEMO}api/ConsultaNumeraciones`) {
      return new Response(
        JSON.stringify({
          codigo: "200",
          resultado: { disponibles: 480, utilizados: 20, totalAsignados: 500, numeraciones: [{ serie: "", disponibles: 480 }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url === `${HOST_TFHKA_DEMO}api/DescargaArchivo`) {
      return new Response(
        JSON.stringify({ codigo: "200", resultado: { archivo: btoa(pdfSintetico) } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url === `${HOST_TFHKA_DEMO}api/AplicarRetencion`) {
      return new Response(JSON.stringify({ codigo: "200", mensaje: "Retención aplicada" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === `${HOST_TFHKA_DEMO}api/Emision`) {
      const idDoc = body?.DocumentoElectronico?.Encabezado?.IdentificacionDocumento;
      const tipo = String(idDoc?.TipoDocumento ?? "");
      const num = String(idDoc?.NumeroDocumento ?? "");
      const comp = body?.DocumentoElectronico?.Encabezado?.Comprador;
      const suj = body?.DocumentoElectronico?.Encabezado?.SujetoRetenido;
      if (!num || (!comp?.NumeroIdentificacion && !suj?.NumeroIdentificacion)) {
        return new Response(JSON.stringify({ codigo: "400", mensaje: "Faltan campos obligatorios (NumeroDocumento / Receptor)" }), { status: 400 });
      }
      const key = `${tipo}:${num}`;
      if (emitidosMock.has(key)) {
        return new Response(JSON.stringify({ codigo: "409", mensaje: `Documento ${num} ya fue emitido (duplicado)` }), { status: 409 });
      }
      emitidosMock.add(key);
      ctrlSeq++;
      return new Response(
        JSON.stringify({
          codigo: "200",
          resultado: {
            numeroControl: `00-${String(ctrlSeq).padStart(8, "0")}`,
            fechaAsignacion: "26/11/2026",
            horaAsignacion: "11:30:00 AM",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: `Ruta inesperada: ${url}` }), { status: 404 });
  }) as typeof fetch;

  try {
    // 6.1 Probar conexión -> auto-descubre /api/ y consulta ConsultaNumeraciones (480 disponibles de 500)
    const probar = await reqJson(env, jarAdmin, "/api/sistema/imprenta/probar", "POST", {});
    assert.equal(probar.status, 200, `Probar falló: ${JSON.stringify(probar.data)}`);
    assert.equal(probar.data.api_prefix, "api/");
    assert.equal(probar.data.numeraciones?.disponibles, 480);
    assert.equal(probar.data.numeraciones?.total_asignados, 500);
    assert.ok(String(probar.data.mensaje).includes("480 N.º de control disponibles"));

    // 6.2 Endpoint directo POST /api/sistema/imprenta/numeraciones
    const numRes = await reqJson(env, jarAdmin, "/api/sistema/imprenta/numeraciones", "POST", {});
    assert.equal(numRes.status, 200);
    assert.equal(numRes.data.numeraciones?.disponibles, 480);

    // 6.3 Emitir 1 factura real y descargar su PDF oficial vía GET /api/documentos/:id/imprenta-pdf
    const bor = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      lineas: [{ tipo: "SERVICIO", descripcion: "Servicio v530", cantidad: "1", precio_usd: "25,00", alicuota_iva: 16 }],
    });
    const em = await reqJson(env, jarAdmin, `/api/documentos/${bor.data.id}/emitir`, "POST", {});
    assert.equal(em.status, 200);
    assert.ok(em.data.control_fiscal);

    const cookieHdr = Object.entries(jarAdmin)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const pdfHttp = await app.fetch(
      new Request(`http://local/api/documentos/${bor.data.id}/imprenta-pdf`, {
        method: "GET",
        headers: { Cookie: cookieHdr },
      }),
      env
    );
    assert.equal(pdfHttp.status, 200);
    assert.equal(pdfHttp.headers.get("content-type"), "application/pdf");
    const pdfTxt = await pdfHttp.text();
    assert.ok(pdfTxt.startsWith("%PDF-1.4"), "Debe retornar los bytes %PDF reales desde DescargaArchivo");

    // 6.4 AplicarRetencion vía conector
    const cfgLive = await (await import("../src/imprenta-cg")).leerConfigImprentaCompleta(db, env);
    const retApp = await aplicarRetencionTfhka(db, env, cfgLive, {
      numero_documento: 1,
      numero_control: em.data.control_fiscal,
      base_imponible_bs: 125000,
      numero_comprobante_retencion: "20261100000099",
      fecha_emision_cr: "2026-11-26",
      total_iva_bs: 20000,
      total_retenido_bs: 15000,
    });
    assert.equal(retApp.ok, true);

    // 6.5 Ejecutar Suite de Certificación Demo (21 pruebas) sin ensuciar la tabla local documentos
    const docsAntes = (await db.prepare(`SELECT COUNT(*) AS n FROM documentos`).first<{ n: number }>())?.n ?? 0;
    const cert = await reqJson(env, jarAdmin, "/api/sistema/imprenta/certificar-tfhka", "POST", {
      numero_inicio: 500,
      email_prueba: "cert@v530.ve",
      incluir_errores: true,
      password: CLAVE_TEST,
      confirmo: true,
    });
    assert.equal(cert.status, 200, `Certificación falló: ${JSON.stringify(cert.data)}`);
    assert.equal(cert.data.ok, true);
    assert.equal(cert.data.resumen.total, 21);
    assert.equal(cert.data.resumen.aprobados, 19);
    assert.equal(cert.data.resumen.errores_controlados_ok, 2);
    assert.equal(cert.data.resumen.fallidos, 0);
    assert.ok(String(cert.data.reporte_texto).includes("21/21 OK"));

    const docsDespues = (await db.prepare(`SELECT COUNT(*) AS n FROM documentos`).first<{ n: number }>())?.n ?? 0;
    assert.equal(docsDespues, docsAntes, "La Suite de Certificación Demo JAMÁS debe insertar filas en documentos locales");

    // 6.6 Cambiar a PRODUCCION -> certificar-tfhka DEBE bloquearse con HTTP 403
    const cfgProd = await reqJson(env, jarAdmin, "/api/sistema/imprenta", "POST", {
      proveedor_tipo: "THE_FACTORY_HKA",
      proveedor: "The Factory HKA Venezuela",
      url: HOST_TFHKA_PROD,
      usuario: "prod_v530",
      clave: "clave-prod-sintetica",
      ambiente: "PRODUCCION",
      serie: "",
      sucursal: "",
      password: CLAVE_TEST,
      confirmo: true,
    });
    assert.equal(cfgProd.status, 200);

    const certProd = await reqJson(env, jarAdmin, "/api/sistema/imprenta/certificar-tfhka", "POST", {
      numero_inicio: 600,
      password: CLAVE_TEST,
      confirmo: true,
    });
    assert.equal(certProd.status, 403, "En PRODUCCION la suite de certificación debe estar estrictamente bloqueada (403)");
  } finally {
    globalThis.fetch = fetchOrig;
  }
});


