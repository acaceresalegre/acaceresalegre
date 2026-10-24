# Cuentas Casa

App móvil (web) de finanzas del hogar para Alan y Karo, hecha a partir del handoff de diseño «Cuentas Casa».
Controla ingresos, gastos y presupuesto por categoría, y sobre todo **las facturas por pagar según su vencimiento**,
con calendario y alertas. También lleva hipotecas, préstamos y facturas por cobrar.

Moneda base COP, con ARS y USD para cargar y visualizar.

## Pantallas

- **Inicio**: saldo del mes, facturas por pagar, «te quedaría a fin de mes», alertas, próximos vencimientos, presupuesto y últimos movimientos.
- **Vencimientos**: calendario mensual con puntos de estado (vencida / por vencer / pagada), lista agrupada y check de pago. Pestaña *Por cobrar* para las facturas emitidas por Karo: cada cobro, total o parcial, se registra como un ingreso vinculado a la factura (con la categoría que elijas) y la factura queda Pendiente, Parcial o Cobrada. Si el cliente paga menos (retención en la fuente o un descuento), se puede dar por cobrada igual y queda registrado lo que no se cobró.
- **Presupuesto**: este mes (gastado, proyección de cierre, umbral de aviso 70/80/90 %, una tarjeta por categoría) y año (ahorro, gráfico mensual contra presupuesto, comparación por categoría).
- **Metas**: metas de ahorro con monto, fecha objetivo y ahorro inicial. Cada una muestra el avance, cuánto falta por mes para llegar a tiempo, el ritmo de los últimos 3 meses y cuándo se alcanzaría a ese ritmo. Los aportes (y retiros) se cargan con **+ → Ahorro** y quedan en Movimientos con tipo «Ahorro»: no cuentan como gasto ni entran al presupuesto, pero se descuentan de «te quedaría a fin de mes». En el celular Metas, Deudas y Balance están en la pestaña **Patrimonio**.
- **Deudas**: hipotecas y préstamos con su cuota mensual, estado, saldo y avance. Abajo, el **plan para salir de las deudas**: con un pago extra mensual y la estrategia avalancha (mayor tasa primero) o bola de nieve (menor saldo primero), cuándo termina cada préstamo y cuánto interés se ahorra. Usa la TNA de la pestaña Deudas y la cuota sin seguros; las cuotas de los préstamos que terminan se suman al extra.
- **Vencimientos → Plan por cobro**: para cada tramo entre cobros (sueldos, quincenas) muestra lo que entra, las facturas que vencen, los gastos del día a día estimados (promedio de los últimos 90 días) y lo que queda libre, con el acumulado. Los cobros se configuran en la app (pestaña «Ingresos esperados»); si no hay, se estiman con los ingresos de los últimos 3 meses.
- **Balance** (por mes, por defecto el último cerrado):
  - *Estado de resultados* por lo devengado: ingresos y gastos del mes aunque no se hayan cobrado o pagado (las facturas del mes cuentan aunque estén impagas; las facturas emitidas por cobrar cuentan en el mes de emisión, no al cobrarlas). De las cuotas de préstamos solo es gasto el interés, el seguro y los diferidos; la amortización baja la deuda. Los aportes a metas y las transferencias no son gasto.
  - *Situación patrimonial* al cierre: cuentas, inversiones y bienes (con el último saldo cargado), facturas por cobrar, saldos de préstamos según la tabla de cuotas, tarjetas de crédito (su saldo es lo que se debe) y facturas impagas. Montos al tipo de cambio actual.
  - *Flujo de efectivo* simple: compara cuánto cambiaron las cuentas líquidas (bancos, efectivo, billeteras) con lo registrado en el mes; la diferencia muestra lo que falta cargar. Las tarjetas de crédito restan, así una compra con tarjeta y el pago del resumen cierran sin diferencias.
  - *Evolución del patrimonio*: activos, pasivos y patrimonio neto de los últimos 12 meses.
  - Las cuentas y bienes se agregan desde Balance y su saldo se carga una vez por mes con **Actualizar saldos** (el cierre preliminar por mail recuerda cuáles faltan).
- **+ → Transferir**: movimientos entre cuentas propias (de una cuenta a otra, a una inversión o el pago del resumen de la tarjeta). No son gasto ni ingreso. Con la tarjeta de crédito: cada compra se carga como **gasto** (medio de pago Tarjeta Crédito) y el pago del resumen como **transferencia** de la cuenta a la tarjeta, para no contarlo dos veces.
- **+**: agregar gasto, ingreso o factura (con repetición mensual y recordatorios), mostrando el impacto en el presupuesto antes de guardar. Al escribir el comentario sugiere la categoría (reglas de la pestaña Reglas o lo usado antes) y permite indicar, opcionalmente, quién pagó.
- **Escanear**: foto de un ticket o factura → lee comercio, total y fecha (en facturas, la de «pague hasta») y abre el formulario ya completo para revisar, con el texto leído a la vista. Con la planilla conectada usa el lector de Google Drive; sin conexión, el del celular sobre la foto achicada, en grises y con más contraste.
- **Computadora** (pantallas de 1024 px o más): menú lateral y pestaña **Resumen** con indicadores del mes (ahorro, ingresos, gastos, tasa de ahorro y presupuesto usado, comparados con el mes anterior), gráficos de ingresos y gastos de los últimos 12 meses, gasto acumulado contra presupuesto con proyección de cierre, gasto por categoría y por persona, más vencimientos y alertas. Los gráficos muestran los valores al pasar el mouse.
- **Movimientos**: lista completa con búsqueda, filtros (período, tipo, categoría, medio de pago, persona), orden por fecha o importe, totales, edición y exportación a CSV de lo filtrado.
- **⋯ Ajustes**: umbral de alertas, tasas de cambio, categorías, calendario, importar/exportar, datos, último respaldo y **Novedades** (también aparecen en Inicio una vez después de cada actualización).
- **Sin conexión**: la app queda guardada en el teléfono (`sw.js`) y abre sin internet; lo que se carga se envía al volver. Con internet siempre baja la última versión publicada.

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
  el día 1, a las direcciones de **Ajustes → Correos del resumen** de la planilla. El resumen incluye lo aportado
  a metas y el avance de cada una.
- Cuentas y bienes en la pestaña **Cuentas y bienes**, y su saldo de cierre de cada mes en **Saldos** (se crean solas).
  La app lee de **Cuotas** solo los últimos 25 meses y los próximos 13.
- **Respaldo semanal**: los domingos se copia la planilla en la carpeta **Backup** de Drive (quedan las últimas 12).
- Si el `Codigo.gs` de la planilla es más viejo que lo que la app necesita, la app avisa «Código de la planilla desactualizado».
- Las metas se guardan en la pestaña **Metas** (se crea sola con la primera meta). Borrar una meta la marca como
  inactiva; sus aportes quedan en Movimientos.

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
| `sw.js` | Guarda la app para abrir sin conexión (primero la red, si no hay, la copia guardada) |
| `apps-script/Codigo.gs` | Programa de la planilla: API para la app, facturas de cada mes, Google Calendar, mails y respaldo semanal |
| `tests/` | Tests de las reglas de negocio y del programa de la planilla (sobre una planilla simulada, `fake-gas.js`) |

## Tests

```bash
node --test tests/*.test.js
```
