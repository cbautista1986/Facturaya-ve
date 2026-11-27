// Seguridad: contraseñas (PBKDF2), tokens de sesión y comparación segura.
// Cloudflare Workers permite como máximo 100.000 iteraciones de PBKDF2.
const ITERACIONES = 100_000;
const enc = new TextEncoder();

const aB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derivar(clave: string, sal: Uint8Array<ArrayBuffer>, iteraciones: number) {
  const base = await crypto.subtle.importKey("raw", enc.encode(clave), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteraciones }, base, 256);
  return new Uint8Array(bits);
}

async function aplicarPepper(clave: string, secreto: string): Promise<string> {
  const llave = await crypto.subtle.importKey(
    "raw",
    enc.encode(`facturaya:pw-pepper:v1:${secreto}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", llave, enc.encode(clave));
  return aB64(new Uint8Array(sig));
}

function leerPepperEnv(env?: Record<string, unknown>): { actual: string; anterior: string } {
  const actual = typeof env?.MASTER_KEY === "string" ? env.MASTER_KEY.trim() : "";
  const anterior = typeof env?.MASTER_KEY_ANTERIOR === "string" ? env.MASTER_KEY_ANTERIOR.trim() : "";
  return { actual, anterior };
}

function compararConstante(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a[i] ^ b[i];
  return dif === 0;
}

// Formato guardado:
// - Con MASTER_KEY: pbkdf2p$iteraciones$sal$hash (clave pre-mezclada con HMAC-SHA256 pepper derivado de MASTER_KEY)
// - Legado / sin MASTER_KEY: pbkdf2$iteraciones$sal$hash (retrocompatible para cuentas anteriores)
export async function hashClave(clave: string, env?: Record<string, unknown>) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const { actual } = leerPepperEnv(env);
  if (actual) {
    const pre = await aplicarPepper(clave, actual);
    return `pbkdf2p$${ITERACIONES}$${aB64(sal)}$${aB64(await derivar(pre, sal, ITERACIONES))}`;
  }
  return `pbkdf2$${ITERACIONES}$${aB64(sal)}$${aB64(await derivar(clave, sal, ITERACIONES))}`;
}

// Hash de relleno: el login tarda lo mismo aunque el correo no exista.
export const CLAVE_FALSA = `pbkdf2$${ITERACIONES}$${aB64(new Uint8Array(16))}$${aB64(new Uint8Array(32))}`;

export async function verificarClave(clave: string, guardado: string, env?: Record<string, unknown>) {
  const [alg, iter, sal, hash] = String(guardado || "").split("$");
  if (!iter || !sal || !hash) return false;
  const iterNum = Number(iter);
  if (!Number.isFinite(iterNum) || iterNum <= 0) return false;
  const salBytes = deB64(sal);
  const esperado = deB64(hash);

  if (alg === "pbkdf2") {
    const calculado = await derivar(clave, salBytes, iterNum);
    return compararConstante(calculado, esperado);
  }
  if (alg === "pbkdf2p") {
    const { actual, anterior } = leerPepperEnv(env);
    if (!actual && !anterior) return false;
    if (actual) {
      const pre = await aplicarPepper(clave, actual);
      const calculado = await derivar(pre, salBytes, iterNum);
      if (compararConstante(calculado, esperado)) return true;
    }
    if (anterior && anterior !== actual) {
      const preAnt = await aplicarPepper(clave, anterior);
      const calculadoAnt = await derivar(preAnt, salBytes, iterNum);
      if (compararConstante(calculadoAnt, esperado)) return true;
    }
    return false;
  }
  return false;
}

// Indica si una cuenta con hash legado (pbkdf2$) debe actualizarse transparentemente a pbkdf2p$ tras un login exitoso.
export function necesitaRehashClave(guardado: string, env?: Record<string, unknown>): boolean {
  const { actual } = leerPepperEnv(env);
  if (!actual) return false;
  return String(guardado || "").startsWith("pbkdf2$");
}

export async function sha256(texto: string) {
  return aB64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(texto))));
}

export function tokenAleatorio() {
  return aB64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Códigos que una persona copia o teclea (recuperación de clave, claves temporales): letras y números sin confusiones (sin 0/O, 1/I/L).
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 símbolos
function sorteo(largo: number) {
  let s = "";
  while (s.length < largo) for (const b of crypto.getRandomValues(new Uint8Array(32))) { if (b < 248 && s.length < largo) s += ALFABETO[b % 31]; } // 248 = 31 × 8: sin sesgo
  return s;
}
// Código de recuperación: 20 símbolos (≈ 99 bits), se muestra UNA sola vez, ejemplo: K7QM-2XTA-9RBD-HW4P-N6ZC
export const codigoRecuperacion = () => sorteo(20).match(/.{4}/g)!.join("-");
export const normalizarCodigo = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, "");
// Clave temporal para un usuario nuevo o restablecido: 12 símbolos, ejemplo: H7KQ-2MXA-9RBD (debe cambiarla al entrar)
export const claveTemporal = () => sorteo(12).match(/.{4}/g)!.join("-");
