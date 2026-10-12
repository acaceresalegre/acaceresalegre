const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib.js');

test('summarizeMonth suma ingresos y gastos del mes', () => {
  const tx = [
    { type: 'income', amount: 1000, category: 'Sueldo', date: '2026-10-01' },
    { type: 'expense', amount: 200, category: 'Supermercado', date: '2026-10-05' },
    { type: 'expense', amount: 50.5, category: 'Supermercado', date: '2026-10-20' },
    { type: 'expense', amount: 999, category: 'Ocio', date: '2026-09-30' },
  ];
  const s = L.summarizeMonth(tx, '2026-10');
  assert.equal(s.income, 1000);
  assert.equal(s.expense, 250.5);
  assert.equal(s.balance, 749.5);
  assert.deepEqual(s.byCategory, { Supermercado: 250.5 });
});

test('budgetStatus calcula porcentaje y restante', () => {
  const [b] = L.budgetStatus({ Ocio: 100, Salud: 0 }, { Ocio: 120 });
  assert.deepEqual(b, { category: 'Ocio', limit: 100, spent: 120, remaining: -20, pct: 120 });
});

test('nextDueDate respeta fin de mes y años', () => {
  assert.equal(L.nextDueDate('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(L.nextDueDate('2026-12-15', 'monthly'), '2027-01-15');
  assert.equal(L.nextDueDate('2026-12-29', 'weekly'), '2027-01-05');
  assert.equal(L.nextDueDate('2026-02-28', 'daily'), '2026-03-01');
  assert.equal(L.nextDueDate('2026-02-28', 'none'), null);
});

test('monthGrid arranca en lunes y tiene 42 días', () => {
  const g = L.monthGrid('2026-10'); // 1/10/2026 es jueves
  assert.equal(g.length, 42);
  assert.equal(g[0].iso, '2026-09-28');
  assert.equal(g[3].iso, '2026-10-01');
  assert.equal(g.filter((d) => d.inMonth).length, 31);
});

test('completeTask crea la próxima ocurrencia en tareas repetitivas', () => {
  const tasks = [{ id: 'a', title: 'Basura', due: '2026-10-12', repeat: 'weekly', done: false }];
  const out = L.completeTask(tasks, 'a', '2026-10-12');
  assert.equal(out.length, 2);
  assert.equal(out[0].done, true);
  assert.equal(out[1].done, false);
  assert.equal(out[1].due, '2026-10-19');
  assert.notEqual(out[1].id, 'a');
  assert.equal(L.completeTask([{ id: 'b', repeat: 'none' }], 'b', '2026-10-12').length, 1);
});

test('sortTasks: pendientes primero, por fecha y prioridad', () => {
  const sorted = L.sortTasks([
    { id: 1, done: true, due: '2026-01-01' },
    { id: 2, done: false, due: '' },
    { id: 3, done: false, due: '2026-10-12', priority: 'low' },
    { id: 4, done: false, due: '2026-10-12', priority: 'high' },
  ]);
  assert.deepEqual(sorted.map((t) => t.id), [4, 3, 2, 1]);
});

test('agendaByDate junta eventos y tareas pendientes', () => {
  const map = L.agendaByDate({
    events: [{ id: 'e', title: 'Médico', date: '2026-10-12', time: '10:00' }],
    tasks: [
      { id: 't', title: 'Pagar luz', due: '2026-10-12', done: false },
      { id: 'x', title: 'Hecha', due: '2026-10-12', done: true },
    ],
  });
  assert.deepEqual(map['2026-10-12'].map((i) => i.kind), ['event', 'task']);
});

test('normalizeState tolera datos incompletos o inválidos', () => {
  assert.deepEqual(L.normalizeState(null), L.defaultState());
  const s = L.normalizeState({ tasks: 'nope', members: [] });
  assert.deepEqual(s.tasks, []);
  assert.deepEqual(s.members, ['Yo']);
});
