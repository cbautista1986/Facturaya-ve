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
| **Providencia SNAT/2025/000054** | Registro de comprobantes de retención de IVA (75% y 100%, aplicable a Ordinarios y Especiales — G.O. N.º 43.171, que derogó la SNAT/2015/0049), control de cierre quincenal (Art. 11) e imputación en el período correspondiente dentro del Libro de Ventas. |
| **Decreto 1.808** | Registro y relación de comprobantes de retención de ISLR (alícuotas configurables: 1%, 2%, 3%, 5%). |

---

## 2. Controles de Integridad Contable y Auditoría

El núcleo contable aplica reglas estrictas a nivel de servidor y base de datos para garantizar consistencia y auditabilidad:

1. **Aritmética monetaria en centavos enteros:** Todos los importes en Bolívares y Dólares se procesan y almacenan exclusivamente como números enteros en centavos (sin aritmética de punto flotante), evitando errores de redondeo en libros fiscales y resúmenes de impuestos.
2. **Inmutabilidad fiscal en Modo Real:** Una vez emitido un documento, pago, compra o movimiento de existencias en Modo Real, los *triggers* de SQLite impiden su edición o eliminación física. Cualquier corrección se canaliza únicamente mediante anulación justificada o emisión de Notas de Crédito / Notas de Débito.
3. **Correlativos atómicos sin saltos:** Los números de factura, notas de crédito, notas de débito, presupuestos, control interno y recibos de pago se incrementan dentro de la misma transacción atómica de emisión, sin saltos ni reutilización de numeraciones anuladas.
4. **Separación de inventario y gastos operativos:** Las facturas de proveedores admiten renglones de mercancía (con trazabilidad en Kardex / existencias) y renglones de gastos operativos o servicios que impactan el Libro de Compras y el crédito fiscal de IVA sin alterar existencias físicas.
5. **Control de acceso basado en roles (RBAC):** Validación estricta en servidor para cada petición según rol (**Administrador**, **Supervisor**, **Cajero**, **Bodega** y **Contador** en solo lectura), aplicando aislamiento de costos y márgenes de ganancia.
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
- Correo de plataforma multi-inquilino (failover Brevo → Resend → Zoho ZeptoMail, cuotas UTC, circuitos, rebotes duros/blandos, quejas de spam, bloqueos HMAC-SHA256 y webhooks autenticados).

---

## 5. Correo de Plataforma Multi-Inquilino (v4.7.0)

El envío de facturas, recibos, cierres contables y recuperación de claves opera de forma centralizada mediante secretos de Cloudflare Workers (sin exigir cuentas externas a cada inquilino):

- **Orden de proveedores (failover automático):** `Brevo → Resend → Zoho ZeptoMail` (Zoho permanece inactivo hasta configurar su clave).
- **Secretos recomendados (`wrangler secret put`):**
  - `BREVO_API_KEY`, `RESEND_API_KEY`, `ZEPTOMAIL_API_KEY` (si ninguno está configurado, el sistema conserva el modo legado por inquilino sin borrar claves previas).
  - `BREVO_WEBHOOK_SECRET`, `RESEND_WEBHOOK_SECRET` (soporta firma Svix `whsec_...` o token), `ZEPTOMAIL_WEBHOOK_SECRET` para los endpoints `POST /api/correo/eventos/{brevo|resend|zeptomail}` (fail-closed si falta el secreto).
- **Variables públicas opcionales (`wrangler.toml`):**
  - `EMAIL_REMITENTE` (dirección validada del dominio de plataforma) y `EMAIL_NOMBRE_PLATAFORMA`.
  - Cuotas diarias UTC opcionales: `BREVO_CUOTA_DIARIA` (300), `RESEND_CUOTA_DIARIA` (100), `ZEPTOMAIL_CUOTA_DIARIA` (10000).
- **Identidad y privacidad:** los correos de documentos, recibos y cierre mensual salen como `<Nombre del negocio> (vía FacturaYa)` con `Reply-To` directo al correo del negocio. Los bloqueos globales (`_mt_correos_bloqueos`) se almacenan únicamente como HMAC-SHA256 con `MASTER_KEY`.

---

## 6. Cron Triggers, Silencio Diurno y Escala Multi-Inquilino (v5.6.0)

`wrangler.toml` programa 3 expresiones Cron separando estrictamente la operación comercial diurna del mantenimiento nocturno:

| Cron (UTC) | Horario Venezuela (VET, UTC-4) | Alcance exacto |
| :--- | :--- | :--- |
| `0 6 * * *` | **2:00 AM VET** | Inicio del mantenimiento nocturno: auto-bindings D1, primer lote de salud/sanación/optimización, respaldos R2 streaming `.json.gz`, archivado de retención (>12 meses) en R2, cierre mensual (días 1–5) y cobros SaaS (día 1). |
| `15,30,45 6 * * *` | **2:15, 2:30 y 2:45 AM VET** | Continuación por lotes (hasta 4 tandas/noche) con **rotación circular multi-día** para 100+ empresas: las empresas que no alcanzan en una madrugada retoman al día siguiente desde el puntero persistido; si alguna pasa >2 días sin respaldo R2 se dispara alerta crítica. |
| `0 12,17,22 * * *` | **8:00 AM, 1:00 PM y 6:00 PM VET** | **Silencio diurno estricto (6:00 AM – 9:00 PM VET):** ejecuta **únicamente** la consulta de tasa BCV oficial (1 fila global en la BD principal) y limpieza de `DB_DEMO` expirada. Cero respaldos R2, cero auditorías masivas y cero toques a bases de clientes en horario comercial. |

---

## 7. Novedades de la versión v5.6.0

- **Aislamiento total de costos y ganancias (RBAC + DTOs explícitos):** `CAJERO`, `SUPERVISOR` y `BODEGA` nunca reciben `costo_centavos`, `valor_usd`, `valor_total_usd` ni costos unitarios de compra desde SQL ni en `GET /api/informes/ganancias` (403), respaldado además por el filtro central `sinCostos()`.
- **Bloqueo fiscal de tasa BCV desactualizada en servidor (`REAL`):** emitir facturas, NC, ND o cobros en Bolívares con tasa vencida devuelve `409 TASA_DESACTUALIZADA`; soporte de feriados bancarios / días sin publicación (`POST /api/sistema/tasa-bcv/feriados`) y *override* auditado (`TASA_VIEJA_OVERRIDE`) exclusivo para `ADMIN` / `SUPER_ADMIN`.
- **Tasa BCV oficial primero + guardia anti-anomalías:** prioriza `bcv.org.ve` con extracción real de `fecha_valor` (`fecha_valor_asumida = 0|1`), validación cruzada (>0.5% alerta priorizando BCV oficial) y retención en pendiente ante saltos >15% hasta aprobación explícita del Súper Administrador (`POST /api/sistema/tasa-bcv/aprobar-pendiente`).
- **Respaldos R2 en streaming `.json.gz` con paginación keyset y firma `hmac:v2`:** compresión `CompressionStream("gzip")`, carga multipart en R2, hash SHA-256 streaming sin materializar la BD completa en RAM y compatibilidad transparente de restauración con respaldos legados `.json` (`hmac:v1`).
- **Endurecimiento de seguridad y eficiencia:** CSRF estricto basado en `c.req.url` + `Sec-Fetch-Site`, *pepper* HMAC con `MASTER_KEY` en contraseñas (`pbkdf2p$`) con migración transparente al iniciar sesión, cachés cortas de *isolate* (15–20 s) para mantenimiento/inquilino/restauración, archivado en R2 de `auditoria`/`correo_envios` (>12 meses) y `Message-ID` RFC 5322 + registro `INTENTANDO`/`INDETERMINADO` en failover de correo.


