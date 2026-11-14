// Módulo de envío de correos electrónicos por HTTP API (compatible con Cloudflare Workers sin puertos SMTP).
// Soporta Resend (https://api.resend.com/emails) y Brevo (https://api.brevo.com/v3/smtp/email).
// Puede configurarse mediante variables de entorno en Cloudflare (RESEND_API_KEY, EMAIL_FROM) o en Ajustes -> Servicio de Correo (tabla integraciones).

export type AdjuntoCorreo = { filename: string; content: string }; // content en Base64
export type OpcionesCorreo = {
  para: string | string[];
  cc?: string | string[];
  responderA?: string;
  asunto: string;
  html: string;
  texto?: string;
  adjuntos?: AdjuntoCorreo[];
};

export type ConfigCorreo = {
  proveedor: "RESEND" | "BREVO";
  remitente: string;
  nombre_remitente: string;
  clave_configurada: boolean;
  clave_final: string;
};

export async function leerConfigCorreo(db: D1Database, env?: Record<string, unknown>): Promise<ConfigCorreo & { clave: string }> {
  const { results } = await db.prepare(`SELECT clave, valor FROM integraciones WHERE clave LIKE 'correo_%'`).all<{ clave: string; valor: string }>();
  const m = Object.fromEntries(results.map((r) => [r.clave.replace("correo_", ""), r.valor]));
  const envKey = typeof env?.RESEND_API_KEY === "string" ? env.RESEND_API_KEY : "";
  const envFrom = typeof env?.EMAIL_FROM === "string" ? env.EMAIL_FROM : "";
  const clave = m.clave || envKey || "";
  const proveedor = (m.proveedor === "BREVO" ? "BREVO" : "RESEND") as "RESEND" | "BREVO";
  const remitente = m.remitente || envFrom || "notificaciones@facturaya.com";
  const nombre_remitente = m.nombre_remitente || "FacturaYa Venezuela";
  return {
    proveedor,
    remitente,
    nombre_remitente,
    clave,
    clave_configurada: !!clave,
    clave_final: clave ? clave.slice(-4) : "",
  };
}

export async function enviarCorreo(db: D1Database, env: Record<string, unknown> | undefined, opc: OpcionesCorreo): Promise<{ ok: true } | { ok: false; error: string }> {
  const cfg = await leerConfigCorreo(db, env);
  if (!cfg.clave) {
    return {
      ok: false,
      error: "Falta configurar la clave API de correo electrónico en Ajustes → Servicio de Correo (Resend o Brevo).",
    };
  }
  const destinatarios = (Array.isArray(opc.para) ? opc.para : [opc.para]).map((x) => x.trim()).filter(Boolean);
  const copias = (opc.cc ? (Array.isArray(opc.cc) ? opc.cc : [opc.cc]) : []).map((x) => x.trim()).filter((x) => x && !destinatarios.includes(x));
  if (!destinatarios.length) return { ok: false, error: "No hay correo destinatario válido." };

  try {
    if (cfg.proveedor === "BREVO") {
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": cfg.clave,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sender: { name: cfg.nombre_remitente, email: cfg.remitente },
          to: destinatarios.map((email) => ({ email })),
          ...(copias.length ? { cc: copias.map((email) => ({ email })) } : {}),
          ...(opc.responderA ? { replyTo: { email: opc.responderA } } : {}),
          subject: opc.asunto,
          htmlContent: opc.html,
          ...(opc.texto ? { textContent: opc.texto } : {}),
          ...(opc.adjuntos?.length ? { attachment: opc.adjuntos.map((a) => ({ name: a.filename, content: a.content })) } : {}),
        }),
      });
      if (!r.ok) {
        const err = await r.text().catch(() => "");
        return { ok: false, error: `Brevo rechazó el envío (${r.status}): ${err.slice(0, 160)}` };
      }
      return { ok: true };
    }

    // Por defecto: Resend API (https://api.resend.com/emails)
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.clave}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${cfg.nombre_remitente} <${cfg.remitente}>`,
        to: destinatarios,
        ...(copias.length ? { cc: copias } : {}),
        ...(opc.responderA ? { reply_to: opc.responderA } : {}),
        subject: opc.asunto,
        html: opc.html,
        ...(opc.texto ? { text: opc.texto } : {}),
        ...(opc.adjuntos?.length ? { attachments: opc.adjuntos.map((a) => ({ filename: a.filename, content: a.content })) } : {}),
      }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => "");
      return { ok: false, error: `Resend rechazó el envío (${r.status}): ${err.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `No se pudo conectar con el servidor de correo: ${(e as Error).message}` };
  }
}
