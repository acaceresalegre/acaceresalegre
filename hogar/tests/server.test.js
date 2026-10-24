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
      ['M0001', D('2026-10-01'), 'Ingreso', 'Ingresos', 'Sueldo Alan', 'COP', 8000000, 'Transferencia', '', '', '', ''],
      ['M0002', D('2026-10-03'), 'Gasto', 'Alimentación', 'Supermercado', 'COP', 250000, 'Efectivo', 'Davivienda', 'Compra', '', ''],
    ],
    'Facturas': [
      ['ID', 'Nombre', 'Categoría', 'Subcategoría', 'Moneda', 'Importe', 'Vence', 'Pagada', 'Fecha de pago', 'Medio de pago',
        'Recurrente ID', 'Préstamo ID', 'Avisos (días antes)', 'Evento de calendario', 'Actualizado'],
      ['F0001', 'Hipoteca N°1', 'Obligaciones_financieras', 'Hipoteca N°1', 'COP', 1400000.25, D('2026-10-08'), 'No', '', '', '', 'H1', '3,0', '', ''],
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
    'Deudas': [['ID', 'Préstamo', 'Moneda', 'Capital', 'Próxima cuota'], ['H1', 'Hipoteca N°1', 'COP', 60000000, 1400000.25]],
    'Cuotas': [
      ['ID préstamo', 'Préstamo', 'N° cuota', 'Vencimiento', 'Moneda', 'Amortización', 'Interés', 'Seguro', 'Diferidos', 'Cuota', 'Saldo', 'Pagada'],
      ['H1', 'Hipoteca N°1', 40, D('2026-10-08'), 'COP', 1, 1, 1, 1, 1400000.25, 1, 'No'],
      ['H1', 'Hipoteca N°1', 41, D('2026-11-07'), 'COP', 1, 1, 1, 1, 1400000.25, 1, 'No'],
      ['P4', 'Préstamo N°4', 20, D('2026-11-30'), 'COP', 0, 0, 0, 0, 0, 1, 'No'],
    ],
    'Presupuesto': [['Mes', 'Categoría', 'Subcategoría', 'Moneda', 'Importe'], [D('2025-10-01'), 'Alimentación', 'Supermercado', 'COP', 700000]],
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
  // Cuotas: solo las de la ventana de meses alrededor de hoy.
  assert.deepEqual(res.tables['Cuotas'].map((c) => [c['ID préstamo'], c['Vencimiento']]),
    [['H1', '2026-10-08'], ['H1', '2026-11-07'], ['P4', '2026-11-30']]);
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
  assert.equal(hip.title, 'Pagar Hipoteca N°1 · $ 1.400.000');
  assert.equal(hip.start.getHours(), 9);
  assert.deepEqual(hip.reminders, [4320, 0]);
  const row = rowsOf(gas, 'Facturas').find((r) => r[0] === 'F0001');
  assert.equal(row[13], hip.id);

  gas.post({ token: 'secreto', ops: [{ table: 'Facturas', op: 'upsert', row: { ID: 'F0001', Pagada: 'Sí', 'Fecha de pago': '2026-10-08' } }] });
  assert.equal(hip.title, '✓ Pagada: Hipoteca N°1 · $ 1.400.000');
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
  assert.ok(gas.sheets['Movimientos'].data[0].includes('Origen ID') && gas.sheets['Movimientos'].data[0].includes('Destino ID'));
  const correos = rowsOf(gas, 'Ajustes').find((r) => r[0] === 'Correos del resumen');
  assert.equal(correos[1], 'alan@example.com');
  assert.deepEqual(gas.triggers.sort(), ['alCambiar', 'respaldoSemanal', 'tareaDiaria', 'tareaPeriodica']);
  gas.run('instalar');
  assert.equal(gas.triggers.length, 4, 'reinstalar no duplica los activadores');
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
    ['M0006', D('2026-10-10'), 'Transferencia', 'Transferencia', 'Banco → Visa', 'COP', 900000, '', '', 'Pago tarjeta', 'Alan', ''],
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
  // Gastos: 250.000 + 250.000 + 250.000 + 40.000 (la hipoteca no está pagada; el pago de la tarjeta es transferencia).
  assert.match(m.htmlBody, /\$ 790\.000/);
  assert.match(m.htmlBody, /Karo<\/td><td[^>]*>\$ 290\.000/);
  assert.match(m.htmlBody, /Alan<\/td><td[^>]*>\$ 250\.000/);
  assert.match(m.htmlBody, /Sin asignar<\/td><td[^>]*>\$ 250\.000/);
});

test('metas: la pestaña se crea al guardar la primera y los aportes no son gasto en el mail', () => {
  const p = planilla();
  p['Ajustes'].push(['Correos del resumen', 'alan@example.com', '']);
  let now = D('2026-10-10');
  const gas = createGas(p, { now: () => now });
  gas.post({ token: 'secreto', user: 'Alan', ops: [
    { table: 'Metas', op: 'upsert', row: { ID: 'G1', Nombre: 'Vacaciones', 'Monto objetivo': 1000000, Moneda: 'COP', 'Fecha objetivo': '2027-03-31', 'Ahorro inicial': 100000, Activa: 'Sí' } },
    { table: 'Movimientos', op: 'upsert', row: { ID: 'A1', Fecha: '2026-10-09', Tipo: 'Ahorro', 'Categoría': 'Ahorro', 'Subcategoría': 'Vacaciones', 'Meta ID': 'G1', Moneda: 'COP', Importe: 300000 } },
  ] });
  assert.deepEqual(gas.sheets['Metas'].data[0], ['ID', 'Nombre', 'Monto objetivo', 'Moneda', 'Fecha objetivo', 'Ahorro inicial', 'Activa', 'Comentarios', 'Actualizado']);
  const pulled = gas.get({ token: 'secreto', action: 'pull' }).tables;
  assert.equal(pulled['Metas'][0]['Fecha objetivo'], '2027-03-31');
  assert.equal(pulled['Movimientos'].find((m) => m.ID === 'A1')['Meta ID'], 'G1');
  gas.post({ token: 'secreto', ops: [{ table: 'Metas', op: 'delete', row: { ID: 'G1' } }] });
  assert.equal(rowsOf(gas, 'Metas')[0][6], 'No', 'borrar una meta la desactiva');
  gas.post({ token: 'secreto', ops: [{ table: 'Metas', op: 'upsert', row: { ID: 'G1', Activa: 'Sí' } }] });

  now = D('2026-11-01');
  gas.run('tareaDiaria');
  const html = gas.mails[0].htmlBody;
  assert.match(html, /Aportado a metas en el mes: <b>\$ 300\.000/);
  assert.match(html, /Gastos<\/div><div[^>]*>\$ 250\.000/, 'el aporte no suma a gastos');
  assert.match(html, /Vacaciones.*\$ 400\.000.*\$ 1\.000\.000.*40%/);
});

test('balance: cuentas y saldos se crean solos y el cierre recuerda cargar saldos', () => {
  const p = planilla();
  p['Ajustes'].push(['Correos del resumen', 'alan@example.com', '']);
  p['Cuotas'].push(['H1', 'Hipoteca N°1', 1, D('2023-07-08'), 'COP', 1, 1, 1, 1, 1, 1, 'Sí']);
  let now = D('2026-10-12');
  const gas = createGas(p, { now: () => now });
  gas.post({ token: 'secreto', ops: [
    { table: 'Cuentas y bienes', op: 'upsert', row: { ID: 'B1', Nombre: 'Banco', Tipo: 'Cuenta bancaria', Moneda: 'COP', Activa: 'Sí' } },
    { table: 'Cuentas y bienes', op: 'upsert', row: { ID: 'B2', Nombre: 'Efectivo', Tipo: 'Efectivo', Moneda: 'COP', Activa: 'Sí' } },
    { table: 'Saldos', op: 'upsert', row: { 'Cuenta ID': 'B1', Cuenta: 'Banco', Mes: '2026-10-01', Moneda: 'COP', Saldo: 5000000 } },
  ] });
  gas.post({ token: 'secreto', ops: [{ table: 'Saldos', op: 'upsert', row: { 'Cuenta ID': 'B1', Mes: '2026-10-01', Saldo: 5100000 } }] });
  assert.equal(rowsOf(gas, 'Saldos').length, 1, 'mismo mes y cuenta: se actualiza la fila');
  assert.equal(rowsOf(gas, 'Saldos')[0][4], 5100000);
  const t = gas.get({ token: 'secreto', action: 'pull' }).tables;
  assert.equal(t['Saldos'][0]['Mes'], '2026-10-01');
  assert.ok(!t['Cuotas'].some((c) => c['Vencimiento'] === '2023-07-08'), 'las cuotas viejas no se mandan');
  now = D('2026-10-27');
  gas.run('tareaDiaria');
  assert.match(gas.mails[0].htmlBody, /Saldos de cierre para cargar.*<b>Efectivo<\/b>/);
  assert.doesNotMatch(gas.mails[0].htmlBody, /<b>Banco<\/b>/);
});

test('ocr: sube la foto a Drive como documento, devuelve el texto y borra el temporal', () => {
  const gas = createGas(planilla(), { now: NOW, fetch: (url) => {
    if (url.includes('/upload/drive/v2/files')) return { code: 200, body: JSON.stringify({ id: 'doc123' }) };
    if (url.includes('/export')) return { code: 200, body: 'EXITO\nTOTAL $ 12.600' };
    return { code: 204, body: '' };
  } });
  const res = gas.post({ token: 'secreto', action: 'ocr', image: Buffer.from('jpegbytes').toString('base64'), mime: 'image/jpeg' });
  assert.deepEqual(res, { ok: true, text: 'EXITO\nTOTAL $ 12.600' });
  assert.deepEqual(gas.fetches.map((f) => [f.method, f.url.split('?')[0].replace('https://www.googleapis.com', '')]), [
    ['post', '/upload/drive/v2/files'], ['get', '/drive/v3/files/doc123/export'], ['delete', '/drive/v3/files/doc123']]);
  assert.match(gas.fetches[0].url, /ocr=true&ocrLanguage=es/);
  assert.equal(gas.fetches[0].headers.Authorization, 'Bearer tok-oauth');
  assert.ok(Buffer.from(gas.fetches[0].payload).toString().includes('jpegbytes'));
  assert.equal(rowsOf(gas, 'Movimientos').length, 2, 'leer una foto no toca la planilla');

  assert.equal(gas.post({ token: 'otro', action: 'ocr', image: 'x' }).ok, false);
  const fail = createGas(planilla(), { now: NOW, fetch: () => ({ code: 403, body: 'no' }) });
  assert.match(fail.post({ token: 'secreto', action: 'ocr', image: 'eA==' }).error, /lector de Google/);
});

test('auditoría: borrar y recrear en un envío, IDs duplicados y facturas mensuales', () => {
  const p = planilla();
  p['Movimientos'].push(['M0002', D('2026-10-04'), 'Gasto', 'Ocio', '', 'COP', 1, '', '', 'copia a mano', '', '']);
  const gas = createGas(p, { now: NOW });
  gas.props.instaladoEl = '2026-10-01';
  // ID duplicado a mano: borrar lo elimina entero y no toca otras filas.
  gas.post({ token: 'secreto', ops: [{ table: 'Movimientos', op: 'delete', row: { ID: 'M0002' } }] });
  assert.deepEqual(rowsOf(gas, 'Movimientos').map((r) => r[0]), ['M0001']);
  // Borrar y volver a crear la misma clave en un mismo envío deja la fila nueva.
  gas.post({ token: 'secreto', ops: [
    { table: 'Saldos', op: 'upsert', row: { 'Cuenta ID': 'B1', Mes: '2026-09-01', Saldo: 1 } }] });
  gas.post({ token: 'secreto', ops: [
    { table: 'Saldos', op: 'delete', row: { 'Cuenta ID': 'B1', Mes: '2026-09-01' } },
    { table: 'Saldos', op: 'upsert', row: { 'Cuenta ID': 'B1', Mes: '2026-09-01', Saldo: 2 } }] });
  assert.deepEqual(rowsOf(gas, 'Saldos').map((r) => r[4]), [2]);
  // Factura mensual que arranca el mes que viene: no se crea la de este mes.
  gas.post({ token: 'secreto', ops: [{ table: 'Recurrentes', op: 'upsert', row: { ID: 'R9', Nombre: 'Gym', 'Categoría': 'Ocio', Moneda: 'COP', Importe: 90000, 'Día': 5, Activa: 'Sí', Desde: '2026-11' } }] });
  const gym = () => rowsOf(gas, 'Facturas').filter((r) => r[1] === 'Gym').map((r) => r[6].toISOString().slice(0, 7));
  assert.deepEqual(gym(), ['2026-11']);
  // Borrar una factura mensual no la vuelve a crear.
  const celu = rowsOf(gas, 'Facturas').find((r) => r[1] === 'Celular' && r[6].getMonth() === 10);
  gas.post({ token: 'secreto', ops: [{ table: 'Facturas', op: 'delete', row: { ID: celu[0] } }] });
  gas.run('tareaPeriodica');
  assert.equal(rowsOf(gas, 'Facturas').filter((r) => r[1] === 'Celular' && r[6].getMonth() === 10).length, 0);
  // Ajustes: solo las claves que maneja la app; los textos con = no quedan como fórmula.
  gas.post({ token: 'secreto', ops: [
    { table: 'Ajustes', op: 'upsert', row: { Ajuste: 'Correos del resumen', Valor: 'otro@example.com' } },
    { table: 'Movimientos', op: 'upsert', row: { ID: 'X1', Fecha: '2026-10-10', Tipo: 'Gasto', Comentarios: '=HYPERLINK("x")', Importe: 1 } }] });
  assert.ok(!rowsOf(gas, 'Ajustes').some((r) => r[0] === 'Correos del resumen'));
  assert.equal(rowsOf(gas, 'Movimientos').find((r) => r[0] === 'X1')[9], '\'=HYPERLINK("x")');
  // Lectura por POST, sin el código en la dirección.
  assert.equal(gas.post({ token: 'secreto', action: 'version' }).ok, true);
  assert.ok(gas.post({ token: 'secreto', action: 'pull' }).tables['Movimientos']);
});

test('auditoría: los mails salen aunque el activador se saltee el día', () => {
  const p = planilla();
  p['Ajustes'].push(['Correos del resumen', 'alan@example.com', '']);
  let now = D('2026-10-29');
  const gas = createGas(p, { now: () => now });
  gas.run('tareaDiaria');
  now = D('2026-11-03');
  gas.run('tareaDiaria');
  gas.run('tareaDiaria');
  assert.deepEqual(gas.mails.map((m) => m.subject.split(' · ')[1]), ['Cierre preliminar de octubre 2026', 'Resumen de octubre 2026']);
});

test('respaldo semanal: copia la planilla en la carpeta Backup y guarda solo las últimas 12', () => {
  let now = new Date(2026, 9, 12, 3, 0);
  const gas = createGas(planilla(), { now: () => now });
  assert.equal(gas.get({ token: 'secreto', action: 'pull' }).respaldo, '');
  gas.run('instalar');
  assert.equal(gas.drive.folders.length, 1);
  assert.equal(gas.drive.folders[0].name, 'Backup');
  const vivos = () => gas.drive.files.filter((f) => !f.trashed).map((f) => f.name);
  assert.deepEqual(vivos(), ['Cuentas Casa - respaldo 2026-10-12'], 'instalar hace el primer respaldo');
  gas.run('respaldoSemanal');
  assert.equal(vivos().length, 1, 'dos respaldos el mismo día no se duplican');
  for (let i = 1; i <= 13; i++) { now = new Date(2026, 9, 12 + 7 * i, 3, 0); gas.run('respaldoSemanal'); }
  assert.equal(gas.drive.folders.length, 1, 'reusa la carpeta');
  const quedan = vivos().sort();
  assert.equal(quedan.length, 12);
  assert.equal(quedan[0], 'Cuentas Casa - respaldo 2026-10-26', 'los más viejos van a la papelera');
  assert.equal(quedan[11], 'Cuentas Casa - respaldo 2027-01-11');
  const r = gas.get({ token: 'secreto', action: 'pull' });
  assert.equal(r.respaldo, '2027-01-11');
  assert.equal(typeof r.codigo, 'number');
  gas.run('respaldarAhora');
  assert.match(gas.ui.alerts.at(-1), /Backup/);
});
