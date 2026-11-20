// Módulo de interfaz del Correo de Plataforma (v4.7.0):
// 1) Panel Global del Súper Admin en Mis Inquilinos -> Correos de Plataforma (cuotas UTC, circuitos, métricas por inquilino, alertas, bloqueos y prueba).
// 2) Historial propio de envíos y rebotes en Ajustes -> Servicio de Correo para cada inquilino.
import { $, api, aviso, esc } from "./comun.js";

const ETIQ_ESTADO = {
  ENVIADO: { txt: "Enviado", cls: "azul" },
  ENTREGADO: { txt: "Entregado", cls: "verde" },
  REBOTADO: { txt: "Rebotado", cls: "rojo" },
  QUEJA: { txt: "Queja spam", cls: "rojo" },
  BLOQUEADO: { txt: "Bloqueado", cls: "ambar" },
  FALLIDO: { txt: "Fallido", cls: "rojo" },
};

const ETIQ_TIPO_BLOQ = {
  REBOTE_DURO: { txt: "Rebote duro", cls: "rojo" },
  REBOTE_BLANDO: { txt: "Rebote temporal", cls: "ambar" },
  SPAM: { txt: "Queja spam", cls: "rojo" },
};

export async function renderHistorialCorreoInquilino(contenedor) {
  if (!contenedor) return;
  contenedor.innerHTML = `<p class="suave">Cargando historial de envíos…</p>`;
  try {
    const data = await api("correos/historial?limite=30");
    const r = data.resumen || {};
    const envios = data.envios || [];
    const rebotes = Number(r.rebotados || 0) + Number(r.quejas || 0);
    contenedor.innerHTML = `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid #dde3ec">
        <div class="reng-cab" style="margin-bottom:8px">
          <b>📋 Historial de envíos y rebotes de este negocio</b>
          <span class="insignia ${rebotes > 0 ? "rojo" : "gris"}">${Number(r.total || 0)} registro(s)${rebotes > 0 ? ` · ${rebotes} rebote(s)` : ""}</span>
        </div>
        ${rebotes > 0 ? `<div class="aviso-anulado" style="margin-bottom:10px">⚠️ Tienes <b>${rebotes}</b> correo(s) rebotado(s) o con reporte. Revisa las direcciones marcadas en rojo y corrige el correo del cliente antes de reenviar.</div>` : ""}
        ${envios.length === 0
          ? `<p class="suave" style="margin:4px 0">Aún no se han enviado correos desde este negocio.</p>`
          : `<div style="display:flex;flex-direction:column;gap:8px;max-height:320px;overflow:auto">
              ${envios.map((e) => {
                const st = ETIQ_ESTADO[e.estado] || { txt: e.estado || "Info", cls: "gris" };
                return `<div style="padding:10px 12px;border:1px solid ${e.estado === "REBOTADO" || e.estado === "QUEJA" ? "#f5c2c7" : "#e3e8ef"};border-radius:12px;background:${e.estado === "REBOTADO" || e.estado === "QUEJA" ? "#fff5f5" : "#fafcff"}">
                  <div class="reng-cab" style="gap:6px;flex-wrap:wrap">
                    <span style="font-size:13px"><b>${esc(e.destinatario || "—")}</b> <small class="suave">(${esc(e.tipo || "GENERAL")})</small></span>
                    <span class="insignia ${st.cls}">${esc(st.txt)}</span>
                  </div>
                  <div class="suave" style="font-size:12px;margin-top:2px">${esc(e.asunto || "")} · ${esc(e.creado_en || "")}${e.proveedor ? ` · ${esc(e.proveedor)}` : ""}</div>
                  ${e.motivo ? `<div style="font-size:12px;color:#b42318;margin-top:4px">${esc(e.motivo)}</div>` : ""}
                </div>`;
              }).join("")}
            </div>`}
      </div>`;
  } catch (e) {
    contenedor.innerHTML = `<p class="suave">No se pudo cargar el historial de envíos: ${esc(e.message)}</p>`;
  }
}

export async function vistaPanelCorreosPlataforma(raiz, barraVolverInq, onVolver) {
  raiz.innerHTML = `${barraVolverInq("📨 Correos de Plataforma")}<section class="tarjeta"><p class="cargando">Cargando panel global de correos…</p></section>`;
  const volver = () => onVolver();
  $("#volver-inq")?.addEventListener("click", volver);

  const cargar = async () => {
    const d = await api("correos/panel");
    const g = d.resumen_global || {};
    const sec = d.secretos || {};
    const provs = d.proveedores || [];
    const inqs = d.por_inquilino || [];
    const alertas = d.alertas || [];
    const bloqueos = d.bloqueos || [];

    const badgeSecreto = (nombre, ok) =>
      `<span class="insignia ${ok ? "verde" : "gris"}" style="margin:2px 4px 2px 0">${ok ? "✅" : "⚪"} ${esc(nombre)}</span>`;

    raiz.innerHTML = `
      ${barraVolverInq("📨 Correos de Plataforma")}
      <section class="tarjeta">
        <div class="reng-cab" style="flex-wrap:wrap;gap:6px">
          <span class="etiqueta">👑 PANEL GLOBAL · SÚPER ADMIN (${esc(d.fecha_utc)} UTC)</span>
          <span class="insignia ${d.modo_plataforma ? "verde" : "ambar"}">${d.modo_plataforma ? "Modo Plataforma Activo" : "Modo Legado (sin secretos globales)"}</span>
        </div>
        <p class="suave" style="margin:6px 0 10px">Remitente plataforma: <b>${esc(d.nombre_plataforma)} &lt;${esc(d.remitente)}&gt;</b> · Cadena: <b>Brevo → Resend → Zoho ZeptoMail</b>.</p>
        <div class="rejilla" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:10px">
          <div style="padding:10px;border-radius:12px;background:#f4f8fe;border:1px solid #dce8fb"><small class="suave">Enviados hoy (UTC)</small><div style="font-size:20px;font-weight:700">${Number(g.enviados_hoy || 0)}</div></div>
          <div style="padding:10px;border-radius:12px;background:#f4f8fe;border:1px solid #dce8fb"><small class="suave">Enviados mes (${esc(d.mes_utc)})</small><div style="font-size:20px;font-weight:700">${Number(g.enviados_mes || 0)}</div></div>
          <div style="padding:10px;border-radius:12px;background:${Number(g.tasa_rebotes_mes || 0) >= 2 ? "#fff5f5" : "#f2fbf5"};border:1px solid ${Number(g.tasa_rebotes_mes || 0) >= 2 ? "#f5c2c7" : "#cdecd8"}"><small class="suave">Tasa rebotes (meta &lt;2%)</small><div style="font-size:20px;font-weight:700">${Number(g.tasa_rebotes_mes || 0)}%</div></div>
          <div style="padding:10px;border-radius:12px;background:${Number(g.quejas_mes || 0) > 0 ? "#fff5f5" : "#f2fbf5"};border:1px solid ${Number(g.quejas_mes || 0) > 0 ? "#f5c2c7" : "#cdecd8"}"><small class="suave">Quejas spam (meta 0)</small><div style="font-size:20px;font-weight:700">${Number(g.quejas_mes || 0)}</div></div>
        </div>
        <div style="margin-top:8px">
          <small class="suave" style="display:block;margin-bottom:4px"><b>Estado de secretos en Cloudflare (nunca se muestran valores):</b></small>
          <div>
            ${badgeSecreto("BREVO_API_KEY", sec.BREVO_API_KEY)}
            ${badgeSecreto("RESEND_API_KEY", sec.RESEND_API_KEY)}
            ${badgeSecreto("ZEPTOMAIL_API_KEY", sec.ZEPTOMAIL_API_KEY)}
            ${badgeSecreto("BREVO_WEBHOOK_SECRET", sec.BREVO_WEBHOOK_SECRET)}
            ${badgeSecreto("RESEND_WEBHOOK_SECRET", sec.RESEND_WEBHOOK_SECRET)}
            ${badgeSecreto("ZEPTOMAIL_WEBHOOK_SECRET", sec.ZEPTOMAIL_WEBHOOK_SECRET)}
          </div>
        </div>
      </section>

      ${alertas.length ? `<section class="tarjeta" id="plat-alertas">
        <div class="reng-cab"><h2>🚨 Alertas activas (${alertas.length})</h2><span class="insignia rojo">Revisar</span></div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${alertas.map((a) => `
            <div style="padding:10px 12px;border-radius:12px;border:1px solid ${a.nivel === "CRITICO" ? "#f5c2c7" : "#ffe0a3"};background:${a.nivel === "CRITICO" ? "#fff5f5" : "#fffaf0"}">
              <div class="reng-cab">
                <b>${a.nivel === "CRITICO" ? "🔴" : "🟠"} ${esc(a.titulo)}</b>
                <button type="button" class="boton chico contorno" data-descartar-alerta="${esc(a.clave)}">Descartar</button>
              </div>
              <div class="suave" style="font-size:13px;margin-top:4px">${esc(a.detalle)}</div>
            </div>`).join("")}
        </div>
      </section>` : ""}

      <section class="tarjeta">
        <h2>🔌 Proveedores, Cuotas UTC y Circuitos</h2>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${provs.map((p) => {
            const c = p.circuito || {};
            const estBadge = !p.configurado
              ? `<span class="insignia gris">Inactivo (sin clave)</span>`
              : c.abierto
                ? `<span class="insignia rojo">Circuito abierto (${Math.ceil((c.segundos_restantes || 0) / 60)} min)</span>`
                : `<span class="insignia verde">Sano · Activo</span>`;
            return `<div style="padding:12px;border:1px solid #dde3ec;border-radius:12px">
              <div class="reng-cab">
                <b>${esc(p.proveedor)}</b>
                ${estBadge}
              </div>
              <div class="suave" style="font-size:13px;margin-top:4px">
                Hoy (UTC): <b>${p.hoy.enviados} / ${p.cuota_diaria}</b> (${p.porcentaje_hoy}%) · Entregados: ${p.hoy.entregados} · Fallos: ${p.hoy.fallidos} · Rebotes: ${p.hoy.rebotes}
              </div>
              <div class="suave" style="font-size:12px;margin-top:2px">
                Mes (${esc(d.mes_utc)}): <b>${p.mes.enviados}</b> enviados · ${p.mes.entregados} entregados · ${p.mes.rebotes} rebotes · ${p.mes.quejas} quejas
              </div>
              ${c.ultimo_error ? `<div style="font-size:12px;color:#b42318;margin-top:4px">Último error (HTTP ${c.ultimo_estado_http || 0}): ${esc(c.ultimo_error)}</div>` : ""}
              ${c.abierto ? `<button type="button" class="boton chico contorno-azul" style="margin-top:8px" data-reset-circ="${esc(p.proveedor)}">🔄 Reiniciar circuito ${esc(p.proveedor)}</button>` : ""}
            </div>`;
          }).join("")}
        </div>
        <form id="plat-probar-form" style="margin-top:14px;padding-top:12px;border-top:1px solid #dde3ec">
          <h3 style="margin:0 0 8px">📨 Envío de prueba</h3>
          <label for="plat-test-para">Correo destinatario</label>
          <input id="plat-test-para" type="email" required placeholder="tu-correo@ejemplo.com">
          <label for="plat-test-prov">Proveedor</label>
          <select id="plat-test-prov">
            <option value="">Automático (Cadena Brevo → Resend → ZeptoMail)</option>
            <option value="BREVO">Solo Brevo</option>
            <option value="RESEND">Solo Resend</option>
            <option value="ZEPTOMAIL">Solo Zoho ZeptoMail</option>
          </select>
          <button type="submit" class="boton chico" style="margin-top:8px">Enviar correo de prueba</button>
        </form>
      </section>

      <section class="tarjeta">
        <h2>🏢 Uso por Inquilino y Fusible de Seguridad</h2>
        <p class="suave">El conteo no limita el uso normal. La <b>alerta suave</b> solo avisa; el <b>fusible diario</b> protege contra bucles o abuso (pon <code>0</code> para desactivarlo en un cliente).</p>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${inqs.map((i) => `
            <div style="padding:12px;border:1px solid #dde3ec;border-radius:12px">
              <div class="reng-cab" style="flex-wrap:wrap;gap:6px">
                <b>${esc(i.nombre_negocio)} <small class="suave">(${esc(i.codigo)}${i.rif ? ` · ${esc(i.rif)}` : ""})</small></b>
                <span class="insignia ${i.tasa_rebotes_mes > 5 ? "rojo" : i.tasa_rebotes_mes >= 2 ? "ambar" : "verde"}">Rebotes mes: ${i.tasa_rebotes_mes}%</span>
              </div>
              <div class="suave" style="font-size:13px;margin-top:4px">
                Hoy: <b>${i.hoy.enviados}</b> env · ${i.hoy.entregados} entr · ${i.hoy.rebotes} reb · ${i.hoy.quejas} spam · ${i.hoy.bloqueados} bloq
              </div>
              <div class="suave" style="font-size:12px;margin-top:2px">
                Mes: <b>${i.mes.enviados}</b> env · ${i.mes.entregados} entr · ${i.mes.rebotes} reb · ${i.mes.quejas} spam · ${i.mes.bloqueados} bloq
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:8px">
                <div style="flex:1;min-width:110px">
                  <label style="font-size:12px">Alerta diaria</label>
                  <input type="number" min="0" max="100000" value="${i.alerta_diaria}" data-lim-alerta="${esc(i.codigo)}">
                </div>
                <div style="flex:1;min-width:110px">
                  <label style="font-size:12px">Fusible diario (0=sin tope)</label>
                  <input type="number" min="0" max="500000" value="${i.fusible_diario}" data-lim-fusible="${esc(i.codigo)}">
                </div>
                <button type="button" class="boton chico contorno-azul" data-guardar-lim="${esc(i.codigo)}">Guardar</button>
              </div>
            </div>`).join("")}
        </div>
      </section>

      <section class="tarjeta">
        <div class="reng-cab" style="flex-wrap:wrap;gap:6px"><h2 style="margin:0">🚫 Direcciones Bloqueadas (${bloqueos.length})</h2><span class="insignia gris">Almacenadas en HMAC-SHA256</span></div>
        <p class="suave">Los correos bloqueados se guardan cifrados como huella criptográfica (nunca en texto plano). Puedes desbloquear una dirección desde la lista o escribiéndola abajo.</p>
        <form id="plat-desbloq-email-form" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          <input id="plat-desbloq-email" type="email" placeholder="cliente@ejemplo.com" required style="flex:1;min-width:200px">
          <button type="submit" class="boton chico contorno-azul">Desbloquear correo</button>
        </form>
        ${bloqueos.length === 0
          ? `<p class="suave">No hay direcciones bloqueadas actualmente.</p>`
          : `<div style="display:flex;flex-direction:column;gap:8px">
              ${bloqueos.map((b) => {
                const tb = ETIQ_TIPO_BLOQ[b.tipo] || { txt: b.tipo, cls: "gris" };
                const vigencia = Number(b.bloqueado_hasta) === -1
                  ? "Permanente (hasta desbloqueo)"
                  : `Pausado hasta ${new Date(Number(b.bloqueado_hasta) * 1000).toLocaleTimeString("es-VE")}`;
                return `<div style="padding:10px 12px;border:1px solid #f5c2c7;border-radius:12px;background:#fff8f8">
                  <div class="reng-cab">
                    <span><b>${esc(b.mascara || "***")}</b> <small class="suave">(${esc(b.inquilino_origen || "principal")})</small></span>
                    <span class="insignia ${tb.cls}">${esc(tb.txt)} · ×${Number(b.contador || 1)}</span>
                  </div>
                  <div class="suave" style="font-size:12px;margin-top:3px">${esc(b.motivo || "")} · ${esc(vigencia)}</div>
                  <button type="button" class="boton chico contorno" style="margin-top:6px" data-desbloq-hash="${esc(b.email_hash)}">🔓 Desbloquear</button>
                </div>`;
              }).join("")}
            </div>`}
      </section>
    `;

    $("#volver-inq")?.addEventListener("click", volver);

    raiz.querySelectorAll("[data-descartar-alerta]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api(`correos/alertas/${encodeURIComponent(btn.dataset.descartarAlerta)}`, "DELETE");
          aviso("Alerta descartada ✅");
          await cargar();
        } catch (e) {
          aviso(e.message);
          btn.disabled = false;
        }
      })
    );

    raiz.querySelectorAll("[data-reset-circ]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api("correos/circuitos/reiniciar", "POST", { proveedor: btn.dataset.resetCirc });
          aviso(`Circuito de ${btn.dataset.resetCirc} reiniciado ✅`);
          await cargar();
        } catch (e) {
          aviso(e.message);
          btn.disabled = false;
        }
      })
    );

    $("#plat-probar-form")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const para = $("#plat-test-para")?.value.trim();
      const proveedor = $("#plat-test-prov")?.value || "";
      try {
        const r = await api("correos/probar", "POST", { para, proveedor });
        aviso(`Prueba enviada vía ${r.proveedor || "plataforma"} a ${r.destino} ✅`);
        await cargar();
      } catch (e) {
        aviso(e.message);
      }
    });

    raiz.querySelectorAll("[data-guardar-lim]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const cod = btn.dataset.guardarLim;
        const alerta = Number(raiz.querySelector(`[data-lim-alerta="${CSS.escape(cod)}"]`)?.value ?? 100);
        const fusible = Number(raiz.querySelector(`[data-lim-fusible="${CSS.escape(cod)}"]`)?.value ?? 500);
        btn.disabled = true;
        try {
          await api(`correos/limites/${encodeURIComponent(cod)}`, "PUT", { alerta_diaria: alerta, fusible_diario: fusible });
          aviso(`Límites de ${cod} guardados ✅`);
          await cargar();
        } catch (e) {
          aviso(e.message);
          btn.disabled = false;
        }
      })
    );

    raiz.querySelectorAll("[data-desbloq-hash]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api("correos/bloqueos/desbloquear", "POST", { email_hash: btn.dataset.desbloqHash });
          aviso("Dirección desbloqueada ✅");
          await cargar();
        } catch (e) {
          aviso(e.message);
          btn.disabled = false;
        }
      })
    );

    $("#plat-desbloq-email-form")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const email = $("#plat-desbloq-email")?.value.trim();
      if (!email) return;
      try {
        const r = await api("correos/bloqueos/desbloquear", "POST", { email });
        aviso(r.eliminados > 0 ? "Dirección desbloqueada ✅" : "Esa dirección no tenía bloqueo activo.");
        $("#plat-desbloq-email").value = "";
        await cargar();
      } catch (e) {
        aviso(e.message);
      }
    });
  };

  try {
    await cargar();
  } catch (e) {
    raiz.innerHTML = `${barraVolverInq("📨 Correos de Plataforma")}<section class="tarjeta"><p class="error">${esc(e.message)}</p></section>`;
    $("#volver-inq")?.addEventListener("click", volver);
  }
}
