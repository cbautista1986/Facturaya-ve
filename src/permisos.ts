// Permisos por rol (Fase 7.1). UNA sola tabla decide quién puede qué: el servidor la aplica a CADA petición (no solo se esconden botones).
// Para dar un permiso nuevo a un rol, o proteger una ruta nueva, se edita SOLO este archivo. Lo que no aparece aquí es solo del administrador.
export const ROLES = ["ADMIN", "SUPERVISOR", "CAJERO", "BODEGA"] as const;
export type Rol = (typeof ROLES)[number];
export const NOMBRE_ROL: Record<string, string> = { ADMIN: "Dueño / administrador", SUPERVISOR: "Supervisor", CAJERO: "Cajero", BODEGA: "Bodega" };

// caja: clientes, presupuestos, facturas y cobros · anular: anular facturas y pagos (devoluciones) · inventario: productos, costos, proveedores, compras y existencias
// informes_caja: libro de ventas y por cobrar · tasa: actualizar la tasa BCV · admin: todo lo demás (usuarios, ganancias, libros de compras, respaldo, ajustes)
export type Permiso = "caja" | "anular" | "inventario" | "informes_caja" | "tasa" | "admin";
const POR_ROL: Record<string, Permiso[]> = {
  ADMIN: ["caja", "anular", "inventario", "informes_caja", "tasa", "admin"],
  SUPERVISOR: ["caja", "anular", "informes_caja", "tasa"],
  CAJERO: ["caja"],
  BODEGA: ["inventario"],
};
export const permisosDe = (rol: string): Permiso[] => POR_ROL[rol] ?? [];
export const tiene = (rol: string, p: Permiso) => permisosDe(rol).includes(p);
// Quién ve costos y ganancias: el dueño y bodega (que registra las compras). Caja y supervisor no.
export const veCostos = (rol: string) => tiene(rol, "admin") || tiene(rol, "inventario");

type Regla = [metodo: RegExp, ruta: RegExp, quien: Permiso[]];
const G = /^GET$/, P = /^POST$/, U = /^PUT$/, D = /^DELETE$/, TODOS = /^(GET|POST|PUT|DELETE)$/;
// La PRIMERA regla que coincide manda. Una regla = alguno de esos permisos basta (el administrador los tiene todos).
const REGLAS: Regla[] = [
  [TODOS, /^\/api\/cuenta(\/|$)/, []],                                   // mi cuenta: cualquier usuario con sesión
  [TODOS, /^\/api\/usuarios(\/|$)/, ["admin"]],
  [TODOS, /^\/api\/sistema(\/|$)/, ["admin"]],
  [U, /^\/api\/config$/, ["admin", "tasa"]],                             // el supervisor solo puede la tasa (se revisa dentro)
  [P, /^\/api\/documentos\/\d+\/anular$/, ["anular"]],
  [G, /^\/api\/documentos\/resumen$/, ["admin"]],                        // ganancia del mes
  [TODOS, /^\/api\/documentos(\/|$)/, ["caja"]],
  [P, /^\/api\/pagos\/\d+\/anular$/, ["anular"]],
  [U, /^\/api\/pagos\/metodos\//, ["admin"]],
  [TODOS, /^\/api\/pagos(\/|$)/, ["caja"]],
  [D, /^\/api\/clientes\//, ["admin"]],
  [TODOS, /^\/api\/clientes(\/|$)/, ["caja"]],
  [G, /^\/api\/catalogo(\/|$)/, ["caja", "inventario"]],
  [TODOS, /^\/api\/catalogo(\/|$)/, ["inventario"]],
  [P, /^\/api\/compras\/\d+\/anular$/, ["admin"]],
  [TODOS, /^\/api\/(compras|proveedores|existencias)(\/|$)/, ["inventario"]],
  [G, /^\/api\/informes\/(ventas|por-cobrar)$/, ["informes_caja"]],
  [G, /^\/api\/informes\/inventario$/, ["inventario"]],
  [G, /^\/api\/informes\/(compras|resumen-iva|ganancias)$/, ["admin"]],
];
// null = nadie con sesión puede (ruta desconocida: solo el administrador, así una ruta nueva olvidada NO queda abierta)
export function exigido(metodo: string, ruta: string): Permiso[] {
  for (const [m, r, quien] of REGLAS) if (m.test(metodo) && r.test(ruta)) return quien;
  return ["admin"];
}
export const permitido = (rol: string, metodo: string, ruta: string) => {
  const quien = exigido(metodo, ruta);
  return quien.length === 0 || quien.some((p) => tiene(rol, p));
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
