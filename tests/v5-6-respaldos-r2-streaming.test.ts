import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { crearBaseDatosD1 } from "./d1";
import { migrar } from "../src/migraciones";
import { asegurarTablasMultiTenant, registrarCorreoDirectorio } from "../src/inquilinos";
import { asegurarTablaLimitesRed } from "../src/seguridad-red";
import { cifrarSecreto, firmarHmacRespaldo, verificarHmacDigestRespaldo } from "../src/cifrado";
import { hashClave } from "../src/seguridad";
import { ejecutarRespaldoR2, type AlmacenR2 } from "../src/respaldos-r2";
import { leerRespaldoCualquierFormato } from "../src/rutas/restaurar";
import { generarRespaldoNegocio } from "../src/salud-bd";

const MASTER_KEY = "ClaveMaestraTestR2StreamingV560!";
const SUPER_EMAIL = "super@streaming.test";
const PASS = "ClaveSegura2026!";

function crearBucketMultipart() {
  const objetos = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>();
  const partesSubidasPorClave = new Map<string, number>();

  async function aBytes(v: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null): Promise<Uint8Array> {
    if (!v) return new Uint8Array(0);
    if (typeof v === "string") return new TextEncoder().encode(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    if (typeof (v as Blob).arrayBuffer === "function") return new Uint8Array(await (v as Blob).arrayBuffer());
    return new Uint8Array(0);
  }

  const bucket: AlmacenR2 & {
    objetos: typeof objetos;
    partesSubidasPorClave: typeof partesSubidasPorClave;
  } = {
    objetos,
    partesSubidasPorClave,
    async put(key, value, options) {
      const bytes = await aBytes(value);
      objetos.set(key, { bytes, customMetadata: options?.customMetadata });
      return { key, size: bytes.byteLength, uploaded: new Date(), customMetadata: options?.customMetadata };
    },
    async createMultipartUpload(key, options) {
      const partes = new Map<number, Uint8Array>();
      return {
        async uploadPart(partNumber, value) {
          const b = await aBytes(value);
          partes.set(partNumber, b);
          partesSubidasPorClave.set(key, (partesSubidasPorClave.get(key) || 0) + 1);
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(uploadedParts) {
          const orden = [...uploadedParts].sort((a, b) => a.partNumber - b.partNumber);
          let total = 0;
          for (const p of orden) total += partes.get(p.partNumber)?.byteLength || 0;
          const out = new Uint8Array(total);
          let off = 0;
          for (const p of orden) {
            const b = partes.get(p.partNumber);
            if (b) {
              out.set(b, off);
              off += b.byteLength;
            }
          }
          objetos.set(key, { bytes: out, customMetadata: options?.customMetadata });
          return { key, size: out.byteLength, uploaded: new Date(), customMetadata: options?.customMetadata };
        },
        async abort() {
          partes.clear();
        },
      };
    },
    async get(key) {
      const it = objetos.get(key);
      if (!it) return null;
      return {
        key,
        size: it.bytes.byteLength,
        uploaded: new Date(),
        customMetadata: it.customMetadata,
        body: new ReadableStream({
          start(c) {
            c.enqueue(it.bytes.slice(0));
            c.close();
          },
        }),
        async text() {
          return new TextDecoder().decode(it.bytes);
        },
        async arrayBuffer() {
          return it.bytes.buffer.slice(it.bytes.byteOffset, it.bytes.byteOffset + it.bytes.byteLength);
        },
      };
    },
    async list(opts) {
      const pref = opts?.prefix || "";
      return {
        objects: [...objetos.entries()]
          .filter(([k]) => k.startsWith(pref))
          .map(([key, v]) => ({ key, size: v.bytes.byteLength, uploaded: new Date(), customMetadata: v.customMetadata })),
        truncated: false,
      };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objetos.delete(k);
    },
  };
  return bucket;
}

test("v5.6 Respaldos R2 Streaming: multipart gzip .json.gz, hmac:v2, exclusión de secretos y round-trip v2 + legado v1", async () => {
  const db = crearBaseDatosD1(":memory:");
  const bucket = crearBucketMultipart();
  const env: Record<string, unknown> = {
    DB: db,
    MASTER_KEY,
    SUPER_ADMIN_EMAIL: SUPER_EMAIL,
    RESPALDOS_R2: bucket,
  };
  await migrar(db);
  await asegurarTablasMultiTenant(db);
  await asegurarTablaLimitesRed(db);

  const hash = await hashClave(PASS, env);
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv) VALUES (1, 1, 'Streaming C.A.', 'J-55555555-5', 'Caracas', 50)`),
    db.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave, totp_secreto) VALUES ('Super', ?, ?, 'SUPER_ADMIN', 1, 0, 'SECRETO_TOTP_NO_EXPORTAR')`).bind(SUPER_EMAIL, hash),
    db.prepare(`INSERT OR REPLACE INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_token', ?, datetime('now'))`).bind(await cifrarSecreto("TOKEN_SECRETO_API", env)),
  ]);
  await registrarCorreoDirectorio(db, SUPER_EMAIL, "principal", "SUPER_ADMIN", env);

  // Poblar 220 clientes con notas variadas (baja compresibilidad) para forzar múltiples partes con tamParteBytes=2048
  const stmts: D1PreparedStatement[] = [];
  for (let i = 1; i <= 220; i++) {
    const ruido = crypto.randomUUID() + "-" + crypto.randomUUID();
    stmts.push(
      db.prepare(`INSERT INTO clientes (rif_cedula, nombre_apellido, direccion, whatsapp, email) VALUES (?, ?, ?, ?, ?)`)
        .bind(`V-${10000000 + i}-0`, `Cliente ${i} ${ruido.slice(0, 24)}`, `Direccion ${ruido}`, `0414${1000000 + i}`, `cli${i}@test.ve`)
    );
  }
  await db.batch(stmts);

  // Ejecutar respaldo streaming con tamaño de parte pequeño (2 KB) para ejercitar multipart
  const res = await ejecutarRespaldoR2(db, env, {
    tipo: "manual",
    hoyIso: "2026-11-20",
    tamParteBytes: 2048,
  });
  assert.equal(res.ok, true);
  assert.equal(res.firmado, true);
  assert.equal(res.claves.length, 1);
  const key = res.claves[0];
  assert.ok(key.endsWith("-principal.json.gz"));
  assert.ok((bucket.partesSubidasPorClave.get(key) || 0) >= 2, `Se esperaban >=2 partes multipart (subidas: ${bucket.partesSubidasPorClave.get(key)})`);

  // Verificar gzip magic bytes (0x1f 0x8b)
  const rawGz = bucket.objetos.get(key)!.bytes;
  assert.equal(rawGz[0], 0x1f);
  assert.equal(rawGz[1], 0x8b);

  // Descomprimir y verificar estructura, exclusión de secretos y firma hmac:v2
  const json = await leerRespaldoCualquierFormato(rawGz);
  assert.equal(json.formato, "respaldo-maestro-facturaya");
  assert.ok(String(json.firma_hmac).startsWith("hmac:v2:"), `Se esperaba hmac:v2, llegó ${json.firma_hmac}`);
  assert.ok(typeof json.sha256_datos === "string" && json.sha256_datos.length === 64);

  const textoPlano = JSON.stringify(json);
  assert.equal(textoPlano.includes("TOKEN_SECRETO_API"), false, "Nunca debe exportar secretos de integraciones");
  assert.equal(textoPlano.includes("SECRETO_TOTP_NO_EXPORTAR"), false, "Nunca debe exportar totp_secreto");
  assert.equal(textoPlano.includes(hash), false, "Nunca debe exportar password_hash");

  const negocio = (json.negocios as Record<string, any>).principal;
  assert.equal(negocio.datos.clientes.length, 220);

  // Verificar hmac:v2 válido y rechazo por alteración
  assert.equal(
    await verificarHmacDigestRespaldo(String(negocio.firma_hmac), String(negocio.modo_origen), String(negocio.sha256_datos), negocio.conteos, negocio.sumas, env),
    true
  );
  assert.equal(
    await verificarHmacDigestRespaldo(String(negocio.firma_hmac), String(negocio.modo_origen), "0".repeat(64), negocio.conteos, negocio.sumas, env),
    false
  );

  // Round-trip de restauración sobre una BD destino recién instalada (vacía): iniciar con respaldo v2 (hmac:v2) Y con respaldo legado v1 (hmac:v1)
  const dbDestino = crearBaseDatosD1(":memory:");
  const envDestino: Record<string, unknown> = {
    DB: dbDestino,
    MASTER_KEY,
    SUPER_ADMIN_EMAIL: SUPER_EMAIL,
  };
  await migrar(dbDestino);
  await asegurarTablasMultiTenant(dbDestino);
  await asegurarTablaLimitesRed(dbDestino);
  await dbDestino.batch([
    dbDestino.prepare(`INSERT OR REPLACE INTO perfil_emisor (id, instalado, nombre_razon_social, rif, direccion_fiscal, tasa_bcv) VALUES (1, 1, 'Destino C.A.', 'J-55555555-5', 'Caracas', 50)`),
    dbDestino.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES ('Super', ?, ?, 'SUPER_ADMIN', 1, 0)`).bind(SUPER_EMAIL, hash),
  ]);
  await registrarCorreoDirectorio(dbDestino, SUPER_EMAIL, "principal", "SUPER_ADMIN", envDestino);

  const rLogin = await app.fetch(
    new Request("https://facturayave.com/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: SUPER_EMAIL, clave: PASS }),
    }),
    envDestino as never
  );
  const cookie = (rLogin.headers.getSetCookie?.() || [rLogin.headers.get("set-cookie") || ""])
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");

  // 1) Iniciar con respaldo v2 (.json.gz descomprimido -> manifiesto con hmac:v2)
  const rIniV2 = await app.fetch(
    new Request("https://facturayave.com/api/sistema/restaurar/iniciar", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        clave: PASS,
        manifiesto: {
          version: negocio.version,
          modo_origen: negocio.modo_origen,
          conteos: negocio.conteos,
          sumas: negocio.sumas,
          firma_hmac: negocio.firma_hmac,
          sha256_datos: negocio.sha256_datos,
          huella: negocio.huella,
        },
      }),
    }),
    envDestino as never
  );
  assert.equal(rIniV2.status, 200, `Restaurar v2 falló: ${await rIniV2.clone().text()}`);
  const rCan1 = await app.fetch(
    new Request("https://facturayave.com/api/sistema/restaurar/cancelar", {
      method: "POST",
      headers: { Cookie: cookie },
    }),
    envDestino as never
  );
  assert.equal(rCan1.status, 200);

  // 2) Respaldo legado v1 (JSON sin comprimir + hmac:v1) también debe pasar leerRespaldoCualquierFormato e iniciar
  const expV1 = await generarRespaldoNegocio(db, { env });
  const firmaV1 = await firmarHmacRespaldo(expV1.modo_origen, expV1.conteos, expV1.sumas, env, expV1.huella);
  assert.ok(firmaV1 && firmaV1.startsWith("hmac:v1:"));
  const leidoV1 = await leerRespaldoCualquierFormato(JSON.stringify({ ...expV1, firma_hmac: firmaV1 }));
  assert.equal(leidoV1.firma_hmac, firmaV1);

  const rIniV1 = await app.fetch(
    new Request("https://facturayave.com/api/sistema/restaurar/iniciar", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        clave: PASS,
        manifiesto: {
          version: expV1.version,
          modo_origen: expV1.modo_origen,
          conteos: expV1.conteos,
          sumas: expV1.sumas,
          firma_hmac: firmaV1,
          huella: expV1.huella,
        },
      }),
    }),
    envDestino as never
  );
  assert.equal(rIniV1.status, 200, `Restaurar legado v1 falló: ${await rIniV1.clone().text()}`);
});
