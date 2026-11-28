// Módulo CATÁLOGO (pantallas): servicios y productos con precio, costo privado e IVA.
import { $, raiz, esc, bs, usd, aTexto, api, aviso, campo, enviar, navegacion, activar, ERROR } from "./comun.js";
import { aTasaE8, cantidadTexto, usdABs } from "./dinero.js?v=20261127v561";

const TIPOS_EXENCION_UI = [
  ["EXENTA", "Exento (Art. 17–19 LIVA)"],
  ["EXONERADA", "Exonerado (Decreto Ejecutivo)"],
  ["NO_SUJETA", "No Sujeto (Art. 16 LIVA)"],
];
const etiquetaExencion = (t) => (t === "EXONERADA" ? "Exonerado" : t === "NO_SUJETA" ? "No Sujeto" : "Exento");

let filtro = "PRODUCTO", elegido = false; // pestaña actual: "PRODUCTO" o "SERVICIO" (se recuerda al volver a la lista)
export const fijarFiltro = (f) => { filtro = f; elegido = true; }; // lo usa la pantalla de Compras para volver a Productos o Servicios

export async function vistaCatalogo(estado, id) {
  if (id === "nuevo") return formulario(estado, null);
  if (id) {
    try { return formulario(estado, (await api(`catalogo/${encodeURIComponent(id)}`)).item); }
    catch (e) { aviso(e.message); location.hash = "#/inventario"; return; }
  }
  if (!elegido) { // la primera vez, si solo hay servicios, abre directo en la pestaña Servicios
    elegido = true;
    try { const { items } = await api("catalogo"); if (items.length && !items.some((i) => i.tipo === "PRODUCTO")) filtro = "SERVICIO"; } catch { /* sigue en Productos */ }
  }
  const e8 = aTasaE8(String(estado.negocio?.tasa_bcv ?? ""));
  lista(e8 && !Number.isNaN(e8) ? e8 : 0);
}

const detalle = (i, tasaE8) => [
  i.codigo ? esc(i.codigo) : "",
  i.precio_centavos == null ? "Precio a definir al facturar" : usd(i.precio_centavos) + (tasaE8 ? ` · Bs. ${bs(usdABs(i.precio_centavos, tasaE8) / 100)}` : ""),
  i.alicuota_iva ? `IVA ${i.alicuota_iva}%` : etiquetaExencion(i.tipo_exencion),
  i.tipo === "PRODUCTO" && i.controla_stock ? `Stock ${cantidadTexto(i.stock_milli)}` : "",
].filter(Boolean).join(" · ");

const alertaStock = (i) => (!(i.tipo === "PRODUCTO" && i.controla_stock) ? "" : i.stock_milli <= 0 ? '<span class="insignia rojo">Agotado</span>'
  : i.stock_minimo_milli != null && i.stock_milli <= i.stock_minimo_milli ? '<span class="insignia ambar">Poco stock</span>' : "");

const fila = (i, tasa) => {
  const ganancia = i.precio_centavos != null && i.costo_centavos != null ? i.precio_centavos - i.costo_centavos : null;
  return `<article class="fila ${i.activo ? "" : "apagado"}" data-id="${i.id}">
    <span class="icono-tipo ${i.tipo === "SERVICIO" ? "morado" : ""}">${i.tipo === "SERVICIO" ? "🛠️" : "📦"}</span>
    <div class="dato"><strong>${esc(i.nombre)}</strong><small class="suave">${detalle(i, tasa)}</small>
      ${ganancia != null ? `<small class="ganancia-txt">Ganancia ${usd(ganancia)}</small>` : ""}</div>
    ${i.activo ? "" : `<span class="insignia">Inactivo</span>`}${alertaStock(i)}
  </article>`;
};

function lista(tasa) {
  raiz.innerHTML = `
    <header class="encabezado"><h1>📦 Inventario</h1><button class="icono azul" id="nuevo" data-ayuda="Agregar un servicio o producto" aria-label="Nuevo">＋</button></header>
    <div class="chips tres">${[["PRODUCTO", "📦 Productos"], ["SERVICIO", "🛠️ Servicios"], ["COMPRAS", "🧾 Compras"]]
      .map(([v, t]) => `<button class="chip ${v === filtro ? "activo" : ""}" data-f="${v}">${t}</button>`).join("")}</div>
    <input id="buscar" type="search" placeholder="🔎 Buscar por nombre o código" aria-label="Buscar" autocomplete="off">
    <div id="lista" class="lista"><p class="suave">Cargando…</p></div>
    ${navegacion("inventario")}`;
  $("#nuevo").addEventListener("click", () => (location.hash = "#/inventario/nuevo"));
  activar();
  const cargar = async () => {
    if (!$("#buscar")) return; // la pantalla ya cambió
    const q = $("#buscar").value;
    try {
      const { items } = await api(`catalogo?q=${encodeURIComponent(q)}&tipo=${filtro}`);
      const caja = $("#lista"); if (!caja) return;
      caja.innerHTML = items.length ? items.map((i) => fila(i, tasa)).join("")
        : `<p class="suave">${q ? "Sin resultados." : `Aún no tienes ${filtro === "SERVICIO" ? "servicios" : "productos"}. Toca ＋ para agregar el primero.`}</p>`;
      caja.querySelectorAll("[data-id]").forEach((el) => el.addEventListener("click", () => (location.hash = `#/inventario/${el.dataset.id}`)));
    } catch (e) { if ($("#lista")) $("#lista").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };
  raiz.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.f === "COMPRAS") { location.hash = "#/compras"; return; }
    filtro = b.dataset.f;
    raiz.querySelectorAll(".chip").forEach((x) => x.classList.toggle("activo", x === b));
    cargar();
  }));
  let espera;
  $("#buscar").addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(cargar, 250); });
  cargar();
}

const IVAS = [[16, "General 16%"], [8, "Reducido 8%"], [0, "Sin IVA (0% — Exento / Exonerado / No Sujeto)"]];

function formulario(estado, i) {
  const esFormal = estado?.negocio?.tipo_contribuyente === "FORMAL";
  const v = i ?? { tipo: filtro, alicuota_iva: esFormal ? 0 : 16, tipo_exencion: "EXENTA", activo: 1, controla_stock: 1 };
  if (esFormal) v.alicuota_iva = 0;
  const exActual = v.tipo_exencion || "EXENTA";
  raiz.innerHTML = `
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver a la lista" aria-label="Volver">←</button><h1>${i ? "Editar" : "Nuevo"}</h1></header>
    <form id="f" class="tarjeta">
      <fieldset><legend>¿Qué es?</legend>
        <label class="opcion"><input type="radio" name="tipo" value="SERVICIO" ${v.tipo === "SERVICIO" ? "checked" : ""}> 🛠️ Servicio (mano de obra, sin inventario)</label>
        <label class="opcion"><input type="radio" name="tipo" value="PRODUCTO" ${v.tipo === "PRODUCTO" ? "checked" : ""}> 📦 Producto o equipo</label>
      </fieldset>
      ${campo("nombre", "🏷️ Nombre", v.nombre, "text", "required")}
      ${campo("codigo", "🔖 Código (opcional)", v.codigo, "text", 'autocapitalize="characters"')}
      ${campo("precio_usd", "💵 Precio de venta en USD", aTexto(v.precio_centavos), "text", 'inputmode="decimal" placeholder="Vacío = se define al facturar"')}
      ${campo("costo_usd", "🔒 Costo en USD (solo lo ves tú)", aTexto(v.costo_centavos), "text", 'inputmode="decimal" placeholder="Opcional"')}
      <label for="alicuota_iva">🧾 IVA</label>
      ${esFormal
        ? `<select id="alicuota_iva" name="alicuota_iva"><option value="0" selected>Sin IVA (0% — Contribuyente Formal)</option></select>
           <p class="pista">🩺 Contribuyente Formal (Art. 8 Ley IVA): todas las operaciones son sin IVA (0%).</p>`
        : `<select id="alicuota_iva" name="alicuota_iva">${IVAS.map(([n, t]) => `<option value="${n}" ${n === v.alicuota_iva ? "selected" : ""}>${t}</option>`).join("")}</select>`}
      <div id="caja-exencion" ${v.alicuota_iva === 0 ? "" : "hidden"}>
        <label for="tipo_exencion">⚖️ Clasificación fiscal IVA 0% (RLIVA Arts. 70 y 72)</label>
        <select id="tipo_exencion" name="tipo_exencion">
          ${TIPOS_EXENCION_UI.map(([k, t]) => `<option value="${k}" ${k === exActual ? "selected" : ""}>${t}</option>`).join("")}
        </select>
        <p class="pista">Separa tus operaciones sin IVA en Libro de Ventas y Libro de Compras. En Imprenta Digital se reporta como «E».</p>
      </div>
      <div id="caja-stock" ${v.tipo === "PRODUCTO" ? "" : "hidden"}>
        <label class="opcion"><input type="checkbox" id="controla_stock" ${v.controla_stock ? "checked" : ""}> 📦 Controlar existencias (se descuentan al vender)</label>
        ${campo("stock_minimo", "🔔 Avisar cuando queden (opcional)", v.stock_minimo_milli != null ? cantidadTexto(v.stock_minimo_milli) : "", "text", 'inputmode="decimal" placeholder="Ejemplo: 5"')}
        ${i ? `<button type="button" class="boton chico" id="ver-stock">📜 Ver existencias y movimientos</button>` : ""}
      </div>
      ${i ? `<label class="opcion"><input type="checkbox" id="activo" ${v.activo ? "checked" : ""}> Disponible para vender</label>` : ""}
      ${ERROR}<button class="boton" type="submit">${i ? "GUARDAR CAMBIOS" : "GUARDAR"}</button>
      ${i ? `<button class="boton contorno" type="button" id="borrar">Eliminar</button>` : ""}
    </form>`;
  $("#atras").addEventListener("click", () => (location.hash = "#/inventario"));
  raiz.querySelectorAll('input[name="tipo"]').forEach((x) => x.addEventListener("change", () => { $("#caja-stock").hidden = raiz.querySelector('input[name="tipo"]:checked').value !== "PRODUCTO"; }));
  $("#alicuota_iva")?.addEventListener("change", () => {
    const caja = $("#caja-exencion");
    if (caja) caja.hidden = Number($("#alicuota_iva").value) !== 0;
  });
  $("#ver-stock")?.addEventListener("click", () => (location.hash = `#/existencias/${i.id}`));
  enviar($("#f"), async (d) => {
    d.controla_stock = d.tipo === "PRODUCTO" && $("#controla_stock").checked ? "1" : "0";
    d.activo = $("#activo") && !$("#activo").checked ? "0" : "1";
    d.tipo_exencion = Number(d.alicuota_iva) === 0 ? ($("#tipo_exencion")?.value || "EXENTA") : "EXENTA";
    await api(i ? `catalogo/${i.id}` : "catalogo", i ? "PUT" : "POST", d);
    aviso("Guardado ✅"); location.hash = "#/inventario";
  });
  $("#borrar")?.addEventListener("click", async () => {
    if (!confirm(`¿Eliminar "${i.nombre}"?`)) return;
    try { await api(`catalogo/${i.id}`, "DELETE"); aviso("Eliminado"); location.hash = "#/inventario"; }
    catch (e) { aviso(e.message); }
  });
}
