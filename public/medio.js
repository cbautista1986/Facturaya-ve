// Tarjeta MODALIDAD DE FACTURACIÓN DIGITAL en Ajustes (solo el dueño): Aplicación SENIAT o Imprenta Digital (API), una sola a la vez.
import { $, esc, api, aviso, campo, enviar, ERROR } from "./comun.js";

export const NOMBRE_MEDIO = {
  APP_SENIAT: "Aplicación Digital SENIAT (Próximamente)",
  IMPRENTA_DIGITAL: "Imprenta Digital Autorizada (API)",
  SIN_DEFINIR: "Sin definir",
};
export const tarjetaMedio = () => `<section class="tarjeta" id="medio-zona"><h2>🧾 Modalidad de facturación digital</h2><p class="suave">Cargando…</p></section>`;

export async function enlazarMedio(alCambiar) {
  const zona = $("#medio-zona"); if (!zona) return;
  const { medio, historial, imprenta } = await api("sistema/medio");
  if (!$("#medio-zona")) return;
  const otro = medio === "APP_SENIAT" ? "IMPRENTA_DIGITAL" : medio === "IMPRENTA_DIGITAL" ? "APP_SENIAT" : null;
  zona.innerHTML = `<h2>🧾 Modalidad de facturación digital</h2>
    <p><span class="etiqueta">MODALIDAD ACTIVA</span><br><strong id="medio-actual">${esc(NOMBRE_MEDIO[medio] ?? medio)}</strong></p>
    ${medio === "SIN_DEFINIR" ? `<p class="error">⚠️ Elige tu modalidad de facturación digital antes de salir en vivo.</p>` : ""}
    <p class="suave">El sistema opera <b>100% con facturación digital</b> bajo dos metodologías:
      <br>• <b>📱 Aplicación Digital SENIAT (Próximamente):</b> emites aquí tu factura desde el <b>N.º 00000001</b> y <b>N.º de Control 00-00000001</b>, descargas su PDF limpio como FACTURA y tienes un botón para copiar/clonar los datos en el sistema del SENIAT cuando esté habilitado.
      <br>• <b>🌐 Imprenta Digital Autorizada (API):</b> conexión con el API de tu imprenta digital (The Factory HKA / proveedor autorizado) para asignación de números de control y QR.</p>
    <form id="medio-form">
      <label for="medio">${medio === "SIN_DEFINIR" ? "Elige tu modalidad" : "Cambiar a"}</label>
      <select id="medio" name="medio">${(otro ? [otro] : ["APP_SENIAT", "IMPRENTA_DIGITAL"]).map((m) => `<option value="${m}">${NOMBRE_MEDIO[m]}</option>`).join("")}</select>
      ${campo("motivo", "📝 Motivo del cambio (mínimo 5 letras)", "", "text", 'required minlength="5" maxlength="300" autocomplete="off"')}
      ${campo("medio_clave", "🔒 Tu contraseña", "", "password", 'required autocomplete="current-password"')}
      <label class="opcion"><input type="checkbox" id="medio-confirmo"> Confirmo el cambio de modalidad de facturación digital.</label>
      ${ERROR}<button class="boton chico" type="submit" id="medio-ir" disabled>${medio === "SIN_DEFINIR" ? "Guardar modalidad" : "Cambiar modalidad"}</button></form>
    ${medio === "APP_SENIAT" ? `<hr><h3>📱 Aplicación Digital SENIAT (Externa / Próximamente)</h3>
      <p class="suave">Todas tus facturas y notas de crédito se emiten listas con título <b>FACTURA</b>, correlativo <b>00000001</b> y <b>N.º de Control 00-00000001</b>. En cada factura verás el botón <b>«📋 Copiar datos para clonar en App SENIAT»</b> para pasarla rápidamente cuando abras la aplicación del SENIAT.</p>` : ""}
    ${medio === "IMPRENTA_DIGITAL" ? `<hr><h3>🌐 Conexión con tu imprenta digital (API)</h3>
      <p class="suave">Datos de la API de tu imprenta digital (The Factory HKA u otra autorizada). La clave se guarda aparte: <b>no sale en los respaldos</b> y nunca se muestra completa.</p>
      <form id="imp-form">${campo("imp_proveedor", "Nombre de la imprenta digital", imprenta.proveedor, "text", 'required maxlength="60" autocomplete="off" placeholder="Ej: The Factory HKA"')}
        ${campo("imp_url", "Dirección de la API (https://…)", imprenta.url, "url", 'required maxlength="200" autocomplete="off" placeholder="https://api.miimprenta.com/v1"')}
        ${campo("imp_usuario", "Usuario o RIF registrado en la imprenta", imprenta.usuario, "text", 'maxlength="100" autocomplete="off"')}
        ${campo("imp_clave", imprenta.clave_configurada ? `Clave / token (••••${esc(imprenta.clave_final)}; déjalo vacío para no cambiarla)` : "Clave / token de la API", "", "password", `maxlength="200" autocomplete="off"${imprenta.clave_configurada ? "" : " required"}`)}
        <label for="imp_ambiente">Ambiente</label><select id="imp_ambiente" name="imp_ambiente"><option value="PRUEBAS" ${imprenta.ambiente === "PRUEBAS" ? "selected" : ""}>Pruebas (Sandbox)</option><option value="PRODUCCION" ${imprenta.ambiente === "PRODUCCION" ? "selected" : ""}>Producción</option></select>
        ${campo("imp_password", "🔒 Tu contraseña", "", "password", 'required autocomplete="current-password"')}
        ${ERROR}<button class="boton chico" type="submit">Guardar datos de la imprenta</button></form>` : ""}
    ${historial.length ? `<small class="suave">Historial: ${historial.map((h) => `${esc(String(h.cambiado_en).slice(0, 10))}: ${esc(NOMBRE_MEDIO[h.medio_anterior] ?? h.medio_anterior)} → ${esc(NOMBRE_MEDIO[h.medio_nuevo] ?? h.medio_nuevo)}${h.por ? ` (${esc(h.por)})` : ""}`).join(" · ")}</small>` : ""}`;
  $("#medio-confirmo").addEventListener("change", () => { $("#medio-ir").disabled = !$("#medio-confirmo").checked; });
  if ($("#imp-form")) enviar($("#imp-form"), async (d) => { await api("sistema/imprenta", "POST", { proveedor: d.imp_proveedor, url: d.imp_url, usuario: d.imp_usuario, clave: d.imp_clave, ambiente: d.imp_ambiente, password: d.imp_password }); aviso("Datos de la imprenta guardados ✅"); await alCambiar(); });
  enviar($("#medio-form"), async (d) => { await api("sistema/medio", "POST", { medio: d.medio, motivo: d.motivo, clave: d.medio_clave, confirmo: $("#medio-confirmo").checked }); aviso("Modalidad de facturación guardada ✅"); await alCambiar(); });
}

