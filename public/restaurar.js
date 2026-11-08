// Pantalla RESTAURAR RESPALDO (Fase 7.2, solo el dueño): elegir el archivo, ver qué trae, confirmar con la contraseña y seguir el avance.
// El trabajo pesado (leer, verificar la huella, enviar por lotes) está en restaurar-nucleo.js; el servidor decide si el sistema está vacío y valida todo.
import { $, raiz, esc, api, aviso, campo, ERROR } from "./comun.js";
import { leerRespaldo, restaurar } from "./restaurar-nucleo.js";

const leerArchivo = (f) => new Promise((ok, mal) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => mal(new Error("No se pudo leer el archivo.")); r.readAsText(f); });
const NOMBRES = { documentos: "documentos", clientes: "clientes", catalogo: "productos y servicios", pagos: "pagos", compras: "compras", proveedores: "proveedores", movimientos_stock: "movimientos de existencias", usuarios: "usuarios" };

export function tarjetaRestaurar() {
  return `<section class="tarjeta"><h2>♻️ Restaurar un respaldo</h2>
    <p class="suave">Para pasar tu negocio a otra instalación o recuperarlo después de un problema. Solo se puede en un sistema <b>recién instalado y vacío</b>: nunca se mezcla con datos que ya existan.</p>
    <button class="boton chico contorno" id="restaurar-ir" type="button">Restaurar un respaldo</button></section>`;
}

// Pantalla para quien NO es el dueño mientras se restaura
export function pantallaOcupado(alReintentar) {
  raiz.innerHTML = `<section class="tarjeta"><h1>♻️ Sistema en mantenimiento</h1>
    <p class="suave">El administrador está restaurando un respaldo. En unos minutos podrás seguir trabajando. No hace falta que hagas nada.</p>
    <button class="boton" id="reintentar" type="button">Volver a intentar</button></section>`;
  $("#reintentar").addEventListener("click", alReintentar);
}

export async function vistaRestaurar(estado, alTerminar) {
  const e = await api("sistema/restaurar/estado");
  const volver = () => (location.hash = "#/ajustes");
  const cabecera = `<header class="encabezado"><button class="icono" id="atras" data-ayuda="Volver a ajustes" aria-label="Volver">←</button><h1>♻️ Restaurar respaldo</h1></header>`;
  const enlazarAtras = () => $("#atras")?.addEventListener("click", () => { if (location.hash === "#/ajustes") alTerminar(); else volver(); });

  if (e.en_curso) { // quedó una restauración a medias: lo único seguro es limpiar y empezar de nuevo
    raiz.innerHTML = `${cabecera}<section class="tarjeta"><h2>Hay una restauración a medias</h2>
      <p class="suave">Empezó el ${esc(String(e.progreso?.desde ?? "").slice(0, 16).replace("T", " "))} y no terminó. Mientras tanto nadie puede guardar nada. Cancélala para dejar el sistema como estaba y vuelve a empezar con tu archivo.</p>
      ${ERROR}<button class="boton rojo" id="cancelar" type="button">Cancelar y limpiar</button></section>`;
    enlazarAtras();
    $("#cancelar").addEventListener("click", async () => { try { await api("sistema/restaurar/cancelar", "POST"); aviso("Restauración cancelada ✅"); await alTerminar(); } catch (x) { aviso(x.message); } });
    return;
  }
  if (!e.vacio) {
    raiz.innerHTML = `${cabecera}<section class="tarjeta"><h2>Aquí no se puede restaurar</h2>
      <p class="suave">Solo se restaura en un sistema recién instalado y vacío. Para pasar tu negocio a otra instalación, instálala de cero y restaura ahí.</p>
      <ul>${e.razones.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></section>`;
    enlazarAtras(); return;
  }
  raiz.innerHTML = `${cabecera}
    <section class="tarjeta"><p class="suave">Elige el archivo de respaldo (.json) que descargaste del sistema de origen. Antes de tocar nada se comprueba que no esté dañado.</p>
      <input type="file" id="archivo" accept=".json,application/json" aria-label="Archivo de respaldo"><p class="error" id="err-archivo" role="alert" hidden></p></section>
    <div id="resumen"></div>`;
  enlazarAtras();
  $("#archivo").addEventListener("change", async () => {
    const err = $("#err-archivo"); err.hidden = true; $("#resumen").innerHTML = "";
    const f = $("#archivo").files?.[0]; if (!f) return;
    let resp;
    try { resp = await leerRespaldo(await leerArchivo(f)); } catch (x) { resp = { ok: false, error: x.message }; }
    if (!resp.ok) { err.textContent = resp.error; err.hidden = false; return; }
    const d = resp.datos, cuenta = (t) => d[t]?.length ?? 0;
    $("#resumen").innerHTML = `
      <section class="tarjeta"><span class="etiqueta">📦 ESTE RESPALDO TRAE</span>
        <p><strong>${esc(resp.negocio || "(sin nombre)")}</strong><br><small class="suave">${esc(resp.rif)} · ${resp.generado_en ? esc(String(resp.generado_en).slice(0, 10)) : "fecha desconocida"} · ${resp.modo_origen === "REAL" ? "EN VIVO" : "en práctica"}</small></p>
        <ul>${Object.entries(NOMBRES).map(([t, n]) => `<li>${cuenta(t)} ${n}</li>`).join("")}</ul>
        <p class="pista">${resp.huella_ok === true ? "✅ Verificado: el archivo no está dañado ni modificado." : "⚠️ Es un respaldo de una versión anterior: no trae verificación de integridad. Se restaura igual y el sistema comprueba que los totales cuadren."}</p></section>
      <section class="tarjeta"><form id="f">
        ${campo("clave", "🔒 Tu contraseña de administrador", "", "password", 'required autocomplete="current-password"')}
        <label class="opcion"><input type="checkbox" id="entiendo"> Entiendo que este sistema quedará con los datos del respaldo${resp.modo_origen === "REAL" ? " y EN VIVO (las facturas no se podrán editar ni borrar, solo anular)" : ""}. Los usuarios del respaldo quedarán desactivados.</label>
        <progress id="avance" value="0" max="1" hidden></progress><p class="suave" id="avance-txt" hidden></p>
        ${ERROR}<button class="boton" id="ir" type="submit" disabled>RESTAURAR AHORA</button></form></section>`;
    $("#entiendo").addEventListener("change", () => { $("#ir").disabled = !$("#entiendo").checked; });
    $("#f").addEventListener("submit", async (ev) => {
      ev.preventDefault(); const eb = $("#f .error"); eb.hidden = true;
      $("#ir").disabled = true; $("#archivo").disabled = true; $("#avance").hidden = false; $("#avance-txt").hidden = false;
      try {
        await restaurar((ruta, cuerpo, metodo) => api(ruta, metodo ?? (cuerpo === undefined ? "GET" : "POST"), cuerpo), resp, $("#clave").value, (p) => {
          $("#avance").max = p.total || 1; $("#avance").value = p.hechas; $("#avance-txt").textContent = p.tabla === "verificando" ? "Verificando que todo cuadre…" : `Enviando ${p.tabla}… ${p.hechas} de ${p.total}`;
        });
        raiz.innerHTML = `<section class="tarjeta"><h1>✅ Restauración terminada</h1>
          <p class="suave">Tu negocio quedó como en el respaldo${resp.modo_origen === "REAL" ? " y el sistema está EN VIVO; la numeración sigue donde iba" : " (en modo práctica)"}. Los usuarios del respaldo están desactivados: actívalos en Ajustes → Usuarios y dales una clave temporal.</p>
          <button class="boton" id="listo" type="button">CONTINUAR ➔</button></section>`;
        $("#listo").addEventListener("click", () => { location.hash = "#/inicio"; alTerminar(); });
      } catch (x) {
        eb.textContent = x.message; eb.hidden = false; $("#avance").hidden = true;
        // Si ya había empezado a enviar, ofrece limpiar para reintentar
        const est = await api("sistema/restaurar/estado").catch(() => null);
        if (est?.en_curso) eb.innerHTML = `${esc(x.message)}<br><button type="button" class="boton chico rojo" id="limpiar">Cancelar y limpiar para reintentar</button>`;
        $("#limpiar")?.addEventListener("click", async () => { try { await api("sistema/restaurar/cancelar", "POST"); aviso("Limpio ✅ Puedes volver a intentarlo"); await alTerminar(); } catch (y) { aviso(y.message); } });
        $("#archivo").disabled = false;
      }
    });
  });
}
