// Reglas fiscales puras SENIAT (LIVA Arts. 36, 50 y 58 · Providencias SNAT/2011/0071, SNAT/2022/000013, SNAT/2024/000102 y SNAT/2025/000054).
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
  mesActualCaracas?: string; // formato AAAA-MM (compatibilidad)
  fechaActualCaracas?: string; // formato AAAA-MM-DD (preferido para quincenas SPE)
  tipoContribuyente?: string | null; // FORMAL | ORDINARIO | ESPECIAL
}

export interface ResultadoAnulacionDoc {
  permitida: boolean;
  codigo:
    | "ESTADO_NO_EMITIDO"
    | "TIENE_PAGOS_VIGENTES"
    | "TIENE_NOTAS_VIGENTES"
    | "MES_FISCAL_CERRADO"
    | "QUINCENA_FISCAL_CERRADA"
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
  codigo: "PAGO_NO_VIGENTE" | "DOC_ANULADO" | "RETENCION_MES_CERRADO" | "RETENCION_QUINCENA_CERRADA" | null;
  motivo: string | null;
}

export function quincenaDeFecha(fechaIso: string | null | undefined): string | null {
  const s = String(fechaIso ?? "").trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const dia = Number(m[3]);
  if (!Number.isInteger(dia) || dia < 1 || dia > 31) return null;
  return `${m[1]}-${m[2]}-Q${dia <= 15 ? 1 : 2}`;
}

export function esPeriodoFiscalCerrado(
  fechaRegistro: string | null | undefined,
  fechaActualCaracas: string | null | undefined,
  modalidad: "MENSUAL" | "QUINCENAL"
): { cerrado: boolean; porQuincena: boolean } {
  const reg = String(fechaRegistro ?? "").trim();
  const act = String(fechaActualCaracas ?? "").trim();
  const mesReg = reg.slice(0, 7);
  const mesAct = act.slice(0, 7);
  if (!mesReg || !mesAct || !/^\d{4}-\d{2}$/.test(mesReg) || !/^\d{4}-\d{2}$/.test(mesAct)) {
    return { cerrado: false, porQuincena: false };
  }
  if (mesReg !== mesAct) {
    return { cerrado: true, porQuincena: false };
  }
  if (modalidad === "QUINCENAL") {
    const qReg = quincenaDeFecha(reg);
    const qAct = quincenaDeFecha(act);
    if (qReg && qAct && qReg !== qAct) {
      return { cerrado: true, porQuincena: true };
    }
  }
  return { cerrado: false, porQuincena: false };
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
          "Según la normativa SENIAT (LIVA Art. 58 · Providencia SNAT/2011/0071 Arts. 22 y 23), esta factura tiene pagos registrados y no puede anularse directamente: debes emitir una Nota de Crédito («↩️ Devolver»).",
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
        "Esta factura ya tiene Notas de Crédito o Débito emitidas: según la normativa SENIAT (LIVA Art. 58 · SNAT/2011/0071) no se puede anular directamente.",
      sugerirNotaCredito: false,
    };
  }

  if (doc.tipo === "FACTURA") {
    const fechaRef = ctx.fechaActualCaracas || ctx.mesActualCaracas || "";
    const modalidadPeriodo = String(ctx.tipoContribuyente ?? "").toUpperCase() === "ESPECIAL" ? "QUINCENAL" : "MENSUAL";
    const periodo = esPeriodoFiscalCerrado(doc.fecha_emision, fechaRef, modalidadPeriodo);
    if (periodo.cerrado) {
      if (periodo.porQuincena) {
        return {
          permitida: false,
          codigo: "QUINCENA_FISCAL_CERRADA",
          motivo:
            esNc || esNd
              ? "Según la normativa SENIAT para Contribuyentes Especiales (declaración quincenal), una Nota de Crédito o Débito de un período fiscal anterior (quincena cerrada) no puede anularse directamente."
              : "Según la normativa SENIAT para Contribuyentes Especiales (LIVA Art. 58 · declaración quincenal), una factura de un período fiscal anterior (quincena cerrada) no puede anularse directamente: debes emitir una Nota de Crédito («↩️ Devolver»).",
          sugerirNotaCredito: esFacturaBase,
        };
      }
      return {
        permitida: false,
        codigo: "MES_FISCAL_CERRADO",
        motivo:
          esNc || esNd
            ? "Según la normativa SENIAT (LIVA Arts. 50 y 58), una Nota de Crédito o Débito de un período fiscal anterior no puede anularse directamente porque altera el Libro de Ventas cerrado."
            : "Según la normativa SENIAT (LIVA Arts. 50 y 58 · Providencia SNAT/2011/0071 Arts. 22 y 23), una factura de un período fiscal anterior no puede anularse directamente porque altera el Libro de Ventas cerrado: debes emitir una Nota de Crédito («↩️ Devolver»).",
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
  fechaOMesActualCaracas: string
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
  const esRetIva = Boolean(pago.es_retencion_iva);
  const esRetIslr = Boolean(pago.es_retencion_islr);
  if (
    (esRetIva || esRetIslr) &&
    doc &&
    doc.tipo === "FACTURA" &&
    String(doc.modo ?? "").toUpperCase() === "REAL"
  ) {
    // Retenciones de IVA se declaran y enteran quincenalmente (Providencia SNAT/2025/000054 Art. 11); ISLR es mensual (Decreto 1.808).
    const periodo = esPeriodoFiscalCerrado(pago.fecha_pago, fechaOMesActualCaracas, esRetIva ? "QUINCENAL" : "MENSUAL");
    if (periodo.cerrado) {
      if (esRetIva && periodo.porQuincena) {
        return {
          permitida: false,
          codigo: "RETENCION_QUINCENA_CERRADA",
          motivo:
            "Según la Providencia SENIAT SNAT/2025/000054 (Art. 11), una retención de IVA de una quincena ya cerrada (período fiscal anterior) no puede anularse directamente porque su enteramiento quincenal ya cerró.",
        };
      }
      return {
        permitida: false,
        codigo: "RETENCION_MES_CERRADO",
        motivo: esRetIva
          ? "Según la Providencia SENIAT SNAT/2025/000054 (Art. 11), una retención de IVA de un período fiscal anterior no puede anularse porque altera las declaraciones y libros ya cerrados."
          : "Según la normativa SENIAT (Decreto 1.808), una retención de ISLR de un período fiscal anterior no puede anularse porque altera las declaraciones y libros ya cerrados.",
      };
    }
  }
  return { permitida: true, codigo: null, motivo: null };
}
