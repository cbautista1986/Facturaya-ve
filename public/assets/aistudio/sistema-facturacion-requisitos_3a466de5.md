---
name: "sistema-facturacion-requisitos"
description: "Requisitos, 8 módulos, diseño estilo Pixel (6 pantallas) y esquema D1 del sistema de facturación Service-First; leer antes de programar."
---

Requisitos del proyecto [[sistema-facturacion]], tomados de su conversación completa con Gemini (PDF de 70 páginas del 16/10/2026).

## Pedido original y enfoque
- pidió un sistema de facturación para Venezuela, gratis en la nube, como web app en Cloudflare (protegida contra ataques), con login, compras, ventas, bodega y facturación; envía por correo y WhatsApp un PDF con RIF, logo y nombre de persona o empresa; sirve para servicios y productos; clientes frecuentes; costos fijos o calculados al facturar; apegado a las normas del SENIAT; fácil en celular; open source y fácil de editar; con presupuestos
- el enfoque es "Service-First": los servicios son la especialidad (a diferencia de los sistemas de venta física), pero también debe vender productos físicos; el primer usuario es él (repara computadoras, hace páginas web, monta routers y a veces revende un producto atado a un servicio); después minimercado, barbero, mecánico, abogado, contador y diseñador
- eligió hacerlo todo en Cloudflare (Pages, Workers, D1 y R2), con subdominio gratis tipo *.pages.dev
- quiere revisar todo el alcance y ver las pantallas en imágenes antes de programar, y avanzar paso a paso con correcciones

## Los 8 módulos
- 1 Instalación tipo WordPress y login: la primera vez se crea el admin con correo (su usuario) y clave; luego el registro público se bloquea y solo el admin crea otros usuarios
- 2 Configuración: nombre, RIF, logo, dirección, teléfono y tasa BCV; más "mis datos de cobro" (pago móvil, transferencia, Zelle, Binance, PayPal) para enviárselos al cliente con el monto exacto en Bs y USD
- 3 Compras y bodega: los productos entran por compras (proveedor con sus datos, factura y control de compra) y pasan solos a bodega con cantidad; también se cargan directo a bodega sin factura de compra; los ajustes (dañado, perdido, garantía, uso interno, sobrante) exigen nota de motivo; los servicios no usan bodega
- 4 Clientes frecuentes: cédula o RIF, nombre y apellido (o razón social), dirección, correo y WhatsApp; se crean en su sección o al facturar
- 5 Ventas y presupuestos: el presupuesto no es factura pero se convierte en una con un botón; también factura directa sin presupuesto; documentos mixtos de productos y servicios; el servicio no tiene cantidad y su precio puede fijarse al facturar (ej. reparación de motor $100 calculado al entregar); costo interno privado opcional; equipo "comprado al vuelo" (costo y precio sin pasar por bodega); catálogo de servicios fijos de un toque con precio editable; nota de garantía o condiciones en el PDF; abonos con recibo; sumar costos de última hora y descontar lo abonado al facturar
- 6 Pagos y crédito: pago móvil, efectivo en Bs, transferencia, efectivo USD, Zelle, Binance y PayPal; pago mixto; crédito a X días como cuenta por cobrar con vencimiento, abonos parciales y alertas de vencidos
- 7 Envío del PDF por WhatsApp (con mensaje y datos de pago opcionales), por correo y descarga
- 8 Historial e informes por día, semana o mes: ganancia real (venta menos costo en productos, más servicios, menos pérdidas por ajustes), movimientos, clientes frecuentes con estado de cuenta y pagos recibidos por método
- el costo y la ganancia solo los ve él en pantalla; el PDF del cliente nunca los muestra
- ya no habrá selector de perfil de negocio (acordado 18/10/2026): un solo sistema para todos (antes eran 3 perfiles: Servicios + Equipos, Solo servicios y Comercio/Bodega)

## Reglas aplicadas en la base de datos
- facturas inmutables: una vez emitida no se edita ni se borra (trigger en D1); se corrige con anulación o nota de crédito o débito
- cada documento guarda la tasa BCV del día y se muestra en Bs con su equivalente en USD; impuestos: exento, IVA 16%, 8% e IGTF 3% si paga en divisas

## Diseño del front end (acordado)
- quiere colores y fuentes fáciles de leer, uso sobre todo en celular, iconos reconocibles (flecha atrás) con leyenda al dejar presionado, programa táctil moderno tipo último Android o Pixel con marcos redondeados, nada de aspecto de Excel
- estilo "Google Pixel / Material You": tarjetas redondeadas de 24 px; azul #1A73E8 para botones principales; morado #7627BB para servicios y mano de obra; verde #1E8E3E para ganancia, pagos completados y WhatsApp; ámbar #E37400 para presupuestos en espera, abonos y créditos por cobrar; rojo #D93025 para dañados, stock agotado y vencidos; fondo claro #F8FAFD; fuente Google Sans o Inter; totales en negrita grande; leyenda tras toque largo de 0,5 s
- 6 pantallas: (1) instalador y login con nombre, RIF o cédula, correo, contraseña y especialidad; (2) inicio con logo, tasa BCV editable, ganancia neta del mes separada en servicios y reventa, acciones rápidas (nueva factura o servicio, nuevo presupuesto, enviar mis datos de pago, por cobrar y trabajos), alertas y barra inferior Inicio, Facturar, Bodega, Clientes, Info; (3) nuevo documento con interruptor presupuesto o factura, búsqueda de cliente por cédula, RIF o nombre, agregar servicio al momento (morado), de bodega o equipo comprado hoy, ganancia limpia privada, nota de garantía y totales en USD y Bs; (4) cobro y entrega con método(s) de pago, abono o crédito a X días, datos de pago en el mensaje y envío por WhatsApp, correo o descarga; (5) bodega y compras con pestañas Bodega, Compras y Ajuste; (6) el PDF del cliente con logo, tipo y número, RIF, fecha, tasa BCV, datos del cliente, condición, detalle, garantía, subtotal, IVA, total en USD y Bs y datos para el pago

## Base de datos D1 `facturacion_ve_db` (esquema aplicado en local y remoto, 10 consultas)
- tablas: perfil_emisor (fila única con datos del emisor, tasa BCV, datos de cobro y contadores de presupuesto, factura y nota de crédito), usuarios, clientes, catalogo (servicios y productos con costo, precio, IVA y stock), compras, bodega_movimientos, documentos (presupuesto, factura y nota de crédito con totales, ganancia, crédito y estado de pago), documento_renglones, documento_pagos, más un trigger que impide borrar facturas y notas de crédito
- el esquema completo está en schema.sql dentro de la carpeta del proyecto
- el sistema debe ser simple, fácil de editar o corregir más adelante, escalable y 100% gratis
- quiere olvidar PowerShell y que Claude haga todo el trabajo: prefiere recibir el proyecto armado (archivos listos) en vez de comandos para pegar; la Fase 1 parte con su cuenta de Cloudflare ya creada

## Cambios de diseño acordados el 18/10/2026 (se construyen después de la Fase 2)
- quiere 4 accesos directos en el Inicio, de izquierda a derecha: Factura, Clientes, Pagos e Inventario
- Factura: el presupuesto se convierte en factura, o se factura directo sin presupuesto; el número de factura es un correlativo propio que siempre aumenta; las facturas se anulan pero no se borran; mientras no haya imprenta digital, él también lleva el número de control
- Clientes: un enlace wa.me por cada número de celular, con una forma estandarizada y bien explicada de ingresar el número (con o sin +58, con o sin espacios) para que no falle; la factura se entregará por correo y WhatsApp
- Pagos: ahí van todas las formas de pago (pago móvil, Binance, PayPal, etc.), también estandarizadas
- Inventario es la bodega o catálogo actual: productos y servicios con su precio y cálculo, manteniendo separados los productos (con margen de ganancia) de los servicios (sin margen)
- quiere un solo sistema igual para minimercado, peluquero, venta de computadoras o servicios, sin perfiles de especialidad
- un servicio creado al momento de facturar (ej. $15 extra por instalar un programa fuera de lo común) va solo en esa factura y no queda guardado en el catálogo
- los productos entran por Compras o directo al inventario sin factura de compra (ej. 20 hamburguesas)
- el botón Pagos reúne todo junto: por cobrar (créditos y abonos), registrar pagos recibidos y sus datos para cobrar
- los servicios llevan costo privado opcional
- mientras no haya imprenta digital: un "Control interno" propio que siempre aumenta, y el N.º de control fiscal queda vacío hasta conectar la imprenta

## Principios del proyecto (18/10/2026)
- el sistema llevará la contabilidad de personas: hay que construirlo por rutas conservadoras, sin fallos
- las leyes del SENIAT cambian: el sistema debe poder actualizarse según la ley y seguir mejorando de forma continua (escalable)
- quiere hablar las recomendaciones (front end, back end, lógica y legal según las leyes de Venezuela) antes de construir la Fase 3

## Decisiones de la Fase 3 (19/10/2026)
- mientras no haya N.º de control fiscal, el PDF se titula "Factura" con un aviso visible de que no tiene N.º de control fiscal
- no sabe si su negocio es sujeto pasivo especial del SENIAT: el IGTF queda apagado hasta confirmarlo con su contador
- en la Fase 3 las facturas emitidas solo se anulan; las notas de crédito y débito se hacen después

## Decisiones de la Fase 4 (25/10/2026)
- los pagos en bolívares se convierten a dólares con la tasa del día del pago
- vende a crédito con días de plazo
- quiere un recibo en PDF por cada pago

## Decisiones de la Fase 5 (31/10/2026)
- el costo de un producto se calcula como promedio ponderado cuando compra más
- si factura más unidades de las que hay en un producto con control de existencias, se bloquea la venta

## Decisiones de la Fase 6 (04/11/2026)
- en el libro de compras el IVA crédito fiscal se muestra en USD tal como se registró, sin inventar tasas (06/11/2026: cambió; le pidió a Claude decidir y el libro de compras ahora va en Bs con la tasa BCV guardada en cada compra)
- los informes se exportan en CSV y PDF
- 06/11/2026: el negocio usa o impresora fiscal o imprenta digital, no ambas; quiere elegirlo con un interruptor (switch) de configuración
- 06/11/2026: quiere varios usuarios a la vez, cada uno con permisos independientes: cajero solo caja; supervisor caja y devoluciones; administrador o dueño todo; bodega solo bodega
