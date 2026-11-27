import test from "node:test";
import assert from "node:assert/strict";
import { crearBaseDatosD1 } from "./d1";
import { migrar } from "../src/migraciones";
import { asegurarTablasMultiTenant } from "../src/inquilinos";
import { ejecutarMantenimientoNocturno } from "../src/mantenimiento";
import type { AlmacenR2 } from "../src/respaldos-r2";
import { leerRespaldoCualquierFormato } from "../src/rutas/restaurar";

const MASTER_KEY = "ClaveMaestraTestEscalaMantV560!!";

function crearBucketR2Binario(): AlmacenR2 & { objetos: Map<string, Uint8Array> } {
  const objetos = new Map<string, Uint8Array>();
  async function aBytes(v: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null): Promise<Uint8Array> {
    if (!v) return new Uint8Array(0);
    if (typeof v === "string") return new TextEncoder().encode(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    if (typeof (v as Blob).arrayBuffer === "function") return new Uint8Array(await (v as Blob).arrayBuffer());
    return new Uint8Array(0);
  }
  return {
    objetos,
    async put(key, value) {
      const b = await aBytes(value);
      objetos.set(key, b);
      return { key, size: b.byteLength, uploaded: new Date() };
    },
    async get(key) {
      const b = objetos.get(key);
      if (!b) return null;
      return {
        key,
        size: b.byteLength,
        uploaded: new Date(),
        body: new ReadableStream({
          start(c) {
            c.enqueue(b.slice(0));
            c.close();
          },
        }),
        async text() {
          return new TextDecoder().decode(b);
        },
        async arrayBuffer() {
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        },
      };
    },
    async list(opts) {
      const pref = opts?.prefix || "";
      const list = [...objetos.entries()]
        .filter(([k]) => k.startsWith(pref))
        .map(([key, b]) => ({ key, size: b.byteLength, uploaded: new Date() }));
      return { objects: list, truncated: false };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objetos.delete(k);
    },
  };
}

test("v5.6 Escala Mantenimiento: rotación circular multi-día cubre 130 empresas sin saltos, aísla fallos y alerta >2 días", async () => {
  const rawDb = crearBaseDatosD1(":memory:");
  await migrar(rawDb);
  await asegurarTablasMultiTenant(rawDb);
  await rawDb
    .prepare(
      `INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv)
       VALUES (1, 1, 'Principal C.A.', 'J-00000001-0', 'Caracas', 50)`
    )
    .run();

  const env: Record<string, unknown> = {
    DB: rawDb,
    MASTER_KEY,
    RESPALDOS_R2: crearBucketR2Binario(),
  };

  // Registrar 129 empresas adicionales (total 130 con principal) apuntando a un DB compartido liviano, excepto 1 rota
  const dbCompartida = crearBaseDatosD1(":memory:");
  await migrar(dbCompartida);
  await dbCompartida
    .prepare(`INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv) VALUES (1, 1, 'Cliente Pool', 'J-10000000-1', 'Caracas', 50)`)
    .run();

  const dbRota = {
    prepare() {
      throw new Error("D1_SIMULADO_CAIDO");
    },
    async batch() {
      throw new Error("D1_SIMULADO_CAIDO");
    },
  } as unknown as D1Database;

  const inserts: D1PreparedStatement[] = [];
  for (let i = 1; i <= 129; i++) {
    const cod = `DB_${i}`;
    env[cod] = i === 15 ? dbRota : dbCompartida;
    inserts.push(
      rawDb
        .prepare(
          `INSERT INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, plan_usd, activo)
           VALUES (?, 'BINDING', ?, ?, 'Caracas', '0414', 'Dueño', ?, 'APP_SENIAT', 10, 1)`
        )
        .bind(cod, `Empresa ${i}`, `J-1000${String(i).padStart(4, "0")}-1`, `dueno${i}@test.ve`)
    );
  }
  await rawDb.batch(inserts);

  // Simular 3 días × 4 tandas por noche con limiteEmpresas = 12 (48/noche → 144 slots en 3 noches > 130 empresas)
  const dias = ["2026-11-10", "2026-11-11", "2026-11-12"];
  let totalRevisadas = 0;
  let falloAisladoDetectado = false;
  let alertaRetrasoDetectada = false;

  const fetchOffline: typeof fetch = async () => new Response("offline", { status: 503 });
  for (const fecha of dias) {
    for (let tick = 0; tick < 4; tick++) {
      const res = await ejecutarMantenimientoNocturno(rawDb, env, {
        hoyIso: fecha,
        tipo: "NOCTURNO_AUTO",
        maxEmpresasLote: 12,
        maxLotesDia: 4,
        fetchFn: fetchOffline,
      });
      totalRevisadas += res.empresas_revisadas;
      if (res.alertas.some((a) => a.includes("DB_15") || a.includes("D1_SIMULADO_CAIDO"))) {
        falloAisladoDetectado = true;
      }
      if (res.alertas.some((a) => /sin respaldo|2 días|retraso/i.test(a))) {
        alertaRetrasoDetectada = true;
      }
    }
  }

  // Verificar mediante las claves R2 generadas que se cubrieron las 129 empresas sanas (130 - DB_15 rota)
  const bucket = env.RESPALDOS_R2 as ReturnType<typeof crearBucketR2Binario>;
  const codigosRespaldados = new Set<string>();
  for (const k of bucket.objetos.keys()) {
    const m = k.match(/-([A-Za-z0-9_]+)\.json\.gz$/);
    if (m) codigosRespaldados.add(m[1]);
  }
  assert.ok(totalRevisadas >= 130, `Deben haberse procesado >=130 empresas en 3 noches (total: ${totalRevisadas})`);
  assert.equal(codigosRespaldados.size, 129, `Las 129 empresas sanas deben tener respaldo R2 tras la rotación circular (obtenidas: ${codigosRespaldados.size})`);
  assert.equal(falloAisladoDetectado, true, "La BD rota DB_15 debe aislarse y reportar alerta sin detener el lote");
  assert.equal(alertaRetrasoDetectada, true, "Debe alertar cuando una empresa supera 2 días sin respaldo R2 exitoso");
});

test("v5.6 Retención >12 meses: archiva auditoria y correo_envios antiguos en R2 gzip antes de borrar de D1", async () => {
  const rawDb = crearBaseDatosD1(":memory:");
  await migrar(rawDb);
  await asegurarTablasMultiTenant(rawDb);
  const bucket = crearBucketR2Binario();
  const env: Record<string, unknown> = {
    DB: rawDb,
    MASTER_KEY,
    RESPALDOS_R2: bucket,
  };

  await rawDb
    .prepare(
      `INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv)
       VALUES (1, 1, 'Retencion C.A.', 'J-99999999-9', 'Caracas', 50)`
    )
    .run();

  // Insertar 2 registros viejos (> 12 meses) y 1 reciente en auditoria y correo_envios
  await rawDb.batch([
    rawDb.prepare(`INSERT INTO auditoria (accion, detalle, creado_en) VALUES ('OLD_1', 'antiguo 1', '2024-01-10 10:00:00')`),
    rawDb.prepare(`INSERT INTO auditoria (accion, detalle, creado_en) VALUES ('OLD_2', 'antiguo 2', '2024-02-15 10:00:00')`),
    rawDb.prepare(`INSERT INTO auditoria (accion, detalle, creado_en) VALUES ('RECENT', 'reciente', datetime('now'))`),
    rawDb.prepare(`INSERT INTO correo_envios (tipo, destinatario, asunto, proveedor, estado, creado_en) VALUES ('DOCUMENTO', 'a@b.ve', 'Viejo', 'BREVO', 'ENVIADO', '2024-01-10 10:00:00')`),
    rawDb.prepare(`INSERT INTO correo_envios (tipo, destinatario, asunto, proveedor, estado, creado_en) VALUES ('DOCUMENTO', 'c@d.ve', 'Nuevo', 'BREVO', 'ENVIADO', datetime('now'))`),
  ]);

  const fetchOffline: typeof fetch = async () => new Response("offline", { status: 503 });
  const res = await ejecutarMantenimientoNocturno(rawDb, env, {
    hoyIso: "2026-11-20",
    tipo: "NOCTURNO_AUTO",
    fetchFn: fetchOffline,
  });
  assert.equal(res.ok, true);

  // Los viejos deben haberse borrado de D1 pero conservando los recientes
  const audRestantes = await rawDb.prepare(`SELECT accion FROM auditoria WHERE accion IN ('OLD_1', 'OLD_2', 'RECENT')`).all<{ accion: string }>();
  assert.deepEqual(audRestantes.results.map((r) => r.accion), ["RECENT"]);

  const corRestantes = await rawDb.prepare(`SELECT asunto FROM correo_envios`).all<{ asunto: string }>();
  assert.deepEqual(corRestantes.results.map((r) => r.asunto), ["Nuevo"]);

  // Deben existir 2 archivos en R2 bajo respaldos/archivo-retencion/ (uno por tabla: auditoria y correo_envios)
  const clavesArchivo = [...bucket.objetos.keys()].filter((k) => k.startsWith("respaldos/archivo-retencion/") && k.endsWith(".json.gz"));
  assert.equal(clavesArchivo.length, 2, `Deben existir 2 archivos de retención gzip en R2 (claves: ${clavesArchivo.join(", ")})`);
  const claveAud = clavesArchivo.find((k) => k.includes("-auditoria-"));
  const claveCor = clavesArchivo.find((k) => k.includes("-correo_envios-"));
  assert.ok(claveAud && claveCor);
  const archAud = await leerRespaldoCualquierFormato(bucket.objetos.get(claveAud)!);
  const archCor = await leerRespaldoCualquierFormato(bucket.objetos.get(claveCor)!);
  assert.equal((archAud.filas as any[]).length, 2);
  assert.equal((archCor.filas as any[]).length, 1);
});
