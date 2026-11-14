# Sistema de Facturación Service-First

Cloudflare Workers + Hono + D1. Todo funciona en el plan gratis de Cloudflare.

- **Fase 1:** instalador de una sola vez, login seguro, inicio con tasa BCV y ajustes.
- **Fase 2:** clientes (WhatsApp ordenado solo) e inventario de productos y servicios.
- **Fase 3:** presupuestos y facturas (IVA, tasa BCV, correlativos, PDF, anulación), modo práctica y respaldo.
- **Fase 4:** pagos y por cobrar: crédito con días de plazo, cobros en USD y Bs (tasa del día del pago), abonos a presupuestos,
  recibos en PDF, datos de cobro por método y mensajes de WhatsApp.
- **Fase 5:** proveedores, compras y existencias: costo promedio ponderado, la venta descuenta y se bloquea si no hay existencias,
  cargas directas, ajustes con motivo, producto «al vuelo» y alertas de poco stock.
- **Fase 6:** informes para el contador (solo lectura): libro de ventas y libro de compras (ambos en Bs, por alícuota), resumen mensual de IVA
  (débito menos crédito fiscal), ganancias, cuentas por cobrar con antigüedad e inventario valorizado. Las compras guardan la tasa BCV de la fecha
  de su factura (las anteriores a la migración 0007 quedan sin Bs, no se les inventa tasa). Se abren desde la tarjeta de ganancia de Inicio y se descargan en CSV (Excel) y PDF.
- **Fase 7.1:** usuarios con roles (dueño, supervisor, cajero, bodega) y permisos aplicados en el servidor, costos ocultos para caja, clave temporal
  obligatoria de cambiar, desactivar usuarios y código de recuperación de la clave del dueño (se muestra una sola vez).
- **Fase 7.2:** respaldo completo y verificable (todas las tablas, con conteos, sumas y huella) y **restauración de respaldo** en un sistema recién instalado y vacío,
  con avance, verificación final, cancelar y reintentar; los candados contables nunca se apagan (se carga como práctica y se pasa a real al final).
- **Fase 7.3:** medio de facturación (**máquina fiscal o imprenta digital, uno solo a la vez**) con interruptor en Ajustes (solo el dueño, con contraseña, motivo y historial);
  cada factura guarda con qué medio se emitió; con máquina fiscal la factura del sistema es un «comprobante interno» y se registra el número fiscal y el serial de la máquina (una sola vez).
  Hay que elegir el medio antes de salir en vivo.
- **Fase 7.3.1:** la máquina fiscal se configura una vez en Ajustes (serial fijo y último número usado): el sistema propone el siguiente número fiscal (correlativo, avisa si se salta uno)
  y retira el aviso rojo cuando el número ya está registrado. Con imprenta digital, Ajustes guarda los datos de su API (la clave no sale en los respaldos).
- **Fase 8:** devoluciones parciales o totales mediante **Nota de Crédito SENIAT** (`NC-00000001`, referenciando la factura afectada, reingreso automático a existencias con `DEVOLUCION_VENTA`, rebaja del saldo por cobrar y descuento en Libro de Ventas, Resumen de IVA y Ganancias), validaciones de anulación según Providencia SNAT/2011/0071, **IGTF (3%)** activable o desactivable en cada factura (y por defecto en Ajustes) con desglose en USD/Bs en pantalla, PDF, WhatsApp e informes, y favicon vectorial (`favicon.svg`).

## Dónde editar cada cosa (un módulo = pantallas en `public/` + API en `src/rutas/`)
| Módulo | Pantallas | API |
|---|---|---|
| Entrada, inicio, ajustes | `app.js` | `src/index.ts` |
| Clientes | `clientes.js` | `clientes.ts` |
| Inventario (productos y servicios) | `catalogo.js` | `catalogo.ts` |
| Factura, presupuestos, notas de crédito e IGTF | `factura.js`, `pdf.js` | `documentos.ts` |
| Pagos, por cobrar, recibos, datos de cobro | `pagos.js`, `pdf.js` | `pagos.ts` |
| Compras, proveedores y existencias | `compras.js`, `catalogo.js` | `compras.ts`, `proveedores.ts`, `existencias.ts`, `src/stock.ts` |
| Informes (libros, ganancias, por cobrar, inventario) | `informes.js`, `informe-tabla.js` | `informes.ts` |
| Usuarios, roles y recuperación de clave | `usuarios.js` | `usuarios.ts`, `permisos.ts` (la tabla de quién puede qué) |
| Restaurar respaldo | `restaurar.js`, `restaurar-nucleo.js` | `restaurar.ts` (el `PLAN` de tablas), `sistema.ts` (exportación) |
| Medio de facturación, máquina fiscal, imprenta y número fiscal | `medio.js`, `factura.js`, `pdf.js` | `sistema.ts` (`/medio`, `/medio/maquina`, `/imprenta`), `documentos.ts` (`/:id/fiscal`) |
| Modo práctica y respaldo | `app.js` (Ajustes) | `sistema.ts` |

- `public/dinero.js` → **toda** la matemática del dinero; la usan el servidor y el navegador (una sola fuente de verdad).
- `public/comun.js` y `src/comun.ts` → piezas compartidas. `public/estilos.css` → colores y estilos.
- `public/vendor/` → librería de PDF (pdf-lib, MIT) incluida a propósito, sin depender de internet. Ver `LEEME.txt`.
- `src/seguridad.ts` → contraseñas y sesiones.

## Reglas que NO se deben romper (es contabilidad de personas)
1. El dinero va en **centavos enteros**, nunca decimales. No hagas cuentas de dinero fuera de `dinero.js`.
2. Una factura emitida **no se edita ni se borra**: solo se anula (cuando la ley lo permite, conservando todos los ejemplares en el mismo mes fiscal) o se ajusta mediante **Nota de Crédito**, con motivo. La base de datos lo impide con triggers (modo REAL).
3. Los correlativos (factura, nota de crédito, control interno, presupuesto, recibo) se suman **dentro de la misma transacción** que emite el documento; un número anulado no se reutiliza.
4. Un pago **no se edita ni se borra**: se anula con motivo (también lo impide la base de datos). Una factura con pagos vigentes no se anula directamente: se anulan primero sus pagos o se emite una Nota de Crédito.
5. El **saldo nunca se guarda**: se calcula (total del documento − pagos vigentes − notas de crédito emitidas). Así no puede quedar desfasado.
6. Un pago en bolívares se convierte a dólares con la **tasa del día del pago** (queda guardada en el recibo). Una diferencia de redondeo de 1 centavo se cierra sola.
7. Las reglas fiscales son **datos**, no código: tabla `parametros_fiscales` (IVA permitido, alícuota IGTF, leyendas del PDF, validez, tope de renglones...)
   con fecha de vigencia. Si la ley cambia, se agrega una migración con filas nuevas (`vigente_desde` = fecha del cambio).
8. Cambios en la base de datos: **migración nueva al final** de `src/migraciones.ts`; nunca edites una ya desplegada.
9. Las **existencias nunca se guardan sueltas**: se calculan sumando movimientos (`movimientos_stock`), que no se editan ni se borran
   (se corrigen con otro movimiento). Costo = promedio ponderado (valor ÷ existencias). Las facturas descuentan existencias y las notas de crédito o anulaciones reingresan con `DEVOLUCION_VENTA`.
10. Un producto con **control de existencias** no se factura por encima de lo que hay; uno sin control se vende sin límite.
    Anular una factura o emitir una Nota de Crédito devuelve lo que salió, al mismo costo. Una compra solo se anula si después no hubo otros movimientos de sus productos.
11. Los **permisos viven en `src/permisos.ts`** y los aplica el servidor en cada petición (no solo se esconden botones). Una ruta nueva que no esté en esa tabla
    es solo del administrador. Siempre debe quedar al menos un administrador activo. Cajero y supervisor no reciben costos ni ganancias.
12. **Tabla nueva = actualizar `PLAN` en `src/rutas/restaurar.ts`** (o ponerla en `NO_RESTAURAR`). Si no, la restauración se niega a correr (así nunca se pierden datos en silencio).
    El respaldo exporta todas las tablas solo, pero restaurar necesita saber en qué orden y con qué sumas de control cargarlas.
13. Los lotes críticos usan la tabla `verificaciones` como "freno de emergencia": si algo cambió mientras se guardaba, se deshace todo el lote.
14. El **IGTF (3%)** se puede activar o desactivar por factura (y definir su valor por defecto en Ajustes) y se calcula íntegramente en `dinero.js` sobre el subtotal + IVA tanto en USD como en Bs.

## Modo práctica → modo real
El sistema arranca en **modo práctica**: los documentos y recibos llevan marca de agua, no valen y tienen numeración aparte.
Cuando todo esté probado y revisado con tu contador: Ajustes → «Salir en vivo». Se borran los documentos y pagos de práctica,
eliges con qué número empieza cada serie (factura, nota de crédito, control interno, presupuesto y recibo) y no se puede volver atrás.

## N.º de control
El N.º de control **fiscal** lo asigna una imprenta digital autorizada o máquina fiscal: por ahora queda vacío hasta registrarlo y el PDF lo avisa.
El «control interno» es solo un correlativo propio. Cuando se conecte la imprenta o máquina fiscal, ese dato se guarda en `control_fiscal`.

## Respaldo
Ajustes → «Exportar respaldo» descarga todos los datos (sin contraseñas). Guárdalo fuera del sistema.

## Actualizar sin borrar nada
En GitHub: Add file → Upload files y arrastra el contenido del proyecto (las carpetas `src` y `public` y los archivos de la raíz).
GitHub reemplaza lo que tiene el mismo nombre y agrega lo nuevo; no borra nada. Cloudflare vuelve a desplegar solo y aplica la migración `0011_igtf_y_notas_credito` sin tocar tus datos existentes.

## Probar en tu PC (opcional)
`npm install` y luego `npm run dev` (http://127.0.0.1:8787). No pegues nada en la consola mientras corre el servidor.
