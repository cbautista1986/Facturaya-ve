import test from "node:test";
import assert from "node:assert/strict";
import { crearBaseDatosD1 } from "./d1";
import { migrar } from "../src/migraciones";
import {
  POLITICA_LIMITE,
  asegurarTablaLimitesRed,
  limitePayloadPorRuta,
  limpiarLimiteIp,
  registrarEventoIp,
  verificarLimiteIp,
  verificarTurnstile,
} from "../src/seguridad-red";
import { diagnosticarTodoElSistema, repararInquilino } from "../src/salud-bd";

test("Seguridad de Red: Límites por IP (Rate Limiting), Tamaño de Payload y Turnstile Anti-Bots", async () => {
  const db = crearBaseDatosD1(":memory:");
  await migrar(db);
  await asegurarTablaLimitesRed(db);

  assert.equal(limitePayloadPorRuta("/api/login"), 256 * 1024);
  assert.equal(limitePayloadPorRuta("/api/config"), 380_000);
  assert.equal(limitePayloadPorRuta("/api/sistema/restaurar/subir"), 2 * 1024 * 1024);

  const ipPrueba = "203.0.113.77";
  for (let i = 0; i < POLITICA_LIMITE.LOGIN_IP.maxIntentos; i++) {
    await registrarEventoIp(db, POLITICA_LIMITE.LOGIN_IP, ipPrueba, 1000);
  }
  const lim = await verificarLimiteIp(db, POLITICA_LIMITE.LOGIN_IP, ipPrueba, 1005);
  assert.equal(lim.bloqueado, true);

  await limpiarLimiteIp(db, POLITICA_LIMITE.LOGIN_IP, ipPrueba);
  const limDespues = await verificarLimiteIp(db, POLITICA_LIMITE.LOGIN_IP, ipPrueba, 1010);
  assert.equal(limDespues.bloqueado, false);

  // Turnstile en modo sin clave secreta configurada permite el paso; con clave secreta valida token y acción
  const tsSinClave = await verificarTurnstile(undefined, "", ipPrueba);
  assert.equal(tsSinClave.ok, true);

  const tsFaltaToken = await verificarTurnstile("0xSecret", "", ipPrueba);
  assert.equal(tsFaltaToken.ok, false);
});

test("Salud y Autorreparación de BD: Detecta contadores atrasados o triggers faltantes y los repara sin perder datos", async () => {
  const db = crearBaseDatosD1(":memory:");
  await migrar(db);
  const env: Record<string, unknown> = { DB: db };

  // Simular un contador atrasado respecto a una factura emitida
  await db.prepare(
    `INSERT INTO documentos (id, tipo, es_nota_credito, estado, modo, numero, control_interno, fecha_emision, subtotal_usd, iva_usd, total_usd, subtotal_bs, iva_bs, total_bs, tasa_e8)
     VALUES (1, 'FACTURA', 0, 'EMITIDO', 'REAL', 5, 5, '2026-11-15', 1000, 160, 1160, 100000, 16000, 116000, 10000000000)`
  ).run();
  await db.prepare(`UPDATE contadores SET valor = 1 WHERE clave = 'FACTURA:REAL'`).run();

  const diagAntes = await diagnosticarTodoElSistema(db, env);
  assert.equal(diagAntes.sano_global, false);
  assert.equal(diagAntes.reportes[0].correlativos_ok, false);

  // Ejecutar reparación quirúrgica no destructiva
  const rep = await repararInquilino(db, env, "principal", null);
  assert.equal(rep.diagnostico.sano, true);
  assert.equal(rep.diagnostico.correlativos_ok, true);

  const cont = await db.prepare(`SELECT valor FROM contadores WHERE clave = 'FACTURA:REAL'`).first<{ valor: number }>();
  assert.equal(cont?.valor, 5);
});
