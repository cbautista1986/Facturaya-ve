// Arquitectura Multi-Tenant (Multi-Inquilino) para FacturaYa Venezuela.
// Permite a Cristian (SUPER_ADMIN) crear negocios aislados desde su Panel de Control en 1 clic sin entrar a Cloudflare
// (mediante tablas SQLite prefijadas t2_, t3_, t4_... 100% independientes) O conectar bases D1 físicas (DB_1, DB_2...).
import { EMAIL_SUPER_ADMIN } from "./permisos";

export const TABLAS_INQUILINO = [
  "_migraciones",
  "perfil_emisor",
  "usuarios",
  "sesiones",
  "intentos_login",
  "auditoria",
  "clientes",
  "catalogo",
  "ajustes",
  "contadores",
  "parametros_fiscales",
  "documentos",
  "documento_renglones",
  "documento_impuestos",
  "pagos",
  "metodos_cobro",
  "verificaciones",
  "proveedores",
  "compras",
  "compras_vieja",
  "movimientos_stock",
  "compra_impuestos",
  "medio_historial",
  "integraciones",
] as const;

export const OBJETOS_ESQUEMA_INQUILINO = [
  ...TABLAS_INQUILINO,
  "documento_pagos",
  "doc_no_borrar",
  "doc_inmutable",
  "renglon_no_cambiar",
  "renglon_no_borrar",
  "impuesto_no_cambiar",
  "impuesto_no_borrar",
  "pago_no_borrar",
  "pago_inmutable",
  "mov_no_cambiar",
  "mov_no_borrar",
  "compra_no_borrar",
  "compra_inmutable",
  "compra_impuestos_no_cambiar",
  "compra_impuestos_no_borrar",
  "idx_doc_numero",
  "idx_doc_cliente",
  "idx_doc_estado",
  "idx_doc_afectada",
  "documentos_fiscal_unico",
  "idx_pago_numero",
  "idx_pago_documento",
  "idx_compra_factura",
  "idx_mov_producto",
  "idx_mov_documento",
] as const;

const REGEX_OBJETOS = new RegExp(`\\b(${OBJETOS_ESQUEMA_INQUILINO.join("|")})\\b`, "g");

export function reescribirSqlInquilino(sql: string, prefijo: string): string {
  if (!prefijo) return sql;
  return sql.replace(REGEX_OBJETOS, `${prefijo}$1`);
}

// Envuelve una base D1 física para que todas las consultas operen sobre el espacio de tablas aislado del inquilino (ej. t2_documentos, t2_usuarios...)
export function crearDbInquilino(rawDb: D1Database, prefijo: string): D1Database {
  if (!prefijo) return rawDb;
  const r = rawDb as unknown as Record<string, (...args: unknown[]) => unknown>;
  return {
    prepare(query: string) {
      return rawDb.prepare(reescribirSqlInquilino(query, prefijo));
    },
    batch(statements: D1PreparedStatement[]) {
      return rawDb.batch(statements);
    },
    exec(query: string) {
      return typeof r.exec === "function" ? r.exec(reescribirSqlInquilino(query, prefijo)) : Promise.resolve({ count: 0, duration: 0 });
    },
    dump() {
      return typeof r.dump === "function" ? r.dump() : Promise.resolve(new ArrayBuffer(0));
    },
  } as unknown as D1Database;
}

export function obtenerDbInquilino(env: Record<string, unknown>, codigo: string): D1Database {
  const basePrincipal = env.DB as D1Database;
  if (!codigo || codigo === "principal") return basePrincipal;
  if (/^DB_\d+$/.test(codigo) && env[codigo] && typeof (env[codigo] as D1Database).prepare === "function") {
    return env[codigo] as D1Database;
  }
  if (/^t\d+$/.test(codigo)) {
    return crearDbInquilino(basePrincipal, `${codigo}_`);
  }
  return basePrincipal;
}

export type InquilinoInfo = {
  codigo: string;
  tipo_db: "PRINCIPAL" | "PREFIJO" | "BINDING";
  nombre_negocio: string;
  rif: string;
  direccion: string;
  telefono: string;
  nombre_dueno: string;
  email_dueno: string;
  medio_facturacion: string;
  plan_usd: number;
  activo: number;
  creado_en: string;
};

export async function asegurarTablasMultiTenant(rawDb: D1Database) {
  await rawDb.batch([
    rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_inquilinos (
      codigo TEXT PRIMARY KEY,
      tipo_db TEXT NOT NULL DEFAULT 'PREFIJO',
      nombre_negocio TEXT NOT NULL,
      rif TEXT NOT NULL,
      direccion TEXT NOT NULL DEFAULT '',
      telefono TEXT NOT NULL DEFAULT '',
      nombre_dueno TEXT NOT NULL,
      email_dueno TEXT NOT NULL,
      medio_facturacion TEXT NOT NULL DEFAULT 'APP_SENIAT',
      plan_usd INTEGER NOT NULL DEFAULT 10,
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_directorio (
      email TEXT PRIMARY KEY,
      inquilino_codigo TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'ADMIN',
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    rawDb.prepare(`CREATE TABLE IF NOT EXISTS _mt_super_vista (
      email TEXT PRIMARY KEY,
      inquilino_codigo TEXT NOT NULL,
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
  ]);

  // Sincronizar el negocio principal si ya está instalado y aún no figura en _mt_inquilinos
  const existePrincipal = await rawDb.prepare(`SELECT codigo FROM _mt_inquilinos WHERE codigo = 'principal'`).first();
  if (!existePrincipal) {
    try {
      const p = await rawDb.prepare(`SELECT instalado, nombre_razon_social, rif, direccion_fiscal, telefono, email, medio_facturacion FROM perfil_emisor WHERE id = 1`).first<Record<string, any>>();
      if (p?.instalado === 1) {
        const u = await rawDb.prepare(`SELECT nombre, email, rol FROM usuarios ORDER BY id ASC`).all<{ nombre: string; email: string; rol: string }>();
        const dueno = u.results.find((x) => x.rol === "SUPER_ADMIN" || x.rol === "ADMIN") ?? u.results[0];
        await rawDb.prepare(
          `INSERT OR IGNORE INTO _mt_inquilinos (codigo, tipo_db, nombre_negocio, rif, direccion, telefono, nombre_dueno, email_dueno, medio_facturacion, plan_usd, activo)
           VALUES ('principal', 'PRINCIPAL', ?, ?, ?, ?, ?, ?, ?, 0, 1)`
        ).bind(
          p.nombre_razon_social || "Mi Negocio Principal",
          p.rif || "",
          p.direccion_fiscal || "",
          p.telefono || "",
          dueno?.nombre || "Administrador",
          dueno?.email || EMAIL_SUPER_ADMIN,
          p.medio_facturacion || "APP_SENIAT"
        ).run();
        for (const usr of u.results) {
          await registrarCorreoDirectorio(rawDb, usr.email, "principal", usr.rol);
        }
      }
    } catch {
      // Si aún no se han corrido las migraciones de la base principal, se sincronizará al instalar
    }
  }
}

export async function registrarCorreoDirectorio(rawDb: D1Database, email: string, codigo: string, rol: string) {
  const limpio = String(email || "").trim().toLowerCase();
  if (!limpio) return;
  // El correo del Súper Administrador siempre conserva como base por defecto 'principal' (cambia de empresa con _mt_super_vista)
  const destino = limpio === EMAIL_SUPER_ADMIN ? "principal" : codigo;
  await rawDb.prepare(
    `INSERT INTO _mt_directorio (email, inquilino_codigo, rol, actualizado_en) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(email) DO UPDATE SET inquilino_codigo = excluded.inquilino_codigo, rol = excluded.rol, actualizado_en = datetime('now')`
  ).bind(limpio, destino, rol).run();
}

export async function buscarInquilinoPorCorreo(rawDb: D1Database, email: string): Promise<{ codigo: string; activo: boolean; nombre_negocio: string }> {
  const limpio = String(email || "").trim().toLowerCase();
  await asegurarTablasMultiTenant(rawDb);
  if (limpio === EMAIL_SUPER_ADMIN) {
    const vista = await rawDb.prepare(`SELECT inquilino_codigo FROM _mt_super_vista WHERE email = ?`).bind(limpio).first<{ inquilino_codigo: string }>();
    const cod = vista?.inquilino_codigo || "principal";
    const info = await rawDb.prepare(`SELECT nombre_negocio FROM _mt_inquilinos WHERE codigo = ?`).bind(cod).first<{ nombre_negocio: string }>();
    return { codigo: cod, activo: true, nombre_negocio: info?.nombre_negocio || "Negocio Principal" };
  }
  const dir = await rawDb.prepare(`SELECT inquilino_codigo FROM _mt_directorio WHERE email = ?`).bind(limpio).first<{ inquilino_codigo: string }>();
  const codigo = dir?.inquilino_codigo || "principal";
  if (codigo === "principal") {
    return { codigo: "principal", activo: true, nombre_negocio: "Negocio Principal" };
  }
  const inq = await rawDb.prepare(`SELECT activo, nombre_negocio FROM _mt_inquilinos WHERE codigo = ?`).bind(codigo).first<{ activo: number; nombre_negocio: string }>();
  if (!inq) return { codigo: "principal", activo: true, nombre_negocio: "Negocio Principal" };
  return { codigo, activo: inq.activo === 1, nombre_negocio: inq.nombre_negocio };
}

export async function fijarVistaSuperAdmin(rawDb: D1Database, codigo: string) {
  await asegurarTablasMultiTenant(rawDb);
  await rawDb.prepare(
    `INSERT INTO _mt_super_vista (email, inquilino_codigo, actualizado_en) VALUES (?, ?, datetime('now'))
     ON CONFLICT(email) DO UPDATE SET inquilino_codigo = excluded.inquilino_codigo, actualizado_en = datetime('now')`
  ).bind(EMAIL_SUPER_ADMIN, codigo).run();
}
