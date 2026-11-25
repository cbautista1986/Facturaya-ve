// Módulo INQUILINOS (Multi-Tenant · Exclusivo del Súper Administrador): /api/inquilinos
// Permite dar de alta nuevos clientes/negocios con ranuras estándar D1 dedicadas (DB_1, DB_2... hasta DB_9 en plan gratis y más en Pro),
// controlar y crear bases de datos D1 directamente en Cloudflare vía API sin entrar a dash.cloudflare.com,
// descargar el respaldo individual de un cliente para entregárselo al finalizar su contrato,
// y dar de baja definitiva a un ex-cliente liberando su base D1 y su ranura DB_X para el próximo cliente.
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { aRifSeniat, aTasaE8 } from "../../public/dinero.js";
import {
  MESES_PROMO_DEFECTO,
  PRECIO_PROMO_DEFECTO_CENT,
  PRECIO_REGULAR_DEFECTO_CENT,
  calcularCobroSuscripcion,
  emitirYEnviarCobroSaas,
  registrarPagoCobroSaas,
  type FilaCobroSaas,
} from "../suscripciones";
import { cifrarSecreto, exigirLlaveMaestra } from "../cifrado";
import { normalizarHostCg, PROVEEDOR_CG, PROVEEDOR_GENERICO, validarUrlImprentaSegura, type TipoProveedorImprenta } from "../imprenta-cg";
import {
  consultarDesplieguesYBuilds,
  consultarEstadoCloudflare,
  consultarLogBuildCloudflare,
  crearBaseD1EnCloudflare,
  crearDbCloudflareHttp,
  descubrirAccountIdCloudflare,
  eliminarBaseD1EnCloudflare,
  guardarConfigCloudflare,
  leerConfigCloudflare,
  obtenerUuidBdPrincipal,
  relanzarBuildCloudflare,
  rollbackWorkerCloudflare,
  sincronizarBindingsD1Cloudflare,
} from "../cloudflare-api";
import {
  activarModoMantenimientoDespliegue,
  actualizarEtapaDespliegue,
  configurarCorreoResumenMantenimiento,
  desactivarModoMantenimientoDespliegue,
  ejecutarMantenimientoNocturno,
  esHorarioDiurnoCaracas,
  guardarLogMantenimiento,
  horaCaracas,
  leerEstadoMantenimiento,
  listarLogsMantenimiento,
} from "../mantenimiento";
import { EMAIL, RIF, ahora, auditar, falla, fechaCaracas, leerJson, requiereSesion, texto, type Env } from "../comun";
import { enviarCorreo } from "../correo";
import {
  asegurarTablasMultiTenant,
  eliminarInquilinoDefinitivo,
  esCorreoSuperAdmin,
  fijarVistaSuperAdmin,
  generarListaRanurasD1,
  generarWranglerTomlBindings,
  hidratarBindingsCloudflare,
  invalidarCacheInquilinos,
  obtenerDbInquilino,
  obtenerSuperAdminPrincipal,
  registrarCorreoDirectorio,
  siguienteRanuraD1Libre,
  tieneBindingDedicado,
  type InquilinoInfo,
} from "../inquilinos";
import { migrar } from "../migraciones";
import { NOMBRE_ROL, esSuperAdmin } from "../permisos";
import { reglasRegimen, validarTipoContribuyenteEstricto } from "../regimen";
import { claveR2Valida, ejecutarRespaldoR2, listarRespaldosR2, obtenerBucketR2 } from "../respaldos-r2";
import { diagnosticarTodoElSistema, generarRespaldoMaestro, generarRespaldoNegocio, obtenerFirmaCoberturaReal, repararInquilino } from "../salud-bd";
import { CLAVE_FALSA, claveTemporal, codigoRecuperacion, hashClave, normalizarCodigo, sha256, verificarClave } from "../seguridad";

const inquilinos = new Hono<Env>();
inquilinos.use("*", requiereSesion);

inquilinos.use("*", async (c, next) => {
  const yo = c.get("usuario");
  const envObj = c.env as unknown as Record<string, unknown>;
  if (!esSuperAdmin(yo.rol, yo.email, envObj)) {
    return falla(c, 403, "Acceso exclusivo para el Súper Administrador de FacturaYa Venezuela.");
  }
  await next();
});

async function verificarClaveSuperAdmin(rawDb: D1Database, clave: string, envObj: Record<string, unknown>): Promise<boolean> {
  if (!clave) return false;
  const u = await obtenerSuperAdminPrincipal(rawDb, envObj);
  return verificarClave(clave, u?.password_hash ?? CLAVE_FALSA);
}

// Lista todos los negocios (inquilinos), cuál está viendo actualmente el Súper Admin y qué ranuras estándar D1 existen (DB_1..DB_9)
inquilinos.get("/", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const yo = c.get("usuario");
  await asegurarTablasMultiTenant(rawDb);
  await hidratarBindingsCloudflare(rawDb, envObj);

  const { results } = await rawDb
    .prepare(
      `SELECT codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, cedula_dueno, zona_postal, firma_personal, respaldo_descargado_en, medio_facturacion, tipo_contribuyente, plan_usd,
              COALESCE(NULLIF(fecha_alta, ''), substr(creado_en, 1, 10)) AS fecha_alta,
              COALESCE(precio_promo_usd_cent, 500) AS precio_promo_usd_cent,
              COALESCE(meses_promo, 3) AS meses_promo,
              COALESCE(precio_regular_usd_cent, 1000) AS precio_regular_usd_cent,
              COALESCE(cobro_auto_dia1, 0) AS cobro_auto_dia1,
              COALESCE(motivo_suspension, '') AS motivo_suspension,
              activo, creado_en, d1_uuid, d1_nombre
       FROM _mt_inquilinos ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en DESC`
    )
    .all<InquilinoInfo>();
  const vista = await rawDb
    .prepare(`SELECT inquilino_codigo FROM _mt_super_vista WHERE email = ?`)
    .bind(yo.email.trim().toLowerCase())
    .first<{ inquilino_codigo: string }>();

  await rawDb.prepare(`DELETE FROM _mt_directorio WHERE inquilino_codigo NOT IN (SELECT codigo FROM _mt_inquilinos) AND inquilino_codigo <> 'DB_DEMO'`).run().catch(() => {});
  // Sincronizar en caliente todos los correos de usuarios de cada empresa (cuando <= 25 empresas para cuidar cuota de subrequests)
  if (results.length <= 25) {
    for (const inq of results) {
      try {
        const dbInq = inq.codigo === "principal" ? rawDb : obtenerDbInquilino({ ...envObj, DB: rawDb }, inq.codigo);
        const usrs = await dbInq.prepare(`SELECT email, rol FROM usuarios`).all<{ email: string; rol: string }>();
        for (const u of usrs.results || []) {
          if (u.email) {
            await registrarCorreoDirectorio(rawDb, u.email, inq.codigo, u.rol, envObj);
          }
        }
      } catch {
        // Si alguna base remota aún no responde, conservamos los registros existentes en _mt_directorio
      }
    }
  }

  const dirRows = await rawDb
    .prepare(
      `SELECT d.email, d.inquilino_codigo, d.rol, COALESCE(i.nombre_negocio, d.inquilino_codigo) AS nombre_negocio
       FROM _mt_directorio d LEFT JOIN _mt_inquilinos i ON i.codigo = d.inquilino_codigo
       ORDER BY CASE WHEN d.inquilino_codigo = 'principal' THEN 0 ELSE 1 END, d.email ASC`
    )
    .all<{ email: string; inquilino_codigo: string; rol: string; nombre_negocio: string }>();

  const ocupadas = new Map(results.map((r) => [r.codigo.toUpperCase(), r]));
  const cfgCf = await leerConfigCloudflare(rawDb, envObj);
  const esPlan5Usd = cfgCf.plan_d1 === "PRO_5USD" || results.length > 10;
  const listaCodigosD1 = generarListaRanurasD1(ocupadas.keys(), 5, esPlan5Usd);

  const bindingsFisicos: string[] = [];
  const maxCheckBinding = Math.max(20, listaCodigosD1.length + 2);
  for (let i = 1; i <= maxCheckBinding; i++) {
    const k = `DB_${i}`;
    if (tieneBindingDedicado(envObj, k)) bindingsFisicos.push(k);
  }

  const ranurasDisponibles = listaCodigosD1.map((codigo) => {
    const inq = ocupadas.get(codigo);
    return {
      codigo,
      nombre_bd_sugerido: `facturaya_${codigo.toLowerCase()}`,
      ocupada: !!inq,
      inquilino_nombre: inq?.nombre_negocio ?? null,
      inquilino_rif: inq?.rif ?? null,
      d1_uuid: inq?.d1_uuid ?? null,
      binding_activo: tieneBindingDedicado(envObj, codigo),
    };
  });

  const proximaRanura = await siguienteRanuraD1Libre(rawDb);
  const limiteD1 = esPlan5Usd ? 50_000 : 10;
  const usadasD1 = results.length;
  const libresD1 = Math.max(0, limiteD1 - usadasD1);

  const hoy = fechaCaracas();
  const periodoActual = hoy.slice(0, 7);
  const perfilPrin = await rawDb
    .prepare(`SELECT tasa_bcv, medio_facturacion, tipo_contribuyente, igtf_activo FROM perfil_emisor WHERE id = 1`)
    .first<{ tasa_bcv?: number; medio_facturacion?: string; tipo_contribuyente?: string; igtf_activo?: number }>()
    .catch(() => null);
  const tasaE8Prin = aTasaE8(String(perfilPrin?.tasa_bcv ?? ""));
  const alicuotaPrin = reglasRegimen(perfilPrin?.tipo_contribuyente, perfilPrin?.igtf_activo).cobraIva ? 1600 : 0;

  const { results: todosCobros } = await rawDb
    .prepare(`SELECT * FROM _mt_cobros_saas ORDER BY periodo_ym DESC, id DESC LIMIT 400`)
    .all<FilaCobroSaas>()
    .catch(() => ({ results: [] as FilaCobroSaas[] }));
  const cobrosPorInq = new Map<string, FilaCobroSaas[]>();
  for (const cb of todosCobros || []) {
    const arr = cobrosPorInq.get(cb.inquilino_codigo) || [];
    if (arr.length < 6) arr.push(cb);
    cobrosPorInq.set(cb.inquilino_codigo, arr);
  }

  const inquilinosEnriquecidos = results.map((r) => {
    const recientes = cobrosPorInq.get(r.codigo) || [];
    const cobroActual = recientes.find((x) => x.periodo_ym === periodoActual) || null;
    let proyeccion = null;
    if (r.codigo !== "principal" && tasaE8Prin && !Number.isNaN(tasaE8Prin) && tasaE8Prin > 0) {
      try {
        proyeccion = calcularCobroSuscripcion({
          fecha_alta: String(r.fecha_alta || hoy).slice(0, 10),
          periodo_ym: periodoActual,
          precio_promo_usd_cent: Number(r.precio_promo_usd_cent ?? PRECIO_PROMO_DEFECTO_CENT),
          meses_promo: Number(r.meses_promo ?? MESES_PROMO_DEFECTO),
          precio_regular_usd_cent: Number(r.precio_regular_usd_cent ?? PRECIO_REGULAR_DEFECTO_CENT),
          tasa_e8: tasaE8Prin,
          alicuota_cent: alicuotaPrin,
        });
      } catch {
        proyeccion = null;
      }
    }
    return {
      ...r,
      cobro_mes_actual: cobroActual,
      cobros_recientes: recientes,
      proyeccion_mes: proyeccion,
    };
  });

  return c.json({
    ok: true,
    inquilino_actual: vista?.inquilino_codigo || "principal",
    inquilinos: inquilinosEnriquecidos,
    directorio: dirRows.results,
    bindings_fisicos: bindingsFisicos,
    ranuras_d1: ranurasDisponibles,
    proxima_ranura: proximaRanura,
    cloudflare_configurado: cfgCf.configurado,
    plan_d1: esPlan5Usd ? "PRO_5USD" : "GRATIS",
    limite_d1: limiteD1,
    usadas_d1: usadasD1,
    libres_d1: libresD1,
    periodo_actual: periodoActual,
    tasa_bcv_principal: Number(perfilPrin?.tasa_bcv || 0),
    medio_principal: perfilPrin?.medio_facturacion === "IMPRENTA_DIGITAL" ? "IMPRENTA_DIGITAL" : "APP_SENIAT",
  });
});

// Dar de alta e inicializar un nuevo negocio/cliente estandarizado en DB_1, DB_2... (con todos sus datos RIF SENIAT, Cédula, Contacto, Logo opcional y APIs opcionales)
inquilinos.post("/", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  await asegurarTablasMultiTenant(rawDb);
  const b = await leerJson(c, 380_000);
  if (b.__demasiadoGrande) return falla(c, 413, "La ficha o el logo exceden el tamaño permitido.");

  const nombre_negocio = texto(b.nombre_negocio ?? b.nombre_razon_social, 140);
  const rifEntrada = texto(b.rif, 20).toUpperCase();
  const rif = aRifSeniat(rifEntrada);
  const firma_personal = texto(b.firma_personal, 140) || null;
  const direccion = texto(b.direccion ?? b.direccion_fiscal, 260);
  const zona_postal = texto(b.zona_postal, 20) || null;
  const sector_seniat = texto(b.sector_seniat, 180) || null;
  const rif_comprobante = texto(b.rif_comprobante, 40) || null;
  const rif_fecha_inscripcion = texto(b.rif_fecha_inscripcion, 20) || null;
  const rif_fecha_actualizacion = texto(b.rif_fecha_actualizacion, 20) || null;
  const rif_codigo_firma = texto(b.rif_codigo_firma, 40) || null;

  const nombre_dueno = texto(b.nombre_dueno, 120);
  const cedula_dueno = texto(b.cedula_dueno ?? b.representante_cedula, 25).toUpperCase() || null;
  const representante_fecha_nac = texto(b.representante_fecha_nac, 20) || null;
  const representante_estado_civil = texto(b.representante_estado_civil, 30) || null;
  const representante_cedula_venc = texto(b.representante_cedula_venc, 20) || null;
  const telefono = texto(b.telefono, 40);
  const email_dueno = texto(b.email_dueno, 120).toLowerCase();

  const logoRaw = String(b.logo_base64 ?? "").trim();
  if (logoRaw && (!/^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(logoRaw) || logoRaw.length > 220_000)) {
    return falla(c, 400, "El logo debe ser una imagen PNG o JPG válida (máximo 150 KB).");
  }
  const logo_base64 = logoRaw || null;

  const medio_facturacion = texto(b.medio_facturacion, 20) === "IMPRENTA_DIGITAL" ? "IMPRENTA_DIGITAL" : "APP_SENIAT";
  const tipoContribRaw = texto(b.tipo_contribuyente, 20);
  const tipo_contribuyente = tipoContribRaw ? validarTipoContribuyenteEstricto(tipoContribRaw) : "ORDINARIO";
  if (!tipo_contribuyente) return falla(c, 400, "Tipo de contribuyente no válido. Elige FORMAL, ORDINARIO o ESPECIAL.");
  const igtf_activo = tipo_contribuyente === "ESPECIAL" ? 1 : 0;
  const modo_inicial = texto(b.modo_inicial, 12) === "PRACTICA" ? "PRACTICA" : "REAL";
  const plan_usd = Math.max(0, Math.min(999, Number(b.plan_usd ?? b.precio_regular_usd ?? 10) || 10));
  const fechaAltaRaw = texto(b.fecha_alta, 20);
  const fecha_alta = /^\d{4}-\d{2}-\d{2}$/.test(fechaAltaRaw) ? fechaAltaRaw : fechaCaracas();
  const aCentUsd = (val: unknown, defecto: number) => {
    if (val === undefined || val === null || String(val).trim() === "") return defecto;
    const n = Number(String(val).replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 9999) return defecto;
    return Math.round(n * 100);
  };
  const precio_promo_usd_cent = aCentUsd(b.precio_promo_usd, PRECIO_PROMO_DEFECTO_CENT);
  const precio_regular_usd_cent = aCentUsd(b.precio_regular_usd ?? b.plan_usd, PRECIO_REGULAR_DEFECTO_CENT);
  const mesesPromoNum = b.meses_promo === undefined || b.meses_promo === null || String(b.meses_promo).trim() === ""
    ? MESES_PROMO_DEFECTO
    : Math.trunc(Number(b.meses_promo));
  const meses_promo = Number.isInteger(mesesPromoNum) && mesesPromoNum >= 0 && mesesPromoNum <= 36 ? mesesPromoNum : MESES_PROMO_DEFECTO;
  const cobro_auto_dia1 = b.cobro_auto_dia1 === true || b.cobro_auto_dia1 === 1 || b.cobro_auto_dia1 === "1" || b.cobro_auto_dia1 === "on" ? 1 : 0;
  const ranuraSolicitada = texto(b.ranura_db, 20).toUpperCase();

  // Correlativos iniciales SENIAT (para clientes nuevos desde 1 o que pasan de facturero manual / otro sistema a digital)
  const enteroCorrelativo = (v: unknown) => {
    if (v === undefined || v === null || String(v).trim() === "") return 1;
    const n = Number(String(v).trim());
    return Number.isInteger(n) && n >= 1 && n <= 999_999_999 ? n : 0;
  };
  const primer_factura = enteroCorrelativo(b.primer_factura);
  const primer_control = enteroCorrelativo(b.primer_control);
  const primer_nota_credito = enteroCorrelativo(b.primer_nota_credito);
  const primer_nota_debito = enteroCorrelativo(b.primer_nota_debito);
  const primer_presupuesto = enteroCorrelativo(b.primer_presupuesto);
  const primer_recibo = enteroCorrelativo(b.primer_recibo);
  if (!primer_factura || !primer_control || !primer_nota_credito || !primer_nota_debito || !primer_presupuesto || !primer_recibo) {
    return falla(c, 400, "Los números correlativos iniciales (Factura, Control, Nota de Crédito, Nota de Débito, Presupuesto y Recibo) deben ser enteros mayores o iguales a 1.");
  }

  if (nombre_negocio.length < 2) return falla(c, 400, "Escribe el nombre o razón social que figura en el RIF.");
  if (!RIF.test(rifEntrada)) return falla(c, 400, "RIF no válido. Usa formato V-12345678-9 o J-12345678-9.");
  if (direccion.length < 4) return falla(c, 400, "Escribe el domicilio fiscal completo del negocio.");
  if (nombre_dueno.length < 2) return falla(c, 400, "Escribe los nombres y apellidos del administrador / representante legal.");
  if (!EMAIL.test(email_dueno)) return falla(c, 400, "Escribe un correo válido para el administrador.");
  const envObjCheck = c.env as unknown as Record<string, unknown>;
  if (await esCorreoSuperAdmin(rawDb, email_dueno, envObjCheck)) return falla(c, 400, "El correo del administrador del cliente debe ser distinto a tu correo de Súper Administrador.");

  // Validar APIs opcionales si fueron llenadas en el Alta
  const correo_proveedor = texto(b.correo_proveedor, 20).toUpperCase() === "RESEND" ? "RESEND" : "BREVO";
  const correo_remitente = texto(b.correo_remitente, 120).toLowerCase();
  const correo_nombre_remitente = texto(b.correo_nombre_remitente ?? b.correo_nombre, 80) || nombre_negocio;
  const correo_clave = texto(b.correo_clave, 200);
  if (correo_clave && correo_remitente && !EMAIL.test(correo_remitente)) {
    return falla(c, 400, "El correo remitente de la API de Brevo/Resend no es válido.");
  }

  const imprenta_prov_tipo_raw = texto(b.imprenta_proveedor_tipo, 20).toUpperCase();
  const imprenta_proveedor_raw = texto(b.imprenta_proveedor, 60);
  const imprenta_url_raw = texto(b.imprenta_url, 200);
  const imprenta_proveedor_tipo: TipoProveedorImprenta =
    imprenta_prov_tipo_raw === PROVEEDOR_CG ||
    (!imprenta_prov_tipo_raw && /cg\s*imprenta|cgimprenta\.digital/i.test(`${imprenta_proveedor_raw} ${imprenta_url_raw}`))
      ? PROVEEDOR_CG
      : PROVEEDOR_GENERICO;
  const imprenta_proveedor = imprenta_proveedor_raw || (imprenta_proveedor_tipo === PROVEEDOR_CG ? "CG La Imprenta Digital" : "");
  const imprenta_usuario = texto(b.imprenta_usuario, 100);
  const imprenta_clave = texto(b.imprenta_clave, 200);
  const imprenta_ambiente = texto(b.imprenta_ambiente, 12).toUpperCase() === "PRODUCCION" ? "PRODUCCION" : "PRUEBAS";
  const imprenta_serie = (texto(b.imprenta_serie, 5) || "A").toUpperCase().replace(/[^A-Z0-9]/g, "") || "A";
  const imprenta_plan_nombre = texto(b.imprenta_plan_nombre, 80);
  const imprenta_plan_cupo = b.imprenta_plan_cupo_total !== undefined && b.imprenta_plan_cupo_total !== "" ? Math.trunc(Number(b.imprenta_plan_cupo_total)) : 0;
  const imprenta_plan_fecha_pago = texto(b.imprenta_plan_fecha_pago, 10);
  const imprenta_plan_fecha_vence = texto(b.imprenta_plan_fecha_vence, 10);
  let imprenta_url = "";
  if (imprenta_url_raw) {
    const valImpUrl = validarUrlImprentaSegura(imprenta_url_raw);
    if (!valImpUrl.ok) return falla(c, 400, valImpUrl.error);
    imprenta_url = imprenta_proveedor_tipo === PROVEEDOR_CG ? normalizarHostCg(valImpUrl.url) : valImpUrl.url;
  }
  if (!Number.isFinite(imprenta_plan_cupo) || imprenta_plan_cupo < 0 || imprenta_plan_cupo > 10_000_000) {
    return falla(c, 400, "El cupo inicial de números de control debe ser un entero mayor o igual a 0.");
  }
  if (imprenta_plan_fecha_pago && !/^\d{4}-\d{2}-\d{2}$/.test(imprenta_plan_fecha_pago)) {
    return falla(c, 400, "La fecha pagada del plan de imprenta debe tener formato AAAA-MM-DD.");
  }
  if (imprenta_plan_fecha_vence && !/^\d{4}-\d{2}-\d{2}$/.test(imprenta_plan_fecha_vence)) {
    return falla(c, 400, "La fecha de vigencia del plan de imprenta debe tener formato AAAA-MM-DD.");
  }

  const envObj = c.env as unknown as Record<string, unknown>;
  // Falla cerrado ANTES de crear nada en Cloudflare: guardar claves de API exige MASTER_KEY.
  if (correo_clave || imprenta_clave) exigirLlaveMaestra(envObj);
  await hidratarBindingsCloudflare(rawDb, envObj);

  const correoOcupado = await rawDb.prepare(`SELECT inquilino_codigo FROM _mt_directorio WHERE email = ?`).bind(email_dueno).first<{ inquilino_codigo: string }>();
  if (correoOcupado) {
    const inqInfo = await rawDb.prepare(`SELECT nombre_negocio FROM _mt_inquilinos WHERE codigo = ?`).bind(correoOcupado.inquilino_codigo).first<{ nombre_negocio: string }>();
    if (!inqInfo) {
      await rawDb.prepare(`DELETE FROM _mt_directorio WHERE email = ?`).bind(email_dueno).run();
    } else {
      const dbOcupada = obtenerDbInquilino({ ...envObj, DB: rawDb }, correoOcupado.inquilino_codigo);
      const usrReal = await dbOcupada.prepare(`SELECT id, rol, activo FROM usuarios WHERE lower(email) = ?`).bind(email_dueno).first<{ id: number; rol: string; activo: number }>().catch(() => null);
      if (!usrReal) {
        await rawDb.prepare(`DELETE FROM _mt_directorio WHERE email = ?`).bind(email_dueno).run();
      } else {
        const rolTxt = NOMBRE_ROL[usrReal.rol] ?? usrReal.rol;
        const estTxt = usrReal.activo ? "activo" : "desactivado";
        return falla(
          c,
          409,
          `El correo ${email_dueno} ya existe como usuario (${rolTxt}, ${estTxt}) en «${inqInfo.nombre_negocio}» (${correoOcupado.inquilino_codigo}). Puedes liberarlo en «Directorio de Correos» o usar otro correo.`
        );
      }
    }
  }

  // Estandarización a ranuras D1 dedicadas: DB_1, DB_2... por defecto para todos los clientes nuevos
  let codigo = "";
  if (/^DB_\d+$/.test(ranuraSolicitada)) {
    const yaUsada = await rawDb.prepare(`SELECT 1 FROM _mt_inquilinos WHERE upper(codigo) = ?`).bind(ranuraSolicitada).first();
    if (yaUsada) return falla(c, 409, `La ranura dedicada ${ranuraSolicitada} ya está asignada a otro cliente.`);
    codigo = ranuraSolicitada;
  } else {
    codigo = await siguienteRanuraD1Libre(rawDb);
  }

  let d1Uuid: string | null = null;
  let d1Nombre: string | null = `facturaya_${codigo.toLowerCase()}`;
  const cfgCf = await leerConfigCloudflare(rawDb, envObj);
  let yaExistiaD1EnCf = false;

  // Si la API de Cloudflare está configurada y la ranura aún no tiene binding físico nativo, crear o enlazar la base D1 real en Cloudflare
  if (!tieneBindingDedicado(envObj, codigo) && cfgCf.configurado) {
    const creacionD1 = await crearBaseD1EnCloudflare(rawDb, envObj, d1Nombre);
    if (!creacionD1.ok) {
      return falla(c, 502, creacionD1.error);
    }
    if (creacionD1.uuid) {
      d1Uuid = creacionD1.uuid;
      d1Nombre = creacionD1.name || d1Nombre;
      yaExistiaD1EnCf = !!creacionD1.ya_existia;
      envObj[codigo] = crearDbCloudflareHttp(cfgCf.account_id, cfgCf.api_token, d1Uuid);
    }
  }

  const tipo_db: "BINDING" | "PREFIJO" = tieneBindingDedicado(envObj, codigo) ? "BINDING" : "PREFIJO";
  let dbInquilino = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);

  const uuidPrincipal = obtenerUuidBdPrincipal(envObj);
  const rollbackD1Nueva = async () => {
    if (!yaExistiaD1EnCf && d1Uuid && (!uuidPrincipal || d1Uuid !== uuidPrincipal) && cfgCf.configurado) {
      await eliminarBaseD1EnCloudflare(rawDb, envObj, d1Uuid).catch(() => {});
      delete envObj[codigo];
    }
  };

  // 1) Correr todas las migraciones en la base D1 aislada del nuevo cliente.
  // Si esa D1 ya existía en Cloudflare por un intento previo fallido a medias (sin estar en _mt_inquilinos),
  // verificamos que no tenga datos reales y la recreamos limpia automáticamente.
  try {
    await migrar(dbInquilino);
  } catch (errMig) {
    if (yaExistiaD1EnCf && d1Uuid && cfgCf.configurado) {
      const tieneDocs = await dbInquilino.prepare(`SELECT COUNT(*) AS n FROM documentos`).first<{ n: number }>().catch(() => null);
      if (!tieneDocs || Number(tieneDocs.n || 0) === 0) {
        const delRes = await eliminarBaseD1EnCloudflare(rawDb, envObj, d1Uuid);
        if (delRes.ok) {
          const rec = await crearBaseD1EnCloudflare(rawDb, envObj, d1Nombre);
          if (rec.ok && rec.uuid) {
            d1Uuid = rec.uuid;
            d1Nombre = rec.name || d1Nombre;
            yaExistiaD1EnCf = !!rec.ya_existia;
            envObj[codigo] = crearDbCloudflareHttp(cfgCf.account_id, cfgCf.api_token, d1Uuid);
            dbInquilino = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);
            try {
              await migrar(dbInquilino);
            } catch (errRec) {
              await rollbackD1Nueva();
              return falla(c, 502, `Error al migrar la base recreada ${codigo}: ${(errRec as Error).message}`);
            }
          } else {
            return falla(c, 502, `La base D1 huérfana ${d1Nombre} falló al recrearse: ${!rec.ok ? rec.error : "sin UUID"}`);
          }
        } else {
          return falla(c, 502, `Error al migrar base D1 existente (${(errMig as Error).message}). Bórrala en Control Cloudflare D1 e intenta de nuevo.`);
        }
      } else {
        return falla(c, 409, `La base D1 ${d1Nombre} ya existe en Cloudflare y contiene ${tieneDocs.n} documento(s). Verifica en Control Cloudflare D1.`);
      }
    } else {
      await rollbackD1Nueva();
      return falla(c, 502, `Error al inicializar tablas de la base ${codigo}: ${(errMig as Error).message}`);
    }
  }

  // 2) Obtener el hash de contraseña actual del Súper Admin para que también pueda entrar a esta bóveda
  const superUser = await obtenerSuperAdminPrincipal(rawDb, envObj);

  const tempClave = claveTemporal();
  const codRecup = codigoRecuperacion();
  const hashTemp = await hashClave(tempClave);
  const hashRecup = await hashClave(normalizarCodigo(codRecup));
  const ahoraIso = new Date().toISOString();

  const lotes: D1PreparedStatement[] = [
    dbInquilino.prepare(
      `INSERT INTO perfil_emisor (
         id, instalado, nombre_razon_social, rif, direccion_fiscal, telefono, email, logo_base64, medio_facturacion, tipo_contribuyente, igtf_activo,
         firma_personal, zona_postal, sector_seniat, rif_comprobante, rif_fecha_inscripcion, rif_fecha_actualizacion, rif_codigo_firma,
         representante_nombre, representante_cedula, representante_fecha_nac, representante_estado_civil, representante_cedula_venc
       ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         instalado = 1, nombre_razon_social = excluded.nombre_razon_social, rif = excluded.rif,
         direccion_fiscal = excluded.direccion_fiscal, telefono = excluded.telefono, email = excluded.email,
         logo_base64 = excluded.logo_base64, medio_facturacion = excluded.medio_facturacion,
         tipo_contribuyente = excluded.tipo_contribuyente, igtf_activo = excluded.igtf_activo,
         firma_personal = excluded.firma_personal, zona_postal = excluded.zona_postal, sector_seniat = excluded.sector_seniat,
         rif_comprobante = excluded.rif_comprobante, rif_fecha_inscripcion = excluded.rif_fecha_inscripcion,
         rif_fecha_actualizacion = excluded.rif_fecha_actualizacion, rif_codigo_firma = excluded.rif_codigo_firma,
         representante_nombre = excluded.representante_nombre, representante_cedula = excluded.representante_cedula,
         representante_fecha_nac = excluded.representante_fecha_nac, representante_estado_civil = excluded.representante_estado_civil,
         representante_cedula_venc = excluded.representante_cedula_venc`
    ).bind(
      nombre_negocio, rif, direccion, telefono, email_dueno, logo_base64, medio_facturacion, tipo_contribuyente, igtf_activo,
      firma_personal, zona_postal, sector_seniat, rif_comprobante, rif_fecha_inscripcion, rif_fecha_actualizacion, rif_codigo_firma,
      nombre_dueno, cedula_dueno, representante_fecha_nac, representante_estado_civil, representante_cedula_venc
    ),
    dbInquilino.prepare(`UPDATE ajustes SET valor = ? WHERE clave = 'modo'`).bind(modo_inicial),
    dbInquilino.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'FACTURA:REAL'`).bind(primer_factura - 1),
    dbInquilino.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'CONTROL:REAL'`).bind(primer_control - 1),
    dbInquilino.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'NOTA_CREDITO:REAL'`).bind(primer_nota_credito - 1),
    dbInquilino.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'NOTA_DEBITO:REAL'`).bind(primer_nota_debito - 1),
    dbInquilino.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'PRESUPUESTO:REAL'`).bind(primer_presupuesto - 1),
    dbInquilino.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'RECIBO:REAL'`).bind(primer_recibo - 1),
  ];

  if (logo_base64) {
    const hashLogo = await sha256(logo_base64);
    lotes.push(
      dbInquilino.prepare(`INSERT OR IGNORE INTO emisor_logos (hash, logo_base64) VALUES (?, ?)`).bind(hashLogo, logo_base64)
    );
  }

  // Si se incluyó la API de Correo Brevo/Resend en el Alta, guardarla cifrada de inmediato
  if (correo_clave) {
    const remitenteFinal = EMAIL.test(correo_remitente) ? correo_remitente : email_dueno;
    const claveCorreoCifrada = await cifrarSecreto(correo_clave, envObj);
    for (const [k, val] of [
      ["correo_proveedor", correo_proveedor],
      ["correo_remitente", remitenteFinal],
      ["correo_nombre_remitente", correo_nombre_remitente],
      ["correo_clave", claveCorreoCifrada],
    ] as const) {
      lotes.push(
        dbInquilino
          .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
          .bind(k, val, ahoraIso)
      );
    }
  }

  // Si se incluyó la API de Imprenta Digital en el Alta, guardarla cifrada de inmediato (compatible con cualquier cuenta CG o genérica)
  if (imprenta_clave && imprenta_url && imprenta_proveedor) {
    const claveImpCifrada = await cifrarSecreto(imprenta_clave, envObj);
    const paresImp: [string, string][] = [
      ["imprenta_proveedor_tipo", imprenta_proveedor_tipo],
      ["imprenta_proveedor", imprenta_proveedor],
      ["imprenta_url", imprenta_url],
      ["imprenta_usuario", imprenta_usuario],
      ["imprenta_clave", claveImpCifrada],
      ["imprenta_ambiente", imprenta_ambiente],
      ["imprenta_serie", imprenta_serie],
    ];
    if (imprenta_plan_cupo > 0) {
      paresImp.push(
        ["imprenta_plan_nombre", imprenta_plan_nombre || `Lote ${imprenta_plan_cupo} números`],
        ["imprenta_plan_cupo_total", String(imprenta_plan_cupo)],
        ["imprenta_plan_fecha_pago", imprenta_plan_fecha_pago || fecha_alta],
        ["imprenta_plan_fecha_vence", imprenta_plan_fecha_vence || ""]
      );
    }
    for (const [k, val] of paresImp) {
      lotes.push(
        dbInquilino
          .prepare(`INSERT INTO integraciones (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`)
          .bind(k, val, ahoraIso)
      );
    }
    if (imprenta_plan_cupo > 0) {
      lotes.push(
        dbInquilino
          .prepare(
            `INSERT INTO imprenta_plan_recargas (plan_nombre, cantidad_numeros, fecha_pago, fecha_vence, monto_usd_centavos, referencia, nota, registrado_por, creado_en)
             VALUES (?, ?, ?, ?, 0, 'PLAN-INICIAL', 'Cargado en el alta del negocio', NULL, ?)`
          )
          .bind(imprenta_plan_nombre || `Lote ${imprenta_plan_cupo} números`, imprenta_plan_cupo, imprenta_plan_fecha_pago || fecha_alta, imprenta_plan_fecha_vence || null, ahoraIso)
      );
    }
  }

  if (superUser) {
    lotes.push(
      dbInquilino.prepare(
        `INSERT OR IGNORE INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave, codigo_recuperacion_hash)
         VALUES (?, ?, ?, 'SUPER_ADMIN', 1, 0, ?)`
      ).bind(superUser.nombre, superUser.email.toLowerCase(), superUser.password_hash, superUser.codigo_recuperacion_hash)
    );
  }

  lotes.push(
    dbInquilino.prepare(
      `INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave, codigo_recuperacion_hash)
       VALUES (?, ?, ?, 'ADMIN', 1, 1, ?)
       ON CONFLICT(email) DO UPDATE SET nombre = excluded.nombre, password_hash = excluded.password_hash, rol = 'ADMIN', activo = 1, debe_cambiar_clave = 1, codigo_recuperacion_hash = excluded.codigo_recuperacion_hash`
    ).bind(nombre_dueno, email_dueno, hashTemp, hashRecup)
  );

  try {
    await dbInquilino.batch(lotes);
  } catch (errBatch) {
    await rollbackD1Nueva();
    return falla(c, 502, `Error al guardar los datos iniciales en ${d1Nombre || codigo}: ${(errBatch as Error).message}`);
  }

  // 3) Registrar el inquilino (con su ranura DB_X, su d1_uuid y sus datos de cédula/zona postal) y su correo en el directorio maestro
  try {
    await rawDb.batch([
      rawDb.prepare(
        `INSERT INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, tipo_contribuyente, plan_usd, fecha_alta, precio_promo_usd_cent, meses_promo, precio_regular_usd_cent, cobro_auto_dia1, motivo_suspension, activo, d1_uuid, d1_nombre, cedula_dueno, zona_postal, firma_personal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?, ?, ?, ?)`
      ).bind(codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, tipo_contribuyente, plan_usd, fecha_alta, precio_promo_usd_cent, meses_promo, precio_regular_usd_cent, cobro_auto_dia1, d1Uuid, d1Nombre, cedula_dueno || "", zona_postal || "", firma_personal || ""),
    ]);
  } catch (errReg) {
    await rollbackD1Nueva();
    return falla(c, 502, `Error al registrar el inquilino ${codigo}: ${(errReg as Error).message}`);
  }
  await registrarCorreoDirectorio(rawDb, email_dueno, codigo, "ADMIN", envObj);
  invalidarCacheInquilinos(rawDb);

  // 4) Enviar correo de bienvenida al dueño si el correo está configurado
  let correo_enviado = false;
  const escHtml = (s: unknown) =>
    String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
  const resCorreo = await enviarCorreo(dbInquilino, { ...envObj, __rawDb: rawDb, __inquilinoCodigo: codigo }, {
    para: email_dueno,
    alcance: "PLATAFORMA",
    tipo: "ALTA",
    inquilinoCodigo: codigo,
    asunto: `🎉 Bienvenido a FacturaYa Venezuela · Acceso de ${nombre_negocio}`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #dde3ec;border-radius:16px;color:#1f2933">
      <h2 style="margin:0 0 12px;color:#1A73E8">🇻🇪 Bienvenido a FacturaYa Venezuela</h2>
      <p>Hola <b>${escHtml(nombre_dueno)}</b>, tu sistema de facturación digital para <b>${escHtml(nombre_negocio)} (${escHtml(rif)})</b> ya está activo en su base dedicada <b>${escHtml(codigo)}</b>.</p>
      <div style="background:#f8fafd;border:1px dashed #9aa7b6;border-radius:12px;padding:16px;margin:16px 0">
        <p style="margin:0 0 8px"><b>🌐 Portal de acceso:</b> <a href="https://facturayave.com" style="color:#1A73E8;font-weight:700">https://facturayave.com</a></p>
        <p style="margin:0 0 8px"><b>✉️ Usuario (Correo):</b> ${escHtml(email_dueno)}</p>
        <p style="margin:0 0 8px"><b>🔑 Clave temporal de primer ingreso:</b> <code style="font-size:18px;font-weight:700">${escHtml(tempClave)}</code></p>
        <p style="margin:0"><b>🔐 Código Maestro de Recuperación (guárdalo en secreto):</b> <code style="font-size:15px;font-weight:700">${escHtml(codRecup)}</code></p>
      </div>
      <p style="font-size:13px;color:#5f6b7a">Al iniciar sesión por primera vez con tu clave temporal, el sistema te pedirá elegir tu propia contraseña privada.</p>
    </div>`,
    texto: `Bienvenido a FacturaYa Venezuela (${nombre_negocio} - ${rif}).\nPortal de acceso: https://facturayave.com\nUsuario: ${email_dueno}\nClave temporal: ${tempClave}\nCódigo Maestro de Recuperación: ${codRecup}`,
  });
  if (resCorreo.ok) correo_enviado = true;

  // 3b) Auto-enlace Nativo D1 (v5.0.0):
  // - De noche (9:00 PM – 5:59 AM VET): conecta el Binding Nativo al Worker al instante vía API de Cloudflare.
  // - De día (6:00 AM – 8:59 PM VET): opera 100% aislado por HTTP D1 sin tocar el Worker de las demás empresas,
  //   y el Mantenimiento Nocturno de las 2:00 AM lo promueve automáticamente a Binding Nativo.
  let binding_nativo_enlazado = false;
  let binding_nativo_programado_2am = false;
  let binding_nativo_aviso = "";
  if (d1Uuid && cfgCf.configurado) {
    if (esHorarioDiurnoCaracas()) {
      binding_nativo_programado_2am = true;
      binding_nativo_aviso = "Alta diurna aislada (isla segura): ya opera vía D1 HTTP sin afectar a otras empresas; a las 2:00 AM pasará automáticamente a Binding Nativo.";
    } else {
      const syncNativo = await sincronizarBindingsD1Cloudflare(rawDb, envObj, { soloCodigo: codigo }).catch((e) => ({
        ok: false,
        cambios: 0,
        enlazados: [] as string[],
        ya_nativos: [] as string[],
        mensaje: "",
        error: (e as Error).message,
      }));
      if (syncNativo.ok) {
        binding_nativo_enlazado = true;
        binding_nativo_aviso = syncNativo.mensaje || `Binding Nativo ${codigo} conectado automáticamente en Cloudflare.`;
      } else {
        binding_nativo_programado_2am = true;
        binding_nativo_aviso = syncNativo.error || "Operando en modo HTTP aislado; se reintentará enlace nativo a las 2:00 AM.";
      }
    }
  }

  await auditar(c, c.get("usuario").id, "INQUILINO_CREAR", `${codigo} (${d1Nombre}${d1Uuid ? " · D1:" + d1Uuid : ""}) ${nombre_negocio} (${rif}) -> ${email_dueno}`);
  return c.json({
    ok: true,
    codigo,
    d1_uuid: d1Uuid,
    d1_nombre: d1Nombre,
    binding_nativo_enlazado,
    binding_nativo_programado_2am,
    binding_nativo_aviso,
    nombre_negocio,
    rif,
    tipo_contribuyente,
    fecha_alta,
    precio_promo_usd_cent,
    meses_promo,
    precio_regular_usd_cent,
    cobro_auto_dia1: !!cobro_auto_dia1,
    nombre_dueno,
    email_dueno,
    clave_temporal: tempClave,
    codigo_recuperacion: codRecup,
    correo_enviado,
    correo_api_configurada: !!correo_clave,
    imprenta_api_configurada: !!(imprenta_clave && imprenta_url),
    correlativos_iniciales: {
      primer_factura,
      primer_control,
      primer_nota_credito,
      primer_nota_debito,
      primer_presupuesto,
      primer_recibo,
    },
  });
});

// Cambiar el negocio activo que el Súper Administrador está viendo / configurando en este momento
inquilinos.post("/cambiar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  await asegurarTablasMultiTenant(rawDb);
  const b = await leerJson(c);
  const codigo = texto(b.codigo, 20) || "principal";
  if (codigo === "DB_DEMO") {
    const filaDemo = await rawDb
      .prepare(`SELECT activo, expira_en FROM _mt_demo_estado WHERE id = 1`)
      .first<{ activo: number; expira_en: number }>()
      .catch(() => null);
    if (!filaDemo || filaDemo.activo !== 1 || Number(filaDemo.expira_en || 0) <= ahora()) {
      return falla(c, 404, "No hay un Entorno Demo activo en este momento.");
    }
  } else if (codigo !== "principal") {
    const existe = await rawDb.prepare(`SELECT codigo FROM _mt_inquilinos WHERE codigo = ?`).bind(codigo).first();
    if (!existe) return falla(c, 404, "Ese inquilino o negocio no existe.");
  }

  const envObj = c.env as unknown as Record<string, unknown>;
  await hidratarBindingsCloudflare(rawDb, envObj);
  const dbDestino = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);
  await migrar(dbDestino);

  const superOrig = await obtenerSuperAdminPrincipal(rawDb, envObj);
  const emailSuper = (superOrig?.email || c.get("usuario").email).trim().toLowerCase();
  if (superOrig) {
    await dbDestino.prepare(
      `INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave, codigo_recuperacion_hash)
       VALUES (?, ?, ?, 'SUPER_ADMIN', 1, 0, ?)
       ON CONFLICT(email) DO UPDATE SET
         nombre = excluded.nombre,
         password_hash = excluded.password_hash,
         codigo_recuperacion_hash = excluded.codigo_recuperacion_hash,
         rol = 'SUPER_ADMIN',
         activo = 1`
    ).bind(superOrig.nombre, emailSuper, superOrig.password_hash, superOrig.codigo_recuperacion_hash).run();
    const uDest = await dbDestino.prepare(`SELECT id FROM usuarios WHERE lower(email) = ?`).bind(emailSuper).first<{ id: number }>();
    const tok = getCookie(c, "sid");
    if (uDest && tok) {
      await dbDestino.prepare(
        `INSERT OR REPLACE INTO sesiones (token_hash, usuario_id, expira_en) VALUES (?, ?, ?)`
      ).bind(await sha256(tok), uDest.id, ahora() + 7 * 86400).run();
    }
  }

  await fijarVistaSuperAdmin(rawDb, codigo, emailSuper, envObj);
  const url = new URL(c.req.url);
  const esHttps = c.req.header("x-forwarded-proto") === "https" || url.protocol === "https:";
  const enIframePreview = url.hostname.endsWith(".run.app");
  setCookie(c, "inq", codigo, {
    httpOnly: true, sameSite: enIframePreview && esHttps ? "None" : "Lax", path: "/", maxAge: 7 * 86400,
    secure: enIframePreview ? esHttps : url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
  });
  return c.json({ ok: true, inquilino_actual: codigo });
});

// Suspender o reactivar el servicio de un inquilino (100% MANUAL y protegido con contraseña del Súper Admin).
// Al suspender cierra de inmediato todas las sesiones del Administrador y demás usuarios de esa empresa.
inquilinos.put("/:codigo/estado", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  await asegurarTablasMultiTenant(rawDb);
  const codigo = texto(c.req.param("codigo"), 20);
  if (codigo === "principal") return falla(c, 400, "Tu negocio principal no se puede suspender.");
  const b = await leerJson(c);
  const clave = String(b.clave ?? "");
  if (!clave || !(await verificarClaveSuperAdmin(rawDb, clave, envObj))) {
    return falla(c, 403, "Contraseña de Súper Administrador incorrecta. Se requiere tu contraseña para suspender o reactivar una empresa.");
  }
  const activo = "activo" in b ? (b.activo ? 1 : 0) : (String(b.estado ?? "").toUpperCase() === "SUSPENDIDO" ? 0 : 1);
  const motivo = activo ? "" : (texto(b.motivo, 40).toUpperCase() || "FALTA_PAGO");
  const r = await rawDb
    .prepare(`UPDATE _mt_inquilinos SET activo = ?, motivo_suspension = ? WHERE codigo = ?`)
    .bind(activo, motivo, codigo)
    .run();
  if (!r.meta.changes) return falla(c, 404, "Inquilino no encontrado.");
  invalidarCacheInquilinos(rawDb);
  let sesionesCerradas = 0;
  if (!activo) {
    await hidratarBindingsCloudflare(rawDb, envObj);
    const dbInq = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);
    const del = await dbInq
      .prepare(`DELETE FROM sesiones WHERE usuario_id NOT IN (SELECT id FROM usuarios WHERE rol = 'SUPER_ADMIN')`)
      .run();
    sesionesCerradas = Number(del.meta?.changes || 0);
  }
  await auditar(
    c,
    c.get("usuario").id,
    "INQUILINO_ESTADO",
    `${codigo} -> ${activo ? "ACTIVO" : `SUSPENDIDO (${motivo}) · ${sesionesCerradas} sesión(es) cerrada(s)`}`
  );
  return c.json({ ok: true, activo: !!activo, motivo_suspension: motivo, sesiones_cerradas: sesionesCerradas });
});

// Configurar fecha de alta, tarifa promocional/regular y switch de cobro automático día 1 (NUNCA suspende)
inquilinos.put("/:codigo/suscripcion", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  await asegurarTablasMultiTenant(rawDb);
  const codigo = texto(c.req.param("codigo"), 20);
  if (codigo === "principal") return falla(c, 400, "Tu empresa principal no lleva suscripción mensual.");
  const actual = await rawDb
    .prepare(
      `SELECT codigo, COALESCE(NULLIF(fecha_alta, ''), substr(creado_en, 1, 10)) AS fecha_alta,
              COALESCE(precio_promo_usd_cent, 500) AS precio_promo_usd_cent,
              COALESCE(meses_promo, 3) AS meses_promo,
              COALESCE(precio_regular_usd_cent, 1000) AS precio_regular_usd_cent,
              COALESCE(cobro_auto_dia1, 0) AS cobro_auto_dia1
       FROM _mt_inquilinos WHERE codigo = ?`
    )
    .bind(codigo)
    .first<Record<string, any>>();
  if (!actual) return falla(c, 404, "Empresa cliente no encontrada.");

  const b = await leerJson(c);
  const fechaAlta = "fecha_alta" in b ? texto(b.fecha_alta, 20) : String(actual.fecha_alta || fechaCaracas()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaAlta)) {
    return falla(c, 400, "La fecha de alta debe tener formato AAAA-MM-DD.");
  }

  const parseCent = (val: unknown, fallback: number, label: string) => {
    if (val === undefined || val === null || String(val).trim() === "") return fallback;
    const n = Number(String(val).replace(",", "."));
    if (!Number.isFinite(n) || n <= 0 || n > 9999) throw new Error(`${label} debe ser un monto válido en USD.`);
    return Math.round(n * 100);
  };
  let promoCent = Number(actual.precio_promo_usd_cent ?? PRECIO_PROMO_DEFECTO_CENT);
  let regularCent = Number(actual.precio_regular_usd_cent ?? PRECIO_REGULAR_DEFECTO_CENT);
  try {
    if ("precio_promo_usd_cent" in b) promoCent = Math.trunc(Number(b.precio_promo_usd_cent));
    else if ("precio_promo_usd" in b) promoCent = parseCent(b.precio_promo_usd, promoCent, "Tarifa promocional");
    if ("precio_regular_usd_cent" in b) regularCent = Math.trunc(Number(b.precio_regular_usd_cent));
    else if ("precio_regular_usd" in b) regularCent = parseCent(b.precio_regular_usd, regularCent, "Tarifa regular");
  } catch (e) {
    return falla(c, 400, (e as Error).message);
  }
  if (!Number.isInteger(promoCent) || promoCent < 0 || promoCent > 999_900) return falla(c, 400, "Tarifa promocional inválida.");
  if (!Number.isInteger(regularCent) || regularCent <= 0 || regularCent > 999_900) return falla(c, 400, "Tarifa regular inválida.");

  const mesesPromo = "meses_promo" in b ? Math.trunc(Number(b.meses_promo)) : Number(actual.meses_promo ?? MESES_PROMO_DEFECTO);
  if (!Number.isInteger(mesesPromo) || mesesPromo < 0 || mesesPromo > 36) {
    return falla(c, 400, "Los meses promocionales deben estar entre 0 y 36.");
  }
  const cobroAuto =
    "cobro_auto_dia1" in b
      ? b.cobro_auto_dia1 === true || b.cobro_auto_dia1 === 1 || b.cobro_auto_dia1 === "1" || b.cobro_auto_dia1 === "on"
        ? 1
        : 0
      : Number(actual.cobro_auto_dia1 ?? 0);

  await rawDb
    .prepare(
      `UPDATE _mt_inquilinos
       SET fecha_alta = ?, precio_promo_usd_cent = ?, meses_promo = ?, precio_regular_usd_cent = ?, plan_usd = ?, cobro_auto_dia1 = ?
       WHERE codigo = ?`
    )
    .bind(fechaAlta, promoCent, mesesPromo, regularCent, Math.round(regularCent / 100), cobroAuto, codigo)
    .run();
  invalidarCacheInquilinos(rawDb);
  await auditar(
    c,
    c.get("usuario").id,
    "SAAS_SUSCRIPCION_CONFIG",
    `${codigo} · alta=${fechaAlta} · promo=$${(promoCent / 100).toFixed(2)}x${mesesPromo}m · reg=$${(regularCent / 100).toFixed(2)} · autoDia1=${cobroAuto}`
  );
  return c.json({
    ok: true,
    fecha_alta: fechaAlta,
    precio_promo_usd_cent: promoCent,
    meses_promo: mesesPromo,
    precio_regular_usd_cent: regularCent,
    cobro_auto_dia1: !!cobroAuto,
  });
});

// Vista previa o emisión real + envío de correo de cobro mensual SaaS (idempotente por período AAAA-MM)
inquilinos.post("/:codigo/cobrar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const codigo = texto(c.req.param("codigo"), 20);
  const b = await leerJson(c).catch(() => ({} as Record<string, unknown>));
  const periodoYm = texto(b.periodo_ym, 10) || undefined;
  const soloVistaPrevia = Boolean(b.solo_vista_previa);
  const forzarReenvioCorreo = Boolean(b.reenviar_correo);
  try {
    const res = await emitirYEnviarCobroSaas(rawDb, envObj, {
      codigo,
      periodoYm,
      usuarioId: c.get("usuario").id,
      soloVistaPrevia,
      forzarReenvioCorreo,
    });
    if (!soloVistaPrevia) {
      await auditar(
        c,
        c.get("usuario").id,
        forzarReenvioCorreo ? "SAAS_COBRO_REENVIAR" : "SAAS_COBRAR",
        `${codigo} · ${res.calculo.periodo_ym} · Fac #${res.cobro?.numero_factura ?? "-"} · USD ${(res.calculo.total_usd_cent / 100).toFixed(2)}`
      );
    }
    return c.json(res);
  } catch (e) {
    return falla(c, 400, (e as Error).message || "No se pudo procesar el cobro mensual.");
  }
});

// Historial de cobros mensuales SaaS de una empresa
inquilinos.get("/:codigo/cobros", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  await asegurarTablasMultiTenant(rawDb);
  const codigo = texto(c.req.param("codigo"), 20);
  const { results } = await rawDb
    .prepare(`SELECT * FROM _mt_cobros_saas WHERE inquilino_codigo = ? ORDER BY periodo_ym DESC, id DESC LIMIT 36`)
    .bind(codigo)
    .all<FilaCobroSaas>();
  return c.json({ ok: true, cobros: results || [] });
});

// Registrar pago recibido (emite recibo atómico en tu negocio principal y marca el período PAGADO)
inquilinos.post("/:codigo/cobros/:cobroId/pagar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const codigo = texto(c.req.param("codigo"), 20);
  const cobroId = Number(c.req.param("cobroId"));
  if (!Number.isInteger(cobroId) || cobroId <= 0) return falla(c, 400, "ID de cobro inválido.");
  const b = await leerJson(c);
  const metodo = texto(b.metodo, 30).toUpperCase() || "PAGO_MOVIL";
  const moneda = texto(b.moneda, 10).toUpperCase() === "USD" ? "USD" : "BS";
  const referencia = texto(b.referencia, 60);
  const nota = texto(b.nota, 200);
  try {
    const res = await registrarPagoCobroSaas(rawDb, {
      codigo,
      cobroId,
      metodo,
      moneda,
      referencia,
      nota,
      usuarioId: c.get("usuario").id,
    });
    await auditar(
      c,
      c.get("usuario").id,
      "SAAS_PAGO",
      `${codigo} · ${res.cobro.periodo_ym} · ${metodo} ${moneda} · ref=${referencia || "-"} · Recibo #${res.recibo_numero ?? "-"}`
    );
    return c.json(res);
  } catch (e) {
    return falla(c, 400, (e as Error).message || "No se pudo registrar el pago.");
  }
});

// Descargar la base de datos individual de un cliente (soporta ?anio=YYYY para bases históricas grandes)
inquilinos.get("/:codigo/respaldo", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  await asegurarTablasMultiTenant(rawDb);
  await hidratarBindingsCloudflare(rawDb, envObj);

  const codigo = texto(c.req.param("codigo"), 20);
  const anioParam = Number(c.req.query("anio") || 0);
  const anio = Number.isInteger(anioParam) && anioParam >= 2000 && anioParam <= 2100 ? anioParam : undefined;
  const info = await rawDb
    .prepare(`SELECT codigo, nombre_negocio, rif, email_dueno, d1_uuid, d1_nombre FROM _mt_inquilinos WHERE codigo = ?`)
    .bind(codigo)
    .first<{ codigo: string; nombre_negocio: string; rif: string; email_dueno: string; d1_uuid?: string | null; d1_nombre?: string | null }>();
  if (!info && codigo !== "principal") return falla(c, 404, "Ese cliente o negocio no existe.");

  const dbInq = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);
  await migrar(dbInq);
  const respaldo = await generarRespaldoNegocio(dbInq, { ...(anio ? { anio } : {}), env: envObj });
  const rifLimpio = (info?.rif || codigo).replace(/[^A-Z0-9-]/gi, "");
  const descargadoEn = new Date().toISOString();
  const payload = {
    ...respaldo,
    sistema: "facturaya-ve",
    tipo: "entrega-base-datos-cliente",
    codigo_ranura: codigo,
    d1_uuid: info?.d1_uuid ?? null,
    d1_nombre: info?.d1_nombre ?? null,
    nombre_negocio: info?.nombre_negocio || codigo,
    rif: info?.rif || "",
    email_dueno: info?.email_dueno ?? "",
    sha256: respaldo.huella,
    descargado_en: descargadoEn,
  };

  if (!anio) {
    const firmaCob = respaldo.cobertura_real?.firma ?? "0:0";
    await rawDb
      .prepare(`UPDATE _mt_inquilinos SET respaldo_descargado_en = ? WHERE codigo = ?`)
      .bind(`${descargadoEn}|${firmaCob}`, codigo)
      .run()
      .catch(() => {});
    await dbInq
      .batch([
        dbInq
          .prepare(
            `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('ultimo_respaldo_descargado', ?, ?)
             ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
          )
          .bind(descargadoEn, descargadoEn),
        dbInq
          .prepare(
            `INSERT INTO integraciones (clave, valor, actualizado_en) VALUES ('ultimo_respaldo_cobertura', ?, ?)
             ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
          )
          .bind(firmaCob, descargadoEn),
      ])
      .catch(() => {});
  }

  await auditar(c, c.get("usuario").id, "INQUILINO_RESPALDO_ENTREGA", `${codigo} (${payload.nombre_negocio})`);
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="entrega-cliente-${codigo.toLowerCase()}-${rifLimpio}-${fechaCaracas()}.json"`,
    },
  });
});

// Dar de baja definitiva a un cliente moroso (3 meses): exige haber descargado antes su respaldo de entrega, borra sus tablas/D1 en Cloudflare y libera la ranura DB_X
inquilinos.post("/:codigo/eliminar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  await asegurarTablasMultiTenant(rawDb);
  await hidratarBindingsCloudflare(rawDb, envObj);

  const codigo = texto(c.req.param("codigo"), 20);
  if (codigo === "principal") return falla(c, 400, "Tu empresa principal no se puede eliminar.");

  const info = await rawDb
    .prepare(`SELECT codigo, nombre_negocio, respaldo_descargado_en FROM _mt_inquilinos WHERE codigo = ?`)
    .bind(codigo)
    .first<{ codigo: string; nombre_negocio: string; respaldo_descargado_en?: string | null }>();
  if (!info) return falla(c, 404, "Ese cliente o empresa ya no existe.");

  const b = await leerJson(c);
  if (!info.respaldo_descargado_en) {
    return falla(
      c,
      409,
      `⚠️ Procedimiento de Baja: Antes de borrar a «${info.nombre_negocio}» (${codigo}) y destruir su base D1, debes pulsar «📦 1. Descargar BD Cliente» para guardar su información y podérsela enviar.`
    );
  }
  const dbInqCheck = obtenerDbInquilino({ ...envObj, DB: rawDb }, codigo);
  const cobActual = await obtenerFirmaCoberturaReal(dbInqCheck).catch(() => ({ n: 0, max_id: 0, firma: "0:0" }));
  if (cobActual.n > 0) {
    const cobLocal = await dbInqCheck
      .prepare(`SELECT valor FROM integraciones WHERE clave = 'ultimo_respaldo_cobertura'`)
      .first<{ valor: string }>()
      .catch(() => null);
    const cobInq = info.respaldo_descargado_en.includes("|") ? info.respaldo_descargado_en.split("|")[1] : "";
    if (cobLocal?.valor !== cobActual.firma && cobInq !== cobActual.firma) {
      return falla(
        c,
        409,
        `⚠️ Procedimiento de Baja: «${info.nombre_negocio}» (${codigo}) emitió nuevos documentos fiscales después del último respaldo descargado. Pulsa nuevamente «📦 1. Descargar BD Cliente» para guardar su información actualizada antes de darlo de baja.`
      );
    }
  }

  const clave = String(b.clave ?? "");
  const confirmar = texto(b.confirmar, 30).toUpperCase();
  if (!(await verificarClaveSuperAdmin(rawDb, clave, envObj))) {
    return falla(c, 401, "Tu contraseña de Súper Administrador no es correcta.");
  }
  if (confirmar !== "ELIMINAR" && confirmar !== codigo.toUpperCase()) {
    return falla(c, 400, `Escribe ELIMINAR o ${codigo.toUpperCase()} para confirmar la baja definitiva.`);
  }

  const eliminarD1Remota = b.eliminar_d1_cloudflare !== false;
  const res = await eliminarInquilinoDefinitivo(rawDb, envObj, codigo, eliminarD1Remota);

  // Si el Súper Admin estaba viendo ese inquilino, regresarlo a principal
  const inqActual = getCookie(c, "inq") || "principal";
  if (inqActual === codigo) {
    const url = new URL(c.req.url);
    const esHttps = c.req.header("x-forwarded-proto") === "https" || url.protocol === "https:";
    const enIframePreview = url.hostname.endsWith(".run.app");
    setCookie(c, "inq", "principal", {
      httpOnly: true, sameSite: enIframePreview && esHttps ? "None" : "Lax", path: "/", maxAge: 7 * 86400,
      secure: enIframePreview ? esHttps : url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    });
  }

  await auditar(
    c,
    c.get("usuario").id,
    "INQUILINO_BAJA_DEFINITIVA",
    `${codigo} eliminado (D1 remota eliminada: ${res.d1_remota_eliminada ? "SI" : "NO"})`
  );
  return c.json({
    ok: true,
    codigo_liberado: codigo,
    d1_remota_eliminada: res.d1_remota_eliminada,
    advertencia_d1: res.advertencia_d1,
  });
});

// Liberar un correo del directorio (por si se registró por error como usuario en el negocio principal y se desea usarlo para una empresa nueva)
inquilinos.post("/liberar-correo", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObjCheck = c.env as unknown as Record<string, unknown>;
  await asegurarTablasMultiTenant(rawDb);
  const b = await leerJson(c);
  const email = texto(b.email, 120).toLowerCase();
  if (!EMAIL.test(email)) return falla(c, 400, "Correo no válido.");
  if (await esCorreoSuperAdmin(rawDb, email, envObjCheck)) return falla(c, 400, "El correo del Súper Administrador está protegido y no se puede liberar.");

  const dir = await rawDb.prepare(`SELECT inquilino_codigo FROM _mt_directorio WHERE email = ?`).bind(email).first<{ inquilino_codigo: string }>();
  if (!dir) return falla(c, 404, "Ese correo no está ocupado en el directorio.");

  const envObj = c.env as unknown as Record<string, unknown>;
  await hidratarBindingsCloudflare(rawDb, envObj);
  const dbNeg = obtenerDbInquilino({ ...envObj, DB: rawDb }, dir.inquilino_codigo);
  const usr = await dbNeg.prepare(`SELECT id, rol FROM usuarios WHERE lower(email) = ?`).bind(email).first<{ id: number; rol: string }>().catch(() => null);
  if (usr) {
    if (usr.rol === "ADMIN" && dir.inquilino_codigo !== "principal") {
      const otroAdmin = await dbNeg.prepare(`SELECT 1 FROM usuarios WHERE id <> ? AND rol IN ('ADMIN', 'SUPER_ADMIN') AND activo = 1`).bind(usr.id).first();
      if (!otroAdmin) return falla(c, 409, `Ese correo es el único administrador de «${dir.inquilino_codigo}». Usa «Dar de Baja y Liberar Ranura» en su tarjeta si deseas borrar toda esa empresa.`);
    }
    await dbNeg.prepare(`DELETE FROM sesiones WHERE usuario_id = ?`).bind(usr.id).run().catch(() => {});
    try {
      await dbNeg.prepare(`DELETE FROM usuarios WHERE id = ?`).bind(usr.id).run();
    } catch {
      await dbNeg.prepare(`UPDATE usuarios SET activo = 0, email = ? WHERE id = ?`).bind(`liberado_${usr.id}_${email}`, usr.id).run();
    }
  }
  await rawDb.prepare(`DELETE FROM _mt_directorio WHERE email = ?`).bind(email).run();
  await auditar(c, c.get("usuario").id, "INQUILINO_LIBERAR_CORREO", `${email} (de ${dir.inquilino_codigo})`);
  return c.json({ ok: true });
});

// ---- CENTRO DE CONTROL CLOUDFLARE (API D1, Cuota 10 Gratis, Turnstile y Worker) ----

inquilinos.get("/cloudflare/estado", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  await asegurarTablasMultiTenant(rawDb);
  const estado = await consultarEstadoCloudflare(rawDb, envObj);
  return c.json(estado);
});

inquilinos.post("/cloudflare/config", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c);
  const clave = String(b.clave ?? "");
  if (!(await verificarClaveSuperAdmin(rawDb, clave, envObj))) {
    return falla(c, 401, "Tu contraseña de Súper Administrador no es correcta.");
  }

  let accountId = texto(b.account_id, 80);
  const apiToken = texto(b.api_token, 250);
  const workerName = texto(b.worker_name, 80) || "facturaya";
  const planD1 = b.plan_d1 === "PRO_5USD" ? "PRO_5USD" : b.plan_d1 === "GRATIS" ? "GRATIS" : undefined;

  // Si se pega el API Token y se deja Account ID en blanco, lo auto-descubrimos consultando la API de Cloudflare
  const tokenEfectivo = apiToken || (await leerConfigCloudflare(rawDb, envObj)).api_token;
  if (!accountId && tokenEfectivo) {
    const desc = await descubrirAccountIdCloudflare(tokenEfectivo);
    if (!desc.ok) {
      return falla(c, 400, desc.error || "No pudimos detectar tu Account ID con ese API Token.");
    }
    accountId = desc.account_id;
  }

  await guardarConfigCloudflare(rawDb, envObj, {
    account_id: accountId,
    api_token: apiToken || undefined,
    worker_name: workerName,
    plan_d1: planD1,
  });
  invalidarCacheInquilinos(rawDb);

  await auditar(c, c.get("usuario").id, "CLOUDFLARE_API_CONFIG", `Account: ${accountId.slice(0, 8)}… · Worker: ${workerName} · Plan: ${planD1 || "AUTO"}`);
  const estado = await consultarEstadoCloudflare(rawDb, envObj);
  return c.json(estado);
});

inquilinos.get("/cloudflare/wrangler-toml", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const res = await generarWranglerTomlBindings(rawDb, c.env as unknown as Record<string, unknown>);
  return c.json(res);
});

inquilinos.post("/cloudflare/crear-bd", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c);
  const ranura = texto(b.ranura, 20).toUpperCase();
  const nombre = texto(b.nombre, 64).toLowerCase() || (ranura ? `facturaya_${ranura.toLowerCase()}` : "");
  if (!nombre) return falla(c, 400, "Indica el nombre de la base de datos D1 (ej. facturaya_db_N).");

  const res = await crearBaseD1EnCloudflare(rawDb, envObj, nombre);
  if (!res.ok) return falla(c, 400, res.error || "No se pudo crear la base D1 en Cloudflare.");

  // Si esa ranura ya pertenece a un inquilino registrado, vincularle su d1_uuid automáticamente
  if (ranura && res.uuid) {
    await rawDb
      .prepare(`UPDATE _mt_inquilinos SET d1_uuid = ?, d1_nombre = ?, tipo_db = 'BINDING' WHERE upper(codigo) = ?`)
      .bind(res.uuid, res.name || nombre, ranura)
      .run()
      .catch(() => {});
  }
  invalidarCacheInquilinos(rawDb);

  await auditar(c, c.get("usuario").id, "CLOUDFLARE_D1_CREAR", `${res.name} (${res.uuid})`);
  const estado = await consultarEstadoCloudflare(rawDb, envObj);
  return c.json({ ok: true, creada: res, estado });
});

inquilinos.post("/cloudflare/eliminar-bd", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c);
  const clave = String(b.clave ?? "");
  const uuid = texto(b.uuid, 80);
  if (!(await verificarClaveSuperAdmin(rawDb, clave, envObj))) {
    return falla(c, 401, "Tu contraseña de Súper Administrador no es correcta.");
  }
  if (!uuid) return falla(c, 400, "Indica el UUID de la base de datos D1 a eliminar.");

  // Proteger la base de datos principal y las bases actualmente asignadas a clientes activos
  const asignada = await rawDb
    .prepare(`SELECT codigo, nombre_negocio FROM _mt_inquilinos WHERE d1_uuid = ?`)
    .bind(uuid)
    .first<{ codigo: string; nombre_negocio: string }>();
  if (asignada) {
    return falla(
      c,
      409,
      `Esa base D1 está asignada a «${asignada.nombre_negocio}» (${asignada.codigo}). Usa el botón «Dar de Baja y Liberar Ranura» en su tarjeta de cliente.`
    );
  }

  const res = await eliminarBaseD1EnCloudflare(rawDb, envObj, uuid);
  if (!res.ok) return falla(c, 400, res.error || "No se pudo eliminar la base D1 en Cloudflare.");
  invalidarCacheInquilinos(rawDb);

  await auditar(c, c.get("usuario").id, "CLOUDFLARE_D1_ELIMINAR", uuid);
  const estado = await consultarEstadoCloudflare(rawDb, envObj);
  return c.json({ ok: true, estado });
});

inquilinos.post("/cloudflare/sincronizar-bindings", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  await asegurarTablasMultiTenant(rawDb);
  const t0 = Date.now();
  const iniciadoEn = new Date().toISOString();
  const res = await sincronizarBindingsD1Cloudflare(rawDb, envObj);
  await guardarLogMantenimiento(rawDb, {
    tipo: "BINDINGS_SYNC",
    estado: res.ok ? "OK" : "ADVERTENCIA",
    iniciado_en: iniciadoEn,
    finalizado_en: new Date().toISOString(),
    duracion_ms: Date.now() - t0,
    empresas_revisadas: res.enlazados.length + res.ya_nativos.length,
    empresas_sanas: res.enlazados.length + res.ya_nativos.length,
    bindings_sanados: res.cambios,
    respaldos_ok: 0,
    sesiones_purgadas: 0,
    alertas_count: res.ok ? 0 : 1,
    resumen: res.ok ? (res.mensaje || "Bindings D1 sincronizados.") : (res.error || "No se pudo sincronizar bindings D1."),
    detalle_json: JSON.stringify(res),
  });
  await auditar(c, c.get("usuario").id, "CLOUDFLARE_BINDINGS_SYNC", `${res.cambios} enlazado(s): ${res.enlazados.join(", ") || "sin cambios"}`);
  const estado = await consultarEstadoCloudflare(rawDb, envObj);
  if (!res.ok) return c.json({ ok: false, error: res.error, permiso_faltante: res.permiso_faltante, resultado: res, estado }, 400);
  return c.json({ ok: true, resultado: res, estado });
});

inquilinos.get("/cloudflare/builds", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  await asegurarTablasMultiTenant(rawDb);
  const [res, mant, logs] = await Promise.all([
    consultarDesplieguesYBuilds(rawDb, envObj),
    leerEstadoMantenimiento(rawDb, { omitirCache: true }),
    listarLogsMantenimiento(rawDb, 15),
  ]);
  // Si el Modo Mantenimiento de despliegue está activo, sincronizar automáticamente la etapa con el estado real del último build de main
  let mantFinal = mant;
  if (mant.activo && res.configurado && res.builds?.length) {
    const ultimoMain = res.builds.find((b) => (b.branch || "main") === "main") || res.builds[0];
    if (ultimoMain) {
      const estRaw = `${ultimoMain.status} ${ultimoMain.build_outcome}`.toLowerCase();
      const creadoMs = Date.parse(ultimoMain.created_on || "");
      const activadoMs = Date.parse(mant.activado_en || "");
      const esPosterior = Number.isFinite(creadoMs) && Number.isFinite(activadoMs) && creadoMs >= activadoMs - 60_000;
      if (esPosterior) {
        if (/queued|running|initializing|active|pending/.test(estRaw) && !/success|succeed|fail|error/.test(estRaw)) {
          mantFinal = await actualizarEtapaDespliegue(rawDb, "DESPLEGANDO", {
            ultimo_build_uuid: ultimoMain.build_uuid,
            ultimo_build_estado: "COMPILANDO",
          });
        } else if (/success|succeed/.test(estRaw) && !/fail|error/.test(estRaw)) {
          mantFinal = await actualizarEtapaDespliegue(rawDb, "VERIFICADO_OK", {
            ultimo_build_uuid: ultimoMain.build_uuid,
            ultimo_build_estado: "OK",
          });
        }
      }
    }
  }
  return c.json({ ...res, mantenimiento: mantFinal, logs_despliegue: logs.filter((l) => l.tipo === "DESPLIEGUE_INICIO" || l.tipo === "DESPLIEGUE_FIN").slice(0, 10) });
});

inquilinos.get("/cloudflare/builds/:buildUuid/logs", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const buildUuid = texto(c.req.param("buildUuid"), 80);
  const res = await consultarLogBuildCloudflare(rawDb, envObj, buildUuid);
  if (!res.ok) return falla(c, 400, res.error);
  return c.json(res);
});

inquilinos.post("/cloudflare/builds/reintentar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c);
  const clave = String(b.clave ?? "");
  if (!(await verificarClaveSuperAdmin(rawDb, clave, envObj))) {
    return falla(c, 401, "Tu contraseña de Súper Administrador no es correcta.");
  }
  const triggerUuid = texto(b.trigger_uuid, 80);
  const branch = texto(b.branch, 80);
  const purgarCache = Boolean(b.purgar_cache);
  const res = await relanzarBuildCloudflare(rawDb, envObj, {
    trigger_uuid: triggerUuid || undefined,
    branch: branch || undefined,
    purgar_cache: purgarCache,
  });
  if (!res.ok) return falla(c, 400, res.error);
  const mant = await leerEstadoMantenimiento(rawDb, { omitirCache: true });
  if (mant.activo) {
    await actualizarEtapaDespliegue(rawDb, "DESPLEGANDO", { ultimo_build_uuid: res.build_uuid, ultimo_build_estado: "COMPILANDO" });
  }
  await auditar(c, c.get("usuario").id, "CLOUDFLARE_BUILD_REINTENTAR", `Build: ${res.build_uuid} · Rama: ${res.branch} · Cache: ${purgarCache ? "purgado" : "normal"}`);
  const [estado, mantDespues, logsDesp] = await Promise.all([
    consultarDesplieguesYBuilds(rawDb, envObj),
    leerEstadoMantenimiento(rawDb, { omitirCache: true }),
    listarLogsMantenimiento(rawDb, 15),
  ]);
  const logsFiltrados = logsDesp.filter((l) => l.tipo === "DESPLIEGUE_INICIO" || l.tipo === "DESPLIEGUE_FIN").slice(0, 10);
  return c.json({ ok: true, lanzado: res, estado: { ...estado, mantenimiento: mantDespues, logs_despliegue: logsFiltrados } });
});

inquilinos.post("/cloudflare/rollback", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c);
  const clave = String(b.clave ?? "");
  if (!(await verificarClaveSuperAdmin(rawDb, clave, envObj))) {
    return falla(c, 401, "Tu contraseña de Súper Administrador no es correcta.");
  }
  const versionId = texto(b.version_id, 80);
  const motivo = texto(b.motivo, 120) || "Rollback manual desde Centro de Control FacturaYa";
  if (!versionId) return falla(c, 400, "Selecciona la versión a la que deseas restaurar el tráfico.");

  const res = await rollbackWorkerCloudflare(rawDb, envObj, versionId, motivo);
  if (!res.ok) return falla(c, 400, res.error);
  await auditar(c, c.get("usuario").id, "CLOUDFLARE_ROLLBACK", `Version: ${res.version_id} · ${motivo}`);
  const [estado, mantDespues, logsDesp] = await Promise.all([
    consultarDesplieguesYBuilds(rawDb, envObj),
    leerEstadoMantenimiento(rawDb, { omitirCache: true }),
    listarLogsMantenimiento(rawDb, 15),
  ]);
  const logsFiltrados = logsDesp.filter((l) => l.tipo === "DESPLIEGUE_INICIO" || l.tipo === "DESPLIEGUE_FIN").slice(0, 10);
  return c.json({ ok: true, rollback: res, estado: { ...estado, mantenimiento: mantDespues, logs_despliegue: logsFiltrados } });
});

// Diagnóstico integral de salud de base de datos en las empresas (soporta ?desde=0&limite=8 o ?codigo=DB_X para 100+ BD)
inquilinos.get("/salud", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  await hidratarBindingsCloudflare(rawDb, envObj);
  const desdeQ = c.req.query("desde");
  const limiteQ = c.req.query("limite");
  const codigoQ = texto(c.req.query("codigo"), 20) || undefined;
  const opts =
    codigoQ || desdeQ !== undefined || limiteQ !== undefined
      ? {
          codigo: codigoQ,
          desde: desdeQ !== undefined ? Number(desdeQ) : undefined,
          limite: limiteQ !== undefined ? Number(limiteQ) : undefined,
        }
      : undefined;
  const reporte = await diagnosticarTodoElSistema(rawDb, envObj, opts);
  return c.json({ ok: true, ...reporte });
});

// Reparación quirúrgica NO destructiva: re-aplica migraciones/triggers faltantes y sincroniza contadores atrasados
inquilinos.post("/reparar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const yo = c.get("usuario");
  const b = await leerJson(c);
  const codigo = texto(b.codigo, 20);
  await asegurarTablasMultiTenant(rawDb);
  await hidratarBindingsCloudflare(rawDb, envObj);

  const codigos: string[] = [];
  if (codigo && codigo !== "*") {
    codigos.push(codigo);
  } else {
    const { results } = await rawDb
      .prepare(`SELECT codigo FROM _mt_inquilinos ORDER BY CASE WHEN codigo = 'principal' THEN 0 ELSE 1 END, creado_en ASC`)
      .all<{ codigo: string }>();
    codigos.push(...(results.length ? results.map((r) => r.codigo) : ["principal"]));
  }

  const resultados = [];
  for (const cod of codigos) {
    resultados.push(await repararInquilino(rawDb, envObj, cod, yo.id, c));
  }
  const reporte = await diagnosticarTodoElSistema(rawDb, envObj, codigo && codigo !== "*" ? { codigo } : undefined);
  return c.json({ ok: true, resultados, reporte });
});

// Respaldo Maestro Multi-Tenant (principal + empresas afiliadas; soporta ?desde=0&limite=25 para 100+ BD)
inquilinos.get("/respaldo-maestro", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  await hidratarBindingsCloudflare(rawDb, envObj);
  const desdeQ = c.req.query("desde");
  const limiteQ = c.req.query("limite");
  const codigoQ = texto(c.req.query("codigo"), 20) || undefined;
  const anioParam = Number(c.req.query("anio") || 0);
  const anioQ = Number.isInteger(anioParam) && anioParam >= 2000 && anioParam <= 2100 ? anioParam : undefined;
  const opts =
    codigoQ || desdeQ !== undefined || limiteQ !== undefined || anioQ !== undefined
      ? {
          codigo: codigoQ,
          desde: desdeQ !== undefined ? Number(desdeQ) : undefined,
          limite: limiteQ !== undefined ? Number(limiteQ) : undefined,
          anio: anioQ,
        }
      : undefined;
  const maestro = await generarRespaldoMaestro(rawDb, envObj, opts);
  const sufijoLote = maestro.empresas_en_archivo < maestro.total_empresas
    ? `-lote-${maestro.desde + 1}-a-${maestro.desde + maestro.empresas_en_archivo}`
    : "";
  const sufijoAnio = anioQ ? `-${anioQ}` : "";
  await auditar(c, c.get("usuario").id, "RESPALDO_MAESTRO", `${maestro.empresas_en_archivo}/${maestro.total_empresas} empresa(s)${anioQ ? ` (${anioQ})` : ""}`);
  return new Response(JSON.stringify(maestro), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="respaldo-maestro-facturaya${sufijoAnio}-${fechaCaracas()}${sufijoLote}.json"`,
    },
  });
});

// ---- RESPALDOS AUTOMÁTICOS DIARIOS Y ARCHIVO FISCAL MENSUAL EN CLOUDFLARE R2 (v4.5) ----
inquilinos.get("/respaldos-r2", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const estado = await listarRespaldosR2(rawDb, envObj);
  return c.json(estado);
});

inquilinos.post("/respaldos-r2/ejecutar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  if (!obtenerBucketR2(envObj)) {
    return falla(c, 400, "El bucket Cloudflare R2 (RESPALDOS_R2) aún no está vinculado en el Worker.");
  }
  const b = await leerJson(c).catch(() => ({} as Record<string, unknown>));
  const tipo = String(b.tipo ?? "").trim().toLowerCase() === "mensual" ? "mensual" : "manual";
  const mesIso = /^\d{4}-\d{2}$/.test(String(b.mes ?? "").trim()) ? String(b.mes).trim() : undefined;
  await hidratarBindingsCloudflare(rawDb, envObj);
  const resultado = await ejecutarRespaldoR2(rawDb, envObj, { tipo, ...(mesIso ? { mesIso } : {}) });
  await auditar(
    c,
    c.get("usuario").id,
    tipo === "mensual" ? "RESPALDO_R2_MENSUAL_MANUAL" : "RESPALDO_R2_MANUAL",
    `${resultado.claves.length} archivo(s) · ${resultado.total_empresas} emp · ${resultado.bytes_totales} B`
  );
  const estado = await listarRespaldosR2(rawDb, envObj);
  return c.json({ ok: true, resultado, estado });
});

inquilinos.get("/respaldos-r2/descargar", async (c) => {
  const envObj = c.env as unknown as Record<string, unknown>;
  const bucket = obtenerBucketR2(envObj);
  if (!bucket) return falla(c, 400, "El bucket Cloudflare R2 (RESPALDOS_R2) no está vinculado.");
  const key = texto(c.req.query("key"), 200);
  if (!claveR2Valida(key)) return falla(c, 400, "Clave de respaldo R2 no válida.");
  const obj = await bucket.get(key);
  if (!obj) return falla(c, 404, "Respaldo no encontrado en R2.");
  const nombre = (key.split("/").pop() || "respaldo-r2.json").replace(/[^a-zA-Z0-9._-]/g, "_");
  await auditar(c, c.get("usuario").id, "RESPALDO_R2_DESCARGAR", key);
  const cuerpo = obj.body ?? (await obj.arrayBuffer());
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${nombre}"`,
  };
  if (Number.isFinite(obj.size) && obj.size > 0) {
    headers["Content-Length"] = String(obj.size);
  }
  return new Response(cuerpo as ConstructorParameters<typeof Response>[0], { headers });
});

// ---- MODO MANTENIMIENTO PARA DESPLIEGUES Y MANTENIMIENTO NOCTURNO AUTOMÁTICO (v5.0.0) ----

inquilinos.get("/mantenimiento/estado", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  await asegurarTablasMultiTenant(rawDb);
  const [mantenimiento, logs] = await Promise.all([
    leerEstadoMantenimiento(rawDb, { omitirCache: true }),
    listarLogsMantenimiento(rawDb, 40),
  ]);
  return c.json({
    ok: true,
    mantenimiento,
    horario_diurno_vet: esHorarioDiurnoCaracas(),
    hora_caracas: horaCaracas(),
    ventana_nocturna: "1:00 AM – 5:00 AM (Hora Venezuela · Cron automático 2:00 AM)",
    silencio_diurno: "6:00 AM – 9:00 PM (Cero tareas pesadas ni respaldos)",
    logs,
  });
});

inquilinos.post("/mantenimiento/despliegue/activar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c);
  const clave = String(b.clave ?? "");
  if (!(await verificarClaveSuperAdmin(rawDb, clave, envObj))) {
    return falla(c, 401, "Tu contraseña de Súper Administrador no es correcta.");
  }
  const mensaje = texto(b.mensaje, 280);
  const res = await activarModoMantenimientoDespliegue(rawDb, envObj, {
    emailSuper: c.get("usuario").email,
    mensaje: mensaje || undefined,
  });
  await auditar(
    c,
    c.get("usuario").id,
    "MANTENIMIENTO_DESPLIEGUE_ACTIVAR",
    `${res.sesiones_cerradas} sesión(es) cerrada(s) en ${res.empresas_procesadas} empresa(s)`
  );
  const logs = await listarLogsMantenimiento(rawDb, 15);
  return c.json({ ok: true, ...res, logs_despliegue: logs.filter((l) => l.tipo === "DESPLIEGUE_INICIO" || l.tipo === "DESPLIEGUE_FIN").slice(0, 10) });
});

inquilinos.post("/mantenimiento/despliegue/etapa", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const b = await leerJson(c);
  const etapaRaw = texto(b.etapa, 30).toUpperCase();
  if (!["SESIONES_CERRADAS", "DESPLEGANDO", "VERIFICADO_OK"].includes(etapaRaw)) {
    return falla(c, 400, "Etapa de despliegue no válida.");
  }
  const actual = await leerEstadoMantenimiento(rawDb, { omitirCache: true });
  if (!actual.activo) {
    return falla(c, 409, "Activa primero el Modo Mantenimiento antes de cambiar la etapa de despliegue.");
  }
  const estado = await actualizarEtapaDespliegue(rawDb, etapaRaw as "SESIONES_CERRADAS" | "DESPLEGANDO" | "VERIFICADO_OK");
  return c.json({ ok: true, estado });
});

inquilinos.post("/mantenimiento/despliegue/desactivar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const b = await leerJson(c);
  const clave = String(b.clave ?? "");
  if (!(await verificarClaveSuperAdmin(rawDb, clave, envObj))) {
    return falla(c, 401, "Tu contraseña de Súper Administrador no es correcta.");
  }
  const res = await desactivarModoMantenimientoDespliegue(rawDb, envObj, {
    emailSuper: c.get("usuario").email,
    sincronizarBindings: b.sincronizar_bindings !== false,
  });
  await auditar(
    c,
    c.get("usuario").id,
    "MANTENIMIENTO_DESPLIEGUE_DESACTIVAR",
    `Sesiones listas para usar · bindings sanados: ${res.bindings_sanados}`
  );
  const logs = await listarLogsMantenimiento(rawDb, 15);
  return c.json({ ok: true, ...res, logs_despliegue: logs.filter((l) => l.tipo === "DESPLIEGUE_INICIO" || l.tipo === "DESPLIEGUE_FIN").slice(0, 10) });
});

inquilinos.post("/mantenimiento/nocturno/ejecutar", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const envObj = c.env as unknown as Record<string, unknown>;
  const resultado = await ejecutarMantenimientoNocturno(rawDb, envObj, { tipo: "NOCTURNO_MANUAL" });
  await auditar(c, c.get("usuario").id, "MANTENIMIENTO_NOCTURNO_MANUAL", resultado.resumen);
  const logs = await listarLogsMantenimiento(rawDb, 40);
  return c.json({ ok: true, resultado, logs });
});

inquilinos.post("/mantenimiento/correo-modo", async (c) => {
  const rawDb = c.get("rawDb") || c.env.DB;
  const b = await leerJson(c);
  const modoRaw = texto(b.modo, 20).toUpperCase();
  if (!["SOLO_ALERTAS", "SIEMPRE", "DESACTIVADO"].includes(modoRaw)) {
    return falla(c, 400, "Modo de correo no válido (SOLO_ALERTAS, SIEMPRE o DESACTIVADO).");
  }
  const mantenimiento = await configurarCorreoResumenMantenimiento(rawDb, modoRaw as "SOLO_ALERTAS" | "SIEMPRE" | "DESACTIVADO");
  await auditar(c, c.get("usuario").id, "MANTENIMIENTO_CORREO_MODO", modoRaw);
  return c.json({ ok: true, mantenimiento });
});

export default inquilinos;
