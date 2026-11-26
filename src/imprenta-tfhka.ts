// Módulo oficial de integración con The Factory HKA Venezuela (API Emisión v2 · SNAT/2024/000102).
// Reglas inquebrantables:
// - Toda aritmética monetaria opera EXCLUSIVAMENTE en centavos enteros (jamás decimales flotantes).
// - Las credenciales y el JWT cacheado (vigencia 12 h) se almacenan cifrados con AES-256-GCM.
// - Protección estricta contra URLs locales/privadas en host de Imprenta y enlaces PDF devueltos.

import { cifrarSecreto, descifrarSecreto } from "./cifrado";
import { usdABs } from "../public/dinero.js";
import {
  PROVEEDOR_TFHKA,
  alicuotaATipoImpuestoCg,
  codigoProductoCg,
  fechaHoraAsignacionCaracas,
  formatearCantidadMilliCg,
  formatearCentavosCg,
  formatearTasaCg,
  normalizarCorreoCg,
  normalizarTelefonoCg,
  registrarEnvioImprentaDb,
  validarUrlImprentaSegura,
  validarUrlPdfSegura,
  type ConfigImprentaConSecreto,
  type PayloadImprentaDocumento,
  type ResultadoEnvioImprenta,
} from "./imprenta-cg";

export const HOST_TFHKA_DEMO = "https://demoemisionv2.thefactoryhka.com.ve/";
export const HOST_TFHKA_PROD = "https://emisionv2.thefactoryhka.com.ve/";
export const TFHKA_RAZON_SOCIAL_DEFECTO = "THE FACTORY HKA VENEZUELA, C.A.";
export const TFHKA_AUTORIZACION_DEFECTO = "Imprenta Digital Autorizada por el SENIAT · Providencia SNAT/2024/000102";

// ---------------------------------------------------------------- Normalizadores y utilidades puras

export function normalizarHostTfhka(urlRaw: string): string {
  const parsed = new URL(urlRaw.trim());
  let path = parsed.pathname
    .replace(/\/(Autenticacion|Emision|EstadoDocumento|Anular|AsignarNumeraciones|ListadoAsignaciones|Correo|DescargarArchivo)\/?$/i, "/")
    .replace(/\/api\/?$/i, "/");
  if (!path.endsWith("/")) path += "/";
  return `${parsed.origin}${path}`;
}

export function tipoDocumentoTfhka(tipo: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO" | string): "01" | "02" | "03" {
  const t = String(tipo ?? "").toUpperCase();
  if (t === "NOTA_CREDITO" || t === "02") return "02";
  if (t === "NOTA_DEBITO" || t === "03") return "03";
  return "01";
}

export function numeroDocumentoTfhka(numero: number | string): string {
  const s = String(numero ?? "").trim();
  if (/^\d+$/.test(s)) {
    const n = Math.max(1, Math.trunc(Number(s) || 1));
    return String(n).padStart(8, "0");
  }
  return s.slice(0, 20) || "00000001";
}

export function dividirRifTfhka(rifRaw: string): { tipo: "V" | "J" | "E" | "G" | "P"; numero: string } {
  const limpio = String(rifRaw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = /^([VEJGP])(\d{5,12})$/.exec(limpio);
  if (m) {
    return { tipo: m[1] as "V" | "J" | "E" | "G" | "P", numero: m[2] };
  }
  const soloDig = limpio.replace(/\D/g, "");
  if (soloDig.length >= 5) {
    return { tipo: "V", numero: soloDig.slice(0, 12) };
  }
  return { tipo: "V", numero: "00000000" };
}

export function formatearFechaTfhka(isoDate: string): string {
  const raw = String(isoDate ?? "").trim();
  const mIso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (mIso) return `${mIso[3]}/${mIso[2]}/${mIso[1]}`;
  const mSlash = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(raw);
  if (mSlash) return `${mSlash[1]}/${mSlash[2]}/${mSlash[3]}`;
  const mDash = /^(\d{2})-(\d{2})-(\d{4})/.exec(raw);
  if (mDash) return `${mDash[1]}/${mDash[2]}/${mDash[3]}`;
  return fechaHoraAsignacionCaracas().fecha;
}

export function horaCaracas12h(fechaRef: Date = new Date()): string {
  return fechaHoraAsignacionCaracas(fechaRef).hora;
}

function limpiarTextoTfhka(v: unknown, max: number, defecto = ""): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return (s || defecto).slice(0, max);
}

// Conversión 100% en enteros de centavos a texto legal español para MontoEnLetras (VES o USD)
const UNIDADES = ["", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE"];
const ESPECIALES_10 = ["DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISEIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE"];
const VEINTIS = ["VEINTE", "VEINTIUN", "VEINTIDOS", "VEINTITRES", "VEINTICUATRO", "VEINTICINCO", "VEINTISEIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE"];
const DECENAS = ["", "DIEZ", "VEINTE", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const CENTENAS = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

function bloqueCientos(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "CIEN";
  const c = Math.floor(n / 100);
  const r = n % 100;
  const partes: string[] = [];
  if (c > 0) partes.push(CENTENAS[c]);
  if (r > 0) {
    if (r < 10) partes.push(UNIDADES[r]);
    else if (r < 20) partes.push(ESPECIALES_10[r - 10]);
    else if (r < 30) partes.push(VEINTIS[r - 20]);
    else {
      const d = Math.floor(r / 10);
      const u = r % 10;
      partes.push(u > 0 ? `${DECENAS[d]} Y ${UNIDADES[u]}` : DECENAS[d]);
    }
  }
  return partes.join(" ");
}

function enteroALetrasEs(entero: number): string {
  if (entero === 0) return "CERO";
  const partes: string[] = [];
  const milesMillones = Math.floor(entero / 1_000_000_000);
  const remMilMill = entero % 1_000_000_000;
  const millones = Math.floor(remMilMill / 1_000_000);
  const remMill = remMilMill % 1_000_000;
  const miles = Math.floor(remMill / 1000);
  const cientos = remMill % 1000;

  if (milesMillones > 0) {
    partes.push(milesMillones === 1 ? "MIL MILLONES" : `${bloqueCientos(milesMillones)} MIL MILLONES`);
  }
  if (millones > 0) {
    partes.push(millones === 1 ? "UN MILLON" : `${bloqueCientos(millones)} MILLONES`);
  }
  if (miles > 0) {
    partes.push(miles === 1 ? "MIL" : `${bloqueCientos(miles)} MIL`);
  }
  if (cientos > 0) {
    partes.push(bloqueCientos(cientos));
  }
  return partes.join(" ").replace(/\s+/g, " ").trim();
}

export function montoEnLetrasEntero(centavos: number, moneda: "VES" | "USD" = "VES"): string {
  const n = Math.max(0, Math.round(Number(centavos) || 0));
  const ent = Math.floor(n / 100);
  const dec = String(n % 100).padStart(2, "0");
  const letras = enteroALetrasEs(ent);
  const unidad =
    moneda === "USD"
      ? ent === 1
        ? "DOLAR"
        : "DOLARES"
      : ent === 1
        ? "BOLIVAR"
        : "BOLIVARES";
  return `${letras} ${unidad} CON ${dec}/100`;
}

function tasaAlicuotaStr(alicuotaCent: number): string {
  const a = Math.max(0, Math.round(Number(alicuotaCent) || 0));
  return formatearCentavosCg(a);
}

// ---------------------------------------------------------------- Constructor oficial DocumentoElectronico (Emisión v2)

export function construirDocumentoElectronicoTfhka(
  payload: PayloadImprentaDocumento,
  opts?: { serie?: string; sucursal?: string; fechaRef?: Date }
): { DocumentoElectronico: Record<string, unknown> } {
  const tipoCod = tipoDocumentoTfhka(payload.tipo_documento);
  const numDocStr = numeroDocumentoTfhka(payload.numero);
  const serieLimpia = String(opts?.serie ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 10);
  const sucursalLimpia = limpiarTextoTfhka(opts?.sucursal, 10, "0001");
  const fechaEmision = formatearFechaTfhka(payload.fecha_emision);
  const horaEmision = horaCaracas12h(opts?.fechaRef);
  const tasaSegura = Math.max(0, Math.round(Number(payload.tasa_e8) || 0));
  const tasaStr = formatearTasaCg(tasaSegura);

  const esCredito = String(payload.condicion ?? "").toUpperCase() === "CREDITO";
  const compradorId = dividirRifTfhka(payload.cliente_rif);
  const correoCliente = normalizarCorreoCg(payload.cliente_email, payload.emisor?.email);
  const telCliente = normalizarTelefonoCg(payload.cliente_telefono);

  const rengs = payload.renglones ?? [];
  let gravadoBs = 0;
  let exentoBs = 0;
  let gravadoUsd = 0;
  let exentoUsd = 0;

  const detallesItems = rengs.map((r, i) => {
    const alicCent = Math.max(0, Math.round(Number(r.alicuota_cent ?? 0) || 0));
    const codImp = alicuotaATipoImpuestoCg(alicCent);
    const cantMilli = Math.max(1, Math.round(Number(r.cantidad_milli ?? 1000) || 1000));
    const precioUsdCent = Math.max(0, Math.round(Number(r.precio_usd ?? 0) || 0));
    const montoUsdCent =
      Number(r.monto_usd ?? 0) > 0
        ? Math.round(Number(r.monto_usd))
        : Math.floor((cantMilli * precioUsdCent + 500) / 1000);
    const precioUnitBsCent = tasaSegura > 0 ? Math.max(1, usdABs(precioUsdCent, tasaSegura)) : Math.max(1, precioUsdCent);
    const montoBsCent =
      Number(r.monto_bs ?? 0) > 0
        ? Math.round(Number(r.monto_bs))
        : tasaSegura > 0
          ? Math.max(1, usdABs(montoUsdCent, tasaSegura))
          : montoUsdCent;

    const valorIvaBsCent = alicCent > 0 ? Math.floor((montoBsCent * alicCent + 5000) / 10000) : 0;
    const valorTotalBsCent = montoBsCent + valorIvaBsCent;

    if (alicCent > 0) {
      gravadoBs += montoBsCent;
      gravadoUsd += montoUsdCent;
    } else {
      exentoBs += montoBsCent;
      exentoUsd += montoUsdCent;
    }

    const desc = limpiarTextoTfhka(r.descripcion, 200, `Renglón ${i + 1}`);
    const esProducto = String(r.tipo ?? "").toUpperCase() === "PRODUCTO";
    return {
      NumeroLinea: String(i + 1),
      CodigoCIIU: "0000",
      CodigoPLU: codigoProductoCg(r.catalogo_id, r.orden ?? i + 1),
      IndicadorBienoServicio: esProducto ? "1" : "2",
      Descripcion: desc,
      Cantidad: formatearCantidadMilliCg(cantMilli),
      UnidadMedida: "UND",
      PrecioUnitario: formatearCentavosCg(precioUnitBsCent),
      PrecioUnitarioDescuento: "0.00",
      MontoBonificacion: "0.00",
      DescripcionBonificacion: "",
      DescuentoMonto: "0.00",
      RecargoMonto: "0.00",
      PrecioItem: formatearCentavosCg(montoBsCent),
      PrecioAntesDescuento: formatearCentavosCg(montoBsCent),
      CodigoImpuesto: codImp,
      TasaIVA: tasaAlicuotaStr(alicCent),
      ValorIVA: formatearCentavosCg(valorIvaBsCent),
      ValorTotalItem: formatearCentavosCg(valorTotalBsCent),
      InfoAdicionalItem: [],
    };
  });

  // Consolidar impuestos en VES y USD desde tabla documento_impuestos (si viene) o desde los renglones
  type ImpRow = { alicuota_cent: number; base_bs: number; iva_bs: number; base_usd: number; iva_usd: number };
  const impFuente: ImpRow[] = [];
  if (Array.isArray(payload.impuestos) && payload.impuestos.length > 0) {
    gravadoBs = 0;
    exentoBs = 0;
    gravadoUsd = 0;
    exentoUsd = 0;
    for (const row of payload.impuestos) {
      const a = Math.max(0, Math.round(Number(row.alicuota_cent ?? 0) || 0));
      const bBs = Math.max(0, Math.round(Number(row.base_bs ?? 0) || 0));
      const iBs = Math.max(0, Math.round(Number(row.iva_bs ?? 0) || 0));
      const bUsd = Math.max(0, Math.round(Number(row.base_usd ?? 0) || 0));
      const iUsd = Math.max(0, Math.round(Number(row.iva_usd ?? 0) || 0));
      impFuente.push({ alicuota_cent: a, base_bs: bBs, iva_bs: iBs, base_usd: bUsd, iva_usd: iUsd });
      if (a > 0) {
        gravadoBs += bBs;
        gravadoUsd += bUsd;
      } else {
        exentoBs += bBs;
        exentoUsd += bUsd;
      }
    }
  } else {
    if (gravadoBs > 0) {
      impFuente.push({
        alicuota_cent: 1600,
        base_bs: gravadoBs,
        iva_bs: Math.max(0, Math.round(Number(payload.iva_bs) || 0)),
        base_usd: gravadoUsd,
        iva_usd: Math.max(0, Math.round(Number(payload.iva_usd) || 0)),
      });
    }
    if (exentoBs > 0) {
      impFuente.push({ alicuota_cent: 0, base_bs: exentoBs, iva_bs: 0, base_usd: exentoUsd, iva_usd: 0 });
    }
  }

  const subtotalBs = Math.max(0, Math.round(Number(payload.subtotal_bs) || 0));
  const ivaBs = Math.max(0, Math.round(Number(payload.iva_bs) || 0));
  const igtfBs = Math.max(0, Math.round(Number(payload.igtf_bs) || 0));
  const totalBs = Math.max(0, Math.round(Number(payload.total_bs) || 0));
  const totalConIvaBs = subtotalBs + ivaBs;

  const subtotalUsd = Math.max(0, Math.round(Number(payload.subtotal_usd) || 0));
  const ivaUsd = Math.max(0, Math.round(Number(payload.iva_usd) || 0));
  const igtfUsd = Math.max(0, Math.round(Number(payload.igtf_usd) || 0));
  const totalUsd = Math.max(0, Math.round(Number(payload.total_usd) || 0));
  const totalConIvaUsd = subtotalUsd + ivaUsd;

  const impuestosSubtotalBs: Record<string, string>[] = impFuente.map((x) => ({
    CodigoTotalImp: alicuotaATipoImpuestoCg(x.alicuota_cent),
    AlicuotaImp: tasaAlicuotaStr(x.alicuota_cent),
    BaseImponibleImp: formatearCentavosCg(x.base_bs),
    ValorTotalImp: formatearCentavosCg(x.iva_bs),
  }));
  const impuestosSubtotalUsd: Record<string, string>[] = impFuente.map((x) => ({
    CodigoTotalImp: alicuotaATipoImpuestoCg(x.alicuota_cent),
    AlicuotaImp: tasaAlicuotaStr(x.alicuota_cent),
    BaseImponibleImp: formatearCentavosCg(x.base_usd),
    ValorTotalImp: formatearCentavosCg(x.iva_usd),
  }));

  if (igtfBs > 0) {
    impuestosSubtotalBs.push({
      CodigoTotalImp: "IGTF",
      AlicuotaImp: "3.00",
      BaseImponibleImp: formatearCentavosCg(totalConIvaBs),
      ValorTotalImp: formatearCentavosCg(igtfBs),
    });
  }
  if (igtfUsd > 0) {
    impuestosSubtotalUsd.push({
      CodigoTotalImp: "IGTF",
      AlicuotaImp: "3.00",
      BaseImponibleImp: formatearCentavosCg(totalConIvaUsd),
      ValorTotalImp: formatearCentavosCg(igtfUsd),
    });
  }

  const identificacionDocumento: Record<string, unknown> = {
    TipoDocumento: tipoCod,
    NumeroDocumento: numDocStr,
    TipoProveedor: null,
    TipoTransaccion: "01",
    NumeroPlanillaImportacion: null,
    NumeroExpedienteImportacion: null,
    SerieFacturaAfectada: tipoCod === "02" || tipoCod === "03" ? serieLimpia : null,
    NumeroFacturaAfectada:
      (tipoCod === "02" || tipoCod === "03") && payload.factura_afectada_numero
        ? numeroDocumentoTfhka(payload.factura_afectada_numero)
        : null,
    FechaFacturaAfectada:
      (tipoCod === "02" || tipoCod === "03") && payload.factura_afectada_fecha
        ? formatearFechaTfhka(payload.factura_afectada_fecha)
        : null,
    MontoFacturaAfectada:
      (tipoCod === "02" || tipoCod === "03") && payload.factura_afectada_monto_bs
        ? formatearCentavosCg(payload.factura_afectada_monto_bs)
        : null,
    ComentarioFacturaAfectada:
      tipoCod === "02" || tipoCod === "03"
        ? limpiarTextoTfhka(payload.motivo_nc || payload.nota, 200, tipoCod === "02" ? "Nota de crédito" : "Nota de débito")
        : null,
    RegimenEspTributacion: null,
    FechaEmision: fechaEmision,
    FechaVencimiento: fechaEmision,
    HoraEmision: horaEmision,
    Anulado: false,
    TipoDePago: esCredito ? "CREDITO" : "Inmediato",
    Serie: serieLimpia,
    Sucursal: sucursalLimpia,
    TipoDeVenta: "Interna",
    Moneda: "VES",
    TransaccionId: null,
    UrlPdf: null,
  };

  const infoAdicional: { Campo: string; Valor: string }[] = [];
  if (payload.nota) {
    infoAdicional.push({ Campo: "Observacion", Valor: limpiarTextoTfhka(payload.nota, 250) });
  }
  if (tasaSegura > 0) {
    infoAdicional.push({ Campo: "TasaBCV", Valor: `Bs. ${tasaStr} por USD` });
  }

  return {
    DocumentoElectronico: {
      Encabezado: {
        IdentificacionDocumento: identificacionDocumento,
        Vendedor: {
          Codigo: "01",
          Nombre: limpiarTextoTfhka(payload.vendedor_nombre || payload.emisor?.nombre_razon_social, 80, "Principal"),
          NumCajero: "01",
        },
        Comprador: {
          TipoIdentificacion: compradorId.tipo,
          NumeroIdentificacion: compradorId.numero,
          RazonSocial: limpiarTextoTfhka(payload.cliente_nombre, 120, "Cliente"),
          Direccion: limpiarTextoTfhka(payload.cliente_direccion, 200, "Venezuela"),
          Ubigeo: null,
          Pais: "VE",
          Notificar: payload.cliente_email ? "Si" : "No",
          Telefono: [telCliente],
          Correo: [correoCliente],
          OtrosEnvios: null,
        },
        SujetoRetenido: null,
        Terceros: null,
        Totales: {
          NroItems: String(detallesItems.length),
          MontoGravadoTotal: formatearCentavosCg(gravadoBs),
          MontoExentoTotal: formatearCentavosCg(exentoBs),
          MontoPercibidoTotal: "0.00",
          SubtotalAntesDescuento: formatearCentavosCg(subtotalBs),
          TotalDescuento: "0.00",
          TotalRecargos: "0.00",
          Subtotal: formatearCentavosCg(subtotalBs),
          TotalIVA: formatearCentavosCg(ivaBs),
          MontoTotalConIVA: formatearCentavosCg(totalConIvaBs),
          TotalAPagar: formatearCentavosCg(totalBs),
          MontoEnLetras: montoEnLetrasEntero(totalBs, "VES"),
          ListaRecargo: null,
          ListaDescBonificacion: null,
          ImpuestosSubtotal: impuestosSubtotalBs,
          OtrosImpuestosSubtotal: null,
          FormasPago: [
            {
              Descripcion: esCredito ? "Credito" : "Contado",
              Fecha: fechaEmision,
              Forma: "02",
              Monto: formatearCentavosCg(totalBs),
              Moneda: "VES",
              TipoCambio: "0.0000",
            },
          ],
          TotalIGTF: formatearCentavosCg(igtfBs),
          TotalIGTF_VES: formatearCentavosCg(igtfBs),
        },
        TotalesOtraMoneda:
          tasaSegura > 0
            ? {
                Moneda: "USD",
                TipoCambio: tasaStr,
                MontoGravadoTotal: formatearCentavosCg(gravadoUsd),
                MontoExentoTotal: formatearCentavosCg(exentoUsd),
                Subtotal: formatearCentavosCg(subtotalUsd),
                TotalAPagar: formatearCentavosCg(totalUsd),
                TotalIVA: formatearCentavosCg(ivaUsd),
                MontoTotalConIVA: formatearCentavosCg(totalConIvaUsd),
                MontoEnLetras: montoEnLetrasEntero(totalUsd, "USD"),
                SubtotalAntesDescuento: formatearCentavosCg(subtotalUsd),
                TotalDescuento: "0.00",
                TotalRecargos: "0.00",
                ListaRecargo: null,
                ListaDescBonificacion: null,
                ImpuestosSubtotal: impuestosSubtotalUsd,
                OtrosImpuestosSubtotal: null,
              }
            : null,
        TotalesRetencion: null,
      },
      DetallesItems: detallesItems,
      DetallesRetencion: null,
      Viajes: null,
      InfoAdicional: infoAdicional,
      GuiaDespacho: null,
      Transporte: null,
      EsLote: null,
      EsMinimo: null,
    },
  };
}

// ---------------------------------------------------------------- Parseo robusto de respuestas The Factory HKA v2

export function extraerTokenTfhka(rawBody: string, json: Record<string, any> | null): string | null {
  const candidatos = [
    json?.token,
    json?.access_token,
    json?.jwt,
    json?.resultado?.token,
    json?.data?.token,
  ];
  for (const c of candidatos) {
    if (typeof c === "string" && c.trim().length > 12) return c.trim();
  }
  const limpio = String(rawBody ?? "").trim().replace(/^"+|"+$/g, "");
  if (limpio && !limpio.startsWith("{") && !limpio.startsWith("<") && limpio.length > 15 && !/\s/.test(limpio)) {
    return limpio;
  }
  return null;
}

export function extraerRespuestaEmisionTfhka(
  data: Record<string, any> | null | undefined,
  httpStatus?: number
): {
  ok: boolean;
  control_fiscal: string | null;
  pdf_url: string | null;
  fecha_asignacion: string | null;
  hora_asignacion: string | null;
  imprenta_razon_social: string | null;
  imprenta_autorizacion: string | null;
  error?: string;
  sin_cupo?: boolean;
  duplicada?: boolean;
  sin_numeracion?: boolean;
  sin_control_en_200?: boolean;
} {
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      control_fiscal: null,
      pdf_url: null,
      fecha_asignacion: null,
      hora_asignacion: null,
      imprenta_razon_social: null,
      imprenta_autorizacion: null,
      error: "Respuesta vacía de The Factory HKA.",
    };
  }

  const res =
    (data.resultado && typeof data.resultado === "object" ? data.resultado : null) ??
    (data.data && typeof data.data === "object" ? data.data : null) ??
    data;

  const rawCtrl = String(
    res?.numeroControl ??
      res?.numero_control ??
      res?.control_number ??
      res?.control_fiscal ??
      data.numeroControl ??
      data.numero_control ??
      ""
  )
    .trim()
    .toUpperCase();

  const pdfSeguro = validarUrlPdfSegura(
    res?.urlPdf ?? res?.url_pdf ?? res?.pdf_url ?? res?.pdf ?? data.urlPdf ?? data.pdf_url ?? null
  );

  const fechaAsig = String(res?.fechaAsignacion ?? data.fechaAsignacion ?? "").trim() || null;
  const horaAsig = String(res?.horaAsignacion ?? data.horaAsignacion ?? "").trim() || null;
  const razonImp = String(res?.imprentaDigital ?? res?.imprenta ?? data.imprentaDigital ?? data.imprenta ?? "").trim() || TFHKA_RAZON_SOCIAL_DEFECTO;
  const autImp = String(res?.autorizado ?? res?.autorizacion ?? data.autorizado ?? data.autorizacion ?? "").trim() || TFHKA_AUTORIZACION_DEFECTO;

  if (rawCtrl && /^[0-9A-Z][0-9A-Z-]{0,29}$/.test(rawCtrl)) {
    return {
      ok: true,
      control_fiscal: rawCtrl,
      pdf_url: pdfSeguro,
      fecha_asignacion: fechaAsig,
      hora_asignacion: horaAsig,
      imprenta_razon_social: razonImp,
      imprenta_autorizacion: autImp,
    };
  }

  const codigo = String(data.codigo ?? res?.codigo ?? "").trim();
  const baseMsg = String(data.mensaje ?? data.message ?? res?.mensaje ?? data.error ?? "").trim();
  const validaciones = Array.isArray(data.validaciones)
    ? data.validaciones.map((v: any) => (typeof v === "string" ? v : v?.mensaje || v?.error || JSON.stringify(v))).filter(Boolean).join(" | ")
    : "";
  const msgErr =
    (baseMsg && validaciones ? `${baseMsg} (${validaciones})` : baseMsg || validaciones || (codigo ? `Código TFHKA ${codigo}` : "")) ||
    "The Factory HKA no devolvió un número de control válido.";

  const sinCupo = /sin\s+n[uú]meros\s+de\s+control|agotad[oa]|no\s+posee\s+folios|sin\s+saldo/i.test(msgErr);
  const sinNumeracion = /no\s+se\s+encuentra\s+asignad|numeraci[oó]n\s+no\s+asignad|asignar\s*numeraci/i.test(msgErr);
  const duplicada =
    !sinCupo &&
    !sinNumeracion &&
    (httpStatus === 409 || /ya\s+fue\s+emitid|ya\s+existe|duplicad|documento\s+registrado/i.test(msgErr));
  const sinControlEn200 =
    !sinCupo &&
    !sinNumeracion &&
    (httpStatus === 200 || httpStatus === 201) &&
    (codigo === "200" || codigo === "0" || data.procesado === true);

  return {
    ok: false,
    control_fiscal: null,
    pdf_url: null,
    fecha_asignacion: null,
    hora_asignacion: null,
    imprenta_razon_social: null,
    imprenta_autorizacion: null,
    error: msgErr.slice(0, 300),
    sin_cupo: sinCupo,
    duplicada,
    sin_numeracion: sinNumeracion,
    sin_control_en_200: sinControlEn200,
  };
}

// ---------------------------------------------------------------- Cliente HTTP oficial The Factory HKA v2

export async function obtenerTokenTfhka(
  hostBase: string,
  usuario: string,
  clave: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const host = normalizarHostTfhka(hostBase);
  try {
    const r = await fetchFn(`${host}Autenticacion`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        usuario: usuario.trim(),
        clave,
      }),
    });
    const rawTxt = await r.text().catch(() => "");
    let j: Record<string, any> | null = null;
    try {
      j = rawTxt ? JSON.parse(rawTxt) : null;
    } catch {
      j = null;
    }
    const token = r.ok ? extraerTokenTfhka(rawTxt, j) : null;
    if (!r.ok || !token) {
      const msg = j?.mensaje || j?.message || j?.error || `HTTP ${r.status}`;
      return { ok: false, error: `The Factory HKA rechazó la autenticación (${msg}). Verifica usuario y clave API.` };
    }
    return { ok: true, token };
  } catch (e) {
    return { ok: false, error: `No se pudo conectar con The Factory HKA: ${(e as Error).message}` };
  }
}

async function obtenerOCachearTokenTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  forzarRenovar: boolean,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const ahoraMs = Date.now();
  const hostNorm = normalizarHostTfhka(cfg.url);
  const userNorm = cfg.usuario.trim().toLowerCase();
  if (!forzarRenovar) {
    const rows = (
      await db
        .prepare(
          `SELECT clave, valor FROM integraciones
           WHERE clave IN ('imprenta_tfhka_jwt', 'imprenta_tfhka_jwt_exp', 'imprenta_tfhka_jwt_host', 'imprenta_tfhka_jwt_user')`
        )
        .all<{ clave: string; valor: string }>()
        .catch(() => ({ results: [] }))
    ).results;
    const m = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
    const expMs = Number(m.imprenta_tfhka_jwt_exp || 0);
    if (
      m.imprenta_tfhka_jwt &&
      m.imprenta_tfhka_jwt_host === hostNorm &&
      (!m.imprenta_tfhka_jwt_user || m.imprenta_tfhka_jwt_user === userNorm) &&
      expMs > ahoraMs + 120_000
    ) {
      const tok = await descifrarSecreto(m.imprenta_tfhka_jwt, env);
      if (tok) return { ok: true, token: tok };
    }
  }

  const nuevo = await obtenerTokenTfhka(cfg.url, cfg.usuario, cfg.clave_clara, fetchFn);
  if (!nuevo.ok) return nuevo;

  // Token oficial The Factory HKA dura 12 horas; cacheamos cifrado por 11 horas (margen de 1 h)
  const ahoraIso = new Date().toISOString();
  const expMs = String(ahoraMs + 11 * 3600_000);
  const jwtCifrado = await cifrarSecreto(nuevo.token, env).catch(() => "");
  if (jwtCifrado) {
    await db
      .batch([
        db
          .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_tfhka_jwt', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
          .bind(jwtCifrado, ahoraIso),
        db
          .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_tfhka_jwt_exp', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
          .bind(expMs, ahoraIso),
        db
          .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_tfhka_jwt_host', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
          .bind(hostNorm, ahoraIso),
        db
          .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_tfhka_jwt_user', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
          .bind(userNorm, ahoraIso),
      ])
      .catch(() => {});
  }
  return nuevo;
}

async function peticionAutenticadaTfhka(
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
    return { ok: false, status: 400, data: null, error: "Faltan las credenciales API de The Factory HKA (usuario y clave)." };
  }
  const host = normalizarHostTfhka(valUrl.url);
  const endpoint = `${host}${rutaRelativa.replace(/^\/+/, "")}`;

  for (let intento = 0; intento < 2; intento++) {
    const auth = await obtenerOCachearTokenTfhka(db, env, cfg, intento === 1, fetchFn);
    if (!auth.ok) return { ok: false, status: 401, data: null, error: auth.error };
    try {
      const r = await fetchFn(endpoint, {
        method: init.method,
        signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${auth.token}`,
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
      if (r.status === 401 && intento === 0) continue; // renovar JWT una vez automáticamente
      const data = (await r.json().catch(() => null)) as Record<string, any> | null;
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: null, error: `Error de red con The Factory HKA: ${(e as Error).message}` };
    }
  }
  return { ok: false, status: 401, data: null, error: "Token rechazado por The Factory HKA." };
}

export async function asignarNumeracionTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  tipoDocumento: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO",
  numero: number,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; error?: string }> {
  const numStr = numeroDocumentoTfhka(numero);
  const body = {
    detalleAsignacion: [
      {
        serie: cfg.serie || "",
        tipoDocumento: tipoDocumentoTfhka(tipoDocumento),
        numeroDocumentoInicio: numStr,
        numeroDocumentoFin: numStr,
      },
    ],
  };
  const res = await peticionAutenticadaTfhka(
    db,
    env,
    cfg,
    "AsignarNumeraciones",
    { method: "POST", body, timeoutMs: 12_000 },
    fetchFn
  );
  if (!res.ok || res.error) {
    return { ok: false, error: res.error || res.data?.mensaje || `HTTP ${res.status}` };
  }
  return { ok: true };
}

export async function consultarEstadoDocumentoTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  tipoDocumento: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO",
  numero: number,
  fetchFn: typeof fetch = fetch
): Promise<{
  control_fiscal: string;
  pdf_url: string | null;
  fecha_asignacion: string | null;
  hora_asignacion: string | null;
  imprenta_razon_social: string | null;
  imprenta_autorizacion: string | null;
} | null> {
  const body = {
    serie: cfg.serie || "",
    tipoDocumento: tipoDocumentoTfhka(tipoDocumento),
    numeroDocumento: numeroDocumentoTfhka(numero),
  };
  const res = await peticionAutenticadaTfhka(
    db,
    env,
    cfg,
    "EstadoDocumento",
    { method: "POST", body, timeoutMs: 12_000 },
    fetchFn
  );
  if (!res.ok || res.error) return null;
  const parsed = extraerRespuestaEmisionTfhka(res.data, res.status);
  if (!parsed.ok || !parsed.control_fiscal) return null;
  return {
    control_fiscal: parsed.control_fiscal,
    pdf_url: parsed.pdf_url,
    fecha_asignacion: parsed.fecha_asignacion,
    hora_asignacion: parsed.hora_asignacion,
    imprenta_razon_social: parsed.imprenta_razon_social,
    imprenta_autorizacion: parsed.imprenta_autorizacion,
  };
}

export async function probarConexionTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; host?: string; asignaciones?: number; mensaje?: string; error?: string }> {
  const valUrl = validarUrlImprentaSegura(cfg.url);
  if (!valUrl.ok) return { ok: false, error: valUrl.error };
  const host = normalizarHostTfhka(valUrl.url);

  const auth = await obtenerOCachearTokenTfhka(db, env, cfg, true, fetchFn);
  if (!auth.ok) return { ok: false, error: auth.error };

  // Consulta ligera opcional a ListadoAsignaciones para confirmar acceso operativo del token
  let asignaciones = 0;
  const resAsig = await peticionAutenticadaTfhka(
    db,
    env,
    cfg,
    "ListadoAsignaciones",
    {
      method: "POST",
      body: {
        serie: cfg.serie || "",
        tipoDocumento: "01",
        numeroDocumentoInicio: "00000001",
        numeroDocumentoFin: "99999999",
        numPagina: 1,
      },
      timeoutMs: 10_000,
    },
    fetchFn
  ).catch(() => null);
  if (resAsig?.ok && resAsig.data) {
    const lista = resAsig.data.resultado?.asignaciones ?? resAsig.data.asignaciones ?? resAsig.data.data ?? [];
    if (Array.isArray(lista)) asignaciones = lista.length;
  }

  return {
    ok: true,
    host,
    asignaciones,
    mensaje: `Conexión verificada con The Factory HKA Venezuela (${cfg.ambiente === "PRODUCCION" ? "Producción" : "Demo / Pruebas"}) · Token JWT activo (12 h)${asignaciones > 0 ? ` · ${asignaciones} rango(s) de numeración` : ""}.`,
  };
}

export async function enviarDocumentoTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  payload: PayloadImprentaDocumento,
  idempotencyKey: string,
  fetchFn: typeof fetch = fetch
): Promise<ResultadoEnvioImprenta> {
  const numDocStr = numeroDocumentoTfhka(payload.numero);
  const provNombre = cfg.proveedor || "The Factory HKA Venezuela";

  if (cfg.reservar_previo) {
    await asignarNumeracionTfhka(db, env, cfg, payload.tipo_documento, payload.numero, fetchFn).catch(() => {});
  }

  const body = construirDocumentoElectronicoTfhka(payload, { serie: cfg.serie, sucursal: cfg.sucursal });
  let res = await peticionAutenticadaTfhka(db, env, cfg, "Emision", { method: "POST", body, timeoutMs: 25_000 }, fetchFn);

  let parsed: ReturnType<typeof extraerRespuestaEmisionTfhka>;
  if (res.error) {
    const remotoTrasCorte =
      res.status === 0
        ? await consultarEstadoDocumentoTfhka(db, env, cfg, payload.tipo_documento, payload.numero, fetchFn).catch(() => null)
        : null;
    if (remotoTrasCorte?.control_fiscal) {
      parsed = { ok: true, ...remotoTrasCorte };
      res = { ok: true, status: 200, data: null };
    } else {
      await registrarEnvioImprentaDb(db, {
        documento_id: payload.documento_id,
        proveedor: provNombre,
        proveedor_tipo: PROVEEDOR_TFHKA,
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
        proveedor: provNombre,
        proveedor_tipo: PROVEEDOR_TFHKA,
        error: res.error,
        idempotency_key: idempotencyKey,
      };
    }
  } else {
    parsed = extraerRespuestaEmisionTfhka(res.data, res.status);
  }

  // Si TFHKA exige AsignarNumeraciones previa y no estaba activado el switch, asignar automáticamente una vez y reintentar
  if ((!res.ok || !parsed.ok) && parsed.sin_numeracion && !cfg.reservar_previo) {
    const resAsig = await asignarNumeracionTfhka(db, env, cfg, payload.tipo_documento, payload.numero, fetchFn).catch(() => ({ ok: false }));
    if (resAsig.ok) {
      const resRetry = await peticionAutenticadaTfhka(db, env, cfg, "Emision", { method: "POST", body, timeoutMs: 25_000 }, fetchFn);
      if (!resRetry.error) {
        res = resRetry;
        parsed = extraerRespuestaEmisionTfhka(res.data, res.status);
      }
    }
  }

  // Si ya existía emitido o vino 200 sin número de control en línea, recuperar vía EstadoDocumento
  if ((!res.ok || !parsed.ok || !parsed.control_fiscal) && (parsed.duplicada || parsed.sin_control_en_200)) {
    const remoto = await consultarEstadoDocumentoTfhka(db, env, cfg, payload.tipo_documento, payload.numero, fetchFn).catch(() => null);
    if (remoto?.control_fiscal) {
      parsed = { ok: true, ...remoto };
      res = { ...res, ok: true };
    }
  }

  if (!res.ok || !parsed.ok || !parsed.control_fiscal) {
    const errMsg = parsed.error || `The Factory HKA respondió HTTP ${res.status}`;
    await registrarEnvioImprentaDb(db, {
      documento_id: payload.documento_id,
      proveedor: provNombre,
      proveedor_tipo: PROVEEDOR_TFHKA,
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
      proveedor: provNombre,
      proveedor_tipo: PROVEEDOR_TFHKA,
      error: errMsg,
      idempotency_key: idempotencyKey,
      sin_cupo: parsed.sin_cupo,
    };
  }

  const ahoraIso = new Date().toISOString();
  const fhDef = fechaHoraAsignacionCaracas();
  const fechaAsig = parsed.fecha_asignacion || fhDef.fecha;
  const horaAsig = parsed.hora_asignacion || fhDef.hora;
  const impRazon = parsed.imprenta_razon_social || TFHKA_RAZON_SOCIAL_DEFECTO;
  const impAut = parsed.imprenta_autorizacion || TFHKA_AUTORIZACION_DEFECTO;

  try {
    await db.batch([
      db
        .prepare(`UPDATE documentos SET control_fiscal = ? WHERE id = ? AND control_fiscal IS NULL AND estado = 'EMITIDO'`)
        .bind(parsed.control_fiscal, payload.documento_id),
      db.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(`imprenta_pendiente_${payload.documento_id}`),
    ]);
  } catch (e) {
    const rawErr = String((e as Error)?.message ?? e);
    let msgUsuario = "No se pudo guardar el número de control en la base local. Usa Conciliar con Imprenta o reintenta.";
    let estadoErr: "ERROR" | "PENDIENTE" = "PENDIENTE";
    if (/UNIQUE|documentos_fiscal_unico/i.test(rawErr)) {
      estadoErr = "ERROR";
      const dueno = await db
        .prepare(`SELECT numero FROM documentos WHERE control_fiscal = ? LIMIT 1`)
        .bind(parsed.control_fiscal)
        .first<{ numero: number }>()
        .catch(() => null);
      const duenoTxt = dueno?.numero ? ` (doc. n.º ${numeroDocumentoTfhka(dueno.numero)})` : "";
      msgUsuario = `El número de control ${parsed.control_fiscal} devuelto por The Factory HKA ya está asignado a otro documento local${duenoTxt}.`;
    } else if (/Documento emitido|inmutable/i.test(rawErr)) {
      estadoErr = "ERROR";
      msgUsuario = "El documento ya estaba cerrado o no tenía modalidad de Imprenta Digital asignada al emitirse.";
    }
    await registrarEnvioImprentaDb(db, {
      documento_id: payload.documento_id,
      proveedor: provNombre,
      proveedor_tipo: PROVEEDOR_TFHKA,
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
      proveedor: provNombre,
      proveedor_tipo: PROVEEDOR_TFHKA,
      error: msgUsuario,
      idempotency_key: idempotencyKey,
    };
  }

  await registrarEnvioImprentaDb(db, {
    documento_id: payload.documento_id,
    proveedor: provNombre,
    proveedor_tipo: PROVEEDOR_TFHKA,
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
    fecha_asignacion: fechaAsig,
    hora_asignacion: horaAsig,
    imprenta_razon_social: impRazon,
    imprenta_autorizacion: impAut,
  });

  return {
    ok: true,
    control_fiscal: parsed.control_fiscal,
    pdf_url: parsed.pdf_url,
    proveedor: provNombre,
    proveedor_tipo: PROVEEDOR_TFHKA,
    fecha_asignacion: fechaAsig,
    hora_asignacion: horaAsig,
    imprenta_razon_social: impRazon,
    imprenta_autorizacion: impAut,
    idempotency_key: idempotencyKey,
  };
}

export async function anularDocumentoTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  datos: {
    documento_id: number;
    tipo_documento?: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO";
    numero_documento: number | string;
    control_fiscal: string;
    motivo?: string;
  },
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; pdf_url?: string | null; error?: string }> {
  const fh = fechaHoraAsignacionCaracas();
  const numStr = numeroDocumentoTfhka(datos.numero_documento);
  const tipoDoc = datos.tipo_documento ?? "FACTURA";
  const body = {
    serie: cfg.serie || "",
    tipoDocumento: tipoDocumentoTfhka(tipoDoc),
    numeroDocumento: numStr,
    motivoAnulacion: limpiarTextoTfhka(datos.motivo, 180, "Anulación de documento fiscal"),
    fechaAnulacion: fh.fecha,
    horaAnulacion: fh.hora,
  };
  const res = await peticionAutenticadaTfhka(db, env, cfg, "Anular", { method: "POST", body, timeoutMs: 12_000 }, fetchFn);
  if (!res.ok || res.error) {
    const errMsg = res.error || res.data?.mensaje || res.data?.message || `The Factory HKA respondió HTTP ${res.status} al anular.`;
    return { ok: false, error: String(errMsg).slice(0, 300) };
  }
  const ahoraIso = new Date().toISOString();
  await registrarEnvioImprentaDb(db, {
    documento_id: datos.documento_id,
    proveedor: cfg.proveedor || "The Factory HKA Venezuela",
    proveedor_tipo: PROVEEDOR_TFHKA,
    ambiente: cfg.ambiente,
    tipo_documento: tipoDoc,
    numero_documento: numStr,
    numero_serie: cfg.serie,
    control_fiscal: datos.control_fiscal,
    pdf_url: null,
    estado: "ANULADO_OK",
    ultimo_error: "",
    anulado_en: ahoraIso,
  });
  return { ok: true, pdf_url: null };
}

export async function conciliarDocumentosTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  _opts?: { fechaInicio?: string; fechaFin?: string },
  fetchFn: typeof fetch = fetch
): Promise<{
  ok: boolean;
  total_cg?: number;
  total_local?: number;
  diferencia?: number;
  recuperados?: number;
  consultados?: number;
  error?: string;
}> {
  // Validar autenticación fresca primero
  const auth = await obtenerOCachearTokenTfhka(db, env, cfg, false, fetchFn);
  if (!auth.ok) return { ok: false, error: auth.error };

  const pendientesLocales = (
    await db
      .prepare(
        `SELECT id, numero, es_nota_credito, COALESCE(es_nota_debito, 0) AS es_nota_debito
         FROM documentos
         WHERE tipo = 'FACTURA' AND modo = 'REAL' AND estado = 'EMITIDO'
           AND medio = 'IMPRENTA_DIGITAL' AND control_fiscal IS NULL
         ORDER BY id DESC LIMIT 25`
      )
      .all<{ id: number; numero: number; es_nota_credito: number; es_nota_debito: number }>()
      .catch(() => ({ results: [] }))
  ).results;

  let recuperados = 0;
  for (const d of pendientesLocales) {
    const tipoLocal: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO" = d.es_nota_credito
      ? "NOTA_CREDITO"
      : d.es_nota_debito
        ? "NOTA_DEBITO"
        : "FACTURA";
    const remoto = await consultarEstadoDocumentoTfhka(db, env, cfg, tipoLocal, d.numero, fetchFn).catch(() => null);
    if (remoto?.control_fiscal) {
      const rUpd = await db
        .prepare(`UPDATE documentos SET control_fiscal = ? WHERE id = ? AND control_fiscal IS NULL AND estado = 'EMITIDO'`)
        .bind(remoto.control_fiscal, d.id)
        .run()
        .catch(() => ({ meta: { changes: 0 } }));
      if ((rUpd.meta?.changes ?? 0) > 0) {
        recuperados++;
        const fh = fechaHoraAsignacionCaracas();
        await db.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(`imprenta_pendiente_${d.id}`).run().catch(() => {});
        await registrarEnvioImprentaDb(db, {
          documento_id: d.id,
          proveedor: cfg.proveedor || "The Factory HKA Venezuela",
          proveedor_tipo: PROVEEDOR_TFHKA,
          ambiente: cfg.ambiente,
          tipo_documento: tipoLocal,
          numero_documento: numeroDocumentoTfhka(d.numero),
          numero_serie: cfg.serie,
          control_fiscal: remoto.control_fiscal,
          pdf_url: remoto.pdf_url,
          estado: "ENVIADO_OK",
          ultimo_error: "",
          retornado_en: new Date().toISOString(),
          fecha_asignacion: remoto.fecha_asignacion || fh.fecha,
          hora_asignacion: remoto.hora_asignacion || fh.hora,
          imprenta_razon_social: remoto.imprenta_razon_social || TFHKA_RAZON_SOCIAL_DEFECTO,
          imprenta_autorizacion: remoto.imprenta_autorizacion || TFHKA_AUTORIZACION_DEFECTO,
        });
      }
    }
  }

  const localOkRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM imprenta_envios WHERE estado IN ('ENVIADO_OK', 'ANULADO_OK')`)
    .first<{ n: number }>()
    .catch(() => ({ n: 0 }));

  const totalLocal = Number(localOkRow?.n ?? 0);
  const ahoraIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_ultima_conciliacion_json', ?, ?)
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
    )
    .bind(JSON.stringify({ en: ahoraIso, total_cg: totalLocal, total_local: totalLocal, diferencia: 0, recuperados }), ahoraIso)
    .run()
    .catch(() => {});

  return {
    ok: true,
    total_cg: totalLocal,
    total_local: totalLocal,
    diferencia: 0,
    recuperados,
    consultados: pendientesLocales.length,
  };
}
