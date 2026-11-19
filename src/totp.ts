// Autenticación en Dos Pasos (2FA TOTP · RFC 6238) con WebCrypto estándar (Cloudflare Workers + Node.js 20+).
// Cero dependencias externas, cero llamadas aleatorias en ámbito global (compatible con Worker startup validation).
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALFABETO_RESPALDO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 símbolos sin confusión (sin 0/O, 1/I/L)
const enc = new TextEncoder();

export function codificarBase32(bytes: Uint8Array): string {
  let bits = 0;
  let valor = 0;
  let salida = "";
  for (let i = 0; i < bytes.length; i++) {
    valor = (valor << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      salida += BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    salida += BASE32[(valor << (5 - bits)) & 31];
  }
  return salida;
}

export function decodificarBase32(texto: string): Uint8Array {
  const limpio = String(texto ?? "")
    .toUpperCase()
    .replace(/[\s=-]+/g, "");
  if (!limpio) return new Uint8Array(0);
  let bits = 0;
  let valor = 0;
  const salida: number[] = [];
  for (let i = 0; i < limpio.length; i++) {
    const idx = BASE32.indexOf(limpio[i]);
    if (idx === -1) throw new Error("Secreto Base32 inválido.");
    valor = (valor << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      salida.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(salida);
}

// Genera secreto aleatorio de 160 bits (20 bytes -> 32 caracteres Base32), estándar de Google Authenticator / Authy.
export function generarSecretoTotp(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return codificarBase32(bytes);
}

export function construirUriOtpauth(opts: { secreto: string; email: string; emisor?: string }): string {
  const emisor = opts.emisor || "FacturaYa Venezuela";
  const etiqueta = `${encodeURIComponent(emisor)}:${encodeURIComponent(opts.email.trim().toLowerCase())}`;
  const params = new URLSearchParams({
    secret: opts.secreto.replace(/[\s=-]+/g, "").toUpperCase(),
    issuer: emisor,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${etiqueta}?${params.toString()}`;
}

export async function generarHotp(secretoBytes: Uint8Array, contador: number, digitos = 6): Promise<string> {
  if (!secretoBytes.length) throw new Error("Secreto TOTP vacío.");
  const msg = new Uint8Array(8);
  let c = Math.floor(contador);
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const clave = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secretoBytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", clave, msg));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const mod = 10 ** digitos;
  return String(bin % mod).padStart(digitos, "0");
}

export async function generarCodigoTotp(
  secretoBase32: string,
  tiempoMs = Date.now(),
  periodoSeg = 30
): Promise<{ codigo: string; paso: number }> {
  const bytes = decodificarBase32(secretoBase32);
  const paso = Math.floor(tiempoMs / 1000 / periodoSeg);
  const codigo = await generarHotp(bytes, paso, 6);
  return { codigo, paso };
}

function compararConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

export async function verificarCodigoTotp(
  secretoBase32: string,
  codigoEntrada: string,
  opts?: { tiempoMs?: number; periodoSeg?: number; ventana?: number; ultimoPaso?: number }
): Promise<{ ok: boolean; paso?: number; repetido?: boolean }> {
  const limpio = String(codigoEntrada ?? "").replace(/[\s-]+/g, "");
  if (!/^\d{6}$/.test(limpio)) return { ok: false };
  let bytes: Uint8Array;
  try {
    bytes = decodificarBase32(secretoBase32);
  } catch {
    return { ok: false };
  }
  if (!bytes.length) return { ok: false };

  const tiempoMs = opts?.tiempoMs ?? Date.now();
  const periodoSeg = opts?.periodoSeg ?? 30;
  const ventana = Math.max(0, Math.min(2, opts?.ventana ?? 1));
  const ultimoPaso = Number(opts?.ultimoPaso ?? 0) || 0;
  const pasoBase = Math.floor(tiempoMs / 1000 / periodoSeg);

  for (let delta = -ventana; delta <= ventana; delta++) {
    const paso = pasoBase + delta;
    if (paso < 0) continue;
    const esperado = await generarHotp(bytes, paso, 6);
    if (compararConstante(limpio, esperado)) {
      if (ultimoPaso > 0 && paso <= ultimoPaso) {
        return { ok: false, repetido: true };
      }
      return { ok: true, paso };
    }
  }
  return { ok: false };
}

// Genera N códigos de respaldo de un solo uso (12 símbolos -> ~60 bits de entropía: XXXX-XXXX-XXXX)
export function generarCodigosRespaldo2fa(cantidad = 8): string[] {
  const lista: string[] = [];
  for (let i = 0; i < cantidad; i++) {
    let s = "";
    while (s.length < 12) {
      for (const b of crypto.getRandomValues(new Uint8Array(24))) {
        if (b < 248 && s.length < 12) s += ALFABETO_RESPALDO[b % 31];
      }
    }
    lista.push(`${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`);
  }
  return lista;
}

export function normalizarCodigoRespaldo2fa(codigo: string): string {
  return String(codigo ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function hashCodigoRespaldo2fa(codigo: string, email: string): Promise<string> {
  const norm = normalizarCodigoRespaldo2fa(codigo);
  const sal = `facturaya-2fa-backup-v1:${email.trim().toLowerCase()}`;
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(`${sal}:${norm}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verificarYConsumirCodigoRespaldo2fa(
  codigoEntrada: string,
  email: string,
  hashesGuardadosJson: string | null | undefined
): Promise<{ ok: boolean; restantesJson?: string; restantes?: number }> {
  const norm = normalizarCodigoRespaldo2fa(codigoEntrada);
  if (norm.length < 10 || !hashesGuardadosJson) return { ok: false };
  let hashes: string[] = [];
  try {
    const parsed = JSON.parse(hashesGuardadosJson);
    if (!Array.isArray(parsed)) return { ok: false };
    hashes = parsed.filter((x): x is string => typeof x === "string" && x.length === 64);
  } catch {
    return { ok: false };
  }
  if (!hashes.length) return { ok: false };
  const objetivo = await hashCodigoRespaldo2fa(norm, email);
  let indiceEncontrado = -1;
  for (let i = 0; i < hashes.length; i++) {
    if (compararConstante(objetivo, hashes[i])) {
      indiceEncontrado = i;
    }
  }
  if (indiceEncontrado === -1) return { ok: false };
  const restantes = hashes.filter((_, idx) => idx !== indiceEncontrado);
  return {
    ok: true,
    restantesJson: JSON.stringify(restantes),
    restantes: restantes.length,
  };
}
