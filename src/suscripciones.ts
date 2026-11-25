// Motor de Suscripciones y Cobro Mensual SaaS (v4.8) para FacturaYa Venezuela.
// Reglas contables estrictas:
// 1. Toda matemática monetaria corre en centavos enteros (public/dinero.js), cero floats.
// 2. Corte día 1 con prorrateo exacto en el primer mes según fecha_alta.
// 3. Tarifa escalonada por defecto: $5 (500 centavos) los primeros 3 meses -> $10 (1000 centavos) desde el mes 4, a tasa BCV.
// 4. Reutiliza el motor fiscal atómico de la empresa principal (correlativos atómicos + PDF o Imprenta Digital API si está activa).
// 5. Idempotencia por (inquilino_codigo, periodo_ym) y NUNCA suspende cuentas automáticamente.
import { aRifSeniat, aTasaE8, calcular } from "../public/dinero.js";
import { PAGADO, fechaCaracas, masDias, modoActual, parametrosVigentes } from "./comun";
import { enviarCorreo } from "./correo";
import { asegurarTablasMultiTenant } from "./inquilinos";
import { normalizarTipoContribuyente, reglasRegimen } from "./regimen";
import { solicitarControlImprentaDigital } from "./rutas/sistema";
import { sha256 } from "./seguridad";

export const PRECIO_PROMO_DEFECTO_CENT = 500; // USD 5,00
export const MESES_PROMO_DEFECTO = 3;
export const PRECIO_REGULAR_DEFECTO_CENT = 1000; // USD 10,00

export type EntradaCalculoSuscripcion = {
  fecha_alta: string; // YYYY-MM-DD
  periodo_ym: string; // YYYY-MM
  precio_promo_usd_cent?: number;
  meses_promo?: number;
  precio_regular_usd_cent?: number;
  tasa_e8: number;
  alicuota_cent?: number; // 0 (Formal) o 1600 (Ordinario/Especial)
};

export type ResultadoCalculoSuscripcion = {
  periodo_ym: string;
  indice_mes: number;
  es_promo: boolean;
  prorrateado: boolean;
  dias_cobrados: number;
  dias_mes: number;
  tarifa_mensual_usd_cent: number;
  subtotal_usd_cent: number;
  iva_usd_cent: number;
  total_usd_cent: number;
  subtotal_bs_cent: number;
  iva_bs_cent: number;
  total_bs_cent: number;
  alicuota_cent: number;
  concepto: string;
};

export function diasEnMes(anio: number, mes1a12: number): number {
  return new Date(Date.UTC(anio, mes1a12, 0)).getUTCDate();
}

function parseFechaIso(f: string): { anio: number; mes: number; dia: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(f || "").trim());
  if (!m) return null;
  const anio = Number(m[1]), mes = Number(m[2]), dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return { anio, mes, dia };
}

function parsePeriodoYm(p: string): { anio: number; mes: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(p || "").trim());
  if (!m) return null;
  const anio = Number(m[1]), mes = Number(m[2]);
  if (mes < 1 || mes > 12) return null;
  return { anio, mes };
}

// Función pura de cálculo en centavos enteros (sin efectos secundarios, 100% testeable)
export function calcularCobroSuscripcion(entrada: EntradaCalculoSuscripcion): ResultadoCalculoSuscripcion {
  const alta = parseFechaIso(entrada.fecha_alta);
  const per = parsePeriodoYm(entrada.periodo_ym);
  if (!alta) throw new Error("Fecha de alta inválida (usa formato AAAA-MM-DD).");
  if (!per) throw new Error("Período inválido (usa formato AAAA-MM).");
  if (!Number.isInteger(entrada.tasa_e8) || entrada.tasa_e8 <= 0) {
    throw new Error("Tasa BCV inválida para calcular el cobro.");
  }

  const indiceMes = (per.anio - alta.anio) * 12 + (per.mes - alta.mes) + 1;
  if (indiceMes < 1) {
    throw new Error(`La empresa se dio de alta el ${entrada.fecha_alta.slice(0, 10)}, posterior al período ${entrada.periodo_ym}.`);
  }

  const precioPromo = Math.max(0, Math.trunc(Number(entrada.precio_promo_usd_cent ?? PRECIO_PROMO_DEFECTO_CENT)));
  const mesesPromo = Math.max(0, Math.trunc(Number(entrada.meses_promo ?? MESES_PROMO_DEFECTO)));
  const precioRegular = Math.max(0, Math.trunc(Number(entrada.precio_regular_usd_cent ?? PRECIO_REGULAR_DEFECTO_CENT)));
  const esPromo = mesesPromo > 0 && indiceMes <= mesesPromo;
  const tarifaMensual = esPromo ? precioPromo : precioRegular;
  if (tarifaMensual <= 0) {
    throw new Error("La tarifa mensual configurada para esta empresa debe ser mayor a USD 0,00.");
  }

  const dMes = diasEnMes(per.anio, per.mes);
  const prorrateado = indiceMes === 1 && alta.dia > 1;
  const diaInicio = prorrateado ? Math.min(alta.dia, dMes) : 1;
  const diasCobrados = prorrateado ? Math.max(1, dMes - diaInicio + 1) : dMes;
  const montoBaseUsdCent = prorrateado
    ? Math.max(1, Math.round((tarifaMensual * diasCobrados) / dMes))
    : tarifaMensual;

  const alicuotaCent = Number(entrada.alicuota_cent ?? 0) === 1600 ? 1600 : Number(entrada.alicuota_cent ?? 0) === 800 ? 800 : 0;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const concepto = prorrateado
    ? `Suscripción FacturaYa Venezuela (${entrada.periodo_ym} · Prorrateo ${pad2(diaInicio)}/${pad2(per.mes)} al ${pad2(dMes)}/${pad2(per.mes)} · ${diasCobrados}/${dMes} días)`
    : `Suscripción mensual FacturaYa Venezuela (${entrada.periodo_ym} · ${esPromo ? `Tarifa promocional mes ${indiceMes} de ${mesesPromo}` : "Tarifa regular"})`;

  const calc = calcular(
    [{ cantidad_milli: 1000, precio_usd: montoBaseUsdCent, alicuota_cent: alicuotaCent, costo_usd: null }],
    entrada.tasa_e8,
    { aplica_igtf: false, igtf_alicuota_cent: 300 }
  );

  return {
    periodo_ym: entrada.periodo_ym,
    indice_mes: indiceMes,
    es_promo: esPromo,
    prorrateado,
    dias_cobrados: diasCobrados,
    dias_mes: dMes,
    tarifa_mensual_usd_cent: tarifaMensual,
    subtotal_usd_cent: calc.subtotal_usd,
    iva_usd_cent: calc.iva_usd,
    total_usd_cent: calc.total_usd,
    subtotal_bs_cent: calc.subtotal_bs,
    iva_bs_cent: calc.iva_bs,
    total_bs_cent: calc.total_bs,
    alicuota_cent: alicuotaCent,
    concepto,
  };
}

const escHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);

const fmtCent = (c: number) => (c / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ETIQUETA_METODO: Record<string, string> = {
  PAGO_MOVIL: "Pago Móvil (Bs)",
  TRANSFERENCIA: "Transferencia Bancaria",
  BINANCE: "Binance Pay (USDT)",
  ZELLE: "Zelle (USD)",
  PAYPAL: "PayPal (USD)",
  EFECTIVO: "Efectivo",
};

export type MetodoCobroResumen = { metodo: string; etiqueta: string; lineas: string[] };

export async function leerMetodosCobroPrincipal(rawDb: D1Database): Promise<MetodoCobroResumen[]> {
  const { results } = await rawDb
    .prepare(`SELECT metodo, datos_json FROM metodos_cobro WHERE activo = 1 ORDER BY rowid`)
    .all<{ metodo: string; datos_json: string }>()
    .catch(() => ({ results: [] as { metodo: string; datos_json: string }[] }));

  const salida: MetodoCobroResumen[] = [];
  for (const r of results || []) {
    if (r.metodo === "EFECTIVO") continue;
    let d: Record<string, string> = {};
    try { d = JSON.parse(r.datos_json || "{}"); } catch { d = {}; }
    const lineas: string[] = [];
    if (d.banco) lineas.push(`Banco: ${d.banco}`);
    if (d.telefono) lineas.push(`Teléfono: ${d.telefono}`);
    if (d.cuenta) lineas.push(`Cuenta (${d.tipo || "Corriente"}): ${d.cuenta}`);
    if (d.titular) lineas.push(`Titular: ${d.titular}`);
    if (d.documento) lineas.push(`Cédula / RIF: ${d.documento}`);
    if (d.contacto) lineas.push(`Cuenta / Correo / ID: ${d.contacto}`);
    if (d.nota) lineas.push(`Nota: ${d.nota}`);
    if (lineas.length) {
      salida.push({ metodo: r.metodo, etiqueta: ETIQUETA_METODO[r.metodo] || r.metodo, lineas });
    }
  }
  return salida;
}

function construirCorreoCobroSaas(datos: {
  nombreNegocio: string;
  rifNegocio: string;
  nombreAdmin: string;
  emisorNombre: string;
  emisorRif: string;
  numeroFactura: string;
  controlTexto: string;
  fechaEmision: string;
  periodoYm: string;
  concepto: string;
  subtotalUsdCent: number;
  ivaUsdCent: number;
  totalUsdCent: number;
  totalBsCent: number;
  tasaTexto: string;
  alicuotaCent: number;
  metodos: MetodoCobroResumen[];
}): { asunto: string; html: string; texto: string } {
  const asunto = `Factura N.º ${datos.numeroFactura} · Suscripción FacturaYa Venezuela (${datos.periodoYm})`;
  const bloqueMetodosHtml = datos.metodos.length
    ? datos.metodos
        .map(
          (m) => `<div style="padding:10px 12px;border:1px solid #d5e1ee;border-radius:10px;background:#ffffff;margin-bottom:8px">
            <div style="font-weight:700;color:#0A1F3C;margin-bottom:4px">${escHtml(m.etiqueta)}</div>
            <div style="font-size:13px;color:#334155;line-height:1.5">${m.lineas.map((l) => escHtml(l)).join("<br>")}</div>
          </div>`
        )
        .join("")
    : `<p style="margin:0;font-size:13px;color:#475569">Solicita los datos vigentes de Pago Móvil o Binance respondiendo a <b>pagos@facturayave.com</b>.</p>`;

  const bloqueMetodosTxt = datos.metodos.length
    ? datos.metodos.map((m) => `* ${m.etiqueta}: ${m.lineas.join(" | ")}`).join("\n")
    : "* Solicita los datos vigentes respondiendo a pagos@facturayave.com.";

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;line-height:1.55">
    <div style="background:#0A1F3C;color:#ffffff;padding:20px 22px;border-radius:14px 14px 0 0">
      <div style="font-size:12px;opacity:.8;letter-spacing:.04em;text-transform:uppercase">${escHtml(datos.emisorNombre)} · RIF ${escHtml(datos.emisorRif)}</div>
      <h2 style="margin:6px 0 0;font-size:20px">Factura N.º ${escHtml(datos.numeroFactura)} · Suscripción ${escHtml(datos.periodoYm)}</h2>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:0;padding:22px;border-radius:0 0 14px 14px;background:#f8fafc">
      <p style="margin:0 0 12px">Hola <b>${escHtml(datos.nombreAdmin)}</b>,</p>
      <p style="margin:0 0 16px">Adjuntamos el detalle de tu factura emitida correspondiente al servicio de software <b>FacturaYa Venezuela</b> para <b>${escHtml(datos.nombreNegocio)} (${escHtml(datos.rifNegocio)})</b>:</p>

      <div style="background:#ffffff;border:1px solid #d5e1ee;border-radius:12px;padding:16px;margin-bottom:16px">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:5px 0;color:#64748b">Factura N.º</td><td style="padding:5px 0;text-align:right;font-weight:700">${escHtml(datos.numeroFactura)}</td></tr>
          <tr><td style="padding:5px 0;color:#64748b">Control</td><td style="padding:5px 0;text-align:right;font-weight:600">${escHtml(datos.controlTexto)}</td></tr>
          <tr><td style="padding:5px 0;color:#64748b">Fecha de emisión</td><td style="padding:5px 0;text-align:right">${escHtml(datos.fechaEmision)}</td></tr>
          <tr><td style="padding:5px 0;color:#64748b">Concepto</td><td style="padding:5px 0;text-align:right">${escHtml(datos.concepto)}</td></tr>
          <tr><td style="padding:5px 0;color:#64748b">Tasa oficial BCV</td><td style="padding:5px 0;text-align:right">Bs. ${escHtml(datos.tasaTexto)} / USD</td></tr>
          ${datos.alicuotaCent > 0
            ? `<tr><td style="padding:5px 0;color:#64748b">Base imponible</td><td style="padding:5px 0;text-align:right">USD ${fmtCent(datos.subtotalUsdCent)}</td></tr>
               <tr><td style="padding:5px 0;color:#64748b">IVA (${(datos.alicuotaCent / 100).toFixed(0)}%)</td><td style="padding:5px 0;text-align:right">USD ${fmtCent(datos.ivaUsdCent)}</td></tr>`
            : ""}
          <tr style="border-top:1px solid #e2e8f0">
            <td style="padding:10px 0 4px;font-weight:700;font-size:15px">Total a pagar (USD ref.)</td>
            <td style="padding:10px 0 4px;text-align:right;font-weight:700;font-size:16px;color:#0A1F3C">USD ${fmtCent(datos.totalUsdCent)}</td>
          </tr>
          <tr>
            <td style="padding:2px 0;font-weight:700;font-size:15px">Total legal en Bolívares (BCV)</td>
            <td style="padding:2px 0;text-align:right;font-weight:800;font-size:17px;color:#146C2E">Bs. ${fmtCent(datos.totalBsCent)}</td>
          </tr>
        </table>
      </div>

      <h3 style="margin:0 0 8px;font-size:15px;color:#0A1F3C">💳 Datos para realizar tu pago</h3>
      ${bloqueMetodosHtml}

      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 14px;margin:14px 0;font-size:13.5px;color:#1e3a8a">
        <b>📩 ¿Cómo reportar tu pago?</b><br>
        Responde directamente a este correo (<b>pagos@facturayave.com</b>) adjuntando la <b>captura del Pago Móvil o comprobante de Binance</b> indicando el nombre de tu empresa o RIF.
      </div>

      <p style="margin:12px 0 0;font-size:12px;color:#64748b">
        Nota: Esta suscripción cubre exclusivamente la plataforma de software <b>FacturaYa Venezuela</b> (https://facturayave.com). En caso de utilizar Imprenta Digital Autorizada, los paquetes de timbres se contratan y pagan directamente a tu imprenta digital.
      </p>
    </div>
  </div>`;

  const texto = [
    `${datos.emisorNombre} (RIF ${datos.emisorRif})`,
    `Factura N.° ${datos.numeroFactura} · Control: ${datos.controlTexto}`,
    `Fecha: ${datos.fechaEmision} · Cliente: ${datos.nombreNegocio} (${datos.rifNegocio})`,
    `Concepto: ${datos.concepto}`,
    `Tasa BCV: Bs. ${datos.tasaTexto} / USD`,
    `Total USD: USD ${fmtCent(datos.totalUsdCent)}`,
    `Total Bs (BCV): Bs. ${fmtCent(datos.totalBsCent)}`,
    "",
    "Datos para pagar:",
    bloqueMetodosTxt,
    "",
    "Reporta tu pago respondiendo a este correo (pagos@facturayave.com) con la captura del Pago Móvil o Binance.",
    "Nota: Esta suscripción cubre solo el software FacturaYa Venezuela; la Imprenta Digital se paga directamente a tu proveedor de imprenta.",
  ].join("\n");

  return { asunto, html, texto };
}

export async function sincronizarClienteEnPrincipal(
  rawDb: D1Database,
  inq: { rif: string; nombre_negocio: string; direccion: string; telefono: string; email_dueno: string }
): Promise<number> {
  const rifNorm = aRifSeniat(inq.rif || "");
  const existente = await rawDb
    .prepare(`SELECT id FROM clientes WHERE upper(rif_cedula) = upper(?) LIMIT 1`)
    .bind(rifNorm)
    .first<{ id: number }>();

  if (existente?.id) {
    await rawDb
      .prepare(`UPDATE clientes SET nombre_apellido = ?, direccion = ?, whatsapp = ?, email = ? WHERE id = ?`)
      .bind(inq.nombre_negocio, inq.direccion || null, inq.telefono || null, inq.email_dueno || null, existente.id)
      .run();
    return existente.id;
  }

  const ins = await rawDb
    .prepare(`INSERT INTO clientes (rif_cedula, nombre_apellido, direccion, whatsapp, email) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .bind(rifNorm, inq.nombre_negocio, inq.direccion || null, inq.telefono || null, inq.email_dueno || null)
    .first<{ id: number }>();
  if (!ins?.id) throw new Error("No se pudo registrar la empresa cliente en tu negocio principal.");
  return ins.id;
}

export type FilaCobroSaas = {
  id: number;
  inquilino_codigo: string;
  periodo_ym: string;
  documento_id: number | null;
  numero_factura: number | null;
  control_fiscal: string | null;
  medio: string;
  monto_usd_cent: number;
  total_usd_cent: number;
  total_bs_cent: number;
  tasa_e8: number;
  prorrateado: number;
  dias_cobrados: number;
  dias_mes: number;
  es_promo: number;
  concepto: string;
  estado: string;
  correo_enviado: number;
  correo_error: string;
  referencia_pago: string;
  enviado_en: string;
  pagado_en: string | null;
};

// Emite la factura real en tu empresa principal (PDF local o Imprenta Digital API si está configurada)
// y despacha el correo con datos de Pago Móvil/Binance y Reply-To: pagos@facturayave.com.
export async function emitirYEnviarCobroSaas(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  opciones: {
    codigo: string;
    periodoYm?: string;
    usuarioId: number;
    forzarReenvioCorreo?: boolean;
    soloVistaPrevia?: boolean;
  }
): Promise<{
  ok: true;
  vista_previa?: boolean;
  ya_existia?: boolean;
  calculo: ResultadoCalculoSuscripcion;
  cobro?: FilaCobroSaas;
  metodos: MetodoCobroResumen[];
  emisor_medio: string;
  tasa_bcv: number;
  correo?: { enviado: boolean; motivo?: string; proveedor?: string };
}> {
  await asegurarTablasMultiTenant(rawDb, envObj);
  const codigo = opciones.codigo.trim();
  if (!codigo || codigo === "principal") {
    throw new Error("No se puede emitir cobro SaaS a tu propia empresa principal.");
  }

  const inq = await rawDb
    .prepare(
      `SELECT codigo, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, activo, creado_en,
              COALESCE(NULLIF(fecha_alta, ''), substr(creado_en, 1, 10)) AS fecha_alta,
              COALESCE(precio_promo_usd_cent, 500) AS precio_promo_usd_cent,
              COALESCE(meses_promo, 3) AS meses_promo,
              COALESCE(precio_regular_usd_cent, 1000) AS precio_regular_usd_cent,
              COALESCE(cobro_auto_dia1, 0) AS cobro_auto_dia1
       FROM _mt_inquilinos WHERE codigo = ?`
    )
    .bind(codigo)
    .first<Record<string, any>>();
  if (!inq) throw new Error("Empresa cliente no encontrada.");

  const perfil = await rawDb
    .prepare(
      `SELECT nombre_razon_social, rif, direccion_fiscal, telefono, email, tasa_bcv, tasa_bcv_fecha,
              medio_facturacion, tipo_contribuyente, igtf_activo, logo_base64
       FROM perfil_emisor WHERE id = 1`
    )
    .first<Record<string, any>>();
  if (!perfil) throw new Error("Configura primero los datos fiscales de tu empresa principal en Ajustes.");

  const tasaE8 = aTasaE8(String(perfil.tasa_bcv ?? ""));
  if (!tasaE8 || Number.isNaN(tasaE8) || tasaE8 <= 0) {
    throw new Error("Define o sincroniza la tasa BCV oficial en tu empresa principal antes de facturar.");
  }

  const hoy = fechaCaracas();
  const periodoYm = opciones.periodoYm && /^\d{4}-\d{2}$/.test(opciones.periodoYm) ? opciones.periodoYm : hoy.slice(0, 7);
  const reglasTipo = reglasRegimen(perfil.tipo_contribuyente, perfil.igtf_activo);
  const alicuotaCent = reglasTipo.cobraIva ? 1600 : 0;

  const calculo = calcularCobroSuscripcion({
    fecha_alta: String(inq.fecha_alta || hoy),
    periodo_ym: periodoYm,
    precio_promo_usd_cent: Number(inq.precio_promo_usd_cent ?? PRECIO_PROMO_DEFECTO_CENT),
    meses_promo: Number(inq.meses_promo ?? MESES_PROMO_DEFECTO),
    precio_regular_usd_cent: Number(inq.precio_regular_usd_cent ?? PRECIO_REGULAR_DEFECTO_CENT),
    tasa_e8: tasaE8,
    alicuota_cent: alicuotaCent,
  });

  const metodos = await leerMetodosCobroPrincipal(rawDb);
  const emisorMedio = perfil.medio_facturacion === "IMPRENTA_DIGITAL" ? "IMPRENTA_DIGITAL" : "APP_SENIAT";

  if (opciones.soloVistaPrevia) {
    const existentePrev = await rawDb
      .prepare(`SELECT * FROM _mt_cobros_saas WHERE inquilino_codigo = ? AND periodo_ym = ?`)
      .bind(codigo, periodoYm)
      .first<FilaCobroSaas>();
    return {
      ok: true,
      vista_previa: true,
      ya_existia: Boolean(existentePrev),
      cobro: existentePrev || undefined,
      calculo,
      metodos,
      emisor_medio: emisorMedio,
      tasa_bcv: Number(perfil.tasa_bcv),
    };
  }

  // Idempotencia estricta: nunca emitir dos facturas para el mismo inquilino y período
  const existente = await rawDb
    .prepare(`SELECT * FROM _mt_cobros_saas WHERE inquilino_codigo = ? AND periodo_ym = ?`)
    .bind(codigo, periodoYm)
    .first<FilaCobroSaas>();

  if (existente) {
    if (!opciones.forzarReenvioCorreo) {
      return {
        ok: true,
        ya_existia: true,
        calculo,
        cobro: existente,
        metodos,
        emisor_medio: existente.medio || emisorMedio,
        tasa_bcv: Number(perfil.tasa_bcv),
      };
    }
    // Reenvío seguro del correo sin emitir nueva factura ni tocar correlativos
    const numTxt = String(existente.numero_factura ?? 0).padStart(8, "0");
    const ctlTxt = existente.control_fiscal || `00-${numTxt}`;
    const correoData = construirCorreoCobroSaas({
      nombreNegocio: inq.nombre_negocio,
      rifNegocio: inq.rif,
      nombreAdmin: inq.nombre_dueno || "Administrador",
      emisorNombre: perfil.nombre_razon_social,
      emisorRif: aRifSeniat(perfil.rif || ""),
      numeroFactura: numTxt,
      controlTexto: ctlTxt,
      fechaEmision: String(existente.enviado_en || hoy).slice(0, 10),
      periodoYm,
      concepto: existente.concepto,
      subtotalUsdCent: existente.monto_usd_cent,
      ivaUsdCent: Math.max(0, existente.total_usd_cent - existente.monto_usd_cent),
      totalUsdCent: existente.total_usd_cent,
      totalBsCent: existente.total_bs_cent,
      tasaTexto: (existente.tasa_e8 / 1e8).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
      alicuotaCent: existente.total_usd_cent > existente.monto_usd_cent ? 1600 : 0,
      metodos,
    });
    const envio = await enviarCorreo(
      rawDb,
      { ...envObj, __rawDb: rawDb, __inquilinoCodigo: "principal" },
      {
        para: inq.email_dueno,
        asunto: correoData.asunto,
        html: correoData.html,
        texto: correoData.texto,
        responderA: "pagos@facturayave.com",
        alcance: "PLATAFORMA",
        tipo: "DOCUMENTO",
        inquilinoCodigo: "principal",
      }
    );
    const errCorreo = !envio.ok ? envio.error : "";
    await rawDb
      .prepare(`UPDATE _mt_cobros_saas SET correo_enviado = ?, correo_error = ?, enviado_en = datetime('now') WHERE id = ?`)
      .bind(envio.ok ? 1 : 0, errCorreo.slice(0, 260), existente.id)
      .run();
    const actualizado = await rawDb.prepare(`SELECT * FROM _mt_cobros_saas WHERE id = ?`).bind(existente.id).first<FilaCobroSaas>();
    return {
      ok: true,
      ya_existia: true,
      calculo,
      cobro: actualizado || existente,
      metodos,
      emisor_medio: existente.medio || emisorMedio,
      tasa_bcv: Number(perfil.tasa_bcv),
      correo: { enviado: envio.ok, motivo: errCorreo || undefined, proveedor: envio.ok ? envio.proveedor : undefined },
    };
  }

  // Emitir factura real atómica en la empresa principal
  const clienteId = await sincronizarClienteEnPrincipal(rawDb, {
    rif: inq.rif,
    nombre_negocio: inq.nombre_negocio,
    direccion: inq.direccion || "",
    telefono: inq.telefono || "",
    email_dueno: inq.email_dueno || "",
  });

  const modo = await modoActual(rawDb);
  const params = await parametrosVigentes(rawDb, hoy);
  const logoRaw = typeof perfil.logo_base64 === "string" && perfil.logo_base64.trim() ? perfil.logo_base64.trim() : null;
  const logoHash = logoRaw ? await sha256(logoRaw) : null;
  const emisorJson = JSON.stringify({
    nombre_razon_social: perfil.nombre_razon_social,
    rif: aRifSeniat(perfil.rif || ""),
    direccion_fiscal: perfil.direccion_fiscal,
    telefono: perfil.telefono,
    email: perfil.email,
    tipo_contribuyente: normalizarTipoContribuyente(perfil.tipo_contribuyente, perfil.igtf_activo),
    logo_hash: logoHash,
    logo_base64: null,
  });
  const reglasJson = JSON.stringify({
    iva_alicuotas_cent: params.iva_alicuotas_cent,
    igtf_alicuota_cent: params.igtf_alicuota_cent ?? "300",
    titulo_sin_control: params.titulo_sin_control,
    leyenda_sin_control: params.leyenda_sin_control,
    leyenda_cambio: params.leyenda_cambio,
    validez_presupuesto_dias: Number(params.validez_presupuesto_dias ?? 15),
    plantilla_version: Number(params.plantilla_version ?? 1),
  });

  const notaFactura = `Suscripción FacturaYa Venezuela (${codigo} · ${periodoYm}). Reporta tu comprobante a pagos@facturayave.com.`;
  const borrador = await rawDb
    .prepare(
      `INSERT INTO documentos (tipo, estado, modo, cliente_id, nota, aplica_igtf, creado_por, condicion, dias_credito)
       VALUES ('FACTURA', 'BORRADOR', ?, ?, ?, 0, ?, 'CREDITO', 5) RETURNING id`
    )
    .bind(modo, clienteId, notaFactura, opciones.usuarioId)
    .first<{ id: number }>();
  if (!borrador?.id) throw new Error("No se pudo crear el borrador de la factura en tu negocio principal.");
  const docId = borrador.id;

  const claveNum = `FACTURA:${modo}`;
  const claveCtl = `CONTROL:${modo}`;
  const sigueBorrador = `EXISTS (SELECT 1 FROM documentos WHERE id = ? AND estado = 'BORRADOR')`;
  const venceEl = masDias(hoy, 5);
  const pasos: D1PreparedStatement[] = [];
  if (logoHash && logoRaw) {
    pasos.push(rawDb.prepare(`INSERT OR IGNORE INTO emisor_logos (hash, logo_base64) VALUES (?, ?)`).bind(logoHash, logoRaw));
  }
  pasos.push(
    rawDb
      .prepare(
        `INSERT INTO documento_renglones (documento_id, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd, monto_bs)
         VALUES (?, 1, NULL, 'SERVICIO', ?, 1000, ?, NULL, ?, ?, ?)`
      )
      .bind(docId, calculo.concepto, calculo.subtotal_usd_cent, calculo.alicuota_cent, calculo.subtotal_usd_cent, calculo.subtotal_bs_cent),
    rawDb
      .prepare(
        `INSERT INTO documento_impuestos (documento_id, alicuota_cent, base_usd, iva_usd, base_bs, iva_bs)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(docId, calculo.alicuota_cent, calculo.subtotal_usd_cent, calculo.iva_usd_cent, calculo.subtotal_bs_cent, calculo.iva_bs_cent),
    rawDb.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${sigueBorrador}`).bind(claveNum, docId),
    rawDb.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${sigueBorrador}`).bind(claveCtl, docId),
    rawDb
      .prepare(
        `UPDATE documentos SET estado = 'EMITIDO',
           numero = (SELECT valor FROM contadores WHERE clave = ?),
           control_interno = (SELECT valor FROM contadores WHERE clave = ?),
           cliente_rif = ?, cliente_nombre = ?, cliente_direccion = ?, cliente_whatsapp = ?, cliente_email = ?,
           fecha_emision = ?, emitido_en = ?, tasa_e8 = ?, tasa_cargada_en = ?,
           subtotal_usd = ?, iva_usd = ?, igtf_alicuota_cent = 300, igtf_usd = 0, total_usd = ?,
           subtotal_bs = ?, iva_bs = ?, igtf_bs = 0, total_bs = ?, costo_total_usd = 0,
           parametros_json = ?, emisor_json = ?, vence_el = ?, medio = ?
         WHERE id = ? AND estado = 'BORRADOR'`
      )
      .bind(
        claveNum,
        claveCtl,
        aRifSeniat(inq.rif || ""),
        inq.nombre_negocio,
        inq.direccion || null,
        inq.telefono || null,
        inq.email_dueno || null,
        hoy,
        new Date().toISOString(),
        tasaE8,
        perfil.tasa_bcv_fecha || null,
        calculo.subtotal_usd_cent,
        calculo.iva_usd_cent,
        calculo.total_usd_cent,
        calculo.subtotal_bs_cent,
        calculo.iva_bs_cent,
        calculo.total_bs_cent,
        reglasJson,
        emisorJson,
        venceEl,
        emisorMedio,
        docId
      )
  );
  await rawDb.batch(pasos);

  const emitida = await rawDb
    .prepare(`SELECT numero, control_interno FROM documentos WHERE id = ?`)
    .bind(docId)
    .first<{ numero: number; control_interno: number }>();
  const numFac = Number(emitida?.numero || 0);
  const ctlInt = Number(emitida?.control_interno || numFac);

  let controlFiscal: string | null = null;
  if (emisorMedio === "IMPRENTA_DIGITAL" && modo === "REAL" && numFac > 0) {
    const resImp = await solicitarControlImprentaDigital(rawDb, envObj, {
      documento_id: docId,
      tipo_documento: "FACTURA",
      modo,
      numero: numFac,
      control_interno: ctlInt,
      fecha_emision: hoy,
      cliente_rif: aRifSeniat(inq.rif || ""),
      cliente_nombre: inq.nombre_negocio,
      cliente_email: inq.email_dueno || null,
      cliente_direccion: inq.direccion || null,
      cliente_telefono: inq.telefono || null,
      subtotal_bs: calculo.subtotal_bs_cent,
      iva_bs: calculo.iva_bs_cent,
      igtf_bs: 0,
      total_bs: calculo.total_bs_cent,
      subtotal_usd: calculo.subtotal_usd_cent,
      iva_usd: calculo.iva_usd_cent,
      igtf_usd: 0,
      total_usd: calculo.total_usd_cent,
      tasa_e8: tasaE8,
    }).catch(() => ({ ok: false as const, control_fiscal: undefined }));
    if (resImp.ok && resImp.control_fiscal) {
      controlFiscal = resImp.control_fiscal;
    }
  }

  const numTxt = String(numFac).padStart(8, "0");
  const ctlTxt = controlFiscal || `00-${String(ctlInt).padStart(8, "0")}`;
  const correoData = construirCorreoCobroSaas({
    nombreNegocio: inq.nombre_negocio,
    rifNegocio: aRifSeniat(inq.rif || ""),
    nombreAdmin: inq.nombre_dueno || "Administrador",
    emisorNombre: perfil.nombre_razon_social,
    emisorRif: aRifSeniat(perfil.rif || ""),
    numeroFactura: numTxt,
    controlTexto: ctlTxt,
    fechaEmision: hoy,
    periodoYm,
    concepto: calculo.concepto,
    subtotalUsdCent: calculo.subtotal_usd_cent,
    ivaUsdCent: calculo.iva_usd_cent,
    totalUsdCent: calculo.total_usd_cent,
    totalBsCent: calculo.total_bs_cent,
    tasaTexto: Number(perfil.tasa_bcv).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
    alicuotaCent: calculo.alicuota_cent,
    metodos,
  });

  const envio = await enviarCorreo(
    rawDb,
    { ...envObj, __rawDb: rawDb, __inquilinoCodigo: "principal" },
    {
      para: inq.email_dueno,
      asunto: correoData.asunto,
      html: correoData.html,
      texto: correoData.texto,
      responderA: "pagos@facturayave.com",
      alcance: "PLATAFORMA",
      tipo: "DOCUMENTO",
      inquilinoCodigo: "principal",
    }
  );
  const errCorreo = !envio.ok ? envio.error : "";

  const cobroRow = await rawDb
    .prepare(
      `INSERT INTO _mt_cobros_saas (
         inquilino_codigo, periodo_ym, documento_id, numero_factura, control_fiscal, medio,
         monto_usd_cent, total_usd_cent, total_bs_cent, tasa_e8,
         prorrateado, dias_cobrados, dias_mes, es_promo, concepto,
         estado, correo_enviado, correo_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EMITIDO', ?, ?)
       RETURNING *`
    )
    .bind(
      codigo,
      periodoYm,
      docId,
      numFac,
      controlFiscal,
      emisorMedio,
      calculo.subtotal_usd_cent,
      calculo.total_usd_cent,
      calculo.total_bs_cent,
      tasaE8,
      calculo.prorrateado ? 1 : 0,
      calculo.dias_cobrados,
      calculo.dias_mes,
      calculo.es_promo ? 1 : 0,
      calculo.concepto,
      envio.ok ? 1 : 0,
      errCorreo.slice(0, 260)
    )
    .first<FilaCobroSaas>();

  return {
    ok: true,
    ya_existia: false,
    calculo,
    cobro: cobroRow || undefined,
    metodos,
    emisor_medio: emisorMedio,
    tasa_bcv: Number(perfil.tasa_bcv),
    correo: { enviado: envio.ok, motivo: errCorreo || undefined, proveedor: envio.ok ? envio.proveedor : undefined },
  };
}

// Registra el pago recibido (tras revisar el comprobante en pagos@facturayave.com),
// emite el recibo atómico en tu empresa principal y marca el período SaaS como PAGADO.
export async function registrarPagoCobroSaas(
  rawDb: D1Database,
  opciones: {
    codigo: string;
    cobroId: number;
    metodo: string;
    moneda: "BS" | "USD";
    referencia?: string;
    nota?: string;
    usuarioId: number;
  }
): Promise<{ ok: true; recibo_numero: number | null; cobro: FilaCobroSaas }> {
  await asegurarTablasMultiTenant(rawDb);
  const cobro = await rawDb
    .prepare(`SELECT * FROM _mt_cobros_saas WHERE id = ? AND inquilino_codigo = ?`)
    .bind(opciones.cobroId, opciones.codigo)
    .first<FilaCobroSaas>();
  if (!cobro) throw new Error("Cobro mensual no encontrado.");
  if (cobro.estado === "PAGADO") throw new Error("Este período ya fue marcado como pagado.");

  const metodosValidos = new Set(["PAGO_MOVIL", "TRANSFERENCIA", "BINANCE", "ZELLE", "PAYPAL", "EFECTIVO", "OTRO"]);
  const metodo = metodosValidos.has(opciones.metodo) ? opciones.metodo : "PAGO_MOVIL";
  const moneda = opciones.moneda === "USD" ? "USD" : "BS";
  const hoy = fechaCaracas();
  const ref = String(opciones.referencia || "").trim().slice(0, 60) || null;
  const nota = String(opciones.nota || "").trim().slice(0, 200) || `Pago suscripción ${cobro.periodo_ym} (${cobro.inquilino_codigo})`;

  let reciboNum: number | null = null;
  if (cobro.documento_id) {
    const doc = await rawDb
      .prepare(`SELECT id, modo, total_usd, total_bs, tasa_e8, ${PAGADO} AS pagado FROM documentos d WHERE id = ? AND estado = 'EMITIDO'`)
      .bind(cobro.documento_id)
      .first<{ id: number; modo: string; total_usd: number; total_bs: number; tasa_e8: number; pagado: number }>();

    if (doc && doc.total_usd - doc.pagado > 0) {
      const saldoUsd = doc.total_usd - doc.pagado;
      const montoRecibido = moneda === "BS" ? doc.total_bs : saldoUsd;
      const tasaUsada = moneda === "BS" ? doc.tasa_e8 : null;
      const params = await parametrosVigentes(rawDb, hoy);
      const claveRecibo = `RECIBO:${doc.modo}`;
      const reglas = JSON.stringify({
        leyenda_recibo: params.leyenda_recibo,
        plantilla_version: Number(params.plantilla_version ?? 1),
      });
      const guarda = `(SELECT d.total_usd - ${PAGADO} FROM documentos d WHERE d.id = ?) = ?`;
      const resBatch = await rawDb.batch([
        rawDb.prepare(`UPDATE contadores SET valor = valor + 1 WHERE clave = ? AND ${guarda}`).bind(claveRecibo, doc.id, saldoUsd),
        rawDb
          .prepare(
            `INSERT INTO pagos (documento_id, modo, numero, metodo, es_retencion_iva, es_retencion_islr, moneda, monto_recibido, tasa_e8, monto_usd, saldo_despues_usd, referencia, nota, fecha_pago, registrado_en, registrado_por, reglas_json)
             SELECT ?, ?, (SELECT valor FROM contadores WHERE clave = ?), ?, 0, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ? WHERE ${guarda} RETURNING numero`
          )
          .bind(
            doc.id,
            doc.modo,
            claveRecibo,
            metodo,
            moneda,
            montoRecibido,
            tasaUsada,
            saldoUsd,
            ref,
            nota,
            hoy,
            new Date().toISOString(),
            opciones.usuarioId,
            reglas,
            doc.id,
            saldoUsd
          ),
      ]);
      const insRow = (resBatch[1]?.results?.[0] as { numero?: number } | undefined);
      if (insRow?.numero) reciboNum = Number(insRow.numero);
    }
  }

  await rawDb
    .prepare(`UPDATE _mt_cobros_saas SET estado = 'PAGADO', referencia_pago = ?, pagado_en = datetime('now') WHERE id = ?`)
    .bind(ref || metodo, cobro.id)
    .run();

  const actualizado = await rawDb.prepare(`SELECT * FROM _mt_cobros_saas WHERE id = ?`).bind(cobro.id).first<FilaCobroSaas>();
  return { ok: true, recibo_numero: reciboNum, cobro: actualizado || cobro };
}

// Cron opcional día 1: SOLO procesa empresas activas con cobro_auto_dia1 = 1 que aún no hayan sido facturadas ese mes.
// NUNCA suspende cuentas automáticamente.
export async function ejecutarCobroAutomaticoDia1(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  hoyIso = fechaCaracas()
): Promise<{ ejecutados: number; errores: number }> {
  const diaMes = Number(hoyIso.slice(8, 10));
  if (diaMes !== 1) return { ejecutados: 0, errores: 0 };
  const periodoYm = hoyIso.slice(0, 7);
  await asegurarTablasMultiTenant(rawDb, envObj);

  const superUsr = await rawDb
    .prepare(`SELECT id FROM usuarios WHERE rol IN ('SUPER_ADMIN', 'ADMIN') AND activo = 1 ORDER BY CASE WHEN rol = 'SUPER_ADMIN' THEN 0 ELSE 1 END, id ASC LIMIT 1`)
    .first<{ id: number }>();
  if (!superUsr?.id) return { ejecutados: 0, errores: 0 };

  const { results } = await rawDb
    .prepare(
      `SELECT i.codigo
       FROM _mt_inquilinos i
       WHERE i.codigo != 'principal'
         AND i.activo = 1
         AND COALESCE(i.cobro_auto_dia1, 0) = 1
         AND NOT EXISTS (
           SELECT 1 FROM _mt_cobros_saas c
           WHERE c.inquilino_codigo = i.codigo AND c.periodo_ym = ?
         )
       ORDER BY i.creado_en ASC
       LIMIT 10`
    )
    .bind(periodoYm)
    .all<{ codigo: string }>()
    .catch(() => ({ results: [] as { codigo: string }[] }));

  let ejecutados = 0, errores = 0;
  for (const r of results || []) {
    try {
      const res = await emitirYEnviarCobroSaas(rawDb, envObj, {
        codigo: r.codigo,
        periodoYm,
        usuarioId: superUsr.id,
      });
      if (!res.ya_existia) ejecutados++;
    } catch (e) {
      errores++;
      console.error(`[cobro-saas-cron] ${r.codigo}:`, e);
    }
  }
  return { ejecutados, errores };
}
