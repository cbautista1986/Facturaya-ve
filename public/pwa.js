// PWA instalable (Android / Desktop / iOS Safari) + Monitor global de conectividad (Web y App).
// Nunca cachea ni altera peticiones fiscales (/api/*); solo ofrece instalación limpia y alertas de red en tiempo real.

const CLAVE_PWA_INSTALADA = "facturaya_pwa_instalada";

let eventoInstalacion = null;
let appInstaladaConfirmada = false;
let estadoRedActual = typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "online";
let temporizadorInestable = null;
let temporizadorRecuperado = null;
let iniciado = false;
const escPwa = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function leerMarcaInstaladaLocal() {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(CLAVE_PWA_INSTALADA) === "1";
  } catch {
    return false;
  }
}

function guardarMarcaInstaladaLocal(instalada) {
  try {
    if (typeof localStorage === "undefined") return;
    if (instalada) localStorage.setItem(CLAVE_PWA_INSTALADA, "1");
    else localStorage.removeItem(CLAVE_PWA_INSTALADA);
  } catch {}
}

export function esModoStandalone() {
  try {
    if (typeof window === "undefined") return false;
    const modosApp = [
      "(display-mode: standalone)",
      "(display-mode: fullscreen)",
      "(display-mode: minimal-ui)",
      "(display-mode: window-controls-overlay)",
      "(display-mode: tabbed)",
    ];
    if (modosApp.some((q) => window.matchMedia?.(q)?.matches === true)) return true;
    if (window.navigator?.standalone === true) return true;
    if (typeof document !== "undefined" && document.referrer.startsWith("android-app://")) return true;
    return false;
  } catch {
    return false;
  }
}

export function esDispositivoIos() {
  try {
    if (typeof navigator === "undefined" || typeof window === "undefined") return false;
    const ua = navigator.userAgent || "";
    const iosUa = /iPad|iPhone|iPod/i.test(ua);
    const ipadOs = navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
    return (iosUa || ipadOs) && !window.MSStream;
  } catch {
    return false;
  }
}

/**
 * Regla pura y instantánea (0ms, sin peticiones de red) para decidir si mostrar la franja/botón de instalación:
 * - Si ya corre como app instalada (standalone / fullscreen / minimal-ui / iOS home screen): NUNCA mostrar.
 * - Si el sistema operativo o localStorage confirman que ya está instalada y no hay prompt nativo nuevo: NUNCA mostrar.
 * - En Chrome/Edge/Android/PC: SOLO mostrar cuando el navegador dispara `beforeinstallprompt` (lo que garantiza
 *   que la app NO está instalada todavía; si el usuario la desinstala luego, el navegador vuelve a dispararlo).
 * - En iOS Safari (que no soporta `beforeinstallprompt`): mostrar la guía de 2 pasos solo fuera de standalone
 *   y mientras el usuario no la haya marcado como instalada.
 */
export function evaluarVisibilidadInstalacionPwa({
  esStandalone = false,
  instaladaConfirmada = false,
  instaladaLocal = false,
  tienePromptNativo = false,
  esIos = false,
} = {}) {
  if (esStandalone || instaladaConfirmada) return false;
  if (tienePromptNativo) return true;
  if (instaladaLocal) return false;
  return Boolean(esIos);
}

export function puedeMostrarBotonInstalar() {
  const standalone = esModoStandalone();
  if (standalone) {
    appInstaladaConfirmada = true;
    guardarMarcaInstaladaLocal(true);
    return false;
  }
  return evaluarVisibilidadInstalacionPwa({
    esStandalone: false,
    instaladaConfirmada: appInstaladaConfirmada,
    instaladaLocal: leerMarcaInstaladaLocal(),
    tienePromptNativo: Boolean(eventoInstalacion),
    esIos: esDispositivoIos(),
  });
}

export function botonInstalarPwaHtml(variante = "portada") {
  // Si ya está corriendo dentro de la app instalada, ni siquiera insertamos nodos en el DOM.
  if (esModoStandalone()) return "";
  const ocultoAttr = puedeMostrarBotonInstalar() ? "" : " hidden";
  if (variante === "topbar") {
    return `<button type="button" class="pwa-btn-topbar" data-pwa-instalar aria-label="Instalar aplicación FacturaYa"${ocultoAttr}>📲 Instalar App</button>`;
  }
  if (variante === "inicio") {
    return `<button type="button" class="pwa-banner-btn" data-pwa-instalar${ocultoAttr}>
      <img src="/pwa-192x192.png?v=20261123v501" alt="FacturaYa Venezuela" width="40" height="40" class="pwa-banner-logo">
      <span class="pwa-banner-txt"><strong>Instalar FacturaYa en tu equipo</strong><small>Acceso directo en pantalla de inicio · Pantalla completa</small></span>
      <span class="pwa-banner-cta">Instalar</span>
    </button>`;
  }
  return `<button type="button" class="boton chico contorno-azul" data-pwa-instalar${ocultoAttr}>📲 Instalar App en este dispositivo</button>`;
}

function sincronizarVisibilidadBotonesPwa() {
  if (typeof document === "undefined") return;
  const visible = puedeMostrarBotonInstalar();
  const oculto = !visible;
  document.querySelectorAll("[data-pwa-instalar]").forEach((btn) => {
    btn.hidden = oculto;
    if (eventoInstalacion) {
      btn.setAttribute("data-pwa-nativo", "1");
    } else {
      btn.removeAttribute("data-pwa-nativo");
    }
  });
  document.querySelectorAll("[data-pwa-seccion]").forEach((sec) => {
    sec.hidden = oculto;
  });
}

function verificarAppRelacionadaInstalada() {
  try {
    if (typeof navigator === "undefined" || typeof navigator.getInstalledRelatedApps !== "function") return;
    navigator.getInstalledRelatedApps().then((apps) => {
      if (Array.isArray(apps) && apps.length > 0) {
        appInstaladaConfirmada = true;
        eventoInstalacion = null;
        guardarMarcaInstaladaLocal(true);
        cerrarModalPwa();
        sincronizarVisibilidadBotonesPwa();
      }
    }).catch(() => {});
  } catch {}
}

function cerrarModalPwa() {
  const existente = document.getElementById("pwa-modal-backdrop");
  if (existente) existente.remove();
}

export function abrirGuiaInstalacionPwa() {
  cerrarModalPwa();
  const ios = esDispositivoIos();
  const backdrop = document.createElement("div");
  backdrop.id = "pwa-modal-backdrop";
  backdrop.className = "pwa-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-labelledby", "pwa-modal-tit");

  const pasosHtml = ios
    ? `<ol class="pwa-pasos">
        <li>
          <span class="pwa-paso-num">1</span>
          <div><strong>Toca el botón Compartir</strong> en la barra inferior de Safari (el ícono del cuadrado con la flecha hacia arriba <span class="pwa-ico-inline">⎋</span>).</div>
        </li>
        <li>
          <span class="pwa-paso-num">2</span>
          <div>Desliza hacia abajo y selecciona <strong>«Agregar a pantalla de inicio»</strong> (o <i>Add to Home Screen</i>) y luego toca <strong>Agregar</strong>.</div>
        </li>
      </ol>`
    : `<ol class="pwa-pasos">
        <li>
          <span class="pwa-paso-num">1</span>
          <div>Abre el menú de tu navegador (<b>⋮</b> en Chrome/Android o el ícono de <b>Instalar</b> en la barra de direcciones en PC/Edge).</div>
        </li>
        <li>
          <span class="pwa-paso-num">2</span>
          <div>Selecciona <strong>«Instalar aplicación»</strong> o <strong>«Agregar a pantalla principal»</strong> para abrir FacturaYa a pantalla completa.</div>
        </li>
      </ol>`;

  backdrop.innerHTML = `
    <div class="pwa-modal">
      <div class="pwa-modal-cab">
        <div class="pwa-modal-marca">
          <img src="/pwa-192x192.png?v=20261123v501" alt="FacturaYa Venezuela" width="48" height="48">
          <div>
            <h2 id="pwa-modal-tit">Instalar FacturaYa Venezuela</h2>
            <p class="suave" style="margin:2px 0 0;font-size:13px">${ios ? "Guía rápida para iPhone y iPad (Safari)" : "Instala la aplicación en 2 pasos"}</p>
          </div>
        </div>
        <button type="button" class="icono" id="pwa-modal-cerrar" aria-label="Cerrar">✕</button>
      </div>
      ${pasosHtml}
      <p class="pista" style="margin:12px 0 14px">🛡️ Al instalarla se abre como aplicación independiente, mantiene la sincronización fiscal SENIAT en tiempo real y no ocupa espacio extra en tu teléfono o PC.</p>
      <button type="button" class="boton" id="pwa-modal-ok">Entendido</button>
      <button type="button" class="boton contorno chico" id="pwa-modal-ya-instalada" style="width:100%;margin-top:8px">Ya la tengo instalada · Ocultar aviso</button>
    </div>`;

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) cerrarModalPwa();
  });
  document.body.appendChild(backdrop);
  document.getElementById("pwa-modal-cerrar")?.addEventListener("click", cerrarModalPwa);
  document.getElementById("pwa-modal-ok")?.addEventListener("click", cerrarModalPwa);
  document.getElementById("pwa-modal-ya-instalada")?.addEventListener("click", () => {
    appInstaladaConfirmada = true;
    guardarMarcaInstaladaLocal(true);
    cerrarModalPwa();
    sincronizarVisibilidadBotonesPwa();
  });
}

export async function ejecutarInstalacionPwa(onAviso) {
  if (esModoStandalone()) return;
  if (eventoInstalacion) {
    try {
      const promptEv = eventoInstalacion;
      eventoInstalacion = null;
      await promptEv.prompt();
      const eleccion = await promptEv.userChoice;
      if (eleccion?.outcome === "accepted") {
        appInstaladaConfirmada = true;
        guardarMarcaInstaladaLocal(true);
        onAviso?.("FacturaYa se está instalando en tu dispositivo ✅");
      }
      sincronizarVisibilidadBotonesPwa();
      return;
    } catch {
      // Si el navegador cancela o falla el prompt nativo, mostramos la guía visual
    }
  }
  abrirGuiaInstalacionPwa();
}

export function enlazarBotonesPwa(contenedor, onAviso) {
  if (!contenedor) return;
  sincronizarVisibilidadBotonesPwa();
  contenedor.querySelectorAll("[data-pwa-instalar]").forEach((btn) => {
    if (btn.dataset.pwaBound === "1") return;
    btn.dataset.pwaBound = "1";
    btn.addEventListener("click", () => ejecutarInstalacionPwa(onAviso));
  });
}

// ------------------------------------------------------------------
// Monitor global de conectividad (Web y App instalada)
// ------------------------------------------------------------------
function barraRedEl() {
  return document.getElementById("barra-red");
}

function pintarBarraRed(estado, detalle = "") {
  const el = barraRedEl();
  if (!el) return;
  clearTimeout(temporizadorRecuperado);

  if (estado === "offline") {
    estadoRedActual = "offline";
    el.hidden = false;
    el.className = "barra-red barra-red-offline";
    el.innerHTML = `<span class="barra-red-dot" aria-hidden="true"></span>
      <span><strong>Sin conexión a internet.</strong> Verifica tu Wi-Fi o datos móviles antes de emitir facturas o registrar cobros.</span>`;
    return;
  }

  if (estado === "inestable") {
    if (estadoRedActual === "offline") return; // No rebajar "sin internet" a "inestable"
    estadoRedActual = "inestable";
    el.hidden = false;
    el.className = "barra-red barra-red-inestable";
    const extra = detalle ? ` (${escPwa(detalle)})` : "";
    el.innerHTML = `<span class="barra-red-dot" aria-hidden="true"></span>
      <span><strong>Conexión lenta o intermitente${extra}.</strong> Evita pulsar dos veces el botón de emitir; tus correlativos siguen protegidos.</span>`;
    clearTimeout(temporizadorInestable);
    temporizadorInestable = setTimeout(() => {
      if (estadoRedActual === "inestable" && navigator.onLine !== false && !esConexionLentaApi()) {
        pintarBarraRed("online-silencioso");
      }
    }, 12000);
    return;
  }

  if (estado === "recuperado") {
    estadoRedActual = "online";
    el.hidden = false;
    el.className = "barra-red barra-red-ok";
    el.innerHTML = `<span class="barra-red-dot" aria-hidden="true"></span>
      <span><strong>Conexión restablecida.</strong> Ya puedes continuar trabajando normalmente.</span>`;
    temporizadorRecuperado = setTimeout(() => {
      if (estadoRedActual === "online") el.hidden = true;
    }, 3500);
    return;
  }

  estadoRedActual = "online";
  el.hidden = true;
}

function esConexionLentaApi() {
  try {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return false;
    if (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g") return true;
    if (typeof conn.rtt === "number" && conn.rtt >= 1200) return true;
    if (typeof conn.downlink === "number" && conn.downlink > 0 && conn.downlink < 0.35) return true;
  } catch {}
  return false;
}

export function registrarServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // En entornos HTTPS o localhost registramos el Service Worker para instalabilidad PWA
  const esLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (location.protocol !== "https:" && !esLocal) return;
  const registrar = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Silencioso si el navegador bloquea SW (modo incógnito estricto o iframe restringido)
    });
  };
  if (document.readyState === "complete") registrar();
  else window.addEventListener("load", registrar, { once: true });
}

export function iniciarPwaYConectividad() {
  if (iniciado) return;
  iniciado = true;

  registrarServiceWorker();

  if (esModoStandalone()) {
    appInstaladaConfirmada = true;
    guardarMarcaInstaladaLocal(true);
  } else {
    verificarAppRelacionadaInstalada();
    try {
      const mq = window.matchMedia?.("(display-mode: standalone)");
      mq?.addEventListener?.("change", (ev) => {
        if (ev.matches) {
          appInstaladaConfirmada = true;
          eventoInstalacion = null;
          guardarMarcaInstaladaLocal(true);
          cerrarModalPwa();
          sincronizarVisibilidadBotonesPwa();
        }
      });
    } catch {}
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    eventoInstalacion = e;
    // Si el navegador dispara beforeinstallprompt, garantiza que la app NO está instalada (o fue desinstalada).
    appInstaladaConfirmada = false;
    guardarMarcaInstaladaLocal(false);
    sincronizarVisibilidadBotonesPwa();
  });

  window.addEventListener("appinstalled", () => {
    eventoInstalacion = null;
    appInstaladaConfirmada = true;
    guardarMarcaInstaladaLocal(true);
    cerrarModalPwa();
    sincronizarVisibilidadBotonesPwa();
  });

  window.addEventListener("offline", () => {
    pintarBarraRed("offline");
  });

  window.addEventListener("online", () => {
    if (esConexionLentaApi()) {
      estadoRedActual = "online";
      pintarBarraRed("inestable", "señal débil");
    } else {
      pintarBarraRed("recuperado");
    }
  });

  window.addEventListener("facturaya:red-caida", () => {
    if (navigator.onLine === false) {
      pintarBarraRed("offline");
    } else {
      pintarBarraRed("inestable", "corte temporal");
    }
  });

  window.addEventListener("facturaya:red-lenta", (ev) => {
    const ms = Number(ev?.detail?.ms || 0);
    const txt = ms >= 4000 ? `${(ms / 1000).toFixed(1)}s de respuesta` : "señal débil";
    pintarBarraRed("inestable", txt);
  });

  window.addEventListener("facturaya:red-ok", () => {
    if (estadoRedActual === "offline") {
      pintarBarraRed("recuperado");
    } else if (estadoRedActual === "inestable" && !esConexionLentaApi()) {
      pintarBarraRed("online-silencioso");
    }
  });

  try {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    conn?.addEventListener?.("change", () => {
      if (navigator.onLine === false) return pintarBarraRed("offline");
      if (esConexionLentaApi()) return pintarBarraRed("inestable", "red móvil lenta");
      if (estadoRedActual === "inestable") pintarBarraRed("online-silencioso");
    });
  } catch {}

  if (navigator.onLine === false) {
    pintarBarraRed("offline");
  } else if (esConexionLentaApi()) {
    pintarBarraRed("inestable", "red lenta");
  }
}
