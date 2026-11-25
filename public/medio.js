// Tarjeta MODALIDAD DE FACTURACIÓN DIGITAL + CG La Imprenta Digital (SNAT/INTI/012) + Visor de Plan y Consumo.
import { $, esc, api, aviso, campo, enviar, ERROR } from "./comun.js";

const dia = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(d);
const fechaDoc = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "");

export const NOMBRE_MEDIO = {
  APP_SENIAT: "Sistema Digital SENIAT (SNAT/2024/000102)",
  IMPRENTA_DIGITAL: "Imprenta Digital Autorizada (API)",
  SIN_DEFINIR: "Sin definir",
};

const HOST_CG_CALIDAD = "https://calidad.cgimprenta.digital/";
const PLANES_RAPIDOS = [
  { nombre: "Emprende I (100 números)", cupo: 100 },
  { nombre: "Emprende II (500 números)", cupo: 500 },
  { nombre: "Emprende III (1.000 números)", cupo: 1000 },
  { nombre: "Volumen I (5.000 números)", cupo: 5000 },
];

const colorAlerta = (nivel) => {
  if (nivel === "OK") return "verde";
  if (nivel === "AVISO") return "ambar";
  if (nivel === "CRITICO" || nivel === "AGOTADO" || nivel === "VENCIDO") return "rojo";
  return "gris";
};

const etiquetaAlerta = (nivel) => {
  if (nivel === "OK") return "Al día";
  if (nivel === "AVISO") return "Consumo alto";
  if (nivel === "CRITICO") return "Por agotarse";
  if (nivel === "AGOTADO") return "Agotado";
  if (nivel === "VENCIDO") return "Vigencia vencida";
  return "Sin plan cargado";
};

const urlSeguraHttps = (u) => {
  const s = String(u || "").trim();
  return /^https:\/\/[a-z0-9]/i.test(s) ? s : "";
};

export function renderVisorImprentaHtml(estadoImp, opts = {}) {
  const res = estadoImp?.resumen;
  if (!res) return "";
  const color = colorAlerta(res.nivel_alerta);
  const pct = Math.max(0, Math.min(100, Number(res.porcentaje_uso || 0)));
  const esCompacto = !!opts.compacto;
  const provNombre = estadoImp.proveedor || (estadoImp.proveedor_tipo === "CG_IMPRENTA" ? "CG La Imprenta Digital" : "Imprenta Digital");
  const ambTxt = estadoImp.ambiente === "PRODUCCION" ? "Producción" : "Calidad / Pruebas";
  const ambClase = estadoImp.ambiente === "PRODUCCION" ? "verde" : "morado";

  if (esCompacto) {
    return `<section class="tarjeta imp-visor imp-inicio" data-destino="#/ajustes" data-nombre="Plan Imprenta Digital">
      <div class="reng-cab">
        <span class="etiqueta">🏛️ ${esc(provNombre.toUpperCase())}</span>
        <span>
          <span class="insignia ${ambClase}">${esc(ambTxt)}</span>
          <span class="insignia ${color}">${esc(etiquetaAlerta(res.nivel_alerta))}</span>
        </span>
      </div>
      <div class="imp-grid">
        <div class="imp-stat"><small>Plan</small><strong>${res.plan_cupo_total > 0 ? esc(String(res.plan_cupo_total)) : "—"}</strong></div>
        <div class="imp-stat"><small>Enviadas OK</small><strong>${esc(String(res.enviadas_ok))}${res.plan_consumo_previo > 0 ? ` <span class="imp-sub">+${esc(String(res.plan_consumo_previo))} prev.</span>` : ""}</strong></div>
        <div class="imp-stat"><small>Disponibles</small><strong class="imp-num-${color}">${res.disponibles !== null ? esc(String(res.disponibles)) : "—"}</strong></div>
        <div class="imp-stat"><small>Pendientes</small><strong class="${res.pendientes > 0 ? "rojo-txt" : ""}">${esc(String(res.pendientes))}</strong></div>
      </div>
      ${res.plan_cupo_total > 0 ? `<div class="imp-barra" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Consumo de números de control">
        <div class="imp-barra-fill ${color}" style="width:${pct}%"></div>
      </div>` : ""}
      <small class="suave">
        <b>${esc(res.plan_nombre)}</b>${res.plan_fecha_pago ? ` · Pagado: <b>${esc(fechaDoc(res.plan_fecha_pago))}</b>` : ""}${res.plan_fecha_vence ? ` · Vigencia: <b>${esc(fechaDoc(res.plan_fecha_vence))}</b>` : ""} · Toca para administrar
      </small>
    </section>`;
  }

  const conc = estadoImp.ultima_conciliacion;
  const envios = Array.isArray(estadoImp.envios_recientes) ? estadoImp.envios_recientes : [];
  const recargas = Array.isArray(estadoImp.recargas) ? estadoImp.recargas : [];

  return `<div class="imp-visor" id="imp-visor-panel">
    <div class="reng-cab">
      <span class="etiqueta">📊 VISOR DE PLAN Y CONSUMO · ${esc(provNombre.toUpperCase())}</span>
      <span>
        <span class="insignia ${ambClase}">${esc(ambTxt)}</span>
        <span class="insignia ${color}">${esc(etiquetaAlerta(res.nivel_alerta))}</span>
      </span>
    </div>
    <p class="suave" style="margin:4px 0 8px">
      <b>${esc(res.plan_nombre)}</b>
      ${res.plan_fecha_pago ? ` · Pagado el <b>${esc(fechaDoc(res.plan_fecha_pago))}</b>` : ""}
      ${res.plan_fecha_vence ? ` · Vigencia hasta <b>${esc(fechaDoc(res.plan_fecha_vence))}</b>` : ""}
    </p>
    <div class="imp-grid">
      <div class="imp-stat"><small>Contratadas</small><strong>${res.plan_cupo_total > 0 ? esc(String(res.plan_cupo_total)) : "Sin definir"}</strong></div>
      <div class="imp-stat"><small>Enviadas y retornadas</small><strong>${esc(String(res.enviadas_ok))}${res.plan_consumo_previo > 0 ? ` <span class="imp-sub">+${esc(String(res.plan_consumo_previo))} prev.</span>` : ""}</strong></div>
      <div class="imp-stat"><small>Disponibles</small><strong class="imp-num-${color}">${res.disponibles !== null ? esc(String(res.disponibles)) : "—"}</strong></div>
      <div class="imp-stat"><small>Pendientes / Error</small><strong class="${res.pendientes > 0 ? "rojo-txt" : ""}">${esc(String(res.pendientes))}</strong></div>
    </div>
    ${res.plan_cupo_total > 0 ? `<div class="imp-barra" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Porcentaje de consumo del plan">
      <div class="imp-barra-fill ${color}" style="width:${pct}%"></div>
    </div>` : ""}
    <small class="suave" style="display:block;margin-top:6px">
      ${esc(res.mensaje_alerta)}
      <br>Desglose retornado: <b>${res.facturas_ok}</b> Facturas · <b>${res.nc_ok}</b> N. Crédito · <b>${res.nd_ok}</b> N. Débito · <b>${res.anuladas_ok}</b> Anuladas${res.plan_consumo_previo > 0 ? ` · <b>${res.plan_consumo_previo}</b> consumo previo` : ""}.
      ${conc ? `<br>Última conciliación CG (${esc(fechaDoc(conc.en))}): <b>${conc.total_cg}</b> en servidor CG vs <b>${conc.total_local}</b> en FacturaYa${conc.recuperados ? ` · <b>${conc.recuperados}</b> recuperado(s)` : ""}.` : ""}
    </small>
    <div class="imp-acciones">
      <button type="button" class="boton chico contorno-azul" id="imp-probar-btn" ${estadoImp.configurado ? "" : "disabled"}>🔌 Probar conexión CG</button>
      <button type="button" class="boton chico contorno-azul" id="imp-conciliar-btn" ${estadoImp.configurado && estadoImp.proveedor_tipo === "CG_IMPRENTA" ? "" : "disabled"}>🔄 Conciliar con CG</button>
      <button type="button" class="boton chico verde" id="imp-abrir-recarga-btn">➕ Cargar recarga / lote</button>
    </div>
    <p class="suave" id="imp-acc-msg" hidden style="margin:8px 0 0"></p>

    <form id="imp-recarga-form" class="tarjeta" hidden style="margin-top:10px">
      <div class="reng-cab"><span class="etiqueta">➕ REGISTRAR RECARGA / NUEVO LOTE DE NÚMEROS DE CONTROL</span><button type="button" class="boton chico contorno" id="imp-cerrar-recarga">Cerrar</button></div>
      <div class="chips" style="margin-bottom:8px">
        ${PLANES_RAPIDOS.map((p) => `<button type="button" class="chip" data-rec-preset="${p.cupo}" data-rec-nom="${esc(p.nombre)}">+${p.cupo}</button>`).join("")}
      </div>
      ${campo("rec_plan_nombre", "Nombre del plan / lote", "", "text", 'maxlength="80" placeholder="Ej: Emprende II (500 números)"')}
      ${campo("rec_cantidad", "Cantidad de números de control comprados", "500", "number", 'required min="1" max="10000000" step="1"')}
      ${campo("rec_fecha_pago", "📅 Fecha pagada del plan", dia(new Date()), "date", "required")}
      ${campo("rec_fecha_vence", "📅 Vigencia / renovación anual (opcional)", "", "date")}
      ${campo("rec_referencia", "Referencia de pago / factura CG (opcional)", "", "text", 'maxlength="60" placeholder="Ej: FAC-CG-00123"')}
      ${campo("rec_nota", "Nota (opcional)", "", "text", 'maxlength="200"')}
      ${campo("rec_password", "🔒 Tu contraseña (Administrador o Súper Admin)", "", "password", 'required autocomplete="current-password"')}
      <label class="opcion"><input type="checkbox" id="rec-confirmo" required> ☑️ Confirmo sumar este lote al cupo de Imprenta Digital de este negocio.</label>
      ${ERROR}<button class="boton chico verde" type="submit" id="rec-ir" disabled>Guardar recarga de lote</button>
    </form>

    ${envios.length ? `<details style="margin-top:10px"><summary class="suave" style="cursor:pointer;font-weight:600">📜 Últimos ${envios.length} documentos enviados/retornados (${envios.filter((e) => e.estado === "ENVIADO_OK" || e.estado === "ANULADO_OK").length} OK)</summary>
      <div style="margin-top:6px">${envios.slice(0, 8).map((e) => {
        const pdf = urlSeguraHttps(e.pdf_url);
        const estCl = e.estado === "ENVIADO_OK" ? "verde" : e.estado === "ANULADO_OK" ? "gris" : "rojo";
        const estLbl = e.estado === "ENVIADO_OK" ? "Retornado OK" : e.estado === "ANULADO_OK" ? "Anulado CG" : "Pendiente";
        return `<div class="reng" style="padding:8px 10px">
          <div class="reng-cab">
            <span><a href="#/factura/${e.documento_id}"><b>${esc(e.tipo_documento)} ${esc(e.numero_documento)}</b></a>${e.cliente_nombre ? ` · ${esc(e.cliente_nombre)}` : ""}</span>
            <span class="insignia ${estCl}">${estLbl}</span>
          </div>
          <small class="suave">
            ${e.control_fiscal ? `Control: <code>${esc(e.control_fiscal)}</code>` : "Sin N.º de control aún"}
            · Intentos: ${e.intentos || 1}
            ${pdf ? ` · <a href="${esc(pdf)}" target="_blank" rel="noopener noreferrer">🏛️ PDF oficial CG</a>` : ""}
            ${e.ultimo_error ? `<br><span class="rojo-txt">Error: ${esc(e.ultimo_error)}</span>` : ""}
          </small>
        </div>`;
      }).join("")}</div>
    </details>` : ""}

    ${recargas.length ? `<details style="margin-top:8px"><summary class="suave" style="cursor:pointer;font-weight:600">🧾 Historial de lotes / pagos cargados (${recargas.length})</summary>
      <div style="margin-top:6px">${recargas.map((r) => `<div class="reng" style="padding:8px 10px">
        <div class="reng-cab"><span><b>${esc(r.plan_nombre)}</b></span><span class="insignia verde">+${esc(String(r.cantidad_numeros))} núm.</span></div>
        <small class="suave">Pagado: <b>${esc(fechaDoc(r.fecha_pago))}</b>${r.fecha_vence ? ` · Vigencia: ${esc(fechaDoc(r.fecha_vence))}` : ""}${r.referencia ? ` · Ref: ${esc(r.referencia)}` : ""}</small>
      </div>`).join("")}</div>
    </details>` : ""}
  </div>`;
}

export const tarjetaMedio = () => `<section class="tarjeta" id="medio-zona"><h2>🧾 Modalidad Digital (SNAT/2024/000102)</h2><p class="suave">Cargando…</p></section>`;

export async function enlazarMedio(alCambiar) {
  const zona = $("#medio-zona"); if (!zona) return;
  const { medio, historial, imprenta, imprenta_estado } = await api("sistema/medio");
  if (!$("#medio-zona")) return;
  const otro = medio === "APP_SENIAT" ? "IMPRENTA_DIGITAL" : medio === "IMPRENTA_DIGITAL" ? "APP_SENIAT" : null;
  const esCg = (imprenta.proveedor_tipo || "CG_IMPRENTA") === "CG_IMPRENTA";

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
    ${medio === "IMPRENTA_DIGITAL" ? `<hr>
      ${renderVisorImprentaHtml(imprenta_estado)}
      <hr><h3>🌐 Configuración API y Plan · Imprenta Digital Autorizada</h3>
      <p class="suave"><b>Conector oficial CG La Imprenta Digital (SNAT/INTI/012)</b> y proveedores compatibles. El Súper Admin o el Administrador del negocio pueden cargar las credenciales API, el lote contratado y la fecha pagada. La contraseña y el token JWT se guardan cifrados con AES-256-GCM.</p>
      <form id="imp-form">
        <label for="imp_proveedor_tipo">Conector / Imprenta Digital</label>
        <select id="imp_proveedor_tipo" name="imp_proveedor_tipo">
          <option value="CG_IMPRENTA" ${esCg ? "selected" : ""}>🏛️ CG La Imprenta Digital (Oficial · SNAT/INTI/012)</option>
          <option value="GENERICO" ${!esCg ? "selected" : ""}>🌐 Otro proveedor autorizado (API genérica)</option>
        </select>
        <label for="imp_ambiente">Ambiente</label>
        <select id="imp_ambiente" name="imp_ambiente">
          <option value="PRUEBAS" ${imprenta.ambiente === "PRUEBAS" ? "selected" : ""}>🧪 Calidad / Pruebas (Sandbox)</option>
          <option value="PRODUCCION" ${imprenta.ambiente === "PRODUCCION" ? "selected" : ""}>🟢 Producción (Fiscal en vivo)</option>
        </select>
        ${campo("imp_proveedor", "Nombre del proveedor", imprenta.proveedor || (esCg ? "CG La Imprenta Digital" : ""), "text", 'required maxlength="60" autocomplete="off" placeholder="Ej: CG La Imprenta Digital"')}
        ${campo("imp_url", "URL base de la API (https://…)", imprenta.url || (esCg && imprenta.ambiente !== "PRODUCCION" ? HOST_CG_CALIDAD : ""), "url", 'required maxlength="200" autocomplete="off" placeholder="https://calidad.cgimprenta.digital/ o URL de Producción CG"')}
        <small class="error" id="imp-url-aviso" hidden style="display:block;margin:-6px 0 8px"></small>
        ${campo("imp_usuario", esCg ? "Correo / Usuario API CG" : "Usuario o RIF", imprenta.usuario, "text", `${esCg ? "required " : ""}maxlength="100" autocomplete="off" placeholder="usuario@empresa.com"`)}
        ${campo("imp_clave", imprenta.clave_configurada ? `Contraseña API / Token (••••${esc(imprenta.clave_final)}; vacío para conservar)` : (esCg ? "Contraseña API CG" : "Token / API Key"), "", "password", `maxlength="200" autocomplete="new-password"${imprenta.clave_configurada ? "" : " required"}`)}
        ${campo("imp_serie", "Serie de facturación CG (ej: A)", imprenta.serie || "A", "text", 'maxlength="5" autocomplete="off" placeholder="A"')}

        <hr><span class="etiqueta">📦 PLAN CONTRATADO Y FECHA PAGADA (VISOR DEL CLIENTE)</span>
        <div class="chips" style="margin:6px 0 8px">
          ${PLANES_RAPIDOS.map((p) => `<button type="button" class="chip" data-plan-preset="${p.cupo}" data-plan-nom="${esc(p.nombre)}">${p.cupo} núm.</button>`).join("")}
        </div>
        ${campo("imp_plan_nombre", "Nombre del plan contratado", imprenta.plan_nombre || "", "text", 'maxlength="80" placeholder="Ej: Emprende II (500 números)"')}
        ${campo("imp_plan_cupo_total", "Cupo total de números de control contratados", imprenta.plan_cupo_total ? String(imprenta.plan_cupo_total) : "", "number", 'min="0" max="10000000" step="1" placeholder="Ej: 500"')}
        ${campo("imp_plan_fecha_pago", "📅 Fecha pagada del plan", imprenta.plan_fecha_pago || "", "date")}
        ${campo("imp_plan_fecha_vence", "📅 Vigencia / renovación anual (opcional)", imprenta.plan_fecha_vence || "", "date")}
        ${campo("imp_plan_consumo_previo", "Documentos ya usados fuera de FacturaYa (opcional)", imprenta.plan_consumo_previo ? String(imprenta.plan_consumo_previo) : "0", "number", 'min="0" max="10000000" step="1"')}
        ${campo("imp_plan_nota", "Nota interna del plan (opcional)", imprenta.plan_nota || "", "text", 'maxlength="200" placeholder="Ej: Almacenamiento anual activo"')}

        ${campo("imp_password", "🔒 Tu contraseña (Administrador o Súper Admin)", "", "password", 'required autocomplete="current-password"')}
        <label class="opcion"><input type="checkbox" id="imp-confirmo" required> ☑️ Estoy seguro de guardar o modificar la API y el plan de Imprenta Digital de este negocio.</label>
        ${ERROR}<button class="boton chico" type="submit" id="imp-ir" disabled>Guardar API y Plan de Imprenta</button></form>` : ""}
    ${historial.length ? `<small class="suave">Historial: ${historial.map((h) => `${esc(String(h.cambiado_en).slice(0, 10))}: ${esc(NOMBRE_MEDIO[h.medio_anterior] ?? h.medio_anterior)} → ${esc(NOMBRE_MEDIO[h.medio_nuevo] ?? h.medio_nuevo)}${h.por ? ` (${esc(h.por)})` : ""}`).join(" · ")}</small>` : ""}`;

  $("#medio-confirmo").addEventListener("change", () => { $("#medio-ir").disabled = !$("#medio-confirmo").checked; });
  $("#imp-confirmo")?.addEventListener("change", () => { $("#imp-ir").disabled = !$("#imp-confirmo").checked; });
  $("#rec-confirmo")?.addEventListener("change", () => { $("#rec-ir").disabled = !$("#rec-confirmo").checked; });

  // Autocompletado inteligente al elegir CG Imprenta Digital o cambiar ambiente (compatible con cualquier URL CG)
  const selTipo = $("#imp_proveedor_tipo");
  const selAmb = $("#imp_ambiente");
  const inpUrl = $("#imp_url");
  const urlAviso = $("#imp-url-aviso");
  const validarAvisoUrlAmbiente = () => {
    if (!urlAviso || !selTipo || !selAmb || !inpUrl) return;
    const u = inpUrl.value.trim().toLowerCase();
    if (selTipo.value === "CG_IMPRENTA" && selAmb.value === "PRODUCCION" && u.includes("calidad.cgimprenta.digital")) {
      urlAviso.textContent = "⚠️ Seleccionaste Producción, pero la URL todavía apunta a Calidad (Pruebas). Pega la URL de Producción entregada por CG para este cliente.";
      urlAviso.hidden = false;
    } else {
      urlAviso.textContent = "";
      urlAviso.hidden = true;
    }
  };
  const aplicarPresetCg = () => {
    if (!selTipo) return;
    if (selTipo.value === "CG_IMPRENTA") {
      if (!$("#imp_proveedor").value.trim()) $("#imp_proveedor").value = "CG La Imprenta Digital";
      if (selAmb?.value === "PRUEBAS" && (!inpUrl.value.trim() || /miimprenta/i.test(inpUrl.value))) {
        inpUrl.value = HOST_CG_CALIDAD;
      }
    }
    validarAvisoUrlAmbiente();
  };
  selTipo?.addEventListener("change", aplicarPresetCg);
  selAmb?.addEventListener("change", aplicarPresetCg);
  inpUrl?.addEventListener("input", validarAvisoUrlAmbiente);
  validarAvisoUrlAmbiente();

  // Chips rápidos de plan en configuración y en recarga
  zona.querySelectorAll("[data-plan-preset]").forEach((btn) =>
    btn.addEventListener("click", () => {
      $("#imp_plan_cupo_total").value = btn.dataset.planPreset;
      $("#imp_plan_nombre").value = btn.dataset.planNom;
      if (!$("#imp_plan_fecha_pago").value) $("#imp_plan_fecha_pago").value = dia(new Date());
    })
  );
  zona.querySelectorAll("[data-rec-preset]").forEach((btn) =>
    btn.addEventListener("click", () => {
      $("#rec_cantidad").value = btn.dataset.recPreset;
      $("#rec_plan_nombre").value = btn.dataset.recNom;
    })
  );

  // Botones del visor: Probar conexión, Conciliar con CG y Recarga
  const msgAcc = $("#imp-acc-msg");
  const mostrarMsg = (txt, esErr = false) => {
    if (!msgAcc) return;
    msgAcc.hidden = false;
    msgAcc.className = esErr ? "error" : "suave";
    msgAcc.textContent = txt;
  };
  $("#imp-probar-btn")?.addEventListener("click", async () => {
    const b = $("#imp-probar-btn");
    b.disabled = true;
    mostrarMsg("Conectando con CG La Imprenta Digital…");
    try {
      const r = await api("sistema/imprenta/probar", "POST", {});
      mostrarMsg(`✅ ${r.mensaje || "Conexión verificada correctamente."}`);
      aviso("Conexión con CG Imprenta Digital OK ✅");
    } catch (e) {
      mostrarMsg(`⚠️ ${e.message}`, true);
    } finally {
      b.disabled = false;
    }
  });
  $("#imp-conciliar-btn")?.addEventListener("click", async () => {
    const b = $("#imp-conciliar-btn");
    b.disabled = true;
    mostrarMsg("Consultando documentos emitidos en CG La Imprenta Digital…");
    try {
      const r = await api("sistema/imprenta/conciliar", "POST", {});
      const c = r.conciliacion || {};
      aviso(`Conciliación CG lista: ${c.total_cg ?? 0} en CG · ${c.total_local ?? 0} en FacturaYa${c.recuperados ? ` · ${c.recuperados} recuperado(s)` : ""} ✅`);
      await enlazarMedio(alCambiar);
    } catch (e) {
      mostrarMsg(`⚠️ ${e.message}`, true);
      b.disabled = false;
    }
  });
  $("#imp-abrir-recarga-btn")?.addEventListener("click", () => {
    const f = $("#imp-recarga-form");
    if (f) f.hidden = !f.hidden;
  });
  $("#imp-cerrar-recarga")?.addEventListener("click", () => {
    const f = $("#imp-recarga-form");
    if (f) f.hidden = true;
  });

  if ($("#imp-recarga-form")) {
    enviar($("#imp-recarga-form"), async (d) => {
      await api("sistema/imprenta/recarga", "POST", {
        plan_nombre: d.rec_plan_nombre,
        cantidad_numeros: Number(d.rec_cantidad),
        fecha_pago: d.rec_fecha_pago,
        fecha_vence: d.rec_fecha_vence,
        referencia: d.rec_referencia,
        nota: d.rec_nota,
        password: d.rec_password,
        confirmo: $("#rec-confirmo")?.checked,
      });
      aviso("Recarga de lote registrada ✅");
      await enlazarMedio(alCambiar);
    });
  }

  if ($("#imp-form")) {
    enviar($("#imp-form"), async (d) => {
      await api("sistema/imprenta", "POST", {
        proveedor_tipo: d.imp_proveedor_tipo,
        proveedor: d.imp_proveedor,
        url: d.imp_url,
        usuario: d.imp_usuario,
        clave: d.imp_clave,
        ambiente: d.imp_ambiente,
        serie: d.imp_serie,
        plan_nombre: d.imp_plan_nombre,
        plan_cupo_total: d.imp_plan_cupo_total === "" ? undefined : Number(d.imp_plan_cupo_total),
        plan_fecha_pago: d.imp_plan_fecha_pago,
        plan_fecha_vence: d.imp_plan_fecha_vence,
        plan_consumo_previo: d.imp_plan_consumo_previo === "" ? 0 : Number(d.imp_plan_consumo_previo),
        plan_nota: d.imp_plan_nota,
        password: d.imp_password,
        confirmo: $("#imp-confirmo")?.checked,
      });
      aviso("API y plan de Imprenta Digital guardados ✅");
      await alCambiar();
    });
  }

  enviar($("#medio-form"), async (d) => {
    await api("sistema/medio", "POST", {
      medio: d.medio,
      motivo: d.motivo,
      clave: d.medio_clave,
      confirmo: $("#medio-confirmo").checked,
    });
    aviso("Modalidad de facturación guardada ✅");
    await alCambiar();
  });
}
