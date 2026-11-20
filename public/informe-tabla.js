// Informes de la Fase 6, sin pantalla: convierte lo que devuelve /api/informes/* en un «modelo» de tablas y de ahí se sacan
// la vista del celular, el CSV y el PDF (los tres salen del MISMO modelo, así nunca dicen cosas distintas).
// Modelo: { clave, titulo, periodo, resumen: [[etiqueta, valor]], notas: [texto], secciones: [{ titulo, columnas: [{ t, der }], filas: [[texto]], totales: [[texto]] }] }
// Solo muestra números que ya calculó el servidor; aquí no se hace ninguna cuenta de dinero salvo sumas de la propia pantalla.
import { cantidadTexto } from "./dinero.js";

export const num = (c) => (c == null ? "" : (c / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fecha = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "");
const nroFactura = (n) => (n == null ? "" : String(n).padStart(8, "0"));
const alicuota = (cent) => (cent === 0 ? "Exento" : `${cent / 100}%`);
const MOV = { COMPRA: "Compra", CARGA: "Carga", VENTA: "Venta", DEVOLUCION_VENTA: "Devolución de venta", ANULACION_COMPRA: "Anulación de compra", AJUSTE: "Ajuste" };
const MOTIVO = { DANADO: "Dañado", PERDIDO: "Perdido", GARANTIA: "Garantía", USO_INTERNO: "Uso interno", SOBRANTE: "Sobrante" };
const MEDIO = { APP_SENIAT: "Sistema Digital SENIAT", IMPRENTA_DIGITAL: "Imprenta Digital" };
const izq = (t) => ({ t }), der = (t) => ({ t, der: true });
const periodo = (r) => `Del ${fecha(r.desde)} al ${fecha(r.hasta)}`;

export const hoyCaracas = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export const INFORMES = [
  { clave: "cierre-caja", icono: "🧾", nombre: "Corte X y Cierre Z de Caja", ayuda: "Arqueo diario por forma de pago, numeración y facturación", periodo: true },
  { clave: "ventas", icono: "📒", nombre: "Libro de ventas (Art. 72 RLIVA)", ayuda: "Facturas, Notas de Crédito, Notas de Débito y Retenciones de IVA en Bs.", periodo: true },
  { clave: "compras", icono: "📕", nombre: "Libro de compras (Art. 70 RLIVA)", ayuda: "Compras e IVA crédito fiscal en Bs.", periodo: true },
  { clave: "resumen-iva", icono: "🧮", nombre: "Resumen mensual de IVA y Alcaldía", ayuda: "Cuota tributaria SENIAT, retenciones e Ingresos Brutos Municipales", periodo: true },
  { clave: "islr", icono: "📑", nombre: "Retenciones de ISLR (Decreto 1.808)", ayuda: "Comprobantes recibidos (1% a 34%) y base para relación ARC", periodo: true },
  { clave: "igtf", icono: "💵", nombre: "Declaración de IGTF (3% SENIAT)", ayuda: "Auxiliar de IGTF percibido en divisas (SNAT/2022/000013)", periodo: true },
  { clave: "ganancias", icono: "💰", nombre: "Ganancias", ayuda: "Ingresos menos costos por ítem y cliente", periodo: true },
  { clave: "por-cobrar", icono: "💳", nombre: "Cuentas por cobrar", ayuda: "Saldos pendientes y antigüedad por cliente", periodo: false },
  { clave: "inventario", icono: "📦", nombre: "Inventario valorizado", ayuda: "Existencias y costo promedio ponderado", periodo: true },
];

export function informesDisponibles(estado, esAdmin) {
  const tipo = estado?.negocio?.tipo_contribuyente || "ORDINARIO";
  const esFormal = tipo === "FORMAL";
  const esEspecial = tipo === "ESPECIAL";
  const mostrarIgtf = esEspecial || !!estado?.tiene_documentos_igtf;
  return INFORMES.filter((i) => {
    if (i.clave === "ganancias" && !esAdmin) return false;
    if (i.clave === "igtf" && !mostrarIgtf) return false;
    if (i.clave === "resumen-iva" && esFormal) return false;
    return true;
  }).map((i) => {
    if (esFormal && i.clave === "ventas") {
      return { ...i, nombre: "Relación de ventas (Contribuyente Formal)", ayuda: "Facturas, Notas de Crédito y Notas de Débito exentas en Bs. (SNAT/2011/0071)" };
    }
    if (esFormal && i.clave === "compras") {
      return { ...i, nombre: "Relación de compras (Contribuyente Formal)", ayuda: "Compras, gastos operativos y servicios en Bs. (SNAT/2011/0071)" };
    }
    return i;
  });
}

const METODO_TXT = { PAGO_MOVIL: "Pago móvil", TRANSFERENCIA: "Transferencia", EFECTIVO: "Efectivo", ZELLE: "Zelle", BINANCE: "Binance Pay", PAYPAL: "PayPal", RETENCION_IVA: "Retención IVA SENIAT", RETENCION_ISLR: "Retención ISLR (Decreto 1.808)", OTRO: "Otro" };

function modeloVentas(r, opts = {}) {
  const esFormal = opts?.tipo_contribuyente === "FORMAL";
  const alic = r.alicuotas.map((a) => a.alicuota_cent);
  const hayIgtf = r.filas.some((f) => f.igtf_bs);
  const hayRet = r.filas.some((f) => f.iva_retenido_bs);
  const columnas = [izq("Fecha"), izq("Tipo"), izq("N.º doc."), izq("Factura afectada"), izq("N.º de Control"), izq("Modalidad"), izq("RIF / Cédula"), izq("Cliente"), izq("Estado"),
    ...alic.flatMap((a) => [der(`Base ${alicuota(a)} (Bs)`), ...(a === 0 ? [] : [der(`IVA ${alicuota(a)} (Bs)`)])]),
    ...(hayRet ? [izq("N.º Comp. Retención"), der("IVA Retenido (Bs)")] : []),
    ...(hayIgtf ? [der("IGTF (Bs)"), der("IGTF (USD)")] : []),
    der("Total (Bs)"), der("Total (USD)")];
  const celdasImp = (f) => alic.flatMap((a) => { const i = f.impuestos.find((x) => x.alicuota_cent === a); return [num(i?.base_bs ?? 0), ...(a === 0 ? [] : [num(i?.iva_bs ?? 0)])]; });
  const filas = r.filas.map((f) => {
    const anulada = f.estado === "ANULADO", esNc = !!f.es_nota_credito, esNd = !!f.es_nota_debito;
    const nro = esNc ? `NC-${nroFactura(f.numero)}` : esNd ? `ND-${nroFactura(f.numero)}` : nroFactura(f.numero);
    const afectada = (esNc || esNd) && f.factura_afectada_numero != null ? nroFactura(f.factura_afectada_numero) : "";
    const nroCtrl = f.control_fiscal || (f.control_interno == null ? "" : `00-${nroFactura(f.control_interno)}`);
    const tipoTxt = esNc ? "Nota de crédito" : esNd ? "Nota de débito" : "Factura";
    return [fecha(f.fecha_emision), tipoTxt, nro, afectada, nroCtrl, MEDIO[f.medio] || "App Digital SENIAT", f.cliente_rif || "", f.cliente_nombre || "",
      anulada ? "ANULADA" : "Emitida",
      ...(anulada
        ? [...alic.flatMap((a) => (a === 0 ? [""] : ["", ""])), ...(hayRet ? ["", ""] : []), ...(hayIgtf ? ["", ""] : []), "", ""]
        : [...celdasImp(f), ...(hayRet ? [f.comprobante_retencion || "", num(f.iva_retenido_bs ?? 0)] : []), ...(hayIgtf ? [num(f.igtf_bs ?? 0), num(f.igtf_usd ?? 0)] : []), num(f.total_bs), num(f.total_usd)])];
  });
  const totales = [["TOTAL", "", "", "", "", "", "", "", `${r.n_vigentes} fact. / ${r.n_notas_credito ?? 0} NC${r.n_notas_debito ? ` / ${r.n_notas_debito} ND` : ""}`,
    ...alic.flatMap((a) => { const t = r.alicuotas.find((x) => x.alicuota_cent === a); return [num(t.base_bs), ...(a === 0 ? [] : [num(t.iva_bs)])]; }),
    ...(hayRet ? ["", num(r.iva_retenido_bs ?? 0)] : []),
    ...(hayIgtf ? [num(r.igtf_bs ?? 0), num(r.igtf_usd ?? 0)] : []),
    num(r.total_bs), num(r.total_usd)]];
  return { clave: "ventas", titulo: esFormal ? "Relación de ventas (Contribuyente Formal)" : "Libro de ventas (Art. 72 RLIVA)", periodo: periodo(r),
    resumen: [["Facturas emitidas", String(r.n_vigentes)], ...(r.n_notas_credito ? [["Notas de crédito (restan)", String(r.n_notas_credito)]] : []), ...(r.n_notas_debito ? [["Notas de débito (suman)", String(r.n_notas_debito)]] : []), ["Anuladas (no suman)", String(r.n_anuladas)],
      ...(hayRet ? [["IVA retenido (Bs)", num(r.iva_retenido_bs)]] : []),
      ...(hayIgtf ? [["IGTF en Bs", num(r.igtf_bs)], ["IGTF en USD", num(r.igtf_usd)]] : []),
      ["Total neto en Bs", num(r.total_bs)], ["Total neto en USD", num(r.total_usd)]],
    notas: [esFormal
      ? "Relación de ventas para Contribuyente Formal del IVA (Art. 8 Ley de IVA y Providencias SENIAT SNAT/2011/0071 y SNAT/2024/000102). Operaciones exentas en Bolívares a tasa oficial BCV."
      : "Conforme al Art. 72 del Reglamento de la Ley de IVA y Providencias SENIAT SNAT/2011/0071 y SNAT/2024/000102. Montos expresados en Bolívares a tasa oficial BCV.",
      ...(r.iva_retenido_otros_periodos_bs ? [`Incluye ${num(r.iva_retenido_otros_periodos_bs)} Bs de retenciones de IVA recibidas en este período por facturas de otros meses; se detallan en la sección de retenciones.`] : [])],
    secciones: [{ titulo: "Facturas, Notas de Crédito y Notas de Débito", columnas, filas, totales },
      ...(r.retenciones_periodo?.length ? [{
        titulo: "Retenciones de IVA recibidas en el período (por fecha del comprobante)",
        columnas: [izq("Fecha comprobante"), izq("N.º comprobante"), izq("Factura afectada"), izq("Fecha factura"), izq("RIF cliente"), izq("Cliente"), izq("Factura en este período"), der("IVA retenido (Bs)")],
        filas: r.retenciones_periodo.map((x) => [fecha(x.fecha_pago), x.comprobante_retencion || "", nroFactura(x.factura_numero), fecha(x.factura_fecha_emision), x.cliente_rif || "", x.cliente_nombre || "", x.factura_en_periodo ? "Sí" : "No (otro mes)", num(x.iva_retenido_bs)]),
        totales: [["TOTAL", "", "", "", "", "", `${r.retenciones_periodo.length} comprobante(s)`, num(r.iva_retenido_bs ?? 0)]],
      }] : [])] };
}

const tasaTxt = (e8) => (e8 == null ? "Sin tasa" : (e8 / 1e8).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
const TIPO_COMPRA_TXT = { PRODUCTO: "Mercancía", GASTO: "Gasto / Servicio", MIXTA: "Mixta" };
function modeloCompras(r, opts = {}) {
  const esFormal = opts?.tipo_contribuyente === "FORMAL";
  const alic = r.alicuotas.map((a) => a.alicuota_cent);
  const columnas = [izq("Fecha"), izq("RIF proveedor"), izq("Proveedor"), izq("N.º factura"), izq("N.º control"), izq("Tipo"), izq("Estado"), der("Tasa BCV"),
    ...alic.flatMap((a) => [der(`Base ${alicuota(a)} (Bs)`), ...(a === 0 ? [] : [der(`IVA ${alicuota(a)} (Bs)`)])]), der("Total (Bs)"), der("Total (USD)")];
  const vacias = () => [...alic.flatMap((a) => (a === 0 ? [""] : ["", ""])), ""];
  const filas = r.filas.map((f) => {
    const anulada = f.estado === "ANULADA", tipoTxt = TIPO_COMPRA_TXT[f.tipo_compra] || "Mercancía";
    const base = [fecha(f.fecha), f.proveedor_rif, f.proveedor_nombre, f.factura_numero, f.control_numero || "", tipoTxt, anulada ? "ANULADA" : "Registrada", anulada ? "" : tasaTxt(f.tasa_e8)];
    if (anulada) return [...base, ...vacias(), ""];
    if (f.tasa_e8 == null) return [...base, ...vacias(), num(f.total_usd)]; // compra anterior a la tasa: sin Bs, solo USD
    const celdas = alic.flatMap((a) => { const i = f.impuestos.find((x) => x.alicuota_cent === a); return [num(i?.base_bs ?? 0), ...(a === 0 ? [] : [num(i?.iva_bs ?? 0)])]; });
    return [...base, ...celdas, num(f.total_bs), num(f.total_usd)];
  });
  const totales = [["TOTAL", "", "", "", "", "", `${r.n_vigentes} registrada(s)`, "", ...alic.flatMap((a) => { const t = r.alicuotas.find((x) => x.alicuota_cent === a); return [num(t.base_bs), ...(a === 0 ? [] : [num(t.iva_bs)])]; }), num(r.total_bs), num(r.total_usd)]];
  return { clave: "compras", titulo: esFormal ? "Relación de compras (Contribuyente Formal)" : "Libro de compras (Art. 70 RLIVA)", periodo: periodo(r),
    resumen: [["Compras registradas", String(r.n_vigentes)], ["Anuladas (no suman)", String(r.n_anuladas)], ...(!esFormal ? [["IVA crédito fiscal (Bs)", num(r.iva_bs)]] : [["IVA soportado como costo (Bs)", num(r.iva_bs)]]), ["Total en Bs", num(r.total_bs)],
      ...(r.n_sin_tasa ? [["Sin tasa (no suman en Bs)", String(r.n_sin_tasa)]] : [])],
    notas: [esFormal
      ? "Relación de compras para Contribuyente Formal del IVA (Art. 8 Ley de IVA y SNAT/2011/0071). El IVA pagado en compras forma parte del costo o gasto deducible de ISLR y no genera crédito fiscal."
      : "Conforme al Art. 70 del Reglamento de la Ley de IVA. Incluye compras de mercancía, gastos operativos y servicios registrados en Bolívares a la tasa BCV de cada factura.",
      ...(r.n_sin_tasa ? [`${r.n_sin_tasa} compra(s) previas no registran tasa BCV.`] : [])],
    secciones: [{ titulo: "Compras", columnas, filas, totales }] };
}

const mesTxt = (m) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const resultadoIva = (d) => (d > 0 ? "A pagar" : d < 0 ? "Crédito a favor" : "-");
function modeloResumenIva(r) {
  const cuotaDe = (x) => x.cuota_tributaria_bs ?? (x.diferencia_bs - (x.retenciones_bs ?? 0));
  const fila = (mes, x) => [mes, num(x.ventas_gravadas_bs), num(x.ventas_exentas_bs), num(x.debito_bs), num(x.compras_gravadas_bs), num(x.compras_exentas_bs), num(x.credito_bs), num(x.diferencia_bs), num(x.retenciones_bs ?? 0), num(cuotaDe(x)), resultadoIva(cuotaDe(x))];
  const filaMuni = (mes, x) => [mes, num(x.ventas_gravadas_bs), num(x.ventas_exentas_bs), num(x.ingresos_brutos_bs ?? (x.ventas_gravadas_bs + x.ventas_exentas_bs)), num(x.ingresos_brutos_usd ?? 0)];
  const t = r.total, cuotaTotal = cuotaDe(t);
  return { clave: "resumen-iva", titulo: "Resumen mensual de IVA y Alcaldía", periodo: periodo(r),
    resumen: [
      ["Débito fiscal (ventas)", num(t.debito_bs)],
      ["Crédito fiscal (compras)", num(t.credito_bs)],
      ...(t.retenciones_bs ? [["Retenciones de IVA (Bs)", num(t.retenciones_bs)]] : []),
      [cuotaTotal < 0 ? "Excedente / Crédito a favor" : "Cuota neta a pagar SENIAT", num(Math.abs(cuotaTotal))],
      ["Ingresos Brutos Alcaldía (Bs)", num(t.ingresos_brutos_bs ?? (t.ventas_gravadas_bs + t.ventas_exentas_bs))],
    ],
    notas: [
      "1. Declaración de IVA (Forma 000030 SENIAT): Débito fiscal menos Crédito fiscal menos Retenciones de IVA soportadas en el período.",
      "2. Declaración Municipal de Actividades Económicas (Alcaldía): Ingresos Brutos = Ventas gravadas (base imponible sin IVA) + Ventas exentas, netas de Notas de Crédito (excluye IVA e IGTF).",
      ...(t.compras_sin_tasa ? [`${t.compras_sin_tasa} compra(s) sin tasa BCV no están incluidas en el crédito fiscal.`] : []),
    ],
    secciones: [
      { titulo: "Declaración de IVA por mes (SENIAT Forma 000030)", columnas: [izq("Mes"), der("Ventas gravadas (base)"), der("Ventas exentas"), der("Débito fiscal"), der("Compras gravadas (base)"), der("Compras exentas"), der("Crédito fiscal"), der("Cuota previa"), der("Retenciones IVA"), der("Cuota neta"), izq("Resultado")],
        filas: r.filas.map((x) => fila(mesTxt(x.mes), x)), totales: r.filas.length ? [fila("TOTAL", t)] : [] },
      { titulo: "Ingresos Brutos Municipales (Alcaldía / Actividades Económicas)", columnas: [izq("Mes"), der("Ventas gravadas sin IVA (Bs)"), der("Ventas exentas (Bs)"), der("Ingresos Brutos Netos (Bs)"), der("Ingresos Brutos Ref. (USD)")],
        filas: r.filas.map((x) => filaMuni(mesTxt(x.mes), x)), totales: r.filas.length ? [filaMuni("TOTAL", t)] : [] },
    ] };
}

function modeloIslr(r) {
  const filas = (r.filas || []).map((f) => {
    const docNro = f.es_nota_debito ? `ND-${nroFactura(f.factura_numero)}` : nroFactura(f.factura_numero);
    const ctrl = f.control_fiscal || (f.control_interno == null ? "" : `00-${nroFactura(f.control_interno)}`);
    return [
      fecha(f.fecha_pago),
      nroFactura(f.recibo_numero),
      f.comprobante_retencion || "",
      f.cliente_rif || "",
      f.cliente_nombre || "",
      docNro,
      ctrl,
      `${f.porcentaje_retencion || 0}%`,
      num(f.base_imponible_bs),
      num(f.retenido_bs),
      num(f.retenido_usd),
    ];
  });
  const totales = filas.length
    ? [["TOTAL", "", `${r.n_retenciones} comp.`, "", "", "", "", "", num(r.base_imponible_bs), num(r.total_retenido_bs), num(r.total_retenido_usd)]]
    : [];
  return {
    clave: "islr",
    titulo: "Retenciones de ISLR Recibidas (Decreto 1.808 / Relación ARC)",
    periodo: periodo(r),
    resumen: [
      ["Comprobantes recibidos", String(r.n_retenciones ?? 0)],
      ["Base imponible sujeta (Bs)", num(r.base_imponible_bs ?? 0)],
      ["ISLR retenido total (Bs)", num(r.total_retenido_bs ?? 0)],
      ["ISLR retenido equiv. (USD)", num(r.total_retenido_usd ?? 0)],
    ],
    notas: [
      "Relación auxiliar de comprobantes de Retención de Impuesto Sobre la Renta (ISLR) practicados por clientes conforme al Decreto 1.808 (tarifas vigentes de 1% a 34% sobre la base imponible sin IVA). Respalda la conciliación de anticipos de ISLR y el comprobante anual ARC.",
    ],
    secciones: [
      {
        titulo: "Comprobantes de Retención de ISLR del periodo",
        columnas: [
          izq("Fecha"),
          izq("Recibo N.º"),
          izq("N.º Comprobante"),
          izq("RIF Agente"),
          izq("Cliente / Agente de Retención"),
          izq("Factura / ND"),
          izq("N.º Control"),
          der("% Ret."),
          der("Base Imponible (Bs)"),
          der("ISLR Retenido (Bs)"),
          der("ISLR Retenido (USD)"),
        ],
        filas,
        totales,
      },
    ],
  };
}

function modeloIgtf(r) {
  const filas = r.filas.map((f) => {
    const esNc = !!f.es_nota_credito, esNd = !!f.es_nota_debito;
    const nro = esNc ? `NC-${nroFactura(f.numero)}` : esNd ? `ND-${nroFactura(f.numero)}` : nroFactura(f.numero);
    const nroCtrl = f.control_fiscal || (f.control_interno == null ? "" : `00-${nroFactura(f.control_interno)}`);
    return [fecha(f.fecha_emision), esNc ? "Nota de crédito" : esNd ? "Nota de débito" : "Factura", nro, nroCtrl, f.cliente_rif || "", f.cliente_nombre || "",
      tasaTxt(f.tasa_e8), num(f.base_divisas_bs), num(f.base_divisas_usd), num(f.igtf_bs), num(f.igtf_usd)];
  });
  const totales = r.filas.length ? [["TOTAL", "", "", "", "", `${r.n_documentos} doc(s)`, "", num(r.base_divisas_bs), num(r.base_divisas_usd), num(r.igtf_bs), num(r.igtf_usd)]] : [];
  return { clave: "igtf", titulo: "Declaración de IGTF (3% SENIAT)", periodo: periodo(r),
    resumen: [
      ["Documentos con IGTF", String(r.n_documentos)],
      ["Base cobrada en divisas (USD)", num(r.base_divisas_usd)],
      ["IGTF 3% percibido (Bs)", num(r.igtf_bs)],
      ["IGTF 3% percibido (USD)", num(r.igtf_usd)],
    ],
    notas: ["Auxiliar para la declaración y enteramiento quincenal/mensual del Impuesto a las Grandes Transacciones Financieras (IGTF 3%) percibido por pagos en moneda extranjera o criptoactivos distintos al Bolívar, conforme a la Providencia SENIAT SNAT/2022/000013."],
    secciones: [{ titulo: "Documentos con percepción de IGTF (3%)",
      columnas: [izq("Fecha"), izq("Tipo"), izq("N.º doc."), izq("N.º Control"), izq("RIF / Cédula"), izq("Cliente"), der("Tasa BCV"), der("Base divisas (Bs)"), der("Base divisas (USD)"), der("IGTF 3% (Bs)"), der("IGTF 3% (USD)")],
      filas, totales }] };
}

function modeloCierreCaja(r) {
  const esDia = r.desde === r.hasta;
  const n = r.numeracion, fac = r.facturacion, rec = r.recaudacion;
  const rangoNro = (d, h, pref = "") => (d == null ? "Sin emisiones" : `${pref}${nroFactura(d)} al ${pref}${nroFactura(h)}`);
  const filasNum = [
    ["Facturas", n.factura_desde ? nroFactura(n.factura_desde) : "-", n.factura_hasta ? nroFactura(n.factura_hasta) : "-", String(n.facturas_vigentes), String(n.facturas_anuladas)],
    ["Números de Control Fiscal", n.control_desde ? `00-${nroFactura(n.control_desde)}` : "-", n.control_hasta ? `00-${nroFactura(n.control_hasta)}` : "-", String(n.facturas_vigentes + n.nc_vigentes + (n.nd_vigentes ?? 0)), String(n.facturas_anuladas + n.nc_anuladas + (n.nd_anuladas ?? 0))],
    ["Notas de Crédito", n.nc_desde ? `NC-${nroFactura(n.nc_desde)}` : "-", n.nc_hasta ? `NC-${nroFactura(n.nc_hasta)}` : "-", String(n.nc_vigentes), String(n.nc_anuladas)],
    ["Notas de Débito", n.nd_desde ? `ND-${nroFactura(n.nd_desde)}` : "-", n.nd_hasta ? `ND-${nroFactura(n.nd_hasta)}` : "-", String(n.nd_vigentes ?? 0), String(n.nd_anuladas ?? 0)],
    ["Recibos de Cobro", n.recibo_desde ? nroFactura(n.recibo_desde) : "-", n.recibo_hasta ? nroFactura(n.recibo_hasta) : "-", String(n.recibos_vigentes), String(n.recibos_anuladas)],
  ];
  const filasArqueo = rec.metodos.map((m) => [
    METODO_TXT[m.metodo] || m.metodo,
    m.moneda === "BS" ? "Bolívares (Bs.)" : "Divisas (USD)",
    String(m.operaciones),
    m.moneda === "BS" ? `Bs. ${num(m.monto_moneda)}` : `$ ${num(m.monto_moneda)}`,
    num(m.equiv_bs),
    num(m.equiv_usd),
  ]);
  const totalesArqueo = filasArqueo.length
    ? [["TOTAL EN CAJA", "", String(n.recibos_vigentes), `Bs. ${num(rec.cobrado_bs)} + $ ${num(rec.cobrado_divisas_usd)}`, num(rec.total_equiv_bs), num(rec.total_equiv_usd)]]
    : [];
  const filasFiscal = [
    ...fac.alicuotas.map((a) => [`Ventas ${alicuota(a.alicuota_cent)}`, num(a.base_bs), num(a.iva_bs), num(a.base_usd), num(a.iva_usd)]),
    ...(fac.igtf_bs ? [["IGTF 3% percibido en divisas", num(fac.igtf_bs), "0,00", num(fac.igtf_usd), "0,00"]] : []),
  ];
  const totalesFiscal = [["TOTAL FACTURADO NETO", num(fac.subtotal_bs + fac.igtf_bs), num(fac.iva_bs), num(fac.subtotal_usd + fac.igtf_usd), num(fac.iva_usd)],
    ["TOTAL GENERAL (BASE + IVA + IGTF)", num(fac.total_bs), "", num(fac.total_usd), ""]];
  const filasPagos = rec.pagos.map((p) => {
    const anulado = p.estado === "ANULADO";
    const docTxt = p.doc_tipo === "PRESUPUESTO" ? `P-${String(p.doc_numero ?? "").padStart(6, "0")}` : p.doc_es_nota_debito ? `ND-${nroFactura(p.doc_numero)}` : nroFactura(p.doc_numero);
    const refTxt = p.comprobante_retencion ? `Comp. ${p.comprobante_retencion}` : (p.referencia || "");
    return [
      nroFactura(p.numero),
      fecha(p.fecha_pago),
      docTxt,
      p.cliente_nombre || "",
      METODO_TXT[p.metodo] || p.metodo,
      refTxt,
      anulado ? "ANULADA" : "Vigente",
      anulado ? "" : (p.moneda === "BS" ? `Bs. ${num(p.monto_recibido)}` : `$ ${num(p.monto_recibido)}`),
      anulado ? "" : num(p.monto_usd),
    ];
  });
  return {
    clave: "cierre-caja",
    titulo: esDia ? "Corte X y Cierre Diario Z de Caja" : "Cierre de Caja y Facturación del Periodo",
    periodo: periodo(r),
    resumen: [
      ["Rango facturas", rangoNro(n.factura_desde, n.factura_hasta)],
      ["Facturación neta (Bs)", num(fac.total_bs)],
      ["Facturación neta (USD)", num(fac.total_usd)],
      ["Cobrado en Bs", num(rec.cobrado_bs)],
      ["Cobrado en Divisas (USD)", num(rec.cobrado_divisas_usd)],
      ...(rec.retenciones_iva_bs ? [["Retenciones IVA (Bs)", num(rec.retenciones_iva_bs)]] : []),
      ...(rec.retenciones_islr_bs ? [["Retenciones ISLR (Bs)", num(rec.retenciones_islr_bs)]] : []),
      ["Total recaudado (USD)", num(rec.total_equiv_usd)],
    ],
    notas: [
      "Arqueo operativo de caja y resumen de numeración emitida en modalidades de Facturación Digital (App SENIAT / Imprenta Digital). En estas modalidades las facturas van directo al Libro de Ventas (Art. 72 RLIVA); este reporte respalda el cuadre diario de cajeros y la conciliación bancaria.",
    ],
    secciones: [
      { titulo: "1. Control de correlativos del periodo", columnas: [izq("Documento"), izq("Desde N.º"), izq("Hasta N.º"), der("Vigentes"), der("Anulados")], filas: filasNum, totales: [] },
      { titulo: "2. Arqueo de Caja por forma de pago y moneda", columnas: [izq("Forma de pago"), izq("Moneda"), der("Operaciones"), der("Monto recibido"), der("Equivalente (Bs)"), der("Equivalente (USD)")], filas: filasArqueo, totales: totalesArqueo },
      { titulo: "3. Resumen fiscal de facturación neta (Facturas + ND menos NC)", columnas: [izq("Concepto / Alícuota"), der("Base / Monto (Bs)"), der("IVA (Bs)"), der("Base / Monto (USD)"), der("IVA (USD)")], filas: filasFiscal, totales: totalesFiscal },
      { titulo: "4. Relación detallada de recibos de cobro y retenciones", columnas: [izq("Recibo N.º"), izq("Fecha"), izq("Doc. N.º"), izq("Cliente"), izq("Forma de pago"), izq("Referencia / Comp."), izq("Estado"), der("Monto recibido"), der("Acreditado (USD)")], filas: filasPagos, totales: [] },
    ],
  };
}

function modeloGanancias(r) {
  const cols = (primera) => [izq(primera), der("Ingresos (USD)"), der("Costos (USD)"), der("Ganancia (USD)")];
  const fila = (n, f) => [n, num(f.ingresos), num(f.costos), num(f.ganancia)];
  return { clave: "ganancias", titulo: "Ganancias", periodo: periodo(r),
    resumen: [["Ingresos", num(r.total.ingresos)], ["Costos", num(r.total.costos)], ["Ganancia", num(r.total.ganancia)]],
    notas: ["Reporte gerencial del administrador: Ingresos netos (sin IVA) menos costos registrados en facturas emitidas."],
    secciones: [
      { titulo: "Por tipo", columnas: cols("Tipo"), filas: [fila("Servicios", r.servicios), fila("Productos", r.productos)], totales: [fila("TOTAL", r.total)] },
      { titulo: "Por producto o servicio", columnas: [izq("Tipo"), izq("Nombre"), der("Cantidad"), der("Ingresos (USD)"), der("Costos (USD)"), der("Ganancia (USD)")],
        filas: r.por_item.map((f) => [f.tipo === "SERVICIO" ? "Servicio" : "Producto", f.nombre, cantidadTexto(f.cantidad_milli), num(f.ingresos), num(f.costos), num(f.ganancia)]), totales: [] },
      { titulo: "Por cliente", columnas: [izq("RIF / Cédula"), izq("Cliente"), der("Ingresos (USD)"), der("Costos (USD)"), der("Ganancia (USD)")],
        filas: r.por_cliente.map((f) => [f.rif, f.nombre || "", num(f.ingresos), num(f.costos), num(f.ganancia)]), totales: [] }] };
}

function modeloPorCobrar(r) {
  const filas = [];
  for (const c of r.clientes) {
    for (const f of c.facturas) filas.push([c.nombre || "", c.rif, f.es_nota_debito ? `ND-${nroFactura(f.numero)}` : nroFactura(f.numero), fecha(f.fecha_emision), fecha(f.vence_el), f.dias_atraso > 0 ? String(f.dias_atraso) : "", num(f.total_usd), num(f.pagado_usd), num(f.saldo_usd)]);
    if (c.facturas.length > 1) filas.push([`Subtotal ${c.nombre || ""}`, "", "", "", "", "", "", "", num(c.saldo_usd)]);
  }
  return { clave: "por-cobrar", titulo: "Cuentas por cobrar", periodo: `Al ${fecha(r.hoy)}`,
    resumen: [["Por cobrar", num(r.total_usd)], ["Facturas con saldo", String(r.n_facturas)], ["Clientes", String(r.clientes.length)]],
    notas: ["El saldo es el total de la factura o nota de débito menos los pagos vigentes (incluye abonos hechos al presupuesto de origen). La antigüedad cuenta los días pasados desde el vencimiento."],
    secciones: [
      { titulo: "Antigüedad de saldos", columnas: [izq("Tramo"), der("Saldo (USD)")], filas: r.tramos.map((t) => [t.etiqueta, num(t.saldo_usd)]), totales: [["TOTAL", num(r.total_usd)]] },
      { titulo: "Estado de cuenta por cliente", columnas: [izq("Cliente"), izq("RIF / Cédula"), izq("N.º doc."), izq("Emisión"), izq("Vence"), der("Días de atraso"), der("Total (USD)"), der("Pagado (USD)"), der("Saldo (USD)")],
        filas, totales: [["TOTAL", "", "", "", "", "", "", "", num(r.total_usd)]] }] };
}

function modeloInventario(r) {
  return { clave: "inventario", titulo: "Inventario valorizado", periodo: `Existencias a hoy · movimientos ${periodo(r).toLowerCase()}`,
    resumen: [["Valor del inventario (USD)", num(r.valor_total_usd)], ["Productos", String(r.items.length)], ["Movimientos del periodo", String(r.movimientos_n)]],
    notas: ["Valor = suma de los movimientos de cada producto (costo promedio ponderado). Solo productos con control de existencias.",
      ...(r.movimientos_recortados ? [`Se muestran los últimos ${r.movimientos.length} de ${r.movimientos_n} movimientos; acorta el periodo para ver los demás.`] : [])],
    secciones: [
      { titulo: "Existencias valorizadas", columnas: [izq("Código"), izq("Producto"), der("Existencias"), der("Costo promedio (USD)"), der("Valor (USD)")],
        filas: r.items.map((p) => [p.codigo || "", p.nombre, cantidadTexto(p.stock_milli), num(p.costo_prom_usd), num(p.valor_usd)]), totales: [["TOTAL", "", "", "", num(r.valor_total_usd)]] },
      { titulo: "Resumen de movimientos del periodo", columnas: [izq("Tipo"), der("Movimientos"), der("Valor (USD)")],
        filas: r.resumen_movimientos.map((m) => [MOV[m.tipo] || m.tipo, String(m.n), num(m.valor_usd)]), totales: [] },
      { titulo: "Movimientos del periodo", columnas: [izq("Fecha"), izq("Producto"), izq("Tipo"), izq("Motivo"), der("Cantidad"), der("Valor (USD)")],
        filas: r.movimientos.map((m) => [fecha(m.fecha), m.producto, MOV[m.tipo] || m.tipo, MOTIVO[m.motivo] || "", cantidadTexto(m.cantidad_milli), num(m.valor_usd)]), totales: [] }] };
}

export const construirModelo = (clave, datos, opts = {}) => ({
  "cierre-caja": modeloCierreCaja,
  ventas: modeloVentas,
  compras: modeloCompras,
  "resumen-iva": modeloResumenIva,
  islr: modeloIslr,
  igtf: modeloIgtf,
  ganancias: modeloGanancias,
  "por-cobrar": modeloPorCobrar,
  inventario: modeloInventario,
})[clave](datos, opts);

// ---------------------------------------------------------------- CSV (separador «;» y coma decimal: abre bien en Excel en español)
const celdaCsv = (t) => { let s = String(t ?? "").replace(/\r?\n/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  if (/^[=+\-@\t]/.test(s) && !/^-?[\d.,]+$/.test(s)) s = `'${s}`; // evita que Excel trate un texto como fórmula
  return /[;"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const sinPuntos = (t) => (/^-?\d{1,3}(\.\d{3})*,\d{2}$/.test(t) ? t.replace(/\./g, "") : t); // 1.234,56 -> 1234,56 (número limpio para Excel)
export function aCsv(m, negocio) {
  const linea = (xs) => xs.map(celdaCsv).join(";");
  const out = [linea([negocio?.nombre_razon_social || ""]), linea([negocio?.rif || ""]), linea([m.titulo]), linea([m.periodo])];
  for (const s of m.secciones) {
    out.push("", linea([s.titulo]), linea(s.columnas.map((c) => c.t)), ...s.filas.map((f) => linea(f.map(sinPuntos))), ...s.totales.map((f) => linea(f.map(sinPuntos))));
  }
  return "\uFEFF" + out.join("\r\n") + "\r\n";
}
export const nombreArchivoInforme = (m, modo, ext, r) => `${modo === "PRACTICA" ? "PRACTICA-" : ""}${m.titulo.replace(/ /g, "-").normalize("NFD").replace(/[\u0300-\u036f]/g, "")}${r?.desde ? `_${r.desde}_${r.hasta}` : `_${r?.hoy || ""}`}.${ext}`;

// ---------------------------------------------------------------- PDF (horizontal, tabla con encabezado repetido en cada página)
export async function construirPdfInforme(L, m, { negocio, modo }) {
  const { PDFDocument, StandardFonts, rgb } = L;
  const pdf = await PDFDocument.create(), f = await pdf.embedFont(StandardFonts.Helvetica), fb = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logoImg = null;
  if (negocio?.logo_base64 && typeof negocio.logo_base64 === "string" && negocio.logo_base64.startsWith("data:image/")) {
    try { logoImg = negocio.logo_base64.startsWith("data:image/png") ? await pdf.embedPng(negocio.logo_base64) : await pdf.embedJpg(negocio.logo_base64); } catch {}
  }
  const permitido = new Set(f.getCharacterSet());
  const limpio = (t) => [...String(t ?? "").replace(/\s+/g, " ").trim()].map((ch) => (permitido.has(ch.codePointAt(0)) ? ch : "?")).join("");
  const ANCHO = 841.89, ALTO = 595.28, M = 32, UTIL = ANCHO - 2 * M, paginas = [];
  let pag, y;
  const nueva = () => {
    pag = pdf.addPage([ANCHO, ALTO]); paginas.push(pag); y = ALTO - M;
    if (modo === "PRACTICA") pag.drawText("PRACTICA - SIN VALOR", { x: ANCHO - M - 110, y: ALTO - 20, size: 8, font: fb, color: rgb(0.85, 0.15, 0.15) });
  };
  const recortar = (t, w, size, fuente) => { t = limpio(t); if (fuente.widthOfTextAtSize(t, size) <= w) return t; while (t.length > 1 && fuente.widthOfTextAtSize(t + "…", size) > w) t = t.slice(0, -1); return t + "…"; };
  const texto = (t, x, size, fuente, opc = {}) => pag.drawText(limpio(t), { x, y, size, font: fuente, color: opc.color || rgb(0.1, 0.1, 0.1) });
  nueva();
  if (logoImg) {
    const esc = Math.min(95 / logoImg.width, 32 / logoImg.height, 1);
    const lw = logoImg.width * esc, lh = logoImg.height * esc;
    pag.drawImage(logoImg, { x: ANCHO - M - lw, y: ALTO - M - lh + 6, width: lw, height: lh });
  }
  texto(negocio?.nombre_razon_social || "", M, 13, fb); y -= 14; texto(`RIF ${negocio?.rif || ""}`, M, 9, f); y -= 20;
  texto(m.titulo, M, 16, fb, { color: rgb(0.1, 0.45, 0.91) }); y -= 14; texto(m.periodo + (modo === "PRACTICA" ? " · DATOS DE PRACTICA" : ""), M, 9, f); y -= 14;
  texto(m.resumen.map(([k, v]) => `${k}: ${v}`).join("   ·   "), M, 9, fb); y -= 16;
  for (const n of m.notas) { const t = limpio(n), partes = []; let r = t; // notas en varias líneas
    while (r.length) { let k = r.length; while (k > 1 && f.widthOfTextAtSize(r.slice(0, k), 7.5) > UTIL) k = r.lastIndexOf(" ", k - 1) > 0 ? r.lastIndexOf(" ", k - 1) : 1; partes.push(r.slice(0, k)); r = r.slice(k).trim(); }
    for (const p of partes) { texto(p, M, 7.5, f, { color: rgb(0.4, 0.4, 0.4) }); y -= 9.5; } }
  y -= 6;
  for (const s of m.secciones) {
    // ancho de cada columna según su contenido, reducido en proporción si no cabe en la hoja
    let size = 8; const todas = [s.columnas.map((c) => c.t), ...s.filas, ...s.totales];
    const medir = (sz) => s.columnas.map((_, i) => Math.min(Math.max(...todas.map((fila) => fb.widthOfTextAtSize(limpio(fila[i]), sz))) + 8, i === 0 || s.columnas.length < 6 ? 260 : 150));
    let anchos = medir(size); while (anchos.reduce((a, b) => a + b, 0) > UTIL && size > 5.5) { size -= 0.5; anchos = medir(size); }
    const total = anchos.reduce((a, b) => a + b, 0); if (total > UTIL) anchos = anchos.map((w) => (w * UTIL) / total);
    const alto = size + 6;
    const encabezado = () => { pag.drawRectangle({ x: M, y: y - 3, width: anchos.reduce((a, b) => a + b, 0), height: alto, color: rgb(0.93, 0.95, 0.99) });
      let x = M; s.columnas.forEach((c, i) => { const t = recortar(c.t, anchos[i] - 6, size, fb); pag.drawText(t, { x: c.der ? x + anchos[i] - 3 - fb.widthOfTextAtSize(t, size) : x + 3, y, size, font: fb, color: rgb(0.1, 0.1, 0.1) }); x += anchos[i]; }); y -= alto; };
    if (y < M + 70) nueva();
    texto(s.titulo, M, 10.5, fb); y -= 14; encabezado();
    const fila = (celdas, negrita) => {
      if (y < M + alto) { nueva(); encabezado(); }
      let x = M; s.columnas.forEach((c, i) => { const t = recortar(celdas[i], anchos[i] - 6, size, negrita ? fb : f);
        pag.drawText(t, { x: c.der ? x + anchos[i] - 3 - (negrita ? fb : f).widthOfTextAtSize(t, size) : x + 3, y, size, font: negrita ? fb : f, color: rgb(0.1, 0.1, 0.1) }); x += anchos[i]; });
      y -= alto;
    };
    if (!s.filas.length) { texto("Sin datos en este periodo.", M + 3, size, f); y -= alto; }
    s.filas.forEach((c) => fila(c, /^(Subtotal|TOTAL)/.test(c[0])));
    s.totales.forEach((c) => fila(c, true));
    y -= 12;
  }
  const generado = `Generado el ${hoyCaracas().split("-").reverse().join("/")} · Normativa SENIAT (RLIVA / SNAT/2011/0071)`;
  paginas.forEach((p, i) => { const t = limpio(`${generado} · Página ${i + 1} de ${paginas.length}`); p.drawText(t, { x: M, y: 14, size: 7, font: f, color: rgb(0.45, 0.45, 0.45) }); });
  return pdf.save();
}
