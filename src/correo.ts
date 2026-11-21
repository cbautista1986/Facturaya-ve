// Módulo de envío de correos electrónicos por HTTP API (compatible con Cloudflare Workers sin puertos SMTP).
// Modo Plataforma (v4.7.0): usa secretos de Cloudflare (BREVO_API_KEY -> RESEND_API_KEY -> ZEPTOMAIL_API_KEY)
// con failover automático, cuotas diarias UTC, circuito de enfriamiento, bloqueos HMAC-SHA256 y conteo por inquilino.
// Retrocompatibilidad: si no hay secretos de plataforma configurados, opera exactamente como antes con la tabla `integraciones` del inquilino.
import { descifrarSecreto } from "./cifrado";
import {
  asegurarEsquemaCorreos,
  clasificarFalloHttpProveedor,
  construirIdentidadEnvio,
  evaluarAlertasDespuesEnvio,
  extraerContextoPlataforma,
  fechaUtcHoy,
  incrementarUsoCorreo,
  leerCircuitos,
  leerConfigPlataforma,
  leerLimitesInquilino,
  leerUsoHoy,
  limpiarCircuito,
  registrarAlertaCorreo,
  registrarEnvioInquilino,
  registrarFalloCircuito,
  seleccionarCadenaProveedores,
  verificarDestinatarioBloqueado,
  type AlcanceCorreo,
  type PerfilIdentidadCorreo,
  type ProveedorPlataforma,
  type TipoCorreo,
} from "./correo-plataforma";

export type AdjuntoCorreo = { filename: string; content: string }; // content en Base64
export type OpcionesCorreo = {
  para: string | string[];
  cc?: string | string[];
  responderA?: string;
  asunto: string;
  html: string;
  texto?: string;
  adjuntos?: AdjuntoCorreo[];
  alcance?: AlcanceCorreo;
  tipo?: TipoCorreo;
  inquilinoCodigo?: string;
  idempotencyKey?: string;
  forzarProveedor?: ProveedorPlataforma;
};

export type ConfigCorreo = {
  proveedor: "RESEND" | "BREVO" | "ZEPTOMAIL";
  remitente: string;
  nombre_remitente: string;
  clave_configurada: boolean;
  clave_final: string;
  modo_plataforma: boolean;
  proveedores_plataforma: ProveedorPlataforma[];
  remitente_plataforma: string;
  nombre_plataforma: string;
};

export async function leerConfigCorreo(db: D1Database, env?: Record<string, unknown>): Promise<ConfigCorreo & { clave: string }> {
  const plat = leerConfigPlataforma(env);
  const { results } = await db
    .prepare(`SELECT clave, valor FROM integraciones WHERE clave LIKE 'correo_%'`)
    .all<{ clave: string; valor: string }>()
    .catch(() => ({ results: [] as { clave: string; valor: string }[] }));
  const m = Object.fromEntries(results.map((r) => [r.clave.replace("correo_", ""), r.valor]));
  const claveLocal = (await descifrarSecreto(m.clave, env)) || "";
  const proveedorLocal = (m.proveedor === "BREVO" ? "BREVO" : "RESEND") as "RESEND" | "BREVO";

  if (plat.activo) {
    const provActivo = plat.proveedores_disponibles[0] || "BREVO";
    const clavePlat = plat.claves[provActivo] || "";
    return {
      proveedor: provActivo,
      remitente: plat.remitente,
      nombre_remitente: plat.nombre_plataforma,
      clave: clavePlat,
      clave_configurada: true,
      clave_final: clavePlat ? clavePlat.slice(-4) : "",
      modo_plataforma: true,
      proveedores_plataforma: plat.proveedores_disponibles,
      remitente_plataforma: plat.remitente,
      nombre_plataforma: plat.nombre_plataforma,
    };
  }

  const envFrom = typeof env?.EMAIL_FROM === "string" ? env.EMAIL_FROM : "";
  const remitente = m.remitente || envFrom || "facturas@mail.facturayave.com";
  const nombre_remitente = m.nombre_remitente || "FacturaYa Venezuela";
  return {
    proveedor: proveedorLocal,
    remitente,
    nombre_remitente,
    clave: claveLocal,
    clave_configurada: !!claveLocal,
    clave_final: claveLocal ? claveLocal.slice(-4) : "",
    modo_plataforma: false,
    proveedores_plataforma: [],
    remitente_plataforma: plat.remitente,
    nombre_plataforma: plat.nombre_plataforma,
  };
}

type PayloadAdaptador = {
  clave: string;
  remitente: string;
  nombreRemitente: string;
  para: string[];
  cc: string[];
  responderA?: string;
  asunto: string;
  html: string;
  texto?: string;
  adjuntos?: AdjuntoCorreo[];
  inquilinoCodigo: string;
  tipo: string;
  idempotencyKey?: string;
};

type ResultadoAdaptador =
  | { ok: true; messageId: string }
  | { ok: false; status: number; error: string };

async function enviarPorBrevo(p: PayloadAdaptador): Promise<ResultadoAdaptador> {
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": p.clave,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: p.nombreRemitente, email: p.remitente },
        to: p.para.map((email) => ({ email })),
        ...(p.cc.length ? { cc: p.cc.map((email) => ({ email })) } : {}),
        ...(p.responderA ? { replyTo: { email: p.responderA } } : {}),
        subject: p.asunto,
        htmlContent: p.html,
        ...(p.texto ? { textContent: p.texto } : {}),
        ...(p.adjuntos?.length ? { attachment: p.adjuntos.map((a) => ({ name: a.filename, content: a.content })) } : {}),
        tags: [`inq:${p.inquilinoCodigo}`, `tipo:${p.tipo}`],
      }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => "");
      return { ok: false, status: r.status, error: `Brevo rechazó el envío (${r.status}): ${err.slice(0, 160)}` };
    }
    const json = (await r.json().catch(() => ({}))) as { messageId?: string };
    return { ok: true, messageId: String(json?.messageId || "") };
  } catch (e) {
    return { ok: false, status: 0, error: `No se pudo conectar con Brevo: ${(e as Error).message}` };
  }
}

async function enviarPorResend(p: PayloadAdaptador): Promise<ResultadoAdaptador> {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${p.clave}`,
      "Content-Type": "application/json",
    };
    if (p.idempotencyKey) headers["Idempotency-Key"] = p.idempotencyKey;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: `${p.nombreRemitente} <${p.remitente}>`,
        to: p.para,
        ...(p.cc.length ? { cc: p.cc } : {}),
        ...(p.responderA ? { reply_to: p.responderA } : {}),
        subject: p.asunto,
        html: p.html,
        ...(p.texto ? { text: p.texto } : {}),
        ...(p.adjuntos?.length ? { attachments: p.adjuntos.map((a) => ({ filename: a.filename, content: a.content })) } : {}),
        tags: [
          { name: "inq", value: p.inquilinoCodigo.replace(/[^a-zA-Z0-9_-]/g, "_") },
          { name: "tipo", value: p.tipo.replace(/[^a-zA-Z0-9_-]/g, "_") },
        ],
      }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => "");
      return { ok: false, status: r.status, error: `Resend rechazó el envío (${r.status}): ${err.slice(0, 160)}` };
    }
    const json = (await r.json().catch(() => ({}))) as { id?: string };
    return { ok: true, messageId: String(json?.id || "") };
  } catch (e) {
    return { ok: false, status: 0, error: `No se pudo conectar con Resend: ${(e as Error).message}` };
  }
}

async function enviarPorZeptoMail(p: PayloadAdaptador): Promise<ResultadoAdaptador> {
  try {
    const auth = p.clave.startsWith("Zoho-enczapikey") ? p.clave : `Zoho-enczapikey ${p.clave}`;
    const r = await fetch("https://api.zeptomail.com/v1.1/email", {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        from: { address: p.remitente, name: p.nombreRemitente },
        to: p.para.map((address) => ({ email_address: { address } })),
        ...(p.cc.length ? { cc: p.cc.map((address) => ({ email_address: { address } })) } : {}),
        ...(p.responderA ? { reply_to: [{ address: p.responderA }] } : {}),
        subject: p.asunto,
        htmlbody: p.html,
        ...(p.texto ? { textbody: p.texto } : {}),
        ...(p.adjuntos?.length
          ? {
              attachments: p.adjuntos.map((a) => ({
                name: a.filename,
                content: a.content,
                mime_type: a.filename.toLowerCase().endsWith(".pdf")
                  ? "application/pdf"
                  : a.filename.toLowerCase().endsWith(".csv")
                    ? "text/csv"
                    : "application/octet-stream",
              })),
            }
          : {}),
        client_reference: `inq:${p.inquilinoCodigo}|tipo:${p.tipo}`,
      }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => "");
      return { ok: false, status: r.status, error: `ZeptoMail rechazó el envío (${r.status}): ${err.slice(0, 160)}` };
    }
    const json = (await r.json().catch(() => ({}))) as { request_id?: string };
    return { ok: true, messageId: String(json?.request_id || "") };
  } catch (e) {
    return { ok: false, status: 0, error: `No se pudo conectar con ZeptoMail: ${(e as Error).message}` };
  }
}

async function despacharAdaptador(proveedor: ProveedorPlataforma, p: PayloadAdaptador): Promise<ResultadoAdaptador> {
  if (proveedor === "BREVO") return enviarPorBrevo(p);
  if (proveedor === "RESEND") return enviarPorResend(p);
  return enviarPorZeptoMail(p);
}

export async function enviarCorreo(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  opc: OpcionesCorreo
): Promise<{ ok: true; proveedor?: string; messageId?: string } | { ok: false; error: string }> {
  const destinatarios = (Array.isArray(opc.para) ? opc.para : [opc.para]).map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean);
  const copias = (opc.cc ? (Array.isArray(opc.cc) ? opc.cc : [opc.cc]) : [])
    .map((x) => String(x ?? "").trim().toLowerCase())
    .filter((x) => x && !destinatarios.includes(x));
  if (!destinatarios.length) return { ok: false, error: "No hay correo destinatario válido." };

  const tipo: TipoCorreo = opc.tipo || "GENERAL";
  const alcance: AlcanceCorreo = opc.alcance || (tipo === "DOCUMENTO" || tipo === "RECIBO" || tipo === "CIERRE" ? "INQUILINO" : "PLATAFORMA");
  const plat = leerConfigPlataforma(env);
  const { rawDb, inquilinoCodigo } = extraerContextoPlataforma(db, env, opc.inquilinoCodigo);

  // MODO LEGADO (sin secretos de plataforma configurados): mantiene compatibilidad exacta con integraciones del inquilino
  if (!plat.activo) {
    const cfg = await leerConfigCorreo(db, env);
    if (!cfg.clave) {
      return {
        ok: false,
        error: "Falta configurar la clave API de correo electrónico en Ajustes → Servicio de Correo (o los secretos de plataforma en Cloudflare).",
      };
    }
    const res = await despacharAdaptador(cfg.proveedor === "BREVO" ? "BREVO" : "RESEND", {
      clave: cfg.clave,
      remitente: cfg.remitente,
      nombreRemitente: cfg.nombre_remitente,
      para: destinatarios,
      cc: copias,
      responderA: opc.responderA,
      asunto: opc.asunto,
      html: opc.html,
      texto: opc.texto,
      adjuntos: opc.adjuntos,
      inquilinoCodigo,
      tipo,
      idempotencyKey: opc.idempotencyKey,
    });
    if (!res.ok) {
      await registrarEnvioInquilino(db, {
        tipo,
        destinatario: destinatarios.join(", "),
        asunto: opc.asunto,
        proveedor: cfg.proveedor,
        estado: "FALLIDO",
        motivo: res.error,
      });
      return { ok: false, error: res.error };
    }
    await registrarEnvioInquilino(db, {
      tipo,
      destinatario: destinatarios.join(", "),
      asunto: opc.asunto,
      proveedor: cfg.proveedor,
      estado: "ENVIADO",
      message_id: res.messageId,
    });
    return { ok: true, proveedor: cfg.proveedor, messageId: res.messageId };
  }

  // MODO PLATAFORMA (v4.7.0)
  await asegurarEsquemaCorreos(rawDb, env);
  const ahoraSeg = Math.floor(Date.now() / 1000);
  const fechaUtc = fechaUtcHoy(ahoraSeg * 1000);

  // 1) Verificar bloqueos por rebote duro, 3 rebotes blandos (1 hora) o queja de spam
  const todosDest = [...destinatarios, ...copias];
  const hashesDest: string[] = [];
  for (const d of todosDest) {
    const chk = await verificarDestinatarioBloqueado(rawDb, d, env, ahoraSeg);
    hashesDest.push(chk.hash);
    if (chk.bloqueado) {
      await incrementarUsoCorreo(rawDb, plat.proveedores_disponibles[0] || "BREVO", inquilinoCodigo, tipo, "bloqueados", 1, fechaUtc);
      await registrarEnvioInquilino(db, {
        tipo,
        destinatario: d,
        asunto: opc.asunto,
        proveedor: "BLOQUEO",
        estado: "BLOQUEADO",
        motivo: chk.mensaje || "Destinatario bloqueado.",
      });
      return { ok: false, error: chk.mensaje || `El correo a ${d} está bloqueado.` };
    }
  }

  // 2) Revisar fusible de seguridad del inquilino (salvo alertas del sistema)
  const [usoHoy, circuitos, limites] = await Promise.all([
    leerUsoHoy(rawDb, inquilinoCodigo, fechaUtc),
    leerCircuitos(rawDb),
    leerLimitesInquilino(rawDb, inquilinoCodigo),
  ]);
  const cantidadDest = todosDest.length;
  if (tipo !== "ALERTA" && limites.fusible_diario > 0 && usoHoy.delInquilino + cantidadDest > limites.fusible_diario) {
    const msgFusible = `Se alcanzó el tope diario de seguridad (${limites.fusible_diario} correos/día) para esta empresa. Contacta al administrador si necesitas ampliarlo.`;
    await registrarAlertaCorreo(rawDb, {
      clave: `fusible:${inquilinoCodigo}:${fechaUtc}`,
      nivel: "CRITICO",
      titulo: `Fusible diario activado en ${inquilinoCodigo}`,
      detalle: `Se detuvo un envío de ${inquilinoCodigo} al superar el fusible de ${limites.fusible_diario} correos/día (${fechaUtc} UTC).`,
      inquilino_codigo: inquilinoCodigo,
    });
    await incrementarUsoCorreo(rawDb, plat.proveedores_disponibles[0] || "BREVO", inquilinoCodigo, tipo, "bloqueados", 1, fechaUtc);
    await registrarEnvioInquilino(db, {
      tipo,
      destinatario: destinatarios.join(", "),
      asunto: opc.asunto,
      proveedor: "FUSIBLE",
      estado: "BLOQUEADO",
      motivo: msgFusible,
    });
    return { ok: false, error: msgFusible };
  }

  // 3) Construir identidad (negocio + Reply-To para INQUILINO; FacturaYa para PLATAFORMA)
  let perfil: PerfilIdentidadCorreo | null = null;
  if (alcance === "INQUILINO") {
    perfil = await db
      .prepare(`SELECT nombre_razon_social, rif, direccion_fiscal, telefono, email FROM perfil_emisor WHERE id = 1`)
      .first<PerfilIdentidadCorreo>()
      .catch(() => null);
  }
  const identidad = construirIdentidadEnvio(alcance, plat, perfil, opc.responderA);
  const htmlFinal = identidad.pieHtml && !opc.html.includes("Enviado mediante") ? `${opc.html}${identidad.pieHtml}` : opc.html;
  const textoFinal = opc.texto
    ? identidad.pieTexto && !opc.texto.includes("Enviado mediante")
      ? `${opc.texto}${identidad.pieTexto}`
      : opc.texto
    : undefined;

  // 4) Planificar cadena de proveedores (BREVO -> RESEND -> ZEPTOMAIL)
  const disponibles = opc.forzarProveedor
    ? plat.proveedores_disponibles.includes(opc.forzarProveedor)
      ? [opc.forzarProveedor]
      : []
    : plat.proveedores_disponibles;

  if (!disponibles.length) {
    return { ok: false, error: `El proveedor ${opc.forzarProveedor || "de correo"} no tiene clave configurada en Cloudflare.` };
  }

  const plan = seleccionarCadenaProveedores(disponibles, usoHoy.porProveedor, circuitos, plat.cuotas, ahoraSeg);
  if (!plan.orden.length) {
    const todoPorCuota = plan.omitidos.length > 0 && plan.omitidos.every((o) => o.razon === "cuota_agotada");
    const msg = todoPorCuota
      ? "Cuota diaria del proveedor de correo agotada. Reintenta más tarde."
      : "Todos los proveedores de correo están temporalmente en enfriamiento por fallos previos. Reintenta en unos minutos.";
    await registrarAlertaCorreo(rawDb, {
      clave: `sin_prov:${fechaUtc}`,
      nivel: "CRITICO",
      titulo: todoPorCuota ? "Cuota diaria de correo agotada" : "Proveedores de correo no disponibles",
      detalle: msg,
      inquilino_codigo: inquilinoCodigo,
    });
    await incrementarUsoCorreo(rawDb, disponibles[0], inquilinoCodigo, tipo, "fallidos", 1, fechaUtc);
    await registrarEnvioInquilino(db, {
      tipo,
      destinatario: destinatarios.join(", "),
      asunto: opc.asunto,
      proveedor: disponibles[0],
      estado: "FALLIDO",
      motivo: msg,
    });
    return { ok: false, error: msg };
  }

  // 5) Ejecutar intento + failover inmediato al siguiente proveedor sano en la misma petición
  const idempKey = opc.idempotencyKey || `${inquilinoCodigo}-${tipo}-${ahoraSeg}-${crypto.randomUUID().slice(0, 8)}`;
  let ultimoError = "";
  let ultimoFueCuota = false;
  let ultimoProveedor: ProveedorPlataforma = plan.orden[0];

  for (const prov of plan.orden) {
    ultimoProveedor = prov;
    const res = await despacharAdaptador(prov, {
      clave: plat.claves[prov],
      remitente: identidad.remitente,
      nombreRemitente: identidad.nombreRemitente,
      para: destinatarios,
      cc: copias,
      responderA: identidad.responderA,
      asunto: opc.asunto,
      html: htmlFinal,
      texto: textoFinal,
      adjuntos: opc.adjuntos,
      inquilinoCodigo,
      tipo,
      idempotencyKey: idempKey,
    });

    if (res.ok) {
      await limpiarCircuito(rawDb, prov);
      await incrementarUsoCorreo(rawDb, prov, inquilinoCodigo, tipo, "enviados", cantidadDest, fechaUtc);
      if (res.messageId) {
        await rawDb
          .prepare(
            `INSERT OR REPLACE INTO _mt_correos_indice (message_id, proveedor, inquilino_codigo, tipo, email_hash, creado_en)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`
          )
          .bind(res.messageId, prov, inquilinoCodigo, tipo, hashesDest[0] || "")
          .run()
          .catch(() => {});
      }
      await registrarEnvioInquilino(db, {
        tipo,
        destinatario: destinatarios.join(", "),
        asunto: opc.asunto,
        proveedor: prov,
        estado: "ENVIADO",
        message_id: res.messageId,
      });
      await evaluarAlertasDespuesEnvio(
        rawDb,
        prov,
        (usoHoy.porProveedor[prov] || 0) + cantidadDest,
        plat.cuotas[prov],
        inquilinoCodigo,
        usoHoy.delInquilino + cantidadDest,
        limites.alerta_diaria,
        fechaUtc
      );
      return { ok: true, proveedor: prov, messageId: res.messageId };
    }

    const clas = clasificarFalloHttpProveedor(res.status);
    ultimoError = res.error;
    ultimoFueCuota = clas.esCuota;
    if (clas.abrirCircuito) {
      await registrarFalloCircuito(rawDb, prov, res.status, res.error, clas.segundosEnfriamiento, ahoraSeg);
      if (clas.esCuota) {
        await registrarAlertaCorreo(rawDb, {
          clave: `cuota_http:${prov}:${fechaUtc}`,
          nivel: "CRITICO",
          titulo: `${prov} devolvió límite/cuota (HTTP ${res.status})`,
          detalle: `${res.error}. Se activó enfriamiento y failover automático si hay respaldo configurado.`,
          proveedor: prov,
        });
      }
    }
    if (!clas.reintentable) break;
  }

  const msgFinal = ultimoFueCuota
    ? "Cuota diaria del proveedor de correo agotada. Reintenta más tarde."
    : ultimoError || "No se pudo enviar el correo electrónico.";
  await incrementarUsoCorreo(rawDb, ultimoProveedor, inquilinoCodigo, tipo, "fallidos", 1, fechaUtc);
  await registrarEnvioInquilino(db, {
    tipo,
    destinatario: destinatarios.join(", "),
    asunto: opc.asunto,
    proveedor: ultimoProveedor,
    estado: "FALLIDO",
    motivo: msgFinal,
  });
  return { ok: false, error: msgFinal };
}
