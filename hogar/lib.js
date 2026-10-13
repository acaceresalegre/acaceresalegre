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
    return state.categories.map((c) => {
      const movs = state.movements.filter((m) => m.type === 'exp' && m.cat === c.name && monthKey(m.date) === key);
      const bills = state.bills.filter((b) => b.cat === c.name && monthKey(b.due) === key);
      const variable = movs.reduce((s, m) => s + toCOP(m, rates), 0);
      const paidBills = bills.filter((b) => b.paid).reduce((s, b) => s + toCOP(b, rates), 0);
      const allBills = bills.reduce((s, b) => s + toCOP(b, rates), 0);
      const spent = variable + paidBills;
      const projection = (elapsed ? (variable / elapsed) * dim : 0) + allBills;
      const limit = Number(c.limit) || 0;
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
    const expense = variable + paid;
    return { income, expense, pending, balance: income - expense, remaining: income - expense - pending, hasData: income + expense > 0 };
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
      if (q && !norm([m.note, m.cat, m.sub, m.method].join(' ')).includes(q)) return false;
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
    return { list, income, expense, net: income - expense };
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
    state.receivables.filter((r) => !r.collected && r.due < today)
      .forEach((r) => out.push({ kind: 'recv', id: r.id, tone: 'neutral', title: `Por cobrar: ${r.client}`, sub: `Venció hace ${daysBetween(r.due, today)} días · ${money(toCOP(r, rates))}` }));
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

  function toCSV(state) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Fecha', 'Tipo', 'Categoría', 'Subcategoría', 'Descripción', 'Moneda', 'Importe', 'Medio de pago']];
    for (const m of [...state.movements].sort((a, b) => a.date.localeCompare(b.date))) {
      rows.push([m.date, m.type === 'inc' ? 'Ingreso' : 'Gasto', m.cat, m.sub, m.note, m.cur, m.amount, m.method]);
    }
    for (const b of state.bills.filter((x) => x.paid).sort((a, z) => a.due.localeCompare(z.due))) {
      rows.push([b.due, 'Factura', b.cat, b.sub, b.name, b.cur, b.amount, b.method]);
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

  function parseReceipt(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const merchant = (lines.find((l) => (l.match(/[a-záéíóúñ]/gi) || []).length >= 3) || '').replace(/\s{2,}/g, ' ').slice(0, 40);
    const amountsIn = (l) => (l.match(/\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g) || []).map(parseNumber).filter((n) => n > 0);
    let total = 0;
    const totalLine = [...lines].reverse().find((l) => /total/i.test(l) && !/sub\s*-?total/i.test(l) && amountsIn(l).length);
    if (totalLine) total = Math.max(...amountsIn(totalLine));
    if (!total) total = Math.max(0, ...lines.flatMap((l) => amountsIn(l).filter((n) => n < 1e9)));
    const dateMatch = lines.map((l) => cellToISO(l)).find(Boolean) || null;
    let cat = null;
    let sub = '';
    for (const [re, c, s] of CATEGORY_HINTS) {
      if (re.test(text)) { cat = c; sub = s; break; }
    }
    return { merchant, total: Math.round(total), date: dateMatch, cat, sub };
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

  // Cuotas de la hoja "Deudas" (vencimientos de octubre 2026).
  const LOANS = [
    ['Hipoteca N°1', 'COP', 1551582, 8, 'Hipoteca'],
    ['Hipoteca N°2', 'COP', 1763226, 26, 'Hipoteca'],
    ['Préstamo N°1', 'ARS', 173089, 10, 'Préstamo'],
    ['Préstamo N°2', 'ARS', 127592, 10, 'Préstamo'],
    ['Préstamo N°3', 'COP', 1162496, 30, 'Préstamo'],
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
    // Pagadas las vencidas, salvo los préstamos N°1 y N°2 (ejemplo de alerta).
    for (const b of s.bills) {
      if (b.due < today && !/Préstamo N°[12]/.test(b.name)) { b.paid = true; b.method = 'Transferencia'; }
    }
    const mov = (d, type, cat, sub, note, amount, method, cur = 'COP') => {
      if (d <= td) s.movements.push({ id: uid(), date: `${key}-${pad(d)}`, type, cat, sub, note, amount, cur, method, sample: true });
    };
    mov(1, 'inc', 'Sueldo Alan', '', 'Sueldo octubre', 9800000, 'Transferencia');
    mov(1, 'inc', 'Sueldo Karo', '', 'Sueldo octubre', 7600000, 'Transferencia');
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
    for (const k of ['categories', 'incomeCats', 'methods', 'loans', 'recurring', 'bills', 'movements', 'receivables']) {
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
  const SETTING_KEYS = { USD: 'Tasa USD (COP por 1 USD)', ARS: 'Tasa ARS (COP por 1 ARS)', threshold: 'Umbral de aviso de presupuesto' };

  function parseAlerts(v) {
    if (typeof v === 'number') return [v];
    const list = String(v ?? '').split(/[,;\s]+/).filter((x) => x !== '').map(Number).filter((n) => !isNaN(n) && n >= 0);
    return list.length ? list : [3, 0];
  }

  const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
  const num = (v) => (typeof v === 'number' ? v : parseNumber(v) || 0);

  // Límite de cada categoría para el mes: suma del presupuesto del mes, o del mismo mes del año anterior.
  function budgetLimits(rows, key, rates) {
    const pick = (k) => rows.filter((r) => str(r['Mes']).slice(0, 7) === k);
    let month = pick(key);
    if (!month.length) month = pick(addMonths(key, -12));
    const out = {};
    for (const r of month) {
      out[r['Categoría']] = (out[r['Categoría']] || 0) + convert(num(r['Importe']), str(r['Moneda']) || 'COP', 'COP', rates);
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
    const limits = budgetLimits(t('Presupuesto'), monthKey(today), s.settings.rates);
    s.categories = [...groups].map(([code, subs]) => ({ name: label(code), group: code, limit: Math.round(limits[code] || 0), subs }));
    if (incomes.length) s.incomeCats = incomes;
    const methods = t('Listas').map((r) => str(r['Medio de pago'])).filter(Boolean);
    if (methods.length) s.methods = methods;

    s.movements = t('Movimientos').filter((r) => r['ID'] && r['Fecha']).map((r) => {
      const inc = str(r['Tipo']) === 'Ingreso' || str(r['Categoría']) === INCOME_GROUP;
      return {
        id: str(r['ID']), date: str(r['Fecha']), type: inc ? 'inc' : 'exp',
        cat: inc ? str(r['Subcategoría']) : label(r['Categoría']), sub: inc ? '' : str(r['Subcategoría']),
        note: str(r['Comentarios']), amount: num(r['Importe']), cur: str(r['Moneda']) || 'COP', method: str(r['Medio de pago']),
      };
    });
    s.bills = t('Facturas').filter((r) => r['ID'] && r['Vence']).map((r) => ({
      id: str(r['ID']), templateId: str(r['Recurrente ID']) || null, name: str(r['Nombre']), cat: label(r['Categoría']),
      sub: str(r['Subcategoría']), amount: num(r['Importe']), cur: str(r['Moneda']) || 'COP', due: str(r['Vence']),
      paid: str(r['Pagada']) === 'Sí', paidAt: str(r['Fecha de pago']) || null, method: str(r['Medio de pago']),
      loanId: str(r['Préstamo ID']) || null, alerts: parseAlerts(r['Avisos (días antes)']),
    }));
    s.recurring = t('Recurrentes').filter((r) => r['ID'] && str(r['Activa']) !== 'No').map((r) => ({
      id: str(r['ID']), name: str(r['Nombre']), cat: label(r['Categoría']), sub: str(r['Subcategoría']),
      amount: num(r['Importe']), cur: str(r['Moneda']) || 'COP', day: num(r['Día']) || 1, alerts: parseAlerts(r['Avisos (días antes)']),
    }));
    s.receivables = t('Por cobrar').filter((r) => r['ID']).map((r) => ({
      id: str(r['ID']), client: str(r['Cliente']), issued: str(r['Fecha de emisión']) || null, due: str(r['Vence']),
      amount: num(r['Valor']), cur: str(r['Moneda']) || 'COP', collected: str(r['Estado']) === 'Cobrada',
      incomeId: str(r['Movimiento ID']) || null, collectedAt: str(r['Fecha de cobro']) || null,
    }));
    s.loans = t('Deudas').filter((r) => r['ID']).map((r) => ({
      id: str(r['ID']), name: str(r['Préstamo']), cur: str(r['Moneda']) || 'COP', installment: num(r['Próxima cuota']),
      day: num(r['Día de vencimiento']) || null, balance: r['Saldo actual'] === undefined ? null : num(r['Saldo actual']),
      capital: num(r['Capital']) || null, paidCount: r['Cuotas vencidas'] === undefined ? null : num(r['Cuotas vencidas']),
      totalCount: num(r['Plazo (cuotas)']) || null,
    }));
    s.catCodes = codes;
    s.synced = true;
    return s;
  }

  // Filas que la app puede escribir, por pestaña (solo las columnas que la app conoce).
  function stateToRows(s) {
    const code = (labelName) => (s.catCodes && s.catCodes[labelName]) || labelName;
    const alerts = (a) => (a && a.length ? a : [3, 0]).join(',');
    return {
      'Movimientos': s.movements.map((m) => ({
        'ID': m.id, 'Fecha': m.date, 'Tipo': m.type === 'inc' ? 'Ingreso' : 'Gasto',
        'Categoría': m.type === 'inc' ? INCOME_GROUP : code(m.cat), 'Subcategoría': m.type === 'inc' ? m.cat : (m.sub || ''),
        'Moneda': m.cur, 'Importe': m.amount, 'Medio de pago': m.method || '', 'Comentarios': m.note || '',
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
      })),
      'Por cobrar': s.receivables.map((r) => ({
        'ID': r.id, 'Fecha de emisión': r.issued || '', 'Cliente': r.client, 'Moneda': r.cur, 'Valor': r.amount, 'Vence': r.due,
        'Estado': r.collected ? 'Cobrada' : 'Pendiente', 'Fecha de cobro': r.collected ? (r.collectedAt || '') : '',
        'Movimiento ID': r.incomeId || '',
      })),
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

  const ROW_KEYS = { 'Categorías': ['Categoría', 'Subcategoría'], 'Ajustes': ['Ajuste'] };
  const rowKey = (table, row) => (ROW_KEYS[table] || ['ID']).map((k) => str(row[k])).join('|');

  // Cambios entre dos versiones de las filas: upsert de lo nuevo o modificado, delete de lo que ya no está.
  function diffRows(prev, next) {
    const ops = [];
    for (const table of Object.keys(next)) {
      const before = new Map((prev && prev[table] || []).map((r) => [rowKey(table, r), JSON.stringify(r)]));
      const seen = new Set();
      for (const row of next[table]) {
        const k = rowKey(table, row);
        seen.add(k);
        if (before.get(k) !== JSON.stringify(row)) ops.push({ table, op: 'upsert', row });
      }
      for (const r of (prev && prev[table]) || []) {
        if (!seen.has(rowKey(table, r))) ops.push({ table, op: 'delete', row: r });
      }
    }
    return ops;
  }

  // Lee el enlace de conexión que arma la planilla: #conectar=URL&token=...&quien=Alan
  function parseConnectHash(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const url = p.get('conectar');
    const token = p.get('token');
    if (!url || !token || !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return null;
    return { url, token, user: p.get('quien') || '' };
  }

  const api = {
    catLabel, parseAlerts, budgetLimits, sheetToState, stateToRows, diffRows, parseConnectHash,
    toISO, parseISO, todayISO, monthKey, dayOf, addMonths, daysInMonth, dateInMonth, daysBetween,
    monthName, monthLabel, shortDate, longDate, uid, MONTHS, MON,
    CURRENCIES, convert, formatMoney, formatShort, cleanDigits, groupDigits, toCOP,
    ensureRecurring, dueInfo, isUrgent, groupBills, dayDot, calendarCells,
    elapsedDays, categoryStats, monthSummary, buildAlerts, monthSeries, dailySpend, filterMovements,
    toICS, toCSV, parseMovementRows, parseNumber, cellToISO, parseReceipt,
    baseState, sampleState, normalizeState, clearSamples,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CasaLib = api;
})(typeof window !== 'undefined' ? window : globalThis);
