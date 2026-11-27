// Protección contra ataques de fuerza bruta por IP global, límite de carga útil y verificación opcional de Cloudflare Turnstile.
import { ahora } from "./comun";

export const POLITICA_LIMITE = {
  LOGIN_IP: { ambito: "login_ip", maxIntentos: 20, ventanaSeg: 600, bloqueoSeg: 900 },
  RECUPERAR_IP: { ambito: "rec_ip", maxIntentos: 12, ventanaSeg: 900, bloqueoSeg: 900 },
  CORREO_REC_IP: { ambito: "reccor_ip", maxIntentos: 6, ventanaSeg: 900, bloqueoSeg: 900 },
  INSTALAR_IP: { ambito: "inst_ip", maxIntentos: 10, ventanaSeg: 900, bloqueoSeg: 900 },
} as const;

export type PoliticaLimite = (typeof POLITICA_LIMITE)[keyof typeof POLITICA_LIMITE];

const tablaRateLimitAsegurada = new WeakSet<D1Database>();

export async function asegurarTablaLimitesRed(rawDb: D1Database) {
  if (tablaRateLimitAsegurada.has(rawDb)) return;
  await rawDb.prepare(
    `CREATE TABLE IF NOT EXISTS _mt_rate_limit (
      clave TEXT PRIMARY KEY,
      intentos INTEGER NOT NULL DEFAULT 0,
      ventana_inicio INTEGER NOT NULL,
      bloqueado_hasta INTEGER NOT NULL DEFAULT 0
    )`
  ).run();
  tablaRateLimitAsegurada.add(rawDb);
}

export async function verificarLimiteIp(
  rawDb: D1Database,
  politica: PoliticaLimite,
  ipCliente: string,
  t = ahora()
): Promise<{ bloqueado: boolean; esperarSeg: number }> {
  await asegurarTablaLimitesRed(rawDb);
  const clave = `${politica.ambito}|${ipCliente || "local"}`;
  const row = await rawDb
    .prepare(`SELECT intentos, ventana_inicio, bloqueado_hasta FROM _mt_rate_limit WHERE clave = ?`)
    .bind(clave)
    .first<{ intentos: number; ventana_inicio: number; bloqueado_hasta: number }>();
  if (!row) return { bloqueado: false, esperarSeg: 0 };
  if (row.bloqueado_hasta > t) {
    return { bloqueado: true, esperarSeg: row.bloqueado_hasta - t };
  }
  return { bloqueado: false, esperarSeg: 0 };
}

export async function registrarEventoIp(
  rawDb: D1Database,
  politica: PoliticaLimite,
  ipCliente: string,
  t = ahora()
): Promise<{ bloqueado: boolean; intentos: number }> {
  await asegurarTablaLimitesRed(rawDb);
  const clave = `${politica.ambito}|${ipCliente || "local"}`;
  const row = await rawDb
    .prepare(`SELECT intentos, ventana_inicio, bloqueado_hasta FROM _mt_rate_limit WHERE clave = ?`)
    .bind(clave)
    .first<{ intentos: number; ventana_inicio: number; bloqueado_hasta: number }>();

  const dentroVentana = row && t - row.ventana_inicio < politica.ventanaSeg;
  const intentos = dentroVentana ? row.intentos + 1 : 1;
  const ventanaInicio = dentroVentana ? row.ventana_inicio : t;
  const bloquear = intentos >= politica.maxIntentos;
  const bloqueadoHasta = bloquear ? t + politica.bloqueoSeg : 0;

  await rawDb
    .prepare(
      `INSERT INTO _mt_rate_limit (clave, intentos, ventana_inicio, bloqueado_hasta) VALUES (?, ?, ?, ?)
       ON CONFLICT(clave) DO UPDATE SET intentos = excluded.intentos, ventana_inicio = excluded.ventana_inicio, bloqueado_hasta = excluded.bloqueado_hasta`
    )
    .bind(clave, bloquear ? 0 : intentos, ventanaInicio, bloqueadoHasta)
    .run();

  // Limpieza oportunista de registros caducados para no inflar la base de datos
  if (Math.random() < 0.05) {
    await rawDb
      .prepare(`DELETE FROM _mt_rate_limit WHERE bloqueado_hasta <= ? AND (? - ventana_inicio) > ?`)
      .bind(t, t, politica.ventanaSeg * 2)
      .run()
      .catch(() => {});
  }

  return { bloqueado: bloquear, intentos };
}

export async function limpiarLimiteIp(rawDb: D1Database, politica: PoliticaLimite, ipCliente: string) {
  const clave = `${politica.ambito}|${ipCliente || "local"}`;
  await rawDb.prepare(`DELETE FROM _mt_rate_limit WHERE clave = ?`).bind(clave).run().catch(() => {});
}

export function limitePayloadPorRuta(ruta: string): number {
  if (ruta === "/api/config" || ruta === "/api/inquilinos") return 380_000; // permite logo_base64 optimizado
  if (/^\/api\/(?:documentos|pagos)\/\d+\/enviar-correo$/.test(ruta)) return 1_500_000; // permite PDF Base64 con logotipo
  if (ruta.startsWith("/api/sistema/restaurar/")) return 2_097_152; // hasta 2 MB por lote de respaldo
  return 262_144; // 256 KB por defecto
}

export type OpcionesTurnstile = {
  expectedAction?: string;
  allowedHostnames?: string;
  produccionEstricto?: boolean;
};

export async function verificarTurnstile(
  secretKey: string | undefined,
  token: string,
  ipCliente: string,
  fetchFn: typeof fetch = fetch,
  opciones?: OpcionesTurnstile
): Promise<{ ok: boolean; error?: string }> {
  const secreto = String(secretKey ?? "").trim();
  if (!secreto) {
    if (opciones?.produccionEstricto) {
      return { ok: false, error: "Verificación anti-bots obligatoria en este entorno (falta TURNSTILE_SECRET_KEY)." };
    }
    return { ok: true }; // Turnstile opcional cuando no se ha configurado clave secreta
  }
  if (typeof token !== "string") {
    return { ok: false, error: "Completa la verificación de seguridad anti-bots." };
  }
  const tok = token.trim();
  if (!tok || tok.length > 2048) {
    return { ok: false, error: "Completa la verificación de seguridad anti-bots." };
  }
  try {
    const form = new URLSearchParams();
    form.set("secret", secreto);
    form.set("response", tok);
    if (ipCliente && ipCliente !== "local") form.set("remoteip", ipCliente);
    const resp = await fetchFn("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: form,
    });
    const data = (await resp.json().catch(() => null)) as {
      success?: boolean;
      action?: string;
      hostname?: string;
    } | null;
    if (!resp.ok || !data?.success) {
      return { ok: false, error: "Verificación de seguridad expirada o inválida. Inténtalo de nuevo." };
    }
    if (opciones?.expectedAction && data.action !== opciones.expectedAction) {
      return { ok: false, error: "El token anti-bots no corresponde a esta acción. Inténtalo de nuevo." };
    }
    const permitidos = new Set(
      String(opciones?.allowedHostnames ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    );
    if (permitidos.size > 0 && !permitidos.has(String(data.hostname ?? "").trim().toLowerCase())) {
      return { ok: false, error: "Dominio no autorizado para la verificación anti-bots." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "No se pudo validar la verificación anti-bots. Reintenta en unos segundos." };
  }
}
