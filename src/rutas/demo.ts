// Módulo DEMO (Exclusivo Súper Administrador): /api/demo
// Permite crear, inspeccionar, extender y cerrar/borrar al instante el Entorno Demo aislado en DB_DEMO.
import { Hono } from "hono";
import { auditar, falla, leerJson, requiereSesion, texto, type Env } from "../comun";
import { crearEntornoDemo, extenderDemo, limpiarBaseDemo, limpiarDemoExpiradaSiCorresponde, obtenerEstadoDemo } from "../demo";
import { esSuperAdmin } from "../permisos";

const demo = new Hono<Env>();
demo.use("*", requiereSesion);

demo.use("*", async (c, next) => {
  const yo = c.get("usuario");
  const envObj = c.env as unknown as Record<string, unknown>;
  if (!esSuperAdmin(yo.rol, yo.email, envObj)) {
    return falla(c, 403, "Solo el Súper Administrador puede administrar el Entorno Demo.");
  }
  await next();
});

demo.get("/", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  await limpiarDemoExpiradaSiCorresponde(rawDb, envObj).catch(() => {});
  const estado = await obtenerEstadoDemo(rawDb, envObj);
  return c.json({ ok: true, demo: estado });
});

demo.post("/crear", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c);
  try {
    const res = await crearEntornoDemo(rawDb, envObj, {
      regimen: texto(b.regimen, 20) || "ORDINARIO",
      duracion_min: Number(b.duracion_min ?? 120),
      nombre_negocio: texto(b.nombre_negocio, 120),
      email_prospecto: texto(b.email_prospecto, 120),
    });
    await auditar(
      c,
      c.get("usuario").id,
      "DEMO_CREAR",
      `${res.estado.regimen} · ${res.estado.duracion_min}m · ${res.estado.nombre_negocio}${res.estado.email_prospecto ? ` · mail=${res.estado.email_prospecto}` : ""}`
    );
    return c.json(res);
  } catch (e) {
    return falla(c, 400, (e as Error).message || "No se pudo crear el entorno demo.");
  }
});

demo.post("/extender", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c).catch(() => ({} as Record<string, unknown>));
  try {
    const estado = await extenderDemo(rawDb, envObj, Number(b.minutos ?? 60));
    await auditar(c, c.get("usuario").id, "DEMO_EXTENDER", `+${Number(b.minutos ?? 60)}m · vence=${estado.expira_hora_caracas}`);
    return c.json({ ok: true, demo: estado });
  } catch (e) {
    return falla(c, 400, (e as Error).message || "No se pudo extender el tiempo de la demo.");
  }
});

demo.post("/cerrar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  try {
    const res = await limpiarBaseDemo(rawDb, envObj);
    await auditar(c, c.get("usuario").id, "DEMO_CERRAR", res.limpiada_bd ? "DB_DEMO vaciada" : "Estado cerrado");
    const estado = await obtenerEstadoDemo(rawDb, envObj);
    return c.json({ ...res, demo: estado });
  } catch (e) {
    return falla(c, 400, (e as Error).message || "No se pudo cerrar el entorno demo.");
  }
});

export default demo;
