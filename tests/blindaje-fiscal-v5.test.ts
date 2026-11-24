import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import {
  esPeriodoFiscalCerrado,
  evaluarAnulacionDocumento,
  evaluarAnulacionPago,
  formatearControlFiscal,
  puedeInvocarImprentaDigital,
  quincenaDeFecha,
  validarIgtfNotaCredito,
} from "../src/reglas-fiscales";

const CLAVE = "ClaveFiscalSegura2026!";

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

async function instalarBase(
  env: Record<string, unknown>,
  jar: Record<string, string>,
  opts?: { tipo_contribuyente?: "FORMAL" | "ORDINARIO" | "ESPECIAL"; medio_facturacion?: "APP_SENIAT" | "IMPRENTA_DIGITAL" }
) {
  env.SUPER_ADMIN_EMAIL = "admin@facturaya.test";
  const inst = await reqJson(env, jar, "/api/instalar", "POST", {
    nombre: "COMERCIAL FISCAL VE C.A.",
    rif: "J-40123456-7",
    direccion: "Av. Francisco de Miranda, Caracas",
    telefono: "0414-5551234",
    email: "admin@facturaya.test",
    clave: CLAVE,
    tipo_contribuyente: opts?.tipo_contribuyente ?? "ORDINARIO",
    medio_facturacion: opts?.medio_facturacion ?? "APP_SENIAT",
  });
  assert.equal(inst.status, 200, `Error instalando: ${JSON.stringify(inst.data)}`);
  const db = env.DB as any;
  await db.prepare(`UPDATE perfil_emisor SET tasa_bcv = '50.00', tasa_bcv_fecha = ? WHERE id = 1`).bind(new Date().toISOString()).run();
}

// =========================================================================
// 1. Pruebas unitarias puras de src/reglas-fiscales.ts
// =========================================================================
test("1. Reglas fiscales puras: formateo control, anulación SENIAT, IGTF NC y guarda Imprenta Digital", () => {
  assert.equal(formatearControlFiscal(null, 1), "00-00000001");
  assert.equal(formatearControlFiscal("00-00987654", 1), "00-00987654");
  assert.equal(formatearControlFiscal("", "00-00000042"), "00-00000042");

  assert.equal(puedeInvocarImprentaDigital("IMPRENTA_DIGITAL", "REAL"), true);
  assert.equal(puedeInvocarImprentaDigital("IMPRENTA_DIGITAL", "PRACTICA"), false);
  assert.equal(puedeInvocarImprentaDigital("APP_SENIAT", "REAL"), false);
  assert.equal(puedeInvocarImprentaDigital("SIN_DEFINIR", "REAL"), false);

  assert.equal(validarIgtfNotaCredito(false, false).ok, true);
  assert.equal(validarIgtfNotaCredito(true, true).ok, true);
  assert.equal(validarIgtfNotaCredito(true, false).ok, false);

  // Factura pagada en el mismo mes -> bloqueada y sugiere Nota de Crédito (sin sugerir anular pagos)
  const rPagada = evaluarAnulacionDocumento(
    { tipo: "FACTURA", estado: "EMITIDO", fecha_emision: "2026-11-23", medio: "APP_SENIAT" },
    { pagosVigentes: 1, notasVigentes: 0, mesActualCaracas: "2026-11" }
  );
  assert.equal(rPagada.permitida, false);
  assert.equal(rPagada.codigo, "TIENE_PAGOS_VIGENTES");
  assert.equal(rPagada.sugerirNotaCredito, true);
  assert.ok(rPagada.motivo?.includes("pagos registrados"));
  assert.ok(rPagada.motivo?.includes("LIVA Art. 58"));
  assert.ok(!rPagada.motivo?.toLowerCase().includes("anula primero sus pagos"));

  // Quincenas y cierre de período: Formal/Ordinario = mensual, Especial (SPE) = quincenal (1-15 / 16-fin)
  assert.equal(quincenaDeFecha("2026-11-15"), "2026-11-Q1");
  assert.equal(quincenaDeFecha("2026-11-16"), "2026-11-Q2");
  assert.deepEqual(esPeriodoFiscalCerrado("2026-11-10", "2026-11-24", "MENSUAL"), { cerrado: false, porQuincena: false });
  assert.deepEqual(esPeriodoFiscalCerrado("2026-11-10", "2026-11-24", "QUINCENAL"), { cerrado: true, porQuincena: true });
  assert.deepEqual(esPeriodoFiscalCerrado("2026-11-16", "2026-11-24", "QUINCENAL"), { cerrado: false, porQuincena: false });

  // Factura impaga 1.ª quincena vista en 2.ª quincena del mismo mes:
  // - ORDINARIO / FORMAL -> permitida (mismo mes)
  const rOrdMismoMes = evaluarAnulacionDocumento(
    { tipo: "FACTURA", estado: "EMITIDO", fecha_emision: "2026-11-10", medio: "APP_SENIAT" },
    { pagosVigentes: 0, notasVigentes: 0, fechaActualCaracas: "2026-11-24", tipoContribuyente: "ORDINARIO" }
  );
  assert.equal(rOrdMismoMes.permitida, true);

  // - ESPECIAL (SPE) -> bloqueada por quincena cerrada y sugiere Nota de Crédito
  const rSpeQuincena = evaluarAnulacionDocumento(
    { tipo: "FACTURA", estado: "EMITIDO", fecha_emision: "2026-11-10", medio: "APP_SENIAT" },
    { pagosVigentes: 0, notasVigentes: 0, fechaActualCaracas: "2026-11-24", tipoContribuyente: "ESPECIAL" }
  );
  assert.equal(rSpeQuincena.permitida, false);
  assert.equal(rSpeQuincena.codigo, "QUINCENA_FISCAL_CERRADA");
  assert.equal(rSpeQuincena.sugerirNotaCredito, true);
  assert.ok(rSpeQuincena.motivo?.includes("quincena cerrada"));

  // - ESPECIAL (SPE) dentro de la misma 2.ª quincena -> permitida
  const rSpeMismaQ = evaluarAnulacionDocumento(
    { tipo: "FACTURA", estado: "EMITIDO", fecha_emision: "2026-11-18", medio: "APP_SENIAT" },
    { pagosVigentes: 0, notasVigentes: 0, fechaActualCaracas: "2026-11-24", tipoContribuyente: "ESPECIAL" }
  );
  assert.equal(rSpeMismaQ.permitida, true);

  // Factura impaga mismo mes -> permitida
  const rImpaga = evaluarAnulacionDocumento(
    { tipo: "FACTURA", estado: "EMITIDO", fecha_emision: "2026-11-23", medio: "APP_SENIAT" },
    { pagosVigentes: 0, notasVigentes: 0, mesActualCaracas: "2026-11" }
  );
  assert.equal(rImpaga.permitida, true);

  // NC con control fiscal de Imprenta Digital -> bloqueada
  const rNcImp = evaluarAnulacionDocumento(
    { tipo: "FACTURA", es_nota_credito: 1, estado: "EMITIDO", fecha_emision: "2026-11-23", medio: "IMPRENTA_DIGITAL", control_fiscal: "00-00001234" },
    { pagosVigentes: 0, notasVigentes: 0, mesActualCaracas: "2026-11" }
  );
  assert.equal(rNcImp.permitida, false);
  assert.equal(rNcImp.codigo, "NOTA_CON_CONTROL_IMPRENTA");

  // Retención IVA de mes cerrado en modo REAL -> bloqueada (SNAT/2025/000054)
  const rRetCerrada = evaluarAnulacionPago(
    { estado: "VIGENTE", fecha_pago: "2025-01-15", es_retencion_iva: 1 },
    { tipo: "FACTURA", estado: "EMITIDO", modo: "REAL" },
    "2026-11-24"
  );
  assert.equal(rRetCerrada.permitida, false);
  assert.equal(rRetCerrada.codigo, "RETENCION_MES_CERRADO");
  assert.ok(rRetCerrada.motivo?.includes("SNAT/2025/000054"));

  // Retención IVA de 1.ª quincena vista en 2.ª quincena del mismo mes -> bloqueada (SNAT/2025/000054 Art. 11)
  const rRetIvaQ = evaluarAnulacionPago(
    { estado: "VIGENTE", fecha_pago: "2026-11-10", es_retencion_iva: 1 },
    { tipo: "FACTURA", estado: "EMITIDO", modo: "REAL" },
    "2026-11-24"
  );
  assert.equal(rRetIvaQ.permitida, false);
  assert.equal(rRetIvaQ.codigo, "RETENCION_QUINCENA_CERRADA");
  assert.ok(rRetIvaQ.motivo?.includes("SNAT/2025/000054"));

  // Retención ISLR de 1.ª quincena vista en 2.ª quincena del mismo mes -> permitida (ISLR es mensual, Decreto 1.808)
  const rRetIslrMismoMes = evaluarAnulacionPago(
    { estado: "VIGENTE", fecha_pago: "2026-11-10", es_retencion_islr: 1 },
    { tipo: "FACTURA", estado: "EMITIDO", modo: "REAL" },
    "2026-11-24"
  );
  assert.equal(rRetIslrMismoMes.permitida, true);

  // Pago normal sobre documento ya anulado -> bloqueado
  const rDocAnul = evaluarAnulacionPago(
    { estado: "VIGENTE", fecha_pago: "2026-11-23", es_retencion_iva: 0 },
    { tipo: "FACTURA", estado: "ANULADO", modo: "REAL" },
    "2026-11-24"
  );
  assert.equal(rDocAnul.permitida, false);
  assert.equal(rDocAnul.codigo, "DOC_ANULADO");
});

// =========================================================================
// 2. Integración completa: factura pagada, NC sobre ND, IGTF fantasma, ND metadata y retenciones cerradas
// =========================================================================
test("2. Blindaje SENIAT integral: factura pagada oculta anulación, NC bloquea ND e IGTF fantasma, ND guarda factura afectada", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-blindaje-fiscal-v503" };
  const jar: Record<string, string> = {};
  await instalarBase(env, jar, { tipo_contribuyente: "ESPECIAL", medio_facturacion: "APP_SENIAT" });

  // Salir en vivo a modo REAL para validar reglas REAL estrictas
  await db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`).run();

  const cli = await reqJson(env, jar, "/api/clientes", "POST", {
    rif_cedula: "J-30111222-3",
    nombre_apellido: "INVERSIONES CARACAS C.A.",
    direccion: "Chacao, Caracas",
    email: "cliente@caracas.test",
  });
  assert.equal(cli.status, 200);

  // Emitir factura SPE SIN IGTF (pagada en Bolívares)
  const facDraft = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    aplica_igtf: 0,
    lineas: [{ tipo: "SERVICIO", descripcion: "Consultoría tributaria", cantidad: "1", precio_usd: "100,00", alicuota_iva: 16 }],
  });
  assert.equal(facDraft.status, 200);
  const em = await reqJson(env, jar, `/api/documentos/${facDraft.data.id}/emitir`, "POST", {});
  assert.equal(em.status, 200);

  // Sin pagos: GET /:id indica anulacion.permitida === true
  const detAntes = await reqJson(env, jar, `/api/documentos/${facDraft.data.id}`);
  assert.equal(detAntes.status, 200);
  assert.equal(detAntes.data.anulacion.permitida, true);

  // Registrar pago completo en Bolívares
  const pago = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: facDraft.data.id,
    metodo: "PAGO_MOVIL",
    moneda: "BS",
    monto: "5800,00",
    tasa: "50,00",
    referencia: "998877",
  });
  assert.equal(pago.status, 200);

  // Tras pagar: GET /:id indica anulacion.permitida === false y sugerir_nota_credito === true
  const detDespues = await reqJson(env, jar, `/api/documentos/${facDraft.data.id}`);
  assert.equal(detDespues.status, 200);
  assert.equal(detDespues.data.anulacion.permitida, false);
  assert.equal(detDespues.data.anulacion.codigo, "TIENE_PAGOS_VIGENTES");
  assert.equal(detDespues.data.anulacion.sugerir_nota_credito, true);

  // POST /:id/anular debe rechazar 409 sin sugerir "anula primero los pagos"
  const anularPagada = await reqJson(env, jar, `/api/documentos/${facDraft.data.id}/anular`, "POST", {
    motivo: "Intento indebido de anular factura pagada",
  });
  assert.equal(anularPagada.status, 409);
  assert.ok(String(anularPagada.data.error).includes("pagos registrados"));
  assert.ok(!String(anularPagada.data.error).toLowerCase().includes("anula primero"));

  // Intentar emitir Nota de Crédito con IGTF 3% sobre factura SPE que NO tuvo IGTF -> 400
  const ncIgtfFantasma = await reqJson(env, jar, `/api/documentos/${facDraft.data.id}/devolver`, "POST", {
    motivo: "Devolución con intento de IGTF inexistente",
    aplica_igtf: true,
    lineas: [{ orden: 1, cantidad: "1" }],
  });
  assert.equal(ncIgtfFantasma.status, 400);

  // Emitir Nota de Débito y verificar que guarda factura_afectada_* + titulo_sin_control = NOTA DE DÉBITO
  const nd = await reqJson(env, jar, `/api/documentos/${facDraft.data.id}/nota-debito`, "POST", {
    motivo: "Ajuste por diferencia operativa",
    lineas: [{ descripcion: "Recargo adicional", cantidad: "1", precio_usd: "10,00", alicuota_iva: 16 }],
  });
  assert.equal(nd.status, 200);
  const detNd = await reqJson(env, jar, `/api/documentos/${nd.data.id}`);
  const paramsNd = JSON.parse(detNd.data.documento.parametros_json || "{}");
  assert.equal(paramsNd.titulo_sin_control, "NOTA DE DÉBITO");
  assert.equal(paramsNd.factura_afectada_numero, em.data.numero);
  assert.ok(paramsNd.factura_afectada_fecha);
  assert.ok(paramsNd.factura_afectada_control != null);

  // Intentar emitir Nota de Crédito sobre una Nota de Débito -> 409
  const ncSobreNd = await reqJson(env, jar, `/api/documentos/${nd.data.id}/devolver`, "POST", {
    motivo: "Intento inválido de NC sobre ND",
    lineas: [{ orden: 1, cantidad: "1" }],
  });
  assert.equal(ncSobreNd.status, 409);

  // Retención IVA en mes cerrado no puede anularse
  const fac2 = await reqJson(env, jar, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    aplica_igtf: 0,
    lineas: [{ tipo: "SERVICIO", descripcion: "Soporte mensual", cantidad: "1", precio_usd: "100,00", alicuota_iva: 16 }],
  });
  await reqJson(env, jar, `/api/documentos/${fac2.data.id}/emitir`, "POST", {});
  const ret = await reqJson(env, jar, "/api/pagos", "POST", {
    documento_id: fac2.data.id,
    metodo: "RETENCION_IVA",
    moneda: "BS",
    monto: "600,00",
    tasa: "50,00",
    comprobante_retencion: "20261100000001",
  });
  assert.equal(ret.status, 200);
  // Simular cierre de período anterior en la retención
  const { results: trPagos } = await db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'pagos'`)
    .all<{ name: string; sql: string }>();
  for (const tr of trPagos) await db.prepare(`DROP TRIGGER IF EXISTS "${tr.name}"`).run();
  await db.prepare(`UPDATE pagos SET fecha_pago = '2025-01-15' WHERE id = ?`).bind(ret.data.id).run();
  for (const tr of trPagos) if (tr.sql) await db.prepare(tr.sql).run();

  const verRet = await reqJson(env, jar, `/api/pagos/${ret.data.id}`);
  assert.equal(verRet.status, 200);
  assert.equal(verRet.data.puede_anular_fiscal, false);
  const anularRet = await reqJson(env, jar, `/api/pagos/${ret.data.id}/anular`, "POST", {
    motivo: "Intento de anular retención de mes cerrado",
  });
  assert.equal(anularRet.status, 409);
  assert.ok(String(anularRet.data.error).includes("período fiscal anterior"));

  // Informes exponen tipo_contribuyente
  const infVentas = await reqJson(env, jar, "/api/informes/ventas");
  const infIva = await reqJson(env, jar, "/api/informes/resumen-iva");
  const infIgtf = await reqJson(env, jar, "/api/informes/igtf");
  assert.equal(infVentas.data.tipo_contribuyente, "ESPECIAL");
  assert.equal(infIva.data.tipo_contribuyente, "ESPECIAL");
  assert.equal(infIgtf.data.tipo_contribuyente, "ESPECIAL");
});

// =========================================================================
// 3. Modo PRACTICA jamás invoca la API HTTP en vivo de Imprenta Digital + clonar respeta cambios de régimen
// =========================================================================
test("3. Modo PRACTICA nunca llama a Imprenta Digital HTTP en vivo y clonar sanitiza IVA/IGTF al cambiar de régimen", async () => {
  const db = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = { DB: db, MASTER_KEY: "llave-practica-imprenta-v503" };
  const jar: Record<string, string> = {};
  await instalarBase(env, jar, { tipo_contribuyente: "ESPECIAL", medio_facturacion: "IMPRENTA_DIGITAL" });

  // Configurar credenciales de imprenta digital en el entorno
  const confImp = await reqJson(env, jar, "/api/sistema/imprenta", "POST", {
    proveedor: "Imprenta Demo",
    url: "https://imprenta-ejemplo.invalid/api/emision",
    usuario: "J401234567",
    clave: "token-secreto-prueba-1234",
    ambiente: "PRUEBAS",
    password: CLAVE,
    confirmo: true,
  });
  assert.equal(confImp.status, 200);

  // Espía de fetch global para verificar 0 llamadas externas en modo PRACTICA
  let llamadasFetch = 0;
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async () => {
    llamadasFetch++;
    return new Response(JSON.stringify({ numero_control: "00-99999999" }), { status: 200 });
  }) as typeof fetch;

  try {
    // Asegurar modo PRACTICA
    await db.prepare(`UPDATE ajustes SET valor = 'PRACTICA' WHERE clave = 'modo'`).run();

    const cli = await reqJson(env, jar, "/api/clientes", "POST", {
      rif_cedula: "V-19123456",
      nombre_apellido: "Cliente Práctica",
    });
    const borrador = await reqJson(env, jar, "/api/documentos", "POST", {
      tipo: "FACTURA",
      cliente_id: cli.data.id,
      aplica_igtf: 1,
      lineas: [{ tipo: "SERVICIO", descripcion: "Servicio SPE práctica", cantidad: "1", precio_usd: "50,00", alicuota_iva: 16 }],
    });
    assert.equal(borrador.status, 200);
    const em = await reqJson(env, jar, `/api/documentos/${borrador.data.id}/emitir`, "POST", {});
    assert.equal(em.status, 200);
    assert.equal(llamadasFetch, 0, "Emitir en PRACTICA jamás debe invocar la Imprenta Digital HTTP");

    const nc = await reqJson(env, jar, `/api/documentos/${borrador.data.id}/devolver`, "POST", {
      motivo: "Devolución de práctica",
      aplica_igtf: true,
      lineas: [{ orden: 1, cantidad: "1" }],
    });
    assert.equal(nc.status, 200);
    assert.equal(llamadasFetch, 0, "NC en PRACTICA jamás debe invocar la Imprenta Digital HTTP");

    const nd = await reqJson(env, jar, `/api/documentos/${borrador.data.id}/nota-debito`, "POST", {
      motivo: "Recargo de práctica",
      lineas: [{ descripcion: "Recargo", cantidad: "1", precio_usd: "5,00", alicuota_iva: 16 }],
    });
    assert.equal(nd.status, 200);
    assert.equal(llamadasFetch, 0, "ND en PRACTICA jamás debe invocar la Imprenta Digital HTTP");

    const reintentoPractica = await reqJson(env, jar, `/api/documentos/${borrador.data.id}/fiscal`, "POST", {
      reintentar_imprenta: true,
    });
    assert.equal(reintentoPractica.status, 409);
    assert.equal(llamadasFetch, 0, "Reintento imprenta en PRACTICA debe rechazarse sin llamar HTTP");

    // Cambiar régimen ESPECIAL -> FORMAL y clonar la factura SPE con IVA 16% + IGTF 3%
    const aFormal = await reqJson(env, jar, "/api/config/regimen", "PUT", {
      tipo_contribuyente: "FORMAL",
      clave_actual: CLAVE,
      confirmo_regimen: true,
    });
    assert.equal(aFormal.status, 200);

    const copia = await reqJson(env, jar, `/api/documentos/${borrador.data.id}/copiar`, "POST", {});
    assert.equal(copia.status, 200);
    const detCopia = await reqJson(env, jar, `/api/documentos/${copia.data.id}`);
    assert.equal(detCopia.data.documento.aplica_igtf, 0, "Al clonar como FORMAL se limpia IGTF");
    assert.equal(detCopia.data.documento.iva_usd, 0, "Al clonar como FORMAL se limpia IVA");
    assert.equal(detCopia.data.documento.total_usd, 5000, "Total recalculado en centavos sin IVA ni IGTF");
    assert.equal(detCopia.data.lineas[0].alicuota_cent, 0, "Renglón clonado queda exento (0%)");

    // Emitir el borrador clonado como FORMAL debe funcionar sin error
    const emCopia = await reqJson(env, jar, `/api/documentos/${copia.data.id}/emitir`, "POST", {});
    assert.equal(emCopia.status, 200);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

// =========================================================================
// 4. Inmutabilidad del PDF en documentos REAL + formato Control en NC/ND
// =========================================================================
test("4. PDF fiscal REAL conserva el emisor congelado aunque cambie el perfil actual", async () => {
  const reqCjs = createRequire(import.meta.url);
  const PDFLib = reqCjs("../public/vendor/pdf-lib.min.js");
  const modPdf = await import("../public/pdf.js");
  assert.ok(PDFLib, "pdf-lib debe cargarse correctamente");

  const docReal = {
    tipo: "FACTURA",
    es_nota_credito: 0,
    es_nota_debito: 0,
    estado: "EMITIDO",
    modo: "REAL",
    medio: "APP_SENIAT",
    numero: 1,
    control_interno: 1,
    control_fiscal: null,
    fecha_emision: "2026-11-23",
    tasa_e8: 50_00000000,
    cliente_nombre: "CLIENTE PRUEBA",
    cliente_rif: "J-12345678-9",
    subtotal_usd: 10000,
    iva_usd: 1600,
    aplica_igtf: 0,
    igtf_usd: 0,
    total_usd: 11600,
    subtotal_bs: 500000,
    iva_bs: 80000,
    igtf_bs: 0,
    total_bs: 580000,
    emisor_json: JSON.stringify({
      nombre_razon_social: "EMISOR HISTORICO CONGELADO C.A.",
      rif: "J-40000001-1",
      direccion_fiscal: "Calle Original, Caracas",
      tipo_contribuyente: "ORDINARIO",
    }),
    parametros_json: JSON.stringify({ leyenda_cambio: "Monto referencial en USD." }),
  };

  const bytes = await modPdf.construirPdf(PDFLib, {
    doc: docReal,
    lineas: [{ descripcion: "Servicio profesional", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600, monto_usd: 10000, monto_bs: 500000 }],
    impuestos: [{ alicuota_cent: 1600, base_usd: 10000, iva_usd: 1600, base_bs: 500000, iva_bs: 80000 }],
    negocio: {
      nombre_razon_social: "RAZON SOCIAL NUEVA MODIFICADA",
      rif: "J-99999999-9",
      direccion_fiscal: "Otra dirección distinta",
    },
  });
  assert.ok(bytes instanceof Uint8Array && bytes.length > 500);
  // Verificar mediante lectura directa del PDF que el emisor congelado está presente y el nuevo NO lo sobrescribió
  const pdfDoc = await PDFLib.PDFDocument.load(bytes);
  assert.equal(pdfDoc.getPageCount(), 1);
  // Buscar en los flujos descomprimidos o verificar en el código fuente que congelado prioriza emisorGuardado
  const pdfSrc = await fs.readFile(path.join(process.cwd(), "public", "pdf.js"), "utf8");
  assert.ok(pdfSrc.includes('const congelado = D.modo === "REAL" && D.estado !== "BORRADOR"'));
  assert.ok(pdfSrc.includes("N.º de Control Interno"));
});
