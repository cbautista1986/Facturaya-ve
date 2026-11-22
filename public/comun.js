// Utilidades compartidas por todas las pantallas.
try {
  for (const obj of [window, Window?.prototype]) {
    const d = obj && Object.getOwnPropertyDescriptor(obj, "fetch");
    if (d && !d.writable && !d.set && d.configurable !== false) {
      let fn = d.get ? d.get.call(window) : d.value;
      Object.defineProperty(obj, "fetch", { configurable: true, enumerable: true, get: () => fn, set: (v) => { if (typeof v === "function") fn = v; } });
    }
  }
} catch {}
export const raiz = document.getElementById("app");
const burbuja = document.getElementById("burbuja");
export const $ = (s) => raiz.querySelector(s);
export const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const bs = (n) => Number(n).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const usd = (centavos) => (centavos == null ? "—" : `$ ${bs(centavos / 100)}`); // centavos -> "$ 12,50"
export const aTexto = (centavos) => (centavos == null ? "" : (centavos / 100).toFixed(2).replace(".", ",")); // centavos -> "12,50"
export const fechaLocal = (f) => {
  if (f == null || f === "") return "—";
  const s = String(f).trim();
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    return new Date(s.length <= 10 ? n * 1000 : n).toLocaleString("es-VE", { dateStyle: "short", timeStyle: "short" });
  }
  const iso = s.replace(" ", "T");
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("es-VE", { dateStyle: "short", timeStyle: "short" });
};
export const ERROR = `<p class="error" role="alert" hidden></p>`;

export function fijarInquilinoTab(cod) {
  try {
    if (cod) sessionStorage.setItem("inq_tab", String(cod));
    else sessionStorage.removeItem("inq_tab");
  } catch {}
}

export async function api(ruta, metodo = "GET", cuerpo) {
  const headers = {};
  if (cuerpo) headers["Content-Type"] = "application/json";
  try {
    const inqTab = sessionStorage.getItem("inq_tab");
    if (inqTab && ruta !== "login") headers["X-Inquilino"] = inqTab;
  } catch {}
  const r = await fetch(`/api/${ruta}`, {
    method: metodo,
    headers,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j.error || `Error ${r.status}`);
    if (j.demo_expirado) {
      err.demo_expirado = true;
      if (ruta !== "login") {
        fijarInquilinoTab("");
        try { window.dispatchEvent(new CustomEvent("facturaya:demo-expirado", { detail: j })); } catch {}
      }
    }
    throw err;
  }
  if (j && typeof j.inquilino_actual === "string" && j.inquilino_actual) {
    fijarInquilinoTab(j.inquilino_actual);
  }
  return j;
}

let tAviso;
export function aviso(texto) {
  burbuja.textContent = texto; burbuja.hidden = false;
  clearTimeout(tAviso); tAviso = setTimeout(() => (burbuja.hidden = true), 2400);
}

// Leyendas: al dejar presionado medio segundo cualquier elemento con data-ayuda
let pulso;
document.addEventListener("pointerdown", (e) => {
  const el = e.target.closest("[data-ayuda]");
  if (el) pulso = setTimeout(() => aviso(el.dataset.ayuda), 500);
});
for (const ev of ["pointerup", "pointercancel", "pointerleave", "scroll"]) document.addEventListener(ev, () => clearTimeout(pulso), true);

export const campo = (id, etiqueta, valor = "", tipo = "text", extra = "") =>
  `<label for="${id}">${etiqueta}</label><input id="${id}" name="${id}" type="${tipo}" value="${esc(valor)}" ${extra}>`;

export function enviar(form, accion) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const boton = form.querySelector("button[type=submit]"), err = form.querySelector(".error");
    boton.disabled = true; err.hidden = true;
    try { await accion(Object.fromEntries(new FormData(form))); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
    finally { boton.disabled = false; }
  });
}

// Barra inferior: destino "#/ruta" = pantalla lista; "Fase N" = todavía no existe
const NAV = [
  ["inicio", "🏠", "Inicio", "#/inicio"], ["factura", "🧾", "Factura", "#/factura", "caja"], ["clientes", "👥", "Clientes", "#/clientes", "caja"],
  ["pagos", "💳", "Pagos", "#/pagos", "caja"], ["inventario", "📦", "Inventario", "#/inventario", "inventario"],
  ["informes", "📊", "Libros", "#/informes", "informes_contador"],
];
// Permisos de quien tiene la sesión (los manda el servidor en /api/estado). Solo sirven para MOSTRAR u ocultar: el servidor es quien los hace cumplir.
let PERMISOS = [];
export const fijarPermisos = (p) => { PERMISOS = Array.isArray(p) ? p : []; };
export const puede = (p) => PERMISOS.includes(p);
export function navegacion(activo) {
  return `<nav class="nav">${NAV.filter(([, , , , req]) => !req || puede(req)).map(([id, icono, nombre, destino]) =>
    `<button data-nombre="${nombre}" data-destino="${destino}" data-ayuda="${nombre}" class="${id === activo ? "activo" : ""}"><span>${icono}</span>${nombre}</button>`).join("")}</nav>`;
}
// Enlaza todos los botones con data-destino de la pantalla actual
export function activar() {
  raiz.querySelectorAll("[data-destino]").forEach((b) => b.addEventListener("click", () => {
    const d = b.dataset.destino;
    if (d.startsWith("#")) location.hash = d; else aviso(`${b.dataset.nombre} llega en la ${d}`);
  }));
}

// Teléfonos: la persona escribe como quiera y se guarda siempre igual (código de país + número, sin "+" ni espacios).
// Devuelve null si está vacío, { error } si no se entiende, o { digitos: "584141234567", bonito: "+58 414 123 4567" }.
// Debe comportarse igual que normalizarWhatsapp() de src/comun.ts.
const MSG_VE = "Un celular venezolano tiene 10 dígitos y empieza por 4 (ejemplo: 0414-1234567).";
const MSG_OTRO = "No reconozco ese número. Escríbelo como 0414-1234567, o con + y el código del país (ejemplo: +1 305 555 1234).";
export function telefono(texto) {
  const t = String(texto ?? "").trim();
  if (!t) return null;
  let d = t.replace(/\D/g, "");
  const conCodigo = t.startsWith("+") || d.startsWith("00");
  if (d.startsWith("00")) d = d.slice(2);
  if (conCodigo) { if (d.startsWith("580")) d = "58" + d.slice(3); }
  else if (d.startsWith("0")) d = "58" + d.replace(/^0+/, "");
  else if (d.length === 10 && d[0] === "4") d = "58" + d;
  const venezolano = d.startsWith("58");
  if (venezolano && !/^584\d{9}$/.test(d)) return { error: MSG_VE };
  if (!/^\d{8,15}$/.test(d) || d.startsWith("0") || (!conCodigo && !venezolano)) return { error: MSG_OTRO };
  return { digitos: d, bonito: venezolano ? `+58 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : `+${d}` };
}

// ---- Archivos y PDF (los usan Factura y Pagos)
let promesaPdf;
export const cargarPdfLib = () => (window.PDFLib ? Promise.resolve(window.PDFLib) : (promesaPdf ??= new Promise((ok, mal) => {
  const s = document.createElement("script"); s.src = "/vendor/pdf-lib.min.js";
  s.onload = () => ok(window.PDFLib); s.onerror = () => { promesaPdf = null; mal(new Error("No se pudo cargar el generador de PDF.")); };
  document.head.appendChild(s);
})));
export function descargar(blob, nombre) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nombre; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export async function compartir(blob, nombre) { // menú Compartir del celular (WhatsApp, Gmail...); si no existe, descarga
  const archivo = new File([blob], nombre, { type: "application/pdf" });
  if (navigator.canShare?.({ files: [archivo] })) { await navigator.share({ files: [archivo], title: nombre }); return; }
  descargar(blob, nombre); aviso("Tu navegador no puede compartir archivos: se descargó el PDF.");
}
export function abrirEnlace(url) { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.click(); }

// ---- Verificación anti-bots opcional (Cloudflare Turnstile, solo se carga si está configurada)
let promesaTurnstile;
function cargarTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return (promesaTurnstile ??= new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = () => ok(window.turnstile);
    s.onerror = () => { promesaTurnstile = null; mal(new Error("No se pudo cargar la verificación anti-bots.")); };
    document.head.appendChild(s);
  }));
}

export function montarTurnstile(contenedor, siteKey, accion = "") {
  if (!contenedor || !siteKey) return { token: () => "", reset: () => {} };
  let widgetId = null, ultimoToken = "";
  cargarTurnstile().then((ts) => {
    if (!ts || !contenedor.isConnected) return;
    const opts = {
      sitekey: siteKey,
      theme: "auto",
      callback: (t) => { ultimoToken = t || ""; },
      "expired-callback": () => { ultimoToken = ""; },
      "error-callback": () => { ultimoToken = ""; },
    };
    if (accion) opts.action = accion;
    widgetId = ts.render(contenedor, opts);
  }).catch(() => {});
  return {
    token: () => {
      if (widgetId != null && window.turnstile) return window.turnstile.getResponse(widgetId) || ultimoToken;
      return ultimoToken;
    },
    reset: () => {
      ultimoToken = "";
      if (widgetId != null && window.turnstile) window.turnstile.reset(widgetId);
    },
  };
}

