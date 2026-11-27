// Cifrado autenticado AES-256-GCM en reposo (enc:v2:<kid>:) y firma HMAC-SHA256 de respaldos para FacturaYa Venezuela v4.2.1.
// Compatible con WebCrypto estándar en Cloudflare Workers y Node.js 20+.
// Seguridad v4.2: Nunca usa una semilla estática del repositorio público para cifrar ni firmar respaldos HMAC.
const PREFIJO_CIFRADO_V1 = "enc:v1:";
const PREFIJO_CIFRADO_V2 = "enc:v2:";
const enc = new TextEncoder();
const dec = new TextDecoder();

const aB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const aHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Llave maestra obligatoria (v4.2.1): los secretos se cifran y los respaldos se firman SOLO con MASTER_KEY (wrangler secret put MASTER_KEY).
// Sin MASTER_KEY el sistema falla cerrado: no cifra, no inventa llaves en memoria y no firma. Los respaldos salen sin firma (nunca se bloquea una descarga).
// Para leer datos de versiones anteriores se conservan las llaves heredadas: la de la base (_mt_llave_plataforma, v4.2) y la derivada de TURNSTILE_SECRET_KEY.
// La semilla pública del repositorio solo sirve para LEER valores v1 / kid "def" ya guardados; nunca para cifrar ni para verificar firmas.
const SEMILLA_PUBLICA_LEGADA = "facturaya-ve-default-envelope-key-2026";

export class ErrorLlaveMaestra extends Error {
  codigo = "SIN_MASTER_KEY";
  constructor() {
    super("Falta la llave maestra MASTER_KEY. Configúrala con: wrangler secret put MASTER_KEY (mínimo 32 caracteres aleatorios).");
    this.name = "ErrorLlaveMaestra";
  }
}

const textoEnv = (env: Record<string, unknown> | undefined, k: string) => (typeof env?.[k] === "string" ? (env[k] as string).trim() : "");
export const llaveMaestraConfigurada = (env?: Record<string, unknown>) => textoEnv(env, "MASTER_KEY").length > 0;
// Solo desarrollo y pruebas: PERMITIR_LLAVE_EN_BD=1 habilita llaves derivadas de la base o de Turnstile cuando no hay MASTER_KEY. No usar en producción.
const permiteLlaveEnBd = (env?: Record<string, unknown>) => textoEnv(env, "PERMITIR_LLAVE_EN_BD") === "1";
export const exigirLlaveMaestra = (env?: Record<string, unknown>) => {
  if (!llaveMaestraConfigurada(env) && !permiteLlaveEnBd(env)) throw new ErrorLlaveMaestra();
};

// Llaves heredadas de la base (v4.2): solo lectura, para poder descifrar lo ya guardado hasta que se recifre con MASTER_KEY.
const llavesHeredadasBd = new Set<string>();
const heredadasCargadas = new WeakSet<object>();
const cacheLlaveDb = new WeakMap<D1Database, string>();

export async function cargarLlavesLegadas(rawDb?: D1Database | null): Promise<void> {
  if (!rawDb || heredadasCargadas.has(rawDb)) return;
  try {
    const fila = await rawDb.prepare(`SELECT secret FROM _mt_llave_plataforma WHERE id = 1`).first<{ secret: string }>();
    if (fila?.secret?.trim()) llavesHeredadasBd.add(fila.secret.trim());
    heredadasCargadas.add(rawDb);
  } catch (e) {
    // "no such table" = nunca hubo llave en la base. Cualquier otro error es transitorio: no se marca para reintentar.
    if (/no such table/i.test(String((e as Error)?.message ?? e))) heredadasCargadas.add(rawDb);
  }
}

// Con MASTER_KEY no hace nada. Sin ella y sin PERMITIR_LLAVE_EN_BD devuelve "" (no genera llaves). Con la bandera de desarrollo genera la llave en la base y NUNCA cae a una llave en memoria.
export async function asegurarLlavePlataforma(rawDb?: D1Database | null, env?: Record<string, unknown>): Promise<string> {
  const mk = textoEnv(env, "MASTER_KEY");
  if (mk) return mk;
  if (!permiteLlaveEnBd(env)) return "";
  const pkEnv = textoEnv(env, "__PLATFORM_KEY");
  if (pkEnv) return pkEnv;
  if (!rawDb) return "";
  const enCache = cacheLlaveDb.get(rawDb);
  if (enCache) {
    if (env) env.__PLATFORM_KEY = enCache;
    return enCache;
  }
  await rawDb
    .prepare(`CREATE TABLE IF NOT EXISTS _mt_llave_plataforma (id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL, creado_en TEXT NOT NULL DEFAULT (datetime('now')))`)
    .run();
  const candidata = aHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  await rawDb.prepare(`INSERT OR IGNORE INTO _mt_llave_plataforma (id, secret) VALUES (1, ?)`).bind(candidata).run();
  const fila = await rawDb.prepare(`SELECT secret FROM _mt_llave_plataforma WHERE id = 1`).first<{ secret: string }>();
  const finalSecret = fila?.secret?.trim();
  if (!finalSecret) throw new Error("No se pudo leer la llave de plataforma de la base de datos.");
  cacheLlaveDb.set(rawDb, finalSecret);
  llavesHeredadasBd.add(finalSecret);
  if (env) env.__PLATFORM_KEY = finalSecret;
  return finalSecret;
}

function obtenerSemillaActiva(env?: Record<string, unknown>): { kid: string; semilla: string } {
  const mk = textoEnv(env, "MASTER_KEY");
  if (mk) return { kid: "mk", semilla: `facturaya-master:${mk}` };
  if (!permiteLlaveEnBd(env)) throw new ErrorLlaveMaestra();
  const pk = textoEnv(env, "__PLATFORM_KEY") || (env?.DB ? cacheLlaveDb.get(env.DB as D1Database) || "" : "");
  if (pk) return { kid: "pk", semilla: `facturaya-platform:${pk}` };
  const ts = textoEnv(env, "TURNSTILE_SECRET_KEY");
  if (ts) return { kid: "ts", semilla: `facturaya-ts-key:${ts}` };
  throw new ErrorLlaveMaestra();
}

function obtenerCandidatosSemilla(env?: Record<string, unknown>, permitirSemillaPublica = false): string[] {
  const mk = textoEnv(env, "MASTER_KEY");
  const ts = textoEnv(env, "TURNSTILE_SECRET_KEY");
  return [
    ...new Set([
      ...(mk ? [`facturaya-master:${mk}`] : []),
      ...[...llavesHeredadasBd].map((k) => `facturaya-platform:${k}`),
      ...(ts ? [`facturaya-ts-key:${ts}`] : []),
      ...(permitirSemillaPublica ? [SEMILLA_PUBLICA_LEGADA] : []),
    ]),
  ];
}

async function derivarClaveAes(semilla: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(semilla));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function cifrarSecreto(textoPlano: string, env?: Record<string, unknown>): Promise<string> {
  const limpio = String(textoPlano ?? "").trim();
  if (!limpio) return "";
  if (limpio.startsWith(PREFIJO_CIFRADO_V2) || limpio.startsWith(PREFIJO_CIFRADO_V1)) return limpio;
  exigirLlaveMaestra(env);
  if (env?.DB && !llaveMaestraConfigurada(env)) await asegurarLlavePlataforma(env.DB as D1Database, env);
  const { kid, semilla } = obtenerSemillaActiva(env);
  const key = await derivarClaveAes(semilla);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(limpio));
  return `${PREFIJO_CIFRADO_V2}${kid}:${aB64(iv)}:${aB64(new Uint8Array(cipherBuf))}`;
}

export async function descifrarSecreto(valorGuardado: string | null | undefined, env?: Record<string, unknown>): Promise<string> {
  const val = String(valorGuardado ?? "").trim();
  if (!val) return "";
  if (!val.startsWith(PREFIJO_CIFRADO_V2) && !val.startsWith(PREFIJO_CIFRADO_V1)) return val;

  let ivB64 = "";
  let dataB64 = "";
  let leerConSemillaPublica = false; // solo lectura de lo que ya se guardó con la semilla pública (v1 y kid "def")
  if (val.startsWith(PREFIJO_CIFRADO_V2)) {
    const partes = val.slice(PREFIJO_CIFRADO_V2.length).split(":");
    if (partes.length !== 3) return "";
    leerConSemillaPublica = partes[0] === "def";
    ivB64 = partes[1];
    dataB64 = partes[2];
  } else {
    const partes = val.slice(PREFIJO_CIFRADO_V1.length).split(":");
    if (partes.length !== 2) return "";
    leerConSemillaPublica = true;
    ivB64 = partes[0];
    dataB64 = partes[1];
  }

  try {
    const iv = deB64(ivB64);
    const data = deB64(dataB64);
    for (const sem of obtenerCandidatosSemilla(env, leerConSemillaPublica)) {
      try {
        const key = await derivarClaveAes(sem);
        const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
        return dec.decode(plainBuf);
      } catch {
        // probar la siguiente llave (rotación)
      }
    }
    return "";
  } catch {
    return "";
  }
}

export function estaCifrado(valorGuardado: string | null | undefined): boolean {
  const s = String(valorGuardado ?? "");
  return s.startsWith(PREFIJO_CIFRADO_V2) || s.startsWith(PREFIJO_CIFRADO_V1);
}

// Firma criptográfica HMAC-SHA256 para respaldos JSON (detecta manipulación de sumas, conteos o modo_origen antes de restaurar)
async function hmacHex(semilla: string, mensaje: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`hmac-respaldo:${semilla}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(mensaje));
  return aHex(sig);
}

function mensajeCanonicRespaldo(modoOrigen: string, conteos: unknown, sumas: unknown, huella?: string): string {
  return JSON.stringify({
    modo_origen: modoOrigen === "REAL" ? "REAL" : "PRACTICA",
    conteos: conteos ?? {},
    sumas: sumas ?? {},
    ...(huella ? { huella } : {}),
  });
}

export async function firmarHmacRespaldo(
  modoOrigen: string,
  conteos: unknown,
  sumas: unknown,
  env?: Record<string, unknown>,
  huella?: string
): Promise<string> {
  // Sin MASTER_KEY el respaldo se entrega sin firma (la descarga nunca se bloquea); restaurar uno sin firma exige Súper Admin.
  if (!llaveMaestraConfigurada(env) && !permiteLlaveEnBd(env)) return "";
  if (env?.DB && !llaveMaestraConfigurada(env)) await asegurarLlavePlataforma(env.DB as D1Database, env);
  const { kid, semilla } = obtenerSemillaActiva(env);
  const msg = mensajeCanonicRespaldo(modoOrigen, conteos, sumas, huella);
  const hex = await hmacHex(semilla, msg);
  return `hmac:v1:${kid}:${hex}`;
}

export async function verificarHmacRespaldo(
  firma: string | null | undefined,
  modoOrigen: string,
  conteos: unknown,
  sumas: unknown,
  env?: Record<string, unknown>,
  huella?: string
): Promise<boolean> {
  const f = String(firma ?? "").trim();
  if (!f.startsWith("hmac:v1:")) return false;
  const partes = f.slice("hmac:v1:".length).split(":");
  if (partes.length !== 2) return false;
  const hexRecibido = partes[1];
  if (partes[0] === "def") return false; // firmas hechas con la semilla pública (v4.1) no se aceptan jamás
  // Nota: nunca se usa la semilla pública del repositorio para verificar firmas.
  for (const sem of obtenerCandidatosSemilla(env, false)) {
    const esperadoConHuella = huella ? await hmacHex(sem, mensajeCanonicRespaldo(modoOrigen, conteos, sumas, huella)) : "";
    const esperadoSinHuella = await hmacHex(sem, mensajeCanonicRespaldo(modoOrigen, conteos, sumas));
    if ((esperadoConHuella && esperadoConHuella === hexRecibido) || esperadoSinHuella === hexRecibido) {
      return true;
    }
  }
  return false;
}

// Firma HMAC v2 para respaldos generados en streaming (.json.gz):
// Usa un propósito HMAC separado ("hmac-respaldo-v2") para firmar el digest SHA-256 calculado en streaming junto a metadatos críticos.
async function hmacHexV2(semilla: string, mensaje: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`hmac-respaldo-v2:${semilla}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(mensaje));
  return aHex(sig);
}

function mensajeCanonicRespaldoV2(modoOrigen: string, sha256Datos: string, conteos: unknown, sumas: unknown): string {
  return JSON.stringify({
    v: 2,
    modo_origen: modoOrigen === "REAL" ? "REAL" : "PRACTICA",
    sha256_datos: String(sha256Datos ?? "").toLowerCase(),
    conteos: conteos ?? {},
    sumas: sumas ?? {},
  });
}

export async function firmarHmacDigestRespaldo(
  modoOrigen: string,
  sha256Datos: string,
  conteos: unknown,
  sumas: unknown,
  env?: Record<string, unknown>
): Promise<string> {
  if (!llaveMaestraConfigurada(env) && !permiteLlaveEnBd(env)) return "";
  if (env?.DB && !llaveMaestraConfigurada(env)) await asegurarLlavePlataforma(env.DB as D1Database, env);
  const { kid, semilla } = obtenerSemillaActiva(env);
  const msg = mensajeCanonicRespaldoV2(modoOrigen, sha256Datos, conteos, sumas);
  const hex = await hmacHexV2(semilla, msg);
  return `hmac:v2:${kid}:${hex}`;
}

export async function verificarHmacDigestRespaldo(
  firma: string | null | undefined,
  modoOrigen: string,
  sha256Datos: string,
  conteos: unknown,
  sumas: unknown,
  env?: Record<string, unknown>
): Promise<boolean> {
  const f = String(firma ?? "").trim();
  if (!f.startsWith("hmac:v2:")) return false;
  const partes = f.slice("hmac:v2:".length).split(":");
  if (partes.length !== 2) return false;
  const hexRecibido = partes[1];
  if (partes[0] === "def" || !sha256Datos) return false;
  const msg = mensajeCanonicRespaldoV2(modoOrigen, sha256Datos, conteos, sumas);
  for (const sem of obtenerCandidatosSemilla(env, false)) {
    const esperado = await hmacHexV2(sem, msg);
    if (comparacionConstante(esperado, hexRecibido)) return true;
  }
  return false;
}

// HMAC-SHA256 con propósito separado (ej. hash de correos bloqueados) usando MASTER_KEY (fail-closed en producción).
export async function hmacTextoPlataforma(
  proposito: string,
  textoPlano: string,
  env?: Record<string, unknown>,
  rawDb?: D1Database | null
): Promise<string> {
  const limpio = String(textoPlano ?? "").trim().toLowerCase();
  if (!limpio) return "";
  exigirLlaveMaestra(env);
  if (!llaveMaestraConfigurada(env) && (rawDb || env?.DB)) {
    await asegurarLlavePlataforma((rawDb || env?.DB) as D1Database, env);
  }
  const { semilla } = obtenerSemillaActiva(env);
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`hmac-${proposito}:${semilla}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(limpio));
  return aHex(sig);
}

// Comparación en tiempo constante para validar secretos y firmas de webhooks.
export function comparacionConstante(a: string, b: string): boolean {
  const ab = enc.encode(String(a ?? ""));
  const bb = enc.encode(String(b ?? ""));
  if (ab.length !== bb.length || ab.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

