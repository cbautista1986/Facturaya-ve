// Cambios de la base de datos. Regla de oro: para cambiar algo, AGREGA una migración nueva al final;
// nunca edites las anteriores. Se aplican solas, una sola vez, en orden (no hace falta consola).
type Migracion = { id: string; sql: string[]; antes?: (db: D1Database) => Promise<void> };

// El catálogo viejo estaba vacío y guardaba el dinero como decimales. Si por algún motivo tuviera datos, NO se recrea.
async function protegerCatalogoViejo(db: D1Database) {
  const existe = await db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'catalogo'`).first();
  if (!existe) return;
  const fila = await db.prepare(`SELECT COUNT(*) AS n FROM catalogo`).first<{ n: number }>();
  if (fila && fila.n > 0) throw new Error("El catálogo viejo tiene datos: no se recrea automáticamente.");
}

// Las tablas viejas de documentos (de Gemini) estaban vacías y guardaban dinero como decimales. Si tuvieran datos, NO se recrean.
async function protegerDocumentosViejos(db: D1Database) {
  for (const t of ["documentos", "documento_renglones", "documento_pagos"]) {
    const existe = await db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(t).first();
    if (!existe) continue;
    const fila = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
    if (fila && fila.n > 0) throw new Error(`La tabla vieja ${t} tiene datos: no se recrea automáticamente.`);
  }
}

// El instalador viejo (Gemini) dejó una tabla "compras" con otra forma. NO se borra: se aparta como "compras_vieja" (con sus datos, si los hubiera)
// para poder crear la tabla nueva sin perder nada.
async function apartarComprasViejas(db: D1Database) {
  const t = await db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'compras'`).first<{ sql: string }>();
  if (t && t.sql.includes("num_factura_compra")) await db.prepare(`ALTER TABLE compras RENAME TO compras_vieja`).run();
}

export const MIGRACIONES: Migracion[] = [
  {
    id: "0001_base",
    sql: [
      `CREATE TABLE IF NOT EXISTS perfil_emisor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        instalado INTEGER NOT NULL DEFAULT 0,
        especialidad TEXT NOT NULL DEFAULT 'SERVICIOS_EQUIPOS',
        nombre_razon_social TEXT NOT NULL,
        rif TEXT NOT NULL,
        direccion_fiscal TEXT NOT NULL,
        telefono TEXT, email TEXT, logo_base64 TEXT,
        tasa_bcv REAL NOT NULL DEFAULT 0,
        datos_pago_movil TEXT, datos_zelle TEXT, datos_binance TEXT, datos_paypal TEXT, datos_transferencia TEXT,
        prox_presupuesto INTEGER NOT NULL DEFAULT 1,
        prox_factura INTEGER NOT NULL DEFAULT 1,
        prox_nota_credito INTEGER NOT NULL DEFAULT 1)`,
      `CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        rol TEXT NOT NULL DEFAULT 'ADMIN',
        creado_en TEXT DEFAULT (datetime('now')))`,
      `CREATE TABLE IF NOT EXISTS sesiones (
        token_hash TEXT PRIMARY KEY,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        expira_en INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS intentos_login (
        clave TEXT PRIMARY KEY,
        fallos INTEGER NOT NULL DEFAULT 0,
        bloqueado_hasta INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER, accion TEXT NOT NULL, detalle TEXT, ip TEXT,
        creado_en TEXT NOT NULL DEFAULT (datetime('now')))`,
    ],
  },
  {
    id: "0002_fecha_tasa_bcv",
    sql: [`ALTER TABLE perfil_emisor ADD COLUMN tasa_bcv_fecha TEXT`],
  },
  {
    id: "0003_clientes_catalogo",
    antes: protegerCatalogoViejo,
    sql: [
      `CREATE TABLE IF NOT EXISTS clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rif_cedula TEXT NOT NULL UNIQUE,
        nombre_apellido TEXT NOT NULL,
        direccion TEXT, whatsapp TEXT, email TEXT,
        creado_en TEXT DEFAULT (datetime('now')))`,
      `DROP TABLE IF EXISTS catalogo`,
      // Dinero en centavos de USD (enteros). precio_centavos NULL = "se define al facturar" (solo servicios).
      `CREATE TABLE catalogo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'SERVICIO' CHECK (tipo IN ('SERVICIO', 'PRODUCTO')),
        costo_centavos INTEGER CHECK (costo_centavos IS NULL OR costo_centavos >= 0),
        precio_centavos INTEGER CHECK (precio_centavos IS NULL OR precio_centavos >= 0),
        alicuota_iva INTEGER NOT NULL DEFAULT 16 CHECK (alicuota_iva IN (0, 8, 16)),
        activo INTEGER NOT NULL DEFAULT 1)`,
      `CREATE UNIQUE INDEX idx_catalogo_codigo ON catalogo(codigo) WHERE codigo IS NOT NULL`,
    ],
  },
  {
    id: "0004_documentos",
    antes: protegerDocumentosViejos,
    sql: [
      `DROP TABLE IF EXISTS documento_pagos`,
      `DROP TABLE IF EXISTS documento_renglones`,
      `DROP TABLE IF EXISTS documentos`,
      // Modo de trabajo: PRACTICA (documentos de prueba) o REAL. Se sale de práctica una sola vez.
      `CREATE TABLE ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)`,
      `INSERT INTO ajustes (clave, valor) VALUES ('modo', 'PRACTICA')`,
      // Correlativos: se suman dentro de la misma transacción que emite el documento (sin saltos ni repetidos).
      `CREATE TABLE contadores (clave TEXT PRIMARY KEY, valor INTEGER NOT NULL DEFAULT 0)`,
      `INSERT INTO contadores (clave) VALUES ('FACTURA:PRACTICA'), ('PRESUPUESTO:PRACTICA'), ('CONTROL:PRACTICA'),
        ('FACTURA:REAL'), ('PRESUPUESTO:REAL'), ('CONTROL:REAL')`,
      // Reglas fiscales como DATOS con fecha de vigencia: si la ley cambia, se agrega una fila (no se toca el código ni el historial).
      `CREATE TABLE parametros_fiscales (clave TEXT NOT NULL, vigente_desde TEXT NOT NULL, valor TEXT NOT NULL, nota TEXT,
        PRIMARY KEY (clave, vigente_desde))`,
      `INSERT INTO parametros_fiscales (clave, vigente_desde, valor, nota) VALUES
        ('iva_alicuotas_cent', '2000-01-01', '0,800,1600', 'Alícuotas de IVA permitidas (% x 100): exento, 8% y 16%'),
        ('titulo_sin_control', '2000-01-01', 'FACTURA', 'Título del PDF mientras no exista N.º de control fiscal (decisión del dueño)'),
        ('leyenda_sin_control', '2000-01-01', 'DOCUMENTO SIN NÚMERO DE CONTROL FISCAL (pendiente de imprenta digital autorizada)', 'Aviso visible en el PDF'),
        ('leyenda_cambio', '2000-01-01', 'Montos expresados en bolívares (Bs.) con su equivalente en dólares (USD) a la tasa de cambio BCV vigente a la fecha de emisión.', 'Confirmar texto con el contador'),
        ('validez_presupuesto_dias', '2000-01-01', '15', 'Días de validez de un presupuesto'),
        ('plantilla_version', '2000-01-01', '1', 'Versión de la plantilla del PDF'),
        ('max_renglones', '2000-01-01', '30', 'Máximo de renglones por documento (cuida el límite de consultas del plan gratis de Cloudflare)')`,
      `CREATE TABLE documentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL CHECK (tipo IN ('PRESUPUESTO', 'FACTURA')),
        estado TEXT NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN ('BORRADOR', 'EMITIDO', 'FACTURADO', 'ANULADO')),
        modo TEXT NOT NULL CHECK (modo IN ('PRACTICA', 'REAL')),
        numero INTEGER, control_interno INTEGER, control_fiscal TEXT,
        presupuesto_id INTEGER REFERENCES documentos(id),
        cliente_id INTEGER REFERENCES clientes(id),
        cliente_rif TEXT, cliente_nombre TEXT, cliente_direccion TEXT, cliente_whatsapp TEXT, cliente_email TEXT,
        nota TEXT,
        fecha_emision TEXT, emitido_en TEXT,
        tasa_e8 INTEGER, tasa_cargada_en TEXT,
        subtotal_usd INTEGER, iva_usd INTEGER, total_usd INTEGER,
        subtotal_bs INTEGER, iva_bs INTEGER, total_bs INTEGER,
        costo_total_usd INTEGER,
        parametros_json TEXT, emisor_json TEXT,
        anulado_en TEXT, anulado_por INTEGER, motivo_anulacion TEXT,
        creado_en TEXT NOT NULL DEFAULT (datetime('now')), creado_por INTEGER)`,
      `CREATE UNIQUE INDEX idx_doc_numero ON documentos(tipo, modo, numero) WHERE numero IS NOT NULL`,
      `CREATE UNIQUE INDEX idx_doc_control ON documentos(modo, control_interno) WHERE control_interno IS NOT NULL`,
      `CREATE TABLE documento_renglones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        documento_id INTEGER NOT NULL REFERENCES documentos(id),
        orden INTEGER NOT NULL,
        catalogo_id INTEGER REFERENCES catalogo(id),
        tipo TEXT NOT NULL CHECK (tipo IN ('SERVICIO', 'PRODUCTO')),
        descripcion TEXT NOT NULL,
        cantidad_milli INTEGER NOT NULL CHECK (cantidad_milli > 0),
        precio_usd INTEGER NOT NULL CHECK (precio_usd >= 0),
        costo_usd INTEGER,
        alicuota_cent INTEGER NOT NULL,
        monto_usd INTEGER NOT NULL,
        monto_bs INTEGER)`,
      `CREATE TABLE documento_impuestos (
        documento_id INTEGER NOT NULL REFERENCES documentos(id),
        alicuota_cent INTEGER NOT NULL,
        base_usd INTEGER NOT NULL, iva_usd INTEGER NOT NULL, base_bs INTEGER NOT NULL, iva_bs INTEGER NOT NULL,
        PRIMARY KEY (documento_id, alicuota_cent))`,
      // ---- Protecciones DENTRO de la base de datos (valen aunque la aplicación tenga un error). Solo documentos REALES.
      `CREATE TRIGGER doc_no_borrar BEFORE DELETE ON documentos
        WHEN old.modo = 'REAL' AND old.estado <> 'BORRADOR'
        BEGIN SELECT RAISE(ABORT, 'Documento emitido: no se puede borrar, solo anular.'); END`,
      `CREATE TRIGGER doc_inmutable BEFORE UPDATE ON documentos
        WHEN old.modo = 'REAL' AND old.estado <> 'BORRADOR' AND (
          old.estado = 'ANULADO'
          OR new.estado NOT IN ('EMITIDO', 'FACTURADO', 'ANULADO')
          OR (old.estado = 'FACTURADO' AND new.estado <> 'FACTURADO')
          OR new.tipo IS NOT old.tipo
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
  OR new.total_usd IS NOT old.total_usd
  OR new.subtotal_bs IS NOT old.subtotal_bs
  OR new.iva_bs IS NOT old.iva_bs
  OR new.total_bs IS NOT old.total_bs
  OR new.costo_total_usd IS NOT old.costo_total_usd
  OR new.parametros_json IS NOT old.parametros_json
  OR new.emisor_json IS NOT old.emisor_json
  OR new.creado_en IS NOT old.creado_en
  OR new.creado_por IS NOT old.creado_por)
        BEGIN SELECT RAISE(ABORT, 'Documento emitido: no se puede modificar, solo anular.'); END`,
      `CREATE TRIGGER documento_renglones_insert_emitido BEFORE INSERT ON documento_renglones
        WHEN (SELECT estado FROM documentos WHERE id = new.documento_id) <> 'BORRADOR'
         AND (SELECT modo FROM documentos WHERE id = new.documento_id) = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
      `CREATE TRIGGER documento_renglones_update_emitido BEFORE UPDATE ON documento_renglones
        WHEN (SELECT estado FROM documentos WHERE id = old.documento_id) <> 'BORRADOR'
         AND (SELECT modo FROM documentos WHERE id = old.documento_id) = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
      `CREATE TRIGGER documento_renglones_delete_emitido BEFORE DELETE ON documento_renglones
        WHEN (SELECT estado FROM documentos WHERE id = old.documento_id) <> 'BORRADOR'
         AND (SELECT modo FROM documentos WHERE id = old.documento_id) = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
      `CREATE TRIGGER documento_impuestos_insert_emitido BEFORE INSERT ON documento_impuestos
        WHEN (SELECT estado FROM documentos WHERE id = new.documento_id) <> 'BORRADOR'
         AND (SELECT modo FROM documentos WHERE id = new.documento_id) = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
      `CREATE TRIGGER documento_impuestos_update_emitido BEFORE UPDATE ON documento_impuestos
        WHEN (SELECT estado FROM documentos WHERE id = old.documento_id) <> 'BORRADOR'
         AND (SELECT modo FROM documentos WHERE id = old.documento_id) = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
      `CREATE TRIGGER documento_impuestos_delete_emitido BEFORE DELETE ON documento_impuestos
        WHEN (SELECT estado FROM documentos WHERE id = old.documento_id) <> 'BORRADOR'
         AND (SELECT modo FROM documentos WHERE id = old.documento_id) = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Documento emitido: sus renglones no se pueden cambiar.'); END`,
    ],
  },
  {
    id: "0005_pagos",
    sql: [
      // Condición de pago: se fija al emitir la factura (contado o crédito con días de plazo).
      `ALTER TABLE documentos ADD COLUMN condicion TEXT NOT NULL DEFAULT 'CONTADO' CHECK (condicion IN ('CONTADO', 'CREDITO'))`,
      `ALTER TABLE documentos ADD COLUMN dias_credito INTEGER`,
      `ALTER TABLE documentos ADD COLUMN vence_el TEXT`,
      `DROP TRIGGER doc_inmutable`,
      // Las facturas ya emitidas (Fase 3) reciben vencimiento = su fecha de emisión (se hace con la protección apagada, antes de recrearla).
      `UPDATE documentos SET vence_el = fecha_emision WHERE tipo = 'FACTURA' AND estado <> 'BORRADOR' AND vence_el IS NULL`,
      `CREATE TRIGGER doc_inmutable BEFORE UPDATE ON documentos
        WHEN old.modo = 'REAL' AND old.estado <> 'BORRADOR' AND (
          old.estado = 'ANULADO'
          OR new.estado NOT IN ('EMITIDO', 'FACTURADO', 'ANULADO')
          OR (old.estado = 'FACTURADO' AND new.estado <> 'FACTURADO')
          OR new.tipo IS NOT old.tipo
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
          OR new.total_usd IS NOT old.total_usd
          OR new.subtotal_bs IS NOT old.subtotal_bs
          OR new.iva_bs IS NOT old.iva_bs
          OR new.total_bs IS NOT old.total_bs
          OR new.costo_total_usd IS NOT old.costo_total_usd
          OR new.parametros_json IS NOT old.parametros_json
          OR new.emisor_json IS NOT old.emisor_json
          OR new.creado_en IS NOT old.creado_en
          OR new.creado_por IS NOT old.creado_por
          OR new.condicion IS NOT old.condicion
          OR new.dias_credito IS NOT old.dias_credito
          OR new.vence_el IS NOT old.vence_el)
        BEGIN SELECT RAISE(ABORT, 'Documento emitido: no se puede modificar, solo anular.'); END`,
      // Pagos: el saldo NO se guarda, se calcula (total - pagos vigentes), así nunca puede quedar desfasado.
      `CREATE TABLE pagos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        documento_id INTEGER NOT NULL REFERENCES documentos(id),
        modo TEXT NOT NULL CHECK (modo IN ('PRACTICA', 'REAL')),
        numero INTEGER,
        metodo TEXT NOT NULL CHECK (metodo IN ('PAGO_MOVIL', 'TRANSFERENCIA', 'EFECTIVO', 'ZELLE', 'BINANCE', 'PAYPAL', 'OTRO')),
        moneda TEXT NOT NULL CHECK (moneda IN ('USD', 'BS')),
        monto_recibido INTEGER NOT NULL CHECK (monto_recibido > 0),
        tasa_e8 INTEGER,
        monto_usd INTEGER NOT NULL CHECK (monto_usd > 0),
        saldo_despues_usd INTEGER NOT NULL,
        referencia TEXT, nota TEXT,
        fecha_pago TEXT NOT NULL,
        registrado_en TEXT NOT NULL, registrado_por INTEGER,
        reglas_json TEXT,
        estado TEXT NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE', 'ANULADO')),
        anulado_en TEXT, anulado_por INTEGER, motivo_anulacion TEXT)`,
      `CREATE UNIQUE INDEX idx_pago_numero ON pagos(modo, numero) WHERE numero IS NOT NULL`,
      `CREATE INDEX idx_pago_documento ON pagos(documento_id)`,
      `CREATE TRIGGER pago_no_borrar BEFORE DELETE ON pagos WHEN old.modo = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Un pago registrado no se borra: se anula.'); END`,
      `CREATE TRIGGER pago_inmutable BEFORE UPDATE ON pagos
        WHEN old.modo = 'REAL' AND (
          old.estado = 'ANULADO'
          OR new.estado NOT IN ('VIGENTE', 'ANULADO')
          OR new.documento_id IS NOT old.documento_id
          OR new.modo IS NOT old.modo
          OR new.numero IS NOT old.numero
          OR new.metodo IS NOT old.metodo
          OR new.moneda IS NOT old.moneda
          OR new.monto_recibido IS NOT old.monto_recibido
          OR new.tasa_e8 IS NOT old.tasa_e8
          OR new.monto_usd IS NOT old.monto_usd
          OR new.saldo_despues_usd IS NOT old.saldo_despues_usd
          OR new.referencia IS NOT old.referencia
          OR new.nota IS NOT old.nota
          OR new.fecha_pago IS NOT old.fecha_pago
          OR new.registrado_en IS NOT old.registrado_en
          OR new.registrado_por IS NOT old.registrado_por
          OR new.reglas_json IS NOT old.reglas_json)
        BEGIN SELECT RAISE(ABORT, 'Pago registrado: solo se puede anular.'); END`,
      `INSERT INTO contadores (clave) VALUES ('RECIBO:PRACTICA'), ('RECIBO:REAL')`,
      `INSERT INTO parametros_fiscales (clave, vigente_desde, valor, nota) VALUES
        ('leyenda_recibo', '2000-01-01', 'Recibo de pago: comprobante interno de cobro, sin valor fiscal.', 'Texto del recibo en PDF')`,
      // Datos de cobro con campos fijos por método (antes eran texto libre en Ajustes).
      `CREATE TABLE metodos_cobro (metodo TEXT PRIMARY KEY, activo INTEGER NOT NULL DEFAULT 0, datos_json TEXT NOT NULL DEFAULT '{}')`,
      `INSERT INTO metodos_cobro (metodo) VALUES ('PAGO_MOVIL'), ('TRANSFERENCIA'), ('ZELLE'), ('BINANCE'), ('PAYPAL'), ('EFECTIVO')`,
      // Lo que ya habías escrito en Ajustes se conserva como nota del método.
      `UPDATE metodos_cobro SET activo = 1, datos_json = json_object('nota', (SELECT datos_pago_movil FROM perfil_emisor WHERE id = 1))
        WHERE metodo = 'PAGO_MOVIL' AND (SELECT COALESCE(datos_pago_movil, '') FROM perfil_emisor WHERE id = 1) <> ''`,
      // Lo que ya habías escrito en Ajustes se conserva como nota del método.
      `UPDATE metodos_cobro SET activo = 1, datos_json = json_object('nota', (SELECT datos_transferencia FROM perfil_emisor WHERE id = 1))
        WHERE metodo = 'TRANSFERENCIA' AND (SELECT COALESCE(datos_transferencia, '') FROM perfil_emisor WHERE id = 1) <> ''`,
      // Lo que ya habías escrito en Ajustes se conserva como nota del método.
      `UPDATE metodos_cobro SET activo = 1, datos_json = json_object('nota', (SELECT datos_zelle FROM perfil_emisor WHERE id = 1))
        WHERE metodo = 'ZELLE' AND (SELECT COALESCE(datos_zelle, '') FROM perfil_emisor WHERE id = 1) <> ''`,
      // Lo que ya habías escrito en Ajustes se conserva como nota del método.
      `UPDATE metodos_cobro SET activo = 1, datos_json = json_object('nota', (SELECT datos_binance FROM perfil_emisor WHERE id = 1))
        WHERE metodo = 'BINANCE' AND (SELECT COALESCE(datos_binance, '') FROM perfil_emisor WHERE id = 1) <> ''`,
      // Lo que ya habías escrito en Ajustes se conserva como nota del método.
      `UPDATE metodos_cobro SET activo = 1, datos_json = json_object('nota', (SELECT datos_paypal FROM perfil_emisor WHERE id = 1))
        WHERE metodo = 'PAYPAL' AND (SELECT COALESCE(datos_paypal, '') FROM perfil_emisor WHERE id = 1) <> ''`,
    ],
  },
  {
    id: "0006_existencias",
    antes: apartarComprasViejas,
    sql: [
      // Control de existencias por producto. Los productos que ya tienes quedan SIN control (nada de lo que vendes hoy se bloquea)
      // hasta que cargues su cantidad; al registrar una compra o una carga, el producto pasa a controlarse.
      `ALTER TABLE catalogo ADD COLUMN controla_stock INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE catalogo ADD COLUMN stock_minimo_milli INTEGER`,
      // Truco de seguridad: insertar aquí una fila con ok = 0 falla a propósito y deshace TODO el lote (todo o nada).
      `CREATE TABLE verificaciones (ok INTEGER NOT NULL CHECK (ok = 1))`,
      `CREATE TABLE proveedores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rif TEXT NOT NULL UNIQUE,
        nombre TEXT NOT NULL,
        direccion TEXT, whatsapp TEXT, email TEXT,
        creado_en TEXT DEFAULT (datetime('now')))`,
      // Factura de compra del proveedor. Los renglones quedan dentro de la compra (renglones_json) y no se pueden cambiar.
      `CREATE TABLE compras (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        modo TEXT NOT NULL CHECK (modo IN ('PRACTICA', 'REAL')),
        proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
        proveedor_rif TEXT NOT NULL, proveedor_nombre TEXT NOT NULL,
        factura_numero TEXT NOT NULL, control_numero TEXT,
        fecha TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'REGISTRADA' CHECK (estado IN ('REGISTRADA', 'ANULADA')),
        subtotal_usd INTEGER NOT NULL, iva_usd INTEGER NOT NULL, total_usd INTEGER NOT NULL,
        nota TEXT, renglones_json TEXT NOT NULL,
        registrado_en TEXT NOT NULL, registrado_por INTEGER,
        anulado_en TEXT, anulado_por INTEGER, motivo_anulacion TEXT)`,
      `CREATE UNIQUE INDEX idx_compra_factura ON compras(proveedor_id, factura_numero) WHERE estado = 'REGISTRADA'`,
      // Libro de existencias: cada entrada o salida es un movimiento que NUNCA se edita ni se borra (se corrige con otro).
      // Existencias = suma de cantidades; valor = suma de valores; costo promedio = valor / existencias.
      `CREATE TABLE movimientos_stock (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER NOT NULL REFERENCES catalogo(id),
        modo TEXT NOT NULL CHECK (modo IN ('PRACTICA', 'REAL')),
        tipo TEXT NOT NULL CHECK (tipo IN ('COMPRA', 'CARGA', 'VENTA', 'DEVOLUCION_VENTA', 'ANULACION_COMPRA', 'AJUSTE')),
        motivo TEXT CHECK (motivo IS NULL OR motivo IN ('DANADO', 'PERDIDO', 'GARANTIA', 'USO_INTERNO', 'SOBRANTE')),
        cantidad_milli INTEGER NOT NULL CHECK (cantidad_milli <> 0),
        valor_usd INTEGER NOT NULL,
        documento_id INTEGER REFERENCES documentos(id),
        compra_id INTEGER REFERENCES compras(id),
        nota TEXT,
        fecha TEXT NOT NULL, creado_en TEXT NOT NULL, creado_por INTEGER)`,
      `CREATE INDEX idx_mov_producto ON movimientos_stock(producto_id)`,
      `CREATE INDEX idx_mov_documento ON movimientos_stock(documento_id)`,
      `CREATE TRIGGER mov_no_cambiar BEFORE UPDATE ON movimientos_stock WHEN old.modo = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Un movimiento de existencias no se modifica: se corrige con otro movimiento.'); END`,
      `CREATE TRIGGER mov_no_borrar BEFORE DELETE ON movimientos_stock WHEN old.modo = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Un movimiento de existencias no se borra: se corrige con otro movimiento.'); END`,
      `CREATE TRIGGER compra_no_borrar BEFORE DELETE ON compras WHEN old.modo = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Una compra registrada no se borra: se anula.'); END`,
      `CREATE TRIGGER compra_inmutable BEFORE UPDATE ON compras
        WHEN old.modo = 'REAL' AND (
          old.estado = 'ANULADA'
          OR new.estado NOT IN ('REGISTRADA', 'ANULADA')
          OR new.modo IS NOT old.modo OR new.proveedor_id IS NOT old.proveedor_id OR new.proveedor_rif IS NOT old.proveedor_rif
          OR new.proveedor_nombre IS NOT old.proveedor_nombre OR new.factura_numero IS NOT old.factura_numero OR new.control_numero IS NOT old.control_numero
          OR new.fecha IS NOT old.fecha OR new.subtotal_usd IS NOT old.subtotal_usd OR new.iva_usd IS NOT old.iva_usd OR new.total_usd IS NOT old.total_usd
          OR new.nota IS NOT old.nota OR new.renglones_json IS NOT old.renglones_json OR new.registrado_en IS NOT old.registrado_en OR new.registrado_por IS NOT old.registrado_por)
        BEGIN SELECT RAISE(ABORT, 'Compra registrada: solo se puede anular.'); END`,
      `INSERT INTO parametros_fiscales (clave, vigente_desde, valor, nota) VALUES
        ('motivos_ajuste', '2000-01-01', 'DANADO,PERDIDO,GARANTIA,USO_INTERNO,SOBRANTE', 'Motivos permitidos para ajustar existencias')`,
    ],
  },
  {
    // Fase 6.1: las compras guardan la tasa BCV de la fecha de la factura y sus montos en bolívares (libro de compras legal, en Bs).
    // Las compras anteriores quedan con estos campos vacíos a propósito: NO se les inventa una tasa (en modo real no se pueden tocar).
    id: "0007_compras_bs",
    sql: [
      `ALTER TABLE compras ADD COLUMN tasa_e8 INTEGER`,
      `ALTER TABLE compras ADD COLUMN subtotal_bs INTEGER`,
      `ALTER TABLE compras ADD COLUMN iva_bs INTEGER`,
      `ALTER TABLE compras ADD COLUMN total_bs INTEGER`,
      // Base e IVA por alícuota de cada compra (igual que documento_impuestos en las ventas): de aquí sale el libro de compras
      `CREATE TABLE compra_impuestos (
        compra_id INTEGER NOT NULL REFERENCES compras(id),
        alicuota_cent INTEGER NOT NULL,
        base_usd INTEGER NOT NULL, iva_usd INTEGER NOT NULL,
        base_bs INTEGER NOT NULL, iva_bs INTEGER NOT NULL,
        PRIMARY KEY (compra_id, alicuota_cent))`,
      `CREATE TRIGGER compra_impuestos_no_cambiar BEFORE UPDATE ON compra_impuestos
        WHEN (SELECT modo FROM compras WHERE id = old.compra_id) = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Compra registrada: sus impuestos no se pueden cambiar.'); END`,
      `CREATE TRIGGER compra_impuestos_no_borrar BEFORE DELETE ON compra_impuestos
        WHEN (SELECT modo FROM compras WHERE id = old.compra_id) = 'REAL'
        BEGIN SELECT RAISE(ABORT, 'Compra registrada: sus impuestos no se pueden borrar.'); END`,
      // La tasa y los montos en Bs también quedan protegidos: se vuelve a crear el candado de compras con las columnas nuevas
      `DROP TRIGGER compra_inmutable`,
      `CREATE TRIGGER compra_inmutable BEFORE UPDATE ON compras
        WHEN old.modo = 'REAL' AND (
          old.estado = 'ANULADA'
          OR new.estado NOT IN ('REGISTRADA', 'ANULADA')
          OR new.modo IS NOT old.modo OR new.proveedor_id IS NOT old.proveedor_id OR new.proveedor_rif IS NOT old.proveedor_rif
          OR new.proveedor_nombre IS NOT old.proveedor_nombre OR new.factura_numero IS NOT old.factura_numero OR new.control_numero IS NOT old.control_numero
          OR new.fecha IS NOT old.fecha OR new.subtotal_usd IS NOT old.subtotal_usd OR new.iva_usd IS NOT old.iva_usd OR new.total_usd IS NOT old.total_usd
          OR new.tasa_e8 IS NOT old.tasa_e8 OR new.subtotal_bs IS NOT old.subtotal_bs OR new.iva_bs IS NOT old.iva_bs OR new.total_bs IS NOT old.total_bs
          OR new.nota IS NOT old.nota OR new.renglones_json IS NOT old.renglones_json OR new.registrado_en IS NOT old.registrado_en OR new.registrado_por IS NOT old.registrado_por)
        BEGIN SELECT RAISE(ABORT, 'Compra registrada: solo se puede anular.'); END`,
    ],
  },
  {
    // Fase 7.1: usuarios con roles (ADMIN / SUPERVISOR / CAJERO / BODEGA), desactivar sin borrar, cambio obligatorio de clave y código de recuperación.
    // El rol 'ADMIN' de siempre sigue siendo el dueño: ninguna cuenta existente cambia ni pierde acceso.
    id: "0008_usuarios_roles",
    sql: [
      `ALTER TABLE usuarios ADD COLUMN activo INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE usuarios ADD COLUMN debe_cambiar_clave INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE usuarios ADD COLUMN codigo_recuperacion_hash TEXT`,
    ],
  },
  {
    // Fase 7.3: medio de facturación (máquina fiscal o imprenta digital, uno solo a la vez) y registro del número fiscal de cada factura.
    // El interruptor lo cambia solo el dueño y queda en un historial; cada factura guarda con qué medio se emitió y ese dato ya no se puede cambiar.
    id: "0009_medio_facturacion",
    sql: [
      `ALTER TABLE perfil_emisor ADD COLUMN medio_facturacion TEXT NOT NULL DEFAULT 'SIN_DEFINIR'`,
      `CREATE TABLE medio_historial (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        medio_anterior TEXT NOT NULL, medio_nuevo TEXT NOT NULL, motivo TEXT,
        cambiado_por INTEGER, cambiado_en TEXT NOT NULL)`,
      `ALTER TABLE documentos ADD COLUMN medio TEXT`,        // NULL = emitida antes de definir el medio
      `ALTER TABLE documentos ADD COLUMN fiscal_serial TEXT`, // serial de la máquina fiscal (solo máquina fiscal)
      // Un mismo número fiscal (de una misma máquina) no puede estar en dos facturas
      `CREATE UNIQUE INDEX documentos_fiscal_unico ON documentos (COALESCE(fiscal_serial, ''), control_fiscal) WHERE control_fiscal IS NOT NULL`,
      // El candado de facturas emitidas ahora también protege el medio y el número fiscal: el número fiscal solo se puede poner UNA vez (de vacío a un valor)
      `DROP TRIGGER doc_inmutable`,
      `CREATE TRIGGER doc_inmutable BEFORE UPDATE ON documentos
        WHEN old.modo = 'REAL' AND old.estado <> 'BORRADOR' AND (
          old.estado = 'ANULADO'
          OR new.estado NOT IN ('EMITIDO', 'FACTURADO', 'ANULADO')
          OR (old.estado = 'FACTURADO' AND new.estado <> 'FACTURADO')
          OR new.tipo IS NOT old.tipo
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
          OR new.total_usd IS NOT old.total_usd
          OR new.subtotal_bs IS NOT old.subtotal_bs
          OR new.iva_bs IS NOT old.iva_bs
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
    ],
  },
  {
    // Fase 7.3.1: la máquina fiscal se configura UNA vez (serial fijo + último número usado, para que el número fiscal sea correlativo) y la imprenta digital
    // guarda sus datos de conexión (la clave va aparte y NO sale en los respaldos).
    id: "0010_maquina_y_imprenta",
    sql: [
      `ALTER TABLE perfil_emisor ADD COLUMN maquina_serial TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN maquina_ultimo INTEGER NOT NULL DEFAULT 0`,
      `CREATE TABLE integraciones (clave TEXT PRIMARY KEY, valor TEXT NOT NULL, actualizado_en TEXT NOT NULL)`,
    ],
  },
  {
    // Fase 8: IGTF (3%) activable/desactivable por factura y Devoluciones mediante Nota de Crédito según leyes venezolanas (SENIAT Providencia 0071).
    id: "0011_igtf_y_notas_credito",
    sql: [
      `ALTER TABLE perfil_emisor ADD COLUMN igtf_activo INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE documentos ADD COLUMN aplica_igtf INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE documentos ADD COLUMN igtf_alicuota_cent INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE documentos ADD COLUMN igtf_usd INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE documentos ADD COLUMN igtf_bs INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE documentos ADD COLUMN es_nota_credito INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE documentos ADD COLUMN factura_afectada_id INTEGER REFERENCES documentos(id)`,
      `ALTER TABLE documentos ADD COLUMN motivo_nc TEXT`,
      `INSERT OR IGNORE INTO contadores (clave) VALUES ('NOTA_CREDITO:PRACTICA'), ('NOTA_CREDITO:REAL')`,
      `INSERT OR IGNORE INTO parametros_fiscales (clave, vigente_desde, valor, nota) VALUES
        ('igtf_alicuota_cent', '2000-01-01', '300', 'Alícuota de IGTF (% x 100): 3% para pagos en divisas o criptoactivos')`,
      `DROP INDEX IF EXISTS idx_doc_numero`,
      `CREATE UNIQUE INDEX idx_doc_numero ON documentos(tipo, es_nota_credito, modo, numero) WHERE numero IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_doc_afectada ON documentos(factura_afectada_id) WHERE factura_afectada_id IS NOT NULL`,
      `DROP TRIGGER doc_inmutable`,
      `CREATE TRIGGER doc_inmutable BEFORE UPDATE ON documentos
        WHEN old.modo = 'REAL' AND old.estado <> 'BORRADOR' AND (
          old.estado = 'ANULADO'
          OR new.estado NOT IN ('EMITIDO', 'FACTURADO', 'ANULADO')
          OR (old.estado = 'FACTURADO' AND new.estado <> 'FACTURADO')
          OR new.tipo IS NOT old.tipo
          OR new.es_nota_credito IS NOT old.es_nota_credito
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
    ],
  },
  {
    // Fase 9: Eliminación de máquina fiscal; solo dos metodologías digitales: APP_SENIAT (Aplicación SENIAT) e IMPRENTA_DIGITAL (API Imprenta Digital).
    id: "0012_solo_facturacion_digital",
    sql: [
      `UPDATE perfil_emisor SET medio_facturacion = 'APP_SENIAT', maquina_serial = NULL, maquina_ultimo = 0 WHERE medio_facturacion IN ('MAQUINA_FISCAL', 'SIN_DEFINIR')`,
      `UPDATE parametros_fiscales SET valor = 'FACTURA' WHERE clave = 'titulo_sin_control'`,
    ],
  },
  {
    // Fase 10: Ficha integral del Certificado RIF Digital SENIAT v2.0 y Cédula del Representante Legal / Dueño.
    id: "0013_ficha_rif_seniat_y_representante",
    sql: [
      `ALTER TABLE perfil_emisor ADD COLUMN firma_personal TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN zona_postal TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN sector_seniat TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN rif_comprobante TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN rif_fecha_inscripcion TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN rif_fecha_actualizacion TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN rif_codigo_firma TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN representante_nombre TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN representante_cedula TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN representante_fecha_nac TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN representante_estado_civil TEXT`,
      `ALTER TABLE perfil_emisor ADD COLUMN representante_cedula_venc TEXT`,
    ],
  },
  // Retenciones de IVA practicadas por Contribuyentes Especiales (Providencias SENIAT SNAT/2015/0049 y SNAT/2025/000054):
  // agrega es_retencion_iva (0/1) y comprobante_retencion (14 dígitos AAAAMMSSSSSSSS) a pagos y actualiza el trigger pago_inmutable.
  {
    id: "0014_retenciones_iva",
    sql: [
      `ALTER TABLE pagos ADD COLUMN es_retencion_iva INTEGER NOT NULL DEFAULT 0 CHECK (es_retencion_iva IN (0, 1))`,
      `ALTER TABLE pagos ADD COLUMN comprobante_retencion TEXT`,
      `DROP TRIGGER IF EXISTS pago_inmutable`,
      `CREATE TRIGGER pago_inmutable BEFORE UPDATE ON pagos WHEN old.modo = 'REAL' AND (old.estado = 'ANULADO' OR new.numero IS NOT old.numero OR new.documento_id IS NOT old.documento_id OR new.fecha_pago IS NOT old.fecha_pago OR new.metodo IS NOT old.metodo OR new.moneda IS NOT old.moneda OR new.monto_recibido IS NOT old.monto_recibido OR new.tasa_e8 IS NOT old.tasa_e8 OR new.monto_usd IS NOT old.monto_usd OR new.saldo_despues_usd IS NOT old.saldo_despues_usd OR new.referencia IS NOT old.referencia OR new.es_retencion_iva IS NOT old.es_retencion_iva OR new.comprobante_retencion IS NOT old.comprobante_retencion OR new.reglas_json IS NOT old.reglas_json OR new.modo IS NOT old.modo OR new.estado <> 'ANULADO' OR new.motivo_anulacion IS NULL OR length(trim(new.motivo_anulacion)) < 5) BEGIN SELECT RAISE(ABORT, 'Un pago emitido no se puede modificar; solo anularse con motivo'); END`,
    ],
  },
  // Paquete de Mejoras v3.4:
  // 1) Tasa BCV Automática/Manual y Cierre Mensual por Correo en perfil_emisor.
  // 2) Notas de Débito en Ventas (es_nota_debito + contador NOTA_DEBITO + índice único y trigger doc_inmutable).
  // 3) Retenciones de ISLR recibidas en Pagos (Decreto 1.808: es_retencion_islr + porcentaje_retencion + trigger pago_inmutable).
  {
    id: "0015_paquete_v3_4",
    sql: [
      `ALTER TABLE perfil_emisor ADD COLUMN tasa_bcv_modo TEXT NOT NULL DEFAULT 'AUTOMATICO' CHECK (tasa_bcv_modo IN ('AUTOMATICO', 'MANUAL'))`,
      `ALTER TABLE perfil_emisor ADD COLUMN cierre_mensual_correo INTEGER NOT NULL DEFAULT 1 CHECK (cierre_mensual_correo IN (0, 1))`,
      `ALTER TABLE perfil_emisor ADD COLUMN ultimo_cierre_correo TEXT`,
      `ALTER TABLE documentos ADD COLUMN es_nota_debito INTEGER NOT NULL DEFAULT 0 CHECK (es_nota_debito IN (0, 1))`,
      `INSERT OR IGNORE INTO contadores (clave, valor) VALUES ('NOTA_DEBITO:PRACTICA', 0), ('NOTA_DEBITO:REAL', 0)`,
      `DROP INDEX IF EXISTS idx_doc_numero`,
      `CREATE UNIQUE INDEX idx_doc_numero ON documentos(tipo, es_nota_credito, es_nota_debito, modo, numero) WHERE numero IS NOT NULL`,
      `ALTER TABLE pagos ADD COLUMN es_retencion_islr INTEGER NOT NULL DEFAULT 0 CHECK (es_retencion_islr IN (0, 1))`,
      `ALTER TABLE pagos ADD COLUMN porcentaje_retencion INTEGER`,
      `DROP TRIGGER IF EXISTS doc_inmutable`,
      `CREATE TRIGGER doc_inmutable BEFORE UPDATE ON documentos
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
      `DROP TRIGGER IF EXISTS pago_inmutable`,
      `CREATE TRIGGER pago_inmutable BEFORE UPDATE ON pagos WHEN old.modo = 'REAL' AND (old.estado = 'ANULADO' OR new.numero IS NOT old.numero OR new.documento_id IS NOT old.documento_id OR new.fecha_pago IS NOT old.fecha_pago OR new.metodo IS NOT old.metodo OR new.moneda IS NOT old.moneda OR new.monto_recibido IS NOT old.monto_recibido OR new.tasa_e8 IS NOT old.tasa_e8 OR new.monto_usd IS NOT old.monto_usd OR new.saldo_despues_usd IS NOT old.saldo_despues_usd OR new.referencia IS NOT old.referencia OR new.es_retencion_iva IS NOT old.es_retencion_iva OR new.es_retencion_islr IS NOT old.es_retencion_islr OR new.porcentaje_retencion IS NOT old.porcentaje_retencion OR new.comprobante_retencion IS NOT old.comprobante_retencion OR new.reglas_json IS NOT old.reglas_json OR new.modo IS NOT old.modo OR new.estado <> 'ANULADO' OR new.motivo_anulacion IS NULL OR length(trim(new.motivo_anulacion)) < 5) BEGIN SELECT RAISE(ABORT, 'Un pago emitido no se puede modificar; solo anularse con motivo'); END`,
    ],
  },
  // 0016: Escala Pro v4.0 (100 Empresas × 100 Facturas/día):
  // - Tabla `emisor_logos` deduplicada por SHA-256 (ahorra 98.5% de almacenamiento D1 al no repetir 150 KB de logo Base64 por factura)
  // - Índices compuestos SQLite para listados, reportes SENIAT, cuentas por cobrar, renglones, auditoría y limpieza de sesiones en < 5 ms
  {
    id: "0016_escala_pro_v4_0",
    sql: [
      `CREATE TABLE IF NOT EXISTS emisor_logos (
        hash TEXT PRIMARY KEY,
        logo_base64 TEXT NOT NULL,
        creado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_renglones_doc ON documento_renglones(documento_id, orden)`,
      `CREATE INDEX IF NOT EXISTS idx_doc_modo_fecha ON documentos(modo, tipo, estado, fecha_emision DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_doc_por_cobrar ON documentos(modo, tipo, es_nota_credito, estado, vence_el)`,
      `CREATE INDEX IF NOT EXISTS idx_pagos_modo_fecha ON pagos(modo, estado, fecha_pago DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria(creado_en DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_sesiones_expira ON sesiones(expira_en)`,
    ],
  },
  // 0017: Blindaje v4.1 (Recuperación de clave no destructiva anti-DoS + Conector Imprenta Digital):
  // - Agrega `clave_temporal_hash` y `clave_temporal_expira` en `usuarios` para que solicitar recuperación por correo
  //   NO sobrescriba la contraseña activa ni cierre las sesiones del usuario hasta que realmente inicie sesión con la clave temporal.
  {
    id: "0017_blindaje_v4_1",
    antes: async (db) => {
      const info = await db.prepare(`PRAGMA table_info(usuarios)`).all<{ name: string }>().catch(() => ({ results: [] }));
      const cols = new Set((info.results ?? []).map((c) => c.name));
      const alters: D1PreparedStatement[] = [];
      if (!cols.has("clave_temporal_hash")) {
        alters.push(db.prepare(`ALTER TABLE usuarios ADD COLUMN clave_temporal_hash TEXT`));
      }
      if (!cols.has("clave_temporal_expira")) {
        alters.push(db.prepare(`ALTER TABLE usuarios ADD COLUMN clave_temporal_expira INTEGER NOT NULL DEFAULT 0`));
      }
      if (alters.length) {
        try {
          await db.batch(alters);
        } catch (e) {
          if (!/duplicate column/i.test(String(e))) throw e;
        }
      }
      const verif = await db.prepare(`PRAGMA table_info(usuarios)`).all<{ name: string }>();
      const colsDespues = new Set((verif.results ?? []).map((c) => c.name));
      if (!colsDespues.has("clave_temporal_hash") || !colsDespues.has("clave_temporal_expira")) {
        throw new Error("Fallo de migración 0017: columnas clave_temporal_hash y clave_temporal_expira ausentes en usuarios.");
      }
    },
    sql: [
      `SELECT 1`,
    ],
  },
  // 0018: Lanzamiento Comercial v4.3 (2FA TOTP para Súper Admin):
  // - Agrega columnas en `usuarios` para secreto TOTP cifrado con MASTER_KEY, pendiente de activación, paso anti-replay y códigos de respaldo de un solo uso.
  {
    id: "0018_totp_2fa_v4_3",
    sql: [
      `ALTER TABLE usuarios ADD COLUMN totp_activo INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE usuarios ADD COLUMN totp_secreto TEXT`,
      `ALTER TABLE usuarios ADD COLUMN totp_pendiente TEXT`,
      `ALTER TABLE usuarios ADD COLUMN totp_ultimo_paso INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE usuarios ADD COLUMN totp_respaldo_json TEXT`,
    ],
  },
  // 0019: Regímenes Fiscales SENIAT v4.6 (Contribuyente Formal, Ordinario y Especial / SPE):
  // - Agrega `tipo_contribuyente` en `perfil_emisor` con valor por defecto ORDINARIO (compatible con empresas existentes).
  // - Sincroniza cuentas existentes que ya tenían `igtf_activo = 1` como ESPECIAL.
  {
    id: "0019_tipo_contribuyente_v4_6",
    sql: [
      `ALTER TABLE perfil_emisor ADD COLUMN tipo_contribuyente TEXT NOT NULL DEFAULT 'ORDINARIO' CHECK (tipo_contribuyente IN ('FORMAL', 'ORDINARIO', 'ESPECIAL'))`,
      `UPDATE perfil_emisor SET tipo_contribuyente = 'ESPECIAL' WHERE igtf_activo = 1`,
    ],
  },
  // 0020: Correo de Plataforma v4.7 (Historial por inquilino):
  // - Crea únicamente la tabla `correo_envios` dentro de la D1 de cada inquilino (las tablas globales `_mt_correos_*` viven solo en la D1 principal).
  {
    id: "0020_correo_historial_v4_7",
    sql: [
      `CREATE TABLE IF NOT EXISTS correo_envios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        creado_en TEXT NOT NULL DEFAULT (datetime('now')),
        tipo TEXT NOT NULL DEFAULT 'GENERAL',
        destinatario TEXT NOT NULL DEFAULT '',
        asunto TEXT NOT NULL DEFAULT '',
        proveedor TEXT NOT NULL DEFAULT '',
        estado TEXT NOT NULL DEFAULT 'ENVIADO',
        motivo TEXT NOT NULL DEFAULT '',
        message_id TEXT DEFAULT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_correo_envios_fecha ON correo_envios(creado_en)`,
      `CREATE INDEX IF NOT EXISTS idx_correo_envios_msgid ON correo_envios(message_id)`,
    ],
  },
  // 0021: Imprenta Digital CG v5.1 (Trazabilidad ida/vuelta por documento y recargas de plan):
  // - Registra cada documento enviado/retornado por la Imprenta Digital (control_fiscal, pdf_url oficial, intentos, estado y anulación)
  //   sin modificar los triggers inmutables de `documentos`.
  // - Registra historial append-only de lotes/recargas contratados por el cliente con fecha pagada y vigencia.
  {
    id: "0021_imprenta_cg_v5_1",
    sql: [
      `CREATE TABLE IF NOT EXISTS imprenta_envios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        documento_id INTEGER NOT NULL UNIQUE,
        proveedor TEXT NOT NULL DEFAULT '',
        proveedor_tipo TEXT NOT NULL DEFAULT 'CG_IMPRENTA',
        ambiente TEXT NOT NULL DEFAULT 'PRUEBAS',
        tipo_documento TEXT NOT NULL DEFAULT 'FACTURA',
        numero_documento TEXT NOT NULL DEFAULT '',
        numero_serie TEXT NOT NULL DEFAULT 'A',
        control_fiscal TEXT DEFAULT NULL,
        pdf_url TEXT DEFAULT NULL,
        estado TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('ENVIADO_OK', 'PENDIENTE', 'ERROR', 'ANULADO_OK')),
        intentos INTEGER NOT NULL DEFAULT 1,
        ultimo_error TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL DEFAULT '',
        enviado_en TEXT NOT NULL DEFAULT (datetime('now')),
        retornado_en TEXT DEFAULT NULL,
        anulado_en TEXT DEFAULT NULL,
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_imprenta_envios_estado ON imprenta_envios(estado)`,
      `CREATE INDEX IF NOT EXISTS idx_imprenta_envios_control ON imprenta_envios(control_fiscal)`,
      `CREATE TABLE IF NOT EXISTS imprenta_plan_recargas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_nombre TEXT NOT NULL DEFAULT '',
        cantidad_numeros INTEGER NOT NULL DEFAULT 0 CHECK (cantidad_numeros >= 0),
        fecha_pago TEXT NOT NULL DEFAULT '',
        fecha_vence TEXT DEFAULT NULL,
        monto_usd_centavos INTEGER NOT NULL DEFAULT 0 CHECK (monto_usd_centavos >= 0),
        referencia TEXT NOT NULL DEFAULT '',
        nota TEXT NOT NULL DEFAULT '',
        registrado_por INTEGER DEFAULT NULL,
        creado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_imprenta_recargas_fecha ON imprenta_plan_recargas(fecha_pago)`,
    ],
  },
  // 0022: Imprenta Digital v5.2 (The Factory HKA Emisión v2 + Sello Legal Inmutable SNAT/2024/000102):
  // - Agrega metadatos legales inmutables devueltos por la Imprenta Digital (fecha/hora exacta de asignación,
  //   razón social/RIF y autorización SENIAT de la imprenta) en `imprenta_envios`.
  {
    id: "0022_imprenta_legal_tfhka_v5_2",
    sql: [
      `ALTER TABLE imprenta_envios ADD COLUMN fecha_asignacion TEXT DEFAULT NULL`,
      `ALTER TABLE imprenta_envios ADD COLUMN hora_asignacion TEXT DEFAULT NULL`,
      `ALTER TABLE imprenta_envios ADD COLUMN imprenta_razon_social TEXT DEFAULT NULL`,
      `ALTER TABLE imprenta_envios ADD COLUMN imprenta_autorizacion TEXT DEFAULT NULL`,
    ],
  },
  // 0023: Imprenta Digital v5.2.1 (Unicidad Fiscal por Ámbito):
  // - Evita falsas colisiones de control_fiscal entre PRACTICA vs REAL, APP_SENIAT vs IMPRENTA_DIGITAL,
  //   Sandbox vs Producción, o entre distintos proveedores autorizados (CG vs The Factory HKA),
  //   manteniendo unicidad estricta dentro del mismo modo + medio + ámbito fiscal (fiscal_serial).
  // - Permite sellar `fiscal_serial` UNA SOLA VEZ (de NULL a valor inmutable) en IMPRENTA_DIGITAL.
  {
    id: "0023_fiscal_unico_ambito_v5_2_1",
    sql: [
      `DROP INDEX IF EXISTS documentos_fiscal_unico`,
      `CREATE UNIQUE INDEX documentos_fiscal_unico ON documentos (modo, COALESCE(medio, ''), COALESCE(fiscal_serial, ''), control_fiscal) WHERE control_fiscal IS NOT NULL`,
      `DROP TRIGGER IF EXISTS doc_inmutable`,
      `CREATE TRIGGER doc_inmutable BEFORE UPDATE ON documentos
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
          OR (new.fiscal_serial IS NOT old.fiscal_serial AND (old.fiscal_serial IS NOT NULL OR old.medio NOT IN ('MAQUINA_FISCAL', 'IMPRENTA_DIGITAL'))))
        BEGIN SELECT RAISE(ABORT, 'Documento emitido: no se puede modificar, solo anular.'); END`,
    ],
  },
];

export async function migrar(db: D1Database) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS _migraciones (id TEXT PRIMARY KEY, aplicada_en TEXT NOT NULL DEFAULT (datetime('now')))`
  ).run();
  const { results } = await db.prepare(`SELECT id FROM _migraciones`).all<{ id: string }>();
  const hechas = new Set(results.map((r) => r.id));

  let bdTotalmenteNueva = false;
  if (hechas.size === 0) {
    const legadas = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('catalogo', 'documentos', 'compras')`)
      .all<{ name: string }>();
    bdTotalmenteNueva = (legadas.results?.length ?? 0) === 0;
  }

  for (const m of MIGRACIONES) {
    if (hechas.has(m.id)) continue;
    if (!bdTotalmenteNueva || m.id === "0017_blindaje_v4_1") {
      await m.antes?.(db);
    }
    try {
      // batch = todo o nada: INSERT OR IGNORE evita fallo 500 si dos isolates en frío aplican la misma migración en el mismo milisegundo
      await db.batch([...m.sql.map((s) => db.prepare(s)), db.prepare(`INSERT OR IGNORE INTO _migraciones (id) VALUES (?)`).bind(m.id)]);
    } catch (e) {
      const yaAplicada = await db.prepare(`SELECT 1 FROM _migraciones WHERE id = ?`).bind(m.id).first().catch(() => null);
      if (!yaAplicada) throw e;
    }
  }
}
