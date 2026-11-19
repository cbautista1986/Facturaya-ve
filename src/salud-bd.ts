// Auditoría, Diagnóstico de Salud y Reparación No Destructiva de Base de Datos (SENIAT + Multi-Tenant).
// REGLA DE ORO: Las funciones de reparación JAMÁS borran ni editan facturas, notas de crédito, pagos, compras ni clientes existentes.
import { asegurarLlavePlataforma, firmarHmacRespaldo } from "./cifrado";
import { auditar, modoActual, type Ctx } from "./comun";
import { asegurarTablasMultiTenant, hidratarBindingsCloudflare, obtenerDbInquilino, prefijoTablaDeCodigo, tieneBindingDedicado } from "./inquilinos";
import { MIGRACIONES, migrar } from "./migraciones";
import { calcularSumas } from "./rutas/restaurar";

export type ProblemaSalud = {
  nivel: "CRITICO" | "ADVERTENCIA";
  codigo: string;
  mensaje: string;
  reparable: boolean;
};

export type SaludInquilino = {
  codigo: string;
  tipo_db: string;
  nombre_negocio: string;
  rif: string;
  modo: "PRACTICA" | "REAL";
  sano: boolean;
  migraciones_ok: boolean;
  migraciones_faltantes: string[];
  triggers_ok: boolean;
  triggers_faltantes: string[];
  sqlite_ok: boolean;
  fk_rotas: number;
  correlativos_ok: boolean;
  descuadres_centavos: number;
  conteo: {
    clientes: number;
    documentos_real: number;
    pagos_real: number;
    compras_real: number;
  };
  problemas: ProblemaSalud[];
  reparables: number;
};

// Definición canónica final (post-migración 0015) de los 16 triggers de inmutabilidad SENIAT.
export const TRIGGERS_INMUTABILIDAD: { nombre: string; sql: string }[] = [
  {
    nombre: "doc_no_borrar",
    sql: `CREATE TRIGGER IF NOT EXISTS doc_no_borrar BEFORE DELETE ON documentos
      WHEN old.modo = 'REAL' AND old.estado <> 'BORRADOR'
      BEGIN SELECT RAISE(ABORT, 'Documento emitido: no se puede borrar, solo anular.'); END`,
  },
  {
    nombre: "doc_inmutable",
    sql: `CREATE TRIGGER IF NOT EXISTS doc_inmutable BEFORE UPDATE ON documentos
      WHEN old.modo = 'REAL' AND old.estado <> 'BORRADOR' AND (
        old.estado = 'ANULADO'
        OR new.estado NOT IN ('EMITIDO', 'FACTURADO', 'ANULADO')
        OR (old.estado = 'FACTURADO' AND new.estado <> 'FACTURADO')
        OR new.tipo IS NOT old.tipo
        OR new.es_nota_credito IS NOT old.es_nota_credito
        OR new.es_nota_debito IS NOT old.es_nota_debito
        OR new.factura_afectada_id IS NOT old.factura_afectada_id
        OR new.motivo_nc IS NOT old.motivo_nc
        OR new.modo IS NOT old.modo
        OR new.numero IS NOT old.numero
        OR new.control_interno IS NOT old.control_interno
        OR new.presupuesto_id IS NOT old.presupuesto_id
        OR new.cliente_id IS NOT old.cliente_id
        OR new.cliente_rif IS NOT old.cliente_rif
        OR new.cliente_nombre IS NOT old.cliente_nombre
        OR new.cliente_direccion IS NOT old.cliente_direccion
        OR new.cliente_whatsapp IS NOT old.cliente_whatsapp
        OR new.cliente_email IS NOT old.cliente_email
        OR new.nota IS NOT old.nota
        OR new.fecha_emision IS NOT old.fecha_emision
        OR new.emitido_en IS NOT old.emitido_en
        OR new.tasa_e8 IS NOT old.tasa_e8
        OR new.tasa_cargada_en IS NOT old.tasa_cargada_en
        OR new.subtotal_usd IS NOT old.subtotal_usd
        OR new.iva_usd IS NOT old.iva_usd
        OR new.aplica_igtf IS NOT old.aplica_igtf
        OR new.igtf_alicuota_cent IS NOT old.igtf_alicuota_cent
        OR new.igtf_usd IS NOT old.igtf_usd
        OR new.total_usd IS NOT old.total_usd
        OR new.subtotal_bs IS NOT old.subtotal_bs
        OR new.iva_bs IS NOT old.iva_bs
        OR new.igtf_bs IS NOT old.igtf_bs
        OR new.total_bs IS NOT old.total_bs
        OR new.costo_total_usd IS NOT old.costo_total_usd
        OR new.parametros_json IS NOT old.parametros_json
        OR new.emisor_json IS NOT old.emisor_json
        OR new.creado_en IS NOT old.creado_en
        OR new.creado_por IS NOT old.creado_por
        OR new.condicion IS NOT old.condicion
        OR new.dias_credito IS NOT old.dias_credito
        OR new.vence_el IS NOT old.vence_el
        OR new.medio IS NOT old.medio
        OR (new.control_fiscal IS NOT old.control_fiscal AND (old.control_fiscal IS NOT NULL OR old.medio IS NULL))
        OR (new.fiscal_serial IS NOT old.fiscal_serial AND (old.fiscal_serial IS NOT NULL OR old.medio IS NOT 'MAQUINA_FISCAL')))
      BEGIN SELECT RAISE(ABORT, 'Documento emitido: no se puede modificar, solo anular.'); END`,
  },
  {
    nombre: "documento_renglones_insert_emitido",
    sql: `CREATE TRIGGER IF NOT EXISTS documento_renglones_insert_emitido BEFORE INSERT ON documento_renglones
      WHEN (SELECT estado FROM documentos WHERE id = new.documento_id) <> 'BORRADOR'
       AND (SELECT modo FROM documentos WHERE id = new.documento_id) = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
  },
  {
    nombre: "documento_renglones_update_emitido",
    sql: `CREATE TRIGGER IF NOT EXISTS documento_renglones_update_emitido BEFORE UPDATE ON documento_renglones
      WHEN (SELECT estado FROM documentos WHERE id = old.documento_id) <> 'BORRADOR'
       AND (SELECT modo FROM documentos WHERE id = old.documento_id) = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
  },
  {
    nombre: "documento_renglones_delete_emitido",
    sql: `CREATE TRIGGER IF NOT EXISTS documento_renglones_delete_emitido BEFORE DELETE ON documento_renglones
      WHEN (SELECT estado FROM documentos WHERE id = old.documento_id) <> 'BORRADOR'
       AND (SELECT modo FROM documentos WHERE id = old.documento_id) = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
  },
  {
    nombre: "documento_impuestos_insert_emitido",
    sql: `CREATE TRIGGER IF NOT EXISTS documento_impuestos_insert_emitido BEFORE INSERT ON documento_impuestos
      WHEN (SELECT estado FROM documentos WHERE id = new.documento_id) <> 'BORRADOR'
       AND (SELECT modo FROM documentos WHERE id = new.documento_id) = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
  },
  {
    nombre: "documento_impuestos_update_emitido",
    sql: `CREATE TRIGGER IF NOT EXISTS documento_impuestos_update_emitido BEFORE UPDATE ON documento_impuestos
      WHEN (SELECT estado FROM documentos WHERE id = old.documento_id) <> 'BORRADOR'
       AND (SELECT modo FROM documentos WHERE id = old.documento_id) = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
  },
  {
    nombre: "documento_impuestos_delete_emitido",
    sql: `CREATE TRIGGER IF NOT EXISTS documento_impuestos_delete_emitido BEFORE DELETE ON documento_impuestos
      WHEN (SELECT estado FROM documentos WHERE id = old.documento_id) <> 'BORRADOR'
       AND (SELECT modo FROM documentos WHERE id = old.documento_id) = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
  },
  {
    nombre: "pago_no_borrar",
    sql: `CREATE TRIGGER IF NOT EXISTS pago_no_borrar BEFORE DELETE ON pagos WHEN old.modo = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Un pago registrado no se borra: se anula.'); END`,
  },
  {
    nombre: "pago_inmutable",
    sql: `CREATE TRIGGER IF NOT EXISTS pago_inmutable BEFORE UPDATE ON pagos
      WHEN old.modo = 'REAL' AND (
        old.estado = 'ANULADO'
        OR new.numero IS NOT old.numero
        OR new.documento_id IS NOT old.documento_id
        OR new.fecha_pago IS NOT old.fecha_pago
        OR new.metodo IS NOT old.metodo
        OR new.moneda IS NOT old.moneda
        OR new.monto_recibido IS NOT old.monto_recibido
        OR new.tasa_e8 IS NOT old.tasa_e8
        OR new.monto_usd IS NOT old.monto_usd
        OR new.saldo_despues_usd IS NOT old.saldo_despues_usd
        OR new.referencia IS NOT old.referencia
        OR new.es_retencion_iva IS NOT old.es_retencion_iva
        OR new.es_retencion_islr IS NOT old.es_retencion_islr
        OR new.porcentaje_retencion IS NOT old.porcentaje_retencion
        OR new.comprobante_retencion IS NOT old.comprobante_retencion
        OR new.reglas_json IS NOT old.reglas_json
        OR new.modo IS NOT old.modo
        OR new.estado <> 'ANULADO'
        OR new.motivo_anulacion IS NULL
        OR length(trim(new.motivo_anulacion)) < 5)
      BEGIN SELECT RAISE(ABORT, 'Un pago emitido no se puede modificar; solo anularse con motivo'); END`,
  },
  {
    nombre: "mov_no_cambiar",
    sql: `CREATE TRIGGER IF NOT EXISTS mov_no_cambiar BEFORE UPDATE ON movimientos_stock WHEN old.modo = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Un movimiento de existencias no se modifica: se corrige con otro movimiento.'); END`,
  },
  {
    nombre: "mov_no_borrar",
    sql: `CREATE TRIGGER IF NOT EXISTS mov_no_borrar BEFORE DELETE ON movimientos_stock WHEN old.modo = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Un movimiento de existencias no se borra: se corrige con otro movimiento.'); END`,
  },
  {
    nombre: "compra_no_borrar",
    sql: `CREATE TRIGGER IF NOT EXISTS compra_no_borrar BEFORE DELETE ON compras WHEN old.modo = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Una compra registrada no se borra: se anula.'); END`,
  },
  {
    nombre: "compra_inmutable",
    sql: `CREATE TRIGGER IF NOT EXISTS compra_inmutable BEFORE UPDATE ON compras
      WHEN old.modo = 'REAL' AND (
        old.estado = 'ANULADA'
        OR new.estado NOT IN ('REGISTRADA', 'ANULADA')
        OR new.modo IS NOT old.modo OR new.proveedor_id IS NOT old.proveedor_id OR new.proveedor_rif IS NOT old.proveedor_rif
        OR new.proveedor_nombre IS NOT old.proveedor_nombre OR new.factura_numero IS NOT old.factura_numero OR new.control_numero IS NOT old.control_numero
        OR new.fecha IS NOT old.fecha OR new.subtotal_usd IS NOT old.subtotal_usd OR new.iva_usd IS NOT old.iva_usd OR new.total_usd IS NOT old.total_usd
        OR new.tasa_e8 IS NOT old.tasa_e8 OR new.subtotal_bs IS NOT old.subtotal_bs OR new.iva_bs IS NOT old.iva_bs OR new.total_bs IS NOT old.total_bs
        OR new.nota IS NOT old.nota OR new.renglones_json IS NOT old.renglones_json OR new.registrado_en IS NOT old.registrado_en OR new.registrado_por IS NOT old.registrado_por)
      BEGIN SELECT RAISE(ABORT, 'Compra registrada: solo se puede anular.'); END`,
  },
  {
    nombre: "compra_impuestos_no_cambiar",
    sql: `CREATE TRIGGER IF NOT EXISTS compra_impuestos_no_cambiar BEFORE UPDATE ON compra_impuestos
      WHEN (SELECT modo FROM compras WHERE id = old.compra_id) = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Compra registrada: sus impuestos no se pueden cambiar.'); END`,
  },
  {
    nombre: "compra_impuestos_no_borrar",
    sql: `CREATE TRIGGER IF NOT EXISTS compra_impuestos_no_borrar BEFORE DELETE ON compra_impuestos
      WHEN (SELECT modo FROM compras WHERE id = old.compra_id) = 'REAL'
      BEGIN SELECT RAISE(ABORT, 'Compra registrada: sus impuestos no se pueden borrar.'); END`,
  },
];

type SerieCorrelativo = {
  clave: string;
  etiqueta: string;
  sqlMax: string;
};

const SERIES_CORRELATIVOS: SerieCorrelativo[] = [
  { clave: "FACTURA", etiqueta: "Facturas", sqlMax: `SELECT COALESCE(MAX(numero), 0) AS m FROM documentos WHERE tipo = 'FACTURA' AND es_nota_credito = 0 AND COALESCE(es_nota_debito, 0) = 0 AND modo = ?` },
  { clave: "NOTA_CREDITO", etiqueta: "Notas de Crédito", sqlMax: `SELECT COALESCE(MAX(numero), 0) AS m FROM documentos WHERE tipo = 'FACTURA' AND es_nota_credito = 1 AND modo = ?` },
  { clave: "NOTA_DEBITO", etiqueta: "Notas de Débito", sqlMax: `SELECT COALESCE(MAX(numero), 0) AS m FROM documentos WHERE tipo = 'FACTURA' AND COALESCE(es_nota_debito, 0) = 1 AND modo = ?` },
  { clave: "PRESUPUESTO", etiqueta: "Presupuestos", sqlMax: `SELECT COALESCE(MAX(numero), 0) AS m FROM documentos WHERE tipo = 'PRESUPUESTO' AND modo = ?` },
  { clave: "CONTROL", etiqueta: "Control interno", sqlMax: `SELECT COALESCE(MAX(control_interno), 0) AS m FROM documentos WHERE modo = ?` },
  { clave: "RECIBO", etiqueta: "Recibos de pago", sqlMax: `SELECT COALESCE(MAX(numero), 0) AS m FROM pagos WHERE modo = ?` },
];

async function listarTriggersPresentes(
  rawDb: D1Database,
  dbInq: D1Database,
  codigo: string,
  envObj: Record<string, unknown>
): Promise<Map<string, string>> {
  if (codigo === "principal") {
    const { results } = await rawDb
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name NOT GLOB 't[0-9]*_*' AND name NOT GLOB 'db[0-9]*_*'`)
      .all<{ name: string; sql: string | null }>();
    return new Map(results.map((r) => [r.name, String(r.sql ?? "")]));
  }
  if (tieneBindingDedicado(envObj, codigo)) {
    const { results } = await dbInq.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'`).all<{ name: string; sql: string | null }>();
    return new Map(results.map((r) => [r.name, String(r.sql ?? "")]));
  }
  const prefijo = prefijoTablaDeCodigo(codigo);
  const { results } = await rawDb
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE ?`)
    .bind(`${prefijo}%`)
    .all<{ name: string; sql: string | null }>();
  return new Map(results.map((r) => [r.name.slice(prefijo.length), String(r.sql ?? "")]));
}

function triggerNecesitaReparacion(nombre: string, sqlActual: string | undefined, tieneV34: boolean): boolean {
  if (!sqlActual) return true;
  if (tieneV34) {
    if (nombre === "doc_inmutable" && !sqlActual.includes("es_nota_debito")) return true;
    if (nombre === "pago_inmutable" && (!sqlActual.includes("es_retencion_islr") || !sqlActual.includes("motivo_anulacion"))) return true;
  }
  return false;
}

export async function diagnosticarInquilino(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  info: { codigo: string; tipo_db?: string; nombre_negocio?: string; rif?: string }
): Promise<SaludInquilino> {
  await hidratarBindingsCloudflare(rawDb, envObj);
  const codigo = info.codigo || "principal";
  const dedicado = tieneBindingDedicado(envObj, codigo);
  const tipoDb = info.tipo_db || (codigo === "principal" ? "PRINCIPAL" : /^DB_\d+$/.test(codigo) ? "BINDING" : "PREFIJO");
  const dbInq = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);
  const problemas: ProblemaSalud[] = [];

  // 1) Verificar migraciones aplicadas
  let hechas = new Set<string>();
  try {
    const { results } = await dbInq.prepare(`SELECT id FROM _migraciones`).all<{ id: string }>();
    hechas = new Set(results.map((r) => r.id));
  } catch {
    problemas.push({
      nivel: "CRITICO",
      codigo: "SIN_MIGRACIONES",
      mensaje: "La tabla _migraciones no existe o la bóveda aún no se inicializa.",
      reparable: true,
    });
  }
  const migracionesFaltantes = MIGRACIONES.map((m) => m.id).filter((id) => !hechas.has(id));
  if (migracionesFaltantes.length > 0) {
    problemas.push({
      nivel: "CRITICO",
      codigo: "MIGRACIONES_PENDIENTES",
      mensaje: `Faltan ${migracionesFaltantes.length} migración(es): ${migracionesFaltantes.join(", ")}.`,
      reparable: true,
    });
  }

  // 2) Verificar los 16 triggers de inmutabilidad SENIAT (y vigencia post-0015)
  const triggersPresentes = await listarTriggersPresentes(rawDb, dbInq, codigo, envObj).catch(() => new Map<string, string>());
  const tieneV34 = hechas.has("0015_paquete_v3_4");
  const triggersFaltantes = TRIGGERS_INMUTABILIDAD.map((t) => t.nombre).filter((n) =>
    triggerNecesitaReparacion(n, triggersPresentes.get(n), tieneV34)
  );
  if (triggersFaltantes.length > 0) {
    problemas.push({
      nivel: "CRITICO",
      codigo: "TRIGGERS_FALTANTES",
      mensaje: `Faltan o requieren actualización ${triggersFaltantes.length} candado(s) SQLite de inmutabilidad fiscal (${triggersFaltantes.slice(0, 3).join(", ")}…).`,
      reparable: true,
    });
  }

  // 3) Verificar integridad física SQLite y llaves foráneas
  const dbCheck = dedicado ? dbInq : rawDb;
  let sqliteOk = true;
  try {
    const qc = await dbCheck.prepare(`PRAGMA quick_check`).first<Record<string, unknown>>();
    const val = qc ? Object.values(qc)[0] : "ok";
    if (String(val).toLowerCase() !== "ok") {
      sqliteOk = false;
      problemas.push({
        nivel: "CRITICO",
        codigo: "SQLITE_QUICK_CHECK",
        mensaje: `SQLite reportó anomalía de estructura (${val}). Usa Time Travel en Cloudflare inmediatamente.`,
        reparable: false,
      });
    }
  } catch {
    // En D1 remoto algunas PRAGMAs pueden no estar disponibles; no marcamos falso positivo
  }

  let fkRotas = 0;
  try {
    const fkAll = (await dbCheck.prepare(`PRAGMA foreign_key_check`).all<Record<string, unknown>>()).results;
    const prefijo = prefijoTablaDeCodigo(codigo);
    const propias = fkAll.filter((r) => {
      const tabla = String(r.table ?? "");
      if (codigo === "principal") return !/^(t\d+|db\d+)_/.test(tabla) && !tabla.startsWith("_mt_");
      if (!dedicado && prefijo) return tabla.startsWith(prefijo);
      return true;
    });
    fkRotas = propias.length;
    if (fkRotas > 0) {
      problemas.push({
        nivel: "CRITICO",
        codigo: "FK_ROTAS",
        mensaje: `Se detectaron ${fkRotas} referencia(s) cruzada(s) rota(s) entre tablas.`,
        reparable: false,
      });
    }
  } catch {
    // Ignorar si el entorno no permite PRAGMA foreign_key_check
  }

  // 4) Verificar correlativos y consistencia contable en batch (1 solo subrequest HTTP por BD remota)
  let modo: "PRACTICA" | "REAL" = "PRACTICA";
  let correlativosOk = true;
  let descuadresCentavos = 0;
  const conteo = { clientes: 0, documentos_real: 0, pagos_real: 0, compras_real: 0 };

  if (hechas.has("0004_documentos")) {
    const tienePagos = hechas.has("0005_pagos");
    const tieneExistencias = hechas.has("0006_existencias");
    const tieneNC = hechas.has("0011_igtf_y_notas_credito");
    const tieneND = hechas.has("0015_paquete_v3_4");

    type PasoBatch = { clave: string; stmt: D1PreparedStatement };
    const pasos: PasoBatch[] = [
      { clave: "modo", stmt: dbInq.prepare(`SELECT valor FROM ajustes WHERE clave = 'modo'`) },
      { clave: "clientes", stmt: dbInq.prepare(`SELECT COUNT(*) AS n FROM clientes`) },
      { clave: "docs", stmt: dbInq.prepare(`SELECT COUNT(*) AS n FROM documentos WHERE modo = 'REAL'`) },
      { clave: "contadores", stmt: dbInq.prepare(`SELECT clave, valor FROM contadores`) },
      {
        clave: "descuadre",
        stmt: dbInq.prepare(
          `SELECT COUNT(*) AS n FROM documentos
           WHERE modo = 'REAL' AND estado <> 'BORRADOR'
           AND (COALESCE(subtotal_usd, 0) + COALESCE(iva_usd, 0) + COALESCE(igtf_usd, 0)) <> COALESCE(total_usd, 0)`
        ),
      },
    ];
    if (tienePagos) pasos.push({ clave: "pagos", stmt: dbInq.prepare(`SELECT COUNT(*) AS n FROM pagos WHERE modo = 'REAL'`) });
    if (tieneExistencias) pasos.push({ clave: "compras", stmt: dbInq.prepare(`SELECT COUNT(*) AS n FROM compras WHERE modo = 'REAL'`) });

    for (const mModo of ["PRACTICA", "REAL"] as const) {
      for (const s of SERIES_CORRELATIVOS) {
        if (s.clave === "RECIBO" && !tienePagos) continue;
        if (s.clave === "NOTA_CREDITO" && !tieneNC) continue;
        if (s.clave === "NOTA_DEBITO" && !tieneND) continue;
        pasos.push({ clave: `MAX:${s.clave}:${mModo}`, stmt: dbInq.prepare(s.sqlMax).bind(mModo) });
      }
    }

    const resMap = new Map<string, Record<string, unknown>[]>();
    try {
      const loteRes = await dbInq.batch(pasos.map((p) => p.stmt));
      pasos.forEach((p, idx) => {
        resMap.set(p.clave, (loteRes[idx]?.results ?? []) as Record<string, unknown>[]);
      });
    } catch {
      // Fallback seguro en caso de esquema incompleto
      for (const p of pasos) {
        const r = await p.stmt.all().catch(() => ({ results: [] }));
        resMap.set(p.clave, (r.results ?? []) as Record<string, unknown>[]);
      }
    }

    const modoRow = resMap.get("modo")?.[0];
    modo = modoRow?.valor === "REAL" ? "REAL" : "PRACTICA";
    conteo.clientes = Number(resMap.get("clientes")?.[0]?.n ?? 0);
    conteo.documentos_real = Number(resMap.get("docs")?.[0]?.n ?? 0);
    conteo.pagos_real = Number(resMap.get("pagos")?.[0]?.n ?? 0);
    conteo.compras_real = Number(resMap.get("compras")?.[0]?.n ?? 0);

    const contRows = (resMap.get("contadores") ?? []) as { clave: string; valor: number }[];
    const contMap = new Map(contRows.map((c) => [c.clave, Number(c.valor) || 0]));

    for (const mModo of ["PRACTICA", "REAL"] as const) {
      for (const s of SERIES_CORRELATIVOS) {
        if (s.clave === "RECIBO" && !tienePagos) continue;
        if (s.clave === "NOTA_CREDITO" && !tieneNC) continue;
        if (s.clave === "NOTA_DEBITO" && !tieneND) continue;
        const claveCont = `${s.clave}:${mModo}`;
        const maxEmitido = Number(resMap.get(`MAX:${claveCont}`)?.[0]?.m ?? 0);
        const valCont = contMap.get(claveCont);
        if (valCont === undefined) {
          correlativosOk = false;
          problemas.push({
            nivel: "CRITICO",
            codigo: "CONTADOR_FALTANTE",
            mensaje: `Falta el contador ${claveCont} (máximo emitido: ${maxEmitido}).`,
            reparable: true,
          });
        } else if (valCont < maxEmitido) {
          correlativosOk = false;
          problemas.push({
            nivel: "CRITICO",
            codigo: "CONTADOR_ATRASADO",
            mensaje: `El contador ${claveCont} (${valCont}) está por debajo del máximo emitido (${maxEmitido}): podría chocar al facturar.`,
            reparable: true,
          });
        }
      }
    }

    descuadresCentavos = Number(resMap.get("descuadre")?.[0]?.n ?? 0);
    if (descuadresCentavos > 0) {
      problemas.push({
        nivel: "CRITICO",
        codigo: "DESCUADRE_CENTAVOS",
        mensaje: `${descuadresCentavos} documento(s) en modo REAL tienen diferencia entre subtotal+IVA+IGTF y total.`,
        reparable: false,
      });
    }
  }

  return {
    codigo,
    tipo_db: tipoDb,
    nombre_negocio: info.nombre_negocio || (codigo === "principal" ? "Negocio Principal" : codigo),
    rif: info.rif || "",
    modo,
    sano: problemas.filter((p) => p.nivel === "CRITICO").length === 0,
    migraciones_ok: migracionesFaltantes.length === 0,
    migraciones_faltantes: migracionesFaltantes,
    triggers_ok: triggersFaltantes.length === 0,
    triggers_faltantes: triggersFaltantes,
    sqlite_ok: sqliteOk,
    fk_rotas: fkRotas,
    correlativos_ok: correlativosOk,
    descuadres_centavos: descuadresCentavos,
    conteo,
    problemas,
    reparables: problemas.filter((p) => p.reparable).length,
  };
}

export async function diagnosticarTodoElSistema(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  opts?: { desde?: number; limite?: number; codigo?: string }
) {
  await asegurarTablasMultiTenant(rawDb);
  const { results } = await rawDb
    .prepare(
      `SELECT codigo, tipo_db, nombre_negocio, rif FROM _mt_inquilinos
       ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en ASC`
    )
    .all<{ codigo: string; tipo_db: string; nombre_negocio: string; rif: string }>();

  const negociosTodos = results.length ? results : [{ codigo: "principal", tipo_db: "PRINCIPAL", nombre_negocio: "Negocio Principal", rif: "" }];
  let seleccion = negociosTodos;
  let desde = 0;
  let limite = negociosTodos.length;

  if (opts?.codigo) {
    seleccion = negociosTodos.filter((n) => n.codigo === opts.codigo);
    limite = Math.max(1, seleccion.length);
  } else if (opts?.desde !== undefined || opts?.limite !== undefined || negociosTodos.length > 10) {
    desde = Math.max(0, Number(opts?.desde ?? 0) || 0);
    limite = Math.max(1, Math.min(20, Number(opts?.limite ?? 8) || 8));
    seleccion = negociosTodos.slice(desde, desde + limite);
  }

  const reportes: SaludInquilino[] = [];
  for (const inq of seleccion) {
    reportes.push(await diagnosticarInquilino(rawDb, envObj, inq));
  }

  // Verificar huérfanos en el directorio maestro multi-tenant
  const dirHuerfanos = (
    await rawDb
      .prepare(`SELECT COUNT(*) AS n FROM _mt_directorio WHERE inquilino_codigo NOT IN (SELECT codigo FROM _mt_inquilinos)`)
      .first<{ n: number }>()
      .catch(() => null)
  )?.n ?? 0;

  return {
    verificado_en: new Date().toISOString(),
    sano_global: reportes.every((r) => r.sano) && dirHuerfanos === 0,
    directorio_huerfanos: dirHuerfanos,
    total_empresas: negociosTodos.length,
    auditadas_en_lote: reportes.length,
    desde,
    limite,
    hay_mas: !opts?.codigo && desde + seleccion.length < negociosTodos.length,
    reportes,
  };
}

// Reparación quirúrgica NO DESTRUCTIVA: aplica migraciones faltantes, restaura triggers de inmutabilidad SENIAT y adelanta contadores atrasados al MAX emitido.
export async function repararInquilino(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  codigo: string,
  usuarioId?: number,
  c?: Ctx
) {
  await asegurarTablasMultiTenant(rawDb);
  await hidratarBindingsCloudflare(rawDb, envObj);
  const info = await rawDb
    .prepare(`SELECT codigo, tipo_db, nombre_negocio, rif FROM _mt_inquilinos WHERE codigo = ?`)
    .bind(codigo)
    .first<{ codigo: string; tipo_db: string; nombre_negocio: string; rif: string }>();

  if (!info && codigo !== "principal") {
    throw new Error("Inquilino no encontrado.");
  }

  const dbInq = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);
  const acciones: string[] = [];

  // 1) Migraciones pendientes (solo agrega faltantes, sin tocar filas existentes)
  const antesMig = new Set(
    ((await dbInq.prepare(`SELECT id FROM _migraciones`).all<{ id: string }>().catch(() => ({ results: [] }))).results ?? []).map((r) => r.id)
  );
  await migrar(dbInq);
  const despuesMig = new Set(
    ((await dbInq.prepare(`SELECT id FROM _migraciones`).all<{ id: string }>().catch(() => ({ results: [] }))).results ?? []).map((r) => r.id)
  );
  const aplicadas = [...despuesMig].filter((id) => !antesMig.has(id));
  if (aplicadas.length) acciones.push(`Migraciones aplicadas: ${aplicadas.join(", ")}`);

  // 2) Reponer o actualizar triggers de inmutabilidad SENIAT faltantes/desactualizados (sin modificar filas)
  const tipoDb = info?.tipo_db || (codigo === "principal" ? "PRINCIPAL" : /^DB_\d+$/.test(codigo) ? "BINDING" : "PREFIJO");
  const presentes = await listarTriggersPresentes(rawDb, dbInq, codigo, envObj);
  const tieneV34 = despuesMig.has("0015_paquete_v3_4");
  const triggersAReparar = TRIGGERS_INMUTABILIDAD.filter((t) => triggerNecesitaReparacion(t.nombre, presentes.get(t.nombre), tieneV34));
  if (triggersAReparar.length) {
    const pasosTriggers: D1PreparedStatement[] = [];
    for (const t of triggersAReparar) {
      pasosTriggers.push(dbInq.prepare(`DROP TRIGGER IF EXISTS ${t.nombre}`));
      pasosTriggers.push(dbInq.prepare(t.sql));
    }
    await dbInq.batch(pasosTriggers);
    acciones.push(`Triggers restaurados: ${triggersAReparar.map((t) => t.nombre).join(", ")}`);
  }

  // 3) Sincronizar contadores atrasados o faltantes con el máximo real emitido (nunca retrocede)
  const contRows = (await dbInq.prepare(`SELECT clave, valor FROM contadores`).all<{ clave: string; valor: number }>().catch(() => ({ results: [] }))).results;
  const contMap = new Map(contRows.map((x) => [x.clave, Number(x.valor) || 0]));
  const pasosCont: D1PreparedStatement[] = [];
  for (const mModo of ["PRACTICA", "REAL"] as const) {
    for (const s of SERIES_CORRELATIVOS) {
      const claveCont = `${s.clave}:${mModo}`;
      const maxEmitido = (await dbInq.prepare(s.sqlMax).bind(mModo).first<{ m: number }>().catch(() => null))?.m ?? 0;
      const actual = contMap.get(claveCont);
      if (actual === undefined || actual < maxEmitido) {
        pasosCont.push(
          dbInq
            .prepare(`INSERT INTO contadores (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = MAX(valor, excluded.valor)`)
            .bind(claveCont, maxEmitido)
        );
        acciones.push(`Contador ${claveCont} sincronizado (${actual ?? "faltante"} -> ${maxEmitido})`);
      }
    }
  }
  if (pasosCont.length) await dbInq.batch(pasosCont);

  // 4) Limpiar huérfanos en el directorio multi-tenant
  const delHuerf = await rawDb
    .prepare(`DELETE FROM _mt_directorio WHERE inquilino_codigo NOT IN (SELECT codigo FROM _mt_inquilinos)`)
    .run()
    .catch(() => ({ meta: { changes: 0 } }));
  if ((delHuerf.meta?.changes ?? 0) > 0) {
    acciones.push(`Limpiados ${delHuerf.meta.changes} registro(s) huérfano(s) del directorio`);
  }

  if (c && usuarioId) {
    await auditar(c, usuarioId, "SALUD_REPARAR_BD", `${codigo}: ${acciones.length ? acciones.join(" | ") : "sin cambios necesarios"}`);
  }

  const diagnostico = await diagnosticarInquilino(rawDb, envObj, info ?? { codigo, tipo_db: tipoDb, nombre_negocio: codigo, rif: "" });
  return { acciones, diagnostico };
}

const TABLAS_EXPORTAR = [
  "ajustes", "auditoria", "catalogo", "clientes", "compra_impuestos", "compras",
  "contadores", "documento_impuestos", "documento_renglones", "documentos", "emisor_logos",
  "medio_historial", "metodos_cobro", "movimientos_stock", "pagos", "perfil_emisor", "proveedores",
];

const huellaHex = async (t: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export async function obtenerFirmaCoberturaReal(db: D1Database): Promise<{ n: number; max_id: number; firma: string }> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max_id FROM documentos WHERE modo = 'REAL' AND estado <> 'BORRADOR'`)
    .first<{ n: number; max_id: number }>()
    .catch(() => null);
  const n = Number(row?.n ?? 0) || 0;
  const max_id = Number(row?.max_id ?? 0) || 0;
  return { n, max_id, firma: `${n}:${max_id}` };
}

export async function generarRespaldoNegocio(db: D1Database, opts?: { anio?: number; env?: Record<string, unknown> }) {
  await asegurarLlavePlataforma(db, opts?.env);
  const datos: Record<string, Record<string, unknown>[]> = {};
  const nombres = [...TABLAS_EXPORTAR, "usuarios"];
  const anioStr = opts?.anio && opts.anio >= 2000 && opts.anio <= 2100 ? String(opts.anio) : null;

  const armarStmtTabla = (name: string) => {
    if (!anioStr) return db.prepare(`SELECT * FROM ${name}`);
    switch (name) {
      case "documentos":
        return db.prepare(`SELECT * FROM documentos WHERE substr(COALESCE(fecha_emision, creado_en), 1, 4) = ?`).bind(anioStr);
      case "documento_renglones":
        return db.prepare(`SELECT * FROM documento_renglones WHERE documento_id IN (SELECT id FROM documentos WHERE substr(COALESCE(fecha_emision, creado_en), 1, 4) = ?)`).bind(anioStr);
      case "documento_impuestos":
        return db.prepare(`SELECT * FROM documento_impuestos WHERE documento_id IN (SELECT id FROM documentos WHERE substr(COALESCE(fecha_emision, creado_en), 1, 4) = ?)`).bind(anioStr);
      case "pagos":
        return db.prepare(`SELECT * FROM pagos WHERE substr(COALESCE(fecha_pago, creado_en), 1, 4) = ?`).bind(anioStr);
      case "compras":
        return db.prepare(`SELECT * FROM compras WHERE substr(COALESCE(fecha_factura, creado_en), 1, 4) = ?`).bind(anioStr);
      case "compra_impuestos":
        return db.prepare(`SELECT * FROM compra_impuestos WHERE compra_id IN (SELECT id FROM compras WHERE substr(COALESCE(fecha_factura, creado_en), 1, 4) = ?)`).bind(anioStr);
      case "movimientos_stock":
        return db.prepare(`SELECT * FROM movimientos_stock WHERE substr(COALESCE(fecha, creado_en), 1, 4) = ?`).bind(anioStr);
      case "auditoria":
        return db.prepare(`SELECT * FROM auditoria WHERE substr(creado_en, 1, 4) = ?`).bind(anioStr);
      default:
        return db.prepare(`SELECT * FROM ${name}`);
    }
  };

  try {
    const stmts = [
      ...TABLAS_EXPORTAR.map((name) => armarStmtTabla(name)),
      db.prepare(`SELECT id, nombre, email, rol, activo, creado_en FROM usuarios`),
    ];
    const lote = await db.batch(stmts);
    nombres.forEach((n, idx) => {
      datos[n] = (lote[idx]?.results ?? []) as Record<string, unknown>[];
    });
  } catch {
    for (const name of TABLAS_EXPORTAR) {
      datos[name] = (await armarStmtTabla(name).all().catch(() => ({ results: [] }))).results;
    }
    datos.usuarios = (await db.prepare(`SELECT id, nombre, email, rol, activo, creado_en FROM usuarios`).all()).results;
  }
  const conteos = Object.fromEntries(Object.entries(datos).map(([t, f]) => [t, f.length]));
  const huella = await huellaHex(JSON.stringify(datos));
  const modo_origen = await modoActual(db);
  const sumas = calcularSumas(datos);
  const cobertura_real = await obtenerFirmaCoberturaReal(db);
  const firma_hmac = await firmarHmacRespaldo(modo_origen, conteos, sumas, opts?.env, huella);
  return {
    formato: "respaldo-facturacion",
    version: 2,
    generado_en: new Date().toISOString(),
    ...(anioStr ? { anio_filtro: Number(anioStr) } : {}),
    huella,
    firma_hmac,
    modo_origen,
    cobertura_real,
    conteos,
    sumas,
    datos,
  };
}

export async function generarRespaldoMaestro(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  opts?: { desde?: number; limite?: number; codigo?: string; anio?: number }
) {
  await asegurarLlavePlataforma(rawDb, envObj);
  await asegurarTablasMultiTenant(rawDb);
  await hidratarBindingsCloudflare(rawDb, envObj);
  const mtInq = (await rawDb.prepare(`SELECT * FROM _mt_inquilinos ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en ASC`).all()).results;
  const mtDir = (await rawDb.prepare(`SELECT * FROM _mt_directorio ORDER BY email ASC`).all()).results;
  const negocios: Record<string, Awaited<ReturnType<typeof generarRespaldoNegocio>>> = {};

  const todosCodigos = mtInq.length ? mtInq.map((r) => String(r.codigo)) : ["principal"];
  let codigos = todosCodigos;
  let desde = 0;
  let limite = todosCodigos.length;
  if (opts?.codigo) {
    codigos = todosCodigos.filter((c) => c === opts.codigo);
    limite = Math.max(1, codigos.length);
  } else if (opts?.desde !== undefined || opts?.limite !== undefined || todosCodigos.length > 25) {
    desde = Math.max(0, Number(opts?.desde ?? 0) || 0);
    limite = Math.max(1, Math.min(25, Number(opts?.limite ?? 25) || 25));
    codigos = todosCodigos.slice(desde, desde + limite);
  }

  for (const cod of codigos) {
    const dbInq = obtenerDbInquilino({ ...envObj, DB: rawDb }, cod);
    await migrar(dbInq);
    negocios[cod] = await generarRespaldoNegocio(dbInq, { ...(opts?.anio ? { anio: opts.anio } : {}), env: envObj });
  }

  const payload = {
    maestro: { _mt_inquilinos: mtInq, _mt_directorio: mtDir },
    negocios,
  };
  const huella = await huellaHex(JSON.stringify(payload));
  const firma_hmac = await firmarHmacRespaldo("REAL", { empresas: codigos.length }, {}, envObj, huella);

  return {
    formato: "respaldo-maestro-facturaya",
    version: 1,
    generado_en: new Date().toISOString(),
    ...(opts?.anio ? { anio_filtro: opts.anio } : {}),
    total_empresas: todosCodigos.length,
    empresas_en_archivo: codigos.length,
    desde,
    limite,
    hay_mas: !opts?.codigo && desde + codigos.length < todosCodigos.length,
    huella,
    firma_hmac,
    ...payload,
  };
}

