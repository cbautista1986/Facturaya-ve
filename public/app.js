// Entrada de la aplicación: instalador, login, inicio, ajustes y panel Multi-Tenant Súper Admin.
import { $, raiz, esc, bs, usd, fechaLocal, api, aviso, campo, enviar, navegacion, activar, fijarPermisos, puede, ERROR } from "./comun.js";
import { tarjetaRestaurar, vistaRestaurar, pantallaOcupado } from "./restaurar.js";
import { tarjetaMedio, enlazarMedio } from "./medio.js";
import { pantallaCodigo, vistaRecuperar, vistaCambiarClave, vistaUsuarios, formularioCodigo, enlazarCodigo } from "./usuarios.js";
import { vistaClientes } from "./clientes.js";
import { vistaCatalogo } from "./catalogo.js";
import { vistaFactura } from "./factura.js";
import { vistaPagos } from "./pagos.js";
import { vistaCompras, vistaProveedores, vistaExistencias } from "./compras.js";
import { vistaInformes } from "./informes.js";

const NEGOCIO = [
  ["nombre_razon_social", "🏷️ Nombre o razón social"], ["rif", "🪪 RIF fiscal (ej: V-18529773-6 o J-12345678-9)"], ["direccion_fiscal", "📍 Dirección fiscal"],
  ["telefono", "📞 Teléfono"], ["email", "✉️ Correo del negocio"],
];
let estado = {};

const esEntornoPreview = location.hostname.endsWith(".run.app") || location.hostname === "localhost" || location.hostname === "127.0.0.1";
const TARJETA_GITHUB_ZIP = esEntornoPreview ? `<section class="tarjeta"><span class="etiqueta">📦 DESCARGA CON NOMBRE Y EXTENSIÓN EXACTOS (GITHUB / CLOUDFLARE)</span>
  <p class="suave">Pulsa el botón verde para descargar el proyecto completo listo para GitHub, o descarga cada archivo individual con su nombre y extensión exactos:</p>
  <button type="button" class="boton verde" data-dl-cf="facturaya-ve-github.zip">⬇️ Descargar todo: facturaya-ve-github.zip</button>
  <div class="dos-botones">
    <button type="button" class="boton chico contorno-azul" data-dl-cf="inquilinos.ts">⬇️ src/inquilinos.ts</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="rutas-inquilinos.ts">⬇️ src/rutas/inquilinos.ts</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="index.ts">⬇️ src/index.ts</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="permisos.ts">⬇️ src/permisos.ts</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="sistema.ts">⬇️ src/rutas/sistema.ts</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="documentos.ts">⬇️ src/rutas/documentos.ts</button>
  </div>
  <div class="dos-botones">
    <button type="button" class="boton chico contorno-azul" data-dl-cf="pdf.js">⬇️ public/pdf.js</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="app.js">⬇️ public/app.js</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="estilos.css">⬇️ public/estilos.css</button>
    <button type="button" class="boton chico contorno-azul" data-dl-cf="README.md">⬇️ README.md</button>
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
  const cod = estado.inquilino_activo || "principal";
  return `<div class="barra-super">
    <div><small>👑 MODO SÚPER ADMIN · VIENDO NEGOCIO:</small><b>🏢 ${esc(estado.negocio?.nombre_razon_social || "Principal")} (${esc(cod)})</b></div>
    <button type="button" class="boton chico" data-destino="#/inquilinos">Mis Inquilinos</button>
  </div>`;
}

function vistaInstalar() {
  raiz.innerHTML = `<section class="tarjeta"><h1>🛡️ Bienvenido a FacturaYa Venezuela</h1>
    <p class="suave">Crea la cuenta principal del negocio y elige tu modalidad de facturación digital SENIAT. Esta pantalla se bloquea automáticamente después.</p>
    <form id="f">
      ${campo("nombre", "👤 Nombre de tu negocio o personal", "", "text", 'required autocomplete="organization"')}
      ${campo("rif", "🪪 RIF fiscal (ej: V-18529773-6 o J-12345678-9)", "", "text", 'required placeholder="V-18529773-6 o J-12345678-9"')}
      ${campo("direccion", "📍 Dirección fiscal", "", "text", 'required autocomplete="street-address"')}
      ${campo("telefono", "📞 Teléfono", "", "tel", 'autocomplete="tel"')}
      ${campo("email", "✉️ Tu correo (será tu usuario)", "", "email", 'required autocomplete="username"')}
      <label for="medio_facturacion">🧾 Modalidad de facturación digital</label>
      <select id="medio_facturacion" name="medio_facturacion">
        <option value="APP_SENIAT" selected>📱 Aplicación Digital SENIAT (Gratuita)</option>
        <option value="IMPRENTA_DIGITAL">🌐 Imprenta Digital Autorizada (API)</option>
      </select>
      ${campo("clave", "🔒 Contraseña (mínimo 10 caracteres)", "", "password", 'required minlength="10" autocomplete="new-password"')}
      ${ERROR}<button class="boton" type="submit">CREAR SISTEMA Y ENTRAR ➔</button>
    </form></section>${TARJETA_GITHUB_ZIP}`;
  enviar($("#f"), async (d) => { const r = await api("instalar", "POST", d); pantallaCodigo(r.codigo_recuperacion, { alContinuar: ruta }); });
}

function vistaLogin() {
  raiz.innerHTML = `
    <section class="tarjeta hero-login">
      <span class="etiqueta">🇻🇪 FACTURAYA VENEZUELA · FACTURACIÓN Y CONTABILIDAD AL DÍA</span>
      <h1>Tu negocio en regla con el SENIAT desde tu celular o computadora</h1>
      <p class="suave">Diseñado para comercios, tiendas, profesionales, clínicas y emprendedores en Venezuela. Sin máquinas fiscales costosas ni complicaciones.</p>
      <div class="beneficios-lista">
        <div class="beneficio-item"><span>🧾</span><div><strong>Facturas, Presupuestos y Notas de Crédito con tu Logo</strong>Envía comprobantes impecables en PDF por WhatsApp o Correo Electrónico en segundos.</div></div>
        <div class="beneficio-item"><span>💱</span><div><strong>Bimoneda BCV + IGTF (3%) Automático</strong>Trabaja en Dólares y Bolívares a la tasa del día sin sacar cuentas manuales.</div></div>
        <div class="beneficio-item"><span>📊</span><div><strong>Libros Contables Listos para tu Contador</strong>Libro de Ventas, Libro de Compras y Resumen de IVA en Bolívares listos en 1 clic.</div></div>
        <div class="beneficio-item"><span>📱</span><div><strong>Compatible con App Gratis SENIAT e Imprenta Digital</strong>Úsalo con la aplicación gratuita del SENIAT o conectado directo a tu Imprenta Digital.</div></div>
      </div>
    </section>
    <section class="tarjeta">
      <h2>🔐 Ingresa a tu Negocio</h2>
      <p class="suave">Escribe tu correo y contraseña para entrar al panel privado de tu empresa.</p>
      <form id="f">
        ${campo("email", "✉️ Correo electrónico", "", "email", 'required autocomplete="username" placeholder="tucorreo@empresa.com"')}
        ${campo("clave", "🔒 Contraseña", "", "password", 'required autocomplete="current-password"')}
        ${ERROR}<button class="boton" type="submit">ENTRAR A MI NEGOCIO ➔</button>
      </form>
      <button class="boton contorno" id="olvide" type="button">¿Olvidaste tu contraseña? Recíbela en el correo del Dueño</button>
    </section>${TARJETA_GITHUB_ZIP}`;
  $("#olvide").addEventListener("click", () => vistaRecuperar(vistaLogin));
  enviar($("#f"), async (d) => { await api("login", "POST", d); await ruta(); });
}

function vistaInicio() {
  const n = estado.negocio, tasa = Number(n.tasa_bcv) || 0;
  raiz.innerHTML = `
    ${barraSuper()}
    <header class="encabezado">${logoHeader(n)}<h1>Hola, ${esc(n.nombre_razon_social)}</h1>
      <button class="icono" id="ajustes" data-ayuda="Ajustes del negocio, datos de cobro y cerrar sesión" aria-label="Ajustes">⚙️</button></header>
    ${estado.modo === "PRACTICA" ? `<section class="aviso-practica"><b>🧪 MODO PRÁCTICA</b> · los documentos son de prueba y se borran al salir en vivo (Ajustes).</section>` : ""}
    ${estado.modo === "REAL" && estado.negocio.medio_facturacion === "SIN_DEFINIR" && puede("super") ? `<section class="aviso-control" data-destino="#/ajustes">⚠️ Elige la <b>modalidad de facturación digital</b> (App SENIAT o Imprenta Digital) en Ajustes.</section>` : ""}
    <section class="tarjeta tasa">
      <div id="tasa-vista"><span class="etiqueta">🟢 TASA BCV</span><br><strong>${tasa ? `Bs. ${bs(tasa)}` : "Sin definir"}</strong><br>
        <small class="suave">${n.tasa_bcv_fecha ? `Actualizada: ${fechaLocal(n.tasa_bcv_fecha)}` : "Escribe la tasa de hoy"}</small></div>
      ${puede("tasa") ? `<button class="boton chico verde" id="tasa-editar" data-ayuda="Cambia la tasa BCV del día">🔄 Actualizar</button>` : ""}
      <form id="tasa-form" hidden><span class="etiqueta">🟢 TASA BCV DE HOY (Bs por USD)</span>
        <input name="tasa_bcv" inputmode="decimal" placeholder="Ej: 123,45" required aria-label="Tasa BCV">
        <button class="boton chico verde" type="submit">Guardar</button>
        <button class="boton chico contorno" type="button" id="tasa-cancelar" aria-label="Cancelar">✕</button>${ERROR}</form>
    </section>
    ${puede("admin") ? `<section class="tarjeta ganancia" data-destino="#/informes" data-nombre="Informes" data-ayuda="Informes para el contador: ventas, compras, ganancias, por cobrar e inventario"><span class="etiqueta">💰 TU GANANCIA NETA (ESTE MES)</span><strong id="gan-total">$ 0,00</strong>
      <small class="suave" id="gan-det">🟣 Servicios: $0 · 🔵 Productos: $0 · Toca para ver Libros SENIAT</small></section>`
      : puede("informes_contador") ? `<section class="tarjeta ganancia" data-destino="#/informes" data-nombre="Libros SENIAT"><span class="etiqueta">📊 MÓDULO CONTABLE SENIAT</span><strong>Libros de Ventas, Compras e IVA</strong>
      <small class="suave">Toca aquí para consultar e imprimir los libros en PDF o exportar a Excel (CSV).</small></section>` : ""}
    <div class="rejilla">
      ${puede("caja") ? `<button class="accion azul" data-destino="#/factura" data-nombre="Factura" data-ayuda="Presupuestos, facturas y notas de crédito"><span>🧾</span>Factura<small>Facturas y presupuestos</small></button>
      <button class="accion ambar" data-destino="#/clientes" data-nombre="Clientes" data-ayuda="Tus clientes, RIF y correo"><span>👥</span>Clientes<small>Tus clientes</small></button>
      <button class="accion verde" data-destino="#/pagos" data-nombre="Pagos" data-ayuda="Por cobrar, pagos recibidos y tus datos de cobro"><span>💳</span>Pagos<small>Cobros y por cobrar</small></button>` : ""}
      ${puede("inventario") ? `<button class="accion morado" data-destino="#/inventario" data-nombre="Inventario" data-ayuda="Tus productos, servicios y compras"><span>📦</span>Inventario<small>Productos y compras</small></button>` : ""}
      ${puede("informes_contador") ? `<button class="accion azul" data-destino="#/informes" data-nombre="Libros SENIAT" data-ayuda="Libros de ventas, compras, resumen IVA e inventario"><span>📊</span>Libros SENIAT<small>Ventas, compras e IVA</small></button>` : ""}
      ${puede("super") ? `<button class="accion morado" data-destino="#/inquilinos" data-nombre="Inquilinos" data-ayuda="Panel Multi-Tenant para crear y administrar clientes ($10/mes)"><span>🏢</span>Inquilinos<small>Clientes SaaS ($10/mes)</small></button>` : ""}
    </div>
    <section class="tarjeta"><span class="etiqueta">🔔 ALERTAS RÁPIDAS</span><p class="suave" id="alertas-txt">Todo en orden ✅</p></section>
    ${navegacion("inicio")}`;
  $("#ajustes").addEventListener("click", () => (location.hash = "#/ajustes"));
  const editando = (si) => { $("#tasa-vista").hidden = si; $("#tasa-editar").hidden = si; $("#tasa-form").hidden = !si; if (si) $("#tasa-form input").focus(); };
  $("#tasa-editar")?.addEventListener("click", () => editando(true));
  $("#tasa-cancelar").addEventListener("click", () => editando(false));
  enviar($("#tasa-form"), async (d) => { await api("config", "PUT", { tasa_bcv: d.tasa_bcv }); aviso("Tasa actualizada ✅"); await ruta(); });
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

// ---------------------------------------------------------------- Panel Multi-Tenant Exclusivo de Cristian (SUPER_ADMIN)
async function vistaInquilinos() {
  if (!puede("super")) return vistaInicio();
  const data = await api("inquilinos");
  const lista = data.inquilinos || [];
  const activo = data.inquilino_activo || "principal";

  raiz.innerHTML = `
    <header class="encabezado"><button class="icono" id="atras" aria-label="Volver">←</button><h1>🏢 Mis Inquilinos / Empresas</h1></header>
    <section class="tarjeta">
      <div class="reng-cab"><span class="etiqueta">👑 PANEL MULTI-TENANT · EXCLUSIVO SÚPER ADMIN</span><span class="insignia verde">${lista.length} empresa(s)</span></div>
      <p class="suave">Cada cliente tiene su propia base de datos aislada (tablas privadas en D1 sin tocar Cloudflare). Entra a cualquier empresa para configurar su API de Brevo o Imprenta Digital, o suspéndela si está pendiente de pago.</p>
      <div class="lista" id="lista-inq">
        ${lista.map((inq) => {
          const esActual = inq.codigo === activo;
          const susp = inq.estado === "SUSPENDIDO";
          return `<div class="reng" style="${esActual ? "border:2px solid var(--azul)" : ""}">
            <div class="reng-cab">
              <strong>${esc(inq.nombre_razon_social)} <small class="suave">(${esc(inq.rif)})</small></strong>
              <span class="insignia ${susp ? "rojo" : esActual ? "azul" : "verde"}">${susp ? "SUSPENDIDO" : esActual ? "ACTIVO (VIENDO AHORA)" : "ACTIVO"}</span>
            </div>
            <small class="suave">
              Código: <b>${esc(inq.codigo)}</b> · Dueño: <b>${esc(inq.email_dueno || "—")}</b> · Plan: <b>$ ${Number(inq.plan_usd || 10)}/mes</b>
            </small>
            <div class="dos-botones">
              ${esActual
                ? `<button type="button" class="boton chico verde" data-ir-ajustes="1">⚙️ Ir a Ajustes de este negocio</button>`
                : `<button type="button" class="boton chico" data-cambiar-inq="${esc(inq.codigo)}">🔄 Entrar a configurar este negocio</button>`}
              ${inq.codigo !== "principal"
                ? `<button type="button" class="boton chico ${susp ? "contorno-azul" : "contorno"}" data-estado-inq="${esc(inq.codigo)}" data-nuevo-estado="${susp ? "ACTIVO" : "SUSPENDIDO"}">${susp ? "▶️ Reactivar servicio" : "⏸️ Suspender servicio"}</button>`
                : ""}
            </div>
          </div>`;
        }).join("")}
      </div>
    </section>

    <div id="credenciales-nuevo"></div>

    <section class="tarjeta">
      <h2>➕ Dar de alta Nuevo Cliente / Inquilino (Una sola vez)</h2>
      <p class="suave">Registra aquí los datos iniciales de tu nuevo cliente y el <b>correo principal del dueño</b>. El sistema creará su bóveda privada aislada al instante sin abrir Cloudflare.</p>
      <form id="form-nuevo-inq">
        ${campo("nombre_razon_social", "🏷️ Nombre o razón social de la empresa", "", "text", 'required placeholder="Ej: Inversiones Los Andes C.A."')}
        ${campo("rif", "🪪 RIF fiscal del cliente (ej: J-12345678-9 o V-12345678-9)", "", "text", 'required placeholder="J-12345678-9"')}
        ${campo("direccion_fiscal", "📍 Dirección fiscal", "", "text", 'required placeholder="Av. Principal, Local 4, Caracas"')}
        ${campo("telefono", "📞 Teléfono del negocio", "", "tel", 'placeholder="0414-1234567"')}
        ${campo("nombre_dueno", "👤 Nombre y apellido del Dueño (Administrador)", "", "text", 'required placeholder="Ej: Carlos Pérez"')}
        ${campo("email_dueno", "✉️ Correo principal del Dueño (será su usuario de acceso)", "", "email", 'required placeholder="dueno@empresa.com"')}
        <label for="medio_facturacion">🧾 Modalidad de facturación con la que trabajará</label>
        <select id="medio_facturacion" name="medio_facturacion">
          <option value="APP_SENIAT" selected>📱 Aplicación Gratuita del SENIAT (Replica facturas manualmente)</option>
          <option value="IMPRENTA_DIGITAL">🌐 Imprenta Digital Autorizada (Conectarás su API luego)</option>
        </select>
        <label for="modo_inicial">🚀 Modo inicial de sus correlativos</label>
        <select id="modo_inicial" name="modo_inicial">
          <option value="REAL" selected>✅ En Vivo desde 00000001 (Listo para facturar legalmente)</option>
          <option value="PRACTICA">🧪 Modo Práctica (Con marca de agua para entrenar primero)</option>
        </select>
        ${campo("plan_usd", "💵 Mensualidad acordada (USD/mes)", "10", "number", 'min="0" max="999"')}
        ${ERROR}<button class="boton verde" type="submit">🚀 CREAR CLIENTE Y GENERAR ACCESOS</button>
      </form>
    </section>`;

  $("#atras").addEventListener("click", () => (location.hash = "#/inicio"));
  raiz.querySelectorAll("[data-ir-ajustes]").forEach((b) => b.addEventListener("click", () => (location.hash = "#/ajustes")));
  raiz.querySelectorAll("[data-cambiar-inq]").forEach((b) => b.addEventListener("click", async () => {
    const codigo = b.dataset.cambiarInq;
    await api("inquilinos/cambiar", "POST", { codigo });
    aviso(`Ahora estás viendo y configurando: ${codigo} ✅`);
    await ruta();
  }));
  raiz.querySelectorAll("[data-estado-inq]").forEach((b) => b.addEventListener("click", async () => {
    const codigo = b.dataset.estadoInq, nuevo = b.dataset.nuevoEstado;
    await api(`inquilinos/${encodeURIComponent(codigo)}/estado`, "PUT", { estado: nuevo });
    aviso(`Estado actualizado a ${nuevo} ✅`);
    await vistaInquilinos();
  }));

  enviar($("#form-nuevo-inq"), async (d) => {
    const r = await api("inquilinos", "POST", d);
    const c = r.credenciales;
    const msgWa = `Hola ${d.nombre_dueno}, tu sistema *FacturaYa Venezuela* para *${c.nombre_razon_social}* (${c.rif}) ya está activo.\n\n🔗 *Acceso:* ${location.origin}\n✉️ *Usuario:* ${c.email_dueno}\n🔑 *Contraseña temporal:* ${c.clave_temporal}\n🛡️ *Código maestro de respaldo (1 uso):* ${c.codigo_recuperacion}\n\nAl entrar por primera vez el sistema te pedirá elegir tu propia contraseña personal.`;
    $("#credenciales-nuevo").innerHTML = `<section class="tarjeta secreto">
      <div class="reng-cab"><span class="etiqueta">🎉 CLIENTE CREADO CON ÉXITO (${esc(c.codigo)})</span><span class="insignia verde">Base Aislada Lista</span></div>
      <p class="suave">Envíale estos datos de acceso al dueño (<b>${esc(c.email_dueno)}</b>). Al entrar, el sistema le pedirá cambiar la clave temporal:</p>
      <p class="codigo">${esc(c.clave_temporal)}</p>
      <p class="suave">Código maestro de recuperación del dueño (1 uso): <b>${esc(c.codigo_recuperacion)}</b></p>
      <div class="dos-botones">
        <button type="button" class="boton verde" id="copiar-acc">📋 Copiar bienvenida para WhatsApp</button>
        <button type="button" class="boton" id="entrar-nuevo">⚙️ Entrar a configurar su Brevo / Imprenta</button>
      </div>
    </section>`;
    $("#copiar-acc").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(msgWa); aviso("Mensaje de bienvenida copiado 📋"); } catch { aviso("Copia manualmente los datos en pantalla."); }
    });
    $("#entrar-nuevo").addEventListener("click", async () => {
      await api("inquilinos/cambiar", "POST", { codigo: c.codigo });
      location.hash = "#/ajustes";
    });
    $("#form-nuevo-inq").reset();
    aviso("Nuevo inquilino creado ✅");
  });
}

function vistaAjustes() {
  const n = estado.negocio, admin = puede("admin"), superAdmin = puede("super");
  let logoActual = n.logo_base64 || null;

  raiz.innerHTML = `
    ${barraSuper()}
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver al inicio" aria-label="Volver">←</button><h1>Ajustes</h1></header>
    <section class="tarjeta"><h2>🔑 Mi cuenta</h2><p class="suave">${esc(estado.usuario.nombre)} · ${esc(estado.usuario.rol_nombre)}<br>${esc(estado.usuario.email)}</p>
      <button class="boton chico contorno" id="cambiar-clave" type="button">Cambiar mi contraseña</button></section>
    ${superAdmin ? `<section class="tarjeta">
      <div class="reng-cab"><h2>🏢 Mis Inquilinos / Empresas ($10/mes)</h2><span class="insignia azul">Exclusivo Súper Admin</span></div>
      <p class="suave">Estás configurando actualmente: <b>${esc(n.nombre_razon_social)} (${esc(estado.inquilino_activo || "principal")})</b>. Desde tu panel puedes registrar nuevos clientes, cambiar de empresa para conectar sus APIs o suspender morosos.</p>
      <button class="boton" id="ir-inquilinos" type="button">🏢 Administrar Inquilinos / Crear Nuevo Cliente</button>
    </section>` : ""}
    ${admin ? `<form id="f" class="tarjeta">
      <h2>🏷️ Datos Fiscales y Logo de la Empresa</h2>
      <label>🖼️ Logo del negocio (sale en todas tus Facturas, Presupuestos, Recibos y Libros PDF)</label>
      <div class="logo-caja">
        <div class="logo-preview" id="logo-vista">${logoActual ? `<img src="${esc(logoActual)}" alt="Logo">` : `<span class="suave">Sin logo</span>`}</div>
        <div style="flex:1;min-width:0">
          <input type="file" id="logo-archivo" accept="image/png,image/jpeg,image/webp">
          <button type="button" class="boton chico contorno" id="logo-quitar" ${logoActual ? "" : "hidden"}>Quitar logo</button>
        </div>
      </div>
      ${NEGOCIO.map(([id, et]) => campo(id, et, n[id])).join("")}
      <label class="conmutador" for="igtf_activo">
        <span class="conmutador-txt"><span>💱 Activar IGTF (3%) por defecto</span><small>Se aplicará al crear nuevas facturas; puedes encenderlo o apagarlo en cada factura.</small></span>
        <span class="switch"><input type="checkbox" role="switch" id="igtf_activo" name="igtf_activo" ${n.igtf_activo ? "checked" : ""}><span class="switch-pista" aria-hidden="true"></span></span>
      </label>
      <p class="pista">💳 Tus datos de cobro (pago móvil, Zelle, etc.) se configuran en <b>Pagos → Mis datos</b>.</p>
      ${ERROR}<button class="boton verde" type="submit">GUARDAR DATOS Y LOGO</button>
    </form>
    <section class="tarjeta"><h2>👥 Usuarios y Roles</h2><p class="suave">Crea cuentas para tu personal (cajero, supervisor, bodega, contador), cambia sus permisos o restablece sus claves.</p>
      <button class="boton chico" id="usuarios" type="button">Administrar usuarios</button></section>
    ${superAdmin ? `
    ${tarjetaMedio()}
    <section class="tarjeta" id="correo-config">
      <div class="reng-cab"><h2>✉️ Servicio de Correo API (Brevo / Resend)</h2><span class="insignia gris" id="correo-estado">Cargando…</span></div>
      <p class="suave"><b>Exclusivo Súper Admin:</b> Conecta aquí la API de <b>Brevo</b> (9.000 correos gratis/mes) o <b>Resend</b> de este inquilino (<b>${esc(n.nombre_razon_social)}</b>). No se mezcla con los demás clientes.</p>
      <form id="correo-cfg-form">
        <label for="correo_prov">Proveedor de correo HTTP</label>
        <select id="correo_prov" name="proveedor">
          <option value="BREVO">Brevo / Sendinblue (api.brevo.com · 300 correos gratis/día)</option>
          <option value="RESEND">Resend (api.resend.com)</option>
        </select>
        ${campo("correo_rem", "✉️ Correo remitente verificado en Brevo/Resend", n.email || "", "email", 'required placeholder="facturacion@negocio.com"')}
        ${campo("correo_nom", "🏷️ Nombre visible del remitente", n.nombre_razon_social || "", "text", 'placeholder="Mi Negocio · FacturaYa"')}
        ${campo("correo_key", "🔑 API Key de Brevo (xkeysib-...) o Resend (re_...)", "", "password", 'autocomplete="off" placeholder="xkeysib-xxxxxxxxx o re_xxxxxxxxx"')}
        <small class="suave" id="correo-key-pista"></small>
        ${campo("correo_pass", "🔒 Tu contraseña de Súper Admin para guardar", "", "password", 'required autocomplete="current-password"')}
        ${ERROR}<button class="boton" type="submit">GUARDAR API DE CORREO DE ESTE INQUILINO</button>
      </form>
      <button class="boton chico contorno-azul" id="correo-probar" type="button">📨 Enviar correo de prueba</button>
    </section>` : ""}
    ${formularioCodigo()}
    ${tarjetaRestaurar()}
    ${estado.modo === "PRACTICA" ? `<section class="tarjeta"><h2>🧪 Modo práctica</h2>
      <p class="suave">Mientras estés en práctica, las facturas y presupuestos son de prueba: llevan marca de agua, no valen y se borran al salir en vivo. Cuando todo esté probado y revisado con tu contador, sal en vivo para empezar la numeración real desde 00000001.</p>
      <form id="vivo">
        ${campo("primer_factura", "🧾 Primer N.º de factura (1 = 00000001)", "1", "text", 'inputmode="numeric" required')}
        ${campo("primer_nota_credito", "↩️ Primer N.º de nota de crédito (1 = NC-00000001)", "1", "text", 'inputmode="numeric" required')}
        ${campo("primer_control", "🔢 Primer N.º de control (1 = 00-00000001)", "1", "text", 'inputmode="numeric" required')}
        ${campo("primer_presupuesto", "📋 Primer N.º de presupuesto (1 = P-000001)", "1", "text", 'inputmode="numeric" required')}
        ${campo("primer_recibo", "💵 Primer N.º de recibo de pago (1 = 00000001)", "1", "text", 'inputmode="numeric" required')}
        <label class="opcion"><input type="checkbox" name="confirmo"> Entiendo que se BORRAN los documentos de práctica y que NO se puede volver atrás.</label>
        ${ERROR}<button class="boton rojo" type="submit">SALIR EN VIVO</button></form></section>`
      : `<section class="tarjeta"><h2>✅ En vivo</h2><p class="suave">El sistema está en modo real: las facturas emitidas llevan numeración correlativa legal y van directo al Libro de Ventas SENIAT.</p></section>`}
    <section class="tarjeta"><h2>💾 Respaldo</h2><p class="suave">Descarga una copia de todos tus datos (clientes, inventario y documentos). Guárdala fuera del sistema, en un lugar seguro.</p>
      <button class="boton" id="respaldo" type="button">⬇️ Exportar respaldo</button></section>
    ${superAdmin ? `<section class="tarjeta">
      <div class="reng-cab"><h2>🗑️ Reiniciar base de datos de fábrica</h2><span class="insignia rojo">Exclusivo Súper Admin</span></div>
      <p class="suave">Visible únicamente para ti como <b>Súper Administrador (${esc(estado.usuario.email)})</b>. Borra todas las tablas del negocio activo (${esc(estado.inquilino_activo || "principal")}) para empezar desde cero limpio.</p>
      <form id="reiniciar-form">
        ${campo("clave_reinicio", "🔒 Tu contraseña de Súper Administrador", "", "password", 'required autocomplete="current-password"')}
        <label class="opcion"><input type="checkbox" name="confirmo_reinicio" required> Confirmo que deseo BORRAR TODA la base de datos de este negocio y empezar desde cero.</label>
        ${ERROR}<button class="boton rojo" type="submit">🗑️ BORRAR BASE DE DATOS Y REINSTALAR</button>
      </form></section>
      ${TARJETA_GITHUB_ZIP}` : ""}` : ""}
    <button class="boton contorno" id="salir">Cerrar sesión</button>`;

  $("#atras").addEventListener("click", () => (location.hash = "#/inicio"));
  $("#ir-inquilinos")?.addEventListener("click", () => (location.hash = "#/inquilinos"));
  raiz.querySelectorAll(".barra-super [data-destino]").forEach((b) => b.addEventListener("click", () => (location.hash = b.dataset.destino)));
  $("#cambiar-clave").addEventListener("click", () => vistaCambiarClave(estado, { forzado: false, alTerminar: () => { if (location.hash !== "#/ajustes") location.hash = "#/ajustes"; return ruta(); } }));
  $("#salir").addEventListener("click", async () => { await api("logout", "POST"); history.replaceState(null, "", "/"); await ruta(); });
  if (!admin) return;

  $("#logo-archivo")?.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      logoActual = await optimizarLogo(file);
      $("#logo-vista").innerHTML = `<img src="${esc(logoActual)}" alt="Logo">`;
      $("#logo-quitar").hidden = false;
      aviso("Logo listo: pulsa «GUARDAR DATOS Y LOGO» abajo ✅");
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
  if (superAdmin) {
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
      });
      const est = $("#correo-estado");
      est.textContent = cfg.clave_configurada ? `Activo · ${cfg.proveedor}` : "Sin configurar";
      est.className = `insignia ${cfg.clave_configurada ? "verde" : "gris"}`;
      $("#correo_key").value = "";
      $("#correo_pass").value = "";
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
  }
  $("#restaurar-ir").addEventListener("click", () => (location.hash = "#/restaurar"));
  enviar($("#f"), async (d) => {
    d.igtf_activo = $("#igtf_activo").checked ? 1 : 0;
    d.logo_base64 = logoActual ?? "";
    await api("config", "PUT", d);
    aviso("Datos y logo guardados ✅");
    location.hash = "#/inicio";
  });
  if ($("#vivo")) enviar($("#vivo"), async (d) => {
    await api("sistema/salir-en-vivo", "POST", { primer_factura: Number(d.primer_factura), primer_nota_credito: Number(d.primer_nota_credito || 1), primer_control: Number(d.primer_control),
      primer_presupuesto: Number(d.primer_presupuesto), primer_recibo: Number(d.primer_recibo), confirmo: d.confirmo === "on" });
    aviso("El sistema está en vivo ✅"); await ruta();
  });
  if ($("#reiniciar-form")) enviar($("#reiniciar-form"), async (d) => {
    if (!confirm("⚠️ ¿Seguro que deseas BORRAR TODA LA BASE DE DATOS de este negocio y reinstalar desde cero?")) return;
    await api("sistema/reiniciar-fabrica", "POST", { clave: d.clave_reinicio, confirmo: d.confirmo_reinicio === "on" });
    aviso("Base de datos reiniciada de fábrica ✅");
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
    if (seccion === "inquilinos") return puede("super") ? await vistaInquilinos() : vistaInicio();
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

