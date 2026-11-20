import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { normalizarTipoContribuyente, reglasRegimen, validarTipoContribuyenteEstricto } from "../src/regimen";
import { construirModelo, informesDisponibles } from "../public/informe-tabla.js";

function extraerCookies(res: Response, jar: Record<string, string>) {
  const hdrs = (res.headers as any).getSetCookie ? (res.headers as any).getSetCookie() : [];
  for (const h of hdrs) {
    const par = String(h).split(";")[0];
    const idx = par.indexOf("=");
    if (idx > 0) jar[par.slice(0, idx).trim()] = par.slice(idx + 1).trim();
  }
}

async function reqJson(
  env: Record<string, unknown>,
  jar: Record<string, string>,
  ruta: string,
  metodo = "GET",
  body?: unknown
) {
  const cookieHeader = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const headers: Record<string, string> = {};
  if (cookieHeader) headers.cookie = cookieHeader;
  if (body !== undefined) headers["content-type"] = "application/json";
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

test("1. Reglas puras de régimen fiscal (FORMAL, ORDINARIO, ESPECIAL) y visibilidad de informes", () => {
  assert.equal(validarTipoContribuyenteEstricto("formal"), "FORMAL");
  assert.equal(validarTipoContribuyenteEstricto("ORDINARIO"), "ORDINARIO");
  assert.equal(validarTipoContribuyenteEstricto(" Especial "), "ESPECIAL");
  assert.equal(validarTipoContribuyenteEstricto("OTRO"), null);

  assert.equal(normalizarTipoContribuyente(undefined, 0), "ORDINARIO");
  assert.equal(normalizarTipoContribuyente(undefined, 1), "ESPECIAL");
  assert.equal(normalizarTipoContribuyente("FORMAL", 1), "FORMAL");

  const rFormal = reglasRegimen("FORMAL");
  assert.equal(rFormal.cobraIva, false);
  assert.equal(rFormal.cobraIgtf, false);
  assert.equal(rFormal.recibeRetencionIva, false);
  assert.equal(rFormal.recibeRetencionIslr, true);
  assert.match(rFormal.leyendaPdf || "", /SIN DERECHO A CREDITO FISCAL/i);

  const rOrd = reglasRegimen("ORDINARIO");
  assert.equal(rOrd.cobraIva, true);
  assert.equal(rOrd.cobraIgtf, false);
  assert.equal(rOrd.recibeRetencionIva, true);

  const rEsp = reglasRegimen("ESPECIAL");
  assert.equal(rEsp.cobraIva, true);
  assert.equal(rEsp.cobraIgtf, true);

  const infFormal = informesDisponibles({ negocio: { tipo_contribuyente: "FORMAL" }, tiene_documentos_igtf: false }, true);
  assert.ok(!infFormal.some((i: any) => i.clave === "igtf"), "FORMAL no debe ver Declaración de IGTF");
  assert.ok(!infFormal.some((i: any) => i.clave === "resumen-iva"), "FORMAL no debe ver Resumen mensual de IVA");
  assert.match(infFormal.find((i: any) => i.clave === "ventas").nombre, /Relación de ventas/i);
  assert.match(infFormal.find((i: any) => i.clave === "compras").nombre, /Relación de compras/i);

  const infOrdSinHist = informesDisponibles({ negocio: { tipo_contribuyente: "ORDINARIO" }, tiene_documentos_igtf: false }, true);
  assert.ok(!infOrdSinHist.some((i: any) => i.clave === "igtf"), "ORDINARIO sin histórico no debe ver IGTF");
  assert.ok(infOrdSinHist.some((i: any) => i.clave === "resumen-iva"), "ORDINARIO sí debe ver Resumen de IVA");

  const infOrdConHist = informesDisponibles({ negocio: { tipo_contribuyente: "ORDINARIO" }, tiene_documentos_igtf: true }, true);
  assert.ok(infOrdConHist.some((i: any) => i.clave === "igtf"), "ORDINARIO con histórico IGTF conserva el auxiliar");

  const infEsp = informesDisponibles({ negocio: { tipo_contribuyente: "ESPECIAL" }, tiene_documentos_igtf: false }, true);
  assert.ok(infEsp.some((i: any) => i.clave === "igtf"), "ESPECIAL sí debe ver Declaración de IGTF");

  const modVentasFormal = construirModelo(
    "ventas",
    {
      desde: "2026-11-01",
      hasta: "2026-11-30",
      alicuotas: [{ alicuota_cent: 0, base_bs: 10000, iva_bs: 0 }],
      filas: [],
      n_vigentes: 0,
      n_anuladas: 0,
      total_bs: 0,
      total_usd: 0,
    },
    { tipo_contribuyente: "FORMAL" }
  );
  assert.match(modVentasFormal.titulo, /Relación de ventas \(Contribuyente Formal\)/);
});

test("2. Ciclo completo de Regímenes Fiscales: alta FORMAL, bloqueos, cambio protegido con clave+check, ORDINARIO, ESPECIAL e inmutabilidad histórica", async () => {
  const db = crearBaseDatosD1(":memory:");
  const dbInq1 = crearBaseDatosD1(":memory:");
  const env: Record<string, unknown> = {
    DB: db,
    DB_1: dbInq1,
    SUPER_ADMIN_EMAIL: "dueno@regimen.test",
  };
  const jarAdmin: Record<string, string> = {};
  const CLAVE = "ClaveRegimenSegura2026!";

  // A) Instalar como Contribuyente FORMAL (ej. consultorio médico/psicología)
  const inst = await reqJson(env, jarAdmin, "/api/instalar", "POST", {
    nombre: "CONSULTORIO MEDICO DEMO",
    rif: "V-12345678-1",
    direccion: "Av. Salud, Caracas",
    telefono: "0414-1112233",
    email: "dueno@regimen.test",
    medio_facturacion: "APP_SENIAT",
    tipo_contribuyente: "FORMAL",
    clave: CLAVE,
  });
  assert.equal(inst.status, 200);

  let est = await reqJson(env, jarAdmin, "/api/estado");
  assert.equal(est.status, 200);
  assert.equal(est.data.negocio.tipo_contribuyente, "FORMAL");
  assert.equal(est.data.negocio.igtf_activo, 0);
  assert.equal(est.data.regimen.cobraIva, false);
  assert.equal(est.data.regimen.cobraIgtf, false);

  await reqJson(env, jarAdmin, "/api/config", "PUT", { tasa_bcv: "100,00" });

  // B) Reglas estrictas de FORMAL
  const cli = await reqJson(env, jarAdmin, "/api/clientes", "POST", {
    rif_cedula: "V-20111222-0",
    nombre_apellido: "Paciente Ejemplo",
  });
  assert.equal(cli.status, 200);

  // Catálogo rechaza IVA > 0%
  const catIva = await reqJson(env, jarAdmin, "/api/catalogo", "POST", {
    tipo: "SERVICIO",
    nombre: "Consulta con IVA ilegal",
    precio_usd: "40,00",
    alicuota_iva: 16,
  });
  assert.equal(catIva.status, 400);

  // Catálogo acepta exento por defecto (0%)
  const catExento = await reqJson(env, jarAdmin, "/api/catalogo", "POST", {
    tipo: "SERVICIO",
    nombre: "Consulta Médica General",
    precio_usd: "40,00",
  });
  assert.equal(catExento.status, 200);

  // Factura Formal rechaza IVA > 0%
  const facIvaMal = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    lineas: [{ tipo: "SERVICIO", descripcion: "Consulta", cantidad: "1", precio_usd: "40,00", alicuota_iva: 16 }],
  });
  assert.equal(facIvaMal.status, 400);

  // Factura Formal rechaza IGTF
  const facIgtfMal = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    aplica_igtf: 1,
    lineas: [{ catalogo_id: catExento.data.id, cantidad: "1", precio_usd: "40,00" }],
  });
  assert.equal(facIgtfMal.status, 400);

  // Factura Formal exenta se emite y congela tipo_contribuyente = FORMAL en emisor_json
  const facFormal = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    lineas: [{ catalogo_id: catExento.data.id, cantidad: "1", precio_usd: "40,00" }],
  });
  assert.equal(facFormal.status, 200);
  const emFormal = await reqJson(env, jarAdmin, `/api/documentos/${facFormal.data.id}/emitir`, "POST", {});
  assert.equal(emFormal.status, 200);

  const verFormal = await reqJson(env, jarAdmin, `/api/documentos/${facFormal.data.id}`);
  assert.equal(verFormal.data.documento.iva_usd, 0);
  assert.equal(verFormal.data.documento.igtf_usd, 0);
  assert.equal(JSON.parse(verFormal.data.documento.emisor_json).tipo_contribuyente, "FORMAL");

  // Pago RETENCION_IVA bloqueado en FORMAL; RETENCION_ISLR permitido
  const retIvaFormal = await reqJson(env, jarAdmin, "/api/pagos", "POST", {
    documento_id: facFormal.data.id,
    metodo: "RETENCION_IVA",
    moneda: "BS",
    monto: "100,00",
    tasa: "100,00",
    comprobante_retencion: "20261100000001",
  });
  assert.equal(retIvaFormal.status, 400);

  const retIslrFormal = await reqJson(env, jarAdmin, "/api/pagos", "POST", {
    documento_id: facFormal.data.id,
    metodo: "RETENCION_ISLR",
    moneda: "BS",
    monto: "120,00",
    tasa: "100,00",
    comprobante_retencion: "ISLR-2026-01",
    porcentaje_retencion: 3,
  });
  assert.equal(retIslrFormal.status, 200);

  // Nota de débito Formal rechaza IVA > 0% y acepta 0%
  const ndIvaMal = await reqJson(env, jarAdmin, `/api/documentos/${facFormal.data.id}/nota-debito`, "POST", {
    motivo: "Ajuste honorarios adicional",
    lineas: [{ descripcion: "Honorarios", cantidad: "1", precio_usd: "10,00", alicuota_iva: 16 }],
  });
  assert.equal(ndIvaMal.status, 400);
  const ndFormalOk = await reqJson(env, jarAdmin, `/api/documentos/${facFormal.data.id}/nota-debito`, "POST", {
    motivo: "Ajuste honorarios adicional",
    lineas: [{ descripcion: "Honorarios", cantidad: "1", precio_usd: "10,00", alicuota_iva: 0 }],
  });
  assert.equal(ndFormalOk.status, 200);

  // C) Seguridad del cambio de régimen
  // 1) Bloqueado vía PUT /api/config
  const bypassCfg = await reqJson(env, jarAdmin, "/api/config", "PUT", {
    tipo_contribuyente: "ESPECIAL",
    confirmo_fiscal: true,
  });
  assert.equal(bypassCfg.status, 400);

  // 2) Bloqueado sin checkbox
  const sinCheck = await reqJson(env, jarAdmin, "/api/config/regimen", "PUT", {
    tipo_contribuyente: "ORDINARIO",
    clave_actual: CLAVE,
    confirmo_regimen: false,
  });
  assert.equal(sinCheck.status, 400);

  // 3) Bloqueado con contraseña incorrecta
  const claveMal = await reqJson(env, jarAdmin, "/api/config/regimen", "PUT", {
    tipo_contribuyente: "ORDINARIO",
    clave_actual: "ClaveIncorrecta999!",
    confirmo_regimen: true,
  });
  assert.equal(claveMal.status, 403);

  // 4) Bloqueado para rol CAJERO
  const uCaj = await reqJson(env, jarAdmin, "/api/usuarios", "POST", {
    nombre: "Cajero Prueba",
    email: "cajero@regimen.test",
    rol: "CAJERO",
  });
  assert.equal(uCaj.status, 200);
  const jarCaj: Record<string, string> = {};
  const loginCaj = await reqJson(env, jarCaj, "/api/login", "POST", {
    email: "cajero@regimen.test",
    clave: uCaj.data.clave_temporal,
  });
  assert.equal(loginCaj.status, 200);
  const cajIntento = await reqJson(env, jarCaj, "/api/config/regimen", "PUT", {
    tipo_contribuyente: "ESPECIAL",
    clave_actual: uCaj.data.clave_temporal,
    confirmo_regimen: true,
  });
  assert.equal(cajIntento.status, 403);

  // 5) Cambio legítimo FORMAL -> ORDINARIO
  const aOrd = await reqJson(env, jarAdmin, "/api/config/regimen", "PUT", {
    tipo_contribuyente: "ORDINARIO",
    clave_actual: CLAVE,
    confirmo_regimen: true,
  });
  assert.equal(aOrd.status, 200);
  assert.equal(aOrd.data.tipo_contribuyente, "ORDINARIO");

  // Documento Formal previo mantiene intacto emisor_json.tipo_contribuyente === "FORMAL"
  const verFormalDespues = await reqJson(env, jarAdmin, `/api/documentos/${facFormal.data.id}`);
  assert.equal(JSON.parse(verFormalDespues.data.documento.emisor_json).tipo_contribuyente, "FORMAL");

  // D) Reglas estrictas de ORDINARIO: permite IVA 16%, pero bloquea IGTF
  const facOrdIgtfMal = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    aplica_igtf: 1,
    lineas: [{ tipo: "SERVICIO", descripcion: "Servicio gravado", cantidad: "1", precio_usd: "100,00", alicuota_iva: 16 }],
  });
  assert.equal(facOrdIgtfMal.status, 400);

  const facOrdOk = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    aplica_igtf: 0,
    lineas: [{ tipo: "SERVICIO", descripcion: "Servicio gravado", cantidad: "1", precio_usd: "100,00", alicuota_iva: 16 }],
  });
  assert.equal(facOrdOk.status, 200);
  const emOrd = await reqJson(env, jarAdmin, `/api/documentos/${facOrdOk.data.id}/emitir`, "POST", {});
  assert.equal(emOrd.status, 200);

  // E) Cambio a ESPECIAL -> emite factura con IGTF 3% -> regresa a ORDINARIO -> histórico IGTF se conserva y NC puede reversarlo
  const aEsp = await reqJson(env, jarAdmin, "/api/config/regimen", "PUT", {
    tipo_contribuyente: "ESPECIAL",
    clave_actual: CLAVE,
    confirmo_regimen: true,
  });
  assert.equal(aEsp.status, 200);

  const facEsp = await reqJson(env, jarAdmin, "/api/documentos", "POST", {
    tipo: "FACTURA",
    cliente_id: cli.data.id,
    aplica_igtf: 1,
    lineas: [{ tipo: "SERVICIO", descripcion: "Servicio SPE", cantidad: "1", precio_usd: "100,00", alicuota_iva: 16 }],
  });
  assert.equal(facEsp.status, 200);
  const emEsp = await reqJson(env, jarAdmin, `/api/documentos/${facEsp.data.id}/emitir`, "POST", {});
  assert.equal(emEsp.status, 200);

  const volverOrd = await reqJson(env, jarAdmin, "/api/config/regimen", "PUT", {
    tipo_contribuyente: "ORDINARIO",
    clave_actual: CLAVE,
    confirmo_regimen: true,
  });
  assert.equal(volverOrd.status, 200);

  est = await reqJson(env, jarAdmin, "/api/estado");
  assert.equal(est.data.negocio.tipo_contribuyente, "ORDINARIO");
  assert.equal(est.data.tiene_documentos_igtf, true, "Debe conservar visibilidad histórica del auxiliar IGTF");

  // NC sobre la factura histórica con IGTF sí permite reversar IGTF aunque el emisor ya sea ORDINARIO
  const ncIgtfHist = await reqJson(env, jarAdmin, `/api/documentos/${facEsp.data.id}/devolver`, "POST", {
    motivo: "Devolución total de factura SPE histórica",
    aplica_igtf: true,
    lineas: [{ orden: 1, cantidad: "1" }],
  });
  assert.equal(ncIgtfHist.status, 200);

  // F) Alta de inquilino con tipo_contribuyente = FORMAL
  const altaInq = await reqJson(env, jarAdmin, "/api/inquilinos", "POST", {
    ranura_db: "DB_1",
    nombre_negocio: "CLINICA PSICOLOGICA DEMO",
    rif: "J-50000123-4",
    direccion: "Av. Miranda, Valencia",
    nombre_dueno: "Dra. Ejemplo",
    cedula_dueno: "V-15000111",
    telefono: "0414-2223344",
    email_dueno: "clinica@regimen.test",
    tipo_contribuyente: "FORMAL",
    medio_facturacion: "APP_SENIAT",
    modo_inicial: "PRACTICA",
  });
  assert.equal(altaInq.status, 200);
  assert.equal(altaInq.data.tipo_contribuyente, "FORMAL");
  const perfilInq1 = await dbInq1.prepare(`SELECT tipo_contribuyente, igtf_activo FROM perfil_emisor WHERE id = 1`).first<{ tipo_contribuyente: string; igtf_activo: number }>();
  assert.equal(perfilInq1?.tipo_contribuyente, "FORMAL");
  assert.equal(perfilInq1?.igtf_activo, 0);

  // Auditoría debe registrar los cambios de régimen
  const aud = await db
    .prepare(`SELECT COUNT(*) AS n FROM auditoria WHERE accion = 'TIPO_CONTRIBUYENTE_CAMBIO'`)
    .first<{ n: number }>();
  assert.equal(aud?.n, 3);
});
