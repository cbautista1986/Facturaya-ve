// Módulo RESTAURAR RESPALDO (Fase 7.2): /api/sistema/restaurar/*  (solo el administrador, ya lo exige permisos.ts).
//
// REGLAS (por qué es así):
//  1. Solo se restaura en un sistema RECIÉN INSTALADO Y VACÍO. Nunca se mezcla con datos existentes ni se sobrescribe nada.
//  2. Los candados contables (facturas, pagos, compras y movimientos reales no se editan ni se borran) NO se apagan jamás. Los datos se cargan
//     como «práctica» (donde los candados no aplican), se verifican por completo y SOLO AL FINAL, en una sola operación, se pasan a «real».
//     Si algo falla antes de ese paso se puede cancelar y todo se limpia (el sistema queda como estaba).
//  3. Mientras dura la restauración nadie más puede guardar nada (el control central devuelve 423).
//  4. Cada tabla nueva del sistema debe figurar en PLAN o en NO_RESTAURAR: si no, la restauración se niega (así nunca se pierden datos en silencio).
import { Hono } from "hono";
import { calcular } from "../../public/dinero.js";
import { auditar, falla, leerJson, modoActual, type Env } from "../comun";
import { claveTemporal, hashClave, verificarClave } from "../seguridad";

export const restaurar = new Hono<Env>();
type Fila = Record<string, any>;
type Plan = { tabla: string; tipo: "usuarios" | "singleton" | "ajustes" | "upsert" | "insertar" | "auditoria"; modo?: boolean; usuarios?: string[]; sumas?: string[] };
// El ORDEN importa (primero lo que otros necesitan: clientes antes que documentos, documentos antes que pagos...)
export const PLAN: Plan[] = [
  { tabla: "usuarios", tipo: "usuarios" },
  { tabla: "perfil_emisor", tipo: "singleton" },
  { tabla: "ajustes", tipo: "ajustes" },
  { tabla: "contadores", tipo: "upsert" },
  { tabla: "metodos_cobro", tipo: "upsert" },
  { tabla: "medio_historial", tipo: "insertar", usuarios: ["cambiado_por"] },
  { tabla: "clientes", tipo: "insertar" },
  { tabla: "proveedores", tipo: "insertar" },
  { tabla: "catalogo", tipo: "insertar" },
  { tabla: "documentos", tipo: "insertar", modo: true, usuarios: ["creado_por", "anulado_por"], sumas: ["total_usd", "total_bs"] },
  { tabla: "documento_renglones", tipo: "insertar", sumas: ["monto_usd", "monto_bs"] },
  { tabla: "documento_impuestos", tipo: "insertar", sumas: ["base_bs", "iva_bs"] },
  { tabla: "compras", tipo: "insertar", modo: true, usuarios: ["registrado_por", "anulado_por"], sumas: ["total_usd"] },
  { tabla: "compra_impuestos", tipo: "insertar" },
  { tabla: "movimientos_stock", tipo: "insertar", modo: true, usuarios: ["creado_por"], sumas: ["cantidad_milli", "valor_usd"] },
  { tabla: "pagos", tipo: "insertar", modo: true, usuarios: ["registrado_por", "anulado_por"], sumas: ["monto_usd"] },
  { tabla: "auditoria", tipo: "auditoria", usuarios: ["usuario_id"] },
];
// Tablas que se exportan pero NO se restauran porque las maneja el código (migraciones) o son temporales
export const NO_RESTAURAR = ["_migraciones", "sesiones", "intentos_login", "verificaciones", "parametros_fiscales", "integraciones"]; // integraciones = claves de la imprenta: no viajan en los respaldos
const VACIO_SI = ["clientes", "proveedores", "catalogo", "documentos", "pagos", "compras", "movimientos_stock"]; // sin una sola fila
const MAX_LOTE = 100;
const nombreValido = (t: string) => /^[a-z_]+$/.test(t);

// Sumas de control (las usa el respaldo al exportar y la verificación final)
export function calcularSumas(datos: Record<string, Fila[]>) {
  const s: Record<string, Record<string, number>> = {};
  for (const p of PLAN) if (p.sumas) { s[p.tabla] = {}; for (const col of p.sumas) s[p.tabla][col] = (datos[p.tabla] ?? []).reduce((a, f) => a + (Number(f[col]) || 0), 0); }
  return s;
}

const leerEstado = async (db: D1Database) => {
  const r = await db.prepare(`SELECT valor FROM ajustes WHERE clave = 'restauracion'`).first<{ valor: string }>();
  return r ? (JSON.parse(r.valor) as Fila) : null;
};
const guardarEstado = (db: D1Database, e: Fila) => db.prepare(`INSERT INTO ajustes (clave, valor) VALUES ('restauracion', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`).bind(JSON.stringify(e));
const n = async (db: D1Database, t: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? 0;

// ¿Puede restaurarse aquí? Devuelve las razones por las que NO.
async function razonesNo(db: D1Database): Promise<string[]> {
  const r: string[] = [];
  if (await leerEstado(db)) r.push("Ya hay una restauración en curso.");
  if ((await modoActual(db)) !== "PRACTICA") r.push("El sistema ya está en vivo: solo se restaura en un sistema recién instalado.");
  for (const t of VACIO_SI) { const c = await n(db, t); if (c > 0) r.push(`El sistema ya tiene datos (${t}: ${c}). Solo se restaura en un sistema vacío.`); }
  const cont = await db.prepare(`SELECT COALESCE(SUM(valor), 0) AS s FROM contadores`).first<{ s: number }>();
  if ((cont?.s ?? 0) > 0) r.push("El sistema ya numeró documentos.");
  // Si el sistema tiene una tabla que este restaurador no conoce, no se arriesga a perder datos en silencio
  const { results } = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ name: string }>();
  const conocidas = new Set([...PLAN.map((p) => p.tabla), ...NO_RESTAURAR]);
  const raras = results.map((x) => x.name).filter((t) => !conocidas.has(t));
  if (raras.length) r.push(`Este sistema tiene tablas que el restaurador no conoce (${raras.join(", ")}): hay que actualizarlo antes de restaurar.`);
  return r;
}

restaurar.get("/plan", (c) => c.json({ ok: true, orden: PLAN.map((p) => ({ tabla: p.tabla, tipo: p.tipo, sumas: p.sumas ?? [], modo: !!p.modo })), max_lote: MAX_LOTE }));

restaurar.get("/estado", async (c) => {
  const e = await leerEstado(c.env.DB), razones = e ? [] : await razonesNo(c.env.DB);
  return c.json({ ok: true, en_curso: !!e, progreso: e ? { desde: e.desde, cargadas: e.cargadas, conteos: e.conteos } : null, vacio: !e && razones.length === 0, razones });
});

// 1) Iniciar: comprueba que el sistema esté vacío, guarda cómo estaba y bloquea las escrituras de los demás
restaurar.post("/iniciar", async (c) => {
  const db = c.env.DB, yo = c.get("usuario"), b = await leerJson(c);
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.clave ?? ""), u.password_hash))) return falla(c, 400, "La contraseña no es correcta.");
  const razones = await razonesNo(db);
  if (razones.length) return falla(c, 409, razones[0]);
  const m = b.manifiesto as Fila | undefined;
  if (!m || typeof m !== "object" || ![1, 2].includes(Number(m.version)) || typeof m.conteos !== "object" || typeof m.sumas !== "object") return falla(c, 400, "El archivo no parece un respaldo de este sistema.");
  const modoOrigen = m.modo_origen === "REAL" ? "REAL" : "PRACTICA";
  // Se guarda cómo estaba lo pequeño que la restauración reemplaza, por si hay que cancelar
  const previo = { perfil: await db.prepare(`SELECT * FROM perfil_emisor WHERE id = 1`).first(), ajustes: (await db.prepare(`SELECT * FROM ajustes`).all()).results,
    contadores: (await db.prepare(`SELECT * FROM contadores`).all()).results, metodos: (await db.prepare(`SELECT * FROM metodos_cobro`).all()).results,
    auditoria_max: (await db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM auditoria`).first<{ m: number }>())?.m ?? 0,
    usuarios_max: (await db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM usuarios`).first<{ m: number }>())?.m ?? 0,
    auditoria_n: await n(db, "auditoria") };
  await db.batch([
    db.prepare(`INSERT INTO ajustes (clave, valor) VALUES ('restauracion_previo', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`).bind(JSON.stringify(previo)),
    db.prepare(`INSERT INTO ajustes (clave, valor) VALUES ('restauracion_usuarios', '{}') ON CONFLICT(clave) DO UPDATE SET valor = '{}'`),
    guardarEstado(db, { desde: new Date().toISOString(), por: yo.id, version: Number(m.version), modo_origen: modoOrigen, conteos: m.conteos, sumas: m.sumas, cargadas: {} }),
  ]);
  await auditar(c, yo.id, "RESTAURAR_INICIO", `${modoOrigen} v${m.version}`);
  // El registro de «inicio» es de esta restauración, no del respaldo: el punto de partida para contar y para cancelar se fija DESPUÉS de anotarlo (así queda constancia aunque se cancele)
  previo.auditoria_max = (await db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM auditoria`).first<{ m: number }>())?.m ?? 0;
  previo.auditoria_n = await n(db, "auditoria");
  await db.prepare(`UPDATE ajustes SET valor = ? WHERE clave = 'restauracion_previo'`).bind(JSON.stringify(previo)).run();
  return c.json({ ok: true });
});

const columnasDe = async (db: D1Database, t: string) => new Set(((await db.prepare(`PRAGMA table_info(${t})`).all()).results as Fila[]).map((x) => String(x.name)));
const mapaUsuarios = async (db: D1Database) => JSON.parse((await db.prepare(`SELECT valor FROM ajustes WHERE clave = 'restauracion_usuarios'`).first<{ valor: string }>())?.valor ?? "{}") as Record<string, number>;

// 2) Cargar un lote de filas de una tabla (hasta 100). Las filas no se creen: cada columna se comprueba contra la tabla real.
restaurar.post("/lote", async (c) => {
  const db = c.env.DB, yo = c.get("usuario"), b = await leerJson(c), e = await leerEstado(db);
  if (!e) return falla(c, 409, "No hay una restauración iniciada.");
  const plan = PLAN.find((p) => p.tabla === b.tabla);
  if (!plan || !nombreValido(plan.tabla)) return falla(c, 400, "Tabla desconocida.");
  const filas = b.filas;
  if (!Array.isArray(filas) || !filas.length || filas.length > MAX_LOTE) return falla(c, 400, `Cada lote lleva de 1 a ${MAX_LOTE} filas.`);
  const cols = await columnasDe(db, plan.tabla), mapa = await mapaUsuarios(db), t = plan.tabla;
  const remapUsuario = (v: unknown) => (v == null ? null : (mapa[String(v)] ?? yo.id));
  const sentencias: D1PreparedStatement[] = [];
  const nuevosUsuarios: number[] = [];
  for (const f of filas as Fila[]) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return falla(c, 400, "Una fila del respaldo no es válida.");
    const claves = Object.keys(f);
    const validas = claves.filter((k) => cols.has(k));
    for (const k of validas) { const v = f[k]; if (v !== null && !["string", "number"].includes(typeof v)) return falla(c, 400, `Valor no válido en ${t}.${k}.`); }
    const fila: Fila = {}; for (const k of validas) fila[k] = f[k];
    if (plan.tipo === "usuarios") {
      const email = String(f.email ?? "").trim().toLowerCase(), existente = await db.prepare(`SELECT id FROM usuarios WHERE email = ?`).bind(email).first<{ id: number }>();
      if (existente) { mapa[String(f.id)] = existente.id; continue; } // la misma persona (ej. el dueño que restaura)
      // Los usuarios del respaldo vuelven DESACTIVADOS y con clave inutilizable: el dueño los reactiva y les da clave nueva si quiere
      const r = await db.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES (?, ?, ?, ?, 0, 1) RETURNING id`)
        .bind(String(f.nombre ?? "Usuario").slice(0, 120), email, await hashClave(claveTemporal()), ["ADMIN", "SUPERVISOR", "CAJERO", "BODEGA"].includes(String(f.rol)) ? String(f.rol) : "CAJERO").first<{ id: number }>();
      mapa[String(f.id)] = r!.id; nuevosUsuarios.push(r!.id);
      continue;
    }
    if (plan.tipo === "singleton") { // perfil_emisor: una sola fila, se reemplaza su contenido (el id no se toca)
      const ks = validas.filter((k) => k !== "id"); if (!ks.length) continue;
      sentencias.push(db.prepare(`UPDATE perfil_emisor SET ${ks.map((k) => `${k} = ?`).join(", ")} WHERE id = 1`).bind(...ks.map((k) => fila[k]))); continue;
    }
    if (plan.tipo === "ajustes") { // el modo y los marcadores de la restauración los maneja este módulo, no el respaldo
      if (!f.clave || String(f.clave) === "modo" || String(f.clave).startsWith("restauracion")) continue;
      sentencias.push(db.prepare(`INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`).bind(String(f.clave), String(f.valor ?? ""))); continue;
    }
    if (plan.tipo === "upsert") {
      const pk = t === "contadores" ? "clave" : "metodo", ks = validas.filter((k) => k !== pk);
      sentencias.push(db.prepare(`INSERT INTO ${t} (${[pk, ...ks].join(", ")}) VALUES (${[pk, ...ks].map(() => "?").join(", ")}) ON CONFLICT(${pk}) DO UPDATE SET ${ks.map((k) => `${k} = excluded.${k}`).join(", ")}`).bind(fila[pk], ...ks.map((k) => fila[k]))); continue;
    }
    // insertar / auditoria
    for (const k of plan.usuarios ?? []) if (k in fila) fila[k] = remapUsuario(fila[k]);
    if (plan.modo) { // origen REAL: se carga como PRÁCTICA (sin candados) y se pasa a REAL al final, todo junto
      if (f.modo !== e.modo_origen) return falla(c, 400, `El respaldo mezcla datos reales y de práctica (${t}); no se puede restaurar.`);
      if (e.modo_origen === "REAL") fila.modo = "PRACTICA";
    }
    let ks = Object.keys(fila);
    if (plan.tipo === "auditoria") ks = ks.filter((k) => k !== "id"); // el número de auditoría lo asigna este sistema (ya tiene sus propios registros)
    sentencias.push(db.prepare(`INSERT OR IGNORE INTO ${t} (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`).bind(...ks.map((k) => fila[k])));
  }
  try {
    const res = sentencias.length ? await db.batch(sentencias) : [];
    const cuantas = plan.tipo === "usuarios" ? (filas as Fila[]).length : res.reduce((s, r) => s + (r.meta.changes ?? 0), 0);
    if (plan.tipo === "usuarios") await db.prepare(`UPDATE ajustes SET valor = ? WHERE clave = 'restauracion_usuarios'`).bind(JSON.stringify(mapa)).run();
    e.cargadas[t] = (e.cargadas[t] ?? 0) + cuantas;
    if (nuevosUsuarios.length) e.usuarios_creados = [...(e.usuarios_creados ?? []), ...nuevosUsuarios];
    await guardarEstado(db, e).run();
    return c.json({ ok: true, cargadas: e.cargadas[t] });
  } catch (err) {
    return falla(c, 400, `No se pudo cargar ${t}: ${String(err).replace(/^Error: D1_ERROR: /, "").slice(0, 160)}`);
  }
});

// Compras de antes de guardar los impuestos por alícuota: se reconstruyen con la misma cuenta que las registra (y se comprueba que cuadre)
async function reconstruirImpuestosCompras(db: D1Database): Promise<string | null> {
  const { results } = await db.prepare(`SELECT id, tasa_e8, total_bs, renglones_json FROM compras c WHERE tasa_e8 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM compra_impuestos i WHERE i.compra_id = c.id)`).all<Fila>();
  const pasos: D1PreparedStatement[] = [];
  for (const k of results) {
    const lineas = JSON.parse(k.renglones_json) as Fila[];
    const calc = calcular(lineas.map((l) => ({ cantidad_milli: l.cantidad_milli, precio_usd: l.costo_usd, alicuota_cent: l.alicuota_cent })), k.tasa_e8);
    if (calc.total_bs !== k.total_bs) return `La compra ${k.id} no cuadra al reconstruir sus impuestos.`;
    for (const i of calc.impuestos) pasos.push(db.prepare(`INSERT INTO compra_impuestos (compra_id, alicuota_cent, base_usd, iva_usd, base_bs, iva_bs) VALUES (?, ?, ?, ?, ?, ?)`).bind(k.id, i.alicuota_cent, i.base_usd, i.iva_usd, i.base_bs, i.iva_bs));
  }
  if (pasos.length) await db.batch(pasos);
  return null;
}

// 3) Terminar: verifica TODO (conteos, sumas, claves foráneas) y solo entonces pasa los datos a «real» en una sola operación
restaurar.post("/terminar", async (c) => {
  const db = c.env.DB, yo = c.get("usuario"), e = await leerEstado(db);
  if (!e) return falla(c, 409, "No hay una restauración iniciada.");
  const malo = await reconstruirImpuestosCompras(db);
  if (malo) return falla(c, 409, malo);
  const previo = JSON.parse((await db.prepare(`SELECT valor FROM ajustes WHERE clave = 'restauracion_previo'`).first<{ valor: string }>())!.valor);
  const problemas: string[] = [];
  for (const p of PLAN.filter((x) => x.tipo === "insertar")) {
    const esperado = Number(e.conteos[p.tabla] ?? 0), real = await n(db, p.tabla);
    if (p.tabla === "compra_impuestos") continue; // puede reconstruirse: se valida con las sumas de compras
    if (real !== esperado) problemas.push(`${p.tabla}: llegaron ${real} de ${esperado} filas`);
  }
  const audEsperada = Number(e.conteos.auditoria ?? 0), audReal = (await n(db, "auditoria")) - previo.auditoria_n;
  if (audReal !== audEsperada) problemas.push(`auditoria: llegaron ${audReal} de ${audEsperada} filas`);
  for (const p of PLAN) for (const col of p.sumas ?? []) {
    const r = await db.prepare(`SELECT COALESCE(SUM(${col}), 0) AS s FROM ${p.tabla}`).first<{ s: number }>();
    if ((r?.s ?? 0) !== Number(e.sumas?.[p.tabla]?.[col] ?? 0)) problemas.push(`${p.tabla}.${col}: la suma no coincide con el respaldo`);
  }
  const fk = (await db.prepare(`PRAGMA foreign_key_check`).all()).results;
  if (fk.length) problemas.push(`${fk.length} referencias rotas entre tablas`);
  if (problemas.length) return c.json({ ok: false, error: "La verificación no cuadra: " + problemas.slice(0, 5).join("; ") + ". No se activó nada; puedes reintentar el envío o cancelar.", problemas }, 409);
  const pasos = [db.prepare(`DELETE FROM ajustes WHERE clave IN ('restauracion', 'restauracion_previo', 'restauracion_usuarios')`)];
  if (e.modo_origen === "REAL") pasos.unshift(
    db.prepare(`UPDATE documentos SET modo = 'REAL' WHERE modo = 'PRACTICA'`), db.prepare(`UPDATE pagos SET modo = 'REAL' WHERE modo = 'PRACTICA'`),
    db.prepare(`UPDATE compras SET modo = 'REAL' WHERE modo = 'PRACTICA'`), db.prepare(`UPDATE movimientos_stock SET modo = 'REAL' WHERE modo = 'PRACTICA'`),
    db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`));
  await db.batch(pasos); // una sola operación: o pasa todo a real, o nada
  await auditar(c, yo.id, "RESTAURAR_FIN", `${e.modo_origen}: ${Object.entries(e.cargadas).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return c.json({ ok: true, modo: e.modo_origen, cargadas: e.cargadas });
});

// 4) Cancelar: borra lo cargado (todo está como «práctica», así que se puede) y deja el sistema como estaba
restaurar.post("/cancelar", async (c) => {
  const db = c.env.DB, yo = c.get("usuario"), e = await leerEstado(db);
  if (!e) return falla(c, 409, "No hay una restauración en curso.");
  const previo = JSON.parse((await db.prepare(`SELECT valor FROM ajustes WHERE clave = 'restauracion_previo'`).first<{ valor: string }>())!.valor) as Fila;
  const p = previo.perfil as Fila, cols = Object.keys(p).filter((k) => k !== "id");
  const pasos: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM pagos WHERE modo = 'PRACTICA'`), db.prepare(`DELETE FROM movimientos_stock WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM compra_impuestos`), db.prepare(`DELETE FROM compras WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM documento_impuestos`), db.prepare(`DELETE FROM documento_renglones`),
    db.prepare(`UPDATE documentos SET presupuesto_id = NULL, factura_afectada_id = NULL WHERE modo = 'PRACTICA'`), db.prepare(`DELETE FROM documentos WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM catalogo`), db.prepare(`DELETE FROM proveedores`), db.prepare(`DELETE FROM clientes`),
    db.prepare(`DELETE FROM auditoria WHERE id > ?`).bind(previo.auditoria_max),
    db.prepare(`UPDATE perfil_emisor SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = 1`).bind(...cols.map((k) => p[k])),
  ];
  for (const f of previo.contadores as Fila[]) pasos.push(db.prepare(`UPDATE contadores SET valor = ? WHERE clave = ?`).bind(f.valor, f.clave));
  for (const f of previo.metodos as Fila[]) pasos.push(db.prepare(`UPDATE metodos_cobro SET activo = ?, datos_json = ? WHERE metodo = ?`).bind(f.activo, f.datos_json, f.metodo));
  for (const id of (e.usuarios_creados ?? []) as number[]) pasos.push(db.prepare(`DELETE FROM usuarios WHERE id = ?`).bind(id));
  const clavesPrevias = (previo.ajustes as Fila[]).map((f) => f.clave);
  for (const f of previo.ajustes as Fila[]) pasos.push(db.prepare(`UPDATE ajustes SET valor = ? WHERE clave = ?`).bind(f.valor, f.clave));
  pasos.push(db.prepare(`DELETE FROM ajustes WHERE clave NOT IN (${clavesPrevias.map(() => "?").join(", ")})`).bind(...clavesPrevias)); // incluye los marcadores de la restauración
  await db.batch(pasos);
  await auditar(c, yo.id, "RESTAURAR_CANCELAR", "");
  return c.json({ ok: true });
});
