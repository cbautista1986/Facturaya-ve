// Tarjeta MEDIO DE FACTURACIÓN en Ajustes (Fase 7.3, solo el dueño): máquina fiscal o imprenta digital, uno solo a la vez.
import { $, esc, api, aviso, campo, enviar, ERROR } from "./comun.js";

export const NOMBRE_MEDIO = { MAQUINA_FISCAL: "Máquina fiscal", IMPRENTA_DIGITAL: "Imprenta digital", SIN_DEFINIR: "Sin definir" };
export const tarjetaMedio = () => `<section class="tarjeta" id="medio-zona"><h2>🧾 Medio de facturación</h2><p class="suave">Cargando…</p></section>`;

export async function enlazarMedio(alCambiar) {
  const zona = $("#medio-zona"); if (!zona) return;
  const { medio, historial } = await api("sistema/medio");
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
      ${campo("clave", "🔒 Tu contraseña", "", "password", 'required autocomplete="current-password"')}
      <label class="opcion"><input type="checkbox" id="medio-confirmo"> Entiendo el cambio${medio === "SIN_DEFINIR" ? "" : " y avisaré a mi Gerencia Regional / Sector de Tributos Internos del SENIAT"}.</label>
      ${ERROR}<button class="boton chico" type="submit" id="medio-ir" disabled>${medio === "SIN_DEFINIR" ? "Guardar mi medio" : "Cambiar medio"}</button></form>
    ${historial.length ? `<small class="suave">Historial: ${historial.map((h) => `${esc(String(h.cambiado_en).slice(0, 10))}: ${esc(NOMBRE_MEDIO[h.medio_anterior] ?? h.medio_anterior)} → ${esc(NOMBRE_MEDIO[h.medio_nuevo] ?? h.medio_nuevo)}${h.por ? ` (${esc(h.por)})` : ""}`).join(" · ")}</small>` : ""}`;
  $("#medio-confirmo").addEventListener("change", () => { $("#medio-ir").disabled = !$("#medio-confirmo").checked; });
  enviar($("#medio-form"), async (d) => { await api("sistema/medio", "POST", { medio: d.medio, motivo: d.motivo, clave: d.clave, confirmo: $("#medio-confirmo").checked }); aviso("Medio de facturación guardado ✅"); await alCambiar(); });
}
