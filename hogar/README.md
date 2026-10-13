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
- **+**: agregar gasto, ingreso o factura (con repetición mensual y recordatorios), mostrando el impacto en el presupuesto antes de guardar. Al escribir el comentario sugiere la categoría (reglas de la pestaña Reglas o lo usado antes) y permite indicar, opcionalmente, quién pagó.
- **Escanear**: foto de un ticket o factura → lee comercio, total y fecha y abre el formulario ya completo para revisar.
- **Computadora** (pantallas de 1024 px o más): menú lateral y pestaña **Resumen** con indicadores del mes (ahorro, ingresos, gastos, tasa de ahorro y presupuesto usado, comparados con el mes anterior), gráficos de ingresos y gastos de los últimos 12 meses, gasto acumulado contra presupuesto con proyección de cierre, gasto por categoría y por persona, más vencimientos y alertas. Los gráficos muestran los valores al pasar el mouse.
- **Movimientos**: lista completa con búsqueda, filtros (período, tipo, categoría, medio de pago, persona), orden por fecha o importe, totales, edición y exportación a CSV de lo filtrado.
- **⋯ Ajustes**: umbral de alertas, tasas de cambio, categorías, calendario, importar/exportar y datos.

## Cómo usarla

Está publicada con GitHub Pages en **https://acaceresalegre.github.io/acaceresalegre/**
(el workflow `.github/workflows/pages.yml` corre los tests y la publica cada vez que cambia `hogar/` en `main`).

En el celular: abrir esa dirección y elegir «Agregar a pantalla de inicio» (Safari: botón Compartir; Chrome: menú ⋮).
También funciona abriendo `index.html` directamente, sin servidor.

Sin conectar, los datos se guardan solo en el dispositivo (`localStorage`). Para pasarlos a otro equipo: **Ajustes → Copia de seguridad / Restaurar copia**.

### Datos compartidos con Google Sheets

Conectada a la planilla «Cuentas Casa - base de datos», la app lee y escribe ahí, y Alan y Karo ven los mismos datos
(los cambios del otro llegan en unos 20 segundos). Los vencimientos se agregan solos a un calendario de Google
«Cuentas Casa». La instalación, paso a paso, está en [`apps-script/INSTALAR.md`](apps-script/INSTALAR.md).

- La planilla es la fuente de verdad. Cada cambio se envía como alta, cambio o baja de una fila (identificada por su ID);
  si no hay conexión queda pendiente y se envía al volver.
- Las facturas de cada mes (recurrentes y cuotas de préstamos) las crea el programa de la planilla, una vez por hora.
- Límites de presupuesto, préstamos y cuotas se editan en la planilla; la app los muestra.
- Cada movimiento guarda quién lo cargó (**Cargado por**, según el enlace con el que se conectó cada uno) y,
  si se indica, quién pagó (**Pagó**). Los totales por persona usan «Pagó» y, si está vacío, «Cargado por».
- Mails de cierre: un **cierre preliminar** 4 días antes de fin de mes para corregir lo que falte y un **resumen**
  el día 1, a las direcciones de **Ajustes → Correos del resumen** de la planilla.

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

- **Calendario**: con la planilla conectada, eventos automáticos en Google Calendar. Sin conectar, se descarga un archivo `.ics` (eventos a las 9:00 con los avisos de cada factura, próximos 12 meses).
- **Excel**: importa la hoja «Movimientos Reales» (Fecha, Categoría, Descripción, Moneda, Importe, Medio de pago, Comentarios). Exporta los movimientos a CSV.
- **Tasas de cambio**: «Actualizar en línea» toma la TRM de datos.gov.co y el ARS de open.er-api.com; también se pueden cargar a mano.
- **Lectura de tickets**: OCR en el propio navegador con Tesseract.js (no se envían fotos a ningún servidor).

Excel y OCR descargan su librería la primera vez que se usan, así que necesitan conexión.

**Pendiente** respecto del handoff: notificaciones push con la app cerrada y división de gastos por persona.

## Estructura

| Archivo | Contenido |
| --- | --- |
| `index.html` | Estructura base y barra de pestañas |
| `styles.css` | Tokens y estilos del diseño (Figtree, paleta cálida) |
| `lib.js` | Reglas de negocio puras: conversión, vencimientos, presupuesto, proyección, alertas, ICS, CSV, importación, lectura de tickets |
| `app.js` | Pantallas, hojas inferiores, interacciones y sincronización |
| `charts.js` | Gráficos del dashboard en SVG (sin librerías) |
| `apps-script/Codigo.gs` | Programa de la planilla: API para la app, facturas de cada mes y Google Calendar |
| `tests/` | Tests de las reglas de negocio y del programa de la planilla (sobre una planilla simulada, `fake-gas.js`) |

## Tests

```bash
node --test tests/*.test.js
```
