// Reglas fiscales puras SENIAT (Providencias SNAT/2011/0071, SNAT/2022/000013, SNAT/2024/000102 y SNAT/2015/0049).
// Módulo sin dependencias externas para compartir la misma lógica verificable entre rutas y pruebas unitarias.

export interface DocFiscalAnulacion {
  tipo?: string | null;
  estado?: string | null;
  modo?: string | null;
  es_nota_credito?: number | boolean | null;
  es_nota_debito?: number | boolean | null;
  fecha_emision?: string | null;
  medio?: string | null;
  control_fiscal?: string | null;
}

export interface ContextoAnulacionDoc {
  pagosVigentes: number;
  notasVigentes: number;
  mesActualCaracas: string; // formato AAAA-MM
}

export interface ResultadoAnulacionDoc {
  permitida: boolean;
  codigo:
    | "ESTADO_NO_EMITIDO"
    | "TIENE_PAGOS_VIGENTES"
    | "TIENE_NOTAS_VIGENTES"
    | "MES_FISCAL_CERRADO"
    | "NOTA_CON_CONTROL_IMPRENTA"
    | null;
  motivo: string | null;
  sugerirNotaCredito: boolean;
}

export interface PagoFiscalAnulacion {
  estado?: string | null;
  fecha_pago?: string | null;
  es_retencion_iva?: number | boolean | null;
  es_retencion_islr?: number | boolean | null;
}

export interface ResultadoAnulacionPago {
  permitida: boolean;
  codigo: "PAGO_NO_VIGENTE" | "DOC_ANULADO" | "RETENCION_MES_CERRADO" | null;
  motivo: string | null;
}

export function formatearControlFiscal(
  controlFiscal: string | null | undefined,
  controlInterno: number | string | null | undefined,
  numero?: number | string | null
): string {
  const cf = String(controlFiscal ?? "").trim();
  if (cf) return cf;
  const base = controlInterno ?? numero ?? 1;
  const s = String(base).trim();
  if (!s) return "00-00000001";
  if (s.includes("-")) return s;
  if (/^\d+$/.test(s)) return `00-${s.padStart(8, "0")}`;
  return s;
}

export function puedeInvocarImprentaDigital(medio: string | null | undefined, modo: string | null | undefined): boolean {
  return String(medio ?? "").toUpperCase() === "IMPRENTA_DIGITAL" && String(modo ?? "").toUpperCase() === "REAL";
}

export function validarIgtfNotaCredito(
  aplicaIgtfNc: boolean,
  facturaOriginalAplicaIgtf: boolean
): { ok: true } | { ok: false; error: string } {
  if (aplicaIgtfNc && !facturaOriginalAplicaIgtf) {
    return {
      ok: false,
      error: "No se puede reversar IGTF (3%) en la Nota de Crédito porque la factura original no incluyó IGTF.",
    };
  }
  return { ok: true };
}

export function evaluarAnulacionDocumento(
  doc: DocFiscalAnulacion,
  ctx: ContextoAnulacionDoc
): ResultadoAnulacionDoc {
  const esNc = Boolean(doc.es_nota_credito);
  const esNd = Boolean(doc.es_nota_debito);
  const esFacturaBase = doc.tipo === "FACTURA" && !esNc && !esNd;

  if (doc.estado !== "EMITIDO") {
    return {
      permitida: false,
      codigo: "ESTADO_NO_EMITIDO",
      motivo: "Solo se puede anular un documento emitido (no un borrador, ni uno ya anulado o facturado).",
      sugerirNotaCredito: false,
    };
  }

  if (ctx.pagosVigentes > 0) {
    if (esFacturaBase) {
      return {
        permitida: false,
        codigo: "TIENE_PAGOS_VIGENTES",
        motivo:
          "Según la normativa SENIAT (Art. 25 Providencia SNAT/2011/0071), esta factura tiene pagos registrados y no puede anularse directamente: debes emitir una Nota de Crédito («↩️ Devolver»).",
        sugerirNotaCredito: true,
      };
    }
    if (esNd) {
      return {
        permitida: false,
        codigo: "TIENE_PAGOS_VIGENTES",
        motivo:
          "Esta Nota de Débito tiene pagos registrados y no puede anularse directamente: corresponde ajustar mediante Nota de Crédito o revisar el cobro del período actual.",
        sugerirNotaCredito: false,
      };
    }
    return {
      permitida: false,
      codigo: "TIENE_PAGOS_VIGENTES",
      motivo: "Este presupuesto tiene pagos registrados: anula primero los abonos si deseas anularlo.",
      sugerirNotaCredito: false,
    };
  }

  if (ctx.notasVigentes > 0 && esFacturaBase) {
    return {
      permitida: false,
      codigo: "TIENE_NOTAS_VIGENTES",
      motivo:
        "Esta factura ya tiene Notas de Crédito o Débito emitidas: según la normativa SENIAT no se puede anular directamente.",
      sugerirNotaCredito: false,
    };
  }

  if (doc.tipo === "FACTURA") {
    const mesDoc = String(doc.fecha_emision ?? "").slice(0, 7);
    if (mesDoc && ctx.mesActualCaracas && mesDoc !== ctx.mesActualCaracas) {
      return {
        permitida: false,
        codigo: "MES_FISCAL_CERRADO",
        motivo:
          esNc || esNd
            ? "Según la normativa SENIAT, una Nota de Crédito o Débito de un período fiscal anterior no puede anularse directamente porque altera el Libro de Ventas cerrado."
            : "Según la normativa SENIAT, una factura de un período fiscal anterior no puede anularse directamente porque altera el Libro de Ventas cerrado: debes emitir una Nota de Crédito («↩️ Devolver»).",
        sugerirNotaCredito: esFacturaBase,
      };
    }

    if ((esNc || esNd) && String(doc.medio ?? "").toUpperCase() === "IMPRENTA_DIGITAL" && String(doc.control_fiscal ?? "").trim()) {
      return {
        permitida: false,
        codigo: "NOTA_CON_CONTROL_IMPRENTA",
        motivo:
          "Esta Nota Fiscal ya cuenta con N.º de Control asignado por Imprenta Digital Autorizada: según la normativa SENIAT no puede anularse directamente; emite una nota inversa de ajuste.",
        sugerirNotaCredito: false,
      };
    }
  }

  return { permitida: true, codigo: null, motivo: null, sugerirNotaCredito: false };
}

export function evaluarAnulacionPago(
  pago: PagoFiscalAnulacion,
  doc: Pick<DocFiscalAnulacion, "tipo" | "estado" | "modo"> | null | undefined,
  mesActualCaracas: string
): ResultadoAnulacionPago {
  if (pago.estado !== "VIGENTE") {
    return {
      permitida: false,
      codigo: "PAGO_NO_VIGENTE",
      motivo: "Ese pago no existe o ya estaba anulado.",
    };
  }
  if (doc && doc.estado === "ANULADO") {
    return {
      permitida: false,
      codigo: "DOC_ANULADO",
      motivo: "El documento asociado ya está anulado; este comprobante de pago no puede anularse.",
    };
  }
  const esRetencion = Boolean(pago.es_retencion_iva) || Boolean(pago.es_retencion_islr);
  const mesPago = String(pago.fecha_pago ?? "").slice(0, 7);
  if (
    esRetencion &&
    doc &&
    doc.tipo === "FACTURA" &&
    String(doc.modo ?? "").toUpperCase() === "REAL" &&
    mesPago &&
    mesActualCaracas &&
    mesPago !== mesActualCaracas
  ) {
    return {
      permitida: false,
      codigo: "RETENCION_MES_CERRADO",
      motivo:
        "Según la normativa SENIAT, una retención de IVA o ISLR de un período fiscal anterior no puede anularse porque altera las declaraciones y libros ya cerrados.",
    };
  }
  return { permitida: true, codigo: null, motivo: null };
}
