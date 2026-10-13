const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib.js');

const TODAY = '2026-10-12';
const emptyState = () => {
  const s = L.baseState(TODAY);
  s.recurring = []; s.loans = [];
  return s;
};

test('formato de montos en COP, ARS y USD', () => {
  assert.equal(L.formatMoney(1551582, 'COP'), '$ 1.551.582');
  assert.equal(L.formatMoney(1234, 'ARS'), 'AR$ 1.234');
  assert.equal(L.formatMoney(-95.5, 'USD'), '−US$ 95,50');
  assert.equal(L.formatShort(113400000, 'COP'), '$ 113,4 M');
  assert.equal(L.formatShort(450000, 'COP'), '$ 450 mil');
});

test('conversión con tasas expresadas en COP', () => {
  const rates = { COP: 1, ARS: 2.13845, USD: 3194.44 };
  assert.equal(Math.round(L.convert(173089, 'ARS', 'COP', rates)), 370142);
  assert.equal(L.convert(3194.44, 'COP', 'USD', rates), 1);
});

test('campo de monto: solo dígitos, máximo 12, con miles', () => {
  assert.equal(L.cleanDigits('$ 01.234abc'), '1234');
  assert.equal(L.cleanDigits('1234567890123456'), '123456789012');
  assert.equal(L.groupDigits('1551582'), '1.551.582');
});

test('dueInfo: vencida, hoy, mañana, por vencer y más adelante', () => {
  const b = (due, extra) => ({ due, paid: false, alerts: [3, 0], ...extra });
  assert.equal(L.dueInfo(b('2026-10-10'), TODAY).label, 'Venció hace 2 días');
  assert.equal(L.dueInfo(b('2026-10-12'), TODAY).state, 'today');
  assert.equal(L.dueInfo(b('2026-10-13'), TODAY).label, 'Vence mañana');
  assert.equal(L.dueInfo(b('2026-10-15'), TODAY).state, 'soon');
  const later = L.dueInfo(b('2026-10-18'), TODAY);
  assert.equal(later.state, 'later');
  assert.equal(later.label, 'Vence el dom 18 oct · en 6 días');
  assert.equal(L.dueInfo(b('2026-10-18', { alerts: [7] }), TODAY).state, 'soon');
  assert.equal(L.dueInfo(b('2026-10-01', { paid: true, method: 'Transferencia' }), TODAY).label, 'Pagada · Transferencia');
});

test('ensureRecurring crea una instancia por mes y ajusta el día 30/31', () => {
  const s = emptyState();
  s.recurring.push({ id: 'r1', name: 'Préstamo N°3', cat: 'Obligaciones financieras', amount: 1162496, cur: 'COP', day: 30, alerts: [3, 0] });
  assert.equal(L.ensureRecurring(s, '2027-02'), 1);
  assert.equal(L.ensureRecurring(s, '2027-02'), 0);
  assert.equal(s.bills[0].due, '2027-02-28');
});

test('estadísticas de categoría: gastado, estado y proyección', () => {
  const s = emptyState();
  s.categories = [{ name: 'Ocio', limit: 1000, subs: [] }];
  s.movements.push({ type: 'exp', cat: 'Ocio', date: '2026-10-06', amount: 600, cur: 'COP' });
  s.bills.push({ cat: 'Ocio', due: '2026-10-20', amount: 100, cur: 'COP', paid: false });
  let [st] = L.categoryStats(s, '2026-10', TODAY);
  assert.equal(st.spent, 600);
  // proyección = 600 / 12 * 31 + 100 = 1650
  assert.equal(st.projection, 1650);
  assert.equal(st.status, 'proj');
  s.movements.push({ type: 'exp', cat: 'Ocio', date: '2026-10-07', amount: 250, cur: 'COP' });
  assert.equal(L.categoryStats(s, '2026-10', TODAY)[0].status, 'near'); // 85% con umbral 80
  s.bills[0].paid = true;
  [st] = L.categoryStats(s, '2026-10', TODAY);
  assert.equal(st.spent, 950);
  s.settings.threshold = 90;
  s.movements.push({ type: 'exp', cat: 'Ocio', date: '2026-10-08', amount: 50, cur: 'COP' });
  assert.equal(L.categoryStats(s, '2026-10', TODAY)[0].status, 'over');
});

test('resumen del mes: te quedaría = ingresos − gastos − facturas por pagar', () => {
  const s = emptyState();
  s.movements.push({ type: 'inc', cat: 'Sueldo Alan', date: '2026-10-01', amount: 1000, cur: 'COP' });
  s.movements.push({ type: 'exp', cat: 'Ocio', date: '2026-10-02', amount: 100, cur: 'COP' });
  s.movements.push({ type: 'exp', cat: 'Ocio', date: '2026-09-02', amount: 999, cur: 'COP' });
  s.bills.push({ cat: 'Vivienda', due: '2026-10-05', amount: 300, cur: 'COP', paid: true });
  s.bills.push({ cat: 'Vivienda', due: '2026-10-25', amount: 200, cur: 'COP', paid: false });
  const m = L.monthSummary(s, '2026-10');
  assert.deepEqual([m.income, m.expense, m.pending, m.remaining], [1000, 400, 200, 400]);
});

test('alertas en el orden pedido', () => {
  const s = emptyState();
  s.categories = [{ name: 'A', limit: 100, subs: [] }, { name: 'B', limit: 100, subs: [] }];
  s.movements.push({ type: 'exp', cat: 'A', date: '2026-10-01', amount: 120, cur: 'COP' });
  s.movements.push({ type: 'exp', cat: 'B', date: '2026-10-01', amount: 85, cur: 'COP' });
  s.bills.push({ id: 'x', name: 'Luz', cat: 'Z', due: '2026-10-14', amount: 1, cur: 'COP', paid: false, alerts: [3, 0] });
  s.bills.push({ id: 'y', name: 'Gas', cat: 'Z', due: '2026-10-02', amount: 1, cur: 'COP', paid: false, alerts: [3, 0] });
  s.receivables.push({ id: 'r', client: 'Cliente', due: '2026-10-01', amount: 5, cur: 'COP', collected: false });
  assert.deepEqual(L.buildAlerts(s, TODAY).map((a) => a.title),
    ['Gas venció', 'A excedido', 'Luz: vence el mié 14 oct · en 2 días', 'B al 85%', 'Por cobrar: Cliente']);
});

test('calendario: octubre 2026 empieza jueves (3 celdas vacías)', () => {
  const cells = L.calendarCells('2026-10');
  assert.deepEqual(cells.slice(0, 4), [null, null, null, '2026-10-01']);
  assert.equal(cells.length, 34);
  assert.equal(L.dayDot([{ paid: true, due: '2026-10-01' }], TODAY), 'green');
  assert.equal(L.dayDot([{ paid: false, due: '2026-10-10' }], TODAY), 'red');
  assert.equal(L.dayDot([{ paid: false, due: '2026-10-20' }], TODAY), 'amber');
});

test('datos de ejemplo: préstamos de la hoja Deudas y préstamos 1 y 2 vencidos', () => {
  const s = L.sampleState(TODAY);
  assert.equal(s.loans.length, 5);
  const p1 = s.bills.find((b) => b.name === 'Préstamo N°1');
  assert.equal(p1.due, '2026-10-10');
  assert.equal(p1.paid, false);
  assert.equal(s.bills.find((b) => b.name === 'Hipoteca N°1').paid, true);
  L.clearSamples(s);
  assert.equal(s.movements.length, 0);
  assert.equal(s.bills.length, 5);
  assert.ok(s.bills.every((b) => !b.paid));
});

test('ICS: eventos a las 9:00 con avisos y sin las ya pagadas', () => {
  const s = emptyState();
  s.recurring.push({ id: 'r1', name: 'Celular', cat: 'Gastos fijos', amount: 89000, cur: 'COP', day: 18, alerts: [3, 0] });
  L.ensureRecurring(s, '2026-10');
  const ics = L.toICS(s, TODAY);
  assert.match(ics, /DTSTART:20261018T090000/);
  assert.match(ics, /TRIGGER:-P3D/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 12);
  s.bills[0].paid = true;
  assert.doesNotMatch(L.toICS(s, TODAY), /20261018T090000/);
});

test('importar filas de "Movimientos Reales"', () => {
  const s = L.baseState(TODAY);
  const rows = [
    ['Movimientos Reales'],
    ['Período', 'Fecha', 'Categoría', 'Descripción', 'Moneda', 'Importe', 'Medio de pago', 'Entidad', 'Comentarios'],
    ['2026-10', '05/10/2026', 'Alimentación', 'Supermercado', 'COP', '450.000', 'Tarjeta Débito', 'Banco', ''],
    ['2026-10', new Date(2026, 9, 1), 'Sueldo Karo', '', 'COP', 7600000, 'Transferencia', '', 'Octubre'],
    ['2026-10', '2026-10-03', 'Gastos_Fijos', 'Internet', 'ARS', '-12.500,50', 'Efectivo', '', ''],
    ['2026-10', '2026-10-04', 'Algo raro', '', 'USD', '30', '', '', ''],
    ['', '', '', '', '', '', '', '', ''],
  ];
  const { movements, skipped } = L.parseMovementRows(rows, s);
  assert.equal(skipped, 1);
  assert.deepEqual(movements.map((m) => [m.date, m.type, m.cat, m.sub, m.cur, m.amount]), [
    ['2026-10-05', 'exp', 'Alimentación', 'Supermercado', 'COP', 450000],
    ['2026-10-01', 'inc', 'Sueldo Karo', '', 'COP', 7600000],
    ['2026-10-03', 'exp', 'Gastos fijos', 'Internet', 'ARS', 12500.5],
    ['2026-10-04', 'exp', 'Otros gastos', 'Algo raro', 'USD', 30],
  ]);
});

test('lectura de ticket: comercio, total, fecha y categoría sugerida', () => {
  const r = L.parseReceipt('ALMACENES EXITO S.A.\nNIT 890.900.608\nFecha: 11/10/2026\nLeche 4.500\nPan 6.200\nSUBTOTAL 10.700\nTOTAL $ 10.700\nCambio 0');
  assert.deepEqual(r, { merchant: 'ALMACENES EXITO S.A.', total: 10700, date: '2026-10-11', cat: 'Alimentación', sub: 'Supermercado' });
});

// ---------- Sincronización ----------
const TABLES = {
  'Movimientos': [
    { ID: 'M1', Fecha: '2026-10-01', Tipo: 'Ingreso', 'Categoría': 'Ingresos', 'Subcategoría': 'Sueldo Karo', Moneda: 'COP', Importe: 7600000, Entidad: 'Banco' },
    { ID: 'M2', Fecha: '2026-10-03', Tipo: 'Gasto', 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Luz', Moneda: 'COP', Importe: 187940, Comentarios: 'EPM' },
  ],
  'Facturas': [{ ID: 'F1', Nombre: 'Préstamo N°1', 'Categoría': 'Obligaciones_financieras', 'Subcategoría': 'Préstamo N°1', Moneda: 'ARS',
    Importe: 173088.92, Vence: '2026-10-10', Pagada: 'No', 'Préstamo ID': 'P1', 'Avisos (días antes)': '3,0', 'Evento de calendario': 'ev1' }],
  'Recurrentes': [
    { ID: 'R1', Nombre: 'Celular', 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Celular', Moneda: 'COP', Importe: 32000, 'Día': 29, 'Avisos (días antes)': 7, Activa: 'Sí' },
    { ID: 'R2', Nombre: 'Alquiler', 'Categoría': 'Gastos_Fijos', Moneda: 'COP', Importe: 1600000, 'Día': 16, Activa: 'No' },
  ],
  'Por cobrar': [{ ID: 'C1', 'Fecha de emisión': '2026-09-01', NIT: '900', Cliente: 'Clínica', Moneda: 'COP', Valor: 1000000, Vence: '2026-10-01', Estado: 'Pendiente' }],
  'Categorías': [
    { 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Luz', Tipo: 'Gasto' }, { 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Celular', Tipo: 'Gasto' },
    { 'Categoría': 'Obligaciones_financieras', 'Subcategoría': 'Préstamo N°1', Tipo: 'Gasto' },
    { 'Categoría': 'Ingresos', 'Subcategoría': 'Sueldo Alan', Tipo: 'Ingreso' }, { 'Categoría': 'Ingresos', 'Subcategoría': 'Sueldo Karo', Tipo: 'Ingreso' },
  ],
  'Ajustes': [{ Ajuste: 'Tasa ARS (COP por 1 ARS)', Valor: 2.13845 }, { Ajuste: 'Umbral de aviso de presupuesto', Valor: 0.9 }],
  'Deudas': [{ ID: 'P1', 'Préstamo': 'Préstamo N°1', Moneda: 'ARS', Capital: 2500000, 'Plazo (cuotas)': 42, 'Día de vencimiento': 10,
    'Próxima cuota': 172533.76, 'Saldo actual': 1821028.66, 'Cuotas vencidas': 22 }],
  'Presupuesto': [
    { Mes: '2025-10-01', 'Categoría': 'Gastos_Fijos', Moneda: 'COP', Importe: 3000000 },
    { Mes: '2025-10-01', 'Categoría': 'Gastos_Fijos', Moneda: 'COP', Importe: 1075013 },
    { Mes: '2025-09-01', 'Categoría': 'Gastos_Fijos', Moneda: 'COP', Importe: 1 },
  ],
  'Listas': [{ 'Medio de pago': 'Efectivo' }, { 'Medio de pago': 'Cheques' }],
};

test('sheetToState arma el estado de la app desde la planilla', () => {
  const s = L.sheetToState(TABLES, { settings: { displayCur: 'USD' } }, TODAY);
  assert.equal(s.synced, true);
  assert.equal(s.settings.displayCur, 'USD');
  assert.equal(s.settings.rates.ARS, 2.13845);
  assert.equal(s.settings.threshold, 90);
  assert.deepEqual(s.categories.map((c) => [c.name, c.limit, c.subs]), [
    ['Gastos fijos', 4075013, ['Luz', 'Celular']], ['Obligaciones financieras', 0, ['Préstamo N°1']]]);
  assert.deepEqual(s.incomeCats, ['Sueldo Alan', 'Sueldo Karo']);
  assert.deepEqual(s.methods, ['Efectivo', 'Cheques']);
  assert.deepEqual(s.movements.map((m) => [m.type, m.cat, m.sub]), [['inc', 'Sueldo Karo', ''], ['exp', 'Gastos fijos', 'Luz']]);
  assert.deepEqual(s.bills[0].alerts, [3, 0]);
  assert.equal(s.bills[0].loanId, 'P1');
  assert.deepEqual(s.recurring.map((r) => [r.id, r.alerts]), [['R1', [7]]]);
  assert.equal(s.receivables[0].collected, false);
  assert.deepEqual(s.loans[0], { id: 'P1', name: 'Préstamo N°1', cur: 'ARS', installment: 172533.76, day: 10,
    balance: 1821028.66, capital: 2500000, paidCount: 22, totalCount: 42 });
  // El estado convertido funciona con las reglas de negocio.
  assert.equal(L.categoryStats(s, '2026-10', TODAY)[0].spent, 187940);
});

test('stateToRows vuelve a los nombres de la planilla y diffRows detecta solo cambios', () => {
  const s = L.sheetToState(TABLES, null, TODAY);
  const before = L.stateToRows(s);
  assert.deepEqual(L.diffRows(before, L.stateToRows(s)), []);
  assert.equal(before['Movimientos'][1]['Categoría'], 'Gastos_Fijos');
  assert.equal(before['Movimientos'][0]['Categoría'], 'Ingresos');
  assert.equal(before['Movimientos'][0]['Subcategoría'], 'Sueldo Karo');

  s.bills[0].paid = true;
  s.bills[0].paidAt = '2026-10-12';
  s.movements.splice(0, 1);
  s.movements.push({ id: 'n1', date: '2026-10-12', type: 'exp', cat: 'Gastos fijos', sub: 'Celular', note: '', amount: 30000, cur: 'COP', method: 'Efectivo' });
  s.settings.threshold = 80;
  const ops = L.diffRows(before, L.stateToRows(s));
  assert.deepEqual(ops.map((o) => [o.table, o.op, o.row.ID || o.row.Ajuste]), [
    ['Movimientos', 'upsert', 'n1'],
    ['Movimientos', 'delete', 'M1'],
    ['Facturas', 'upsert', 'F1'],
    ['Ajustes', 'upsert', 'Umbral de aviso de presupuesto'],
  ]);
  const bill = ops.find((o) => o.table === 'Facturas').row;
  assert.equal(bill['Pagada'], 'Sí');
  assert.equal(bill['Avisos (días antes)'], '3,0');
  assert.equal(bill['Evento de calendario'], undefined, 'la app no pisa columnas que no maneja');
  assert.equal(ops.find((o) => o.row.ID === 'n1').row['Categoría'], 'Gastos_Fijos');
});

test('parseConnectHash solo acepta direcciones de Apps Script', () => {
  assert.deepEqual(L.parseConnectHash('#conectar=https%3A%2F%2Fscript.google.com%2Fmacros%2Fs%2Fabc%2Fexec&token=t1&quien=Karo'),
    { url: 'https://script.google.com/macros/s/abc/exec', token: 't1', user: 'Karo' });
  assert.equal(L.parseConnectHash('#conectar=https%3A%2F%2Fevil.com%2Fx&token=t1'), null);
  assert.equal(L.parseConnectHash(''), null);
});

// ---------- Dashboard ----------
function dashState() {
  const s = L.baseState(TODAY);
  s.recurring = []; s.loans = [];
  s.categories = [{ name: 'Ocio', limit: 3100, subs: [] }, { name: 'Salud', limit: 0, subs: [] }];
  s.movements = [
    { id: 'a', type: 'inc', cat: 'Sueldo Alan', date: '2026-10-01', amount: 10000, cur: 'COP', note: 'Sueldo' },
    { id: 'b', type: 'exp', cat: 'Ocio', sub: 'Bares', date: '2026-10-02', amount: 600, cur: 'COP', note: 'Cena', method: 'Efectivo' },
    { id: 'c', type: 'exp', cat: 'Ocio', sub: 'Cine', date: '2026-10-05', amount: 600, cur: 'COP', note: 'Película', method: 'Tarjeta Crédito' },
    { id: 'd', type: 'exp', cat: 'Salud', date: '2026-09-20', amount: 1, cur: 'USD', note: 'Farmacia', method: 'Efectivo' },
  ];
  s.bills = [
    { id: 'f1', cat: 'Salud', due: '2026-10-03', amount: 300, cur: 'COP', paid: true },
    { id: 'f2', cat: 'Salud', due: '2026-10-20', amount: 200, cur: 'COP', paid: false },
  ];
  return s;
}

test('monthSeries devuelve ingresos y gastos de los últimos meses', () => {
  const series = L.monthSeries(dashState(), '2026-10', 3);
  assert.deepEqual(series.map((m) => m.key), ['2026-08', '2026-09', '2026-10']);
  assert.equal(series[0].hasData, false);
  assert.equal(series[1].expense, 3194.44);
  assert.deepEqual([series[2].income, series[2].expense], [10000, 1500]);
});

test('dailySpend acumula por día y proyecta el cierre', () => {
  const d = L.dailySpend(dashState(), '2026-10', TODAY);
  assert.equal(d.dim, 31);
  assert.deepEqual(d.cumulative.slice(0, 5), [0, 600, 900, 900, 1500]);
  assert.equal(d.cumulative[30], 1500);
  assert.equal(d.elapsed, 12);
  assert.equal(d.budget, 3100);
  // 1200 / 12 * 31 + facturas del mes (300 + 200)
  assert.equal(d.projection, 3600);
});

test('filterMovements filtra por período, tipo, búsqueda y ordena', () => {
  const s = dashState();
  const mes = L.filterMovements(s, { period: 'month' }, TODAY);
  assert.deepEqual(mes.list.map((m) => m.id), ['c', 'b', 'a']);
  assert.deepEqual([mes.income, mes.expense, mes.net], [10000, 1200, 8800]);
  assert.deepEqual(L.filterMovements(s, { period: '3m', type: 'exp', sort: 'amount', dir: 'desc' }, TODAY).list.map((m) => m.id), ['d', 'c', 'b']);
  assert.deepEqual(L.filterMovements(s, { period: 'all', q: 'pelicula' }, TODAY).list.map((m) => m.id), ['c']);
  assert.deepEqual(L.filterMovements(s, { period: 'all', method: 'Efectivo' }, TODAY).list.map((m) => m.id), ['b', 'd']);
  assert.deepEqual(L.filterMovements(s, { period: 'month', month: '2026-09' }, TODAY).list.map((m) => m.id), ['d']);
});

// ---------- Personas y reglas ----------
const conPersonas = () => ({
  ...TABLES,
  'Movimientos': [
    ...TABLES['Movimientos'],
    { ID: 'M3', Fecha: '2026-10-05', Tipo: 'Gasto', 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Luz', Moneda: 'COP', Importe: 50000, Comentarios: 'Recarga celular', 'Cargado por': 'Alan', 'Pagó': 'Karo' },
    { ID: 'M4', Fecha: '2026-10-06', Tipo: 'Gasto', 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Celular', Moneda: 'COP', Importe: 32000, Comentarios: 'Recarga celular', 'Cargado por': 'Alan' },
    { ID: 'M5', Fecha: '2026-10-07', Tipo: 'Gasto', 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Celular', Moneda: 'COP', Importe: 32000, Comentarios: 'recarga  Celular' },
  ],
  'Reglas': [
    { Contiene: 'EPM', 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Luz', Tipo: 'Gasto', Activa: 'Sí' },
    { Contiene: 'EPM agua', 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Celular', Tipo: 'Gasto' },
    { Contiene: 'éxito', 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Luz', Tipo: 'Gasto', Activa: 'No' },
    { Contiene: 'nómina', 'Categoría': 'Ingresos', 'Subcategoría': 'Sueldo Alan', Tipo: 'Ingreso' },
    { Contiene: 'super', 'Categoría': 'No_existe', Tipo: 'Gasto' },
  ],
});

test('quién cargó y quién pagó cada movimiento', () => {
  const s = L.sheetToState(conPersonas(), null, TODAY);
  const m3 = s.movements.find((m) => m.id === 'M3');
  assert.deepEqual([m3.by, m3.paidBy, L.personOf(m3)], ['Alan', 'Karo', 'Karo']);
  assert.equal(L.personOf(s.movements.find((m) => m.id === 'M4')), 'Alan');
  assert.deepEqual(L.peopleOf(s), ['Alan', 'Karo']);
  assert.deepEqual(L.spendByPerson(s, '2026-10').map((r) => [r.name, r.income, r.expense]), [
    ['Karo', 0, 50000], ['Alan', 0, 32000], ['Sin asignar', 7600000, 187940 + 32000]]);
  const f = (person) => L.filterMovements(s, { period: 'month', month: '2026-10', person }, TODAY).list.map((m) => m.id).sort();
  assert.deepEqual(f('Karo'), ['M3']);
  assert.deepEqual(f('-'), ['M1', 'M2', 'M5']);
  const row = L.stateToRows(s)['Movimientos'].find((r) => r.ID === 'M3');
  assert.equal(row['Pagó'], 'Karo');
  assert.equal(row['Cargado por'], undefined, 'Cargado por lo completa la planilla');
});

test('una columna nueva no hace reenviar todas las filas', () => {
  const s = L.sheetToState(TABLES, null, TODAY);
  const viejo = L.stateToRows(s);
  viejo['Movimientos'].forEach((r) => delete r['Pagó']);
  assert.deepEqual(L.diffRows(viejo, L.stateToRows(s)), []);
  s.movements[1].paidBy = 'Alan';
  assert.deepEqual(L.diffRows(viejo, L.stateToRows(s)).map((o) => [o.row.ID, o.row['Pagó']]), [['M2', 'Alan']]);
});

test('sugerencia de categoría: reglas primero, después el historial', () => {
  const s = L.sheetToState(conPersonas(), null, TODAY);
  assert.deepEqual(s.rules.map((r) => r.text), ['EPM', 'EPM agua', 'nómina', 'super'], 'las reglas inactivas no se cargan');
  assert.deepEqual(L.suggestCategory(s, 'Factura epm octubre', 'exp'), { cat: 'Gastos fijos', sub: 'Luz', source: 'regla', match: 'EPM' });
  assert.equal(L.suggestCategory(s, 'EPM Agua', 'exp').sub, 'Celular', 'gana la coincidencia más larga');
  assert.deepEqual(L.suggestCategory(s, 'Nomina octubre', 'inc'), { cat: 'Sueldo Alan', sub: '', source: 'regla', match: 'nómina' });
  assert.equal(L.suggestCategory(s, 'supermercado', 'exp'), null, 'una regla con categoría inexistente se ignora');
  assert.deepEqual(L.suggestCategory(s, 'Recarga celular', 'exp'), { cat: 'Gastos fijos', sub: 'Celular', source: 'historial' });
  assert.equal(L.suggestCategory(s, 're', 'exp'), null);
});

// ---------- Metas ----------
const conMetas = () => ({
  ...TABLES,
  'Metas': [
    { ID: 'G1', Nombre: 'Vacaciones', 'Monto objetivo': 6000000, Moneda: 'COP', 'Fecha objetivo': '2027-03-31', 'Ahorro inicial': 1000000, Activa: 'Sí' },
    { ID: 'G2', Nombre: 'Auto viejo', 'Monto objetivo': 1, Moneda: 'COP', Activa: 'No' },
  ],
  'Movimientos': [
    ...TABLES['Movimientos'],
    { ID: 'A1', Fecha: '2026-08-05', Tipo: 'Ahorro', 'Categoría': 'Ahorro', 'Subcategoría': 'Vacaciones', 'Meta ID': 'G1', Moneda: 'COP', Importe: 500000 },
    { ID: 'A2', Fecha: '2026-10-05', Tipo: 'Ahorro', 'Categoría': 'Ahorro', 'Subcategoría': 'Vacaciones', 'Meta ID': 'G1', Moneda: 'COP', Importe: 700000 },
    { ID: 'A3', Fecha: '2026-10-09', Tipo: 'Ahorro', 'Categoría': 'Ahorro', 'Subcategoría': 'Vacaciones', 'Meta ID': 'G1', Moneda: 'COP', Importe: -100000, 'Pagó': 'Karo' },
  ],
});

test('metas: los aportes son movimientos de Ahorro que no cuentan como gasto', () => {
  const s = L.sheetToState(conMetas(), null, TODAY);
  assert.deepEqual(s.goals.map((g) => [g.id, g.name, g.target, g.due, g.initial]), [['G1', 'Vacaciones', 6000000, '2027-03-31', 1000000]]);
  const a2 = s.movements.find((m) => m.id === 'A2');
  assert.deepEqual([a2.type, a2.goalId, a2.cat], ['save', 'G1', 'Vacaciones']);
  const sum = L.monthSummary(s, '2026-10');
  assert.equal(sum.expense, 187940, 'el aporte no suma a gastos');
  assert.equal(sum.saved, 600000);
  assert.equal(sum.remaining, sum.income - sum.expense - sum.pending - 600000);
  assert.equal(L.categoryStats(s, '2026-10', TODAY).reduce((x, c) => x + c.spent, 0), 187940);
  assert.deepEqual(L.spendByPerson(s, '2026-10').map((r) => r.name), ['Sin asignar'], 'los aportes no van a gastos por persona');
  const f = L.filterMovements(s, { period: 'month', month: '2026-10', type: 'save' }, TODAY);
  assert.deepEqual([f.list.length, f.expense, f.saved], [2, 0, 600000]);
});

test('metas: avance, cuánto falta por mes, ritmo y fecha estimada', () => {
  const s = L.sheetToState(conMetas(), null, TODAY);
  const p = L.goalProgress(s, s.goals[0], TODAY);
  assert.equal(p.saved, 1000000 + 500000 + 700000 - 100000);
  assert.equal(p.left, 6000000 - 2100000);
  assert.equal(p.monthsLeft, 6, 'de octubre a marzo inclusive');
  assert.equal(p.needed, 3900000 / 6);
  assert.equal(p.pace, 1100000 / 3);
  assert.equal(p.status, 'behind');
  assert.equal(p.eta, L.addMonths('2026-10', Math.ceil(3900000 / (1100000 / 3)) - 1));
  // Meta nueva: un solo mes de aportes se promedia sobre ese mes.
  const nueva = { id: 'G9', name: 'Nueva', target: 1000000, cur: 'COP', due: '2027-01-31', initial: 0 };
  s.movements.push({ id: 'A9', date: TODAY, type: 'save', goalId: 'G9', cat: 'Nueva', amount: 250000, cur: 'COP' });
  assert.deepEqual([L.goalProgress(s, nueva, TODAY).pace, L.goalProgress(s, nueva, TODAY).status], [250000, 'ok']);
  s.goals[0].target = 2000000;
  assert.equal(L.goalProgress(s, s.goals[0], TODAY).status, 'done');
  s.goals[0].due = '';
  s.goals[0].target = 9000000;
  assert.equal(L.goalProgress(s, s.goals[0], TODAY).status, 'nodate');
  // Meta en USD con aportes en COP.
  const usd = { id: 'G1', name: 'x', target: 1000, cur: 'USD', due: '', initial: 0 };
  assert.ok(Math.abs(L.goalProgress(s, usd, TODAY).saved - 1100000 / s.settings.rates.USD) < 1e-6);
});

test('metas: vuelven a la planilla y una meta borrada se manda a borrar', () => {
  const s = L.sheetToState(conMetas(), null, TODAY);
  const before = L.stateToRows(s);
  assert.deepEqual(L.diffRows(before, L.stateToRows(s)), []);
  const a3 = before['Movimientos'].find((r) => r.ID === 'A3');
  assert.deepEqual([a3['Tipo'], a3['Categoría'], a3['Subcategoría'], a3['Meta ID'], a3['Importe']], ['Ahorro', 'Ahorro', 'Vacaciones', 'G1', -100000]);
  assert.equal(before['Movimientos'].find((r) => r.ID === 'M2')['Meta ID'], undefined, 'los gastos no llevan Meta ID');
  s.goals[0].name = 'Viaje';
  s.movements.push({ id: 'A4', date: TODAY, type: 'save', goalId: 'G1', cat: 'Viaje', sub: '', note: '', amount: 50000, cur: 'COP', method: '' });
  const ops = L.diffRows(before, L.stateToRows(s));
  assert.deepEqual(ops.map((o) => [o.table, o.op, o.row.ID]).sort(), [
    ['Metas', 'upsert', 'G1'], ['Movimientos', 'upsert', 'A1'], ['Movimientos', 'upsert', 'A2'], ['Movimientos', 'upsert', 'A3'], ['Movimientos', 'upsert', 'A4']].sort());
  s.goals = [];
  assert.deepEqual(L.diffRows(before, L.stateToRows(s)).filter((o) => o.table === 'Metas').map((o) => o.op), ['delete']);
  assert.match(L.toCSV(s), /"Ahorro";"Viaje"/);
});
