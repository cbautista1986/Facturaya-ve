// Núcleo de la RESTAURACIÓN DE RESPALDO (Fase 7.2), sin pantalla: lee y comprueba el archivo, arma el manifiesto y envía los datos por lotes.
// Lo usan la pantalla de Ajustes y las pruebas (así se prueba el mismo código que corre en el navegador).
// Qué tablas hay, en qué orden y qué sumas se comprueban lo dice el SERVIDOR (/api/sistema/restaurar/plan): hay una sola fuente de verdad.

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (texto) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)));

// Lee el texto del archivo: devuelve { ok, error } o { ok: true, version, datos, modo_origen, generado_en, huella_ok }
export async function leerRespaldo(texto) {
  let r;
  try { r = JSON.parse(texto); } catch { return { ok: false, error: "El archivo no es un respaldo: no se puede leer (¿está dañado o incompleto?)." }; }
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: "El archivo no parece un respaldo de este sistema." };
  let datos, huellaOk = null;
  if (r.formato === "respaldo-facturacion" && r.version === 2 && r.datos && typeof r.datos === "object") {
    datos = r.datos;
    huellaOk = typeof r.huella === "string" ? (await sha256Hex(JSON.stringify(datos))) === r.huella : null;
    if (huellaOk === false) return { ok: false, error: "El respaldo está dañado o fue modificado: su huella de verificación no coincide. No se restaurará." };
  } else if (r.version === 1 && Array.isArray(r.clientes) && Array.isArray(r.documentos)) { // formato anterior (Fases 3 a 7.1): sin huella ni impuestos de compras
    const { generado_en, version, ...resto } = r; datos = resto;
  } else return { ok: false, error: "El archivo no parece un respaldo de este sistema." };
  for (const [t, f] of Object.entries(datos)) if (!Array.isArray(f)) return { ok: false, error: `El respaldo está incompleto (${t}).` };
  const modoFila = (datos.ajustes ?? []).find((f) => f.clave === "modo");
  const perfil = (datos.perfil_emisor ?? [])[0] ?? {};
  return { ok: true, version: r.version, datos, huella_ok: huellaOk, modo_origen: modoFila?.valor === "REAL" ? "REAL" : "PRACTICA", generado_en: r.generado_en ?? null,
    negocio: perfil.nombre_razon_social ?? "", rif: perfil.rif ?? "" };
}

// Cuántas filas y qué sumas lleva cada tabla (el servidor las vuelve a calcular al terminar y deben coincidir)
export function armarManifiesto(resp, plan) {
  const conteos = {}, sumas = {};
  for (const p of plan.orden) {
    const filas = resp.datos[p.tabla] ?? [];
    conteos[p.tabla] = filas.length;
    if (p.sumas.length) sumas[p.tabla] = Object.fromEntries(p.sumas.map((c) => [c, filas.reduce((a, f) => a + (Number(f[c]) || 0), 0)]));
  }
  return { version: resp.version, modo_origen: resp.modo_origen, conteos, sumas };
}

// Los presupuestos (sin presupuesto_id) van antes que las facturas que salieron de ellos
const ordenar = (tabla, filas) => (tabla !== "documentos" ? filas : [...filas].sort((a, b) => (a.presupuesto_id == null ? 0 : 1) - (b.presupuesto_id == null ? 0 : 1) || a.id - b.id));

// llamar(ruta, cuerpo?, metodo?) -> JSON de la respuesta; lanza Error con el mensaje del servidor si falla
export async function restaurar(llamar, resp, clave, progreso = () => {}) {
  const plan = await llamar("sistema/restaurar/plan");
  await llamar("sistema/restaurar/iniciar", { clave, manifiesto: armarManifiesto(resp, plan) });
  let hechas = 0; const total = plan.orden.reduce((a, p) => a + (resp.datos[p.tabla]?.length ?? 0), 0);
  for (const p of plan.orden) {
    const filas = ordenar(p.tabla, resp.datos[p.tabla] ?? []);
    for (let i = 0; i < filas.length; i += plan.max_lote) {
      const lote = filas.slice(i, i + plan.max_lote);
      await llamar("sistema/restaurar/lote", { tabla: p.tabla, filas: lote });
      hechas += lote.length; progreso({ tabla: p.tabla, hechas, total });
    }
  }
  progreso({ tabla: "verificando", hechas, total });
  return llamar("sistema/restaurar/terminar", {});
}
