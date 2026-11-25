// Módulo oficial de integración con CG La Imprenta Digital (API Gateway CG v14 · Providencia SENIAT/INTI/012)
// y gestión de planes/contadores de consumo ida y vuelta para Imprenta Digital Autorizada.
// Reglas inquebrantables:
// - Toda conversión monetaria USD -> Bs. pasa por `usdABs` (centavos enteros, jamás punto flotante).
// - Las credenciales (contraseña API y token JWT cacheado) se guardan cifradas con AES-256-GCM y jamás salen en respuestas ni respaldos.
// - Protección SSRF estricta en URLs de Imprenta y validación https:// en enlaces PDF devueltos.

import { cifrarSecreto, descifrarSecreto } from "./cifrado";
import { usdABs } from "../public/dinero.js";

export const HOST_CG_CALIDAD = "https://calidad.cgimprenta.digital/";
export const PROVEEDOR_CG = "CG_IMPRENTA" as const;
export const PROVEEDOR_GENERICO = "GENERICO" as const;
export type TipoProveedorImprenta = typeof PROVEEDOR_CG | typeof PROVEEDOR_GENERICO;

export const PLANES_CG_PREDEFINIDOS = [
  { codigo: "EMPRENDE_1", nombre: "Emprende I (100 números)", cantidad: 100 },
  { codigo: "EMPRENDE_2", nombre: "Emprende II (500 números)", cantidad: 500 },
  { codigo: "EMPRENDE_3", nombre: "Emprende III (1.000 números)", cantidad: 1000 },
  { codigo: "VOLUMEN_1", nombre: "Volumen I (5.000 números)", cantidad: 5000 },
  { codigo: "VOLUMEN_2", nombre: "Volumen II (15.000 números)", cantidad: 15000 },
] as const;

export type ConfigImprentaCompleta = {
  proveedor_tipo: TipoProveedorImprenta;
  proveedor: string;
  url: string;
  usuario: string;
  ambiente: "PRUEBAS" | "PRODUCCION";
  serie: string;
  clave_configurada: boolean;
  clave_final: string;
  plan_nombre: string;
  plan_cupo_total: number;
  plan_fecha_pago: string;
  plan_fecha_vence: string;
  plan_consumo_previo: number;
  plan_nota: string;
  ultima_conciliacion: {
    en: string;
    total_cg: number;
    total_local: number;
    diferencia: number;
    recuperados: number;
  } | null;
};

export type ConfigImprentaConSecreto = ConfigImprentaCompleta & {
  clave_clara: string;
};

export type PayloadImprentaDocumento = {
  documento_id: number;
  tipo_documento: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO";
  modo?: string;
  numero: number;
  control_interno: number;
  fecha_emision: string;
  cliente_rif: string;
  cliente_nombre: string;
  cliente_email?: string | null;
  cliente_direccion?: string | null;
  cliente_telefono?: string | null;
  nota?: string | null;
  motivo_nc?: string | null;
  es_nc_total?: boolean;
  subtotal_bs: number;
  iva_bs: number;
  igtf_bs: number;
  total_bs: number;
  subtotal_usd: number;
  iva_usd: number;
  igtf_usd: number;
  total_usd: number;
  tasa_e8: number;
  factura_afectada_numero?: number | null;
  emisor?: { rif: string; nombre_razon_social: string; direccion_fiscal?: string };
  renglones?: {
    orden?: number;
    catalogo_id?: number | null;
    tipo?: string;
    descripcion?: string;
    cantidad_milli?: number;
    precio_usd?: number;
    alicuota_cent?: number;
    monto_usd?: number;
    monto_bs?: number;
  }[];
  impuestos?: Record<string, unknown>[];
};

export type ResultadoEnvioImprenta = {
  ok: boolean;
  control_fiscal: string | null;
  pdf_url?: string | null;
  proveedor?: string;
  proveedor_tipo?: TipoProveedorImprenta;
  error?: string;
  idempotency_key?: string;
  sin_cupo?: boolean;
};

export type ResumenPlanImprenta = {
  plan_nombre: string;
  plan_cupo_total: number;
  plan_consumo_previo: number;
  plan_fecha_pago: string;
  plan_fecha_vence: string;
  enviadas_ok: number;
  facturas_ok: number;
  nc_ok: number;
  nd_ok: number;
  anuladas_ok: number;
  pendientes: number;
  errores: number;
  total_intentos_envio: number;
  consumidas_total: number;
  disponibles: number | null;
  porcentaje_uso: number;
  dias_restantes_plan: number | null;
  nivel_alerta: "OK" | "AVISO" | "CRITICO" | "AGOTADO" | "VENCIDO" | "SIN_PLAN";
  mensaje_alerta: string;
};

// ---------------------------------------------------------------- Validación SSRF y saneamiento de URLs

function esHostPrivadoOLocal(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  // Bloquear direcciones IPv4 literales (incluye loopback, RFC1918 y metadata cloud 169.254.169.254)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  // Bloquear IPv6 literales
  if (h.includes(":")) return true;
  return false;
}

export function validarUrlImprentaSegura(urlRaw: string): { ok: true; url: string } | { ok: false; error: string } {
  const raw = String(urlRaw ?? "").trim();
  if (!raw) return { ok: false, error: "Escribe la dirección HTTPS de la API de tu Imprenta Digital." };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "La dirección de la API no es una URL válida (debe empezar por https://)." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "La dirección de la API debe usar protocolo seguro https://." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "No incluyas usuario ni contraseña dentro de la URL." };
  }
  if (esHostPrivadoOLocal(parsed.hostname)) {
    return { ok: false, error: "Por seguridad, la URL de la Imprenta Digital debe apuntar a un dominio público HTTPS (no IP ni direcciones locales)." };
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(parsed.hostname) || !parsed.hostname.includes(".")) {
    return { ok: false, error: "El dominio de la Imprenta Digital no es válido." };
  }
  return { ok: true, url: parsed.toString() };
}

export function normalizarHostCg(urlRaw: string): string {
  const parsed = new URL(urlRaw.trim());
  // Si el usuario pegó la ruta completa (/api/Invoice/...), recortamos al host raíz
  let path = parsed.pathname.replace(/\/api\/invoice\/.*$/i, "/").replace(/\/auth\/login\/?$/i, "/");
  if (!path.endsWith("/")) path += "/";
  return `${parsed.origin}${path}`;
}

export function validarUrlPdfSegura(urlRaw: unknown): string | null {
  const s = String(urlRaw ?? "").trim();
  if (!s || s.length > 500) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    if (esHostPrivadoOLocal(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Formateadores puros (100% aritmética entera)

export function formatearFechaDdMmYyyy(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate ?? "").trim());
  if (!m) return "01-01-2026";
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function formatearTasaCg(tasaE8: number): string {
  const n = Math.max(0, Math.round(Number(tasaE8) || 0));
  // tasa_e8 tiene 8 decimales; CG acepta hasta 8 decimales, mostramos 4 decimales exactos redondeados (estándar BCV)
  const e4 = Math.floor((n + 5000) / 10000);
  const ent = Math.floor(e4 / 10000);
  const dec = String(e4 % 10000).padStart(4, "0");
  return `${ent}.${dec}`;
}

export function formatearCentavosCg(centavos: number): string {
  const n = Math.max(0, Math.round(Number(centavos) || 0));
  const ent = Math.floor(n / 100);
  const dec = String(n % 100).padStart(2, "0");
  return `${ent}.${dec}`;
}

export function formatearCantidadMilliCg(cantidadMilli: number): string {
  const m = Math.max(1, Math.round(Number(cantidadMilli) || 1000));
  if (m % 1000 === 0) return String(m / 1000);
  const ent = Math.floor(m / 1000);
  const dec = String(m % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${ent}.${dec}`;
}

export function alicuotaATipoImpuestoCg(alicuotaCent: number): "G" | "R" | "A" | "E" {
  const a = Math.round(Number(alicuotaCent) || 0);
  if (a === 1600) return "G";
  if (a === 800) return "R";
  if (a === 3100) return "A";
  if (a > 0) return "G";
  return "E";
}

export function codigoProductoCg(catalogoId: number | null | undefined, orden: number | undefined): string {
  const id = Number(catalogoId);
  if (Number.isInteger(id) && id > 0) {
    return `PROD-${id}`.slice(0, 13);
  }
  const ord = Number(orden);
  const idx = Number.isInteger(ord) && ord > 0 ? ord : 1;
  return `ITEM-${idx}`.slice(0, 13);
}

export function limpiarDocumentoIdentidadCg(rif: string): string {
  const limpio = String(rif ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[VEJGPC]\d{5,12}$/.test(limpio)) return limpio;
  if (/^\d{5,12}$/.test(limpio)) return `V${limpio}`;
  return limpio.slice(0, 15) || "V00000000";
}

export function numeroDocumentoCg(numero: number): string {
  const n = Math.max(1, Math.trunc(Number(numero) || 1));
  return String(n).padStart(6, "0");
}

function limpiarTextoCg(v: unknown, max: number, defecto = ""): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return (s || defecto).slice(0, max);
}

// ---------------------------------------------------------------- Constructores de payloads exactos (API Gateway CG v14)

export function construirPayloadFacturaCg(
  payload: PayloadImprentaDocumento,
  serie = "A"
): Record<string, unknown> {
  const numStr = numeroDocumentoCg(payload.numero);
  const serieLimpia = limpiarTextoCg(serie, 5, "A").toUpperCase();
  const rengs = payload.renglones ?? [];
  const productos = rengs.map((r, i) => {
    const precioBsCent = Math.max(1, usdABs(Number(r.precio_usd ?? 0), payload.tasa_e8));
    const desc = limpiarTextoCg(r.descripcion, 120, `Renglón ${i + 1}`);
    return {
      codigoProducto: codigoProductoCg(r.catalogo_id, r.orden ?? i + 1),
      nombreProducto: desc.slice(0, 60),
      descripcionProducto: desc,
      product_note: "",
      tipoImpuesto: alicuotaATipoImpuestoCg(Number(r.alicuota_cent ?? 0)),
      cantidadAdquirida: formatearCantidadMilliCg(Number(r.cantidad_milli ?? 1000)),
      precioProducto: formatearCentavosCg(precioBsCent),
      discount: 0,
    };
  });

  return {
    numeroSerie: serieLimpia,
    cantidadFactura: 1,
    facturas: [
      {
        numeroFactura: numStr,
        descripcionFactura: limpiarTextoCg(payload.nota, 200, `Factura ${numStr}`),
        documentoIdentidadCliente: limpiarDocumentoIdentidadCg(payload.cliente_rif),
        nombreRazonSocialCliente: limpiarTextoCg(payload.cliente_nombre, 120, "Cliente"),
        correoCliente: limpiarTextoCg(payload.cliente_email, 120, "sin-correo@facturayave.com"),
        direccionCliente: limpiarTextoCg(payload.cliente_direccion, 200, "Venezuela"),
        telefonoCliente: limpiarTextoCg(payload.cliente_telefono, 30, "00000000000").replace(/[^0-9+]/g, "") || "00000000000",
        tasa_del_dia: formatearTasaCg(payload.tasa_e8),
        fecha_tasa: formatearFechaDdMmYyyy(payload.fecha_emision),
        mostrar_formas_de_pago: 0,
        productos,
      },
    ],
  };
}

export function construirPayloadNcTotalCg(payload: PayloadImprentaDocumento): Record<string, unknown> {
  return {
    numeroFactura: numeroDocumentoCg(Number(payload.factura_afectada_numero ?? 0)),
    numeroNotaCredito: numeroDocumentoCg(payload.numero),
    descripcion: limpiarTextoCg(payload.motivo_nc || payload.nota, 200, "Devolución total de factura"),
  };
}

export function construirPayloadNcParcialCg(payload: PayloadImprentaDocumento): Record<string, unknown> {
  const rengs = payload.renglones ?? [];
  return {
    numeroFactura: numeroDocumentoCg(Number(payload.factura_afectada_numero ?? 0)),
    numeroNotaCredito: numeroDocumentoCg(payload.numero),
    descripcion: limpiarTextoCg(payload.motivo_nc || payload.nota, 200, "Devolución parcial de mercancía"),
    productos: rengs.map((r, i) => ({
      codigo: codigoProductoCg(r.catalogo_id, r.orden ?? i + 1),
      descripcion: limpiarTextoCg(r.descripcion, 120, `Renglón ${i + 1}`),
      cantidad: formatearCantidadMilliCg(Number(r.cantidad_milli ?? 1000)),
    })),
  };
}

export function construirPayloadNdCg(payload: PayloadImprentaDocumento): Record<string, unknown> {
  const rengs = payload.renglones ?? [];
  const productosNuevos = rengs.map((r, i) => {
    const precioBsCent = Math.max(1, usdABs(Number(r.precio_usd ?? 0), payload.tasa_e8));
    const desc = limpiarTextoCg(r.descripcion, 120, `Recargo ${i + 1}`);
    return {
      codigoProducto: `ND-${payload.numero}-${i + 1}`.slice(0, 13),
      nombreProducto: desc.slice(0, 60),
      descripcionProducto: desc,
      tipoImpuesto: alicuotaATipoImpuestoCg(Number(r.alicuota_cent ?? 0)),
      cantidadAdquirida: Number(formatearCantidadMilliCg(Number(r.cantidad_milli ?? 1000))),
      precioProducto: formatearCentavosCg(precioBsCent),
    };
  });

  return {
    numeroFactura: numeroDocumentoCg(Number(payload.factura_afectada_numero ?? 0)),
    numeroNotaDebito: numeroDocumentoCg(payload.numero),
    descripcion: limpiarTextoCg(payload.motivo_nc || payload.nota, 200, "Nota de débito / ajuste"),
    tasa_del_dia: formatearTasaCg(payload.tasa_e8),
    fecha_tasa: formatearFechaDdMmYyyy(payload.fecha_emision),
    productos_nuevos: productosNuevos,
  };
}

export function construirPayloadAnulacionCg(numeroFactura: number | string, controlFiscal: string): Record<string, unknown> {
  const numDoc = typeof numeroFactura === "number" ? numeroDocumentoCg(numeroFactura) : String(numeroFactura).trim();
  return {
    numero_documento: numDoc,
    numero_control: String(controlFiscal ?? "").trim().toUpperCase(),
  };
}

// ---------------------------------------------------------------- Parseo robusto de respuestas CG

export function extraerRespuestaCg(
  data: Record<string, any> | null | undefined,
  _tipo?: string
): {
  ok: boolean;
  control_fiscal: string | null;
  pdf_url: string | null;
  error?: string;
  sin_cupo?: boolean;
} {
  if (!data || typeof data !== "object") {
    return { ok: false, control_fiscal: null, pdf_url: null, error: "Respuesta vacía de CG Imprenta Digital." };
  }

  // Verificar arreglo invoice_errors (add_list_invoice)
  const invErrors = Array.isArray(data.invoice_errors) ? data.invoice_errors : [];
  const listaExito = Array.isArray(data.invoice_list_success)
    ? data.invoice_list_success
    : Array.isArray(data.credit_note_list_success)
      ? data.credit_note_list_success
      : Array.isArray(data.debit_note_list_success)
        ? data.debit_note_list_success
        : [];
  const primero = listaExito[0] ?? data.data ?? data.resultado ?? data;

  const rawCtrl = String(
    primero?.control_number ??
      primero?.numero_control ??
      primero?.numeroControl ??
      primero?.control_fiscal ??
      data.control_number ??
      data.numero_control ??
      data.numeroControl ??
      data.control_fiscal ??
      ""
  )
    .trim()
    .toUpperCase();

  const rawPdf =
    primero?.invoice_pdf ??
    primero?.pdf_factura ??
    primero?.pdf_nota_credito ??
    primero?.pdf_nota_debito ??
    primero?.pdf_url ??
    primero?.url_pdf ??
    primero?.pdf ??
    data.invoice_pdf ??
    data.pdf_factura ??
    data.pdf_url ??
    data.url_pdf ??
    data.pdf ??
    null;

  const pdfSeguro = validarUrlPdfSegura(rawPdf);

  if (rawCtrl && /^[0-9A-Z][0-9A-Z-]{0,29}$/.test(rawCtrl)) {
    return { ok: true, control_fiscal: rawCtrl, pdf_url: pdfSeguro };
  }

  const msgErr =
    (invErrors.length
      ? invErrors
          .map((e: any) =>
            typeof e === "string"
              ? e
              : e?.error || e?.message || e?.errors?.join?.("; ") || JSON.stringify(e)
          )
          .join(" | ")
      : "") ||
    (Array.isArray(data.errors) ? data.errors.map((e: any) => (typeof e === "string" ? e : e?.message || JSON.stringify(e))).join(" | ") : "") ||
    String(data.message ?? data.error ?? "").trim() ||
    "CG Imprenta Digital no devolvió un número de control válido.";

  const sinCupo = /no posee m[aá]s n[uú]meros de control|sin n[uú]meros de control|agotad[oa]/i.test(msgErr);
  return { ok: false, control_fiscal: null, pdf_url: null, error: msgErr.slice(0, 300), sin_cupo: sinCupo };
}

// ---------------------------------------------------------------- Cálculo puro del Contador / Visor de Plan

export function calcularResumenPlanImprenta(params: {
  plan_nombre: string;
  plan_cupo_total: number;
  plan_consumo_previo: number;
  plan_fecha_pago: string;
  plan_fecha_vence: string;
  facturas_ok: number;
  nc_ok: number;
  nd_ok: number;
  anuladas_ok: number;
  pendientes: number;
  errores: number;
  total_intentos_envio: number;
  hoyIso: string;
}): ResumenPlanImprenta {
  const cupoTotal = Math.max(0, Math.trunc(Number(params.plan_cupo_total) || 0));
  const consumoPrevio = Math.max(0, Math.trunc(Number(params.plan_consumo_previo) || 0));
  const facturasOk = Math.max(0, Math.trunc(Number(params.facturas_ok) || 0));
  const ncOk = Math.max(0, Math.trunc(Number(params.nc_ok) || 0));
  const ndOk = Math.max(0, Math.trunc(Number(params.nd_ok) || 0));
  const anuladasOk = Math.max(0, Math.trunc(Number(params.anuladas_ok) || 0));
  const pendientes = Math.max(0, Math.trunc(Number(params.pendientes) || 0));
  const errores = Math.max(0, Math.trunc(Number(params.errores) || 0));
  const totalIntentos = Math.max(0, Math.trunc(Number(params.total_intentos_envio) || 0));

  // Las facturas anuladas igualmente consumieron un número de control fiscal en CG (jamás se reutilizan por ley SENIAT)
  const enviadasOk = facturasOk + ncOk + ndOk + anuladasOk;
  const consumidasTotal = consumoPrevio + enviadasOk;
  const disponibles = cupoTotal > 0 ? Math.max(0, cupoTotal - consumidasTotal) : null;
  const porcentajeUso = cupoTotal > 0 ? Math.min(100, Math.round((consumidasTotal * 100) / cupoTotal)) : 0;

  let diasRestantes: number | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(params.plan_fecha_vence) && /^\d{4}-\d{2}-\d{2}$/.test(params.hoyIso)) {
    const tVence = Date.parse(`${params.plan_fecha_vence}T00:00:00Z`);
    const tHoy = Date.parse(`${params.hoyIso}T00:00:00Z`);
    if (Number.isFinite(tVence) && Number.isFinite(tHoy)) {
      diasRestantes = Math.round((tVence - tHoy) / 86_400_000);
    }
  }

  let nivel: ResumenPlanImprenta["nivel_alerta"] = "OK";
  let mensaje = "";
  if (cupoTotal <= 0) {
    nivel = "SIN_PLAN";
    mensaje = "Carga el lote contratado y la fecha pagada para activar el medidor de disponibles.";
  } else if (disponibles === 0) {
    nivel = "AGOTADO";
    mensaje = "Cupo agotado: registra una recarga de números de control para seguir timbrando en CG.";
  } else if (diasRestantes !== null && diasRestantes < 0) {
    nivel = "VENCIDO";
    mensaje = `La vigencia anual del plan venció hace ${Math.abs(diasRestantes)} día(s). Renueva el almacenamiento/plan.`;
  } else if (porcentajeUso >= 95 || (disponibles !== null && disponibles <= 10)) {
    nivel = "CRITICO";
    mensaje = `Quedan solo ${disponibles} número(s) de control disponibles (${porcentajeUso}% consumido).`;
  } else if (porcentajeUso >= 80 || (diasRestantes !== null && diasRestantes <= 15)) {
    nivel = "AVISO";
    mensaje =
      porcentajeUso >= 80
        ? `Has consumido el ${porcentajeUso}% de tu lote (${disponibles} disponibles). Planifica tu recarga.`
        : `Tu plan vence en ${diasRestantes} día(s) (${params.plan_fecha_vence}).`;
  } else {
    nivel = "OK";
    mensaje = `${disponibles} número(s) de control disponibles de ${cupoTotal} contratados.`;
  }

  return {
    plan_nombre: params.plan_nombre || (cupoTotal > 0 ? `Lote ${cupoTotal} números` : "Sin plan cargado"),
    plan_cupo_total: cupoTotal,
    plan_consumo_previo: consumoPrevio,
    plan_fecha_pago: params.plan_fecha_pago || "",
    plan_fecha_vence: params.plan_fecha_vence || "",
    enviadas_ok: enviadasOk,
    facturas_ok: facturasOk,
    nc_ok: ncOk,
    nd_ok: ndOk,
    anuladas_ok: anuladasOk,
    pendientes,
    errores,
    total_intentos_envio: totalIntentos,
    consumidas_total: consumidasTotal,
    disponibles,
    porcentaje_uso: porcentajeUso,
    dias_restantes_plan: diasRestantes,
    nivel_alerta: nivel,
    mensaje_alerta: mensaje,
  };
}

// ---------------------------------------------------------------- Lectura de configuración e historial en D1

export async function leerConfigImprentaCompleta(
  db: D1Database,
  env?: Record<string, unknown>
): Promise<ConfigImprentaConSecreto> {
  const { results } = await db
    .prepare(`SELECT clave, valor FROM integraciones WHERE clave LIKE 'imprenta_%'`)
    .all<{ clave: string; valor: string }>()
    .catch(() => ({ results: [] as { clave: string; valor: string }[] }));
  const m = Object.fromEntries(results.map((r) => [r.clave.replace("imprenta_", ""), r.valor]));
  const claveClara = await descifrarSecreto(m.clave, env);
  const provTipo: TipoProveedorImprenta =
    m.proveedor_tipo === PROVEEDOR_CG ||
    (!m.proveedor_tipo && /cg\s*imprenta|cgimprenta\.digital/i.test(`${m.proveedor ?? ""} ${m.url ?? ""}`))
      ? PROVEEDOR_CG
      : PROVEEDOR_GENERICO;

  let ultimaConciliacion: ConfigImprentaCompleta["ultima_conciliacion"] = null;
  if (m.ultima_conciliacion_json) {
    try {
      const parsed = JSON.parse(m.ultima_conciliacion_json);
      if (parsed && typeof parsed === "object") {
        ultimaConciliacion = {
          en: String(parsed.en ?? ""),
          total_cg: Number(parsed.total_cg ?? 0) || 0,
          total_local: Number(parsed.total_local ?? 0) || 0,
          diferencia: Number(parsed.diferencia ?? 0) || 0,
          recuperados: Number(parsed.recuperados ?? 0) || 0,
        };
      }
    } catch {}
  }

  return {
    proveedor_tipo: provTipo,
    proveedor: m.proveedor ?? "",
    url: m.url ?? "",
    usuario: m.usuario ?? "",
    ambiente: m.ambiente === "PRODUCCION" ? "PRODUCCION" : "PRUEBAS",
    serie: (m.serie || "A").trim().toUpperCase().slice(0, 5) || "A",
    clave_configurada: !!claveClara,
    clave_final: claveClara ? claveClara.slice(-4) : "",
    clave_clara: claveClara,
    plan_nombre: m.plan_nombre ?? "",
    plan_cupo_total: Math.max(0, Math.trunc(Number(m.plan_cupo_total) || 0)),
    plan_fecha_pago: m.plan_fecha_pago ?? "",
    plan_fecha_vence: m.plan_fecha_vence ?? "",
    plan_consumo_previo: Math.max(0, Math.trunc(Number(m.plan_consumo_previo) || 0)),
    plan_nota: m.plan_nota ?? "",
    ultima_conciliacion: ultimaConciliacion,
  };
}

export function ocultarSecretoImprenta(cfg: ConfigImprentaConSecreto): ConfigImprentaCompleta {
  const { clave_clara: _omit, ...publica } = cfg;
  return publica;
}

export async function registrarEnvioImprentaDb(
  db: D1Database,
  datos: {
    documento_id: number;
    proveedor: string;
    proveedor_tipo: TipoProveedorImprenta;
    ambiente: string;
    tipo_documento: string;
    numero_documento: string;
    numero_serie: string;
    control_fiscal: string | null;
    pdf_url: string | null;
    estado: "ENVIADO_OK" | "PENDIENTE" | "ERROR" | "ANULADO_OK";
    ultimo_error?: string;
    idempotency_key?: string;
    retornado_en?: string | null;
    anulado_en?: string | null;
  }
) {
  const ahora = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO imprenta_envios (
         documento_id, proveedor, proveedor_tipo, ambiente, tipo_documento,
         numero_documento, numero_serie, control_fiscal, pdf_url, estado,
         intentos, ultimo_error, idempotency_key, enviado_en, retornado_en, anulado_en, actualizado_en
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(documento_id) DO UPDATE SET
         proveedor = excluded.proveedor,
         proveedor_tipo = excluded.proveedor_tipo,
         ambiente = excluded.ambiente,
         numero_documento = excluded.numero_documento,
         numero_serie = excluded.numero_serie,
         control_fiscal = COALESCE(excluded.control_fiscal, imprenta_envios.control_fiscal),
         pdf_url = COALESCE(excluded.pdf_url, imprenta_envios.pdf_url),
         estado = excluded.estado,
         intentos = imprenta_envios.intentos + 1,
         ultimo_error = excluded.ultimo_error,
         idempotency_key = CASE WHEN excluded.idempotency_key <> '' THEN excluded.idempotency_key ELSE imprenta_envios.idempotency_key END,
         retornado_en = COALESCE(excluded.retornado_en, imprenta_envios.retornado_en),
         anulado_en = COALESCE(excluded.anulado_en, imprenta_envios.anulado_en),
         actualizado_en = excluded.actualizado_en`
    )
    .bind(
      datos.documento_id,
      datos.proveedor,
      datos.proveedor_tipo,
      datos.ambiente,
      datos.tipo_documento,
      datos.numero_documento,
      datos.numero_serie,
      datos.control_fiscal,
      datos.pdf_url,
      datos.estado,
      (datos.ultimo_error ?? "").slice(0, 300),
      datos.idempotency_key ?? "",
      ahora,
      datos.retornado_en ?? null,
      datos.anulado_en ?? null,
      ahora
    )
    .run()
    .catch(() => {});
}

export async function obtenerResumenImprenta(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  hoyIso: string,
  opts?: { incluirHistorial?: boolean }
) {
  const cfg = await leerConfigImprentaCompleta(db, env);
  const perfil = await db
    .prepare(`SELECT medio_facturacion FROM perfil_emisor WHERE id = 1`)
    .first<{ medio_facturacion: string }>()
    .catch(() => null);

  const agg = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN estado = 'ENVIADO_OK' AND tipo_documento = 'FACTURA' THEN 1 ELSE 0 END) AS facturas_ok,
         SUM(CASE WHEN estado = 'ENVIADO_OK' AND tipo_documento = 'NOTA_CREDITO' THEN 1 ELSE 0 END) AS nc_ok,
         SUM(CASE WHEN estado = 'ENVIADO_OK' AND tipo_documento = 'NOTA_DEBITO' THEN 1 ELSE 0 END) AS nd_ok,
         SUM(CASE WHEN estado = 'ANULADO_OK' THEN 1 ELSE 0 END) AS anuladas_ok,
         SUM(CASE WHEN estado = 'PENDIENTE' THEN 1 ELSE 0 END) AS pendientes,
         SUM(CASE WHEN estado = 'ERROR' THEN 1 ELSE 0 END) AS errores,
         COALESCE(SUM(intentos), 0) AS total_intentos
       FROM imprenta_envios`
    )
    .first<{
      facturas_ok: number;
      nc_ok: number;
      nd_ok: number;
      anuladas_ok: number;
      pendientes: number;
      errores: number;
      total_intentos: number;
    }>()
    .catch(() => null);

  // También contar documentos emitidos en REAL bajo IMPRENTA_DIGITAL que aún no tienen control_fiscal (por si no pasaron por imprenta_envios)
  const sinControl = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM documentos
       WHERE tipo = 'FACTURA' AND modo = 'REAL' AND estado = 'EMITIDO'
         AND medio = 'IMPRENTA_DIGITAL' AND control_fiscal IS NULL
         AND id NOT IN (SELECT documento_id FROM imprenta_envios WHERE estado IN ('PENDIENTE', 'ERROR'))`
    )
    .first<{ n: number }>()
    .catch(() => ({ n: 0 }));

  const resumen = calcularResumenPlanImprenta({
    plan_nombre: cfg.plan_nombre,
    plan_cupo_total: cfg.plan_cupo_total,
    plan_consumo_previo: cfg.plan_consumo_previo,
    plan_fecha_pago: cfg.plan_fecha_pago,
    plan_fecha_vence: cfg.plan_fecha_vence,
    facturas_ok: Number(agg?.facturas_ok ?? 0),
    nc_ok: Number(agg?.nc_ok ?? 0),
    nd_ok: Number(agg?.nd_ok ?? 0),
    anuladas_ok: Number(agg?.anuladas_ok ?? 0),
    pendientes: Number(agg?.pendientes ?? 0) + Number(sinControl?.n ?? 0),
    errores: Number(agg?.errores ?? 0),
    total_intentos_envio: Number(agg?.total_intentos ?? 0),
    hoyIso,
  });

  const base = {
    medio_activo: perfil?.medio_facturacion ?? "APP_SENIAT",
    configurado: Boolean(cfg.url && cfg.clave_configurada),
    proveedor_tipo: cfg.proveedor_tipo,
    proveedor: cfg.proveedor || (cfg.proveedor_tipo === PROVEEDOR_CG ? "CG La Imprenta Digital" : ""),
    ambiente: cfg.ambiente,
    serie: cfg.serie,
    ultima_conciliacion: cfg.ultima_conciliacion,
    resumen,
  };

  if (!opts?.incluirHistorial) return base;

  const [enviosRes, recargasRes] = await Promise.all([
    db
      .prepare(
        `SELECT e.documento_id, e.tipo_documento, e.numero_documento, e.numero_serie,
                e.control_fiscal, e.pdf_url, e.estado, e.intentos, e.ultimo_error,
                e.enviado_en, e.retornado_en, e.anulado_en, d.cliente_nombre, d.total_usd
         FROM imprenta_envios e
         LEFT JOIN documentos d ON d.id = e.documento_id
         ORDER BY e.id DESC LIMIT 20`
      )
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] })),
    db
      .prepare(
        `SELECT id, plan_nombre, cantidad_numeros, fecha_pago, fecha_vence, monto_usd_centavos, referencia, nota, creado_en
         FROM imprenta_plan_recargas ORDER BY id DESC LIMIT 20`
      )
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] })),
  ]);

  return {
    ...base,
    config: ocultarSecretoImprenta(cfg),
    envios_recientes: enviosRes.results,
    recargas: recargasRes.results,
  };
}

// ---------------------------------------------------------------- Cliente HTTP oficial CG Imprenta Digital (v14)

export async function obtenerTokenCg(
  hostBase: string,
  userName: string,
  userPassword: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const host = normalizarHostCg(hostBase);
  try {
    const r = await fetchFn(`${host}api/Invoice/create_token_authenticator`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userName: userName.trim(),
        userPassword,
      }),
    });
    const j = (await r.json().catch(() => null)) as { success?: boolean; token?: string; message?: string; error?: string } | null;
    if (!r.ok || !j?.token) {
      const msg = j?.message || j?.error || `HTTP ${r.status}`;
      return { ok: false, error: `CG rechazó la autenticación (${msg}). Verifica usuario y contraseña API.` };
    }
    return { ok: true, token: String(j.token).trim() };
  } catch (e) {
    return { ok: false, error: `No se pudo conectar con CG Imprenta Digital: ${(e as Error).message}` };
  }
}

async function obtenerOCachearTokenCg(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  forzarRenovar: boolean,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const ahoraMs = Date.now();
  if (!forzarRenovar) {
    const rows = (
      await db
        .prepare(`SELECT clave, valor FROM integraciones WHERE clave IN ('imprenta_cg_jwt', 'imprenta_cg_jwt_exp', 'imprenta_cg_jwt_host')`)
        .all<{ clave: string; valor: string }>()
        .catch(() => ({ results: [] }))
    ).results;
    const m = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
    const expMs = Number(m.imprenta_cg_jwt_exp || 0);
    const hostNorm = normalizarHostCg(cfg.url);
    if (m.imprenta_cg_jwt && m.imprenta_cg_jwt_host === hostNorm && expMs > ahoraMs + 60_000) {
      const tok = await descifrarSecreto(m.imprenta_cg_jwt, env);
      if (tok) return { ok: true, token: tok };
    }
  }

  const nuevo = await obtenerTokenCg(cfg.url, cfg.usuario, cfg.clave_clara, fetchFn);
  if (!nuevo.ok) return nuevo;

  // Guardar JWT cifrado con TTL de 50 minutos (CG emite tokens de 60 minutos)
  const ahoraIso = new Date().toISOString();
  const expMs = String(ahoraMs + 50 * 60_000);
  const hostNorm = normalizarHostCg(cfg.url);
  const jwtCifrado = await cifrarSecreto(nuevo.token, env).catch(() => "");
  if (jwtCifrado) {
    await db
      .batch([
        db
          .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_cg_jwt', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
          .bind(jwtCifrado, ahoraIso),
        db
          .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_cg_jwt_exp', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
          .bind(expMs, ahoraIso),
        db
          .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_cg_jwt_host', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
          .bind(hostNorm, ahoraIso),
      ])
      .catch(() => {});
  }
  return nuevo;
}

async function peticionAutenticadaCg(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  rutaRelativa: string,
  init: { method: "GET" | "POST"; body?: Record<string, unknown>; timeoutMs?: number },
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; status: number; data: Record<string, any> | null; error?: string }> {
  const valUrl = validarUrlImprentaSegura(cfg.url);
  if (!valUrl.ok) return { ok: false, status: 400, data: null, error: valUrl.error };
  if (!cfg.usuario || !cfg.clave_clara) {
    return { ok: false, status: 400, data: null, error: "Faltan las credenciales de API de CG Imprenta Digital (usuario y contraseña)." };
  }
  const host = normalizarHostCg(valUrl.url);
  const endpoint = `${host}${rutaRelativa.replace(/^\/+/, "")}`;

  for (let intento = 0; intento < 2; intento++) {
    const auth = await obtenerOCachearTokenCg(db, env, cfg, intento === 1, fetchFn);
    if (!auth.ok) return { ok: false, status: 401, data: null, error: auth.error };
    try {
      const r = await fetchFn(endpoint, {
        method: init.method,
        signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.token}`,
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
      if (r.status === 401 && intento === 0) continue; // renovar JWT una vez automáticamente
      const data = (await r.json().catch(() => null)) as Record<string, any> | null;
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: null, error: `Error de red con CG Imprenta Digital: ${(e as Error).message}` };
    }
  }
  return { ok: false, status: 401, data: null, error: "Token rechazado por CG Imprenta Digital." };
}

export async function probarConexionCg(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; host?: string; metodos_pago?: number; mensaje?: string; error?: string }> {
  const valUrl = validarUrlImprentaSegura(cfg.url);
  if (!valUrl.ok) return { ok: false, error: valUrl.error };
  const host = normalizarHostCg(valUrl.url);

  // Forzamos autenticación fresca para confirmar credenciales actuales
  const auth = await obtenerOCachearTokenCg(db, env, cfg, true, fetchFn);
  if (!auth.ok) return { ok: false, error: auth.error };

  const resMet = await peticionAutenticadaCg(db, env, cfg, "api/Invoice/payments_methods", { method: "GET", timeoutMs: 10_000 }, fetchFn);
  if (!resMet.ok) {
    return {
      ok: false,
      error: resMet.error || resMet.data?.message || `Autenticación OK pero falló consulta de catálogo (HTTP ${resMet.status}).`,
    };
  }
  const metodos = Array.isArray(resMet.data?.payment_methods) ? resMet.data.payment_methods.length : 0;
  return {
    ok: true,
    host,
    metodos_pago: metodos,
    mensaje: `Conexión verificada con CG Imprenta Digital (${cfg.ambiente === "PRODUCCION" ? "Producción" : "Calidad / Pruebas"}) · Token JWT activo · ${metodos} métodos de pago disponibles.`,
  };
}

export async function enviarDocumentoCg(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  payload: PayloadImprentaDocumento,
  idempotencyKey: string,
  fetchFn: typeof fetch = fetch
): Promise<ResultadoEnvioImprenta> {
  let ruta = "api/Invoice/add_list_invoice";
  let body: Record<string, unknown>;

  if (payload.tipo_documento === "FACTURA") {
    ruta = "api/Invoice/add_list_invoice";
    body = construirPayloadFacturaCg(payload, cfg.serie);
  } else if (payload.tipo_documento === "NOTA_CREDITO") {
    if (payload.es_nc_total) {
      ruta = "api/Invoice/add_credit_note";
      body = construirPayloadNcTotalCg(payload);
    } else {
      ruta = "api/Invoice/add_credit_note_with_products";
      body = construirPayloadNcParcialCg(payload);
    }
  } else {
    ruta = "api/Invoice/add_debit_note";
    body = construirPayloadNdCg(payload);
  }

  const res = await peticionAutenticadaCg(db, env, cfg, ruta, { method: "POST", body, timeoutMs: 15_000 }, fetchFn);
  const numDocStr = numeroDocumentoCg(payload.numero);

  if (res.error) {
    await registrarEnvioImprentaDb(db, {
      documento_id: payload.documento_id,
      proveedor: cfg.proveedor || "CG La Imprenta Digital",
      proveedor_tipo: PROVEEDOR_CG,
      ambiente: cfg.ambiente,
      tipo_documento: payload.tipo_documento,
      numero_documento: numDocStr,
      numero_serie: cfg.serie,
      control_fiscal: null,
      pdf_url: null,
      estado: "PENDIENTE",
      ultimo_error: res.error,
      idempotency_key: idempotencyKey,
    });
    return {
      ok: false,
      control_fiscal: null,
      pdf_url: null,
      proveedor: cfg.proveedor || "CG La Imprenta Digital",
      proveedor_tipo: PROVEEDOR_CG,
      error: res.error,
      idempotency_key: idempotencyKey,
    };
  }

  const parsed = extraerRespuestaCg(res.data, payload.tipo_documento);
  if (!res.ok || !parsed.ok || !parsed.control_fiscal) {
    const errMsg = parsed.error || `CG respondió HTTP ${res.status}`;
    await registrarEnvioImprentaDb(db, {
      documento_id: payload.documento_id,
      proveedor: cfg.proveedor || "CG La Imprenta Digital",
      proveedor_tipo: PROVEEDOR_CG,
      ambiente: cfg.ambiente,
      tipo_documento: payload.tipo_documento,
      numero_documento: numDocStr,
      numero_serie: cfg.serie,
      control_fiscal: null,
      pdf_url: null,
      estado: "PENDIENTE",
      ultimo_error: errMsg,
      idempotency_key: idempotencyKey,
    });
    return {
      ok: false,
      control_fiscal: null,
      pdf_url: null,
      proveedor: cfg.proveedor || "CG La Imprenta Digital",
      proveedor_tipo: PROVEEDOR_CG,
      error: errMsg,
      idempotency_key: idempotencyKey,
      sin_cupo: parsed.sin_cupo,
    };
  }

  const ahoraIso = new Date().toISOString();
  await db.batch([
    db
      .prepare(`UPDATE documentos SET control_fiscal = ? WHERE id = ? AND control_fiscal IS NULL AND estado = 'EMITIDO'`)
      .bind(parsed.control_fiscal, payload.documento_id),
    db.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(`imprenta_pendiente_${payload.documento_id}`),
  ]);
  await registrarEnvioImprentaDb(db, {
    documento_id: payload.documento_id,
    proveedor: cfg.proveedor || "CG La Imprenta Digital",
    proveedor_tipo: PROVEEDOR_CG,
    ambiente: cfg.ambiente,
    tipo_documento: payload.tipo_documento,
    numero_documento: numDocStr,
    numero_serie: cfg.serie,
    control_fiscal: parsed.control_fiscal,
    pdf_url: parsed.pdf_url,
    estado: "ENVIADO_OK",
    ultimo_error: "",
    idempotency_key: idempotencyKey,
    retornado_en: ahoraIso,
  });

  return {
    ok: true,
    control_fiscal: parsed.control_fiscal,
    pdf_url: parsed.pdf_url,
    proveedor: cfg.proveedor || "CG La Imprenta Digital",
    proveedor_tipo: PROVEEDOR_CG,
    idempotency_key: idempotencyKey,
  };
}

export async function anularFacturaCg(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  datos: { documento_id: number; numero_documento: number | string; control_fiscal: string },
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; pdf_url?: string | null; error?: string }> {
  const body = construirPayloadAnulacionCg(datos.numero_documento, datos.control_fiscal);
  const res = await peticionAutenticadaCg(db, env, cfg, "api/Invoice/cancel_invoice", { method: "POST", body, timeoutMs: 12_000 }, fetchFn);
  if (!res.ok || res.error) {
    const errMsg = res.error || res.data?.message || `CG respondió HTTP ${res.status} al anular.`;
    return { ok: false, error: String(errMsg).slice(0, 300) };
  }
  const pdfSeguro = validarUrlPdfSegura(res.data?.pdf_factura ?? res.data?.pdf ?? res.data?.data?.pdf_factura ?? null);
  const ahoraIso = new Date().toISOString();
  await registrarEnvioImprentaDb(db, {
    documento_id: datos.documento_id,
    proveedor: cfg.proveedor || "CG La Imprenta Digital",
    proveedor_tipo: PROVEEDOR_CG,
    ambiente: cfg.ambiente,
    tipo_documento: "FACTURA",
    numero_documento: String(body.numero_documento),
    numero_serie: cfg.serie,
    control_fiscal: String(body.numero_control),
    pdf_url: pdfSeguro,
    estado: "ANULADO_OK",
    ultimo_error: "",
    anulado_en: ahoraIso,
  });
  return { ok: true, pdf_url: pdfSeguro };
}

export async function conciliarDocumentosCg(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  opts?: { fechaInicio?: string; fechaFin?: string },
  fetchFn: typeof fetch = fetch
): Promise<{
  ok: boolean;
  total_cg?: number;
  total_local?: number;
  diferencia?: number;
  recuperados?: number;
  muestra?: { numero: string; control: string; estado: string; pdf_url: string | null }[];
  error?: string;
}> {
  const todosRemotos: Record<string, any>[] = [];
  let pagina = 1;
  const maxPaginas = 5;

  while (pagina <= maxPaginas) {
    const qs = new URLSearchParams({ limite: "100", pagina: String(pagina) });
    if (opts?.fechaInicio && /^\d{4}-\d{2}-\d{2}$/.test(opts.fechaInicio)) qs.set("fechaInicio", opts.fechaInicio);
    if (opts?.fechaFin && /^\d{4}-\d{2}-\d{2}$/.test(opts.fechaFin)) qs.set("fechaFin", opts.fechaFin);

    const res = await peticionAutenticadaCg(
      db,
      env,
      cfg,
      `api/Invoice/get_list_invoices?${qs.toString()}`,
      { method: "GET", timeoutMs: 12_000 },
      fetchFn
    );
    if (!res.ok || res.error) {
      if (pagina === 1) {
        return { ok: false, error: res.error || res.data?.message || `No se pudo consultar get_list_invoices (HTTP ${res.status}).` };
      }
      break;
    }
    const lista: Record<string, any>[] = Array.isArray(res.data?.invoices)
      ? res.data.invoices
      : Array.isArray(res.data?.data)
        ? res.data.data
        : Array.isArray(res.data?.facturas)
          ? res.data.facturas
          : [];
    todosRemotos.push(...lista);
    if (lista.length < 100) break;
    pagina++;
  }

  // Mapa por número de factura (normalizado sin ceros a la izquierda) para recuperar documentos locales pendientes
  const mapaRemoto = new Map<string, { control: string; pdf_url: string | null; estado: string; numero: string }>();
  for (const item of todosRemotos) {
    const numRaw = String(item.invoice_number ?? item.numeroFactura ?? item.numero_documento ?? item.numero ?? "").trim();
    const ctrlRaw = String(item.control_number ?? item.numero_control ?? item.numeroControl ?? "").trim().toUpperCase();
    const pdfSeguro = validarUrlPdfSegura(item.invoice_pdf ?? item.pdf_factura ?? item.pdf ?? item.url_pdf ?? null);
    const estadoRaw = String(item.status ?? item.estado ?? "EMITIDA").trim();
    if (numRaw && ctrlRaw) {
      const claveNum = String(Number(numRaw) || numRaw);
      mapaRemoto.set(claveNum, { control: ctrlRaw, pdf_url: pdfSeguro, estado: estadoRaw, numero: numRaw });
    }
  }

  // Intentar recuperar documentos locales REALES de IMPRENTA_DIGITAL que quedaron sin control_fiscal
  const pendientesLocales = (
    await db
      .prepare(
        `SELECT id, numero, es_nota_credito, COALESCE(es_nota_debito, 0) AS es_nota_debito
         FROM documentos
         WHERE tipo = 'FACTURA' AND modo = 'REAL' AND estado = 'EMITIDO'
           AND medio = 'IMPRENTA_DIGITAL' AND control_fiscal IS NULL`
      )
      .all<{ id: number; numero: number; es_nota_credito: number; es_nota_debito: number }>()
      .catch(() => ({ results: [] }))
  ).results;

  let recuperados = 0;
  for (const d of pendientesLocales) {
    if (d.es_nota_credito || d.es_nota_debito) continue;
    const hit = mapaRemoto.get(String(d.numero));
    if (hit && /^[0-9A-Z][0-9A-Z-]{0,29}$/.test(hit.control)) {
      const rUpd = await db
        .prepare(`UPDATE documentos SET control_fiscal = ? WHERE id = ? AND control_fiscal IS NULL AND estado = 'EMITIDO'`)
        .bind(hit.control, d.id)
        .run()
        .catch(() => ({ meta: { changes: 0 } }));
      if ((rUpd.meta?.changes ?? 0) > 0) {
        recuperados++;
        await db.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(`imprenta_pendiente_${d.id}`).run().catch(() => {});
        await registrarEnvioImprentaDb(db, {
          documento_id: d.id,
          proveedor: cfg.proveedor || "CG La Imprenta Digital",
          proveedor_tipo: PROVEEDOR_CG,
          ambiente: cfg.ambiente,
          tipo_documento: "FACTURA",
          numero_documento: numeroDocumentoCg(d.numero),
          numero_serie: cfg.serie,
          control_fiscal: hit.control,
          pdf_url: hit.pdf_url,
          estado: "ENVIADO_OK",
          ultimo_error: "",
          retornado_en: new Date().toISOString(),
        });
      }
    }
  }

  const localOkRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM imprenta_envios WHERE estado IN ('ENVIADO_OK', 'ANULADO_OK')`)
    .first<{ n: number }>()
    .catch(() => ({ n: 0 }));

  const totalCg = todosRemotos.length;
  const totalLocal = Number(localOkRow?.n ?? 0);
  const diferencia = totalCg - totalLocal;
  const ahoraIso = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_ultima_conciliacion_json', ?, ?)
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
    )
    .bind(JSON.stringify({ en: ahoraIso, total_cg: totalCg, total_local: totalLocal, diferencia, recuperados }), ahoraIso)
    .run()
    .catch(() => {});

  return {
    ok: true,
    total_cg: totalCg,
    total_local: totalLocal,
    diferencia,
    recuperados,
    muestra: [...mapaRemoto.values()].slice(0, 10),
  };
}
