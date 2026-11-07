// Pantallas de USUARIOS Y CUENTA (Fase 7.1): lista y alta de usuarios (solo el dueño), claves temporales, código de recuperación,
// recuperar la clave olvidada y cambio de clave. Las claves temporales y los códigos se muestran UNA sola vez.
import { $, raiz, esc, api, aviso, campo, enviar, ERROR } from "./comun.js";

const ETIQUETA_ROL = { ADMIN: "Dueño / administrador", SUPERVISOR: "Supervisor", CAJERO: "Cajero", BODEGA: "Bodega" };
const AYUDA_ROL = { ADMIN: "Todo", SUPERVISOR: "Caja, devoluciones y tasa", CAJERO: "Solo caja", BODEGA: "Inventario y compras" };

// Tarjeta con un secreto que se muestra una sola vez (clave temporal o código de recuperación) y botón de copiar
export function tarjetaSecreto(secreto, aviso1) {
  return `<section class="tarjeta secreto"><p class="suave">${aviso1}</p><p class="codigo" id="secreto" aria-label="Valor secreto">${esc(secreto)}</p>
    <button type="button" class="boton chico contorno" id="copiar">📋 Copiar</button></section>`;
}
export function enlazarCopiar(texto) {
  const b = $("#copiar"); if (!b) return;
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(texto); aviso("Copiado ✅"); }
    catch { const r = document.createRange(); r.selectNodeContents($("#secreto")); getSelection().removeAllRanges(); getSelection().addRange(r); aviso("Selecciónalo y cópialo"); }
  });
}

// Pantalla completa para guardar el código de recuperación (no se puede seguir sin confirmar que se guardó)
export function pantallaCodigo(codigo, { titulo = "🔐 Tu código de recuperación", boton = "CONTINUAR ➔", alContinuar }) {
  raiz.innerHTML = `<section class="tarjeta"><h1>${titulo}</h1>
    <p class="suave">Si olvidas tu contraseña, este código es la ÚNICA forma de recuperarla sin ayuda técnica. Anótalo en papel o guárdalo en un lugar seguro. <b>No se vuelve a mostrar.</b></p>
    ${tarjetaSecreto(codigo, "Tu código:")}
    <label class="opcion"><input type="checkbox" id="guardado"> Ya guardé mi código en un lugar seguro.</label>
    <button class="boton" id="seguir" disabled>${boton}</button></section>`;
  enlazarCopiar(codigo);
  $("#guardado").addEventListener("change", (e) => { $("#seguir").disabled = !e.target.checked; });
  $("#seguir").addEventListener("click", alContinuar);
}

// Olvidé mi contraseña (solo el administrador; los demás piden al administrador que restablezca su clave)
export function vistaRecuperar(alVolver) {
  raiz.innerHTML = `<section class="tarjeta"><h1>🔑 Recuperar mi contraseña</h1>
    <p class="suave">Escribe tu correo, el código de recuperación que guardaste al instalar y una contraseña nueva. Si eres cajero, supervisor o de bodega, pídele al administrador que restablezca tu clave.</p>
    <form id="f">
      ${campo("email", "✉️ Correo", "", "email", 'required autocomplete="username"')}
      ${campo("codigo", "🔐 Código de recuperación", "", "text", 'required autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"')}
      ${campo("clave_nueva", "🔒 Contraseña nueva (mínimo 10 caracteres)", "", "password", 'required minlength="10" autocomplete="new-password"')}
      ${ERROR}<button class="boton" type="submit">CAMBIAR CONTRASEÑA ➔</button>
    </form><button class="boton contorno" id="volver" type="button">← Volver</button></section>`;
  $("#volver").addEventListener("click", alVolver);
  enviar($("#f"), async (d) => {
    const r = await api("recuperar", "POST", d);
    pantallaCodigo(r.codigo_recuperacion, { titulo: "✅ Contraseña cambiada · tu código NUEVO", boton: "IR A INICIAR SESIÓN ➔", alContinuar: alVolver });
  });
}

// Cambio de clave: obligatorio con una clave temporal (forzado = true) o voluntario desde Ajustes
export function vistaCambiarClave(estado, { forzado, alTerminar }) {
  raiz.innerHTML = `<section class="tarjeta"><h1>🔑 ${forzado ? "Elige tu contraseña" : "Cambiar mi contraseña"}</h1>
    ${forzado ? `<p class="suave">Entraste con una clave temporal. Antes de seguir, elige una contraseña tuya (mínimo 10 caracteres).</p>` : ""}
    <form id="f">
      ${campo("actual", forzado ? "🔒 Clave temporal" : "🔒 Contraseña actual", "", "password", 'required autocomplete="current-password"')}
      ${campo("nueva", "🆕 Contraseña nueva (mínimo 10 caracteres)", "", "password", 'required minlength="10" autocomplete="new-password"')}
      ${ERROR}<button class="boton" type="submit">GUARDAR MI CONTRASEÑA ➔</button>
    </form>${forzado ? `<button class="boton contorno" id="salir" type="button">Cerrar sesión</button>` : `<button class="boton contorno" id="volver" type="button">← Volver</button>`}</section>`;
  if (forzado) $("#salir").addEventListener("click", async () => { await api("logout", "POST"); alTerminar(); });
  else $("#volver").addEventListener("click", alTerminar);
  enviar($("#f"), async (d) => { await api("cuenta/clave", "POST", d); aviso("Contraseña cambiada ✅"); alTerminar(); });
}

// Código de recuperación para cuentas anteriores a esta versión (o para reemplazar el que se perdió)
export function formularioCodigo() {
  return `<section class="tarjeta"><h2>🔐 Código de recuperación</h2>
    <p class="suave">Sirve para recuperar tu contraseña si la olvidas. Al generar uno nuevo, el anterior deja de funcionar.</p>
    <form id="cod">${campo("clave", "🔒 Tu contraseña actual", "", "password", 'required autocomplete="current-password"')}
      ${ERROR}<button class="boton chico contorno" type="submit">Generar código nuevo</button></form></section>`;
}
export function enlazarCodigo(alVolver) {
  enviar($("#cod"), async (d) => { const r = await api("cuenta/codigo-recuperacion", "POST", d); pantallaCodigo(r.codigo, { boton: "LISTO ➔", alContinuar: alVolver }); });
}

// Lista y gestión de usuarios (solo el dueño)
export async function vistaUsuarios(estado) {
  const { usuarios, roles } = await api("usuarios");
  if (!location.hash.startsWith("#/usuarios")) return; // la persona ya se fue a otra pantalla mientras cargaba: no se la pisa
  const opciones = (sel) => roles.map((r) => `<option value="${r.clave}" ${r.clave === sel ? "selected" : ""}>${esc(r.nombre)} · ${esc(AYUDA_ROL[r.clave] ?? "")}</option>`).join("");
  raiz.innerHTML = `
    <header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver a ajustes" aria-label="Volver">←</button><h1>👥 Usuarios</h1></header>
    <div id="secreto-zona"></div>
    <div class="lista">${usuarios.map((u) => `<section class="tarjeta usuario${u.activo ? "" : " inactivo"}" data-id="${u.id}">
      <div class="fila-usuario"><span class="dato"><strong>${esc(u.nombre)}</strong><small class="suave">${esc(u.email)}</small></span>
        <span class="etiqueta">${u.activo ? esc(ETIQUETA_ROL[u.rol] ?? u.rol) : "DESACTIVADO"}</span></div>
      ${u.debe_cambiar_clave ? `<small class="suave">⏳ Aún no ha cambiado su clave temporal.</small>` : ""}
      ${u.id === estado.usuario.id ? `<small class="suave">Esta es tu cuenta.</small>` : `
      <div class="acciones-usuario"><select data-rol aria-label="Rol de ${esc(u.nombre)}">${opciones(u.rol)}</select>
        <button class="boton chico contorno" data-guardar-rol>Cambiar rol</button>
        <button class="boton chico contorno" data-reset>Restablecer clave</button>
        <button class="boton chico ${u.activo ? "rojo" : "verde"}" data-activo="${u.activo ? 0 : 1}">${u.activo ? "Desactivar" : "Reactivar"}</button></div>`}
    </section>`).join("")}</div>
    <section class="tarjeta"><h2>➕ Nuevo usuario</h2>
      <form id="nuevo">${campo("nombre", "👤 Nombre", "", "text", "required")}${campo("email", "✉️ Correo (será su usuario)", "", "email", 'required autocomplete="off"')}
        <label for="rol">Rol</label><select id="rol" name="rol">${opciones("CAJERO")}</select>
        <p class="pista">Se le da una clave temporal que verás una sola vez; al entrar deberá elegir la suya.</p>
        ${ERROR}<button class="boton" type="submit">CREAR USUARIO</button></form></section>`;
  $("#atras").addEventListener("click", () => (location.hash = "#/ajustes"));
  const mostrar = (clave, quien) => { $("#secreto-zona").innerHTML = tarjetaSecreto(clave, `Clave temporal de <b>${esc(quien)}</b> (se ve una sola vez; pásasela y deberá cambiarla al entrar):`); enlazarCopiar(clave); scrollTo(0, 0); };
  const refrescar = (clave, quien) => vistaUsuarios(estado).then(() => clave && mostrar(clave, quien));
  enviar($("#nuevo"), async (d) => { const r = await api("usuarios", "POST", d); aviso("Usuario creado ✅"); await refrescar(r.clave_temporal, d.nombre); });
  raiz.querySelectorAll(".usuario[data-id]").forEach((el) => {
    const id = el.dataset.id, nombre = el.querySelector("strong").textContent;
    const hacer = (fn) => async () => { try { await fn(); } catch (e) { aviso(e.message); } };
    el.querySelector("[data-guardar-rol]")?.addEventListener("click", hacer(async () => { await api(`usuarios/${id}`, "PUT", { rol: el.querySelector("[data-rol]").value }); aviso("Rol cambiado ✅ (si estaba conectado, deberá entrar de nuevo)"); await refrescar(); }));
    el.querySelector("[data-reset]")?.addEventListener("click", hacer(async () => { if (!confirm(`¿Restablecer la clave de ${nombre}? Se cerrará su sesión y recibirá una clave temporal.`)) return; const r = await api(`usuarios/${id}/reset-clave`, "POST"); await refrescar(r.clave_temporal, nombre); }));
    el.querySelector("[data-activo]")?.addEventListener("click", hacer(async () => { const a = Number(el.querySelector("[data-activo]").dataset.activo); if (!a && !confirm(`¿Desactivar a ${nombre}? Dejará de poder entrar (no se borra nada).`)) return; await api(`usuarios/${id}`, "PUT", { activo: !!a }); aviso(a ? "Reactivado ✅" : "Desactivado ✅"); await refrescar(); }));
  });
}
