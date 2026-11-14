// Módulo FACTURA (pantallas): lista, editor de borradores, vista del documento, IGTF por factura, Notas de Crédito (devoluciones SENIAT) y PDF.
// Toda la matemática del dinero sale de dinero.js (la misma que usa el servidor).
import { $, raiz, esc, bs, usd, aTexto, api, aviso, campo, enviar, navegacion, activar, descargar, compartir, cargarPdfLib, abrirEnlace, puede, ERROR } from "./comun.js";
import { aTasaE8, aCantidadMilli, aCentavos, calcular, cantidadTexto } from "./dinero.js";
import { construirPdf, nombreArchivo, numeroDoc, numeroRecibo, metodoNombre } from "./pdf.js";
import { mensajeDocumento, enlaceWhatsApp } from "./pagos.js";

const NOMBRE = { FACTURA: "Factura", PRESUPUESTO: "Presupuesto", NOTA_CREDITO: "Nota de crédito" };
const nombreDe = (d) => (d.es_nota_credito ? "Nota de crédito" : NOMBRE[d.tipo] ?? d.tipo);
const ESTADOS = { BORRADOR: ["Borrador", "gris"], EMITIDO: ["Emitido", "verde"], FACTURADO: ["Facturado", "azul"], ANULADO: ["Anulado", "rojo"] };
const dia = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(d);
const fechaDoc = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "");
const costoAlVuelo = (t) => { const c = aCentavos(t); return c == null || Number.isNaN(c) ? null : c; };
const stockPoco = (l, q) => (l?.controla && q > l.stock_milli ? ` · ⚠️ Solo hay ${cantidadTexto(Math.max(l.stock_milli, 0))} en existencias` : "");
const bannerPractica = (estado) => (estado.modo === "PRACTICA"
  ? `<section class="aviso-practica"><b>🧪 MODO PRÁCTICA</b> · los documentos son de prueba, no valen y se borran al salir en vivo (en Ajustes).</section>` : "");

function tasaInfo(estado) {
  const n = estado.negocio, e8 = aTasaE8(String(n.tasa_bcv));
  const f = n.tasa_bcv_fecha ? new Date(String(n.tasa_bcv_fecha).replace(" ", "T") + "Z") : null;
  const dias = f ? Math.round((Date.parse(`${dia(new Date())}T00:00:00Z`) - Date.parse(`${dia(f)}T00:00:00Z`)) / 86400000) : null;
  const cuando = dias === null ? "sin fecha" : dias <= 0 ? "actualizada hoy" : dias === 1 ? "actualizada ayer" : `actualizada hace ${dias} días`;
  return { e8: e8 && !Number.isNaN(e8) ? e8 : null, valor: Number(n.tasa_bcv) || 0, cuando, vieja: dias === null || dias > 3 };
}

let tab = "FACTURA"; // FACTURA | PRESUPUESTO | NOTA_CREDITO

export async function vistaFactura(estado, id, extra) {
  if (id === "nuevo") return editor(estado, null, extra === "PRESUPUESTO" ? "PRESUPUESTO" : "FACTURA");
  if (id) {
    try { return extra === "editar" ? await editor(estado, await cargarBorrador(id)) : await ver(estado, id); }
    catch (e) { aviso(e.message); location.hash = "#/factura"; return; }
  }
  lista(estado);
}

// ------------------------------------------------------------------ lista
const estadoVisible = (x) => {
  if (x.es_nota_credito) return x.estado === "ANULADO" ? ["Anulada", "rojo"] : ["Aplicada", "azul"];
  if (x.tipo === "FACTURA" && x.estado === "EMITIDO") {
    if (x.total_usd - x.pagado_usd <= 0) return ["Pagada", "verde"];
    if (x.vence_el && x.vence_el < dia(new Date())) return ["Vencida", "rojo"];
    return x.pagado_usd > 0 ? ["Abonada", "ambar"] : ["Por cobrar", "gris"];
  }
  return ESTADOS[x.estado];
};
const fila = (x) => {
  const [txt, color] = estadoVisible(x);
  const nom = nombreDe(x);
  const titulo = x.numero == null ? `${nom} (borrador)` : `${nom} ${numeroDoc(x)}`;
  const refAf = x.es_nota_credito && x.factura_afectada_numero != null ? ` · Afecta Factura ${String(x.factura_afectada_numero).padStart(8, "0")}` : "";
  return `<article class="fila" data-id="${x.id}">
    <div class="dato"><strong>${esc(titulo)}</strong>
      <small class="suave">${esc(x.cliente ?? "Sin cliente")}${x.fecha_emision ? " · " + fechaDoc(x.fecha_emision) : ""}${esc(refAf)}</small>
      <small class="suave">${usd(x.total_usd)}${x.total_bs != null ? ` · Bs. ${bs(x.total_bs / 100)}` : ""}${x.aplica_igtf ? " · IGTF 3%" : ""}${x.tipo === "FACTURA" && !x.es_nota_credito && x.estado === "EMITIDO" && x.total_usd - x.pagado_usd > 0 ? ` · Saldo ${usd(x.total_usd - x.pagado_usd)}` : ""}</small></div>
    <span class="insignia ${color}">${txt}</span>${x.modo === "PRACTICA" ? `<span class="insignia" title="Práctica">🧪</span>` : ""}</article>`;
};

function lista(estado) {
  raiz.innerHTML = `
    <header class="encabezado"><h1>🧾 Factura</h1><button class="icono azul" id="nuevo" data-ayuda="Crear una factura o presupuesto nuevo" aria-label="Nuevo">＋</button></header>
    ${bannerPractica(estado)}
    <div class="chips tres">${[["FACTURA", "🧾 Facturas"], ["PRESUPUESTO", "📋 Presupuestos"], ["NOTA_CREDITO", "↩️ Notas de crédito"]].map(([v, t]) => `<button class="chip ${v === tab ? "activo" : ""}" data-t="${v}">${t}</button>`).join("")}</div>
    <input id="buscar" type="search" placeholder="🔎 Buscar por cliente o número" aria-label="Buscar" autocomplete="off">
    <div id="lista" class="lista"><p class="suave">Cargando…</p></div>
    ${navegacion("factura")}`;
  $("#nuevo").addEventListener("click", () => (location.hash = `#/factura/nuevo/${tab === "PRESUPUESTO" ? "PRESUPUESTO" : "FACTURA"}`));
  activar();
  const cargar = async () => {
    if (!$("#buscar")) return;
    const q = $("#buscar").value;
    try {
      const { documentos } = await api(`documentos?tipo=${tab}&q=${encodeURIComponent(q)}`);
      const caja = $("#lista"); if (!caja) return;
      const vacioTxt = tab === "NOTA_CREDITO"
        ? "No hay notas de crédito emitidas. Para crear una devolución, abre la factura original y toca «↩️ Devolver (Nota de crédito)»."
        : `Aún no tienes ${tab === "FACTURA" ? "facturas" : "presupuestos"}. Toca ＋ para crear ${tab === "FACTURA" ? "la primera" : "el primero"}.`;
      caja.innerHTML = documentos.length ? documentos.map(fila).join("") : `<p class="suave">${q ? "Sin resultados." : vacioTxt}</p>`;
      caja.querySelectorAll("[data-id]").forEach((el) => el.addEventListener("click", () => (location.hash = `#/factura/${el.dataset.id}`)));
    } catch (e) { if ($("#lista")) $("#lista").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };
  raiz.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    tab = b.dataset.t; raiz.querySelectorAll(".chip").forEach((x) => x.classList.toggle("activo", x === b)); cargar();
  }));
  let espera; $("#buscar").addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(cargar, 250); });
  cargar();
}

// ------------------------------------------------------------------ editor de borradores
async function cargarBorrador(id) {
  const { documento: D, lineas } = await api(`documentos/${encodeURIComponent(id)}`);
  if (D.estado !== "BORRADOR") throw new Error("Solo se puede editar un borrador.");
  const cliente = D.cliente_id ? (await api(`clientes/${D.cliente_id}`)).cliente : null;
  return {
    id: D.id, tipo: D.tipo, cliente, nota: D.nota ?? "", condicion: D.condicion ?? "CONTADO", dias_credito: D.dias_credito ?? "",
    aplica_igtf: !!D.aplica_igtf,
    lineas: lineas.map((l) => ({
      catalogo_id: l.catalogo_id, tipo: l.tipo, descripcion: l.descripcion, cantidad: cantidadTexto(l.cantidad_milli),
      precio: aTexto(l.precio_usd), alicuota_iva: l.alicuota_cent / 100, costo_usd: l.costo_usd, costo: l.catalogo_id ? "" : aTexto(l.costo_usd),
    })),
  };
}

function editor(estado, existente, tipoNuevo) {
  const d = existente ?? {
    id: null, tipo: tipoNuevo, cliente: null, nota: "", condicion: "CONTADO", dias_credito: "",
    aplica_igtf: tipoNuevo === "FACTURA" && !!estado.negocio?.igtf_activo, lineas: [],
  };
  const tasa = tasaInfo(estado), nombre = NOMBRE[d.tipo];
  raiz.innerHTML = `
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver" aria-label="Volver">←</button><h1>${d.id ? `Editar ${nombre.toLowerCase()}` : d.tipo === "FACTURA" ? "Nueva factura" : "Nuevo presupuesto"}</h1></header>
    ${bannerPractica(estado)}
    <section class="tarjeta" id="sec-cliente"></section>
    <section class="tarjeta"><span class="etiqueta">🧾 RENGLONES</span><div id="lineas"></div>
      <div class="dos-botones"><button type="button" class="boton chico morado" id="add-inv">🏷️ Del inventario</button><button type="button" class="boton chico" id="add-srv">🛠️ Servicio al momento</button><button type="button" class="boton chico" id="add-prod">📦 Producto al vuelo</button></div>
      <div id="picker" hidden></div></section>
    ${d.tipo === "FACTURA" ? `<section class="tarjeta"><div class="reng-cab"><span class="etiqueta">💱 IGTF · NORMATIVA VENEZOLANA (3%)</span><span id="igtf-insignia" class="insignia ${d.aplica_igtf ? "verde" : "gris"}">${d.aplica_igtf ? "Activo · 3%" : "Desactivado"}</span></div>
      <label class="conmutador" for="aplica_igtf">
        <span class="conmutador-txt"><span>Calcular IGTF (3%) sobre el total</span><small id="igtf-subtxt">${d.aplica_igtf ? "Se percibe 3% sobre Subtotal + IVA (pagos en divisas / cripto)." : "No se suma IGTF (solo Subtotal + IVA en Bs.)."}</small></span>
        <span class="switch"><input type="checkbox" role="switch" id="aplica_igtf" aria-checked="${d.aplica_igtf ? "true" : "false"}" ${d.aplica_igtf ? "checked" : ""}><span class="switch-pista" aria-hidden="true"></span></span>
      </label>
      <p class="pista">Según la Ley de IGTF (Providencia SNAT/2022/000013), el 3% aplica únicamente sobre el monto pagado en divisas o criptoactivos distintos al bolívar cuando el emisor es sujeto pasivo especial (agente de percepción).</p></section>` : ""}
    <section class="tarjeta" id="sec-totales"></section>
    ${d.tipo === "FACTURA" ? `<section class="tarjeta"><span class="etiqueta">🗓️ CONDICIÓN DE PAGO</span>
      <label class="opcion"><input type="radio" name="condicion" value="CONTADO" ${d.condicion !== "CREDITO" ? "checked" : ""}> Contado</label>
      <label class="opcion"><input type="radio" name="condicion" value="CREDITO" ${d.condicion === "CREDITO" ? "checked" : ""}> A crédito (paga después)</label>
      <div id="dias-box" hidden>${campo("dias_credito", "Días de plazo", d.dias_credito, "text", 'inputmode="numeric" maxlength="3"')}</div></section>` : ""}
    <section class="tarjeta"><label for="nota">📝 Nota o garantía (sale en el PDF)</label><textarea id="nota" rows="3" maxlength="500">${esc(d.nota)}</textarea></section>
    <p class="error" id="error" role="alert" hidden></p>
    <button class="boton verde" type="button" id="emitir">EMITIR ${nombre.toUpperCase()}</button>
    <button class="boton contorno-azul" type="button" id="guardar">Guardar borrador</button>`;
  $("#atras").addEventListener("click", () => (location.hash = d.id ? `#/factura/${d.id}` : "#/factura"));

  // ---- cliente
  const pintarCliente = () => {
    const s = $("#sec-cliente");
    if (d.cliente) {
      s.innerHTML = `<span class="etiqueta">👤 CLIENTE</span><div class="fila sin-borde"><div class="dato"><strong>${esc(d.cliente.nombre_apellido)}</strong><small class="suave">${esc(d.cliente.rif_cedula)}</small></div><button type="button" class="boton chico" id="cli-cambiar">Cambiar</button></div>`;
      $("#cli-cambiar").addEventListener("click", () => { d.cliente = null; pintarCliente(); });
      return;
    }
    s.innerHTML = `<span class="etiqueta">👤 CLIENTE</span>
      <input id="cli-q" type="search" placeholder="🔎 Buscar cliente" autocomplete="off" aria-label="Buscar cliente">
      <div id="cli-res" class="lista"></div>
      <button type="button" class="boton chico" id="cli-nuevo">＋ Cliente nuevo</button>
      <form id="cli-form" hidden>
        ${campo("rif_cedula", "🪪 Cédula o RIF", "", "text", 'required placeholder="V-12345678 o J-12345678-9" autocapitalize="characters"')}
        ${campo("nombre_apellido", "👤 Nombre y apellido (o razón social)", "", "text", "required")}
        ${campo("whatsapp", "📲 WhatsApp (opcional)", "", "tel", 'placeholder="0414-1234567"')}
        ${ERROR}<button class="boton" type="submit">GUARDAR Y USAR</button></form>`;
    const buscar = async () => {
      if (!$("#cli-q")) return;
      try {
        const { clientes } = await api(`clientes?q=${encodeURIComponent($("#cli-q").value)}`);
        if (!$("#cli-res")) return;
        $("#cli-res").innerHTML = (clientes.length ? `<p class="pista">Toca un cliente para elegirlo:</p>` : "") + clientes.slice(0, 6).map((c) => `<article class="fila" data-c="${c.id}"><div class="dato"><strong>${esc(c.nombre_apellido)}</strong><small class="suave">${esc(c.rif_cedula)}</small></div></article>`).join("")
          || `<p class="suave">No hay coincidencias. Crea el cliente con «＋ Cliente nuevo».</p>`;
        $("#cli-res").querySelectorAll("[data-c]").forEach((el) => el.addEventListener("click", () => { d.cliente = clientes.find((c) => String(c.id) === el.dataset.c); pintarCliente(); }));
      } catch (e) { if ($("#cli-res")) $("#cli-res").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    };
    let espera; $("#cli-q").addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(buscar, 250); });
    $("#cli-nuevo").addEventListener("click", () => { $("#cli-form").hidden = !$("#cli-form").hidden; });
    enviar($("#cli-form"), async (v) => {
      const { id } = await api("clientes", "POST", v);
      d.cliente = (await api(`clientes/${id}`)).cliente; pintarCliente();
    });
    buscar();
  };

  // ---- renglones
  const pintarLineas = () => {
    $("#lineas").innerHTML = d.lineas.length ? d.lineas.map((l, i) => `
      <div class="reng" data-i="${i}">
        <div class="reng-cab"><span>${l.catalogo_id ? (l.tipo === "SERVICIO" ? "🛠️ Servicio" : "📦 Producto") : l.tipo === "PRODUCTO" ? "📦 Producto al vuelo" : "🛠️ Servicio al momento"}</span><button type="button" class="x" data-quitar="${i}" aria-label="Quitar renglón">✕</button></div>
        <input data-campo="descripcion" value="${esc(l.descripcion)}" placeholder="Descripción" maxlength="200" aria-label="Descripción">
        <div class="reng-fila">
          <label>Cant.<input data-campo="cantidad" value="${esc(l.cantidad)}" inputmode="decimal" aria-label="Cantidad"></label>
          <label>Precio USD<input data-campo="precio" value="${esc(l.precio)}" inputmode="decimal" placeholder="0,00" aria-label="Precio en USD"></label>
          <label>IVA${l.catalogo_id ? `<span class="iva-fijo">${l.alicuota_iva ? l.alicuota_iva + "%" : "Exento"}</span>`
            : `<select data-campo="alicuota_iva" aria-label="IVA">${[[16, "16%"], [8, "8%"], [0, "Exento"]].map(([n, t]) => `<option value="${n}" ${n === l.alicuota_iva ? "selected" : ""}>${t}</option>`).join("")}</select>`}</label>
        </div>
        ${!l.catalogo_id && l.tipo === "PRODUCTO" ? `<label>🔒 Costo USD c/u (solo lo ves tú)<input data-campo="costo" value="${esc(l.costo ?? "")}" inputmode="decimal" placeholder="Opcional" aria-label="Costo en USD"></label>` : ""}
        <small class="suave" data-sub="${i}"></small>
      </div>`).join("") : `<p class="suave">Agrega productos o servicios del inventario, o un servicio al momento.</p>`;
    refrescar();
  };
  const editarCampo = (e) => {
    const el = e.target.closest("[data-campo]"); if (!el) return;
    const l = d.lineas[Number(el.closest("[data-i]").dataset.i)], k = el.dataset.campo;
    l[k] = k === "alicuota_iva" ? Number(el.value) : el.value; refrescar();
  };
  $("#lineas").addEventListener("input", editarCampo); $("#lineas").addEventListener("change", editarCampo);
  $("#lineas").addEventListener("click", (e) => { const q = e.target.closest("[data-quitar]"); if (q) { d.lineas.splice(Number(q.dataset.quitar), 1); pintarLineas(); } });
  $("#add-srv").addEventListener("click", () => {
    d.lineas.push({ catalogo_id: null, tipo: "SERVICIO", descripcion: "", cantidad: "1", precio: "", alicuota_iva: 16, costo_usd: null });
    pintarLineas(); raiz.querySelector(`[data-i="${d.lineas.length - 1}"] [data-campo="descripcion"]`).focus();
  });
  $("#add-prod").addEventListener("click", () => {
    d.lineas.push({ catalogo_id: null, tipo: "PRODUCTO", descripcion: "", cantidad: "1", precio: "", costo: "", alicuota_iva: 16, costo_usd: null });
    pintarLineas(); raiz.querySelector(`[data-i="${d.lineas.length - 1}"] [data-campo="descripcion"]`).focus();
  });
  $("#add-inv").addEventListener("click", () => {
    const p = $("#picker"); p.hidden = !p.hidden; if (p.hidden) return;
    p.innerHTML = `<input id="inv-q" type="search" placeholder="🔎 Buscar en el inventario" autocomplete="off" aria-label="Buscar en el inventario"><div id="inv-res" class="lista"></div>`;
    const cargar = async () => {
      if (!$("#inv-q")) return;
      try {
        const { items } = await api(`catalogo?q=${encodeURIComponent($("#inv-q").value)}`), activos = items.filter((i) => i.activo);
        if (!$("#inv-res")) return;
        $("#inv-res").innerHTML = activos.map((i) => `<article class="fila" data-it="${i.id}"><span class="icono-tipo ${i.tipo === "SERVICIO" ? "morado" : ""}">${i.tipo === "SERVICIO" ? "🛠️" : "📦"}</span>
          <div class="dato"><strong>${esc(i.nombre)}</strong><small class="suave">${i.precio_centavos == null ? "Precio a definir" : usd(i.precio_centavos)}${i.tipo === "PRODUCTO" && i.controla_stock ? ` · Stock ${cantidadTexto(i.stock_milli)}` : ""}</small></div></article>`).join("") || `<p class="suave">Nada por aquí. Crea productos y servicios en Inventario.</p>`;
        $("#inv-res").querySelectorAll("[data-it]").forEach((el) => el.addEventListener("click", () => {
          const it = activos.find((x) => String(x.id) === el.dataset.it);
          d.lineas.push({ catalogo_id: it.id, tipo: it.tipo, descripcion: it.nombre, cantidad: "1", precio: aTexto(it.precio_centavos), alicuota_iva: it.alicuota_iva, costo_usd: it.costo_centavos, controla: it.tipo === "PRODUCTO" && !!it.controla_stock, stock_milli: it.stock_milli });
          p.hidden = true; pintarLineas();
        }));
      } catch (e) { if ($("#inv-res")) $("#inv-res").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    };
    let espera; $("#inv-q").addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(cargar, 250); }); cargar();
  });

  // ---- totales en vivo (mismo cálculo que el servidor, incluyendo IGTF si está activo)
  const calculoActual = () => {
    const validas = []; let malas = 0;
    d.lineas.forEach((l, i) => {
      const cant = aCantidadMilli(l.cantidad), precio = aCentavos(l.precio);
      if (cant === null || Number.isNaN(cant) || precio === null || Number.isNaN(precio)) { malas++; return; }
      validas.push({ cantidad_milli: cant, precio_usd: precio, alicuota_cent: Math.round(l.alicuota_iva * 100), costo_usd: l.catalogo_id ? l.costo_usd : costoAlVuelo(l.costo), _i: i });
    });
    try { return { r: calcular(validas, tasa.e8, { aplica_igtf: d.tipo === "FACTURA" && d.aplica_igtf }), validas, malas }; }
    catch (e) { return { error: e.message, validas, malas }; }
  };
  function refrescar() {
    const c = calculoActual(), t = $("#sec-totales");
    if (c.error) { t.innerHTML = `<p class="error">${esc(c.error)}</p>`; return; }
    c.validas.forEach((v, k) => { const el = raiz.querySelector(`[data-sub="${v._i}"]`); if (el) el.textContent = `Subtotal ${usd(c.r.renglones[k].monto_usd)}${c.r.renglones[k].monto_bs != null ? ` · Bs. ${bs(c.r.renglones[k].monto_bs / 100)}` : ""}${stockPoco(d.lineas[v._i], v.cantidad_milli)}`; });
    d.lineas.forEach((l, i) => { if (!c.validas.some((v) => v._i === i)) { const el = raiz.querySelector(`[data-sub="${i}"]`); if (el) el.textContent = "⚠️ Revisa la cantidad y el precio (ejemplo: 1 y 12,50)"; } });
    const r = c.r, hayCosto = c.validas.some((v) => v.costo_usd != null);
    t.innerHTML = `<span class="etiqueta">💰 TOTALES</span>
      ${r.impuestos.map((i) => i.alicuota_cent === 0 ? `<div class="tot"><span>Monto exento</span><b>${usd(i.base_usd)}</b></div>`
        : `<div class="tot"><span>Base ${i.alicuota_cent / 100}% · IVA</span><b>${usd(i.base_usd)} · ${usd(i.iva_usd)}</b></div>`).join("")}
      ${d.tipo === "FACTURA" && d.aplica_igtf ? `<div class="tot"><span>Subtotal + IVA</span><b>${usd(r.subtotal_usd + r.iva_usd)}${r.subtotal_bs != null ? ` · Bs. ${bs((r.subtotal_bs + r.iva_bs) / 100)}` : ""}</b></div>
        <div class="tot"><span>IGTF (3%)</span><b>${usd(r.igtf_usd)}${r.igtf_bs != null ? ` · Bs. ${bs(r.igtf_bs / 100)}` : ""}</b></div>` : ""}
      <div class="tot grande"><span>${d.tipo === "FACTURA" && d.aplica_igtf ? "TOTAL + IGTF (USD)" : "TOTAL USD"}</span><b>${usd(r.total_usd)}</b></div>
      ${r.total_bs != null ? `<div class="tot"><span>Total en Bs.</span><b>Bs. ${bs(r.total_bs / 100)}</b></div>` : ""}
      <small class="suave">${tasa.e8 ? `Tasa BCV: Bs. ${bs(tasa.valor)}${tasa.vieja ? " · ⚠️ " : " · "}${tasa.cuando}` : "⚠️ Define la tasa BCV en el Inicio para ver y emitir en Bs."}</small>
      ${hayCosto ? `<small class="ganancia-txt">🔒 Ganancia: ${usd(r.subtotal_usd - r.costo_total_usd)} (solo la ves tú)</small>` : ""}`;
  }

  $("#aplica_igtf")?.addEventListener("change", (e) => {
    d.aplica_igtf = e.target.checked;
    e.target.setAttribute("aria-checked", d.aplica_igtf ? "true" : "false");
    const ins = $("#igtf-insignia"), sub = $("#igtf-subtxt");
    if (ins) { ins.textContent = d.aplica_igtf ? "Activo · 3%" : "Desactivado"; ins.className = `insignia ${d.aplica_igtf ? "verde" : "gris"}`; }
    if (sub) sub.textContent = d.aplica_igtf ? "Se percibe 3% sobre Subtotal + IVA (pagos en divisas / cripto)." : "No se suma IGTF (solo Subtotal + IVA en Bs.).";
    refrescar();
  });

  // ---- guardar y emitir
  const cuerpo = () => ({
    tipo: d.tipo, cliente_id: d.cliente?.id ?? null, nota: $("#nota").value, condicion: d.condicion, dias_credito: d.dias_credito,
    aplica_igtf: d.tipo === "FACTURA" && d.aplica_igtf ? 1 : 0,
    lineas: d.lineas.map((l) => ({ catalogo_id: l.catalogo_id, descripcion: l.descripcion, cantidad: l.cantidad, precio_usd: l.precio, alicuota_iva: l.alicuota_iva, ...(l.catalogo_id ? {} : { tipo: l.tipo, costo_usd: l.costo ?? "" }) })),
  });
  const guardar = async () => { if (d.id) await api(`documentos/${d.id}`, "PUT", cuerpo()); else d.id = (await api("documentos", "POST", cuerpo())).id; };
  const ejecutar = async (fn) => {
    const err = $("#error"), botones = [$("#emitir"), $("#guardar")]; err.hidden = true; botones.forEach((b) => (b.disabled = true));
    try { await fn(); } catch (e) { err.textContent = e.message; err.hidden = false; } finally { botones.forEach((b) => (b.disabled = false)); }
  };
  $("#guardar").addEventListener("click", () => ejecutar(async () => { await guardar(); aviso("Borrador guardado ✅"); location.hash = `#/factura/${d.id}`; }));
  $("#emitir").addEventListener("click", () => ejecutar(async () => {
    if (!d.cliente) throw new Error("Elige el cliente primero.");
    const c = calculoActual();
    if (c.error) throw new Error(c.error);
    if (c.malas) throw new Error("Revisa los renglones: hay cantidades o precios con formato inválido.");
    if (!c.r.total_bs) throw new Error("Define la tasa BCV de hoy en el Inicio antes de emitir.");
    await guardar();
    const aviso1 = `¿Emitir ${nombre.toLowerCase()} a ${d.cliente.nombre_apellido} por ${usd(c.r.total_usd)} (Bs. ${bs(c.r.total_bs / 100)})${d.aplica_igtf ? " [incluye IGTF 3%]" : ""}?\n\nCondición de pago: ${d.tipo === "FACTURA" && d.condicion === "CREDITO" ? `a crédito, ${d.dias_credito} días` : "contado"}.\n\nDespués NO se puede editar ni borrar: solo anular o ajustar con Nota de Crédito.`
      + `\n\nTasa BCV usada: Bs. ${bs(tasa.valor)} (${tasa.cuando})${tasa.vieja ? " ⚠️ revísala antes de emitir" : ""}.${estado.modo === "PRACTICA" ? "\n\n🧪 Modo práctica: es un documento de prueba." : ""}`;
    if (!confirm(aviso1)) { aviso("Quedó guardado como borrador."); return; }
    await api(`documentos/${d.id}/emitir`, "POST");
    aviso(`${nombre} emitida ✅`); location.hash = `#/factura/${d.id}`;
  }));
  if (d.tipo === "FACTURA") {
    const mostrar = () => { $("#dias-box").hidden = d.condicion !== "CREDITO"; };
    raiz.querySelectorAll('input[name="condicion"]').forEach((x) => x.addEventListener("change", () => { d.condicion = x.value; mostrar(); }));
    $("#dias_credito").addEventListener("input", (e) => { d.dias_credito = e.target.value; });
    mostrar();
  }
  pintarCliente(); pintarLineas();
}

// ------------------------------------------------------------------ vista de un documento
const seccionPagos = (D, pagos, notasCredito, pagado, acreditadoNc, saldo) => `<section class="tarjeta"><span class="etiqueta">💵 ${D.tipo === "FACTURA" ? "PAGOS Y NOTAS DE CRÉDITO" : "ABONOS"}</span>
  ${D.tipo === "FACTURA" ? `<div class="tot"><span>Condición</span><b>${D.condicion === "CREDITO" ? `Crédito ${D.dias_credito} días · vence ${fechaDoc(D.vence_el)}` : "Contado"}</b></div>` : ""}
  <div class="tot"><span>${D.tipo === "FACTURA" ? "Pagado" : "Abonado"}</span><b>${usd(pagado - acreditadoNc)}</b></div>
  ${acreditadoNc > 0 ? `<div class="tot"><span>Acreditado por Notas de Crédito</span><b>${usd(acreditadoNc)}</b></div>` : ""}
  <div class="tot grande"><span>${saldo > 0 ? "SALDO" : "SALDADA"}</span><b>${usd(Math.max(saldo, 0))}</b></div>
  ${notasCredito.map((nc) => `<div class="reng-ver ${nc.estado === "ANULADO" ? "apagado" : "enlace"}" data-doc="${nc.id}"><div><b>↩️ Nota de crédito NC-${String(nc.numero).padStart(8, "0")}</b>${nc.estado === "ANULADO" ? " · anulada" : ""}<br>
    <small class="suave">${fechaDoc(nc.fecha_emision)} · ${esc(nc.motivo_nc || "Devolución")}</small></div><b>-${usd(nc.total_usd)}</b></div>`).join("")}
  ${pagos.map((p) => `<div class="reng-ver ${p.estado === "ANULADO" ? "apagado" : ""}" data-recibo="${p.id}"><div><b>Recibo ${numeroRecibo(p.numero)}</b>${p.estado === "ANULADO" ? " · anulado" : ""}<br>
    <small class="suave">${esc(metodoNombre(p.metodo))} · ${p.moneda === "BS" ? "Bs. " + bs(p.monto_recibido / 100) : usd(p.monto_recibido)} · ${fechaDoc(p.fecha_pago)}</small></div><b>${usd(p.monto_usd)}</b></div>`).join("")}</section>`;

async function ver(estado, id) {
  const datos = await api(`documentos/${encodeURIComponent(id)}`);
  const { documento: D, lineas, impuestos, pagos = [], notas_credito = [], factura_afectada: FA = null, pagado_usd = 0, acreditado_nc_usd = 0, saldo_usd = null } = datos;
  const [estTxt, estColor] = ESTADOS[D.estado], emitido = D.estado !== "BORRADOR", esNc = !!D.es_nota_credito, reglas = JSON.parse(D.parametros_json || "{}");
  const cliente = D.cliente_nombre ? { nombre: D.cliente_nombre, rif: D.cliente_rif } : D.cliente_id ? await api(`clientes/${D.cliente_id}`).then((r) => ({ nombre: r.cliente.nombre_apellido, rif: r.cliente.rif_cedula })) : null;
  const maquina = D.tipo === "FACTURA" && emitido && D.medio === "MAQUINA_FISCAL";
  const sinControl = D.tipo === "FACTURA" && emitido && !D.control_fiscal && !maquina;
  const nom = nombreDe(D);
  const titulo = esNc ? "Nota de crédito" : D.tipo === "FACTURA" && emitido && !D.control_fiscal && !maquina ? (reglas.titulo_sin_control || "Factura") : nom;
  const pideFiscal = D.tipo === "FACTURA" && D.estado === "EMITIDO" && !!D.medio && !D.control_fiscal;
  const tieneDisponibleDevolver = D.tipo === "FACTURA" && !esNc && D.estado === "EMITIDO" && lineas.some((l) => l.cantidad_milli - (l.devuelto_milli ?? 0) > 0);

  const botones = D.estado === "BORRADOR"
    ? [["editar", "✏️ Editar", ""], ["emitir", `EMITIR ${nom.toUpperCase()}`, "verde"], ["borrar", "Eliminar borrador", "contorno"]]
    : [["pdf", "📄 Descargar PDF", ""], ["compartir", "📤 Compartir PDF", "verde"],
      ...(D.estado === "EMITIDO" && !esNc && saldo_usd > 0 ? [["pagar", "💵 Registrar pago", "verde"]] : []),
      ["whatsapp", "💬 Enviar por WhatsApp", ""],
      ...(D.tipo === "PRESUPUESTO" && D.estado === "EMITIDO" ? [["convertir", "🧾 Convertir en factura", ""]] : []),
      ...(!esNc ? [["copiar", "📑 Copiar como borrador nuevo", "contorno-azul"]] : []),
      ...(tieneDisponibleDevolver && puede("anular") ? [["devolver", "↩️ Devolver (Nota de crédito SENIAT)", "morado"]] : []),
      ...(D.estado === "EMITIDO" && puede("anular") ? [["anular", "⛔ Anular", "contorno"]] : [])];

  const tienePagosVigentes = pagos.some((p) => p.estado === "VIGENTE");
  const tieneNcVigentes = notas_credito.some((n) => n.estado === "EMITIDO");
  const mesCerrado = D.tipo === "FACTURA" && !esNc && D.fecha_emision && String(D.fecha_emision).slice(0, 7) !== dia(new Date()).slice(0, 7);
  const impresaMaquina = D.tipo === "FACTURA" && !esNc && D.medio === "MAQUINA_FISCAL" && !!D.control_fiscal;
  const bloqueoAnularFactura = D.tipo === "FACTURA" && !esNc
    ? (tienePagosVigentes ? "Esta factura tiene pagos registrados. Anula primero los pagos o emite una Nota de Crédito."
      : tieneNcVigentes ? "Esta factura ya tiene Notas de Crédito aplicadas; no puede anularse directamente."
      : impresaMaquina ? "Esta factura ya fue impresa en Máquina Fiscal (N.º " + D.control_fiscal + "). Según la Providencia SENIAT SNAT/2011/0071 debes emitir una Nota de Crédito."
      : mesCerrado ? "Esta factura pertenece a un mes fiscal anterior. Para no alterar el Libro de Ventas cerrado, debes emitir una Nota de Crédito."
      : null)
    : null;

  raiz.innerHTML = `
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver a la lista" aria-label="Volver">←</button>
      <h1>${esc(titulo)} ${emitido ? esc(numeroDoc(D)) : "(borrador)"}</h1><span class="insignia ${estColor}">${estTxt}</span></header>
    ${D.modo === "PRACTICA" ? bannerPractica({ modo: "PRACTICA" }) : ""}
    ${D.estado === "ANULADO" ? `<section class="aviso-anulado">⛔ ANULADO el ${fechaDoc(D.anulado_en)} · Motivo: ${esc(D.motivo_anulacion)}</section>` : ""}
    ${maquina && !D.control_fiscal ? `<section class="aviso-control">🖨️ Falta registrar el número fiscal que imprimió tu máquina fiscal.</section>` : ""}
    ${sinControl ? `<section class="aviso-control">⚠️ ${esc(reglas.leyenda_sin_control || "Documento sin N.º de control fiscal")}</section>` : ""}
    ${esNc ? `<section class="tarjeta"><span class="etiqueta">↩️ FACTURA AFECTADA (NORMATIVA SENIAT)</span>
      <div class="tot"><span>Factura original</span><b>${FA ? `<a href="#/factura/${FA.id}">Factura ${String(FA.numero).padStart(8, "0")}</a>` : esc(String(reglas.factura_afectada_numero ?? "").padStart(8, "0"))}</b></div>
      <div class="tot"><span>Fecha factura original</span><b>${fechaDoc(FA?.fecha_emision ?? reglas.factura_afectada_fecha)}</b></div>
      <div class="tot"><span>Motivo de la devolución</span><b>${esc(D.motivo_nc || "")}</b></div></section>` : ""}
    <section class="tarjeta">
      <div class="tot"><span>Cliente</span><b>${cliente ? esc(cliente.nombre) : "(sin elegir)"}</b></div>
      ${cliente ? `<div class="tot"><span>RIF / C.I.</span><b>${esc(cliente.rif)}</b></div>` : ""}
      ${emitido ? `<div class="tot"><span>Fecha de emisión</span><b>${fechaDoc(D.fecha_emision)}</b></div>` : ""}
      ${D.tipo === "FACTURA" && emitido ? `<div class="tot"><span>N.º de Control</span><b>00-${String(D.control_interno).padStart(8, "0")}</b></div>
        <div class="tot"><span>${maquina ? (esNc ? "Nota de crédito fiscal N.º" : "Factura fiscal N.º") : "N.º de control fiscal"}</span><b>${esc(D.control_fiscal || (maquina ? "Pendiente de registrar" : "No asignado"))}</b></div>
        ${D.fiscal_serial ? `<div class="tot"><span>Serial de la máquina fiscal</span><b>${esc(D.fiscal_serial)}</b></div>` : ""}` : ""}
      ${emitido ? `<div class="tot"><span>Tasa BCV usada</span><b>Bs. ${bs(D.tasa_e8 / 1e8)}</b></div>` : ""}
    </section>
    <section class="tarjeta"><span class="etiqueta">🧾 RENGLONES</span>${lineas.map((l) => `<div class="reng-ver"><div><b>${esc(l.descripcion)}</b><br><small class="suave">${cantidadTexto(l.cantidad_milli)} × ${usd(l.precio_usd)} · ${l.alicuota_cent ? "IVA " + l.alicuota_cent / 100 + "%" : "Exento"}${l.devuelto_milli > 0 ? ` · ↩️ Devuelto: ${cantidadTexto(l.devuelto_milli)}` : ""}</small></div><b>${usd(l.monto_usd)}</b></div>`).join("")}</section>
    <section class="tarjeta"><span class="etiqueta">💰 TOTALES</span>
      ${emitido ? impuestos.map((i) => i.alicuota_cent === 0 ? `<div class="tot"><span>Monto exento</span><b>${usd(i.base_usd)} · Bs. ${bs(i.base_bs / 100)}</b></div>`
        : `<div class="tot"><span>Base ${i.alicuota_cent / 100}%</span><b>${usd(i.base_usd)} · Bs. ${bs(i.base_bs / 100)}</b></div><div class="tot"><span>IVA ${i.alicuota_cent / 100}%</span><b>${usd(i.iva_usd)} · Bs. ${bs(i.iva_bs / 100)}</b></div>`).join("") : ""}
      ${D.aplica_igtf && D.igtf_usd > 0 ? `<div class="tot"><span>Subtotal + IVA</span><b>${usd((D.subtotal_usd ?? 0) + (D.iva_usd ?? 0))}${emitido ? ` · Bs. ${bs(((D.subtotal_bs ?? 0) + (D.iva_bs ?? 0)) / 100)}` : ""}</b></div>
        <div class="tot"><span>IGTF (${(D.igtf_alicuota_cent || 300) / 100}%)</span><b>${usd(D.igtf_usd)}${emitido && D.igtf_bs != null ? ` · Bs. ${bs(D.igtf_bs / 100)}` : ""}</b></div>` : ""}
      <div class="tot grande"><span>${D.aplica_igtf && D.igtf_usd > 0 ? "TOTAL + IGTF" : "TOTAL"}</span><b>${usd(D.total_usd)}</b></div>
      ${emitido ? `<div class="tot"><span>Total en Bs.</span><b>Bs. ${bs(D.total_bs / 100)}</b></div>` : `<small class="suave">Los montos en Bs. se fijan al emitir, con la tasa BCV de ese momento.</small>`}
      ${D.costo_total_usd ? `<small class="ganancia-txt">🔒 Ganancia: ${usd(D.subtotal_usd - D.costo_total_usd)} (solo la ves tú)</small>` : ""}</section>
    ${pideFiscal ? `<section class="tarjeta"><span class="etiqueta">🧾 REGISTRAR NÚMERO FISCAL</span>
      ${maquina && !estado.negocio.maquina_serial ? `<p class="suave">Primero hay que configurar tu máquina fiscal (serial y último número) en <b>Ajustes → Medio de facturación</b>. Solo el dueño puede hacerlo.</p>` : `
      <p class="suave">${maquina ? `Imprime el documento en tu máquina fiscal (serial <b>${esc(estado.negocio.maquina_serial)}</b>) y confirma el número que salió.` : "Anota aquí el número de control que te dio la imprenta digital."} Solo se puede registrar una vez.</p>
      <form id="fiscal-form">${campo("numero", maquina ? "Número fiscal (propuesto: el siguiente)" : "Número de control", maquina ? String((estado.negocio.maquina_ultimo ?? 0) + 1).padStart(7, "0") : "", "text", `required maxlength="30" autocomplete="off"${maquina ? ' inputmode="numeric"' : ""}`)}
        ${ERROR}<button class="boton chico" type="submit">REGISTRAR</button></form>`}</section>` : ""}
    ${emitido && !esNc ? seccionPagos(D, pagos, notas_credito, pagado_usd, acreditado_nc_usd, saldo_usd) : ""}
    ${D.nota ? `<section class="tarjeta"><span class="etiqueta">📝 NOTA</span><p>${esc(D.nota)}</p></section>` : ""}
    <p class="error" id="error" role="alert" hidden></p>
    ${botones.map(([id2, txt, clase]) => `<button type="button" class="boton ${clase}" data-acc="${id2}">${txt}</button>`).join("")}
    <form id="devolver-form" class="tarjeta" hidden>
      <h2>↩️ Emitir Nota de Crédito (Devolución SENIAT)</h2>
      <p class="pista">Según la Providencia Administrativa SNAT/2011/0071 del SENIAT, cuando una factura ya fue entregada al cliente o hay devolución parcial o total de mercancía/servicio, se emite una <b>Nota de Crédito</b> referenciando la Factura ${esc(numeroDoc(D))}. Las existencias devueltas reingresan al inventario automáticamente.</p>
      <div class="dos-botones">
        <button type="button" class="boton chico" id="dev-todo">Devolución total</button>
        <button type="button" class="boton chico contorno-azul" id="dev-cero">Poner en 0 (elegir parcial)</button>
      </div>
      <div id="devolver-lineas">
        ${lineas.map((l) => {
          const disp = l.cantidad_milli - (l.devuelto_milli ?? 0);
          if (disp <= 0) return "";
          return `<div class="reng">
            <div class="reng-cab"><span>${esc(l.descripcion)}</span><small class="suave">${usd(l.precio_usd)} c/u · Disponible: ${cantidadTexto(disp)}</small></div>
            <label>Cantidad a devolver (0 = no devolver este renglón)
              <input data-dev-orden="${l.orden}" data-max="${cantidadTexto(disp)}" value="${cantidadTexto(disp)}" inputmode="decimal" aria-label="Cantidad a devolver de ${esc(l.descripcion)}">
            </label>
          </div>`;
        }).join("")}
      </div>
      <label class="opcion"><input type="checkbox" id="dev_igtf" ${D.aplica_igtf ? "checked" : ""}> Incluir reverso de IGTF (3%) en la Nota de Crédito</label>
      <div id="dev-totales" class="tarjeta"></div>
      ${campo("motivo_nc", "Motivo de la devolución / Nota de Crédito (mínimo 5 letras)", "", "text", 'required minlength="5" maxlength="200" placeholder="Ej: Devolución de mercancía por el cliente"')}
      ${ERROR}<button class="boton morado" type="submit">EMITIR NOTA DE CRÉDITO</button>
    </form>
    <form id="anular-form" class="tarjeta" hidden>
      <h2>⛔ Anular ${esc(nom.toLowerCase())}</h2>
      ${bloqueoAnularFactura ? `<p class="error">${esc(bloqueoAnularFactura)}</p>
        ${tieneDisponibleDevolver ? `<button type="button" class="boton morado" id="ir-a-nc">↩️ Emitir Nota de Crédito en su lugar</button>` : ""}` : `
      <p class="pista">⚠️ <b>Normativa SENIAT (Art. 37 SNAT/2011/0071):</b> La anulación directa de una factura solo procede dentro del mismo mes fiscal cuando el documento no fue entregado al cliente y se conservan todos sus ejemplares (original y copias). Si el cliente ya recibió la factura o devuelve mercancía, usa «↩️ Devolver (Nota de crédito SENIAT)».</p>
      ${D.tipo === "FACTURA" && !esNc ? `<label class="opcion"><input type="checkbox" id="confirmar_ejemplares" required> Confirmo que conservo el original y todas las copias sin entregar al cliente</label>` : ""}
      ${campo("motivo", "Motivo de la anulación (mínimo 5 letras)", "", "text", 'required minlength="5" maxlength="200" placeholder="Ej: Error de transcripción antes de entregar al cliente"')}
      ${ERROR}<button class="boton rojo" type="submit">CONFIRMAR ANULACIÓN</button>`}</form>`;

  $("#atras").addEventListener("click", () => (location.hash = "#/factura"));
  const pedir = async (fn) => { try { await fn(); } catch (e) { const er = $("#error"); er.textContent = e.message; er.hidden = false; } };
  const blobPdf = async () => new Blob([await construirPdf(await cargarPdfLib(), { doc: D, lineas, impuestos, factura_afectada: FA, negocio: estado.negocio })], { type: "application/pdf" });
  const tasaNc = tasaInfo(estado).e8 || D.tasa_e8;
  const recalcularNc = () => {
    const caja = $("#dev-totales"); if (!caja) return;
    const seleccion = [];
    for (const inp of raiz.querySelectorAll("[data-dev-orden]")) {
      const orden = Number(inp.dataset.devOrden), orig = lineas.find((l) => l.orden === orden);
      const cant = aCantidadMilli(inp.value);
      if (!orig || cant === null || cant === 0) continue;
      if (Number.isNaN(cant) || cant < 0 || cant > orig.cantidad_milli - (orig.devuelto_milli ?? 0)) {
        caja.innerHTML = `<p class="error">⚠️ Revisa la cantidad en «${esc(orig?.descripcion ?? "")}» (máximo disponible: ${cantidadTexto(orig.cantidad_milli - (orig.devuelto_milli ?? 0))}).</p>`;
        return;
      }
      seleccion.push({ cantidad_milli: cant, precio_usd: orig.precio_usd, alicuota_cent: orig.alicuota_cent, costo_usd: orig.costo_usd });
    }
    if (!seleccion.length) {
      caja.innerHTML = `<p class="suave">Indica al menos un renglón con cantidad mayor que 0 para calcular la Nota de Crédito.</p>`;
      return;
    }
    try {
      const calc = calcular(seleccion, tasaNc, { aplica_igtf: $("#dev_igtf")?.checked });
      const nuevoSaldo = Math.max((saldo_usd ?? 0) - calc.total_usd, 0);
      caja.innerHTML = `<span class="etiqueta">📋 RESUMEN DE LA NOTA DE CRÉDITO</span>
        <div class="tot"><span>Subtotal a reversar</span><b>-${usd(calc.subtotal_usd)}${calc.subtotal_bs != null ? ` · -Bs. ${bs(calc.subtotal_bs / 100)}` : ""}</b></div>
        <div class="tot"><span>IVA a reversar</span><b>-${usd(calc.iva_usd)}${calc.iva_bs != null ? ` · -Bs. ${bs(calc.iva_bs / 100)}` : ""}</b></div>
        ${calc.igtf_usd > 0 ? `<div class="tot"><span>IGTF (3%) a reversar</span><b>-${usd(calc.igtf_usd)}${calc.igtf_bs != null ? ` · -Bs. ${bs(calc.igtf_bs / 100)}` : ""}</b></div>` : ""}
        <div class="tot grande"><span>TOTAL A ACREDITAR</span><b>-${usd(calc.total_usd)}${calc.total_bs != null ? ` (-Bs. ${bs(calc.total_bs / 100)})` : ""}</b></div>
        <div class="tot"><span>Saldo de la factura tras aplicar NC</span><b>${usd(nuevoSaldo)}</b></div>`;
    } catch (e) { caja.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };

  const accion = {
    editar: () => (location.hash = `#/factura/${id}/editar`),
    emitir: () => pedir(async () => {
      if (!confirm(`¿Emitir ${nom.toLowerCase()} por ${usd(D.total_usd)}?\n\nDespués NO se puede editar ni borrar: solo anular o ajustar con Nota de Crédito.`)) return;
      await api(`documentos/${id}/emitir`, "POST"); aviso("Emitida ✅"); await ver(estado, id);
    }),
    borrar: () => pedir(async () => { if (!confirm("¿Eliminar este borrador?")) return; await api(`documentos/${id}`, "DELETE"); aviso("Borrador eliminado"); location.hash = "#/factura"; }),
    pdf: () => pedir(async () => descargar(await blobPdf(), nombreArchivo(D))),
    compartir: () => pedir(async () => compartir(await blobPdf(), nombreArchivo(D))),
    convertir: () => pedir(async () => { const r = await api(`documentos/${id}/convertir`, "POST"); aviso("Borrador de factura creado"); location.hash = `#/factura/${r.id}`; }),
    copiar: () => pedir(async () => { const r = await api(`documentos/${id}/copiar`, "POST"); aviso("Copia creada como borrador"); location.hash = `#/factura/${r.id}`; }),
    pagar: () => (location.hash = `#/pagos/nuevo/${id}`),
    whatsapp: () => pedir(async () => {
      if (!D.cliente_whatsapp) throw new Error("Este cliente no tiene WhatsApp: agrégalo en Clientes.");
      const { metodos } = await api("pagos/metodos");
      abrirEnlace(enlaceWhatsApp(D.cliente_whatsapp, mensajeDocumento({ D, pagado: pagado_usd, saldo: saldo_usd ?? D.total_usd, metodos })));
      aviso("Se abrió WhatsApp con el mensaje. Adjunta el PDF con «Compartir PDF».");
    }),
    devolver: () => { $("#anular-form").hidden = true; $("#devolver-form").hidden = !$("#devolver-form").hidden; if (!$("#devolver-form").hidden) { recalcularNc(); $("#motivo_nc").focus(); } },
    anular: () => { $("#devolver-form").hidden = true; $("#anular-form").hidden = !$("#anular-form").hidden; if (!$("#anular-form").hidden && $("#motivo")) $("#motivo").focus(); },
  };
  raiz.querySelectorAll("[data-acc]").forEach((b) => b.addEventListener("click", () => accion[b.dataset.acc]()));
  $("#ir-a-nc")?.addEventListener("click", () => accion.devolver());
  $("#dev-todo")?.addEventListener("click", () => { raiz.querySelectorAll("[data-dev-orden]").forEach((inp) => (inp.value = inp.dataset.max)); recalcularNc(); });
  $("#dev-cero")?.addEventListener("click", () => { raiz.querySelectorAll("[data-dev-orden]").forEach((inp) => (inp.value = "0")); recalcularNc(); });
  $("#devolver-lineas")?.addEventListener("input", recalcularNc);
  $("#dev_igtf")?.addEventListener("change", recalcularNc);
  if ($("#fiscal-form")) enviar($("#fiscal-form"), async (d) => {
    try { await api(`documentos/${id}/fiscal`, "POST", { numero: d.numero }); }
    catch (e) { if (/Se salta del/.test(e.message) && confirm(e.message)) await api(`documentos/${id}/fiscal`, "POST", { numero: d.numero, confirmar_salto: true }); else throw e; }
    estado.negocio = (await api("estado")).negocio;
    aviso("Número fiscal registrado ✅"); await ver(estado, id);
  });
  raiz.querySelectorAll("[data-recibo]").forEach((el) => el.addEventListener("click", () => (location.hash = `#/pagos/recibo/${el.dataset.recibo}`)));
  raiz.querySelectorAll("[data-doc]").forEach((el) => el.addEventListener("click", () => (location.hash = `#/factura/${el.dataset.doc}`)));
  if ($("#devolver-form")) enviar($("#devolver-form"), async (v) => {
    const ls = [...raiz.querySelectorAll("[data-dev-orden]")].map((inp) => ({ orden: Number(inp.dataset.devOrden), cantidad: inp.value }));
    if (!confirm(`¿Emitir Nota de Crédito sobre la Factura ${numeroDoc(D)}?\n\nEsta operación devolverá al inventario las unidades indicadas y reducirá el saldo de la factura.`)) return;
    const r = await api(`documentos/${id}/devolver`, "POST", { motivo: v.motivo_nc, aplica_igtf: $("#dev_igtf").checked, lineas: ls });
    aviso(`Nota de Crédito NC-${String(r.numero).padStart(8, "0")} emitida ✅`);
    location.hash = `#/factura/${r.id}`;
  });
  if ($("#anular-form") && !bloqueoAnularFactura) enviar($("#anular-form"), async (v) => {
    await api(`documentos/${id}/anular`, "POST", { motivo: v.motivo });
    aviso("Documento anulado ✅");
    await ver(estado, id);
  });
}
