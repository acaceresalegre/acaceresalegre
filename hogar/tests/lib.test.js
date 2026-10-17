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
  assert.equal(L.formatMoney(1400000, 'COP'), '$ 1.400.000');
  assert.equal(L.formatMoney(1234, 'ARS'), 'AR$ 1.234');
  assert.equal(L.formatMoney(-95.5, 'USD'), '−US$ 95,50');
  assert.equal(L.formatShort(113400000, 'COP'), '$ 113,4 M');
  assert.equal(L.formatShort(450000, 'COP'), '$ 450 mil');
});

test('conversión con tasas expresadas en COP', () => {
  const rates = { COP: 1, ARS: 2.13845, USD: 3194.44 };
  assert.equal(Math.round(L.convert(160001, 'ARS', 'COP', rates)), 342154);
  assert.equal(L.convert(3194.44, 'COP', 'USD', rates), 1);
});

test('campo de monto: solo dígitos, máximo 12, con miles', () => {
  assert.equal(L.cleanDigits('$ 01.234abc'), '1234');
  assert.equal(L.cleanDigits('1234567890123456'), '123456789012');
  assert.equal(L.groupDigits('1400000'), '1.400.000');
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
  s.recurring.push({ id: 'r1', name: 'Préstamo N°3', cat: 'Obligaciones financieras', amount: 1050000, cur: 'COP', day: 30, alerts: [3, 0] });
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

test('datos de ejemplo: préstamos ficticios y uno vencido para mostrar la alerta', () => {
  const s = L.sampleState(TODAY);
  assert.equal(s.loans.length, 3);
  const p1 = s.bills.find((b) => b.name === 'Préstamo de ejemplo');
  assert.equal(p1.due, '2026-10-10');
  assert.equal(p1.paid, false);
  assert.equal(s.bills.find((b) => b.name === 'Hipoteca de ejemplo').paid, true);
  L.clearSamples(s);
  assert.equal(s.movements.length, 0);
  assert.equal(s.bills.length, 3);
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
    ['2026-10', new Date(2026, 9, 1), 'Sueldo Karo', '', 'COP', 6000000, 'Transferencia', '', 'Octubre'],
    ['2026-10', '2026-10-03', 'Gastos_Fijos', 'Internet', 'ARS', '-12.500,50', 'Efectivo', '', ''],
    ['2026-10', '2026-10-04', 'Algo raro', '', 'USD', '30', '', '', ''],
    ['', '', '', '', '', '', '', '', ''],
  ];
  const { movements, skipped } = L.parseMovementRows(rows, s);
  assert.equal(skipped, 1);
  assert.deepEqual(movements.map((m) => [m.date, m.type, m.cat, m.sub, m.cur, m.amount]), [
    ['2026-10-05', 'exp', 'Alimentación', 'Supermercado', 'COP', 450000],
    ['2026-10-01', 'inc', 'Sueldo Karo', '', 'COP', 6000000],
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
    { ID: 'M1', Fecha: '2026-10-01', Tipo: 'Ingreso', 'Categoría': 'Ingresos', 'Subcategoría': 'Sueldo Karo', Moneda: 'COP', Importe: 6000000, Entidad: 'Banco' },
    { ID: 'M2', Fecha: '2026-10-03', Tipo: 'Gasto', 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Luz', Moneda: 'COP', Importe: 187940, Comentarios: 'EPM' },
  ],
  'Facturas': [{ ID: 'F1', Nombre: 'Préstamo N°1', 'Categoría': 'Obligaciones_financieras', 'Subcategoría': 'Préstamo N°1', Moneda: 'ARS',
    Importe: 160000.5, Vence: '2026-10-10', Pagada: 'No', 'Préstamo ID': 'P1', 'Avisos (días antes)': '3,0', 'Evento de calendario': 'ev1' }],
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
    'Próxima cuota': 159500.2, 'Saldo actual': 1700000.6, 'Cuotas vencidas': 22 }],
  'Presupuesto': [
    { Mes: '2025-10-01', 'Categoría': 'Gastos_Fijos', Moneda: 'COP', Importe: 3000000 },
    { Mes: '2025-10-01', 'Categoría': 'Gastos_Fijos', Moneda: 'COP', Importe: 1000000 },
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
    ['Gastos fijos', 4000000, ['Luz', 'Celular']], ['Obligaciones financieras', 0, ['Préstamo N°1']]]);
  assert.deepEqual(s.incomeCats, ['Sueldo Alan', 'Sueldo Karo']);
  assert.deepEqual(s.methods, ['Efectivo', 'Cheques']);
  assert.deepEqual(s.movements.map((m) => [m.type, m.cat, m.sub]), [['inc', 'Sueldo Karo', ''], ['exp', 'Gastos fijos', 'Luz']]);
  assert.deepEqual(s.bills[0].alerts, [3, 0]);
  assert.equal(s.bills[0].loanId, 'P1');
  assert.deepEqual(s.recurring.map((r) => [r.id, r.alerts]), [['R1', [7]]]);
  assert.equal(s.receivables[0].collected, false);
  assert.deepEqual(s.loans[0], { id: 'P1', name: 'Préstamo N°1', cur: 'ARS', installment: 159500.2, day: 10,
    balance: 1700000.6, capital: 2500000, paidCount: 22, totalCount: 42, rate: 0 });
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
  assert.deepEqual(Object.keys(bill).sort(), ['Fecha de pago', 'ID', 'Pagada'], 'en filas existentes solo viaja lo que cambió');
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
    ['Karo', 0, 50000], ['Alan', 0, 32000], ['Sin asignar', 6000000, 187940 + 32000]]);
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

// ---------- Balance ----------
const conBalance = () => ({
  ...TABLES,
  'Movimientos': [
    { ID: 'M1', Fecha: '2026-09-02', Tipo: 'Ingreso', 'Categoría': 'Ingresos', 'Subcategoría': 'Sueldo Alan', Moneda: 'COP', Importe: 9000000 },
    { ID: 'M2', Fecha: '2026-09-05', Tipo: 'Gasto', 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Luz', Moneda: 'COP', Importe: 200000 },
    { ID: 'M3', Fecha: '2026-09-20', Tipo: 'Ingreso', 'Categoría': 'Ingresos', 'Subcategoría': 'Sueldo Karo', Moneda: 'COP', Importe: 1000000, Comentarios: 'Cobro Clínica' },
    { ID: 'A1', Fecha: '2026-09-21', Tipo: 'Ahorro', 'Categoría': 'Ahorro', 'Subcategoría': 'Viaje', 'Meta ID': 'G1', Moneda: 'COP', Importe: 500000 },
  ],
  'Facturas': [
    { ID: 'F1', Nombre: 'Préstamo N°1', 'Categoría': 'Obligaciones_financieras', Moneda: 'ARS', Importe: 161000, Vence: '2026-09-10', Pagada: 'Sí', 'Fecha de pago': '2026-09-10', 'Préstamo ID': 'P1' },
    { ID: 'F2', Nombre: 'Celular', 'Categoría': 'Gastos_Fijos', 'Subcategoría': 'Celular', Moneda: 'COP', Importe: 32000, Vence: '2026-09-29', Pagada: 'No' },
    { ID: 'F3', Nombre: 'Internet', 'Categoría': 'Gastos_Fijos', Moneda: 'COP', Importe: 100000, Vence: '2026-09-15', Pagada: 'Sí', 'Fecha de pago': '2026-09-14' },
  ],
  'Por cobrar': [
    { ID: 'C1', 'Fecha de emisión': '2026-08-25', Cliente: 'Clínica', Moneda: 'COP', Valor: 1000000, Vence: '2026-09-25', Estado: 'Cobrada', 'Fecha de cobro': '2026-09-20', 'Movimiento ID': 'M3' },
    { ID: 'C2', 'Fecha de emisión': '2026-09-10', Cliente: 'Estudio', Moneda: 'COP', Valor: 2000000, Vence: '2026-10-10', Estado: 'Pendiente' },
  ],
  'Cuotas': [
    { 'ID préstamo': 'P1', 'Préstamo': 'Préstamo N°1', 'N° cuota': 21, Vencimiento: '2026-09-10', Moneda: 'ARS', 'Amortización': 45000, 'Interés': 95000, Seguro: 21000, Diferidos: 0, Cuota: 161000, Saldo: 1745000 },
    { 'ID préstamo': 'P1', 'Préstamo': 'Préstamo N°1', 'N° cuota': 22, Vencimiento: '2026-10-10', Moneda: 'ARS', 'Amortización': 47000, 'Interés': 93000, Seguro: 20500, Diferidos: 0, Cuota: 160001, Saldo: 1700001 },
  ],
  'Cuentas y bienes': [
    { ID: 'B1', Nombre: 'Banco', Tipo: 'Cuenta bancaria', Moneda: 'COP', Activa: 'Sí' },
    { ID: 'B2', Nombre: 'Efectivo', Tipo: 'Efectivo', Moneda: 'COP' },
    { ID: 'B3', Nombre: 'CDT', Tipo: 'Inversión', Moneda: 'COP' },
    { ID: 'B4', Nombre: 'Auto', Tipo: 'Vehículo', Moneda: 'COP' },
    { ID: 'B5', Nombre: 'Vieja', Tipo: 'Cuenta bancaria', Moneda: 'COP', Activa: 'No' },
  ],
  'Saldos': [
    { 'Cuenta ID': 'B1', Mes: '2026-08-01', Saldo: 3000000 }, { 'Cuenta ID': 'B2', Mes: '2026-08-01', Saldo: 200000 },
    { 'Cuenta ID': 'B1', Mes: '2026-09-01', Saldo: 11000000 }, { 'Cuenta ID': 'B2', Mes: '2026-09-01', Saldo: 100000 },
    { 'Cuenta ID': 'B3', Mes: '2026-07-01', Saldo: 5000000 }, { 'Cuenta ID': 'B4', Mes: '2026-09-01', Saldo: 40000000 },
  ],
});
const ARS = 2.13845;

test('estado de resultados devengado: facturas del mes, por cobrar al emitir y solo intereses de préstamos', () => {
  const s = L.sheetToState(conBalance(), null, TODAY);
  const r = L.incomeStatement(s, '2026-09');
  assert.deepEqual(r.income.map((x) => [x.name, x.amount]), [['Sueldo Alan', 9000000], ['Facturas emitidas', 2000000]],
    'el cobro de C1 (emitida en agosto) no vuelve a contarse');
  assert.deepEqual(r.expense.map((x) => [x.name, x.amount]), [['Gastos fijos', 200000 + 32000 + 100000]], 'la cuota del préstamo no es gasto operativo');
  assert.equal(r.unpaid, 32000);
  assert.equal(r.financial.length, 1);
  assert.ok(Math.abs(r.financial[0].interest - 95000 * ARS) < 1e-6);
  assert.ok(Math.abs(r.financial[0].other - 21000 * ARS) < 1e-6);
  assert.ok(Math.abs(r.principal - 45000 * ARS) < 1e-6, 'la amortización se informa aparte');
  assert.ok(Math.abs(r.result - (11000000 - 332000 - (95000 + 21000) * ARS)) < 1e-6);
  assert.equal(L.incomeStatement(s, '2026-08').income[0].name, 'Facturas emitidas');
});

test('situación patrimonial al cierre: cuentas, por cobrar, préstamos y facturas impagas', () => {
  const s = L.sheetToState(conBalance(), null, TODAY);
  assert.deepEqual(s.accounts.map((a) => a.id), ['B1', 'B2', 'B3', 'B4']);
  const b = L.balanceSheet(s, '2026-09', TODAY);
  assert.equal(b.assets.cash, 11100000);
  assert.deepEqual(b.groups.invest.map((x) => [x.name, x.amount, x.stale]), [['CDT', 5000000, true]], 'usa el último saldo cargado');
  assert.equal(b.assets.asset, 40000000);
  assert.equal(b.assets.receivables, 2000000, 'C1 ya se cobró el 20/9; C2 sigue pendiente');
  assert.ok(Math.abs(b.totalLoans - 1745000 * ARS) < 1e-6, 'saldo después de la cuota de septiembre');
  assert.deepEqual(b.payables.map((x) => x.name), ['Celular']);
  assert.ok(Math.abs(b.netWorth - (11100000 + 5000000 + 2000000 + 40000000 - 1745000 * ARS - 32000)) < 1e-6);
  const ago = L.balanceSheet(s, '2026-08', TODAY);
  assert.equal(ago.assets.receivables, 1000000);
  assert.ok(Math.abs(ago.totalLoans - (1745000 + 45000) * ARS) < 1e-6, 'antes de la primera cuota de la ventana');
  assert.deepEqual(ago.missing.map((a) => a.id), ['B4']);
});

test('flujo de efectivo: variación de las cuentas contra lo registrado', () => {
  const s = L.sheetToState(conBalance(), null, TODAY);
  const f = L.cashFlow(s, '2026-09');
  assert.equal(f.complete, true);
  assert.equal(f.opening, 3200000);
  assert.equal(f.closing, 11100000);
  assert.equal(f.receipts, 10000000, 'cobros en caja, incluido el de la factura emitida');
  assert.equal(f.spending, 300000, 'gastos más facturas pagadas en el mes (no la impaga)');
  assert.ok(Math.abs(f.loanPayments - 161000 * ARS) < 1e-6);
  assert.ok(Math.abs(f.unexplained - (7900000 - (10000000 - 300000 - 161000 * ARS))) < 1e-6);
  assert.equal(L.cashFlow(s, '2026-10').complete, false);
});

test('cuentas y saldos vuelven a la planilla', () => {
  const s = L.sheetToState(conBalance(), null, TODAY);
  const before = L.stateToRows(s);
  assert.deepEqual(L.diffRows(before, L.stateToRows(s)), []);
  assert.deepEqual(before['Saldos'][2], { 'Cuenta ID': 'B1', Cuenta: 'Banco', Mes: '2026-09-01', Moneda: 'COP', Saldo: 11000000 });
  s.balances.push({ accountId: 'B1', month: '2026-10', amount: 9000000 });
  s.balances.find((b) => b.accountId === 'B2' && b.month === '2026-09').amount = 150000;
  assert.deepEqual(L.diffRows(before, L.stateToRows(s)).map((o) => [o.table, o.op, o.row['Cuenta ID'], o.row.Mes, o.row.Saldo]), [
    ['Saldos', 'upsert', 'B2', '2026-09-01', 150000], ['Saldos', 'upsert', 'B1', '2026-10-01', 9000000]]);
  s.accounts = s.accounts.filter((a) => a.id !== 'B4');
  const ops = L.diffRows(before, L.stateToRows(s));
  assert.deepEqual(ops.filter((o) => o.table === 'Cuentas y bienes').map((o) => [o.op, o.row.ID]), [['delete', 'B4']]);
  assert.equal(ops.filter((o) => o.table === 'Saldos' && o.op === 'delete').length, 0, 'los saldos de una cuenta quitada no se borran');
});

// ---------- Lectura de tickets ----------
test('ticket: el total no se confunde con el NIT, el teléfono ni el número de factura', () => {
  const t = [
    'Almacenes Éxito S.A.',
    'NIT 890.900.608-9',
    'Tel 604 3396565',
    'Factura electrónica de venta N° 4567891',
    'Fecha: 11/10/2026 14:32',
    'LECHE ENTERA 1L        4.500',
    'PAN TAJADO             6.200',
    'SUBTOTAL              10.700',
    'IVA 19%                 1.900',
    'TOTAL                 $ 12.600',
    'EFECTIVO              20.000',
    'CAMBIO                 7.400',
  ].join('\n');
  assert.deepEqual(L.parseReceipt(t, 'ticket', '2026-10-15'),
    { merchant: 'Almacenes Éxito S.A.', total: 12600, date: '2026-10-11', cat: 'Alimentación', sub: 'Supermercado' });
});

test('ticket: total en la línea siguiente y errores típicos del lector (O por 0)', () => {
  const t = 'DROGUERIA CRUZ VERDE\nNIT. 800149695\nTOTAL A PAGAR\n$ 3O.4OO\nGracias por su compra\n15-oct-2026';
  const r = L.parseReceipt(t, 'ticket', '2026-10-15');
  assert.equal(r.total, 30400);
  assert.equal(r.date, '2026-10-15');
  assert.equal(r.cat, 'Salud');
});

test('ticket sin la palabra total: usa el monto con formato de plata, nunca un código', () => {
  const t = 'Panadería La Espiga\nCod 7702004003508\nCroissant x2   9.800\nCafé            4.500\nPagado con tarjeta  14.300';
  assert.equal(L.parseReceipt(t, 'ticket', '2026-10-15').total, 14300);
  assert.equal(L.parseReceipt('hola\n12345678901\nabc', 'ticket', '2026-10-15').total, 0, 'sin montos claros no inventa uno');
});

test('factura de servicios: total a pagar y fecha de «pague hasta»', () => {
  const t = [
    'EPM Empresas Públicas de Medellín E.S.P.',
    'Contrato 12345678',
    'Fecha de expedición 02/10/2026',
    'Periodo facturado 01 sep 2026 - 30 sep 2026',
    'Valor del consumo 187.940',
    'Total a pagar',
    '$ 215.380',
    'Pague hasta',
    '20 de octubre de 2026',
  ].join('\n');
  const r = L.parseReceipt(t, 'factura', '2026-10-15');
  assert.equal(r.total, 215380);
  assert.equal(r.date, '2026-10-20');
  assert.equal(r.cat, 'Gastos fijos');
  assert.equal(r.merchant, 'EPM Empresas Públicas de Medellín E.S.P.');
});

test('fechas fuera de rango o imposibles se ignoran', () => {
  assert.equal(L.parseReceipt('Tienda\nFecha 45/13/2026\nTOTAL 5.000', 'ticket', '2026-10-15').date, null);
  assert.equal(L.parseReceipt('Tienda\n01/01/1999\nTOTAL 5.000', 'ticket', '2026-10-15').date, null);
});

// ---------- Plan por cobro, patrimonio y deudas ----------
test('plan por cobro: tramos entre quincenas con facturas, gastos variables y lo que queda libre', () => {
  const s = emptyState();
  s.incomePlan = [
    { id: 'I1', name: 'Sueldo Alan', cat: 'Sueldo Alan', cur: 'COP', amount: 4000000, days: [15, 30] },
    { id: 'I2', name: 'Sueldo Karo', cat: 'Sueldo Karo', cur: 'COP', amount: 6000000, days: [30] },
  ];
  s.bills = [
    { id: 'b1', name: 'Alquiler', cat: 'Vivienda', amount: 1600000, cur: 'COP', due: '2026-10-16', paid: false },
    { id: 'b2', name: 'Luz', cat: 'Gastos fijos', amount: 200000, cur: 'COP', due: '2026-10-13', paid: true },
    { id: 'b3', name: 'Celular', cat: 'Gastos fijos', amount: 32000, cur: 'COP', due: '2026-10-14', paid: false },
  ];
  // 900.000 de gasto variable en los últimos 90 días = 10.000 por día.
  s.movements = [{ id: 'g', date: '2026-10-01', type: 'exp', cat: 'Ocio', sub: '', note: '', amount: 900000, cur: 'COP', method: '' },
    { id: 'i', date: '2026-09-30', type: 'inc', cat: 'Sueldo Karo', sub: '', note: '', amount: 6000000, cur: 'COP', method: '' }];
  const p = L.paycheckPlan(s, TODAY);
  assert.equal(p.inferred, false);
  assert.deepEqual(p.periods.map((x) => [x.start, x.end, x.income]), [
    ['2026-09-30', '2026-10-14', 10000000], ['2026-10-15', '2026-10-29', 4000000], ['2026-10-30', '2026-11-14', 10000000],
    ['2026-11-15', '2026-11-29', 4000000], ['2026-11-30', '2026-11-30', 10000000]]);
  const cur = p.periods[0];
  assert.equal(cur.current, true);
  assert.deepEqual(cur.incomes.map((e) => [e.name, e.received]), [['Sueldo Alan', false], ['Sueldo Karo', true]]);
  assert.deepEqual(cur.bills.map((b) => [b.name, b.paid]), [['Luz', true], ['Celular', false]]);
  assert.equal(cur.toPay, 32000, 'solo lo que falta pagar');
  assert.equal(cur.days, 2, 'del 13 al 14: lo de hoy ya está en lo gastado');
  assert.equal(cur.variable, 20000);
  assert.equal(cur.spent, 900000, 'lo gastado desde el cobro');
  assert.equal(cur.free, 10000000 - 900000 - 32000 - 20000);
  assert.equal(p.periods[1].toPay, 1600000);
  assert.equal(p.periods[1].cumulative, cur.free + p.periods[1].free);
});

test('plan por cobro: sin cobros configurados los estima con los últimos 3 meses', () => {
  const s = emptyState();
  const inc = (date, cat, amount) => ({ id: date + cat, date, type: 'inc', cat, sub: '', note: '', amount, cur: 'COP', method: '' });
  s.movements = [
    inc('2026-07-15', 'Sueldo Alan', 4000000), inc('2026-07-30', 'Sueldo Alan', 4100000),
    inc('2026-08-14', 'Sueldo Alan', 4000000), inc('2026-08-29', 'Sueldo Alan', 4000000),
    inc('2026-09-15', 'Sueldo Alan', 4000000), inc('2026-09-30', 'Sueldo Alan', 4000000),
    inc('2026-08-05', 'Sueldo Karo', 7000000), inc('2026-09-04', 'Sueldo Karo', 7400000),
    inc('2026-09-20', 'Bono', 900000),
  ];
  assert.deepEqual(L.inferIncomePlan(s, TODAY).map((p) => [p.cat, p.days, p.amount]),
    [['Sueldo Alan', [15], 4000000], ['Sueldo Alan', [30], 4000000], ['Sueldo Karo', [5], 7200000]], 'el bono de un solo mes no cuenta');
  const p = L.paycheckPlan(s, TODAY);
  assert.equal(p.inferred, true);
  assert.equal(p.periods[0].start, '2026-10-05');
  assert.deepEqual(L.parseDays('15 y 30'), [15, 30]);
});

test('evolución del patrimonio: un punto por mes, marcando los meses sin saldos', () => {
  const s = L.sheetToState(conBalance(), null, TODAY);
  const series = L.netWorthSeries(s, '2026-09', 3, TODAY);
  assert.deepEqual(series.map((x) => [x.key, x.hasData]), [['2026-07', true], ['2026-08', true], ['2026-09', true]]);
  assert.equal(series[2].net, L.balanceSheet(s, '2026-09', TODAY).netWorth);
  assert.equal(L.netWorthSeries(s, '2026-06', 1, TODAY)[0].hasData, false);
});

test('plan de deudas: el pago extra adelanta el fin y ahorra intereses; avalancha va por la tasa más alta', () => {
  const s = emptyState();
  s.loans = [
    { id: 'A', name: 'Tarjeta', cur: 'COP', installment: 300000, balance: 3000000, rate: 0.30 },
    { id: 'B', name: 'Auto', cur: 'COP', installment: 500000, balance: 10000000, rate: 0.12 },
    { id: 'C', name: 'Crédito chico', cur: 'COP', installment: 100000, balance: 800000, rate: 18 },
  ];
  const base = L.debtPlan(s, TODAY, { extra: 0 });
  assert.equal(base.saved, 0);
  assert.deepEqual(base.endless, []);
  const av = L.debtPlan(s, TODAY, { extra: 500000, strategy: 'avalanche' });
  assert.deepEqual(av.order, ['A', 'C', 'B']);
  assert.equal(av.loans.find((l) => l.id === 'C').rate, 0.18, 'una TNA en porcentaje se pasa a decimal');
  assert.ok(av.saved > 0);
  assert.ok(av.planEnd < av.baseEnd);
  assert.ok(av.monthsSaved > 0);
  const sb = L.debtPlan(s, TODAY, { extra: 500000, strategy: 'snowball' });
  assert.deepEqual(sb.order, ['C', 'A', 'B']);
  assert.ok(sb.loans.find((l) => l.id === 'C').planEnd <= av.loans.find((l) => l.id === 'C').planEnd, 'bola de nieve cierra antes la más chica');
  assert.ok(av.planInterest <= sb.planInterest + 1, 'avalancha paga menos interés');
  s.loans.push({ id: 'D', name: 'Capitaliza', cur: 'COP', installment: 0, balance: 1000000, rate: 0.17 });
  const d = L.debtPlan(s, TODAY, { extra: 0 });
  assert.equal(d.loans.find((l) => l.id === 'D').baseEnd, null, 'con cuota 0 no se termina nunca');
  assert.equal(d.baseEnd, null);
  assert.deepEqual([d.baseInterest, d.saved, d.endless], [null, null, ['Capitaliza']], 'sin fin no hay total de intereses');
  assert.ok(L.debtPlan(s, TODAY, { extra: 300000 }).loans.find((l) => l.id === 'D').planEnd, 'con extra sí');
});

// ---------- Auditoría ----------
test('auditoría: plan por cobro descuenta lo ya gastado e incluye facturas vencidas', () => {
  const s = emptyState();
  s.incomePlan = [{ id: 'I', name: 'Sueldo', cat: 'Sueldo Alan', cur: 'COP', amount: 10000000, days: [1] }];
  s.movements = [{ id: 'g', date: '2026-10-05', type: 'exp', cat: 'Ocio', sub: '', note: '', amount: 9000000, cur: 'COP', method: '' }];
  s.bills = [{ id: 'r', name: 'Arriendo', cat: 'Vivienda', amount: 2800000, cur: 'COP', due: '2026-09-28', paid: false }];
  const cur = L.paycheckPlan(s, '2026-10-20').periods[0];
  assert.equal(cur.spent, 9000000);
  assert.equal(cur.toPay, 2800000);
  assert.ok(cur.bills[0].overdue);
  assert.ok(cur.free < 0);
});

test('auditoría: presupuesto de cada mes, préstamos sin tabla y antes de existir', () => {
  const t = { ...TABLES, 'Presupuesto': [
    { Mes: '2026-10-01', 'Categoría': 'Gastos_Fijos', Moneda: 'COP', Importe: 1000000 },
    { Mes: '2026-11-01', 'Categoría': 'Gastos_Fijos', Moneda: 'COP', Importe: 3000000 }] };
  const s = L.sheetToState(t, null, '2026-11-01');
  assert.equal(L.categoryStats(s, '2026-10', '2026-11-01')[0].limit, 1000000);
  assert.equal(L.categoryStats(s, '2026-11', '2026-11-01')[0].limit, 3000000);
  // Cuota de préstamo sin tabla: interés estimado con la tasa y el saldo.
  const r = L.incomeStatement(s, '2026-10');
  assert.equal(r.financial.length, 1);
  assert.ok(r.financial[0].estimated && r.financial[0].interest > 0 && r.financial[0].interest < L.toCOP(s.bills[0], s.settings.rates) + 1);
  // Préstamo cuya primera cuota es más adelante: antes no hay deuda.
  s.schedule = [{ loanId: 'P1', n: 1, due: '2027-01-10', cur: 'COP', principal: 100, interest: 10, insurance: 0, deferred: 0, balance: 900 }];
  assert.equal(L.loanBalanceAt(s, s.loans[0], '2026-12', '2026-11-01'), 0);
});

test('auditoría: CSV sin fórmulas y alerta de cobro sin fecha', () => {
  const s = emptyState();
  s.movements = [{ id: 'a', date: '2026-10-01', type: 'exp', cat: 'Ocio', sub: '', note: '=1+1', amount: 5, cur: 'COP', method: '' }];
  assert.match(L.toCSV(s), /"'=1\+1"/);
  s.receivables = [{ id: 'c', client: 'X', due: '', amount: 1, cur: 'COP', collected: false }];
  assert.ok(!L.buildAlerts(s, TODAY).some((a) => /NaN/.test(a.sub)));
});

test('auditoría: plan de deudas sin extra no reparte sobrantes y lee TNA mayores a 100 %', () => {
  const s = emptyState();
  s.loans = [{ id: 'A', name: 'A', cur: 'COP', installment: 1000000, balance: 1500000, rate: 0 },
    { id: 'B', name: 'B', cur: 'COP', installment: 100000, balance: 5000000, rate: 0.12 }];
  const solo = { ...s, loans: [s.loans[1]] };
  assert.equal(L.debtPlan(s, TODAY).loans[1].baseEnd, L.debtPlan(solo, TODAY).loans[0].baseEnd);
  s.loans = [{ id: 'C', name: 'C', cur: 'COP', installment: 100000, balance: 1000000, rate: 1.2 }];
  assert.equal(L.debtPlan(s, TODAY).loans[0].rate, 1.2);
});

// ---------- Cobros parciales ----------
test('facturas emitidas: cobros parciales, retención y estado en la planilla', () => {
  const s = L.sheetToState({ ...TABLES,
    'Por cobrar': [{ ID: 'C1', 'Fecha de emisión': '2026-09-01', Cliente: 'Clínica', Moneda: 'COP', Valor: 1000000, Vence: '2026-10-01', Estado: 'Pendiente' }],
    'Movimientos': [...TABLES['Movimientos'],
      { ID: 'P1', Fecha: '2026-09-20', Tipo: 'Ingreso', 'Categoría': 'Ingresos', 'Subcategoría': 'Sueldo Karo', Moneda: 'COP', Importe: 400000, 'Por cobrar ID': 'C1' }],
  }, null, TODAY);
  const r = s.receivables[0];
  let info = L.receivableInfo(s, r);
  assert.deepEqual([info.status, info.collected, info.pending], ['partial', 400000, 600000]);
  assert.equal(L.stateToRows(s)['Por cobrar'][0]['Estado'], 'Parcial');
  assert.equal(L.stateToRows(s)['Movimientos'].find((m) => m.ID === 'P1')['Por cobrar ID'], 'C1');
  // Balance: al cierre de septiembre falta cobrar 600.000; en agosto la factura no existía.
  assert.equal(L.balanceSheet(s, '2026-09', TODAY).assets.receivables, 600000);
  // El cobro parcial no se suma otra vez como ingreso (ya contó al emitirse).
  assert.deepEqual(L.incomeStatement(s, '2026-09').income.map((x) => x.name), ['Facturas emitidas']);
  assert.match(L.buildAlerts(s, TODAY).find((a) => a.kind === 'recv').sub, /falta \$ 600\.000/);
  // Segundo cobro neto de retención: se cierra como cobrada aunque falten 110.000.
  s.movements.push({ id: 'P2', date: '2026-10-05', type: 'inc', cat: 'Sueldo Karo', sub: '', note: '', amount: 490000, cur: 'COP', method: '', receivableId: 'C1' });
  r.collected = true; r.collectedAt = '2026-10-05';
  info = L.receivableInfo(s, r);
  assert.deepEqual([info.status, info.collected, info.pending, info.writtenOff], ['done', 890000, 0, 110000]);
  assert.equal(L.stateToRows(s)['Por cobrar'][0]['Estado'], 'Cobrada');
  assert.equal(L.balanceSheet(s, '2026-10', TODAY).assets.receivables, 0);
  assert.equal(L.balanceSheet(s, '2026-09', TODAY).assets.receivables, 600000, 'el pasado no cambia');
  assert.ok(!L.buildAlerts(s, TODAY).some((a) => a.kind === 'recv'));
  // Un cobro de antes de esta versión (Movimiento ID) también cuenta.
  const old = { id: 'C2', client: 'X', issued: '2026-09-01', due: '2026-09-30', amount: 100, cur: 'COP', collected: true, incomeId: 'M1' };
  assert.equal(L.receivableInfo(s, old).payments[0].id, 'M1');
  // Marcada «Cobrada» en la planilla sin cobros vinculados: cobrada completa, no «sin cobrar».
  const legacy = { id: 'C3', client: 'Y', issued: '2026-08-01', due: '2026-08-30', amount: 500, cur: 'COP', collected: true, collectedAt: '2026-09-10', incomeId: null };
  assert.deepEqual([L.receivableInfo(s, legacy).collected, L.receivableInfo(s, legacy).writtenOff], [500, 0]);
  s.receivables.push(legacy);
  assert.equal(L.balanceSheet(s, '2026-08', TODAY).receivables.find((x) => x.name === 'Y').amount, 500, 'antes de cobrarla seguía pendiente');
});
