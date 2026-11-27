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
export const PROVEEDOR_TFHKA = "THE_FACTORY_HKA" as const;
export const PROVEEDOR_GENERICO = "GENERICO" as const;
export type TipoProveedorImprenta = typeof PROVEEDOR_CG | typeof PROVEEDOR_TFHKA | typeof PROVEEDOR_GENERICO;

export const CG_IMPRENTA_RAZON_SOCIAL = "CG LA IMPRENTA DIGITAL, C.A. · RIF J-504526711";
export const CG_IMPRENTA_AUTORIZACION = "Imprenta Digital Autorizada por el SENIAT · Providencia SNAT/INTI/012";

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
  sucursal: string;
  reservar_previo: boolean;
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
  factura_afectada_fecha?: string | null;
  factura_afectada_monto_bs?: number | null;
  condicion?: string | null;
  vendedor_nombre?: string | null;
  moneda_base?: "VES" | "USD";
  descuento_global_bs?: number;
  descuento_global_usd?: number;
  descuento_global_desc?: string | null;
  emisor?: { rif: string; nombre_razon_social: string; direccion_fiscal?: string; email?: string | null };
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
    descuento_bs?: number;
    descuento_usd?: number;
    es_percibido?: boolean;
  }[];
  impuestos?: Record<string, unknown>[];
};

export type ResultadoEnvioImprenta = {
  ok: boolean;
  control_fiscal: string | null;
  pdf_url?: string | null;
  proveedor?: string;
  proveedor_tipo?: TipoProveedorImprenta;
  fecha_asignacion?: string | null;
  hora_asignacion?: string | null;
  imprenta_razon_social?: string | null;
  imprenta_autorizacion?: string | null;
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

export function ambitoFiscalImprenta(cfg: {
  proveedor_tipo?: string | null;
  ambiente?: string | null;
  serie?: string | null;
}): string {
  const prov =
    String(cfg.proveedor_tipo || PROVEEDOR_GENERICO)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, "")
      .slice(0, 24) || PROVEEDOR_GENERICO;
  const amb = String(cfg.ambiente || "PRUEBAS").trim().toUpperCase() === "PRODUCCION" ? "PROD" : "PRUEBAS";
  const ser = String(cfg.serie || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 10);
  return ser ? `${prov}:${amb}:${ser}` : `${prov}:${amb}`;
}

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
  // Si el usuario pegó una ruta interna (/api/Invoice/..., /api/..., /auth/login, /doc/...), recortamos al host/base raíz
  let path = parsed.pathname
    .replace(/\/api\/invoice\/.*$/i, "/")
    .replace(/\/api\/?$/i, "/")
    .replace(/\/auth\/login\/?$/i, "/")
    .replace(/\/doc\/.*$/i, "/");
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

export function normalizarCorreoCg(correoCliente: unknown, correoEmisor?: unknown): string {
  const rx = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
  const cli = String(correoCliente ?? "").trim().toLowerCase();
  if (cli && cli.length <= 120 && rx.test(cli)) return cli;
  const emi = String(correoEmisor ?? "").trim().toLowerCase();
  if (emi && emi.length <= 120 && rx.test(emi)) return emi;
  return "sin-correo@facturayave.com";
}

export function normalizarTelefonoCg(telRaw: unknown): string {
  const limpio = String(telRaw ?? "").trim().replace(/[^0-9+]/g, "");
  const digitos = limpio.replace(/\D/g, "");
  if (digitos.length >= 7) return limpio.slice(0, 20);
  return "00000000000";
}

// ---------------------------------------------------------------- Constructores de payloads exactos (API Gateway CG v14)

export function construirPayloadFacturaCg(
  payload: PayloadImprentaDocumento,
  serie = "A",
  opts?: { incluirDescripcion?: boolean }
): Record<string, unknown> {
  const numStr = numeroDocumentoCg(payload.numero);
  const serieLimpia = limpiarTextoCg(serie, 5, "A").toUpperCase();
  const rengs = payload.renglones ?? [];
  const tasaSegura = Math.max(0, Math.round(Number(payload.tasa_e8) || 0));
  const productos = rengs.map((r, i) => {
    const precioUsdSeguro = Math.max(0, Math.round(Number(r.precio_usd ?? 0) || 0));
    const precioBsCent = tasaSegura > 0 ? Math.max(1, usdABs(precioUsdSeguro, tasaSegura)) : Math.max(1, precioUsdSeguro);
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

  // Según doc oficial CG v14, `descripcionFactura` es opcional y falla con HTTP 400 si el comercio tiene Coletilla / Mensaje Fijo activo.
  // Solo la incluimos si el usuario escribió una nota explícita (y nunca si se reintenta por conflicto de Coletilla).
  const notaLimpia = opts?.incluirDescripcion === false ? "" : limpiarTextoCg(payload.nota, 200);
  const facturaObj: Record<string, unknown> = {
    numeroFactura: numStr,
    ...(notaLimpia ? { descripcionFactura: notaLimpia } : {}),
    documentoIdentidadCliente: limpiarDocumentoIdentidadCg(payload.cliente_rif),
    nombreRazonSocialCliente: limpiarTextoCg(payload.cliente_nombre, 120, "Cliente"),
    correoCliente: normalizarCorreoCg(payload.cliente_email, payload.emisor?.email),
    direccionCliente: limpiarTextoCg(payload.cliente_direccion, 200, "Venezuela"),
    telefonoCliente: normalizarTelefonoCg(payload.cliente_telefono),
    tasa_del_dia: formatearTasaCg(payload.tasa_e8),
    fecha_tasa: formatearFechaDdMmYyyy(payload.fecha_emision),
    mostrar_formas_de_pago: 0,
    productos,
  };

  return {
    numeroSerie: serieLimpia,
    cantidadFactura: 1,
    facturas: [facturaObj],
  };
}

export function construirPayloadNcTotalCg(payload: PayloadImprentaDocumento): Record<string, unknown> {
  return {
    numeroFactura: numeroDocumentoCg(Number(payload.factura_afectada_numero ?? 0)),
    numeroNotaCredito: numeroDocumentoCg(payload.numero),
    // CG v14 impone estrictamente un máximo de 50 caracteres en `descripcion` para NC/ND
    descripcion: limpiarTextoCg(payload.motivo_nc || payload.nota, 50, "Devolución total de factura"),
  };
}

export function construirPayloadNcParcialCg(payload: PayloadImprentaDocumento): Record<string, unknown> {
  const rengs = payload.renglones ?? [];
  return {
    numeroFactura: numeroDocumentoCg(Number(payload.factura_afectada_numero ?? 0)),
    numeroNotaCredito: numeroDocumentoCg(payload.numero),
    descripcion: limpiarTextoCg(payload.motivo_nc || payload.nota, 50, "Devolución parcial de mercancía"),
    productos: rengs.map((r, i) => ({
      codigo: codigoProductoCg(r.catalogo_id, r.orden ?? i + 1),
      descripcion: limpiarTextoCg(r.descripcion, 120, `Renglón ${i + 1}`),
      cantidad: formatearCantidadMilliCg(Number(r.cantidad_milli ?? 1000)),
    })),
  };
}

export function construirPayloadNdCg(payload: PayloadImprentaDocumento): Record<string, unknown> {
  const rengs = payload.renglones ?? [];
  const tasaSeguraNd = Math.max(0, Math.round(Number(payload.tasa_e8) || 0));
  const productosNuevos = rengs.map((r, i) => {
    const precioUsdSeguro = Math.max(0, Math.round(Number(r.precio_usd ?? 0) || 0));
    const precioBsCent = tasaSeguraNd > 0 ? Math.max(1, usdABs(precioUsdSeguro, tasaSeguraNd)) : Math.max(1, precioUsdSeguro);
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
    descripcion: limpiarTextoCg(payload.motivo_nc || payload.nota, 50, "Nota de débito / ajuste"),
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

export function extraerListaDocumentosCg(data: Record<string, any> | null | undefined): Record<string, any>[] {
  if (!data || typeof data !== "object") return [];
  const raw = Array.isArray(data.invoices)
    ? data.invoices
    : Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.facturas)
        ? data.facturas
        : [];
  const planos: Record<string, any>[] = [];
  const aplanar = (arr: unknown[]) => {
    for (const el of arr) {
      if (Array.isArray(el)) aplanar(el);
      else if (el && typeof el === "object") planos.push(el as Record<string, any>);
    }
  };
  aplanar(raw);
  return planos;
}

export function normalizarTipoDocumentoCg(docRaw: unknown): "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO" | "OTRO" {
  const s = String(docRaw ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
  if (!s || s.includes("FACTURA")) return "FACTURA";
  if (s.includes("CREDITO") || s === "NC" || s === "NOTA_CREDITO") return "NOTA_CREDITO";
  if (s.includes("DEBITO") || s === "ND" || s === "NOTA_DEBITO") return "NOTA_DEBITO";
  return "OTRO";
}

export function claveNumeroCg(numRaw: unknown): string {
  const s = String(numRaw ?? "").trim().toUpperCase();
  if (!s) return "";
  if (/^\d+$/.test(s)) return String(Number(s));
  return s;
}

export function extraerRespuestaCg(
  data: Record<string, any> | null | undefined,
  _tipo?: string,
  httpStatus?: number
): {
  ok: boolean;
  control_fiscal: string | null;
  pdf_url: string | null;
  error?: string;
  sin_cupo?: boolean;
  duplicada?: boolean;
  coletilla_conflicto?: boolean;
  sin_control_en_200?: boolean;
} {
  if (!data || typeof data !== "object") {
    return { ok: false, control_fiscal: null, pdf_url: null, error: "Respuesta vacía de CG Imprenta Digital." };
  }

  // Verificar arreglo invoice_errors (add_list_invoice)
  const invErrors = Array.isArray(data.invoice_errors) ? data.invoice_errors : [];
  const rawExito = Array.isArray(data.invoice_list_success)
    ? data.invoice_list_success
    : Array.isArray(data.credit_note_list_success)
      ? data.credit_note_list_success
      : Array.isArray(data.debit_note_list_success)
        ? data.debit_note_list_success
        : [];
  // Aplanar posibles arreglos bidimensionales (ej. [[ { control_number, ... } ]]) igual que en get_list_invoices
  const listaExito: Record<string, any>[] = [];
  const aplanarExito = (arr: unknown[]) => {
    for (const el of arr) {
      if (Array.isArray(el)) aplanarExito(el);
      else if (el && typeof el === "object") listaExito.push(el as Record<string, any>);
    }
  };
  aplanarExito(rawExito);
  const primero = listaExito[0] ?? (data.data && typeof data.data === "object" ? data.data : null) ?? (data.resultado && typeof data.resultado === "object" ? data.resultado : null) ?? data;

  const rawCtrl = String(
    primero?.control_number ??
      primero?.numero_control ??
      primero?.numeroControl ??
      primero?.control_fiscal ??
      primero?.details?.control_number ??
      primero?.details?.numero_control ??
      data.control_number ??
      data.numero_control ??
      data.numeroControl ??
      data.control_fiscal ??
      data.details?.control_number ??
      data.details?.numero_control ??
      ""
  )
    .trim()
    .toUpperCase();

  const rawPdf =
    primero?.invoice_pdf ??
    primero?.credit_note_pdf ??
    primero?.debit_note_pdf ??
    primero?.pdf_factura ??
    primero?.pdf_nota_credito ??
    primero?.pdf_nota_debito ??
    primero?.details?.pdf_factura ??
    primero?.details?.invoice_pdf ??
    primero?.pdf_url ??
    primero?.url_pdf ??
    primero?.pdf ??
    data.invoice_pdf ??
    data.credit_note_pdf ??
    data.debit_note_pdf ??
    data.details?.pdf_factura ??
    data.details?.invoice_pdf ??
    data.pdf_factura ??
    data.pdf_nota_credito ??
    data.pdf_nota_debito ??
    data.pdf_url ??
    data.url_pdf ??
    data.pdf ??
    null;

  const pdfSeguro = validarUrlPdfSegura(rawPdf);

  if (rawCtrl && /^[0-9A-Z][0-9A-Z-]{0,29}$/.test(rawCtrl)) {
    return { ok: true, control_fiscal: rawCtrl, pdf_url: pdfSeguro };
  }

  const baseMsg = String(data.message ?? data.error ?? "").trim();
  const invErrTxt = invErrors.length
    ? invErrors
        .map((e: any) =>
          typeof e === "string"
            ? e.trim()
            : e?.error || e?.message || e?.errors?.join?.("; ") || JSON.stringify(e)
        )
        .filter(Boolean)
        .join(" | ")
    : "";
  const dataErrTxt = Array.isArray(data.errors)
    ? data.errors
        .map((e: any) => (typeof e === "string" ? e.trim() : e?.message || JSON.stringify(e)))
        .filter(Boolean)
        .join(" | ")
    : "";
  const detalleErr = invErrTxt || dataErrTxt;

  const msgErr =
    (baseMsg && detalleErr
      ? baseMsg.includes(detalleErr)
        ? baseMsg
        : `${baseMsg} (${detalleErr})`
      : baseMsg || detalleErr) || "CG Imprenta Digital no devolvió un número de control válido.";

  const sinCupo = /no posee m[aá]s n[uú]meros de control|sin n[uú]meros de control|agotad[oa]/i.test(msgErr);
  const coletillaConflicto = /coletilla|mensaje fijo|fixed_message/i.test(msgErr);
  const soloNumerosEnInvErrors =
    invErrors.length > 0 && invErrors.every((e: any) => typeof e === "string" && /^\d+$/.test(e.trim()));
  const duplicada =
    !sinCupo &&
    !coletillaConflicto &&
    (httpStatus === 409 ||
      /ya registrad|ya est[aá] en uso|duplicad|already registered/i.test(msgErr) ||
      soloNumerosEnInvErrors);

  const sinControlEn200 =
    !sinCupo &&
    !coletillaConflicto &&
    (httpStatus === 200 || httpStatus === 201) &&
    (data.success === true || rawExito.length > 0) &&
    invErrors.length === 0;

  return {
    ok: false,
    control_fiscal: null,
    pdf_url: null,
    error: msgErr.slice(0, 300),
    sin_cupo: sinCupo,
    duplicada,
    coletilla_conflicto: coletillaConflicto,
    sin_control_en_200: sinControlEn200,
  };
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
    mensaje = "Cupo agotado: registra una recarga de números de control para seguir timbrando en tu Imprenta Digital.";
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
      : m.proveedor_tipo === PROVEEDOR_TFHKA ||
          (!m.proveedor_tipo && /thefactoryhka\.com\.ve/i.test(String(m.url ?? "")))
        ? PROVEEDOR_TFHKA
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

  const serie =
    provTipo === PROVEEDOR_TFHKA
      ? String(m.serie ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 10)
      : (m.serie || "A").trim().toUpperCase().slice(0, 5) || "A";

  return {
    proveedor_tipo: provTipo,
    proveedor: m.proveedor ?? "",
    url: m.url ?? "",
    usuario: m.usuario ?? "",
    ambiente: m.ambiente === "PRODUCCION" ? "PRODUCCION" : "PRUEBAS",
    serie,
    sucursal: String(m.sucursal ?? "").trim().slice(0, 10),
    reservar_previo: m.reservar_previo === "1" || m.reservar_previo === "true",
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

export function fechaHoraAsignacionCaracas(fechaRef: Date = new Date()): { fecha: string; hora: string } {
  const ccs = new Date(fechaRef.getTime() - 4 * 3600 * 1000);
  const dd = String(ccs.getUTCDate()).padStart(2, "0");
  const mm = String(ccs.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = ccs.getUTCFullYear();
  let h = ccs.getUTCHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  const hh = String(h).padStart(2, "0");
  const mi = String(ccs.getUTCMinutes()).padStart(2, "0");
  const ss = String(ccs.getUTCSeconds()).padStart(2, "0");
  return { fecha: `${dd}/${mm}/${yyyy}`, hora: `${hh}:${mi}:${ss} ${ampm}` };
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
    fecha_asignacion?: string | null;
    hora_asignacion?: string | null;
    imprenta_razon_social?: string | null;
    imprenta_autorizacion?: string | null;
  }
) {
  const ahora = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO imprenta_envios (
         documento_id, proveedor, proveedor_tipo, ambiente, tipo_documento,
         numero_documento, numero_serie, control_fiscal, pdf_url, estado,
         intentos, ultimo_error, idempotency_key, enviado_en, retornado_en, anulado_en,
         fecha_asignacion, hora_asignacion, imprenta_razon_social, imprenta_autorizacion, actualizado_en
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(documento_id) DO UPDATE SET
         proveedor = excluded.proveedor,
         proveedor_tipo = excluded.proveedor_tipo,
         ambiente = excluded.ambiente,
         numero_documento = excluded.numero_documento,
         numero_serie = excluded.numero_serie,
         control_fiscal = COALESCE(imprenta_envios.control_fiscal, excluded.control_fiscal),
         pdf_url = COALESCE(excluded.pdf_url, imprenta_envios.pdf_url),
         estado = excluded.estado,
         intentos = imprenta_envios.intentos + 1,
         ultimo_error = excluded.ultimo_error,
         idempotency_key = CASE WHEN excluded.idempotency_key <> '' THEN excluded.idempotency_key ELSE imprenta_envios.idempotency_key END,
         retornado_en = COALESCE(imprenta_envios.retornado_en, excluded.retornado_en),
         anulado_en = COALESCE(excluded.anulado_en, imprenta_envios.anulado_en),
         fecha_asignacion = COALESCE(imprenta_envios.fecha_asignacion, excluded.fecha_asignacion),
         hora_asignacion = COALESCE(imprenta_envios.hora_asignacion, excluded.hora_asignacion),
         imprenta_razon_social = COALESCE(imprenta_envios.imprenta_razon_social, excluded.imprenta_razon_social),
         imprenta_autorizacion = COALESCE(imprenta_envios.imprenta_autorizacion, excluded.imprenta_autorizacion),
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
      datos.fecha_asignacion ?? null,
      datos.hora_asignacion ?? null,
      datos.imprenta_razon_social ?? null,
      datos.imprenta_autorizacion ?? null,
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
    proveedor:
      cfg.proveedor ||
      (cfg.proveedor_tipo === PROVEEDOR_CG
        ? "CG La Imprenta Digital"
        : cfg.proveedor_tipo === PROVEEDOR_TFHKA
          ? "The Factory HKA Venezuela"
          : ""),
    ambiente: cfg.ambiente,
    serie: cfg.serie,
    sucursal: cfg.sucursal,
    ultima_conciliacion: cfg.ultima_conciliacion,
    resumen,
  };

  if (!opts?.incluirHistorial) return base;

  const [enviosRes, recargasRes] = await Promise.all([
    db
      .prepare(
        `SELECT e.documento_id, e.tipo_documento, e.numero_documento, e.numero_serie,
                e.control_fiscal, e.pdf_url, e.estado, e.intentos, e.ultimo_error,
                e.enviado_en, e.retornado_en, e.anulado_en,
                e.fecha_asignacion, e.hora_asignacion, e.imprenta_razon_social, e.imprenta_autorizacion,
                d.cliente_nombre, d.total_usd
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
  const hostNorm = normalizarHostCg(cfg.url);
  const userNorm = cfg.usuario.trim().toLowerCase();
  if (!forzarRenovar) {
    const rows = (
      await db
        .prepare(`SELECT clave, valor FROM integraciones WHERE clave IN ('imprenta_cg_jwt', 'imprenta_cg_jwt_exp', 'imprenta_cg_jwt_host', 'imprenta_cg_jwt_user')`)
        .all<{ clave: string; valor: string }>()
        .catch(() => ({ results: [] }))
    ).results;
    const m = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
    const expMs = Number(m.imprenta_cg_jwt_exp || 0);
    if (
      m.imprenta_cg_jwt &&
      m.imprenta_cg_jwt_host === hostNorm &&
      (!m.imprenta_cg_jwt_user || m.imprenta_cg_jwt_user === userNorm) &&
      expMs > ahoraMs + 60_000
    ) {
      const tok = await descifrarSecreto(m.imprenta_cg_jwt, env);
      if (tok) return { ok: true, token: tok };
    }
  }

  const nuevo = await obtenerTokenCg(cfg.url, cfg.usuario, cfg.clave_clara, fetchFn);
  if (!nuevo.ok) return nuevo;

  // Guardar JWT cifrado con TTL de 50 minutos (CG emite tokens de 60 minutos), aislado por host + usuario API
  const ahoraIso = new Date().toISOString();
  const expMs = String(ahoraMs + 50 * 60_000);
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
        db
          .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_cg_jwt_user', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
          .bind(userNorm, ahoraIso),
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

async function buscarDocumentoRemotoCg(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  tipoDocumento: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO",
  numero: number,
  fetchFn: typeof fetch = fetch
): Promise<{ control_fiscal: string; pdf_url: string | null; estado: string } | null> {
  const numBuscado = claveNumeroCg(numero);
  const numPadded = numeroDocumentoCg(numero);

  const buscarEnLista = (items: Record<string, any>[]) => {
    for (const item of items) {
      const tipoItem = normalizarTipoDocumentoCg(item.document ?? item.tipo_documento ?? item.tipo ?? "FACTURA");
      if (tipoItem !== tipoDocumento) continue;
      const numRaw = String(item.invoice_number ?? item.numeroFactura ?? item.numero_documento ?? item.numero ?? "").trim();
      if (claveNumeroCg(numRaw) !== numBuscado) continue;
      const ctrlRaw = String(item.control_number ?? item.numero_control ?? item.numeroControl ?? "").trim().toUpperCase();
      if (!ctrlRaw || !/^[0-9A-Z][0-9A-Z-]{0,29}$/.test(ctrlRaw)) continue;
      const pdfSeguro = validarUrlPdfSegura(
        item.invoice_pdf ?? item.credit_note_pdf ?? item.debit_note_pdf ?? item.pdf_factura ?? item.pdf ?? item.url_pdf ?? null
      );
      return {
        control_fiscal: ctrlRaw,
        pdf_url: pdfSeguro,
        estado: String(item.status ?? item.estado ?? "EMITIDA").trim(),
      };
    }
    return null;
  };

  // 1) Consulta filtrada directa por numeroDocumento (rápida)
  const resFiltro = await peticionAutenticadaCg(
    db,
    env,
    cfg,
    `api/Invoice/get_list_invoices?${new URLSearchParams({ numeroDocumento: numPadded, limite: "50", pagina: "1" }).toString()}`,
    { method: "GET", timeoutMs: 12_000 },
    fetchFn
  );
  if (resFiltro.ok && !resFiltro.error) {
    const hit = buscarEnLista(extraerListaDocumentosCg(resFiltro.data));
    if (hit) return hit;
  }

  // 2) Respaldo paginado sin filtro (por si CG guardó otro largo de ceros a la izquierda)
  for (let pagina = 1; pagina <= 3; pagina++) {
    const resPag = await peticionAutenticadaCg(
      db,
      env,
      cfg,
      `api/Invoice/get_list_invoices?${new URLSearchParams({ limite: "100", pagina: String(pagina) }).toString()}`,
      { method: "GET", timeoutMs: 12_000 },
      fetchFn
    );
    if (!resPag.ok || resPag.error) break;
    const lista = extraerListaDocumentosCg(resPag.data);
    const hit = buscarEnLista(lista);
    if (hit) return hit;
    if (lista.length < 100) break;
  }

  return null;
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

  let res = await peticionAutenticadaCg(db, env, cfg, ruta, { method: "POST", body, timeoutMs: 25_000 }, fetchFn);
  const numDocStr = numeroDocumentoCg(payload.numero);

  let parsed: ReturnType<typeof extraerRespuestaCg>;
  if (res.error) {
    // Si hubo timeout o corte de red tras enviar, verificar una vez en CG si el documento sí se timbró antes de dejarlo pendiente
    const remotoTrasCorte =
      res.status === 0 ? await buscarDocumentoRemotoCg(db, env, cfg, payload.tipo_documento, payload.numero, fetchFn).catch(() => null) : null;
    if (remotoTrasCorte?.control_fiscal) {
      parsed = {
        ok: true,
        control_fiscal: remotoTrasCorte.control_fiscal,
        pdf_url: remotoTrasCorte.pdf_url,
      };
      res = { ok: true, status: 200, data: null };
    } else {
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
  } else {
    parsed = extraerRespuestaCg(res.data, payload.tipo_documento, res.status);
  }

  // Si la empresa tiene Coletilla / Mensaje Fijo en CG y enviamos `descripcionFactura`, reintentar automáticamente sin ese campo
  if ((!res.ok || !parsed.ok) && parsed.coletilla_conflicto && payload.tipo_documento === "FACTURA") {
    const bodySinDesc = construirPayloadFacturaCg(payload, cfg.serie, { incluirDescripcion: false });
    const resRetry = await peticionAutenticadaCg(db, env, cfg, ruta, { method: "POST", body: bodySinDesc, timeoutMs: 25_000 }, fetchFn);
    if (!resRetry.error) {
      res = resRetry;
      parsed = extraerRespuestaCg(res.data, payload.tipo_documento, res.status);
    }
  }

  // Si CG indica que el documento ya estaba registrado (ej. `invoice_errors: ["000005"]` / HTTP 409)
  // o respondió HTTP 200 exitoso sin incluir `control_number` en línea, consultamos `get_list_invoices` de inmediato para recuperarlo.
  if ((!res.ok || !parsed.ok || !parsed.control_fiscal) && (parsed.duplicada || parsed.sin_control_en_200)) {
    const remoto = await buscarDocumentoRemotoCg(db, env, cfg, payload.tipo_documento, payload.numero, fetchFn).catch(() => null);
    if (remoto?.control_fiscal) {
      parsed = {
        ok: true,
        control_fiscal: remoto.control_fiscal,
        pdf_url: remoto.pdf_url,
      };
      res = { ...res, ok: true };
    }
  }

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
  const ambitoFiscal = ambitoFiscalImprenta(cfg);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE documentos
           SET control_fiscal = ?, fiscal_serial = COALESCE(fiscal_serial, ?)
           WHERE id = ? AND control_fiscal IS NULL AND estado = 'EMITIDO'`
        )
        .bind(parsed.control_fiscal, ambitoFiscal, payload.documento_id),
      db.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(`imprenta_pendiente_${payload.documento_id}`),
    ]);
  } catch (e) {
    const rawErr = String((e as Error)?.message ?? e);
    let msgUsuario = "No se pudo guardar el número de control en la base local. Usa Conciliar con CG o reintenta.";
    let estadoErr: "ERROR" | "PENDIENTE" = "PENDIENTE";
    if (/UNIQUE|documentos_fiscal_unico/i.test(rawErr)) {
      estadoErr = "ERROR";
      const dueno =
        (await db
          .prepare(
            `SELECT numero, modo, medio, fiscal_serial FROM documentos
             WHERE control_fiscal = ? AND modo = 'REAL' AND COALESCE(medio, '') = 'IMPRENTA_DIGITAL' AND COALESCE(fiscal_serial, '') = ?
             LIMIT 1`
          )
          .bind(parsed.control_fiscal, ambitoFiscal)
          .first<{ numero: number; modo: string; medio: string | null; fiscal_serial: string | null }>()
          .catch(() => null)) ??
        (await db
          .prepare(`SELECT numero, modo, medio, fiscal_serial FROM documentos WHERE control_fiscal = ? LIMIT 1`)
          .bind(parsed.control_fiscal)
          .first<{ numero: number; modo: string; medio: string | null; fiscal_serial: string | null }>()
          .catch(() => null));
      const duenoTxt = dueno?.numero ? ` (doc. n.º ${numeroDocumentoCg(dueno.numero)})` : "";
      msgUsuario = `El número de control ${parsed.control_fiscal} devuelto por CG ya está asignado a otro documento local${duenoTxt} dentro del mismo ámbito (${ambitoFiscal}). Verifica que el correlativo de facturas en FacturaYa no esté repetido en tu cuenta CG.`;
    } else if (/Documento emitido|inmutable/i.test(rawErr)) {
      estadoErr = "ERROR";
      msgUsuario = "El documento ya estaba cerrado o no tenía modalidad de Imprenta Digital asignada al emitirse.";
    }
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
      estado: estadoErr,
      ultimo_error: msgUsuario,
      idempotency_key: idempotencyKey,
    });
    return {
      ok: false,
      control_fiscal: null,
      pdf_url: null,
      proveedor: cfg.proveedor || "CG La Imprenta Digital",
      proveedor_tipo: PROVEEDOR_CG,
      error: msgUsuario,
      idempotency_key: idempotencyKey,
    };
  }
  const fhAsig = fechaHoraAsignacionCaracas();
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
    fecha_asignacion: fhAsig.fecha,
    hora_asignacion: fhAsig.hora,
    imprenta_razon_social: CG_IMPRENTA_RAZON_SOCIAL,
    imprenta_autorizacion: CG_IMPRENTA_AUTORIZACION,
  });

  return {
    ok: true,
    control_fiscal: parsed.control_fiscal,
    pdf_url: parsed.pdf_url,
    proveedor: cfg.proveedor || "CG La Imprenta Digital",
    proveedor_tipo: PROVEEDOR_CG,
    fecha_asignacion: fhAsig.fecha,
    hora_asignacion: fhAsig.hora,
    imprenta_razon_social: CG_IMPRENTA_RAZON_SOCIAL,
    imprenta_autorizacion: CG_IMPRENTA_AUTORIZACION,
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
  const pdfSeguro = validarUrlPdfSegura(
    res.data?.details?.pdf_factura ?? res.data?.pdf_factura ?? res.data?.pdf ?? res.data?.data?.pdf_factura ?? null
  );
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
  muestra?: { tipo: string; numero: string; control: string; estado: string; pdf_url: string | null }[];
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
    // CG v14 devuelve HTTP 404 ("No se encontraron datos") cuando la consulta o página no tiene documentos
    if (res.status === 404 && !res.error) {
      break;
    }
    if (!res.ok || res.error) {
      if (pagina === 1) {
        return { ok: false, error: res.error || res.data?.message || `No se pudo consultar get_list_invoices (HTTP ${res.status}).` };
      }
      break;
    }
    // CG v14 devuelve `invoices: [ [ { ... } ] ]` (arreglo bidimensional); aplanamos siempre con extraerListaDocumentosCg
    const lista = extraerListaDocumentosCg(res.data);
    todosRemotos.push(...lista);
    if (lista.length < 100) break;
    pagina++;
  }

  // Mapa compuesto por (tipo, numero normalizado sin ceros a la izquierda) para recuperar Facturas, NC y ND pendientes
  const mapaRemoto = new Map<string, { tipo: string; control: string; pdf_url: string | null; estado: string; numero: string }>();
  for (const item of todosRemotos) {
    const tipoItem = normalizarTipoDocumentoCg(item.document ?? item.tipo_documento ?? item.tipo ?? "FACTURA");
    const numRaw = String(item.invoice_number ?? item.numeroFactura ?? item.numero_documento ?? item.numero ?? "").trim();
    const ctrlRaw = String(item.control_number ?? item.numero_control ?? item.numeroControl ?? "").trim().toUpperCase();
    const pdfSeguro = validarUrlPdfSegura(
      item.invoice_pdf ?? item.credit_note_pdf ?? item.debit_note_pdf ?? item.pdf_factura ?? item.pdf ?? item.url_pdf ?? null
    );
    const estadoRaw = String(item.status ?? item.estado ?? "EMITIDA").trim();
    if (numRaw && ctrlRaw) {
      const claveNum = claveNumeroCg(numRaw);
      mapaRemoto.set(`${tipoItem}:${claveNum}`, { tipo: tipoItem, control: ctrlRaw, pdf_url: pdfSeguro, estado: estadoRaw, numero: numRaw });
    }
  }

  // Intentar recuperar documentos locales REALES de IMPRENTA_DIGITAL que quedaron sin control_fiscal (Facturas, NC y ND)
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
  const ambitoFiscal = ambitoFiscalImprenta(cfg);
  for (const d of pendientesLocales) {
    const tipoLocal = d.es_nota_credito ? "NOTA_CREDITO" : d.es_nota_debito ? "NOTA_DEBITO" : "FACTURA";
    const hit = mapaRemoto.get(`${tipoLocal}:${claveNumeroCg(d.numero)}`);
    if (hit && /^[0-9A-Z][0-9A-Z-]{0,29}$/.test(hit.control)) {
      const rUpd = await db
        .prepare(
          `UPDATE documentos
           SET control_fiscal = ?, fiscal_serial = COALESCE(fiscal_serial, ?)
           WHERE id = ? AND control_fiscal IS NULL AND estado = 'EMITIDO'`
        )
        .bind(hit.control, ambitoFiscal, d.id)
        .run()
        .catch(() => ({ meta: { changes: 0 } }));
      if ((rUpd.meta?.changes ?? 0) > 0) {
        recuperados++;
        await db.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(`imprenta_pendiente_${d.id}`).run().catch(() => {});
        const fhAsig = fechaHoraAsignacionCaracas();
        await registrarEnvioImprentaDb(db, {
          documento_id: d.id,
          proveedor: cfg.proveedor || "CG La Imprenta Digital",
          proveedor_tipo: PROVEEDOR_CG,
          ambiente: cfg.ambiente,
          tipo_documento: tipoLocal,
          numero_documento: numeroDocumentoCg(d.numero),
          numero_serie: cfg.serie,
          control_fiscal: hit.control,
          pdf_url: hit.pdf_url,
          estado: "ENVIADO_OK",
          ultimo_error: "",
          retornado_en: new Date().toISOString(),
          fecha_asignacion: fhAsig.fecha,
          hora_asignacion: fhAsig.hora,
          imprenta_razon_social: CG_IMPRENTA_RAZON_SOCIAL,
          imprenta_autorizacion: CG_IMPRENTA_AUTORIZACION,
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

// ---------------------------------------------------------------- Suite de Certificación Calidad (CG La Imprenta Digital · PRUEBAS)

export type ResultadoCasoCertificacionCg = {
  codigo: string;
  descripcion: string;
  tipo_documento: string;
  numero_documento: string;
  esperaba_error: boolean;
  ok: boolean;
  http_status: number;
  control_fiscal: string | null;
  pdf_url: string | null;
  mensaje: string;
};

export async function ejecutarSuiteCertificacionCg(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  opts?: {
    numero_inicio?: number;
    rif_emisor?: string;
    razon_emisor?: string;
    email_prueba?: string;
    incluir_anulacion?: boolean;
    incluir_errores?: boolean;
  },
  fetchFn: typeof fetch = fetch
): Promise<{
  ok: boolean;
  ambiente?: string;
  host?: string;
  fecha_ejecucion?: string;
  resumen?: { total: number; aprobados: number; fallidos: number; errores_controlados_ok: number };
  resultados?: ResultadoCasoCertificacionCg[];
  reporte_texto?: string;
  error?: string;
}> {
  // CANDADO CRÍTICO: jamás ejecutar pruebas de certificación en ambiente PRODUCCION
  if (cfg.ambiente !== "PRUEBAS") {
    return {
      ok: false,
      error: "Bloqueado por seguridad fiscal: la Suite de Certificación CG La Imprenta Digital solo puede ejecutarse en ambiente PRUEBAS (Calidad).",
    };
  }
  const valUrl = validarUrlImprentaSegura(cfg.url);
  if (!valUrl.ok) return { ok: false, error: valUrl.error };
  const host = normalizarHostCg(valUrl.url);

  const auth = await obtenerOCachearTokenCg(db, env, cfg, true, fetchFn);
  if (!auth.ok) return { ok: false, error: auth.error };

  const numInicio = Math.max(1, Math.min(99_999_000, Math.trunc(Number(opts?.numero_inicio ?? 100) || 100)));
  const incluirAnulacion = opts?.incluir_anulacion !== false;
  const incluirErrores = opts?.incluir_errores !== false;
  const emailPrueba = normalizarCorreoCg(opts?.email_prueba, "certificacion@facturayave.com");
  const fechaIso = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
  const tasaE8 = 50_00000000; // Bs. 50.0000 por USD (aritmética entera exacta)
  const serieLimpia = (cfg.serie || "A").trim().toUpperCase().slice(0, 5) || "A";
  const emisorDemo = {
    rif: opts?.rif_emisor || "J-40123456-7",
    nombre_razon_social: opts?.razon_emisor || "EMPRESA CERTIFICACION FACTURAYA",
    email: emailPrueba,
  };

  let seq = numInicio;
  const nextNum = () => seq++;

  const numFac16 = nextNum();
  const numFac8 = nextNum();
  const numFac31 = nextNum();
  const numFacExenta = nextNum();
  const numFacMixta = nextNum();
  const numFacMulti = nextNum();
  const numNcTotal = nextNum();
  const numNcParcial = nextNum();
  const numNd = nextNum();

  const baseComun = (num: number, extra: Partial<PayloadImprentaDocumento>): PayloadImprentaDocumento => ({
    documento_id: 0,
    tipo_documento: "FACTURA",
    numero: num,
    control_interno: num,
    fecha_emision: fechaIso,
    cliente_rif: "J-30111222-3",
    cliente_nombre: "CLIENTE PRUEBA CERTIFICACION C.A.",
    cliente_email: emailPrueba,
    cliente_direccion: "Av. Francisco de Miranda, Caracas",
    cliente_telefono: "04145551234",
    condicion: "CONTADO",
    emisor: emisorDemo,
    tasa_e8: tasaE8,
    subtotal_bs: 500000,
    iva_bs: 80000,
    igtf_bs: 0,
    total_bs: 580000,
    subtotal_usd: 10000,
    iva_usd: 1600,
    igtf_usd: 0,
    total_usd: 11600,
    ...extra,
  });

  type CasoCg = {
    codigo: string;
    descripcion: string;
    tipo_documento: string;
    numero_documento: string;
    ruta: string;
    metodo: "GET" | "POST";
    esperaba_error: boolean;
    tipo_operacion: "EMISION" | "ANULACION" | "CONSULTA";
    requiere_control_de?: string;
    construir?: (controles: Record<string, string>) => Record<string, unknown>;
  };

  const casos: CasoCg[] = [
    {
      codigo: "FAC_IVA_16",
      descripcion: "Factura gravada alícuota general 16% (G)",
      tipo_documento: "FACTURA",
      numero_documento: numeroDocumentoCg(numFac16),
      ruta: "api/Invoice/add_list_invoice",
      metodo: "POST",
      esperaba_error: false,
      tipo_operacion: "EMISION",
      construir: () =>
        construirPayloadFacturaCg(
          baseComun(numFac16, {
            renglones: [{ orden: 1, catalogo_id: 1, descripcion: "Servicio de soporte técnico 16%", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600 }],
          }),
          serieLimpia,
          { incluirDescripcion: false }
        ),
    },
    {
      codigo: "FAC_IVA_8",
      descripcion: "Factura gravada alícuota reducida 8% (R)",
      tipo_documento: "FACTURA",
      numero_documento: numeroDocumentoCg(numFac8),
      ruta: "api/Invoice/add_list_invoice",
      metodo: "POST",
      esperaba_error: false,
      tipo_operacion: "EMISION",
      construir: () =>
        construirPayloadFacturaCg(
          baseComun(numFac8, {
            subtotal_bs: 500000, iva_bs: 40000, total_bs: 540000,
            subtotal_usd: 10000, iva_usd: 800, total_usd: 10800,
            renglones: [{ orden: 1, catalogo_id: 2, descripcion: "Servicio gravado alícuota reducida 8%", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 800 }],
          }),
          serieLimpia,
          { incluirDescripcion: false }
        ),
    },
    {
      codigo: "FAC_IVA_31",
      descripcion: "Factura gravada alícuota adicional suntuaria 31% (A)",
      tipo_documento: "FACTURA",
      numero_documento: numeroDocumentoCg(numFac31),
      ruta: "api/Invoice/add_list_invoice",
      metodo: "POST",
      esperaba_error: false,
      tipo_operacion: "EMISION",
      construir: () =>
        construirPayloadFacturaCg(
          baseComun(numFac31, {
            subtotal_bs: 500000, iva_bs: 155000, total_bs: 655000,
            subtotal_usd: 10000, iva_usd: 3100, total_usd: 13100,
            renglones: [{ orden: 1, catalogo_id: 3, tipo: "PRODUCTO", descripcion: "Artículo suntuario 31%", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 3100 }],
          }),
          serieLimpia,
          { incluirDescripcion: false }
        ),
    },
    {
      codigo: "FAC_EXENTA",
      descripcion: "Factura exenta de IVA 0% (E)",
      tipo_documento: "FACTURA",
      numero_documento: numeroDocumentoCg(numFacExenta),
      ruta: "api/Invoice/add_list_invoice",
      metodo: "POST",
      esperaba_error: false,
      tipo_operacion: "EMISION",
      construir: () =>
        construirPayloadFacturaCg(
          baseComun(numFacExenta, {
            subtotal_bs: 250000, iva_bs: 0, total_bs: 250000,
            subtotal_usd: 5000, iva_usd: 0, total_usd: 5000,
            renglones: [{ orden: 1, catalogo_id: 4, descripcion: "Servicio exento de IVA", cantidad_milli: 1000, precio_usd: 5000, alicuota_cent: 0 }],
          }),
          serieLimpia,
          { incluirDescripcion: false }
        ),
    },
    {
      codigo: "FAC_MIXTA",
      descripcion: "Factura mixta con 4 alícuotas (16% G + 8% R + 31% A + Exento E)",
      tipo_documento: "FACTURA",
      numero_documento: numeroDocumentoCg(numFacMixta),
      ruta: "api/Invoice/add_list_invoice",
      metodo: "POST",
      esperaba_error: false,
      tipo_operacion: "EMISION",
      construir: () =>
        construirPayloadFacturaCg(
          baseComun(numFacMixta, {
            subtotal_bs: 400000, iva_bs: 55000, total_bs: 455000,
            subtotal_usd: 8000, iva_usd: 1100, total_usd: 9100,
            renglones: [
              { orden: 1, catalogo_id: 11, descripcion: "Ítem gravado 16%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 1600 },
              { orden: 2, catalogo_id: 12, descripcion: "Ítem reducido 8%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 800 },
              { orden: 3, catalogo_id: 13, tipo: "PRODUCTO", descripcion: "Ítem adicional 31%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 3100 },
              { orden: 4, catalogo_id: 14, descripcion: "Ítem exento 0%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 0 },
            ],
          }),
          serieLimpia,
          { incluirDescripcion: false }
        ),
    },
    {
      codigo: "FAC_MULTI_CANT",
      descripcion: "Factura multi-renglón con cantidades múltiples (base para NC Parcial)",
      tipo_documento: "FACTURA",
      numero_documento: numeroDocumentoCg(numFacMulti),
      ruta: "api/Invoice/add_list_invoice",
      metodo: "POST",
      esperaba_error: false,
      tipo_operacion: "EMISION",
      construir: () =>
        construirPayloadFacturaCg(
          baseComun(numFacMulti, {
            subtotal_bs: 750000, iva_bs: 120000, total_bs: 870000,
            subtotal_usd: 15000, iva_usd: 2400, total_usd: 17400,
            renglones: [
              { orden: 1, catalogo_id: 101, tipo: "PRODUCTO", descripcion: "Repuesto certificado A", cantidad_milli: 2000, precio_usd: 5000, alicuota_cent: 1600 },
              { orden: 2, catalogo_id: 102, tipo: "SERVICIO", descripcion: "Instalación técnica B", cantidad_milli: 1000, precio_usd: 5000, alicuota_cent: 1600 },
            ],
          }),
          serieLimpia,
          { incluirDescripcion: false }
        ),
    },
    {
      codigo: "NC_TOTAL",
      descripcion: "Nota de Crédito Total (add_credit_note) sobre Factura 16%",
      tipo_documento: "NOTA_CREDITO",
      numero_documento: numeroDocumentoCg(numNcTotal),
      ruta: "api/Invoice/add_credit_note",
      metodo: "POST",
      esperaba_error: false,
      tipo_operacion: "EMISION",
      construir: () =>
        construirPayloadNcTotalCg(
          baseComun(numNcTotal, {
            tipo_documento: "NOTA_CREDITO",
            es_nc_total: true,
            factura_afectada_numero: numFac16,
            motivo_nc: "Devolucion total prueba certificacion CG",
          })
        ),
    },
    {
      codigo: "NC_PARCIAL",
      descripcion: "Nota de Crédito Parcial por productos (add_credit_note_with_products)",
      tipo_documento: "NOTA_CREDITO",
      numero_documento: numeroDocumentoCg(numNcParcial),
      ruta: "api/Invoice/add_credit_note_with_products",
      metodo: "POST",
      esperaba_error: false,
      tipo_operacion: "EMISION",
      construir: () =>
        construirPayloadNcParcialCg(
          baseComun(numNcParcial, {
            tipo_documento: "NOTA_CREDITO",
            es_nc_total: false,
            factura_afectada_numero: numFacMulti,
            motivo_nc: "Devolucion parcial 1 unidad repuesto A",
            renglones: [
              { orden: 1, catalogo_id: 101, descripcion: "Repuesto certificado A", cantidad_milli: 1000, precio_usd: 5000, alicuota_cent: 1600 },
            ],
          })
        ),
    },
    {
      codigo: "ND_AJUSTE",
      descripcion: "Nota de Débito por recargo/ajuste (add_debit_note) sobre Factura 8%",
      tipo_documento: "NOTA_DEBITO",
      numero_documento: numeroDocumentoCg(numNd),
      ruta: "api/Invoice/add_debit_note",
      metodo: "POST",
      esperaba_error: false,
      tipo_operacion: "EMISION",
      construir: () =>
        construirPayloadNdCg(
          baseComun(numNd, {
            tipo_documento: "NOTA_DEBITO",
            factura_afectada_numero: numFac8,
            motivo_nc: "Recargo adicional prueba certificacion CG",
            renglones: [
              { orden: 1, descripcion: "Recargo servicio urgente", cantidad_milli: 1000, precio_usd: 1500, alicuota_cent: 1600 },
            ],
          })
        ),
    },
  ];

  if (incluirAnulacion) {
    casos.push({
      codigo: "ANULACION",
      descripcion: "Anulación fiscal de Factura Exenta (cancel_invoice)",
      tipo_documento: "ANULACION",
      numero_documento: numeroDocumentoCg(numFacExenta),
      ruta: "api/Invoice/cancel_invoice",
      metodo: "POST",
      esperaba_error: false,
      tipo_operacion: "ANULACION",
      requiere_control_de: "FAC_EXENTA",
      construir: (controles) => construirPayloadAnulacionCg(numFacExenta, controles.FAC_EXENTA || ""),
    });
  }

  casos.push({
    codigo: "CONSULTA_LISTADO",
    descripcion: "Consulta en línea de documentos emitidos (get_list_invoices)",
    tipo_documento: "CONSULTA",
    numero_documento: "LISTADO",
    ruta: "api/Invoice/get_list_invoices?limite=20&pagina=1",
    metodo: "GET",
    esperaba_error: false,
    tipo_operacion: "CONSULTA",
  });

  if (incluirErrores) {
    casos.push(
      {
        codigo: "ERR_DUPLICADO",
        descripcion: "Validación negativa: rechazo por N.º de factura duplicado",
        tipo_documento: "FACTURA",
        numero_documento: numeroDocumentoCg(numFac16),
        ruta: "api/Invoice/add_list_invoice",
        metodo: "POST",
        esperaba_error: true,
        tipo_operacion: "EMISION",
        construir: () =>
          construirPayloadFacturaCg(
            baseComun(numFac16, {
              renglones: [{ orden: 1, catalogo_id: 1, descripcion: "Intento duplicado controlado", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600 }],
            }),
            serieLimpia,
            { incluirDescripcion: false }
          ),
      },
      {
        codigo: "ERR_CAMPOS_FALTANTES",
        descripcion: "Validación negativa: rechazo por campos obligatorios faltantes",
        tipo_documento: "FACTURA",
        numero_documento: numeroDocumentoCg(nextNum()),
        ruta: "api/Invoice/add_list_invoice",
        metodo: "POST",
        esperaba_error: true,
        tipo_operacion: "EMISION",
        construir: () => ({
          numeroSerie: serieLimpia,
          cantidadFactura: 1,
          facturas: [{ numeroFactura: "", documentoIdentidadCliente: "", productos: [] }],
        }),
      }
    );
  }

  const controlesObtenidos: Record<string, string> = {};
  const resultados: ResultadoCasoCertificacionCg[] = [];

  for (const caso of casos) {
    if (caso.requiere_control_de && !controlesObtenidos[caso.requiere_control_de]) {
      resultados.push({
        codigo: caso.codigo,
        descripcion: caso.descripcion,
        tipo_documento: caso.tipo_documento,
        numero_documento: caso.numero_documento,
        esperaba_error: caso.esperaba_error,
        ok: false,
        http_status: 0,
        control_fiscal: null,
        pdf_url: null,
        mensaje: `Omitido: requiere que ${caso.requiere_control_de} haya obtenido número de control previo.`,
      });
      continue;
    }

    const body = caso.construir ? caso.construir(controlesObtenidos) : undefined;
    const res = await peticionAutenticadaCg(
      db,
      env,
      cfg,
      caso.ruta,
      { method: caso.metodo, body, timeoutMs: 25_000 },
      fetchFn
    );

    if (caso.tipo_operacion === "CONSULTA") {
      const lista = res.error ? [] : extraerListaDocumentosCg(res.data);
      const okConsulta = res.ok && !res.error && lista.length > 0;
      resultados.push({
        codigo: caso.codigo,
        descripcion: caso.descripcion,
        tipo_documento: caso.tipo_documento,
        numero_documento: caso.numero_documento,
        esperaba_error: false,
        ok: okConsulta,
        http_status: res.status,
        control_fiscal: null,
        pdf_url: null,
        mensaje: okConsulta
          ? `Consulta OK: ${lista.length} documento(s) verificados en CG Calidad.`
          : res.error || res.data?.message || `HTTP ${res.status} sin documentos en get_list_invoices.`,
      });
      continue;
    }

    if (caso.tipo_operacion === "ANULACION") {
      const ctrlUsado = controlesObtenidos[caso.requiere_control_de || ""] || null;
      const pdfAnul = validarUrlPdfSegura(
        res.data?.details?.pdf_factura ?? res.data?.pdf_factura ?? res.data?.pdf ?? res.data?.data?.pdf_factura ?? null
      );
      const okAnul = res.ok && !res.error;
      resultados.push({
        codigo: caso.codigo,
        descripcion: caso.descripcion,
        tipo_documento: caso.tipo_documento,
        numero_documento: caso.numero_documento,
        esperaba_error: false,
        ok: okAnul,
        http_status: res.status,
        control_fiscal: ctrlUsado,
        pdf_url: pdfAnul,
        mensaje: okAnul
          ? `Anulada correctamente en CG (Control ${ctrlUsado || ""})`
          : res.error || res.data?.message || `HTTP ${res.status} al anular.`,
      });
      continue;
    }

    const parsed = res.error ? null : extraerRespuestaCg(res.data, caso.tipo_documento, res.status);

    if (caso.esperaba_error) {
      const rechazadoOk = !res.ok || !parsed?.ok || !parsed?.control_fiscal;
      resultados.push({
        codigo: caso.codigo,
        descripcion: caso.descripcion,
        tipo_documento: caso.tipo_documento,
        numero_documento: caso.numero_documento,
        esperaba_error: true,
        ok: rechazadoOk,
        http_status: res.status,
        control_fiscal: parsed?.control_fiscal ?? null,
        pdf_url: null,
        mensaje: rechazadoOk
          ? `Rechazo controlado OK: ${parsed?.error || res.error || `HTTP ${res.status}`}`
          : "Se esperaba rechazo de validación, pero CG devolvió éxito.",
      });
    } else if (res.ok && parsed?.ok && parsed.control_fiscal) {
      controlesObtenidos[caso.codigo] = parsed.control_fiscal;
      resultados.push({
        codigo: caso.codigo,
        descripcion: caso.descripcion,
        tipo_documento: caso.tipo_documento,
        numero_documento: caso.numero_documento,
        esperaba_error: false,
        ok: true,
        http_status: res.status,
        control_fiscal: parsed.control_fiscal,
        pdf_url: parsed.pdf_url,
        mensaje: `Control asignado: ${parsed.control_fiscal}`,
      });
    } else {
      resultados.push({
        codigo: caso.codigo,
        descripcion: caso.descripcion,
        tipo_documento: caso.tipo_documento,
        numero_documento: caso.numero_documento,
        esperaba_error: false,
        ok: false,
        http_status: res.status,
        control_fiscal: null,
        pdf_url: null,
        mensaje: res.error || parsed?.error || `HTTP ${res.status}`,
      });
    }
  }

  const aprobados = resultados.filter((r) => r.ok && !r.esperaba_error).length;
  const erroresControladosOk = resultados.filter((r) => r.ok && r.esperaba_error).length;
  const fallidos = resultados.filter((r) => !r.ok).length;
  const fechaEjec = new Date().toISOString();

  const lineasReporte = [
    `REPORTE DE CERTIFICACIÓN CALIDAD — CG LA IMPRENTA DIGITAL (FacturaYa Venezuela v5.3.1)`,
    `Fecha: ${fechaEjec} | Ambiente: PRUEBAS (Calidad) | Host: ${host}`,
    `Emisor: ${emisorDemo.nombre_razon_social} (${emisorDemo.rif}) | Serie: "${serieLimpia}"`,
    `Resultado: ${aprobados + erroresControladosOk}/${resultados.length} OK (${aprobados} operaciones + ${erroresControladosOk} errores controlados, ${fallidos} fallidos)`,
    ``,
    ...resultados.map(
      (r, idx) =>
        `${String(idx + 1).padStart(2, "0")}. [${r.ok ? "OK" : "FAIL"}] ${r.codigo} (${r.tipo_documento} · Doc ${r.numero_documento}) -> ${
          r.control_fiscal ? `Control ${r.control_fiscal}${r.pdf_url ? ` · PDF: ${r.pdf_url}` : ""}` : r.mensaje
        }`
    ),
  ];

  return {
    ok: fallidos === 0,
    ambiente: "PRUEBAS",
    host,
    fecha_ejecucion: fechaEjec,
    resumen: {
      total: resultados.length,
      aprobados,
      fallidos,
      errores_controlados_ok: erroresControladosOk,
    },
    resultados,
    reporte_texto: lineasReporte.join("\n"),
  };
}

