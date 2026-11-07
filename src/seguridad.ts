// Seguridad: contraseñas (PBKDF2), tokens de sesión y comparación segura.
// Cloudflare Workers permite como máximo 100.000 iteraciones de PBKDF2.
const ITERACIONES = 100_000;
const enc = new TextEncoder();

const aB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derivar(clave: string, sal: Uint8Array, iteraciones: number) {
  const base = await crypto.subtle.importKey("raw", enc.encode(clave), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteraciones }, base, 256);
  return new Uint8Array(bits);
}

// Formato guardado: pbkdf2$iteraciones$sal$hash (así se puede subir la dificultad sin romper cuentas viejas)
export async function hashClave(clave: string) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERACIONES}$${aB64(sal)}$${aB64(await derivar(clave, sal, ITERACIONES))}`;
}

// Hash de relleno: el login tarda lo mismo aunque el correo no exista.
export const CLAVE_FALSA = `pbkdf2$${ITERACIONES}$${aB64(new Uint8Array(16))}$${aB64(new Uint8Array(32))}`;

export async function verificarClave(clave: string, guardado: string) {
  const [alg, iter, sal, hash] = guardado.split("$");
  if (alg !== "pbkdf2") return false;
  const calculado = await derivar(clave, deB64(sal), Number(iter));
  const esperado = deB64(hash);
  if (calculado.length !== esperado.length) return false;
  let dif = 0;
  for (let i = 0; i < calculado.length; i++) dif |= calculado[i] ^ esperado[i];
  return dif === 0;
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
