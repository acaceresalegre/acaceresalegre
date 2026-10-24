// Reglas de negocio de Cuentas Casa (sin DOM). Se usa en el navegador y en los tests de Node.
(function (root) {
  'use strict';

  // ---------- Fechas ----------
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // 'YYYY-MM-DD' como fecha local (evita corrimientos por zona horaria).
  function parseISO(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  const todayISO = () => toISO(new Date());
  const monthKey = (iso) => iso.slice(0, 7);
  const dayOf = (iso) => Number(iso.slice(8, 10));

  function addMonths(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  function daysInMonth(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }

  // Fecha del día `day` en el mes `key`, ajustada al último día si no existe (31 -> 30).
  const dateInMonth = (key, day) => `${key}-${pad(Math.min(day, daysInMonth(key)))}`;

  const daysBetween = (from, to) => Math.round((parseISO(to) - parseISO(from)) / 86400000);

  const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const DOW_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MON = MONTHS.map((m) => m.slice(0, 3));

  const monthName = (key) => MONTHS[Number(key.slice(5, 7)) - 1];
  const monthLabel = (key) => `${monthName(key)} ${key.slice(0, 4)}`;
  const shortDate = (iso) => `${DOW[parseISO(iso).getDay()]} ${dayOf(iso)} ${MON[Number(iso.slice(5, 7)) - 1]}`;
  const longDate = (iso) => `${DOW_LONG[parseISO(iso).getDay()]} ${dayOf(iso)} de ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ---------- Monedas ----------
  const CURRENCIES = ['COP', 'ARS', 'USD'];
  const PREFIX = { COP: '$', ARS: 'AR$', USD: 'US$' };

  // rates: valor de 1 unidad de cada moneda expresado en COP.
  function convert(amount, from, to, rates) {
    if (from === to) return amount;
    return (amount * (rates[from] || 1)) / (rates[to] || 1);
  }

  function formatMoney(amount, cur) {
    const dec = cur === 'USD' ? 2 : 0;
    const n = new Intl.NumberFormat('es-CO', {
      minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: 'always',
    }).format(Math.abs(amount || 0));
    return `${amount < 0 ? '−' : ''}${PREFIX[cur] || '$'} ${n}`;
  }

  // Formato corto para resúmenes: "$ 113,4 M", "$ 450 mil".
  function formatShort(amount, cur) {
    const abs = Math.abs(amount || 0);
    const sign = amount < 0 ? '−' : '';
    const p = PREFIX[cur] || '$';
    const fmt = (v, d) => new Intl.NumberFormat('es-CO', { maximumFractionDigits: d }).format(v);
    if (abs >= 1e6) return `${sign}${p} ${fmt(abs / 1e6, 1)} M`;
    if (abs >= 1e4) return `${sign}${p} ${fmt(abs / 1e3, 0)} mil`;
    return formatMoney(amount, cur);
  }

  // Campo de monto: solo dígitos (máx. 12) con separador de miles.
  function cleanDigits(s) {
    return String(s || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 12);
  }
  const groupDigits = (digits) => (digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '');

  // ---------- Facturas ----------
  // Instancias del mes para cada factura recurrente (y cuota de préstamo) que falte.
  function ensureRecurring(state, key) {
    let added = 0;
    for (const r of state.recurring) {
      if (r.startMonth && key < r.startMonth) continue;
      if (state.bills.some((b) => b.templateId === r.id && monthKey(b.due) === key)) continue;
      state.bills.push({
        id: uid(), templateId: r.id, name: r.name, cat: r.cat, sub: r.sub || '',
        amount: r.amount, cur: r.cur, due: dateInMonth(key, r.day), paid: false,
        method: r.method || '', loanId: r.loanId || null, alerts: [...(r.alerts || [3, 0])],
      });
      added++;
    }
    return added;
  }

  // Estado de vencimiento de una factura respecto de hoy.
  function dueInfo(bill, today) {
    const days = daysBetween(today, bill.due);
    if (bill.paid) {
      return { state: 'paid', tone: 'green', days, label: `Pagada${bill.method ? ' · ' + bill.method : ''}` };
    }
    if (days < 0) {
      return { state: 'overdue', tone: 'red', days, label: days === -1 ? 'Venció ayer' : `Venció hace ${-days} días` };
    }
    if (days === 0) return { state: 'today', tone: 'red', days, label: 'Vence hoy' };
    if (days === 1) return { state: 'tomorrow', tone: 'amber', days, label: 'Vence mañana' };
    const maxAlert = Math.max(0, ...(bill.alerts && bill.alerts.length ? bill.alerts : [3, 0]));
    const label = `Vence el ${shortDate(bill.due)} · en ${days} días`;
    return { state: days <= maxAlert ? 'soon' : 'later', tone: days <= maxAlert ? 'amber' : 'neutral', days, label };
  }

  const isUrgent = (info) => ['overdue', 'today', 'tomorrow', 'soon'].includes(info.state);

  // Agrupa facturas para la lista de Vencimientos.
  function groupBills(bills, today) {
    const groups = { overdue: [], week: [], later: [], paid: [] };
    for (const b of bills) {
      const info = dueInfo(b, today);
      if (info.state === 'paid') groups.paid.push(b);
      else if (info.days < 0) groups.overdue.push(b);
      else if (info.days <= 7) groups.week.push(b);
      else groups.later.push(b);
    }
    const byDue = (a, b) => a.due.localeCompare(b.due);
    Object.values(groups).forEach((g) => g.sort(byDue));
    return groups;
  }

  // Color del punto de un día del calendario.
  function dayDot(bills, today) {
    if (!bills.length) return null;
    if (bills.every((b) => b.paid)) return 'green';
    if (bills.some((b) => !b.paid && b.due < today)) return 'red';
    return 'amber';
  }

  // Celdas del calendario (semana de lunes a domingo, con celdas vacías al inicio).
  function calendarCells(key) {
    const [y, m] = key.split('-').map(Number);
    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
    const cells = Array(lead).fill(null);
    for (let d = 1; d <= daysInMonth(key); d++) cells.push(`${key}-${pad(d)}`);
    return cells;
  }

  // ---------- Presupuesto ----------
  const toCOP = (item, rates) => convert(Number(item.amount) || 0, item.cur || 'COP', 'COP', rates);

  // Día "transcurrido" del mes para proyecciones: hoy si es el mes actual, todo el mes si ya pasó.
  function elapsedDays(key, today) {
    const cur = monthKey(today);
    if (key < cur) return daysInMonth(key);
    if (key > cur) return 0;
    return dayOf(today);
  }

  function categoryStats(state, key, today) {
    const rates = state.settings.rates;
    const threshold = state.settings.threshold;
    const dim = daysInMonth(key);
    const elapsed = elapsedDays(key, today);
    // Con la planilla, cada mes usa su propio presupuesto (o el del mismo mes del año anterior).
    const monthLimits = state.budgetRows && state.budgetRows.length ? budgetLimits(state.budgetRows, key, rates) : null;
    return state.categories.map((c) => {
      const movs = state.movements.filter((m) => m.type === 'exp' && m.cat === c.name && monthKey(m.date) === key);
      const bills = state.bills.filter((b) => b.cat === c.name && monthKey(b.due) === key);
      const variable = movs.reduce((s, m) => s + toCOP(m, rates), 0);
      const paidBills = bills.filter((b) => b.paid).reduce((s, b) => s + toCOP(b, rates), 0);
      const allBills = bills.reduce((s, b) => s + toCOP(b, rates), 0);
      const spent = variable + paidBills;
      const projection = (elapsed ? (variable / elapsed) * dim : 0) + allBills;
      const limit = monthLimits ? Math.round(monthLimits[c.group] || 0) : Number(c.limit) || 0;
      const pct = limit ? (spent / limit) * 100 : 0;
      const projPct = limit ? (projection / limit) * 100 : 0;
      let status = 'ok';
      if (limit) {
        if (pct >= 100) status = 'over';
        else if (pct >= threshold) status = 'near';
        else if (projPct > 102) status = 'proj';
      }
      return { name: c.name, limit, spent, variable, pct, projection, projPct, status, movs, bills };
    });
  }

  function monthSummary(state, key) {
    const rates = state.settings.rates;
    const inMonth = (m) => monthKey(m.date) === key;
    const income = state.movements.filter((m) => m.type === 'inc' && inMonth(m)).reduce((s, m) => s + toCOP(m, rates), 0);
    const variable = state.movements.filter((m) => m.type === 'exp' && inMonth(m)).reduce((s, m) => s + toCOP(m, rates), 0);
    const bills = state.bills.filter((b) => monthKey(b.due) === key);
    const paid = bills.filter((b) => b.paid).reduce((s, b) => s + toCOP(b, rates), 0);
    const pending = bills.filter((b) => !b.paid).reduce((s, b) => s + toCOP(b, rates), 0);
    const saved = state.movements.filter((m) => m.type === 'save' && inMonth(m)).reduce((s, m) => s + toCOP(m, rates), 0);
    const expense = variable + paid;
    // Lo aportado a metas no es gasto (sigue siendo ahorro), pero ya no está disponible para gastar.
    return { income, expense, pending, saved, balance: income - expense, remaining: income - expense - pending - saved, hasData: income + expense > 0 };
  }

  // Ingresos y gastos (COP) del mes por persona, solo movimientos (las facturas no tienen persona).
  function spendByPerson(state, key) {
    const rates = state.settings.rates;
    const map = new Map();
    for (const m of state.movements) {
      if (monthKey(m.date) !== key || (m.type !== 'inc' && m.type !== 'exp')) continue;
      const name = personOf(m) || 'Sin asignar';
      const r = map.get(name) || { name, income: 0, expense: 0 };
      r[m.type === 'inc' ? 'income' : 'expense'] += toCOP(m, rates);
      map.set(name, r);
    }
    return [...map.values()].sort((a, b) => (a.name === 'Sin asignar') - (b.name === 'Sin asignar') || b.expense - a.expense);
  }

  // ---------- Dashboard ----------
  // Ingresos y gastos (COP) de los n meses que terminan en endKey.
  function monthSeries(state, endKey, n = 12) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const key = addMonths(endKey, -i);
      const s = monthSummary(state, key);
      out.push({ key, income: s.income, expense: s.expense, hasData: s.hasData });
    }
    return out;
  }

  // Gasto acumulado por día del mes (movimientos + facturas pagadas), presupuesto y proyección de cierre.
  function dailySpend(state, key, today) {
    const rates = state.settings.rates;
    const dim = daysInMonth(key);
    const daily = Array(dim).fill(0);
    let variable = 0;
    for (const m of state.movements) {
      if (m.type !== 'exp' || monthKey(m.date) !== key) continue;
      const v = toCOP(m, rates);
      daily[dayOf(m.date) - 1] += v;
      variable += v;
    }
    let billsTotal = 0;
    for (const b of state.bills) {
      if (monthKey(b.due) !== key) continue;
      const v = toCOP(b, rates);
      billsTotal += v;
      if (b.paid) daily[dayOf(b.due) - 1] += v;
    }
    const cumulative = [];
    daily.reduce((acc, v, i) => (cumulative[i] = acc + v), 0);
    const elapsed = elapsedDays(key, today);
    const projection = (elapsed ? (variable / elapsed) * dim : 0) + billsTotal;
    const budget = state.categories.reduce((s, c) => s + (Number(c.limit) || 0), 0);
    return { dim, daily, cumulative, elapsed, budget, projection };
  }

  // Movimientos filtrados y ordenados para la tabla completa.
  function filterMovements(state, f, today) {
    const q = norm(f.q || '');
    const key = f.month || monthKey(today);
    const from = { month: key, '3m': addMonths(key, -2), year: key.slice(0, 4) + '-01', all: '0000-00' }[f.period || 'month'];
    const to = f.period === 'all' ? '9999-99' : key;
    const list = state.movements.filter((m) => {
      const k = monthKey(m.date);
      if (k < from || k > to) return false;
      if (f.type && f.type !== 'all' && m.type !== f.type) return false;
      if (f.cat && m.cat !== f.cat) return false;
      if (f.method && m.method !== f.method) return false;
      if (f.person && personOf(m) !== (f.person === '-' ? '' : f.person)) return false; // '-' = sin asignar
      if (q && !norm([m.note, m.cat, m.sub, m.method, personOf(m)].join(' ')).includes(q)) return false;
      return true;
    });
    const dir = f.dir === 'asc' ? 1 : -1;
    const rates = state.settings.rates;
    list.sort((a, b) => {
      const d = f.sort === 'amount' ? toCOP(a, rates) - toCOP(b, rates) : a.date.localeCompare(b.date);
      return d * dir || a.id.localeCompare(b.id) * dir;
    });
    const income = list.filter((m) => m.type === 'inc').reduce((s, m) => s + toCOP(m, rates), 0);
    const expense = list.filter((m) => m.type === 'exp').reduce((s, m) => s + toCOP(m, rates), 0);
    const saved = list.filter((m) => m.type === 'save').reduce((s, m) => s + toCOP(m, rates), 0);
    return { list, income, expense, saved, net: income - expense };
  }

  // Personas de la casa: las conocidas más las que aparecen cargando o pagando movimientos.
  function peopleOf(state) {
    const out = [];
    const add = (p) => { if (p && !out.some((x) => norm(x) === norm(p))) out.push(p); };
    (state.people || []).forEach(add);
    state.movements.forEach((m) => { add(m.paidBy); add(m.by); });
    return out;
  }

  // Quién hizo el gasto o ingreso: el que pagó si se indicó, si no el que lo cargó.
  const personOf = (m) => m.paidBy || m.by || '';

  // Categoría sugerida para una descripción: primero las reglas de la planilla (la coincidencia más
  // larga), después los movimientos anteriores con la misma descripción (la categoría más usada).
  function suggestCategory(state, text, type) {
    const q = norm(text);
    if (q.length < 3) return null;
    const valid = (c) => (type === 'inc' ? state.incomeCats.includes(c.cat) : state.categories.some((k) => k.name === c.cat));
    const rule = (state.rules || [])
      .filter((r) => r.type === type && norm(r.text) && q.includes(norm(r.text)) && valid(r))
      .sort((a, b) => norm(b.text).length - norm(a.text).length)[0];
    if (rule) return { cat: rule.cat, sub: rule.sub || '', source: 'regla', match: rule.text };
    const counts = new Map();
    for (const m of state.movements) {
      if (m.type !== type || norm(m.note) !== q || !valid(m)) continue;
      const k = m.cat + '|' + (m.sub || '');
      const c = counts.get(k) || { cat: m.cat, sub: m.sub || '', n: 0, last: '' };
      c.n++;
      if (m.date > c.last) c.last = m.date;
      counts.set(k, c);
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last))[0];
    return best ? { cat: best.cat, sub: best.sub, source: 'historial' } : null;
  }

  // ---------- Metas de ahorro ----------
  // Ahorrado = ahorro inicial + aportes (movimientos de tipo Ahorro), en la moneda de la meta.
  // Ritmo = promedio mensual aportado en los últimos 3 meses (incluido el actual).
  function goalProgress(state, goal, today) {
    const rates = state.settings.rates;
    const inGoal = (v, cur) => convert(v, cur, goal.cur, rates);
    const movs = state.movements.filter((m) => m.type === 'save' && m.goalId === goal.id);
    const saved = (Number(goal.initial) || 0) + movs.reduce((s, m) => s + inGoal(m.amount, m.cur), 0);
    const target = Number(goal.target) || 0;
    const left = Math.max(0, target - saved);
    const key = monthKey(today);
    const from = addMonths(key, -2);
    // Si la meta tiene aportes desde hace menos de 3 meses, se promedia solo ese tramo.
    const first = movs.reduce((k, m) => (monthKey(m.date) < k ? monthKey(m.date) : k), key);
    const start = first > from ? first : from;
    const span = (Number(key.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(key.slice(5, 7)) - Number(start.slice(5, 7)) + 1;
    const pace = movs.filter((m) => monthKey(m.date) >= from && monthKey(m.date) <= key)
      .reduce((s, m) => s + inGoal(m.amount, m.cur), 0) / span;
    const thisMonth = movs.filter((m) => monthKey(m.date) === key).reduce((s, m) => s + inGoal(m.amount, m.cur), 0);
    const monthsLeft = goal.due ? Math.max(1, (Number(goal.due.slice(0, 4)) - Number(key.slice(0, 4))) * 12
      + Number(goal.due.slice(5, 7)) - Number(key.slice(5, 7)) + 1) : null;
    const needed = monthsLeft ? left / monthsLeft : null;
    const eta = left <= 0 ? null : pace > 0 ? addMonths(key, Math.ceil(left / pace) - 1) : null;
    let status = 'nodate';
    if (left <= 0) status = 'done';
    else if (goal.due && goal.due < today) status = 'late';
    else if (goal.due) status = pace >= needed * 0.95 ? 'ok' : 'behind';
    return { saved, target, left, pct: target ? Math.min(100, (saved / target) * 100) : 0, pace, thisMonth, monthsLeft, needed, eta, status,
      movs: movs.slice().sort((a, b) => b.date.localeCompare(a.date)) };
  }

  // ---------- Balance del hogar ----------
  // Tipos de cuentas y bienes, y en qué rubro del balance van.
  const CARD_KIND = 'Tarjeta de crédito';
  const ACCOUNT_KINDS = ['Cuenta bancaria', 'Efectivo', 'Billetera virtual', CARD_KIND, 'Inversión', 'Inmueble', 'Vehículo', 'Otro bien'];
  // La tarjeta de crédito es un pasivo: su saldo es lo que se debe. Comprar con ella es gasto; pagar el resumen, una transferencia.
  const kindClass = (kind) => (['Cuenta bancaria', 'Efectivo', 'Billetera virtual'].includes(kind) ? 'cash'
    : kind === CARD_KIND ? 'card' : kind === 'Inversión' ? 'invest' : 'asset');
  const endOf = (key) => dateInMonth(key, 31);

  // Último saldo cargado de una cuenta hasta el mes key (puede ser de un mes anterior).
  function accountBalance(state, accountId, key) {
    let best = null;
    for (const b of state.balances || []) {
      if (b.accountId === accountId && b.month <= key && (!best || b.month > best.month)) best = b;
    }
    return best;
  }

  // Saldo de un préstamo al cierre del mes según la tabla de cuotas (saldo después de la última cuota vencida).
  function loanBalanceAt(state, loan, key, today) {
    const rows = (state.schedule || []).filter((c) => c.loanId === loan.id);
    const end = endOf(key);
    let last = null;
    for (const c of rows) if (c.due <= end && (!last || c.due > last.due)) last = c;
    if (last) return last.balance;
    if (rows.length && rows.every((c) => c.due > end)) {
      const first = rows.reduce((a, c) => (c.due < a.due ? c : a));
      if (first.n <= 1) return 0; // el préstamo todavía no existía
      return first.balance + first.principal; // saldo antes de la primera cuota de la ventana
    }
    return today && key === monthKey(today) && loan.balance != null ? loan.balance : null;
  }

  // ---------- Facturas emitidas (por cobrar) ----------
  // Cada cobro, total o parcial, es un ingreso vinculado a la factura (Movimientos → «Por cobrar ID»).
  // Cobros anteriores a esta versión quedaron enlazados con «Movimiento ID» de la factura.
  const isPaymentOf = (m, r) => m.type === 'inc' && (m.receivableId === r.id || (r.incomeId && m.id === r.incomeId));
  function receivableInfo(state, r, until) {
    const rates = state.settings.rates;
    const payments = state.movements.filter((m) => isPaymentOf(m, r) && (!until || m.date <= until))
      .sort((a, b) => a.date.localeCompare(b.date));
    let collected = payments.reduce((s, m) => s + convert(m.amount, m.cur, r.cur, rates), 0);
    // Marcada «Cobrada» sin ningún cobro vinculado (cargada así en la planilla): se cobró completa.
    if (r.collected && !until && !payments.length) collected = r.amount;
    const pending = Math.max(0, r.amount - collected);
    // Cerrada con menos de lo facturado: retención en la fuente, descuento o lo que no se va a cobrar.
    const closed = Boolean(r.collected);
    const status = closed || pending < 0.5 ? 'done' : collected > 0 ? 'partial' : 'pending';
    const writtenOff = closed ? pending : 0;
    // De lo que no se cobró, la retención en la fuente es un anticipo del impuesto de renta (saldo a favor), no una pérdida.
    const withheld = Math.min(writtenOff, Number(r.withheld) || 0);
    return { payments, collected, pending: closed ? 0 : pending, status, writtenOff, withheld, lost: writtenOff - withheld,
      lastDate: payments.length ? payments[payments.length - 1].date : null };
  }

  // Retenciones en la fuente a favor al cierre: las de las facturas cerradas hasta esa fecha, por año.
  // Se descuentan en la declaración de renta del año siguiente; se dejan de mostrar después de octubre de ese año.
  function retentionsAt(state, end) {
    const rates = state.settings.rates;
    const y = Number(end.slice(0, 4));
    const byYear = new Map();
    for (const r of state.receivables) {
      if (!r.collected || !(Number(r.withheld) > 0)) continue;
      const on = r.collectedAt || r.due;
      if (!on || on > end) continue;
      const ry = Number(on.slice(0, 4));
      if (ry < y - 1 || (ry === y - 1 && Number(end.slice(5, 7)) > 10)) continue;
      const v = convert(receivableInfo(state, r).withheld, r.cur, 'COP', rates);
      byYear.set(ry, (byYear.get(ry) || 0) + v);
    }
    return [...byYear].sort((a, b) => a[0] - b[0]).map(([year, amount]) => ({ year, amount }));
  }

  // Estado de resultados del mes, por lo devengado: ingresos y gastos del mes aunque no se hayan cobrado o pagado.
  // De los préstamos solo es gasto el interés, el seguro y los diferidos; la amortización baja la deuda.
  function incomeStatement(state, key) {
    const rates = state.settings.rates;
    const inMonth = (iso) => Boolean(iso) && monthKey(iso) === key;
    const income = new Map();
    const add = (map, k, v) => map.set(k, (map.get(k) || 0) + v);
    for (const m of state.movements) {
      if (m.type !== 'inc' || !inMonth(m.date)) continue;
      // El cobro (total o parcial) de una factura emitida ya se contó cuando se emitió.
      if (state.receivables.some((r) => r.issued && isPaymentOf(m, r))) continue;
      add(income, m.cat, toCOP(m, rates));
    }
    for (const r of state.receivables) if (r.issued && inMonth(r.issued)) add(income, 'Facturas emitidas', toCOP(r, rates));
    const expense = new Map();
    let unpaid = 0;
    for (const m of state.movements) if (m.type === 'exp' && inMonth(m.date)) add(expense, m.cat, toCOP(m, rates));
    // Facturas emitidas cerradas con menos de lo facturado (descuento o lo que no se va a cobrar, sin la retención):
    // el ingreso se contó entero al emitirlas, así que la diferencia es gasto del mes en que se cerraron.
    for (const r of state.receivables) {
      if (!r.issued || !r.collected || !inMonth(r.collectedAt || r.due)) continue;
      const lost = receivableInfo(state, r).lost;
      if (lost > 0.5) add(expense, 'Facturas no cobradas', convert(lost, r.cur, 'COP', rates));
    }
    for (const b of state.bills) {
      if (b.loanId || !inMonth(b.due)) continue;
      add(expense, b.cat, toCOP(b, rates));
      if (!b.paid) unpaid += toCOP(b, rates);
    }
    const financial = [];
    let principal = 0;
    // Préstamos sin tabla de cuotas para el mes: interés estimado con la tasa y el saldo, o la cuota entera si no hay tasa.
    for (const b of state.bills) {
      if (!b.loanId || !inMonth(b.due)) continue;
      if ((state.schedule || []).some((c) => c.loanId === b.loanId && inMonth(c.due))) continue;
      const loan = state.loans.find((l) => l.id === b.loanId) || {};
      let rate = Number(loan.rate) || 0;
      if (rate > 3) rate /= 100;
      const cuota = toCOP(b, rates);
      const interest = rate && loan.balance ? Math.min(cuota, convert((loan.balance * rate) / 12, loan.cur || b.cur, 'COP', rates)) : cuota;
      financial.push({ name: b.name, interest, other: 0, estimated: true });
      principal += cuota - interest;
    }
    for (const c of state.schedule || []) {
      if (!inMonth(c.due)) continue;
      const loan = state.loans.find((l) => l.id === c.loanId);
      const fx = (v) => convert(v, c.cur, 'COP', rates);
      financial.push({ name: loan ? loan.name : c.name || c.loanId, interest: fx(c.interest), other: fx(c.insurance + c.deferred) });
      principal += fx(c.principal);
    }
    const sorted = (map) => [...map].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
    const incomeRows = sorted(income);
    const expenseRows = sorted(expense);
    const totalIncome = incomeRows.reduce((s, r) => s + r.amount, 0);
    const totalExpense = expenseRows.reduce((s, r) => s + r.amount, 0);
    const totalFinancial = financial.reduce((s, r) => s + r.interest + r.other, 0);
    const result = totalIncome - totalExpense - totalFinancial;
    return { income: incomeRows, expense: expenseRows, financial, totalIncome, totalExpense, totalFinancial, result,
      margin: totalIncome ? (result / totalIncome) * 100 : null, principal, unpaid };
  }

  // Situación patrimonial al cierre del mes: cuentas y bienes, por cobrar, préstamos y facturas impagas.
  function balanceSheet(state, key, today) {
    const rates = state.settings.rates;
    const end = endOf(key);
    const groups = { cash: [], invest: [], asset: [], card: [] };
    const missing = [];
    for (const a of state.accounts || []) {
      const b = accountBalance(state, a.id, key);
      if (!b) { missing.push(a); continue; }
      groups[kindClass(a.kind)].push({ id: a.id, name: a.name, amount: convert(b.amount, a.cur, 'COP', rates), month: b.month, stale: b.month !== key });
    }
    // Lo que faltaba cobrar al cierre: valor menos los cobros hasta esa fecha (nada, si ya se cerró).
    const receivables = state.receivables.filter((r) => (r.issued || r.due) <= end).map((r) => {
      const info = receivableInfo(state, r, end);
      const closedOn = r.collectedAt || receivableInfo(state, r).lastDate || '9999-12-31';
      const left = r.collected && closedOn <= end ? 0 : Math.max(0, r.amount - info.collected);
      return { name: r.client, amount: convert(left, r.cur, 'COP', rates) };
    }).filter((x) => x.amount > 0.5);
    const loans = [];
    const noData = [];
    for (const l of state.loans) {
      const bal = loanBalanceAt(state, l, key, today);
      if (bal == null) noData.push(l.name);
      else loans.push({ name: l.name, amount: convert(bal, l.cur, 'COP', rates) });
    }
    const payables = state.bills.filter((b) => b.due <= end && !(b.paid && (b.paidAt || b.due) <= end))
      .map((b) => ({ name: b.name, amount: toCOP(b, rates), due: b.due }));
    const sum = (xs) => xs.reduce((s, x) => s + x.amount, 0);
    const retentions = retentionsAt(state, end);
    const assets = { cash: sum(groups.cash), invest: sum(groups.invest), receivables: sum(receivables), retentions: sum(retentions), asset: sum(groups.asset) };
    const totalAssets = assets.cash + assets.invest + assets.receivables + assets.retentions + assets.asset;
    const totalCards = sum(groups.card);
    const totalLiabilities = sum(loans) + totalCards + sum(payables);
    return { key, groups, receivables, retentions, loans, payables, assets, totalAssets, totalLoans: sum(loans), totalCards, totalPayables: sum(payables),
      totalLiabilities, netWorth: totalAssets - totalLiabilities, missing, noData };
  }

  // Flujo de efectivo simple: cuánto cambiaron las cuentas líquidas contra lo registrado en el mes.
  // La diferencia son gastos o ingresos sin cargar (o cuentas que no están en la lista).
  // Las tarjetas de crédito restan: una compra con tarjeta es gasto aunque la plata salga al pagar el resumen,
  // y pagar el resumen (una transferencia de la cuenta a la tarjeta) no cambia el total.
  function cashFlow(state, key) {
    const rates = state.settings.rates;
    const prev = addMonths(key, -1);
    const cash = (state.accounts || []).filter((a) => kindClass(a.kind) === 'cash' || kindClass(a.kind) === 'card');
    const at = (k) => {
      let total = 0;
      let complete = cash.length > 0;
      for (const a of cash) {
        const b = (state.balances || []).find((x) => x.accountId === a.id && x.month === k);
        const sign = kindClass(a.kind) === 'card' ? -1 : 1;
        if (b) total += sign * convert(b.amount, a.cur, 'COP', rates); else complete = false;
      }
      return { total, complete };
    };
    const opening = at(prev);
    const closing = at(key);
    const inMonth = (iso) => Boolean(iso) && monthKey(iso) === key;
    const receipts = state.movements.filter((m) => m.type === 'inc' && inMonth(m.date)).reduce((s, m) => s + toCOP(m, rates), 0);
    const spending = state.movements.filter((m) => m.type === 'exp' && inMonth(m.date)).reduce((s, m) => s + toCOP(m, rates), 0)
      + state.bills.filter((b) => !b.loanId && b.paid && inMonth(b.paidAt || b.due)).reduce((s, b) => s + toCOP(b, rates), 0);
    const loanPayments = state.bills.filter((b) => b.loanId && b.paid && inMonth(b.paidAt || b.due)).reduce((s, b) => s + toCOP(b, rates), 0);
    const recorded = receipts - spending - loanPayments;
    const change = closing.total - opening.total;
    return { opening: opening.total, closing: closing.total, complete: opening.complete && closing.complete, hasAccounts: cash.length > 0,
      receipts, spending, loanPayments, recorded, change, unexplained: change - recorded };
  }

  // ---------- Plan por cobro ----------
  const median = (xs) => {
    const a = xs.slice().sort((x, y) => x - y);
    return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0;
  };
  const parseDays = (v) => [...new Set(String(v ?? '').split(/[^\d]+/).map(Number).filter((d) => d >= 1 && d <= 31))].sort((a, b) => a - b);

  // Cobros estimados con los ingresos de los últimos 3 meses cerrados: los que aparecen en al menos 2 meses,
  // con su día y monto típicos (si llegan 2 veces por mes, como una quincena, se toman los dos).
  function inferIncomePlan(state, today) {
    const key = monthKey(today);
    const months = [1, 2, 3].map((i) => addMonths(key, -i));
    const byCat = new Map();
    for (const m of state.movements) {
      const k = monthKey(m.date);
      if (m.type !== 'inc' || !months.includes(k)) continue;
      if (!byCat.has(m.cat)) byCat.set(m.cat, new Map());
      const mm = byCat.get(m.cat);
      if (!mm.has(k)) mm.set(k, []);
      mm.get(k).push({ day: dayOf(m.date), amount: m.amount, cur: m.cur });
    }
    const out = [];
    for (const [cat, mm] of byCat) {
      if (mm.size < 2) continue;
      const lists = [...mm.values()].map((l) => l.sort((a, b) => a.day - b.day));
      const counts = lists.map((l) => l.length);
      const n = Math.min(2, Math.round(median(counts)));
      const usable = lists.filter((l) => l.length >= n);
      for (let i = 0; i < n; i++) {
        out.push({ id: `auto-${cat}-${i}`, name: cat, cat, cur: usable[0][i].cur,
          amount: Math.round(median(usable.map((l) => l[i].amount))), days: [Math.round(median(usable.map((l) => l[i].day)))], inferred: true });
      }
    }
    return out;
  }

  // Tramos entre cobros desde el último cobro hasta fin del mes siguiente: cuánto entra, qué facturas vencen,
  // cuánto se va en gastos variables (promedio diario de los últimos 90 días) y cuánto queda libre.
  function paycheckPlan(state, today) {
    const rates = state.settings.rates;
    const configured = (state.incomePlan || []).filter((p) => p.amount > 0 && p.days.length);
    const plan = configured.length ? configured : inferIncomePlan(state, today);
    const key = monthKey(today);
    const end = dateInMonth(addMonths(key, 1), 31);
    const events = new Map();
    for (const k of [addMonths(key, -1), key, addMonths(key, 1)]) {
      for (const p of plan) {
        for (const d of p.days) {
          const iso = dateInMonth(k, d);
          if (iso > end) continue;
          if (!events.has(iso)) events.set(iso, []);
          events.get(iso).push({ name: p.name, cat: p.cat, amount: convert(p.amount, p.cur, 'COP', rates) });
        }
      }
    }
    const dates = [...events.keys()].sort();
    let first = dates.filter((d) => d <= today).pop();
    if (!first) first = key + '-01';
    const starts = [first, ...dates.filter((d) => d > first)];
    const since = toISO(new Date(parseISO(today).getTime() - 90 * 86400000));
    const variable90 = state.movements.filter((m) => m.type === 'exp' && m.date > since && m.date <= today).reduce((s, m) => s + toCOP(m, rates), 0);
    const perDay = variable90 / 90;
    let carry = 0;
    const periods = starts.map((start, i) => {
      const next = starts[i + 1];
      const last = next ? toISO(new Date(parseISO(next).getTime() - 86400000)) : end;
      const current = start <= today && today <= last;
      const incomes = (events.get(start) || []).map((e) => ({
        ...e, received: state.movements.some((m) => m.type === 'inc' && m.cat === e.cat && m.date >= start && m.date <= last),
      }));
      // En el tramo actual entran también las facturas vencidas antes y sin pagar.
      const bills = state.bills.filter((b) => (b.due >= start && b.due <= last) || (current && !b.paid && b.due < start))
        .sort((a, b) => a.due.localeCompare(b.due))
        .map((b) => ({ id: b.id, name: b.name, due: b.due, amount: toCOP(b, rates), paid: b.paid, overdue: !b.paid && b.due < start }));
      const fromDay = current ? toISO(new Date(parseISO(today).getTime() + 86400000)) : start;
      const days = Math.max(0, daysBetween(fromDay, last) + 1);
      const income = incomes.reduce((s, e) => s + e.amount, 0);
      const toPay = bills.filter((b) => !b.paid).reduce((s, b) => s + b.amount, 0);
      // Lo que ya salió en el tramo actual: gastos cargados y facturas pagadas desde el cobro hasta hoy.
      const spent = current ? state.movements.filter((m) => m.type === 'exp' && m.date >= start && m.date <= today).reduce((s, m) => s + toCOP(m, rates), 0)
        + state.bills.filter((b) => b.paid && (b.paidAt || b.due) >= start && (b.paidAt || b.due) <= today).reduce((s, b) => s + toCOP(b, rates), 0) : 0;
      const variable = perDay * days;
      const free = income - spent - toPay - variable;
      carry += free;
      return { start, end: last, current, incomes, bills, income, spent, toPay, variable, days, free, cumulative: carry };
    }).filter((p) => p.end >= today);
    return { periods, inferred: !configured.length, plan, perDay };
  }

  // ---------- Evolución del patrimonio ----------
  function netWorthSeries(state, endKey, n, today) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const key = addMonths(endKey, -i);
      const b = balanceSheet(state, key, today);
      const hasData = b.groups.cash.length + b.groups.invest.length + b.groups.asset.length + b.groups.card.length > 0;
      out.push({ key, assets: b.totalAssets, liabilities: b.totalLiabilities, net: b.netWorth, hasData });
    }
    return out;
  }

  // ---------- Plan para salir de las deudas ----------
  // Simula mes a mes: cada préstamo paga su cuota (capital + interés, sin seguros); el pago extra y las
  // cuotas de los préstamos ya terminados van al préstamo elegido por la estrategia:
  // avalancha = mayor tasa primero (paga menos interés), bola de nieve = menor saldo primero (cierra antes).
  function debtPlan(state, today, opts = {}) {
    const rates = state.settings.rates;
    const key = monthKey(today);
    const loans = [];
    for (const l of state.loans) {
      const bal = loanBalanceAt(state, l, key, today);
      if (!(bal > 0)) continue;
      const row = (state.schedule || []).find((c) => c.loanId === l.id && monthKey(c.due) === addMonths(key, 1))
        || (state.schedule || []).find((c) => c.loanId === l.id && monthKey(c.due) === key);
      const pay = row ? row.interest + row.principal : l.installment;
      let rate = Number(l.rate) || 0;
      if (rate > 3) rate /= 100; // «17» es 17 %; 1,2 es 120 % (TNA de préstamos en pesos argentinos)
      loans.push({ id: l.id, name: l.name, cur: l.cur, rate, balance: convert(bal, l.cur, 'COP', rates), payment: Math.max(0, convert(pay, l.cur, 'COP', rates)) });
    }
    const simulate = (extra, strategy, rollover) => {
      const st = loans.map((l) => ({ ...l, bal: l.balance, done: null, interest: 0 }));
      let interest = 0;
      for (let m = 1; m <= 600 && st.some((x) => x.done == null); m++) {
        let pool = extra;
        for (const x of st) {
          if (x.done != null) { if (rollover) pool += x.payment; continue; }
          const i = (x.bal * x.rate) / 12;
          x.bal += i;
          x.interest += i;
          interest += i;
          const p = Math.min(x.bal, x.payment);
          x.bal -= p;
          if (rollover && x.payment > p) pool += x.payment - p; // lo que sobró de la última cuota
          if (x.bal < 1) { x.bal = 0; x.done = m; }
        }
        const order = st.filter((x) => x.done == null)
          .sort((a, b) => (strategy === 'snowball' ? a.bal - b.bal : b.rate - a.rate || a.bal - b.bal));
        for (const x of order) {
          if (pool <= 0) break;
          const p = Math.min(pool, x.bal);
          x.bal -= p;
          pool -= p;
          if (x.bal < 1) { x.bal = 0; x.done = m; }
        }
      }
      return { st, interest, months: st.every((x) => x.done != null) ? Math.max(0, ...st.map((x) => x.done)) : null };
    };
    const extra = Math.max(0, Number(opts.extra) || 0);
    const strategy = opts.strategy === 'snowball' ? 'snowball' : 'avalanche';
    const base = simulate(0, strategy, false);
    const plan = simulate(extra, strategy, extra > 0); // sin extra, el plan es seguir como hoy
    const order = loans.slice().sort((a, b) => (strategy === 'snowball' ? a.balance - b.balance : b.rate - a.rate || a.balance - b.balance)).map((l) => l.id);
    const when = (m) => (m == null ? null : addMonths(key, m));
    return {
      strategy, extra, order,
      loans: loans.map((l, i) => ({ ...l, baseEnd: when(base.st[i].done), planEnd: when(plan.st[i].done),
        baseInterest: base.st[i].done == null ? null : base.st[i].interest, planInterest: plan.st[i].done == null ? null : plan.st[i].interest })),
      // Si algún préstamo no se termina, el interés total no tiene fin: no se informa ni se compara.
      baseInterest: base.months == null ? null : base.interest, planInterest: plan.months == null ? null : plan.interest,
      baseEnd: when(base.months), planEnd: when(plan.months),
      saved: base.months != null && plan.months != null ? base.interest - plan.interest : null,
      monthsSaved: base.months != null && plan.months != null ? base.months - plan.months : null,
      endless: loans.filter((l, i) => base.st[i].done == null).map((l) => l.name),
    };
  }

  // ---------- Alertas ----------
  function buildAlerts(state, today) {
    const key = monthKey(today);
    const rates = state.settings.rates;
    const cur = state.settings.displayCur;
    const money = (cop) => formatMoney(convert(cop, 'COP', cur, rates), cur);
    const unpaid = state.bills.filter((b) => !b.paid).map((b) => ({ b, info: dueInfo(b, today) }));
    const stats = categoryStats(state, key, today);
    const out = [];

    unpaid.filter((x) => x.info.state === 'overdue')
      .sort((a, z) => a.b.due.localeCompare(z.b.due))
      .forEach(({ b, info }) => out.push({ kind: 'bill', id: b.id, tone: 'red', title: `${b.name} venció`, sub: `${info.label} · ${money(toCOP(b, rates))}` }));
    stats.filter((s) => s.status === 'over')
      .forEach((s) => out.push({ kind: 'cat', id: s.name, tone: 'red', title: `${s.name} excedido`, sub: `${Math.round(s.pct)}% · ${money(s.spent)} de ${money(s.limit)}` }));
    unpaid.filter((x) => ['today', 'tomorrow', 'soon'].includes(x.info.state))
      .sort((a, z) => a.b.due.localeCompare(z.b.due))
      .forEach(({ b, info }) => out.push({ kind: 'bill', id: b.id, tone: info.state === 'today' ? 'red' : 'amber', title: `${b.name}: ${info.label.toLowerCase()}`, sub: money(toCOP(b, rates)) }));
    stats.filter((s) => s.status === 'near')
      .forEach((s) => out.push({ kind: 'cat', id: s.name, tone: 'amber', title: `${s.name} al ${Math.round(s.pct)}%`, sub: `Quedan ${money(s.limit - s.spent)}` }));
    stats.filter((s) => s.status === 'proj')
      .forEach((s) => out.push({ kind: 'cat', id: s.name, tone: 'amber', title: `${s.name} podría excederse`, sub: `Proyección ${Math.round(s.projPct)}% al cierre del mes` }));
    state.receivables.filter((r) => !r.collected && r.due && r.due < today).forEach((r) => {
      const info = receivableInfo(state, r);
      if (info.status === 'done') return;
      out.push({ kind: 'recv', id: r.id, tone: 'neutral', title: `Por cobrar: ${r.client}`,
        sub: `Venció hace ${daysBetween(r.due, today)} días · ${info.status === 'partial' ? 'falta ' : ''}${money(convert(info.pending, r.cur, 'COP', rates))}` });
    });
    return out;
  }

  // ---------- Exportaciones ----------
  const icsDate = (iso) => iso.replace(/-/g, '');
  const icsText = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');

  // Eventos de calendario a las 9:00 con avisos. Las recurrentes se exportan para los próximos 12 meses.
  function toICS(state, today) {
    const events = [];
    const fromKey = monthKey(today);
    const add = (uidStr, name, due, amount, cur, alerts) => {
      const lines = ['BEGIN:VEVENT', `UID:${uidStr}@cuentas-casa`, `DTSTAMP:${icsDate(today)}T000000`,
        `DTSTART:${icsDate(due)}T090000`, 'DURATION:PT30M',
        `SUMMARY:${icsText(`Pagar ${name} · ${formatMoney(amount, cur)}`)}`];
      for (const d of alerts && alerts.length ? alerts : [0]) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(name)}`,
          `TRIGGER:${d ? `-P${d}D` : '-PT0M'}`, 'END:VALARM');
      }
      lines.push('END:VEVENT');
      events.push(lines.join('\r\n'));
    };
    for (const b of state.bills) {
      if (b.paid || (b.templateId && b.due >= `${fromKey}-01`)) continue;
      add(b.id, b.name, b.due, b.amount, b.cur, b.alerts);
    }
    for (const r of state.recurring) {
      for (let i = 0; i < 12; i++) {
        const key = addMonths(fromKey, i);
        const inst = state.bills.find((b) => b.templateId === r.id && monthKey(b.due) === key);
        if (inst && inst.paid) continue;
        add(`${r.id}-${key}`, r.name, inst ? inst.due : dateInMonth(key, r.day), r.amount, r.cur, inst ? inst.alerts : r.alerts);
      }
    }
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cuentas Casa//ES', 'CALSCALE:GREGORIAN',
      ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
  }

  const TYPE_LABEL = { exp: 'Gasto', inc: 'Ingreso', save: 'Ahorro', xfer: 'Transferencia' };

  function toCSV(state) {
    // Un texto que empieza con = + - @ se abriría como fórmula en Excel: se le antepone un apóstrofo.
    const q = (v) => `"${(typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : String(v ?? '')).replace(/"/g, '""')}"`;
    const rows = [['Fecha', 'Tipo', 'Categoría', 'Subcategoría', 'Descripción', 'Moneda', 'Importe', 'Medio de pago', 'Persona']];
    for (const m of [...state.movements].sort((a, b) => a.date.localeCompare(b.date))) {
      rows.push([m.date, TYPE_LABEL[m.type] || 'Gasto', m.cat, m.sub, m.note, m.cur, m.amount, m.method, personOf(m)]);
    }
    for (const b of state.bills.filter((x) => x.paid).sort((a, z) => a.due.localeCompare(z.due))) {
      rows.push([b.due, 'Factura', b.cat, b.sub, b.name, b.cur, b.amount, b.method, '']);
    }
    return rows.map((r) => r.map(q).join(';')).join('\r\n');
  }

  // ---------- Importar Excel (hoja "Movimientos Reales") ----------
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[_\s]+/g, ' ').trim().toLowerCase();

  function cellToISO(v) {
    if (v instanceof Date && !isNaN(v)) return toISO(v);
    if (typeof v === 'number' && v > 20000 && v < 80000) { // número de serie de Excel
      return toISO(new Date(Math.round((v - 25569) * 86400000) + new Date().getTimezoneOffset() * 60000));
    }
    const m = String(v ?? '').match(/(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})/);
    if (!m) return null;
    let [, a, b, c] = m.map(Number);
    if (a > 999) return `${a}-${pad(b)}-${pad(c)}`;
    if (c < 100) c += 2000;
    return `${c}-${pad(b)}-${pad(a)}`;
  }

  function parseNumber(v) {
    if (typeof v === 'number') return v;
    let s = String(v ?? '').replace(/[^\d,.-]/g, '');
    if (!s) return NaN;
    const last = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    if (last >= 0 && s.length - last - 1 !== 3) {
      s = s.slice(0, last).replace(/[.,]/g, '') + '.' + s.slice(last + 1);
    } else {
      s = s.replace(/[.,]/g, '');
    }
    return Number(s);
  }

  // rows: matriz de celdas (primera fila con "Fecha" e "Importe" = encabezado).
  function parseMovementRows(rows, state) {
    const hi = rows.findIndex((r) => r && r.some((c) => norm(c) === 'fecha') && r.some((c) => norm(c) === 'importe'));
    if (hi < 0) throw new Error('No se encontró el encabezado (Fecha, Importe)');
    const head = rows[hi].map(norm);
    const col = (name) => head.indexOf(name);
    const C = { fecha: col('fecha'), cat: col('categoria'), desc: col('descripcion'), cur: col('moneda'),
      amt: col('importe'), method: col('medio de pago'), ent: col('entidad'), com: col('comentarios') };
    const incomeCats = state.incomeCats;
    const out = [];
    let skipped = 0;
    for (const r of rows.slice(hi + 1)) {
      if (!r) continue;
      const date = cellToISO(r[C.fecha]);
      const raw = parseNumber(r[C.amt]);
      if (!date || !raw) { skipped++; continue; }
      const catRaw = C.cat >= 0 ? String(r[C.cat] ?? '').trim() : '';
      const desc = C.desc >= 0 ? String(r[C.desc] ?? '').trim() : '';
      const note = [C.com >= 0 ? r[C.com] : '', desc].map((x) => String(x ?? '').trim()).filter(Boolean)[0] || '';
      const curRaw = String(C.cur >= 0 ? r[C.cur] ?? '' : '').toUpperCase();
      const cur = CURRENCIES.find((c) => curRaw.includes(c)) || 'COP';
      const mov = { id: uid(), date, amount: Math.abs(raw), cur, note, sub: '',
        method: C.method >= 0 ? String(r[C.method] ?? '').trim() : '' };
      const inc = incomeCats.find((c) => norm(c) === norm(catRaw) || (desc && norm(c) === norm(desc)));
      if (inc) {
        out.push({ ...mov, type: 'inc', cat: inc });
        continue;
      }
      const byName = state.categories.find((c) => norm(c.name) === norm(catRaw) || norm(c.group || '') === norm(catRaw));
      const bySub = state.categories.find((c) => c.subs.some((s) => norm(s) === norm(desc) || norm(s) === norm(catRaw)));
      const cat = byName || bySub || state.categories.find((c) => c.name === 'Otros gastos') || state.categories[0];
      const sub = cat.subs.find((s) => norm(s) === norm(desc) || norm(s) === norm(catRaw)) || (byName ? '' : catRaw);
      out.push({ ...mov, type: 'exp', cat: cat.name, sub });
    }
    return { movements: out, skipped };
  }

  // ---------- Lectura de tickets (texto de OCR) ----------
  const CATEGORY_HINTS = [
    [/supermerc|exito|éxito|carulla|jumbo|olimpica|olímpica|\bd1\b|\bara\b|coto|carrefour|mercado|fruver/i, 'Alimentación', 'Supermercado'],
    [/restaurante|cafe|café|pizza|burger|rappi|domicilio|panader/i, 'Alimentación', 'Restaurantes'],
    [/farmacia|drogu|cruz verde|cafam|colsubsidio|medic|clinica|clínica/i, 'Salud', 'Farmacia'],
    [/terpel|esso|primax|texaco|combustible|gasolina|peaje|uber|didi|cabify|taxi|parqueadero/i, 'Transporte', ''],
    [/veterin|mascota|pet|agrocampo/i, 'Mascotas', ''],
    [/cine|netflix|spotify|disney|teatro|concierto/i, 'Ocio', ''],
    [/epm|enel|codensa|vanti|acueducto|energ|claro|movistar|tigo|etb|internet/i, 'Gastos fijos', 'Servicios públicos'],
    [/librer|curso|universidad|colegio/i, 'Formación', ''],
  ];

  // ---------- Lectura de tickets y facturas (texto que devuelve el lector) ----------
  const MONTHS_RE = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
    jan: 1, apr: 4, aug: 8, dec: 12 };
  // Líneas cuyos números no son montos: identificaciones, teléfonos, numeraciones, códigos.
  const NOT_AMOUNT = /\bnit\b|n\.?i\.?t|\bc\.?c\b|\bcc\b|tel[eé]?f?|cel\b|whats|resoluci|autoriz|\bfactura\s*(n|no|#|electr)|\bfact\b|\bref(erencia)?\b|cufe|cude|\bcaja\b|cajero|\bpos\b|terminal|\bitems?\b|art[ií]culos|unidades|cantidad|\bcant\b|c[oó]digo|\bcod\b|\bplu\b|\bean\b|\bnro\b|\bn[°º]|\bno\.\s|consecutivo|transacci|aprobaci|recibo\s*n|cuenta\s*n|contrato|\bnic\b|\bnis\b|matr[ií]cula|direcci|\bcalle\b|\bcra\b|\bcarrera\b|\bkm\b|www\.|@/i;
  // Palabras de total, de más a menos específicas. Se descartan subtotal, IVA, descuentos y cambio.
  const TOTAL_KEYS = [
    /total\s*a\s*pagar|valor\s*a\s*pagar|neto\s*a\s*pagar|total\s*pagar|pague\s*(este\s*)?valor|valor\s*total\s*a\s*pagar/i,
    /valor\s*total|total\s*factura|total\s*(cop|\$)|gran\s*total|total\s*general|importe\s*total/i,
    /\btotal\b/i,
  ];
  const NOT_TOTAL = /sub\s*-?\s*total|\biva\b|impuesto|descuento|\bdcto|ahorr|cambio|vuelto|propina|base\s*(gravable|imp)|items|art[ií]culos|unidades|total\s*(de\s*)?(l[ií]neas|prod)/i;
  const DUE_KEYS = /pague\s*hasta|p[aá]guese\s*hasta|fecha\s*l[ií]mite|l[ií]mite\s*de\s*pago|pago\s*oportuno|vence|vencimiento|fecha\s*de\s*pago|pagar\s*antes/i;

  // Arregla confusiones típicas del lector dentro de los números: O→0, l/I→1, S→5, B→8.
  // Solo toca grupos que ya tienen algún dígito y no son palabras (ej. «3O.4OO» → «30.400»).
  const fixDigits = (l) => l.replace(/(^|[^A-Za-zÁÉÍÓÚáéíóúÑñ])([\dOoIlSB]+(?:[.,][\dOoIlSB]+)*)(?![A-Za-zÁÉÍÓÚáéíóúÑñ])/g, (all, pre, tok) =>
    (/\d/.test(tok) ? pre + tok.replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5').replace(/B/g, '8') : all));

  // Montos de una línea: con separador de miles, con signo $ o de hasta 7 cifras. Ignora fechas, horas y porcentajes.
  function moneyIn(line) {
    const clean = line.replace(/\d{1,4}[/\-]\d{1,2}[/\-]\d{1,4}/g, ' ').replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ').replace(/\d+([.,]\d+)?\s*%/g, ' ');
    const out = [];
    const re = /(\$\s*)?(\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d])/g;
    let m;
    while ((m = re.exec(clean))) {
      const raw = m[2];
      const grouped = /\d[.,\s]\d{3}/.test(raw);
      const digits = raw.replace(/\D/g, '').length;
      if (!grouped && !m[1] && digits > 7) continue; // códigos largos sin separadores
      if (!grouped && !m[1] && digits < 3) continue; // cantidades sueltas
      const n = parseNumber(raw.replace(/\s/g, ''));
      if (n > 0 && n < 1e9) out.push({ n, strong: grouped || Boolean(m[1]) });
    }
    return out;
  }

  function datesIn(line, today) {
    const out = [];
    const ok = (y, mo, d) => {
      if (y < 100) y += 2000;
      if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return;
      const iso = `${y}-${pad(mo)}-${pad(Math.min(d, daysInMonth(`${y}-${pad(mo)}`)))}`;
      if (today && (iso < addMonths(monthKey(today), -24) + '-01' || iso > addMonths(monthKey(today), 13) + '-01')) return;
      out.push(iso);
    };
    let m;
    const num = /(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{2,4})/g;
    while ((m = num.exec(line))) {
      const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (m[1].length === 4) ok(a, b, c); else ok(c, b, a);
    }
    const txt = /(\d{1,2})\s*(?:de\s*|[-/.\s])?([a-záéíóú]{3,10})\.?\s*(?:de\s*|[-/.,\s])\s*(\d{2,4})/gi;
    while ((m = txt.exec(line))) {
      const mo = MONTHS_RE[norm(m[2]).slice(0, 3)];
      if (mo) ok(Number(m[3]), mo, Number(m[1]));
    }
    return out;
  }

  function parseReceipt(text, mode = 'ticket', today = null) {
    const raw = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const lines = raw.map(fixDigits);

    // Total: la palabra más específica gana; el monto está en la línea o en las dos siguientes.
    let total = 0;
    for (const key of TOTAL_KEYS) {
      const found = [];
      lines.forEach((l, i) => {
        if (!key.test(l) || NOT_TOTAL.test(l)) return;
        let amounts = moneyIn(l);
        for (let j = 1; !amounts.length && j <= 2 && lines[i + j]; j++) {
          if (NOT_AMOUNT.test(lines[i + j]) || NOT_TOTAL.test(lines[i + j])) continue;
          amounts = moneyIn(lines[i + j]);
        }
        if (amounts.length) found.push(amounts[amounts.length - 1].n);
      });
      if (found.length) { total = Math.max(...found); break; }
    }
    // Sin palabra de total: el monto más alto que tenga formato de plata ($ o miles), fuera de líneas de códigos.
    if (!total) {
      const cands = lines.filter((l) => !NOT_AMOUNT.test(l) && !NOT_TOTAL.test(l)).flatMap(moneyIn).filter((a) => a.strong).map((a) => a.n);
      if (cands.length) total = Math.max(...cands);
    }

    // Fecha: en facturas, la de «pague hasta» o la más lejana; en tickets, la de la línea «fecha» o la primera.
    let date = null;
    const near = (re) => {
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        const d = datesIn(lines[i], today).concat(lines[i + 1] ? datesIn(lines[i + 1], today) : []);
        if (d.length) return d[0];
      }
      return null;
    };
    const all = lines.flatMap((l) => datesIn(l, today));
    if (mode === 'factura') date = near(DUE_KEYS) || (all.length ? all.slice().sort().pop() : null);
    else date = near(/fecha/i) || all[0] || null;

    // Comercio: entre las primeras líneas, la primera con mayoría de letras que no sea un dato fiscal.
    const merchantLine = raw.slice(0, 8).find((l) => {
      const letters = (l.match(/[a-záéíóúñ]/gi) || []).length;
      return letters >= 3 && letters / l.replace(/\s/g, '').length > 0.6 && !NOT_AMOUNT.test(l)
        && !/r[eé]gimen|responsable|iva|factura|ticket|recibo|bienvenid|gracias|original|copia/i.test(l);
    }) || '';
    const merchant = merchantLine.replace(/[^\wáéíóúñÁÉÍÓÚÑ&.' -]/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 40);

    let cat = null;
    let sub = '';
    const joined = lines.join('\n');
    for (const [re, c, sb] of CATEGORY_HINTS) {
      if (re.test(joined)) { cat = c; sub = sb; break; }
    }
    return { merchant, total: Math.round(total), date, cat, sub };
  }

  // ---------- Estado ----------
  const EXPENSE_CATEGORIES = [
    ['Alimentación', 'Alimentación', 2500000, ['Supermercado', 'Verdulería', 'Carnicería', 'Restaurantes', 'Domicilios']],
    ['Gastos fijos', 'Gastos_Fijos', 3000000, ['Servicios públicos', 'Internet', 'Celular', 'Ayuda doméstica', 'Seguridad social']],
    ['Obligaciones financieras', 'Obligaciones_financieras', 5200000, ['Hipoteca', 'Préstamo', 'Tarjeta de crédito']],
    ['Salud', 'Salud', 900000, ['Promédico', 'Seguro de salud', 'Farmacia', 'Consultas']],
    ['Otros gastos', 'Otros_Gastos', 600000, ['Honorarios', 'Regalos', 'Varios']],
    ['Ocio', 'Ocio', 700000, ['Salidas', 'Suscripciones', 'Viajes']],
    ['Transporte', 'Transporte', 800000, ['Combustible', 'Taxi / App', 'Peajes', 'Mantenimiento']],
    ['Vivienda', 'Vivienda', 3200000, ['Alquiler', 'Administración', 'Reparaciones']],
    ['Mascotas', 'Mascotas', 300000, ['Alimento', 'Veterinario']],
    ['Formación', 'Formación', 400000, ['Cursos', 'Libros']],
    ['2ª Vivienda', '2ª Vivienda', 500000, ['Expensas', 'Servicios', 'Mantenimiento']],
  ];

  // Préstamos de ejemplo (montos ficticios; los reales viven solo en la planilla).
  const LOANS = [
    ['Hipoteca de ejemplo', 'COP', 1500000, 8, 'Hipoteca'],
    ['Préstamo de ejemplo', 'ARS', 150000, 10, 'Préstamo'],
    ['Crédito de ejemplo', 'COP', 1000000, 30, 'Préstamo'],
  ];

  function baseState(today) {
    const startMonth = monthKey(today);
    const state = {
      version: 1,
      settings: {
        displayCur: 'COP',
        rates: { COP: 1, ARS: 2.13845, USD: 3194.44 },
        ratesUpdated: '2026-10-13',
        ratesSource: 'TRM Banco de la República · XE (tasa media)',
        threshold: 80,
      },
      categories: EXPENSE_CATEGORIES.map(([name, group, limit, subs]) => ({ name, group, limit, subs })),
      incomeCats: ['Sueldo Alan', 'Sueldo Karo', 'Plazo Fijo', 'Prima', 'Bono', 'FCI', 'Otros Ingresos'],
      methods: ['Efectivo', 'Transferencia', 'Tarjeta Débito', 'Tarjeta Crédito', 'Billetera virtual'],
      people: ['Alan', 'Karo'],
      rules: [],
      goals: [],
      accounts: [],
      balances: [],
      schedule: [],
      incomePlan: [],
      loans: [],
      recurring: [],
      bills: [],
      movements: [],
      receivables: [],
    };
    for (const [name, cur, installment, day, sub] of LOANS) {
      const id = uid();
      state.loans.push({ id, name, cur, installment, day, balance: null, paidCount: null, totalCount: null });
      state.recurring.push({ id: 'r-' + id, name, cat: 'Obligaciones financieras', sub, amount: installment, cur, day, loanId: id, alerts: [3, 0], startMonth });
    }
    return state;
  }

  // Datos de ejemplo para ver la app funcionando (se borran desde Ajustes).
  function sampleState(today) {
    const s = baseState(today);
    const key = monthKey(today);
    const td = dayOf(today);
    const startMonth = key;
    const rec = (name, cat, sub, amount, day) => s.recurring.push({ id: uid(), name, cat, sub, amount, cur: 'COP', day, alerts: [3, 0], sample: true, startMonth });
    rec('Alquiler', 'Vivienda', 'Alquiler', 2800000, 5);
    rec('Ayuda doméstica · 1ª quincena', 'Gastos fijos', 'Ayuda doméstica', 650000, 15);
    rec('Ayuda doméstica · 2ª quincena', 'Gastos fijos', 'Ayuda doméstica', 650000, 30);
    rec('Seguridad social', 'Gastos fijos', 'Seguridad social', 420000, 10);
    rec('Promédico', 'Salud', 'Promédico', 185000, 5);
    rec('Seguro de salud', 'Salud', 'Seguro de salud', 340000, 20);
    rec('Honorarios', 'Otros gastos', 'Honorarios', 300000, 25);
    rec('Celular', 'Gastos fijos', 'Celular', 89000, 18);
    ensureRecurring(s, key);
    // Pagadas las vencidas, salvo el préstamo de ejemplo (para mostrar una alerta).
    for (const b of s.bills) {
      if (b.due < today && b.name !== 'Préstamo de ejemplo') { b.paid = true; b.method = 'Transferencia'; }
    }
    const mov = (d, type, cat, sub, note, amount, method, cur = 'COP') => {
      if (d <= td) s.movements.push({ id: uid(), date: `${key}-${pad(d)}`, type, cat, sub, note, amount, cur, method, sample: true });
    };
    mov(1, 'inc', 'Sueldo Alan', '', 'Sueldo octubre', 8000000, 'Transferencia');
    mov(1, 'inc', 'Sueldo Karo', '', 'Sueldo octubre', 6000000, 'Transferencia');
    mov(2, 'exp', 'Alimentación', 'Supermercado', 'Compra del mes', 980000, 'Tarjeta Crédito');
    mov(3, 'exp', 'Transporte', 'Combustible', 'Tanqueo', 210000, 'Tarjeta Débito');
    mov(4, 'exp', 'Ocio', 'Salidas', 'Cena con amigos', 320000, 'Tarjeta Crédito');
    mov(6, 'exp', 'Alimentación', 'Verdulería', 'Fruver', 145000, 'Efectivo');
    mov(7, 'exp', 'Mascotas', 'Alimento', 'Concentrado', 168000, 'Tarjeta Débito');
    mov(8, 'exp', 'Ocio', 'Suscripciones', 'Streaming', 45000, 'Tarjeta Crédito');
    mov(9, 'exp', 'Alimentación', 'Domicilios', 'Domicilio', 86000, 'Billetera virtual');
    mov(9, 'exp', 'Ocio', 'Viajes', 'Pasajes fin de semana', 95, 'Tarjeta Crédito', 'USD');
    mov(10, 'exp', 'Transporte', 'Taxi / App', 'Viajes en app', 74000, 'Billetera virtual');
    mov(11, 'exp', 'Alimentación', 'Supermercado', 'Reposición', 412000, 'Tarjeta Débito');
    const rcv = (client, issuedDelta, dueDelta, amount) => {
      const d = parseISO(today);
      const at = (n) => { const x = new Date(d); x.setDate(x.getDate() + n); return toISO(x); };
      s.receivables.push({ id: uid(), client, issued: at(issuedDelta), due: at(dueDelta), amount, cur: 'COP', collected: false, incomeId: null, sample: true });
    };
    rcv('Estudio Contable Andes', -40, -10, 2400000);
    rcv('Clínica del Norte', -20, 10, 1850000);
    rcv('Fundación Semillas', -12, 18, 950000);
    return s;
  }

  function normalizeState(raw, today) {
    if (!raw || typeof raw !== 'object' || !raw.settings) return null;
    const base = baseState(today);
    const s = { ...base, ...raw, settings: { ...base.settings, ...raw.settings } };
    s.settings.rates = { ...base.settings.rates, ...(raw.settings.rates || {}) };
    for (const k of ['categories', 'incomeCats', 'methods', 'people', 'rules', 'goals', 'accounts', 'balances', 'schedule', 'incomePlan', 'loans', 'recurring', 'bills', 'movements', 'receivables']) {
      if (!Array.isArray(s[k])) s[k] = base[k];
    }
    if (!s.categories.length) s.categories = base.categories;
    s.categories.forEach((c) => { if (!Array.isArray(c.subs)) c.subs = []; });
    return s;
  }

  // Quita los datos de ejemplo y deja categorías, préstamos y ajustes.
  function clearSamples(state) {
    const sampleTemplates = new Set(state.recurring.filter((r) => r.sample).map((r) => r.id));
    state.recurring = state.recurring.filter((r) => !r.sample);
    state.bills = state.bills.filter((b) => !sampleTemplates.has(b.templateId));
    state.movements = state.movements.filter((m) => !m.sample);
    state.receivables = state.receivables.filter((r) => !r.sample);
    state.bills.forEach((b) => { if (b.loanId) { b.paid = false; b.method = ''; } });
    return state;
  }

  // ---------- Sincronización con la planilla de Google ----------
  // La planilla usa los nombres del Excel (Gastos_Fijos); la app los muestra legibles (Gastos fijos).
  const catLabel = (code) => String(code).replace(/_(.)/g, (m, c) => ' ' + c.toLowerCase());

  const INCOME_GROUP = 'Ingresos';
  const SAVE_TYPE = 'Ahorro'; // aportes a metas: Tipo y Categoría «Ahorro», Subcategoría = nombre de la meta
  // Transferencias entre cuentas propias (y pago del resumen de la tarjeta): Tipo y Categoría «Transferencia»,
  // Subcategoría «Origen → Destino», cuentas en Origen ID y Destino ID. No son ingreso ni gasto.
  const XFER_TYPE = 'Transferencia';
  const SETTING_KEYS = { USD: 'Tasa USD (COP por 1 USD)', ARS: 'Tasa ARS (COP por 1 ARS)', threshold: 'Umbral de aviso de presupuesto' };

  function parseAlerts(v) {
    if (typeof v === 'number') return [v];
    const list = String(v ?? '').split(/[,;\s]+/).filter((x) => x !== '').map(Number).filter((n) => !isNaN(n) && n >= 0);
    return list.length ? list : [3, 0];
  }

  const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
  const num = (v) => (typeof v === 'number' ? v : parseNumber(v) || 0);

  // Filas de presupuesto de una categoría para el mes; si ese mes no tiene, las del mismo mes del año anterior.
  function budgetRowsFor(rows, group, key) {
    const pick = (k) => rows.filter((r) => r['Categoría'] === group && str(r['Mes']).slice(0, 7) === k);
    const own = pick(key);
    return own.length ? { rows: own, from: key } : { rows: pick(addMonths(key, -12)), from: addMonths(key, -12) };
  }

  // Límite de cada categoría para el mes: suma de su presupuesto del mes, o del mismo mes del año anterior.
  // Se decide por categoría: editar una desde la app no deja a las demás sin presupuesto.
  function budgetLimits(rows, key, rates) {
    const out = {};
    for (const group of new Set(rows.map((r) => r['Categoría']))) {
      for (const r of budgetRowsFor(rows, group, key).rows) {
        out[group] = (out[group] || 0) + convert(num(r['Importe']), str(r['Moneda']) || 'COP', 'COP', rates);
      }
    }
    return out;
  }

  // Convierte las pestañas de la planilla al estado de la app. Conserva preferencias locales de prev.
  function sheetToState(tables, prev, today) {
    const s = baseState(today);
    s.loans = [];
    s.recurring = [];
    if (prev && prev.settings) s.settings.displayCur = prev.settings.displayCur;
    const t = (name) => tables[name] || [];

    for (const r of t('Ajustes')) {
      const v = num(r['Valor']);
      if (r['Ajuste'] === SETTING_KEYS.USD && v > 0) s.settings.rates.USD = v;
      if (r['Ajuste'] === SETTING_KEYS.ARS && v > 0) s.settings.rates.ARS = v;
      if (r['Ajuste'] === SETTING_KEYS.threshold && v > 0) s.settings.threshold = Math.round(v <= 1 ? v * 100 : v);
    }
    s.settings.ratesSource = 'planilla';

    const codes = {};
    const label = (code) => {
      const c = str(code);
      if (!c) return c;
      const l = catLabel(c);
      codes[l] = c;
      return l;
    };
    const groups = new Map();
    const incomes = [];
    for (const r of t('Categorías')) {
      const cat = str(r['Categoría']);
      const sub = str(r['Subcategoría']);
      if (!cat) continue;
      if (cat === INCOME_GROUP || str(r['Tipo']) === 'Ingreso') {
        if (sub && !incomes.includes(sub)) incomes.push(sub);
        continue;
      }
      if (!groups.has(cat)) groups.set(cat, []);
      if (sub && !groups.get(cat).includes(sub)) groups.get(cat).push(sub);
    }
    s.budgetRows = t('Presupuesto').filter((r) => str(r['Mes']) && str(r['Categoría'])).map((r) => ({ 'Mes': str(r['Mes']), 'Categoría': str(r['Categoría']),
      'Subcategoría': str(r['Subcategoría']), 'Moneda': str(r['Moneda']) || 'COP', 'Importe': num(r['Importe']) }));
    const limits = budgetLimits(s.budgetRows, monthKey(today), s.settings.rates);
    s.categories = [...groups].map(([code, subs]) => ({ name: label(code), group: code, limit: Math.round(limits[code] || 0), subs }));
    if (incomes.length) s.incomeCats = incomes;
    const methods = t('Listas').map((r) => str(r['Medio de pago'])).filter(Boolean);
    if (methods.length) s.methods = methods;

    s.accounts = t('Cuentas y bienes').filter((r) => r['ID'] && str(r['Activa']) !== 'No').map((r) => ({
      id: str(r['ID']), name: str(r['Nombre']), kind: str(r['Tipo']) || 'Cuenta bancaria', cur: str(r['Moneda']) || 'COP', note: str(r['Comentarios']),
    }));
    s.balances = t('Saldos').filter((r) => r['Cuenta ID'] && r['Mes']).map((r) => ({
      accountId: str(r['Cuenta ID']), month: str(r['Mes']).slice(0, 7), amount: num(r['Saldo']),
    }));
    s.schedule = t('Cuotas').filter((r) => r['ID préstamo'] && r['Vencimiento']).map((r) => ({
      loanId: str(r['ID préstamo']), name: str(r['Préstamo']), n: num(r['N° cuota']), due: str(r['Vencimiento']), cur: str(r['Moneda']) || 'COP',
      principal: num(r['Amortización']), interest: num(r['Interés']), insurance: num(r['Seguro']), deferred: num(r['Diferidos']),
      installment: num(r['Cuota']), balance: num(r['Saldo']),
    }));
    s.goals = t('Metas').filter((r) => r['ID'] && str(r['Activa']) !== 'No').map((r) => ({
      id: str(r['ID']), name: str(r['Nombre']), target: num(r['Monto objetivo']), cur: str(r['Moneda']) || 'COP',
      due: str(r['Fecha objetivo']), initial: num(r['Ahorro inicial']), note: str(r['Comentarios']),
    }));
    s.movements = t('Movimientos').filter((r) => r['ID'] && r['Fecha']).map((r) => {
      if (str(r['Tipo']) === XFER_TYPE) {
        return { id: str(r['ID']), date: str(r['Fecha']), type: 'xfer', from: str(r['Origen ID']), to: str(r['Destino ID']), cat: XFER_TYPE,
          sub: str(r['Subcategoría']), note: str(r['Comentarios']), amount: num(r['Importe']), cur: str(r['Moneda']) || 'COP', method: '',
          by: str(r['Cargado por']), paidBy: str(r['Pagó']) };
      }
      if (str(r['Tipo']) === SAVE_TYPE) {
        return { id: str(r['ID']), date: str(r['Fecha']), type: 'save', goalId: str(r['Meta ID']), cat: str(r['Subcategoría']), sub: '',
          note: str(r['Comentarios']), amount: num(r['Importe']), cur: str(r['Moneda']) || 'COP', method: str(r['Medio de pago']),
          by: str(r['Cargado por']), paidBy: str(r['Pagó']) };
      }
      const inc = str(r['Tipo']) === 'Ingreso' || str(r['Categoría']) === INCOME_GROUP;
      return {
        id: str(r['ID']), date: str(r['Fecha']), type: inc ? 'inc' : 'exp',
        cat: inc ? str(r['Subcategoría']) : label(r['Categoría']), sub: inc ? '' : str(r['Subcategoría']),
        note: str(r['Comentarios']), amount: num(r['Importe']), cur: str(r['Moneda']) || 'COP', method: str(r['Medio de pago']),
        by: str(r['Cargado por']), paidBy: str(r['Pagó']),
        ...(str(r['Por cobrar ID']) ? { receivableId: str(r['Por cobrar ID']) } : {}),
      };
    });
    s.rules = t('Reglas').filter((r) => str(r['Contiene']) && str(r['Activa']) !== 'No').map((r) => {
      const inc = str(r['Tipo']) === 'Ingreso' || str(r['Categoría']) === INCOME_GROUP;
      return { text: str(r['Contiene']), type: inc ? 'inc' : 'exp', cat: inc ? str(r['Subcategoría']) : label(r['Categoría']), sub: inc ? '' : str(r['Subcategoría']) };
    }).filter((r) => r.cat);
    s.bills = t('Facturas').filter((r) => r['ID'] && r['Vence']).map((r) => ({
      id: str(r['ID']), templateId: str(r['Recurrente ID']) || null, name: str(r['Nombre']), cat: label(r['Categoría']),
      sub: str(r['Subcategoría']), amount: num(r['Importe']), cur: str(r['Moneda']) || 'COP', due: str(r['Vence']),
      paid: str(r['Pagada']) === 'Sí', paidAt: str(r['Fecha de pago']) || null, method: str(r['Medio de pago']),
      loanId: str(r['Préstamo ID']) || null, alerts: parseAlerts(r['Avisos (días antes)']),
    }));
    s.recurring = t('Recurrentes').filter((r) => r['ID'] && str(r['Activa']) !== 'No').map((r) => ({
      id: str(r['ID']), name: str(r['Nombre']), cat: label(r['Categoría']), sub: str(r['Subcategoría']),
      amount: num(r['Importe']), cur: str(r['Moneda']) || 'COP', day: num(r['Día']) || 1, alerts: parseAlerts(r['Avisos (días antes)']),
      ...(str(r['Desde']) ? { startMonth: str(r['Desde']).slice(0, 7) } : {}),
    }));
    s.receivables = t('Por cobrar').filter((r) => r['ID']).map((r) => ({
      id: str(r['ID']), client: str(r['Cliente']), issued: str(r['Fecha de emisión']) || null, due: str(r['Vence']),
      amount: num(r['Valor']), cur: str(r['Moneda']) || 'COP', collected: str(r['Estado']) === 'Cobrada',
      incomeId: str(r['Movimiento ID']) || null, collectedAt: str(r['Fecha de cobro']) || null,
      ...(num(r['Retención']) > 0 ? { withheld: num(r['Retención']) } : {}),
    }));
    s.loans = t('Deudas').filter((r) => r['ID']).map((r) => ({
      id: str(r['ID']), name: str(r['Préstamo']), cur: str(r['Moneda']) || 'COP', installment: num(r['Próxima cuota']),
      day: num(r['Día de vencimiento']) || null, balance: r['Saldo actual'] === undefined ? null : num(r['Saldo actual']),
      capital: num(r['Capital']) || null, paidCount: r['Cuotas vencidas'] === undefined ? null : num(r['Cuotas vencidas']),
      totalCount: num(r['Plazo (cuotas)']) || null, rate: num(r['TNA']) || 0,
    }));
    s.incomePlan = t('Ingresos esperados').filter((r) => r['ID'] && str(r['Activa']) !== 'No').map((r) => ({
      id: str(r['ID']), name: str(r['Nombre']), cat: str(r['Subcategoría']) || str(r['Nombre']), cur: str(r['Moneda']) || 'COP',
      amount: num(r['Importe']), days: parseDays(r['Días de cobro']),
    }));
    s.catCodes = codes;
    s.synced = true;
    return s;
  }

  // Filas que la app puede escribir, por pestaña (solo las columnas que la app conoce).
  function stateToRows(s) {
    const code = (labelName) => (s.catCodes && s.catCodes[labelName]) || labelName;
    const goalName = (id) => ((s.goals || []).find((g) => g.id === id) || {}).name;
    const accName = (id) => ((s.accounts || []).find((a) => a.id === id) || {}).name || (id ? '?' : 'Otra');
    const alerts = (a) => (a && a.length ? a : [3, 0]).join(',');
    return {
      'Movimientos': s.movements.map((m) => {
        const row = {
          'ID': m.id, 'Fecha': m.date, 'Tipo': TYPE_LABEL[m.type] || 'Gasto',
          'Categoría': m.type === 'inc' ? INCOME_GROUP : m.type === 'save' ? SAVE_TYPE : code(m.cat),
          'Subcategoría': m.type === 'exp' ? (m.sub || '') : m.type === 'save' ? goalName(m.goalId) || m.cat : m.cat,
          'Moneda': m.cur, 'Importe': m.amount, 'Medio de pago': m.method || '', 'Comentarios': m.note || '',
          'Pagó': m.paidBy || '',
        };
        if (m.type === 'save') row['Meta ID'] = m.goalId || '';
        if (m.type === 'xfer') {
          Object.assign(row, { 'Categoría': XFER_TYPE, 'Subcategoría': `${accName(m.from)} → ${accName(m.to)}`, 'Medio de pago': '',
            'Origen ID': m.from || '', 'Destino ID': m.to || '' });
        }
        if (m.receivableId) row['Por cobrar ID'] = m.receivableId;
        return row;
      }),
      'Ingresos esperados': (s.incomePlan || []).map((p) => ({
        'ID': p.id, 'Nombre': p.name, 'Subcategoría': p.cat, 'Moneda': p.cur, 'Importe': p.amount, 'Días de cobro': p.days.join(', '), 'Activa': 'Sí',
      })),
      'Cuentas y bienes': (s.accounts || []).map((a) => ({
        'ID': a.id, 'Nombre': a.name, 'Tipo': a.kind, 'Moneda': a.cur, 'Activa': 'Sí', 'Comentarios': a.note || '',
      })),
      // Solo si se leyó de la planilla: sin filas cargadas no se manda nada (y no se borra el presupuesto).
      ...(Array.isArray(s.budgetRows) && s.synced ? { 'Presupuesto': s.budgetRows.map((r) => ({ ...r })) } : {}),
      'Saldos': (s.balances || []).map((b) => {
        const a = (s.accounts || []).find((x) => x.id === b.accountId);
        // Si la cuenta se quitó de la lista, sus saldos quedan como estaban en la planilla.
        return a ? { 'Cuenta ID': b.accountId, 'Cuenta': a.name, 'Mes': b.month + '-01', 'Moneda': a.cur, 'Saldo': b.amount }
          : { 'Cuenta ID': b.accountId, 'Mes': b.month + '-01', 'Saldo': b.amount };
      }),
      'Metas': (s.goals || []).map((g) => ({
        'ID': g.id, 'Nombre': g.name, 'Monto objetivo': g.target, 'Moneda': g.cur, 'Fecha objetivo': g.due || '',
        'Ahorro inicial': g.initial || 0, 'Activa': 'Sí', 'Comentarios': g.note || '',
      })),
      'Facturas': s.bills.map((b) => ({
        'ID': b.id, 'Nombre': b.name, 'Categoría': code(b.cat), 'Subcategoría': b.sub || '', 'Moneda': b.cur, 'Importe': b.amount,
        'Vence': b.due, 'Pagada': b.paid ? 'Sí' : 'No', 'Fecha de pago': b.paid ? (b.paidAt || '') : '',
        'Medio de pago': b.method || '', 'Recurrente ID': b.templateId || '', 'Préstamo ID': b.loanId || '',
        'Avisos (días antes)': alerts(b.alerts),
      })),
      'Recurrentes': s.recurring.filter((r) => !r.loanId).map((r) => ({
        'ID': r.id, 'Nombre': r.name, 'Categoría': code(r.cat), 'Subcategoría': r.sub || '', 'Moneda': r.cur,
        'Importe': r.amount, 'Día': r.day, 'Avisos (días antes)': alerts(r.alerts), 'Activa': 'Sí',
        ...(r.startMonth ? { 'Desde': r.startMonth } : {}),
      })),
      'Por cobrar': s.receivables.map((r) => {
        const st = receivableInfo(s, r).status;
        return {
          'ID': r.id, 'Fecha de emisión': r.issued || '', 'Cliente': r.client, 'Moneda': r.cur, 'Valor': r.amount, 'Vence': r.due,
          'Estado': st === 'done' ? 'Cobrada' : st === 'partial' ? 'Parcial' : 'Pendiente', 'Fecha de cobro': r.collected ? (r.collectedAt || '') : '',
          'Movimiento ID': r.incomeId || '',
          'Retención': r.withheld || '',
        };
      }),
      'Categorías': [
        ...s.categories.flatMap((c) => (c.subs.length ? c.subs : ['']).map((sub) => ({
          'Categoría': c.group || code(c.name), 'Subcategoría': sub, 'Tipo': 'Gasto' }))),
        ...s.incomeCats.map((sub) => ({ 'Categoría': INCOME_GROUP, 'Subcategoría': sub, 'Tipo': 'Ingreso' })),
      ],
      'Ajustes': [
        { 'Ajuste': SETTING_KEYS.USD, 'Valor': s.settings.rates.USD },
        { 'Ajuste': SETTING_KEYS.ARS, 'Valor': s.settings.rates.ARS },
        { 'Ajuste': SETTING_KEYS.threshold, 'Valor': s.settings.threshold / 100 },
      ],
    };
  }

  const ROW_KEYS = { 'Categorías': ['Categoría', 'Subcategoría'], 'Ajustes': ['Ajuste'], 'Saldos': ['Cuenta ID', 'Mes'],
    'Presupuesto': ['Mes', 'Categoría', 'Subcategoría'] };
  const rowKey = (table, row) => (ROW_KEYS[table] || ['ID']).map((k) => str(row[k])).join('|');

  const BASELINE_TABLES = ['Presupuesto'];

  // Cambios entre dos versiones de las filas: upsert de lo nuevo o modificado, delete de lo que ya no está.
  // Una columna que la versión anterior no conocía (por ejemplo «Pagó») cuenta como vacía, así una
  // actualización de la app no reenvía todas las filas.
  const sameRow = (a, b) => Object.keys(b).every((k) => JSON.stringify(a[k] ?? '') === JSON.stringify(b[k] ?? ''))
    && Object.keys(a).every((k) => k in b);
  function diffRows(prev, next) {
    const ops = [];
    const group = (rows) => {
      const m = new Map();
      for (const r of rows || []) { const k = rowKey(table, r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      return m;
    };
    let table;
    for (table of Object.keys(next)) {
      // Pestaña que la app empieza a escribir en esta versión: la primera vez solo se toma como punto de partida.
      if (prev && !prev[table] && BASELINE_TABLES.includes(table)) continue;
      const before = group(prev && prev[table]);
      const after = group(next[table]);
      for (const [k, rows] of after) {
        const olds = before.get(k) || [];
        if (olds.length > 1 || rows.length > 1) {
          // Filas repetidas con la misma clave (cargadas así a mano): si cambiaron, se reemplazan todas.
          if (JSON.stringify(olds) === JSON.stringify(rows)) continue;
          ops.push({ table, op: 'delete', row: olds[0] });
          rows.forEach((row) => ops.push({ table, op: 'upsert', row }));
          continue;
        }
        const row = rows[0];
        const old = olds[0];
        if (!old) { ops.push({ table, op: 'upsert', row }); continue; }
        if (sameRow(old, row)) continue;
        // Fila existente: solo la clave y lo que cambió, así no se pisan los cambios del otro en otras columnas.
        const part = {};
        for (const kc of ROW_KEYS[table] || ['ID']) part[kc] = row[kc];
        for (const c of Object.keys(row)) if (JSON.stringify(old[c] ?? '') !== JSON.stringify(row[c] ?? '')) part[c] = row[c];
        ops.push({ table, op: 'upsert', row: part });
      }
      for (const [k, olds] of before) if (!after.has(k)) ops.push({ table, op: 'delete', row: olds[0] });
    }
    return ops;
  }

  // Lee el enlace de conexión que arma la planilla: #conectar=URL&token=...&quien=Alan
  function parseConnectHash(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const url = (p.get('conectar') || '').trim();
    const token = (p.get('token') || '').trim();
    if (!url || !token || !/^https:\/\/script\.google(usercontent)?\.com\//i.test(url)) return null;
    return { url, token, user: (p.get('quien') || '').trim() };
  }

  // Acepta el enlace de conexión como venga pegado: completo, solo la parte después del #, con el # convertido
  // en %23 por la app desde donde se copió, con espacios o saltos de línea de WhatsApp o del mail.
  function parseConnectLink(raw) {
    let s = String(raw || '').replace(/\s+/g, '');
    if (!/conectar(=|%3D)/i.test(s)) return null;
    if (!/conectar=/i.test(s)) { try { s = decodeURIComponent(s); } catch (e) { return null; } }
    s = s.replace(/%23conectar=/i, '#conectar=');
    const i = s.search(/conectar=/i);
    return parseConnectHash('conectar=' + s.slice(i + 'conectar='.length));
  }

  const api = {
    catLabel, parseAlerts, budgetLimits, budgetRowsFor, sheetToState, stateToRows, diffRows, parseConnectHash, parseConnectLink,
    toISO, parseISO, todayISO, monthKey, dayOf, addMonths, daysInMonth, dateInMonth, daysBetween,
    monthName, monthLabel, shortDate, longDate, uid, MONTHS, MON,
    CURRENCIES, convert, formatMoney, formatShort, cleanDigits, groupDigits, toCOP,
    ensureRecurring, dueInfo, isUrgent, groupBills, dayDot, calendarCells,
    elapsedDays, categoryStats, monthSummary, buildAlerts, monthSeries, dailySpend, filterMovements,
    peopleOf, personOf, suggestCategory, spendByPerson, goalProgress,
    ACCOUNT_KINDS, kindClass, accountBalance, loanBalanceAt, incomeStatement, balanceSheet, cashFlow,
    retentionsAt, parseDays, inferIncomePlan, paycheckPlan, netWorthSeries, debtPlan, receivableInfo,
    toICS, toCSV, parseMovementRows, parseNumber, cellToISO, parseReceipt,
    baseState, sampleState, normalizeState, clearSamples,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CasaLib = api;
})(typeof window !== 'undefined' ? window : globalThis);
