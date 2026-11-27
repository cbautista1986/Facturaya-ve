// Motor de Entorno Demo Aislado y Efímero (v4.9.0) sobre base D1 dedicada `DB_DEMO`.
// Garantías inquebrantables:
// 1. Opera EXCLUSIVAMENTE sobre `env.DB_DEMO` (nunca sobre `DB` principal ni `DB_1..DB_N`).
// 2. Semilla realista de 3 meses en centavos enteros exactos (public/dinero.js), adaptada al régimen SENIAT elegido (FORMAL / ORDINARIO / ESPECIAL).
// 3. Limpieza total automática al vencer (Cron + verificación perezosa) o manual por el Súper Administrador.
// 4. Bloqueo estricto de funciones sensibles (Imprenta Digital, API Keys, R2, 2FA, Multi-Tenant) y tope de 5 correos redirigidos únicamente al correo real del prospecto.
import { aTasaE8, calcular, usdABs } from "../public/dinero.js";
import { EMAIL, ahora, fechaCaracas, masDias } from "./comun";
import {
  TRIGGERS_CONOCIDOS_INQUILINO,
  asegurarTablasMultiTenant,
  fijarVistaSuperAdmin,
  invalidarCacheInquilinos,
  registrarCorreoDirectorio,
} from "./inquilinos";
import { migrar } from "./migraciones";
import { validarTipoContribuyenteEstricto, type TipoContribuyente } from "./regimen";
import { hashClave } from "./seguridad";

export const CODIGO_DEMO = "DB_DEMO";
export const MAX_CORREOS_DEMO_DEFECTO = 5;
export const DURACIONES_DEMO_PERMITIDAS = [30, 60, 120] as const;

export const CORREOS_DEMO = {
  ADMIN: "admin@demo.facturayave.com",
  CAJERO: "cajero@demo.facturayave.com",
  CONTADOR: "contador@demo.facturayave.com",
} as const;

export const MENSAJE_DEMO_EXPIRADO =
  "⏳ Tu prueba guiada de FacturaYa Venezuela finalizó y el entorno temporal fue cerrado. ¿Listo para activar tu empresa real con tus propios datos fiscales? Escríbenos por WhatsApp.";

export type FilaDemoEstado = {
  id: number;
  activo: number;
  regimen: TipoContribuyente;
  nombre_negocio: string;
  email_prospecto: string;
  clave_demo: string;
  correos_enviados: number;
  max_correos: number;
  duracion_min: number;
  creado_en: number;
  expira_en: number;
  limpiado: number;
  actualizado_en: string;
};

export type EstadoDemoCalculado = {
  activo: boolean;
  expirado: boolean;
  limpiado: boolean;
  regimen: TipoContribuyente;
  nombre_negocio: string;
  email_prospecto: string;
  email_prospecto_mascara: string;
  clave_demo: string;
  correos_enviados: number;
  max_correos: number;
  correos_restantes: number;
  duracion_min: number;
  creado_en: number;
  expira_en: number;
  segundos_restantes: number;
  expira_hora_caracas: string;
};

export function enmascararCorreo(email: string): string {
  const limpio = String(email || "").trim().toLowerCase();
  const partes = limpio.split("@");
  if (partes.length !== 2 || !partes[0] || !partes[1]) return "";
  const u = partes[0];
  const vis = u.length <= 2 ? u[0] : `${u.slice(0, 2)}***${u.slice(-1)}`;
  return `${vis}@${partes[1]}`;
}

export function formatearHoraCaracas(unixSeg: number): string {
  if (!unixSeg || unixSeg <= 0) return "";
  try {
    return new Intl.DateTimeFormat("es-VE", {
      timeZone: "America/Caracas",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(unixSeg * 1000));
  } catch {
    return new Date(unixSeg * 1000).toISOString();
  }
}

export function calcularEstadoDemo(fila: FilaDemoEstado | null | undefined, ahoraSeg = ahora()): EstadoDemoCalculado {
  if (!fila) {
    return {
      activo: false,
      expirado: false,
      limpiado: true,
      regimen: "ORDINARIO",
      nombre_negocio: "",
      email_prospecto: "",
      email_prospecto_mascara: "",
      clave_demo: "",
      correos_enviados: 0,
      max_correos: MAX_CORREOS_DEMO_DEFECTO,
      correos_restantes: MAX_CORREOS_DEMO_DEFECTO,
      duracion_min: 120,
      creado_en: 0,
      expira_en: 0,
      segundos_restantes: 0,
      expira_hora_caracas: "",
    };
  }
  const expiraEn = Number(fila.expira_en || 0);
  const activoBd = Number(fila.activo || 0) === 1;
  const expirado = activoBd && expiraEn > 0 && ahoraSeg >= expiraEn;
  const vigente = activoBd && expiraEn > ahoraSeg;
  const enviados = Math.max(0, Number(fila.correos_enviados || 0));
  const maxC = Math.max(1, Number(fila.max_correos || MAX_CORREOS_DEMO_DEFECTO));
  return {
    activo: vigente,
    expirado,
    limpiado: Number(fila.limpiado ?? 1) === 1,
    regimen: (validarTipoContribuyenteEstricto(fila.regimen) || "ORDINARIO") as TipoContribuyente,
    nombre_negocio: String(fila.nombre_negocio || ""),
    email_prospecto: String(fila.email_prospecto || ""),
    email_prospecto_mascara: enmascararCorreo(String(fila.email_prospecto || "")),
    clave_demo: String(fila.clave_demo || ""),
    correos_enviados: enviados,
    max_correos: maxC,
    correos_restantes: Math.max(0, maxC - enviados),
    duracion_min: Number(fila.duracion_min || 120),
    creado_en: Number(fila.creado_en || 0),
    expira_en: expiraEn,
    segundos_restantes: vigente ? Math.max(0, expiraEn - ahoraSeg) : 0,
    expira_hora_caracas: expiraEn ? formatearHoraCaracas(expiraEn) : "",
  };
}

// Reglas duras de bloqueo dentro del Entorno Demo (devuelven HTTP 403 server-side)
const RUTAS_BLOQUEADAS_DEMO: Array<{ metodo: RegExp; ruta: RegExp; motivo: string }> = [
  { metodo: /.*/, ruta: /^\/api\/sistema\/imprenta(\/|$)/, motivo: "La API de Imprenta Digital está deshabilitada en el Entorno Demo." },
  { metodo: /.*/, ruta: /^\/api\/sistema\/medio(\/|$)/, motivo: "El cambio de modalidad fiscal está deshabilitado en el Entorno Demo." },
  { metodo: /^POST$/, ruta: /^\/api\/sistema\/correo(\/|$)/, motivo: "La configuración de claves de correo está deshabilitada en el Entorno Demo." },
  { metodo: /.*/, ruta: /^\/api\/sistema\/reiniciar-fabrica(\/|$)/, motivo: "El reinicio de base de datos está deshabilitado en el Entorno Demo." },
  { metodo: /.*/, ruta: /^\/api\/sistema\/salir-en-vivo(\/|$)/, motivo: "El Entorno Demo ya opera en modo demostrativo completo." },
  { metodo: /.*/, ruta: /^\/api\/sistema\/restaurar(\/|$)/, motivo: "La restauración de respaldos está deshabilitada en el Entorno Demo." },
  { metodo: /.*/, ruta: /^\/api\/sistema\/respaldo(\/|$)/, motivo: "La descarga de respaldos está deshabilitada en el Entorno Demo." },
  { metodo: /.*/, ruta: /^\/api\/cuenta\/2fa(\/|$)/, motivo: "La autenticación 2FA está deshabilitada en cuentas Demo." },
  { metodo: /^POST|PUT$/, ruta: /^\/api\/cuenta\/clave(\/|$)/, motivo: "No es necesario cambiar la clave en el Entorno Demo." },
  { metodo: /^POST|PUT$/, ruta: /^\/api\/cuenta\/codigo-recuperacion(\/|$)/, motivo: "Los códigos de recuperación están deshabilitados en el Entorno Demo." },
  { metodo: /^PUT$/, ruta: /^\/api\/config\/regimen(\/|$)/, motivo: "El régimen fiscal del Entorno Demo fue prefijado para esta prueba." },
  { metodo: /.*/, ruta: /^\/api\/inquilinos(\/|$)/, motivo: "Acceso restringido fuera del Entorno Demo." },
  { metodo: /.*/, ruta: /^\/api\/demo(\/|$)/, motivo: "Acceso restringido fuera del Entorno Demo." },
  { metodo: /.*/, ruta: /^\/api\/correos\/(?!historial$)/, motivo: "El panel global de correos no está disponible en el Entorno Demo." },
];

export function motivoBloqueoDemo(metodo: string, ruta: string): string | null {
  for (const regla of RUTAS_BLOQUEADAS_DEMO) {
    if (regla.metodo.test(metodo) && regla.ruta.test(ruta)) {
      return regla.motivo;
    }
  }
  return null;
}

export function generarClaveDemo(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const num = ((bytes[0] << 8) | bytes[1]) % 9000 + 1000;
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const a = letras[bytes[2] % letras.length];
  const b = letras[bytes[3] % letras.length];
  return `Demo-${num}${a}${b}`;
}

export function etiquetaRegimenDemo(regimen: TipoContribuyente): string {
  if (regimen === "FORMAL") return "Contribuyente Formal (Exento IVA 0% · Sin IGTF)";
  if (regimen === "ESPECIAL") return "Contribuyente Especial SPE (IVA 16% + IGTF 3% + Retenciones)";
  return "Contribuyente Ordinario (IVA 16% / Exento + Retenciones)";
}

export function construirInvitacionWhatsappDemo(datos: {
  nombre_negocio: string;
  regimen: TipoContribuyente;
  clave_demo: string;
  expira_hora_caracas: string;
  duracion_min: number;
  email_prospecto?: string;
  max_correos?: number;
  url?: string;
}): string {
  const portal = datos.url || "https://facturayave.com";
  const durTxt = datos.duracion_min === 30 ? "30 minutos" : datos.duracion_min === 60 ? "1 hora" : `${Math.round(datos.duracion_min / 60)} horas`;
  const lineas = [
    `🇻🇪 *Prueba Guiada — FacturaYa Venezuela*`,
    ``,
    `Te preparé un entorno demostrativo exclusivo y precargado con 3 meses de movimientos ficticios para que pruebes el sistema completo desde tu celular o PC:`,
    ``,
    `🏢 *Empresa ejemplo:* ${datos.nombre_negocio}`,
    `⚖️ *Régimen:* ${etiquetaRegimenDemo(datos.regimen)}`,
    `⏱️ *Duración:* ${durTxt} (vence: ${datos.expira_hora_caracas} hora VE)`,
    ``,
    `🌐 *Ingresa aquí:* ${portal}`,
    ``,
    `🔐 *Accesos de prueba (misma clave para los 3 roles):*`,
    `• *Administrador (todo + ganancias):* ${CORREOS_DEMO.ADMIN}`,
    `• *Cajero (factura y cobra, sin ver costos):* ${CORREOS_DEMO.CAJERO}`,
    `• *Contador (libros SENIAT solo lectura):* ${CORREOS_DEMO.CONTADOR}`,
    `🔑 *Contraseña:* ${datos.clave_demo}`,
  ];
  if (datos.email_prospecto) {
    lineas.push(``, `✉️ *Prueba de envío de PDF:* puedes enviar hasta ${datos.max_correos || MAX_CORREOS_DEMO_DEFECTO} correos de prueba; todos llegarán únicamente a tu correo (${datos.email_prospecto}).`);
  }
  lineas.push(``, `✨ Al vencer el tiempo, este entorno temporal se borra automáticamente. ¡Cualquier duda me escribes por aquí!`);
  return lineas.join("\n");
}

// Verifica y obtiene la base aislada DB_DEMO. NUNCA permite operar sobre DB principal.
export function obtenerDbDemoAislada(envObj: Record<string, unknown>, rawDb?: D1Database): D1Database | null {
  const cand = envObj?.DB_DEMO as D1Database | undefined;
  if (!cand || typeof cand.prepare !== "function") return null;
  if (rawDb && cand === rawDb) {
    throw new Error("Error de aislamiento crítico: DB_DEMO no puede apuntar a la base principal.");
  }
  return cand;
}

// Limpia por completo las tablas y triggers de DB_DEMO (jamás toca DB principal ni DB_1..DB_N).
export async function limpiarBaseDemo(rawDb: D1Database, envObj: Record<string, unknown>): Promise<{ ok: true; limpiada_bd: boolean }> {
  await asegurarTablasMultiTenant(rawDb, envObj);
  const dbDemo = obtenerDbDemoAislada(envObj, rawDb);
  let limpiadaBd = false;

  if (dbDemo) {
    const ordenTablas = [
      "imprenta_envios",
      "imprenta_plan_recargas",
      "correo_envios",
      "pagos",
      "movimientos_stock",
      "compra_impuestos",
      "compras",
      "compras_vieja",
      "documento_impuestos",
      "documento_renglones",
      "documentos",
      "catalogo",
      "clientes",
      "proveedores",
      "medio_historial",
      "metodos_cobro",
      "integraciones",
      "parametros_fiscales",
      "contadores",
      "ajustes",
      "verificaciones",
      "auditoria",
      "intentos_login",
      "sesiones",
      "usuarios",
      "emisor_logos",
      "perfil_emisor",
      "_migraciones",
    ];
    await dbDemo.batch(TRIGGERS_CONOCIDOS_INQUILINO.map((t) => dbDemo.prepare(`DROP TRIGGER IF EXISTS ${t}`))).catch(() => {});
    await dbDemo.batch(ordenTablas.map((t) => dbDemo.prepare(`DROP TABLE IF EXISTS ${t}`))).catch(() => {});
    limpiadaBd = true;
  }

  await rawDb.batch([
    rawDb.prepare(`DELETE FROM _mt_directorio WHERE inquilino_codigo = ?`).bind(CODIGO_DEMO),
    rawDb.prepare(`UPDATE _mt_super_vista SET inquilino_codigo = 'principal', actualizado_en = datetime('now') WHERE inquilino_codigo = ?`).bind(CODIGO_DEMO),
    rawDb.prepare(
      `INSERT INTO _mt_demo_estado (id, activo, regimen, nombre_negocio, email_prospecto, clave_demo, correos_enviados, max_correos, duracion_min, creado_en, expira_en, limpiado, actualizado_en)
       VALUES (1, 0, 'ORDINARIO', '', '', '', 0, ?, 120, 0, 0, 1, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET activo = 0, clave_demo = '', limpiado = 1, actualizado_en = datetime('now')`
    ).bind(MAX_CORREOS_DEMO_DEFECTO),
  ]);
  invalidarCacheInquilinos(rawDb);
  return { ok: true, limpiada_bd: limpiadaBd };
}

// Plan puro y determinista de datos realistas venezolanos de 3 meses según régimen SENIAT (todo en centavos enteros).
export type SemillaPerfil = {
  nombre_razon_social: string;
  rif: string;
  direccion_fiscal: string;
  telefono: string;
  email: string;
  tipo_contribuyente: TipoContribuyente;
  igtf_activo: number;
  especialidad: string;
  representante_nombre: string;
  representante_cedula: string;
};

export type SemillaItemCatalogo = {
  codigo: string;
  nombre: string;
  tipo: "PRODUCTO" | "SERVICIO";
  costo_centavos: number;
  precio_centavos: number;
  alicuota_iva: 0 | 8 | 16;
  stock_inicial_milli: number;
  stock_minimo_milli: number | null;
};

export type SemillaCliente = {
  rif_cedula: string;
  nombre_apellido: string;
  direccion: string;
  whatsapp: string;
  email: string;
  es_agente_retencion: boolean;
};

export type SemillaProveedor = {
  rif: string;
  nombre: string;
  direccion: string;
  whatsapp: string;
  email: string;
};

export type SemillaFacturaPlan = {
  mesOffset: -2 | -1 | 0; // -2 = hace 2 meses, -1 = mes anterior, 0 = mes actual
  dia: number;
  clienteIdx: number;
  condicion: "CONTADO" | "CREDITO";
  diasCredito: number | null;
  aplicaIgtf: boolean;
  items: Array<{ catIdx: number; cantidadMilli: number }>;
  pago:
    | null
    | {
        metodo: "PAGO_MOVIL" | "TRANSFERENCIA" | "ZELLE" | "BINANCE" | "EFECTIVO";
        moneda: "BS" | "USD";
        fraccion: 1 | 0.5;
        conRetencionIva?: boolean;
        conRetencionIslr?: boolean;
      };
  nota: string;
};

export function fechaEnMesRelativo(hoyIso: string, mesOffset: number, diaDeseado: number): string {
  const [y0, m0] = hoyIso.split("-").map(Number);
  const d = new Date(Date.UTC(y0, m0 - 1 + mesOffset, 1));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const maxDiaMes = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let dia = Math.min(Math.max(1, diaDeseado), maxDiaMes);
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
  if (iso > hoyIso) {
    // Nunca generar facturas con fecha futura respecto a hoy
    const diaHoy = Number(hoyIso.slice(8, 10));
    dia = Math.max(1, Math.min(diaHoy, diaDeseado <= diaHoy ? diaDeseado : Math.max(1, diaHoy - ((diaDeseado % Math.max(1, diaHoy)) || 0))));
    return `${hoyIso.slice(0, 8)}${String(dia).padStart(2, "0")}`;
  }
  return iso;
}

export function generarPlanSemillaDemo(
  regimen: TipoContribuyente,
  hoyIso = fechaCaracas(),
  tasaBcv = 58.42,
  nombreNegocioCustom?: string
) {
  const tasaValida = Number.isFinite(tasaBcv) && tasaBcv > 0 ? Number(tasaBcv.toFixed(4)) : 58.42;
  const tasaE8 = aTasaE8(String(tasaValida));

  const perfiles: Record<TipoContribuyente, SemillaPerfil> = {
    FORMAL: {
      nombre_razon_social: nombreNegocioCustom?.trim() || "Clínica & Consultorio Salud Integral Demo",
      rif: "J-50128490-2",
      direccion_fiscal: "Av. Francisco de Miranda, Torre Salud, Piso 4, Chacao, Caracas",
      telefono: "0212-5550192",
      email: "administracion@demo.facturayave.com",
      tipo_contribuyente: "FORMAL",
      igtf_activo: 0,
      especialidad: "SERVICIOS_PROFESIONALES",
      representante_nombre: "Dra. Valeria Mendoza (Demo)",
      representante_cedula: "V-16482910",
    },
    ORDINARIO: {
      nombre_razon_social: nombreNegocioCustom?.trim() || "Comercializadora Andina Express Demo C.A.",
      rif: "J-40872195-6",
      direccion_fiscal: "Av. Bolívar Norte, C.C. Galerías Centro, Local 14, Valencia, Carabobo",
      telefono: "0241-5550348",
      email: "administracion@demo.facturayave.com",
      tipo_contribuyente: "ORDINARIO",
      igtf_activo: 0,
      especialidad: "COMERCIO_SERVICIOS",
      representante_nombre: "Ing. Carlos Eduardo Rivas (Demo)",
      representante_cedula: "V-15294018",
    },
    ESPECIAL: {
      nombre_razon_social: nombreNegocioCustom?.trim() || "Distribuidora Sol de Oro SPE Demo C.A.",
      rif: "J-31495820-9",
      direccion_fiscal: "Zona Industrial Los Cortijos, Calle 3, Galpón 7-B, Caracas",
      telefono: "0212-5550874",
      email: "administracion@demo.facturayave.com",
      tipo_contribuyente: "ESPECIAL",
      igtf_activo: 1,
      especialidad: "DISTRIBUIDORA_SPE",
      representante_nombre: "Lic. Mariana Delgado (Demo)",
      representante_cedula: "V-14820394",
    },
  };

  const catalogos: Record<TipoContribuyente, SemillaItemCatalogo[]> = {
    FORMAL: [
      { codigo: "MED-001", nombre: "Consulta Médica General (Exenta IVA)", tipo: "SERVICIO", costo_centavos: 800, precio_centavos: 3500, alicuota_iva: 0, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "MED-002", nombre: "Evaluación Cardiológica + Electrocardiograma", tipo: "SERVICIO", costo_centavos: 1800, precio_centavos: 6500, alicuota_iva: 0, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "MED-003", nombre: "Ultrasonido Abdominal Completo", tipo: "SERVICIO", costo_centavos: 1500, precio_centavos: 5500, alicuota_iva: 0, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "MED-004", nombre: "Perfil 20 Laboratorio Clínico", tipo: "SERVICIO", costo_centavos: 1200, precio_centavos: 4000, alicuota_iva: 0, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "MED-005", nombre: "Certificado Médico Vial / Salud", tipo: "SERVICIO", costo_centavos: 300, precio_centavos: 2000, alicuota_iva: 0, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "MED-006", nombre: "Terapia Respiratoria Nebulización", tipo: "SERVICIO", costo_centavos: 500, precio_centavos: 2500, alicuota_iva: 0, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "INS-001", nombre: "Kit de Curación Estéril Descartable", tipo: "PRODUCTO", costo_centavos: 450, precio_centavos: 1200, alicuota_iva: 0, stock_inicial_milli: 45000, stock_minimo_milli: 10000 },
      { codigo: "INS-002", nombre: "Tensiómetro Digital de Brazo", tipo: "PRODUCTO", costo_centavos: 2200, precio_centavos: 4500, alicuota_iva: 0, stock_inicial_milli: 14000, stock_minimo_milli: 4000 },
      { codigo: "INS-003", nombre: "Oxímetro de Pulso LED", tipo: "PRODUCTO", costo_centavos: 850, precio_centavos: 1900, alicuota_iva: 0, stock_inicial_milli: 22000, stock_minimo_milli: 5000 },
      { codigo: "INS-004", nombre: "Termómetro Infrarrojo Sin Contacto", tipo: "PRODUCTO", costo_centavos: 1100, precio_centavos: 2600, alicuota_iva: 0, stock_inicial_milli: 16000, stock_minimo_milli: 4000 },
    ],
    ORDINARIO: [
      { codigo: "TEC-001", nombre: "Router Wi-Fi 6 Dual Band Gigabit", tipo: "PRODUCTO", costo_centavos: 3800, precio_centavos: 6500, alicuota_iva: 16, stock_inicial_milli: 28000, stock_minimo_milli: 6000 },
      { codigo: "TEC-002", nombre: "UPS Respaldo Eléctrico 1000VA", tipo: "PRODUCTO", costo_centavos: 5200, precio_centavos: 8800, alicuota_iva: 16, stock_inicial_milli: 20000, stock_minimo_milli: 5000 },
      { codigo: "TEC-003", nombre: "Impresora Térmica POS 80mm USB/LAN", tipo: "PRODUCTO", costo_centavos: 4400, precio_centavos: 7500, alicuota_iva: 16, stock_inicial_milli: 18000, stock_minimo_milli: 4000 },
      { codigo: "TEC-004", nombre: "Lector de Código de Barras Inalámbrico", tipo: "PRODUCTO", costo_centavos: 2100, precio_centavos: 3900, alicuota_iva: 16, stock_inicial_milli: 25000, stock_minimo_milli: 5000 },
      { codigo: "TEC-005", nombre: "Monitor LED 24\" Full HD IPS", tipo: "PRODUCTO", costo_centavos: 8900, precio_centavos: 13800, alicuota_iva: 16, stock_inicial_milli: 15000, stock_minimo_milli: 3000 },
      { codigo: "PAP-001", nombre: "Rollo Térmico 80mm Caja x10 (Exento)", tipo: "PRODUCTO", costo_centavos: 950, precio_centavos: 1650, alicuota_iva: 0, stock_inicial_milli: 50000, stock_minimo_milli: 10000 },
      { codigo: "SRV-001", nombre: "Mantenimiento Preventivo de Estación PC", tipo: "SERVICIO", costo_centavos: 1000, precio_centavos: 3500, alicuota_iva: 16, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "SRV-002", nombre: "Instalación y Configuración de Red Corporativa", tipo: "SERVICIO", costo_centavos: 3500, precio_centavos: 12000, alicuota_iva: 16, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "SRV-003", nombre: "Soporte Técnico Remoto Mensual", tipo: "SERVICIO", costo_centavos: 1500, precio_centavos: 5500, alicuota_iva: 16, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "SRV-004", nombre: "Capacitación de Personal en Facturación Digital", tipo: "SERVICIO", costo_centavos: 1200, precio_centavos: 4500, alicuota_iva: 0, stock_inicial_milli: 0, stock_minimo_milli: null },
    ],
    ESPECIAL: [
      { codigo: "DIS-001", nombre: "Aceite Lubricante Sintético 5W-30 (Caja x12)", tipo: "PRODUCTO", costo_centavos: 6400, precio_centavos: 9800, alicuota_iva: 16, stock_inicial_milli: 40000, stock_minimo_milli: 8000 },
      { codigo: "DIS-002", nombre: "Batería Automotriz 12V 800AMP Libre Mant.", tipo: "PRODUCTO", costo_centavos: 7800, precio_centavos: 12200, alicuota_iva: 16, stock_inicial_milli: 26000, stock_minimo_milli: 6000 },
      { codigo: "DIS-003", nombre: "Caucho Rin 16 Todo Terreno 215/65", tipo: "PRODUCTO", costo_centavos: 6900, precio_centavos: 10500, alicuota_iva: 16, stock_inicial_milli: 32000, stock_minimo_milli: 8000 },
      { codigo: "DIS-004", nombre: "Kit de Filtros Aire + Aceite + Combustible", tipo: "PRODUCTO", costo_centavos: 1850, precio_centavos: 3400, alicuota_iva: 16, stock_inicial_milli: 55000, stock_minimo_milli: 10000 },
      { codigo: "DIS-005", nombre: "Refrigerante Orgánico Galón 3.78L", tipo: "PRODUCTO", costo_centavos: 920, precio_centavos: 1750, alicuota_iva: 16, stock_inicial_milli: 60000, stock_minimo_milli: 12000 },
      { codigo: "DIS-006", nombre: "Repuesto Agrícola Certificado (Exento IVA)", tipo: "PRODUCTO", costo_centavos: 4200, precio_centavos: 6800, alicuota_iva: 0, stock_inicial_milli: 20000, stock_minimo_milli: 4000 },
      { codigo: "LOG-001", nombre: "Flete y Despacho Regional Express", tipo: "SERVICIO", costo_centavos: 1500, precio_centavos: 4200, alicuota_iva: 16, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "LOG-002", nombre: "Diagnóstico Computarizado de Flota", tipo: "SERVICIO", costo_centavos: 1800, precio_centavos: 6000, alicuota_iva: 16, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "LOG-003", nombre: "Alineación y Balanceo Flota Corporativa", tipo: "SERVICIO", costo_centavos: 1400, precio_centavos: 4800, alicuota_iva: 16, stock_inicial_milli: 0, stock_minimo_milli: null },
      { codigo: "LOG-004", nombre: "Mantenimiento Integral Unidad Pesada", tipo: "SERVICIO", costo_centavos: 4500, precio_centavos: 14500, alicuota_iva: 16, stock_inicial_milli: 0, stock_minimo_milli: null },
    ],
  };

  const clientes: SemillaCliente[] = [
    { rif_cedula: "J-30194821-4", nombre_apellido: "Inversiones Los Palos Grandes C.A.", direccion: "Av. Andrés Bello, Edif. Centro, Caracas", whatsapp: "584141110001", email: "cliente1@demo.invalid", es_agente_retencion: true },
    { rif_cedula: "J-40285109-7", nombre_apellido: "Supermercados El Ávila Express C.A.", direccion: "Av. Rómulo Gallegos, Boleíta, Caracas", whatsapp: "584141110002", email: "cliente2@demo.invalid", es_agente_retencion: true },
    { rif_cedula: "J-29847163-1", nombre_apellido: "Corporación Industrial Aragua S.A.", direccion: "Zona Industrial San Vicente, Maracay", whatsapp: "584121110003", email: "cliente3@demo.invalid", es_agente_retencion: true },
    { rif_cedula: "J-50019284-8", nombre_apellido: "Ferretería y Suministros Lara C.A.", direccion: "Av. Venezuela con Calle 28, Barquisimeto", whatsapp: "584241110004", email: "cliente4@demo.invalid", es_agente_retencion: false },
    { rif_cedula: "J-31094872-0", nombre_apellido: "Logística Maracaibo Norte C.A.", direccion: "Av. 5 de Julio, Sector Bella Vista, Maracaibo", whatsapp: "584141110005", email: "cliente5@demo.invalid", es_agente_retencion: true },
    { rif_cedula: "V-18472910-3", nombre_apellido: "Alejandro José Zambrano", direccion: "Urb. El Viñedo, Calle 141, Valencia", whatsapp: "584121110006", email: "cliente6@demo.invalid", es_agente_retencion: false },
    { rif_cedula: "V-21394815-7", nombre_apellido: "Gabriela Sofía Briceño", direccion: "Las Mercedes, Calle Madrid, Caracas", whatsapp: "584141110007", email: "cliente7@demo.invalid", es_agente_retencion: false },
    { rif_cedula: "V-14928371-2", nombre_apellido: "Ricardo Antonio Peralta", direccion: "Av. Intercomunal, Lechería, Anzoátegui", whatsapp: "584241110008", email: "cliente8@demo.invalid", es_agente_retencion: false },
    { rif_cedula: "J-41192837-5", nombre_apellido: "Servicios Médicos Altamira C.A.", direccion: "Plaza Altamira Sur, Chacao, Caracas", whatsapp: "584141110009", email: "cliente9@demo.invalid", es_agente_retencion: false },
    { rif_cedula: "J-30819274-6", nombre_apellido: "Alimentos y Bebidas Mérida C.A.", direccion: "Av. Las Américas, C.C. Rodeo, Mérida", whatsapp: "584161110010", email: "cliente10@demo.invalid", es_agente_retencion: false },
  ];

  const proveedores: SemillaProveedor[] = [
    { rif: "J-30519284-3", nombre: "Importadora Mayorista Central C.A.", direccion: "La Yaguara, Caracas", whatsapp: "584142220001", email: "prov1@demo.invalid" },
    { rif: "J-40192844-1", nombre: "Insumos y Equipos Nacionales S.A.", direccion: "Zona Industrial Castillito, Valencia", whatsapp: "584122220002", email: "prov2@demo.invalid" },
    { rif: "J-29481029-8", nombre: "Administradora Torre Empresarial C.A.", direccion: "Chacao, Caracas", whatsapp: "584142220003", email: "prov3@demo.invalid" },
    { rif: "J-31209481-5", nombre: "Telecomunicaciones Fibra VE C.A.", direccion: "El Rosal, Caracas", whatsapp: "584242220004", email: "prov4@demo.invalid" },
  ];

  const esEspecial = regimen === "ESPECIAL";
  const cobraIva = regimen !== "FORMAL";

  // 24 facturas distribuidas en los últimos 3 meses (8 por mes) con pagos realistas y cuentas por cobrar abiertas
  const facturas: SemillaFacturaPlan[] = [
    // Hace 2 meses
    { mesOffset: -2, dia: 3, clienteIdx: 0, condicion: "CONTADO", diasCredito: null, aplicaIgtf: false, items: [{ catIdx: 0, cantidadMilli: 2000 }, { catIdx: 6, cantidadMilli: 1000 }], pago: { metodo: "TRANSFERENCIA", moneda: "BS", fraccion: 1, conRetencionIva: cobraIva }, nota: "Despacho inicial mes 1" },
    { mesOffset: -2, dia: 6, clienteIdx: 5, condicion: "CONTADO", diasCredito: null, aplicaIgtf: esEspecial, items: [{ catIdx: 1, cantidadMilli: 1000 }, { catIdx: 7, cantidadMilli: 1000 }], pago: { metodo: "ZELLE", moneda: "USD", fraccion: 1 }, nota: "Pago en divisas" },
    { mesOffset: -2, dia: 10, clienteIdx: 1, condicion: "CREDITO", diasCredito: 15, aplicaIgtf: false, items: [{ catIdx: 2, cantidadMilli: 2000 }, { catIdx: 3, cantidadMilli: 2000 }], pago: { metodo: "PAGO_MOVIL", moneda: "BS", fraccion: 1, conRetencionIva: cobraIva }, nota: "Orden de compra OC-104" },
    { mesOffset: -2, dia: 14, clienteIdx: 6, condicion: "CONTADO", diasCredito: null, aplicaIgtf: esEspecial, items: [{ catIdx: 4, cantidadMilli: 1000 }, { catIdx: 8, cantidadMilli: 1000 }], pago: { metodo: "BINANCE", moneda: "USD", fraccion: 1 }, nota: "Atención prioritaria" },
    { mesOffset: -2, dia: 18, clienteIdx: 2, condicion: "CREDITO", diasCredito: 15, aplicaIgtf: false, items: [{ catIdx: 0, cantidadMilli: 3000 }, { catIdx: 9, cantidadMilli: 1000 }], pago: { metodo: "TRANSFERENCIA", moneda: "BS", fraccion: 1, conRetencionIslr: cobraIva }, nota: "Servicio corporativo" },
    { mesOffset: -2, dia: 21, clienteIdx: 3, condicion: "CONTADO", diasCredito: null, aplicaIgtf: false, items: [{ catIdx: 5, cantidadMilli: 2000 }, { catIdx: 6, cantidadMilli: 2000 }], pago: { metodo: "PAGO_MOVIL", moneda: "BS", fraccion: 1 }, nota: "" },
    { mesOffset: -2, dia: 24, clienteIdx: 7, condicion: "CONTADO", diasCredito: null, aplicaIgtf: esEspecial, items: [{ catIdx: 1, cantidadMilli: 1000 }, { catIdx: 3, cantidadMilli: 1000 }], pago: { metodo: "EFECTIVO", moneda: "USD", fraccion: 1 }, nota: "" },
    { mesOffset: -2, dia: 27, clienteIdx: 8, condicion: "CONTADO", diasCredito: null, aplicaIgtf: false, items: [{ catIdx: 2, cantidadMilli: 1000 }, { catIdx: 7, cantidadMilli: 1000 }], pago: { metodo: "TRANSFERENCIA", moneda: "BS", fraccion: 1 }, nota: "Cierre de mes" },

    // Mes anterior
    { mesOffset: -1, dia: 2, clienteIdx: 4, condicion: "CREDITO", diasCredito: 15, aplicaIgtf: false, items: [{ catIdx: 0, cantidadMilli: 2000 }, { catIdx: 2, cantidadMilli: 1000 }], pago: { metodo: "TRANSFERENCIA", moneda: "BS", fraccion: 1, conRetencionIva: cobraIva }, nota: "Reposición mensual" },
    { mesOffset: -1, dia: 5, clienteIdx: 9, condicion: "CONTADO", diasCredito: null, aplicaIgtf: esEspecial, items: [{ catIdx: 3, cantidadMilli: 2000 }, { catIdx: 8, cantidadMilli: 1000 }], pago: { metodo: "ZELLE", moneda: "USD", fraccion: 1 }, nota: "" },
    { mesOffset: -1, dia: 9, clienteIdx: 0, condicion: "CREDITO", diasCredito: 15, aplicaIgtf: false, items: [{ catIdx: 1, cantidadMilli: 2000 }, { catIdx: 6, cantidadMilli: 2000 }], pago: { metodo: "PAGO_MOVIL", moneda: "BS", fraccion: 1, conRetencionIva: cobraIva }, nota: "Contrato corporativo" },
    { mesOffset: -1, dia: 13, clienteIdx: 5, condicion: "CONTADO", diasCredito: null, aplicaIgtf: false, items: [{ catIdx: 4, cantidadMilli: 1000 }, { catIdx: 5, cantidadMilli: 1000 }], pago: { metodo: "PAGO_MOVIL", moneda: "BS", fraccion: 1 }, nota: "" },
    { mesOffset: -1, dia: 16, clienteIdx: 2, condicion: "CREDITO", diasCredito: 15, aplicaIgtf: false, items: [{ catIdx: 7, cantidadMilli: 2000 }, { catIdx: 9, cantidadMilli: 1000 }], pago: { metodo: "TRANSFERENCIA", moneda: "BS", fraccion: 0.5 }, nota: "Abono 50% recibido · saldo vencido demo" },
    { mesOffset: -1, dia: 20, clienteIdx: 6, condicion: "CONTADO", diasCredito: null, aplicaIgtf: esEspecial, items: [{ catIdx: 0, cantidadMilli: 1000 }, { catIdx: 8, cantidadMilli: 2000 }], pago: { metodo: "BINANCE", moneda: "USD", fraccion: 1 }, nota: "Cobro Binance USDT" },
    { mesOffset: -1, dia: 23, clienteIdx: 1, condicion: "CREDITO", diasCredito: 15, aplicaIgtf: false, items: [{ catIdx: 2, cantidadMilli: 2000 }, { catIdx: 4, cantidadMilli: 1000 }], pago: null, nota: "Factura a crédito vencida para demo de cobranza" },
    { mesOffset: -1, dia: 26, clienteIdx: 3, condicion: "CONTADO", diasCredito: null, aplicaIgtf: false, items: [{ catIdx: 3, cantidadMilli: 2000 }, { catIdx: 6, cantidadMilli: 1000 }], pago: { metodo: "TRANSFERENCIA", moneda: "BS", fraccion: 1 }, nota: "" },

    // Mes actual
    { mesOffset: 0, dia: 1, clienteIdx: 0, condicion: "CONTADO", diasCredito: null, aplicaIgtf: false, items: [{ catIdx: 0, cantidadMilli: 2000 }, { catIdx: 7, cantidadMilli: 1000 }], pago: { metodo: "TRANSFERENCIA", moneda: "BS", fraccion: 1, conRetencionIva: cobraIva }, nota: "Inicio de mes" },
    { mesOffset: 0, dia: 4, clienteIdx: 7, condicion: "CONTADO", diasCredito: null, aplicaIgtf: esEspecial, items: [{ catIdx: 1, cantidadMilli: 1000 }, { catIdx: 5, cantidadMilli: 2000 }], pago: { metodo: "ZELLE", moneda: "USD", fraccion: 1 }, nota: "Venta divisas" },
    { mesOffset: 0, dia: 7, clienteIdx: 4, condicion: "CREDITO", diasCredito: 15, aplicaIgtf: false, items: [{ catIdx: 2, cantidadMilli: 2000 }, { catIdx: 8, cantidadMilli: 1000 }], pago: { metodo: "PAGO_MOVIL", moneda: "BS", fraccion: 0.5 }, nota: "Abono inicial 50%" },
    { mesOffset: 0, dia: 10, clienteIdx: 8, condicion: "CONTADO", diasCredito: null, aplicaIgtf: false, items: [{ catIdx: 3, cantidadMilli: 1000 }, { catIdx: 9, cantidadMilli: 1000 }], pago: { metodo: "PAGO_MOVIL", moneda: "BS", fraccion: 1 }, nota: "" },
    { mesOffset: 0, dia: 13, clienteIdx: 9, condicion: "CONTADO", diasCredito: null, aplicaIgtf: esEspecial, items: [{ catIdx: 4, cantidadMilli: 1000 }, { catIdx: 6, cantidadMilli: 2000 }], pago: { metodo: "EFECTIVO", moneda: "USD", fraccion: 1 }, nota: "Efectivo divisas en taquilla" },
    { mesOffset: 0, dia: 16, clienteIdx: 1, condicion: "CREDITO", diasCredito: 20, aplicaIgtf: false, items: [{ catIdx: 0, cantidadMilli: 3000 }, { catIdx: 2, cantidadMilli: 1000 }], pago: null, nota: "Crédito corporativo vigente" },
    { mesOffset: 0, dia: 18, clienteIdx: 5, condicion: "CONTADO", diasCredito: null, aplicaIgtf: false, items: [{ catIdx: 5, cantidadMilli: 2000 }, { catIdx: 7, cantidadMilli: 1000 }], pago: { metodo: "TRANSFERENCIA", moneda: "BS", fraccion: 1 }, nota: "" },
    { mesOffset: 0, dia: 20, clienteIdx: 3, condicion: "CREDITO", diasCredito: 15, aplicaIgtf: false, items: [{ catIdx: 1, cantidadMilli: 1000 }, { catIdx: 8, cantidadMilli: 2000 }], pago: null, nota: "Pendiente por cobrar (demo)" },
  ];

  return {
    perfil: perfiles[regimen],
    tasaBcv: tasaValida,
    tasaE8,
    hoyIso,
    catalogo: catalogos[regimen],
    clientes,
    proveedores,
    facturas,
  };
}

// Crea o reemplaza el Entorno Demo aislado en DB_DEMO con 3 meses de movimientos realistas.
export async function crearEntornoDemo(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  opc: {
    regimen?: string;
    duracion_min?: number;
    nombre_negocio?: string;
    email_prospecto?: string;
  }
) {
  await asegurarTablasMultiTenant(rawDb, envObj);
  const dbDemo = obtenerDbDemoAislada(envObj, rawDb);
  if (!dbDemo) {
    throw new Error("Falta el binding D1 `DB_DEMO` (facturaya_demo_db) en Cloudflare / wrangler.toml.");
  }

  const regimen = validarTipoContribuyenteEstricto(opc.regimen || "ORDINARIO");
  if (!regimen) {
    throw new Error("Régimen inválido. Elige FORMAL, ORDINARIO o ESPECIAL.");
  }
  const durNum = Number(opc.duracion_min ?? 120);
  const duracionMin = DURACIONES_DEMO_PERMITIDAS.includes(durNum as 30 | 60 | 120) ? durNum : 120;
  const emailProspecto = String(opc.email_prospecto ?? "").trim().toLowerCase();
  if (emailProspecto && !EMAIL.test(emailProspecto)) {
    throw new Error("El correo del prospecto no tiene un formato válido.");
  }
  const nombreCustom = String(opc.nombre_negocio ?? "").trim().slice(0, 120);

  // Tomar tasa BCV vigente de la BD principal (o fallback realista)
  const filaTasa = await rawDb
    .prepare(`SELECT tasa_bcv FROM perfil_emisor WHERE id = 1`)
    .first<{ tasa_bcv?: number }>()
    .catch(() => null);
  const tasaGlobal = await rawDb
    .prepare(`SELECT tasa_bcv FROM _mt_tasa_bcv_global WHERE id = 1`)
    .first<{ tasa_bcv?: number }>()
    .catch(() => null);
  const tasaBcv = Number(tasaGlobal?.tasa_bcv || filaTasa?.tasa_bcv || 58.42);

  // 1) Limpiar por completo DB_DEMO antes de sembrar (jamás toca DB principal)
  await limpiarBaseDemo(rawDb, envObj);
  await migrar(dbDemo);

  const hoyIso = fechaCaracas();
  const plan = generarPlanSemillaDemo(regimen, hoyIso, tasaBcv, nombreCustom);
  const claveDemo = generarClaveDemo();
  const hashDemo = await hashClave(claveDemo, envObj);
  const ahoraSeg = ahora();
  const expiraEn = ahoraSeg + duracionMin * 60;
  const ahoraIso = new Date().toISOString();

  // 2) Perfil emisor, modo REAL (para que los libros, correlativos y candados operen igual que en vivo), métodos de cobro y 3 usuarios listos (sin cambio obligatorio de clave)
  await dbDemo.batch([
    dbDemo
      .prepare(
        `INSERT OR REPLACE INTO perfil_emisor (
           id, instalado, especialidad, nombre_razon_social, rif, direccion_fiscal, telefono, email,
           tasa_bcv, tasa_bcv_fecha, tasa_bcv_modo, medio_facturacion, tipo_contribuyente, igtf_activo,
           representante_nombre, representante_cedula, cierre_mensual_correo
         ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTOMATICO', 'APP_SENIAT', ?, ?, ?, ?, 0)`
      )
      .bind(
        plan.perfil.especialidad,
        plan.perfil.nombre_razon_social,
        plan.perfil.rif,
        plan.perfil.direccion_fiscal,
        plan.perfil.telefono,
        plan.perfil.email,
        plan.tasaBcv,
        ahoraIso,
        plan.perfil.tipo_contribuyente,
        plan.perfil.igtf_activo,
        plan.perfil.representante_nombre,
        plan.perfil.representante_cedula
      ),
    dbDemo.prepare(`UPDATE ajustes SET valor = 'REAL' WHERE clave = 'modo'`),
    dbDemo
      .prepare(`UPDATE metodos_cobro SET activo = 1, datos_json = ? WHERE metodo = 'PAGO_MOVIL'`)
      .bind(JSON.stringify({ banco: "Banesco (0134)", documento: plan.perfil.rif, telefono: "0414-5550199", nota: "Cuenta Demo Pago Móvil" })),
    dbDemo
      .prepare(`UPDATE metodos_cobro SET activo = 1, datos_json = ? WHERE metodo = 'TRANSFERENCIA'`)
      .bind(JSON.stringify({ banco: "Banco Mercantil (0105)", cuenta: "01050011223344556677", tipo: "Corriente", titular: plan.perfil.nombre_razon_social, documento: plan.perfil.rif })),
    dbDemo
      .prepare(`UPDATE metodos_cobro SET activo = 1, datos_json = ? WHERE metodo = 'ZELLE'`)
      .bind(JSON.stringify({ contacto: "pagos@demo.facturayave.com", titular: plan.perfil.nombre_razon_social })),
    dbDemo
      .prepare(`UPDATE metodos_cobro SET activo = 1, datos_json = ? WHERE metodo = 'BINANCE'`)
      .bind(JSON.stringify({ contacto: "binance-demo@facturayave.com", titular: plan.perfil.nombre_razon_social })),
    dbDemo.prepare(`UPDATE metodos_cobro SET activo = 1, datos_json = '{}' WHERE metodo = 'EFECTIVO'`),
    dbDemo
      .prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES (?, ?, ?, 'ADMIN', 1, 0)`)
      .bind("Administrador Demo", CORREOS_DEMO.ADMIN, hashDemo),
    dbDemo
      .prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES (?, ?, ?, 'CAJERO', 1, 0)`)
      .bind("Cajero Demo", CORREOS_DEMO.CAJERO, hashDemo),
    dbDemo
      .prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo, debe_cambiar_clave) VALUES (?, ?, ?, 'CONTADOR', 1, 0)`)
      .bind("Contador Demo", CORREOS_DEMO.CONTADOR, hashDemo),
  ]);

  // 3) Insertar clientes, proveedores y catálogo
  await dbDemo.batch(
    plan.clientes.map((cl) =>
      dbDemo
        .prepare(`INSERT INTO clientes (rif_cedula, nombre_apellido, direccion, whatsapp, email) VALUES (?, ?, ?, ?, ?)`)
        .bind(cl.rif_cedula, cl.nombre_apellido, cl.direccion, cl.whatsapp, cl.email)
    )
  );
  await dbDemo.batch(
    plan.proveedores.map((pr) =>
      dbDemo
        .prepare(`INSERT INTO proveedores (rif, nombre, direccion, whatsapp, email) VALUES (?, ?, ?, ?, ?)`)
        .bind(pr.rif, pr.nombre, pr.direccion, pr.whatsapp, pr.email)
    )
  );
  await dbDemo.batch(
    plan.catalogo.map((it) =>
      dbDemo
        .prepare(
          `INSERT INTO catalogo (codigo, nombre, tipo, costo_centavos, precio_centavos, alicuota_iva, activo, controla_stock, stock_minimo_milli)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .bind(
          it.codigo,
          it.nombre,
          it.tipo,
          it.costo_centavos,
          it.precio_centavos,
          it.alicuota_iva,
          it.tipo === "PRODUCTO" ? 1 : 0,
          it.stock_minimo_milli
        )
    )
  );

  // Recuperar IDs reales insertados
  const [{ results: cliRows }, { results: provRows }, { results: catRows }] = await Promise.all([
    dbDemo.prepare(`SELECT id, rif_cedula, nombre_apellido, direccion, whatsapp, email FROM clientes ORDER BY id ASC`).all<Record<string, any>>(),
    dbDemo.prepare(`SELECT id, rif, nombre FROM proveedores ORDER BY id ASC`).all<Record<string, any>>(),
    dbDemo.prepare(`SELECT id, codigo, nombre, tipo, costo_centavos, precio_centavos, alicuota_iva FROM catalogo ORDER BY id ASC`).all<Record<string, any>>(),
  ]);

  // 4) Sembrar compras de mercancía + gastos operativos en los 3 meses (alimentan stock y Libro de Compras SENIAT)
  const productosCat = catRows
    .map((c, idx) => ({ row: c, meta: plan.catalogo[idx] }))
    .filter((x) => x.row.tipo === "PRODUCTO");

  const comprasPlan: Array<{
    mesOffset: number;
    dia: number;
    provIdx: number;
    numFac: string;
    control: string;
    nota: string;
    lineas: Array<{
      tipo: "PRODUCTO" | "GASTO";
      categoria?: string;
      producto_id: number | null;
      descripcion: string;
      cantidad_milli: number;
      costo_usd: number;
      alicuota_cent: number;
    }>;
  }> = [
    {
      mesOffset: -2,
      dia: 1,
      provIdx: 0,
      numFac: "00018410",
      control: "00-0098410",
      nota: "Reposición inicial de inventario (Demo)",
      lineas: productosCat.slice(0, 3).map((p) => ({
        tipo: "PRODUCTO",
        producto_id: p.row.id,
        descripcion: p.row.nombre,
        cantidad_milli: Math.max(15000, p.meta.stock_inicial_milli),
        costo_usd: p.row.costo_centavos,
        alicuota_cent: p.row.alicuota_iva * 100,
      })),
    },
    {
      mesOffset: -2,
      dia: 2,
      provIdx: 1,
      numFac: "00024901",
      control: "00-0041901",
      nota: "Compra de mercancía lote B (Demo)",
      lineas: productosCat.slice(3).map((p) => ({
        tipo: "PRODUCTO",
        producto_id: p.row.id,
        descripcion: p.row.nombre,
        cantidad_milli: Math.max(15000, p.meta.stock_inicial_milli),
        costo_usd: p.row.costo_centavos,
        alicuota_cent: p.row.alicuota_iva * 100,
      })),
    },
    {
      mesOffset: -2,
      dia: 5,
      provIdx: 2,
      numFac: "ALQ-2026-01",
      control: "00-0011001",
      nota: "Alquiler de local comercial",
      lineas: [{ tipo: "GASTO", categoria: "ALQUILER", producto_id: null, descripcion: "Alquiler mensual de oficina/local", cantidad_milli: 1000, costo_usd: 35000, alicuota_cent: regimen === "FORMAL" ? 0 : 1600 }],
    },
    {
      mesOffset: -1,
      dia: 3,
      provIdx: 0,
      numFac: "00018922",
      control: "00-0098922",
      nota: "Reposición de stock mes anterior",
      lineas: productosCat.slice(0, 2).map((p) => ({
        tipo: "PRODUCTO",
        producto_id: p.row.id,
        descripcion: p.row.nombre,
        cantidad_milli: 12000,
        costo_usd: p.row.costo_centavos,
        alicuota_cent: p.row.alicuota_iva * 100,
      })),
    },
    {
      mesOffset: -1,
      dia: 5,
      provIdx: 2,
      numFac: "ALQ-2026-02",
      control: "00-0011002",
      nota: "Alquiler de local comercial",
      lineas: [{ tipo: "GASTO", categoria: "ALQUILER", producto_id: null, descripcion: "Alquiler mensual de oficina/local", cantidad_milli: 1000, costo_usd: 35000, alicuota_cent: regimen === "FORMAL" ? 0 : 1600 }],
    },
    {
      mesOffset: -1,
      dia: 12,
      provIdx: 3,
      numFac: "FIB-90412",
      control: "00-0077412",
      nota: "Internet fibra óptica corporativo",
      lineas: [{ tipo: "GASTO", categoria: "SERVICIOS", producto_id: null, descripcion: "Servicio Internet Fibra Empresarial 500Mbps", cantidad_milli: 1000, costo_usd: 8500, alicuota_cent: 1600 }],
    },
    {
      mesOffset: 0,
      dia: 2,
      provIdx: 1,
      numFac: "00025318",
      control: "00-0042318",
      nota: "Reposición mensual de productos",
      lineas: productosCat.slice(0, 3).map((p) => ({
        tipo: "PRODUCTO",
        producto_id: p.row.id,
        descripcion: p.row.nombre,
        cantidad_milli: 10000,
        costo_usd: p.row.costo_centavos,
        alicuota_cent: p.row.alicuota_iva * 100,
      })),
    },
    {
      mesOffset: 0,
      dia: 4,
      provIdx: 3,
      numFac: "FIB-91005",
      control: "00-0078005",
      nota: "Internet fibra óptica mes actual",
      lineas: [{ tipo: "GASTO", categoria: "SERVICIOS", producto_id: null, descripcion: "Servicio Internet Fibra Empresarial 500Mbps", cantidad_milli: 1000, costo_usd: 8500, alicuota_cent: 1600 }],
    },
  ];

  for (const cp of comprasPlan) {
    if (!cp.lineas.length) continue;
    const prov = provRows[cp.provIdx % provRows.length];
    const fechaC = fechaEnMesRelativo(hoyIso, cp.mesOffset, cp.dia);
    const factorTasa = cp.mesOffset === -2 ? 0.94 : cp.mesOffset === -1 ? 0.97 : 1;
    const tasaCompraE8 = aTasaE8((plan.tasaBcv * factorTasa).toFixed(4));
    const calc = calcular(
      cp.lineas.map((l) => ({ cantidad_milli: l.cantidad_milli, precio_usd: l.costo_usd, alicuota_cent: l.alicuota_cent })),
      tasaCompraE8
    );
    const insCompra = await dbDemo
      .prepare(
        `INSERT INTO compras (
           modo, proveedor_id, proveedor_rif, proveedor_nombre, factura_numero, control_numero, fecha, estado,
           subtotal_usd, iva_usd, total_usd, tasa_e8, subtotal_bs, iva_bs, total_bs, nota, renglones_json, registrado_en, registrado_por
         ) VALUES ('REAL', ?, ?, ?, ?, ?, ?, 'REGISTRADA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) RETURNING id`
      )
      .bind(
        prov.id,
        prov.rif,
        prov.nombre,
        cp.numFac,
        cp.control,
        fechaC,
        calc.subtotal_usd,
        calc.iva_usd,
        calc.total_usd,
        tasaCompraE8,
        calc.subtotal_bs,
        calc.iva_bs,
        calc.total_bs,
        cp.nota,
        JSON.stringify(cp.lineas),
        `${fechaC}T10:30:00Z`
      )
      .first<{ id: number }>();

    const compraId = insCompra!.id;
    const batchComp: D1PreparedStatement[] = [];
    for (const imp of calc.impuestos) {
      batchComp.push(
        dbDemo
          .prepare(`INSERT INTO compra_impuestos (compra_id, alicuota_cent, base_usd, iva_usd, base_bs, iva_bs) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(compraId, imp.alicuota_cent, imp.base_usd, imp.iva_usd, imp.base_bs, imp.iva_bs)
      );
    }
    for (const l of cp.lineas) {
      if (l.tipo === "PRODUCTO" && l.producto_id) {
        const valorUsd = Math.round((l.cantidad_milli * l.costo_usd) / 1000);
        batchComp.push(
          dbDemo
            .prepare(
              `INSERT INTO movimientos_stock (producto_id, modo, tipo, cantidad_milli, valor_usd, compra_id, nota, fecha, creado_en, creado_por)
               VALUES (?, 'REAL', 'COMPRA', ?, ?, ?, ?, ?, ?, 1)`
            )
            .bind(l.producto_id, l.cantidad_milli, valorUsd, compraId, `Compra ${cp.numFac}`, fechaC, `${fechaC}T10:30:00Z`)
        );
      }
    }
    if (batchComp.length) await dbDemo.batch(batchComp);
  }

  // 5) Sembrar 24 facturas reales en DB_DEMO, sus renglones, impuestos, salidas de stock y pagos/retenciones
  const emisorSnap = JSON.stringify({
    nombre_razon_social: plan.perfil.nombre_razon_social,
    rif: plan.perfil.rif,
    direccion_fiscal: plan.perfil.direccion_fiscal,
    telefono: plan.perfil.telefono,
    email: plan.perfil.email,
    tipo_contribuyente: plan.perfil.tipo_contribuyente,
    es_demo: true,
  });
  const paramsSnap = JSON.stringify({
    leyenda_cambio:
      "Montos expresados en bolívares (Bs.) con su equivalente en dólares (USD) a la tasa de cambio BCV vigente a la fecha de emisión.",
    validez_presupuesto_dias: "15",
    es_demo: true,
  });

  let seqFactura = 0;
  let seqControl = 0;
  let seqRecibo = 0;
  let seqRetComprobante = 1;
  const facturasEmitidasIds: Array<{ id: number; numero: number; fecha: string; clienteIdx: number; items: Array<{ catIdx: number; cantidadMilli: number }>; tasaE8: number }> = [];

  for (const fp of plan.facturas) {
    seqFactura++;
    seqControl++;
    const cli = cliRows[fp.clienteIdx % cliRows.length];
    const fechaEmision = fechaEnMesRelativo(hoyIso, fp.mesOffset, fp.dia);
    const venceEl = fp.condicion === "CREDITO" && fp.diasCredito ? masDias(fechaEmision, fp.diasCredito) : fechaEmision;
    const factorTasa = fp.mesOffset === -2 ? 0.95 : fp.mesOffset === -1 ? 0.98 : 1;
    const tasaFacE8 = aTasaE8((plan.tasaBcv * factorTasa).toFixed(4));

    const renglonesCalc = fp.items.map((it) => {
      const cat = catRows[it.catIdx % catRows.length];
      return {
        cat,
        cantidad_milli: it.cantidadMilli,
        precio_usd: cat.precio_centavos,
        costo_usd: cat.costo_centavos,
        alicuota_cent: regimen === "FORMAL" ? 0 : cat.alicuota_iva * 100,
      };
    });

    const calc = calcular(
      renglonesCalc.map((r) => ({ cantidad_milli: r.cantidad_milli, precio_usd: r.precio_usd, alicuota_cent: r.alicuota_cent })),
      tasaFacE8,
      fp.aplicaIgtf ? 300 : 0
    );
    const costoTotalUsd = renglonesCalc.reduce((acc, r) => acc + Math.round((r.cantidad_milli * (r.costo_usd || 0)) / 1000), 0);

    // Insertar como BORRADOR primero para poblar renglones/impuestos, luego emitir (respetando todos los triggers SENIAT!)
    const insDoc = await dbDemo
      .prepare(
        `INSERT INTO documentos (
           tipo, estado, modo, numero, control_interno, control_fiscal, medio,
           cliente_id, cliente_rif, cliente_nombre, cliente_direccion, cliente_whatsapp, cliente_email,
           nota, fecha_emision, emitido_en, tasa_e8, tasa_cargada_en,
           subtotal_usd, iva_usd, aplica_igtf, igtf_alicuota_cent, igtf_usd, total_usd,
           subtotal_bs, iva_bs, igtf_bs, total_bs, costo_total_usd,
           parametros_json, emisor_json, condicion, dias_credito, vence_el, creado_por
         ) VALUES (
           'FACTURA', 'BORRADOR', 'REAL', ?, ?, ?, 'APP_SENIAT',
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, 1
         ) RETURNING id`
      )
      .bind(
        seqFactura,
        seqControl,
        `DEMO-${String(seqControl).padStart(8, "0")}`,
        cli.id,
        cli.rif_cedula,
        cli.nombre_apellido,
        cli.direccion,
        cli.whatsapp,
        cli.email,
        fp.nota || null,
        fechaEmision,
        `${fechaEmision}T14:15:00Z`,
        tasaFacE8,
        `${fechaEmision}T09:00:00Z`,
        calc.subtotal_usd,
        calc.iva_usd,
        fp.aplicaIgtf ? 1 : 0,
        fp.aplicaIgtf ? 300 : 0,
        calc.igtf_usd,
        calc.total_usd,
        calc.subtotal_bs,
        calc.iva_bs,
        calc.igtf_bs,
        calc.total_bs,
        costoTotalUsd,
        paramsSnap,
        emisorSnap,
        fp.condicion,
        fp.diasCredito,
        venceEl
      )
      .first<{ id: number }>();

    const docId = insDoc!.id;
    const batchDoc: D1PreparedStatement[] = [];
    renglonesCalc.forEach((r, idx) => {
      const lCalc = calc.renglones[idx];
      batchDoc.push(
        dbDemo
          .prepare(
            `INSERT INTO documento_renglones (documento_id, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd, monto_bs)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            docId,
            idx + 1,
            r.cat.id,
            r.cat.tipo,
            r.cat.nombre,
            r.cantidad_milli,
            r.precio_usd,
            r.costo_usd,
            r.alicuota_cent,
            lCalc.monto_usd,
            lCalc.monto_bs
          )
      );
      if (r.cat.tipo === "PRODUCTO") {
        const valorSalida = -Math.round((r.cantidad_milli * (r.costo_usd || 0)) / 1000);
        batchDoc.push(
          dbDemo
            .prepare(
              `INSERT INTO movimientos_stock (producto_id, modo, tipo, cantidad_milli, valor_usd, documento_id, nota, fecha, creado_en, creado_por)
               VALUES (?, 'REAL', 'VENTA', ?, ?, ?, ?, ?, ?, 1)`
            )
            .bind(r.cat.id, -r.cantidad_milli, valorSalida, docId, `Factura ${String(seqFactura).padStart(8, "0")}`, fechaEmision, `${fechaEmision}T14:15:00Z`)
        );
      }
    });
    for (const imp of calc.impuestos) {
      batchDoc.push(
        dbDemo
          .prepare(`INSERT INTO documento_impuestos (documento_id, alicuota_cent, base_usd, iva_usd, base_bs, iva_bs) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(docId, imp.alicuota_cent, imp.base_usd, imp.iva_usd, imp.base_bs, imp.iva_bs)
      );
    }
    batchDoc.push(dbDemo.prepare(`UPDATE documentos SET estado = 'EMITIDO' WHERE id = ?`).bind(docId));
    await dbDemo.batch(batchDoc);

    facturasEmitidasIds.push({ id: docId, numero: seqFactura, fecha: fechaEmision, clienteIdx: fp.clienteIdx, items: fp.items, tasaE8: tasaFacE8 ?? plan.tasaE8 ?? 9550000000 });

    // Registrar pagos (y retenciones IVA / ISLR cuando aplique)
    if (fp.pago) {
      let saldoRestanteUsd = calc.total_usd;
      const pagosBatch: D1PreparedStatement[] = [];
      const fechaPago = fechaEmision;
      const reglasPago = JSON.stringify({ leyenda_recibo: "Recibo de pago demostrativo sin valor fiscal.", es_demo: true });

      if (fp.pago.conRetencionIva && calc.iva_usd > 0) {
        const retUsd = Math.round(calc.iva_usd * 0.75);
        if (retUsd > 0 && retUsd < saldoRestanteUsd) {
          seqRecibo++;
          const retBs = usdABs(retUsd, tasaFacE8);
          saldoRestanteUsd -= retUsd;
          const comp = `${fechaPago.slice(0, 4)}${fechaPago.slice(5, 7)}${String(seqRetComprobante++).padStart(8, "0")}`;
          pagosBatch.push(
            dbDemo
              .prepare(
                `INSERT INTO pagos (
                   documento_id, modo, numero, metodo, moneda, monto_recibido, tasa_e8, monto_usd, saldo_despues_usd,
                   referencia, nota, fecha_pago, registrado_en, registrado_por, reglas_json, estado, es_retencion_iva, comprobante_retencion
                 ) VALUES (?, 'REAL', ?, 'OTRO', 'BS', ?, ?, ?, ?, ?, 'Retención IVA 75% (Demo)', ?, ?, 1, ?, 'VIGENTE', 1, ?)`
              )
              .bind(docId, seqRecibo, retBs, tasaFacE8, retUsd, saldoRestanteUsd, comp, fechaPago, `${fechaPago}T15:00:00Z`, reglasPago, comp)
          );
        }
      }

      if (fp.pago.conRetencionIslr && calc.subtotal_usd > 0) {
        const retIslrUsd = Math.round(calc.subtotal_usd * 0.02);
        if (retIslrUsd > 0 && retIslrUsd < saldoRestanteUsd) {
          seqRecibo++;
          const retIslrBs = usdABs(retIslrUsd, tasaFacE8);
          saldoRestanteUsd -= retIslrUsd;
          const comp = `ISLR-${fechaPago.slice(0, 4)}${fechaPago.slice(5, 7)}-${String(seqRetComprobante++).padStart(4, "0")}`;
          pagosBatch.push(
            dbDemo
              .prepare(
                `INSERT INTO pagos (
                   documento_id, modo, numero, metodo, moneda, monto_recibido, tasa_e8, monto_usd, saldo_despues_usd,
                   referencia, nota, fecha_pago, registrado_en, registrado_por, reglas_json, estado, es_retencion_islr, porcentaje_retencion, comprobante_retencion
                 ) VALUES (?, 'REAL', ?, 'OTRO', 'BS', ?, ?, ?, ?, ?, 'Retención ISLR 2% (Demo)', ?, ?, 1, ?, 'VIGENTE', 1, 200, ?)`
              )
              .bind(docId, seqRecibo, retIslrBs, tasaFacE8, retIslrUsd, saldoRestanteUsd, comp, fechaPago, `${fechaPago}T15:05:00Z`, reglasPago, comp)
          );
        }
      }

      const montoCobrarUsd = fp.pago.fraccion === 1 ? saldoRestanteUsd : Math.max(100, Math.round(saldoRestanteUsd * 0.5));
      if (montoCobrarUsd > 0) {
        seqRecibo++;
        const saldoDespues = Math.max(0, saldoRestanteUsd - montoCobrarUsd);
        const montoRecibido = fp.pago.moneda === "BS" ? usdABs(montoCobrarUsd, tasaFacE8) : montoCobrarUsd;
        const ref = `${fp.pago.metodo.slice(0, 3)}-${String(104200 + seqRecibo)}`;
        pagosBatch.push(
          dbDemo
            .prepare(
              `INSERT INTO pagos (
                 documento_id, modo, numero, metodo, moneda, monto_recibido, tasa_e8, monto_usd, saldo_despues_usd,
                 referencia, nota, fecha_pago, registrado_en, registrado_por, reglas_json, estado
               ) VALUES (?, 'REAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'VIGENTE')`
            )
            .bind(
              docId,
              seqRecibo,
              fp.pago.metodo,
              fp.pago.moneda,
              montoRecibido,
              fp.pago.moneda === "BS" ? tasaFacE8 : null,
              montoCobrarUsd,
              saldoDespues,
              ref,
              fp.pago.fraccion === 1 ? "Pago total recibido (Demo)" : "Abono parcial (Demo)",
              fechaPago,
              `${fechaPago}T15:10:00Z`,
              reglasPago
            )
        );
      }

      if (pagosBatch.length) await dbDemo.batch(pagosBatch);
    }
  }

  // 6) Sembrar 1 Nota de Crédito (devolución parcial), 1 Nota de Débito (recargo) y 2 Presupuestos activos + 1 Borrador
  let seqNc = 0;
  let seqNd = 0;
  let seqPres = 0;

  const facParaNc = facturasEmitidasIds[facturasEmitidasIds.length - 5];
  if (facParaNc) {
    seqNc++;
    seqControl++;
    const cli = cliRows[facParaNc.clienteIdx % cliRows.length];
    const cat = catRows[facParaNc.items[0].catIdx % catRows.length];
    const alic = regimen === "FORMAL" ? 0 : cat.alicuota_iva * 100;
    const calcNc = calcular([{ cantidad_milli: 1000, precio_usd: cat.precio_centavos, alicuota_cent: alic }], facParaNc.tasaE8);
    const insNc = await dbDemo
      .prepare(
        `INSERT INTO documentos (
           tipo, estado, modo, es_nota_credito, factura_afectada_id, motivo_nc, numero, control_interno, control_fiscal, medio,
           cliente_id, cliente_rif, cliente_nombre, cliente_direccion, cliente_whatsapp, cliente_email,
           nota, fecha_emision, emitido_en, tasa_e8, tasa_cargada_en,
           subtotal_usd, iva_usd, total_usd, subtotal_bs, iva_bs, total_bs, costo_total_usd,
           parametros_json, emisor_json, condicion, vence_el, creado_por
         ) VALUES (
           'FACTURA', 'BORRADOR', 'REAL', 1, ?, 'Ajuste / devolución parcial de demostración', ?, ?, ?, 'APP_SENIAT',
           ?, ?, ?, ?, ?, ?,
           'Nota de crédito demostrativa', ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?,
           ?, ?, 'CONTADO', ?, 1
         ) RETURNING id`
      )
      .bind(
        facParaNc.id,
        seqNc,
        seqControl,
        `DEMO-${String(seqControl).padStart(8, "0")}`,
        cli.id,
        cli.rif_cedula,
        cli.nombre_apellido,
        cli.direccion,
        cli.whatsapp,
        cli.email,
        hoyIso,
        `${hoyIso}T11:00:00Z`,
        facParaNc.tasaE8,
        `${hoyIso}T09:00:00Z`,
        calcNc.subtotal_usd,
        calcNc.iva_usd,
        calcNc.total_usd,
        calcNc.subtotal_bs,
        calcNc.iva_bs,
        calcNc.total_bs,
        cat.costo_centavos || 0,
        JSON.stringify({ ...JSON.parse(paramsSnap), factura_afectada_numero: facParaNc.numero, factura_afectada_fecha: facParaNc.fecha }),
        emisorSnap,
        hoyIso
      )
      .first<{ id: number }>();

    await dbDemo.batch([
      dbDemo
        .prepare(
          `INSERT INTO documento_renglones (documento_id, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd, monto_bs)
           VALUES (?, 1, ?, ?, ?, 1000, ?, ?, ?, ?, ?)`
        )
        .bind(insNc!.id, cat.id, cat.tipo, cat.nombre, cat.precio_centavos, cat.costo_centavos, alic, calcNc.renglones[0].monto_usd, calcNc.renglones[0].monto_bs),
      ...calcNc.impuestos.map((imp) =>
        dbDemo
          .prepare(`INSERT INTO documento_impuestos (documento_id, alicuota_cent, base_usd, iva_usd, base_bs, iva_bs) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(insNc!.id, imp.alicuota_cent, imp.base_usd, imp.iva_usd, imp.base_bs, imp.iva_bs)
      ),
      dbDemo.prepare(`UPDATE documentos SET estado = 'EMITIDO' WHERE id = ?`).bind(insNc!.id),
    ]);
  }

  const facParaNd = facturasEmitidasIds[facturasEmitidasIds.length - 3];
  if (facParaNd) {
    seqNd++;
    seqControl++;
    const cli = cliRows[facParaNd.clienteIdx % cliRows.length];
    const alic = regimen === "FORMAL" ? 0 : 1600;
    const calcNd = calcular([{ cantidad_milli: 1000, precio_usd: 1500, alicuota_cent: alic }], plan.tasaE8);
    const insNd = await dbDemo
      .prepare(
        `INSERT INTO documentos (
           tipo, estado, modo, es_nota_debito, factura_afectada_id, motivo_nc, numero, control_interno, control_fiscal, medio,
           cliente_id, cliente_rif, cliente_nombre, cliente_direccion, cliente_whatsapp, cliente_email,
           nota, fecha_emision, emitido_en, tasa_e8, tasa_cargada_en,
           subtotal_usd, iva_usd, total_usd, subtotal_bs, iva_bs, total_bs, costo_total_usd,
           parametros_json, emisor_json, condicion, vence_el, creado_por
         ) VALUES (
           'FACTURA', 'BORRADOR', 'REAL', 1, ?, 'Recargo por despacho urgente (Demo)', ?, ?, ?, 'APP_SENIAT',
           ?, ?, ?, ?, ?, ?,
           'Nota de débito demostrativa', ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, 0,
           ?, ?, 'CONTADO', ?, 1
         ) RETURNING id`
      )
      .bind(
        facParaNd.id,
        seqNd,
        seqControl,
        `DEMO-${String(seqControl).padStart(8, "0")}`,
        cli.id,
        cli.rif_cedula,
        cli.nombre_apellido,
        cli.direccion,
        cli.whatsapp,
        cli.email,
        hoyIso,
        `${hoyIso}T11:30:00Z`,
        plan.tasaE8,
        `${hoyIso}T09:00:00Z`,
        calcNd.subtotal_usd,
        calcNd.iva_usd,
        calcNd.total_usd,
        calcNd.subtotal_bs,
        calcNd.iva_bs,
        calcNd.total_bs,
        JSON.stringify({ ...JSON.parse(paramsSnap), factura_afectada_numero: facParaNd.numero, factura_afectada_fecha: facParaNd.fecha }),
        emisorSnap,
        hoyIso
      )
      .first<{ id: number }>();

    await dbDemo.batch([
      dbDemo
        .prepare(
          `INSERT INTO documento_renglones (documento_id, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd, monto_bs)
           VALUES (?, 1, NULL, 'SERVICIO', 'Recargo por entrega express', 1000, 1500, 0, ?, ?, ?)`
        )
        .bind(insNd!.id, alic, calcNd.renglones[0].monto_usd, calcNd.renglones[0].monto_bs),
      ...calcNd.impuestos.map((imp) =>
        dbDemo
          .prepare(`INSERT INTO documento_impuestos (documento_id, alicuota_cent, base_usd, iva_usd, base_bs, iva_bs) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(insNd!.id, imp.alicuota_cent, imp.base_usd, imp.iva_usd, imp.base_bs, imp.iva_bs)
      ),
      dbDemo.prepare(`UPDATE documentos SET estado = 'EMITIDO' WHERE id = ?`).bind(insNd!.id),
    ]);
  }

  // 2 Presupuestos emitidos listos para que el prospecto pruebe "Convertir a Factura"
  for (const [idxP, cliIdx] of [
    [0, 6],
    [1, 8],
  ] as const) {
    seqPres++;
    const cli = cliRows[cliIdx % cliRows.length];
    const c1 = catRows[idxP % catRows.length];
    const c2 = catRows[(idxP + 6) % catRows.length];
    const alic1 = regimen === "FORMAL" ? 0 : c1.alicuota_iva * 100;
    const alic2 = regimen === "FORMAL" ? 0 : c2.alicuota_iva * 100;
    const calcP = calcular(
      [
        { cantidad_milli: 2000, precio_usd: c1.precio_centavos, alicuota_cent: alic1 },
        { cantidad_milli: 1000, precio_usd: c2.precio_centavos, alicuota_cent: alic2 },
      ],
      plan.tasaE8
    );
    const insP = await dbDemo
      .prepare(
        `INSERT INTO documentos (
           tipo, estado, modo, numero, cliente_id, cliente_rif, cliente_nombre, cliente_direccion, cliente_whatsapp, cliente_email,
           nota, fecha_emision, emitido_en, tasa_e8, tasa_cargada_en,
           subtotal_usd, iva_usd, total_usd, subtotal_bs, iva_bs, total_bs, costo_total_usd,
           parametros_json, emisor_json, condicion, creado_por
         ) VALUES (
           'PRESUPUESTO', 'BORRADOR', 'REAL', ?, ?, ?, ?, ?, ?, ?,
           'Presupuesto vigente de demostración — prueba el botón Convertir a Factura', ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?,
           ?, ?, 'CONTADO', 1
         ) RETURNING id`
      )
      .bind(
        seqPres,
        cli.id,
        cli.rif_cedula,
        cli.nombre_apellido,
        cli.direccion,
        cli.whatsapp,
        cli.email,
        hoyIso,
        `${hoyIso}T12:00:00Z`,
        plan.tasaE8,
        `${hoyIso}T09:00:00Z`,
        calcP.subtotal_usd,
        calcP.iva_usd,
        calcP.total_usd,
        calcP.subtotal_bs,
        calcP.iva_bs,
        calcP.total_bs,
        (c1.costo_centavos || 0) * 2 + (c2.costo_centavos || 0),
        paramsSnap,
        emisorSnap
      )
      .first<{ id: number }>();

    await dbDemo.batch([
      dbDemo
        .prepare(
          `INSERT INTO documento_renglones (documento_id, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd, monto_bs)
           VALUES (?, 1, ?, ?, ?, 2000, ?, ?, ?, ?, ?)`
        )
        .bind(insP!.id, c1.id, c1.tipo, c1.nombre, c1.precio_centavos, c1.costo_centavos, alic1, calcP.renglones[0].monto_usd, calcP.renglones[0].monto_bs),
      dbDemo
        .prepare(
          `INSERT INTO documento_renglones (documento_id, orden, catalogo_id, tipo, descripcion, cantidad_milli, precio_usd, costo_usd, alicuota_cent, monto_usd, monto_bs)
           VALUES (?, 2, ?, ?, ?, 1000, ?, ?, ?, ?, ?)`
        )
        .bind(insP!.id, c2.id, c2.tipo, c2.nombre, c2.precio_centavos, c2.costo_centavos, alic2, calcP.renglones[1].monto_usd, calcP.renglones[1].monto_bs),
      ...calcP.impuestos.map((imp) =>
        dbDemo
          .prepare(`INSERT INTO documento_impuestos (documento_id, alicuota_cent, base_usd, iva_usd, base_bs, iva_bs) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(insP!.id, imp.alicuota_cent, imp.base_usd, imp.iva_usd, imp.base_bs, imp.iva_bs)
      ),
      dbDemo.prepare(`UPDATE documentos SET estado = 'EMITIDO' WHERE id = ?`).bind(insP!.id),
    ]);
  }

  // 7) Actualizar contadores atómicos al último correlativo sembrado
  await dbDemo.batch([
    dbDemo.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'FACTURA:REAL'`).bind(seqFactura),
    dbDemo.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'CONTROL:REAL'`).bind(seqControl),
    dbDemo.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'NOTA_CREDITO:REAL'`).bind(seqNc),
    dbDemo.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'NOTA_DEBITO:REAL'`).bind(seqNd),
    dbDemo.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'PRESUPUESTO:REAL'`).bind(seqPres),
    dbDemo.prepare(`UPDATE contadores SET valor = ? WHERE clave = 'RECIBO:REAL'`).bind(seqRecibo),
    dbDemo
      .prepare(`INSERT INTO auditoria (usuario_id, accion, detalle, ip) VALUES (1, 'DEMO_SEMBRADO', ?, 'sistema')`)
      .bind(`${regimen} · ${seqFactura} fac · ${comprasPlan.length} comp · ${duracionMin}m`),
  ]);

  // 8) Registrar correos demo en _mt_directorio y guardar estado en _mt_demo_estado (en rawDb principal)
  await registrarCorreoDirectorio(rawDb, CORREOS_DEMO.ADMIN, CODIGO_DEMO, "ADMIN", envObj);
  await registrarCorreoDirectorio(rawDb, CORREOS_DEMO.CAJERO, CODIGO_DEMO, "CAJERO", envObj);
  await registrarCorreoDirectorio(rawDb, CORREOS_DEMO.CONTADOR, CODIGO_DEMO, "CONTADOR", envObj);

  await rawDb
    .prepare(
      `INSERT INTO _mt_demo_estado (
         id, activo, regimen, nombre_negocio, email_prospecto, clave_demo, correos_enviados, max_correos,
         duracion_min, creado_en, expira_en, limpiado, actualizado_en
       ) VALUES (1, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         activo = 1, regimen = excluded.regimen, nombre_negocio = excluded.nombre_negocio,
         email_prospecto = excluded.email_prospecto, clave_demo = excluded.clave_demo,
         correos_enviados = 0, max_correos = excluded.max_correos, duracion_min = excluded.duracion_min,
         creado_en = excluded.creado_en, expira_en = excluded.expira_en, limpiado = 0, actualizado_en = datetime('now')`
    )
    .bind(regimen, plan.perfil.nombre_razon_social, emailProspecto, claveDemo, MAX_CORREOS_DEMO_DEFECTO, duracionMin, ahoraSeg, expiraEn)
    .run();

  invalidarCacheInquilinos(rawDb);
  const estado = await obtenerEstadoDemo(rawDb, envObj);
  return {
    ok: true as const,
    estado,
    credenciales: {
      admin: CORREOS_DEMO.ADMIN,
      cajero: CORREOS_DEMO.CAJERO,
      contador: CORREOS_DEMO.CONTADOR,
      clave: claveDemo,
    },
    invitacion_whatsapp: construirInvitacionWhatsappDemo({
      nombre_negocio: plan.perfil.nombre_razon_social,
      regimen,
      clave_demo: claveDemo,
      expira_hora_caracas: estado.expira_hora_caracas,
      duracion_min: duracionMin,
      email_prospecto: emailProspecto || undefined,
      max_correos: MAX_CORREOS_DEMO_DEFECTO,
    }),
    resumen_semilla: {
      clientes: cliRows.length,
      catalogo: catRows.length,
      proveedores: provRows.length,
      compras: comprasPlan.length,
      facturas: seqFactura,
      notas_credito: seqNc,
      notas_debito: seqNd,
      presupuestos: seqPres,
      recibos: seqRecibo,
    },
  };
}

export async function leerFilaDemoEstado(rawDb: D1Database): Promise<FilaDemoEstado | null> {
  return rawDb
    .prepare(`SELECT * FROM _mt_demo_estado WHERE id = 1`)
    .first<FilaDemoEstado>()
    .catch(() => null);
}

export async function obtenerEstadoDemo(rawDb: D1Database, envObj: Record<string, unknown>, ahoraSeg = ahora()) {
  await asegurarTablasMultiTenant(rawDb, envObj);
  const fila = await leerFilaDemoEstado(rawDb);
  const est = calcularEstadoDemo(fila, ahoraSeg);
  return {
    ...est,
    db_demo_configurada: Boolean(obtenerDbDemoAislada(envObj, rawDb)),
    credenciales: est.activo
      ? {
          admin: CORREOS_DEMO.ADMIN,
          cajero: CORREOS_DEMO.CAJERO,
          contador: CORREOS_DEMO.CONTADOR,
          clave: est.clave_demo,
        }
      : null,
    invitacion_whatsapp: est.activo
      ? construirInvitacionWhatsappDemo({
          nombre_negocio: est.nombre_negocio,
          regimen: est.regimen,
          clave_demo: est.clave_demo,
          expira_hora_caracas: est.expira_hora_caracas,
          duracion_min: est.duracion_min,
          email_prospecto: est.email_prospecto || undefined,
          max_correos: est.max_correos,
        })
      : "",
  };
}

export async function extenderDemo(rawDb: D1Database, envObj: Record<string, unknown>, minutosExtra = 60) {
  await asegurarTablasMultiTenant(rawDb, envObj);
  const fila = await leerFilaDemoEstado(rawDb);
  const ahoraSeg = ahora();
  const est = calcularEstadoDemo(fila, ahoraSeg);
  if (!est.activo) {
    throw new Error("No hay una sesión demo activa para extender. Genera una nueva demo.");
  }
  const extra = Math.max(15, Math.min(180, Math.round(Number(minutosExtra) || 60)));
  const topeMax = ahoraSeg + 4 * 3600; // Máximo 4 horas desde el momento actual
  const nuevoExpira = Math.min(topeMax, est.expira_en + extra * 60);
  await rawDb
    .prepare(`UPDATE _mt_demo_estado SET expira_en = ?, duracion_min = duracion_min + ?, actualizado_en = datetime('now') WHERE id = 1`)
    .bind(nuevoExpira, extra)
    .run();
  invalidarCacheInquilinos(rawDb);
  return obtenerEstadoDemo(rawDb, envObj);
}

// Limpia DB_DEMO automáticamente cuando el tiempo expiró y aún no había sido borrada (invocado por Cron y en verificaciones perezosas).
export async function limpiarDemoExpiradaSiCorresponde(
  rawDb: D1Database,
  envObj: Record<string, unknown>,
  ahoraSeg = ahora()
): Promise<{ limpiada: boolean }> {
  await asegurarTablasMultiTenant(rawDb, envObj);
  const fila = await leerFilaDemoEstado(rawDb);
  if (!fila) return { limpiada: false };
  const expirada = Number(fila.expira_en || 0) > 0 && ahoraSeg >= Number(fila.expira_en || 0);
  const necesitaLimpieza = (Number(fila.activo || 0) === 1 && expirada) || (Number(fila.limpiado ?? 1) === 0 && expirada);
  if (!necesitaLimpieza) return { limpiada: false };
  await limpiarBaseDemo(rawDb, envObj);
  return { limpiada: true };
}

// Permite al Súper Admin entrar rápidamente a inspeccionar la Demo si está activa (y luego volver a su negocio principal).
export async function prepararVistaSuperAdminDemo(rawDb: D1Database, envObj: Record<string, unknown>, emailSuper: string) {
  await fijarVistaSuperAdmin(rawDb, CODIGO_DEMO, emailSuper, envObj);
}
