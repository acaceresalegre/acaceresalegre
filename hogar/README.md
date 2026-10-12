# 🏠 Hogar — finanzas, tareas y calendario

App web de uso hogareño para organizar en un solo lugar:

- **Inicio**: resumen del mes (ingresos, gastos, balance), tareas de hoy/atrasadas, agenda de los próximos 7 días y estado de los presupuestos.
- **Finanzas**: registro de ingresos y gastos por categoría y miembro, navegación por mes, gastos por categoría y movimientos filtrables.
- **Tareas**: responsable, vencimiento, prioridad y repetición (diaria, semanal, mensual). Al completar una tarea repetitiva se agenda automáticamente la siguiente.
- **Calendario**: vista mensual con eventos y tareas pendientes; tocá un día para ver el detalle o agregar un evento.
- **Ajustes**: miembros del hogar, categorías, presupuestos mensuales por categoría, y copia de seguridad (exportar/importar JSON).

## Cómo usarla

No necesita instalación ni servidor: abrí `index.html` en el navegador.
También se puede publicar tal cual en GitHub Pages o cualquier hosting estático.

Los datos se guardan en el navegador (`localStorage`), por lo que quedan solo en ese
dispositivo. Usá **Ajustes → Exportar datos** para respaldarlos o pasarlos a otro equipo.

## Estructura

| Archivo | Contenido |
| --- | --- |
| `index.html` | Estructura de las pantallas |
| `styles.css` | Estilos (responsive, modo oscuro automático) |
| `lib.js` | Lógica pura: resúmenes, presupuestos, fechas, recurrencias |
| `app.js` | Interfaz y manejo de eventos |
| `tests/` | Tests de la lógica |

## Tests

```bash
node --test tests/*.test.js
```
