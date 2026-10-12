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
