// Centro de Control Cloudflare vía API REST oficial (https://api.cloudflare.com/client/v4).
// Permite al Súper Administrador ver el estado de sus bases de datos D1, cupo gratis (10 BD),
// crear bases de datos físicas reales (facturaya_db_N), consultarlas en caliente y borrarlas al dar de baja un cliente,
// TODO desde su propio panel web sin tener que entrar al dashboard de Cloudflare.
import { cifrarSecreto, descifrarSecreto } from "./cifrado";

export const NOMBRE_BD_PRINCIPAL = "facturacion_ve_db";
export const CUOTA_D1_GRATIS = 10;
export const CUOTA_D1_PRO_5USD = 50_000;

export function obtenerUuidBdPrincipal(env?: Record<string, unknown>): string {
  return String(env?.PRINCIPAL_D1_UUID ?? "").trim();
}

export type ConfigCloudflare = {
  account_id: string;
  worker_name: string;
  api_token: string;
  plan_d1: "GRATIS" | "PRO_5USD";
  configurado: boolean;
  token_final: string;
};

export type InfoBaseD1Remota = {
  uuid: string;
  name: string;
  created_at: string;
  file_size: number;
  num_tables: number;
  version: string;
  es_principal: boolean;
  asignada_a: string | null;
};

export async function leerConfigCloudflare(rawDb: D1Database, env?: Record<string, unknown>): Promise<ConfigCloudflare> {
  const { results } = await rawDb
    .prepare(`SELECT clave, valor FROM integraciones WHERE clave LIKE 'cf_%'`)
    .all<{ clave: string; valor: string }>()
    .catch(() => ({ results: [] as { clave: string; valor: string }[] }));
  const m = Object.fromEntries(results.map((r) => [r.clave.replace("cf_", ""), r.valor]));
  const envAcc = typeof env?.CF_ACCOUNT_ID === "string" ? env.CF_ACCOUNT_ID.trim() : "";
  const envTok = typeof env?.CF_API_TOKEN === "string" ? env.CF_API_TOKEN.trim() : "";
  const account_id = (m.account_id || envAcc || "").trim();
  const worker_name = (m.worker_name || "facturaya").trim() || "facturaya";
  const plan_d1 = m.plan_d1 === "PRO_5USD" ? "PRO_5USD" : "GRATIS";
  const api_token = (await descifrarSecreto(m.api_token, env)) || envTok || "";
  return {
    account_id,
    worker_name,
    api_token,
    plan_d1,
    configurado: Boolean(account_id && api_token),
    token_final: api_token ? api_token.slice(-4) : "",
  };
}

export async function guardarConfigCloudflare(
  rawDb: D1Database,
  env: Record<string, unknown> | undefined,
  datos: { account_id: string; api_token?: string; worker_name?: string; plan_d1?: "GRATIS" | "PRO_5USD" }
) {
  const ahora = new Date().toISOString();
  const pares: [string, string][] = [
    ["cf_account_id", datos.account_id.trim()],
    ["cf_worker_name", (datos.worker_name || "facturaya").trim() || "facturaya"],
  ];
  if (datos.plan_d1 === "PRO_5USD" || datos.plan_d1 === "GRATIS") {
    pares.push(["cf_plan_d1", datos.plan_d1]);
  }
  if (datos.api_token && datos.api_token.trim()) {
    pares.push(["cf_api_token", await cifrarSecreto(datos.api_token.trim(), env)]);
  }
  await rawDb.batch(
    pares.map(([k, v]) =>
      rawDb
        .prepare(
          `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?)
           ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
        )
        .bind(k, v, ahora)
    )
  );
}

// Si el usuario solo pega su API Token y no conoce su Account ID, lo descubrimos automáticamente con GET /accounts
export async function descubrirAccountIdCloudflare(
  apiToken: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; account_id: string; account_name: string } | { ok: false; error: string }> {
  try {
    const r = await fetchFn("https://api.cloudflare.com/client/v4/accounts?per_page=5", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiToken.trim()}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => null)) as {
      success?: boolean;
      result?: { id: string; name: string }[];
      errors?: { message?: string }[];
    } | null;
    if (!r.ok || !j?.success || !Array.isArray(j.result) || j.result.length === 0) {
      const msg = j?.errors?.[0]?.message || `HTTP ${r.status}`;
      return { ok: false, error: `No se pudo obtener el Account ID con ese token (${msg}).` };
    }
    return { ok: true, account_id: j.result[0].id, account_name: j.result[0].name || "" };
  } catch (e) {
    return { ok: false, error: `Error conectando con la API de Cloudflare: ${(e as Error).message}` };
  }
}

export async function consultarEstadoCloudflare(
  rawDb: D1Database,
  env: Record<string, unknown> | undefined,
  fetchFn: typeof fetch = fetch
) {
  const cfg = await leerConfigCloudflare(rawDb, env);
  const bindingsLocales: string[] = [];
  if (env) {
    for (let i = 1; i <= 20; i++) {
      const k = `DB_${i}`;
      if (env[k] && typeof (env[k] as D1Database).prepare === "function") bindingsLocales.push(k);
    }
  }

  // Mapa de bases asignadas a inquilinos en _mt_inquilinos
  const inqRows = (
    await rawDb
      .prepare(`SELECT codigo, nombre_negocio, rif, tipo_db, d1_uuid, d1_nombre FROM _mt_inquilinos`)
      .all<{ codigo: string; nombre_negocio: string; rif: string; tipo_db: string; d1_uuid?: string | null; d1_nombre?: string | null }>()
      .catch(() => ({ results: [] }))
  ).results;

  const porUuid = new Map<string, string>();
  const porNombre = new Map<string, string>();
  const uuidPrincipal = obtenerUuidBdPrincipal(env);
  for (const row of inqRows) {
    const etq = `${row.codigo} · ${row.nombre_negocio} (${row.rif})`;
    if (row.d1_uuid) porUuid.set(row.d1_uuid, etq);
    if (row.d1_nombre) porNombre.set(row.d1_nombre.toLowerCase(), etq);
    if (row.codigo === "principal") {
      if (uuidPrincipal) porUuid.set(uuidPrincipal, etq);
      porNombre.set(NOMBRE_BD_PRINCIPAL, etq);
    }
  }

  if (!cfg.configurado) {
    const esPro = cfg.plan_d1 === "PRO_5USD" || inqRows.length > CUOTA_D1_GRATIS;
    const lim = esPro ? CUOTA_D1_PRO_5USD : CUOTA_D1_GRATIS;
    const uLocal = Math.max(1, inqRows.length || 1 + bindingsLocales.length);
    return {
      ok: true,
      configurado: false,
      account_id: cfg.account_id,
      worker_name: cfg.worker_name,
      plan_d1: esPro ? ("PRO_5USD" as const) : ("GRATIS" as const),
      token_final: cfg.token_final,
      bindings_locales: bindingsLocales,
      cuota_d1: {
        usadas: uLocal,
        plan: esPro ? "PRO_5USD" : "GRATIS",
        limite_plan: lim,
        libres_plan: Math.max(0, lim - uLocal),
        limite_gratis: CUOTA_D1_GRATIS,
        libres_gratis: Math.max(0, CUOTA_D1_GRATIS - uLocal),
      },
      bases_d1: [] as InfoBaseD1Remota[],
      turnstile_widgets: [] as { sitekey: string; name: string; domains: string[]; mode: string }[],
      worker_bindings: [] as { name: string; type: string }[],
      aviso_api: "Conecta tu API Token de Cloudflare para ver, crear y borrar bases D1 reales directamente desde aquí.",
    };
  }

  const headers = {
    Authorization: `Bearer ${cfg.api_token}`,
    "Content-Type": "application/json",
  };

  // 1) Consultar todas las bases D1 en la cuenta de Cloudflare (soporta paginación para planes de 50.000 D1)
  let basesD1: InfoBaseD1Remota[] = [];
  let errorD1 = "";
  try {
    let pagina = 1;
    const rawBases: Record<string, unknown>[] = [];
    while (pagina <= 10) {
      const rD1 = await fetchFn(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id)}/d1/database?per_page=100&page=${pagina}`,
        { method: "GET", headers, signal: AbortSignal.timeout(10_000) }
      );
      const jD1 = (await rD1.json().catch(() => null)) as {
        success?: boolean;
        result?: Record<string, unknown>[];
        errors?: { message?: string }[];
      } | null;
      if (!rD1.ok || !jD1?.success || !Array.isArray(jD1.result)) {
        if (pagina === 1) errorD1 = jD1?.errors?.[0]?.message || `Cloudflare D1 API respondió HTTP ${rD1.status}`;
        break;
      }
      rawBases.push(...jD1.result);
      if (jD1.result.length < 100) break;
      pagina++;
    }
    if (!errorD1) {
      basesD1 = rawBases.map((b) => {
        const uuid = String(b.uuid ?? "");
        const name = String(b.name ?? "");
        const esPrincipal = (Boolean(uuidPrincipal) && uuid === uuidPrincipal) || name.toLowerCase() === NOMBRE_BD_PRINCIPAL;
        const asignada =
          porUuid.get(uuid) ||
          porNombre.get(name.toLowerCase()) ||
          (esPrincipal ? "principal · Negocio Principal" : null);
        return {
          uuid,
          name,
          created_at: String(b.created_at ?? ""),
          file_size: Number(b.file_size ?? 0),
          num_tables: Number(b.num_tables ?? 0),
          version: String(b.version ?? "production"),
          es_principal: esPrincipal,
          asignada_a: asignada,
        };
      });
    }
  } catch (e) {
    errorD1 = `No se pudo consultar D1 en Cloudflare: ${(e as Error).message}`;
  }

  // 2) Consultar widgets de Turnstile (opcional si el token incluye permiso de lectura de Turnstile)
  let turnstileWidgets: { sitekey: string; name: string; domains: string[]; mode: string }[] = [];
  try {
    const rTs = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id)}/challenges/widgets`,
      { method: "GET", headers, signal: AbortSignal.timeout(8_000) }
    );
    const jTs = (await rTs.json().catch(() => null)) as {
      success?: boolean;
      result?: Record<string, unknown>[];
    } | null;
    if (rTs.ok && jTs?.success && Array.isArray(jTs.result)) {
      turnstileWidgets = jTs.result.map((w) => ({
        sitekey: String(w.sitekey ?? ""),
        name: String(w.name ?? ""),
        domains: Array.isArray(w.domains) ? w.domains.map(String) : [],
        mode: String(w.mode ?? ""),
      }));
    }
  } catch {
    // Opcional
  }

  // 3) Consultar configuración de bindings del Worker (opcional si el token incluye Workers Scripts Read)
  let workerBindings: { name: string; type: string }[] = [];
  try {
    const rWk = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id)}/workers/scripts/${encodeURIComponent(cfg.worker_name)}/settings`,
      { method: "GET", headers, signal: AbortSignal.timeout(8_000) }
    );
    const jWk = (await rWk.json().catch(() => null)) as {
      success?: boolean;
      result?: { bindings?: { name?: string; type?: string }[] };
    } | null;
    if (rWk.ok && jWk?.success && Array.isArray(jWk.result?.bindings)) {
      workerBindings = jWk.result!.bindings!.map((b) => ({
        name: String(b.name ?? ""),
        type: String(b.type ?? ""),
      }));
    }
  } catch {
    // Opcional
  }

  const usadas = basesD1.length || 1;
  // Si Cloudflare reporta más de 10 bases D1 o si se activó el plan de $5/mes, el límite pasa automáticamente a 50.000 D1
  const esPlanPro = cfg.plan_d1 === "PRO_5USD" || usadas > CUOTA_D1_GRATIS || inqRows.length > CUOTA_D1_GRATIS;
  const limitePlan = esPlanPro ? CUOTA_D1_PRO_5USD : CUOTA_D1_GRATIS;
  return {
    ok: !errorD1,
    configurado: true,
    error_api: errorD1 || undefined,
    account_id: cfg.account_id,
    worker_name: cfg.worker_name,
    plan_d1: esPlanPro ? ("PRO_5USD" as const) : ("GRATIS" as const),
    token_final: cfg.token_final,
    bindings_locales: bindingsLocales,
    cuota_d1: {
      usadas,
      plan: esPlanPro ? "PRO_5USD" : "GRATIS",
      limite_plan: limitePlan,
      libres_plan: Math.max(0, limitePlan - usadas),
      limite_gratis: CUOTA_D1_GRATIS,
      libres_gratis: Math.max(0, CUOTA_D1_GRATIS - usadas),
    },
    bases_d1: basesD1,
    turnstile_widgets: turnstileWidgets,
    worker_bindings: workerBindings,
  };
}

// Crea (o reutiliza si ya existe con ese nombre) una base de datos D1 física real en Cloudflare
export async function crearBaseD1EnCloudflare(
  rawDb: D1Database,
  env: Record<string, unknown> | undefined,
  nombreBd: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; uuid: string; name: string; ya_existia: boolean } | { ok: false; error: string }> {
  const cfg = await leerConfigCloudflare(rawDb, env);
  if (!cfg.configurado) {
    return { ok: false, error: "Configura primero tu API Token de Cloudflare en el Centro de Control Cloudflare." };
  }
  const nombreLimpio = nombreBd
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 60);
  if (nombreLimpio.length < 3) {
    return { ok: false, error: "Nombre de base de datos D1 no válido." };
  }

  const headers = {
    Authorization: `Bearer ${cfg.api_token}`,
    "Content-Type": "application/json",
  };

  try {
    // Verificar primero si ya existe una base con ese mismo nombre para reutilizarla
    const rList = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id)}/d1/database?name=${encodeURIComponent(nombreLimpio)}`,
      { method: "GET", headers, signal: AbortSignal.timeout(10_000) }
    );
    const jList = (await rList.json().catch(() => null)) as {
      success?: boolean;
      result?: { uuid?: string; name?: string }[];
    } | null;
    const existente = jList?.result?.find((d) => String(d.name ?? "").toLowerCase() === nombreLimpio);
    if (existente?.uuid) {
      return { ok: true, uuid: String(existente.uuid), name: String(existente.name || nombreLimpio), ya_existia: true };
    }

    const rCreate = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id)}/d1/database`,
      {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ name: nombreLimpio }),
      }
    );
    const jCreate = (await rCreate.json().catch(() => null)) as {
      success?: boolean;
      result?: { uuid?: string; name?: string };
      errors?: { message?: string }[];
    } | null;
    if (!rCreate.ok || !jCreate?.success || !jCreate.result?.uuid) {
      const msg = jCreate?.errors?.[0]?.message || `HTTP ${rCreate.status}`;
      return { ok: false, error: `Cloudflare no pudo crear la base D1 «${nombreLimpio}»: ${msg}` };
    }
    return {
      ok: true,
      uuid: String(jCreate.result.uuid),
      name: String(jCreate.result.name || nombreLimpio),
      ya_existia: false,
    };
  } catch (e) {
    return { ok: false, error: `Error al crear base D1 en Cloudflare: ${(e as Error).message}` };
  }
}

// Elimina una base D1 física en Cloudflare (protegiendo siempre la base principal facturacion_ve_db)
export async function eliminarBaseD1EnCloudflare(
  rawDb: D1Database,
  env: Record<string, unknown> | undefined,
  uuidBd: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true } | { ok: false; error: string }> {
  const uuid = String(uuidBd ?? "").trim();
  if (!uuid) return { ok: false, error: "Falta el UUID de la base de datos D1." };
  const uuidPrincipalEnv = obtenerUuidBdPrincipal(env);
  const filaPrincipal = await rawDb
    .prepare(`SELECT d1_uuid FROM _mt_inquilinos WHERE codigo = 'principal'`)
    .first<{ d1_uuid?: string | null }>()
    .catch(() => null);
  if ((uuidPrincipalEnv && uuid === uuidPrincipalEnv) || (filaPrincipal?.d1_uuid && uuid === filaPrincipal.d1_uuid)) {
    return { ok: false, error: "Protección crítica: la base de datos principal (facturacion_ve_db) jamás puede ser eliminada." };
  }
  const cfg = await leerConfigCloudflare(rawDb, env);
  if (!cfg.configurado) {
    return { ok: false, error: "Configura primero tu API Token de Cloudflare." };
  }
  try {
    const r = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id)}/d1/database/${encodeURIComponent(uuid)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${cfg.api_token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    const j = (await r.json().catch(() => null)) as {
      success?: boolean;
      errors?: { message?: string }[];
    } | null;
    if (!r.ok || !j?.success) {
      const msg = j?.errors?.[0]?.message || `HTTP ${r.status}`;
      return { ok: false, error: `Cloudflare rechazó eliminar la base D1: ${msg}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Error eliminando base D1 en Cloudflare: ${(e as Error).message}` };
  }
}

// Adaptador D1Database completo sobre la API HTTP de Cloudflare D1 (/d1/database/{uuid}/query).
// Permite operar sobre cualquier base D1 física recién creada desde la web sin necesitar reiniciar el Worker ni editar wrangler.toml.
type ResultadoD1Http<T = Record<string, unknown>> = {
  results: T[];
  success: boolean;
  meta: { changes: number; last_row_id: number; [k: string]: unknown };
};

type StmtInterno = {
  __sql: string;
  __params: unknown[];
  bind: (...values: unknown[]) => D1PreparedStatement;
  first: <T = Record<string, unknown>>(colName?: string) => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<ResultadoD1Http<T>>;
  run: <T = Record<string, unknown>>() => Promise<ResultadoD1Http<T>>;
  raw: <T = unknown[]>() => Promise<T[]>;
};

export function crearDbCloudflareHttp(
  accountId: string,
  apiToken: string,
  databaseUuid: string,
  fetchFn: typeof fetch = fetch
): D1Database {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseUuid)}/query`;

  async function ejecutarUno<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<ResultadoD1Http<T>> {
    const r = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ sql, params }),
    });
    const j = (await r.json().catch(() => null)) as {
      success?: boolean;
      result?: { results?: T[]; success?: boolean; meta?: Record<string, unknown> }[];
      errors?: { message?: string }[];
    } | null;
    if (!r.ok || !j?.success || !Array.isArray(j.result) || !j.result[0]) {
      const msg = j?.errors?.[0]?.message || `Error HTTP ${r.status} en D1 API`;
      throw new Error(msg);
    }
    const item = j.result[0];
    return {
      results: (item.results ?? []) as T[],
      success: item.success ?? true,
      meta: (item.meta ?? { changes: 0, duration: 0, last_row_id: 0 }) as ResultadoD1Http<T>["meta"],
    };
  }

  function crearStmt(sql: string, params: unknown[] = []): StmtInterno {
    return {
      __sql: sql,
      __params: params,
      bind(...values: unknown[]) {
        return crearStmt(sql, values) as unknown as D1PreparedStatement;
      },
      async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        const res = await ejecutarUno<Record<string, unknown>>(sql, params);
        const row = res.results?.[0];
        if (!row) return null;
        if (colName !== undefined) return (row[colName] as T) ?? null;
        return row as unknown as T;
      },
      async all<T = Record<string, unknown>>(): Promise<ResultadoD1Http<T>> {
        return ejecutarUno<T>(sql, params);
      },
      async run<T = Record<string, unknown>>(): Promise<ResultadoD1Http<T>> {
        return ejecutarUno<T>(sql, params);
      },
      async raw<T = unknown[]>(): Promise<T[]> {
        const res = await ejecutarUno<Record<string, unknown>>(sql, params);
        return (res.results ?? []).map((r: Record<string, unknown>) => Object.values(r) as unknown as T);
      },
    };
  }

  return {
    prepare(query: string) {
      return crearStmt(query) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<ResultadoD1Http<T>[]> {
      if (!statements.length) return [];
      const batchPayload = statements.map((s) => {
        const st = s as unknown as StmtInterno;
        return { sql: st.__sql, params: st.__params ?? [] };
      });
      const r = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({ batch: batchPayload }),
      });
      const j = (await r.json().catch(() => null)) as {
        success?: boolean;
        result?: { results?: T[]; success?: boolean; meta?: Record<string, unknown> }[];
        errors?: { message?: string }[];
      } | null;
      if (!r.ok || !j?.success || !Array.isArray(j.result)) {
        const msg = j?.errors?.[0]?.message || `Error HTTP ${r.status} en D1 API (batch)`;
        throw new Error(msg);
      }
      return j.result.map((item) => ({
        results: (item.results ?? []) as T[],
        success: item.success ?? true,
        meta: (item.meta ?? { changes: 0, duration: 0, last_row_id: 0 }) as ResultadoD1Http<T>["meta"],
      }));
    },
    async exec(query: string): Promise<{ count: number; duration: number }> {
      await ejecutarUno(query, []);
      return { count: 1, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
  } as unknown as D1Database;
}

// ============================================================================
// Control de Compilaciones (Workers Builds), Logs y Rollback en Cloudflare
// ============================================================================

export type InfoBuildCloudflare = {
  build_uuid: string;
  trigger_uuid: string;
  status: string;
  build_outcome: string;
  branch: string;
  commit_hash: string;
  commit_message: string;
  author: string;
  created_on: string;
  running_on: string;
  stopped_on: string;
  duracion_seg: number | null;
};

export type InfoDeploymentCloudflare = {
  id: string;
  created_on: string;
  source: string;
  author_email: string;
  mensaje: string;
  version_id: string;
  porcentaje: number;
  activa: boolean;
};

// Función pura: traduce logs técnicos de Cloudflare Builds a un diagnóstico claro en español.
export function diagnosticarErrorBuild(textoLog: string): { codigo: string; resumen: string; sugerencia: string } | null {
  const raw = String(textoLog || "");
  if (!raw.trim()) return null;
  if (/lockfile had changes|lockfile is frozen/i.test(raw)) {
    return {
      codigo: "LOCKFILE_DESFASADO",
      resumen: "bun.lock no coincide con package.json en tu repositorio de GitHub.",
      sugerencia: "Elimina bun.lock en GitHub (o regenera bun.lock) y vuelve a subir para que Cloudflare instale las dependencias actuales.",
    };
  }
  if (/Missing script:\s*["']?build["']?/i.test(raw)) {
    return {
      codigo: "FALTA_SCRIPT_BUILD",
      resumen: "package.json no tiene el script \"build\" que Cloudflare intentó ejecutar.",
      sugerencia: "Agrega \"build\": \"tsc --noEmit\" dentro de \"scripts\" en package.json o deja vacío el comando Build en Cloudflare.",
    };
  }
  if (/error TS\d+:/i.test(raw)) {
    const m = raw.match(/([^\s]+\.ts\(\d+,\d+\):\s*error TS\d+:[^\n]+)/i);
    return {
      codigo: "ERROR_TYPESCRIPT",
      resumen: m ? m[1] : "Error de tipos TypeScript durante la compilación.",
      sugerencia: "Si menciona src/d1.ts, exclúyelo en tsconfig.json (\"exclude\": [\"src/d1.ts\"]) o bórralo del repo de producción.",
    };
  }
  if (/Authentication error|Invalid.*token|HTTP 40[13]/i.test(raw)) {
    return {
      codigo: "PERMISO_TOKEN",
      resumen: "Permiso insuficiente o token inválido en Cloudflare.",
      sugerencia: "Verifica que tu Token de Usuario incluya Workers Builds Configuration: Edit y Workers Scripts: Edit.",
    };
  }
  if (/ERROR|✘ \[ERROR\]|Failed to publish|Build failed|exited with code [1-9]/i.test(raw)) {
    const lineas = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const hit = [...lineas].reverse().find((l) => /error|failed|fatal|cannot|missing/i.test(l)) || lineas[lineas.length - 1] || "";
    return {
      codigo: "FALLO_COMPILACION",
      resumen: hit.slice(0, 220),
      sugerencia: "Revisa la línea marcada arriba en el log, corrige el archivo indicado en GitHub o usa Rollback si necesitas volver a la versión anterior.",
    };
  }
  if (/non-production|preview.*disabled|invalid branch|workers_dev/i.test(raw)) {
    return {
      codigo: "RAMA_NO_PRODUCCION",
      resumen: "Cloudflare intentó compilar una rama secundaria (no-producción) con workers_dev desactivado o nombre con acentos.",
      sugerencia: "En Cloudflare → Settings → Build → Branch control desactiva «Builds for non-production branches» y usa solo ramas sin tildes o Git Tags para respaldos.",
    };
  }
  return null;
}

const UUID_OR_TAG = /^[a-f0-9-]{8,64}$/i;

export async function consultarDesplieguesYBuilds(
  rawDb: D1Database,
  env: Record<string, unknown> | undefined,
  fetchFn: typeof fetch = fetch
) {
  const cfg = await leerConfigCloudflare(rawDb, env);
  if (!cfg.configurado) {
    return {
      ok: true,
      configurado: false,
      worker_name: cfg.worker_name,
      account_id: cfg.account_id,
      estado_general: "SIN_CONECTAR" as const,
      aviso_api: "Conecta tu API Token de Usuario en Centro de Control Cloudflare para ver compilaciones, logs y Rollback.",
      deployments: [] as InfoDeploymentCloudflare[],
      builds: [] as InfoBuildCloudflare[],
      triggers: [] as { trigger_uuid: string; trigger_name: string; branch: string; build_command: string; deploy_command: string }[],
      script_tag: "",
    };
  }

  const headers = {
    Authorization: `Bearer ${cfg.api_token}`,
    "Content-Type": "application/json",
  };
  const baseAcc = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id)}`;

  let scriptTag = "";
  let errorPermisos = "";
  const warnings: string[] = [];

  // 1) Obtener script_tag inmutable del Worker + lista de despliegues (Deployments)
  const [rScripts, rDeps] = await Promise.all([
    fetchFn(`${baseAcc}/workers/scripts`, { method: "GET", headers, signal: AbortSignal.timeout(10_000) }).catch(() => null),
    fetchFn(`${baseAcc}/workers/scripts/${encodeURIComponent(cfg.worker_name)}/deployments`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null),
  ]);

  if (rScripts && rScripts.ok) {
    const jSc = (await rScripts.json().catch(() => null)) as {
      success?: boolean;
      result?: { id?: string; tag?: string; script_tag?: string }[];
    } | null;
    const encontrado = (jSc?.result || []).find(
      (s) => String(s.id ?? "").toLowerCase() === cfg.worker_name.toLowerCase()
    );
    if (encontrado) scriptTag = String(encontrado.tag || encontrado.script_tag || "");
  } else if (rScripts && (rScripts.status === 401 || rScripts.status === 403)) {
    errorPermisos = `Tu API Token no tiene permiso de lectura en Workers Scripts (HTTP ${rScripts.status}).`;
  }

  let deployments: InfoDeploymentCloudflare[] = [];
  if (rDeps) {
    const jDep = (await rDeps.json().catch(() => null)) as {
      success?: boolean;
      result?: { deployments?: Record<string, unknown>[] } | Record<string, unknown>[];
      errors?: { message?: string }[];
    } | null;
    if (rDeps.ok && jDep?.success) {
      const lista = Array.isArray(jDep.result)
        ? jDep.result
        : Array.isArray(jDep.result?.deployments)
          ? jDep.result!.deployments!
          : [];
      deployments = lista.slice(0, 12).map((d, idx) => {
        const versions = Array.isArray(d.versions) ? (d.versions as { version_id?: string; percentage?: number }[]) : [];
        const principal = versions.reduce(
          (best, cur) => ((Number(cur.percentage ?? 0) > Number(best.percentage ?? -1) ? cur : best)),
          versions[0] || {}
        );
        const ann = (d.annotations && typeof d.annotations === "object" ? d.annotations : {}) as Record<string, unknown>;
        return {
          id: String(d.id ?? ""),
          created_on: String(d.created_on ?? ""),
          source: String(d.source ?? ""),
          author_email: String(d.author_email ?? ""),
          mensaje: String(ann["workers/message"] ?? ann["rollback_comment"] ?? ""),
          version_id: String(principal?.version_id ?? ""),
          porcentaje: Number(principal?.percentage ?? (idx === 0 ? 100 : 0)),
          activa: idx === 0 && Number(principal?.percentage ?? 100) > 0,
        };
      });
    } else if (rDeps.status === 401 || rDeps.status === 403) {
      warnings.push(`Sin acceso a Deployments (HTTP ${rDeps.status}: activa Workers Scripts Edit/Read).`);
    } else if (jDep?.errors?.[0]?.message) {
      warnings.push(jDep.errors[0].message);
    }
  }

  // 2) Consultar Builds y Triggers (requiere script_tag y Token de Usuario con Workers Builds Configuration)
  let builds: InfoBuildCloudflare[] = [];
  let triggers: { trigger_uuid: string; trigger_name: string; branch: string; build_command: string; deploy_command: string }[] = [];

  if (scriptTag) {
    const [rBuilds, rTrig] = await Promise.all([
      fetchFn(`${baseAcc}/builds/workers/${encodeURIComponent(scriptTag)}/builds?per_page=15`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null),
      fetchFn(`${baseAcc}/builds/workers/${encodeURIComponent(scriptTag)}/triggers`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null),
    ]);

    if (rBuilds) {
      const jB = (await rBuilds.json().catch(() => null)) as {
        success?: boolean;
        result?: Record<string, unknown>[] | { builds?: Record<string, unknown>[] };
        errors?: { message?: string }[];
      } | null;
      if (rBuilds.ok && jB?.success) {
        const arr = Array.isArray(jB.result) ? jB.result : Array.isArray(jB.result?.builds) ? jB.result!.builds! : [];
        builds = arr.slice(0, 15).map((b) => {
          const meta = (b.build_trigger_metadata && typeof b.build_trigger_metadata === "object"
            ? b.build_trigger_metadata
            : {}) as Record<string, unknown>;
          const ini = Date.parse(String(b.running_on || b.created_on || ""));
          const fin = Date.parse(String(b.stopped_on || ""));
          const dur = Number.isFinite(ini) && Number.isFinite(fin) && fin >= ini ? Math.round((fin - ini) / 1000) : null;
          return {
            build_uuid: String(b.build_uuid ?? b.uuid ?? ""),
            trigger_uuid: String(b.trigger_uuid ?? ""),
            status: String(b.status ?? ""),
            build_outcome: String(b.build_outcome ?? b.outcome ?? ""),
            branch: String(b.branch ?? meta.branch ?? "main"),
            commit_hash: String(b.commit_hash ?? meta.commit_hash ?? "").slice(0, 8),
            commit_message: String(b.commit_message ?? meta.commit_message ?? "").split("\n")[0].slice(0, 140),
            author: String(b.author ?? meta.author ?? ""),
            created_on: String(b.created_on ?? ""),
            running_on: String(b.running_on ?? ""),
            stopped_on: String(b.stopped_on ?? ""),
            duracion_seg: dur,
          };
        });
      } else if (rBuilds.status === 401 || rBuilds.status === 403) {
        errorPermisos =
          errorPermisos ||
          `Cloudflare rechazó leer Workers Builds (HTTP ${rBuilds.status}). Verifica que sea Token de Usuario con permiso «Workers Builds Configuration: Edit».`;
      } else if (jB?.errors?.[0]?.message) {
        warnings.push(jB.errors[0].message);
      }
    }

    if (rTrig && rTrig.ok) {
      const jT = (await rTrig.json().catch(() => null)) as {
        success?: boolean;
        result?: Record<string, unknown>[];
      } | null;
      if (jT?.success && Array.isArray(jT.result)) {
        triggers = jT.result.map((t) => ({
          trigger_uuid: String(t.trigger_uuid ?? t.uuid ?? ""),
          trigger_name: String(t.trigger_name ?? t.name ?? "Producción"),
          branch: String(Array.isArray(t.branch_includes) ? t.branch_includes[0] : (t.branch ?? "main")),
          build_command: String(t.build_command ?? ""),
          deploy_command: String(t.deploy_command ?? "npx wrangler deploy"),
        })).filter((t) => t.trigger_uuid);
      }
    }
    if (!triggers.length && builds.length && builds[0].trigger_uuid) {
      triggers.push({
        trigger_uuid: builds[0].trigger_uuid,
        trigger_name: "Trigger principal",
        branch: builds[0].branch || "main",
        build_command: "",
        deploy_command: "npx wrangler deploy",
      });
    }
  } else if (!errorPermisos) {
    warnings.push(`No se encontró el Worker «${cfg.worker_name}» en la cuenta ${cfg.account_id}.`);
  }

  const ultimo = builds[0];
  let estadoGeneral: "SANO" | "ERROR_BUILD" | "COMPILANDO" | "SIN_BUILDS" = "SIN_BUILDS";
  if (ultimo) {
    const est = `${ultimo.status} ${ultimo.build_outcome}`.toLowerCase();
    if (/fail|error|cancel/.test(est)) estadoGeneral = "ERROR_BUILD";
    else if (/queued|running|initializing|active|pending/.test(est) && !/success|succeed/.test(est)) estadoGeneral = "COMPILANDO";
    else if (/success|succeed/.test(est)) estadoGeneral = "SANO";
  } else if (deployments.length > 0) {
    estadoGeneral = "SANO";
  }

  return {
    ok: !errorPermisos,
    configurado: true,
    error_api: errorPermisos || undefined,
    advertencias: warnings,
    account_id: cfg.account_id,
    worker_name: cfg.worker_name,
    script_tag: scriptTag,
    estado_general: estadoGeneral,
    deployments,
    builds,
    triggers,
  };
}

export async function consultarLogBuildCloudflare(
  rawDb: D1Database,
  env: Record<string, unknown> | undefined,
  buildUuid: string,
  fetchFn: typeof fetch = fetch
): Promise<
  | {
      ok: true;
      build_uuid: string;
      truncated: boolean;
      lineas: { ts: string; texto: string }[];
      texto: string;
      diagnostico: ReturnType<typeof diagnosticarErrorBuild>;
    }
  | { ok: false; error: string }
> {
  const id = String(buildUuid || "").trim();
  if (!UUID_OR_TAG.test(id)) return { ok: false, error: "Identificador de compilación (build_uuid) no válido." };
  const cfg = await leerConfigCloudflare(rawDb, env);
  if (!cfg.configurado) return { ok: false, error: "Conecta primero tu API Token de Cloudflare." };

  try {
    const r = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id)}/builds/builds/${encodeURIComponent(id)}/logs`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${cfg.api_token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(12_000),
      }
    );
    const j = (await r.json().catch(() => null)) as {
      success?: boolean;
      result?: { lines?: unknown[]; truncated?: boolean };
      errors?: { message?: string }[];
    } | null;
    if (!r.ok || !j?.success || !j.result) {
      return { ok: false, error: j?.errors?.[0]?.message || `Cloudflare respondió HTTP ${r.status} al leer logs.` };
    }
    const rawLines = Array.isArray(j.result.lines) ? j.result.lines : [];
    const lineas = rawLines.map((ln) => {
      if (Array.isArray(ln)) {
        const tsNum = Number(ln[0]);
        const ts = Number.isFinite(tsNum) && tsNum > 0 ? new Date(tsNum > 1e12 ? tsNum : tsNum * 1000).toISOString().slice(11, 19) : "";
        return { ts, texto: String(ln[1] ?? "") };
      }
      if (ln && typeof ln === "object") {
        const o = ln as Record<string, unknown>;
        return { ts: String(o.timestamp ?? o.ts ?? ""), texto: String(o.message ?? o.line ?? o.text ?? "") };
      }
      return { ts: "", texto: String(ln ?? "") };
    });
    const texto = lineas.map((l) => (l.ts ? `[${l.ts}] ${l.texto}` : l.texto)).join("\n");
    return {
      ok: true,
      build_uuid: id,
      truncated: Boolean(j.result.truncated),
      lineas,
      texto,
      diagnostico: diagnosticarErrorBuild(texto),
    };
  } catch (e) {
    return { ok: false, error: `Error leyendo log de Cloudflare: ${(e as Error).message}` };
  }
}

export async function relanzarBuildCloudflare(
  rawDb: D1Database,
  env: Record<string, unknown> | undefined,
  opc?: { trigger_uuid?: string; branch?: string; purgar_cache?: boolean },
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; build_uuid: string; trigger_uuid: string; branch: string } | { ok: false; error: string }> {
  const cfg = await leerConfigCloudflare(rawDb, env);
  if (!cfg.configurado) return { ok: false, error: "Conecta primero tu API Token de Cloudflare." };

  let triggerUuid = String(opc?.trigger_uuid || "").trim();
  let branch = String(opc?.branch || "").trim();
  if (!triggerUuid || !branch) {
    const est = await consultarDesplieguesYBuilds(rawDb, env, fetchFn);
    if (!est.ok && est.error_api) return { ok: false, error: est.error_api };
    const trigEncontrado = triggerUuid
      ? est.triggers?.find((t) => t.trigger_uuid === triggerUuid)
      : est.triggers?.[0];
    if (!triggerUuid) triggerUuid = trigEncontrado?.trigger_uuid || "";
    if (!branch) branch = trigEncontrado?.branch || "main";
  }
  if (!UUID_OR_TAG.test(triggerUuid)) {
    return { ok: false, error: "No se encontró un trigger de compilación conectado a GitHub para este Worker." };
  }
  branch = branch || "main";

  const headers = { Authorization: `Bearer ${cfg.api_token}`, "Content-Type": "application/json" };
  const baseAcc = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id)}`;

  try {
    if (opc?.purgar_cache) {
      await fetchFn(`${baseAcc}/builds/triggers/${encodeURIComponent(triggerUuid)}/purge_build_cache`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(8_000),
      }).catch(() => null);
    }
    // La API oficial de Workers Builds exige al menos `branch` (o `commit_hash`) en el cuerpo JSON; `{}` devuelve "Invalid request body".
    const r = await fetchFn(`${baseAcc}/builds/triggers/${encodeURIComponent(triggerUuid)}/builds`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ branch }),
    });
    const j = (await r.json().catch(() => null)) as {
      success?: boolean;
      result?: { build_uuid?: string; uuid?: string };
      errors?: { message?: string }[];
    } | null;
    if (!r.ok || !j?.success) {
      return { ok: false, error: j?.errors?.[0]?.message || `Cloudflare rechazó relanzar el build (HTTP ${r.status}).` };
    }
    return { ok: true, build_uuid: String(j.result?.build_uuid ?? j.result?.uuid ?? ""), trigger_uuid: triggerUuid, branch };
  } catch (e) {
    return { ok: false, error: `Error al relanzar compilación en Cloudflare: ${(e as Error).message}` };
  }
}

// ============================================================================
// Auto-Enlace de Bindings Nativos D1 vía Cloudflare Workers Settings API (v5.0.0)
// Elimina la necesidad de editar wrangler.toml y hacer Push a GitHub por cada cliente nuevo.
// ============================================================================
export async function sincronizarBindingsD1Cloudflare(
  rawDb: D1Database,
  env: Record<string, unknown> | undefined,
  opc?: { soloCodigo?: string },
  fetchFn: typeof fetch = fetch
): Promise<{
  ok: boolean;
  cambios: number;
  enlazados: string[];
  ya_nativos: string[];
  mensaje?: string;
  error?: string;
  permiso_faltante?: boolean;
}> {
  const cfg = await leerConfigCloudflare(rawDb, env);
  if (!cfg.configurado) {
    return { ok: false, cambios: 0, enlazados: [], ya_nativos: [], error: "API Token de Cloudflare no configurado." };
  }

  const sqlInq = opc?.soloCodigo
    ? rawDb
        .prepare(`SELECT codigo, d1_uuid FROM _mt_inquilinos WHERE activo = 1 AND codigo = ? AND d1_uuid IS NOT NULL AND trim(d1_uuid) <> ''`)
        .bind(opc.soloCodigo)
    : rawDb.prepare(`SELECT codigo, d1_uuid FROM _mt_inquilinos WHERE activo = 1 AND codigo <> 'principal' AND d1_uuid IS NOT NULL AND trim(d1_uuid) <> ''`);

  const { results: inquilinosD1 } = await sqlInq
    .all<{ codigo: string; d1_uuid: string }>()
    .catch(() => ({ results: [] as { codigo: string; d1_uuid: string }[] }));

  const candidatos = (inquilinosD1 || []).filter((r) => /^DB_\d+$/i.test(r.codigo) && UUID_OR_TAG.test(String(r.d1_uuid || "").trim()));
  if (!candidatos.length) {
    return { ok: true, cambios: 0, enlazados: [], ya_nativos: [], mensaje: "No hay bases D1 de clientes pendientes de enlace nativo." };
  }

  const urlSettings = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id)}/workers/scripts/${encodeURIComponent(cfg.worker_name)}/settings`;
  const authHeader = { Authorization: `Bearer ${cfg.api_token}` };

  try {
    // 1) Leer bindings actuales del Worker para preservar DB, DB_DEMO, RESPALDOS_R2, ASSETS y variables existentes
    const rGet = await fetchFn(urlSettings, {
      method: "GET",
      headers: { ...authHeader, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const jGet = (await rGet.json().catch(() => null)) as {
      success?: boolean;
      result?: { bindings?: Record<string, unknown>[] };
      errors?: { message?: string }[];
    } | null;
    if (rGet.status === 401 || rGet.status === 403) {
      return {
        ok: false,
        cambios: 0,
        enlazados: [],
        ya_nativos: [],
        permiso_faltante: true,
        error: `Tu API Token no tiene permiso «Workers Scripts: Edit» (HTTP ${rGet.status}). Los clientes seguirán operando en modo HTTP aislado sin interrupción.`,
      };
    }
    if (!rGet.ok || !jGet?.success || !Array.isArray(jGet.result?.bindings)) {
      return {
        ok: false,
        cambios: 0,
        enlazados: [],
        ya_nativos: [],
        error: jGet?.errors?.[0]?.message || `Cloudflare no devolvió los bindings actuales del Worker (HTTP ${rGet.status}).`,
      };
    }

    const actuales = jGet.result.bindings;
    const bindingPrincipal = actuales.find((b) => String(b.name || "") === "DB" && String(b.type || "") === "d1");
    if (!bindingPrincipal) {
      return {
        ok: false,
        cambios: 0,
        enlazados: [],
        ya_nativos: [],
        error: "Protección de seguridad: no se detectó el binding principal DB en la configuración actual del Worker; se abortó el PATCH.",
      };
    }

    // Respetar exactamente el nombre de campo que usa Cloudflare en este Worker (`id` o `database_id`)
    const campoUuidD1 = "database_id" in bindingPrincipal && !("id" in bindingPrincipal) ? "database_id" : "id";

    // Preservar todos los bindings no-secret_text y no-assets (los secrets y assets se protegen con keep_bindings + keep_assets)
    const mapaD1Actual = new Map<string, string>();
    const bindingsPreservados: Record<string, unknown>[] = [];
    for (const b of actuales) {
      const tipo = String(b.type || "");
      const nombre = String(b.name || "");
      if (tipo === "secret_text" || tipo === "assets") continue;
      if (tipo === "d1" && nombre) {
        mapaD1Actual.set(nombre.toUpperCase(), String(b.id ?? b.database_id ?? "").trim());
      }
      bindingsPreservados.push(b);
    }

    const yaNativos: string[] = [];
    const porEnlazar: { codigo: string; uuid: string }[] = [];
    for (const c of candidatos) {
      const codUp = c.codigo.toUpperCase();
      const uuidLimpio = c.d1_uuid.trim();
      if (mapaD1Actual.get(codUp) === uuidLimpio) {
        yaNativos.push(codUp);
      } else {
        porEnlazar.push({ codigo: codUp, uuid: uuidLimpio });
      }
    }

    if (!porEnlazar.length) {
      return {
        ok: true,
        cambios: 0,
        enlazados: [],
        ya_nativos: yaNativos,
        mensaje: `Todos los bindings nativos D1 (${yaNativos.length}) ya están enlazados en Cloudflare.`,
      };
    }

    // Reemplazar o agregar los bindings D1 nuevos sin tocar ningún otro binding del Worker
    const nombresNuevos = new Set(porEnlazar.map((p) => p.codigo));
    const bindingsFinales: Record<string, unknown>[] = bindingsPreservados.filter(
      (b) => !(String(b.type || "") === "d1" && nombresNuevos.has(String(b.name || "").toUpperCase()))
    );
    for (const item of porEnlazar) {
      bindingsFinales.push({
        type: "d1",
        name: item.codigo,
        [campoUuidD1]: item.uuid,
      });
    }

    const fd = new FormData();
    fd.set(
      "settings",
      JSON.stringify({
        bindings: bindingsFinales,
        keep_bindings: ["secret_text", "assets"],
        keep_assets: true,
      })
    );

    const rPatch = await fetchFn(urlSettings, {
      method: "PATCH",
      headers: authHeader,
      body: fd,
      signal: AbortSignal.timeout(15_000),
    });
    const jPatch = (await rPatch.json().catch(() => null)) as {
      success?: boolean;
      errors?: { message?: string }[];
    } | null;

    if (rPatch.status === 401 || rPatch.status === 403) {
      return {
        ok: false,
        cambios: 0,
        enlazados: [],
        ya_nativos: yaNativos,
        permiso_faltante: true,
        error: `Tu API Token necesita permiso «Workers Scripts: Edit» para enlazar bindings nativos automáticamente (HTTP ${rPatch.status}).`,
      };
    }
    if (!rPatch.ok || !jPatch?.success) {
      return {
        ok: false,
        cambios: 0,
        enlazados: [],
        ya_nativos: yaNativos,
        error: jPatch?.errors?.[0]?.message || `Cloudflare rechazó actualizar bindings nativos (HTTP ${rPatch.status}).`,
      };
    }

    return {
      ok: true,
      cambios: porEnlazar.length,
      enlazados: porEnlazar.map((p) => p.codigo),
      ya_nativos: yaNativos,
      mensaje: `Enlazado(s) automáticamente en modo Nativo D1: ${porEnlazar.map((p) => p.codigo).join(", ")}.`,
    };
  } catch (e) {
    return {
      ok: false,
      cambios: 0,
      enlazados: [],
      ya_nativos: [],
      error: `Error conectando con Cloudflare Settings API: ${(e as Error).message}`,
    };
  }
}

export async function rollbackWorkerCloudflare(
  rawDb: D1Database,
  env: Record<string, unknown> | undefined,
  versionId: string,
  motivo = "Rollback manual desde Centro de Control FacturaYa",
  fetchFn: typeof fetch = fetch
): Promise<{ ok: true; deployment_id: string; version_id: string } | { ok: false; error: string }> {
  const vid = String(versionId || "").trim();
  if (!UUID_OR_TAG.test(vid)) return { ok: false, error: "Identificador de versión (version_id) no válido." };
  const cfg = await leerConfigCloudflare(rawDb, env);
  if (!cfg.configurado) return { ok: false, error: "Conecta primero tu API Token de Cloudflare." };

  try {
    const r = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.account_id)}/workers/scripts/${encodeURIComponent(cfg.worker_name)}/deployments`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.api_token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(12_000),
        body: JSON.stringify({
          strategy: "percentage",
          annotations: {
            "workers/message": motivo.slice(0, 120),
            rollback_comment: motivo.slice(0, 120),
          },
          versions: [{ version_id: vid, percentage: 100 }],
        }),
      }
    );
    const j = (await r.json().catch(() => null)) as {
      success?: boolean;
      result?: { id?: string };
      errors?: { message?: string }[];
    } | null;
    if (!r.ok || !j?.success) {
      return { ok: false, error: j?.errors?.[0]?.message || `Cloudflare rechazó el rollback (HTTP ${r.status}).` };
    }
    return { ok: true, deployment_id: String(j.result?.id ?? ""), version_id: vid };
  } catch (e) {
    return { ok: false, error: `Error ejecutando Rollback en Cloudflare: ${(e as Error).message}` };
  }
}
