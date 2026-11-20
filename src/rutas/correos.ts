// Rutas del Correo de Plataforma (v4.7.0):
// - Webhooks públicos fail-closed: POST /api/correo/eventos/:proveedor (brevo | resend | zeptomail)
// - Historial propio del inquilino: GET /api/correos/historial (Dueño / Admin y Súper Admin)
// - Panel global de correos, cuotas, circuitos, bloqueos, límites y pruebas: /api/correos/* (EXCLUSIVO Súper Admin)
import { Hono } from "hono";
import { EMAIL, auditar, falla, leerJson, texto, type Env } from "../comun";
import { hmacTextoPlataforma } from "../cifrado";
import { enviarCorreo, leerConfigCorreo } from "../correo";
import {
  ALERTA_DIARIA_DEFECTO,
  FUSIBLE_DIARIO_DEFECTO,
  PROVEEDORES_PLATAFORMA,
  asegurarEsquemaCorreos,
  fechaUtcHoy,
  leerCircuitos,
  leerConfigPlataforma,
  limpiarCircuito,
  mesUtcActual,
  procesarEventoWebhook,
  verificarFirmaWebhook,
  type ProveedorPlataforma,
} from "../correo-plataforma";
import { hidratarBindingsCloudflare } from "../inquilinos";

// 1) Webhooks públicos (excluidos de sesión y Turnstile, pero autenticados criptográficamente fail-closed)
export const webhookCorreo = new Hono<Env>();

webhookCorreo.post("/eventos/:proveedor", async (c) => {
  const provRaw = String(c.req.param("proveedor") ?? "").trim().toUpperCase();
  if (provRaw !== "BREVO" && provRaw !== "RESEND" && provRaw !== "ZEPTOMAIL") {
    return falla(c, 404, "Proveedor de correo no reconocido.");
  }
  const proveedor = provRaw as ProveedorPlataforma;
  const envObj = c.env as unknown as Record<string, unknown>;
  const rawBody = await c.req.text().catch(() => "");
  const verif = await verificarFirmaWebhook(proveedor, c.req.raw, rawBody, envObj);
  if (!verif.ok) {
    return c.json({ ok: false, error: verif.error }, verif.status);
  }

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return falla(c, 400, "JSON de webhook inválido.");
  }

  const rawDb = c.get("rawDb") || c.env.DB;
  await asegurarEsquemaCorreos(rawDb, envObj);
  await hidratarBindingsCloudflare(rawDb, envObj);

  const lista = Array.isArray(payload) ? payload : [payload];
  let procesados = 0;
  for (const item of lista) {
    if (!item || typeof item !== "object") continue;
    const r = await procesarEventoWebhook(rawDb, envObj, proveedor, item as Record<string, unknown>);
    if (r.procesado) procesados++;
  }
  return c.json({ ok: true, proveedor, procesados });
});

// 2) Rutas autenticadas (/api/correos/*)
const correos = new Hono<Env>();

// Historial propio del inquilino actual (Dueño/Admin y Súper Admin)
correos.get("/historial", async (c) => {
  const db = c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const limite = Math.min(100, Math.max(10, Number(c.req.query("limite") || 50)));
  const estadoFiltro = texto(c.req.query("estado"), 20).toUpperCase();

  const where = estadoFiltro && ["ENVIADO", "ENTREGADO", "REBOTADO", "QUEJA", "BLOQUEADO", "FALLIDO"].includes(estadoFiltro)
    ? `WHERE estado = ?`
    : "";
  const binds = where ? [estadoFiltro, limite] : [limite];

  const [filas, resumen, cfg, perfil] = await Promise.all([
    db
      .prepare(
        `SELECT id, creado_en, tipo, destinatario, asunto, proveedor, estado, motivo
         FROM correo_envios ${where}
         ORDER BY id DESC LIMIT ?`
      )
      .bind(...binds)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] })),
    db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN estado = 'ENVIADO' THEN 1 ELSE 0 END), 0) AS enviados,
           COALESCE(SUM(CASE WHEN estado = 'ENTREGADO' THEN 1 ELSE 0 END), 0) AS entregados,
           COALESCE(SUM(CASE WHEN estado = 'REBOTADO' THEN 1 ELSE 0 END), 0) AS rebotados,
           COALESCE(SUM(CASE WHEN estado = 'QUEJA' THEN 1 ELSE 0 END), 0) AS quejas,
           COALESCE(SUM(CASE WHEN estado = 'BLOQUEADO' THEN 1 ELSE 0 END), 0) AS bloqueados,
           COALESCE(SUM(CASE WHEN estado = 'FALLIDO' THEN 1 ELSE 0 END), 0) AS fallidos
         FROM correo_envios`
      )
      .first<Record<string, number>>()
      .catch(() => null),
    leerConfigCorreo(db, envObj),
    db
      .prepare(`SELECT nombre_razon_social, email FROM perfil_emisor WHERE id = 1`)
      .first<{ nombre_razon_social: string; email: string | null }>()
      .catch(() => null),
  ]);

  return c.json({
    ok: true,
    modo_plataforma: cfg.modo_plataforma,
    remitente_plataforma: cfg.remitente_plataforma,
    nombre_plataforma: cfg.nombre_plataforma,
    negocio_nombre: perfil?.nombre_razon_social || "",
    reply_to: perfil?.email || "",
    resumen: resumen || { total: 0, enviados: 0, entregados: 0, rebotados: 0, quejas: 0, bloqueados: 0, fallidos: 0 },
    envios: filas.results || [],
  });
});

// Panel Global del Súper Admin (protegido por RBAC ["super"] en permisos.ts)
correos.get("/panel", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  await asegurarEsquemaCorreos(rawDb, envObj);

  const hoyUtc = fechaUtcHoy();
  const mesUtc = mesUtcActual();
  const ahoraSeg = Math.floor(Date.now() / 1000);
  const plat = leerConfigPlataforma(envObj);
  const circuitos = await leerCircuitos(rawDb);

  const [usoProvHoy, usoProvMes, usoInqHoy, usoInqMes, inquilinosRes, limitesRes, alertasRes, bloqueosRes] = await Promise.all([
    rawDb
      .prepare(
        `SELECT proveedor,
           COALESCE(SUM(enviados), 0) AS enviados,
           COALESCE(SUM(entregados), 0) AS entregados,
           COALESCE(SUM(fallidos), 0) AS fallidos,
           COALESCE(SUM(rebotes_duros), 0) AS rebotes_duros,
           COALESCE(SUM(rebotes_blandos), 0) AS rebotes_blandos,
           COALESCE(SUM(quejas), 0) AS quejas,
           COALESCE(SUM(bloqueados), 0) AS bloqueados
         FROM _mt_correos_uso WHERE fecha_utc = ? GROUP BY proveedor`
      )
      .bind(hoyUtc)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] })),
    rawDb
      .prepare(
        `SELECT proveedor,
           COALESCE(SUM(enviados), 0) AS enviados,
           COALESCE(SUM(entregados), 0) AS entregados,
           COALESCE(SUM(fallidos), 0) AS fallidos,
           COALESCE(SUM(rebotes_duros), 0) AS rebotes_duros,
           COALESCE(SUM(rebotes_blandos), 0) AS rebotes_blandos,
           COALESCE(SUM(quejas), 0) AS quejas,
           COALESCE(SUM(bloqueados), 0) AS bloqueados
         FROM _mt_correos_uso WHERE substr(fecha_utc, 1, 7) = ? GROUP BY proveedor`
      )
      .bind(mesUtc)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] })),
    rawDb
      .prepare(
        `SELECT inquilino_codigo,
           COALESCE(SUM(enviados), 0) AS enviados,
           COALESCE(SUM(entregados), 0) AS entregados,
           COALESCE(SUM(fallidos), 0) AS fallidos,
           COALESCE(SUM(rebotes_duros), 0) AS rebotes_duros,
           COALESCE(SUM(rebotes_blandos), 0) AS rebotes_blandos,
           COALESCE(SUM(quejas), 0) AS quejas,
           COALESCE(SUM(bloqueados), 0) AS bloqueados
         FROM _mt_correos_uso WHERE fecha_utc = ? GROUP BY inquilino_codigo`
      )
      .bind(hoyUtc)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] })),
    rawDb
      .prepare(
        `SELECT inquilino_codigo,
           COALESCE(SUM(enviados), 0) AS enviados,
           COALESCE(SUM(entregados), 0) AS entregados,
           COALESCE(SUM(fallidos), 0) AS fallidos,
           COALESCE(SUM(rebotes_duros), 0) AS rebotes_duros,
           COALESCE(SUM(rebotes_blandos), 0) AS rebotes_blandos,
           COALESCE(SUM(quejas), 0) AS quejas,
           COALESCE(SUM(bloqueados), 0) AS bloqueados
         FROM _mt_correos_uso WHERE substr(fecha_utc, 1, 7) = ? GROUP BY inquilino_codigo`
      )
      .bind(mesUtc)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] })),
    rawDb
      .prepare(`SELECT codigo, nombre_negocio, rif, activo FROM _mt_inquilinos ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, codigo ASC`)
      .all<{ codigo: string; nombre_negocio: string; rif: string; activo: number }>()
      .catch(() => ({ results: [] as { codigo: string; nombre_negocio: string; rif: string; activo: number }[] })),
    rawDb
      .prepare(`SELECT inquilino_codigo, alerta_diaria, fusible_diario FROM _mt_correos_limites`)
      .all<{ inquilino_codigo: string; alerta_diaria: number; fusible_diario: number }>()
      .catch(() => ({ results: [] as { inquilino_codigo: string; alerta_diaria: number; fusible_diario: number }[] })),
    rawDb
      .prepare(`SELECT clave, nivel, titulo, detalle, inquilino_codigo, proveedor, actualizado_en FROM _mt_correos_alertas ORDER BY actualizado_en DESC LIMIT 40`)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] })),
    rawDb
      .prepare(
        `SELECT email_hash, mascara, tipo, motivo, contador, bloqueado_hasta, inquilino_origen, actualizado_en
         FROM _mt_correos_bloqueos
         WHERE bloqueado_hasta = -1 OR bloqueado_hasta > ?
         ORDER BY actualizado_en DESC LIMIT 100`
      )
      .bind(ahoraSeg)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] })),
  ]);

  const mapProvHoy = new Map((usoProvHoy.results || []).map((r) => [String(r.proveedor), r]));
  const mapProvMes = new Map((usoProvMes.results || []).map((r) => [String(r.proveedor), r]));

  const proveedores = PROVEEDORES_PLATAFORMA.map((p) => {
    const h = mapProvHoy.get(p) || {};
    const m = mapProvMes.get(p) || {};
    const circ = circuitos[p];
    const circuitoAbierto = Boolean(circ && Number(circ.abierto_hasta || 0) > ahoraSeg);
    const cuota = plat.cuotas[p];
    const envHoy = Number(h.enviados || 0);
    return {
      proveedor: p,
      configurado: Boolean(plat.claves[p]),
      activo_en_cadena: Boolean(plat.claves[p]) && !circuitoAbierto,
      cuota_diaria: cuota,
      porcentaje_hoy: cuota > 0 ? Math.min(100, Math.round((envHoy / cuota) * 100)) : 0,
      hoy: {
        enviados: envHoy,
        entregados: Number(h.entregados || 0),
        fallidos: Number(h.fallidos || 0),
        rebotes: Number(h.rebotes_duros || 0) + Number(h.rebotes_blandos || 0),
        quejas: Number(h.quejas || 0),
        bloqueados: Number(h.bloqueados || 0),
      },
      mes: {
        enviados: Number(m.enviados || 0),
        entregados: Number(m.entregados || 0),
        fallidos: Number(m.fallidos || 0),
        rebotes: Number(m.rebotes_duros || 0) + Number(m.rebotes_blandos || 0),
        quejas: Number(m.quejas || 0),
        bloqueados: Number(m.bloqueados || 0),
      },
      circuito: {
        abierto: circuitoAbierto,
        segundos_restantes: circuitoAbierto ? Math.max(0, Number(circ!.abierto_hasta) - ahoraSeg) : 0,
        fallos_consecutivos: Number(circ?.fallos_consecutivos || 0),
        ultimo_error: circ?.ultimo_error || "",
        ultimo_estado_http: Number(circ?.ultimo_estado_http || 0),
      },
    };
  });

  const mapInqHoy = new Map((usoInqHoy.results || []).map((r) => [String(r.inquilino_codigo), r]));
  const mapInqMes = new Map((usoInqMes.results || []).map((r) => [String(r.inquilino_codigo), r]));
  const mapLimites = new Map((limitesRes.results || []).map((r) => [r.inquilino_codigo, r]));
  const codigos = new Set<string>([
    ...(inquilinosRes.results || []).map((i) => i.codigo),
    ...mapInqHoy.keys(),
    ...mapInqMes.keys(),
  ]);
  const mapInfoInq = new Map((inquilinosRes.results || []).map((i) => [i.codigo, i]));

  let globalEnvMes = 0;
  let globalRebMes = 0;
  let globalQuejasMes = 0;
  let globalEnvHoy = 0;

  const por_inquilino = [...codigos].map((cod) => {
    const info = mapInfoInq.get(cod);
    const h = mapInqHoy.get(cod) || {};
    const m = mapInqMes.get(cod) || {};
    const lim = mapLimites.get(cod);
    const envH = Number(h.enviados || 0);
    const envM = Number(m.enviados || 0);
    const rebM = Number(m.rebotes_duros || 0) + Number(m.rebotes_blandos || 0);
    const quejM = Number(m.quejas || 0);
    globalEnvHoy += envH;
    globalEnvMes += envM;
    globalRebMes += rebM;
    globalQuejasMes += quejM;
    return {
      codigo: cod,
      nombre_negocio: info?.nombre_negocio || cod,
      rif: info?.rif || "",
      alerta_diaria: lim ? Number(lim.alerta_diaria) : ALERTA_DIARIA_DEFECTO,
      fusible_diario: lim ? Number(lim.fusible_diario) : FUSIBLE_DIARIO_DEFECTO,
      hoy: {
        enviados: envH,
        entregados: Number(h.entregados || 0),
        fallidos: Number(h.fallidos || 0),
        rebotes: Number(h.rebotes_duros || 0) + Number(h.rebotes_blandos || 0),
        quejas: Number(h.quejas || 0),
        bloqueados: Number(h.bloqueados || 0),
      },
      mes: {
        enviados: envM,
        entregados: Number(m.entregados || 0),
        fallidos: Number(m.fallidos || 0),
        rebotes: rebM,
        quejas: quejM,
        bloqueados: Number(m.bloqueados || 0),
      },
      tasa_rebotes_mes: envM > 0 ? Number(((rebM / envM) * 100).toFixed(2)) : 0,
      tasa_quejas_mes: envM > 0 ? Number(((quejM / envM) * 100).toFixed(2)) : 0,
    };
  });

  const secretos = {
    BREVO_API_KEY: Boolean(plat.claves.BREVO),
    RESEND_API_KEY: Boolean(plat.claves.RESEND),
    ZEPTOMAIL_API_KEY: Boolean(plat.claves.ZEPTOMAIL),
    BREVO_WEBHOOK_SECRET: Boolean(typeof envObj.BREVO_WEBHOOK_SECRET === "string" && envObj.BREVO_WEBHOOK_SECRET.trim()),
    RESEND_WEBHOOK_SECRET: Boolean(typeof envObj.RESEND_WEBHOOK_SECRET === "string" && envObj.RESEND_WEBHOOK_SECRET.trim()),
    ZEPTOMAIL_WEBHOOK_SECRET: Boolean(typeof envObj.ZEPTOMAIL_WEBHOOK_SECRET === "string" && envObj.ZEPTOMAIL_WEBHOOK_SECRET.trim()),
  };

  return c.json({
    ok: true,
    fecha_utc: hoyUtc,
    mes_utc: mesUtc,
    modo_plataforma: plat.activo,
    remitente: plat.remitente,
    nombre_plataforma: plat.nombre_plataforma,
    secretos,
    resumen_global: {
      enviados_hoy: globalEnvHoy,
      enviados_mes: globalEnvMes,
      rebotes_mes: globalRebMes,
      quejas_mes: globalQuejasMes,
      tasa_rebotes_mes: globalEnvMes > 0 ? Number(((globalRebMes / globalEnvMes) * 100).toFixed(2)) : 0,
      tasa_quejas_mes: globalEnvMes > 0 ? Number(((globalQuejasMes / globalEnvMes) * 100).toFixed(2)) : 0,
      bloqueos_activos: (bloqueosRes.results || []).length,
      alertas_activas: (alertasRes.results || []).length,
    },
    proveedores,
    por_inquilino,
    alertas: alertasRes.results || [],
    bloqueos: bloqueosRes.results || [],
  });
});

// Envío de prueba desde el Panel del Súper Admin (opcionalmente forzando proveedor)
correos.post("/probar", async (c) => {
  const b = await leerJson(c);
  const yo = c.get("usuario");
  const destino = texto(b.para || yo.email, 120).toLowerCase();
  if (!EMAIL.test(destino)) return falla(c, 400, "Escribe un correo destinatario válido.");
  const provRaw = texto(b.proveedor, 20).toUpperCase();
  const forzarProveedor =
    provRaw === "BREVO" || provRaw === "RESEND" || provRaw === "ZEPTOMAIL"
      ? (provRaw as ProveedorPlataforma)
      : undefined;

  const r = await enviarCorreo(c.env.DB, c.env as unknown as Record<string, unknown>, {
    para: destino,
    asunto: `✅ Prueba de Correo de Plataforma${forzarProveedor ? ` (${forzarProveedor})` : ""} · FacturaYa Venezuela`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:22px;border:1px solid #dde3ec;border-radius:14px">
      <h2 style="margin:0 0 10px;color:#1A73E8">✉️ Correo de Plataforma Operativo</h2>
      <p>Prueba despachada desde el Panel Global de Súper Admin de <b>FacturaYa Venezuela</b>.</p>
    </div>`,
    texto: "Prueba despachada desde el Panel Global de Súper Admin de FacturaYa Venezuela.",
    alcance: "PLATAFORMA",
    tipo: "PRUEBA",
    forzarProveedor,
  });
  if (!r.ok) return falla(c, 400, r.error);
  await auditar(c, yo.id, "CORREO_PLAT_PRUEBA", `${r.proveedor || "AUTO"}`);
  return c.json({ ok: true, proveedor: r.proveedor, destino });
});

// Desbloquear un correo (por email_hash o escribiendo la dirección que se hashea en el servidor)
correos.post("/bloqueos/desbloquear", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c);
  await asegurarEsquemaCorreos(rawDb, envObj);

  let hash = texto(b.email_hash, 128);
  const email = texto(b.email, 160).toLowerCase();
  if (!hash && email) {
    if (!EMAIL.test(email)) return falla(c, 400, "Escribe un correo válido para desbloquear.");
    hash = await hmacTextoPlataforma("correo-bloqueo", email, envObj, rawDb);
  }
  if (!hash) return falla(c, 400, "Indica el bloqueo o correo a desbloquear.");

  const res = await rawDb.prepare(`DELETE FROM _mt_correos_bloqueos WHERE email_hash = ?`).bind(hash).run();
  await auditar(c, c.get("usuario").id, "CORREO_DESBLOQUEAR", `hash:${hash.slice(0, 12)}`);
  return c.json({ ok: true, eliminados: Number(res.meta?.changes ?? 0) });
});

// Reiniciar manualmente un circuito abierto de un proveedor
correos.post("/circuitos/reiniciar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c);
  const prov = texto(b.proveedor, 20).toUpperCase();
  if (prov !== "BREVO" && prov !== "RESEND" && prov !== "ZEPTOMAIL") {
    return falla(c, 400, "Proveedor inválido.");
  }
  await asegurarEsquemaCorreos(rawDb, envObj);
  await limpiarCircuito(rawDb, prov as ProveedorPlataforma);
  await auditar(c, c.get("usuario").id, "CORREO_CIRCUITO_RESET", prov);
  return c.json({ ok: true, proveedor: prov });
});

// Configurar alerta suave y fusible diario por inquilino (fusible = 0 quita el tope)
correos.put("/limites/:codigo", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const codigo = texto(c.req.param("codigo"), 40);
  if (!codigo) return falla(c, 400, "Código de inquilino inválido.");
  const b = await leerJson(c);
  const alerta = Math.max(0, Math.min(100_000, Math.trunc(Number(b.alerta_diaria ?? ALERTA_DIARIA_DEFECTO))));
  const fusible = Math.max(0, Math.min(500_000, Math.trunc(Number(b.fusible_diario ?? FUSIBLE_DIARIO_DEFECTO))));
  if (!Number.isFinite(alerta) || !Number.isFinite(fusible)) return falla(c, 400, "Valores de límite inválidos.");

  await asegurarEsquemaCorreos(rawDb, envObj);
  await rawDb
    .prepare(
      `INSERT INTO _mt_correos_limites (inquilino_codigo, alerta_diaria, fusible_diario, actualizado_en)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(inquilino_codigo) DO UPDATE SET
         alerta_diaria = excluded.alerta_diaria,
         fusible_diario = excluded.fusible_diario,
         actualizado_en = datetime('now')`
    )
    .bind(codigo, alerta, fusible)
    .run();
  await auditar(c, c.get("usuario").id, "CORREO_LIMITES", `${codigo} alerta=${alerta} fusible=${fusible}`);
  return c.json({ ok: true, codigo, alerta_diaria: alerta, fusible_diario: fusible });
});

// Descartar una alerta resuelta
correos.delete("/alertas/:clave", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const clave = decodeURIComponent(c.req.param("clave") || "");
  if (!clave) return falla(c, 400, "Clave de alerta inválida.");
  await asegurarEsquemaCorreos(rawDb, envObj);
  await rawDb.prepare(`DELETE FROM _mt_correos_alertas WHERE clave = ?`).bind(clave).run();
  return c.json({ ok: true });
});

export default correos;
