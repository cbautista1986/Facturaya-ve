// DINERO: toda la matemática de montos vive aquí y la usan el servidor Y el navegador (una sola fuente de verdad).
// Reglas: montos en centavos enteros · tasa BCV en "e8" (Bs por USD × 100.000.000) · redondeo siempre "mitad hacia arriba".
// Nunca se usan decimales de coma flotante para dinero.
const E8 = 100000000;

const seguro = (n) => {
  if (!Number.isSafeInteger(n)) throw new Error("Los montos son demasiado grandes.");
  return n;
};
// round(a × b ÷ div) exacto (BigInt), mitad hacia arriba. Solo para valores no negativos.
export const redondear = (a, b, div) => seguro(Number((BigInt(a) * BigInt(b) + BigInt(div) / 2n) / BigInt(div)));

const limpio = (v) => String(v ?? "").trim().replace(/\s/g, "").replace(",", ".");

// "12,50" o "12.5" -> 1250 centavos. null si está vacío, NaN si no es un monto válido (máximo 9 dígitos enteros).
export function aCentavos(v) {
  const t = limpio(v);
  if (t === "") return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return NaN;
  const [e, d = ""] = t.split(".");
  return Number(e) * 100 + Number(d.padEnd(2, "0"));
}

// "123,45" o "123.4567" -> 12345000000 (e8). null si está vacío, NaN si no es válido o es 0.
export function aTasaE8(v) {
  const t = limpio(v);
  if (t === "") return null;
  if (!/^\d{1,7}(\.\d{1,8})?$/.test(t)) return NaN;
  const [e, d = ""] = t.split(".");
  const n = Number(e) * E8 + Number(d.padEnd(8, "0"));
  return n > 0 ? n : NaN;
}

// "1,5" -> 1500 (milésimas de unidad). Máximo 3 decimales. null si vacío, NaN si inválido o 0.
export function aCantidadMilli(v) {
  const t = limpio(v);
  if (t === "") return null;
  if (!/^\d{1,7}(\.\d{1,3})?$/.test(t)) return NaN;
  const [e, d = ""] = t.split(".");
  const n = Number(e) * 1000 + Number(d.padEnd(3, "0"));
  return n > 0 && n <= 1e9 ? n : NaN;
}

export const cantidadTexto = (milli) => (milli / 1000).toString().replace(".", ",");
export const tasaTexto = (e8) => (e8 / E8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");

export const TIPOS_EXENCION = ["EXENTA", "EXONERADA", "NO_SUJETA"];

export function normalizarTipoExencion(v) {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "EXONERADA" || s === "NO_SUJETA") return s;
  return "EXENTA";
}

// lineas: [{ cantidad_milli, precio_usd (centavos por unidad), alicuota_cent (% × 100), costo_usd? (centavos por unidad), tipo_exencion? ('EXENTA'|'EXONERADA'|'NO_SUJETA') }]
// opciones: { aplica_igtf?: boolean, igtf_alicuota_cent?: number, igtf_base_usd?: number | null }
// Devuelve montos por renglón, impuestos por alícuota (con desglose Exento/Exonerado/No Sujeto para 0%), IGTF total o parcial y totales, en USD y en Bs (los de Bs son los legales).
// Con tasaE8 vacío (borrador sin tasa) los campos en Bs quedan en null.
export function calcular(lineas, tasaE8, opciones = {}) {
  const conTasa = Number.isInteger(tasaE8) && tasaE8 > 0;
  const aplicaIgtf = !!(opciones && opciones.aplica_igtf);
  const alicuotaIgtf = Number(opciones?.igtf_alicuota_cent ?? 300) || 300;
  const grupos = new Map();
  let costo = 0;
  const renglones = lineas.map((l) => {
    const monto_usd = redondear(l.cantidad_milli, l.precio_usd, 1000);
    const monto_bs = conTasa ? redondear(monto_usd, tasaE8, E8) : null;
    costo = seguro(costo + redondear(l.cantidad_milli, l.costo_usd ?? 0, 1000));
    const g = grupos.get(l.alicuota_cent) ?? {
      alicuota_cent: l.alicuota_cent,
      base_usd: 0,
      base_bs: 0,
      exenta_usd: 0,
      exenta_bs: 0,
      exonerada_usd: 0,
      exonerada_bs: 0,
      no_sujeta_usd: 0,
      no_sujeta_bs: 0,
    };
    g.base_usd = seguro(g.base_usd + monto_usd);
    if (conTasa) g.base_bs = seguro(g.base_bs + monto_bs);
    if (l.alicuota_cent === 0) {
      const te = normalizarTipoExencion(l.tipo_exencion);
      if (te === "EXONERADA") {
        g.exonerada_usd = seguro(g.exonerada_usd + monto_usd);
        if (conTasa) g.exonerada_bs = seguro(g.exonerada_bs + monto_bs);
      } else if (te === "NO_SUJETA") {
        g.no_sujeta_usd = seguro(g.no_sujeta_usd + monto_usd);
        if (conTasa) g.no_sujeta_bs = seguro(g.no_sujeta_bs + monto_bs);
      } else {
        g.exenta_usd = seguro(g.exenta_usd + monto_usd);
        if (conTasa) g.exenta_bs = seguro(g.exenta_bs + monto_bs);
      }
    }
    grupos.set(l.alicuota_cent, g);
    return { monto_usd, monto_bs };
  });
  const impuestos = [...grupos.values()].sort((a, b) => a.alicuota_cent - b.alicuota_cent).map((g) => ({
    alicuota_cent: g.alicuota_cent,
    base_usd: g.base_usd, iva_usd: redondear(g.base_usd, g.alicuota_cent, 10000),
    base_bs: conTasa ? g.base_bs : null, iva_bs: conTasa ? redondear(g.base_bs, g.alicuota_cent, 10000) : null,
    exenta_usd: g.alicuota_cent === 0 ? g.exenta_usd : 0,
    exonerada_usd: g.alicuota_cent === 0 ? g.exonerada_usd : 0,
    no_sujeta_usd: g.alicuota_cent === 0 ? g.no_sujeta_usd : 0,
    exenta_bs: conTasa ? (g.alicuota_cent === 0 ? g.exenta_bs : 0) : null,
    exonerada_bs: conTasa ? (g.alicuota_cent === 0 ? g.exonerada_bs : 0) : null,
    no_sujeta_bs: conTasa ? (g.alicuota_cent === 0 ? g.no_sujeta_bs : 0) : null,
  }));
  const suma = (k) => seguro(impuestos.reduce((s, i) => s + (i[k] ?? 0), 0));
  const subtotal_usd = suma("base_usd"), iva_usd = suma("iva_usd");
  const subtotal_bs = conTasa ? suma("base_bs") : null, iva_bs = conTasa ? suma("iva_bs") : null;
  const total_con_iva_usd = seguro(subtotal_usd + iva_usd);
  const total_con_iva_bs = conTasa ? seguro(subtotal_bs + iva_bs) : null;

  let igtf_base_usd = 0;
  let igtf_base_bs = conTasa ? 0 : null;
  if (aplicaIgtf) {
    const baseEx = opciones?.igtf_base_usd;
    if (baseEx === undefined || baseEx === null || baseEx === "") {
      igtf_base_usd = total_con_iva_usd;
      igtf_base_bs = total_con_iva_bs;
    } else {
      if (!Number.isInteger(baseEx) || baseEx < 0) {
        throw new Error("La base en divisas para IGTF no es válida.");
      }
      if (baseEx > total_con_iva_usd) {
        throw new Error("El monto pagado en divisas para IGTF no puede superar el Subtotal + IVA del documento.");
      }
      igtf_base_usd = baseEx;
      if (conTasa) {
        igtf_base_bs = igtf_base_usd === total_con_iva_usd
          ? total_con_iva_bs
          : Math.min(total_con_iva_bs, redondear(igtf_base_usd, tasaE8, E8));
      }
    }
  }
  const igtf_usd = aplicaIgtf && igtf_base_usd > 0 ? redondear(igtf_base_usd, alicuotaIgtf, 10000) : 0;
  const igtf_bs = conTasa ? (aplicaIgtf && igtf_base_bs > 0 ? redondear(igtf_base_bs, alicuotaIgtf, 10000) : 0) : null;
  return {
    renglones, impuestos, costo_total_usd: costo,
    subtotal_usd, iva_usd, igtf_alicuota_cent: aplicaIgtf && igtf_base_usd > 0 ? alicuotaIgtf : 0,
    igtf_base_usd, igtf_usd,
    total_usd: seguro(total_con_iva_usd + igtf_usd),
    subtotal_bs, iva_bs, igtf_base_bs, igtf_bs,
    total_bs: conTasa ? seguro(total_con_iva_bs + igtf_bs) : null,
  };
}

// Pagos: Bs (centavos) ÷ tasa del día del pago = USD (centavos); y al revés. Mitad hacia arriba, exacto.
export const bsAUsd = (bsCent, tasaE8) => redondear(bsCent, E8, tasaE8);
export const usdABs = (usdCent, tasaE8) => redondear(usdCent, tasaE8, E8);

// Convierte una cédula o RIF venezolano (ej. "V-12345678" o "V123456781") al formato RIF SENIAT con dígito verificador Módulo 11 ("V-12345678-1").
export function aRifSeniat(valor) {
  const limpioRif = String(valor ?? "").toUpperCase().trim().replace(/\s+/g, "");
  if (!limpioRif) return "";
  // Si ya viene con guion y dígito verificador explícito (ej. V-12345678-1 o J-12345678-9), se normaliza su formato con guiones
  const conDigito = limpioRif.match(/^([VEJPGC])-?(\d{6,8})-(\d)$/);
  if (conDigito) return `${conDigito[1]}-${conDigito[2].padStart(8, "0")}-${conDigito[3]}`;
  // Si viene con 9 dígitos pegados (8 de cuerpo + 1 verificador, ej. J123456789)
  const nueveDigitos = limpioRif.match(/^([VEJPGC])-?(\d{8})(\d)$/);
  if (nueveDigitos) return `${nueveDigitos[1]}-${nueveDigitos[2]}-${nueveDigitos[3]}`;
  // Si es una cédula V o E (6 a 8 dígitos sin dígito verificador, ej. V-12345678), calcula el dígito verificador SENIAT (Módulo 11)
  const sinDigito = limpioRif.match(/^([VEJPG])-?(\d{6,8})$/);
  if (sinDigito) {
    const letra = sinDigito[1], cuerpo = sinDigito[2].padStart(8, "0");
    const valorLetra = { V: 1, E: 2, J: 3, P: 4, G: 5 }[letra] ?? 1;
    const pesos = [3, 2, 7, 6, 5, 4, 3, 2];
    const suma = valorLetra * 4 + [...cuerpo].reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    const resto = 11 - (suma % 11);
    const digito = resto >= 10 ? 0 : resto;
    return `${letra}-${cuerpo}-${digito}`;
  }
  return limpioRif;
}

// Semáforo visual de la Tasa Oficial BCV en hora de Venezuela (Caracas UTC-4, sin horario de verano):
// - verde: día hábil (lun–vie, no feriado) con tasa actualizada hoy.
// - amarillo: fin de semana (sáb–dom), feriado bancario o día sin publicación BCV con tasa vigente desde el último día hábil.
// - rojo: tasa sin definir, sin fecha válida o desactualizada.
export function estadoSemaforoTasaBcv(tasa, tasaFecha, ahoraMs = Date.now(), opciones = {}) {
  const numTasa = Number(tasa);
  if (!Number.isFinite(numTasa) || numTasa <= 0) {
    return {
      estado: "rojo",
      clase: "tasa-rojo",
      punto: "🔴",
      insignia: "rojo",
      etiqueta: "Sin definir",
      detalle: "Define o sincroniza la tasa oficial en Ajustes",
    };
  }
  let tasaMs = 0;
  if (tasaFecha instanceof Date) {
    tasaMs = tasaFecha.getTime();
  } else if (tasaFecha != null && String(tasaFecha).trim() !== "") {
    const s = String(tasaFecha).trim();
    if (/^\d{9,13}$/.test(s)) {
      const n = Number(s);
      tasaMs = s.length <= 10 ? n * 1000 : n;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      // Fecha ISO pura (YYYY-MM-DD, ej. fecha_valor BCV): se interpreta como mediodía Caracas para no cambiar de día al restar UTC-4
      tasaMs = Date.parse(`${s}T16:00:00Z`);
    } else {
      const iso = s.replace(" ", "T");
      tasaMs = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
    }
  }
  if (!Number.isFinite(tasaMs) || tasaMs <= 0) {
    return {
      estado: "rojo",
      clase: "tasa-rojo",
      punto: "🔴",
      insignia: "rojo",
      etiqueta: "Sin actualizar",
      detalle: "Sin fecha de actualización · sincroniza en Ajustes",
    };
  }

  const OFFSET_VET_MS = 4 * 60 * 60 * 1000;
  const DIA_MS = 24 * 60 * 60 * 1000;
  const ahoraVet = new Date(ahoraMs - OFFSET_VET_MS);
  const tasaVet = new Date(tasaMs - OFFSET_VET_MS);
  const hoyIso = ahoraVet.toISOString().slice(0, 10);
  const tasaIso = tasaVet.toISOString().slice(0, 10);
  const diaSemana = ahoraVet.getUTCDay(); // 0=Dom, 1=Lun .. 5=Vie, 6=Sáb

  const feriadosSet = new Set(
    Array.isArray(opciones?.feriados)
      ? opciones.feriados.map((x) => String(x || "").trim().slice(0, 10)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))
      : []
  );
  const sinPubHoy = String(opciones?.sinPublicacionHoy || "").trim().slice(0, 10) === hoyIso;
  const esFeriadoHoy = feriadosSet.has(hoyIso);

  const ultimoDiaHabilAntesDe = (baseMsVet) => {
    for (let i = 1; i <= 14; i++) {
      const cand = new Date(baseMsVet - i * DIA_MS);
      const dow = cand.getUTCDay();
      const iso = cand.toISOString().slice(0, 10);
      if (dow !== 0 && dow !== 6 && !feriadosSet.has(iso)) return iso;
    }
    return new Date(baseMsVet - DIA_MS).toISOString().slice(0, 10);
  };

  if (diaSemana === 6 || diaSemana === 0) {
    const ultimoHabilIso = ultimoDiaHabilAntesDe(ahoraMs - OFFSET_VET_MS);
    if (tasaIso >= ultimoHabilIso) {
      return {
        estado: "amarillo",
        clase: "tasa-amarillo",
        punto: "🟡",
        insignia: "ambar",
        etiqueta: "Fin de semana",
        detalle: "Fin de semana (BCV): rige la tasa oficial del último día hábil",
      };
    }
    return {
      estado: "rojo",
      clase: "tasa-rojo",
      punto: "🔴",
      insignia: "rojo",
      etiqueta: "Sin actualizar",
      detalle: "Sin actualizar desde antes del último día hábil",
    };
  }

  if (tasaIso >= hoyIso) {
    return {
      estado: "verde",
      clase: "tasa-verde",
      punto: "🟢",
      insignia: "verde",
      etiqueta: "Al día",
      detalle: "",
    };
  }

  if (esFeriadoHoy || sinPubHoy) {
    const ultimoHabilIso = ultimoDiaHabilAntesDe(ahoraMs - OFFSET_VET_MS);
    if (tasaIso >= ultimoHabilIso) {
      return {
        estado: "amarillo",
        clase: "tasa-amarillo",
        punto: "🟡",
        insignia: "ambar",
        etiqueta: esFeriadoHoy ? "Feriado BCV" : "Sin publicación BCV",
        detalle: "Feriado o día sin publicación BCV: rige la última tasa oficial hábil",
      };
    }
  }

  return {
    estado: "rojo",
    clase: "tasa-rojo",
    punto: "🔴",
    insignia: "rojo",
    etiqueta: "Sin actualizar",
    detalle: "Tasa sin actualizar hoy · revisa en Ajustes",
  };
}


