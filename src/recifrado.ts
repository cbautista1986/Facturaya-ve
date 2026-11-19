// Recifrado de secretos heredados (v4.2.1): pasa a MASTER_KEY (kid "mk") todo secreto guardado con llaves anteriores
// (semilla pública v1 / kid "def" de la v4.1, llave de la base kid "pk" de la v4.2 o llave derivada de Turnstile kid "ts")
// y cifra los que estuvieran en claro. Es idempotente, no destructivo (UPDATE condicionado al valor leído) y no hace nada sin MASTER_KEY.
import { cargarLlavesLegadas, cifrarSecreto, descifrarSecreto, estaCifrado, llaveMaestraConfigurada } from "./cifrado";

export const CLAVES_SECRETAS = ["cf_api_token", "correo_clave", "imprenta_clave"] as const;
const PREFIJO_MK = "enc:v2:mk:";

// Una base queda en esta lista cuando ya no tiene pendientes (solo vive mientras viva el isolate; la consulta es de 3 filas).
const terminadas = new WeakSet<object>();

export type ResultadoRecifrado = { omitido?: "SIN_MASTER_KEY"; recifrados: number; cifrados_en_claro: number; ilegibles: string[] };

export async function recifrarSecretosHeredados(
  db: D1Database,
  env: Record<string, unknown>,
  rawDb?: D1Database | null
): Promise<ResultadoRecifrado> {
  const vacio: ResultadoRecifrado = { recifrados: 0, cifrados_en_claro: 0, ilegibles: [] };
  if (!llaveMaestraConfigurada(env)) return { ...vacio, omitido: "SIN_MASTER_KEY" };
  if (terminadas.has(db)) return vacio;
  await cargarLlavesLegadas(rawDb ?? db);

  const marcas = CLAVES_SECRETAS.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT clave, valor FROM integraciones WHERE clave IN (${marcas})`)
    .bind(...CLAVES_SECRETAS)
    .all<{ clave: string; valor: string | null }>();

  const resultado: ResultadoRecifrado = { recifrados: 0, cifrados_en_claro: 0, ilegibles: [] };
  const ahora = new Date().toISOString();
  for (const fila of results) {
    const valor = String(fila.valor ?? "").trim();
    if (!valor || valor.startsWith(PREFIJO_MK)) continue;
    const enClaro = !estaCifrado(valor);
    const plano = enClaro ? valor : await descifrarSecreto(valor, env);
    if (!plano) {
      resultado.ilegibles.push(fila.clave);
      continue;
    }
    const nuevo = await cifrarSecreto(plano, env);
    await db
      .prepare(`UPDATE integraciones SET valor = ?, actualizado_en = ? WHERE clave = ? AND valor = ?`)
      .bind(nuevo, ahora, fila.clave, fila.valor)
      .run();
    if (enClaro) resultado.cifrados_en_claro++;
    else resultado.recifrados++;
  }
  if (resultado.ilegibles.length) {
    // Solo se informan los nombres de los campos, jamás su contenido: hay que volver a escribirlos desde el panel.
    console.warn(`[recifrado] Secretos ilegibles que deben ingresarse de nuevo: ${resultado.ilegibles.join(", ")}`);
  } else {
    terminadas.add(db);
  }
  return resultado;
}
