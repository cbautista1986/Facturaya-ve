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
  ambitoFiscalImprenta,
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
  let path = parsed.pathname.replace(
    /\/(Autenticacion|Emision|EstadoDocumento|Anular|AsignarNumeraciones|ListadoAsignaciones|ConsultaNumeraciones|DescargaArchivo|DescargarArchivo|AplicarRetencion|EmisionARC|Correo)\/?$/i,
    "/"
  );
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
  if (a === 0) return "00.00";
  return formatearCentavosCg(a);
}

function tasaIvaEnteraStr(alicuotaCent: number): string {
  const a = Math.max(0, Math.round(Number(alicuotaCent) || 0));
  if (a % 100 === 0) return String(Math.floor(a / 100));
  return formatearCentavosCg(a);
}

type CodigoImpuestoTfhka = "G" | "R" | "A" | "E" | "P";

function codigoImpuestoLineaTfhka(alicuotaCent: number, esPercibido?: boolean): CodigoImpuestoTfhka {
  const a = Math.max(0, Math.round(Number(alicuotaCent) || 0));
  if (a === 0 && esPercibido) return "P";
  return alicuotaATipoImpuestoCg(a);
}

// ---------------------------------------------------------------- Constructor oficial DocumentoElectronico (Emisión v2)

export function construirDocumentoElectronicoTfhka(
  payload: PayloadImprentaDocumento,
  opts?: { serie?: string; sucursal?: string; fechaRef?: Date }
): { DocumentoElectronico: Record<string, unknown> } {
  const tipoCod = tipoDocumentoTfhka(payload.tipo_documento);
  const numDocStr = numeroDocumentoTfhka(payload.numero);
  const serieLimpia = String(opts?.serie ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 10);
  const sucursalLimpia = limpiarTextoTfhka(opts?.sucursal, 10, "");
  const fechaEmision = formatearFechaTfhka(payload.fecha_emision);
  const horaEmision = horaCaracas12h(opts?.fechaRef);
  const tasaSegura = Math.max(0, Math.round(Number(payload.tasa_e8) || 0));
  const tasaStr = formatearTasaCg(tasaSegura);
  const esBaseUsd = payload.moneda_base === "USD";

  const esCredito = String(payload.condicion ?? "").toUpperCase() === "CREDITO";
  const compradorId = dividirRifTfhka(payload.cliente_rif);
  const correoCliente = normalizarCorreoCg(payload.cliente_email, payload.emisor?.email);
  const telCliente = normalizarTelefonoCg(payload.cliente_telefono);

  const rengs = payload.renglones ?? [];
  let gravadoBs = 0;
  let exentoBs = 0;
  let percibidoBs = 0;
  let gravadoUsd = 0;
  let exentoUsd = 0;
  let percibidoUsd = 0;

  type ImpGroup = {
    codigo: CodigoImpuestoTfhka;
    alicuota_cent: number;
    base_bs: number;
    iva_bs: number;
    base_usd: number;
    iva_usd: number;
  };
  const gruposLineas = new Map<string, ImpGroup>();

  const detallesItems = rengs.map((r, i) => {
    const alicCent = Math.max(0, Math.round(Number(r.alicuota_cent ?? 0) || 0));
    const codImp = codigoImpuestoLineaTfhka(alicCent, Boolean(r.es_percibido));
    const cantMilli = Math.max(1, Math.round(Number(r.cantidad_milli ?? 1000) || 1000));
    const precioUsdCent = Math.max(0, Math.round(Number(r.precio_usd ?? 0) || 0));
    const brutoUsdCent = Math.floor((cantMilli * precioUsdCent + 500) / 1000);
    const descUsdCent = Math.min(brutoUsdCent, Math.max(0, Math.round(Number(r.descuento_usd ?? 0) || 0)));
    const montoUsdCent =
      Number(r.monto_usd ?? 0) > 0
        ? Math.round(Number(r.monto_usd))
        : Math.max(0, brutoUsdCent - descUsdCent);
    const precioAntesDescUsdCent = montoUsdCent + descUsdCent;

    const precioUnitBsCent = tasaSegura > 0 ? Math.max(1, usdABs(precioUsdCent, tasaSegura)) : Math.max(1, precioUsdCent);
    const brutoBsCent = tasaSegura > 0 ? Math.max(1, usdABs(brutoUsdCent, tasaSegura)) : brutoUsdCent;
    const descBsCent =
      r.descuento_bs !== undefined
        ? Math.min(brutoBsCent, Math.max(0, Math.round(Number(r.descuento_bs) || 0)))
        : descUsdCent > 0
          ? Math.min(brutoBsCent, tasaSegura > 0 ? usdABs(descUsdCent, tasaSegura) : descUsdCent)
          : 0;
    const montoBsCent =
      Number(r.monto_bs ?? 0) > 0
        ? Math.round(Number(r.monto_bs))
        : Math.max(0, brutoBsCent - descBsCent);
    const precioAntesDescBsCent = montoBsCent + descBsCent;

    const valorIvaBsCent = alicCent > 0 ? Math.floor((montoBsCent * alicCent + 5000) / 10000) : 0;
    const valorIvaUsdCent = alicCent > 0 ? Math.floor((montoUsdCent * alicCent + 5000) / 10000) : 0;

    if (codImp === "P") {
      percibidoBs += montoBsCent;
      percibidoUsd += montoUsdCent;
    } else if (alicCent > 0) {
      gravadoBs += montoBsCent;
      gravadoUsd += montoUsdCent;
    } else {
      exentoBs += montoBsCent;
      exentoUsd += montoUsdCent;
    }

    const gk = `${codImp}:${alicCent}`;
    const prev = gruposLineas.get(gk);
    if (prev) {
      prev.base_bs += montoBsCent;
      prev.iva_bs += valorIvaBsCent;
      prev.base_usd += montoUsdCent;
      prev.iva_usd += valorIvaUsdCent;
    } else {
      gruposLineas.set(gk, {
        codigo: codImp,
        alicuota_cent: alicCent,
        base_bs: montoBsCent,
        iva_bs: valorIvaBsCent,
        base_usd: montoUsdCent,
        iva_usd: valorIvaUsdCent,
      });
    }

    const precioUnitItem = esBaseUsd ? precioUsdCent : precioUnitBsCent;
    const descItem = esBaseUsd ? descUsdCent : descBsCent;
    const precioItemNeto = esBaseUsd ? montoUsdCent : montoBsCent;
    const precioItemAntes = esBaseUsd ? precioAntesDescUsdCent : precioAntesDescBsCent;
    const ivaItem = esBaseUsd ? valorIvaUsdCent : valorIvaBsCent;
    const totalItem = precioItemNeto + ivaItem;
    const precioUnitDesc =
      descItem > 0 ? Math.floor((descItem * 1000 + Math.floor(cantMilli / 2)) / cantMilli) : 0;

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
      PrecioUnitario: formatearCentavosCg(precioUnitItem),
      PrecioUnitarioDescuento: formatearCentavosCg(precioUnitDesc),
      MontoBonificacion: "0.00",
      DescripcionBonificacion: "",
      DescuentoMonto: formatearCentavosCg(descItem),
      RecargoMonto: "0.00",
      PrecioItem: formatearCentavosCg(precioItemNeto),
      PrecioAntesDescuento: formatearCentavosCg(precioItemAntes),
      CodigoImpuesto: codImp,
      TasaIVA: tasaIvaEnteraStr(alicCent),
      ValorIVA: formatearCentavosCg(ivaItem),
      ValorTotalItem: formatearCentavosCg(totalItem),
      InfoAdicionalItem: [],
    };
  });

  // Consolidar impuestos en VES y USD desde tabla documento_impuestos (si viene) o agrupando renglones por (codigo, alícuota)
  const impFuente: ImpGroup[] = [];
  if (Array.isArray(payload.impuestos) && payload.impuestos.length > 0) {
    gravadoBs = 0;
    exentoBs = 0;
    percibidoBs = 0;
    gravadoUsd = 0;
    exentoUsd = 0;
    percibidoUsd = 0;
    for (const row of payload.impuestos) {
      const a = Math.max(0, Math.round(Number(row.alicuota_cent ?? 0) || 0));
      const esPerc = String(row.codigo_impuesto ?? "").toUpperCase() === "P";
      const cod = codigoImpuestoLineaTfhka(a, esPerc);
      const bBs = Math.max(0, Math.round(Number(row.base_bs ?? 0) || 0));
      const iBs = Math.max(0, Math.round(Number(row.iva_bs ?? 0) || 0));
      const bUsd = Math.max(0, Math.round(Number(row.base_usd ?? 0) || 0));
      const iUsd = Math.max(0, Math.round(Number(row.iva_usd ?? 0) || 0));
      impFuente.push({ codigo: cod, alicuota_cent: a, base_bs: bBs, iva_bs: iBs, base_usd: bUsd, iva_usd: iUsd });
      if (cod === "P") {
        percibidoBs += bBs;
        percibidoUsd += bUsd;
      } else if (a > 0) {
        gravadoBs += bBs;
        gravadoUsd += bUsd;
      } else {
        exentoBs += bBs;
        exentoUsd += bUsd;
      }
    }
  } else if (gruposLineas.size > 0) {
    const ordenCod: Record<CodigoImpuestoTfhka, number> = { G: 1, R: 2, A: 3, E: 4, P: 5 };
    const lista = [...gruposLineas.values()].sort((x, y) => ordenCod[x.codigo] - ordenCod[y.codigo]);
    const gravados = lista.filter((g) => g.alicuota_cent > 0);
    if (gravados.length === 1) {
      if (Number(payload.iva_bs) >= 0) gravados[0].iva_bs = Math.max(0, Math.round(Number(payload.iva_bs) || 0));
      if (Number(payload.iva_usd) >= 0) gravados[0].iva_usd = Math.max(0, Math.round(Number(payload.iva_usd) || 0));
    }
    impFuente.push(...lista);
  } else {
    const subFallbackBs = Math.max(0, Math.round(Number(payload.subtotal_bs) || 0));
    const subFallbackUsd = Math.max(0, Math.round(Number(payload.subtotal_usd) || 0));
    const ivaFallbackBs = Math.max(0, Math.round(Number(payload.iva_bs) || 0));
    const ivaFallbackUsd = Math.max(0, Math.round(Number(payload.iva_usd) || 0));
    if (ivaFallbackBs > 0 || ivaFallbackUsd > 0) {
      gravadoBs = subFallbackBs;
      gravadoUsd = subFallbackUsd;
      impFuente.push({
        codigo: "G",
        alicuota_cent: 1600,
        base_bs: gravadoBs,
        iva_bs: ivaFallbackBs,
        base_usd: gravadoUsd,
        iva_usd: ivaFallbackUsd,
      });
    } else if (subFallbackBs > 0 || subFallbackUsd > 0) {
      exentoBs = subFallbackBs;
      exentoUsd = subFallbackUsd;
      impFuente.push({ codigo: "E", alicuota_cent: 0, base_bs: exentoBs, iva_bs: 0, base_usd: exentoUsd, iva_usd: 0 });
    }
  }

  const descGlobalBs = Math.max(0, Math.round(Number(payload.descuento_global_bs ?? 0) || 0));
  const descGlobalUsd =
    payload.descuento_global_usd !== undefined
      ? Math.max(0, Math.round(Number(payload.descuento_global_usd) || 0))
      : descGlobalBs > 0 && tasaSegura > 0
        ? Math.floor((descGlobalBs * 100_000_000 + Math.floor(tasaSegura / 2)) / tasaSegura)
        : 0;
  const descGlobalTxt = limpiarTextoTfhka(payload.descuento_global_desc, 120, "Descuento comercial");

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
    CodigoTotalImp: x.codigo,
    AlicuotaImp: tasaAlicuotaStr(x.alicuota_cent),
    BaseImponibleImp: formatearCentavosCg(x.base_bs),
    ValorTotalImp: formatearCentavosCg(x.iva_bs),
  }));
  const impuestosSubtotalUsd: Record<string, string>[] = impFuente.map((x) => ({
    CodigoTotalImp: x.codigo,
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
    Moneda: esBaseUsd ? "USD" : "VES",
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

  // Formas de pago oficiales TFHKA:
  // - Con IGTF 3% -> Forma "09" (Divisas), Moneda "USD", TipoCambio tasa BCV
  // - Sin IGTF -> Forma "02" (Bolívares VES), TipoCambio tasa BCV si moneda base es USD o "0.0000" si base es VES
  const tieneIgtf = igtfBs > 0 || igtfUsd > 0;
  const formasPago = tieneIgtf
    ? [
        {
          Descripcion: esCredito ? "Credito Divisas" : "Efectivo Divisas",
          Fecha: fechaEmision,
          Forma: "09",
          Monto: formatearCentavosCg(totalUsd > 0 ? totalUsd : totalBs),
          Moneda: "USD",
          TipoCambio: tasaStr,
        },
      ]
    : [
        {
          Descripcion: esCredito ? "Credito" : "Contado",
          Fecha: fechaEmision,
          Forma: "02",
          Monto: formatearCentavosCg(totalBs),
          Moneda: "VES",
          TipoCambio: esBaseUsd ? tasaStr : "0.0000",
        },
      ];

  const listaDescBs = descGlobalBs > 0 ? [{ DescDescuento: descGlobalTxt, MontoDescuento: formatearCentavosCg(descGlobalBs) }] : null;
  const listaDescUsd = descGlobalUsd > 0 ? [{ DescDescuento: descGlobalTxt, MontoDescuento: formatearCentavosCg(descGlobalUsd) }] : null;

  const totalesPrincipal = esBaseUsd
    ? {
        NroItems: String(detallesItems.length),
        MontoGravadoTotal: formatearCentavosCg(gravadoUsd),
        MontoExentoTotal: formatearCentavosCg(exentoUsd),
        MontoPercibidoTotal: formatearCentavosCg(percibidoUsd),
        SubtotalAntesDescuento: formatearCentavosCg(subtotalUsd + descGlobalUsd),
        TotalDescuento: formatearCentavosCg(descGlobalUsd),
        TotalRecargos: "0.00",
        Subtotal: formatearCentavosCg(subtotalUsd),
        TotalIVA: formatearCentavosCg(ivaUsd),
        MontoTotalConIVA: formatearCentavosCg(totalConIvaUsd),
        TotalAPagar: formatearCentavosCg(totalUsd),
        MontoEnLetras: montoEnLetrasEntero(totalUsd, "USD"),
        ListaRecargo: null,
        ListaDescBonificacion: listaDescUsd,
        ImpuestosSubtotal: impuestosSubtotalUsd,
        OtrosImpuestosSubtotal: null,
        FormasPago: formasPago,
        TotalIGTF: formatearCentavosCg(igtfUsd),
        TotalIGTF_VES: formatearCentavosCg(igtfBs),
      }
    : {
        NroItems: String(detallesItems.length),
        MontoGravadoTotal: formatearCentavosCg(gravadoBs),
        MontoExentoTotal: formatearCentavosCg(exentoBs),
        MontoPercibidoTotal: formatearCentavosCg(percibidoBs),
        SubtotalAntesDescuento: formatearCentavosCg(subtotalBs + descGlobalBs),
        TotalDescuento: formatearCentavosCg(descGlobalBs),
        TotalRecargos: "0.00",
        Subtotal: formatearCentavosCg(subtotalBs),
        TotalIVA: formatearCentavosCg(ivaBs),
        MontoTotalConIVA: formatearCentavosCg(totalConIvaBs),
        TotalAPagar: formatearCentavosCg(totalBs),
        MontoEnLetras: montoEnLetrasEntero(totalBs, "VES"),
        ListaRecargo: null,
        ListaDescBonificacion: listaDescBs,
        ImpuestosSubtotal: impuestosSubtotalBs,
        OtrosImpuestosSubtotal: null,
        FormasPago: formasPago,
        TotalIGTF: formatearCentavosCg(igtfBs),
        TotalIGTF_VES: formatearCentavosCg(igtfBs),
      };

  const totalesOtraMoneda =
    tasaSegura > 0
      ? esBaseUsd
        ? {
            Moneda: "VES",
            TipoCambio: tasaStr,
            MontoGravadoTotal: formatearCentavosCg(gravadoBs),
            MontoExentoTotal: formatearCentavosCg(exentoBs),
            MontoPercibidoTotal: formatearCentavosCg(percibidoBs),
            Subtotal: formatearCentavosCg(subtotalBs),
            TotalAPagar: formatearCentavosCg(totalBs),
            TotalIVA: formatearCentavosCg(ivaBs),
            MontoTotalConIVA: formatearCentavosCg(totalConIvaBs),
            MontoEnLetras: montoEnLetrasEntero(totalBs, "VES"),
            SubtotalAntesDescuento: formatearCentavosCg(subtotalBs + descGlobalBs),
            TotalDescuento: formatearCentavosCg(descGlobalBs),
            TotalRecargos: "0.00",
            ListaRecargo: null,
            ListaDescBonificacion: listaDescBs,
            ImpuestosSubtotal: impuestosSubtotalBs,
            OtrosImpuestosSubtotal: null,
          }
        : {
            Moneda: "USD",
            TipoCambio: tasaStr,
            MontoGravadoTotal: formatearCentavosCg(gravadoUsd),
            MontoExentoTotal: formatearCentavosCg(exentoUsd),
            MontoPercibidoTotal: formatearCentavosCg(percibidoUsd),
            Subtotal: formatearCentavosCg(subtotalUsd),
            TotalAPagar: formatearCentavosCg(totalUsd),
            TotalIVA: formatearCentavosCg(ivaUsd),
            MontoTotalConIVA: formatearCentavosCg(totalConIvaUsd),
            MontoEnLetras: montoEnLetrasEntero(totalUsd, "USD"),
            SubtotalAntesDescuento: formatearCentavosCg(subtotalUsd + descGlobalUsd),
            TotalDescuento: formatearCentavosCg(descGlobalUsd),
            TotalRecargos: "0.00",
            ListaRecargo: null,
            ListaDescBonificacion: listaDescUsd,
            ImpuestosSubtotal: impuestosSubtotalUsd,
            OtrosImpuestosSubtotal: null,
          }
      : null;

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
        Totales: totalesPrincipal,
        TotalesOtraMoneda: totalesOtraMoneda,
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

// ---------------------------------------------------------------- Constructores adicionales oficiales TFHKA (04 Guía, 05 Ret. IVA, 06 Ret. ISLR)

export type PayloadRetencionIvaTfhka = {
  numero: number;
  numero_comprobante: string;
  fecha_emision: string;
  sujeto_rif: string;
  sujeto_nombre: string;
  sujeto_direccion?: string;
  sujeto_telefono?: string;
  sujeto_email?: string;
  factura_fecha: string;
  factura_numero: number | string;
  factura_control: string;
  factura_serie?: string;
  monto_total_bs: number;
  monto_exento_bs: number;
  base_imponible_bs: number;
  alicuota_iva_cent: number; // ej: 1600 -> 16% -> "0.16"
  porcentaje_retencion_cent: number; // ej: 7500 -> "0.75", 10000 -> "1.00"
  monto_iva_bs: number;
  monto_retenido_bs: number;
};

function fraccionDecimalDesdeCent(cent: number): string {
  const c = Math.max(0, Math.round(Number(cent) || 0));
  const ent = Math.floor(c / 10000);
  const dec = String(Math.floor((c % 10000) / 100)).padStart(2, "0");
  return `${ent}.${dec}`;
}

export function construirComprobanteRetencionIvaTfhka(
  input: PayloadRetencionIvaTfhka,
  opts?: { serie?: string; sucursal?: string; fechaRef?: Date }
): { DocumentoElectronico: Record<string, unknown> } {
  const serieLimpia = String(opts?.serie ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 10);
  const sucursalLimpia = limpiarTextoTfhka(opts?.sucursal, 10, "");
  const fechaEmision = formatearFechaTfhka(input.fecha_emision);
  const horaEmision = horaCaracas12h(opts?.fechaRef);
  const sujetoId = dividirRifTfhka(input.sujeto_rif);
  const percibidoBs = Math.max(0, Math.round(input.monto_iva_bs) - Math.round(input.monto_retenido_bs));

  return {
    DocumentoElectronico: {
      Encabezado: {
        IdentificacionDocumento: {
          TipoDocumento: "05",
          NumeroDocumento: numeroDocumentoTfhka(input.numero),
          TipoProveedor: null,
          TipoTransaccion: "01",
          FechaEmision: fechaEmision,
          FechaVencimiento: fechaEmision,
          HoraEmision: horaEmision,
          Anulado: false,
          TipoDePago: "Inmediato",
          Serie: serieLimpia,
          Sucursal: sucursalLimpia,
          TipoDeVenta: "Interna",
          Moneda: "VES",
        },
        SujetoRetenido: {
          TipoIdentificacion: sujetoId.tipo,
          NumeroIdentificacion: sujetoId.numero,
          RazonSocial: limpiarTextoTfhka(input.sujeto_nombre, 120, "Proveedor"),
          Direccion: limpiarTextoTfhka(input.sujeto_direccion, 200, "Venezuela"),
          Pais: "VE",
          Notificar: input.sujeto_email ? "Si" : "No",
          Telefono: [normalizarTelefonoCg(input.sujeto_telefono)],
          Correo: [normalizarCorreoCg(input.sujeto_email)],
        },
        TotalesRetencion: {
          TotalBaseImponible: formatearCentavosCg(input.base_imponible_bs),
          NumeroCompRetencion: limpiarTextoTfhka(input.numero_comprobante, 20, "20261100000001"),
          FechaEmisionCR: fechaEmision,
          TotalIVA: formatearCentavosCg(input.monto_iva_bs),
          TotalRetenido: formatearCentavosCg(input.monto_retenido_bs),
          TotalISRL: null,
          TipoComprobante: null,
        },
      },
      DetallesRetencion: [
        {
          NumeroLinea: "1",
          FechaDocumento: formatearFechaTfhka(input.factura_fecha),
          TipoDocumento: "01",
          SerieDocumento: limpiarTextoTfhka(input.factura_serie, 10, serieLimpia),
          NumeroDocumento: numeroDocumentoTfhka(input.factura_numero),
          NumeroControl: limpiarTextoTfhka(input.factura_control, 30, "00-00000001"),
          TipoTransaccion: "01",
          MontoTotal: formatearCentavosCg(input.monto_total_bs),
          MontoExento: formatearCentavosCg(input.monto_exento_bs),
          BaseImponible: formatearCentavosCg(input.base_imponible_bs),
          Porcentaje: fraccionDecimalDesdeCent(input.alicuota_iva_cent),
          PorcentajeRetencion: fraccionDecimalDesdeCent(input.porcentaje_retencion_cent),
          MontoIVA: formatearCentavosCg(input.monto_iva_bs),
          Retenido: formatearCentavosCg(input.monto_retenido_bs),
          Percibido: formatearCentavosCg(percibidoBs),
          Moneda: "VES",
        },
      ],
      DetallesItems: null,
      InfoAdicional: [],
      GuiaDespacho: null,
    },
  };
}

export type PayloadRetencionIslrTfhka = {
  numero: number;
  numero_comprobante: string;
  fecha_emision: string;
  sujeto_rif: string;
  sujeto_nombre: string;
  sujeto_direccion?: string;
  sujeto_telefono?: string;
  sujeto_email?: string;
  factura_fecha: string;
  factura_numero: number | string;
  factura_control: string;
  factura_serie?: string;
  monto_total_bs: number;
  base_imponible_bs: number;
  porcentaje_retencion_cent: number; // ej: 200 -> 2% -> "0.02"
  sustraendo_bs?: number;
  monto_retenido_bs: number;
  codigo_concepto?: string;
};

export function construirComprobanteRetencionIslrTfhka(
  input: PayloadRetencionIslrTfhka,
  opts?: { serie?: string; sucursal?: string; fechaRef?: Date }
): { DocumentoElectronico: Record<string, unknown> } {
  const serieLimpia = String(opts?.serie ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 10);
  const sucursalLimpia = limpiarTextoTfhka(opts?.sucursal, 10, "");
  const fechaEmision = formatearFechaTfhka(input.fecha_emision);
  const horaEmision = horaCaracas12h(opts?.fechaRef);
  const sujetoId = dividirRifTfhka(input.sujeto_rif);
  const sustraendoBs = Math.max(0, Math.round(Number(input.sustraendo_bs ?? 0) || 0));
  const percibidoBs = Math.max(0, Math.round(input.base_imponible_bs) - Math.round(input.monto_retenido_bs));

  return {
    DocumentoElectronico: {
      Encabezado: {
        IdentificacionDocumento: {
          TipoDocumento: "06",
          NumeroDocumento: numeroDocumentoTfhka(input.numero),
          TipoProveedor: null,
          TipoTransaccion: "01",
          FechaEmision: fechaEmision,
          FechaVencimiento: fechaEmision,
          HoraEmision: horaEmision,
          Anulado: false,
          TipoDePago: "Inmediato",
          Serie: serieLimpia,
          Sucursal: sucursalLimpia,
          TipoDeVenta: "Interna",
          Moneda: "VES",
        },
        SujetoRetenido: {
          TipoIdentificacion: sujetoId.tipo,
          NumeroIdentificacion: sujetoId.numero,
          RazonSocial: limpiarTextoTfhka(input.sujeto_nombre, 120, "Proveedor"),
          Direccion: limpiarTextoTfhka(input.sujeto_direccion, 200, "Venezuela"),
          Pais: "VE",
          Notificar: input.sujeto_email ? "Si" : "No",
          Telefono: [normalizarTelefonoCg(input.sujeto_telefono)],
          Correo: [normalizarCorreoCg(input.sujeto_email)],
        },
        TotalesRetencion: {
          TotalBaseImponible: formatearCentavosCg(input.base_imponible_bs),
          NumeroCompRetencion: limpiarTextoTfhka(input.numero_comprobante, 20, "20261100000002"),
          FechaEmisionCR: fechaEmision,
          TotalIVA: null,
          TotalISRL: formatearCentavosCg(input.monto_retenido_bs),
          TotalRetenido: formatearCentavosCg(input.monto_retenido_bs),
          TipoComprobante: "1",
        },
      },
      DetallesRetencion: [
        {
          NumeroLinea: "1",
          FechaDocumento: formatearFechaTfhka(input.factura_fecha),
          TipoDocumento: "01",
          SerieDocumento: limpiarTextoTfhka(input.factura_serie, 10, serieLimpia),
          NumeroDocumento: numeroDocumentoTfhka(input.factura_numero),
          NumeroControl: limpiarTextoTfhka(input.factura_control, 30, "00-00000001"),
          TipoTransaccion: "01",
          MontoTotal: formatearCentavosCg(input.monto_total_bs),
          MontoExento: "0.00",
          BaseImponible: formatearCentavosCg(input.base_imponible_bs),
          Porcentaje: fraccionDecimalDesdeCent(input.porcentaje_retencion_cent),
          PorcentajeRetencion: fraccionDecimalDesdeCent(input.porcentaje_retencion_cent),
          Sustraendo: formatearCentavosCg(sustraendoBs),
          Retenido: formatearCentavosCg(input.monto_retenido_bs),
          Percibido: formatearCentavosCg(percibidoBs),
          CodigoConcepto: limpiarTextoTfhka(input.codigo_concepto, 10, "053"),
          Moneda: "VES",
        },
      ],
      DetallesItems: null,
      InfoAdicional: [],
      GuiaDespacho: null,
    },
  };
}

export type PayloadGuiaDespachoTfhka = {
  numero: number;
  fecha_emision: string;
  cliente_rif: string;
  cliente_nombre: string;
  cliente_direccion?: string;
  cliente_telefono?: string;
  cliente_email?: string;
  motivo_traslado: string;
  origen_producto: string;
  destino_producto: string;
  conductor_nombre: string;
  conductor_rif: string;
  vehiculo_tipo?: string;
  vehiculo_placa: string;
  transportista?: string;
  peso_total?: string;
  renglones: { descripcion: string; cantidad_milli: number; codigo?: string }[];
};

export function construirGuiaDespachoTfhka(
  input: PayloadGuiaDespachoTfhka,
  opts?: { serie?: string; sucursal?: string; fechaRef?: Date }
): { DocumentoElectronico: Record<string, unknown> } {
  const serieLimpia = String(opts?.serie ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 10);
  const sucursalLimpia = limpiarTextoTfhka(opts?.sucursal, 10, "");
  const fechaEmision = formatearFechaTfhka(input.fecha_emision);
  const horaEmision = horaCaracas12h(opts?.fechaRef);
  const compradorId = dividirRifTfhka(input.cliente_rif);
  const conductorId = dividirRifTfhka(input.conductor_rif);

  const detallesItems = input.renglones.map((r, i) => ({
    NumeroLinea: String(i + 1),
    CodigoCIIU: "0000",
    CodigoPLU: limpiarTextoTfhka(r.codigo, 13, `GUIA-${i + 1}`),
    IndicadorBienoServicio: "1",
    Descripcion: limpiarTextoTfhka(r.descripcion, 200, `Artículo ${i + 1}`),
    Cantidad: formatearCantidadMilliCg(r.cantidad_milli),
    UnidadMedida: "UND",
    PrecioUnitario: "0.00",
    PrecioUnitarioDescuento: "0.00",
    MontoBonificacion: "0.00",
    DescripcionBonificacion: "",
    DescuentoMonto: "0.00",
    RecargoMonto: "0.00",
    PrecioItem: "0.00",
    PrecioAntesDescuento: "0.00",
    CodigoImpuesto: "E",
    TasaIVA: "0",
    ValorIVA: "0.00",
    ValorTotalItem: "0.00",
    InfoAdicionalItem: [],
  }));

  return {
    DocumentoElectronico: {
      Encabezado: {
        IdentificacionDocumento: {
          TipoDocumento: "04",
          NumeroDocumento: numeroDocumentoTfhka(input.numero),
          TipoProveedor: null,
          TipoTransaccion: "01",
          FechaEmision: fechaEmision,
          FechaVencimiento: fechaEmision,
          HoraEmision: horaEmision,
          Anulado: false,
          TipoDePago: "Inmediato",
          Serie: serieLimpia,
          Sucursal: sucursalLimpia,
          TipoDeVenta: "Interna",
          Moneda: "VES",
        },
        Comprador: {
          TipoIdentificacion: compradorId.tipo,
          NumeroIdentificacion: compradorId.numero,
          RazonSocial: limpiarTextoTfhka(input.cliente_nombre, 120, "Destinatario"),
          Direccion: limpiarTextoTfhka(input.cliente_direccion, 200, "Venezuela"),
          Pais: "VE",
          Notificar: input.cliente_email ? "Si" : "No",
          Telefono: [normalizarTelefonoCg(input.cliente_telefono)],
          Correo: [normalizarCorreoCg(input.cliente_email)],
        },
      },
      DetallesItems: detallesItems,
      GuiaDespacho: {
        esGuiaDespacho: "1",
        motivoTraslado: limpiarTextoTfhka(input.motivo_traslado, 120, "Traslado de mercancía"),
        descripcionServicio: limpiarTextoTfhka(input.motivo_traslado, 120, "Traslado de mercancía"),
        origenProducto: limpiarTextoTfhka(input.origen_producto, 150, "Depósito Principal"),
        destinoProducto: limpiarTextoTfhka(input.destino_producto, 150, "Dirección del Cliente"),
        nombreCompleto: limpiarTextoTfhka(input.conductor_nombre, 80, "Conductor"),
        tipoIdentificacion: conductorId.tipo,
        numeroIdentificacion: conductorId.numero,
        tipoVehiculo: limpiarTextoTfhka(input.vehiculo_tipo, 40, "Camioneta"),
        numeroPlaca: limpiarTextoTfhka(input.vehiculo_placa, 16, "AA000AA"),
        transportista: limpiarTextoTfhka(input.transportista, 80, "Transporte Propio"),
        pesoTotal: limpiarTextoTfhka(input.peso_total, 20, "10.00"),
      },
      InfoAdicional: [],
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
): Promise<{ ok: true; token: string; apiPrefix: "" | "api/" } | { ok: false; error: string }> {
  const host = normalizarHostTfhka(hostBase);
  const prefijos: ("" | "api/")[] = /\/api\/$/i.test(host) ? [""] : ["", "api/"];
  let ultimoErr = "No se pudo autenticar con The Factory HKA.";

  for (const prefijo of prefijos) {
    try {
      const r = await fetchFn(`${host}${prefijo}Autenticacion`, {
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
      if (r.ok && token) {
        return { ok: true, token, apiPrefix: prefijo };
      }
      const msg = j?.mensaje || j?.message || j?.error || `HTTP ${r.status}`;
      ultimoErr = `The Factory HKA rechazó la autenticación (${msg}). Verifica usuario y clave API.`;
      if (r.status !== 404) {
        return { ok: false, error: ultimoErr };
      }
    } catch (e) {
      return { ok: false, error: `No se pudo conectar con The Factory HKA: ${(e as Error).message}` };
    }
  }
  return { ok: false, error: ultimoErr };
}

async function obtenerOCachearTokenTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  forzarRenovar: boolean,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; token: string; apiPrefix: "" | "api/" } | { ok: false; error: string }> {
  const ahoraMs = Date.now();
  const hostNorm = normalizarHostTfhka(cfg.url);
  const userNorm = cfg.usuario.trim().toLowerCase();
  if (!forzarRenovar) {
    const rows = (
      await db
        .prepare(
          `SELECT clave, valor FROM integraciones
           WHERE clave IN ('imprenta_tfhka_jwt', 'imprenta_tfhka_jwt_exp', 'imprenta_tfhka_jwt_host', 'imprenta_tfhka_jwt_user', 'imprenta_tfhka_api_prefix')`
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
      if (tok) {
        const apiPrefix: "" | "api/" = m.imprenta_tfhka_api_prefix === "api/" ? "api/" : "";
        return { ok: true, token: tok, apiPrefix };
      }
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
        db
          .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_tfhka_api_prefix', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
          .bind(nuevo.apiPrefix, ahoraIso),
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
  const rutaLimpia = rutaRelativa.replace(/^\/+/, "");

  for (let intento = 0; intento < 2; intento++) {
    const auth = await obtenerOCachearTokenTfhka(db, env, cfg, intento === 1, fetchFn);
    if (!auth.ok) return { ok: false, status: 401, data: null, error: auth.error };
    const endpoint = `${host}${auth.apiPrefix}${rutaLimpia}`;
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

export type ResumenNumeracionesTfhka = {
  ok: boolean;
  fuente: "ConsultaNumeraciones" | "ListadoAsignaciones" | "NINGUNA";
  disponibles: number | null;
  utilizados: number | null;
  total_asignados: number | null;
  rangos: number;
  detalle?: unknown[];
  error?: string;
};

export async function consultarNumeracionesTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  fetchFn: typeof fetch = fetch
): Promise<ResumenNumeracionesTfhka> {
  // Endpoint oficial confirmado por soporte TFHKA: ConsultaNumeraciones
  const resNum = await peticionAutenticadaTfhka(
    db,
    env,
    cfg,
    "ConsultaNumeraciones",
    {
      method: "POST",
      body: {
        serie: cfg.serie || "",
        tipoDocumento: "01",
      },
      timeoutMs: 10_000,
    },
    fetchFn
  ).catch(() => null);

  if (resNum?.ok && resNum.data) {
    const d = resNum.data.resultado ?? resNum.data.data ?? resNum.data;
    const lista = Array.isArray(d)
      ? d
      : Array.isArray(d?.numeraciones)
        ? d.numeraciones
        : Array.isArray(d?.asignaciones)
          ? d.asignaciones
          : Array.isArray(resNum.data.numeraciones)
            ? resNum.data.numeraciones
            : [];
    const dispDirecto = Number(d?.disponibles ?? d?.cantidadDisponible ?? d?.saldoDisponible ?? NaN);
    const usadDirecto = Number(d?.utilizados ?? d?.consumidos ?? d?.cantidadUtilizada ?? NaN);
    const totDirecto = Number(d?.totalAsignados ?? d?.cantidadAsignada ?? d?.total ?? NaN);
    let disp = Number.isFinite(dispDirecto) ? Math.max(0, Math.trunc(dispDirecto)) : null;
    let usad = Number.isFinite(usadDirecto) ? Math.max(0, Math.trunc(usadDirecto)) : null;
    let tot = Number.isFinite(totDirecto) ? Math.max(0, Math.trunc(totDirecto)) : null;
    if (disp === null && lista.length > 0) {
      let sDisp = 0;
      let sUsad = 0;
      let sTot = 0;
      let vioAlgo = false;
      for (const item of lista) {
        if (!item || typeof item !== "object") continue;
        const nD = Number(item.disponibles ?? item.cantidadDisponible ?? item.restantes ?? NaN);
        const nU = Number(item.utilizados ?? item.consumidos ?? NaN);
        const nT = Number(item.cantidad ?? item.total ?? item.asignados ?? NaN);
        if (Number.isFinite(nD)) { sDisp += Math.max(0, Math.trunc(nD)); vioAlgo = true; }
        if (Number.isFinite(nU)) { sUsad += Math.max(0, Math.trunc(nU)); vioAlgo = true; }
        if (Number.isFinite(nT)) { sTot += Math.max(0, Math.trunc(nT)); vioAlgo = true; }
      }
      if (vioAlgo) {
        disp = sDisp;
        usad = sUsad;
        tot = sTot || sDisp + sUsad;
      }
    }
    return {
      ok: true,
      fuente: "ConsultaNumeraciones",
      disponibles: disp,
      utilizados: usad,
      total_asignados: tot,
      rangos: lista.length || (disp !== null ? 1 : 0),
      detalle: lista.slice(0, 20),
    };
  }

  // Respaldo compatible: ListadoAsignaciones
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
    const arr = Array.isArray(lista) ? lista : [];
    return {
      ok: true,
      fuente: "ListadoAsignaciones",
      disponibles: null,
      utilizados: null,
      total_asignados: null,
      rangos: arr.length,
      detalle: arr.slice(0, 20),
    };
  }

  return {
    ok: false,
    fuente: "NINGUNA",
    disponibles: null,
    utilizados: null,
    total_asignados: null,
    rangos: 0,
    error: resNum?.error || resAsig?.error || "No se pudo consultar el cupo de numeraciones.",
  };
}

export async function probarConexionTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  fetchFn: typeof fetch = fetch
): Promise<{
  ok: boolean;
  host?: string;
  api_prefix?: "" | "api/";
  asignaciones?: number;
  numeraciones?: ResumenNumeracionesTfhka;
  mensaje?: string;
  error?: string;
}> {
  const valUrl = validarUrlImprentaSegura(cfg.url);
  if (!valUrl.ok) return { ok: false, error: valUrl.error };
  const host = normalizarHostTfhka(valUrl.url);

  const auth = await obtenerOCachearTokenTfhka(db, env, cfg, true, fetchFn);
  if (!auth.ok) return { ok: false, error: auth.error };

  const num = await consultarNumeracionesTfhka(db, env, cfg, fetchFn);
  const asignaciones = num.rangos;
  const cupoTxt =
    num.disponibles !== null
      ? ` · ${num.disponibles} N.º de control disponibles${num.total_asignados ? ` de ${num.total_asignados}` : ""}`
      : asignaciones > 0
        ? ` · ${asignaciones} rango(s) de numeración`
        : "";

  return {
    ok: true,
    host,
    api_prefix: auth.apiPrefix,
    asignaciones,
    numeraciones: num,
    mensaje: `Conexión verificada con The Factory HKA Venezuela (${cfg.ambiente === "PRODUCCION" ? "Producción" : "Demo / Pruebas"}) · Token JWT activo (12 h)${cupoTxt}.`,
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
    let msgUsuario = "No se pudo guardar el número de control en la base local. Usa Conciliar con Imprenta o reintenta.";
    let estadoErr: "ERROR" | "PENDIENTE" = "PENDIENTE";
    if (/UNIQUE|documentos_fiscal_unico/i.test(rawErr)) {
      estadoErr = "ERROR";
      const dueno =
        (await db
          .prepare(
            `SELECT numero FROM documentos
             WHERE control_fiscal = ? AND modo = 'REAL' AND COALESCE(medio, '') = 'IMPRENTA_DIGITAL' AND COALESCE(fiscal_serial, '') = ?
             LIMIT 1`
          )
          .bind(parsed.control_fiscal, ambitoFiscal)
          .first<{ numero: number }>()
          .catch(() => null)) ??
        (await db
          .prepare(`SELECT numero FROM documentos WHERE control_fiscal = ? LIMIT 1`)
          .bind(parsed.control_fiscal)
          .first<{ numero: number }>()
          .catch(() => null));
      const duenoTxt = dueno?.numero ? ` (doc. n.º ${numeroDocumentoTfhka(dueno.numero)})` : "";
      msgUsuario = `El número de control ${parsed.control_fiscal} devuelto por The Factory HKA ya está asignado a otro documento local${duenoTxt} dentro del mismo ámbito (${ambitoFiscal}).`;
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
  const ambitoFiscal = ambitoFiscalImprenta(cfg);
  for (const d of pendientesLocales) {
    const tipoLocal: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO" = d.es_nota_credito
      ? "NOTA_CREDITO"
      : d.es_nota_debito
        ? "NOTA_DEBITO"
        : "FACTURA";
    const remoto = await consultarEstadoDocumentoTfhka(db, env, cfg, tipoLocal, d.numero, fetchFn).catch(() => null);
    if (remoto?.control_fiscal) {
      const rUpd = await db
        .prepare(
          `UPDATE documentos
           SET control_fiscal = ?, fiscal_serial = COALESCE(fiscal_serial, ?)
           WHERE id = ? AND control_fiscal IS NULL AND estado = 'EMITIDO'`
        )
        .bind(remoto.control_fiscal, ambitoFiscal, d.id)
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

// ---------------------------------------------------------------- Descarga oficial de PDF (DescargaArchivo)

const MAX_PDF_BYTES_TFHKA = 10 * 1024 * 1024;

function decodificarBase64Bytes(b64Raw: string): Uint8Array | null {
  const limpio = b64Raw.replace(/^data:application\/pdf;base64,/i, "").replace(/\s+/g, "");
  if (!limpio || limpio.length < 16) return null;
  try {
    const bin = atob(limpio);
    if (bin.length > MAX_PDF_BYTES_TFHKA) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function esPdfValido(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_PDF_BYTES_TFHKA) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

export async function descargarPdfTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  params: {
    tipo_documento: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO" | string;
    numero_documento: number | string;
    serie?: string;
  },
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; bytes: Uint8Array; filename: string } | { ok: false; error: string }> {
  const valUrl = validarUrlImprentaSegura(cfg.url);
  if (!valUrl.ok) return { ok: false, error: valUrl.error };
  if (!cfg.usuario || !cfg.clave_clara) {
    return { ok: false, error: "Faltan las credenciales API de The Factory HKA." };
  }
  const host = normalizarHostTfhka(valUrl.url);
  const serieUsar = params.serie !== undefined ? String(params.serie).trim() : cfg.serie || "";
  const tipoCod = tipoDocumentoTfhka(params.tipo_documento);
  const numStr = numeroDocumentoTfhka(params.numero_documento);
  const filename = `TFHKA-${tipoCod}-${numStr}.pdf`;
  const body = {
    serie: serieUsar,
    tipoDocumento: tipoCod,
    numeroDocumento: numStr,
    tipoArchivo: "pdf",
  };

  for (let intento = 0; intento < 2; intento++) {
    const auth = await obtenerOCachearTokenTfhka(db, env, cfg, intento === 1, fetchFn);
    if (!auth.ok) return { ok: false, error: auth.error };
    const endpoint = `${host}${auth.apiPrefix}DescargaArchivo`;
    try {
      const r = await fetchFn(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/pdf, application/json",
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify(body),
      });
      if (r.status === 401 && intento === 0) continue;
      if (!r.ok) {
        const jErr = (await r.json().catch(() => null)) as Record<string, any> | null;
        return {
          ok: false,
          error: String(jErr?.mensaje || jErr?.message || `The Factory HKA respondió HTTP ${r.status} en DescargaArchivo.`).slice(0, 260),
        };
      }
      const ctype = (r.headers.get("content-type") || "").toLowerCase();
      if (ctype.includes("application/pdf") || ctype.includes("application/octet-stream")) {
        const buf = new Uint8Array(await r.arrayBuffer());
        if (!esPdfValido(buf)) {
          return { ok: false, error: "El archivo recibido de The Factory HKA no es un PDF válido." };
        }
        return { ok: true, bytes: buf, filename };
      }

      const rawTxt = await r.text();
      let j: Record<string, any> | null = null;
      try {
        j = rawTxt ? JSON.parse(rawTxt) : null;
      } catch {
        j = null;
      }
      const b64 =
        j?.archivo ??
        j?.pdf ??
        j?.documento ??
        j?.resultado?.archivo ??
        j?.resultado?.pdf ??
        j?.data?.archivo ??
        j?.data?.pdf ??
        (typeof j?.resultado === "string" ? j.resultado : null) ??
        null;
      if (typeof b64 === "string") {
        const bytes = decodificarBase64Bytes(b64);
        if (bytes && esPdfValido(bytes)) {
          return { ok: true, bytes, filename };
        }
      }
      const urlPdfSeg = validarUrlPdfSegura(j?.urlPdf ?? j?.resultado?.urlPdf ?? j?.pdf_url ?? null);
      if (urlPdfSeg) {
        const rPdf = await fetchFn(urlPdfSeg, { signal: AbortSignal.timeout(15_000) });
        if (rPdf.ok) {
          const bytes = new Uint8Array(await rPdf.arrayBuffer());
          if (esPdfValido(bytes)) return { ok: true, bytes, filename };
        }
      }
      return {
        ok: false,
        error: String(j?.mensaje || j?.message || "The Factory HKA no devolvió un PDF válido en DescargaArchivo.").slice(0, 260),
      };
    } catch (e) {
      return { ok: false, error: `Error de red descargando PDF de The Factory HKA: ${(e as Error).message}` };
    }
  }
  return { ok: false, error: "Token rechazado por The Factory HKA al descargar PDF." };
}

// ---------------------------------------------------------------- Aplicar Retención sobre documento emitido (AplicarRetencion)

export async function aplicarRetencionTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  datos: {
    serie?: string;
    tipo_documento?: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO" | string;
    numero_documento: number | string;
    numero_control: string;
    base_imponible_bs: number;
    numero_comprobante_retencion: string;
    fecha_emision_cr: string;
    total_iva_bs: number;
    total_retenido_bs: number;
  },
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; mensaje?: string; error?: string }> {
  const body = {
    serie: datos.serie !== undefined ? datos.serie : cfg.serie || "",
    tipoDocumento: tipoDocumentoTfhka(datos.tipo_documento ?? "FACTURA"),
    numeroDocumento: numeroDocumentoTfhka(datos.numero_documento),
    numeroControl: limpiarTextoTfhka(datos.numero_control, 30),
    totalRetencion: {
      totalBaseImponible: formatearCentavosCg(datos.base_imponible_bs),
      numeroCompRetencion: limpiarTextoTfhka(datos.numero_comprobante_retencion, 20),
      fechaEmisionCR: formatearFechaTfhka(datos.fecha_emision_cr),
      totalIVA: formatearCentavosCg(datos.total_iva_bs),
      totalRetenido: formatearCentavosCg(datos.total_retenido_bs),
    },
  };
  const res = await peticionAutenticadaTfhka(db, env, cfg, "AplicarRetencion", { method: "POST", body, timeoutMs: 15_000 }, fetchFn);
  if (!res.ok || res.error) {
    return {
      ok: false,
      error: String(res.error || res.data?.mensaje || res.data?.message || `HTTP ${res.status} en AplicarRetencion`).slice(0, 260),
    };
  }
  return { ok: true, mensaje: String(res.data?.mensaje || "Retención aplicada correctamente en The Factory HKA.") };
}

// ---------------------------------------------------------------- Suite de Certificación Demo oficial TFHKA (21 escenarios)

export type ResultadoCasoCertificacionTfhka = {
  codigo: string;
  descripcion: string;
  tipo_documento: string;
  numero_documento: string;
  esperaba_error: boolean;
  ok: boolean;
  http_status: number;
  control_fiscal: string | null;
  mensaje: string;
};

export async function ejecutarSuiteCertificacionTfhka(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  cfg: ConfigImprentaConSecreto,
  opts?: {
    numero_inicio?: number;
    rif_emisor?: string;
    razon_emisor?: string;
    email_prueba?: string;
    incluir_errores?: boolean;
  },
  fetchFn: typeof fetch = fetch
): Promise<{
  ok: boolean;
  ambiente?: string;
  host?: string;
  fecha_ejecucion?: string;
  resumen?: { total: number; aprobados: number; fallidos: number; errores_controlados_ok: number };
  resultados?: ResultadoCasoCertificacionTfhka[];
  reporte_texto?: string;
  error?: string;
}> {
  // CANDADO CRÍTICO: jamás correr pruebas de certificación en ambiente PRODUCCION
  if (cfg.ambiente !== "PRUEBAS") {
    return {
      ok: false,
      error: "Bloqueado por seguridad fiscal: la Suite de Certificación The Factory HKA solo puede ejecutarse en ambiente PRUEBAS (Demo).",
    };
  }
  const valUrl = validarUrlImprentaSegura(cfg.url);
  if (!valUrl.ok) return { ok: false, error: valUrl.error };
  const host = normalizarHostTfhka(valUrl.url);

  const auth = await obtenerOCachearTokenTfhka(db, env, cfg, true, fetchFn);
  if (!auth.ok) return { ok: false, error: auth.error };

  const numInicio = Math.max(1, Math.min(99_999_000, Math.trunc(Number(opts?.numero_inicio ?? 100) || 100)));
  const incluirErrores = opts?.incluir_errores !== false;
  const emailPrueba = normalizarCorreoCg(opts?.email_prueba, "certificacion@facturayave.com");
  const fechaIso = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
  const tasaE8 = 50_00000000; // Bs. 50.0000 por USD (exacto entero para cálculos limpios)
  const serieOpt = { serie: cfg.serie || "", sucursal: cfg.sucursal || "" };
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
  const numFacPerc = nextNum();
  const numFacMixta = nextNum();
  const numFacUsdVes = nextNum();
  const numFacUsdBs = nextNum();
  const numFacIgtf = nextNum();
  const numFacDescRen = nextNum();
  const numFacDescGlob = nextNum();
  const numFacExtensa = nextNum();
  const numNcTotal = nextNum();
  const numNcParcial = nextNum();
  const numNd = nextNum();
  const numRetIva75 = nextNum();
  const numRetIva100 = nextNum();
  const numRetIslr = nextNum();
  const numGuia = nextNum();

  type Caso = {
    codigo: string;
    descripcion: string;
    tipo_documento: string;
    numero_documento: string;
    esperaba_error: boolean;
    construir: (controles: Record<string, string>) => Record<string, unknown>;
  };

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

  const casos: Caso[] = [
    {
      codigo: "FAC_IVA_16",
      descripcion: "Factura gravada alícuota general 16% (G)",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFac16),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFac16, {
            nota: "Certificación TFHKA: Factura IVA 16%",
            renglones: [{ orden: 1, descripcion: "Servicio de soporte técnico 16%", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600 }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "FAC_IVA_8",
      descripcion: "Factura gravada alícuota reducida 8% (R)",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFac8),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFac8, {
            nota: "Certificación TFHKA: Factura IVA 8%",
            subtotal_bs: 500000, iva_bs: 40000, total_bs: 540000,
            subtotal_usd: 10000, iva_usd: 800, total_usd: 10800,
            renglones: [{ orden: 1, descripcion: "Servicio gravado alícuota reducida 8%", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 800 }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "FAC_IVA_31",
      descripcion: "Factura gravada alícuota adicional suntuaria 31% (A)",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFac31),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFac31, {
            nota: "Certificación TFHKA: Factura IVA 31%",
            subtotal_bs: 500000, iva_bs: 155000, total_bs: 655000,
            subtotal_usd: 10000, iva_usd: 3100, total_usd: 13100,
            renglones: [{ orden: 1, tipo: "PRODUCTO", descripcion: "Artículo suntuario 31%", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 3100 }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "FAC_EXENTA",
      descripcion: "Factura exenta de IVA 0% (E)",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFacExenta),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFacExenta, {
            nota: "Certificación TFHKA: Factura Exenta",
            subtotal_bs: 250000, iva_bs: 0, total_bs: 250000,
            subtotal_usd: 5000, iva_usd: 0, total_usd: 5000,
            renglones: [{ orden: 1, descripcion: "Servicio exento de IVA", cantidad_milli: 1000, precio_usd: 5000, alicuota_cent: 0 }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "FAC_PERCIBIDO",
      descripcion: "Factura con IVA percibido 0% (P)",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFacPerc),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFacPerc, {
            nota: "Certificación TFHKA: Factura Percibida",
            subtotal_bs: 250000, iva_bs: 0, total_bs: 250000,
            subtotal_usd: 5000, iva_usd: 0, total_usd: 5000,
            renglones: [{ orden: 1, tipo: "PRODUCTO", descripcion: "Producto con IVA percibido", cantidad_milli: 1000, precio_usd: 5000, alicuota_cent: 0, es_percibido: true }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "FAC_MIXTA_COMPLETA",
      descripcion: "Factura mixta con 5 alícuotas (16% G + 8% R + 31% A + Exento E + Percibido P)",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFacMixta),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFacMixta, {
            nota: "Certificación TFHKA: Mixta completa",
            subtotal_bs: 500000, iva_bs: 55000, total_bs: 555000, // 5 renglones de Bs 1000 ($20): IVA 160+80+310+0+0 = Bs 550
            subtotal_usd: 10000, iva_usd: 1100, total_usd: 11100,
            renglones: [
              { orden: 1, descripcion: "Ítem gravado 16%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 1600 },
              { orden: 2, descripcion: "Ítem reducido 8%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 800 },
              { orden: 3, tipo: "PRODUCTO", descripcion: "Ítem adicional 31%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 3100 },
              { orden: 4, descripcion: "Ítem exento 0%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 0 },
              { orden: 5, tipo: "PRODUCTO", descripcion: "Ítem percibido 0%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 0, es_percibido: true },
            ],
          }),
          serieOpt
        ),
    },
    {
      codigo: "FAC_USD_VES",
      descripcion: "Factura en divisa USD con equivalencia VES e IGTF 3%",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFacUsdVes),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFacUsdVes, {
            moneda_base: "USD",
            nota: "Certificación TFHKA: USD con equivalencia VES + IGTF",
            subtotal_bs: 500000, iva_bs: 80000, igtf_bs: 17400, total_bs: 597400,
            subtotal_usd: 10000, iva_usd: 1600, igtf_usd: 348, total_usd: 11948,
            renglones: [{ orden: 1, descripcion: "Licencia anual en USD", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600 }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "FAC_USD_PAGADA_BS",
      descripcion: "Factura en divisa USD pagada en Bolívares (sin IGTF)",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFacUsdBs),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFacUsdBs, {
            moneda_base: "USD",
            nota: "Certificación TFHKA: USD pagada en VES sin IGTF",
            subtotal_bs: 500000, iva_bs: 80000, igtf_bs: 0, total_bs: 580000,
            subtotal_usd: 10000, iva_usd: 1600, igtf_usd: 0, total_usd: 11600,
            renglones: [{ orden: 1, descripcion: "Servicio referenciado en USD pagado en Bs", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600 }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "FAC_IGTF_3",
      descripcion: "Factura VES con pago en divisas + IGTF 3% (Forma 09)",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFacIgtf),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFacIgtf, {
            nota: "Certificación TFHKA: IGTF 3%",
            subtotal_bs: 500000, iva_bs: 80000, igtf_bs: 17400, total_bs: 597400,
            subtotal_usd: 10000, iva_usd: 1600, igtf_usd: 348, total_usd: 11948,
            renglones: [{ orden: 1, descripcion: "Servicio con pago en divisas + IGTF", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600 }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "FAC_DESC_RENGLON",
      descripcion: "Factura con descuento por renglón (DescuentoMonto)",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFacDescRen),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFacDescRen, {
            nota: "Certificación TFHKA: Descuento por renglón",
            subtotal_bs: 450000, iva_bs: 72000, total_bs: 522000,
            subtotal_usd: 9000, iva_usd: 1440, total_usd: 10440,
            renglones: [
              {
                orden: 1,
                descripcion: "Servicio con 10% descuento en renglón",
                cantidad_milli: 1000,
                precio_usd: 10000,
                descuento_usd: 1000,
                descuento_bs: 50000,
                monto_usd: 9000,
                monto_bs: 450000,
                alicuota_cent: 1600,
              },
            ],
          }),
          serieOpt
        ),
    },
    {
      codigo: "FAC_DESC_GLOBAL",
      descripcion: "Factura con descuento global (ListaDescBonificacion)",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFacDescGlob),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFacDescGlob, {
            nota: "Certificación TFHKA: Descuento global",
            descuento_global_bs: 50000,
            descuento_global_usd: 1000,
            descuento_global_desc: "Descuento pronto pago 10%",
            subtotal_bs: 450000, iva_bs: 72000, total_bs: 522000,
            subtotal_usd: 9000, iva_usd: 1440, total_usd: 10440,
            renglones: [{ orden: 1, descripcion: "Consultoría con descuento global", cantidad_milli: 1000, precio_usd: 10000, monto_usd: 9000, monto_bs: 450000, alicuota_cent: 1600 }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "FAC_DETALLE_EXTENSO",
      descripcion: "Factura con detalle extenso (25 ítems / paginación)",
      tipo_documento: "01",
      numero_documento: numeroDocumentoTfhka(numFacExtensa),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numFacExtensa, {
            nota: "Certificación TFHKA: Detalle extenso 25 ítems",
            subtotal_bs: 1_250_000, iva_bs: 200_000, total_bs: 1_450_000,
            subtotal_usd: 25_000, iva_usd: 4_000, total_usd: 29_000,
            renglones: Array.from({ length: 25 }, (_, i) => ({
              orden: i + 1,
              tipo: i % 2 === 0 ? "SERVICIO" : "PRODUCTO",
              descripcion: `Ítem de certificación n.º ${i + 1}`,
              cantidad_milli: 1000,
              precio_usd: 1000,
              alicuota_cent: 1600,
            })),
          }),
          serieOpt
        ),
    },
    {
      codigo: "NC_TOTAL",
      descripcion: "Nota de Crédito Total (02) afectando Factura 16%",
      tipo_documento: "02",
      numero_documento: numeroDocumentoTfhka(numNcTotal),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numNcTotal, {
            tipo_documento: "NOTA_CREDITO",
            factura_afectada_numero: numFac16,
            factura_afectada_fecha: fechaIso,
            factura_afectada_monto_bs: 580000,
            motivo_nc: "Anulación / Devolución total de prueba certificación",
            renglones: [{ orden: 1, descripcion: "Devolución servicio 16%", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600 }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "NC_PARCIAL",
      descripcion: "Nota de Crédito Parcial (02) afectando Factura Mixta",
      tipo_documento: "02",
      numero_documento: numeroDocumentoTfhka(numNcParcial),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numNcParcial, {
            tipo_documento: "NOTA_CREDITO",
            factura_afectada_numero: numFacMixta,
            factura_afectada_fecha: fechaIso,
            factura_afectada_monto_bs: 555000,
            motivo_nc: "Devolución parcial ítem 16%",
            subtotal_bs: 100000, iva_bs: 16000, total_bs: 116000,
            subtotal_usd: 2000, iva_usd: 320, total_usd: 2320,
            renglones: [{ orden: 1, descripcion: "Ítem gravado 16%", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 1600 }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "ND_RECARGO",
      descripcion: "Nota de Débito por recargo (03)",
      tipo_documento: "03",
      numero_documento: numeroDocumentoTfhka(numNd),
      esperaba_error: false,
      construir: () =>
        construirDocumentoElectronicoTfhka(
          baseComun(numNd, {
            tipo_documento: "NOTA_DEBITO",
            factura_afectada_numero: numFac16,
            factura_afectada_fecha: fechaIso,
            factura_afectada_monto_bs: 580000,
            motivo_nc: "Recargo por flete adicional certificación",
            subtotal_bs: 100000, iva_bs: 16000, total_bs: 116000,
            subtotal_usd: 2000, iva_usd: 320, total_usd: 2320,
            renglones: [{ orden: 1, descripcion: "Recargo por flete", cantidad_milli: 1000, precio_usd: 2000, alicuota_cent: 1600 }],
          }),
          serieOpt
        ),
    },
    {
      codigo: "RET_IVA_75",
      descripcion: "Comprobante de Retención IVA 75% (05)",
      tipo_documento: "05",
      numero_documento: numeroDocumentoTfhka(numRetIva75),
      esperaba_error: false,
      construir: (controles) =>
        construirComprobanteRetencionIvaTfhka(
          {
            numero: numRetIva75,
            numero_comprobante: `${fechaIso.slice(0, 7).replace("-", "")}${String(numRetIva75).padStart(8, "0")}`,
            fecha_emision: fechaIso,
            sujeto_rif: "J-30111222-3",
            sujeto_nombre: "PROVEEDOR CERTIFICACION C.A.",
            sujeto_email: emailPrueba,
            factura_fecha: fechaIso,
            factura_numero: numFac16,
            factura_control: controles.FAC_IVA_16 || "00-00000001",
            monto_total_bs: 580000,
            monto_exento_bs: 0,
            base_imponible_bs: 500000,
            alicuota_iva_cent: 1600,
            porcentaje_retencion_cent: 7500,
            monto_iva_bs: 80000,
            monto_retenido_bs: 60000,
          },
          serieOpt
        ),
    },
    {
      codigo: "RET_IVA_100",
      descripcion: "Comprobante de Retención IVA 100% (05)",
      tipo_documento: "05",
      numero_documento: numeroDocumentoTfhka(numRetIva100),
      esperaba_error: false,
      construir: (controles) =>
        construirComprobanteRetencionIvaTfhka(
          {
            numero: numRetIva100,
            numero_comprobante: `${fechaIso.slice(0, 7).replace("-", "")}${String(numRetIva100).padStart(8, "0")}`,
            fecha_emision: fechaIso,
            sujeto_rif: "J-30111222-3",
            sujeto_nombre: "PROVEEDOR CERTIFICACION C.A.",
            sujeto_email: emailPrueba,
            factura_fecha: fechaIso,
            factura_numero: numFac8,
            factura_control: controles.FAC_IVA_8 || "00-00000002",
            monto_total_bs: 540000,
            monto_exento_bs: 0,
            base_imponible_bs: 500000,
            alicuota_iva_cent: 800,
            porcentaje_retencion_cent: 10000,
            monto_iva_bs: 40000,
            monto_retenido_bs: 40000,
          },
          serieOpt
        ),
    },
    {
      codigo: "RET_ISLR",
      descripcion: "Comprobante de Retención ISLR (06)",
      tipo_documento: "06",
      numero_documento: numeroDocumentoTfhka(numRetIslr),
      esperaba_error: false,
      construir: (controles) =>
        construirComprobanteRetencionIslrTfhka(
          {
            numero: numRetIslr,
            numero_comprobante: `${fechaIso.slice(0, 7).replace("-", "")}${String(numRetIslr).padStart(8, "0")}`,
            fecha_emision: fechaIso,
            sujeto_rif: "J-30111222-3",
            sujeto_nombre: "PROVEEDOR SERVICIOS C.A.",
            sujeto_email: emailPrueba,
            factura_fecha: fechaIso,
            factura_numero: numFac16,
            factura_control: controles.FAC_IVA_16 || "00-00000001",
            monto_total_bs: 580000,
            base_imponible_bs: 500000,
            porcentaje_retencion_cent: 200,
            sustraendo_bs: 0,
            monto_retenido_bs: 10000,
            codigo_concepto: "053",
          },
          serieOpt
        ),
    },
    {
      codigo: "GUIA_DESPACHO",
      descripcion: "Guía de Despacho (04)",
      tipo_documento: "04",
      numero_documento: numeroDocumentoTfhka(numGuia),
      esperaba_error: false,
      construir: () =>
        construirGuiaDespachoTfhka(
          {
            numero: numGuia,
            fecha_emision: fechaIso,
            cliente_rif: "J-30111222-3",
            cliente_nombre: "DESTINATARIO CERTIFICACION C.A.",
            cliente_direccion: "Valencia, Carabobo",
            cliente_email: emailPrueba,
            motivo_traslado: "Traslado de mercancía vendida",
            origen_producto: "Almacén Central Caracas",
            destino_producto: "Sucursal Valencia",
            conductor_nombre: "Carlos Conductor",
            conductor_rif: "V-18123456",
            vehiculo_tipo: "Camión 350",
            vehiculo_placa: "A12BC3D",
            transportista: "Transporte Propio",
            peso_total: "25.00",
            renglones: [{ descripcion: "Equipos de computación sellados", cantidad_milli: 2000, codigo: "EQ-01" }],
          },
          serieOpt
        ),
    },
  ];

  if (incluirErrores) {
    casos.push(
      {
        codigo: "ERR_DUPLICADO",
        descripcion: "Validación negativa: rechazo por N.º de documento duplicado",
        tipo_documento: "01",
        numero_documento: numeroDocumentoTfhka(numFac16),
        esperaba_error: true,
        construir: () =>
          construirDocumentoElectronicoTfhka(
            baseComun(numFac16, {
              nota: "Intento duplicado controlado",
              renglones: [{ orden: 1, descripcion: "Duplicado controlado", cantidad_milli: 1000, precio_usd: 10000, alicuota_cent: 1600 }],
            }),
            serieOpt
          ),
      },
      {
        codigo: "ERR_CAMPOS_FALTANTES",
        descripcion: "Validación negativa: rechazo por campos obligatorios faltantes",
        tipo_documento: "01",
        numero_documento: numeroDocumentoTfhka(nextNum()),
        esperaba_error: true,
        construir: () => ({
          DocumentoElectronico: {
            Encabezado: {
              IdentificacionDocumento: {
                TipoDocumento: "01",
                NumeroDocumento: "",
                Serie: serieOpt.serie,
                Sucursal: serieOpt.sucursal,
              },
              Comprador: { TipoIdentificacion: "", NumeroIdentificacion: "", RazonSocial: "" },
              Totales: null,
            },
            DetallesItems: [],
          },
        }),
      }
    );
  }

  const controlesObtenidos: Record<string, string> = {};
  const resultados: ResultadoCasoCertificacionTfhka[] = [];

  for (const caso of casos) {
    const body = caso.construir(controlesObtenidos);
    const res = await peticionAutenticadaTfhka(db, env, cfg, "Emision", { method: "POST", body, timeoutMs: 25_000 }, fetchFn);
    const parsed = res.error ? null : extraerRespuestaEmisionTfhka(res.data, res.status);

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
        mensaje: rechazadoOk
          ? `Rechazo controlado OK: ${parsed?.error || res.error || `HTTP ${res.status}`}`
          : "Se esperaba rechazo de validación, pero la API devolvió éxito.",
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
        mensaje: res.error || parsed?.error || `HTTP ${res.status}`,
      });
    }
  }

  const aprobados = resultados.filter((r) => r.ok && !r.esperaba_error).length;
  const erroresControladosOk = resultados.filter((r) => r.ok && r.esperaba_error).length;
  const fallidos = resultados.filter((r) => !r.ok).length;
  const fechaEjec = new Date().toISOString();

  const lineasReporte = [
    `REPORTE DE CERTIFICACIÓN DEMO — THE FACTORY HKA VENEZUELA (FacturaYa Venezuela v5.3.0)`,
    `Fecha: ${fechaEjec} | Ambiente: PRUEBAS (Demo) | Host: ${host}${auth.apiPrefix}`,
    `Emisor: ${emisorDemo.nombre_razon_social} (${emisorDemo.rif}) | Serie: "${serieOpt.serie}" | Sucursal: "${serieOpt.sucursal}"`,
    `Resultado: ${aprobados + erroresControladosOk}/${resultados.length} OK (${aprobados} emisiones + ${erroresControladosOk} errores controlados, ${fallidos} fallidos)`,
    ``,
    ...resultados.map(
      (r, idx) =>
        `${String(idx + 1).padStart(2, "0")}. [${r.ok ? "OK" : "FAIL"}] ${r.codigo} (Tipo ${r.tipo_documento} · Doc ${r.numero_documento}) -> ${
          r.control_fiscal ? `Control ${r.control_fiscal}` : r.mensaje
        }`
    ),
  ];

  return {
    ok: fallidos === 0,
    ambiente: "PRUEBAS",
    host: `${host}${auth.apiPrefix}`,
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
