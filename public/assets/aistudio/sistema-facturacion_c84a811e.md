---
name: "sistema-facturacion"
description: "Sistema de facturación Service-First para Venezuela (Hono, Cloudflare Workers, D1 facturacion_ve_db); stack, tablas y estado."
---

- construye un "Sistema de Facturación Service-First" para Venezuela (especialidad inicial SERVICIOS_EQUIPOS), con instalador inicial estilo WordPress que crea el perfil del emisor y el usuario ADMIN
- stack: Hono (TypeScript) en Cloudflare Workers, base de datos D1 `facturacion_ve_db` (binding DB), Tailwind por CDN; trabaja en Windows con PowerShell
- carpeta del proyecto: C:\Users\cbaut\sistema-facturacion-ve; desarrollo local con `npx wrangler dev --local --ip 127.0.0.1 --port 8787`
- la base D1 ya tiene 9 tablas y un trigger aplicados en local y remoto (database_id 1c555fec-951d-48f9-bbb4-fc54bf6c2e84); requisitos completos, diseño de pantallas y esquema en [[sistema-facturacion-requisitos]]
- retomó el proyecto trayendo su conversación completa con Gemini (PDF de 70 páginas del 16/10/2026): cuenta de Cloudflare creada, Node.js y Wrangler instalados, esquema D1 aplicado y servidor base respondiendo 200 OK en local; src/index.ts solo tenía las rutas de API (/api/ping, /api/estado-instalacion, /api/instalar) y el formulario de instalación nunca llegó a cargar porque crear archivos pegando código largo en PowerShell falló varias veces
- decidió que por ahora el sistema emita presupuestos y facturas en PDF para enviar por WhatsApp o correo, sin imprenta digital; más adelante quiere poder agregar una imprenta digital o conectarlo a la web que diseña el gobierno (SENIAT)
- quiere un desarrollo ordenado y fácil de ampliar, porque el sistema va a crecer
- tuvo un bucle de miles de pestañas del navegador después de pegar un script largo en PowerShell mientras corría `wrangler dev`, y tuvo que reiniciar la PC
- repositorio del proyecto en GitHub: cbautista1986/Sistema-CRM-Free-Cloudflare-VE (rama main)
- la Fase 1 ya está desplegada en Cloudflare Workers desde el repositorio de GitHub (Workers Builds): https://sistema-crm-free-cloudflare-ve.cbautista1986.workers.dev, Worker llamado sistema-crm-free-cloudflare-ve; el instalador ya carga en producción (18/10/2026)
- 18/10/2026: instaló el sistema en producción (administrador creado) y ya entra al Inicio; por ahora solo tiene las pantallas de la Fase 1
- actualiza el sistema subiendo archivos a su repositorio de GitHub desde la web (Upload files) y no quiere borrar lo que ya tiene subido; pidió seguir con la Fase 2 (clientes y catálogo)
- 18/10/2026: confirmó que la Fase 2 con los ajustes de diseño funciona sin fallas; sigue la Fase 3 (Factura) después de hablar las recomendaciones
- 24/10/2026: probó la Fase 3 en su celular (presupuesto, factura, anulación, PDF) y la compartió para revisión; pidió pasar a la Fase 4 si estaba correcta y agregar ahí las mejoras que se propongan
- fecha límite: quiere tener todo el sistema listo el 11 de noviembre de 2026
- 06/11/2026: el sistema es para su uso y para distribuirlo como servicio de pago mensual (como Netflix); repositorio también en cbautista1986/Facturaya-ve y sitio https://facturaya.exenet.workers.dev; delegó en Claude decidir y hacer el siguiente paso técnico
