// Régimen Fiscal del Contribuyente en Venezuela (Ley del IVA Arts. 5 y 8, Providencias SENIAT SNAT/2011/0071, SNAT/2022/000013 y SNAT/2026/00099).
// Centraliza las reglas de negocio para FORMAL, ORDINARIO y ESPECIAL (SPE) usadas por el servidor y pruebas unitarias.

export const TIPOS_CONTRIBUYENTE = ["FORMAL", "ORDINARIO", "ESPECIAL"] as const;
export type TipoContribuyente = (typeof TIPOS_CONTRIBUYENTE)[number];

export interface ReglasRegimen {
  tipo: TipoContribuyente;
  etiqueta: string;
  etiquetaCorta: string;
  icono: string;
  descripcion: string;
  cobraIva: boolean;
  cobraIgtf: boolean;
  recibeRetencionIva: boolean;
  recibeRetencionIslr: boolean;
  muestraResumenIva: boolean;
  leyendaPdf: string;
}

const INFO_REGIMEN: Record<TipoContribuyente, ReglasRegimen> = {
  FORMAL: {
    tipo: "FORMAL",
    etiqueta: "Contribuyente Formal (Exento de IVA)",
    etiquetaCorta: "Formal",
    icono: "🩺",
    descripcion: "Actividades exclusivamente exentas (médicos, odontólogos, psicólogos, educación). Factura 0% IVA, sin IGTF y con leyenda «Contribuyente Formal».",
    cobraIva: false,
    cobraIgtf: false,
    recibeRetencionIva: false,
    recibeRetencionIslr: true,
    muestraResumenIva: false,
    leyendaPdf: "CONTRIBUYENTE FORMAL · SIN DERECHO A CREDITO FISCAL",
  },
  ORDINARIO: {
    tipo: "ORDINARIO",
    etiqueta: "Contribuyente Ordinario (Estándar)",
    etiquetaCorta: "Ordinario",
    icono: "🧾",
    descripcion: "Profesionales, firmas personales y comercios gravados con IVA (16%, 8% o Exento). NO cobra IGTF (0%) aunque reciba divisas, Zelle o Binance.",
    cobraIva: true,
    cobraIgtf: false,
    recibeRetencionIva: true,
    recibeRetencionIslr: true,
    muestraResumenIva: true,
    leyendaPdf: "",
  },
  ESPECIAL: {
    tipo: "ESPECIAL",
    etiqueta: "Contribuyente Especial / SPE (SENIAT)",
    etiquetaCorta: "Especial (SPE)",
    icono: "🏢",
    descripcion: "Sujeto Pasivo Especial notificado formalmente por el SENIAT (SNAT/2026/00099). Cobra IVA y percibe IGTF (3%) por pagos en divisas o criptoactivos.",
    cobraIva: true,
    cobraIgtf: true,
    recibeRetencionIva: true,
    recibeRetencionIslr: true,
    muestraResumenIva: true,
    leyendaPdf: "",
  },
};

export function validarTipoContribuyenteEstricto(valor: unknown): TipoContribuyente | null {
  const s = String(valor ?? "").trim().toUpperCase();
  if (s === "FORMAL" || s === "ORDINARIO" || s === "ESPECIAL") return s;
  return null;
}

export function normalizarTipoContribuyente(valor: unknown, igtfActivoFallback?: unknown): TipoContribuyente {
  const exacto = validarTipoContribuyenteEstricto(valor);
  if (exacto) return exacto;
  const fallback = igtfActivoFallback === true || igtfActivoFallback === 1 || igtfActivoFallback === "1";
  return fallback ? "ESPECIAL" : "ORDINARIO";
}

export function reglasRegimen(tipo: unknown, igtfActivoFallback?: unknown): ReglasRegimen {
  return INFO_REGIMEN[normalizarTipoContribuyente(tipo, igtfActivoFallback)];
}

export async function leerTipoContribuyente(db: D1Database): Promise<TipoContribuyente> {
  const fila = await db
    .prepare(`SELECT tipo_contribuyente, igtf_activo FROM perfil_emisor WHERE id = 1`)
    .first<{ tipo_contribuyente?: string | null; igtf_activo?: number | null }>()
    .catch(async () =>
      db
        .prepare(`SELECT igtf_activo FROM perfil_emisor WHERE id = 1`)
        .first<{ igtf_activo?: number | null }>()
        .catch(() => null),
    );
  return normalizarTipoContribuyente((fila as { tipo_contribuyente?: string | null } | null)?.tipo_contribuyente, fila?.igtf_activo);
}
