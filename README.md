# FacturaYa Venezuela — Especificación Técnica y Contable

Software de facturación digital, control administrativo, inventario y generación de libros contables diseñado para contribuyentes **Formales**, **Ordinarios** y **Especiales (SPE)** en la República Bolivariana de Venezuela.

---

## 1. Marco Normativo Implementado

El sistema estructura sus flujos de emisión, cobro, registro de compras y reportes fiscales conforme a la normativa tributaria vigente en Venezuela, adaptando pantallas, validaciones y libros según el tipo de contribuyente configurado (`FORMAL`, `ORDINARIO` o `ESPECIAL`):

| Norma | Alcance implementado en el software |
| :--- | :--- |
| **Providencia Administrativa SNAT/2011/0071** | Emisión de Facturas, Notas de Crédito (`NC`), Notas de Débito (`ND`) y Presupuestos con identificación completa del emisor, receptor, RIF, domicilio fiscal, detalle de alícuotas de IVA (Exento, 8% y 16%), totales legales y leyenda obligatoria `CONTRIBUYENTE FORMAL · SIN DERECHO A CRÉDITO FISCAL` cuando aplica. |
| **Providencia Administrativa SNAT/2024/000102** | Soporte para modalidades de facturación digital: operación con Sistema Digital SENIAT y conector API para Imprenta Digital Autorizada con idempotencia de emisión y trazabilidad de números de control. |
| **Art. 70 y Art. 72 del Reglamento de la Ley del IVA (RLIVA)** | Generación y exportación en PDF y CSV del **Libro de Compras** (mercancía de inventario, gastos operativos y servicios con crédito fiscal) y del **Libro de Ventas** (o *Relación de Ventas / Compras* para Contribuyente Formal). |
| **Art. 128 de la Ley del Banco Central de Venezuela (BCV)** | Expresión bimoneda con monto legal obligatorio en Bolívares (`Bs.`) calculado a la tasa oficial del BCV (sincronizada o manual) congelada históricamente en cada documento y pago emitido. |
| **Providencia SNAT/2022/000013 (IGTF 3%)** | Habilitado exclusivamente para **Sujetos Pasivos Especiales (SPE)**: cálculo, registro por método de pago en divisas, desglose en comprobantes y relación quincenal de IGTF (Forma 99032); oculto y bloqueado en servidor para Formales y Ordinarios. |
| **Providencia SNAT/2015/0049** | Registro de comprobantes de retención de IVA (75% y 100%, aplicable a Ordinarios y Especiales) e imputación en el período correspondiente dentro del Libro de Ventas, incluyendo retenciones recibidas en el mes sobre facturas de períodos anteriores. |
| **Decreto 1.808** | Registro y relación de comprobantes de retención de ISLR (alícuotas configurables: 1%, 2%, 3%, 5%). |

---

## 2. Controles de Integridad Contable y Auditoría

El núcleo contable aplica reglas estrictas a nivel de servidor y base de datos para garantizar consistencia y auditabilidad:

1. **Aritmética monetaria en centavos enteros:** Todos los importes en Bolívares y Dólares se procesan y almacenan exclusivamente como números enteros en centavos (sin aritmética de punto flotante), evitando errores de redondeo en libros fiscales y resúmenes de impuestos.
2. **Inmutabilidad fiscal en Modo Real:** Una vez emitido un documento, pago, compra o movimiento de existencias en Modo Real, los *triggers* de SQLite impiden su edición o eliminación física. Cualquier corrección se canaliza únicamente mediante anulación justificada o emisión de Notas de Crédito / Notas de Débito.
3. **Correlativos atómicos sin saltos:** Los números de factura, notas de crédito, notas de débito, presupuestos, control interno y recibos de pago se incrementan dentro de la misma transacción atómica de emisión, sin saltos ni reutilización de numeraciones anuladas.
4. **Separación de inventario y gastos operativos:** Las facturas de proveedores admiten renglones de mercancía (con trazabilidad en Kardex / existencias) y renglones de gastos operativos o servicios que impactan el Libro de Compras y el crédito fiscal de IVA sin alterar existencias físicas.
5. **Control de acceso basado en roles (RBAC):** Validación estricta en servidor para cada petición según rol (**Administrador/Dueño**, **Supervisor**, **Cajero**, **Bodega** y **Contador** en solo lectura), aplicando aislamiento de costos y márgenes de ganancia.
6. **Bitácora de auditoría:** Registro cronológico de emisiones, anulaciones, cambios de configuración fiscal, acceso de usuarios, migraciones y respaldos.

---

## 3. Arquitectura Técnica de Referencia

- **Entorno de ejecución:** Cloudflare Workers (TypeScript estricto + Hono), arquitectura *serverless* en el borde.
- **Base de datos relacional:** Cloudflare D1 (SQLite distribuido) con migraciones versionadas acumulativas e inmutables y aislamiento lógico/físico por contribuyente.
- **Almacenamiento de respaldos:** Cloudflare R2 privado con copias diarias por empresa (retención de 30 días), archivo mensual fiscal inmutable de larga conservación (10 años), firma de integridad criptográfica (HMAC-SHA256) y descarga en *streaming*.
- **Seguridad de acceso y transporte:**
  - Contraseñas derivadas con PBKDF2-SHA256 y sesiones HTTP-only con límite de intentos por IP.
  - Autenticación en dos pasos (**2FA TOTP · RFC 6238**) para Súper Administrador y Administradores de empresa, con límite de intentos fallidos, generación local de códigos QR (SVG sin dependencias externas) y códigos de respaldo de un solo uso.
  - Cifrado AES-256-GCM en reposo para credenciales de integraciones externas mediante secreto administrado fuera del repositorio (`MASTER_KEY`).
  - Cabeceras de seguridad estrictas en el cliente web y la API (`Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`).
- **Cliente web:** Aplicación modular en JavaScript estándar sin rastreadores externos, generación local de documentos PDF y exportación CSV para contabilidad.

---

## 4. Verificación y Pruebas Automatizadas

El repositorio incluye suites automatizadas en `tests/` que validan:
- Precisión contable en centavos enteros, cálculo de IVA/IGTF, retenciones y cuadre de Libros de Ventas y Compras.
- Inmutabilidad en Modo Real y cumplimiento de *triggers* de base de datos.
- Integridad de migraciones, correlativos atómicos y aislamiento multi-contribuyente.
- Compras de mercancía, gastos operativos y servicios mixtos.
- Controles criptográficos (AES-256-GCM, firmas HMAC, 2FA TOTP RFC 6238, rate limiting y respaldos en R2).
