# Lista de prueba en el celular

El recorrido automático (`tests/e2e/recorrido.js`) prueba la app en un Chromium en cada publicación. Lo que no
puede probar es el celular real: la app instalada, la cámara, el teclado y el modo sin conexión de cada sistema.
Esta lista se repite **después de cada versión que cambie algo visible**, una vez en iPhone y otra en Android.
Lleva unos 10 minutos.

Antes de empezar: abrir la app desde el **ícono de la pantalla de inicio** (no desde Safari o Chrome) y esperar a
que diga que está sincronizada (⋯ → Planilla de Google).

| # | Qué hacer | Qué tiene que pasar | iPhone | Android |
| --- | --- | --- | --- | --- |
| 1 | Abrir la app | Aparece «Novedades de la app» una vez; ⋯ → Planilla dice «Conectada» y el último respaldo | ☐ | ☐ |
| 2 | **+ → Gasto** de $ 1.000, comentario «prueba», guardar | Aparece en Últimos movimientos y en la planilla en menos de 30 s | ☐ | ☐ |
| 3 | Editar ese gasto y pasarlo a **Devolución** | El monto se ve en verde con «−» y el presupuesto de la categoría baja | ☐ | ☐ |
| 4 | **Escanear ticket** con la cámara | Se abre la cámara, lee el total y la fecha y abre el formulario completo | ☐ | ☐ |
| 5 | **+ → Transferir** de una cuenta a otra | No cambia «Gastos» del mes en Inicio | ☐ | ☐ |
| 6 | Presupuesto → tocar una categoría → **Editar** y cambiar un monto | El límite cambia en la pantalla y en la pestaña Presupuesto de la planilla | ☐ | ☐ |
| 7 | Vencimientos → una factura → **Marcar como pagada** | Pasa a Pagadas y el evento del calendario de Google se actualiza | ☐ | ☐ |
| 8 | Ajustes → **Facturas mensuales** → cambiar un monto | Cambian la factura de este mes (si no está pagada) y las siguientes | ☐ | ☐ |
| 9 | Vencimientos → Por cobrar → cobrar una factura con menos del total → **Retención** | Queda «Cobrada» y arriba aparece «Retención en la fuente AAAA» | ☐ | ☐ |
| 10 | Poner el teléfono en **modo avión**, cerrar y volver a abrir la app | Abre con los datos; cargar un gasto queda «por enviar» | ☐ | ☐ |
| 11 | Sacar el modo avión | El gasto se envía solo y el aviso desaparece | ☐ | ☐ |
| 12 | Girar el teléfono y volver | Nada queda cortado ni se mueve de costado | ☐ | ☐ |
| 13 | Borrar los movimientos de prueba | Desaparecen también de la planilla | ☐ | ☐ |

Si algo falla: anotar el número de la fila, una captura de pantalla y si pasó en iPhone, Android o los dos.
