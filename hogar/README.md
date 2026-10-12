# Cuentas Casa

App móvil (web) de finanzas del hogar para Alan y Karo, hecha a partir del handoff de diseño «Cuentas Casa».
Controla ingresos, gastos y presupuesto por categoría, y sobre todo **las facturas por pagar según su vencimiento**,
con calendario y alertas. También lleva hipotecas, préstamos y facturas por cobrar.

Moneda base COP, con ARS y USD para cargar y visualizar.

## Pantallas

- **Inicio**: saldo del mes, facturas por pagar, «te quedaría a fin de mes», alertas, próximos vencimientos, presupuesto y últimos movimientos.
- **Vencimientos**: calendario mensual con puntos de estado (vencida / por vencer / pagada), lista agrupada y check de pago. Pestaña *Por cobrar* para las facturas emitidas por Karo (al cobrarlas se crea el ingreso en «Sueldo Karo»).
- **Presupuesto**: este mes (gastado, proyección de cierre, umbral de aviso 70/80/90 %, una tarjeta por categoría) y año (ahorro, gráfico mensual contra presupuesto, comparación por categoría).
- **Deudas**: hipotecas y préstamos con su cuota mensual, estado, saldo y avance.
- **+**: agregar gasto, ingreso o factura (con repetición mensual y recordatorios), mostrando el impacto en el presupuesto antes de guardar.
- **Escanear**: foto de un ticket o factura → lee comercio, total y fecha y abre el formulario ya completo para revisar.
- **⋯ Ajustes**: umbral de alertas, tasas de cambio, categorías, calendario, importar/exportar y datos.

## Cómo usarla

Está publicada con GitHub Pages en **https://acaceresalegre.github.io/acaceresalegre/**
(el workflow `.github/workflows/pages.yml` corre los tests y la publica cada vez que cambia `hogar/` en `main`).

En el celular: abrir esa dirección y elegir «Agregar a pantalla de inicio» (Safari: botón Compartir; Chrome: menú ⋮).
También funciona abriendo `index.html` directamente, sin servidor.

Los datos se guardan en el dispositivo (`localStorage`). Para pasarlos a otro equipo: **Ajustes → Copia de seguridad / Restaurar copia**.

La primera vez se cargan **datos de ejemplo** para ver la app funcionando; se quitan con **Ajustes → Quitar datos de ejemplo**
(se conservan las categorías y los préstamos).

## Qué viene de `finanzas 26.xlsx` y qué es ejemplo

| Dato | Origen |
| --- | --- |
| Categorías, ingresos y medios de pago | Handoff (hoja `Datos`) |
| Cuotas y días de vencimiento de los 5 préstamos | Handoff (hoja `Deudas`) |
| Tasas de cambio iniciales | Handoff (TRM y XE, oct 2026) |
| Límites por categoría, subcategorías, facturas fijas, movimientos y cobros | **Ejemplo**: editar en la app o importar |
| Saldo, capital y cantidad de cuotas de cada préstamo | Se cargan tocando cada préstamo en Deudas |

## Integraciones

- **Calendario**: se descarga un archivo `.ics` (eventos a las 9:00 con los avisos de cada factura, próximos 12 meses) que se abre con el calendario del teléfono.
- **Excel**: importa la hoja «Movimientos Reales» (Fecha, Categoría, Descripción, Moneda, Importe, Medio de pago, Comentarios). Exporta los movimientos a CSV.
- **Tasas de cambio**: «Actualizar en línea» toma la TRM de datos.gov.co y el ARS de open.er-api.com; también se pueden cargar a mano.
- **Lectura de tickets**: OCR en el propio navegador con Tesseract.js (no se envían fotos a ningún servidor).

Excel y OCR descargan su librería la primera vez que se usan, así que necesitan conexión.

**Pendiente** respecto del handoff: sincronización con Google Sheets (requiere un proyecto de Google con OAuth),
notificaciones push con la app cerrada y división de gastos por persona.

## Estructura

| Archivo | Contenido |
| --- | --- |
| `index.html` | Estructura base y barra de pestañas |
| `styles.css` | Tokens y estilos del diseño (Figtree, paleta cálida) |
| `lib.js` | Reglas de negocio puras: conversión, vencimientos, presupuesto, proyección, alertas, ICS, CSV, importación, lectura de tickets |
| `app.js` | Pantallas, hojas inferiores e interacciones |
| `tests/` | Tests de las reglas de negocio |

## Tests

```bash
node --test tests/*.test.js
```
