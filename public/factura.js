// Módulo FACTURA (pantallas): lista, editor de borradores, vista del documento, IGTF por factura, Notas de Crédito (devoluciones SENIAT) y PDF.
// Toda la matemática del dinero sale de dinero.js (la misma que usa el servidor).
import { $, raiz, esc, bs, usd, aTexto, api, aviso, campo, enviar, navegacion, activar, descargar, compartir, cargarPdfLib, abrirEnlace, puede, ERROR } from "./comun.js";
import { aTasaE8, aCantidadMilli, aCentavos, calcular, cantidadTexto, usdABs } from "./dinero.js";
import { construirPdf, nombreArchivo, numeroDoc, numeroRecibo, metodoNombre } from "./pdf.js?v=20261123v503";
import { mensajeDocumento, enlaceWhatsApp } from "./pagos.js?v=20261123v503";

const NOMBRE = { FACTURA: "Factura", PRESUPUESTO: "Presupuesto", NOTA_CREDITO: "Nota de crédito", NOTA_DEBITO: "Nota de débito" };
const nombreDe = (d) => (d.es_nota_credito ? "Nota de crédito" : d.es_nota_debito ? "Nota de débito" : NOMBRE[d.tipo] ?? d.tipo);
const ESTADOS = { BORRADOR: ["Borrador", "gris"], EMITIDO: ["Emitido", "verde"], FACTURADO: ["Facturado", "azul"], ANULADO: ["Anulado", "rojo"] };
const dia = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(d);
const fechaDoc = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "");
const costoAlVuelo = (t) => { const c = aCentavos(t); return c == null || Number.isNaN(c) ? null : c; };
const stockPoco = (l, q) => (l?.controla && q > l.stock_milli ? ` · ⚠️ Solo hay ${cantidadTexto(Math.max(l.stock_milli, 0))} en existencias` : "");
const bannerPractica = (estado) => (estado.modo === "PRACTICA"
  ? `<section class="aviso-practica"><b>🧪 MODO PRÁCTICA</b> · Documentos de prueba; se limpian al activar la numeración oficial en Ajustes.</section>` : "");

function parseFechaUtc(s) {
  const t = String(s || "").trim().replace(" ", "T");
  if (!t) return null;
  const f = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(t) ? t : `${t}Z`);
  return Number.isNaN(f.getTime()) ? null : f;
}

function tasaInfo(estado) {
  const n = estado.negocio, e8 = aTasaE8(String(n.tasa_bcv));
  const f = n.tasa_bcv_fecha ? parseFechaUtc(n.tasa_bcv_fecha) : null;
  const dias = f ? Math.round((Date.parse(`${dia(new Date())}T00:00:00Z`) - Date.parse(`${dia(f)}T00:00:00Z`)) / 86400000) : null;
  const cuando = dias === null ? "sin fecha" : dias <= 0 ? "actualizada hoy" : dias === 1 ? "actualizada ayer" : `actualizada hace ${dias} días`;
  return { e8: e8 && !Number.isNaN(e8) ? e8 : null, valor: Number(n.tasa_bcv) || 0, cuando, vieja: dias === null || dias > 3 };
}

let tab = "FACTURA"; // FACTURA | PRESUPUESTO | NOTA_CREDITO | NOTA_DEBITO

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
  const refAf = (x.es_nota_credito || x.es_nota_debito) && x.factura_afectada_numero != null ? ` · Afecta Factura ${String(x.factura_afectada_numero).padStart(8, "0")}` : "";
  return `<article class="fila" data-id="${x.id}">
    <div class="dato"><strong>${esc(titulo)}</strong>
      <small class="suave">${esc(x.cliente ?? "Sin cliente")}${x.fecha_emision ? " · " + fechaDoc(x.fecha_emision) : ""}${esc(refAf)}</small>
      <small class="suave">${usd(x.total_usd)}${x.total_bs != null ? ` · Bs. ${bs(x.total_bs / 100)}` : ""}${x.aplica_igtf ? " · IGTF 3%" : ""}${x.tipo === "FACTURA" && !x.es_nota_credito && x.estado === "EMITIDO" && x.total_usd - x.pagado_usd > 0 ? ` · Saldo ${usd(x.total_usd - x.pagado_usd)}` : ""}</small></div>
    <span class="insignia ${color}">${txt}</span>${x.modo === "PRACTICA" ? `<span class="insignia" title="Práctica">🧪</span>` : ""}</article>`;
};

function lista(estado) {
  let pagina = 0;
  const limite = 50;
  raiz.innerHTML = `
    <header class="encabezado"><h1>🧾 Factura</h1><button class="icono azul" id="nuevo" data-ayuda="Crear una factura o presupuesto nuevo" aria-label="Nuevo">＋</button></header>
    ${bannerPractica(estado)}
    <div class="chips">${[["FACTURA", "🧾 Facturas"], ["PRESUPUESTO", "📋 Presupuestos"], ["NOTA_CREDITO", "↩️ Notas de crédito"], ["NOTA_DEBITO", "📈 Notas de débito"]].map(([v, t]) => `<button class="chip ${v === tab ? "activo" : ""}" data-t="${v}">${t}</button>`).join("")}</div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <input id="buscar" type="search" placeholder="🔎 Buscar por cliente, RIF o número" aria-label="Buscar" autocomplete="off" style="flex:1;margin:0">
      <input id="filtro-mes" type="month" aria-label="Filtrar por mes" title="Filtrar por período mensual" style="width:auto;min-width:140px;margin:0">
    </div>
    <div id="lista" class="lista"><p class="suave">Cargando…</p></div>
    <div id="paginacion-doc" class="dos-botones" style="margin-top:8px" hidden></div>
    ${navegacion("factura")}`;
  $("#nuevo").addEventListener("click", () => (location.hash = `#/factura/nuevo/${tab === "PRESUPUESTO" ? "PRESUPUESTO" : "FACTURA"}`));
  activar();
  const cargar = async () => {
    if (!$("#buscar")) return;
    const q = $("#buscar").value;
    const mes = $("#filtro-mes")?.value || "";
    try {
      const { documentos, hay_mas } = await api(`documentos?tipo=${tab}&q=${encodeURIComponent(q)}&mes=${encodeURIComponent(mes)}&pagina=${pagina}&limite=${limite}`);
      const caja = $("#lista"), pagCaja = $("#paginacion-doc"); if (!caja) return;
      const vacioTxt = tab === "NOTA_CREDITO"
        ? "No hay notas de crédito emitidas. Para crear una devolución, abre la factura original y toca «↩️ Devolver (Nota de crédito)»."
        : tab === "NOTA_DEBITO"
        ? "No hay notas de débito emitidas. Para registrar un recargo o ajuste posterior, abre la factura original y toca «📈 Emitir Nota de débito»."
        : `Aún no tienes ${tab === "FACTURA" ? "facturas" : "presupuestos"}. Toca ＋ para crear ${tab === "FACTURA" ? "la primera" : "el primero"}.`;
      caja.innerHTML = documentos.length ? documentos.map(fila).join("") : `<p class="suave">${q || mes ? "Sin resultados para este filtro." : vacioTxt}</p>`;
      caja.querySelectorAll("[data-id]").forEach((el) => el.addEventListener("click", () => (location.hash = `#/factura/${el.dataset.id}`)));
      if (pagCaja) {
        if (pagina > 0 || hay_mas) {
          pagCaja.hidden = false;
          pagCaja.innerHTML = `
            <button type="button" class="boton chico" id="doc-ant" ${pagina <= 0 ? "disabled" : ""}>← Anterior</button>
            <span class="suave" style="align-self:center;text-align:center;font-size:13px">Pág. ${pagina + 1}</span>
            <button type="button" class="boton chico" id="doc-sig" ${!hay_mas ? "disabled" : ""}>Siguiente →</button>`;
          $("#doc-ant")?.addEventListener("click", () => { if (pagina > 0) { pagina--; cargar(); } });
          $("#doc-sig")?.addEventListener("click", () => { if (hay_mas) { pagina++; cargar(); } });
        } else {
          pagCaja.hidden = true;
          pagCaja.innerHTML = "";
        }
      }
    } catch (e) { if ($("#lista")) $("#lista").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };
  raiz.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    tab = b.dataset.t; pagina = 0; raiz.querySelectorAll(".chip").forEach((x) => x.classList.toggle("activo", x === b)); cargar();
  }));
  let espera;
  $("#buscar").addEventListener("input", () => { clearTimeout(espera); pagina = 0; espera = setTimeout(cargar, 250); });
  $("#filtro-mes").addEventListener("change", () => { pagina = 0; cargar(); });
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
  const tipoContrib = estado?.negocio?.tipo_contribuyente || "ORDINARIO";
  const esFormal = tipoContrib === "FORMAL";
  const esEspecial = tipoContrib === "ESPECIAL";
  const d = existente ?? {
    id: null, tipo: tipoNuevo, cliente: null, nota: "", condicion: "CONTADO", dias_credito: "",
    aplica_igtf: tipoNuevo === "FACTURA" && esEspecial && !!estado.negocio?.igtf_activo, lineas: [],
  };
  if (!esEspecial) d.aplica_igtf = false;
  if (esFormal) d.lineas.forEach((l) => { l.alicuota_iva = 0; });
  const tasa = tasaInfo(estado), nombre = NOMBRE[d.tipo];
  raiz.innerHTML = `
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver" aria-label="Volver">←</button><h1>${d.id ? `Editar ${nombre.toLowerCase()}` : d.tipo === "FACTURA" ? "Nueva factura" : "Nuevo presupuesto"}</h1></header>
    ${bannerPractica(estado)}
    ${esFormal ? `<section class="aviso-control">🩺 <b>Contribuyente Formal (Art. 8 Ley IVA):</b> operaciones exentas de IVA (0%) y sin IGTF. La factura imprimirá la leyenda legal «Sin derecho a crédito fiscal».</section>` : ""}
    <section class="tarjeta" id="sec-cliente"></section>
    <section class="tarjeta"><span class="etiqueta">🧾 RENGLONES</span><div id="lineas"></div>
      <div class="dos-botones"><button type="button" class="boton chico morado" id="add-inv">🏷️ Del inventario</button><button type="button" class="boton chico" id="add-srv">🛠️ Servicio al momento</button><button type="button" class="boton chico" id="add-prod">📦 Producto al vuelo</button></div>
      <div id="picker" hidden></div></section>
    ${d.tipo === "FACTURA" && esEspecial ? `<section class="tarjeta" id="card-igtf-factura"><div class="reng-cab"><span class="etiqueta">💱 MONEDA DE COBRO E IGTF 3% (SNAT/2022/000013 · SPE)</span><span id="igtf-insignia" class="insignia ${d.aplica_igtf ? "verde" : "gris"}">${d.aplica_igtf ? "IGTF 3% Activo (Divisas)" : "Sin IGTF (Bolívares)"}</span></div>
      <label for="medio_cobro_igtf">💳 ¿En qué moneda o medio pagará el cliente?</label>
      <select id="medio_cobro_igtf">
        <option value="BS" ${!d.aplica_igtf ? "selected" : ""}>🇻🇪 Bolívares (Pago Móvil / Transferencia Bs / Efectivo Bs) — Sin IGTF (0%)</option>
        <option value="USD" ${d.aplica_igtf ? "selected" : ""}>💵 Divisas o Cripto (Zelle / Binance / PayPal / Efectivo USD) — Activa IGTF (3%)</option>
      </select>
      <label class="conmutador" for="aplica_igtf" style="margin-top:8px">
        <span class="conmutador-txt"><span>Calcular IGTF (3%) sobre Subtotal + IVA</span><small id="igtf-subtxt">${d.aplica_igtf ? "Aplica 3% por pago en divisas (Zelle, Binance, PayPal o Efectivo USD)." : "Sin IGTF: pago en Bolívares (solo Subtotal + IVA)."}</small></span>
        <span class="switch"><input type="checkbox" role="switch" id="aplica_igtf" aria-checked="${d.aplica_igtf ? "true" : "false"}" ${d.aplica_igtf ? "checked" : ""}><span class="switch-pista" aria-hidden="true"></span></span>
      </label></section>` : ""}
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
          <label>IVA${esFormal ? `<span class="iva-fijo">Exento (0%)</span>`
            : l.catalogo_id ? `<span class="iva-fijo">${l.alicuota_iva ? l.alicuota_iva + "%" : "Exento"}</span>`
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
    l[k] = k === "alicuota_iva" ? (esFormal ? 0 : Number(el.value)) : el.value; refrescar();
  };
  $("#lineas").addEventListener("input", editarCampo); $("#lineas").addEventListener("change", editarCampo);
  $("#lineas").addEventListener("click", (e) => { const q = e.target.closest("[data-quitar]"); if (q) { d.lineas.splice(Number(q.dataset.quitar), 1); pintarLineas(); } });
  $("#add-srv").addEventListener("click", () => {
    d.lineas.push({ catalogo_id: null, tipo: "SERVICIO", descripcion: "", cantidad: "1", precio: "", alicuota_iva: esFormal ? 0 : 16, costo_usd: null });
    pintarLineas(); raiz.querySelector(`[data-i="${d.lineas.length - 1}"] [data-campo="descripcion"]`).focus();
  });
  $("#add-prod").addEventListener("click", () => {
    d.lineas.push({ catalogo_id: null, tipo: "PRODUCTO", descripcion: "", cantidad: "1", precio: "", costo: "", alicuota_iva: esFormal ? 0 : 16, costo_usd: null });
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
          d.lineas.push({ catalogo_id: it.id, tipo: it.tipo, descripcion: it.nombre, cantidad: "1", precio: aTexto(it.precio_centavos), alicuota_iva: esFormal ? 0 : it.alicuota_iva, costo_usd: it.costo_centavos, controla: it.tipo === "PRODUCTO" && !!it.controla_stock, stock_milli: it.stock_milli });
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
      <small class="suave">${tasa.e8 ? `Tasa BCV: Bs. ${bs(tasa.valor)}${tasa.vieja ? " · ⚠️ " : " · "}${tasa.cuando}` : "⚠️ Define la tasa BCV en Ajustes para ver y emitir en Bs."}</small>
      ${hayCosto ? `<small class="ganancia-txt">🔒 Ganancia: ${usd(r.subtotal_usd - r.costo_total_usd)} (solo la ves tú)</small>` : ""}`;
  }

  const sincronizarIgtfUI = (activo) => {
    d.aplica_igtf = !!activo;
    const chk = $("#aplica_igtf"), sel = $("#medio_cobro_igtf"), ins = $("#igtf-insignia"), sub = $("#igtf-subtxt");
    if (chk) { chk.checked = d.aplica_igtf; chk.setAttribute("aria-checked", d.aplica_igtf ? "true" : "false"); }
    if (sel) sel.value = d.aplica_igtf ? "USD" : "BS";
    if (ins) { ins.textContent = d.aplica_igtf ? "IGTF 3% Activo (Divisas)" : "Sin IGTF (Bolívares)"; ins.className = `insignia ${d.aplica_igtf ? "verde" : "gris"}`; }
    if (sub) sub.textContent = d.aplica_igtf ? "Aplica 3% por pago en divisas (Zelle, Binance, PayPal o Efectivo USD)." : "Sin IGTF: pago en Bolívares (solo Subtotal + IVA).";
    refrescar();
  };
  $("#aplica_igtf")?.addEventListener("change", (e) => sincronizarIgtfUI(e.target.checked));
  $("#medio_cobro_igtf")?.addEventListener("change", (e) => sincronizarIgtfUI(e.target.value === "USD"));

  // ---- guardar y emitir
  const cuerpo = () => ({
    tipo: d.tipo, cliente_id: d.cliente?.id ?? null, nota: $("#nota").value, condicion: d.condicion, dias_credito: d.dias_credito,
    aplica_igtf: d.tipo === "FACTURA" && esEspecial && d.aplica_igtf ? 1 : 0,
    lineas: d.lineas.map((l) => ({ catalogo_id: l.catalogo_id, descripcion: l.descripcion, cantidad: l.cantidad, precio_usd: l.precio, alicuota_iva: esFormal ? 0 : l.alicuota_iva, ...(l.catalogo_id ? {} : { tipo: l.tipo, costo_usd: l.costo ?? "" }) })),
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
    if (!c.r.total_bs) throw new Error("Define la tasa BCV de hoy en Ajustes antes de emitir.");
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
const seccionPagos = (D, pagos, notasCredito, notasDebito, pagado, acreditadoNc, saldo) => `<section class="tarjeta"><span class="etiqueta">💵 ${D.tipo === "FACTURA" ? "PAGOS Y NOTAS DE AJUSTE" : "ABONOS"}</span>
  ${D.tipo === "FACTURA" ? `<div class="tot"><span>Condición</span><b>${D.condicion === "CREDITO" ? `Crédito ${D.dias_credito} días · vence ${fechaDoc(D.vence_el)}` : "Contado"}</b></div>` : ""}
  <div class="tot"><span>${D.tipo === "FACTURA" ? "Pagado" : "Abonado"}</span><b>${usd(pagado - acreditadoNc)}</b></div>
  ${acreditadoNc > 0 ? `<div class="tot"><span>Acreditado por Notas de Crédito</span><b>${usd(acreditadoNc)}</b></div>` : ""}
  <div class="tot grande"><span>${saldo > 0 ? "SALDO" : "SALDADA"}</span><b>${usd(Math.max(saldo, 0))}</b></div>
  ${notasCredito.map((nc) => `<div class="reng-ver ${nc.estado === "ANULADO" ? "apagado" : "enlace"}" data-doc="${nc.id}"><div><b>↩️ Nota de crédito NC-${String(nc.numero).padStart(8, "0")}</b>${nc.estado === "ANULADO" ? " · anulada" : ""}<br>
    <small class="suave">${fechaDoc(nc.fecha_emision)} · ${esc(nc.motivo_nc || "Devolución")}</small></div><b>-${usd(nc.total_usd)}</b></div>`).join("")}
  ${notasDebito.map((nd) => `<div class="reng-ver ${nd.estado === "ANULADO" ? "apagado" : "enlace"}" data-doc="${nd.id}"><div><b>📈 Nota de débito ND-${String(nd.numero).padStart(8, "0")}</b>${nd.estado === "ANULADO" ? " · anulada" : ""}<br>
    <small class="suave">${fechaDoc(nd.fecha_emision)} · ${esc(nd.motivo_nc || "Recargo / Ajuste")}</small></div><b>+${usd(nd.total_usd)}</b></div>`).join("")}
  ${pagos.map((p) => `<div class="reng-ver ${p.estado === "ANULADO" ? "apagado" : ""}" data-recibo="${p.id}"><div><b>Recibo ${numeroRecibo(p.numero)}</b>${p.estado === "ANULADO" ? " · anulado" : ""}<br>
    <small class="suave">${esc(metodoNombre(p.metodo))} · ${p.moneda === "BS" ? "Bs. " + bs(p.monto_recibido / 100) : usd(p.monto_recibido)} · ${fechaDoc(p.fecha_pago)}</small></div><b>${usd(p.monto_usd)}</b></div>`).join("")}</section>`;

async function ver(estado, id) {
  const datos = await api(`documentos/${encodeURIComponent(id)}`);
  const { documento: D, lineas, impuestos, pagos = [], notas_credito = [], notas_debito = [], factura_afectada: FA = null, pagado_usd = 0, acreditado_nc_usd = 0, saldo_usd = null } = datos;
  const [estTxt, estColor] = ESTADOS[D.estado], emitido = D.estado !== "BORRADOR", esNc = !!D.es_nota_credito, esNd = !!D.es_nota_debito, reglas = JSON.parse(D.parametros_json || "{}");
  const tipoContrib = estado?.negocio?.tipo_contribuyente || "ORDINARIO";
  const esFormal = tipoContrib === "FORMAL";
  const esEspecial = tipoContrib === "ESPECIAL";
  const emisorDoc = JSON.parse(D.emisor_json || "{}");
  const docEsFormal = (emisorDoc.tipo_contribuyente || tipoContrib) === "FORMAL";
  const permitirIgtfNc = !!D.aplica_igtf && (D.igtf_usd ?? 0) > 0;
  const cliente = D.cliente_nombre ? { nombre: D.cliente_nombre, rif: D.cliente_rif, email: D.cliente_email || "" } : D.cliente_id ? await api(`clientes/${D.cliente_id}`).then((r) => ({ nombre: r.cliente.nombre_apellido, rif: r.cliente.rif_cedula, email: r.cliente.email || "" })) : null;
  const nom = nombreDe(D);
  const titulo = esNc ? "Nota de crédito" : esNd ? "Nota de débito" : nom;
  const medioEfectivo = D.medio || estado.negocio?.medio_facturacion || "APP_SENIAT";
  const esAppSeniat = D.tipo === "FACTURA" && emitido && medioEfectivo === "APP_SENIAT";
  const esImprenta = D.tipo === "FACTURA" && emitido && medioEfectivo === "IMPRENTA_DIGITAL";
  const nroControlMostrar = D.control_fiscal || `00-${String(D.control_interno ?? D.numero ?? 1).padStart(8, "0")}`;
  const pideFiscal = D.tipo === "FACTURA" && D.estado === "EMITIDO" && !D.control_fiscal;
  const tieneDisponibleDevolver = D.tipo === "FACTURA" && !esNc && !esNd && D.estado === "EMITIDO" && lineas.some((l) => l.cantidad_milli - (l.devuelto_milli ?? 0) > 0);
  const puedeEmitirNd = D.tipo === "FACTURA" && !esNc && !esNd && D.estado === "EMITIDO" && puede("anular");

  const tienePagosVigentes = pagos.some((p) => p.estado === "VIGENTE");
  const tieneNcVigentes = notas_credito.some((n) => n.estado === "EMITIDO");
  const tieneNdVigentes = notas_debito.some((n) => n.estado === "EMITIDO");
  const mesCerrado = D.tipo === "FACTURA" && D.fecha_emision && String(D.fecha_emision).slice(0, 7) !== dia(new Date()).slice(0, 7);
  const anulServer = datos.anulacion;
  const bloqueoAnularFactura = anulServer && anulServer.permitida === false
    ? anulServer.motivo
    : D.tipo === "FACTURA"
      ? (tienePagosVigentes ? (esNd ? "Esta Nota de Débito tiene pagos registrados y no puede anularse directamente." : "Según la normativa SENIAT (Art. 25 Providencia SNAT/2011/0071), esta factura tiene pagos registrados y no puede anularse directamente: debes emitir una Nota de Crédito («↩️ Devolver»).")
        : !esNc && !esNd && tieneNcVigentes ? "Esta factura ya tiene Notas de Crédito aplicadas; no puede anularse directamente."
        : !esNc && !esNd && tieneNdVigentes ? "Esta factura ya tiene Notas de Débito asociadas; no puede anularse directamente."
        : mesCerrado ? (esNc || esNd
          ? `Esta Nota de ${esNd ? "Débito" : "Crédito"} pertenece a un mes fiscal anterior. Según la normativa SENIAT no puede anularse directamente porque altera el Libro de Ventas cerrado.`
          : "Esta factura pertenece a un mes fiscal anterior. Para no alterar el Libro de Ventas cerrado, debes emitir una Nota de Crédito.")
        : (esNc || esNd) && esImprenta && D.control_fiscal ? "Esta Nota Fiscal ya cuenta con N.º de Control asignado por Imprenta Digital Autorizada: no puede anularse directamente."
        : null)
      : (tienePagosVigentes ? "Este presupuesto tiene abonos registrados: anula primero los abonos si deseas anularlo." : null);
  const puedeAnularDirecto = D.estado === "EMITIDO" && puede("anular") && !bloqueoAnularFactura;

  const botones = D.estado === "BORRADOR"
    ? [["editar", "✏️ Editar", ""], ["emitir", `EMITIR ${nom.toUpperCase()}`, "verde"], ["borrar", "Eliminar borrador", "contorno"]]
    : [["pdf", "📄 Descargar PDF", ""], ["compartir", "📤 Compartir PDF", "verde"],
      ["correo", "✉️ Enviar por correo al cliente", "contorno-azul"],
      ...(esAppSeniat ? [["clonar_seniat", "📋 Copiar resumen fiscal SENIAT", "contorno-azul"]] : []),
      ...(D.estado === "EMITIDO" && !esNc && saldo_usd > 0 ? [["pagar", "💵 Registrar pago", "verde"]] : []),
      ["whatsapp", "💬 Enviar por WhatsApp", ""],
      ...(D.tipo === "PRESUPUESTO" && D.estado === "EMITIDO" ? [["convertir", "🧾 Convertir en factura", ""]] : []),
      ...(!esNc && !esNd ? [["copiar", "📑 Copiar como borrador nuevo", "contorno-azul"]] : []),
      ...(tieneDisponibleDevolver && puede("anular") ? [["devolver", "↩️ Devolver (Nota de crédito SENIAT)", "morado"]] : []),
      ...(puedeEmitirNd ? [["nota_debito", "📈 Emitir Nota de débito (Recargo / Ajuste)", "contorno-azul"]] : []),
      ...(puedeAnularDirecto ? [["anular", "⛔ Anular", "contorno"]] : [])];

  raiz.innerHTML = `
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver a la lista" aria-label="Volver">←</button>
      <h1>${esc(titulo)} ${emitido ? esc(numeroDoc(D)) : "(borrador)"}</h1><span class="insignia ${estColor}">${estTxt}</span></header>
    ${D.modo === "PRACTICA" ? bannerPractica({ modo: "PRACTICA" }) : ""}
    ${docEsFormal && D.tipo === "FACTURA" ? `<section class="aviso-control">🩺 <b>CONTRIBUYENTE FORMAL · SIN DERECHO A CRÉDITO FISCAL</b> (Providencia SENIAT SNAT/2011/0071).</section>` : ""}
    ${D.estado === "ANULADO" ? `<section class="aviso-anulado">⛔ ANULADO el ${fechaDoc(D.anulado_en)} · Motivo: ${esc(D.motivo_anulacion)}</section>` : ""}
    ${esNc || esNd ? `<section class="tarjeta"><span class="etiqueta">${esNd ? "📈 FACTURA AFECTADA POR NOTA DE DÉBITO (SENIAT)" : "↩️ FACTURA AFECTADA (NORMATIVA SENIAT)"}</span>
      <div class="tot"><span>Factura original</span><b>${FA ? `<a href="#/factura/${FA.id}">Factura ${String(FA.numero).padStart(8, "0")}</a>` : esc(String(reglas.factura_afectada_numero ?? "").padStart(8, "0"))}</b></div>
      <div class="tot"><span>Fecha factura original</span><b>${fechaDoc(FA?.fecha_emision ?? reglas.factura_afectada_fecha)}</b></div>
      <div class="tot"><span>Motivo de ${esNd ? "la nota de débito" : "la devolución"}</span><b>${esc(D.motivo_nc || "")}</b></div></section>` : ""}
    <section class="tarjeta">
      <div class="tot"><span>Cliente</span><b>${cliente ? esc(cliente.nombre) : "(sin elegir)"}</b></div>
      ${cliente ? `<div class="tot"><span>RIF / C.I.</span><b>${esc(cliente.rif)}</b></div>` : ""}
      ${cliente?.email ? `<div class="tot"><span>Correo</span><b>${esc(cliente.email)}</b></div>` : ""}
      ${emitido ? `<div class="tot"><span>Fecha de emisión</span><b>${fechaDoc(D.fecha_emision)}</b></div>` : ""}
      ${D.tipo === "FACTURA" && emitido ? `<div class="tot"><span>N.º de Control</span><b>${esc(nroControlMostrar)}</b></div>
        <div class="tot"><span>Modalidad digital</span><b>${esImprenta ? "🌐 Imprenta Digital (SNAT/2024/000102)" : "📱 Sistema Digital SENIAT (SNAT/2024/000102)"}</b></div>` : ""}
      ${emitido ? `<div class="tot"><span>Tasa BCV (Art. 128 Ley BCV)</span><b>Bs. ${bs(D.tasa_e8 / 1e8)}</b></div>` : ""}
    </section>
    <section class="tarjeta"><span class="etiqueta">🧾 RENGLONES</span>${lineas.map((l) => `<div class="reng-ver"><div><b>${esc(l.descripcion)}</b><br><small class="suave">${cantidadTexto(l.cantidad_milli)} × ${usd(l.precio_usd)} · ${l.alicuota_cent ? "IVA " + l.alicuota_cent / 100 + "%" : "Exento"}${l.devuelto_milli > 0 ? ` · ↩️ Devuelto: ${cantidadTexto(l.devuelto_milli)}` : ""}</small></div><b>${usd(l.monto_usd)}</b></div>`).join("")}</section>
    <section class="tarjeta"><span class="etiqueta">💰 TOTALES</span>
      ${emitido ? impuestos.map((i) => i.alicuota_cent === 0 ? `<div class="tot"><span>Monto exento</span><b>${usd(i.base_usd)} · Bs. ${bs(i.base_bs / 100)}</b></div>`
        : `<div class="tot"><span>Base ${i.alicuota_cent / 100}%</span><b>${usd(i.base_usd)} · Bs. ${bs(i.base_bs / 100)}</b></div><div class="tot"><span>IVA ${i.alicuota_cent / 100}%</span><b>${usd(i.iva_usd)} · Bs. ${bs(i.iva_bs / 100)}</b></div>`).join("") : ""}
      ${D.aplica_igtf && D.igtf_usd > 0 ? `<div class="tot"><span>Subtotal + IVA</span><b>${usd((D.subtotal_usd ?? 0) + (D.iva_usd ?? 0))}${emitido ? ` · Bs. ${bs(((D.subtotal_bs ?? 0) + (D.iva_bs ?? 0)) / 100)}` : ""}</b></div>
        <div class="tot"><span>IGTF (${(D.igtf_alicuota_cent || 300) / 100}%)</span><b>${usd(D.igtf_usd)}${emitido && D.igtf_bs != null ? ` · Bs. ${bs(D.igtf_bs / 100)}` : ""}</b></div>` : ""}
      <div class="tot grande"><span>${D.aplica_igtf && D.igtf_usd > 0 ? "TOTAL + IGTF" : "TOTAL"}</span><b>${usd(D.total_usd)}</b></div>
      ${emitido ? `<div class="tot"><span>Total en Bs.</span><b>Bs. ${bs(D.total_bs / 100)}</b></div>` : `<small class="suave">Los montos en Bs. se fijan al emitir a la tasa BCV vigente.</small>`}
      ${D.costo_total_usd ? `<small class="ganancia-txt">🔒 Ganancia: ${usd(D.subtotal_usd - D.costo_total_usd)} (solo la ves tú)</small>` : ""}</section>
    ${pideFiscal ? `<section class="tarjeta"><span class="etiqueta">🔢 ${esAppSeniat ? "CONTROL INTERNO Y N.º FISCAL SENIAT (SNAT/2024/000102)" : "N.º DE CONTROL FISCAL (IMPRENTA DIGITAL)"}</span>
      <p class="suave">${esAppSeniat
        ? `Control interno asignado: <b>${esc(nroControlMostrar)}</b>. Usa este documento como control interno inmediato y copia el resumen fiscal en la App del SENIAT; cuando el SENIAT te emita el comprobante oficial, registra aquí el N.º de Control definitivo:`
        : `Correlativo interno: <b>${esc(nroControlMostrar)}</b>. Aún no se ha registrado el N.º de Control definitivo de la Imprenta Digital.`}</p>
      ${esImprenta && D.modo === "REAL" ? `<button type="button" class="boton chico" id="reintentar-imprenta" style="margin-bottom:10px">🔄 Reintentar asignación con Imprenta Digital</button>` : ""}
      <form id="fiscal-form">${campo("numero", "N.º de Control definitivo", nroControlMostrar, "text", 'required maxlength="30" autocomplete="off"')}
        ${ERROR}<button class="boton chico" type="submit">GUARDAR N.º DE CONTROL</button></form></section>` : ""}
    ${emitido && !esNc ? seccionPagos(D, pagos, notas_credito, notas_debito, pagado_usd, acreditado_nc_usd, saldo_usd) : ""}
    ${D.nota ? `<section class="tarjeta"><span class="etiqueta">📝 NOTA</span><p>${esc(D.nota)}</p></section>` : ""}
    ${D.estado === "EMITIDO" && puede("anular") && bloqueoAnularFactura ? `<section class="tarjeta" id="aviso-proteccion-fiscal">
      <span class="etiqueta">🛡️ PROTECCIÓN FISCAL SENIAT (ART. 25 SNAT/2011/0071)</span>
      <p class="suave" style="margin:6px 0 0">${esc(bloqueoAnularFactura)}</p>
    </section>` : ""}
    <p class="error" id="error" role="alert" hidden></p>
    ${botones.map(([id2, txt, clase]) => `<button type="button" class="boton ${clase}" data-acc="${id2}">${txt}</button>`).join("")}
    <form id="correo-form" class="tarjeta" hidden>
      <h2>✉️ Enviar ${esc(titulo.toLowerCase())} + PDF por correo</h2>
      <p class="pista">Envía el detalle en Bolívares y USD con el PDF adjunto.</p>
      ${campo("email_destino", "✉️ Correo del cliente", D.cliente_email || cliente?.email || "", "email", 'required placeholder="cliente@correo.com"')}
      ${ERROR}<button class="boton verde" type="submit">ENVIAR CORREO CON PDF ➔</button>
    </form>
    <form id="devolver-form" class="tarjeta" hidden>
      <h2>↩️ Emitir Nota de Crédito (Art. 25 SNAT/2011/0071)</h2>
      <p class="pista">Ajusta parcial o totalmente la Factura ${esc(numeroDoc(D))} y reingresa las existencias al inventario.</p>
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
      ${permitirIgtfNc ? `<label class="opcion"><input type="checkbox" id="dev_igtf" ${D.aplica_igtf ? "checked" : ""}> Incluir reverso de IGTF (3%) en la Nota de Crédito</label>` : ""}
      <div id="dev-totales" class="tarjeta"></div>
      ${campo("motivo_nc", "Motivo de la devolución / Nota de Crédito (mínimo 5 letras)", "", "text", 'required minlength="5" maxlength="200" placeholder="Ej: Devolución de mercancía por el cliente"')}
      ${ERROR}<button class="boton morado" type="submit">EMITIR NOTA DE CRÉDITO</button>
    </form>
    <form id="nd-form" class="tarjeta" hidden>
      <h2>📈 Emitir Nota de Débito (Art. 25 SNAT/2011/0071)</h2>
      <p class="pista">Registra un recargo, interés moratorio, flete o ajuste adicional sobre la Factura ${esc(numeroDoc(D))}.</p>
      ${campo("motivo_nd", "Motivo de la Nota de Débito (mínimo 5 letras)", "", "text", 'required minlength="5" maxlength="200" placeholder="Ej: Recargo por flete adicional / ajuste de precio"')}
      ${campo("descripcion_nd", "Descripción del renglón / concepto", "", "text", 'required maxlength="200" placeholder="Ej: Servicio de flete adicional"')}
      <div class="reng-fila">
        <label>Monto base USD<input id="monto_nd" name="monto_nd" inputmode="decimal" required placeholder="0,00"></label>
        <label>IVA<select id="alicuota_nd" name="alicuota_nd">${esFormal
          ? `<option value="0" selected>Exento (0% — Formal)</option>`
          : `<option value="16" selected>16% General</option><option value="8">8% Reducida</option><option value="0">Exento (0%)</option>`}</select></label>
      </div>
      ${esEspecial ? `<label class="opcion"><input type="checkbox" id="nd_igtf" ${D.aplica_igtf ? "checked" : ""}> Aplicar IGTF (3%) sobre esta Nota de Débito</label>` : ""}
      <div id="nd-totales" class="tarjeta"></div>
      ${ERROR}<button class="boton" type="submit">EMITIR NOTA DE DÉBITO</button>
    </form>
    <form id="anular-form" class="tarjeta" hidden>
      <h2>⛔ Anular ${esc(nom.toLowerCase())}</h2>
      ${bloqueoAnularFactura ? `<p class="error">${esc(bloqueoAnularFactura)}</p>
        ${tieneDisponibleDevolver ? `<button type="button" class="boton morado" id="ir-a-nc">↩️ Emitir Nota de Crédito en su lugar</button>` : ""}` : `
      <p class="pista">⚠️ <b>Art. 37 Providencia SNAT/2011/0071:</b> Solo procede en el mismo mes fiscal cuando se conservan todos los ejemplares sin entregar al cliente. En caso contrario, emite Nota de Crédito.</p>
      ${D.tipo === "FACTURA" && !esNc ? `<label class="opcion"><input type="checkbox" id="confirmar_ejemplares" required> Confirmo conservar original y copias sin entregar al cliente</label>` : ""}
      ${campo("motivo", "Motivo de la anulación", "", "text", 'required minlength="5" maxlength="200" placeholder="Ej: Error de transcripción"')}
      ${ERROR}<button class="boton rojo" type="submit">CONFIRMAR ANULACIÓN</button>`}</form>`;

  $("#atras").addEventListener("click", () => (location.hash = "#/factura"));
  const pedir = async (fn) => { try { await fn(); } catch (e) { const er = $("#error"); er.textContent = e.message; er.hidden = false; } };
  const esDemo = Boolean(estado?.demo?.activo);
  const bytesPdf = async () => await construirPdf(await cargarPdfLib(), { doc: D, lineas, impuestos, factura_afectada: FA, negocio: estado.negocio, esDemo });
  const blobPdf = async () => new Blob([await bytesPdf()], { type: "application/pdf" });
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

  const recalcularNd = () => {
    const caja = $("#nd-totales"); if (!caja) return;
    const precio = aCentavos($("#monto_nd")?.value || "");
    if (!precio || Number.isNaN(precio) || precio <= 0) {
      caja.innerHTML = `<p class="suave">Ingresa el monto base en USD para calcular la Nota de Débito.</p>`;
      return;
    }
    try {
      const alic = esFormal ? 0 : Math.round(Number($("#alicuota_nd")?.value ?? 16) * 100);
      const calc = calcular([{ cantidad_milli: 1000, precio_usd: precio, alicuota_cent: alic, costo_usd: null }], tasaNc, { aplica_igtf: Boolean($("#nd_igtf")?.checked) });
      caja.innerHTML = `<span class="etiqueta">📋 RESUMEN DE LA NOTA DE DÉBITO</span>
        <div class="tot"><span>Base imponible / Subtotal</span><b>+${usd(calc.subtotal_usd)}${calc.subtotal_bs != null ? ` · +Bs. ${bs(calc.subtotal_bs / 100)}` : ""}</b></div>
        ${alic > 0 ? `<div class="tot"><span>IVA (${alic / 100}%)</span><b>+${usd(calc.iva_usd)}${calc.iva_bs != null ? ` · +Bs. ${bs(calc.iva_bs / 100)}` : ""}</b></div>` : ""}
        ${calc.igtf_usd > 0 ? `<div class="tot"><span>IGTF (3%)</span><b>+${usd(calc.igtf_usd)}${calc.igtf_bs != null ? ` · +Bs. ${bs(calc.igtf_bs / 100)}` : ""}</b></div>` : ""}
        <div class="tot grande"><span>TOTAL A CARGAR (ND)</span><b>+${usd(calc.total_usd)}${calc.total_bs != null ? ` (+Bs. ${bs(calc.total_bs / 100)})` : ""}</b></div>`;
    } catch (e) { caja.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };

  const accion = {
    editar: () => (location.hash = `#/factura/${id}/editar`),
    emitir: () => pedir(async () => {
      if (!confirm(`¿Emitir ${nom.toLowerCase()} por ${usd(D.total_usd)}?\n\nDespués NO se puede editar ni borrar: solo anular o ajustar con Nota de Crédito.`)) return;
      await api(`documentos/${id}/emitir`, "POST"); aviso("Emitida ✅"); await ver(estado, id);
    }),
    borrar: () => pedir(async () => { if (!confirm("¿Eliminar este borrador?")) return; await api(`documentos/${id}`, "DELETE"); aviso("Borrador eliminado"); location.hash = "#/factura"; }),
    pdf: () => pedir(async () => descargar(await blobPdf(), nombreArchivo(D, esDemo))),
    compartir: () => pedir(async () => compartir(await blobPdf(), nombreArchivo(D, esDemo))),
    correo: () => {
      $("#correo-form").hidden = !$("#correo-form").hidden;
      if (!$("#correo-form").hidden) $("#email_destino")?.focus();
    },
    clonar_seniat: () => pedir(async () => {
      const regimenEmisor = (emisorDoc.tipo_contribuyente || tipoContrib) === "FORMAL"
        ? "Contribuyente Formal (Exento IVA · Art. 8 Ley IVA)"
        : (emisorDoc.tipo_contribuyente || tipoContrib) === "ESPECIAL"
          ? "Contribuyente Especial (SPE · Agente IGTF)"
          : "Contribuyente Ordinario";
      const desgloseIva = impuestos.map((i) =>
        i.alicuota_cent === 0
          ? `Base Exenta (0%): Bs. ${bs(i.base_bs / 100)} (${usd(i.base_usd)})`
          : `Base ${i.alicuota_cent / 100}%: Bs. ${bs(i.base_bs / 100)} (${usd(i.base_usd)}) | IVA ${i.alicuota_cent / 100}%: Bs. ${bs(i.iva_bs / 100)} (${usd(i.iva_usd)})`
      );
      const resumenSeniat = [
        `DOCUMENTO: ${esNc ? "NOTA DE CRÉDITO" : esNd ? "NOTA DE DÉBITO" : "FACTURA"} N.º ${numeroDoc(D)}`,
        `RÉGIMEN EMISOR: ${regimenEmisor}`,
        `${D.control_fiscal ? "N.º DE CONTROL FISCAL" : "N.º DE CONTROL INTERNO"}: ${nroControlMostrar}`,
        `FECHA EMISIÓN: ${fechaDoc(D.fecha_emision)} | CONDICIÓN: ${D.condicion === "CREDITO" ? `Crédito (${D.dias_credito} días)` : "Contado"}`,
        `CLIENTE: ${cliente?.nombre ?? D.cliente_nombre ?? ""}`,
        `RIF / C.I.: ${cliente?.rif ?? D.cliente_rif ?? ""}`,
        `DIRECCIÓN: ${D.cliente_direccion || "-"}`,
        ...(cliente?.email ? [`CORREO: ${cliente.email}`] : []),
        `TASA BCV: Bs. ${bs(D.tasa_e8 / 1e8)}`,
        `--- RENGLONES ---`,
        ...lineas.map((l, idx) => `${idx + 1}. ${l.descripcion} | Cant: ${cantidadTexto(l.cantidad_milli)} | P.Unit: Bs. ${bs(usdABs(l.precio_usd, D.tasa_e8) / 100)} (${usd(l.precio_usd)}) | IVA: ${l.alicuota_cent / 100}% | Monto: Bs. ${bs(l.monto_bs / 100)} (${usd(l.monto_usd)})`),
        `--- DESGLOSE FISCAL ---`,
        ...desgloseIva,
        `Subtotal: Bs. ${bs(D.subtotal_bs / 100)} (${usd(D.subtotal_usd)})`,
        `IVA Total: Bs. ${bs(D.iva_bs / 100)} (${usd(D.iva_usd)})`,
        ...(D.aplica_igtf && D.igtf_usd > 0 ? [`IGTF (3%): Bs. ${bs((D.igtf_bs ?? 0) / 100)} (${usd(D.igtf_usd)})`] : []),
        `TOTAL: Bs. ${bs(D.total_bs / 100)} (${usd(D.total_usd)})`,
      ].join("\n");
      await navigator.clipboard.writeText(resumenSeniat);
      aviso("Resumen fiscal SENIAT copiado 📋");
    }),
    convertir: () => pedir(async () => { const r = await api(`documentos/${id}/convertir`, "POST"); aviso("Borrador de factura creado"); location.hash = `#/factura/${r.id}`; }),
    copiar: () => pedir(async () => { const r = await api(`documentos/${id}/copiar`, "POST"); aviso("Copia creada como borrador"); location.hash = `#/factura/${r.id}`; }),
    pagar: () => (location.hash = `#/pagos/nuevo/${id}`),
    whatsapp: () => pedir(async () => {
      if (!D.cliente_whatsapp) throw new Error("Este cliente no tiene WhatsApp: agrégalo en Clientes.");
      const { metodos } = await api("pagos/metodos");
      abrirEnlace(enlaceWhatsApp(D.cliente_whatsapp, mensajeDocumento({ D, pagado: pagado_usd, saldo: saldo_usd ?? D.total_usd, metodos })));
      aviso("Se abrió WhatsApp con el mensaje. Adjunta el PDF con «Compartir PDF».");
    }),
    devolver: () => { $("#anular-form").hidden = true; $("#nd-form").hidden = true; $("#devolver-form").hidden = !$("#devolver-form").hidden; if (!$("#devolver-form").hidden) { recalcularNc(); $("#motivo_nc").focus(); } },
    nota_debito: () => { $("#anular-form").hidden = true; $("#devolver-form").hidden = true; $("#nd-form").hidden = !$("#nd-form").hidden; if (!$("#nd-form").hidden) { recalcularNd(); $("#motivo_nd").focus(); } },
    anular: () => { $("#devolver-form").hidden = true; $("#nd-form").hidden = true; $("#anular-form").hidden = !$("#anular-form").hidden; if (!$("#anular-form").hidden && $("#motivo")) $("#motivo").focus(); },
  };
  raiz.querySelectorAll("[data-acc]").forEach((b) => b.addEventListener("click", () => accion[b.dataset.acc]()));
  $("#ir-a-nc")?.addEventListener("click", () => accion.devolver());
  $("#dev-todo")?.addEventListener("click", () => { raiz.querySelectorAll("[data-dev-orden]").forEach((inp) => (inp.value = inp.dataset.max)); recalcularNc(); });
  $("#dev-cero")?.addEventListener("click", () => { raiz.querySelectorAll("[data-dev-orden]").forEach((inp) => (inp.value = "0")); recalcularNc(); });
  $("#devolver-lineas")?.addEventListener("input", recalcularNc);
  $("#dev_igtf")?.addEventListener("change", recalcularNc);
  $("#monto_nd")?.addEventListener("input", recalcularNd);
  $("#alicuota_nd")?.addEventListener("change", recalcularNd);
  $("#nd_igtf")?.addEventListener("change", recalcularNd);
  $("#reintentar-imprenta")?.addEventListener("click", () => pedir(async () => {
    const r = await api(`documentos/${id}/fiscal`, "POST", { reintentar_imprenta: true });
    aviso(`N.º de Control asignado por Imprenta Digital: ${r.control_fiscal} ✅`);
    await ver(estado, id);
  }));
  if ($("#fiscal-form")) enviar($("#fiscal-form"), async (d) => {
    await api(`documentos/${id}/fiscal`, "POST", { numero: d.numero });
    aviso("N.º de Control guardado ✅"); await ver(estado, id);
  });
  if ($("#correo-form")) enviar($("#correo-form"), async (v) => {
    const bytes = await bytesPdf();
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const pdf_base64 = btoa(bin);
    const r = await api(`documentos/${id}/enviar-correo`, "POST", {
      email: v.email_destino,
      pdf_base64,
      nombre_archivo: nombreArchivo(D, esDemo),
    });
    aviso(
      r?.demo_redirigido_a
        ? `🧪 Correo de prueba enviado a ${r.demo_redirigido_a} (quedan ${r.demo_restantes ?? 0} de ${estado?.demo?.max_correos ?? 5}) ✅`
        : `Correo enviado a ${v.email_destino} ✅`
    );
    $("#correo-form").hidden = true;
    await ver(estado, id);
  });
  raiz.querySelectorAll("[data-recibo]").forEach((el) => el.addEventListener("click", () => (location.hash = `#/pagos/recibo/${el.dataset.recibo}`)));
  raiz.querySelectorAll("[data-doc]").forEach((el) => el.addEventListener("click", () => (location.hash = `#/factura/${el.dataset.doc}`)));
  if ($("#devolver-form")) enviar($("#devolver-form"), async (v) => {
    const ls = [...raiz.querySelectorAll("[data-dev-orden]")].map((inp) => ({ orden: Number(inp.dataset.devOrden), cantidad: inp.value }));
    if (!confirm(`¿Emitir Nota de Crédito sobre la Factura ${numeroDoc(D)}?\n\nEsta operación devolverá al inventario las unidades indicadas y reducirá el saldo de la factura.`)) return;
    const r = await api(`documentos/${id}/devolver`, "POST", { motivo: v.motivo_nc, aplica_igtf: Boolean($("#dev_igtf")?.checked), lineas: ls });
    aviso(`Nota de Crédito NC-${String(r.numero).padStart(8, "0")} emitida ✅`);
    location.hash = `#/factura/${r.id}`;
  });
  if ($("#nd-form")) enviar($("#nd-form"), async (v) => {
    if (!confirm(`¿Emitir Nota de Débito sobre la Factura ${numeroDoc(D)}?\n\nSe registrará como documento independiente en el Libro de Ventas y Cuentas por Cobrar.`)) return;
    const r = await api(`documentos/${id}/nota-debito`, "POST", {
      motivo: v.motivo_nd,
      aplica_igtf: Boolean($("#nd_igtf")?.checked),
      lineas: [{ descripcion: v.descripcion_nd, cantidad: "1", precio_usd: v.monto_nd, alicuota_iva: esFormal ? 0 : Number(v.alicuota_nd) }],
    });
    aviso(`Nota de Débito ND-${String(r.numero).padStart(8, "0")} emitida ✅`);
    location.hash = `#/factura/${r.id}`;
  });
  if ($("#anular-form") && !bloqueoAnularFactura) enviar($("#anular-form"), async (v) => {
    await api(`documentos/${id}/anular`, "POST", { motivo: v.motivo });
    aviso("Documento anulado ✅");
    await ver(estado, id);
  });
}
