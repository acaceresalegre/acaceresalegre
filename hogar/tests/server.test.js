// Pruebas del servidor de Apps Script (apps-script/Codigo.gs) sobre una planilla simulada.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGas } = require('./fake-gas');

const D = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const NOW = () => new Date(2026, 9, 12, 10, 0);

function planilla() {
  return {
    'Movimientos': [
      ['ID', 'Fecha', 'Tipo', 'Categoría', 'Subcategoría', 'Moneda', 'Importe', 'Medio de pago', 'Entidad', 'Comentarios', 'Cargado por', 'Actualizado'],
      ['M0001', D('2026-10-01'), 'Ingreso', 'Ingresos', 'Sueldo Alan', 'COP', 9800000, 'Transferencia', '', '', '', ''],
      ['M0002', D('2026-10-03'), 'Gasto', 'Alimentación', 'Supermercado', 'COP', 250000, 'Efectivo', 'Davivienda', 'Compra', '', ''],
    ],
    'Facturas': [
      ['ID', 'Nombre', 'Categoría', 'Subcategoría', 'Moneda', 'Importe', 'Vence', 'Pagada', 'Fecha de pago', 'Medio de pago',
        'Recurrente ID', 'Préstamo ID', 'Avisos (días antes)', 'Evento de calendario', 'Actualizado'],
      ['F0001', 'Hipoteca N°1', 'Obligaciones_financieras', 'Hipoteca N°1', 'COP', 1551581.78, D('2026-10-08'), 'No', '', '', '', 'H1', '3,0', '', ''],
    ],
    'Recurrentes': [
      ['ID', 'Nombre', 'Categoría', 'Subcategoría', 'Moneda', 'Importe', 'Día', 'Avisos (días antes)', 'Activa'],
      ['R01', 'Celular', 'Gastos_Fijos', 'Celular', 'COP', 32000, 29, '3,0', 'Sí'],
      ['R02', 'Alquiler', 'Gastos_Fijos', 'Alquiler', 'COP', 1600000, 16, '3,0', 'No'],
    ],
    'Por cobrar': [
      ['ID', 'Fecha de emisión', 'NIT', 'Cliente', 'Moneda', 'Valor', 'Vence', 'Estado', 'Fecha de cobro', 'Movimiento ID', 'Actualizado'],
      ['C001', D('2026-09-01'), '900000001', 'Clínica Ejemplo', 'COP', 1000000, D('2026-10-01'), 'Pendiente', '', '', ''],
    ],
    'Categorías': [['Categoría', 'Subcategoría', 'Tipo'], ['Alimentación', 'Supermercado', 'Gasto'], ['Ingresos', 'Sueldo Alan', 'Ingreso']],
    'Ajustes': [['Ajuste', 'Valor', 'Fuente o nota'], ['Tasa ARS (COP por 1 ARS)', 2.14, 'XE'], ['Calendario', 'Cuentas Casa', '']],
    'Deudas': [['ID', 'Préstamo', 'Moneda', 'Capital', 'Próxima cuota'], ['H1', 'Hipoteca N°1', 'COP', 70000000, 1551581.78]],
    'Cuotas': [
      ['ID préstamo', 'Préstamo', 'N° cuota', 'Vencimiento', 'Moneda', 'Amortización', 'Interés', 'Seguro', 'Diferidos', 'Cuota', 'Saldo', 'Pagada'],
      ['H1', 'Hipoteca N°1', 40, D('2026-10-08'), 'COP', 1, 1, 1, 1, 1551581.78, 1, 'No'],
      ['H1', 'Hipoteca N°1', 41, D('2026-11-07'), 'COP', 1, 1, 1, 1, 1551581.78, 1, 'No'],
      ['P4', 'Préstamo N°4', 20, D('2026-11-30'), 'COP', 0, 0, 0, 0, 0, 1, 'No'],
    ],
    'Presupuesto': [['Mes', 'Categoría', 'Subcategoría', 'Moneda', 'Importe'], [D('2025-10-01'), 'Alimentación', 'Supermercado', 'COP', 758423]],
    'Listas': [['Medio de pago', 'Moneda'], ['Efectivo', 'COP'], ['Transferencia', 'ARS']],
  };
}

const rowsOf = (gas, name) => gas.sheets[name].data.slice(1).filter((r) => r.some((v) => v !== '' && v !== undefined));

test('rechaza pedidos sin el código de acceso', () => {
  const gas = createGas(planilla(), { now: NOW });
  assert.deepEqual(gas.get({ action: 'version' }), { ok: false, error: 'Código de acceso inválido' });
  assert.equal(gas.post({ token: 'otro', ops: [] }).ok, false);
});

test('pull devuelve las pestañas con fechas como texto', () => {
  const gas = createGas(planilla(), { now: NOW });
  const res = gas.get({ token: 'secreto', action: 'pull' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.tables['Movimientos'][1], {
    ID: 'M0002', Fecha: '2026-10-03', Tipo: 'Gasto', 'Categoría': 'Alimentación', 'Subcategoría': 'Supermercado',
    Moneda: 'COP', Importe: 250000, 'Medio de pago': 'Efectivo', Entidad: 'Davivienda', Comentarios: 'Compra',
  });
  assert.equal(res.tables['Presupuesto'][0]['Mes'], '2025-10-01');
  assert.equal(res.tables['Cuotas'], undefined);
});

test('upsert agrega filas nuevas y actualiza solo las columnas enviadas', () => {
  const gas = createGas(planilla(), { now: NOW });
  const v0 = gas.get({ token: 'secreto', action: 'version' }).version;
  const res = gas.post({ token: 'secreto', user: 'Karo', ops: [
    { table: 'Movimientos', op: 'upsert', row: { ID: 'x1', Fecha: '2026-10-11', Tipo: 'Gasto', 'Categoría': 'Ocio', 'Subcategoría': 'Bares', Moneda: 'COP', Importe: 45000, Comentarios: 'Cena' } },
    { table: 'Movimientos', op: 'upsert', row: { ID: 'M0002', Importe: 260000 } },
  ] });
  assert.equal(res.ok, true);
  const rows = rowsOf(gas, 'Movimientos');
  assert.equal(rows.length, 3);
  const nuevo = rows[2];
  assert.equal(nuevo[0], 'x1');
  assert.ok(nuevo[1] instanceof Date && nuevo[1].getDate() === 11);
  assert.equal(nuevo[10], 'Karo');
  assert.ok(nuevo[11] instanceof Date);
  assert.equal(rows[1][6], 260000);
  assert.equal(rows[1][8], 'Davivienda', 'la columna Entidad no enviada se conserva');
  assert.equal(rows[1][10], '', 'Cargado por solo se completa en filas nuevas');
  assert.notEqual(res.version, v0);
});

test('delete borra la fila; en Recurrentes la desactiva', () => {
  const gas = createGas(planilla(), { now: NOW });
  gas.post({ token: 'secreto', ops: [
    { table: 'Movimientos', op: 'delete', row: { ID: 'M0001' } },
    { table: 'Recurrentes', op: 'delete', row: { ID: 'R01' } },
  ] });
  assert.deepEqual(rowsOf(gas, 'Movimientos').map((r) => r[0]), ['M0002']);
  assert.deepEqual(rowsOf(gas, 'Recurrentes').map((r) => [r[0], r[8]]), [['R01', 'No'], ['R02', 'No']]);
});

test('no permite escribir pestañas de solo lectura', () => {
  const gas = createGas(planilla(), { now: NOW });
  const res = gas.post({ token: 'secreto', ops: [{ table: 'Deudas', op: 'upsert', row: { ID: 'H1', Capital: 1 } }] });
  assert.equal(res.ok, false);
  assert.match(res.error, /no se puede modificar/);
});

test('genera las facturas del mes y el siguiente una sola vez', () => {
  const gas = createGas(planilla(), { now: NOW });
  gas.props.instaladoEl = '2026-10-01';
  gas.run('tareaPeriodica');
  gas.run('tareaPeriodica');
  const bills = rowsOf(gas, 'Facturas').map((r) => [r[1], r[6].toISOString().slice(0, 10), r[10] || r[11]]);
  assert.deepEqual(bills.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])), [
    ['Celular', '2026-10-29', 'R01'],
    ['Celular', '2026-11-29', 'R01'],
    ['Hipoteca N°1', '2026-10-08', 'H1'],
    ['Hipoteca N°1', '2026-11-07', 'H1'],
  ]);
});

test('no crea facturas que vencían antes de instalar', () => {
  const p = planilla();
  p['Recurrentes'].push(['R03', 'Promédico', 'Gastos_Fijos', 'Promedico', 'COP', 980000, 7, '3,0', 'Sí']);
  const gas = createGas(p, { now: NOW });
  gas.run('instalar');
  assert.equal(gas.props.instaladoEl, '2026-10-12');
  const prom = rowsOf(gas, 'Facturas').filter((r) => r[1] === 'Promédico').map((r) => r[6].toISOString().slice(0, 10));
  assert.deepEqual(prom, ['2026-11-07'], 'el 7 de octubre ya pasó al instalar');
});

test('calendario: crea eventos a las 9:00 con avisos y los actualiza al pagar o borrar', () => {
  const gas = createGas(planilla(), { now: NOW });
  gas.props.instaladoEl = '2026-10-01';
  gas.run('tareaPeriodica');
  const cal = gas.calendars[0];
  assert.equal(cal.getName(), 'Cuentas Casa');
  assert.equal(cal.events.length, 4);
  const hip = cal.events.find((e) => e.title.startsWith('Pagar Hipoteca N°1') && e.start.getMonth() === 9);
  assert.equal(hip.title, 'Pagar Hipoteca N°1 · $ 1.551.582');
  assert.equal(hip.start.getHours(), 9);
  assert.deepEqual(hip.reminders, [4320, 0]);
  const row = rowsOf(gas, 'Facturas').find((r) => r[0] === 'F0001');
  assert.equal(row[13], hip.id);

  gas.post({ token: 'secreto', ops: [{ table: 'Facturas', op: 'upsert', row: { ID: 'F0001', Pagada: 'Sí', 'Fecha de pago': '2026-10-08' } }] });
  assert.equal(hip.title, '✓ Pagada: Hipoteca N°1 · $ 1.551.582');
  assert.deepEqual(hip.reminders, []);

  gas.post({ token: 'secreto', ops: [{ table: 'Facturas', op: 'delete', row: { ID: 'F0001' } }] });
  assert.equal(cal.getEventById(hip.id), null);
});

test('instalar corrige la tasa ARS redondeada', () => {
  const gas = createGas(planilla(), { now: NOW });
  gas.run('instalar');
  assert.equal(rowsOf(gas, 'Ajustes')[0][1], 2.13845);
});

test('conectar la app pide la dirección publicada una vez y la usa en los enlaces', () => {
  const gas = createGas(planilla(), { now: NOW });
  gas.ui.promptAnswer = 'https://script.google.com/macros/s/OTRA/dev';
  gas.run('conectarApp');
  assert.equal(gas.props.webAppUrl, undefined, 'rechaza una dirección que no termina en /exec');
  assert.equal(gas.ui.dialogs.length, 0);

  gas.ui.promptAnswer = ' https://script.google.com/macros/s/AKfyc123/exec\n';
  gas.run('conectarApp');
  assert.equal(gas.props.webAppUrl, 'https://script.google.com/macros/s/AKfyc123/exec');
  const html = gas.ui.dialogs[0].html;
  assert.ok(html.includes('#conectar=' + encodeURIComponent('https://script.google.com/macros/s/AKfyc123/exec') + '&token=secreto&quien=Alan'));
  assert.ok(html.includes('Código: secreto'));

  gas.ui.promptAnswer = null;
  gas.run('conectarApp');
  assert.equal(gas.ui.prompts.length, 2, 'la segunda vez usa la dirección guardada');
  assert.equal(gas.ui.dialogs.length, 2);
});

test('agrega la columna Pagó la primera vez que la app la manda', () => {
  const gas = createGas(planilla(), { now: NOW });
  gas.post({ token: 'secreto', user: 'Alan', ops: [
    { table: 'Movimientos', op: 'upsert', row: { ID: 'x2', Fecha: '2026-10-11', Tipo: 'Gasto', 'Categoría': 'Ocio', Moneda: 'COP', Importe: 1000, 'Pagó': 'Karo' } },
  ] });
  const head = gas.sheets['Movimientos'].data[0];
  assert.equal(head[head.length - 1], 'Pagó');
  const fila = rowsOf(gas, 'Movimientos').find((r) => r[0] === 'x2');
  assert.equal(fila[head.indexOf('Pagó')], 'Karo');
  assert.equal(fila[head.indexOf('Cargado por')], 'Alan');
  const pulled = gas.get({ token: 'secreto', action: 'pull' }).tables['Movimientos'].find((m) => m.ID === 'x2');
  assert.equal(pulled['Pagó'], 'Karo');
});

test('la pestaña Reglas es opcional e instalar la crea', () => {
  const gas = createGas(planilla(), { now: NOW });
  assert.deepEqual(gas.get({ token: 'secreto', action: 'pull' }).tables['Reglas'], []);
  gas.run('instalar');
  assert.deepEqual(gas.sheets['Reglas'].data[0], ['Contiene', 'Categoría', 'Subcategoría', 'Tipo', 'Activa']);
  assert.ok(gas.sheets['Movimientos'].data[0].includes('Pagó'));
  const correos = rowsOf(gas, 'Ajustes').find((r) => r[0] === 'Correos del resumen');
  assert.equal(correos[1], 'alan@example.com');
  assert.deepEqual(gas.triggers.sort(), ['tareaDiaria', 'tareaPeriodica']);
  gas.run('instalar');
  assert.equal(gas.triggers.length, 2, 'reinstalar no duplica los activadores');
  assert.equal(rowsOf(gas, 'Ajustes').filter((r) => r[0] === 'Correos del resumen').length, 1);
});

function conMails(fecha) {
  const p = planilla();
  p['Ajustes'].push(['Correos del resumen', 'alan@example.com, karo@example.com', '']);
  p['Movimientos'][0].push('Pagó');
  p['Movimientos'].push(
    ['M0003', D('2026-10-05'), 'Gasto', 'Alimentación', 'Supermercado', 'COP', 250000, 'Efectivo', '', '', 'Alan', '', 'Karo'],
    ['M0004', D('2026-10-03'), 'Gasto', 'Alimentación', 'Supermercado', 'COP', 250000, 'Efectivo', '', '', 'Alan', ''],
    ['M0005', D('2026-10-06'), 'Gasto', 'Ocio', '', 'COP', 40000, 'Efectivo', '', '', 'Karo', ''],
  );
  let now = D(fecha);
  const gas = createGas(p, { now: () => now });
  gas.setNow = (s) => { now = D(s); };
  return gas;
}

test('mail de cierre preliminar 4 días antes de fin de mes, una sola vez', () => {
  const gas = conMails('2026-10-26');
  gas.run('tareaDiaria');
  assert.equal(gas.mails.length, 0);
  gas.setNow('2026-10-27');
  gas.run('tareaDiaria');
  gas.run('tareaDiaria');
  assert.equal(gas.mails.length, 1);
  const m = gas.mails[0];
  assert.equal(m.to, 'alan@example.com,karo@example.com');
  assert.equal(m.subject, 'Cuentas Casa · Cierre preliminar de octubre 2026');
  assert.match(m.htmlBody, /Hipoteca N°1/, 'factura sin pagar');
  assert.match(m.htmlBody, /posible duplicado/);
  assert.match(m.htmlBody, /sin subcategoría/);
});

test('resumen del mes anterior el día 1 con gastos por persona', () => {
  const gas = conMails('2026-11-01');
  gas.run('tareaDiaria');
  gas.run('tareaDiaria');
  assert.equal(gas.mails.length, 1);
  const m = gas.mails[0];
  assert.equal(m.subject, 'Cuentas Casa · Resumen de octubre 2026');
  // Gastos: 250.000 + 250.000 + 250.000 + 40.000 (la hipoteca no está pagada).
  assert.match(m.htmlBody, /\$ 790\.000/);
  assert.match(m.htmlBody, /Karo<\/td><td[^>]*>\$ 290\.000/);
  assert.match(m.htmlBody, /Alan<\/td><td[^>]*>\$ 250\.000/);
  assert.match(m.htmlBody, /Sin asignar<\/td><td[^>]*>\$ 250\.000/);
});
