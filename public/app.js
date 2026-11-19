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

const NEGOCIO = [
  ["nombre_razon_social", "🏷️ Nombre o razón social (según RIF SENIAT)"],
  ["rif", "🪪 RIF fiscal (ej: V-12345678-0 o J-12345678-9)"],
  ["direccion_fiscal", "📍 Domicilio fiscal completo (según RIF)"],
  ["representante_nombre", "👤 Nombre completo del Dueño / Representante Legal"],
  ["representante_cedula", "🪪 Cédula de Identidad del Dueño (ej: V-12345678)"],
  ["telefono", "📞 Teléfono / WhatsApp de contacto"],
  ["email", "✉️ Correo del negocio"],
];
let estado = {};

const esEntornoPreview = location.hostname.endsWith(".run.app") || location.hostname === "localhost" || location.hostname === "127.0.0.1";
const ICONO_WA_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.52 3.48A11.86 11.86 0 0 0 12.06 0C5.5 0 .16 5.34.16 11.9c0 2.1.55 4.15 1.59 5.95L0 24l6.33-1.66a11.84 11.84 0 0 0 5.73 1.46h.01c6.56 0 11.9-5.34 11.9-11.9 0-3.18-1.24-6.17-3.45-8.42ZM12.07 21.8h-.01a9.87 9.87 0 0 1-5.04-1.38l-.36-.21-3.76.99 1-3.66-.24-.38a9.84 9.84 0 0 1-1.51-5.26c0-5.45 4.44-9.89 9.91-9.89 2.65 0 5.13 1.03 7 2.9a9.83 9.83 0 0 1 2.9 7c0 5.46-4.44 9.89-9.89 9.89Zm5.42-7.41c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.22 3.08.15.2 2.1 3.21 5.08 4.5.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.69.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35Z"/></svg>`;

function datosWhatsappContacto() {
  const raw = estado?.whatsapp_contacto;
  if (!raw) return null;
  const digitos = String(typeof raw === "object" ? (raw.digitos || "") : raw).replace(/\D/g, "");
  if (digitos.length < 10 || digitos.length > 15) return null;
  const local = (typeof raw === "object" && raw.bonito)
    ? String(raw.bonito)
    : (digitos.startsWith("58") && digitos.length === 12
      ? `0${digitos.slice(2, 5)}-${digitos.slice(5, 8)}-${digitos.slice(8)}`
      : `+${digitos}`);
  return {
    url: `https://wa.me/${digitos}?text=${encodeURIComponent("Hola, deseo información para activar FacturaYa Venezuela en mi empresa.")}`,
    etiqueta: local,
  };
}

const TARJETA_GITHUB_ZIP = esEntornoPreview ? `<section class="tarjeta" style="margin-top:24px"><span class="etiqueta">📦 DESCARGA PARA GITHUB DESKTOP / CLOUDFLARE (v4.5.1)</span>
  <p class="suave">Descarga el ZIP completo v4.5.1 auditado (env obligatorio en permisos, instalación protegida por SUPER_ADMIN_EMAIL, cero PII, R2 10 años en streaming, 2FA con rate-limit, HSTS y package-lock.json fijado):</p>
  <button type="button" class="boton verde" data-dl-cf="facturaya-ve-github.zip">⬇️ Descargar todo: facturaya-ve-github.zip (v4.5.1)</button>
  <div class="dos-botones">
    <button type="button" class="boton chico contorno-azul" data-dl-cf="wrangler.toml">⬇️ wrangler.toml</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="README.md">⬇️ README.md</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="_headers">⬇️ public/_headers</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="package.json">⬇️ package.json</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="respaldos-r2.ts">⬇️ src/respaldos-r2.ts</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="app.js">⬇️ public/app.js</button>
  </div></section>` : "";

document.addEventListener("click", async (e) => {
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
      a.download = nombre === "rutas-inquilinos.ts" ? "inquilinos.ts" : nombre;
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
  return `<span class="logo">🖼️</span>`;
}

function barraSuper() {
  if (!puede("super")) return "";
  const cod = estado.inquilino_actual || estado.inquilino_activo || "principal";
  return `<div class="barra-super">
    <div><small>👑 MODO SÚPER ADMIN · VIENDO NEGOCIO:</small><b>🏢 ${esc(estado.negocio?.nombre_razon_social || "Principal")} (${esc(cod)})</b></div>
    <button type="button" class="boton chico" data-destino="#/inquilinos">Mis Inquilinos</button>
  </div>`;
}

function vistaInstalar() {
  raiz.innerHTML = `<section class="tarjeta"><h1>🛡️ Bienvenido a FacturaYa Venezuela</h1>
    <p class="suave">Configuración inicial del contribuyente conforme a las Providencias SENIAT SNAT/2011/0071 y SNAT/2024/000102.</p>
    <form id="f">
      ${campo("nombre", "👤 Nombre o razón social", "", "text", 'required autocomplete="organization"')}
      ${campo("rif", "🪪 RIF fiscal (ej: V-12345678-0 o J-12345678-9)", "", "text", 'required placeholder="V-12345678-0 o J-12345678-9"')}
      ${campo("direccion", "📍 Domicilio fiscal", "", "text", 'required autocomplete="street-address"')}
      ${campo("telefono", "📞 Teléfono", "", "tel", 'autocomplete="tel"')}
      ${campo("email", "✉️ Correo del administrador", "", "email", 'required autocomplete="username"')}
      <label for="medio_facturacion">🧾 Modalidad digital (SNAT/2024/000102)</label>
      <select id="medio_facturacion" name="medio_facturacion">
        <option value="APP_SENIAT" selected>📱 Sistema Digital SENIAT (SNAT/2024/000102)</option>
        <option value="IMPRENTA_DIGITAL">🌐 Imprenta Digital Autorizada (API)</option>
      </select>
      ${campo("clave", "🔒 Contraseña (mínimo 10 caracteres)", "", "password", 'required minlength="10" autocomplete="new-password"')}
      <div id="ts-instalar" class="ts-caja"></div>
      ${ERROR}<button class="boton" type="submit">CREAR SISTEMA Y ENTRAR ➔</button>
    </form></section>${TARJETA_GITHUB_ZIP}`;
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
  document.body.classList.add("modo-portada");
  const wa = datosWhatsappContacto();
  raiz.innerHTML = `
    <div class="portada">
      <header class="portada-topbar" id="inicio-portada">
        <button type="button" class="portada-marca" data-scroll="inicio-portada" aria-label="FacturaYa Venezuela">
          <img src="/favicon.svg?v=20261119v45" alt="" width="34" height="34">
          <span>FacturaYa Venezuela</span>
        </button>
        <nav class="portada-nav" aria-label="Secciones principales">
          <button type="button" class="portada-nav-link" data-scroll="capacidades">Capacidades</button>
          <button type="button" class="portada-nav-link" data-scroll="marco-legal">Marco legal</button>
          <button type="button" class="portada-nav-link" data-scroll="equipos">Roles</button>
          ${wa ? `<button type="button" class="portada-nav-link" data-scroll="contacto">Contacto</button>` : ""}
        </nav>
        <div class="portada-nav-accion">
          <button type="button" class="portada-btn-nav" data-scroll="acceso-empresa">Iniciar sesión</button>
        </div>
      </header>

      <section class="portada-hero" aria-labelledby="hero-titulo">
        <div class="portada-hero-texto">
          <p class="portada-kicker">Facturación digital · Normativa SENIAT · Venezuela</p>
          <h1 id="hero-titulo">Facturación digital y libros contables claros para tu negocio.</h1>
          <p class="portada-lead">Emite facturas, presupuestos, notas de crédito y recibos con tu logo en Bolívares y Dólares a la tasa oficial BCV. Opera desde celular, tablet o computadora y entrega los libros listos a tu contador.</p>
          <div class="portada-hero-ctas">
            ${wa
              ? `<a class="portada-btn-wa" href="${esc(wa.url)}" target="_blank" rel="noopener noreferrer">${ICONO_WA_SVG}<span>Solicitar activación por WhatsApp</span></a>
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
                <img src="/favicon.svg?v=20261119v45" alt="" width="36" height="36">
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
            <span class="bento-num">02. Bimoneda BCV e IGTF</span>
            <h3>Cálculo exacto en Bolívares y Dólares</h3>
            <p>Sincroniza la tasa oficial del BCV o ajústala manualmente, congela la tasa en cada factura y calcula automáticamente el IVA y el IGTF del 3% en pagos en divisas.</p>
            <p class="bento-ley">Sustento legal: Art. 128 Ley del BCV y Providencia SNAT/2022/000013.</p>
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
            <p>Asigna accesos independientes para Dueño, Supervisor, Cajero, Bodega y Contador. Los cajeros facturan y cobran sin ver costos ni ganancias, y tu contador entra en modo solo lectura para descargar los libros del mes.</p>
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
            <p>Cálculo, desglose y declaración quincenal del IGTF (3%) aplicable a pagos recibidos en moneda extranjera.</p>
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

      ${wa ? `<section class="portada-cta-banda" id="contacto" aria-labelledby="tit-contacto">
        <div>
          <h2 id="tit-contacto">Activa FacturaYa Venezuela en tu empresa</h2>
          <p>Te ayudamos a configurar tu RIF, logotipo, usuarios y modalidad de facturación para empezar a emitir el mismo día.</p>
        </div>
        <a class="portada-btn-wa grande" href="${esc(wa.url)}" target="_blank" rel="noopener noreferrer">${ICONO_WA_SVG}<span>Escribir al WhatsApp ${esc(wa.etiqueta)}</span></a>
      </section>` : ""}

      <section class="portada-acceso" id="acceso-empresa" aria-labelledby="tit-acceso">
        <div class="portada-acceso-info">
          <p class="portada-kicker">Acceso para empresas activas</p>
          <h2 id="tit-acceso">Ingresa a tu negocio</h2>
          <p>Inicia sesión con el correo y la contraseña asignados a tu empresa. Funciona igual en teléfono, tablet y computadora.</p>
          <ul class="portada-acceso-puntos">
            <li>Acceso por usuario y rol (Dueño, Supervisor, Cajero, Bodega o Contador).</li>
            <li>Sesiones cifradas con verificación en 2 pasos (2FA) disponible para administradores.</li>
            <li>¿Olvidaste tu clave? Solicita una clave temporal al correo principal del Dueño.</li>
          </ul>
        </div>
        <div class="portada-acceso-card">
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
          <button class="boton contorno-azul" id="olvide" type="button" style="margin-top:12px">¿Olvidaste tu contraseña? Recíbela en el correo del Dueño</button>
        </div>
      </section>

      <footer class="portada-pie">
        <span>FacturaYa Venezuela · Facturación Digital y Libros Contables</span>
        ${wa
          ? `<a href="${esc(wa.url)}" target="_blank" rel="noopener noreferrer">Atención por WhatsApp: ${esc(wa.etiqueta)}</a>`
          : `<span>Normativa SENIAT · SNAT/2011/0071 · SNAT/2024/000102</span>`}
      </footer>
    </div>${TARJETA_GITHUB_ZIP}`;

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
      throw e;
    }
  });
}

function vistaInicio() {
  const n = estado.negocio || {}, tasa = Number(n.tasa_bcv) || 0;
  const modoTasa = n.tasa_bcv_modo === "MANUAL" ? "MANUAL" : "AUTOMATICO";
  raiz.innerHTML = `
    ${barraSuper()}
    <header class="encabezado">${logoHeader(n)}<h1>Hola, ${esc(n.nombre_razon_social || "Mi Negocio")}</h1>
      <button class="icono" id="ajustes" data-ayuda="Ajustes del negocio, tasa BCV, datos de cobro y cerrar sesión" aria-label="Ajustes">⚙️</button></header>
    ${estado.seguridad && !estado.seguridad.master_key ? `<section class="aviso-control">🔐 <b>Falta MASTER_KEY.</b> Sin ella no se pueden guardar claves de API ni firmar respaldos. Configúrala en Cloudflare: <code>wrangler secret put MASTER_KEY</code>.</section>` : ""}
    ${estado.seguridad && !estado.seguridad.turnstile_secreto ? `<section class="aviso-control">🛡️ <b>Falta TURNSTILE_SECRET_KEY.</b> Con la clave pública activa, el acceso y la recuperación exigen el secreto: <code>wrangler secret put TURNSTILE_SECRET_KEY</code>.</section>` : ""}
    ${estado.seguridad?.ultimo_error_r2 ? `<section class="aviso-anulado" data-destino="#/inquilinos/salud">☁️ <b>Alerta de respaldo R2 (${esc(estado.seguridad.ultimo_error_r2.tipo || "cron")}):</b> ${esc(estado.seguridad.ultimo_error_r2.mensaje || "Error en la última ejecución.")} <small>(${esc(estado.seguridad.ultimo_error_r2.fecha || "")})</small></section>` : ""}
    ${estado.modo === "PRACTICA" ? `<section class="aviso-practica"><b>🧪 MODO PRÁCTICA</b> · Documentos de prueba; se limpian al activar la numeración oficial en Ajustes.</section>` : ""}
    ${estado.modo === "REAL" && n.medio_facturacion === "SIN_DEFINIR" && puede("super") ? `<section class="aviso-control" data-destino="#/ajustes">⚠️ Define la <b>modalidad de facturación digital (SNAT/2024/000102)</b> en Ajustes.</section>` : ""}
    <div class="inicio-resumen">
      <section class="tarjeta tasa">
        <div id="tasa-vista">
          <span class="etiqueta">🟢 TASA OFICIAL BCV (ART. 128 LEY BCV)</span><br>
          <strong>${tasa ? `Bs. ${bs(tasa)}` : "Sin definir"}</strong>
          <span class="insignia ${modoTasa === "MANUAL" ? "ambar" : "verde"}" id="tasa-modo-badge" style="margin-left:8px;vertical-align:middle">${modoTasa === "MANUAL" ? "✍️ Manual" : "🔄 Automático BCV"}</span><br>
          <small class="suave">${n.tasa_bcv_fecha ? `Actualizada: ${fechaLocal(n.tasa_bcv_fecha)}` : "Sincroniza o define la tasa en Ajustes"}</small>
        </div>
        ${puede("tasa") ? `<button class="boton chico contorno-azul" type="button" id="tasa-ir-ajustes" data-destino="#/ajustes" data-ayuda="Configurar tasa BCV automática o manual en Ajustes">⚙️ Ajustes</button>` : ""}
      </section>
      ${puede("admin") ? `<section class="tarjeta ganancia" data-destino="#/informes" data-nombre="Informes" data-ayuda="Informes para el contador: ventas, compras, ganancias, por cobrar e inventario"><span class="etiqueta">💰 TU GANANCIA NETA (ESTE MES)</span><strong id="gan-total">$ 0,00</strong>
        <small class="suave" id="gan-det">🟣 Servicios: $0 · 🔵 Productos: $0 · Toca para ver Libros SENIAT</small></section>`
        : puede("informes_contador") ? `<section class="tarjeta ganancia" data-destino="#/informes" data-nombre="Libros SENIAT"><span class="etiqueta">📊 LIBROS CONTABLES (ART. 70 Y 72 RLIVA)</span><strong>Ventas, Compras y Resumen IVA</strong>
        <small class="suave">Descarga en PDF o Excel (CSV).</small></section>` : ""}
    </div>
    <div class="rejilla">
      ${puede("caja") ? `<button class="accion azul" data-destino="#/factura" data-nombre="Factura" data-ayuda="Presupuestos, facturas, notas de crédito y débito"><span>🧾</span>Factura<small>Facturas y presupuestos</small></button>
      <button class="accion ambar" data-destino="#/clientes" data-nombre="Clientes" data-ayuda="Tus clientes, RIF y correo"><span>👥</span>Clientes<small>Tus clientes</small></button>
      <button class="accion verde" data-destino="#/pagos" data-nombre="Pagos" data-ayuda="Por cobrar, pagos recibidos y tus datos de cobro"><span>💳</span>Pagos<small>Cobros y por cobrar</small></button>` : ""}
      ${puede("inventario") ? `<button class="accion morado" data-destino="#/inventario" data-nombre="Inventario" data-ayuda="Tus productos, servicios y compras"><span>📦</span>Inventario<small>Productos y compras</small></button>` : ""}
      ${puede("informes_contador") ? `<button class="accion azul" data-destino="#/informes" data-nombre="Libros SENIAT" data-ayuda="Libros de ventas, compras, resumen IVA, IGTF, ISLR y Cierre Z"><span>📊</span>Libros SENIAT<small>Ventas, compras e IVA</small></button>` : ""}
      ${puede("super") ? `<button class="accion morado" data-destino="#/inquilinos" data-nombre="Inquilinos" data-ayuda="Panel Multi-Tenant para crear y administrar clientes"><span>🏢</span>Inquilinos<small>Empresas afiliadas</small></button>` : ""}
    </div>
    <section class="tarjeta"><span class="etiqueta">🔔 ALERTAS RÁPIDAS</span><p class="suave" id="alertas-txt">Todo en orden ✅</p></section>
    ${navegacion("inicio")}`;
  $("#ajustes").addEventListener("click", () => (location.hash = "#/ajustes"));
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
  const inqActualObj = lista.find((x) => x.codigo === activo) || lista[0] || {};
  const limiteD1 = Number(data.limite_d1 || 10);
  const usadasD1 = Number(data.usadas_d1 || lista.length || 1);
  const libresD1 = Math.max(0, Number(data.libres_d1 ?? (limiteD1 - usadasD1)));
  const txtLimiteD1 = limiteD1.toLocaleString("es-VE");
  const txtLibresD1 = libresD1.toLocaleString("es-VE");
  const esPlan5Usd = data.plan_d1 === "PRO_5USD" || limiteD1 > 10;
  const activasN = lista.filter((x) => x.activo !== 0 && x.activo !== false && x.estado !== "SUSPENDIDO").length;

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
        <button class="accion azul" data-destino="#/inquilinos/empresas" data-nombre="Empresas Afiliadas">
          <span>🏢</span><b>Empresas (${lista.length})</b><small>${activasN} activa(s) · Buscar y gestionar</small>
        </button>
        <button class="accion morado" data-destino="#/inquilinos/cloudflare" data-nombre="Cloudflare D1">
          <span>☁️</span><b id="btn-cf-titulo">Cloudflare D1 (${usadasD1}/${txtLimiteD1})</b><small id="btn-cf-sub">${txtLibresD1} de ${txtLimiteD1} libres · Worker y API</small>
        </button>
        <button class="accion azul" data-destino="#/inquilinos/builds" data-nombre="Despliegues y Builds">
          <span>🚀</span><b id="btn-builds-titulo">Despliegues y Builds</b><small id="btn-builds-sub">Compilaciones, Logs y Rollback</small>
        </button>
        <button class="accion ambar" data-destino="#/inquilinos/salud" data-nombre="Salud BD y Respaldo">
          <span>🩺</span><b>Salud y Respaldos (${lista.length} BD)</b><small>16 candados SENIAT y Backup</small>
        </button>
        <button class="accion azul" data-destino="#/inquilinos/correos" data-nombre="Directorio de Correos">
          <span>📧</span><b>Directorio Correos (${directorio.length})</b><small>${directorio.length} usuario(s) en ${lista.length} empresa(s)</small>
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
        <p class="suave">Al crear la empresa se provisiona automáticamente su base de datos <b>Cloudflare D1</b> dedicada. Solo se piden los datos estrictamente exigidos por el SENIAT y de contacto del dueño. El <b>Logo</b> y las <b>APIs</b> son opcionales.</p>
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

          <hr>
          <span class="etiqueta">3️⃣ DATOS DE CONTACTO Y ACCESO DEL DUEÑO</span>
          ${campo("nombre_dueno", "👤 Nombre Completo del Dueño (Administrador)", "", "text", 'required placeholder="Ej: Nombre y Apellido"')}
          ${campo("cedula_dueno", "🪪 Cédula de Identidad", "", "text", 'required placeholder="Ej: V-12345678"')}
          <div class="dos-botones">
            <div>${campo("telefono", "📞 Teléfono / WhatsApp", "", "tel", 'required placeholder="0414-0000000"')}</div>
            <div>${campo("email_dueno", "✉️ Correo Electrónico (será su usuario)", "", "email", 'required placeholder="dueno@empresa.com"')}</div>
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

          <details style="margin-top:10px">
            <summary style="cursor:pointer;font-weight:600;color:#1A73E8">✉️ Configurar API de Correo Brevo / Resend del Cliente (Opcional ahora · Editable luego)</summary>
            <div style="margin-top:8px;padding:10px;border:1px solid #dadce0;border-radius:10px">
              <label for="correo_proveedor">Proveedor de Correo</label>
              <select id="correo_proveedor" name="correo_proveedor">
                <option value="BREVO" selected>Brevo Free (api.brevo.com · 300 correos/día gratis)</option>
                <option value="RESEND">Resend (api.resend.com)</option>
              </select>
              ${campo("correo_remitente", "✉️ Correo remitente verificado en Brevo", "", "email", 'placeholder="Si lo dejas vacío usa el correo del dueño"')}
              ${campo("correo_nombre", "🏷️ Nombre del remitente", "", "text", 'placeholder="Si lo dejas vacío usa la razón social"')}
              ${campo("correo_clave", "🔑 API Key de Brevo (xkeysib-...) o Resend (re_...)", "", "password", 'autocomplete="off" placeholder="Opcional: puedes colocarla hoy o después en Ajustes"')}
            </div>
          </details>

          <hr>
          <div class="dos-botones">
            <div>
              <label for="modo_inicial">🚀 Modo inicial</label>
              <select id="modo_inicial" name="modo_inicial">
                <option value="REAL" selected>✅ En Vivo (SNAT/2011/0071)</option>
                <option value="PRACTICA">🧪 Modo Práctica (Entrenamiento)</option>
              </select>
            </div>
            <div>${campo("plan_usd", "💵 Mensualidad (USD)", "10", "number", 'min="0" max="999"')}</div>
          </div>
          <p class="pista">📌 Los correlativos iniciales de Factura y Control se fijan al dar de alta el sistema; luego avanzan de forma automática e inmutable según el SENIAT.</p>
          ${ERROR}<button class="boton verde" type="submit">🚀 CREAR BASE DE DATOS D1 Y DAR DE ALTA CLIENTE</button>
        </form>
      </section>`;

    $("#volver-inq").addEventListener("click", () => (location.hash = "#/inquilinos"));
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
      const r = await api("inquilinos", "POST", d);
      const c = r.credenciales || r;
      const corr = c.correlativos_iniciales || {};
      const facIni = String(corr.primer_factura || d.primer_factura || 1).padStart(8, "0");
      const ctrlIni = `00-${String(corr.primer_control || d.primer_control || 1).padStart(8, "0")}`;
      const nombreEmp = c.nombre_negocio || c.nombre_razon_social || d.nombre_negocio || "";
      const msgWa = `Hola ${d.nombre_dueno}, tu sistema *FacturaYa Venezuela* para *${nombreEmp}* (${c.rif}) ya está activo en su base dedicada *${c.codigo}*.\n\n🔗 *Acceso:* ${location.origin}\n✉️ *Usuario:* ${c.email_dueno}\n🔑 *Contraseña temporal:* ${c.clave_temporal}\n🛡️ *Código maestro de respaldo (1 uso):* ${c.codigo_recuperacion}\n🧾 *Correlativo inicial:* Factura N.º ${facIni} · Control N.º ${ctrlIni}\n\nAl ingresar por primera vez el sistema te solicitará definir tu contraseña personal.`;
      $("#credenciales-nuevo").innerHTML = `<section class="tarjeta secreto">
        <div class="reng-cab"><span class="etiqueta">🎉 CLIENTE DADO DE ALTA EN ${esc(c.codigo)} (${esc(c.d1_nombre || `facturaya_${c.codigo.toLowerCase()}`)})</span><span class="insignia verde">Activa</span></div>
        <p class="suave"><b>${esc(nombreEmp)}</b> · Credenciales iniciales del dueño (<b>${esc(c.email_dueno)}</b>):</p>
        <p class="codigo">${esc(c.clave_temporal)}</p>
        <p class="suave">Código maestro (1 uso): <b>${esc(c.codigo_recuperacion)}</b><br>
        🧾 Correlativo inicial SENIAT: <b>Factura N.º ${esc(facIni)}</b> · <b>Control N.º ${esc(ctrlIni)}</b></p>
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
        <div class="reng-cab"><span class="etiqueta">👑 GESTIÓN DE INQUILINOS (${lista.length} EMPRESAS)</span><button type="button" class="boton chico verde" id="ir-alta-btn">➕ Dar de Alta Cliente</button></div>
        <p class="suave">Si un cliente se retrasa 1 mes puedes <b>⏸️ Suspender</b> su facturación. Si cumple 3 meses de mora y decides darlo de baja, el sistema te exige <b>primero descargar su base de datos completa</b> antes de habilitar el borrado definitivo.</p>
        <input type="search" id="emp-buscar" placeholder="🔍 Buscar empresa, RIF, ranura DB_X, dueño o correo…" autocomplete="off">
        <div class="chips">
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
        return `<div class="reng${esActual ? " activo" : ""}">
          <div class="reng-cab">
            <strong>${esPrincipal ? "👑 " : "🏢 "}${esc(inq.nombre_negocio || inq.nombre_razon_social || "Empresa")} <small class="suave">(${esc(inq.rif)})</small></strong>
            <span class="insignia ${susp ? "rojo" : esActual ? "azul" : "verde"}">${susp ? "SUSPENDIDO" : esActual ? "ACTIVO (ACTUAL)" : "ACTIVO"}</span>
          </div>
          <small class="suave">
            ${esPrincipal ? "<b>Tu negocio principal</b> · " : ""}Ranura: <b>${esc(inq.codigo)}</b> · Base D1: <b>${esc(bdTxt)}</b><br>
            Dueño: <b>${esc(inq.nombre_dueno || "—")}</b> ${inq.cedula_dueno ? `(${esc(inq.cedula_dueno)})` : ""} · Correo: <b>${esc(inq.email_dueno || "—")}</b><br>
            Domicilio: ${esc(inq.direccion || "—")}${inq.zona_postal ? ` · Z.P. ${esc(inq.zona_postal)}` : ""}${esPrincipal ? "" : ` · Plan: <b>$ ${Number(inq.plan_usd || 10)}/mes</b>`}
          </small>
          <div class="dos-botones">
            ${esActual
              ? `<button type="button" class="boton chico verde" data-ir-ajustes="1">⚙️ Ir a Ajustes</button>`
              : `<button type="button" class="boton chico" data-cambiar-inq="${esc(inq.codigo)}">🔄 Entrar / Configurar</button>`}
            ${!esPrincipal
              ? `<button type="button" class="boton chico ${susp ? "contorno-azul" : "contorno"}" data-estado-inq="${esc(inq.codigo)}" data-nuevo-estado="${susp ? "ACTIVO" : "SUSPENDIDO"}">${susp ? "▶️ Reactivar servicio" : "⏸️ Suspender facturación"}</button>`
              : ""}
          </div>
          ${!esPrincipal
            ? `<div class="dos-botones">
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
      cont.querySelectorAll("[data-estado-inq]").forEach((b) => b.addEventListener("click", async () => {
        const codigo = b.dataset.estadoInq, nuevo = b.dataset.nuevoEstado;
        await api(`inquilinos/${encodeURIComponent(codigo)}/estado`, "PUT", { activo: nuevo === "ACTIVO", estado: nuevo });
        aviso(`Estado actualizado a ${nuevo} ✅`);
        await vistaInquilinos("empresas");
      }));
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
        <p class="suave">Monitorea tus bases D1 en Cloudflare (<b>10 BD en Plan Gratis</b> o <b>50.000 BD en el Plan Workers Paid de $5/mes</b>), tu Worker y Turnstile sin cambiar una sola línea de código. Las bases D1 nuevas se crean automáticamente al usar <b>➕ Dar de Alta Cliente</b> y se eliminan al dar de baja una empresa.</p>
        <div id="cf-resumen"><p class="suave">Verificando conexión con Cloudflare API…</p></div>
        <div class="dos-botones" style="margin-top:10px">
          <button type="button" class="boton chico contorno-azul" id="cf-refrescar">🔄 Sincronizar Cloudflare</button>
          <button type="button" class="boton chico azul" id="cf-ir-builds">🚀 Ver Builds, Logs y Rollback</button>
        </div>
        <div class="dos-botones" style="margin-top:6px">
          <button type="button" class="boton chico verde" id="cf-ir-alta">➕ Dar de Alta Cliente (Crea su D1)</button>
          <button type="button" class="boton chico contorno-azul" id="cf-generar-toml">⚡ Generar wrangler.toml (Bindings Nativos Pro)</button>
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

  // 4b) Subvista: DESPLIEGUES Y BUILDS CLOUDFLARE (#/inquilinos/builds)
  if (subvista === "builds") {
    raiz.innerHTML = `
      ${barraVolverInq("🚀 Despliegues y Builds")}
      <section class="tarjeta" id="builds-card">
        <div class="reng-cab">
          <h2>🚀 Control de Compilaciones y Despliegues (Cloudflare)</h2>
          <span class="insignia gris" id="builds-badge">Consultando…</span>
        </div>
        <p class="suave">Revisa en vivo si las compilaciones desde GitHub terminaron en <b>Listo</b> o presentaron algún error, inspecciona el log exacto y relanza un build o restaura una versión estable anterior (<i>Rollback</i>).</p>
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
      if (trigBox) {
        trigBox.innerHTML = trigs.length
          ? `<label for="builds-trig-sel">Rama / Trigger conectado</label>
             <select id="builds-trig-sel" name="trigger_uuid">
               ${trigs.map((t) => `<option value="${esc(t.trigger_uuid)}">${esc(t.trigger_name)} (rama: ${esc(t.branch)})</option>`).join("")}
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
        if (manual) aviso(res.configurado ? "Estado de compilaciones actualizado ✅" : "Conecta tu API Token primero.");
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
        const r = await api("inquilinos/cloudflare/builds/reintentar", "POST", {
          trigger_uuid: d.trigger_uuid || "",
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
  const codActivo = estado.inquilino_actual || estado.inquilino_activo || "principal";
  const tasaActual = Number(n.tasa_bcv) || 0;
  const modoTasaActual = n.tasa_bcv_modo === "MANUAL" ? "MANUAL" : "AUTOMATICO";
  const cierreAutoActivo = Number(n.cierre_mensual_correo ?? 1) === 1;
  let logoActual = n.logo_base64 || null;

  raiz.innerHTML = `
    ${barraSuper()}
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver al inicio" aria-label="Volver">←</button><h1>Ajustes</h1></header>
    <section class="tarjeta"><h2>🔑 Mi cuenta</h2><p class="suave">${esc(estado.usuario.nombre)} · ${esc(estado.usuario.rol_nombre)} (${esc(estado.usuario.email)})</p>
      <button class="boton chico contorno" id="cambiar-clave" type="button">Cambiar mi contraseña</button></section>
    ${admin ? `<section class="tarjeta" id="card-2fa">
      <div class="reng-cab"><h2>🛡️ Autenticación en 2 Pasos (2FA · ${superAdmin ? "Súper Admin" : "Administrador"})</h2><span class="insignia gris" id="totp-badge">Consultando…</span></div>
      <p class="suave">Protege tu acceso de ${superAdmin ? "Súper Administrador" : "Dueño / Administrador"} con códigos temporales de 6 dígitos en <b>Google Authenticator</b> o <b>Authy</b> (estándar RFC 6238). Incluye 8 códigos de respaldo de un solo uso y protección contra fuerza bruta.</p>
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
    ${superAdmin ? `<section class="tarjeta">
      <div class="reng-cab"><h2>🏢 Mis Inquilinos / Empresas</h2><span class="insignia azul">Exclusivo Súper Admin</span></div>
      <p class="suave">Empresa activa: <b>${esc(n.nombre_razon_social)} (${esc(codActivo)})</b>. Accede al panel de botones cuadrados para dar de alta clientes, controlar Cloudflare D1, respaldar o dar de baja empresas.</p>
      <button class="boton" id="ir-inquilinos" type="button">🏢 Abrir Menú de Mis Inquilinos</button>
    </section>` : ""}
    ${admin ? `<form id="f" class="tarjeta">
      <div class="reng-cab"><h2>🏷️ Datos Fiscales, RIF SENIAT y Logo</h2><span class="insignia verde">Dueño / Súper Admin</span></div>
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
      <p class="pista">💳 Configura tus cuentas receptoras (Pago Móvil, Transferencia, Zelle, Binance, PayPal) en <b>Pagos → Mis datos</b>. El IGTF (3%) se activa automáticamente al facturar o cobrar en divisas.</p>
      <label class="opcion"><input type="checkbox" id="fiscal-confirmo" required> ☑️ Estoy seguro de guardar o modificar los datos fiscales y de contacto de este negocio (solo Dueño y Súper Admin).</label>
      ${ERROR}<button class="boton verde" type="submit" id="fiscal-guardar-btn" disabled>GUARDAR DATOS FISCALES Y LOGO</button>
    </form>
    <section class="tarjeta"><h2>👥 Usuarios y Empleados</h2><p class="suave">Exclusivo del Dueño: crea usuarios para tus empleados (cajero, supervisor, bodega, contador), cámbiales la contraseña o desactívalos.</p>
      <button class="boton chico" id="usuarios" type="button">Administrar usuarios y claves</button></section>
    ${tarjetaMedio()}
    <section class="tarjeta" id="correo-config">
      <div class="reng-cab"><h2>✉️ Servicio de Correo API (Brevo / Resend) y Cierre Mensual</h2><span class="insignia gris" id="correo-estado">Cargando…</span></div>
      <p class="suave"><b>¿Qué hace esta API?</b> Conecta la cuenta gratuita de <b>Brevo</b> (o Resend) del negocio (<b>${esc(n.nombre_razon_social)}</b>) para enviar facturas, notas y recibos en PDF a tus clientes, además de despachar automáticamente los <b>Libros Contables SENIAT en Excel (CSV)</b> al inicio de cada mes al correo del Administrador y Contador.</p>
      <label class="opcion" style="margin-bottom:12px">
        <input type="checkbox" id="cierre-mensual-chk" ${cierreAutoActivo ? "checked" : ""}>
        📊 Enviar automáticamente el Cierre Contable Mensual (Libros de Ventas, Compras, IVA, IGTF e ISLR en CSV) al inicio de cada mes al Administrador y Contador${n.ultimo_cierre_correo ? ` <small class="suave">(último enviado: ${esc(n.ultimo_cierre_correo)})</small>` : ""}.
      </label>
      <form id="correo-cfg-form">
        <label for="correo_prov">Proveedor HTTP</label>
        <select id="correo_prov" name="proveedor">
          <option value="BREVO">Brevo (api.brevo.com · 300/día gratis)</option>
          <option value="RESEND">Resend (api.resend.com)</option>
        </select>
        ${campo("correo_rem", "✉️ Correo remitente verificado", n.email || "", "email", 'required placeholder="facturacion@negocio.com"')}
        ${campo("correo_nom", "🏷️ Nombre del remitente", n.nombre_razon_social || "", "text", 'placeholder="Mi Negocio · FacturaYa"')}
        ${campo("correo_key", "🔑 API Key (xkeysib-... o re_...)", "", "password", 'autocomplete="off" placeholder="xkeysib-xxxxxxxxx"')}
        <small class="suave" id="correo-key-pista"></small>
        ${campo("correo_pass", "🔒 Tu contraseña (Dueño o Súper Admin)", "", "password", 'required autocomplete="current-password"')}
        <label class="opcion"><input type="checkbox" id="correo-confirmo" required> ☑️ Estoy seguro de guardar o modificar la API de Correo de este negocio.</label>
        ${ERROR}<button class="boton" type="submit" id="correo-guardar-btn" disabled>GUARDAR API DE CORREO</button>
      </form>
      <button class="boton chico contorno-azul" id="correo-probar" type="button">📨 Enviar correo de prueba</button>
    </section>
    ${formularioCodigo()}
    <section class="tarjeta"><h2>💾 Respaldo Online de mi Base de Datos</h2><p class="suave">Exclusivo del Dueño: descarga en cualquier momento una copia completa y verificada de tu base de datos (clientes, inventario, facturas, notas de crédito/débito y cobros) para tu resguardo. <b>Nota:</b> Ningún usuario puede borrar facturas ni eliminar la base de datos.</p>
      <button class="boton" id="respaldo" type="button">⬇️ Descargar respaldo completo (.json)</button></section>
    ${tarjetaRestaurar()}
    ${estado.modo === "PRACTICA" ? `<section class="tarjeta"><h2>🧪 Pasar a En Vivo (SNAT/2011/0071)</h2>
      <p class="suave">Limpia los documentos de prueba e inicia la numeración correlativa oficial desde 00000001. Los números iniciales de Factura y Control solo se definen esta única vez.</p>
      <form id="vivo">
        ${campo("primer_factura", "🧾 Primer N.º de factura (1 = 00000001)", "1", "text", 'inputmode="numeric" required')}
        ${campo("primer_nota_credito", "↩️ Primer N.º de nota de crédito (1 = NC-00000001)", "1", "text", 'inputmode="numeric" required')}
        ${campo("primer_nota_debito", "📈 Primer N.º de nota de débito (1 = ND-00000001)", "1", "text", 'inputmode="numeric" required')}
        ${campo("primer_control", "🔢 Primer N.º de control (1 = 00-00000001)", "1", "text", 'inputmode="numeric" required')}
        ${campo("primer_presupuesto", "📋 Primer N.º de presupuesto (1 = P-000001)", "1", "text", 'inputmode="numeric" required')}
        ${campo("primer_recibo", "💵 Primer N.º de recibo (1 = 00000001)", "1", "text", 'inputmode="numeric" required')}
        <label class="opcion"><input type="checkbox" name="confirmo"> Confirmo limpiar las pruebas e iniciar la numeración oficial.</label>
        ${ERROR}<button class="boton rojo" type="submit">ACTIVAR NUMERACIÓN EN VIVO</button></form></section>`
      : `<section class="tarjeta"><h2>✅ En Vivo (Providencia SNAT/2011/0071)</h2><p class="suave">Numeración correlativa fiscal activa e inmutable integrada al Libro de Ventas (Art. 72 RLIVA).</p></section>`}
    ${superAdmin ? `<section class="tarjeta">
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
    <button class="boton contorno" id="salir">Cerrar sesión</button>`;

  $("#atras").addEventListener("click", () => (location.hash = "#/inicio"));
  $("#ir-inquilinos")?.addEventListener("click", () => (location.hash = "#/inquilinos"));
  raiz.querySelectorAll(".barra-super [data-destino]").forEach((b) => b.addEventListener("click", () => (location.hash = b.dataset.destino)));
  $("#cambiar-clave").addEventListener("click", () => vistaCambiarClave(estado, { forzado: false, alTerminar: () => { if (location.hash !== "#/ajustes") location.hash = "#/ajustes"; return ruta(); } }));
  $("#salir").addEventListener("click", async () => { await api("logout", "POST"); history.replaceState(null, "", "/"); await ruta(); });

  if (admin) {
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
  $("#correo-confirmo")?.addEventListener("change", () => {
    $("#correo-guardar-btn").disabled = !$("#correo-confirmo").checked;
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

  $("#usuarios").addEventListener("click", () => (location.hash = "#/usuarios"));
  enlazarCodigo(ruta);
  enlazarMedio(ruta).catch((e) => aviso(e.message));
  api("sistema/correo").then((cfg) => {
    if (!$("#correo_prov")) return;
    $("#correo_prov").value = cfg.proveedor || "BREVO";
    if (cfg.remitente) $("#correo_rem").value = cfg.remitente;
    if (cfg.nombre_remitente) $("#correo_nom").value = cfg.nombre_remitente;
    const est = $("#correo-estado");
    est.textContent = cfg.clave_configurada ? `Activo · ${cfg.proveedor}` : "Sin configurar";
    est.className = `insignia ${cfg.clave_configurada ? "verde" : "gris"}`;
    $("#correo-key-pista").textContent = cfg.clave_configurada ? `API Key guardada (termina en …${cfg.clave_final}). Déjala en blanco para conservarla.` : "Aún no has guardado una API Key para este negocio.";
  }).catch(() => {});
  enviar($("#correo-cfg-form"), async (d) => {
    const cfg = await api("sistema/correo", "POST", {
      proveedor: d.proveedor,
      remitente: d.correo_rem,
      nombre_remitente: d.correo_nom,
      clave: d.correo_key,
      password: d.correo_pass,
      confirmo: $("#correo-confirmo")?.checked,
    });
    const est = $("#correo-estado");
    est.textContent = cfg.clave_configurada ? `Activo · ${cfg.proveedor}` : "Sin configurar";
    est.className = `insignia ${cfg.clave_configurada ? "verde" : "gris"}`;
    $("#correo_key").value = "";
    $("#correo_pass").value = "";
    $("#correo-confirmo").checked = false;
    $("#correo-guardar-btn").disabled = true;
    $("#correo-key-pista").textContent = cfg.clave_configurada ? `API Key guardada (termina en …${cfg.clave_final}). Déjala en blanco para conservarla.` : "";
    aviso("Configuración de correo guardada ✅");
  });
  $("#correo-probar")?.addEventListener("click", async () => {
    try {
      const r = await api("sistema/correo/probar", "POST", { para: estado.usuario.email });
      aviso(`Correo de prueba enviado a ${r.destino} ✅`);
    } catch (e) {
      aviso(e.message);
    }
  });
  $("#restaurar-ir").addEventListener("click", () => (location.hash = "#/restaurar"));
  enviar($("#f"), async (d) => {
    d.logo_base64 = logoActual ?? "";
    d.confirmo_fiscal = $("#fiscal-confirmo")?.checked;
    await api("config", "PUT", d);
    aviso("Datos fiscales y logo guardados ✅");
    location.hash = "#/inicio";
  });
  if ($("#vivo")) enviar($("#vivo"), async (d) => {
    await api("sistema/salir-en-vivo", "POST", {
      primer_factura: Number(d.primer_factura),
      primer_nota_credito: Number(d.primer_nota_credito || 1),
      primer_nota_debito: Number(d.primer_nota_debito || 1),
      primer_control: Number(d.primer_control),
      primer_presupuesto: Number(d.primer_presupuesto),
      primer_recibo: Number(d.primer_recibo),
      confirmo: d.confirmo === "on",
    });
    aviso("El sistema está en vivo ✅"); await ruta();
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
  $("#respaldo").addEventListener("click", async () => {
    try {
      const r = await fetch("/api/sistema/respaldo"); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "No se pudo descargar el respaldo.");
      const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `respaldo-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000); aviso("Respaldo descargado ✅");
    } catch (e) { aviso(e.message); }
  });
}

async function ruta() {
  document.body.classList.remove("modo-portada");
  window.scrollTo(0, 0);
  try {
    estado = await api("estado");
    if (!estado.instalado) return vistaInstalar();
    if (!estado.sesion) return vistaLogin();
    fijarPermisos(estado.permisos);
    if (estado.restaurando && !puede("admin")) return pantallaOcupado(ruta);
    if (estado.usuario.debe_cambiar_clave) return vistaCambiarClave(estado, { forzado: true, alTerminar: ruta });
    const [seccion, id, extra] = location.hash.replace(/^#\/?/, "").split("/");
    if (estado.restaurando && seccion !== "restaurar") return vistaRestaurar(estado, ruta);
    if (seccion === "restaurar") return puede("admin") ? vistaRestaurar(estado, ruta) : vistaInicio();
    if (seccion === "inquilinos") return puede("super") ? await vistaInquilinos(id) : vistaInicio();
    if (seccion === "ajustes") return vistaAjustes();
    if (seccion === "usuarios") return puede("admin") ? await vistaUsuarios(estado) : vistaInicio();
    if (seccion === "clientes") return await vistaClientes(estado, id);
    if (seccion === "factura") return await vistaFactura(estado, id, extra);
    if (seccion === "pagos") return await vistaPagos(estado, id, extra);
    if (seccion === "compras") return await vistaCompras(estado, id);
    if (seccion === "proveedores") return await vistaProveedores(estado, id);
    if (seccion === "existencias") return await vistaExistencias(estado, id);
    if (seccion === "informes") return await vistaInformes(estado, id);
    if (seccion === "inventario" || seccion === "catalogo") return await vistaCatalogo(estado, id);
    vistaInicio();
  } catch (e) {
    raiz.innerHTML = `<section class="tarjeta"><h1>⚠️ No se pudo cargar</h1><p class="error">${esc(e.message)}</p><button class="boton" id="reintentar">Reintentar</button></section>`;
    $("#reintentar").addEventListener("click", ruta);
  }
}
window.addEventListener("hashchange", ruta);
ruta();

