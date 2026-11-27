// Módulo SISTEMA (solo administrador): salir del modo práctica, servicio de correo, respaldo completo y reinicio de fábrica (solo Super Admin).
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cifrarSecreto, descifrarSecreto } from "../cifrado";
import { EMAIL, ahora, auditar, falla, fechaCaracas, leerJson, modoActual, requiereAdmin, requiereSesion, texto, type Env } from "../comun";
import { enviarCorreo, leerConfigCorreo } from "../correo";
import { eliminarBaseD1EnCloudflare, obtenerUuidBdPrincipal } from "../cloudflare-api";
import { fijarVistaSuperAdmin, hidratarBindingsCloudflare, obtenerSuperAdminPrincipal } from "../inquilinos";
import { migrar } from "../migraciones";
import { esSuperAdmin } from "../permisos";
import { sha256, verificarClave } from "../seguridad";
import { generarRespaldoNegocio, obtenerFirmaCoberturaReal } from "../salud-bd";
import {
  PROVEEDOR_CG,
  PROVEEDOR_GENERICO,
  PROVEEDOR_TFHKA,
  ambitoFiscalImprenta,
  anularFacturaCg,
  conciliarDocumentosCg,
  ejecutarSuiteCertificacionCg,
  enviarDocumentoCg,
  leerConfigImprentaCompleta,
  normalizarHostCg,
  numeroDocumentoCg,
  obtenerResumenImprenta,
  ocultarSecretoImprenta,
  probarConexionCg,
  registrarEnvioImprentaDb,
  validarUrlImprentaSegura,
  validarUrlPdfSegura,
  type PayloadImprentaDocumento,
  type ResultadoEnvioImprenta,
  type TipoProveedorImprenta,
} from "../imprenta-cg";
import {
  anularDocumentoTfhka,
  conciliarDocumentosTfhka,
  consultarNumeracionesTfhka,
  ejecutarSuiteCertificacionTfhka,
  enviarDocumentoTfhka,
  normalizarHostTfhka,
  numeroDocumentoTfhka,
  probarConexionTfhka,
} from "../imprenta-tfhka";

const sistema = new Hono<Env>();
sistema.use("*", requiereSesion, requiereAdmin);

const entero = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 999999999 ? n : 0; };

// Ruta legada (reemplazada por el Entorno Demo aislado): bloqueada para inquilinos/clientes; solo Súper Admin en contingencia.
sistema.post("/salir-en-vivo", async (c) => {
  const yo = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  if (!esSuperAdmin(yo.rol, yo.email, envObj)) {
    return falla(c, 403, "El modo práctica fue reemplazado por el Entorno Demo aislado. Todas las empresas operan directamente en modo fiscal real.");
  }
  const db = c.env.DB, b = await leerJson(c);
  const medio = await db.prepare(`SELECT medio_facturacion AS m FROM perfil_emisor WHERE id = 1`).first<{ m: string }>();
  if (medio?.m === "SIN_DEFINIR") return falla(c, 400, "Antes de salir en vivo elige tu modalidad de facturación digital (App SENIAT o Imprenta Digital) en Ajustes.");
  const f = entero(b.primer_factura), k = entero(b.primer_control), p = entero(b.primer_presupuesto), rec = entero(b.primer_recibo ?? 1), nc = entero(b.primer_nota_credito ?? 1), nd = entero(b.primer_nota_debito ?? 1);
  if (!f || !k || !p || !rec || !nc || !nd) return falla(c, 400, "Escribe los números iniciales (mínimo 1).");
  if (b.confirmo !== true) return falla(c, 400, "Marca la casilla para confirmar.");
  if ((await modoActual(db)) !== "PRACTICA") return falla(c, 409, "El sistema ya está en vivo.");
  await db.batch([
    db.prepare(`DELETE FROM pagos WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM movimientos_stock WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM compra_impuestos WHERE compra_id IN (SELECT id FROM compras WHERE modo = 'PRACTICA')`),
    db.prepare(`DELETE FROM compras WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM documento_impuestos WHERE documento_id IN (SELECT id FROM documentos WHERE modo = 'PRACTICA')`),
    db.prepare(`DELETE FROM documento_renglones WHERE documento_id IN (SELECT id FROM documentos WHERE modo = 'PRACTICA')`),
    db.prepare(`UPDATE documentos SET presupuesto_id = NULL, factura_afectada_id = NULL WHERE modo = 'PRACTICA'`),
    db.prepare(`DELETE FROM documentos WHERE modo = 'PRACTICA'`),
    db.prepare(`UPDATE contadores SET valor = 0 WHERE clave LIKE '%:PRACTICA'`),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'FACTURA:REAL'`).bind(f - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'CONTROL:REAL'`).bind(k - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'PRESUPUESTO:REAL'`).bind(p - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'RECIBO:REAL'`).bind(rec - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'NOTA_CREDITO:REAL'`).bind(nc - 1),
    db.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'NOTA_DEBITO:REAL'`).bind(nd - 1),
    db.prepare(`UPDATE catalogo SET controla_stock = 0 WHERE controla_stock = 1 AND NOT EXISTS (SELECT 1 FROM movimientos_stock m WHERE m.producto_id = catalogo.id)`),
    db.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`),
  ]);
  await auditar(c, c.get("usuario").id, "SALIR_EN_VIVO", `factura ${f}, control ${k}, presupuesto ${p}, nc ${nc}, nd ${nd}`);
  return c.json({ ok: true });
});

// MODALIDAD DE FACTURACIÓN DIGITAL: Aplicación Digital SENIAT (APP_SENIAT) o Imprenta Digital Autorizada (IMPRENTA_DIGITAL).
// Solo el dueño lo cambia, con su contraseña y un motivo; queda en el historial.
const MEDIOS = ["APP_SENIAT", "IMPRENTA_DIGITAL"];
sistema.get("/medio", async (c) => {
  const db = c.env.DB, envObj = c.env as unknown as Record<string, unknown>;
  const p = await db.prepare(`SELECT medio_facturacion AS medio FROM perfil_emisor WHERE id = 1`).first<{ medio: string }>();
  const { results } = await db.prepare(`SELECT h.medio_anterior, h.medio_nuevo, h.motivo, h.cambiado_en, u.nombre AS por FROM medio_historial h LEFT JOIN usuarios u ON u.id = h.cambiado_por ORDER BY h.id DESC LIMIT 10`).all();
  const estadoImp = await obtenerResumenImprenta(db, envObj, fechaCaracas(), { incluirHistorial: true });
  return c.json({
    ok: true,
    medio: p?.medio ?? "APP_SENIAT",
    historial: results,
    imprenta: await leerImprenta(db, envObj),
    imprenta_estado: estadoImp,
  });
});

// IMPRENTA DIGITAL: datos de conexión (proveedor_tipo, proveedor, dirección de su API, usuario, clave, ambiente, serie)
// y plan contratado (nombre, cupo total, fecha pagada, vigencia, consumo previo). La clave y el JWT se guardan cifrados (AES-256-GCM),
// NO salen en los respaldos y nunca se devuelven enteros (solo los últimos 4 caracteres).
async function leerImprenta(db: D1Database, env?: Record<string, unknown>) {
  return ocultarSecretoImprenta(await leerConfigImprentaCompleta(db, env));
}

// Conector HTTP en vivo para Imprenta Digital Autorizada (SNAT/2024/000102 / SNAT/2026/00093 / CG SNAT/INTI/012).
// Se invoca exclusivamente cuando medio_facturacion === 'IMPRENTA_DIGITAL' y modo === 'REAL' (APP_SENIAT no se toca).
export async function solicitarControlImprentaDigital(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  payload: PayloadImprentaDocumento,
  fetchFn: typeof fetch = fetch
): Promise<ResultadoEnvioImprenta> {
  if (payload.modo && String(payload.modo).toUpperCase() !== "REAL") {
    return { ok: false, control_fiscal: null, error: "La Imprenta Digital solo se invoca en documentos fiscales reales (modo REAL)." };
  }
  const cfg = await leerConfigImprentaCompleta(db, env);
  const url = String(cfg.url ?? "").trim();
  const claveClara = cfg.clave_clara;
  if (!url || !claveClara) {
    return { ok: false, control_fiscal: null, error: "Imprenta Digital no configurada" };
  }

  let emisor = payload.emisor;
  if (!emisor) {
    const p = await db
      .prepare(`SELECT rif, nombre_razon_social, direccion_fiscal, email FROM perfil_emisor WHERE id = 1`)
      .first<{ rif: string; nombre_razon_social: string; direccion_fiscal: string; email?: string | null }>()
      .catch(() => null);
    emisor = {
      rif: String(p?.rif ?? ""),
      nombre_razon_social: String(p?.nombre_razon_social ?? ""),
      direccion_fiscal: String(p?.direccion_fiscal ?? ""),
      email: p?.email ?? null,
    };
  }
  const renglones =
    payload.renglones ??
    (
      await db
        .prepare(
          `SELECT orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, alicuota_cent, monto_usd, monto_bs
           FROM documento_renglones WHERE documento_id = ? ORDER BY orden ASC`
        )
        .bind(payload.documento_id)
        .all<NonNullable<PayloadImprentaDocumento["renglones"]>[number]>()
        .catch(() => ({ results: [] as NonNullable<PayloadImprentaDocumento["renglones"]> }))
    ).results;
  const impuestos =
    payload.impuestos ??
    (
      await db
        .prepare(
          `SELECT alicuota_cent, base_usd, iva_usd, base_bs, iva_bs
           FROM documento_impuestos WHERE documento_id = ? ORDER BY alicuota_cent ASC`
        )
        .bind(payload.documento_id)
        .all<Record<string, unknown>>()
        .catch(() => ({ results: [] as Record<string, unknown>[] }))
    ).results;

  const idempotencyKey = `${(emisor.rif || "EMISOR").replace(/[^A-Z0-9]/gi, "")}-${payload.tipo_documento}-${payload.modo || "REAL"}-${payload.numero}`;
  const registrarPendiente = async (motivoError: string) => {
    const ahoraIso = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?)
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
      )
      .bind(`imprenta_pendiente_${payload.documento_id}`, JSON.stringify({ error: motivoError, idempotency_key: idempotencyKey, en: ahoraIso }), ahoraIso)
      .run()
      .catch(() => {});
  };

  // Ruta oficial CG La Imprenta Digital (API Gateway CG v14)
  if (cfg.proveedor_tipo === PROVEEDOR_CG) {
    try {
      const resCg = await enviarDocumentoCg(
        db,
        env,
        cfg,
        { ...payload, emisor, renglones, impuestos },
        idempotencyKey,
        fetchFn
      );
      if (!resCg.ok) {
        await registrarPendiente(resCg.error || "Error con CG Imprenta Digital");
      }
      return resCg;
    } catch (err) {
      const errMsg = `Error inesperado comunicando con CG Imprenta Digital: ${String((err as Error)?.message || err).slice(0, 180)}`;
      console.error("[imprenta-cg] enviarDocumentoCg:", err);
      await registrarPendiente(errMsg);
      await registrarEnvioImprentaDb(db, {
        documento_id: payload.documento_id,
        proveedor: cfg.proveedor || "CG La Imprenta Digital",
        proveedor_tipo: PROVEEDOR_CG,
        ambiente: cfg.ambiente,
        tipo_documento: payload.tipo_documento,
        numero_documento: numeroDocumentoCg(payload.numero),
        numero_serie: cfg.serie,
        control_fiscal: null,
        pdf_url: null,
        estado: "PENDIENTE",
        ultimo_error: errMsg,
        idempotency_key: idempotencyKey,
      });
      return {
        ok: false,
        control_fiscal: null,
        pdf_url: null,
        proveedor: cfg.proveedor || "CG La Imprenta Digital",
        proveedor_tipo: PROVEEDOR_CG,
        error: errMsg,
        idempotency_key: idempotencyKey,
      };
    }
  }

  // Ruta oficial The Factory HKA Venezuela (API Emisión v2 · SNAT/2024/000102)
  if (cfg.proveedor_tipo === PROVEEDOR_TFHKA) {
    try {
      const resTf = await enviarDocumentoTfhka(
        db,
        env,
        cfg,
        { ...payload, emisor, renglones, impuestos },
        idempotencyKey,
        fetchFn
      );
      if (!resTf.ok) {
        await registrarPendiente(resTf.error || "Error con The Factory HKA");
      }
      return resTf;
    } catch (err) {
      const errMsg = `Error inesperado comunicando con The Factory HKA: ${String((err as Error)?.message || err).slice(0, 180)}`;
      console.error("[imprenta-tfhka] enviarDocumentoTfhka:", err);
      await registrarPendiente(errMsg);
      await registrarEnvioImprentaDb(db, {
        documento_id: payload.documento_id,
        proveedor: cfg.proveedor || "The Factory HKA Venezuela",
        proveedor_tipo: PROVEEDOR_TFHKA,
        ambiente: cfg.ambiente,
        tipo_documento: payload.tipo_documento,
        numero_documento: numeroDocumentoTfhka(payload.numero),
        numero_serie: cfg.serie,
        control_fiscal: null,
        pdf_url: null,
        estado: "PENDIENTE",
        ultimo_error: errMsg,
        idempotency_key: idempotencyKey,
      });
      return {
        ok: false,
        control_fiscal: null,
        pdf_url: null,
        proveedor: cfg.proveedor || "The Factory HKA Venezuela",
        proveedor_tipo: PROVEEDOR_TFHKA,
        error: errMsg,
        idempotency_key: idempotencyKey,
      };
    }
  }

  // Ruta genérica compatible con otros proveedores autorizados (webhook Bearer + JSON)
  const numDocStr = numeroDocumentoCg(payload.numero);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${claveClara}`,
        "Idempotency-Key": idempotencyKey,
        "X-Imprenta-Usuario": String(cfg.usuario ?? ""),
        "X-Imprenta-Ambiente": String(cfg.ambiente ?? "PRUEBAS"),
      },
      body: JSON.stringify({
        proveedor: cfg.proveedor ?? "",
        ambiente: cfg.ambiente ?? "PRUEBAS",
        usuario: cfg.usuario ?? "",
        idempotency_key: idempotencyKey,
        emisor,
        documento: {
          ...payload,
          emisor,
          renglones,
          impuestos,
        },
      }),
    });
    if (!res.ok) {
      const errMsg = `HTTP ${res.status}`;
      await registrarPendiente(errMsg);
      await registrarEnvioImprentaDb(db, {
        documento_id: payload.documento_id,
        proveedor: cfg.proveedor,
        proveedor_tipo: PROVEEDOR_GENERICO,
        ambiente: cfg.ambiente,
        tipo_documento: payload.tipo_documento,
        numero_documento: numDocStr,
        numero_serie: cfg.serie,
        control_fiscal: null,
        pdf_url: null,
        estado: "PENDIENTE",
        ultimo_error: errMsg,
        idempotency_key: idempotencyKey,
      });
      return { ok: false, control_fiscal: null, proveedor: cfg.proveedor, proveedor_tipo: PROVEEDOR_GENERICO, error: errMsg, idempotency_key: idempotencyKey };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    const rawCtrl = String(
      data?.control_fiscal ??
        data?.numero_control ??
        data?.control_number ??
        data?.control ??
        data?.resultado?.control_fiscal ??
        data?.resultado?.numero_control ??
        ""
    )
      .trim()
      .toUpperCase();
    const pdfSeguro = validarUrlPdfSegura(data?.invoice_pdf ?? data?.pdf_url ?? data?.url_pdf ?? data?.resultado?.pdf_url ?? null);
    if (!/^[0-9A-Z][0-9A-Z-]{0,29}$/.test(rawCtrl)) {
      const errMsg = "Formato de número de control inválido";
      await registrarPendiente(errMsg);
      await registrarEnvioImprentaDb(db, {
        documento_id: payload.documento_id,
        proveedor: cfg.proveedor,
        proveedor_tipo: PROVEEDOR_GENERICO,
        ambiente: cfg.ambiente,
        tipo_documento: payload.tipo_documento,
        numero_documento: numDocStr,
        numero_serie: cfg.serie,
        control_fiscal: null,
        pdf_url: null,
        estado: "PENDIENTE",
        ultimo_error: errMsg,
        idempotency_key: idempotencyKey,
      });
      return { ok: false, control_fiscal: null, proveedor: cfg.proveedor, proveedor_tipo: PROVEEDOR_GENERICO, error: errMsg, idempotency_key: idempotencyKey };
    }
    const ambitoFiscal = ambitoFiscalImprenta(cfg);
    await db.batch([
      db
        .prepare(
          `UPDATE documentos
           SET control_fiscal = ?, fiscal_serial = COALESCE(fiscal_serial, ?)
           WHERE id = ? AND control_fiscal IS NULL AND estado = 'EMITIDO'`
        )
        .bind(rawCtrl, ambitoFiscal, payload.documento_id),
      db.prepare(`DELETE FROM integraciones WHERE clave = ?`).bind(`imprenta_pendiente_${payload.documento_id}`),
    ]);
    await registrarEnvioImprentaDb(db, {
      documento_id: payload.documento_id,
      proveedor: cfg.proveedor,
      proveedor_tipo: PROVEEDOR_GENERICO,
      ambiente: cfg.ambiente,
      tipo_documento: payload.tipo_documento,
      numero_documento: numDocStr,
      numero_serie: cfg.serie,
      control_fiscal: rawCtrl,
      pdf_url: pdfSeguro,
      estado: "ENVIADO_OK",
      ultimo_error: "",
      idempotency_key: idempotencyKey,
      retornado_en: new Date().toISOString(),
    });
    return { ok: true, control_fiscal: rawCtrl, pdf_url: pdfSeguro, proveedor: cfg.proveedor, proveedor_tipo: PROVEEDOR_GENERICO, idempotency_key: idempotencyKey };
  } catch (err) {
    const errMsg = (err as Error).message || "Error de red o timeout con la Imprenta Digital";
    await registrarPendiente(errMsg);
    await registrarEnvioImprentaDb(db, {
      documento_id: payload.documento_id,
      proveedor: cfg.proveedor,
      proveedor_tipo: PROVEEDOR_GENERICO,
      ambiente: cfg.ambiente,
      tipo_documento: payload.tipo_documento,
      numero_documento: numDocStr,
      numero_serie: cfg.serie,
      control_fiscal: null,
      pdf_url: null,
      estado: "PENDIENTE",
      ultimo_error: errMsg,
      idempotency_key: idempotencyKey,
    });
    return { ok: false, control_fiscal: null, proveedor: cfg.proveedor, proveedor_tipo: PROVEEDOR_GENERICO, error: errMsg, idempotency_key: idempotencyKey };
  }
}

export async function anularFacturaImprentaDigital(
  db: D1Database,
  env: Record<string, unknown> | undefined,
  datos: {
    documento_id: number;
    tipo_documento?: "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO";
    numero_documento: number | string;
    control_fiscal: string;
    motivo?: string;
  },
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; omitido?: boolean; pdf_url?: string | null; error?: string }> {
  const cfg = await leerConfigImprentaCompleta(db, env);
  if (!cfg.url || !cfg.clave_clara) return { ok: true, omitido: true };
  if (cfg.proveedor_tipo === PROVEEDOR_CG) {
    try {
      return await anularFacturaCg(db, env, cfg, datos, fetchFn);
    } catch (err) {
      console.error("[imprenta-cg] anularFacturaCg:", err);
      return { ok: false, error: `Error inesperado anulando en CG: ${String((err as Error)?.message || err).slice(0, 180)}` };
    }
  }
  if (cfg.proveedor_tipo === PROVEEDOR_TFHKA) {
    try {
      return await anularDocumentoTfhka(db, env, cfg, datos, fetchFn);
    } catch (err) {
      console.error("[imprenta-tfhka] anularDocumentoTfhka:", err);
      return { ok: false, error: `Error inesperado anulando en The Factory HKA: ${String((err as Error)?.message || err).slice(0, 180)}` };
    }
  }
  await registrarEnvioImprentaDb(db, {
    documento_id: datos.documento_id,
    proveedor: cfg.proveedor,
    proveedor_tipo: PROVEEDOR_GENERICO,
    ambiente: cfg.ambiente,
    tipo_documento: "FACTURA",
    numero_documento: typeof datos.numero_documento === "number" ? numeroDocumentoCg(datos.numero_documento) : String(datos.numero_documento),
    numero_serie: cfg.serie,
    control_fiscal: datos.control_fiscal,
    pdf_url: null,
    estado: "ANULADO_OK",
    ultimo_error: "",
    anulado_en: new Date().toISOString(),
  });
  return { ok: true, omitido: true };
}

sistema.get("/imprenta", async (c) => c.json({ ok: true, ...(await leerImprenta(c.env.DB, c.env as unknown as Record<string, unknown>)) }));

sistema.get("/imprenta/estado", async (c) => {
  const db = c.env.DB, envObj = c.env as unknown as Record<string, unknown>;
  const estado = await obtenerResumenImprenta(db, envObj, fechaCaracas(), { incluirHistorial: true });
  return c.json({ ok: true, ...estado });
});

sistema.post("/imprenta", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  if (b.confirmo !== true && b.confirmo !== "on" && b.confirmo !== 1) {
    return falla(c, 400, "Marca la casilla «Estoy seguro» para guardar la configuración de la API de Imprenta Digital.");
  }
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.password ?? ""), u.password_hash))) return falla(c, 400, "La contraseña no es correcta.");

  const provTipoRaw = texto(b.proveedor_tipo, 24).toUpperCase();
  const proveedorTxt = texto(b.proveedor, 60);
  const urlRaw = texto(b.url, 200);
  const provTipo: TipoProveedorImprenta =
    provTipoRaw === PROVEEDOR_CG || (!provTipoRaw && /cg\s*imprenta|cgimprenta\.digital/i.test(`${proveedorTxt} ${urlRaw}`))
      ? PROVEEDOR_CG
      : provTipoRaw === PROVEEDOR_TFHKA ||
          (!provTipoRaw && /thefactoryhka\.com\.ve/i.test(urlRaw))
        ? PROVEEDOR_TFHKA
        : PROVEEDOR_GENERICO;

  const proveedor =
    proveedorTxt ||
    (provTipo === PROVEEDOR_CG
      ? "CG La Imprenta Digital"
      : provTipo === PROVEEDOR_TFHKA
        ? "The Factory HKA Venezuela"
        : "");
  if (proveedor.length < 2) return falla(c, 400, "Escribe el nombre de tu imprenta digital.");

  const valUrl = validarUrlImprentaSegura(urlRaw);
  if (!valUrl.ok) return falla(c, 400, valUrl.error);
  const urlFinal =
    provTipo === PROVEEDOR_CG
      ? normalizarHostCg(valUrl.url)
      : provTipo === PROVEEDOR_TFHKA
        ? normalizarHostTfhka(valUrl.url)
        : valUrl.url;

  const ambiente = texto(b.ambiente, 12).toUpperCase();
  if (!["PRUEBAS", "PRODUCCION"].includes(ambiente)) return falla(c, 400, "Elige el ambiente: pruebas o producción.");

  const usuarioApi = texto(b.usuario, 100);
  if ((provTipo === PROVEEDOR_CG || provTipo === PROVEEDOR_TFHKA) && !usuarioApi) {
    return falla(c, 400, `Indica el usuario de tu cuenta API en ${provTipo === PROVEEDOR_TFHKA ? "The Factory HKA" : "CG La Imprenta Digital"}.`);
  }
  const serie =
    provTipo === PROVEEDOR_TFHKA
      ? texto(b.serie, 10).toUpperCase().replace(/[^A-Z0-9_-]/g, "")
      : (texto(b.serie, 5) || "A").toUpperCase().replace(/[^A-Z0-9]/g, "") || "A";
  const sucursal = texto(b.sucursal, 10).replace(/[^A-Za-z0-9_-]/g, "");
  const reservarPrevio =
    b.reservar_previo === true || b.reservar_previo === 1 || b.reservar_previo === "1" || b.reservar_previo === "on"
      ? "1"
      : "0";

  const claveNueva = texto(b.clave, 200);
  const previa = (await db.prepare(`SELECT valor FROM integraciones WHERE clave = 'imprenta_clave'`).first<{ valor: string }>())?.valor;
  if (!claveNueva && !previa) return falla(c, 400, "Escribe la clave (contraseña API o token) de tu imprenta.");

  // Datos opcionales del Plan contratado y Fecha pagada
  const tienePlanEnBody =
    b.plan_cupo_total !== undefined ||
    b.plan_nombre !== undefined ||
    b.plan_fecha_pago !== undefined ||
    b.plan_fecha_vence !== undefined ||
    b.plan_consumo_previo !== undefined ||
    b.plan_nota !== undefined;

  const planNombre = texto(b.plan_nombre, 80);
  const planCupo = b.plan_cupo_total !== undefined && b.plan_cupo_total !== "" ? Math.trunc(Number(b.plan_cupo_total)) : null;
  if (planCupo !== null && (!Number.isFinite(planCupo) || planCupo < 0 || planCupo > 10_000_000)) {
    return falla(c, 400, "El cupo contratado debe ser un número entero mayor o igual a 0.");
  }
  const planPrevio = b.plan_consumo_previo !== undefined && b.plan_consumo_previo !== "" ? Math.trunc(Number(b.plan_consumo_previo)) : null;
  if (planPrevio !== null && (!Number.isFinite(planPrevio) || planPrevio < 0 || planPrevio > 10_000_000)) {
    return falla(c, 400, "El consumo previo debe ser un número entero mayor o igual a 0.");
  }
  const planFechaPago = texto(b.plan_fecha_pago, 10);
  if (planFechaPago && !/^\d{4}-\d{2}-\d{2}$/.test(planFechaPago)) {
    return falla(c, 400, "La fecha pagada del plan debe tener formato AAAA-MM-DD.");
  }
  const planFechaVence = texto(b.plan_fecha_vence, 10);
  if (planFechaVence && !/^\d{4}-\d{2}-\d{2}$/.test(planFechaVence)) {
    return falla(c, 400, "La fecha de vigencia/renovación debe tener formato AAAA-MM-DD.");
  }
  const planNota = texto(b.plan_nota, 200);

  const ahoraIso = new Date().toISOString();
  const pares: [string, string][] = [
    ["imprenta_proveedor_tipo", provTipo],
    ["imprenta_proveedor", proveedor],
    ["imprenta_url", urlFinal],
    ["imprenta_usuario", usuarioApi],
    ["imprenta_ambiente", ambiente],
    ["imprenta_serie", serie],
    ["imprenta_sucursal", sucursal],
    ["imprenta_reservar_previo", reservarPrevio],
  ];
  if (claveNueva) {
    pares.push(["imprenta_clave", await cifrarSecreto(claveNueva, envObj)]);
  }
  if (tienePlanEnBody) {
    if (b.plan_nombre !== undefined) pares.push(["imprenta_plan_nombre", planNombre]);
    if (planCupo !== null) pares.push(["imprenta_plan_cupo_total", String(planCupo)]);
    if (b.plan_fecha_pago !== undefined) pares.push(["imprenta_plan_fecha_pago", planFechaPago]);
    if (b.plan_fecha_vence !== undefined) pares.push(["imprenta_plan_fecha_vence", planFechaVence]);
    if (planPrevio !== null) pares.push(["imprenta_plan_consumo_previo", String(planPrevio)]);
    if (b.plan_nota !== undefined) pares.push(["imprenta_plan_nota", planNota]);
  }

  const pasos: D1PreparedStatement[] = pares.map(([k, val]) =>
    db
      .prepare(
        `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?)
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
      )
      .bind(k, val, ahoraIso)
  );
  // Al cambiar credenciales/URL invalidamos los JWT cacheados (CG y TFHKA) para forzar re-autenticación limpia
  pasos.push(
    db.prepare(
      `DELETE FROM integraciones WHERE clave IN (
         'imprenta_cg_jwt', 'imprenta_cg_jwt_exp', 'imprenta_cg_jwt_host', 'imprenta_cg_jwt_user',
         'imprenta_tfhka_jwt', 'imprenta_tfhka_jwt_exp', 'imprenta_tfhka_jwt_host', 'imprenta_tfhka_jwt_user', 'imprenta_tfhka_api_prefix'
       )`
    )
  );
  await db.batch(pasos);

  // Si es la primera vez que se registra un cupo > 0, dejar constancia en el historial de recargas
  if (planCupo !== null && planCupo > 0) {
    const yaRec = await db.prepare(`SELECT COUNT(*) AS n FROM imprenta_plan_recargas`).first<{ n: number }>().catch(() => ({ n: 1 }));
    if ((yaRec?.n ?? 0) === 0) {
      await db
        .prepare(
          `INSERT INTO imprenta_plan_recargas (plan_nombre, cantidad_numeros, fecha_pago, fecha_vence, monto_usd_centavos, referencia, nota, registrado_por, creado_en)
           VALUES (?, ?, ?, ?, 0, 'PLAN-INICIAL', ?, ?, ?)`
        )
        .bind(planNombre || `Lote ${planCupo} números`, planCupo, planFechaPago || fechaCaracas(), planFechaVence || null, planNota, yo.id, ahoraIso)
        .run()
        .catch(() => {});
    }
  }

  await auditar(c, yo.id, "IMPRENTA_CONFIG", `${provTipo}:${proveedor} ${ambiente} serie=${serie || "(vacía)"}${planCupo !== null ? ` cupo=${planCupo}` : ""}${claveNueva ? " (clave nueva)" : ""}`);
  const estado = await obtenerResumenImprenta(db, envObj, fechaCaracas(), { incluirHistorial: true });
  return c.json({ ok: true, ...(await leerImprenta(db, envObj)), imprenta_estado: estado });
});

sistema.post("/imprenta/recarga", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  if (b.confirmo !== true && b.confirmo !== "on" && b.confirmo !== 1) {
    return falla(c, 400, "Marca la casilla de confirmación para registrar la recarga de lote.");
  }
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.password ?? ""), u.password_hash))) return falla(c, 400, "La contraseña no es correcta.");

  const cantidad = Math.trunc(Number(b.cantidad_numeros));
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 10_000_000) {
    return falla(c, 400, "Indica la cantidad de números de control comprados (mínimo 1).");
  }
  const planNombre = texto(b.plan_nombre, 80) || `Recarga +${cantidad} números`;
  const fechaPago = texto(b.fecha_pago, 10) || fechaCaracas();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago)) return falla(c, 400, "La fecha pagada debe tener formato AAAA-MM-DD.");
  const fechaVence = texto(b.fecha_vence, 10);
  if (fechaVence && !/^\d{4}-\d{2}-\d{2}$/.test(fechaVence)) return falla(c, 400, "La fecha de vigencia debe tener formato AAAA-MM-DD.");
  const referencia = texto(b.referencia, 60);
  const nota = texto(b.nota, 200);
  const montoCent = Math.max(0, Math.round(Number(b.monto_usd_centavos ?? 0) || 0));

  const cfgActual = await leerConfigImprentaCompleta(db, envObj);
  const nuevoCupo = cfgActual.plan_cupo_total + cantidad;
  const ahoraIso = new Date().toISOString();

  const pasos: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO imprenta_plan_recargas (plan_nombre, cantidad_numeros, fecha_pago, fecha_vence, monto_usd_centavos, referencia, nota, registrado_por, creado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(planNombre, cantidad, fechaPago, fechaVence || null, montoCent, referencia, nota, yo.id, ahoraIso),
    db
      .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_plan_cupo_total', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
      .bind(String(nuevoCupo), ahoraIso),
    db
      .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_plan_nombre', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
      .bind(planNombre, ahoraIso),
    db
      .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_plan_fecha_pago', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
      .bind(fechaPago, ahoraIso),
  ];
  if (fechaVence) {
    pasos.push(
      db
        .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('imprenta_plan_fecha_vence', ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
        .bind(fechaVence, ahoraIso)
    );
  }
  await db.batch(pasos);
  await auditar(c, yo.id, "IMPRENTA_RECARGA", `+${cantidad} (total=${nuevoCupo}) plan=${planNombre} pago=${fechaPago}`);
  const estado = await obtenerResumenImprenta(db, envObj, fechaCaracas(), { incluirHistorial: true });
  return c.json({ ok: true, nuevo_cupo: nuevoCupo, imprenta_estado: estado });
});

sistema.post("/imprenta/probar", async (c) => {
  const db = c.env.DB, envObj = c.env as unknown as Record<string, unknown>;
  const cfg = await leerConfigImprentaCompleta(db, envObj);
  if (!cfg.url || !cfg.clave_clara) {
    return falla(c, 400, "Guarda primero las credenciales de tu Imprenta Digital antes de probar la conexión.");
  }
  if (cfg.proveedor_tipo === PROVEEDOR_TFHKA) {
    const res = await probarConexionTfhka(db, envObj, cfg);
    if (!res.ok) return falla(c, 502, res.error || "No se pudo validar la conexión con The Factory HKA.");
    await auditar(c, c.get("usuario").id, "IMPRENTA_PROBAR", `TFHKA OK (${cfg.ambiente})`);
    return c.json({ ...res, ok: true });
  }
  if (cfg.proveedor_tipo !== PROVEEDOR_CG) {
    return c.json({ ok: true, mensaje: `Proveedor genérico (${cfg.proveedor}) configurado en ${cfg.ambiente}. La validación en vivo está disponible para CG La Imprenta Digital y The Factory HKA Venezuela.` });
  }
  const res = await probarConexionCg(db, envObj, cfg);
  if (!res.ok) return falla(c, 502, res.error || "No se pudo validar la conexión con CG Imprenta Digital.");
  await auditar(c, c.get("usuario").id, "IMPRENTA_PROBAR", `CG OK (${cfg.ambiente})`);
  return c.json({ ...res, ok: true });
});

sistema.post("/imprenta/conciliar", async (c) => {
  const db = c.env.DB, b = await leerJson(c), envObj = c.env as unknown as Record<string, unknown>;
  const cfg = await leerConfigImprentaCompleta(db, envObj);
  if (!cfg.url || !cfg.clave_clara) {
    return falla(c, 400, "Configura primero tu API de Imprenta Digital.");
  }
  if (cfg.proveedor_tipo === PROVEEDOR_TFHKA) {
    const res = await conciliarDocumentosTfhka(db, envObj, cfg);
    if (!res.ok) return falla(c, 502, res.error || "No se pudo conciliar con The Factory HKA.");
    await auditar(c, c.get("usuario").id, "IMPRENTA_CONCILIAR", `TFHKA consultados=${res.consultados ?? 0} recuperados=${res.recuperados}`);
    const estado = await obtenerResumenImprenta(db, envObj, fechaCaracas(), { incluirHistorial: true });
    return c.json({ ok: true, conciliacion: res, imprenta_estado: estado });
  }
  if (cfg.proveedor_tipo !== PROVEEDOR_CG) {
    return falla(c, 400, "La conciliación automática contra servidores remotos está disponible para CG La Imprenta Digital y The Factory HKA Venezuela.");
  }
  const fechaInicio = texto(b.fechaInicio, 10);
  const fechaFin = texto(b.fechaFin, 10);
  const res = await conciliarDocumentosCg(db, envObj, cfg, { fechaInicio, fechaFin });
  if (!res.ok) return falla(c, 502, res.error || "No se pudo conciliar con CG Imprenta Digital.");
  await auditar(c, c.get("usuario").id, "IMPRENTA_CONCILIAR", `CG=${res.total_cg} local=${res.total_local} recuperados=${res.recuperados}`);
  const estado = await obtenerResumenImprenta(db, envObj, fechaCaracas(), { incluirHistorial: true });
  return c.json({ ok: true, conciliacion: res, imprenta_estado: estado });
});

sistema.post("/imprenta/numeraciones", async (c) => {
  const db = c.env.DB, envObj = c.env as unknown as Record<string, unknown>;
  const cfg = await leerConfigImprentaCompleta(db, envObj);
  if (!cfg.url || !cfg.clave_clara) {
    return falla(c, 400, "Configura primero tu API de Imprenta Digital.");
  }
  if (cfg.proveedor_tipo !== PROVEEDOR_TFHKA) {
    return c.json({
      ok: true,
      numeraciones: null,
      mensaje: "La consulta en línea de cupo (ConsultaNumeraciones) está disponible para The Factory HKA Venezuela. En CG La Imprenta Digital puedes ver el saldo en el módulo Indicadores de su portal.",
    });
  }
  const num = await consultarNumeracionesTfhka(db, envObj, cfg);
  if (!num.ok) return falla(c, 502, num.error || "No se pudo consultar el cupo de numeraciones en The Factory HKA.");
  return c.json({ ok: true, numeraciones: num });
});

sistema.post("/imprenta/certificar-tfhka", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  if (b.confirmo !== true && b.confirmo !== "on" && b.confirmo !== 1) {
    return falla(c, 400, "Marca la casilla de confirmación para ejecutar la suite de certificación Demo en The Factory HKA.");
  }
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.password ?? ""), u.password_hash))) {
    return falla(c, 400, "La contraseña no es correcta.");
  }

  const cfg = await leerConfigImprentaCompleta(db, envObj);
  if (cfg.proveedor_tipo !== PROVEEDOR_TFHKA) {
    return falla(c, 403, "La Suite de Certificación Demo aplica únicamente cuando el conector activo es The Factory HKA Venezuela.");
  }
  if (cfg.ambiente !== "PRUEBAS") {
    return falla(c, 403, "Bloqueado por seguridad fiscal: la Suite de Certificación The Factory HKA solo puede ejecutarse en ambiente PRUEBAS (Demo), jamás en PRODUCCION.");
  }
  if (!cfg.url || !cfg.usuario || !cfg.clave_clara) {
    return falla(c, 400, "Guarda primero las credenciales API de The Factory HKA Demo.");
  }

  const numInicio = Math.max(1, Math.min(99_999_000, Math.trunc(Number(b.numero_inicio ?? 100) || 100)));
  const incluirErrores = b.incluir_errores !== false;
  const perfil = await db
    .prepare(`SELECT rif, nombre_razon_social, email FROM perfil_emisor WHERE id = 1`)
    .first<{ rif: string; nombre_razon_social: string; email: string | null }>()
    .catch(() => null);

  const res = await ejecutarSuiteCertificacionTfhka(db, envObj, cfg, {
    numero_inicio: numInicio,
    rif_emisor: perfil?.rif,
    razon_emisor: perfil?.nombre_razon_social,
    email_prueba: texto(b.email_prueba, 120) || perfil?.email || undefined,
    incluir_errores: incluirErrores,
  });

  if (res.error && !res.resultados) {
    return falla(c, 502, res.error);
  }
  await auditar(
    c,
    yo.id,
    "IMPRENTA_TFHKA_CERTIFICAR",
    `inicio=${numInicio} ok=${res.resumen?.aprobados ?? 0}+err=${res.resumen?.errores_controlados_ok ?? 0}/${res.resumen?.total ?? 0} fail=${res.resumen?.fallidos ?? 0}`
  );
  return c.json(res);
});

sistema.post("/imprenta/certificar-cg", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  if (b.confirmo !== true && b.confirmo !== "on" && b.confirmo !== 1) {
    return falla(c, 400, "Marca la casilla de confirmación para ejecutar la suite de certificación en CG La Imprenta Digital (Calidad).");
  }
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.password ?? ""), u.password_hash))) {
    return falla(c, 400, "La contraseña no es correcta.");
  }

  const cfg = await leerConfigImprentaCompleta(db, envObj);
  if (cfg.proveedor_tipo !== PROVEEDOR_CG) {
    return falla(c, 403, "La Suite de Certificación CG aplica únicamente cuando el conector activo es CG La Imprenta Digital.");
  }
  if (cfg.ambiente !== "PRUEBAS") {
    return falla(c, 403, "Bloqueado por seguridad fiscal: la Suite de Certificación CG solo puede ejecutarse en ambiente PRUEBAS (Calidad), jamás en PRODUCCION.");
  }
  if (!cfg.url || !cfg.usuario || !cfg.clave_clara) {
    return falla(c, 400, "Guarda primero las credenciales API de CG La Imprenta Digital (Calidad).");
  }

  const numInicio = Math.max(1, Math.min(99_999_000, Math.trunc(Number(b.numero_inicio ?? 100) || 100)));
  const incluirAnulacion = b.incluir_anulacion !== false;
  const incluirErrores = b.incluir_errores !== false;
  const perfil = await db
    .prepare(`SELECT rif, nombre_razon_social, email FROM perfil_emisor WHERE id = 1`)
    .first<{ rif: string; nombre_razon_social: string; email: string | null }>()
    .catch(() => null);

  const res = await ejecutarSuiteCertificacionCg(db, envObj, cfg, {
    numero_inicio: numInicio,
    rif_emisor: perfil?.rif,
    razon_emisor: perfil?.nombre_razon_social,
    email_prueba: texto(b.email_prueba, 120) || perfil?.email || undefined,
    incluir_anulacion: incluirAnulacion,
    incluir_errores: incluirErrores,
  });

  if (res.error && !res.resultados) {
    return falla(c, 502, res.error);
  }
  await auditar(
    c,
    yo.id,
    "IMPRENTA_CG_CERTIFICAR",
    `inicio=${numInicio} ok=${res.resumen?.aprobados ?? 0}+err=${res.resumen?.errores_controlados_ok ?? 0}/${res.resumen?.total ?? 0} fail=${res.resumen?.fallidos ?? 0}`
  );
  return c.json(res);
});

// SERVICIO DE CORREO ELECTRÓNICO (Resend / Brevo) para enviar facturas a clientes y recuperación jerárquica de claves.
sistema.get("/correo", async (c) => {
  const db = c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const [cfg, perfil] = await Promise.all([
    leerConfigCorreo(db, envObj),
    db.prepare(`SELECT nombre_razon_social, email FROM perfil_emisor WHERE id = 1`).first<{ nombre_razon_social: string; email: string | null }>().catch(() => null),
  ]);
  return c.json({
    ok: true,
    proveedor: cfg.proveedor,
    remitente: cfg.remitente,
    nombre_remitente: cfg.nombre_remitente,
    clave_configurada: !!cfg.clave,
    clave_final: cfg.clave ? cfg.clave.slice(-4) : "",
    modo_plataforma: cfg.modo_plataforma,
    proveedores_plataforma: cfg.proveedores_plataforma,
    remitente_plataforma: cfg.remitente_plataforma,
    nombre_plataforma: cfg.nombre_plataforma,
    negocio_nombre: perfil?.nombre_razon_social || "",
    reply_to: perfil?.email || "",
  });
});

sistema.post("/correo", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario"), envObj = c.env as unknown as Record<string, unknown>;
  if (!esSuperAdmin(yo.rol, yo.email, envObj)) {
    return falla(c, 403, "El envío de correos es gestionado por FacturaYa Venezuela (Correo de Plataforma). No necesitas configurar API Keys propias.");
  }
  if (b.confirmo !== true && b.confirmo !== "on" && b.confirmo !== 1) {
    return falla(c, 400, "Marca la casilla «Estoy seguro» para guardar la configuración de la API de Correo.");
  }
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.password ?? ""), u.password_hash))) return falla(c, 400, "La contraseña no es correcta.");
  const proveedor = texto(b.proveedor, 20).toUpperCase() === "BREVO" ? "BREVO" : "RESEND";
  const remitente = texto(b.remitente, 120).toLowerCase();
  const nombre_remitente = texto(b.nombre_remitente, 80);
  const clave = texto(b.clave, 200);
  if (!EMAIL.test(remitente)) return falla(c, 400, "Escribe un correo remitente válido (ejemplo: facturacion@tudominio.com o onboarding@resend.dev).");
  const previa = (await db.prepare(`SELECT valor FROM integraciones WHERE clave = 'correo_clave'`).first<{ valor: string }>())?.valor;
  if (!clave && !previa) return falla(c, 400, `Escribe la API Key de ${proveedor}.`);
  const ahora = new Date().toISOString();
  const pares: [string, string][] = [
    ["correo_proveedor", proveedor],
    ["correo_remitente", remitente],
    ["correo_nombre_remitente", nombre_remitente],
  ];
  if (clave) pares.push(["correo_clave", await cifrarSecreto(clave, envObj)]);
  await db.batch(
    pares.map(([k, val]) =>
      db.prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`).bind(k, val, ahora)
    )
  );
  await auditar(c, yo.id, "CORREO_CONFIG", `${proveedor} <${remitente}>${clave ? " (API key actualizada)" : ""}`);
  const cfg = await leerConfigCorreo(db, envObj);
  return c.json({ ok: true, proveedor: cfg.proveedor, remitente: cfg.remitente, nombre_remitente: cfg.nombre_remitente, clave_configurada: !!cfg.clave, clave_final: cfg.clave ? cfg.clave.slice(-4) : "" });
});

sistema.post("/correo/probar", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario");
  const destino = texto(b.para || yo.email, 120).toLowerCase();
  if (!EMAIL.test(destino)) return falla(c, 400, "Escribe un correo de destino válido.");
  const r = await enviarCorreo(db, c.env as unknown as Record<string, unknown>, {
    para: destino,
    alcance: "PLATAFORMA",
    tipo: "PRUEBA",
    asunto: "✅ Prueba de correo · FacturaYa Venezuela",
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #dde3ec;border-radius:16px">
      <h2 style="margin:0 0 12px;color:#1A73E8">✉️ Servicio de correo activo</h2>
      <p>Tu configuración de correo en <b>FacturaYa Venezuela</b> (<a href="https://facturayave.com" style="color:#1A73E8">facturayave.com</a>) funciona correctamente.</p>
      <p style="font-size:13px;color:#5f6b7a">Ya puedes enviar facturas, presupuestos y notas de crédito con PDF adjunto a tus clientes, así como recibir recuperaciones de contraseña.</p>
    </div>`,
    texto: "Servicio de correo activo en FacturaYa Venezuela (https://facturayave.com). Ya puedes enviar facturas a tus clientes y recuperar contraseñas por correo.",
  });
  if (!r.ok) return falla(c, 400, r.error);
  await auditar(c, yo.id, "CORREO_PRUEBA", destino);
  return c.json({ ok: true, destino, proveedor: r.proveedor });
});

sistema.post("/medio", async (c) => {
  const db = c.env.DB, b = await leerJson(c), yo = c.get("usuario");
  const medio = texto(b.medio, 20), motivo = texto(b.motivo, 300);
  if (!MEDIOS.includes(medio)) return falla(c, 400, "Elige Aplicación Digital SENIAT o Imprenta Digital.");
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.clave ?? ""), u.password_hash))) return falla(c, 400, "La contraseña no es correcta.");
  if (motivo.length < 5) return falla(c, 400, "Escribe el motivo del cambio (mínimo 5 letras).");
  if (b.confirmo !== true) return falla(c, 400, "Confirma que entiendes el cambio.");
  const actual = (await db.prepare(`SELECT medio_facturacion AS m FROM perfil_emisor WHERE id = 1`).first<{ m: string }>())?.m ?? "APP_SENIAT";
  if (actual === medio) return falla(c, 409, "Esa ya es tu modalidad de facturación.");
  await db.batch([
    db.prepare(`UPDATE perfil_emisor SET medio_facturacion = ? WHERE id = 1 AND medio_facturacion = ?`).bind(medio, actual),
    db.prepare(`INSERT INTO medio_historial (medio_anterior, medio_nuevo, motivo, cambiado_por, cambiado_en) VALUES (?, ?, ?, ?, ?)`).bind(actual, medio, motivo, yo.id, new Date().toISOString()),
  ]);
  await auditar(c, yo.id, "MEDIO_FACTURACION", `${actual} -> ${medio}`);
  return c.json({ ok: true, medio });
});

// REINICIAR BASE DE DATOS DE FÁBRICA (EXCLUSIVO DEL SÚPER ADMINISTRADOR):
// elimina triggers y tablas del inquilino actual y vuelve a correr las migraciones desde cero para dejar el negocio recién instalado.
sistema.post("/reiniciar-fabrica", async (c) => {
  const db = c.env.DB, rawDb = c.get("rawDb") || db, inqCod = c.get("inquilinoCodigo") || "principal";
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c), yo = c.get("usuario");
  if (!esSuperAdmin(yo.rol, yo.email, envObj)) {
    return falla(c, 403, "Solo el Súper Administrador del sistema tiene permiso para reiniciar la base de datos de fábrica.");
  }
  if (b.confirmo !== true) return falla(c, 400, "Marca la casilla de confirmación para borrar toda la base de datos.");
  const modo = await modoActual(db).catch(() => "PRACTICA");
  const cob = await obtenerFirmaCoberturaReal(db);
  const realesN = cob.n;
  if (inqCod === "principal" || (modo === "REAL" && realesN > 0)) {
    if (texto(b.frase_confirmacion, 40) !== "REINICIAR-DEFINITIVAMENTE") {
      return falla(c, 400, "Por seguridad fiscal SENIAT, escribe exactamente REINICIAR-DEFINITIVAMENTE para confirmar el borrado.");
    }
  }
  if (modo === "REAL" && realesN > 0) {
    const respLocal = await db
      .prepare(`SELECT valor FROM integraciones WHERE clave = 'ultimo_respaldo_descargado'`)
      .first<{ valor: string }>()
      .catch(() => null);
    const cobLocal = await db
      .prepare(`SELECT valor FROM integraciones WHERE clave = 'ultimo_respaldo_cobertura'`)
      .first<{ valor: string }>()
      .catch(() => null);
    const respInq = await rawDb
      .prepare(`SELECT respaldo_descargado_en FROM _mt_inquilinos WHERE codigo = ?`)
      .bind(inqCod)
      .first<{ respaldo_descargado_en?: string | null }>()
      .catch(() => null);
    if (!respLocal?.valor && !respInq?.respaldo_descargado_en) {
      return falla(
        c,
        409,
        "⚠️ Candado de Respaldo Obligatorio: Esta empresa tiene documentos fiscales REALES emitidos. Descarga primero el respaldo completo («📦 Guardar respaldo ahora» o «📦 1. Descargar BD Cliente») para entregárselo al cliente antes de vaciar o dar de baja su base de datos."
      );
    }
    const cobInq = respInq?.respaldo_descargado_en?.includes("|") ? respInq.respaldo_descargado_en.split("|")[1] : "";
    const coberturaCoincide = cobLocal?.valor === cob.firma || cobInq === cob.firma;
    if (!coberturaCoincide) {
      return falla(
        c,
        409,
        "⚠️ Candado de Respaldo Obligatorio: Se emitieron nuevos documentos fiscales REALES después del último respaldo descargado. Descarga un respaldo completo actualizado antes de reiniciar la base de datos."
      );
    }
  }
  const u = await db.prepare(`SELECT password_hash FROM usuarios WHERE id = ?`).bind(yo.id).first<{ password_hash: string }>();
  if (!u || !(await verificarClave(String(b.clave ?? ""), u.password_hash))) return falla(c, 400, "La contraseña del Súper Administrador no es correcta.");

  let d1UuidRemota: string | null = null;
  if (inqCod !== "principal") {
    await hidratarBindingsCloudflare(rawDb, envObj);
    const infoInq = await rawDb
      .prepare(`SELECT d1_uuid FROM _mt_inquilinos WHERE codigo = ?`)
      .bind(inqCod)
      .first<{ d1_uuid?: string | null }>()
      .catch(() => null);
    d1UuidRemota = infoInq?.d1_uuid ?? null;
  }

  const triggersConocidos = [
    "doc_no_borrar", "doc_inmutable",
    "documento_renglones_insert_emitido", "documento_renglones_update_emitido", "documento_renglones_delete_emitido",
    "documento_impuestos_insert_emitido", "documento_impuestos_update_emitido", "documento_impuestos_delete_emitido",
    "renglon_no_cambiar", "renglon_no_borrar",
    "impuesto_no_cambiar", "impuesto_no_borrar", "pago_no_borrar", "pago_inmutable",
    "mov_no_cambiar", "mov_no_borrar", "compra_no_borrar", "compra_inmutable",
    "compra_impuestos_no_cambiar", "compra_impuestos_no_borrar",
  ];
  await db.batch(triggersConocidos.map((t) => db.prepare(`DROP TRIGGER IF EXISTS ${t}`))).catch(() => {});
  const ordenTablas = [
    "pagos", "movimientos_stock", "compra_impuestos", "compras", "compras_vieja",
    "documento_impuestos", "documento_renglones", "documentos", "catalogo", "clientes", "proveedores",
    "imprenta_envios", "imprenta_plan_recargas", "correo_envios",
    "medio_historial", "metodos_cobro", "integraciones", "parametros_fiscales", "contadores", "ajustes",
    "verificaciones", "auditoria", "intentos_login", "sesiones", "usuarios", "emisor_logos", "perfil_emisor", "_migraciones",
  ];
  await db.batch(ordenTablas.map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`))).catch(() => {});
  if (inqCod === "principal") {
    await migrar(db);
    await rawDb.prepare(`DELETE FROM _mt_inquilinos WHERE codigo = 'principal'`).run().catch(() => {});
    await rawDb.prepare(`DELETE FROM _mt_directorio WHERE inquilino_codigo = 'principal'`).run().catch(() => {});
    await rawDb.prepare(`DELETE FROM _mt_super_vista`).run().catch(() => {});
  } else {
    const uuidPrincipal = obtenerUuidBdPrincipal(envObj);
    if (d1UuidRemota && (!uuidPrincipal || d1UuidRemota !== uuidPrincipal)) {
      await eliminarBaseD1EnCloudflare(rawDb, envObj, d1UuidRemota).catch(() => {});
      delete envObj[inqCod];
    }
    // Al borrar un inquilino secundario, eliminar su registro y devolver al Súper Admin a 'principal' con su sesión intacta
    await rawDb.prepare(`DELETE FROM _mt_inquilinos WHERE codigo = ?`).bind(inqCod).run().catch(() => {});
    await rawDb.prepare(`DELETE FROM _mt_directorio WHERE inquilino_codigo = ?`).bind(inqCod).run().catch(() => {});
    await fijarVistaSuperAdmin(rawDb, "principal", yo.email, envObj);
    const tok = getCookie(c, "sid");
    const uPrin = await obtenerSuperAdminPrincipal(rawDb, envObj);
    if (tok && uPrin) {
      await rawDb.prepare(`INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)`)
        .bind(await sha256(tok), uPrin.id, ahora() + 7 * 86400).run().catch(() => {});
    }
    const url = new URL(c.req.url);
    const esHttps = c.req.header("x-forwarded-proto") === "https" || url.protocol === "https:";
    const enIframePreview = url.hostname.endsWith(".run.app");
    setCookie(c, "inq", "principal", {
      httpOnly: true, sameSite: enIframePreview && esHttps ? "None" : "Lax", path: "/", maxAge: 7 * 86400,
      secure: enIframePreview ? esHttps : url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    });
  }
  return c.json({ ok: true, regreso_a_principal: inqCod !== "principal" });
});

// Copia completa (o filtrada por ?anio=YYYY para bases multi-anuales grandes) de los datos del negocio actual.
sistema.get("/respaldo", async (c) => {
  const db = c.env.DB, rawDb = c.get("rawDb") || db, inqCod = c.get("inquilinoCodigo") || "principal";
  const envObj = c.env as unknown as Record<string, unknown>;
  const anioParam = Number(c.req.query("anio") || 0);
  const anio = Number.isInteger(anioParam) && anioParam >= 2000 && anioParam <= 2100 ? anioParam : undefined;
  const respaldo = await generarRespaldoNegocio(db, { ...(anio ? { anio } : {}), env: envObj });
  if (!anio) {
    const ahoraIso = new Date().toISOString();
    const firmaCob = respaldo.cobertura_real?.firma ?? "0:0";
    await db
      .batch([
        db
          .prepare(
            `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('ultimo_respaldo_descargado', ?, ?)
             ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
          )
          .bind(ahoraIso, ahoraIso),
        db
          .prepare(
            `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('ultimo_respaldo_cobertura', ?, ?)
             ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
          )
          .bind(firmaCob, ahoraIso),
      ])
      .catch(() => {});
    await rawDb
      .prepare(`UPDATE _mt_inquilinos SET respaldo_descargado_en = ? WHERE codigo = ?`)
      .bind(`${ahoraIso}|${firmaCob}`, inqCod)
      .run()
      .catch(() => {});
  }
  await auditar(c, c.get("usuario").id, "RESPALDO", anio ? `Año ${anio}` : "Completo");
  const sufijoAnio = anio ? `-${anio}` : "";
  return new Response(JSON.stringify(respaldo), { headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="respaldo${sufijoAnio}-${fechaCaracas()}.json"` } });
});

export default sistema;
