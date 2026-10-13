const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../charts.js');

const fmt = (v) => String(Math.round(v));

test('niceScale arma un máximo redondo', () => {
  assert.deepEqual(C.niceScale(17400000), { max: 20000000, step: 5000000, ticks: [0, 5000000, 10000000, 15000000, 20000000] });
  assert.equal(C.niceScale(0).max, 1);
});

test('columnas y barras: 4px redondeados y nada si el valor es 0', () => {
  assert.equal(C.colPath(0, 0, 10, 0), '');
  assert.match(C.colPath(0, 10, 10, 50), /^M0,60V14Q0,10 4,10/);
  assert.match(C.barPath(0, 0, 50, 12), /H46Q50,0 50,4/);
});

test('trend: una zona de hover por mes, con los valores en el tooltip', () => {
  const months = [
    { key: '2026-09', label: 'sep', title: 'Septiembre 2026', income: 0, expense: 0, hasData: false },
    { key: '2026-10', label: 'oct', title: 'Octubre 2026', income: 100, expense: 40, hasData: true },
  ];
  const { svg } = C.trend({ months, selected: '2026-10', width: 400, fmtAxis: fmt, fmtVal: fmt });
  assert.equal((svg.match(/class="viz-hit"/g) || []).length, 2);
  assert.equal((svg.match(/class="viz-inc"/g) || []).length, 1);
  assert.match(svg, /data-month="2026-10"/);
  assert.match(svg, /&quot;Ahorro&quot;,&quot;60&quot;/);
});

test('cumulative: datos de hover para cada día y proyección solo en el mes actual', () => {
  const base = { dim: 30, cumulative: Array.from({ length: 30 }, (_, i) => i * 10), lastDay: 12, budget: 600, projection: 700,
    width: 500, fmtAxis: fmt, fmtVal: fmt, dayLabel: (d) => String(d) };
  const cur = C.cumulative({ ...base, showProjection: true });
  assert.equal(cur.hover.length, 30);
  assert.match(cur.svg, /class="viz-proj"/);
  assert.deepEqual(cur.hover[20].rows.map((r) => r[0]), ['Proyección', 'Presupuesto al ritmo']);
  assert.doesNotMatch(C.cumulative({ ...base, lastDay: 30, showProjection: false }).svg, /viz-proj/);
});

test('categories: marca de presupuesto y aviso de excedido; nombres escapados', () => {
  const { svg } = C.categories({ rows: [{ name: 'Ocio <b>', spent: 120, limit: 100 }, { name: 'Salud', spent: 10, limit: 0 }],
    width: 600, fmtVal: fmt, statusText: 'excedido' });
  assert.equal((svg.match(/viz-tickmark/g) || []).length, 1);
  assert.match(svg, /120 · 120%<tspan class="viz-bad"> ▲ excedido/);
  assert.match(svg, /10 · sin límite/);
  assert.match(svg, /Ocio &lt;b&gt;/);
  assert.doesNotMatch(svg, /<b>/);
});
