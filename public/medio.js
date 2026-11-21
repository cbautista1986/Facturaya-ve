// Tarjeta MODALIDAD DE FACTURACIÓN DIGITAL en Ajustes (solo el administrador): Aplicación SENIAT o Imprenta Digital (API), una sola a la vez.
import { $, esc, api, aviso, campo, enviar, ERROR } from "./comun.js";

export const NOMBRE_MEDIO = {
  APP_SENIAT: "Sistema Digital SENIAT (SNAT/2024/000102)",
  IMPRENTA_DIGITAL: "Imprenta Digital Autorizada (API)",
  SIN_DEFINIR: "Sin definir",
};
export const tarjetaMedio = () => `<section class="tarjeta" id="medio-zona"><h2>🧾 Modalidad Digital (SNAT/2024/000102)</h2><p class="suave">Cargando…</p></section>`;

export async function enlazarMedio(alCambiar) {
  const zona = $("#medio-zona"); if (!zona) return;
  const { medio, historial, imprenta } = await api("sistema/medio");
  if (!$("#medio-zona")) return;
  const otro = medio === "APP_SENIAT" ? "IMPRENTA_DIGITAL" : medio === "IMPRENTA_DIGITAL" ? "APP_SENIAT" : null;
  zona.innerHTML = `<h2>🧾 Modalidad Digital (SNAT/2024/000102)</h2>
    <p><span class="etiqueta">MODALIDAD ACTIVA</span><br><strong id="medio-actual">${esc(NOMBRE_MEDIO[medio] ?? medio)}</strong></p>
    ${medio === "SIN_DEFINIR" ? `<p class="error">⚠️ Define la modalidad digital antes de activar la numeración en vivo.</p>` : ""}
    <p class="suave">Emisión digital conforme a las Providencias <b>SNAT/2011/0071</b> y <b>SNAT/2024/000102</b> (correlativo <b>00000001</b> y N.º de Control <b>00-00000001</b>).</p>
    <form id="medio-form">
      <label for="medio">${medio === "SIN_DEFINIR" ? "Seleccionar modalidad" : "Cambiar a"}</label>
      <select id="medio" name="medio">${(otro ? [otro] : ["APP_SENIAT", "IMPRENTA_DIGITAL"]).map((m) => `<option value="${m}">${NOMBRE_MEDIO[m]}</option>`).join("")}</select>
      ${campo("motivo", "📝 Motivo del cambio", "", "text", 'required minlength="5" maxlength="300" autocomplete="off"')}
      ${campo("medio_clave", "🔒 Tu contraseña", "", "password", 'required autocomplete="current-password"')}
      <label class="opcion"><input type="checkbox" id="medio-confirmo"> ☑️ Estoy seguro de cambiar la modalidad de facturación digital (define si los números de control fiscal se asignan vía Sistema Digital SENIAT o vía Imprenta Digital Autorizada).</label>
      ${ERROR}<button class="boton chico" type="submit" id="medio-ir" disabled>${medio === "SIN_DEFINIR" ? "Guardar modalidad" : "Cambiar modalidad"}</button></form>
    ${medio === "IMPRENTA_DIGITAL" ? `<hr><h3>🌐 API de Imprenta Digital Autorizada</h3>
      <p class="suave"><b>¿Qué hace esta configuración?</b> Conecta tu negocio con tu Imprenta Digital Autorizada (ej. The Factory HKA / Unidigital, Providencia SNAT/2024/000102) para solicitar automáticamente Números de Control Fiscal al emitir facturas y notas de crédito. El token se almacena cifrado con AES-256-GCM. Solo el Administrador del negocio y el Súper Admin pueden editarla.</p>
      <form id="imp-form">${campo("imp_proveedor", "Proveedor autorizado", imprenta.proveedor, "text", 'required maxlength="60" autocomplete="off" placeholder="Ej: The Factory HKA / Unidigital"')}
        ${campo("imp_url", "URL de la API (https://…)", imprenta.url, "url", 'required maxlength="200" autocomplete="off" placeholder="https://api.miimprenta.com/v1"')}
        ${campo("imp_usuario", "Usuario o RIF", imprenta.usuario, "text", 'maxlength="100" autocomplete="off"')}
        ${campo("imp_clave", imprenta.clave_configurada ? `Token API (••••${esc(imprenta.clave_final)}; vacío para conservar)` : "Token / API Key", "", "password", `maxlength="200" autocomplete="off"${imprenta.clave_configurada ? "" : " required"}`)}
        <label for="imp_ambiente">Ambiente</label><select id="imp_ambiente" name="imp_ambiente"><option value="PRUEBAS" ${imprenta.ambiente === "PRUEBAS" ? "selected" : ""}>Pruebas (Sandbox)</option><option value="PRODUCCION" ${imprenta.ambiente === "PRODUCCION" ? "selected" : ""}>Producción</option></select>
        ${campo("imp_password", "🔒 Tu contraseña (Administrador o Súper Admin)", "", "password", 'required autocomplete="current-password"')}
        <label class="opcion"><input type="checkbox" id="imp-confirmo" required> ☑️ Estoy seguro de guardar o modificar la API de Imprenta Digital de este negocio.</label>
        ${ERROR}<button class="boton chico" type="submit" id="imp-ir" disabled>Guardar API de Imprenta</button></form>` : ""}
    ${historial.length ? `<small class="suave">Historial: ${historial.map((h) => `${esc(String(h.cambiado_en).slice(0, 10))}: ${esc(NOMBRE_MEDIO[h.medio_anterior] ?? h.medio_anterior)} → ${esc(NOMBRE_MEDIO[h.medio_nuevo] ?? h.medio_nuevo)}${h.por ? ` (${esc(h.por)})` : ""}`).join(" · ")}</small>` : ""}`;
  $("#medio-confirmo").addEventListener("change", () => { $("#medio-ir").disabled = !$("#medio-confirmo").checked; });
  $("#imp-confirmo")?.addEventListener("change", () => { $("#imp-ir").disabled = !$("#imp-confirmo").checked; });
  if ($("#imp-form")) enviar($("#imp-form"), async (d) => { await api("sistema/imprenta", "POST", { proveedor: d.imp_proveedor, url: d.imp_url, usuario: d.imp_usuario, clave: d.imp_clave, ambiente: d.imp_ambiente, password: d.imp_password, confirmo: $("#imp-confirmo")?.checked }); aviso("Datos de la imprenta guardados ✅"); await alCambiar(); });
  enviar($("#medio-form"), async (d) => { await api("sistema/medio", "POST", { medio: d.medio, motivo: d.motivo, clave: d.medio_clave, confirmo: $("#medio-confirmo").checked }); aviso("Modalidad de facturación guardada ✅"); await alCambiar(); });
}

