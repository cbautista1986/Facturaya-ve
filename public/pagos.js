// Módulo PAGOS (pantallas): por cobrar, cobros, datos de cobro, registrar un pago y recibos.
// El saldo siempre lo calcula el servidor (total - pagos vigentes); aquí solo se muestra. Los Bs se convierten con la tasa del día del pago.
import { $, raiz, esc, bs, usd, aTexto, api, aviso, campo, enviar, navegacion, activar, descargar, compartir, cargarPdfLib, abrirEnlace, telefono, puede, ERROR } from "./comun.js";
import { aTasaE8, aCentavos, bsAUsd, usdABs } from "./dinero.js";
import { construirRecibo, nombreRecibo, numeroRecibo, numeroDoc, metodoNombre } from "./pdf.js?v=20261124v504";

const fechaDoc = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "");
const hoyCaracas = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(new Date());
const METODOS_UI = [["PAGO_MOVIL", "📱", "Pago móvil", ["BS"]], ["TRANSFERENCIA", "🏦", "Transferencia", ["BS", "USD"]], ["EFECTIVO", "💵", "Efectivo", ["BS", "USD"]],
  ["ZELLE", "🟣", "Zelle", ["USD"]], ["BINANCE", "🟡", "Binance Pay", ["USD"]], ["PAYPAL", "🔵", "PayPal", ["USD"]],
  ["RETENCION_IVA", "🧾", "Retención de IVA (SENIAT 75% / 100%)", ["BS"]],
  ["RETENCION_ISLR", "📑", "Retención de ISLR (Decreto 1.808 — 1% a 34%)", ["BS"]],
  ["OTRO", "➕", "Otro", ["BS", "USD"]]];
const BANCOS = ["0102 Banco de Venezuela", "0104 Venezolano de Crédito", "0105 Mercantil", "0108 Provincial", "0114 Bancaribe", "0115 Exterior", "0128 Banco Caroní",
  "0134 Banesco", "0137 Sofitasa", "0138 Banco Plaza", "0151 BFC Banco Fondo Común", "0156 100% Banco", "0157 DelSur", "0163 Banco del Tesoro", "0166 Banco Agrícola",
  "0168 Bancrecer", "0169 Mi Banco", "0171 Banco Activo", "0172 Bancamiga", "0174 Banplus", "0175 Banco Bicentenario", "0177 Banfanb", "0191 BNC Nacional de Crédito"];
const CAMPOS_UI = {
  PAGO_MOVIL: [["banco", "🏦 Banco", "banco"], ["documento", "🪪 Cédula o RIF del titular", "texto", 'placeholder="V-12345678"'], ["telefono", "📱 Teléfono del pago móvil", "tel", 'placeholder="0414-1234567"']],
  TRANSFERENCIA: [["banco", "🏦 Banco", "banco"], ["cuenta", "🔢 Número de cuenta (20 dígitos)", "texto", 'inputmode="numeric"'], ["tipo", "📒 Tipo de cuenta", "tipo"],
    ["titular", "👤 Titular", "texto"], ["documento", "🪪 Cédula o RIF del titular", "texto", 'placeholder="V-12345678"']],
  ZELLE: [["contacto", "✉️ Correo o teléfono de Zelle", "texto"], ["titular", "👤 Titular", "texto"]],
  BINANCE: [["contacto", "🆔 Binance Pay ID o correo", "texto"], ["titular", "👤 Titular", "texto"]],
  PAYPAL: [["contacto", "✉️ Correo de PayPal", "texto"]],
  EFECTIVO: [],
};

// ------------------------------------------------------------------ mensajes de WhatsApp (los usa también Factura)
export function lineasCobro(metodos) {
  const unir = (...p) => p.filter(Boolean).join(" · ");
  const formato = { PAGO_MOVIL: ["📱 Pago móvil", (d) => unir(d.banco, d.documento, d.telefono)],
    TRANSFERENCIA: ["🏦 Transferencia", (d) => unir(d.banco, d.cuenta && `Cuenta ${d.cuenta}${d.tipo ? ` (${d.tipo})` : ""}`, d.titular, d.documento)],
    ZELLE: ["🟣 Zelle", (d) => unir(d.contacto, d.titular)], BINANCE: ["🟡 Binance Pay", (d) => unir(d.contacto, d.titular)],
    PAYPAL: ["🔵 PayPal", (d) => d.contacto ?? ""], EFECTIVO: ["💵 Efectivo", () => ""] };
  return metodos.filter((m) => m.activo && formato[m.metodo]).map((m) => {
    const [titulo, datos] = formato[m.metodo], base = datos(m.datos ?? {}), nota = m.datos?.nota;
    return `${titulo}${base ? `: ${base}` : ""}${nota ? (base ? ` — ${nota}` : `: ${nota}`) : ""}`;
  });
}
export function mensajeDocumento({ D, pagado, saldo, metodos }) {
  const emisor = JSON.parse(D.emisor_json || "{}"), esNC = !!D.es_nota_credito, esND = !!D.es_nota_debito, esF = D.tipo === "FACTURA" && !esNC;
  const formas = lineasCobro(metodos);
  const nombreDoc = esNC ? "tu nota de crédito" : esND ? "tu nota de débito" : esF ? "tu factura" : "tu presupuesto";
  return `Hola ${D.cliente_nombre} 👋\nTe envío ${nombreDoc} ${numeroDoc(D)} de ${emisor.nombre_razon_social}.\n`
    + `Total${esNC ? " acreditado" : ""}: ${usd(D.total_usd)} (Bs. ${bs(D.total_bs / 100)})`
    + (D.aplica_igtf && D.igtf_usd > 0 ? `\nIncluye IGTF (3%): ${usd(D.igtf_usd)} (Bs. ${bs(D.igtf_bs / 100)})` : "")
    + (!esNC && pagado > 0 ? `\nPagado / acreditado: ${usd(pagado)} · Saldo: ${usd(Math.max(saldo, 0))}` : "")
    + (esF && D.condicion === "CREDITO" ? `\nVence: ${fechaDoc(D.vence_el)}` : "")
    + (!esNC && saldo > 0 && formas.length ? `\n\nFormas de pago:\n${formas.map((l) => "• " + l).join("\n")}` : "") + "\n\nGracias 🙏";
}
export const enlaceWhatsApp = (numero, texto) => `https://wa.me/${telefono(numero)?.digitos ?? String(numero).replace(/\D/g, "")}?text=${encodeURIComponent(texto)}`;

// ------------------------------------------------------------------ rutas
let tab = "COBRAR", volverA = null, pedido = 0; // al entrar desde el menú siempre se abre «Por cobrar»; al volver de un recibo o de un método, a su pestaña
export async function vistaPagos(estado, id, extra) {
  try {
    if (id === "nuevo") return await formPago(estado, extra);
    if (id === "recibo") return await verRecibo(estado, extra);
    if (id === "metodo") return await editarMetodo(extra);
  } catch (e) { aviso(e.message); location.hash = "#/pagos"; return; }
  hub(estado);
}

function hub(estado) {
  tab = volverA ?? "COBRAR"; volverA = null;
  raiz.innerHTML = `
    <header class="encabezado"><h1>💳 Pagos</h1></header>
    ${estado.modo === "PRACTICA" ? `<section class="aviso-practica"><b>🧪 MODO PRÁCTICA</b> · los pagos y recibos son de prueba.</section>` : ""}
    <div class="chips tres">${[["COBRAR", "⏳ Por cobrar"], ["COBROS", "✅ Cobros"], ["DATOS", "🧾 Mis datos"]].map(([v, t]) => `<button class="chip ${v === tab ? "activo" : ""}" data-t="${v}">${t}</button>`).join("")}</div>
    <div id="cuerpo"></div>${navegacion("pagos")}`;
  activar();
  raiz.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.t; raiz.querySelectorAll(".chip").forEach((x) => x.classList.toggle("activo", x === b)); pintar(); }));
  pintar();
}

let cobrosFiltroQ = "", cobrosFiltroMes = "", cobrosPagina = 0;

async function pintar() {
  const mio = ++pedido;
  if (!$("#cuerpo")) return;
  $("#cuerpo").innerHTML = `<p class="suave">Cargando…</p>`;
  try {
    const html = tab === "COBRAR" ? await htmlPorCobrar() : tab === "COBROS" ? await htmlCobros() : await htmlDatos();
    if (mio !== pedido || !$("#cuerpo")) return; // llegó tarde: ya cambiaste de pestaña o de pantalla
    $("#cuerpo").innerHTML = html;
    $("#cuerpo").querySelectorAll("[data-ir]").forEach((el) => el.addEventListener("click", () => (location.hash = el.dataset.ir)));
    if (tab === "COBROS") enlazarFiltrosCobros();
  } catch (e) { if (mio === pedido && $("#cuerpo")) $("#cuerpo").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function htmlPorCobrar() {
  const [{ facturas }, r] = await Promise.all([api("pagos/por-cobrar"), api("pagos/resumen")]), hoy = hoyCaracas();
  const resumen = `<section class="tarjeta"><div class="tot"><span>Por cobrar</span><b>${usd(r.por_cobrar_usd)} · ${r.por_cobrar_n} factura(s)</b></div>
    <div class="tot"><span>Vencidas</span><b class="${r.vencidas_n ? "rojo-txt" : ""}">${usd(r.vencidas_usd)} · ${r.vencidas_n}</b></div>
    <div class="tot"><span>Cobrado este mes</span><b>${usd(r.cobrado_mes_usd)}</b></div></section>`;
  const filas = facturas.map((x) => {
    const [txt, color] = x.vencida ? [`Vencida ${x.dias_atraso} d`, "rojo"] : x.vence_el === hoy ? ["Vence hoy", "ambar"] : ["Vigente", "verde"];
    const etDoc = x.es_nota_debito ? `Nota de Débito ND-${String(x.numero).padStart(8, "0")}` : `Factura ${String(x.numero).padStart(8, "0")}`;
    return `<article class="fila" data-ir="#/pagos/nuevo/${x.id}"><div class="dato"><strong>${esc(etDoc)} · ${esc(x.cliente_nombre)}</strong>
      <small class="suave">${x.vence_el ? "Vence " + fechaDoc(x.vence_el) + " · " : ""}Saldo ${usd(x.saldo_usd)} de ${usd(x.total_usd)}</small></div><span class="insignia ${color}">${txt}</span></article>`;
  }).join("");
  return resumen + (filas ? `<div class="lista">${filas}</div><p class="pista">Toca una factura para registrar un pago.</p>` : `<p class="suave">No hay nada por cobrar. ✅</p>`);
}

async function cargarCobrosLista() {
  const listaEl = $("#cobros-lista"), pagEl = $("#cobros-paginacion");
  if (!listaEl) return;
  listaEl.innerHTML = `<p class="suave">Cargando…</p>`;
  const limite = 50;
  try {
    const { pagos, hay_mas } = await api(`pagos?q=${encodeURIComponent(cobrosFiltroQ)}&mes=${encodeURIComponent(cobrosFiltroMes)}&pagina=${cobrosPagina}&limite=${limite}`);
    if (!$("#cobros-lista")) return;
    $("#cobros-lista").innerHTML = pagos.length ? pagos.map((p) => `<article class="fila ${p.estado === "ANULADO" ? "apagado" : ""}" data-ir="#/pagos/recibo/${p.id}">
      <div class="dato"><strong>Recibo ${numeroRecibo(p.numero)} · ${esc(p.cliente_nombre)}</strong>
      <small class="suave">${esc(metodoNombre(p.metodo))} · ${p.moneda === "BS" ? "Bs. " + bs(p.monto_recibido / 100) : usd(p.monto_recibido)} · ${fechaDoc(p.fecha_pago)}</small></div>
      <span class="insignia ${p.estado === "ANULADO" ? "rojo" : "verde"}">${usd(p.monto_usd)}</span></article>`).join("") : `<p class="suave">${cobrosFiltroQ || cobrosFiltroMes ? "Sin cobros para este filtro." : "Todavía no has registrado cobros."}</p>`;
    $("#cobros-lista").querySelectorAll("[data-ir]").forEach((el) => el.addEventListener("click", () => (location.hash = el.dataset.ir)));
    if (pagEl) {
      if (cobrosPagina > 0 || hay_mas) {
        pagEl.hidden = false;
        pagEl.innerHTML = `
          <button type="button" class="boton chico" id="cob-ant" ${cobrosPagina <= 0 ? "disabled" : ""}>← Anterior</button>
          <span class="suave" style="align-self:center;text-align:center;font-size:13px">Pág. ${cobrosPagina + 1}</span>
          <button type="button" class="boton chico" id="cob-sig" ${!hay_mas ? "disabled" : ""}>Siguiente →</button>`;
        $("#cob-ant")?.addEventListener("click", () => { if (cobrosPagina > 0) { cobrosPagina--; cargarCobrosLista(); } });
        $("#cob-sig")?.addEventListener("click", () => { if (hay_mas) { cobrosPagina++; cargarCobrosLista(); } });
      } else {
        pagEl.hidden = true;
        pagEl.innerHTML = "";
      }
    }
  } catch (e) {
    if ($("#cobros-lista")) $("#cobros-lista").innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

async function htmlCobros() {
  return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
    <input id="buscar-cobros" type="search" value="${esc(cobrosFiltroQ)}" placeholder="🔎 Buscar por cliente, recibo o referencia" aria-label="Buscar cobros" autocomplete="off" style="flex:1;margin:0">
    <input id="mes-cobros" type="month" value="${esc(cobrosFiltroMes)}" aria-label="Filtrar cobros por mes" title="Filtrar por mes" style="width:auto;min-width:140px;margin:0">
  </div>
  <div id="cobros-lista" class="lista"><p class="suave">Cargando…</p></div>
  <div id="cobros-paginacion" class="dos-botones" style="margin-top:8px" hidden></div>`;
}

function enlazarFiltrosCobros() {
  let esp;
  $("#buscar-cobros")?.addEventListener("input", (e) => {
    cobrosFiltroQ = e.target.value;
    cobrosPagina = 0;
    clearTimeout(esp);
    esp = setTimeout(cargarCobrosLista, 250);
  });
  $("#mes-cobros")?.addEventListener("change", (e) => {
    cobrosFiltroMes = e.target.value;
    cobrosPagina = 0;
    cargarCobrosLista();
  });
  cargarCobrosLista();
}

async function htmlDatos() {
  const { metodos } = await api("pagos/metodos"), activos = lineasCobro(metodos);
  return `<p class="suave">Estos datos salen en los mensajes de WhatsApp para que tus clientes sepan cómo pagarte.</p><div class="lista">${METODOS_UI.filter((m) => m[0] !== "OTRO" && m[0] !== "RETENCION_IVA" && m[0] !== "RETENCION_ISLR").map(([v, ic, t]) => {
    const m = metodos.find((x) => x.metodo === v);
    return `<article class="fila ${m?.activo ? "" : "apagado"}" data-ir="#/pagos/metodo/${v}"><span class="icono-tipo">${ic}</span>
      <div class="dato"><strong>${t}</strong><small class="suave">${m?.activo ? "Activo" : "Apagado: toca para configurarlo"}</small></div></article>`;
  }).join("")}</div>
  <section class="tarjeta"><span class="etiqueta">💬 ASÍ SE VERÁ EN TUS MENSAJES</span>${activos.length ? activos.map((l) => `<p class="linea-cobro">${esc(l)}</p>`).join("") : `<p class="suave">Activa al menos una forma de cobro.</p>`}</section>`;
}

// ------------------------------------------------------------------ datos de cobro de un método
async function editarMetodo(metodo) {
  const def = METODOS_UI.find((m) => m[0] === metodo);
  if (!def || metodo === "OTRO" || metodo === "RETENCION_IVA" || metodo === "RETENCION_ISLR") throw new Error("Método no válido.");
  const m = (await api("pagos/metodos")).metodos.find((x) => x.metodo === metodo), d = m?.datos ?? {}, campos = CAMPOS_UI[metodo] ?? [];
  const campoUI = ([k, et, tipo, extra = ""]) => {
    if (tipo === "banco") {
      const enLista = !d[k] || BANCOS.includes(d[k]);
      return `<label for="${k}_sel">${et}</label><select id="${k}_sel"><option value="">— Elige el banco —</option>${BANCOS.map((b) => `<option ${d[k] === b ? "selected" : ""}>${b}</option>`).join("")}<option value="OTRO" ${enLista ? "" : "selected"}>Otro banco…</option></select>
        <div id="${k}_otro_caja" ${enLista ? "hidden" : ""}>${campo(`${k}_otro`, "Nombre y código del banco", enLista ? "" : d[k])}</div>`;
    }
    if (tipo === "tipo") return `<label for="${k}">${et}</label><select id="${k}" name="${k}">${["Corriente", "Ahorros"].map((t) => `<option ${d[k] === t ? "selected" : ""}>${t}</option>`).join("")}</select>`;
    return campo(k, et, d[k] ?? "", tipo === "tel" ? "tel" : "text", extra);
  };
  raiz.innerHTML = `
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver" aria-label="Volver">←</button><h1>${def[1]} ${def[2]}</h1></header>
    <form id="f" class="tarjeta">
      <label class="opcion"><input type="checkbox" name="activo" ${m?.activo ? "checked" : ""}> Mostrar esta forma de pago a mis clientes</label>
      ${campos.map(campoUI).join("")}
      <label for="nota">📝 Nota (opcional)</label><textarea id="nota" name="nota" rows="2" maxlength="300">${esc(d.nota ?? "")}</textarea>
      ${ERROR}<button class="boton verde" type="submit">GUARDAR</button></form>`;
  $("#atras").addEventListener("click", () => { volverA = "DATOS"; location.hash = "#/pagos"; });
  campos.filter((c) => c[2] === "banco").forEach(([k]) => $(`#${k}_sel`).addEventListener("change", () => { $(`#${k}_otro_caja`).hidden = $(`#${k}_sel`).value !== "OTRO"; }));
  enviar($("#f"), async (v) => {
    const datos = { nota: v.nota };
    for (const [k, , tipo] of campos) datos[k] = tipo === "banco" ? ($(`#${k}_sel`).value === "OTRO" ? v[`${k}_otro`] : $(`#${k}_sel`).value) : v[k];
    await api(`pagos/metodos/${metodo}`, "PUT", { activo: v.activo === "on", datos });
    aviso("Guardado ✅"); volverA = "DATOS"; location.hash = "#/pagos";
  });
}

// ------------------------------------------------------------------ registrar un pago
async function formPago(estado, docId) {
  const { documento: D, pagado_usd, saldo_usd } = await api(`documentos/${encodeURIComponent(docId)}`), hoy = hoyCaracas();
  if (D.estado !== "EMITIDO" || !(saldo_usd > 0)) throw new Error("Este documento no admite más pagos.");
  const tipoContrib = estado?.negocio?.tipo_contribuyente || "ORDINARIO";
  const esFormal = tipoContrib === "FORMAL";
  const esEspecial = tipoContrib === "ESPECIAL";
  const metodosDisp = METODOS_UI.filter(([v]) => {
    if (v === "RETENCION_IVA") return !esFormal && D.tipo === "FACTURA" && !D.es_nota_credito && (D.iva_bs ?? 0) > 0;
    if (v === "RETENCION_ISLR") return D.tipo === "FACTURA" && !D.es_nota_credito && (D.subtotal_bs ?? 0) > 0;
    return true;
  });
  const iva75Bs = Math.round(((D.iva_bs ?? 0) * 75) / 100);
  const iva100Bs = D.iva_bs ?? 0;
  const baseIslrBs = D.subtotal_bs ?? 0;
  let porcentajeIslr = 2;
  const tasaDocTxt = D.tasa_e8 ? (D.tasa_e8 / 1e8).toFixed(4).replace(/\.?0+$/, "").replace(".", ",") : "";
  raiz.innerHTML = `
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver" aria-label="Volver">←</button><h1>Registrar pago</h1></header>
    <section class="tarjeta">
      <div class="tot"><span>${D.tipo === "FACTURA" ? (D.es_nota_debito ? "Nota de Débito" : "Factura") : "Presupuesto (abono)"}</span><b>${esc(numeroDoc(D))}</b></div>
      <div class="tot"><span>Cliente</span><b>${esc(D.cliente_nombre)}</b></div>
      <div class="tot"><span>Total</span><b>${usd(D.total_usd)}</b></div><div class="tot"><span>Pagado</span><b>${usd(pagado_usd)}</b></div>
      <div class="tot grande"><span>SALDO</span><b>${usd(saldo_usd)}</b></div></section>
    <form id="f" class="tarjeta">
      <label for="metodo">💳 Forma de pago</label>
      <select id="metodo" name="metodo">${metodosDisp.map(([v, ic, t]) => `<option value="${v}">${ic} ${t}</option>`).join("")}</select>
      <fieldset><legend>Moneda del pago</legend>
        <label class="opcion"><input type="radio" name="moneda" value="USD" checked> 💵 Dólares / Divisas (USD)</label>
        <label class="opcion"><input type="radio" name="moneda" value="BS"> 🇻🇪 Bolívares (Bs.${esEspecial ? " · Sin IGTF" : ""})</label></fieldset>
      <p class="pista" id="pista-igtf-pago"></p>
      <div id="caja-retencion" class="tarjeta" hidden>
        <span class="etiqueta">🧾 RETENCIÓN DE IVA SENIAT (SNAT/2025/000054)</span>
        <p class="suave">IVA facturado: <b>Bs. ${bs(iva100Bs / 100)}</b> (${usd(D.iva_usd ?? 0)}). Elige el porcentaje retenido por el Contribuyente Especial:</p>
        <div class="dos-botones">
          <button type="button" class="boton chico" id="btn-ret-75">75% IVA (Bs. ${bs(iva75Bs / 100)})</button>
          <button type="button" class="boton chico contorno-azul" id="btn-ret-100">100% IVA (Bs. ${bs(iva100Bs / 100)})</button>
        </div>
      </div>
      <div id="caja-retencion-islr" class="tarjeta" hidden>
        <span class="etiqueta">📑 RETENCIÓN DE ISLR RECIBIDA (DECRETO 1.808)</span>
        <p class="suave">Base imponible (sin IVA): <b>Bs. ${bs(baseIslrBs / 100)}</b> (${usd(D.subtotal_usd ?? 0)}). Elige el porcentaje de retención ISLR practicado por tu cliente:</p>
        <div class="chips">
          ${[1, 2, 3, 5].map((pct) => `<button type="button" class="chip ${pct === 2 ? "activo" : ""}" data-islr-pct="${pct}">${pct}% (Bs. ${bs(Math.round((baseIslrBs * pct) / 100) / 100)})</button>`).join("")}
        </div>
        <label for="islr_pct_custom" style="margin-top:8px">Otro % ISLR (1 a 34, ej. 15% o 34%)</label>
        <input id="islr_pct_custom" type="number" min="1" max="34" step="1" value="2" inputmode="numeric">
      </div>
      ${campo("monto", "💰 Monto recibido", "", "text", 'inputmode="decimal" required placeholder="0,00"')}
      <div id="caja-tasa" hidden>${campo("tasa", "📈 Tasa BCV del día del pago (Bs por USD)", String(estado.negocio.tasa_bcv || tasaDocTxt || "").replace(".", ","), "text", 'inputmode="decimal"')}</div>
      <p class="pista" id="equivale"></p>
      <button type="button" class="boton chico verde" id="todo">Cobrar el saldo completo</button>
      ${campo("referencia", "🔖 Referencia (opcional)", "", "text", 'maxlength="60"')}
      ${campo("fecha", "📅 Fecha del pago", hoy, "date", `max="${hoy}" min="${D.fecha_emision}" required`)}
      ${ERROR}<button class="boton" type="submit">REGISTRAR PAGO</button></form>`;
  $("#atras").addEventListener("click", () => (location.hash = `#/factura/${D.id}`));
  const radios = () => [...raiz.querySelectorAll('input[name="moneda"]')], moneda = () => radios().find((r) => r.checked).value;
  const recalcular = () => {
    const met = $("#metodo").value;
    const esBs = moneda() === "BS", esRetIva = met === "RETENCION_IVA", esRetIslr = met === "RETENCION_ISLR", esRet = esRetIva || esRetIslr;
    $("#caja-tasa").hidden = !esBs;
    $("#caja-retencion").hidden = !esRetIva;
    $("#caja-retencion-islr").hidden = !esRetIslr;
    $("#todo").hidden = esRet;
    const lblRef = raiz.querySelector('label[for="referencia"]');
    if (lblRef) {
      lblRef.textContent = esRetIva
        ? "🧾 N.º Comprobante de Retención IVA SENIAT (14 dígitos: AAAAMM00000001)"
        : esRetIslr
          ? "📑 N.º Comprobante de Retención ISLR (Decreto 1.808)"
          : "🔖 Referencia (opcional)";
    }
    $("#referencia").required = esRet;
    $("#referencia").placeholder = esRetIva ? `${hoy.slice(0, 4)}${hoy.slice(5, 7)}00000001` : esRetIslr ? `ISLR-${hoy.slice(0, 7)}-001` : "";
    const pIgtf = $("#pista-igtf-pago");
    if (pIgtf) {
      pIgtf.textContent = esRetIva
        ? "🧾 Comprobante de Retención de IVA emitido por agente de retención SENIAT. Se registra en Bolívares y se descuenta en tu Resumen mensual de IVA."
        : esRetIslr
          ? `📑 Comprobante de Retención de ISLR (${porcentajeIslr}% sobre base imponible sin IVA, Decreto 1.808). Queda registrado en tu auxiliar anual ARC.`
          : esBs
            ? (esEspecial
                ? "🇻🇪 Pago en Bolívares: no causa IGTF (0%). Se convierte a USD con la tasa BCV del día."
                : "🇻🇪 Pago en Bolívares: se convierte a USD con la tasa BCV del día.")
            : esEspecial
              ? (D.aplica_igtf
                  ? "💵 Pago en divisas (Zelle / Binance / PayPal / Efectivo USD): esta factura ya incluye el IGTF (3% SNAT/2022/000013)."
                  : "⚠️ Pago en divisas (SPE): esta factura fue emitida sin IGTF (3%). Como Sujeto Pasivo Especial, si cobras en divisas corresponde emitir una Nota de Débito por el 3% de IGTF (SNAT/2022/000013).")
              : "💵 Pago en divisas (Zelle / Binance / PayPal / Efectivo USD): se acredita directamente al saldo en USD (sin IGTF).";
    }
    const monto = aCentavos($("#monto").value), tasa = aTasaE8($("#tasa").value), el = $("#equivale");
    if (!monto || Number.isNaN(monto)) { el.textContent = ""; return; }
    let u = monto;
    if (esBs) {
      if (!tasa || Number.isNaN(tasa)) { el.textContent = "Escribe la tasa BCV del día del pago."; return; }
      try { u = bsAUsd(monto, tasa); } catch { el.textContent = "El monto es demasiado grande."; return; }
      if (Math.abs(saldo_usd - u) <= 1) u = saldo_usd; // diferencia de redondeo de un centavo: se cierra el saldo
    }
    el.textContent = u > saldo_usd ? `⚠️ Equivale a ${usd(u)}: es más que el saldo (${usd(saldo_usd)}).` : `Equivale a ${usd(u)} · Saldo después: ${usd(saldo_usd - u)}`;
  };
  const aplicarMetodo = () => {
    const met = $("#metodo").value;
    const permitidas = METODOS_UI.find((m) => m[0] === met)[3];
    radios().forEach((r) => { r.disabled = !permitidas.includes(r.value); });
    if (!radios().some((r) => r.checked && !r.disabled)) radios().find((r) => !r.disabled).checked = true;
    if (met === "RETENCION_IVA") {
      if (tasaDocTxt) $("#tasa").value = tasaDocTxt;
      if (!$("#monto").value && iva75Bs > 0) $("#monto").value = aTexto(iva75Bs);
    } else if (met === "RETENCION_ISLR") {
      if (tasaDocTxt) $("#tasa").value = tasaDocTxt;
      const calcIslr = Math.round((baseIslrBs * porcentajeIslr) / 100);
      if (calcIslr > 0) $("#monto").value = aTexto(calcIslr);
    }
    recalcular();
  };
  $("#metodo").addEventListener("change", aplicarMetodo);
  radios().forEach((r) => r.addEventListener("change", recalcular));
  $("#monto").addEventListener("input", recalcular); $("#tasa").addEventListener("input", recalcular);
  $("#btn-ret-75")?.addEventListener("click", () => {
    if (tasaDocTxt) $("#tasa").value = tasaDocTxt;
    $("#monto").value = aTexto(iva75Bs);
    recalcular();
  });
  $("#btn-ret-100")?.addEventListener("click", () => {
    if (tasaDocTxt) $("#tasa").value = tasaDocTxt;
    $("#monto").value = aTexto(iva100Bs);
    recalcular();
  });
  raiz.querySelectorAll("[data-islr-pct]").forEach((btn) => btn.addEventListener("click", () => {
    porcentajeIslr = Number(btn.dataset.islrPct);
    raiz.querySelectorAll("[data-islr-pct]").forEach((x) => x.classList.toggle("activo", x === btn));
    if ($("#islr_pct_custom")) $("#islr_pct_custom").value = String(porcentajeIslr);
    if (tasaDocTxt) $("#tasa").value = tasaDocTxt;
    $("#monto").value = aTexto(Math.round((baseIslrBs * porcentajeIslr) / 100));
    recalcular();
  }));
  $("#islr_pct_custom")?.addEventListener("input", () => {
    const val = Number($("#islr_pct_custom").value);
    if (Number.isInteger(val) && val >= 1 && val <= 34) {
      porcentajeIslr = val;
      raiz.querySelectorAll("[data-islr-pct]").forEach((x) => x.classList.toggle("activo", Number(x.dataset.islrPct) === val));
      if (tasaDocTxt) $("#tasa").value = tasaDocTxt;
      $("#monto").value = aTexto(Math.round((baseIslrBs * porcentajeIslr) / 100));
      recalcular();
    }
  });
  $("#todo").addEventListener("click", () => {
    if (moneda() === "USD") $("#monto").value = aTexto(saldo_usd);
    else { const t = aTasaE8($("#tasa").value); if (!t || Number.isNaN(t)) { aviso("Escribe primero la tasa BCV del día."); return; } $("#monto").value = aTexto(usdABs(saldo_usd, t)); }
    recalcular();
  });
  aplicarMetodo();
  enviar($("#f"), async (v) => {
    const r = await api("pagos", "POST", {
      documento_id: D.id,
      metodo: v.metodo,
      moneda: v.moneda,
      monto: v.monto,
      tasa: v.tasa,
      referencia: v.referencia,
      comprobante_retencion: (v.metodo === "RETENCION_IVA" || v.metodo === "RETENCION_ISLR") ? v.referencia : undefined,
      porcentaje_retencion: v.metodo === "RETENCION_ISLR" ? porcentajeIslr : undefined,
      fecha: v.fecha,
    });
    aviso(`Pago registrado ✅ Recibo ${numeroRecibo(r.numero)}`); location.hash = `#/pagos/recibo/${r.id}`;
  });
}

// ------------------------------------------------------------------ recibo
async function verRecibo(estado, id) {
  const datos = await api(`pagos/${encodeURIComponent(id)}`), { pago: P, documento: D } = datos;
  const anulado = P.estado === "ANULADO";
  const nroControl = D.tipo === "FACTURA" ? (D.control_fiscal || `00-${String(D.control_interno ?? D.numero ?? 1).padStart(8, "0")}`) : null;
  const nroPresupuesto = D.presupuesto_numero != null ? `P-${String(D.presupuesto_numero).padStart(6, "0")}` : null;
  const clienteEmail = D.cliente_email || (D.cliente_id ? (await api(`clientes/${D.cliente_id}`).catch(() => null))?.cliente?.email : "") || "";
  raiz.innerHTML = `
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver" aria-label="Volver">←</button><h1>Recibo ${numeroRecibo(P.numero)}</h1>
      <span class="insignia ${anulado ? "rojo" : "verde"}">${anulado ? "Anulado" : "Vigente"}</span></header>
    ${P.modo === "PRACTICA" ? `<section class="aviso-practica"><b>🧪 MODO PRÁCTICA</b> · recibo de prueba.</section>` : ""}
    ${anulado ? `<section class="aviso-anulado">⛔ ANULADO el ${fechaDoc(P.anulado_en)} · Motivo: ${esc(P.motivo_anulacion)}</section>` : ""}
    <section class="tarjeta">
      <div class="tot"><span>Recibo de Pago N.º</span><b>${esc(numeroRecibo(P.numero))}</b></div>
      <div class="tot"><span>Cliente</span><b>${esc(D.cliente_nombre)} (${esc(D.cliente_rif)})</b></div>
      <div class="tot"><span>${D.tipo === "FACTURA" ? (D.es_nota_debito ? "Nota de Débito N.º" : "Factura asociada N.º") : "Presupuesto N.º"}</span><b>${esc(numeroDoc(D))}</b></div>
      ${nroControl ? `<div class="tot"><span>N.º de Control Fiscal</span><b>${esc(nroControl)}</b></div>` : ""}
      ${nroPresupuesto ? `<div class="tot"><span>Presupuesto de origen N.º</span><b>${esc(nroPresupuesto)}</b></div>` : ""}
      <div class="tot"><span>Forma de pago</span><b>${esc(metodoNombre(P.metodo))}${P.es_retencion_islr && P.porcentaje_retencion ? ` (${P.porcentaje_retencion}%)` : ""} (${P.moneda === "BS" ? (estado?.negocio?.tipo_contribuyente === "ESPECIAL" ? "Bolívares · Sin IGTF" : "Bolívares") : "Divisas USD"})</b></div>
      ${P.comprobante_retencion ? `<div class="tot"><span>${P.es_retencion_islr ? "Comprobante Retención ISLR" : "Comprobante Retención SENIAT"}</span><b>${esc(P.comprobante_retencion)}</b></div>` : ""}
      ${P.referencia && P.referencia !== P.comprobante_retencion ? `<div class="tot"><span>Referencia</span><b>${esc(P.referencia)}</b></div>` : ""}
      <div class="tot"><span>Monto recibido</span><b>${P.moneda === "BS" ? "Bs. " + bs(P.monto_recibido / 100) : usd(P.monto_recibido)}</b></div>
      ${P.moneda === "BS" ? `<div class="tot"><span>Tasa BCV del pago</span><b>Bs. ${bs(P.tasa_e8 / 1e8)}</b></div>` : ""}
      <div class="tot"><span>Acreditado al documento</span><b>${usd(P.monto_usd)}</b></div>
      <div class="tot"><span>Fecha del pago</span><b>${fechaDoc(P.fecha_pago)}</b></div>
      <div class="tot grande"><span>Saldo tras este pago</span><b>${usd(P.saldo_despues_usd)}</b></div></section>
    <p class="error" id="error" role="alert" hidden></p>
    <button type="button" class="boton" data-acc="pdf">📄 Descargar recibo PDF</button>
    <button type="button" class="boton verde" data-acc="compartir">📤 Compartir recibo</button>
    <button type="button" class="boton contorno-azul" data-acc="correo">✉️ Enviar recibo por correo (PDF)</button>
    <button type="button" class="boton" data-acc="whatsapp">💬 Enviar mensaje por WhatsApp</button>
    <button type="button" class="boton contorno-azul" data-acc="doc">Ver el documento</button>
    ${!anulado && puede("anular") && datos.puede_anular_fiscal !== false
      ? `<button type="button" class="boton contorno" data-acc="anular">⛔ Anular este pago</button>`
      : (!anulado && puede("anular") && datos.motivo_bloqueo_anular
        ? `<section class="tarjeta"><span class="etiqueta">🛡️ PROTECCIÓN FISCAL SENIAT</span><p class="suave" style="margin:6px 0 0">${esc(datos.motivo_bloqueo_anular)}</p></section>`
        : "")}
    <form id="recibo-correo-form" class="tarjeta" hidden>
      <h2>✉️ Enviar Recibo ${esc(numeroRecibo(P.numero))} con PDF adjunto</h2>
      <p class="pista">Se enviará el comprobante de pago en Bolívares y USD con el PDF del recibo adjunto.</p>
      ${campo("email_destino", "✉️ Correo del cliente", clienteEmail, "email", 'required placeholder="cliente@correo.com"')}
      ${ERROR}<button class="boton verde" type="submit">ENVIAR RECIBO POR CORREO ➔</button>
    </form>
    <form id="anular-form" class="tarjeta" hidden>${campo("motivo", "Motivo de la anulación (mínimo 5 letras)", "", "text", 'required minlength="5" maxlength="200"')}
      ${ERROR}<button class="boton rojo" type="submit">CONFIRMAR ANULACIÓN</button></form>`;
  $("#atras").addEventListener("click", () => { volverA = "COBROS"; location.hash = "#/pagos"; });
  const pedir = async (fn) => { try { await fn(); } catch (e) { const er = $("#error"); er.textContent = e.message; er.hidden = false; } };
  const esDemo = Boolean(estado?.demo?.activo);
  const bytesRecibo = async () => await construirRecibo(await cargarPdfLib(), { ...datos, esDemo });
  const blob = async () => new Blob([await bytesRecibo()], { type: "application/pdf" });
  const accion = {
    pdf: () => pedir(async () => descargar(await blob(), nombreRecibo(P, esDemo))),
    compartir: () => pedir(async () => compartir(await blob(), nombreRecibo(P, esDemo))),
    correo: () => {
      $("#recibo-correo-form").hidden = !$("#recibo-correo-form").hidden;
      if (!$("#recibo-correo-form").hidden) $("#email_destino")?.focus();
    },
    whatsapp: () => pedir(async () => {
      if (!D.cliente_whatsapp) throw new Error("Este cliente no tiene WhatsApp: agrégalo en Clientes.");
      const texto = `Hola ${D.cliente_nombre} 👋\nRecibimos tu pago: Recibo N.º ${numeroRecibo(P.numero)} por ${usd(P.monto_usd)}`
        + `${P.moneda === "BS" ? ` (Bs. ${bs(P.monto_recibido / 100)}, tasa ${bs(P.tasa_e8 / 1e8)})` : ""} del ${fechaDoc(P.fecha_pago)}, `
        + `${D.tipo === "FACTURA" ? `${D.es_nota_debito ? "Nota de Débito" : "Factura"} N.º ${numeroDoc(D)}${nroControl ? ` (Control ${nroControl})` : ""}` : `Presupuesto N.º ${numeroDoc(D)}`}`
        + `${nroPresupuesto ? ` · Presupuesto origen ${nroPresupuesto}` : ""}.\n`
        + `${P.saldo_despues_usd > 0 ? `Saldo pendiente: ${usd(P.saldo_despues_usd)}` : "✅ Documento pagado por completo"}\nGracias 🙏`;
      abrirEnlace(enlaceWhatsApp(D.cliente_whatsapp, texto)); aviso("Se abrió WhatsApp con el mensaje. Adjunta el recibo con «Compartir recibo».");
    }),
    doc: () => (location.hash = `#/factura/${D.id}`),
    anular: () => { $("#anular-form").hidden = false; $("#motivo").focus(); },
  };
  raiz.querySelectorAll("[data-acc]").forEach((b) => b.addEventListener("click", () => accion[b.dataset.acc]()));
  enviar($("#recibo-correo-form"), async (v) => {
    const bytes = await bytesRecibo();
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const pdf_base64 = btoa(bin);
    const r = await api(`pagos/${P.id}/enviar-correo`, "POST", {
      email: v.email_destino,
      pdf_base64,
      nombre_archivo: nombreRecibo(P, esDemo),
    });
    aviso(
      r?.demo_redirigido_a
        ? `🧪 Recibo de prueba enviado a ${r.demo_redirigido_a} (quedan ${r.demo_restantes ?? 0} de ${estado?.demo?.max_correos ?? 5}) ✅`
        : `Recibo enviado a ${v.email_destino} ✅`
    );
    $("#recibo-correo-form").hidden = true;
  });
  enviar($("#anular-form"), async (v) => { await api(`pagos/${P.id}/anular`, "POST", { motivo: v.motivo }); aviso("Pago anulado"); await verRecibo(estado, id); });
}
