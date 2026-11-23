// Entrada de la aplicación: instalador, login, inicio, ajustes y panel Multi-Tenant Súper Admin.
import { $, raiz, esc, bs, usd, fechaLocal, api, aviso, campo, enviar, montarTurnstile, navegacion, activar, fijarPermisos, puede, ERROR } from "./comun.js";
import { tarjetaRestaurar, vistaRestaurar, pantallaOcupado } from "./restaurar.js";
import { tarjetaMedio, enlazarMedio } from "./medio.js";
import { pantallaCodigo, vistaRecuperar, vistaCambiarClave, vistaUsuarios, formularioCodigo, enlazarCodigo } from "./usuarios.js";
import { vistaClientes } from "./clientes.js";
import { vistaCatalogo } from "./catalogo.js";
import { vistaFactura } from "./factura.js";
import { vistaPagos } from "./pagos.js";
import { vistaCompras, vistaProveedores, vistaExistencias } from "./compras.js";
import { vistaInformes } from "./informes.js";
import { generarQrSvg } from "./qr.js";
import { renderHistorialCorreoInquilino, vistaPanelCorreosPlataforma } from "./correos.js";
import { iniciarPwaYConectividad, botonInstalarPwaHtml, enlazarBotonesPwa } from "./pwa.js";

const NEGOCIO = [
  ["nombre_razon_social", "🏷️ Nombre o razón social (según RIF SENIAT)"],
  ["rif", "🪪 RIF fiscal (ej: V-12345678-0 o J-12345678-9)"],
  ["direccion_fiscal", "📍 Domicilio fiscal completo (según RIF)"],
  ["representante_nombre", "👤 Nombre completo del Administrador / Representante Legal"],
  ["representante_cedula", "🪪 Cédula de Identidad del Administrador (ej: V-12345678)"],
  ["telefono", "📞 Teléfono / WhatsApp de contacto"],
  ["email", "✉️ Correo del negocio"],
];
let estado = {};

const esEntornoPreview = location.hostname.endsWith(".run.app") || location.hostname === "localhost" || location.hostname === "127.0.0.1";
const URL_PORTAL_OFICIAL = "https://facturayave.com";
const ICONO_WA_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.52 3.48A11.86 11.86 0 0 0 12.06 0C5.5 0 .16 5.34.16 11.9c0 2.1.55 4.15 1.59 5.95L0 24l6.33-1.66a11.84 11.84 0 0 0 5.73 1.46h.01c6.56 0 11.9-5.34 11.9-11.9 0-3.18-1.24-6.17-3.45-8.42ZM12.07 21.8h-.01a9.87 9.87 0 0 1-5.04-1.38l-.36-.21-3.76.99 1-3.66-.24-.38a9.84 9.84 0 0 1-1.51-5.26c0-5.45 4.44-9.89 9.91-9.89 2.65 0 5.13 1.03 7 2.9a9.83 9.83 0 0 1 2.9 7c0 5.46-4.44 9.89-9.89 9.89Zm5.42-7.41c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.22 3.08.15.2 2.1 3.21 5.08 4.5.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.69.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35Z"/></svg>`;

function datosWhatsappContacto(modo = "comercial") {
  const raw = estado?.whatsapp_contacto;
  if (!raw) return null;
  const activo = raw === true || (typeof raw === "object" && (raw.activo === true || Boolean(raw.digitos))) || (typeof raw === "string" && raw.trim().length > 0);
  if (!activo) return null;
  // Nunca se expone el número en el HTML ni en el cliente: la redirección ocurre en el servidor (/api/contacto/whatsapp).
  return { url: modo === "soporte" ? "/api/contacto/whatsapp?modo=soporte" : "/api/contacto/whatsapp" };
}

const REGIMENES_UI = {
  FORMAL: {
    etiqueta: "🩺 Contribuyente Formal",
    insignia: "azul",
    corto: "Formal (Exento IVA)",
    ayuda: "Para médicos, psicólogos, odontólogos y actividades 100% exentas (Art. 8 Ley IVA). Factura con IVA 0%, sin IGTF e imprime la leyenda obligatoria «Contribuyente Formal · Sin derecho a crédito fiscal».",
  },
  ORDINARIO: {
    etiqueta: "🏢 Contribuyente Ordinario",
    insignia: "verde",
    corto: "Ordinario",
    ayuda: "Para la mayoría de profesionales, comercios y empresas en Venezuela. Cobra IVA (16%, 8% o Exento) y NO cobra IGTF (0% incluso si te pagan en divisas).",
  },
  ESPECIAL: {
    etiqueta: "⭐ Contribuyente Especial (SPE)",
    insignia: "ambar",
    corto: "Especial (SPE)",
    ayuda: "Solo para empresas calificadas formalmente por el SENIAT como Sujeto Pasivo Especial (SPE). Cobra IVA y habilita la percepción y declaración de IGTF (3% SNAT/2022/000013) en pagos en divisas.",
  },
};
const infoRegimen = (tipo) => REGIMENES_UI[tipo] || REGIMENES_UI.ORDINARIO;
const opcionesRegimenHtml = (actual = "ORDINARIO") => [
  ["ORDINARIO", "🏢 Contribuyente Ordinario (Estándar — IVA normal, sin IGTF)"],
  ["FORMAL", "🩺 Contribuyente Formal (Médicos / Psicólogos / Exentos — IVA 0%, sin IGTF)"],
  ["ESPECIAL", "⭐ Contribuyente Especial / SPE (Designado SENIAT — IVA + IGTF 3%)"],
].map(([v, t]) => `<option value="${v}" ${v === actual ? "selected" : ""}>${t}</option>`).join("");

const TARJETA_GITHUB_ZIP = esEntornoPreview ? `<section class="tarjeta" style="margin-top:24px"><span class="etiqueta">📦 DESCARGA PARA GITHUB DESKTOP / CLOUDFLARE (v5.0.0)</span>
  <p class="suave">Descarga el ZIP completo v5.0.0 con <b>App Instalable (PWA)</b>, <b>Alertas globales de conexión (Web y App)</b>, <b>Bindings Nativos D1 automáticos</b>, <b>Mantenimiento Nocturno 2:00 AM VET</b> (silencio total 6 AM–9 PM) e <b>Interruptor de Modo Mantenimiento para Despliegues</b>:</p>
  <button type="button" class="boton verde" data-dl-cf="facturaya-ve-github.zip">⬇️ Descargar todo: facturaya-ve-github.zip (v5.0.0)</button>
  <div class="dos-botones">
    <button type="button" class="boton chico contorno-azul" data-dl-cf="wrangler.toml">⬇️ wrangler.toml</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="mantenimiento.ts">⬇️ src/mantenimiento.ts</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="cloudflare-api.ts">⬇️ src/cloudflare-api.ts</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="pwa.js">⬇️ public/pwa.js</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="sw.js">⬇️ public/sw.js</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="app.js">⬇️ public/app.js</button>
  </div>
</section>` : "";

function correoCorporativo(usuario) {
  // Ensamblado dinámico para evitar que bots raspadores lean correos en texto plano en el HTML estático.
  return [usuario, ["facturayave", "com"].join(".")].join("@");
}

async function copiarTextoSeguro(texto) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch { /* fallback silencioso */ }
  return false;
}

document.addEventListener("click", async (e) => {
  const btnCorreoCom = e.target.closest("[data-correo-comercial]");
  if (btnCorreoCom) {
    const dir = correoCorporativo("contacto");
    const copiado = await copiarTextoSeguro(dir);
    aviso(copiado ? `✉️ ${dir} copiado al portapapeles` : `✉️ Correo comercial: ${dir}`);
    const a = document.createElement("a");
    a.href = `mailto:${dir}?subject=${encodeURIComponent("Solicitud de información — FacturaYa Venezuela")}`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const btnCopiar = e.target.closest("[data-copiar-correo]");
  if (btnCopiar) {
    const dir = correoCorporativo(btnCopiar.dataset.copiarCorreo || "soporte");
    const copiado = await copiarTextoSeguro(dir);
    aviso(copiado ? `📋 ${dir} copiado ✅` : `✉️ ${dir}`);
    return;
  }
  const btnEscribir = e.target.closest("[data-escribir-correo]");
  if (btnEscribir) {
    const u = btnEscribir.dataset.escribirCorreo || "soporte";
    const dir = correoCorporativo(u);
    const asunto = u === "pagos"
      ? `Pagos / Suscripción — ${estado?.negocio?.nombre_razon_social || "FacturaYa Venezuela"}`
      : `Soporte Técnico — ${estado?.negocio?.nombre_razon_social || "FacturaYa Venezuela"}`;
    const a = document.createElement("a");
    a.href = `mailto:${dir}?subject=${encodeURIComponent(asunto)}`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const btnDl = e.target.closest("[data-dl-cf]");
  if (btnDl) {
    const nombre = btnDl.dataset.dlCf;
    btnDl.disabled = true;
    try {
      const r = await fetch(`/descargar-cf/${encodeURIComponent(nombre)}`);
      if (!r.ok) throw new Error("No se pudo descargar el archivo.");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nombre === "rutas-inquilinos.ts" ? "inquilinos.ts" : nombre === "rutas-demo.ts" ? "demo.ts" : nombre;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      aviso(`Descargado: ${nombre} ✅`);
    } catch (err) {
      aviso(err.message);
    } finally {
      btnDl.disabled = false;
    }
    return;
  }
});

// Optimiza el logo en el navegador (<canvas>) para guardarlo gratis en D1 (máx. 360x140 PNG)
function optimizarLogo(archivo) {
  return new Promise((resolve, reject) => {
    if (!archivo || !archivo.type.startsWith("image/")) return reject(new Error("Elige una imagen PNG, JPG o WebP."));
    const lector = new FileReader();
    lector.onerror = () => reject(new Error("No se pudo leer la imagen."));
    lector.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Formato de imagen no compatible."));
      img.onload = () => {
        const maxW = 360, maxH = 140;
        const escala = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = Math.max(1, Math.round(img.width * escala));
        const h = Math.max(1, Math.round(img.height * escala));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        let dataUrl = canvas.toDataURL("image/png");
        if (dataUrl.length > 180000) dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve(dataUrl);
      };
      img.src = lector.result;
    };
    lector.readAsDataURL(archivo);
  });
}

function logoHeader(n) {
  if (n?.logo_base64 && String(n.logo_base64).startsWith("data:image/")) {
    return `<span class="logo logo-con-img"><img src="${esc(n.logo_base64)}" alt="Logo" class="logo-img"></span>`;
  }
  return `<span class="logo logo-con-img"><img src="/logo-oficial.png?v=20261123v501" alt="FacturaYa Venezuela" class="logo-img"></span>`;
}

let timerDemo = null;
function formatoRelojDemo(segTotal) {
  const s = Math.max(0, Math.floor(Number(segTotal) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

function detenerRelojDemo() {
  if (timerDemo) {
    clearInterval(timerDemo);
    timerDemo = null;
  }
}

function montarBarraDemo() {
  detenerRelojDemo();
  const d = estado?.demo;
  if (!d || !d.activo) return;
  const reg = infoRegimen(d.regimen);
  const superAdmin = puede("super");
  const cont = document.createElement("aside");
  cont.className = "barra-demo";
  cont.id = "barra-demo";
  cont.setAttribute("aria-label", "Entorno Demo Activo");
  const cuotaCorreoTxt = d.correo_habilitado
    ? ` · ✉️ Correos de prueba: <b>${d.correos_enviados}/${d.max_correos}</b> (redirigidos a ${esc(d.email_prospecto_mascara)})`
    : " · ✉️ Envío de correos desactivado en esta demo";
  cont.innerHTML = `
    <div class="barra-demo-top">
      <div class="barra-demo-tit">
        <span>🧪 MODO DEMO · ${esc(reg.corto)}</span>
        <span class="barra-demo-reloj" id="demo-reloj">${formatoRelojDemo(d.segundos_restantes)}</span>
      </div>
      ${superAdmin ? `<button type="button" class="boton chico" id="demo-salir-super">↩️ Volver a Principal</button>` : ""}
    </div>
    <div class="barra-demo-sub">Datos ficticios sin validez fiscal · Vence: <b>${esc(d.expira_hora_caracas || "")}</b>${cuotaCorreoTxt}</div>
    <details class="demo-guia">
      <summary>🧭 ¿Qué probar en esta demo? (4 pasos rápidos)</summary>
      <ol>
        <li><b>Facturar o Presupuestar:</b> entra a <b>🧾 Factura</b>, emite una factura nueva o convierte un presupuesto y descarga su PDF (con marca de agua demo).</li>
        <li><b>Cobros y Recibos:</b> entra a <b>💳 Pagos</b>, registra un abono en Bolívares o Divisas y genera el recibo PDF.</li>
        <li><b>Libros SENIAT:</b> entra a <b>📊 Libros</b> y revisa los 3 meses precargados (Libro de Ventas, Compras, IVA${d.regimen === "ESPECIAL" ? ", IGTF 3%" : ""} e ISLR) en Excel CSV y PDF.</li>
        <li><b>Roles:</b> cierra sesión y prueba entrar como <b>Cajero</b> (sin ver costos ni ganancias) o <b>Contador</b> (solo lectura contable).</li>
      </ol>
    </details>`;
  raiz.prepend(cont);
  $("#demo-salir-super")?.addEventListener("click", async () => {
    try {
      await api("inquilinos/cambiar", "POST", { codigo: "principal" });
      aviso("De vuelta en tu empresa principal ✅");
      location.hash = "#/inquilinos/demo";
      await ruta();
    } catch (e) { aviso(e.message); }
  });
  const expiraMs = Number(d.expira_en || 0) * 1000;
  if (expiraMs > 0) {
    timerDemo = setInterval(() => {
      const el = document.getElementById("demo-reloj");
      if (!el) { detenerRelojDemo(); return; }
      const rest = Math.max(0, Math.floor((expiraMs - Date.now()) / 1000));
      el.textContent = formatoRelojDemo(rest);
      if (rest <= 0) {
        detenerRelojDemo();
        ruta();
      }
    }, 1000);
  }
}

function barraSuper() {
  if (!puede("super")) return "";
  const cod = estado.inquilino_actual || estado.inquilino_activo || "principal";
  if (cod === "DB_DEMO") return "";
  const mant = estado.mantenimiento_despliegue;
  const alertaMant = mant?.activo
    ? `<div class="barra-mant-super" role="alert">
        <div>🔒 <b>MODO MANTENIMIENTO ACTIVO</b> · Solo tú (Súper Admin) puedes acceder · Etapa: <b>${esc(mant.etapa || "SESIONES_CERRADAS")}</b></div>
        <button type="button" class="boton chico" data-destino="#/inquilinos/builds">🚀 Controlar / Reabrir</button>
      </div>`
    : "";
  return `${alertaMant}<div class="barra-super">
    <div><small>👑 MODO SÚPER ADMIN · VIENDO NEGOCIO:</small><b>🏢 ${esc(estado.negocio?.nombre_razon_social || "Principal")} (${esc(cod)})</b></div>
    <button type="button" class="boton chico" data-destino="#/inquilinos">Mis Inquilinos</button>
  </div>`;
}

function vistaInstalar() {
  raiz.innerHTML = `<section class="tarjeta">
    <div class="instalar-marca">
      <img src="/logo-oficial.png?v=20261123v501" alt="FacturaYa Venezuela" width="52" height="52">
      <div>
        <h1 style="margin:0">Bienvenido a FacturaYa Venezuela</h1>
        <p class="suave" style="margin:4px 0 0">Configuración inicial del contribuyente conforme a las Providencias SENIAT SNAT/2011/0071 y SNAT/2024/000102.</p>
      </div>
    </div>
    <form id="f">
      ${campo("nombre", "👤 Nombre o razón social", "", "text", 'required autocomplete="organization"')}
      ${campo("rif", "🪪 RIF fiscal (ej: V-12345678-0 o J-12345678-9)", "", "text", 'required placeholder="V-12345678-0 o J-12345678-9"')}
      ${campo("direccion", "📍 Domicilio fiscal", "", "text", 'required autocomplete="street-address"')}
      ${campo("telefono", "📞 Teléfono", "", "tel", 'autocomplete="tel"')}
      ${campo("email", "✉️ Correo del administrador", "", "email", 'required autocomplete="username"')}
      <label for="tipo_contribuyente">⚖️ Condición Fiscal / Tipo de Contribuyente (SENIAT)</label>
      <select id="tipo_contribuyente" name="tipo_contribuyente">
        ${opcionesRegimenHtml("ORDINARIO")}
      </select>
      <p class="pista" id="inst-regimen-pista">${esc(infoRegimen("ORDINARIO").ayuda)}</p>
      <label for="medio_facturacion">🧾 Modalidad digital (SNAT/2024/000102)</label>
      <select id="medio_facturacion" name="medio_facturacion">
        <option value="APP_SENIAT" selected>📱 Sistema Digital SENIAT (SNAT/2024/000102)</option>
        <option value="IMPRENTA_DIGITAL">🌐 Imprenta Digital Autorizada (API)</option>
      </select>
      ${campo("clave", "🔒 Contraseña (mínimo 10 caracteres)", "", "password", 'required minlength="10" autocomplete="new-password"')}
      <div id="ts-instalar" class="ts-caja"></div>
      ${ERROR}<button class="boton" type="submit">CREAR SISTEMA Y ENTRAR ➔</button>
    </form></section>${TARJETA_GITHUB_ZIP}`;
  $("#tipo_contribuyente")?.addEventListener("change", (e) => {
    const p = $("#inst-regimen-pista");
    if (p) p.textContent = infoRegimen(e.target.value).ayuda;
  });
  const tsInst = montarTurnstile($("#ts-instalar"), estado.turnstile_site_key, "instalar");
  enviar($("#f"), async (d) => {
    try {
      const r = await api("instalar", "POST", { ...d, cf_turnstile_response: d["cf-turnstile-response"] || tsInst.token() });
      pantallaCodigo(r.codigo_recuperacion, { alContinuar: ruta });
    } catch (e) {
      tsInst.reset();
      throw e;
    }
  });
}

function vistaLogin() {
  detenerRelojDemo();
  document.body.classList.add("modo-portada");
  const wa = datosWhatsappContacto("comercial");
  const avisoDemoExpHtml = estado?.demo_expirado
    ? `<div class="aviso-demo-expirado" role="alert">
        <div><b>⏳ Tu prueba guiada de FacturaYa Venezuela ha finalizado.</b><br>${esc(estado.mensaje_demo_expirado || "El entorno temporal fue cerrado y limpiado automáticamente. ¿Listo para activar tu empresa real con tus propios datos fiscales?")}</div>
        ${wa ? `<a class="portada-btn-wa" href="${esc(wa.url)}" target="_blank" rel="nofollow noopener noreferrer">${ICONO_WA_SVG}<span>Activar mi empresa por WhatsApp</span></a>` : ""}
      </div>`
    : "";
  const avisoMantHtml = estado?.mantenimiento
    ? `<div class="aviso-mantenimiento-login" role="alert">
        <div><b>🛠️ Actualización y mantenimiento programado en curso.</b><br>${esc(estado.mensaje_mantenimiento || "Estamos actualizando FacturaYa Venezuela para mejorar el servicio. Por seguridad, las sesiones fueron cerradas temporalmente; podrás ingresar en unos minutos.")}</div>
        <button type="button" class="boton chico contorno-azul" id="mant-reintentar-btn">🔄 Verificar si ya terminó</button>
      </div>`
    : "";
  const avisoSuspHtml = estado?.suspendido
    ? `<div class="aviso-susp-login" role="alert">${esc(estado.mensaje_suspension || "⚠️ Servicio suspendido por falta de pago. Envía la captura o comprobante de tu pago a pagos@facturayave.com para reactivar el acceso.")}</div>`
    : "";
  raiz.innerHTML = `
    <div class="portada">
      <header class="portada-topbar" id="inicio-portada">
        <button type="button" class="portada-marca" data-scroll="inicio-portada" aria-label="FacturaYa Venezuela">
          <img src="/logo-oficial.png?v=20261123v501" alt="FacturaYa Venezuela" width="38" height="38">
          <span>FacturaYa Venezuela</span>
        </button>
        <nav class="portada-nav" aria-label="Secciones principales">
          <button type="button" class="portada-nav-link" data-scroll="capacidades">Capacidades</button>
          <button type="button" class="portada-nav-link" data-scroll="marco-legal">Marco legal</button>
          <button type="button" class="portada-nav-link" data-scroll="equipos">Roles</button>
          <button type="button" class="portada-nav-link" data-scroll="contacto">Contacto</button>
        </nav>
        <div class="portada-nav-accion">
          ${botonInstalarPwaHtml("topbar")}
          <button type="button" class="portada-btn-nav" data-scroll="acceso-empresa">Iniciar sesión</button>
        </div>
      </header>
      ${avisoMantHtml}
      ${avisoDemoExpHtml}
      ${avisoSuspHtml}

      <section class="portada-hero" aria-labelledby="hero-titulo">
        <div class="portada-hero-texto">
          <p class="portada-kicker">facturayave.com · Facturación digital · Normativa SENIAT</p>
          <h1 id="hero-titulo">Facturación digital y libros contables claros para tu negocio.</h1>
          <p class="portada-lead">Emite facturas, presupuestos, notas de crédito y recibos con tu logo en Bolívares y Dólares a la tasa oficial BCV. Opera desde celular, tablet o computadora y entrega los libros listos a tu contador.</p>
          <div class="portada-hero-ctas">
            ${wa
              ? `<a class="portada-btn-wa" href="${esc(wa.url)}" target="_blank" rel="nofollow noopener noreferrer">${ICONO_WA_SVG}<span>Solicitar activación por WhatsApp</span></a>
                 <button type="button" class="portada-btn-sec" data-scroll="acceso-empresa">Ya soy cliente, ingresar ↓</button>`
              : `<button type="button" class="portada-btn-wa" data-scroll="acceso-empresa">Ingresar al sistema ↓</button>
                 <button type="button" class="portada-btn-sec" data-scroll="marco-legal">Ver respaldo legal</button>`}
          </div>
          <p class="portada-meta">Respaldo legal verificable · SNAT/2011/0071 · SNAT/2024/000102 · Art. 128 Ley BCV · Art. 70 y 72 RLIVA</p>
        </div>

        <div class="portada-visual" aria-hidden="true">
          <div class="doc-demo">
            <div class="doc-demo-cab">
              <div class="doc-demo-emisor">
                <img src="/logo-oficial.png?v=20261123v501" alt="FacturaYa Venezuela" width="40" height="40" style="border-radius:10px">
                <div>
                  <strong>Tu Empresa C.A.</strong>
                  <span>RIF J-00000000-0 · Caracas</span>
                </div>
              </div>
              <div class="doc-demo-num">
                <small>Factura N.°</small>
                <strong>00000148</strong>
                <span>Control 00-00000148</span>
              </div>
            </div>
            <div class="doc-demo-filas">
              <div class="doc-demo-fila">
                <div><strong>Servicio técnico especializado</strong><span>Cant. 1 · Alícuota IVA 16%</span></div>
                <b>Bs. 12.915,00</b>
              </div>
              <div class="doc-demo-fila">
                <div><strong>Mantenimiento preventivo mensual</strong><span>Cant. 1 · Alícuota IVA 16%</span></div>
                <b>Bs. 5.535,00</b>
              </div>
            </div>
            <div class="doc-demo-totales">
              <div><span>Base imponible</span><b>Bs. 18.450,00</b></div>
              <div><span>IVA (16%)</span><b>Bs. 2.952,00</b></div>
              <div class="doc-demo-total-final"><span>Total legal en Bolívares</span><b>Bs. 21.402,00</b></div>
              <div class="doc-demo-ref"><span>Referencia BCV (Art. 128 Ley BCV)</span><span>USD 320,00</span></div>
            </div>
            <div class="doc-demo-pie">
              <span>PDF con tu logo</span>
              <span>·</span>
              <span>Listo para WhatsApp y correo</span>
              <span>·</span>
              <span>Libro de Ventas al instante</span>
            </div>
          </div>
        </div>
      </section>

      <section class="portada-seccion" id="capacidades" aria-labelledby="tit-capacidades">
        <div class="portada-sec-cab">
          <p class="portada-kicker">Capacidades del sistema</p>
          <h2 id="tit-capacidades">Todo el ciclo comercial y contable en una sola plataforma</h2>
        </div>
        <div class="portada-bento">
          <article class="bento-card bento-wide">
            <span class="bento-num">01. Facturación, presupuestos y notas</span>
            <h3>Documentos fiscales con tu marca listos en segundos</h3>
            <p>Emite Facturas, Presupuestos convertibles en factura con un toque, Notas de Crédito, Notas de Débito y Recibos de Pago en PDF con tu logotipo, para enviar directo al WhatsApp o correo de tu cliente.</p>
            <p class="bento-ley">Sustento legal: Providencias SNAT/2011/0071 y SNAT/2024/000102 (compatible con Sistema Digital SENIAT e Imprenta Digital Autorizada).</p>
          </article>
          <article class="bento-card">
            <span class="bento-num">02. Bimoneda BCV y regímenes SENIAT</span>
            <h3>Cálculo exacto para Formal, Ordinario y Especial</h3>
            <p>Sincroniza la tasa oficial del BCV o ajústala manualmente, congela la tasa en cada factura y adapta automáticamente IVA (0%, 8% y 16%) e IGTF del 3% exclusivo para Contribuyentes Especiales (SPE).</p>
            <p class="bento-ley">Sustento legal: Art. 128 Ley del BCV, Art. 8 Ley de IVA y Providencia SNAT/2022/000013.</p>
          </article>
          <article class="bento-card">
            <span class="bento-num">03. Libros contables y retenciones</span>
            <h3>Listos para declarar en PDF y Excel</h3>
            <p>Genera Libro de Ventas, Libro de Compras (mercancía, gastos operativos y servicios), Resumen de IVA, Retenciones IVA (75% / 100%), Retenciones ISLR y Cierre Diario Z.</p>
            <p class="bento-ley">Sustento legal: Art. 70 y 72 RLIVA · Providencia SNAT/2015/0049 · Decreto 1.808.</p>
          </article>
          <article class="bento-card bento-wide" id="equipos">
            <span class="bento-num">04. Inventario, gastos y control por roles</span>
            <h3>Tu equipo trabaja ordenado y tus márgenes quedan protegidos</h3>
            <p>Asigna accesos independientes para Administrador, Supervisor, Cajero, Bodega y Contador. Los cajeros facturan y cobran sin ver costos ni ganancias, y tu contador entra en modo solo lectura para descargar los libros del mes.</p>
            <p class="bento-ley">Privacidad y respaldo: datos aislados por empresa y copias de seguridad automáticas firmadas en la nube.</p>
          </article>
        </div>
      </section>

      <section class="portada-seccion" id="marco-legal" aria-labelledby="tit-legal">
        <div class="portada-sec-cab">
          <p class="portada-kicker">Transparencia normativa</p>
          <h2 id="tit-legal">Base legal que respalda cada proceso</h2>
          <p class="portada-sec-sub">Referenciamos cada norma venezolana para que tú y tu contador puedan verificar con claridad el porqué de cada cálculo y reporte.</p>
        </div>
        <div class="legal-lista">
          <div class="legal-item">
            <strong>Providencia SNAT/2011/0071</strong>
            <p>Requisitos formales de emisión de facturas, notas de crédito, notas de débito y correlativos consecutivos.</p>
          </div>
          <div class="legal-item">
            <strong>Providencia SNAT/2024/000102</strong>
            <p>Modalidades de facturación digital: Sistema Digital SENIAT e integración con Imprenta Digital autorizada.</p>
          </div>
          <div class="legal-item">
            <strong>Art. 128 · Ley del BCV</strong>
            <p>Expresión obligatoria de los montos legales en Bolívares junto a su referencia en divisas a la tasa oficial vigente.</p>
          </div>
          <div class="legal-item">
            <strong>Providencia SNAT/2022/000013</strong>
            <p>Cálculo, desglose y declaración quincenal del IGTF (3%) aplicable a pagos en moneda extranjera percibidos por Sujetos Pasivos Especiales (SPE).</p>
          </div>
          <div class="legal-item">
            <strong>Art. 70 y Art. 72 · RLIVA</strong>
            <p>Estructura oficial del Libro de Compras (crédito fiscal de mercancía, gastos y servicios) y Libro de Ventas.</p>
          </div>
          <div class="legal-item">
            <strong>SNAT/2015/0049 · Decreto 1.808</strong>
            <p>Registro y control de comprobantes de Retención de IVA (75% y 100%) y Retenciones de ISLR.</p>
          </div>
        </div>
      </section>

      <section class="portada-cta-banda" id="contacto" aria-labelledby="tit-contacto">
        <div>
          <h2 id="tit-contacto">Activa FacturaYa Venezuela en tu empresa</h2>
          <p>Te ayudamos a configurar tu RIF, logotipo, usuarios y modalidad de facturación para empezar a emitir el mismo día.</p>
        </div>
        <div class="portada-cta-botones">
          ${wa ? `<a class="portada-btn-wa grande" href="${esc(wa.url)}" target="_blank" rel="nofollow noopener noreferrer">${ICONO_WA_SVG}<span>Escribir por WhatsApp</span></a>` : ""}
          <button type="button" class="portada-btn-correo" data-correo-comercial>✉️ Solicitar por correo</button>
        </div>
      </section>

      <section class="portada-acceso" id="acceso-empresa" aria-labelledby="tit-acceso">
        <div class="portada-acceso-info">
          <p class="portada-kicker">Acceso para empresas activas</p>
          <h2 id="tit-acceso">Ingresa a tu negocio</h2>
          <p>Inicia sesión en <b>www.facturayave.com</b> con el correo y la contraseña asignados a tu empresa. Funciona igual en teléfono, tablet y computadora.</p>
          <ul class="portada-acceso-puntos">
            <li>Acceso por usuario y rol (Administrador, Supervisor, Cajero, Bodega o Contador).</li>
            <li>Sesiones cifradas con verificación en 2 pasos (2FA) disponible para administradores.</li>
            <li>¿Olvidaste tu clave? Solicita una clave temporal al correo principal del Administrador.</li>
          </ul>
        </div>
        <div class="portada-acceso-card">
          ${avisoSuspHtml}
          <form id="f">
            ${campo("email", "Correo electrónico", "", "email", 'required autocomplete="username" placeholder="tucorreo@empresa.com"')}
            ${campo("clave", "Contraseña", "", "password", 'required autocomplete="current-password"')}
            <div id="bloque-2fa" hidden>
              <p class="pista" id="msg-2fa">Esta cuenta tiene verificación en 2 pasos activa. Ingresa el código de 6 dígitos de tu app autenticadora (o un código de respaldo).</p>
              ${campo("codigo_2fa", "Código 2FA (6 dígitos o respaldo)", "", "text", 'autocomplete="one-time-code" maxlength="20" placeholder="123456"')}
            </div>
            <div id="ts-login" class="ts-caja"></div>
            ${ERROR}<button class="boton" type="submit" id="btn-login">Ingresar al sistema</button>
          </form>
          <button class="boton contorno-azul" id="olvide" type="button" style="margin-top:12px">¿Olvidaste tu contraseña? Recíbela en el correo del Administrador</button>
        </div>
      </section>

      <footer class="portada-pie">
        <span class="portada-pie-marca"><img src="/logo-oficial.png?v=20261123v501" alt="FacturaYa Venezuela" width="24" height="24">FacturaYa Venezuela · www.facturayave.com · Facturación Digital y Libros Contables</span>
        <div class="portada-pie-enlaces">
          ${wa ? `<a href="${esc(wa.url)}" target="_blank" rel="nofollow noopener noreferrer">WhatsApp comercial</a>` : ""}
          <button type="button" class="portada-pie-btn" data-correo-comercial>Correo de solicitudes</button>
        </div>
      </footer>
    </div>${TARJETA_GITHUB_ZIP}`;

  enlazarBotonesPwa(raiz, aviso);
  $("#mant-reintentar-btn")?.addEventListener("click", () => ruta());

  raiz.querySelectorAll("[data-scroll]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.scroll);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      if (btn.dataset.scroll === "acceso-empresa") {
        setTimeout(() => $("#email")?.focus(), 450);
      }
    });
  });

  $("#olvide").addEventListener("click", () => {
    document.body.classList.remove("modo-portada");
    vistaRecuperar(vistaLogin, estado.turnstile_site_key);
  });
  const tsLogin = montarTurnstile($("#ts-login"), estado.turnstile_site_key, "login");
  enviar($("#f"), async (d) => {
    try {
      const r = await api("login", "POST", { ...d, cf_turnstile_response: d["cf-turnstile-response"] || tsLogin.token() });
      if (r?.requiere_2fa) {
        const b2 = $("#bloque-2fa");
        if (b2) b2.hidden = false;
        if (r.mensaje && $("#msg-2fa")) $("#msg-2fa").textContent = r.mensaje;
        const inp = $("#codigo_2fa");
        if (inp) { inp.required = true; inp.focus(); }
        if ($("#btn-login")) $("#btn-login").textContent = "Verificar 2FA e ingresar";
        tsLogin.reset();
        return;
      }
      await ruta();
    } catch (e) {
      tsLogin.reset();
      if (e?.mantenimiento) {
        estado = { ...estado, sesion: false, mantenimiento: true, mensaje_mantenimiento: e.mensaje_mantenimiento || e.message };
        vistaLogin();
        window.scrollTo(0, 0);
        return;
      }
      if (e?.demo_expirado) {
        estado = { ...estado, sesion: false, demo_expirado: true, mensaje_demo_expirado: e.message };
        vistaLogin();
        window.scrollTo(0, 0);
        return;
      }
      throw e;
    }
  });
}

function vistaInicio() {
  const n = estado.negocio || {}, tasa = Number(n.tasa_bcv) || 0;
  const modoTasa = n.tasa_bcv_modo === "MANUAL" ? "MANUAL" : "AUTOMATICO";
  const regInfo = infoRegimen(n.tipo_contribuyente);
  const esFormal = n.tipo_contribuyente === "FORMAL";
  raiz.innerHTML = `
    ${barraSuper()}
    <header class="encabezado">${logoHeader(n)}<h1>Hola, ${esc(n.nombre_razon_social || "Mi Negocio")}</h1>
      <button class="icono" id="ajustes" data-ayuda="Ajustes del negocio, tasa BCV, datos de cobro y cerrar sesión" aria-label="Ajustes">⚙️</button></header>
    ${botonInstalarPwaHtml("inicio")}
    ${estado.seguridad && !estado.seguridad.master_key ? `<section class="aviso-control">🔐 <b>Falta MASTER_KEY.</b> Sin ella no se pueden guardar claves de API ni firmar respaldos. Configúrala en Cloudflare: <code>wrangler secret put MASTER_KEY</code>.</section>` : ""}
    ${estado.seguridad && !estado.seguridad.turnstile_secreto ? `<section class="aviso-control">🛡️ <b>Falta TURNSTILE_SECRET_KEY.</b> Con la clave pública activa, el acceso y la recuperación exigen el secreto: <code>wrangler secret put TURNSTILE_SECRET_KEY</code>.</section>` : ""}
    ${estado.seguridad?.ultimo_error_r2 ? `<section class="aviso-anulado" data-destino="#/inquilinos/salud">☁️ <b>Alerta de respaldo R2 (${esc(estado.seguridad.ultimo_error_r2.tipo || "cron")}):</b> ${esc(estado.seguridad.ultimo_error_r2.mensaje || "Error en la última ejecución.")} <small>(${esc(estado.seguridad.ultimo_error_r2.fecha || "")})</small></section>` : ""}
    ${n.medio_facturacion === "SIN_DEFINIR" && puede("super") ? `<section class="aviso-control" data-destino="#/ajustes">⚠️ Define la <b>modalidad de facturación digital (SNAT/2024/000102)</b> en Ajustes.</section>` : ""}
    <div class="inicio-resumen">
      <section class="tarjeta tasa">
        <div id="tasa-vista">
          <span class="etiqueta">🟢 TASA OFICIAL BCV (ART. 128 LEY BCV)</span><br>
          <strong>${tasa ? `Bs. ${bs(tasa)}` : "Sin definir"}</strong>
          <span class="insignia ${modoTasa === "MANUAL" ? "ambar" : "verde"}" id="tasa-modo-badge" style="margin-left:8px;vertical-align:middle">${modoTasa === "MANUAL" ? "✍️ Manual" : "🔄 Automático BCV"}</span>
          <span class="insignia ${regInfo.insignia}" id="inicio-regimen-badge" style="margin-left:6px;vertical-align:middle">${esc(regInfo.corto)}</span><br>
          <small class="suave">${n.tasa_bcv_fecha ? `Actualizada: ${fechaLocal(n.tasa_bcv_fecha)}` : "Sincroniza o define la tasa en Ajustes"}</small>
        </div>
        ${puede("tasa") ? `<button class="boton chico contorno-azul" type="button" id="tasa-ir-ajustes" data-destino="#/ajustes" data-ayuda="Configurar tasa BCV automática o manual en Ajustes">⚙️ Ajustes</button>` : ""}
      </section>
      ${puede("admin") ? `<section class="tarjeta ganancia" data-destino="#/informes" data-nombre="Informes" data-ayuda="Informes para el contador: ventas, compras, ganancias, por cobrar e inventario"><span class="etiqueta">💰 TU GANANCIA NETA (ESTE MES)</span><strong id="gan-total">$ 0,00</strong>
        <small class="suave" id="gan-det">🟣 Servicios: $0 · 🔵 Productos: $0 · Toca para ver Libros SENIAT</small></section>`
        : puede("informes_contador") ? `<section class="tarjeta ganancia" data-destino="#/informes" data-nombre="Libros SENIAT"><span class="etiqueta">${esFormal ? "📊 RELACIÓN DE VENTAS Y COMPRAS (FORMAL)" : "📊 LIBROS CONTABLES (ART. 70 Y 72 RLIVA)"}</span><strong>${esFormal ? "Relación de Ventas, Compras e ISLR" : "Ventas, Compras y Resumen IVA"}</strong>
        <small class="suave">Descarga en PDF o Excel (CSV).</small></section>` : ""}
    </div>
    <div class="rejilla">
      ${puede("caja") ? `<button class="accion azul" data-destino="#/factura" data-nombre="Factura" data-ayuda="Presupuestos, facturas, notas de crédito y débito"><span>🧾</span>Factura<small>Facturas y presupuestos</small></button>
      <button class="accion ambar" data-destino="#/clientes" data-nombre="Clientes" data-ayuda="Tus clientes, RIF y correo"><span>👥</span>Clientes<small>Tus clientes</small></button>
      <button class="accion verde" data-destino="#/pagos" data-nombre="Pagos" data-ayuda="Por cobrar, pagos recibidos y tus datos de cobro"><span>💳</span>Pagos<small>Cobros y por cobrar</small></button>` : ""}
      ${puede("inventario") ? `<button class="accion morado" data-destino="#/inventario" data-nombre="Inventario" data-ayuda="Tus productos, servicios y compras"><span>📦</span>Inventario<small>Productos y compras</small></button>` : ""}
      ${puede("informes_contador") ? `<button class="accion azul" data-destino="#/informes" data-nombre="Libros SENIAT" data-ayuda="${esFormal ? "Relación de ventas y compras (Formal), ISLR y Cierre Z" : "Libros de ventas, compras, resumen IVA, ISLR y Cierre Z"}"><span>📊</span>Libros SENIAT<small>${esFormal ? "Relación ventas y compras" : "Ventas, compras e IVA"}</small></button>` : ""}
      ${puede("super") && (estado.inquilino_actual || "principal") !== "DB_DEMO" ? `<button class="accion morado" data-destino="#/inquilinos" data-nombre="Inquilinos" data-ayuda="Panel Multi-Tenant para crear y administrar clientes"><span>🏢</span>Inquilinos<small>Empresas afiliadas</small></button>` : ""}
    </div>
    <section class="tarjeta"><span class="etiqueta">🔔 ALERTAS RÁPIDAS</span><p class="suave" id="alertas-txt">Todo en orden ✅</p></section>
    ${navegacion("inicio")}`;
  $("#ajustes").addEventListener("click", () => (location.hash = "#/ajustes"));
  enlazarBotonesPwa(raiz, aviso);
  activar();
  if (puede("admin")) api("documentos/resumen").then((r) => {
    $("#gan-total").textContent = usd(r.total); $("#gan-det").textContent = `🟣 Servicios: ${usd(r.servicios)} · 🔵 Productos: ${usd(r.productos)} · Toca para ver Libros SENIAT`;
  }).catch(() => {});
  Promise.all([puede("caja") ? api("pagos/resumen").catch(() => null) : null, puede("inventario") ? api("existencias/alertas").catch(() => null) : null]).then(([r, e]) => {
    const t = $("#alertas-txt"); if (!t) return;
    const lineas = [];
    if (r?.vencidas_n) lineas.push([`⚠️ ${r.vencidas_n} factura(s) vencida(s): ${usd(r.vencidas_usd)}`, "#/pagos"]);
    if (r?.por_cobrar_n) lineas.push([`💵 Por cobrar: ${usd(r.por_cobrar_usd)} en ${r.por_cobrar_n} factura(s)`, "#/pagos"]);
    if (e?.agotados) lineas.push([`📦 ${e.agotados} producto(s) agotado(s)`, "#/inventario"]);
    if (e?.bajos) lineas.push([`🔔 ${e.bajos} producto(s) con poco stock`, "#/inventario"]);
    if (!lineas.length) return;
    t.innerHTML = lineas.map(([x, ir]) => `<span class="alerta-linea" data-ir="${ir}">${esc(x)}</span>`).join("<br>");
    t.querySelectorAll(".alerta-linea").forEach((el) => el.addEventListener("click", () => (location.hash = el.dataset.ir)));
  });
}

// ---------------------------------------------------------------- Panel Multi-Tenant Exclusivo del Súper Administrador (SUPER_ADMIN)
async function vistaInquilinos(subvista = "") {
  if (!puede("super")) return vistaInicio();
  const data = await api("inquilinos");
  const lista = data.inquilinos || [];
  const directorio = data.directorio || [];
  const ranurasD1 = data.ranuras_d1 || [];
  const proximaRanura = data.proxima_ranura || "DB_1";
  const activo = data.inquilino_actual || data.inquilino_activo || "principal";
  const inqActualObj =
    activo === "DB_DEMO"
      ? { codigo: "DB_DEMO", nombre_negocio: estado.demo?.nombre_negocio || estado.negocio?.nombre_razon_social || "Entorno Demo" }
      : (lista.find((x) => x.codigo === activo) || lista[0] || {});
  const limiteD1 = Number(data.limite_d1 || 10);
  const usadasD1 = Number(data.usadas_d1 || lista.length || 1);
  const libresD1 = Math.max(0, Number(data.libres_d1 ?? (limiteD1 - usadasD1)));
  const txtLimiteD1 = limiteD1.toLocaleString("es-VE");
  const txtLibresD1 = libresD1.toLocaleString("es-VE");
  const esPlan5Usd = data.plan_d1 === "PRO_5USD" || limiteD1 > 10;
  const activasN = lista.filter((x) => x.activo !== 0 && x.activo !== false && x.estado !== "SUSPENDIDO").length;
  const periodoActual = data.periodo_actual || new Date().toISOString().slice(0, 7);
  const tasaPrincipal = Number(data.tasa_bcv_principal || 0);
  const medioPrincipal = data.medio_principal || "APP_SENIAT";

  // 1) Menú Principal de Mis Inquilinos con Botones Cuadrados + Selector Rápido Buscable (100+ BD)
  if (!subvista) {
    raiz.innerHTML = `
      <header class="encabezado"><button class="icono" id="atras" aria-label="Volver">←</button><h1>🏢 Mis Inquilinos</h1></header>
      <section class="tarjeta">
        <div class="reng-cab"><span class="etiqueta">👑 CENTRO MULTI-TENANT · SÚPER ADMIN</span><span class="insignia verde" id="inq-cuota-badge">${usadasD1}/${txtLimiteD1} D1 ocupadas · ${txtLibresD1} libres</span></div>
        <p class="suave" style="margin-bottom:8px">Empresa activa en pantalla: <b>${esc(inqActualObj.nombre_negocio || estado.negocio?.nombre_razon_social || "Principal")} (${esc(activo)})</b> · Próxima ranura libre: <b>${esc(proximaRanura)}</b> (${esPlan5Usd ? "Plan $5/mes · hasta 50.000 BD" : "Plan Beta Gratis · 10 BD · Escalable a 50.000 BD"}).</p>
        ${lista.length > 1 ? `<details id="sw-rapido-det">
          <summary style="cursor:pointer;font-weight:600;color:#1A73E8">🔄 Cambiar empresa activa para «⚙️ Ajustes (${esc(activo)})» (${lista.length} disponibles)</summary>
          <div style="margin-top:8px">
            <input type="search" id="sw-buscar" placeholder="🔍 Buscar por nombre, RIF o ranura DB_X…" autocomplete="off" style="margin-bottom:6px">
            <div class="mini-lista-sw" id="sw-lista"></div>
          </div>
        </details>` : ""}
      </section>
      <div class="rejilla">
        <button class="accion verde" data-destino="#/inquilinos/alta" data-nombre="Dar de Alta Cliente">
          <span>➕</span><b>Dar de Alta Cliente</b><small>Próxima: ${esc(proximaRanura)} · RIF y Contacto</small>
        </button>
        <button class="accion ambar" data-destino="#/inquilinos/demo" data-nombre="Demo para Prospectos">
          <span>🧪</span><b>Demo para Prospectos</b><small>${estado.demo_resumen?.activo ? `🟢 Activa (${esc(infoRegimen(estado.demo_resumen.regimen).corto)} · ${Math.max(1, Math.ceil((estado.demo_resumen.segundos_restantes || 0) / 60))}m)` : "Crear prueba aislada 30m/1h/2h"}</small>
        </button>
        <button class="accion azul" data-destino="#/inquilinos/empresas" data-nombre="Empresas Afiliadas">
          <span>🏢</span><b>Empresas (${lista.length})</b><small>${activasN} activa(s) · Buscar y gestionar</small>
        </button>
        <button class="accion morado" data-destino="#/inquilinos/cloudflare" data-nombre="Cloudflare D1">
          <span>☁️</span><b id="btn-cf-titulo">Cloudflare D1 (${usadasD1}/${txtLimiteD1})</b><small id="btn-cf-sub">${txtLibresD1} de ${txtLimiteD1} libres · Worker y API</small>
        </button>
        <button class="accion azul" data-destino="#/inquilinos/builds" data-nombre="Despliegues y Builds">
          <span>🚀</span><b id="btn-builds-titulo">Despliegues y Builds</b><small id="btn-builds-sub">${estado.mantenimiento_despliegue?.activo ? "🔒 Mantenimiento ACTIVO · Reabrir" : "Mantenimiento, Logs y Rollback"}</small>
        </button>
        <button class="accion morado" data-destino="#/inquilinos/mantenimiento" data-nombre="Mantenimiento Nocturno">
          <span>🌙</span><b>Mantenimiento Nocturno</b><small>2:00 AM VET · Silencio 6 AM–9 PM</small>
        </button>
        <button class="accion ambar" data-destino="#/inquilinos/salud" data-nombre="Salud BD y Respaldo">
          <span>🩺</span><b>Salud y Respaldos (${lista.length} BD)</b><small>16 candados SENIAT y Backup</small>
        </button>
        <button class="accion azul" data-destino="#/inquilinos/correos" data-nombre="Directorio de Correos">
          <span>📧</span><b>Directorio Correos (${directorio.length})</b><small>${directorio.length} usuario(s) en ${lista.length} empresa(s)</small>
        </button>
        <button class="accion verde" data-destino="#/inquilinos/correos-plataforma" data-nombre="Correos de Plataforma">
          <span>📨</span><b>Correos Plataforma</b><small>Cuotas UTC, rebotes y failover</small>
        </button>
        <button class="accion morado" data-destino="#/ajustes" data-nombre="Ajustes Empresa Activa">
          <span>⚙️</span><b>Ajustes (${esc(activo)})</b><small>Empresa activa: ${esc(inqActualObj.nombre_negocio || "Principal")}</small>
        </button>
      </div>
      ${navegacion("inicio")}`;
    $("#atras").addEventListener("click", () => (location.hash = "#/inicio"));
    activar();

    const pintarSwitcher = (q = "") => {
      const box = $("#sw-lista");
      if (!box) return;
      const t = q.trim().toLowerCase();
      const filt = t
        ? lista.filter((x) => `${x.codigo} ${x.nombre_negocio || ""} ${x.rif || ""} ${x.email_dueno || ""}`.toLowerCase().includes(t))
        : lista;
      const tope = filt.slice(0, 15);
      box.innerHTML =
        tope.map((x) => {
          const esAct = x.codigo === activo;
          return `<div class="mini-sw-item${esAct ? " activo" : ""}">
            <div style="min-width:0;overflow:hidden;text-overflow:ellipsis"><b>${esc(x.codigo)}</b> · ${esc(x.nombre_negocio || "Empresa")} <small class="suave">(${esc(x.rif)})</small></div>
            ${esAct
              ? `<span class="insignia azul">Activa</span>`
              : `<button type="button" class="boton chico" data-sw-cod="${esc(x.codigo)}">Entrar</button>`}
          </div>`;
        }).join("") +
        (filt.length > 15 ? `<small class="suave">Mostrando 15 de ${filt.length}. Escribe para filtrar o ve a Empresas.</small>` : "") ||
        `<small class="suave">Sin coincidencias.</small>`;
      box.querySelectorAll("[data-sw-cod]").forEach((b) =>
        b.addEventListener("click", async () => {
          const codigo = b.dataset.swCod;
          b.disabled = true;
          try {
            await api("inquilinos/cambiar", "POST", { codigo });
            aviso(`Empresa activa: ${codigo} ✅`);
            await ruta();
          } catch (e) {
            aviso(e.message);
            b.disabled = false;
          }
        })
      );
    };
    if ($("#sw-buscar")) {
      pintarSwitcher("");
      $("#sw-buscar").addEventListener("input", (e) => pintarSwitcher(e.target.value));
    }

    // Si la API de Cloudflare está conectada, sincronizar en caliente el conteo físico real de bases D1 en segundo plano
    if (data.cloudflare_configurado) {
      api("inquilinos/cloudflare/estado").then((cf) => {
        if (!cf || !cf.ok || !cf.cuota_d1) return;
        const c = cf.cuota_d1;
        const lim = Number(c.limite_plan || c.limite_gratis || limiteD1).toLocaleString("es-VE");
        const lib = Number(c.libres_plan ?? c.libres_gratis ?? libresD1).toLocaleString("es-VE");
        const badgeEl = document.getElementById("inq-cuota-badge");
        const titEl = document.getElementById("btn-cf-titulo");
        const subEl = document.getElementById("btn-cf-sub");
        if (badgeEl) badgeEl.textContent = `${c.usadas}/${lim} D1 ocupadas · ${lib} libres`;
        if (titEl) titEl.textContent = `Cloudflare D1 (${c.usadas}/${lim})`;
        if (subEl) subEl.textContent = `${lib} de ${lim} libres · Worker y API`;
      }).catch(() => {});
    }
    return;
  }

  const barraVolverInq = (titulo) => `
    <header class="encabezado"><button class="icono" id="volver-inq" aria-label="Volver a Mis Inquilinos">←</button><h1>${titulo}</h1></header>`;

  if (subvista === "correos-plataforma") {
    await vistaPanelCorreosPlataforma(raiz, barraVolverInq, () => (location.hash = "#/inquilinos"));
    return;
  }

  // 1b) Subvista: DEMO PARA PROSPECTOS (#/inquilinos/demo) — Base D1 aislada DB_DEMO, 3 meses de historial realista, vencimiento automático
  if (subvista === "demo") {
    const respDemo = await api("demo");
    const d = respDemo.demo || {};
    const regAct = infoRegimen(d.regimen || "ORDINARIO");
    const minRest = Math.max(0, Math.ceil((Number(d.segundos_restantes) || 0) / 60));
    raiz.innerHTML = `
      ${barraVolverInq("🧪 Demo para Prospectos")}
      ${!d.db_demo_configurada ? `<section class="aviso-anulado">⚠️ <b>Falta vincular <code>DB_DEMO</code> en Cloudflare:</b> asegúrate de desplegar el último <code>wrangler.toml</code> con el binding <code>DB_DEMO</code> apuntando a <code>facturaya_demo_db</code>.</section>` : ""}
      ${d.activo ? `<section class="tarjeta secreto" id="card-demo-activa">
        <div class="reng-cab">
          <span class="etiqueta">🟢 ENTORNO DEMO ACTIVO (DB_DEMO AISLADA)</span>
          <span class="insignia ${regAct.insignia}">${esc(regAct.etiqueta)}</span>
        </div>
        <p class="suave" style="margin-bottom:6px">
          <b>${esc(d.nombre_negocio)}</b> · Quedan aprox. <b>${minRest} min</b> (vence: <b>${esc(d.expira_hora_caracas)}</b>).<br>
          ✉️ Correos de prueba: ${d.email_prospecto
            ? `<b>${d.correos_enviados}/${d.max_correos}</b> enviados · Redirigidos exclusivamente a <b>${esc(d.email_prospecto)}</b>.`
            : "<b>Desactivados</b> (sin correo del prospecto configurado)."}
        </p>
        <div class="demo-cred-box">
          <div class="demo-cred-fila"><span>👑 Administrador:</span><code>${esc(d.credenciales?.admin || "")}</code></div>
          <div class="demo-cred-fila"><span>🧾 Cajero (sin costos):</span><code>${esc(d.credenciales?.cajero || "")}</code></div>
          <div class="demo-cred-fila"><span>📊 Contador (solo libros):</span><code>${esc(d.credenciales?.contador || "")}</code></div>
          <div class="demo-cred-fila"><span>🔑 Contraseña (3 roles):</span><code>${esc(d.credenciales?.clave || "")}</code></div>
        </div>
        <details style="margin:8px 0">
          <summary style="cursor:pointer;font-weight:600;color:#1A73E8">💬 Ver texto completo de invitación para WhatsApp</summary>
          <pre class="demo-wa-pre" style="margin-top:8px">${esc(d.invitacion_whatsapp || "")}</pre>
        </details>
        <div class="dos-botones" style="margin-top:10px">
          <button type="button" class="boton verde" id="demo-copiar-wa">📋 Copiar invitación WhatsApp</button>
          <button type="button" class="boton" id="demo-entrar-ver">👁️ Entrar a ver la Demo</button>
        </div>
        <div class="dos-botones" style="margin-top:8px">
          <button type="button" class="boton chico contorno-azul" id="demo-extender">⏱️ Extender +1 hora</button>
          <button type="button" class="boton chico rojo" id="demo-cerrar-ahora">🗑️ Cerrar y borrar demo ahora</button>
        </div>
      </section>` : `<section class="tarjeta">
        <div class="reng-cab"><span class="etiqueta">🧪 ESTADO DE DB_DEMO</span><span class="insignia gris">Libre y limpia</span></div>
        <p class="suave">No hay ninguna sesión demo abierta en este momento. Tu base <code>facturaya_demo_db</code> está vacía y lista para generar una prueba aislada en segundos sin tocar jamás tus clientes reales.</p>
      </section>`}

      <section class="tarjeta">
        <h2>${d.activo ? "🔄 Reemplazar y generar una nueva Demo" : "🚀 Generar nuevo Entorno Demo Aislado"}</h2>
        <p class="suave">Crea en <code>DB_DEMO</code> una empresa ficticia con <b>3 meses completos de facturación realista</b> (24 facturas, clientes, inventario, compras, cobros en Bs./Divisas, retenciones IVA/ISLR, Nota de Crédito, Nota de Débito y Presupuestos) y los 3 roles listos sin cambio de clave. Al vencer el tiempo, se cierra y borra sola.</p>
        <form id="form-crear-demo">
          <label for="demo_regimen">⚖️ Régimen fiscal del prospecto (SENIAT)</label>
          <select id="demo_regimen" name="regimen">
            ${opcionesRegimenHtml(d.regimen || "ORDINARIO")}
          </select>
          <p class="pista" id="demo-regimen-pista">${esc(infoRegimen(d.regimen || "ORDINARIO").ayuda)}</p>
          <label for="demo_duracion">⏱️ Duración de la prueba</label>
          <select id="demo_duracion" name="duracion_min">
            <option value="30">30 minutos (Demo rápida en llamada)</option>
            <option value="60">1 hora (Evaluación estándar)</option>
            <option value="120" selected>2 horas (Evaluación completa con contador)</option>
          </select>
          ${campo("nombre_negocio", "🏢 Nombre del negocio ejemplo (opcional)", "", "text", 'maxlength="120" placeholder="Ej: Comercial Demo Los Andes C.A. (si lo dejas vacío se sugiere según régimen)"')}
          ${campo("email_prospecto", "✉️ Correo del prospecto (opcional · habilita prueba real de PDF)", "", "email", 'maxlength="120" placeholder="prospecto@correo.com — máx. 5 correos, todos redirigidos SOLO aquí"')}
          <p class="pista">🛡️ <b>Seguridad blindada:</b> la demo jamás toca tus empresas reales ni respaldos R2, bloquea Imprenta Digital, 2FA y configuración de APIs, y todos los PDF salen marcados como <b>«DOCUMENTO DEMOSTRATIVO — SIN VALIDEZ FISCAL»</b>.</p>
          ${ERROR}<button type="submit" class="boton verde" ${!d.db_demo_configurada ? "disabled" : ""}>🧪 ${d.activo ? "REEMPLAZAR Y GENERAR NUEVA DEMO" : "GENERAR ENTORNO DEMO AISLADO"}</button>
        </form>
      </section>`;

    $("#volver-inq").addEventListener("click", () => (location.hash = "#/inquilinos"));
    $("#demo_regimen")?.addEventListener("change", (e) => {
      const p = $("#demo-regimen-pista");
      if (p) p.textContent = infoRegimen(e.target.value).ayuda;
    });
    $("#demo-copiar-wa")?.addEventListener("click", async () => {
      const ok = await copiarTextoSeguro(d.invitacion_whatsapp || "");
      aviso(ok ? "Invitación copiada para pegar en WhatsApp 📋✅" : "Abre el desplegable para copiar el texto manualmente.");
    });
    $("#demo-entrar-ver")?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        await api("inquilinos/cambiar", "POST", { codigo: "DB_DEMO" });
        aviso("Entrando a la Demo aislada 🧪");
        location.hash = "#/inicio";
        await ruta();
      } catch (e) {
        aviso(e.message);
        btn.disabled = false;
      }
    });
    $("#demo-extender")?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        await api("demo/extender", "POST", { minutos: 60 });
        aviso("Tiempo de demo extendido +1 hora ⏱️✅");
        await vistaInquilinos("demo");
      } catch (e) {
        aviso(e.message);
        btn.disabled = false;
      }
    });
    $("#demo-cerrar-ahora")?.addEventListener("click", async (ev) => {
      if (!confirm("¿Cerrar y borrar ahora mismo toda la base de datos Demo (DB_DEMO)?\n\nTus empresas reales no se tocan en absoluto.")) return;
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        await api("demo/cerrar", "POST", {});
        aviso("Entorno Demo cerrado y DB_DEMO limpiada ✅");
        await vistaInquilinos("demo");
      } catch (e) {
        aviso(e.message);
        btn.disabled = false;
      }
    });
    enviar($("#form-crear-demo"), async (v) => {
      const r = await api("demo/crear", "POST", {
        regimen: v.regimen,
        duracion_min: Number(v.duracion_min || 120),
        nombre_negocio: v.nombre_negocio || "",
        email_prospecto: v.email_prospecto || "",
      });
      aviso(`Entorno Demo ${r.estado?.regimen || ""} generado con 3 meses de datos ✅`);
      await vistaInquilinos("demo");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    return;
  }

  // 2) Subvista: DAR DE ALTA CLIENTE (#/inquilinos/alta) — Limpio: solo datos legales SENIAT, contacto usual, correlativos iniciales y APIs opcionales
  if (subvista === "alta") {
    let logoAlta = null;
    const ranurasLibres = ranurasD1.filter((r) => !r.ocupada);
    const ranurasOcupadasN = ranurasD1.filter((r) => r.ocupada).length;
    const opcionesRanura = (ranurasLibres.length ? ranurasLibres : [{ codigo: proximaRanura, nombre_bd_sugerido: `facturaya_${proximaRanura.toLowerCase()}`, ocupada: false }])
      .slice(0, 12)
      .map((r) => `<option value="${esc(r.codigo)}" ${r.codigo === proximaRanura ? "selected" : ""}>${esc(r.codigo)} (${esc(r.nombre_bd_sugerido)}) — 🟢 Disponible</option>`)
      .join("");
    raiz.innerHTML = `
      ${barraVolverInq("➕ Dar de Alta Cliente")}
      <div id="credenciales-nuevo"></div>
      <section class="tarjeta">
        <h2>📋 Alta de Cliente (SENIAT + Contacto + Correlativos Iniciales)</h2>
        <p class="suave">Al crear la empresa se provisiona automáticamente su base de datos <b>Cloudflare D1</b> dedicada. Solo se piden los datos estrictamente exigidos por el SENIAT y de contacto del administrador. El <b>Logo</b> y las <b>APIs</b> son opcionales.</p>
        <form id="form-nuevo-inq">
          <span class="etiqueta">1️⃣ RANURA DE BASE DE DATOS CLOUDFLARE D1 (AUTO-ESCALABLE)</span>
          <label for="ranura_db">🗄️ Ranura D1 dedicada (${esPlan5Usd ? "Plan $5/mes activo: hasta 50.000 BD D1" : "Beta 10 BD · Plan $5 escala hasta 50.000 BD"} · ${ranurasOcupadasN} ocupadas)</label>
          <select id="ranura_db" name="ranura_db">
            ${opcionesRanura}
          </select>

          <hr>
          <span class="etiqueta">2️⃣ DATOS FISCALES OBLIGATORIOS PARA EL SENIAT (ART. 13 SNAT/2011/0071 Y ART. 7 SNAT/2024/000102)</span>
          ${campo("nombre_negocio", "🏷️ Nombre o Razón Social (según RIF)", "", "text", 'required placeholder="Ej: COMERCIAL DEMO C.A."')}
          ${campo("rif", "🪪 RIF Fiscal (ej: J-12345678-9 o V-12345678-0)", "", "text", 'required placeholder="J-12345678-9 o V-12345678-0" autocapitalize="characters"')}
          ${campo("direccion", "📍 Domicilio Fiscal completo", "", "text", 'required placeholder="Ej: Av. Principal, Edif. Centro, Local 3, Caracas, Distrito Capital"')}
          <label for="tipo_contribuyente">⚖️ Condición Fiscal / Tipo de Contribuyente (SENIAT)</label>
          <select id="tipo_contribuyente" name="tipo_contribuyente">
            ${opcionesRegimenHtml("ORDINARIO")}
          </select>
          <p class="pista" id="alta-regimen-pista">${esc(infoRegimen("ORDINARIO").ayuda)}</p>

          <hr>
          <span class="etiqueta">3️⃣ DATOS DE CONTACTO Y ACCESO DEL ADMINISTRADOR</span>
          ${campo("nombre_dueno", "👤 Nombre Completo del Administrador / Representante Legal", "", "text", 'required placeholder="Ej: Nombre y Apellido"')}
          ${campo("cedula_dueno", "🪪 Cédula de Identidad", "", "text", 'required placeholder="Ej: V-12345678"')}
          <div class="dos-botones">
            <div>${campo("telefono", "📞 Teléfono / WhatsApp", "", "tel", 'required placeholder="0414-0000000"')}</div>
            <div>${campo("email_dueno", "✉️ Correo Electrónico (será su usuario)", "", "email", 'required placeholder="admin@empresa.com"')}</div>
          </div>

          <hr>
          <span class="etiqueta">4️⃣ NUMERACIÓN CORRELATIVA INICIAL SENIAT (NUEVO O TRANSICIÓN DE FACTURERO MANUAL A DIGITAL)</span>
          <p class="suave">Si el cliente arranca desde cero en facturación digital, déjalos en <b>1</b> (<code>00000001</code>). Si viene de un facturero manual o de otro sistema y debe continuar su secuencia en el Libro de Ventas, indica con qué número inicia:</p>
          <div class="dos-botones">
            <div>${campo("primer_factura", "🧾 Primer N.º de Factura (1 = 00000001)", "1", "number", 'min="1" max="999999999" required inputmode="numeric"')}</div>
            <div>${campo("primer_control", "🔢 Primer N.º de Control (1 = 00-00000001)", "1", "number", 'min="1" max="999999999" required inputmode="numeric"')}</div>
          </div>
          <div class="dos-botones">
            <div>${campo("primer_nota_credito", "↩️ Primer N.º Nota de Crédito (1 = NC-00000001)", "1", "number", 'min="1" max="999999999" required inputmode="numeric"')}</div>
            <div>${campo("primer_nota_debito", "📈 Primer N.º Nota de Débito (1 = ND-00000001)", "1", "number", 'min="1" max="999999999" required inputmode="numeric"')}</div>
          </div>
          <div class="dos-botones">
            <div>${campo("primer_presupuesto", "📋 Primer N.º Presupuesto (1 = P-000001)", "1", "number", 'min="1" max="999999999" required inputmode="numeric"')}</div>
            <div>${campo("primer_recibo", "💵 Primer N.º de Recibo de Pago (1 = 00000001)", "1", "number", 'min="1" max="999999999" required inputmode="numeric"')}</div>
          </div>

          <hr>
          <span class="etiqueta">5️⃣ LOGO DE LA EMPRESA (OPCIONAL · SI NO TIENE, SALE SIN LOGO)</span>
          <div class="logo-caja" style="margin-top:6px">
            <div class="logo-preview" id="alta-logo-vista"><span class="suave">Sin logo</span></div>
            <div style="flex:1;min-width:0">
              <input type="file" id="alta-logo-archivo" accept="image/png,image/jpeg,image/webp">
              <button type="button" class="boton chico contorno" id="alta-logo-quitar" hidden>Quitar logo</button>
            </div>
          </div>

          <hr>
          <span class="etiqueta">6️⃣ MODALIDAD DIGITAL SENIAT Y APIS (OPCIONALES EN EL ALTA)</span>
          <label for="medio_facturacion">🧾 Modalidad de facturación digital (SNAT/2024/000102)</label>
          <select id="medio_facturacion" name="medio_facturacion">
            <option value="APP_SENIAT" selected>📱 Sistema Digital SENIAT Gratuito (No requiere API de Imprenta)</option>
            <option value="IMPRENTA_DIGITAL">🌐 Imprenta Digital Autorizada (Con API del cliente)</option>
          </select>

          <div id="caja-alta-imprenta" hidden style="margin-top:10px;padding:10px;border:1px solid #dadce0;border-radius:10px">
            <strong>🌐 API de Imprenta Digital del Cliente (opcional ahora; editable luego en Ajustes)</strong>
            ${campo("imprenta_proveedor", "Proveedor Autorizado", "", "text", 'placeholder="Ej: The Factory HKA / Unidigital"')}
            ${campo("imprenta_url", "URL de la API (https://…)", "", "url", 'placeholder="https://api.imprenta.com/v1"')}
            <div class="dos-botones">
              <div>${campo("imprenta_usuario", "Usuario o RIF en la Imprenta", "", "text", 'placeholder="Usuario / RIF"')}</div>
              <div>
                <label for="imprenta_ambiente">Ambiente</label>
                <select id="imprenta_ambiente" name="imprenta_ambiente">
                  <option value="PRUEBAS">Pruebas (Sandbox)</option>
                  <option value="PRODUCCION">Producción</option>
                </select>
              </div>
            </div>
            ${campo("imprenta_clave", "🔑 Token / API Key de Imprenta Digital (se cifra con AES-256-GCM)", "", "password", 'autocomplete="off" placeholder="Dejar en blanco si se configurará después"')}
          </div>

          <p class="pista" style="margin-top:10px">✉️ <b>Correo de Plataforma incluido:</b> este cliente enviará facturas, recibos y cierres mensuales automáticamente con el correo central de FacturaYa Venezuela (con <i>Reply-To</i> al correo del negocio).</p>

          <hr>
          <span class="etiqueta">7️⃣ SUSCRIPCIÓN MENSUAL SAAS (CORTE DÍA 1 · PRORRATEO MES 1 · TASA BCV)</span>
          <p class="suave">Si se da de alta después del día 1, el primer mes se calcula automáticamente con prorrateo exacto. La Imprenta Digital la paga cada cliente directamente a su proveedor.</p>
          <div>${campo("fecha_alta", "📅 Fecha de alta", new Date().toISOString().slice(0, 10), "date", "required")}</div>
          <div class="dos-botones">
            <div>${campo("precio_promo_usd", "🏷️ Tarifa promo (USD/mes)", "5", "number", 'min="0" max="999" step="0.01"')}</div>
            <div>${campo("meses_promo", "🗓️ Meses promocionales", "3", "number", 'min="0" max="36" step="1"')}</div>
          </div>
          <div class="dos-botones">
            <div>${campo("precio_regular_usd", "💵 Tarifa regular desde mes 4 (USD/mes)", "10", "number", 'min="1" max="999" step="0.01"')}</div>
            <div style="display:flex;align-items:flex-end">
              <label class="saas-switch" style="margin-bottom:8px">
                <input type="checkbox" id="cobro_auto_dia1" name="cobro_auto_dia1">
                <span>Enviar cobro automático día 1</span>
              </label>
            </div>
          </div>
          <p class="pista">📌 Los correlativos iniciales de Factura y Control se fijan al dar de alta el sistema; luego avanzan de forma automática e inmutable según el SENIAT. Ninguna empresa se suspende automáticamente.</p>
          ${ERROR}<button class="boton verde" type="submit">🚀 CREAR BASE DE DATOS D1 Y DAR DE ALTA CLIENTE</button>
        </form>
      </section>`;

    $("#volver-inq").addEventListener("click", () => (location.hash = "#/inquilinos"));
    $("#tipo_contribuyente")?.addEventListener("change", (e) => {
      const p = $("#alta-regimen-pista");
      if (p) p.textContent = infoRegimen(e.target.value).ayuda;
    });
    $("#medio_facturacion").addEventListener("change", (e) => {
      $("#caja-alta-imprenta").hidden = e.target.value !== "IMPRENTA_DIGITAL";
    });
    $("#alta-logo-archivo").addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        logoAlta = await optimizarLogo(file);
        $("#alta-logo-vista").innerHTML = `<img src="${esc(logoAlta)}" alt="Logo">`;
        $("#alta-logo-quitar").hidden = false;
        aviso("Logo listo para el alta ✅");
      } catch (err) {
        aviso(err.message);
      }
    });
    $("#alta-logo-quitar").addEventListener("click", () => {
      logoAlta = null;
      $("#alta-logo-vista").innerHTML = `<span class="suave">Sin logo</span>`;
      $("#alta-logo-quitar").hidden = true;
      $("#alta-logo-archivo").value = "";
    });

    enviar($("#form-nuevo-inq"), async (d) => {
      d.logo_base64 = logoAlta || "";
      d.modo_inicial = "REAL";
      d.cobro_auto_dia1 = $("#cobro_auto_dia1")?.checked ? 1 : 0;
      d.plan_usd = d.precio_regular_usd || 10;
      const r = await api("inquilinos", "POST", d);
      const c = r.credenciales || r;
      const corr = c.correlativos_iniciales || {};
      const facIni = String(corr.primer_factura || d.primer_factura || 1).padStart(8, "0");
      const ctrlIni = `00-${String(corr.primer_control || d.primer_control || 1).padStart(8, "0")}`;
      const nombreEmp = c.nombre_negocio || c.nombre_razon_social || d.nombre_negocio || "";
      const msgWa = `Hola ${d.nombre_dueno}, tu sistema *FacturaYa Venezuela* para *${nombreEmp}* (${c.rif}) ya está activo en su base dedicada *${c.codigo}*.\n\n🔗 *Acceso:* ${URL_PORTAL_OFICIAL}\n✉️ *Usuario:* ${c.email_dueno}\n🔑 *Contraseña temporal:* ${c.clave_temporal}\n🛡️ *Código maestro de respaldo (1 uso):* ${c.codigo_recuperacion}\n🧾 *Correlativo inicial:* Factura N.º ${facIni} · Control N.º ${ctrlIni}\n\nAl ingresar por primera vez el sistema te solicitará definir tu contraseña personal.`;
      $("#credenciales-nuevo").innerHTML = `<section class="tarjeta secreto">
        <div class="reng-cab"><span class="etiqueta">🎉 CLIENTE DADO DE ALTA EN ${esc(c.codigo)} (${esc(c.d1_nombre || `facturaya_${c.codigo.toLowerCase()}`)})</span><span class="insignia verde">Activa</span></div>
        <p class="suave"><b>${esc(nombreEmp)}</b> · Credenciales iniciales del administrador (<b>${esc(c.email_dueno)}</b>):</p>
        <p class="codigo">${esc(c.clave_temporal)}</p>
        <p class="suave">Código maestro (1 uso): <b>${esc(c.codigo_recuperacion)}</b><br>
        🧾 Correlativo inicial SENIAT: <b>Factura N.º ${esc(facIni)}</b> · <b>Control N.º ${esc(ctrlIni)}</b><br>
        📅 Fecha de alta: <b>${esc(c.fecha_alta || d.fecha_alta || "")}</b></p>
        ${r.binding_nativo_aviso ? `<p class="pista" style="margin-bottom:10px">${esc(r.binding_nativo_aviso)}</p>` : ""}
        <div class="dos-botones">
          <button type="button" class="boton verde" id="copiar-acc">📋 Copiar bienvenida WhatsApp</button>
          <button type="button" class="boton" id="entrar-nuevo">⚙️ Entrar a Ajustes del Cliente</button>
        </div>
      </section>`;
      $("#copiar-acc").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(msgWa); aviso("Mensaje copiado 📋"); } catch { aviso("Copia manualmente los datos en pantalla."); }
      });
      $("#entrar-nuevo").addEventListener("click", async () => {
        await api("inquilinos/cambiar", "POST", { codigo: c.codigo });
        await ruta();
        location.hash = "#/ajustes";
      });
      $("#form-nuevo-inq").reset();
      logoAlta = null;
      $("#alta-logo-vista").innerHTML = `<span class="suave">Sin logo</span>`;
      $("#alta-logo-quitar").hidden = true;
      aviso(`Cliente creado en ${c.codigo} ✅`);
      $("#credenciales-nuevo").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return;
  }

  // 3) Subvista: EMPRESAS AFILIADAS (#/inquilinos/empresas) — Buscador + Filtros + Paginación (100+ BD)
  if (subvista === "empresas") {
    const suspTotal = lista.length - activasN;
    let filtroEst = "TODAS";
    let busquedaEmp = "";
    let paginaEmp = 0;
    const POR_PAG_EMP = 20;

    raiz.innerHTML = `
      ${barraVolverInq("🏢 Empresas Afiliadas")}
      <section class="tarjeta">
        <div class="reng-cab"><span class="etiqueta">👑 GESTIÓN DE INQUILINOS Y COBROS SAAS (${lista.length} EMPRESAS)</span><button type="button" class="boton chico verde" id="ir-alta-btn">➕ Dar de Alta Cliente</button></div>
        <p class="suave">Período actual: <b>${esc(periodoActual)}</b> · Tasa BCV principal: <b>${tasaPrincipal ? `Bs. ${bs(tasaPrincipal)}` : "Sin definir"}</b> · Emisor principal: <b>${medioPrincipal === "IMPRENTA_DIGITAL" ? "Imprenta Digital (API)" : "Sistema Digital SENIAT"}</b>.<br>
        El cobro mensual emite la factura en tu negocio principal y envía el correo con tus datos de Pago Móvil/Binance (<b>Reply-To: pagos@facturayave.com</b>). La suspensión y reactivación son <b>100% manuales con tu contraseña</b>.</p>
        <input type="search" id="emp-buscar" placeholder="🔍 Buscar empresa, RIF, ranura DB_X, administrador o correo…" autocomplete="off">
        <div class="chips tres">
          <button type="button" class="chip activo" data-emp-chip="TODAS">Todas (${lista.length})</button>
          <button type="button" class="chip" data-emp-chip="ACTIVAS">Activas (${activasN})</button>
          <button type="button" class="chip" data-emp-chip="SUSPENDIDAS">Suspendidas (${suspTotal})</button>
        </div>
        <div class="lista" id="lista-inq"></div>
        <div class="paginacion" id="emp-paginacion"></div>
      </section>`;

    $("#volver-inq").addEventListener("click", () => (location.hash = "#/inquilinos"));
    $("#ir-alta-btn").addEventListener("click", () => (location.hash = "#/inquilinos/alta"));

    const pintarEmpresas = () => {
      const q = busquedaEmp.trim().toLowerCase();
      const filtradas = lista.filter((inq) => {
        const susp = inq.activo === 0 || inq.activo === false || inq.estado === "SUSPENDIDO";
        if (filtroEst === "ACTIVAS" && susp) return false;
        if (filtroEst === "SUSPENDIDAS" && !susp) return false;
        if (!q) return true;
        return `${inq.codigo} ${inq.nombre_negocio || ""} ${inq.rif || ""} ${inq.nombre_dueno || ""} ${inq.email_dueno || ""}`.toLowerCase().includes(q);
      });
      const totalPags = Math.max(1, Math.ceil(filtradas.length / POR_PAG_EMP));
      if (paginaEmp >= totalPags) paginaEmp = totalPags - 1;
      const inicio = paginaEmp * POR_PAG_EMP;
      const visibles = filtradas.slice(inicio, inicio + POR_PAG_EMP);

      const cont = $("#lista-inq");
      cont.innerHTML = visibles.map((inq) => {
        const esActual = inq.codigo === activo;
        const esPrincipal = inq.codigo === "principal";
        const susp = inq.activo === 0 || inq.activo === false || inq.estado === "SUSPENDIDO";
        const yaDescargo = !!inq.respaldo_descargado_en;
        const bdTxt = esPrincipal
          ? "facturacion_ve_db (Principal)"
          : inq.d1_uuid
            ? `${inq.d1_nombre || `facturaya_${inq.codigo.toLowerCase()}`} (Cloudflare D1)`
            : `${inq.d1_nombre || `facturaya_${inq.codigo.toLowerCase()}`} (${inq.codigo})`;
        const regInq = infoRegimen(inq.tipo_contribuyente);
        const fechaAlta = String(inq.fecha_alta || inq.creado_en || "").slice(0, 10) || "—";
        const promoUsd = (Number(inq.precio_promo_usd_cent ?? 500) / 100).toFixed(2);
        const regUsd = (Number(inq.precio_regular_usd_cent ?? 1000) / 100).toFixed(2);
        const mesesPromo = Number(inq.meses_promo ?? 3);
        const autoDia1 = Number(inq.cobro_auto_dia1 ?? 0) === 1;
        const cobroMes = inq.cobro_mes_actual || null;
        const proy = inq.proyeccion_mes || null;
        const facNumTxt = cobroMes?.numero_factura ? String(cobroMes.numero_factura).padStart(8, "0") : "";
        const badgeCobro = cobroMes
          ? cobroMes.estado === "PAGADO"
            ? `<span class="insignia verde">✅ Pagado (${esc(periodoActual)})</span>`
            : `<span class="insignia ambar">📨 Facturado #${esc(facNumTxt)} · Pendiente</span>`
          : `<span class="insignia gris">⏳ Sin facturar (${esc(periodoActual)})</span>`;
        const etapaTxt = proy
          ? proy.es_promo
            ? `Promo USD ${promoUsd} (Mes ${proy.indice_mes}/${mesesPromo})${proy.prorrateado ? ` · Prorrateo ${proy.dias_cobrados}/${proy.dias_mes}d` : ""}`
            : `Regular USD ${regUsd} (Mes ${proy.indice_mes})`
          : `Promo USD ${promoUsd} (${mesesPromo}m) → Regular USD ${regUsd}`;

        return `<div class="reng${esActual ? " activo" : ""}">
          <div class="reng-cab">
            <strong>${esPrincipal ? "👑 " : "🏢 "}${esc(inq.nombre_negocio || inq.nombre_razon_social || "Empresa")} <small class="suave">(${esc(inq.rif)})</small></strong>
            <span class="insignia ${susp ? "rojo" : esActual ? "azul" : "verde"}">${susp ? (inq.motivo_suspension === "FALTA_PAGO" ? "SUSPENDIDO · FALTA DE PAGO" : "SUSPENDIDO") : esActual ? "ACTIVO (ACTUAL)" : "ACTIVO"}</span>
          </div>
          <small class="suave">
            ${esPrincipal ? "<b>Tu negocio principal</b> · " : ""}Ranura: <b>${esc(inq.codigo)}</b> · Régimen: <b>${esc(regInq.etiqueta)}</b> · Base D1: <b>${esc(bdTxt)}</b><br>
            Administrador: <b>${esc(inq.nombre_dueno || "—")}</b> ${inq.cedula_dueno ? `(${esc(inq.cedula_dueno)})` : ""} · Correo: <b>${esc(inq.email_dueno || "—")}</b><br>
            Domicilio: ${esc(inq.direccion || "—")}${inq.zona_postal ? ` · Z.P. ${esc(inq.zona_postal)}` : ""}
          </small>

          ${!esPrincipal ? `<div class="saas-caja">
            <div class="saas-cab">
              <span class="etiqueta" style="margin:0">💳 SUSCRIPCIÓN SAAS</span>
              ${badgeCobro}
            </div>
            <div class="saas-meta">
              📅 Fecha de alta: <b>${esc(fechaAlta)}</b> · Tarifa: <b>${esc(etapaTxt)}</b><br>
              ${cobroMes
                ? `🧾 Factura <b>#${esc(facNumTxt)}</b> · Total: <b>${usd(cobroMes.total_usd_cent)}</b> (<b>Bs. ${bs(cobroMes.total_bs_cent / 100)}</b>) · Correo: <b>${cobroMes.correo_enviado ? "Enviado ✅" : "Pendiente"}</b>${cobroMes.estado === "PAGADO" && cobroMes.referencia_pago ? ` · Ref: <b>${esc(cobroMes.referencia_pago)}</b>` : ""}`
                : proy
                  ? `💵 Estimado ${esc(periodoActual)}: <b>${usd(proy.total_usd_cent)}</b> (<b>Bs. ${bs(proy.total_bs_cent / 100)}</b> a tasa BCV)`
                  : `⚠️ Define o sincroniza la tasa BCV en tu empresa principal para calcular en Bolívares.`}
            </div>
            <label class="saas-switch">
              <input type="checkbox" data-auto-dia1="${esc(inq.codigo)}" ${autoDia1 ? "checked" : ""}>
              <span>Cobro automático día 1 del mes <small class="suave">(nunca suspende)</small></span>
            </label>
            <div class="dos-botones" style="margin-top:6px">
              ${!cobroMes
                ? `<button type="button" class="boton chico azul" data-preview-cobro="${esc(inq.codigo)}">📧 Facturar y cobrar mes</button>`
                : `<button type="button" class="boton chico contorno-azul" data-reenviar-cobro="${esc(inq.codigo)}">📨 Reenviar factura</button>`}
              ${cobroMes && cobroMes.estado !== "PAGADO"
                ? `<button type="button" class="boton chico verde" data-abrir-pago="${esc(inq.codigo)}">💰 Registrar pago recibido</button>`
                : ""}
            </div>
            <div id="saas-prev-${esc(inq.codigo)}" hidden></div>
            ${cobroMes && cobroMes.estado !== "PAGADO" ? `<form class="saas-preview" id="form-pago-saas-${esc(inq.codigo)}" data-pago-saas-form="${esc(inq.codigo)}" data-cobro-id="${cobroMes.id}" hidden>
              <span class="etiqueta">💰 REGISTRAR PAGO RECIBIDO (${esc(periodoActual)} · FAC #${esc(facNumTxt)})</span>
              <p class="saas-meta">Emite el recibo oficial en tu empresa principal y marca este mes como <b>PAGADO</b>.</p>
              <div class="dos-botones">
                <div>
                  <label>Método</label>
                  <select name="metodo">
                    <option value="PAGO_MOVIL">Pago Móvil (Bs)</option>
                    <option value="BINANCE">Binance Pay (USDT)</option>
                    <option value="TRANSFERENCIA">Transferencia</option>
                    <option value="ZELLE">Zelle</option>
                    <option value="PAYPAL">PayPal</option>
                  </select>
                </div>
                <div>
                  <label>Moneda</label>
                  <select name="moneda">
                    <option value="BS">Bolívares (Bs)</option>
                    <option value="USD">Dólares / USDT</option>
                  </select>
                </div>
              </div>
              <input type="text" name="referencia" placeholder="N.º de referencia del Pago Móvil o Binance" maxlength="60" autocomplete="off">
              <div class="dos-botones" style="margin-top:6px">
                <button type="submit" class="boton chico verde">✅ Confirmar pago y emitir recibo</button>
                <button type="button" class="boton chico contorno" data-cerrar-pago="${esc(inq.codigo)}">Cancelar</button>
              </div>
            </form>` : ""}
            <details style="margin-top:8px">
              <summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--azul)">⚙️ Editar fecha de alta y tarifas ($${esc(promoUsd)} / $${esc(regUsd)})</summary>
              <form data-suscripcion-form="${esc(inq.codigo)}" style="margin-top:8px">
                <div class="dos-botones">
                  <div><label>Fecha de alta</label><input type="date" name="fecha_alta" value="${esc(fechaAlta)}" required></div>
                  <div><label>Meses promo</label><input type="number" name="meses_promo" min="0" max="36" value="${mesesPromo}" required></div>
                </div>
                <div class="dos-botones">
                  <div><label>Promo USD</label><input type="number" name="precio_promo_usd" min="0" max="999" step="0.01" value="${esc(promoUsd)}" required></div>
                  <div><label>Regular USD</label><input type="number" name="precio_regular_usd" min="1" max="999" step="0.01" value="${esc(regUsd)}" required></div>
                </div>
                <button type="submit" class="boton chico contorno-azul" style="margin-top:6px">💾 Guardar condiciones SaaS</button>
              </form>
            </details>
          </div>` : ""}

          <div class="dos-botones" style="margin-top:8px">
            ${esActual
              ? `<button type="button" class="boton chico verde" data-ir-ajustes="1">⚙️ Ir a Ajustes</button>`
              : `<button type="button" class="boton chico" data-cambiar-inq="${esc(inq.codigo)}">🔄 Entrar / Configurar</button>`}
            ${!esPrincipal
              ? `<button type="button" class="boton chico ${susp ? "verde" : "contorno"}" data-abrir-susp="${esc(inq.codigo)}">${susp ? "▶️ Reactivar empresa" : "⏸️ Suspender por falta de pago"}</button>`
              : ""}
          </div>
          ${!esPrincipal
            ? `<form class="susp-form${susp ? " reactivar" : ""}" id="form-susp-${esc(inq.codigo)}" data-susp-form="${esc(inq.codigo)}" data-objetivo-activo="${susp ? "1" : "0"}" hidden>
                <span class="etiqueta">${susp ? "▶️ REACTIVACIÓN MANUAL DE EMPRESA" : "⏸️ SUSPENSIÓN MANUAL POR FALTA DE PAGO"}</span>
                <p class="saas-meta">${susp
                  ? "Restaura de inmediato el acceso del Administrador y sus usuarios tras confirmar el comprobante en <b>pagos@facturayave.com</b>."
                  : "Cerrará de inmediato la sesión del <b>Administrador y todos los usuarios</b> de esta empresa y bloqueará su ingreso mostrando el aviso de suspensión por falta de pago."}</p>
                <input type="password" name="clave" placeholder="🔒 Tu contraseña de Súper Admin (obligatoria)" required autocomplete="current-password" style="margin-top:6px">
                <div class="dos-botones" style="margin-top:6px">
                  <button type="submit" class="boton chico ${susp ? "verde" : "rojo"}">${susp ? "▶️ Confirmar reactivación" : "⏸️ Confirmar suspensión y cerrar sesiones"}</button>
                  <button type="button" class="boton chico contorno" data-cancelar-susp="${esc(inq.codigo)}">Cancelar</button>
                </div>
              </form>
              <div class="dos-botones">
                <button type="button" class="boton chico contorno-azul" data-respaldo-inq="${esc(inq.codigo)}" data-nombre-inq="${esc(inq.nombre_negocio || inq.codigo)}">📦 Descargar BD Cliente</button>
                <button type="button" class="boton chico contorno" data-abrir-baja="${esc(inq.codigo)}">🗑️ Dar de Baja y Liberar ${esc(inq.codigo)}</button>
              </div>
              <form class="tarjeta" id="form-baja-${esc(inq.codigo)}" data-baja-form="${esc(inq.codigo)}" hidden style="margin-top:8px;border:1px solid #d93025">
                <span class="etiqueta">⚠️ PROCEDIMIENTO OBLIGATORIO DE BAJA (${esc(inq.codigo)})</span>
                <p class="suave"><b>Paso 1 (Obligatorio):</b> Descarga toda la base de datos del cliente a tu equipo (tú decides si enviársela por tu Gmail o por WhatsApp).<br>
                <b>Paso 2:</b> Una vez descargada la data, se desbloquea el botón rojo para borrar la empresa y su base de datos D1 en Cloudflare.</p>
                <p class="pista" id="estado-baja-dl-${esc(inq.codigo)}">${yaDescargo ? `✅ Respaldo descargado (${esc(String(inq.respaldo_descargado_en).slice(0, 16).replace("T", " "))}). Paso 2 habilitado.` : "🔒 Candado activo: Pulsa primero «📦 1. Descargar BD Completa» abajo para desbloquear el borrado."}</p>
                <button type="button" class="boton chico verde" data-respaldo-inq="${esc(inq.codigo)}" data-nombre-inq="${esc(inq.nombre_negocio || inq.codigo)}">📦 1. Descargar BD Completa del Cliente</button>
                <input type="password" name="clave" placeholder="🔒 Tu contraseña de Súper Admin" required autocomplete="current-password" style="margin-top:8px">
                <input type="text" name="confirmar" placeholder="✍️ Escribe ELIMINAR o ${esc(inq.codigo)}" required autocomplete="off">
                <div class="dos-botones">
                  <button type="submit" class="boton chico rojo" id="btn-confirmar-baja-${esc(inq.codigo)}" ${yaDescargo ? "" : "disabled"}>🗑️ 2. BORRAR EMPRESA Y BASE DE DATOS ${esc(inq.codigo)}</button>
                  <button type="button" class="boton chico contorno" data-cancelar-baja="${esc(inq.codigo)}">Cancelar</button>
                </div>
              </form>`
            : ""}
        </div>`;
      }).join("") || `<p class="suave">No hay empresas que coincidan con tu filtro.</p>`;

      const pagEl = $("#emp-paginacion");
      pagEl.innerHTML = filtradas.length > POR_PAG_EMP
        ? `<small>Mostrando ${inicio + 1}–${inicio + visibles.length} de ${filtradas.length} empresas</small>
           <div class="dos-botones" style="margin:0">
             <button type="button" class="boton chico contorno-azul" id="emp-prev" ${paginaEmp === 0 ? "disabled" : ""}>⬅️ Anterior</button>
             <button type="button" class="boton chico contorno-azul" id="emp-next" ${paginaEmp >= totalPags - 1 ? "disabled" : ""}>Siguiente ➡️</button>
           </div>`
        : `<small>${filtradas.length} empresa(s) encontrada(s)</small>`;

      $("#emp-prev")?.addEventListener("click", () => { paginaEmp--; pintarEmpresas(); window.scrollTo(0, 0); });
      $("#emp-next")?.addEventListener("click", () => { paginaEmp++; pintarEmpresas(); window.scrollTo(0, 0); });

      cont.querySelectorAll("[data-ir-ajustes]").forEach((b) => b.addEventListener("click", () => (location.hash = "#/ajustes")));
      cont.querySelectorAll("[data-cambiar-inq]").forEach((b) => b.addEventListener("click", async () => {
        const codigo = b.dataset.cambiarInq;
        await api("inquilinos/cambiar", "POST", { codigo });
        aviso(`Empresa activa: ${codigo} ✅`);
        await ruta();
      }));

      // Switch de cobro automático día 1
      cont.querySelectorAll("[data-auto-dia1]").forEach((chk) => {
        chk.addEventListener("change", async () => {
          const cod = chk.dataset.autoDia1;
          const activoAuto = chk.checked;
          chk.disabled = true;
          try {
            await api(`inquilinos/${encodeURIComponent(cod)}/suscripcion`, "PUT", { cobro_auto_dia1: activoAuto });
            aviso(activoAuto ? `Cobro automático día 1 activado para ${cod} ✅` : `Cobro automático día 1 desactivado para ${cod} ✅`);
          } catch (e) {
            chk.checked = !activoAuto;
            aviso(e.message);
          } finally {
            chk.disabled = false;
          }
        });
      });

      // Editar fecha de alta / tarifas SaaS
      cont.querySelectorAll("[data-suscripcion-form]").forEach((f) => {
        f.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          const cod = f.dataset.suscripcionForm;
          const fd = new FormData(f);
          try {
            await api(`inquilinos/${encodeURIComponent(cod)}/suscripcion`, "PUT", {
              fecha_alta: String(fd.get("fecha_alta") || ""),
              meses_promo: Number(fd.get("meses_promo") || 0),
              precio_promo_usd: Number(fd.get("precio_promo_usd") || 0),
              precio_regular_usd: Number(fd.get("precio_regular_usd") || 10),
            });
            aviso(`Condiciones SaaS actualizadas para ${cod} ✅`);
            await vistaInquilinos("empresas");
          } catch (e) {
            aviso(e.message);
          }
        });
      });

      // Vista previa y emisión real de factura mensual + correo (pagos@facturayave.com)
      cont.querySelectorAll("[data-preview-cobro]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const cod = btn.dataset.previewCobro;
          const caja = document.getElementById(`saas-prev-${cod}`);
          if (!caja) return;
          if (!caja.hidden) { caja.hidden = true; return; }
          btn.disabled = true;
          try {
            const prev = await api(`inquilinos/${encodeURIComponent(cod)}/cobrar`, "POST", { solo_vista_previa: true });
            const cal = prev.calculo;
            const metodosHtml = (prev.metodos || []).length
              ? prev.metodos.map((m) => `<div><b>${esc(m.etiqueta)}:</b> ${esc(m.lineas.join(" · "))}</div>`).join("")
              : `<div class="suave">⚠️ Aún no tienes Pago Móvil ni Binance activos en tu empresa principal (Pagos → Mis datos).</div>`;
            caja.innerHTML = `<div class="saas-preview">
              <div class="etiqueta" style="margin-bottom:6px">📧 VISTA PREVIA DE FACTURA Y COBRO (${esc(cal.periodo_ym)})</div>
              <div class="saas-preview-row"><span>Concepto</span><b>${esc(cal.concepto)}</b></div>
              <div class="saas-preview-row"><span>Tasa BCV</span><b>Bs. ${bs(prev.tasa_bcv)} / USD</b></div>
              <div class="saas-preview-row"><span>Total USD ref.</span><b>${usd(cal.total_usd_cent)}</b></div>
              <div class="saas-preview-row"><span>Total legal Bs</span><b>Bs. ${bs(cal.total_bs_cent / 100)}</b></div>
              <div class="saas-preview-row"><span>Emisión en tu principal</span><b>${prev.emisor_medio === "IMPRENTA_DIGITAL" ? "Imprenta Digital (API)" : "Sistema Digital SENIAT"}</b></div>
              <div class="saas-meta" style="margin-top:8px"><b>Datos de pago que irán en el correo (Reply-To: pagos@facturayave.com):</b><br>${metodosHtml}</div>
              <div class="dos-botones" style="margin-top:10px">
                <button type="button" class="boton chico verde" data-emitir-cobro="${esc(cod)}">✅ Emitir factura y enviar correo</button>
                <button type="button" class="boton chico contorno" data-cerrar-prev="${esc(cod)}">Cancelar</button>
              </div>
            </div>`;
            caja.hidden = false;
            caja.querySelector("[data-cerrar-prev]")?.addEventListener("click", () => { caja.hidden = true; });
            caja.querySelector("[data-emitir-cobro]")?.addEventListener("click", async (evBtn) => {
              const bEmitir = evBtn.currentTarget;
              bEmitir.disabled = true;
              try {
                const res = await api(`inquilinos/${encodeURIComponent(cod)}/cobrar`, "POST", { periodo_ym: cal.periodo_ym });
                const nFac = res.cobro?.numero_factura ? String(res.cobro.numero_factura).padStart(8, "0") : "";
                aviso(res.correo?.enviado
                  ? `Factura #${nFac} emitida y correo enviado a ${cod} ✅`
                  : `Factura #${nFac} emitida en tu principal ✅ (Correo pendiente: ${res.correo?.motivo || "revisa proveedor de correo"})`);
                await vistaInquilinos("empresas");
              } catch (err) {
                aviso(err.message);
                bEmitir.disabled = false;
              }
            });
          } catch (e) {
            aviso(e.message);
          } finally {
            btn.disabled = false;
          }
        });
      });

      // Reenviar correo de cobro ya emitido (sin duplicar factura)
      cont.querySelectorAll("[data-reenviar-cobro]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const cod = btn.dataset.reenviarCobro;
          btn.disabled = true;
          try {
            const res = await api(`inquilinos/${encodeURIComponent(cod)}/cobrar`, "POST", { periodo_ym: periodoActual, reenviar_correo: true });
            aviso(res.correo?.enviado ? `Factura reenviada al correo de ${cod} ✅` : `No se pudo reenviar el correo: ${res.correo?.motivo || "error"}`);
            await vistaInquilinos("empresas");
          } catch (e) {
            aviso(e.message);
          } finally {
            btn.disabled = false;
          }
        });
      });

      // Registrar pago recibido (recibo atómico en principal)
      cont.querySelectorAll("[data-abrir-pago]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const f = document.getElementById(`form-pago-saas-${btn.dataset.abrirPago}`);
          if (f) f.hidden = !f.hidden;
        });
      });
      cont.querySelectorAll("[data-cerrar-pago]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const f = document.getElementById(`form-pago-saas-${btn.dataset.cerrarPago}`);
          if (f) f.hidden = true;
        });
      });
      cont.querySelectorAll("[data-pago-saas-form]").forEach((f) => {
        f.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          const cod = f.dataset.pagoSaasForm;
          const cobroId = f.dataset.cobroId;
          const fd = new FormData(f);
          try {
            const res = await api(`inquilinos/${encodeURIComponent(cod)}/cobros/${encodeURIComponent(cobroId)}/pagar`, "POST", {
              metodo: String(fd.get("metodo") || "PAGO_MOVIL"),
              moneda: String(fd.get("moneda") || "BS"),
              referencia: String(fd.get("referencia") || "").trim(),
            });
            aviso(`Pago registrado ✅ Recibo #${res.recibo_numero || "emitido"} en tu negocio principal.`);
            await vistaInquilinos("empresas");
          } catch (e) {
            aviso(e.message);
          }
        });
      });

      // Suspensión / Reactivación 100% manual con contraseña del Súper Admin
      cont.querySelectorAll("[data-abrir-susp]").forEach((b) => b.addEventListener("click", () => {
        const f = document.getElementById(`form-susp-${b.dataset.abrirSusp}`);
        if (f) f.hidden = !f.hidden;
      }));
      cont.querySelectorAll("[data-cancelar-susp]").forEach((b) => b.addEventListener("click", () => {
        const f = document.getElementById(`form-susp-${b.dataset.cancelarSusp}`);
        if (f) f.hidden = true;
      }));
      cont.querySelectorAll("[data-susp-form]").forEach((f) => {
        f.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          const cod = f.dataset.suspForm;
          const objetivoActivo = f.dataset.objetivoActivo === "1";
          const fd = new FormData(f);
          const clave = String(fd.get("clave") || "");
          try {
            const res = await api(`inquilinos/${encodeURIComponent(cod)}/estado`, "PUT", {
              activo: objetivoActivo,
              clave,
              motivo: objetivoActivo ? "" : "FALTA_PAGO",
            });
            aviso(objetivoActivo
              ? `Empresa ${cod} reactivada ✅`
              : `Empresa ${cod} suspendida por falta de pago (${res.sesiones_cerradas || 0} sesión(es) cerrada(s)) ✅`);
            await vistaInquilinos("empresas");
          } catch (e) {
            aviso(e.message);
          }
        });
      });

      cont.querySelectorAll("[data-respaldo-inq]").forEach((b) => b.addEventListener("click", async () => {
        const codigo = b.dataset.respaldoInq;
        b.disabled = true;
        try {
          const r = await fetch(`/api/inquilinos/${encodeURIComponent(codigo)}/respaldo`);
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "No se pudo descargar la base de datos del cliente.");
          const a = document.createElement("a");
          a.href = URL.createObjectURL(await r.blob());
          a.download = `entrega-cliente-${codigo.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          const btnBaja = document.getElementById(`btn-confirmar-baja-${codigo}`);
          if (btnBaja) btnBaja.disabled = false;
          const txtEstado = document.getElementById(`estado-baja-dl-${codigo}`);
          if (txtEstado) txtEstado.textContent = "✅ Respaldo descargado en tu equipo. Ya puedes enviárselo por Gmail/WhatsApp y confirmar el Paso 2.";
          aviso(`Base de datos de ${codigo} descargada ✅ Paso 2 de baja desbloqueado.`);
        } catch (e) {
          aviso(e.message);
        } finally {
          b.disabled = false;
        }
      }));
      cont.querySelectorAll("[data-abrir-baja]").forEach((b) => b.addEventListener("click", () => {
        const f = document.getElementById(`form-baja-${b.dataset.abrirBaja}`);
        if (f) f.hidden = !f.hidden;
      }));
      cont.querySelectorAll("[data-cancelar-baja]").forEach((b) => b.addEventListener("click", () => {
        const f = document.getElementById(`form-baja-${b.dataset.cancelarBaja}`);
        if (f) f.hidden = true;
      }));
      cont.querySelectorAll("[data-baja-form]").forEach((f) => {
        f.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          const cod = f.dataset.bajaForm;
          const fd = new FormData(f);
          const clave = String(fd.get("clave") || "");
          const confirmar = String(fd.get("confirmar") || "").trim();
          try {
            await api(`inquilinos/${encodeURIComponent(cod)}/eliminar`, "POST", { clave, confirmar, eliminar_d1_cloudflare: true });
            aviso(`Cliente ${cod} eliminado y base D1 liberada ✅`);
            await vistaInquilinos("empresas");
          } catch (e) {
            aviso(e.message);
          }
        });
      });
    };

    $("#emp-buscar").addEventListener("input", (e) => { busquedaEmp = e.target.value; paginaEmp = 0; pintarEmpresas(); });
    raiz.querySelectorAll("[data-emp-chip]").forEach((ch) => ch.addEventListener("click", () => {
      filtroEst = ch.dataset.empChip;
      paginaEmp = 0;
      raiz.querySelectorAll("[data-emp-chip]").forEach((x) => x.classList.toggle("activo", x === ch));
      pintarEmpresas();
    }));
    pintarEmpresas();
    return;
  }

  // 4) Subvista: CONTROL CLOUDFLARE D1 (#/inquilinos/cloudflare) — sin botón repetido de Crear D1
  if (subvista === "cloudflare") {
    raiz.innerHTML = `
      ${barraVolverInq("☁️ Control Cloudflare D1")}
      <section class="tarjeta" id="cf-control-card">
        <div class="reng-cab">
          <h2>☁️ Centro de Control Cloudflare (Exclusivo Súper Admin)</h2>
          <span class="insignia gris" id="cf-badge">Consultando…</span>
        </div>
        <p class="suave">Monitorea tus bases D1 en Cloudflare (<b>10 BD en Plan Gratis</b> o <b>50.000 BD en el Plan Workers Paid de $5/mes</b>), tu Worker y Turnstile sin cambiar código. <b>Bindings Nativos automáticos:</b> si das de alta un cliente de noche (9:00 PM–5:59 AM VET), se conecta al Worker al instante; si lo haces de día (6:00 AM–8:59 PM VET), opera aislado por HTTP D1 sin tocar el Worker y el mantenimiento nocturno de las 2:00 AM VET lo promueve a Binding Nativo.</p>
        <div id="cf-resumen"><p class="suave">Verificando conexión con Cloudflare API…</p></div>
        <div class="dos-botones" style="margin-top:10px">
          <button type="button" class="boton chico contorno-azul" id="cf-refrescar">🔄 Sincronizar Cloudflare</button>
          <button type="button" class="boton chico verde" id="cf-sync-bindings">⚡ Sincronizar Bindings Nativos ahora</button>
        </div>
        <div class="dos-botones" style="margin-top:6px">
          <button type="button" class="boton chico azul" id="cf-ir-builds">🚀 Ver Builds, Mantenimiento y Rollback</button>
          <button type="button" class="boton chico contorno-azul" id="cf-generar-toml">📄 Ver / Descargar wrangler.toml (respaldo)</button>
        </div>
        <div style="margin-top:6px">
          <button type="button" class="boton chico contorno" id="cf-ir-alta">➕ Dar de Alta Cliente (Crea su D1)</button>
        </div>
        <div id="cf-toml-box" class="tarjeta" hidden style="margin-top:10px;border:1px solid #1A73E8"></div>
        <details style="margin-top:12px">
          <summary style="cursor:pointer;font-weight:600;color:#1A73E8">🔑 Configurar API Token y Plan de Cloudflare (Cifrado AES-256-GCM · Solo Súper Admin)</summary>
          <form id="cf-config-form" style="margin-top:10px">
            <p class="suave"><b>¿Qué hace esta API?</b> Conecta tu panel Súper Admin con tu cuenta de Cloudflare para administrar bases D1 y monitorear compilaciones, logs y rollbacks de tu Worker. Nadie más tiene acceso a esta sección.</p>
            <label for="plan_d1">🚀 Plan de tu cuenta Cloudflare (Escala sin cambiar código)</label>
            <select id="plan_d1" name="plan_d1">
              <option value="GRATIS" ${!esPlan5Usd ? "selected" : ""}>Plan Gratis Cloudflare (Hasta 10 Bases D1: Principal + DB_1 a DB_9)</option>
              <option value="PRO_5USD" ${esPlan5Usd ? "selected" : ""}>Plan Workers Paid $5/mes (Hasta 50.000 Bases D1: DB_1, DB_2, DB_10, DB_11…)</option>
            </select>
            ${campo("api_token", "🔑 API Token de Usuario Cloudflare (D1 Edit, Workers Builds Edit, Workers Scripts Edit, Turnstile Read)", "", "password", 'autocomplete="off" placeholder="Pega aquí tu Token de Cloudflare"')}
            <small class="suave" id="cf-token-pista"></small>
            ${campo("account_id", "🆔 Account ID de Cloudflare (opcional: se detecta solo con tu Token)", "", "text", 'autocomplete="off" placeholder="Se detecta automáticamente si lo dejas en blanco"')}
            ${campo("worker_name", "⚙️ Nombre de tu Worker", "facturaya", "text", 'placeholder="facturaya"')}
            ${campo("clave", "🔒 Tu contraseña de Súper Admin", "", "password", 'required autocomplete="current-password"')}
            <label class="opcion"><input type="checkbox" id="cf-confirmo" required> ☑️ Estoy seguro de guardar o actualizar el API Token y Plan maestro de Cloudflare.</label>
            ${ERROR}<button class="boton" type="submit" id="cf-guardar-btn" disabled>💾 CONECTAR Y GUARDAR API DE CLOUDFLARE</button>
          </form>
        </details>
      </section>`;

    $("#volver-inq").addEventListener("click", () => (location.hash = "#/inquilinos"));
    $("#cf-ir-alta").addEventListener("click", () => (location.hash = "#/inquilinos/alta"));
    $("#cf-ir-builds")?.addEventListener("click", () => (location.hash = "#/inquilinos/builds"));
    $("#cf-confirmo")?.addEventListener("change", () => {
      $("#cf-guardar-btn").disabled = !$("#cf-confirmo").checked;
    });

    function pintarCloudflare(cf) {
      const badge = $("#cf-badge"), resEl = $("#cf-resumen"), pista = $("#cf-token-pista");
      if (!badge || !resEl) return;
      if ($("#account_id") && cf.account_id && !$("#account_id").value) $("#account_id").value = cf.account_id;
      if ($("#worker_name") && cf.worker_name) $("#worker_name").value = cf.worker_name;
      if ($("#plan_d1") && cf.plan_d1) $("#plan_d1").value = cf.plan_d1;
      if (pista) {
        pista.textContent = cf.token_final
          ? `Token cifrado guardado (termina en …${cf.token_final}). Déjalo en blanco si solo quieres cambiar de Plan Gratis a Plan $5/mes o actualizar el Account ID.`
          : "Aún no has conectado tu API Token de Cloudflare.";
      }
      if (!cf.configurado) {
        badge.textContent = "⚪ SIN CONECTAR";
        badge.className = "insignia gris";
        resEl.innerHTML = `<p class="suave">Abre abajo <b>🔑 Configurar API Token y Plan de Cloudflare</b> y pega tu token para controlar tus bases D1 (10 en Plan Gratis o 50.000 en Plan $5/mes), Turnstile y Worker desde aquí.</p>`;
        return;
      }
      if (!cf.ok || cf.error_api) {
        badge.textContent = "🔴 ERROR API";
        badge.className = "insignia rojo";
        resEl.innerHTML = `<p class="error">${esc(cf.error_api || "No se pudo conectar con Cloudflare API.")}</p>`;
        return;
      }
      const c = cf.cuota_d1 || { usadas: 0, limite_gratis: 10, libres_gratis: 10, limite_plan: 10, libres_plan: 10 };
      const limPlan = Number(c.limite_plan || c.limite_gratis || 10);
      const libPlan = Number(c.libres_plan ?? c.libres_gratis ?? 10);
      badge.textContent = `🟢 ${c.usadas}/${limPlan.toLocaleString("es-VE")} D1 USADAS · ${libPlan.toLocaleString("es-VE")} LIBRES`;
      badge.className = `insignia ${libPlan > 0 ? "verde" : "ambar"}`;

      const tsInfo = (cf.turnstile_widgets || []).map((w) => `${w.name} (${(w.domains || []).join(", ")})`).join(" · ") || "Activo por variables de entorno";
      const bindingsInfo = (cf.worker_bindings || []).map((b) => `${b.name} (${b.type})`).join(", ") || "DB → facturacion_ve_db";
      const todasBases = cf.bases_d1 || [];
      let filtroCf = "TODAS";
      let busqCf = "";
      let pagCf = 0;
      const POR_PAG_CF = 20;

      resEl.innerHTML = `
        <div class="reng">
          <small class="suave">
            <b>🆔 Account ID:</b> <code>${esc(cf.account_id)}</code> · <b>⚙️ Worker:</b> <b>${esc(cf.worker_name)}</b><br>
            <b>🔗 Bindings en Worker:</b> ${esc(bindingsInfo)}<br>
            <b>🛡️ Turnstile Anti-Bots:</b> ${esc(tsInfo)}
          </small>
        </div>
        ${todasBases.length > 6 ? `<div style="margin-top:10px">
          <input type="search" id="cf-buscar" placeholder="🔍 Buscar base D1, UUID o empresa asignada…" autocomplete="off">
          <div class="chips">
            <button type="button" class="chip activo" data-cf-chip="TODAS">Todas (${todasBases.length})</button>
            <button type="button" class="chip" data-cf-chip="ASIGNADAS">Asignadas</button>
            <button type="button" class="chip" data-cf-chip="HUERFANAS">Huérfanas</button>
          </div>
        </div>` : ""}
        <div class="lista" id="cf-bases-lista" style="margin-top:8px"></div>
        <div class="paginacion" id="cf-bases-pag"></div>`;

      const pintarBasesD1 = () => {
        const q = busqCf.trim().toLowerCase();
        const filt = todasBases.filter((db) => {
          const esAsig = !!(db.es_principal || db.asignada_a);
          if (filtroCf === "ASIGNADAS" && !esAsig) return false;
          if (filtroCf === "HUERFANAS" && esAsig) return false;
          if (!q) return true;
          return `${db.name} ${db.uuid} ${db.asignada_a || ""}`.toLowerCase().includes(q);
        });
        const totalPags = Math.max(1, Math.ceil(filt.length / POR_PAG_CF));
        if (pagCf >= totalPags) pagCf = totalPags - 1;
        const inicio = pagCf * POR_PAG_CF;
        const vis = filt.slice(inicio, inicio + POR_PAG_CF);

        const listaBox = $("#cf-bases-lista");
        listaBox.innerHTML = vis.map((db) => {
          const kb = db.file_size ? `${(db.file_size / 1024).toFixed(1)} KB` : "0 KB";
          const esPrin = !!db.es_principal;
          const asignacion = esPrin
            ? "👑 Principal (Tu negocio)"
            : db.asignada_a
              ? `🏢 ${db.asignada_a}`
              : "🟢 Huérfana / Sin cliente asignado";
          return `<div class="reng">
            <div class="reng-cab">
              <strong>🗄️ ${esc(db.name)} <small class="suave">(${esc(kb)})</small></strong>
              <span class="insignia ${esPrin ? "azul" : db.asignada_a ? "verde" : "gris"}">${esc(asignacion)}</span>
            </div>
            <small class="suave">UUID: <code>${esc(db.uuid)}</code></small>
            ${!esPrin && !db.asignada_a
              ? `<button type="button" class="boton chico contorno" data-cf-abrir-del="${esc(db.uuid)}">🗑️ Borrar esta D1 suelta en Cloudflare</button>
                 <form class="tarjeta" id="cf-del-${esc(db.uuid)}" data-cf-del-form="${esc(db.uuid)}" data-cf-del-nom="${esc(db.name)}" hidden style="margin-top:6px;border:1px solid #d93025">
                   <small class="suave">Confirma tu contraseña de Súper Admin para borrar <b>${esc(db.name)}</b> de Cloudflare:</small>
                   <input type="password" name="clave" placeholder="🔒 Contraseña de Súper Admin" required autocomplete="current-password">
                   <div class="dos-botones">
                     <button type="submit" class="boton chico rojo">🗑️ Confirmar borrado D1</button>
                     <button type="button" class="boton chico contorno" data-cf-cancel-del="${esc(db.uuid)}">Cancelar</button>
                   </div>
                 </form>`
              : ""}
          </div>`;
        }).join("") || `<p class="suave">No se encontraron bases D1 con ese filtro.</p>`;

        const pagBox = $("#cf-bases-pag");
        pagBox.innerHTML = filt.length > POR_PAG_CF
          ? `<small>Mostrando ${inicio + 1}–${inicio + vis.length} de ${filt.length} bases D1</small>
             <div class="dos-botones" style="margin:0">
               <button type="button" class="boton chico contorno-azul" id="cf-prev" ${pagCf === 0 ? "disabled" : ""}>⬅️ Anterior</button>
               <button type="button" class="boton chico contorno-azul" id="cf-next" ${pagCf >= totalPags - 1 ? "disabled" : ""}>Siguiente ➡️</button>
             </div>`
          : "";

        $("#cf-prev")?.addEventListener("click", () => { pagCf--; pintarBasesD1(); });
        $("#cf-next")?.addEventListener("click", () => { pagCf++; pintarBasesD1(); });
        listaBox.querySelectorAll("[data-cf-abrir-del]").forEach((btn) => btn.addEventListener("click", () => {
          const f = document.getElementById(`cf-del-${btn.dataset.cfAbrirDel}`);
          if (f) f.hidden = !f.hidden;
        }));
        listaBox.querySelectorAll("[data-cf-cancel-del]").forEach((btn) => btn.addEventListener("click", () => {
          const f = document.getElementById(`cf-del-${btn.dataset.cfCancelDel}`);
          if (f) f.hidden = true;
        }));
        listaBox.querySelectorAll("[data-cf-del-form]").forEach((f) => f.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          const uuid = f.dataset.cfDelForm;
          const nom = f.dataset.cfDelNom;
          const clave = String(new FormData(f).get("clave") || "");
          try {
            const r = await api("inquilinos/cloudflare/eliminar-bd", "POST", { uuid, clave });
            aviso(`Base D1 ${nom} eliminada de Cloudflare ✅`);
            if (r.estado) pintarCloudflare(r.estado);
          } catch (e) {
            aviso(e.message);
          }
        }));
      };

      $("#cf-buscar")?.addEventListener("input", (e) => { busqCf = e.target.value; pagCf = 0; pintarBasesD1(); });
      resEl.querySelectorAll("[data-cf-chip]").forEach((ch) => ch.addEventListener("click", () => {
        filtroCf = ch.dataset.cfChip;
        pagCf = 0;
        resEl.querySelectorAll("[data-cf-chip]").forEach((x) => x.classList.toggle("activo", x === ch));
        pintarBasesD1();
      }));
      pintarBasesD1();
    }

    const cargarCloudflare = async (manual = false) => {
      const btn = $("#cf-refrescar");
      if (manual && btn) { btn.disabled = true; btn.textContent = "⏳ Sincronizando…"; }
      try {
        const cf = await api("inquilinos/cloudflare/estado");
        pintarCloudflare(cf);
        if (manual) aviso(cf.configurado && cf.ok ? "Estado de Cloudflare sincronizado ✅" : "Configura tu API Token abajo para conectar con Cloudflare.");
      } catch (e) {
        if (manual) aviso(e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "🔄 Sincronizar Cloudflare"; }
      }
    };
    cargarCloudflare(false);
    $("#cf-refrescar")?.addEventListener("click", () => cargarCloudflare(true));
    $("#cf-sync-bindings")?.addEventListener("click", async () => {
      const btn = $("#cf-sync-bindings");
      if (btn) { btn.disabled = true; btn.textContent = "⏳ Sincronizando bindings…"; }
      try {
        const res = await api("inquilinos/cloudflare/sincronizar-bindings", "POST", {});
        aviso(res.resultado?.mensaje || res.mensaje || "Bindings nativos sincronizados ✅");
        if (res.estado) pintarCloudflare(res.estado);
        else await cargarCloudflare(false);
      } catch (e) {
        aviso(e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "⚡ Sincronizar Bindings Nativos ahora"; }
      }
    });
    $("#cf-generar-toml")?.addEventListener("click", async () => {
      const box = $("#cf-toml-box");
      if (!box) return;
      box.hidden = false;
      box.innerHTML = `<p class="suave">Generando configuración de Bindings Nativos D1…</p>`;
      try {
        const res = await api("inquilinos/cloudflare/wrangler-toml");
        box.innerHTML = `
          <div class="reng-cab">
            <strong>⚡ wrangler.toml con Bindings Nativos D1 (${res.bindings_con_uuid} base(s) D1 activa(s))</strong>
            <button type="button" class="boton chico contorno" id="cf-toml-cerrar">✕ Cerrar</button>
          </div>
          <p class="suave" style="margin:6px 0">En el Plan Pro con muchas empresas simultáneas, pegar estos bloques <code>[[d1_databases]]</code> en tu archivo <code>wrangler.toml</code> de GitHub conecta cada base D1 por canal nativo interno de Cloudflare (~1 ms) sin consumir el límite de 1.200 req/5min de la API REST.</p>
          <textarea id="cf-toml-txt" rows="10" readonly style="font-family:monospace;font-size:12px;width:100%;margin-bottom:8px">${esc(res.toml)}</textarea>
          <div class="dos-botones">
            <button type="button" class="boton chico azul" id="cf-toml-copiar">📋 Copiar wrangler.toml</button>
            <button type="button" class="boton chico verde" id="cf-toml-descargar">⬇️ Descargar wrangler.toml</button>
          </div>`;
        $("#cf-toml-cerrar")?.addEventListener("click", () => { box.hidden = true; });
        $("#cf-toml-copiar")?.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(res.toml);
            aviso("wrangler.toml copiado al portapapeles ✅");
          } catch {
            $("#cf-toml-txt")?.select();
            aviso("Selecciona y copia el texto ✅");
          }
        });
        $("#cf-toml-descargar")?.addEventListener("click", () => {
          const blob = new Blob([res.toml], { type: "text/plain;charset=utf-8" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "wrangler.toml";
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          aviso("Archivo wrangler.toml descargado ✅");
        });
      } catch (e) {
        box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      }
    });
    if ($("#cf-config-form")) {
      enviar($("#cf-config-form"), async (d) => {
        const r = await api("inquilinos/cloudflare/config", "POST", d);
        $("#api_token").value = "";
        $("#cf-config-form input[name='clave']").value = "";
        pintarCloudflare(r);
        aviso(r.configurado && r.ok ? "API de Cloudflare conectada y cifrada ✅" : "Datos guardados; verifica el Token o Account ID.");
      });
    }
    return;
  }

  // 4b) Subvista: DESPLIEGUES Y BUILDS CLOUDFLARE (#/inquilinos/builds) + MODO MANTENIMIENTO DESPLIEGUE
  if (subvista === "builds") {
    raiz.innerHTML = `
      ${barraVolverInq("🚀 Despliegues y Builds")}
      <section class="tarjeta" id="mant-despliegue-card">
        <div class="reng-cab">
          <h2>🛠️ Modo Mantenimiento para Despliegues</h2>
          <span class="insignia gris" id="mant-badge">Consultando…</span>
        </div>
        <p class="suave">Activa este interruptor <b>antes de subir un push a GitHub</b> cuando haya cambios de código o leyes SENIAT. Cierra la sesión de todos los usuarios de todas las empresas (<b>excepto la tuya de Súper Admin</b>), los envía a la portada con aviso de actualización y bloquea operaciones hasta que verifiques el despliegue OK y reabras las sesiones.</p>
        <div class="mant-pasos" id="mant-pasos-box">
          <div class="mant-paso" data-paso="1"><span>1️⃣ 🔒</span><strong>Sesiones cerradas</strong></div>
          <div class="mant-paso" data-paso="2"><span>2️⃣ 🚀</span><strong>Despliegue realizándose</strong></div>
          <div class="mant-paso" data-paso="3"><span>3️⃣ ✅</span><strong>Despliegue verificado OK</strong></div>
          <div class="mant-paso" data-paso="4"><span>4️⃣ 🟢</span><strong>Sesiones listas para usar</strong></div>
        </div>
        <div id="mant-despliegue-zona"><p class="suave">Cargando estado de mantenimiento…</p></div>
        <div id="mant-logs-despliegue" style="margin-top:12px"></div>
      </section>

      <section class="tarjeta" id="builds-card">
        <div class="reng-cab">
          <h2>🚀 Control de Compilaciones y Despliegues (Cloudflare)</h2>
          <span class="insignia gris" id="builds-badge">Consultando…</span>
        </div>
        <p class="suave">Revisa en vivo si las compilaciones desde GitHub terminaron en <b>Listo</b> o presentaron algún error, inspecciona el log exacto y relanza un build o restaura una versión estable anterior (<i>Rollback</i>).</p>
        <p class="pista" style="margin-bottom:8px">💡 <b>Buenas prácticas GitHub → Cloudflare:</b> sube tus cambios siempre a la rama <code>main</code> (sin tildes ni espacios en nombres de ramas) y mantén desactivada la opción <i>«Builds for non-production branches»</i> en Cloudflare Workers para evitar builds fallidos en 0s de ramas secundarias.</p>
        <div class="dos-botones" style="margin-top:8px">
          <button type="button" class="boton chico contorno-azul" id="builds-refrescar">🔄 Actualizar estado</button>
          <button type="button" class="boton chico verde" id="builds-abrir-reintentar">▶️ Relanzar compilación</button>
        </div>
        <form id="builds-reintentar-form" class="tarjeta" hidden style="margin-top:10px;border:1px solid #1A73E8">
          <h3 style="margin-top:0">▶️ Relanzar compilación en Cloudflare</h3>
          <p class="suave">Ejecuta manualmente el trigger conectado a GitHub para volver a compilar y publicar tu rama principal.</p>
          <div id="builds-trigger-box"></div>
          <label class="opcion"><input type="checkbox" name="purgar_cache"> 🧹 Limpiar caché de compilación antes de construir</label>
          ${campo("clave", "🔒 Tu contraseña de Súper Admin", "", "password", 'required autocomplete="current-password"')}
          ${ERROR}
          <div class="dos-botones">
            <button type="submit" class="boton chico">▶️ Confirmar y compilar</button>
            <button type="button" class="boton chico contorno" id="builds-cancel-reintentar">Cancelar</button>
          </div>
        </form>
        <div id="builds-resumen" style="margin-top:12px"><p class="suave">Consultando Workers Builds y Deployments en Cloudflare…</p></div>
      </section>
      <section class="tarjeta" id="builds-logs-card" hidden>
        <div class="reng-cab">
          <h2 id="builds-log-titulo">🧾 Log de compilación</h2>
          <button type="button" class="boton chico contorno" id="builds-log-cerrar">Cerrar</button>
        </div>
        <div id="builds-log-diag"></div>
        <pre id="builds-log-pre" style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:10px;overflow:auto;max-height:360px;font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word"></pre>
      </section>`;

    $("#volver-inq").addEventListener("click", () => (location.hash = "#/inquilinos"));
    const formReintentar = $("#builds-reintentar-form");
    let triggersActuales = [];
    $("#builds-abrir-reintentar")?.addEventListener("click", () => {
      if (formReintentar) formReintentar.hidden = !formReintentar.hidden;
    });
    $("#builds-cancel-reintentar")?.addEventListener("click", () => {
      if (formReintentar) formReintentar.hidden = true;
    });
    $("#builds-log-cerrar")?.addEventListener("click", () => {
      const cLog = $("#builds-logs-card");
      if (cLog) cLog.hidden = true;
    });

    const fmtFechaIso = (s) => {
      if (!s) return "—";
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return String(s);
      return d.toLocaleString("es-VE", { timeZone: "America/Caracas", dateStyle: "short", timeStyle: "short" });
    };

    const pintarEstadoMantenimiento = (mant, logsDesp = []) => {
      const badge = $("#mant-badge"), zona = $("#mant-despliegue-zona"), pasosBox = $("#mant-pasos-box"), logsBox = $("#mant-logs-despliegue");
      if (!badge || !zona) return;
      const activo = Boolean(mant?.activo);
      const etapa = mant?.etapa || "NORMAL";
      estado.mantenimiento_despliegue = mant || { activo: false, etapa: "NORMAL" };

      const pasoActivo = !activo
        ? 4
        : etapa === "VERIFICADO_OK"
          ? 3
          : etapa === "DESPLEGANDO"
            ? 2
            : 1;
      pasosBox?.querySelectorAll("[data-paso]").forEach((el) => {
        const n = Number(el.dataset.paso || 0);
        el.classList.remove("hecho", "actual");
        if (!activo) {
          if (n === 4) el.classList.add("hecho");
        } else if (n < pasoActivo) {
          el.classList.add("hecho");
        } else if (n === pasoActivo) {
          el.classList.add("actual");
        }
      });

      if (activo) {
        badge.textContent = etapa === "VERIFICADO_OK"
          ? "✅ DESPLIEGUE OK · LISTO PARA REABRIR"
          : etapa === "DESPLEGANDO"
            ? "🚀 DESPLIEGUE EN CURSO"
            : "🔒 SESIONES CERRADAS";
        badge.className = `insignia ${etapa === "VERIFICADO_OK" ? "verde" : "rojo"}`;
        zona.innerHTML = `
          <div class="aviso-anulado" style="margin-bottom:10px">
            <b>🔒 Modo Mantenimiento ACTIVO desde ${esc(fmtFechaIso(mant.activado_en))}</b><br>
            Sesiones cerradas: <b>${Number(mant.sesiones_cerradas_total || 0)}</b> en <b>${Number(mant.empresas_cerradas || 0)}</b> empresa(s). Solo tu cuenta Súper Admin puede operar.<br>
            <small>Aviso visible a usuarios: «${esc(mant.mensaje || "")}»</small>
          </div>
          <div class="dos-botones" style="margin-bottom:10px">
            <button type="button" class="boton chico contorno-azul" id="mant-marcar-desp">🚀 Marcar: Despliegue realizándose</button>
            <button type="button" class="boton chico contorno-azul" id="mant-marcar-ok">✅ Marcar: Despliegue OK</button>
          </div>
          <form id="mant-desactivar-form" class="tarjeta" style="border:1.5px solid #10b981;margin-bottom:0">
            <h3 style="margin-top:0">🔓 Finalizar mantenimiento y reabrir sesiones</h3>
            <p class="suave">Una vez que el último build en Cloudflare figure como <b>✅ Listo</b>, reabre el sistema para todos los clientes.</p>
            <label class="opcion"><input type="checkbox" name="sincronizar_bindings" checked> ⚡ Sincronizar Bindings Nativos D1 en Cloudflare automáticamente al reabrir</label>
            ${campo("mant_clave_off", "🔒 Tu contraseña de Súper Admin", "", "password", 'required autocomplete="current-password"')}
            ${ERROR}
            <button type="submit" class="boton verde">🟢 FINALIZAR MANTENIMIENTO Y REABRIR SESIONES</button>
          </form>`;
        $("#mant-marcar-desp")?.addEventListener("click", async () => {
          try {
            const r = await api("inquilinos/mantenimiento/despliegue/etapa", "POST", { etapa: "DESPLEGANDO" });
            aviso("Etapa actualizada: Despliegue realizándose 🚀");
            pintarEstadoMantenimiento(r.estado || r.mantenimiento, logsDesp);
          } catch (e) { aviso(e.message); }
        });
        $("#mant-marcar-ok")?.addEventListener("click", async () => {
          try {
            const r = await api("inquilinos/mantenimiento/despliegue/etapa", "POST", { etapa: "VERIFICADO_OK" });
            aviso("Etapa actualizada: Despliegue verificado OK ✅");
            pintarEstadoMantenimiento(r.estado || r.mantenimiento, logsDesp);
          } catch (e) { aviso(e.message); }
        });
        enviar($("#mant-desactivar-form"), async (d) => {
          const r = await api("inquilinos/mantenimiento/despliegue/desactivar", "POST", {
            clave: d.mant_clave_off,
            sincronizar_bindings: Boolean($("#mant-desactivar-form [name='sincronizar_bindings']")?.checked),
          });
          aviso("Sesiones listas para usar ✅ Sistema reabierto para todos los clientes.");
          pintarEstadoMantenimiento(r.estado || r.mantenimiento, r.logs_despliegue || logsDesp);
          await cargarBuilds(false);
        });
      } else {
        badge.textContent = "🟢 SESIONES LISTAS PARA USAR";
        badge.className = "insignia verde";
        zona.innerHTML = `
          <button type="button" class="boton rojo" id="mant-abrir-activar">🔒 Activar Modo Mantenimiento (Cerrar sesiones y preparar despliegue)</button>
          <form id="mant-activar-form" class="tarjeta" hidden style="margin-top:10px;border:1.5px solid #dc2626">
            <h3 style="margin-top:0">🔒 Confirmar cierre temporal de sesiones</h3>
            <p class="suave">Esta acción cerrará inmediatamente las sesiones de todos los usuarios de todas las empresas (excepto tú) y los redirigirá a la portada mientras subes y verificas la actualización.</p>
            ${campo("mant_mensaje", "📢 Aviso visible a los usuarios en la portada", "Estamos actualizando FacturaYa Venezuela para mejorar el servicio. Por seguridad, las sesiones fueron cerradas temporalmente; podrás ingresar en unos minutos.", "text", 'maxlength="240"')}
            ${campo("mant_clave_on", "🔒 Tu contraseña de Súper Admin", "", "password", 'required autocomplete="current-password"')}
            <label class="opcion"><input type="checkbox" id="mant-confirmo" required> ☑️ Confirmo cerrar todas las sesiones de clientes para realizar un despliegue seguro.</label>
            ${ERROR}
            <div class="dos-botones">
              <button type="submit" class="boton rojo">🔒 Cerrar sesiones ahora</button>
              <button type="button" class="boton contorno" id="mant-cancel-activar">Cancelar</button>
            </div>
          </form>`;
        $("#mant-abrir-activar")?.addEventListener("click", () => {
          const f = $("#mant-activar-form");
          if (f) f.hidden = !f.hidden;
        });
        $("#mant-cancel-activar")?.addEventListener("click", () => {
          const f = $("#mant-activar-form");
          if (f) f.hidden = true;
        });
        enviar($("#mant-activar-form"), async (d) => {
          const r = await api("inquilinos/mantenimiento/despliegue/activar", "POST", {
            clave: d.mant_clave_on,
            mensaje: d.mant_mensaje,
          });
          aviso(`Modo mantenimiento activado: ${r.sesiones_cerradas} sesión(es) cerrada(s) 🔒`);
          pintarEstadoMantenimiento(r.estado || r.mantenimiento, r.logs_despliegue || logsDesp);
          await cargarBuilds(false);
        });
      }

      if (logsBox) {
        logsBox.innerHTML = logsDesp.length
          ? `<details>
              <summary style="cursor:pointer;font-weight:600;color:#1A73E8">📜 Historial de ventanas de despliegue (${logsDesp.length})</summary>
              <div class="lista" style="margin-top:8px">
                ${logsDesp.map((l) => `<div class="reng">
                  <div class="reng-cab">
                    <strong>${l.tipo === "DESPLIEGUE_INICIO" ? "🔒 Cierre de sesiones" : l.tipo === "DESPLIEGUE_FIN" ? "🟢 Sesiones reabiertas" : "⚡ Bindings Nativos"}</strong>
                    <span class="insignia ${l.estado === "OK" ? "verde" : l.estado === "ADVERTENCIA" ? "ambar" : "rojo"}">${esc(l.estado)}</span>
                  </div>
                  <small class="suave">${esc(l.resumen)}<br>${esc(fmtFechaIso(l.iniciado_en || l.finalizado_en))} · ${Number(l.duracion_ms || 0)} ms</small>
                </div>`).join("")}
              </div>
            </details>`
          : "";
      }
    };

    const abrirLog = async (buildUuid, etiqueta) => {
      const card = $("#builds-logs-card"), pre = $("#builds-log-pre"), diagBox = $("#builds-log-diag"), tit = $("#builds-log-titulo");
      if (!card || !pre) return;
      card.hidden = false;
      if (tit) tit.textContent = `🧾 Log · ${etiqueta || buildUuid.slice(0, 8)}`;
      if (diagBox) diagBox.innerHTML = "";
      pre.textContent = "Descargando log desde Cloudflare…";
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      try {
        const res = await api(`inquilinos/cloudflare/builds/${encodeURIComponent(buildUuid)}/logs`);
        if (res.diagnostico && diagBox) {
          diagBox.innerHTML = `<div class="aviso-anulado" style="margin-bottom:10px">
            <b>⚠️ Diagnóstico detectado (${esc(res.diagnostico.codigo)}):</b> ${esc(res.diagnostico.resumen)}<br>
            <small><b>Cómo resolverlo:</b> ${esc(res.diagnostico.sugerencia)}</small>
          </div>`;
        }
        pre.textContent = res.texto || "(El log de esta compilación está vacío o ya expiró tras 90 días.)";
      } catch (e) {
        pre.textContent = `Error consultando log: ${e.message}`;
      }
    };

    const pintarBuilds = (dataCf) => {
      if (dataCf.mantenimiento !== undefined) {
        pintarEstadoMantenimiento(dataCf.mantenimiento, dataCf.logs_despliegue || []);
      }
      const badge = $("#builds-badge"), box = $("#builds-resumen"), trigBox = $("#builds-trigger-box"), btnRetry = $("#builds-abrir-reintentar");
      if (!badge || !box) return;
      if (btnRetry) btnRetry.hidden = !dataCf.configurado;
      if (!dataCf.configurado) {
        if (formReintentar) formReintentar.hidden = true;
        badge.textContent = "⚪ SIN CONECTAR";
        badge.className = "insignia gris";
        box.innerHTML = `<p class="suave">${esc(dataCf.aviso_api || "Conecta tu API Token de Cloudflare para monitorear compilaciones.")}</p>
          <button type="button" class="boton chico" id="builds-ir-cf">☁️ Conectar API Token de Cloudflare</button>`;
        $("#builds-ir-cf")?.addEventListener("click", () => (location.hash = "#/inquilinos/cloudflare"));
        return;
      }
      if (!dataCf.ok && dataCf.error_api) {
        badge.textContent = "🔴 ERROR PERMISOS";
        badge.className = "insignia rojo";
        box.innerHTML = `<p class="error">${esc(dataCf.error_api)}</p>
          <button type="button" class="boton chico contorno-azul" id="builds-ir-cf">☁️ Revisar Token en Cloudflare D1</button>`;
        $("#builds-ir-cf")?.addEventListener("click", () => (location.hash = "#/inquilinos/cloudflare"));
        return;
      }

      const estMap = {
        SANO: { texto: "🟢 PRODUCCIÓN SANA", cls: "verde" },
        ERROR_BUILD: { texto: "🔴 ÚLTIMO BUILD FALLÓ", cls: "rojo" },
        COMPILANDO: { texto: "🟡 COMPILANDO AHORA", cls: "ambar" },
        SIN_BUILDS: { texto: "🔵 SIN BUILDS RECIENTES", cls: "azul" },
      };
      const est = estMap[dataCf.estado_general] || estMap.SIN_BUILDS;
      badge.textContent = est.texto;
      badge.className = `insignia ${est.cls}`;

      const trigs = dataCf.triggers || [];
      triggersActuales = trigs;
      if (trigBox) {
        trigBox.innerHTML = trigs.length
          ? `<label for="builds-trig-sel">Rama / Trigger conectado</label>
             <select id="builds-trig-sel" name="trigger_uuid">
               ${trigs.map((t) => `<option value="${esc(t.trigger_uuid)}" data-branch="${esc(t.branch || "main")}">${esc(t.trigger_name)} (rama: ${esc(t.branch || "main")})</option>`).join("")}
             </select>`
          : `<p class="suave">No se detectó un trigger de compilación automático en este Worker.</p>`;
      }

      const advHtml = (dataCf.advertencias || []).length
        ? `<div class="aviso-anulado" style="margin-bottom:10px">${dataCf.advertencias.map((w) => esc(w)).join("<br>")}</div>`
        : "";

      const buildsHtml = (dataCf.builds || []).length
        ? dataCf.builds.map((b) => {
            const rawEst = `${b.status} ${b.build_outcome}`.toLowerCase();
            const esOk = /success|succeed/.test(rawEst) && !/fail|error/.test(rawEst);
            const esErr = /fail|error|cancel/.test(rawEst);
            const insCls = esOk ? "verde" : esErr ? "rojo" : "ambar";
            const insTxt = esOk ? "✅ Listo" : esErr ? "❌ Erróneo" : "⏳ En curso";
            const durTxt = b.duracion_seg != null ? ` · ${b.duracion_seg}s` : "";
            return `<div class="reng">
              <div class="reng-cab">
                <strong>${esc(b.commit_message || "Compilación manual / Git")}</strong>
                <span class="insignia ${insCls}">${insTxt}${esc(durTxt)}</span>
              </div>
              <small class="suave">
                Rama: <b>${esc(b.branch || "main")}</b>${b.commit_hash ? ` · Commit: <code>${esc(b.commit_hash)}</code>` : ""}
                · Fecha: ${esc(fmtFechaIso(b.created_on))}${b.author ? ` · Por: ${esc(b.author)}` : ""}
              </small>
              <div style="margin-top:6px">
                <button type="button" class="boton chico contorno-azul" data-ver-log="${esc(b.build_uuid)}" data-log-etq="${esc(b.commit_hash || b.branch)}">🔍 Ver log${esErr ? " del error" : ""}</button>
              </div>
            </div>`;
          }).join("")
        : `<p class="suave">No hay compilaciones recientes registradas para <b>${esc(dataCf.worker_name)}</b>.</p>`;

      const depsHtml = (dataCf.deployments || []).length
        ? dataCf.deployments.map((d) => {
            const shortVer = (d.version_id || d.id || "").slice(0, 8);
            return `<div class="reng">
              <div class="reng-cab">
                <strong>${d.activa ? "🟢 Activa" : "🕘 Anterior"} · <code>${esc(shortVer)}</code> ${d.mensaje ? `· ${esc(d.mensaje)}` : ""}</strong>
                <span class="insignia ${d.activa ? "verde" : "gris"}">${d.activa ? `100% tráfico` : "Historial"}</span>
              </div>
              <small class="suave">Fecha: ${esc(fmtFechaIso(d.created_on))} · Origen: ${esc(d.source || "api")}${d.author_email ? ` · ${esc(d.author_email)}` : ""}</small>
              ${!d.activa && d.version_id
                ? `<div style="margin-top:6px">
                     <button type="button" class="boton chico contorno" data-abrir-rb="${esc(d.version_id)}">⏪ Restaurar esta versión (Rollback)</button>
                   </div>
                   <form class="tarjeta" id="rb-form-${esc(d.version_id)}" data-rb-form="${esc(d.version_id)}" hidden style="margin-top:8px;border:1px solid #d93025">
                     <small class="suave" style="display:block;margin-bottom:8px">Devolverá el <b>100% del tráfico</b> de producción a la versión <code>${esc(shortVer)}</code>.</small>
                     <input type="text" name="motivo" value="Rollback desde FacturaYa Control" placeholder="Motivo del rollback" aria-label="Motivo del rollback" maxlength="120" style="margin-bottom:8px">
                     <input type="password" name="clave" placeholder="🔒 Contraseña de Súper Admin" aria-label="Contraseña de Súper Admin" required autocomplete="current-password">
                     <div class="dos-botones">
                       <button type="submit" class="boton chico rojo">⏪ Confirmar</button>
                       <button type="button" class="boton chico contorno" data-cancel-rb="${esc(d.version_id)}">Cancelar</button>
                     </div>
                   </form>`
                : ""}
            </div>`;
          }).join("")
        : `<p class="suave">Sin historial de despliegues disponible.</p>`;

      box.innerHTML = `${advHtml}
        <h3>🔨 Compilaciones recientes (Workers Builds)</h3>
        <div class="lista" style="margin-bottom:14px">${buildsHtml}</div>
        <h3>📦 Versiones desplegadas y Rollback rápido</h3>
        <div class="lista">${depsHtml}</div>`;

      box.querySelectorAll("[data-ver-log]").forEach((btn) =>
        btn.addEventListener("click", () => abrirLog(btn.dataset.verLog, btn.dataset.logEtq))
      );
      box.querySelectorAll("[data-abrir-rb]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const f = document.getElementById(`rb-form-${btn.dataset.abrirRb}`);
          if (f) f.hidden = !f.hidden;
        })
      );
      box.querySelectorAll("[data-cancel-rb]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const f = document.getElementById(`rb-form-${btn.dataset.cancelRb}`);
          if (f) f.hidden = true;
        })
      );
      box.querySelectorAll("[data-rb-form]").forEach((f) =>
        f.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          const fd = new FormData(f);
          const version_id = f.dataset.rbForm;
          const motivo = String(fd.get("motivo") || "");
          const clave = String(fd.get("clave") || "");
          try {
            const r = await api("inquilinos/cloudflare/rollback", "POST", { version_id, motivo, clave });
            aviso("Rollback aplicado en Cloudflare ✅");
            if (r.estado) pintarBuilds(r.estado);
          } catch (e) {
            aviso(e.message);
          }
        })
      );
    };

    const cargarBuilds = async (manual = false) => {
      const btn = $("#builds-refrescar");
      if (manual && btn) { btn.disabled = true; btn.textContent = "⏳ Actualizando…"; }
      try {
        const res = await api("inquilinos/cloudflare/builds");
        pintarBuilds(res);
        if (manual) aviso(res.configurado ? "Estado de compilaciones actualizado ✅" : "Estado de mantenimiento actualizado ✅");
      } catch (e) {
        if (manual) aviso(e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "🔄 Actualizar estado"; }
      }
    };
    cargarBuilds(false);
    $("#builds-refrescar")?.addEventListener("click", () => cargarBuilds(true));
    if (formReintentar) {
      enviar(formReintentar, async (d) => {
        const trigObj = triggersActuales.find((t) => t.trigger_uuid === d.trigger_uuid) || triggersActuales[0];
        const r = await api("inquilinos/cloudflare/builds/reintentar", "POST", {
          trigger_uuid: d.trigger_uuid || "",
          branch: trigObj?.branch || "main",
          purgar_cache: Boolean(formReintentar.querySelector('[name="purgar_cache"]')?.checked),
          clave: d.clave,
        });
        formReintentar.hidden = true;
        const cl = formReintentar.querySelector('[name="clave"]');
        if (cl) cl.value = "";
        aviso("Compilación relanzada en Cloudflare ✅");
        if (r.estado) pintarBuilds(r.estado);
      });
    }
    return;
  }

  // 4c) Subvista: MANTENIMIENTO NOCTURNO AUTOMÁTICO (#/inquilinos/mantenimiento)
  if (subvista === "mantenimiento") {
    raiz.innerHTML = `
      ${barraVolverInq("🌙 Mantenimiento Nocturno")}
      <section class="tarjeta" id="mant-nocturno-card">
        <div class="reng-cab">
          <h2>🌙 Mantenimiento Automático Nocturno (2:00 AM VET)</h2>
          <span class="insignia gris" id="mn-horario-badge">Consultando…</span>
        </div>
        <p class="suave">Protección operativa garantizada: entre <b>6:00 AM y 9:00 PM (hora Venezuela)</b> el sistema mantiene <b>silencio total</b> (cero respaldos R2, cero escaneos PRAGMA ni cierres pesados) para no afectar a ningún cajero. Cada madrugada a las <b>2:00 AM VET</b> audita todas las BD, aplica saneamiento seguro, sincroniza Bindings Nativos D1, respalda en R2 y registra su resumen aquí.</p>
        <div id="mn-resumen"><p class="suave">Cargando estado y bitácora…</p></div>
        <div class="dos-botones" style="margin-top:10px">
          <button type="button" class="boton chico verde" id="mn-ejecutar-ahora">▶️ Ejecutar mantenimiento ahora</button>
          <button type="button" class="boton chico contorno-azul" id="mn-refrescar">🔄 Actualizar bitácora</button>
        </div>
        <div style="margin-top:12px">
          <label for="mn-correo-modo">✉️ Reporte por correo al Súper Admin</label>
          <select id="mn-correo-modo">
            <option value="SOLO_ALERTAS">Solo si hay alertas o errores (Recomendado)</option>
            <option value="SIEMPRE">Enviar resumen diario todas las madrugadas</option>
            <option value="DESACTIVADO">No enviar correos (solo guardar logs en panel)</option>
          </select>
        </div>
      </section>
      <section class="tarjeta">
        <h2>📜 Historial de Ejecuciones y Logs</h2>
        <div id="mn-logs" class="lista"><p class="suave">Cargando registros…</p></div>
      </section>`;

    $("#volver-inq").addEventListener("click", () => (location.hash = "#/inquilinos"));

    const pintarMantenimientoNocturno = (res) => {
      const badge = $("#mn-horario-badge"), resBox = $("#mn-resumen"), logsBox = $("#mn-logs"), selCorreo = $("#mn-correo-modo");
      if (badge) {
        const esDiurno = Boolean(res.horario_diurno_vet);
        const horaTxt = typeof res.hora_caracas === "number" ? `${String(res.hora_caracas).padStart(2, "0")}:00` : String(res.hora_caracas || "");
        badge.textContent = esDiurno
          ? `☀️ ${horaTxt} VET · Silencio diurno activo`
          : `🌙 ${horaTxt} VET · Ventana nocturna`;
        badge.className = `insignia ${esDiurno ? "verde" : "azul"}`;
      }
      const modoCorreo = res.mantenimiento?.correo_resumen_modo || res.correo_resumen_modo;
      if (selCorreo && modoCorreo) selCorreo.value = modoCorreo;

      const logs = res.logs || [];
      const ultimoNocturno = logs.find((l) => l.tipo === "NOCTURNO_AUTO" || l.tipo === "NOCTURNO_MANUAL");
      if (resBox) {
        resBox.innerHTML = ultimoNocturno
          ? `<div class="reng">
              <div class="reng-cab">
                <strong>Último mantenimiento (${ultimoNocturno.tipo === "NOCTURNO_AUTO" ? "Automático 2:00 AM" : "Manual"})</strong>
                <span class="insignia ${ultimoNocturno.estado === "OK" ? "verde" : ultimoNocturno.estado === "ADVERTENCIA" ? "ambar" : "rojo"}">${esc(ultimoNocturno.estado)}</span>
              </div>
              <small class="suave">${esc(ultimoNocturno.resumen)}<br>Fecha: ${esc(fechaLocal(ultimoNocturno.iniciado_en || ultimoNocturno.finalizado_en))} · Duración: ${Number(ultimoNocturno.duracion_ms || 0)} ms</small>
            </div>`
          : `<p class="suave">Aún no se ha registrado ninguna corrida nocturna. Se ejecutará automáticamente a las 2:00 AM VET o puedes probarla ahora con el botón inferior.</p>`;
      }

      if (logsBox) {
        logsBox.innerHTML = logs.length
          ? logs.map((l) => {
              const etqTipo = {
                NOCTURNO_AUTO: "🌙 Mantenimiento 2:00 AM",
                NOCTURNO_MANUAL: "🛠️ Mantenimiento Manual",
                DESPLIEGUE_INICIO: "🔒 Despliegue: Sesiones cerradas",
                DESPLIEGUE_FIN: "🟢 Despliegue: Sesiones reabiertas",
                BINDINGS_SYNC: "⚡ Sync Bindings Nativos",
              }[l.tipo] || l.tipo;
              const detItems = [];
              if (Number(l.empresas_revisadas || 0) > 0) detItems.push(`BD auditadas: ${l.empresas_sanas}/${l.empresas_revisadas} sanas`);
              if (Number(l.bindings_sanados || 0) > 0) detItems.push(`Bindings nativos enlazados: ${l.bindings_sanados}`);
              if (Number(l.respaldos_ok || 0) > 0) detItems.push(`Respaldos R2: ${l.respaldos_ok} OK`);
              if (Number(l.sesiones_purgadas || 0) > 0) detItems.push(`Sesiones purgadas: ${l.sesiones_purgadas}`);
              if (Number(l.alertas_count || 0) > 0) detItems.push(`Alertas: ${l.alertas_count}`);
              return `<div class="reng">
                <div class="reng-cab">
                  <strong>${esc(etqTipo)}</strong>
                  <span class="insignia ${l.estado === "OK" ? "verde" : l.estado === "ADVERTENCIA" ? "ambar" : "rojo"}">${esc(l.estado)}</span>
                </div>
                <small class="suave">${esc(l.resumen)}</small>
                ${detItems.length ? `<small class="suave" style="display:block;margin-top:4px">${esc(detItems.join(" · "))}</small>` : ""}
                <small class="suave" style="display:block;margin-top:4px">${esc(fechaLocal(l.iniciado_en || l.finalizado_en))} · ${Number(l.duracion_ms || 0)} ms</small>
              </div>`;
            }).join("")
          : `<p class="suave">Sin registros todavía.</p>`;
      }
    };

    const cargarMantenimiento = async (manual = false) => {
      try {
        const res = await api("inquilinos/mantenimiento/estado");
        pintarMantenimientoNocturno(res);
        if (manual) aviso("Bitácora de mantenimiento actualizada ✅");
      } catch (e) {
        if (manual) aviso(e.message);
      }
    };
    cargarMantenimiento(false);
    $("#mn-refrescar")?.addEventListener("click", () => cargarMantenimiento(true));
    $("#mn-correo-modo")?.addEventListener("change", async (e) => {
      try {
        await api("inquilinos/mantenimiento/correo-modo", "POST", { modo: e.target.value });
        aviso("Preferencia de reporte por correo guardada ✅");
      } catch (err) {
        aviso(err.message);
      }
    });
    $("#mn-ejecutar-ahora")?.addEventListener("click", async () => {
      const btn = $("#mn-ejecutar-ahora");
      if (btn) { btn.disabled = true; btn.textContent = "⏳ Ejecutando auditoría y respaldos…"; }
      try {
        const r = await api("inquilinos/mantenimiento/nocturno/ejecutar", "POST", {});
        aviso(`Mantenimiento finalizado (${r.resultado?.estado || "OK"}) ✅`);
        await cargarMantenimiento(false);
      } catch (err) {
        aviso(err.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "▶️ Ejecutar mantenimiento ahora"; }
      }
    });
    return;
  }

  // 5) Subvista: SALUD BD Y RESPALDOS (#/inquilinos/salud) — Por lotes de 8 BD + Buscador + Paginación (100+ BD)
  if (subvista === "salud") {
    let desdeSalud = 0;
    const LOTE_SALUD = 8;
    let busqBackup = "";
    let pagBackup = 0;
    const POR_PAG_BK = 20;

    raiz.innerHTML = `
      ${barraVolverInq("🩺 Salud BD y Respaldos")}
      <section class="tarjeta" id="salud-bd-card">
        <div class="reng-cab"><h2>🩺 Salud y Protección BD (SENIAT)</h2><span class="insignia gris" id="salud-badge">Analizando…</span></div>
        <p class="suave">Verifica migraciones, los 16 candados SQLite de inmutabilidad fiscal, correlativos y cuadre en centavos sin borrar datos. Audita por lotes de hasta ${LOTE_SALUD} BD para no saturar Cloudflare Workers aunque tengas 100+ clientes.</p>
        <div id="salud-lista"><p class="suave">Ejecutando auditoría…</p></div>
        <div class="dos-botones">
          <button type="button" class="boton chico contorno-azul" id="salud-refrescar">🔄 Re-verificar lote</button>
          ${lista.length > 25
            ? `<select id="lote-maestro" aria-label="Lote de Respaldo Maestro" style="flex:1;min-width:160px">
                ${Array.from({ length: Math.ceil(lista.length / 25) }, (_, idx) => {
                  const ini = idx * 25;
                  const fin = Math.min(ini + 25, lista.length);
                  return `<option value="${ini}">Lote ${idx + 1}: Empresas ${ini + 1}–${fin}</option>`;
                }).join("")}
              </select>
              <button type="button" class="boton chico verde" id="respaldo-maestro">📦 Descargar Lote</button>`
            : `<button type="button" class="boton chico verde" id="respaldo-maestro">📦 Respaldo Maestro (Todas)</button>`}
        </div>
      </section>
      <section class="tarjeta" id="r2-respaldos-card">
        <div class="reng-cab"><h2>☁️ Respaldo Automático Diario (Cloudflare R2)</h2><span class="insignia gris" id="r2-badge">Consultando…</span></div>
        <p class="suave">Guarda automáticamente 1 respaldo maestro firmado cada día (hora de Caracas) en un bucket R2 de Cloudflare, con retención automática de <b>30 días</b> (gratis hasta 10 GB/mes).</p>
        <div id="r2-contenido"><p class="suave">Cargando estado de R2…</p></div>
      </section>
      <section class="tarjeta">
        <h2>💾 Descargar Respaldo Individual por Empresa (${lista.length})</h2>
        <p class="suave">Busca cualquier negocio y descarga su copia JSON completa o filtrada por año fiscal (ideal para empresas con 5 años de historial):</p>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <input type="search" id="bk-buscar" placeholder="🔍 Buscar empresa, RIF o ranura DB_X…" autocomplete="off" style="flex:1;margin:0">
          <select id="bk-anio" aria-label="Año fiscal del respaldo" style="width:auto;min-width:165px;margin:0">
            <option value="">📅 Todos los años (Completo)</option>
            ${[0, 1, 2, 3, 4].map((offset) => {
              const y = new Date().getFullYear() - offset;
              return `<option value="${y}">📅 Solo año ${y}</option>`;
            }).join("")}
          </select>
        </div>
        <div class="lista" id="bk-lista"></div>
        <div class="paginacion" id="bk-paginacion"></div>
      </section>`;

    $("#volver-inq").addEventListener("click", () => (location.hash = "#/inquilinos"));

    const pintarRespaldosInd = () => {
      const q = busqBackup.trim().toLowerCase();
      const filt = q
        ? lista.filter((inq) => `${inq.codigo} ${inq.nombre_negocio || ""} ${inq.rif || ""}`.toLowerCase().includes(q))
        : lista;
      const totalPags = Math.max(1, Math.ceil(filt.length / POR_PAG_BK));
      if (pagBackup >= totalPags) pagBackup = totalPags - 1;
      const inicio = pagBackup * POR_PAG_BK;
      const vis = filt.slice(inicio, inicio + POR_PAG_BK);

      const box = $("#bk-lista");
      box.innerHTML = vis.map((inq) => `<div class="reng">
        <div class="reng-cab">
          <strong>${esc(inq.nombre_negocio || inq.codigo)} <small class="suave">(${esc(inq.codigo)} · ${esc(inq.rif)})</small></strong>
          <button type="button" class="boton chico contorno-azul" data-dl-salud-inq="${esc(inq.codigo)}">⬇️ Descargar BD</button>
        </div>
        ${inq.respaldo_descargado_en ? `<small class="suave">Último respaldo descargado: ${esc(String(inq.respaldo_descargado_en).slice(0, 16).replace("T", " "))}</small>` : ""}
      </div>`).join("") || `<p class="suave">Sin coincidencias.</p>`;

      const pagEl = $("#bk-paginacion");
      pagEl.innerHTML = filt.length > POR_PAG_BK
        ? `<small>Mostrando ${inicio + 1}–${inicio + vis.length} de ${filt.length} empresas</small>
           <div class="dos-botones" style="margin:0">
             <button type="button" class="boton chico contorno-azul" id="bk-prev" ${pagBackup === 0 ? "disabled" : ""}>⬅️ Anterior</button>
             <button type="button" class="boton chico contorno-azul" id="bk-next" ${pagBackup >= totalPags - 1 ? "disabled" : ""}>Siguiente ➡️</button>
           </div>`
        : "";
      $("#bk-prev")?.addEventListener("click", () => { pagBackup--; pintarRespaldosInd(); });
      $("#bk-next")?.addEventListener("click", () => { pagBackup++; pintarRespaldosInd(); });

      box.querySelectorAll("[data-dl-salud-inq]").forEach((b) => b.addEventListener("click", async () => {
        const codigo = b.dataset.dlSaludInq;
        const anioSel = $("#bk-anio")?.value || "";
        const qAnio = anioSel ? `?anio=${encodeURIComponent(anioSel)}` : "";
        b.disabled = true;
        try {
          const url = codigo === "principal" ? `/api/sistema/respaldo${qAnio}` : `/api/inquilinos/${encodeURIComponent(codigo)}/respaldo${qAnio}`;
          const r = await fetch(url);
          if (!r.ok) throw new Error("No se pudo descargar el respaldo.");
          const a = document.createElement("a");
          a.href = URL.createObjectURL(await r.blob());
          a.download = `respaldo-${codigo.toLowerCase()}${anioSel ? `-${anioSel}` : ""}-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          aviso(`Respaldo de ${codigo}${anioSel ? ` (${anioSel})` : ""} descargado ✅`);
        } catch (e) {
          aviso(e.message);
        } finally {
          b.disabled = false;
        }
      }));
    };
    $("#bk-buscar")?.addEventListener("input", (e) => { busqBackup = e.target.value; pagBackup = 0; pintarRespaldosInd(); });
    pintarRespaldosInd();

    function pintarSalud(rep) {
      const badge = $("#salud-badge"), listaEl = $("#salud-lista");
      if (!badge || !listaEl) return;
      const hora = new Date().toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const totalEmp = Number(rep.total_empresas ?? (rep.reportes || []).length);
      const loteEmp = (rep.reportes || []).length;
      const ini = Number(rep.desde ?? 0);
      badge.textContent = rep.sano_global ? "🟢 LOTE SANO" : "🔴 ATENCIÓN REQUERIDA";
      badge.className = `insignia ${rep.sano_global ? "verde" : "rojo"}`;
      const items = (rep.reportes || []).map((r) => {
        const probs = (r.problemas || []).map((p) => `<li><b>${esc(p.codigo)}:</b> ${esc(p.mensaje)}</li>`).join("");
        return `<div class="reng">
          <div class="reng-cab">
            <strong>${esc(r.nombre_negocio)} <small class="suave">(${esc(r.codigo)})</small></strong>
            <span class="insignia ${r.sano ? "verde" : "rojo"}">${r.sano ? "SANA ✅" : `${r.problemas.length} alerta(s)`}</span>
          </div>
          <small class="suave">
            Modo: <b>${esc(r.modo)}</b> · Migraciones: <b>${r.migraciones_ok ? "OK" : "Faltan"}</b> · Candados SENIAT: <b>${r.triggers_ok ? "16/16" : "Incompletos"}</b> · Correlativos: <b>${r.correlativos_ok ? "OK" : "Desfase"}</b><br>
            Docs REAL: <b>${r.conteo?.documentos_real ?? 0}</b> · Pagos REAL: <b>${r.conteo?.pagos_real ?? 0}</b> · Clientes: <b>${r.conteo?.clientes ?? 0}</b>
          </small>
          ${probs ? `<ul class="lista-errores">${probs}</ul>` : ""}
          ${r.reparables > 0 ? `<button type="button" class="boton chico verde" data-reparar-inq="${esc(r.codigo)}">🛠️ Reparar estructura y contadores (sin borrar datos)</button>` : ""}
        </div>`;
      }).join("");
      const navLotes = totalEmp > LOTE_SALUD
        ? `<div class="paginacion">
             <small>Lote ${ini + 1}–${ini + loteEmp} de ${totalEmp} empresas</small>
             <div class="dos-botones" style="margin:0">
               <button type="button" class="boton chico contorno-azul" id="salud-prev" ${ini === 0 ? "disabled" : ""}>⬅️ Lote anterior</button>
               <button type="button" class="boton chico contorno-azul" id="salud-next" ${!rep.hay_mas ? "disabled" : ""}>Siguiente lote ➡️</button>
             </div>
           </div>`
        : "";
      const pie = `<p class="pista">🕒 Verificado a las <b>${esc(hora)}</b> · ${loteEmp} de ${totalEmp} empresa(s) auditada(s).</p>`;
      listaEl.innerHTML = `<div class="lista">${items || `<p class="suave">Sin empresas registradas.</p>`}</div>${navLotes}${pie}`;
      $("#salud-prev")?.addEventListener("click", () => { desdeSalud = Math.max(0, ini - LOTE_SALUD); cargarSalud(true); });
      $("#salud-next")?.addEventListener("click", () => { desdeSalud = ini + LOTE_SALUD; cargarSalud(true); });
      listaEl.querySelectorAll("[data-reparar-inq]").forEach((btn) => btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const res = await api("inquilinos/reparar", "POST", { codigo: btn.dataset.repararInq });
          aviso("Reparación completada sin pérdida de datos ✅");
          if (res.reporte) pintarSalud(res.reporte);
        } catch (e) {
          aviso(e.message);
          btn.disabled = false;
        }
      }));
      return { totalEmp, loteEmp, sano: !!rep.sano_global };
    }

    const cargarSalud = async (manual = false) => {
      const btn = $("#salud-refrescar"), b = $("#salud-badge");
      if (manual && btn) { btn.disabled = true; btn.textContent = "⏳ Verificando…"; }
      if (b) { b.textContent = "Verificando…"; b.className = "insignia gris"; }
      try {
        const rep = await api(`inquilinos/salud?desde=${desdeSalud}&limite=${LOTE_SALUD}`);
        const info = pintarSalud(rep);
        if (manual && info) {
          aviso(info.sano ? `Lote verificado: ${info.loteEmp}/${info.loteEmp} BD sanas ✅` : "Diagnóstico completado: hay alertas por revisar ⚠️");
        }
      } catch (e) {
        if (b) { b.textContent = "Error"; b.className = "insignia rojo"; }
        const l = $("#salud-lista");
        if (l) l.innerHTML = `<p class="error">${esc(e.message)}</p>`;
        if (manual) aviso(e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "🔄 Re-verificar lote"; }
      }
    };
    cargarSalud(false);
    $("#salud-refrescar")?.addEventListener("click", () => cargarSalud(true));
    $("#respaldo-maestro")?.addEventListener("click", async () => {
      try {
        const loteSel = $("#lote-maestro");
        const desdeLote = loteSel ? Number(loteSel.value || 0) : 0;
        const finLote = Math.min(desdeLote + 25, lista.length);
        const url = lista.length > 25
          ? `/api/inquilinos/respaldo-maestro?desde=${desdeLote}&limite=25`
          : "/api/inquilinos/respaldo-maestro";
        const r = await fetch(url);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "No se pudo descargar el respaldo maestro.");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(await r.blob());
        const sufijo = lista.length > 25 ? `-lote-${desdeLote + 1}-a-${finLote}` : "";
        a.download = `respaldo-maestro-facturaya-${new Date().toISOString().slice(0, 10)}${sufijo}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        aviso(lista.length > 25 ? `Respaldo Maestro (lote ${desdeLote + 1}–${finLote}) descargado ✅` : "Respaldo Maestro descargado ✅");
      } catch (e) {
        aviso(e.message);
      }
    });

    const fmtTam = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
    const pintarR2 = (info) => {
      const badge = $("#r2-badge"), cont = $("#r2-contenido");
      if (!badge || !cont) return;
      if (!info.configurado) {
        badge.textContent = "⚪ Sin vincular";
        badge.className = "insignia gris";
        cont.innerHTML = `<div class="aviso-control">
          <b>Cómo activarlo en Cloudflare (2 minutos, gratis hasta 10 GB):</b><br>
          1. En Cloudflare abre <b>R2 Object Storage</b> → crea el bucket <code>facturaya-respaldos</code>.<br>
          2. En <b>Workers y Pages → facturaya → Configuración → Vinculaciones</b>, añade una vinculación R2 con variable <code>RESPALDOS_R2</code> apuntando a <code>facturaya-respaldos</code>.<br>
          3. A partir de ese momento el Cron diario guardará tus respaldos automáticamente aquí.
        </div>`;
        return;
      }
      badge.textContent = "🟢 R2 ACTIVO";
      badge.className = "insignia verde";
      const ult = info.ultimo_respaldo;
      const errR2 = info.ultimo_error;
      const alertaErr = errR2
        ? `<div class="aviso-anulado">⚠️ <b>Último error en respaldo R2 (${esc(errR2.tipo || "cron")} · ${esc(errR2.fecha || "")}):</b> ${esc(errR2.mensaje || "")}</div>`
        : "";
      const tipoTxt = (t) => (t === "mensual" ? "🏛️ Mensual (10 años)" : t === "manual" ? "☁️ Manual" : "📅 Diario (30 días)");
      const resumenUlt = ult
        ? `<p class="pista">Último respaldo R2: <b>${esc(ult.fecha || "")}</b> (${tipoTxt(ult.tipo)} · ${ult.total_empresas ?? 1} empresa(s) · 1 archivo/empresa · ${fmtTam(Number(ult.bytes_totales || 0))}${ult.firmado ? " · 🔐 HMAC" : ""})</p>`
        : `<p class="pista">Aún no se ha subido el primer respaldo al bucket R2 privado. Los respaldos diarios se conservan 30 días y los <b>archivos mensuales fiscales</b> se preservan por 10 años sin podarse.</p>`;
      const filasObj = (info.objetos || []).slice(0, 20).map((o) => `<div class="reng">
        <div class="reng-cab">
          <strong>${tipoTxt(o.tipo)} · ${esc(o.fecha || "")}${o.inquilino ? ` · ${esc(o.inquilino)}` : ""}</strong>
          <button type="button" class="boton chico contorno-azul" data-dl-r2="${esc(o.key)}">⬇️ Descargar</button>
        </div>
        <small class="suave">${esc(o.nombre)} · ${fmtTam(o.size)}${o.firmado ? " · 🔐 Firmado" : ""}</small>
      </div>`).join("");
      cont.innerHTML = `${alertaErr}${resumenUlt}
        <div class="dos-botones">
          <button type="button" class="boton chico verde" id="r2-ejecutar">☁️ Respaldar ahora en R2</button>
          <button type="button" class="boton chico contorno-azul" id="r2-mensual">🏛️ Archivar mes fiscal (10 años)</button>
        </div>
        <div style="margin-bottom:10px">
          <button type="button" class="boton chico contorno" id="r2-refrescar">🔄 Actualizar lista</button>
        </div>
        <div class="lista">${filasObj || `<p class="suave">Sin archivos todavía en el bucket.</p>`}</div>`;
      $("#r2-refrescar")?.addEventListener("click", () => cargarR2(true));
      const lanzarRespaldoR2 = async (btn, tipo, etiquetaOrig) => {
        btn.disabled = true;
        btn.textContent = "⏳ Subiendo a R2…";
        try {
          const r = await api("inquilinos/respaldos-r2/ejecutar", "POST", { tipo });
          aviso(tipo === "mensual"
            ? `Archivo mensual fiscal archivado en R2 (${fmtTam(r.resultado?.bytes_totales || 0)}) ✅`
            : `Respaldo subido a R2 (${fmtTam(r.resultado?.bytes_totales || 0)}) ✅`);
          if (r.estado) pintarR2(r.estado);
        } catch (e) {
          aviso(e.message);
          btn.disabled = false;
          btn.textContent = etiquetaOrig;
        }
      };
      $("#r2-ejecutar")?.addEventListener("click", (ev) => lanzarRespaldoR2(ev.currentTarget, "manual", "☁️ Respaldar ahora en R2"));
      $("#r2-mensual")?.addEventListener("click", (ev) => lanzarRespaldoR2(ev.currentTarget, "mensual", "🏛️ Archivar mes fiscal (10 años)"));
      cont.querySelectorAll("[data-dl-r2]").forEach((btn) => btn.addEventListener("click", async () => {
        const key = btn.dataset.dlR2;
        btn.disabled = true;
        try {
          const r = await fetch(`/api/inquilinos/respaldos-r2/descargar?key=${encodeURIComponent(key)}`);
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "No se pudo descargar desde R2.");
          const a = document.createElement("a");
          a.href = URL.createObjectURL(await r.blob());
          a.download = key.split("/").pop() || "respaldo-r2.json";
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          aviso("Respaldo descargado desde R2 ✅");
        } catch (e) {
          aviso(e.message);
        } finally {
          btn.disabled = false;
        }
      }));
    };
    const cargarR2 = async (manual = false) => {
      try {
        const info = await api("inquilinos/respaldos-r2");
        pintarR2(info);
        if (manual) aviso("Lista de respaldos R2 actualizada ✅");
      } catch (e) {
        if ($("#r2-badge")) { $("#r2-badge").textContent = "Error"; $("#r2-badge").className = "insignia rojo"; }
        if ($("#r2-contenido")) $("#r2-contenido").innerHTML = `<p class="error">${esc(e.message)}</p>`;
      }
    };
    cargarR2(false);
    return;
  }

  // 6) Subvista: DIRECTORIO DE CORREOS (#/inquilinos/correos) — Buscador + Paginación (100+ BD)
  if (subvista === "correos") {
    let busqDir = "";
    let pagDir = 0;
    const POR_PAG_DIR = 25;

    raiz.innerHTML = `
      ${barraVolverInq("📧 Directorio de Correos")}
      <section class="tarjeta" id="directorio-correos">
        <h2>📧 Directorio de correos asignados (${directorio.length})</h2>
        <p class="suave">Usuarios registrados en cada negocio. Si un correo quedó en <b>principal</b> por error, pulsa <b>🔓 Liberar correo</b> antes de darle de alta en su propia empresa.</p>
        ${directorio.length > 8 ? `<input type="search" id="dir-buscar" placeholder="🔍 Buscar correo, empresa, ranura DB_X o rol…" autocomplete="off">` : ""}
        <div class="lista" id="dir-lista"></div>
        <div class="paginacion" id="dir-pag"></div>
      </section>`;
    $("#volver-inq").addEventListener("click", () => (location.hash = "#/inquilinos"));

    const pintarDir = () => {
      const q = busqDir.trim().toLowerCase();
      const filt = q
        ? directorio.filter((d) => `${d.email} ${d.nombre_negocio || ""} ${d.inquilino_codigo || ""} ${d.rol || ""}`.toLowerCase().includes(q))
        : directorio;
      const totalPags = Math.max(1, Math.ceil(filt.length / POR_PAG_DIR));
      if (pagDir >= totalPags) pagDir = totalPags - 1;
      const inicio = pagDir * POR_PAG_DIR;
      const vis = filt.slice(inicio, inicio + POR_PAG_DIR);

      const box = $("#dir-lista");
      box.innerHTML = vis.map((d) => `<div class="reng">
        <div class="reng-cab">
          <strong>${esc(d.email)}</strong>
          <span class="insignia gris">${esc(d.rol)}</span>
        </div>
        <small class="suave">Empresa: <b>${esc(d.nombre_negocio)}</b> (${esc(d.inquilino_codigo)})</small>
        ${d.email !== estado.usuario?.email
          ? `<button type="button" class="boton chico contorno" data-liberar-correo="${esc(d.email)}">🔓 Liberar correo</button>`
          : `<small class="suave">👑 Correo Súper Admin protegido</small>`}
      </div>`).join("") || `<p class="suave">Sin registros que coincidan.</p>`;

      const pagBox = $("#dir-pag");
      pagBox.innerHTML = filt.length > POR_PAG_DIR
        ? `<small>Mostrando ${inicio + 1}–${inicio + vis.length} de ${filt.length} correos</small>
           <div class="dos-botones" style="margin:0">
             <button type="button" class="boton chico contorno-azul" id="dir-prev" ${pagDir === 0 ? "disabled" : ""}>⬅️ Anterior</button>
             <button type="button" class="boton chico contorno-azul" id="dir-next" ${pagDir >= totalPags - 1 ? "disabled" : ""}>Siguiente ➡️</button>
           </div>`
        : `<small>${filt.length} correo(s) mostrado(s)</small>`;

      $("#dir-prev")?.addEventListener("click", () => { pagDir--; pintarDir(); window.scrollTo(0, 0); });
      $("#dir-next")?.addEventListener("click", () => { pagDir++; pintarDir(); window.scrollTo(0, 0); });
      box.querySelectorAll("[data-liberar-correo]").forEach((b) => b.addEventListener("click", async () => {
        const email = b.dataset.liberarCorreo;
        try {
          await api("inquilinos/liberar-correo", "POST", { email });
          aviso(`Correo ${email} liberado ✅`);
          await vistaInquilinos("correos");
        } catch (e) {
          aviso(e.message);
        }
      }));
    };
    $("#dir-buscar")?.addEventListener("input", (e) => { busqDir = e.target.value; pagDir = 0; pintarDir(); });
    pintarDir();
    return;
  }

  location.hash = "#/inquilinos";
}

function vistaAjustes() {
  const n = estado.negocio || {}, admin = puede("admin"), superAdmin = puede("super"), puedeTasa = puede("tasa");
  const esDemoCliente = Boolean(estado?.demo?.activo) && !superAdmin;
  const codActivo = estado.inquilino_actual || estado.inquilino_activo || "principal";
  const tasaActual = Number(n.tasa_bcv) || 0;
  const modoTasaActual = n.tasa_bcv_modo === "MANUAL" ? "MANUAL" : "AUTOMATICO";
  const cierreAutoActivo = Number(n.cierre_mensual_correo ?? 1) === 1;
  let logoActual = n.logo_base64 || null;

  raiz.innerHTML = `
    ${barraSuper()}
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver al inicio" aria-label="Volver">←</button><h1>Ajustes</h1></header>
    <section class="tarjeta"><h2>🔑 Mi cuenta</h2><p class="suave">${esc(estado.usuario.nombre)} · ${esc(estado.usuario.rol_nombre)} (${esc(estado.usuario.email)})</p>
      ${esDemoCliente
        ? `<p class="pista">🧪 En la Demo guiada el cambio de clave y 2FA están deshabilitados por seguridad.</p>`
        : `<button class="boton chico contorno" id="cambiar-clave" type="button">Cambiar mi contraseña</button>`}</section>
    ${admin && !esDemoCliente ? `<section class="tarjeta" id="card-2fa">
      <div class="reng-cab"><h2>🛡️ Autenticación en 2 Pasos (2FA · ${superAdmin ? "Súper Admin" : "Administrador"})</h2><span class="insignia gris" id="totp-badge">Consultando…</span></div>
      <p class="suave">Protege tu acceso de ${superAdmin ? "Súper Administrador" : "Administrador"} con códigos temporales de 6 dígitos en <b>Google Authenticator</b> o <b>Authy</b> (estándar RFC 6238). Incluye 8 códigos de respaldo de un solo uso y protección contra fuerza bruta.</p>
      <div id="totp-zona"><p class="suave">Cargando estado 2FA…</p></div>
    </section>` : ""}
    ${puedeTasa ? `<section class="tarjeta" id="ajustes-tasa-card">
      <div class="reng-cab">
        <h2>💱 Tasa de Cambio BCV (Art. 128 Ley BCV)</h2>
        <span class="insignia ${modoTasaActual === "MANUAL" ? "ambar" : "verde"}" id="aj-tasa-badge">${modoTasaActual === "MANUAL" ? "✍️ Manual" : "🔄 Automático (BCV Oficial)"}</span>
      </div>
      <p class="suave">Tasa vigente: <b id="aj-tasa-valor">${tasaActual ? `Bs. ${bs(tasaActual)}` : "Sin definir"}</b> · <span id="aj-tasa-fecha">${n.tasa_bcv_fecha ? `Actualizada: ${fechaLocal(n.tasa_bcv_fecha)}` : "Sin fecha registrada"}</span></p>
      <p class="pista">En modo <b>Automático</b>, el sistema consulta la tasa oficial del BCV una sola vez y la replica a todas las empresas sin saturar el servidor. Las facturas ya emitidas conservan su tasa histórica congelada.</p>
      <form id="tasa-ajustes-form">
        <label for="tasa_bcv_modo">Modo de actualización de la tasa BCV</label>
        <select id="tasa_bcv_modo" name="tasa_bcv_modo">
          <option value="AUTOMATICO" ${modoTasaActual === "AUTOMATICO" ? "selected" : ""}>🔄 Automático (Sincronización Oficial BCV)</option>
          <option value="MANUAL" ${modoTasaActual === "MANUAL" ? "selected" : ""}>✍️ Manual (Yo escribo la tasa cuando quiera)</option>
        </select>
        <div id="caja-tasa-manual" ${modoTasaActual === "MANUAL" ? "" : "hidden"}>
          ${campo("tasa_bcv", "✍️ Tasa BCV manual (Bs por USD)", tasaActual ? String(tasaActual).replace(".", ",") : "", "text", 'inputmode="decimal" placeholder="Ej: 95,45"')}
        </div>
        ${ERROR}
        <div class="dos-botones">
          <button class="boton verde" type="submit" id="tasa-guardar-btn">${modoTasaActual === "MANUAL" ? "💾 Guardar Tasa Manual" : "💾 Guardar Modo Automático"}</button>
          <button class="boton contorno-azul" type="button" id="tasa-sync-ahora">🔄 Sincronizar con BCV ahora</button>
        </div>
      </form>
    </section>` : ""}
    ${superAdmin && codActivo !== "DB_DEMO" ? `<section class="tarjeta">
      <div class="reng-cab"><h2>🏢 Mis Inquilinos / Empresas</h2><span class="insignia azul">Exclusivo Súper Admin</span></div>
      <p class="suave">Empresa activa: <b>${esc(n.nombre_razon_social)} (${esc(codActivo)})</b>. Accede al panel de botones cuadrados para dar de alta clientes, controlar Cloudflare D1, crear Demos, respaldar o dar de baja empresas.</p>
      <button class="boton" id="ir-inquilinos" type="button">🏢 Abrir Menú de Mis Inquilinos</button>
    </section>` : ""}
    ${admin ? `<form id="f" class="tarjeta">
      <div class="reng-cab"><h2>🏷️ Datos Fiscales, RIF SENIAT y Logo</h2><span class="insignia verde">Administrador / Súper Admin</span></div>
      <p class="suave"><b>¿Qué hace esta sección?</b> Define los datos fiscales oficiales del RIF (Art. 13 Providencia SNAT/2011/0071), los datos del representante legal y el logo que se imprimen en el encabezado de tus facturas, presupuestos, notas de crédito, notas de débito y recibos. Si dejas el logo en blanco, los documentos salen sin logo.</p>
      <label>🖼️ Logo en PDF y encabezado (opcional)</label>
      <div class="logo-caja">
        <div class="logo-preview" id="logo-vista">${logoActual ? `<img src="${esc(logoActual)}" alt="Logo">` : `<span class="suave">Sin logo</span>`}</div>
        <div style="flex:1;min-width:0">
          <input type="file" id="logo-archivo" accept="image/png,image/jpeg,image/webp">
          <button type="button" class="boton chico contorno" id="logo-quitar" ${logoActual ? "" : "hidden"}>Quitar logo</button>
        </div>
      </div>
      ${NEGOCIO.map(([id, et]) => campo(id, et, n[id] ?? "")).join("")}
      <p class="pista">💳 Configura tus cuentas receptoras (Pago Móvil, Transferencia, Zelle, Binance, PayPal) en <b>Pagos → Mis datos</b>.${esDemoCliente ? "" : " Para cambiar entre Contribuyente Formal, Ordinario o Especial (IGTF 3%), usa la tarjeta <b>Condición Fiscal</b> justo debajo."}</p>
      <label class="opcion"><input type="checkbox" id="fiscal-confirmo" required> ☑️ Estoy seguro de guardar o modificar los datos fiscales y de contacto de este negocio (solo Administrador y Súper Admin).</label>
      ${ERROR}<button class="boton verde" type="submit" id="fiscal-guardar-btn" disabled>GUARDAR DATOS FISCALES Y LOGO</button>
    </form>
    ${!esDemoCliente ? `<section class="tarjeta" id="card-regimen-fiscal">
      <div class="reng-cab">
        <h2>⚖️ Condición Fiscal / Tipo de Contribuyente</h2>
        <span class="insignia ${infoRegimen(n.tipo_contribuyente).insignia}" id="regimen-actual-badge">${esc(infoRegimen(n.tipo_contribuyente).etiqueta)}</span>
      </div>
      <p class="suave">Controla automáticamente qué impuestos, leyendas en PDF y reportes SENIAT muestra el sistema según tu calificación vigente ante el SENIAT. Los documentos emitidos anteriormente conservan su configuración histórica congelada.</p>
      <form id="regimen-form">
        <label for="regimen_tipo">🏛️ Tipo de contribuyente ante el SENIAT</label>
        <select id="regimen_tipo" name="tipo_contribuyente">
          ${opcionesRegimenHtml(n.tipo_contribuyente || "ORDINARIO")}
        </select>
        <p class="pista" id="regimen-pista">${esc(infoRegimen(n.tipo_contribuyente).ayuda)}</p>
        ${campo("regimen_clave", "🔒 Tu contraseña actual (Administrador o Súper Admin)", "", "password", 'required autocomplete="current-password" placeholder="Ingresa tu contraseña para autorizar"')}
        <label class="opcion"><input type="checkbox" id="regimen-confirmo" required> ☑️ Estoy seguro de cambiar la condición fiscal (Tipo de Contribuyente) de este negocio según su estatus vigente ante el SENIAT.</label>
        ${ERROR}<button class="boton verde" type="submit" id="regimen-guardar-btn" disabled>GUARDAR CONDICIÓN FISCAL</button>
      </form>
    </section>` : ""}
    <section class="tarjeta"><h2>👥 Usuarios y Empleados</h2><p class="suave">Exclusivo del Administrador: crea usuarios para tus empleados (cajero, supervisor, bodega, contador), cámbiales la contraseña o desactívalos.</p>
      <button class="boton chico" id="usuarios" type="button">Administrar usuarios y claves</button></section>
    ${!esDemoCliente ? tarjetaMedio() : ""}
    ${!esDemoCliente ? `<section class="tarjeta" id="correo-config">
      <div class="reng-cab"><h2>✉️ Servicio de Correo y Cierre Mensual</h2><span class="insignia gris" id="correo-estado">Cargando…</span></div>
      <div id="correo-plat-banner" hidden class="correo-banner">
        <div class="correo-banner-tit" id="correo-plat-tit">✅ Correo de plataforma activo (incluido en tu plan)</div>
        <p class="suave" id="correo-plat-detalle" style="margin:4px 0 0;font-size:13px"></p>
      </div>
      <p class="suave"><b>¿Qué hace este servicio?</b> Envía facturas, notas y recibos en PDF a tus clientes y despacha automáticamente los <b>Libros Contables SENIAT en Excel (CSV)</b> al inicio de cada mes al correo del Administrador y Contador.</p>
      <label class="opcion" style="margin-bottom:12px">
        <input type="checkbox" id="cierre-mensual-chk" ${cierreAutoActivo ? "checked" : ""}>
        📊 Enviar automáticamente el Cierre Contable Mensual (${n.tipo_contribuyente === "FORMAL" ? "Relación de Ventas, Compras e ISLR en CSV" : n.tipo_contribuyente === "ESPECIAL" ? "Libros de Ventas, Compras, IVA, IGTF e ISLR en CSV" : "Libros de Ventas, Compras, IVA e ISLR en CSV"}) al inicio de cada mes al Administrador y Contador${n.ultimo_cierre_correo ? ` <small class="suave">(último enviado: ${esc(n.ultimo_cierre_correo)})</small>` : ""}.
      </label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="boton chico contorno-azul" id="correo-probar" type="button">📨 Enviar correo de prueba</button>
        ${superAdmin ? `<button class="boton chico contorno" id="ir-panel-correos-plat" type="button">👑 Panel Global de Correos</button>` : ""}
      </div>
      <div id="correo-historial-box"></div>
    </section>
    ${formularioCodigo()}
    <section class="tarjeta"><h2>💾 Respaldo Online de mi Base de Datos</h2><p class="suave">Exclusivo del Administrador: descarga en cualquier momento una copia completa y verificada de tu base de datos (clientes, inventario, facturas, notas de crédito/débito y cobros) para tu resguardo. <b>Nota:</b> Ningún usuario puede borrar facturas ni eliminar la base de datos.</p>
      <button class="boton" id="respaldo" type="button">⬇️ Descargar respaldo completo (.json)</button></section>
    ${tarjetaRestaurar()}` : `<section class="tarjeta">
      <div class="reng-cab"><h2>✉️ Correos de Prueba en Entorno Demo</h2><span class="insignia ${estado.demo?.correo_habilitado ? "verde" : "gris"}">${estado.demo?.correo_habilitado ? `${estado.demo.correos_enviados}/${estado.demo.max_correos} usados` : "Desactivado"}</span></div>
      <p class="suave">${estado.demo?.correo_habilitado
        ? `Puedes probar el envío real de facturas y recibos PDF (hasta <b>${estado.demo.max_correos} correos</b> en total). Por seguridad, todos los envíos se redirigen exclusivamente a tu correo registrado (<b>${esc(estado.demo.email_prospecto_mascara)}</b>).`
        : "El envío de correos no fue habilitado en esta sesión demo. Puedes descargar y revisar cualquier factura, nota o recibo PDF directamente desde la pantalla."}</p>
      <p class="pista">🛡️ Las funciones administrativas críticas (Imprenta Digital, API de correo, 2FA, respaldos y restauración) están reservadas para cuentas de empresas activas.</p>
    </section>`}
    ${superAdmin && codActivo !== "DB_DEMO" ? `<section class="tarjeta">
      <div class="reng-cab"><h2>🗑️ ${codActivo === "principal" ? "Reiniciar base de datos de fábrica" : "Eliminar empresa y sus datos"}</h2><span class="insignia rojo">Exclusivo Súper Admin</span></div>
      <p class="suave">${codActivo === "principal"
        ? "Reinicia desde cero toda la base de datos de tu empresa principal (deja el sistema sin instalar)."
        : `Elimina por completo las tablas y datos de <b>${esc(n.nombre_razon_social || codActivo)}</b> (${esc(codActivo)}) y vuelve a tu empresa principal.`}</p>
      ${(codActivo === "principal" || (estado.modo === "REAL" && (estado.facturas_reales_n || 0) > 0))
        ? `<div class="aviso-anulado">⚠️ Protección Fiscal SENIAT: ${codActivo === "principal" ? "Esta es tu empresa principal" : "Negocio en Modo Real"} (${estado.facturas_reales_n || 0} documento(s) emitidos). Descarga un respaldo antes de continuar y escribe exactamente <b>REINICIAR-DEFINITIVAMENTE</b>.</div>`
        : ""}
      <form id="reiniciar-form">
        ${campo("clave_reinicio", "🔒 Tu contraseña de Súper Admin", "", "password", 'required autocomplete="current-password"')}
        ${(codActivo === "principal" || (estado.modo === "REAL" && (estado.facturas_reales_n || 0) > 0))
          ? campo("frase_confirmacion", "✍️ Escribe exactamente: REINICIAR-DEFINITIVAMENTE", "", "text", 'required autocomplete="off" placeholder="REINICIAR-DEFINITIVAMENTE"')
          : ""}
        <label class="opcion"><input type="checkbox" name="confirmo_reinicio" required> Confirmo borrar los datos de esta empresa.</label>
        ${ERROR}<button class="boton rojo" type="submit">🗑️ ${codActivo === "principal" ? "BORRAR Y REINSTALAR" : "ELIMINAR EMPRESA"}</button>
      </form></section>
      ${TARJETA_GITHUB_ZIP}` : ""}` : ""}
    <section class="tarjeta" id="card-soporte">
      <h2>🛠️ Soporte y Atención al Cliente</h2>
      <p class="suave">¿Necesitas ayuda técnica con tu cuenta, facturas, libros SENIAT o gestión de tu suscripción? Escríbenos a nuestros canales oficiales:</p>
      <div class="soporte-lista">
        <div class="soporte-item">
          <div class="soporte-item-info">
            <div class="soporte-item-tit">🛟 Soporte técnico e incidencias</div>
            <div class="soporte-item-dir">${esc(correoCorporativo("soporte"))}</div>
            <div class="soporte-item-sub">Fallos, dudas operativas, configuración de usuarios o reportes.</div>
          </div>
          <div class="soporte-item-acciones">
            <button type="button" class="boton chico contorno-azul" data-escribir-correo="soporte">✉️ Escribir</button>
            <button type="button" class="boton chico soporte-btn-copiar" data-copiar-correo="soporte">📋 Copiar</button>
          </div>
        </div>
        <div class="soporte-item">
          <div class="soporte-item-info">
            <div class="soporte-item-tit">💳 Pagos y suscripción</div>
            <div class="soporte-item-dir">${esc(correoCorporativo("pagos"))}</div>
            <div class="soporte-item-sub">Comprobantes de pago, renovaciones, planes y activaciones.</div>
          </div>
          <div class="soporte-item-acciones">
            <button type="button" class="boton chico contorno-azul" data-escribir-correo="pagos">✉️ Escribir</button>
            <button type="button" class="boton chico soporte-btn-copiar" data-copiar-correo="pagos">📋 Copiar</button>
          </div>
        </div>
        ${datosWhatsappContacto("soporte") ? `<div class="soporte-item">
          <div class="soporte-item-info">
            <div class="soporte-item-tit">💬 Soporte por WhatsApp (clientes activos)</div>
            <div class="soporte-item-sub">Deja tus datos de empresa y consulta por WhatsApp; te responderemos en breve.</div>
          </div>
          <div class="soporte-item-acciones">
            <a class="boton chico verde" href="${esc(datosWhatsappContacto("soporte").url)}" target="_blank" rel="nofollow noopener noreferrer">Escribir a soporte</a>
          </div>
        </div>` : ""}
      </div>
    </section>
    ${botonInstalarPwaHtml("ajustes") ? `<section class="tarjeta" id="card-pwa-ajustes">
      <h2>📲 Aplicación Instalable (Celular y PC)</h2>
      <p class="suave">Instala FacturaYa Venezuela en la pantalla principal de tu teléfono, tablet o computadora para abrirlo a pantalla completa en un toque, sin perder las actualizaciones automáticas ni la sincronización fiscal SENIAT.</p>
      ${botonInstalarPwaHtml("ajustes")}
    </section>` : ""}
    <button class="boton contorno" id="salir">Cerrar sesión</button>`;

  $("#atras").addEventListener("click", () => (location.hash = "#/inicio"));
  $("#ir-inquilinos")?.addEventListener("click", () => (location.hash = "#/inquilinos"));
  raiz.querySelectorAll(".barra-super [data-destino], .barra-mant-super [data-destino]").forEach((b) => b.addEventListener("click", () => (location.hash = b.dataset.destino)));
  enlazarBotonesPwa(raiz, aviso);
  $("#cambiar-clave")?.addEventListener("click", () => vistaCambiarClave(estado, { forzado: false, alTerminar: () => { if (location.hash !== "#/ajustes") location.hash = "#/ajustes"; return ruta(); } }));
  $("#salir").addEventListener("click", async () => { await api("logout", "POST"); history.replaceState(null, "", "/"); await ruta(); });

  if (admin && !esDemoCliente) {
    const pintar2fa = (info, pasoSetup = null, codigosNuevos = null) => {
      const badge = $("#totp-badge"), zona = $("#totp-zona");
      if (!badge || !zona) return;
      if (codigosNuevos) {
        badge.textContent = "🟢 2FA ACTIVO";
        badge.className = "insignia verde";
        const textoCodigos = codigosNuevos.join("\n");
        zona.innerHTML = `<div class="aviso-control"><b>✅ 2FA activado correctamente.</b> Guarda estos <b>8 códigos de respaldo de un solo uso</b> en un lugar seguro (si pierdes el teléfono, cada uno te permite entrar una vez). Se muestran una sola vez:</div>
          <pre class="codigo" id="codigos-2fa-txt" style="white-space:pre-wrap;text-align:center;line-height:1.8">${esc(textoCodigos)}</pre>
          <div class="dos-botones">
            <button type="button" class="boton chico contorno-azul" id="copiar-2fa-cods">📋 Copiar 8 códigos</button>
            <button type="button" class="boton chico verde" id="listo-2fa">Ya los guardé ✅</button>
          </div>`;
        $("#copiar-2fa-cods")?.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(textoCodigos); aviso("Códigos de respaldo copiados ✅"); }
          catch { aviso("Selecciona los códigos y cópialos manualmente."); }
        });
        $("#listo-2fa")?.addEventListener("click", () => cargar2fa());
        return;
      }
      if (pasoSetup) {
        badge.textContent = "⏳ Escanea el QR";
        badge.className = "insignia ambar";
        const svgQr = generarQrSvg(pasoSetup.otpauth_uri, { tamPx: 210 });
        zona.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin:10px 0">
            <div style="background:#fff;padding:10px;border-radius:12px;border:1px solid #d5dde7">${svgQr}</div>
            <small class="suave">Escanea este QR con <b>Google Authenticator</b> o <b>Authy</b>. Si prefieres ingresarlo a mano, usa esta clave:</small>
            <code class="codigo" id="totp-secreto-txt" style="font-size:14px;word-break:break-all">${esc(pasoSetup.secreto)}</code>
            <button type="button" class="boton chico contorno-azul" id="copiar-totp-sec">📋 Copiar clave manual</button>
          </div>
          <form id="f-2fa-activar">
            ${campo("codigo", "🔢 Código de 6 dígitos de tu app autenticadora", "", "text", 'required inputmode="numeric" maxlength="10" autocomplete="one-time-code" placeholder="123456"')}
            ${ERROR}
            <div class="dos-botones">
              <button type="submit" class="boton verde">✅ Confirmar y activar 2FA</button>
              <button type="button" class="boton contorno" id="cancelar-2fa">Cancelar</button>
            </div>
          </form>`;
        $("#copiar-totp-sec")?.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(pasoSetup.secreto); aviso("Clave secreta copiada ✅"); }
          catch { aviso("Selecciona la clave y cópiala."); }
        });
        $("#cancelar-2fa")?.addEventListener("click", () => cargar2fa());
        enviar($("#f-2fa-activar"), async (d) => {
          const r = await api("cuenta/2fa/activar", "POST", { codigo: d.codigo });
          aviso("2FA activado ✅");
          pintar2fa({ ...info, activo: true, codigos_respaldo_restantes: r.codigos_respaldo?.length || 8 }, null, r.codigos_respaldo);
        });
        return;
      }
      if (info.activo) {
        badge.textContent = "🟢 2FA ACTIVO";
        badge.className = "insignia verde";
        zona.innerHTML = `<p class="pista">Tu cuenta de ${superAdmin ? "Súper Administrador" : "Administrador"} exige un código TOTP al iniciar sesión. Códigos de respaldo restantes: <b>${info.codigos_respaldo_restantes}</b>.</p>
          <button type="button" class="boton chico contorno" id="abrir-desactivar-2fa">🔓 Desactivar 2FA</button>
          <form id="f-2fa-desactivar" hidden style="margin-top:10px">
            ${campo("clave_2fa_off", "🔒 Tu contraseña actual", "", "password", 'required autocomplete="current-password"')}
            ${campo("codigo_2fa_off", "🔢 Código 2FA actual (o código de respaldo)", "", "text", 'required maxlength="20" autocomplete="one-time-code" placeholder="123456"')}
            ${ERROR}<button type="submit" class="boton rojo">Desactivar 2FA</button>
          </form>`;
        $("#abrir-desactivar-2fa")?.addEventListener("click", () => { $("#f-2fa-desactivar").hidden = !$("#f-2fa-desactivar").hidden; });
        enviar($("#f-2fa-desactivar"), async (d) => {
          await api("cuenta/2fa/desactivar", "POST", { clave: d.clave_2fa_off, codigo: d.codigo_2fa_off });
          aviso("2FA desactivado.");
          await cargar2fa();
        });
      } else {
        badge.textContent = "⚪ Desactivado";
        badge.className = "insignia gris";
        zona.innerHTML = `${!info.master_key_lista ? `<p class="error">Configura primero <code>MASTER_KEY</code> en Cloudflare para cifrar tu secreto 2FA.</p>` : ""}
          <form id="f-2fa-iniciar">
            ${campo("clave_2fa_on", "🔒 Confirma tu contraseña actual para generar el QR", "", "password", 'required autocomplete="current-password"')}
            ${ERROR}<button type="submit" class="boton chico verde" ${!info.master_key_lista ? "disabled" : ""}>🔐 Configurar 2FA (Generar QR)</button>
          </form>`;
        enviar($("#f-2fa-iniciar"), async (d) => {
          const r = await api("cuenta/2fa/iniciar", "POST", { clave: d.clave_2fa_on });
          pintar2fa(info, r);
        });
      }
    };
    const cargar2fa = async () => {
      try {
        const info = await api("cuenta/2fa/estado");
        pintar2fa(info);
      } catch (e) {
        if ($("#totp-badge")) { $("#totp-badge").textContent = "Error"; $("#totp-badge").className = "insignia rojo"; }
        if ($("#totp-zona")) $("#totp-zona").innerHTML = `<p class="error">${esc(e.message)}</p>`;
      }
    };
    cargar2fa();
  }

  if (puedeTasa) {
    const selModo = $("#tasa_bcv_modo");
    const cajaManual = $("#caja-tasa-manual");
    const btnGuardarTasa = $("#tasa-guardar-btn");
    selModo?.addEventListener("change", () => {
      const esManual = selModo.value === "MANUAL";
      if (cajaManual) cajaManual.hidden = !esManual;
      if (btnGuardarTasa) btnGuardarTasa.textContent = esManual ? "💾 Guardar Tasa Manual" : "💾 Guardar Modo Automático";
    });
    enviar($("#tasa-ajustes-form"), async (d) => {
      const modoElegido = d.tasa_bcv_modo === "MANUAL" ? "MANUAL" : "AUTOMATICO";
      const payload = { tasa_bcv_modo: modoElegido };
      if (modoElegido === "MANUAL") payload.tasa_bcv = d.tasa_bcv;
      await api("config", "PUT", payload);
      aviso(modoElegido === "MANUAL" ? "Tasa BCV manual guardada ✅" : "Modo Automático BCV activado ✅");
      await ruta();
    });
    $("#tasa-sync-ahora")?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = "⏳ Consultando BCV…";
      try {
        const r = await api("sistema/tasa-bcv/sincronizar", "POST", {});
        aviso(`Tasa BCV sincronizada: Bs. ${bs(Number(r.tasa_bcv))} (${r.fuente}) ✅`);
        await ruta();
      } catch (e) {
        aviso(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "🔄 Sincronizar con BCV ahora";
      }
    });
  }

  if (!admin) return;

  $("#cierre-mensual-chk")?.addEventListener("change", async (ev) => {
    try {
      await api("config", "PUT", { cierre_mensual_correo: ev.target.checked ? 1 : 0 });
      aviso(ev.target.checked ? "Envío automático de cierre mensual activado ✅" : "Envío automático de cierre mensual desactivado.");
    } catch (e) {
      aviso(e.message);
    }
  });

  $("#fiscal-confirmo")?.addEventListener("change", () => {
    $("#fiscal-guardar-btn").disabled = !$("#fiscal-confirmo").checked;
  });
  $("#regimen-confirmo")?.addEventListener("change", () => {
    $("#regimen-guardar-btn").disabled = !$("#regimen-confirmo").checked;
  });
  $("#regimen_tipo")?.addEventListener("change", (e) => {
    const p = $("#regimen-pista");
    if (p) p.textContent = infoRegimen(e.target.value).ayuda;
  });
  if ($("#regimen-form")) enviar($("#regimen-form"), async (d) => {
    const r = await api("config/regimen", "PUT", {
      tipo_contribuyente: d.tipo_contribuyente,
      clave_actual: d.regimen_clave,
      confirmo_regimen: $("#regimen-confirmo")?.checked,
    });
    $("#regimen_clave").value = "";
    $("#regimen-confirmo").checked = false;
    $("#regimen-guardar-btn").disabled = true;
    aviso(`Condición fiscal actualizada a ${infoRegimen(r.tipo_contribuyente).etiqueta} ✅`);
    await ruta();
  });

  $("#logo-archivo")?.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      logoActual = await optimizarLogo(file);
      $("#logo-vista").innerHTML = `<img src="${esc(logoActual)}" alt="Logo">`;
      $("#logo-quitar").hidden = false;
      aviso("Logo listo: marca la casilla de confirmación y pulsa «GUARDAR DATOS FISCALES Y LOGO» ✅");
    } catch (err) {
      aviso(err.message);
    }
  });
  $("#logo-quitar")?.addEventListener("click", () => {
    logoActual = "";
    $("#logo-vista").innerHTML = `<span class="suave">Sin logo</span>`;
    $("#logo-quitar").hidden = true;
    if ($("#logo-archivo")) $("#logo-archivo").value = "";
  });

  $("#usuarios")?.addEventListener("click", () => (location.hash = "#/usuarios"));
  if (!esDemoCliente) {
    enlazarCodigo(ruta);
    enlazarMedio(ruta).catch((e) => aviso(e.message));
    api("sistema/correo").then((cfg) => {
      const est = $("#correo-estado");
      if (!est) return;
      const ban = $("#correo-plat-banner");
      const tit = $("#correo-plat-tit");
      const det = $("#correo-plat-detalle");
      const nomNeg = cfg.negocio_nombre || n.nombre_razon_social || "Tu negocio";
      const reply = cfg.reply_to || n.email || "tu correo en Datos Fiscales";
      if (cfg.modo_plataforma) {
        est.textContent = "Plataforma activa";
        est.className = "insignia verde";
        if (ban) ban.hidden = false;
        if (tit) tit.textContent = "✅ Correo de plataforma activo (incluido en tu plan)";
        if (det) {
          det.innerHTML = `Remitente visible: <b>${esc(nomNeg)} (vía ${esc(cfg.nombre_plataforma || "FacturaYa Venezuela")})</b> &lt;${esc(cfg.remitente_plataforma || cfg.remitente)}&gt; · Respuestas directas (Reply-To) a: <b>${esc(reply)}</b>.`;
        }
      } else {
        est.textContent = cfg.clave_configurada ? `Activo · ${cfg.proveedor}` : "Administrado por plataforma";
        est.className = `insignia ${cfg.clave_configurada ? "verde" : "gris"}`;
        if (ban) ban.hidden = false;
        if (tit) tit.textContent = cfg.clave_configurada ? "✅ Servicio de correo activo" : "ℹ️ Correo administrado por FacturaYa Venezuela";
        if (det) {
          det.innerHTML = cfg.clave_configurada
            ? `Remitente configurado: <b>${esc(cfg.nombre_remitente || nomNeg)}</b> &lt;${esc(cfg.remitente)}&gt;.`
            : `El envío de facturas y cierres mensuales es administrado por la plataforma sin necesidad de configurar API Keys en tu empresa. Las respuestas llegarán a <b>${esc(reply)}</b>.`;
        }
      }
    }).catch(() => {});
    renderHistorialCorreoInquilino($("#correo-historial-box"));
    $("#ir-panel-correos-plat")?.addEventListener("click", () => (location.hash = "#/inquilinos/correos-plataforma"));
    $("#correo-probar")?.addEventListener("click", async () => {
      try {
        const r = await api("sistema/correo/probar", "POST", { para: estado.usuario.email });
        aviso(`Correo de prueba enviado a ${r.destino} ✅`);
        renderHistorialCorreoInquilino($("#correo-historial-box"));
      } catch (e) {
        aviso(e.message);
        renderHistorialCorreoInquilino($("#correo-historial-box"));
      }
    });
    $("#restaurar-ir")?.addEventListener("click", () => (location.hash = "#/restaurar"));
    $("#respaldo")?.addEventListener("click", async () => {
      try {
        const r = await fetch("/api/sistema/respaldo"); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "No se pudo descargar el respaldo.");
        const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `respaldo-${new Date().toISOString().slice(0, 10)}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000); aviso("Respaldo descargado ✅");
      } catch (e) { aviso(e.message); }
    });
  }
  enviar($("#f"), async (d) => {
    d.logo_base64 = logoActual ?? "";
    d.confirmo_fiscal = $("#fiscal-confirmo")?.checked;
    await api("config", "PUT", d);
    aviso("Datos fiscales y logo guardados ✅");
    location.hash = "#/inicio";
  });
  if ($("#reiniciar-form")) enviar($("#reiniciar-form"), async (d) => {
    if (!confirm("⚠️ ¿Seguro que deseas BORRAR TODA LA BASE DE DATOS de este negocio y reinstalar desde cero?")) return;
    if (estado.modo === "REAL" && (estado.facturas_reales_n || 0) > 0) {
      const rResp = await fetch("/api/sistema/respaldo");
      if (!rResp.ok) throw new Error((await rResp.json().catch(() => ({}))).error || "No se pudo descargar el respaldo obligatorio previo al borrado.");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await rResp.blob());
      a.download = `respaldo-previo-baja-${codActivo}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    await api("sistema/reiniciar-fabrica", "POST", {
      clave: d.clave_reinicio,
      confirmo: d.confirmo_reinicio === "on",
      frase_confirmacion: d.frase_confirmacion || "",
    });
    aviso("Respaldo descargado y base de datos reiniciada de fábrica ✅");
    history.replaceState(null, "", "/");
    await ruta();
  });
}

async function ruta() {
  detenerRelojDemo();
  document.body.classList.remove("modo-portada");
  window.scrollTo(0, 0);
  try {
    try {
      estado = await api("estado");
    } catch (eEstado) {
      const hashActual = (location.hash || "").trim();
      const esRutaPublica = !hashActual || hashActual === "#" || hashActual === "#/" || hashActual === "#/login";
      if (esRutaPublica) {
        // Si un rastreador (ej. Googlebot) cancela /api/estado o hay un corte momentáneo en portada,
        // siempre mostramos la portada pública completa en lugar de una pantalla de error (evita Soft 404).
        estado = { instalado: true, sesion: false, turnstile_site_key: null, whatsapp_contacto: { activo: true } };
        return vistaLogin();
      }
      throw eEstado;
    }
    if (!estado.instalado) return vistaInstalar();
    if (!estado.sesion) return vistaLogin();
    fijarPermisos(estado.permisos);
    if (estado.restaurando && !puede("admin")) return pantallaOcupado(ruta);
    if (estado.usuario.debe_cambiar_clave) return vistaCambiarClave(estado, { forzado: true, alTerminar: ruta });
    const [seccion, id, extra] = location.hash.replace(/^#\/?/, "").split("/");
    if (estado.restaurando && seccion !== "restaurar") return vistaRestaurar(estado, ruta);
    if (seccion === "restaurar") { if (puede("admin") && !estado?.demo?.activo) vistaRestaurar(estado, ruta); else vistaInicio(); }
    else if (seccion === "inquilinos") { if (puede("super")) await vistaInquilinos(id); else vistaInicio(); }
    else if (seccion === "ajustes") vistaAjustes();
    else if (seccion === "usuarios") { if (puede("admin")) await vistaUsuarios(estado); else vistaInicio(); }
    else if (seccion === "clientes") await vistaClientes(estado, id);
    else if (seccion === "factura") await vistaFactura(estado, id, extra);
    else if (seccion === "pagos") await vistaPagos(estado, id, extra);
    else if (seccion === "compras") await vistaCompras(estado, id);
    else if (seccion === "proveedores") await vistaProveedores(estado, id);
    else if (seccion === "existencias") await vistaExistencias(estado, id);
    else if (seccion === "informes") await vistaInformes(estado, id);
    else if (seccion === "inventario" || seccion === "catalogo") await vistaCatalogo(estado, id);
    else vistaInicio();
    montarBarraDemo();
  } catch (e) {
    raiz.innerHTML = `<section class="tarjeta"><h1>⚠️ No se pudo cargar</h1><p class="error">${esc(e.message)}</p><button class="boton" id="reintentar">Reintentar</button></section>`;
    $("#reintentar").addEventListener("click", ruta);
  }
}
window.addEventListener("facturaya:mantenimiento", (ev) => {
  detenerRelojDemo();
  estado = {
    ...estado,
    sesion: false,
    mantenimiento: true,
    mensaje_mantenimiento: ev?.detail?.mensaje || ev?.detail?.error || "",
  };
  history.replaceState(null, "", "/");
  vistaLogin();
  window.scrollTo(0, 0);
});
window.addEventListener("facturaya:demo-expirado", (ev) => {
  detenerRelojDemo();
  estado = {
    ...estado,
    sesion: false,
    demo: null,
    demo_expirado: true,
    mensaje_demo_expirado: ev?.detail?.error || "",
  };
  history.replaceState(null, "", "/");
  vistaLogin();
  window.scrollTo(0, 0);
});
window.addEventListener("hashchange", ruta);
iniciarPwaYConectividad();
ruta();

