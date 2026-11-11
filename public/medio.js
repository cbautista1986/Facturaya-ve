// Tarjeta MEDIO DE FACTURACIÓN en Ajustes (Fase 7.3, solo el dueño): máquina fiscal o imprenta digital, uno solo a la vez.
import { $, esc, api, aviso, campo, enviar, ERROR } from "./comun.js";

export const NOMBRE_MEDIO = { MAQUINA_FISCAL: "Máquina fiscal", IMPRENTA_DIGITAL: "Imprenta digital", SIN_DEFINIR: "Sin definir" };
export const tarjetaMedio = () => `<section class="tarjeta" id="medio-zona"><h2>🧾 Medio de facturación</h2><p class="suave">Cargando…</p></section>`;

export async function enlazarMedio(alCambiar) {
  const zona = $("#medio-zona"); if (!zona) return;
  const { medio, historial, maquina, imprenta } = await api("sistema/medio");
  if (!$("#medio-zona")) return; // ya se fue a otra pantalla
  const otro = medio === "MAQUINA_FISCAL" ? "IMPRENTA_DIGITAL" : medio === "IMPRENTA_DIGITAL" ? "MAQUINA_FISCAL" : null;
  zona.innerHTML = `<h2>🧾 Medio de facturación</h2>
    <p><span class="etiqueta">AHORA</span><br><strong id="medio-actual">${esc(NOMBRE_MEDIO[medio] ?? medio)}</strong></p>
    ${medio === "SIN_DEFINIR" ? `<p class="error">⚠️ Elígelo antes de salir en vivo: el sistema no te deja emitir facturas reales sin saber cómo se factura.</p>` : ""}
    <p class="suave">Se usa uno solo a la vez. Con <b>máquina fiscal</b>, la factura legal es la que imprime tu máquina y la del sistema es un comprobante interno: tú anotas su número fiscal. Con <b>imprenta digital</b>, el número de control lo da la imprenta. El cambio vale para las facturas nuevas; las ya emitidas conservan el medio con que salieron.</p>
    <form id="medio-form">
      <label for="medio">${medio === "SIN_DEFINIR" ? "Elige tu medio" : "Cambiar a"}</label>
      <select id="medio" name="medio">${(otro ? [otro] : ["MAQUINA_FISCAL", "IMPRENTA_DIGITAL"]).map((m) => `<option value="${m}">${NOMBRE_MEDIO[m]}</option>`).join("")}</select>
      ${campo("motivo", "📝 Motivo (mínimo 5 letras)", "", "text", 'required minlength="5" maxlength="300" autocomplete="off"')}
      ${campo("medio_clave", "🔒 Tu contraseña", "", "password", 'required autocomplete="current-password"')}
      <label class="opcion"><input type="checkbox" id="medio-confirmo"> Entiendo el cambio${medio === "SIN_DEFINIR" ? "" : " y avisaré a mi Gerencia Regional / Sector de Tributos Internos del SENIAT"}.</label>
      ${ERROR}<button class="boton chico" type="submit" id="medio-ir" disabled>${medio === "SIN_DEFINIR" ? "Guardar mi medio" : "Cambiar medio"}</button></form>
    ${medio === "MAQUINA_FISCAL" ? `<hr><h3>🖨️ Tu máquina fiscal</h3>
      ${maquina.serial ? `<p>Serial: <strong id="maq-serial">${esc(maquina.serial)}</strong> · Último N.º fiscal usado: <strong id="maq-ultimo">${esc(String(maquina.ultimo).padStart(7, "0"))}</strong> · Siguiente: <strong>${esc(String(maquina.ultimo + 1).padStart(7, "0"))}</strong></p>` : `<p class="error">⚠️ Falta configurarla: sin el serial no se pueden registrar números fiscales.</p>`}
      <p class="suave">Se configura <b>una sola vez</b>: el serial es siempre el mismo y el número fiscal va en orden. Anota hasta qué número ya imprimió la máquina (0 si es nueva) y el sistema te propondrá el siguiente en cada factura.</p>
      <form id="maq-form">${campo("maq_serial", "Serial de la máquina fiscal", maquina.serial ?? "", "text", 'required maxlength="30" autocomplete="off"')}
        ${campo("maq_ultimo", "Último N.º fiscal usado (0 si es nueva)", String(maquina.ultimo ?? 0), "text", 'required inputmode="numeric" maxlength="10"')}
        ${campo("maq_clave", "🔒 Tu contraseña", "", "password", 'required autocomplete="current-password"')}
        ${ERROR}<button class="boton chico" type="submit">${maquina.serial ? "Actualizar mi máquina" : "Guardar mi máquina"}</button></form>` : ""}
    ${medio === "IMPRENTA_DIGITAL" ? `<hr><h3>🌐 Conexión con tu imprenta digital</h3>
      <p class="suave">Datos de la API de tu imprenta. La clave se guarda aparte: <b>no sale en los respaldos</b> y nunca se muestra completa. Por ahora solo se guardan; la conexión automática se activa cuando se integre tu imprenta (dime cuál usas).</p>
      <form id="imp-form">${campo("imp_proveedor", "Nombre de la imprenta digital", imprenta.proveedor, "text", 'required maxlength="60" autocomplete="off"')}
        ${campo("imp_url", "Dirección de la API (https://…)", imprenta.url, "url", 'required maxlength="200" autocomplete="off" placeholder="https://api.miimprenta.com/v1"')}
        ${campo("imp_usuario", "Usuario o RIF registrado en la imprenta", imprenta.usuario, "text", 'maxlength="100" autocomplete="off"')}
        ${campo("imp_clave", imprenta.clave_configurada ? `Clave / token (••••${esc(imprenta.clave_final)}; déjalo vacío para no cambiarla)` : "Clave / token de la API", "", "password", `maxlength="200" autocomplete="off"${imprenta.clave_configurada ? "" : " required"}`)}
        <label for="imp_ambiente">Ambiente</label><select id="imp_ambiente" name="imp_ambiente"><option value="PRUEBAS" ${imprenta.ambiente === "PRUEBAS" ? "selected" : ""}>Pruebas</option><option value="PRODUCCION" ${imprenta.ambiente === "PRODUCCION" ? "selected" : ""}>Producción</option></select>
        ${campo("imp_password", "🔒 Tu contraseña", "", "password", 'required autocomplete="current-password"')}
        ${ERROR}<button class="boton chico" type="submit">Guardar datos de la imprenta</button></form>` : ""}
    ${historial.length ? `<small class="suave">Historial: ${historial.map((h) => `${esc(String(h.cambiado_en).slice(0, 10))}: ${esc(NOMBRE_MEDIO[h.medio_anterior] ?? h.medio_anterior)} → ${esc(NOMBRE_MEDIO[h.medio_nuevo] ?? h.medio_nuevo)}${h.por ? ` (${esc(h.por)})` : ""}`).join(" · ")}</small>` : ""}`;
  $("#medio-confirmo").addEventListener("change", () => { $("#medio-ir").disabled = !$("#medio-confirmo").checked; });
  if ($("#maq-form")) enviar($("#maq-form"), async (d) => { await api("sistema/medio/maquina", "POST", { serial: d.maq_serial, ultimo: d.maq_ultimo, clave: d.maq_clave }); aviso("Máquina fiscal guardada ✅"); await alCambiar(); });
  if ($("#imp-form")) enviar($("#imp-form"), async (d) => { await api("sistema/imprenta", "POST", { proveedor: d.imp_proveedor, url: d.imp_url, usuario: d.imp_usuario, clave: d.imp_clave, ambiente: d.imp_ambiente, password: d.imp_password }); aviso("Datos de la imprenta guardados ✅"); await alCambiar(); });
  enviar($("#medio-form"), async (d) => { await api("sistema/medio", "POST", { medio: d.medio, motivo: d.motivo, clave: d.medio_clave, confirmo: $("#medio-confirmo").checked }); aviso("Medio de facturación guardado ✅"); await alCambiar(); });
}
