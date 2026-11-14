// Permisos por rol (Fase 7.1 + Escalón de Poder SaaS). UNA sola tabla decide quién puede qué: el servidor la aplica a CADA petición.
// Jerarquía: SUPER_ADMIN (Cristian / Plataforma) -> ADMIN (Dueño del negocio) -> SUPERVISOR -> CAJERO / BODEGA / CONTADOR.
export const EMAIL_SUPER_ADMIN = "cbautista1986@gmail.com";
export const ROLES = ["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "CAJERO", "BODEGA", "CONTADOR"] as const;
export type Rol = (typeof ROLES)[number];
export const NOMBRE_ROL: Record<string, string> = {
  SUPER_ADMIN: "Súper Administrador (Plataforma)",
  ADMIN: "Dueño / Administrador",
  SUPERVISOR: "Supervisor",
  CAJERO: "Cajero (Facturación y Cobros)",
  BODEGA: "Bodega (Inventario y Compras)",
  CONTADOR: "Contador (Libros e Informes SENIAT)",
};

export type Permiso = "super" | "admin" | "caja" | "anular" | "inventario" | "informes_caja" | "informes_contador" | "tasa";
const POR_ROL: Record<string, Permiso[]> = {
  SUPER_ADMIN: ["super", "admin", "caja", "anular", "inventario", "informes_caja", "informes_contador", "tasa"],
  ADMIN: ["admin", "caja", "anular", "inventario", "informes_caja", "informes_contador", "tasa"],
  SUPERVISOR: ["caja", "anular", "inventario", "informes_caja", "tasa"],
  CAJERO: ["caja"],
  BODEGA: ["inventario"],
  CONTADOR: ["informes_caja", "informes_contador"],
};

export const esSuperAdmin = (rol?: string, email?: string) =>
  rol === "SUPER_ADMIN" || String(email ?? "").trim().toLowerCase() === EMAIL_SUPER_ADMIN;

export const permisosDe = (rol: string, email?: string): Permiso[] => {
  const base = POR_ROL[rol] ?? [];
  if (esSuperAdmin(rol, email) && !base.includes("super")) return ["super", ... POR_ROL.SUPER_ADMIN.filter((p) => p !== "super")];
  return base;
};
export const tiene = (rol: string, p: Permiso, email?: string) => permisosDe(rol, email).includes(p);
// Quién ve costos y ganancias: el Súper Admin, el dueño y bodega (que registra las compras). Caja, supervisor y contador no ven margen privado.
export const veCostos = (rol: string, email?: string) => tiene(rol, "admin", email) || rol === "BODEGA";

type Regla = [metodo: RegExp, ruta: RegExp, quien: Permiso[]];
const G = /^GET$/, P = /^POST$/, U = /^PUT$/, D = /^DELETE$/, TODOS = /^(GET|POST|PUT|DELETE)$/;
// La PRIMERA regla que coincide manda. Una regla = alguno de esos permisos basta.
const REGLAS: Regla[] = [
  [TODOS, /^\/api\/cuenta(\/|$)/, []],                                   // mi cuenta: cualquier usuario con sesión
  [TODOS, /^\/api\/inquilinos(\/|$)/, ["super"]],                        // gestión Multi-Tenant: EXCLUSIVO del Súper Administrador
  [TODOS, /^\/api\/sistema\/(reiniciar-fabrica|medio|imprenta|correo)(\/|$)/, ["super"]], // API Brevo, Imprenta Digital, Modalidad y Reinicio: EXCLUSIVO Súper Admin
  [TODOS, /^\/api\/usuarios(\/|$)/, ["admin"]],
  [TODOS, /^\/api\/sistema(\/|$)/, ["admin"]],
  [U, /^\/api\/config$/, ["admin", "tasa"]],                             // el supervisor solo puede la tasa (se revisa dentro)
  [P, /^\/api\/documentos\/\d+\/(anular|devolver)$/, ["anular"]],
  [G, /^\/api\/documentos\/resumen$/, ["admin"]],                        // ganancia del mes
  [G, /^\/api\/documentos(\/|$)/, ["caja", "informes_contador"]],        // el contador puede consultar facturas emitidas
  [TODOS, /^\/api\/documentos(\/|$)/, ["caja"]],
  [P, /^\/api\/pagos\/\d+\/anular$/, ["anular"]],
  [U, /^\/api\/pagos\/metodos\//, ["admin"]],
  [G, /^\/api\/pagos(\/|$)/, ["caja", "informes_contador"]],
  [TODOS, /^\/api\/pagos(\/|$)/, ["caja"]],
  [D, /^\/api\/clientes\//, ["admin"]],
  [TODOS, /^\/api\/clientes(\/|$)/, ["caja"]],
  [G, /^\/api\/catalogo(\/|$)/, ["caja", "inventario", "informes_contador"]],
  [TODOS, /^\/api\/catalogo(\/|$)/, ["inventario"]],
  [P, /^\/api\/compras\/\d+\/anular$/, ["admin"]],
  [G, /^\/api\/(compras|proveedores|existencias)(\/|$)/, ["inventario", "informes_contador"]],
  [TODOS, /^\/api\/(compras|proveedores|existencias)(\/|$)/, ["inventario"]],
  [G, /^\/api\/informes\/(ventas|por-cobrar)$/, ["informes_caja", "informes_contador"]],
  [G, /^\/api\/informes\/inventario$/, ["inventario", "informes_contador"]],
  [G, /^\/api\/informes\/(compras|resumen-iva)$/, ["admin", "informes_contador"]],
  [G, /^\/api\/informes\/ganancias$/, ["admin"]],
];
export function exigido(metodo: string, ruta: string): Permiso[] {
  for (const [m, r, quien] of REGLAS) if (m.test(metodo) && r.test(ruta)) return quien;
  return ["admin"];
}
export const permitido = (rol: string, metodo: string, ruta: string, email?: string) => {
  const quien = exigido(metodo, ruta);
  return quien.length === 0 || quien.some((p) => tiene(rol, p, email));
};

// Respuestas JSON sin costos ni ganancias (para quien no los ve): se quita cualquier campo cuyo nombre empiece por costo o ganancia.
const CAMPO_PRIVADO = /^(costos?|ganancias?)(_|$)/;
export function sinCostos(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sinCostos);
  if (x && typeof x === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (!CAMPO_PRIVADO.test(k)) o[k] = sinCostos(v);
    return o;
  }
  return x;
}

