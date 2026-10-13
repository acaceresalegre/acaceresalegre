(function () {
  'use strict';

  const L = window.CasaLib;
  const STORAGE_KEY = 'cuentas-casa-v1';
  const SYNC_KEY = 'cuentas-casa-sync';
  const POLL_MS = 20000;
  const XLSX_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const today = L.todayISO();
  const curMonth = L.monthKey(today);

  // ---------- Estado ----------
  function load() {
    let s = null;
    try { s = L.normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)), today); } catch (e) { /* datos dañados */ }
    s = s || L.sampleState(today);
    if (!s.synced) {
      L.ensureRecurring(s, curMonth);
      L.ensureRecurring(s, L.addMonths(curMonth, 1));
    }
    return s;
  }

  let state = load();
  persist();

  const ui = {
    tab: 'inicio',
    vencMode: 'pay',
    vencMonth: curMonth,
    selDay: null,
    budMode: 'month',
    yearSel: null,
    sheet: null, // { render, mount }
  };

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { toast('No se pudo guardar en este dispositivo', 'red'); }
  }

  function save() {
    persist();
    queueChanges();
    refresh();
  }

  // ---------- Sincronización con Google Sheets ----------
  // La planilla es la fuente de verdad. Cada cambio local se compara contra la última versión
  // recibida y se envía como upsert/delete; si no hay conexión queda pendiente y se reintenta.
  const sync = loadSync();
  const isSynced = () => Boolean(sync.url && state.synced);

  function loadSync() {
    try { return { pending: [], ...JSON.parse(localStorage.getItem(SYNC_KEY)) }; } catch (e) { return { pending: [] }; }
  }

  function saveSync() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) { /* sin almacenamiento */ }
  }

  function queueChanges() {
    if (!isSynced()) return;
    const rows = L.stateToRows(state);
    const ops = L.diffRows(sync.snapshot, rows);
    sync.snapshot = rows;
    if (!ops.length) return;
    sync.pending.push(...ops);
    saveSync();
    push();
  }

  async function call(method, params, body) {
    const url = sync.url + (method === 'GET' ? '?' + new URLSearchParams({ ...params, token: sync.token }) : '');
    const res = await fetch(url, method === 'GET' ? {} : { method: 'POST', body: JSON.stringify({ ...body, token: sync.token }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Error de la planilla');
    return data;
  }

  function applyPull(data) {
    state = L.sheetToState(data.tables, state, today);
    sync.version = data.version;
    sync.snapshot = L.stateToRows(state);
    sync.lastSync = new Date().toISOString();
    sync.error = null;
    saveSync();
    persist();
    refresh();
  }

  let pushing = null;
  function push() {
    if (pushing || !sync.pending.length || !sync.url) return pushing;
    const ops = sync.pending.slice();
    pushing = call('POST', null, { user: sync.user, ops })
      .then((data) => {
        sync.pending.splice(0, ops.length);
        if (!sync.pending.length) applyPull(data);
        else saveSync();
      })
      .catch((err) => { sync.error = err.message; saveSync(); })
      .finally(() => {
        pushing = null;
        if (sync.pending.length && !sync.error) push();
        if (ui.sheet && ui.sheet.isSettings) renderSheet();
      });
    return pushing;
  }

  async function pull() {
    applyPull(await call('GET', { action: 'pull' }));
  }

  async function poll() {
    if (!isSynced() || document.visibilityState !== 'visible' || (ui.sheet && !ui.sheet.isSettings)) return;
    try {
      if (sync.pending.length) { sync.error = null; await push(); return; }
      const { version } = await call('GET', { action: 'version' });
      if (version !== sync.version) await pull();
    } catch (e) {
      sync.error = e.message;
      saveSync();
    }
  }

  async function connect(url, token, user) {
    const prev = { ...sync };
    Object.assign(sync, { url, token, user, pending: [], snapshot: null, version: null });
    try {
      const data = await call('GET', { action: 'pull' });
      if (!confirm(`Conectado a la planilla. Los datos de este dispositivo se reemplazan por los de la planilla (${data.tables['Movimientos'].length} movimientos). ¿Continuar?`)) {
        Object.assign(sync, prev);
        return;
      }
      applyPull(data);
      toast(`Sincronizado con la planilla${user ? ' como ' + user : ''}`, 'green');
    } catch (e) {
      Object.assign(sync, prev);
      saveSync();
      toast(`No se pudo conectar: ${e.message}`, 'red');
    }
  }

  function disconnect() {
    if (sync.pending.length && !confirm(`Hay ${sync.pending.length} cambios sin enviar a la planilla que se perderán. ¿Desconectar igual?`)) return;
    Object.keys(sync).forEach((k) => delete sync[k]);
    sync.pending = [];
    saveSync();
    state.synced = false;
    persist();
    toast('Desconectado de la planilla. Los datos quedan en este dispositivo.');
    refresh();
  }

  // ---------- Formato ----------
  const rates = () => state.settings.rates;
  const dc = () => state.settings.displayCur;
  const cop = (item) => L.toCOP(item, rates());
  const money = (copAmount) => L.formatMoney(L.convert(copAmount, 'COP', dc(), rates()), dc());
  const short = (copAmount) => L.formatShort(L.convert(copAmount, 'COP', dc(), rates()), dc());
  const orig = (item) => L.formatMoney(item.amount, item.cur);
  const shown = (item) => (item.cur === dc() ? orig(item) : money(cop(item)));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const pctTxt = (n) => `${Math.round(n)}%`;
  const TONE = { over: 'red', near: 'amber', proj: 'amber', ok: '' };

  // ---------- Toast y notificación ----------
  function toast(msg, tone) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show ' + (tone || '');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function showOverdueNotice() {
    const overdue = state.bills.filter((b) => !b.paid && b.due < today).sort((a, b) => a.due.localeCompare(b.due));
    if (!overdue.length) return;
    const names = overdue.map((b) => b.name);
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
    const total = overdue.reduce((s, b) => s + cop(b), 0);
    const el = $('#notif');
    el.innerHTML = `<span class="ico">$</span><span><b>Cuentas Casa</b><small>${esc(who)} ${names.length === 1 ? 'venció' : 'vencieron'} · ${esc(money(total))} sin pagar</small></span>`;
    el.onclick = () => { el.classList.remove('show'); openBill(overdue[0].id); };
    setTimeout(() => el.classList.add('show'), 600);
    setTimeout(() => el.classList.remove('show'), 7600);
  }

  // ---------- Componentes ----------
  function header(sub, title) {
    const curs = L.CURRENCIES.map((c) => `<button class="${c === dc() ? 'on' : ''}" data-act="cur" data-v="${c}">${c}</button>`).join('');
    return `<header class="hdr">
      <div><div class="sub">${esc(sub)}</div><h1>${esc(title)}</h1></div>
      <div class="seg" role="group" aria-label="Moneda">${curs}<button data-act="settings" aria-label="Ajustes">⋯</button></div>
    </header>`;
  }

  const scanIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/></svg>';

  function billRow(b) {
    const info = L.dueInfo(b, today);
    const tone = info.state === 'paid' ? 'green' : info.tone;
    return `<div class="bill ${b.paid ? 'paid' : ''}">
      <button class="check ${b.paid ? 'on' : info.state === 'overdue' ? 'over' : ''}" data-act="toggle-bill" data-id="${b.id}" aria-label="${b.paid ? 'Desmarcar pago' : 'Marcar como pagada'}"><i>${b.paid ? '✓' : ''}</i></button>
      <button class="body" data-act="bill" data-id="${b.id}">
        <span class="grow"><div class="name">${esc(b.name)}</div><div class="due ${tone ? 'tone-' + tone : ''}">${esc(info.label)}</div></span>
        <span class="right"><b class="amt">${esc(shown(b))}</b><small>${esc(b.cat)}</small></span>
      </button>
    </div>`;
  }

  function movRow(m) {
    const title = m.note || m.sub || m.cat;
    const sub = [m.cat, m.sub, `día ${L.dayOf(m.date)}`].filter(Boolean).join(' · ');
    return `<button class="mov" data-act="mov" data-id="${m.id}">
      <span class="grow"><b>${esc(title)}</b><small>${esc(sub)}</small></span>
      <span class="amt ${m.type === 'inc' ? 'inc' : ''}">${m.type === 'inc' ? '+' : ''}${esc(shown(m))}</span>
    </button>`;
  }

  function alertRow(a) {
    return `<button class="alert ${a.tone}" data-act="alert" data-kind="${a.kind}" data-id="${esc(a.id)}">
      <span class="dot ${a.tone}"></span><span><b>${esc(a.title)}</b><small>${esc(a.sub)}</small></span>
    </button>`;
  }

  function bar(pct, cls, opts = {}) {
    const fill = `<div class="fill ${cls || ''}" style="width:${Math.min(100, Math.max(0, pct))}%"></div>`;
    const mark = opts.mark != null ? `<div class="mark ${opts.markCls || ''}" style="left:calc(${Math.min(100, Math.max(0, opts.mark))}% - 1px)"></div>` : '';
    return `<div class="bar ${opts.size || ''}">${fill}${mark}</div>`;
  }

  const urgentBills = () => state.bills.filter((b) => !b.paid && L.isUrgent(L.dueInfo(b, today)));

  // ---------- Pantalla: Inicio ----------
  function renderInicio() {
    const sum = L.monthSummary(state, curMonth);
    const alerts = L.buildAlerts(state, today);
    const upcoming = state.bills.filter((b) => !b.paid).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 4);
    const stats = L.categoryStats(state, curMonth, today);
    const limit = stats.reduce((s, c) => s + c.limit, 0);
    const spent = stats.reduce((s, c) => s + c.spent, 0);
    const movs = [...state.movements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

    return header(L.longDate(today), 'Cuentas Casa') + `
      <section class="dark">
        <div class="lbl">Saldo de ${esc(L.monthName(curMonth))}</div>
        <div class="big num">${esc(money(sum.balance))}</div>
        <div class="cols">
          <div><span class="lbl">Ingresos</span><b class="num inc">${esc(money(sum.income))}</b></div>
          <div><span class="lbl">Gastos</span><b class="num">${esc(money(sum.expense))}</b></div>
        </div>
        <hr>
        <div class="line"><span>Facturas por pagar</span><b class="num">${esc(money(sum.pending))}</b></div>
        <div class="line"><span>Te quedaría a fin de mes</span><b class="num ${sum.remaining < 0 ? 'neg' : ''}">${esc(money(sum.remaining))}</b></div>
      </section>

      <button class="shortcut" data-act="scan">
        <span class="ico">${scanIcon}</span>
        <span class="grow"><b>Escanear ticket o factura</b><small>Leé el total y la fecha desde una foto</small></span>
        <span class="chev">›</span>
      </button>

      <section class="sec">
        <div class="sec-head"><h2>Alertas</h2>${alerts.length > 4 ? `<button class="link" data-act="all-alerts">Ver todas (${alerts.length})</button>` : ''}</div>
        <div class="stack">${alerts.length ? alerts.slice(0, 4).map(alertRow).join('') : '<div class="card empty">Todo en orden. Sin alertas por ahora.</div>'}</div>
      </section>

      <section class="sec">
        <div class="sec-head"><h2>Próximos vencimientos</h2><button class="link" data-act="tab" data-v="vencimientos">Ver calendario</button></div>
        <div class="stack">${upcoming.length ? upcoming.map(billRow).join('') : '<div class="card empty">No hay facturas pendientes.</div>'}</div>
      </section>

      <section class="sec">
        <button class="card r20 tap" data-act="tab" data-v="presupuesto">
          <div class="sec-head" style="margin-bottom:10px"><h2>Presupuesto del mes</h2><span class="pct num">${limit ? pctTxt((spent / limit) * 100) : '—'}</span></div>
          ${bar(limit ? (spent / limit) * 100 : 0, spent > limit ? 'red' : '')}
          <div class="meta"><span>Gastaste ${esc(money(spent))} de ${esc(money(limit))} · día ${L.dayOf(today)} de ${L.daysInMonth(curMonth)}</span></div>
        </button>
      </section>

      <section class="sec">
        <div class="sec-head"><h2>Últimos movimientos</h2></div>
        <div class="list-card">${movs.length ? movs.map(movRow).join('') : '<div class="empty">Sin movimientos este mes</div>'}</div>
      </section>`;
  }

  // ---------- Pantalla: Vencimientos ----------
  function renderVencimientos() {
    const pending = state.bills.filter((b) => !b.paid && L.monthKey(b.due) <= curMonth);
    const sub = `${pending.length} por pagar · ${money(pending.reduce((s, b) => s + cop(b), 0))}`;
    const seg = `<div class="seg wide">
      <button class="${ui.vencMode === 'pay' ? 'on' : ''}" data-act="venc-mode" data-v="pay">Por pagar</button>
      <button class="${ui.vencMode === 'collect' ? 'on' : ''}" data-act="venc-mode" data-v="collect">Por cobrar</button>
    </div>`;
    return header(sub, 'Vencimientos') + seg + (ui.vencMode === 'pay' ? renderPorPagar() : renderPorCobrar());
  }

  function renderPorPagar() {
    const key = ui.vencMonth;
    const monthBills = state.bills.filter((b) => L.monthKey(b.due) === key);
    const byDay = {};
    monthBills.forEach((b) => (byDay[b.due] = byDay[b.due] || []).push(b));
    const cells = L.calendarCells(key).map((iso) => {
      if (!iso) return '<div class="cell"></div>';
      const dot = L.dayDot(byDay[iso] || [], today);
      const cls = ['cell', iso < today ? 'past' : '', iso === today ? 'today' : '', iso === ui.selDay ? 'sel' : ''].join(' ');
      return `<button class="${cls}" data-act="day" data-v="${iso}" aria-label="${esc(L.longDate(iso))}"><span class="c">${L.dayOf(iso)}</span>${dot ? `<span class="d ${dot}"></span>` : ''}</button>`;
    }).join('');

    let list;
    if (ui.selDay) {
      const bills = (byDay[ui.selDay] || []);
      list = `<div class="filter-bar"><span>Vence el ${esc(L.shortDate(ui.selDay))}</span><button class="link" data-act="day" data-v="">Ver todo ✕</button></div>
        <div class="stack" style="margin-top:10px">${bills.length ? bills.map(billRow).join('') : '<div class="card empty">Nada vence este día</div>'}</div>`;
    } else {
      const earlierOverdue = state.bills.filter((b) => !b.paid && b.due < today && L.monthKey(b.due) < key);
      const g = L.groupBills([...earlierOverdue, ...monthBills], today);
      const block = (title, tone, items) => (items.length
        ? `<div class="group-title ${tone}">${title} · ${items.length}</div><div class="stack">${items.map(billRow).join('')}</div>` : '');
      list = block('Vencidas', 'red', g.overdue) + block('Próximos 7 días', 'amber', g.week) +
        block('Más adelante', '', g.later) + block('Pagadas', 'green', g.paid);
      if (!list) list = '<div class="card empty" style="margin-top:18px">No hay facturas este mes</div>';
    }

    return `<section class="card r22">
        <div class="cal-nav">
          <button data-act="cal-month" data-v="-1" aria-label="Mes anterior">‹</button>
          <b>${esc(L.monthLabel(key))}</b>
          <button data-act="cal-month" data-v="1" aria-label="Mes siguiente">›</button>
        </div>
        <div class="cal">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells}</div>
        <div class="legend"><span><i class="dot red"></i>Vencida</span><span><i class="dot amber"></i>Por vencer</span><span><i class="dot green"></i>Pagada</span></div>
      </section>
      <div class="card setting-row" style="margin-top:12px">
        <span><b>Agregar al calendario</b><small>Eventos a las 9:00 con tus avisos</small></span>
        <button class="pill on" data-act="ics">Descargar</button>
      </div>
      ${list}
      <button class="dashed" data-act="add" data-v="bill">+ Nueva factura</button>`;
  }

  function renderPorCobrar() {
    const pend = state.receivables.filter((r) => !r.collected).sort((a, b) => a.due.localeCompare(b.due));
    const done = state.receivables.filter((r) => r.collected).sort((a, b) => b.due.localeCompare(a.due));
    const total = pend.reduce((s, r) => s + cop(r), 0);
    const overdue = pend.filter((r) => r.due < today).length;
    const row = (r) => {
      const d = L.daysBetween(today, r.due);
      const when = d < 0 ? `hace ${-d} días` : d === 0 ? 'hoy' : `en ${d} días`;
      return `<div class="bill ${r.collected ? 'paid' : ''}" style="padding-left:14px">
        <div class="body"><span class="grow"><div class="name">${esc(r.client)}</div>
          <div class="due ${!r.collected && d < 0 ? 'tone-red' : ''}">Vence el ${esc(L.shortDate(r.due))} · ${when}</div></span>
          <span class="right"><b class="amt">${esc(shown(r))}</b></span></div>
        <button class="pill ${r.collected ? '' : 'on'}" style="margin-left:10px" data-act="recv-toggle" data-id="${r.id}">${r.collected ? 'Deshacer' : 'Cobrada'}</button>
      </div>`;
    };
    return `<section class="dark">
        <div class="lbl">Pendiente de cobro</div>
        <div class="big num">${esc(money(total))}</div>
        <hr>
        <div class="line"><span>Facturas pendientes</span><b>${pend.length}</b></div>
        <div class="line"><span>Vencidas</span><b class="${overdue ? 'neg' : ''}">${overdue}</b></div>
      </section>
      ${pend.length ? `<div class="group-title">Pendientes</div><div class="stack">${pend.map(row).join('')}</div>` : '<div class="card empty" style="margin-top:18px">Todo cobrado</div>'}
      ${done.length ? `<div class="group-title green">Cobradas</div><div class="stack">${done.map(row).join('')}</div>` : ''}
      <button class="dashed" data-act="recv-add">+ Nueva factura emitida</button>`;
  }

  // ---------- Pantalla: Presupuesto ----------
  function renderPresupuesto() {
    const year = curMonth.slice(0, 4);
    const seg = `<div class="seg wide">
      <button class="${ui.budMode === 'month' ? 'on' : ''}" data-act="bud-mode" data-v="month">Este mes</button>
      <button class="${ui.budMode === 'year' ? 'on' : ''}" data-act="bud-mode" data-v="year">Año ${year}</button>
    </div>`;
    return header(L.monthLabel(curMonth), 'Presupuesto') + seg + (ui.budMode === 'month' ? renderBudgetMonth() : renderBudgetYear(year));
  }

  function statusChip(s) {
    if (!s.limit) return '<span class="chip">Sin límite</span>';
    if (s.status === 'over') return '<span class="chip red">Excedido</span>';
    if (s.status === 'near') return '<span class="chip amber">Cerca del límite</span>';
    if (s.status === 'proj') return `<span class="chip amber">Proyección ${pctTxt(s.projPct)}</span>`;
    return '';
  }

  function renderBudgetMonth() {
    const stats = L.categoryStats(state, curMonth, today);
    const limit = stats.reduce((s, c) => s + c.limit, 0);
    const spent = stats.reduce((s, c) => s + c.spent, 0);
    const proj = stats.reduce((s, c) => s + c.projection, 0);
    const day = L.dayOf(today);
    const dim = L.daysInMonth(curMonth);
    const sorted = [...stats].sort((a, b) => (b.limit ? b.pct : -1) - (a.limit ? a.pct : -1));
    const th = state.settings.threshold;

    const cards = sorted.map((s) => `
      <button class="card cat-card tap" data-act="cat" data-id="${esc(s.name)}">
        <div class="top"><span class="name">${esc(s.name)}</span>${statusChip(s)}<span class="pct num">${s.limit ? pctTxt(s.pct) : ''}</span></div>
        ${bar(s.limit ? s.pct : 0, TONE[s.status] === 'red' ? 'red' : s.status === 'near' ? 'amber' : '', { size: 'h7', mark: s.limit ? s.projPct : null, markCls: 'proj' })}
        <div class="meta"><span class="num">${esc(money(s.spent))}${s.limit ? ' de ' + esc(money(s.limit)) : ''}</span>
          ${s.limit ? `<span class="num ${s.spent > s.limit ? 'tone-red' : ''}">${s.spent > s.limit ? 'Excedido ' + esc(money(s.spent - s.limit)) : 'Quedan ' + esc(money(s.limit - s.spent))}</span>` : ''}</div>
      </button>`).join('');

    return `<section class="card r20">
        <div class="setting-row"><span><small>Gastado</small><b class="num" style="font-size:24px;font-weight:800">${esc(money(spent))}</b></span>
          <span style="text-align:right"><small>Presupuesto</small><b class="num">${esc(money(limit))}</b></span></div>
        <div style="margin-top:14px">${bar(limit ? (spent / limit) * 100 : 0, spent > limit ? 'red' : '', { size: 'h10', mark: (day / dim) * 100 })}</div>
        <div class="meta"><span>${limit ? pctTxt((spent / limit) * 100) + ' usado' : ''}</span><span>Día ${day} de ${dim}</span></div>
        <div class="notice ${proj > limit ? 'amber' : 'green'}">Al ritmo actual cerrarías el mes en ${esc(money(proj))}${limit ? ` (${pctTxt((proj / limit) * 100)} del presupuesto)` : ''}.</div>
      </section>
      <div class="card setting-row" style="margin-top:12px">
        <span><b>Avisarme al llegar al</b></span>
        <span class="seg">${[70, 80, 90].map((n) => `<button class="${n === th ? 'on' : ''}" data-act="threshold" data-v="${n}">${n}%</button>`).join('')}</span>
      </div>
      <div class="stack" style="margin-top:12px">${cards}</div>
      <button class="dashed" data-act="new-cat">+ Nueva categoría</button>`;
  }

  function renderBudgetYear(year) {
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
    const sums = months.map((k) => ({ k, ...L.monthSummary(state, k) }));
    const budget = state.categories.reduce((s, c) => s + (Number(c.limit) || 0), 0);
    const toDate = sums.filter((s) => s.k <= curMonth);
    const income = toDate.reduce((s, m) => s + m.income, 0);
    const expense = toDate.reduce((s, m) => s + m.expense, 0);
    const scale = Math.max(budget, ...sums.map((s) => s.expense)) * 1.1 || 1;

    const cols = sums.map((s, i) => {
      const h = s.hasData ? Math.max(2, (s.expense / scale) * 100) : 6;
      const cls = !s.hasData ? 'none' : s.expense > budget * 1.05 ? 'over' : '';
      return `<button class="col ${ui.yearSel === s.k ? 'sel' : ''}" data-act="year-month" data-v="${s.k}" aria-label="${L.MONTHS[i]}"><span class="b ${cls}" style="height:${h}%"></span></button>`;
    }).join('');

    // Categorías del período (mes elegido o enero → mes actual).
    const period = ui.yearSel ? [ui.yearSel] : months.filter((k) => k <= curMonth);
    const perMonth = months.map((k) => L.categoryStats(state, k, today));
    const monthsWithData = Math.max(1, period.filter((k) => L.monthSummary(state, k).hasData).length);
    const totalSpend = period.reduce((s, k) => s + perMonth[months.indexOf(k)].reduce((a, c) => a + c.spent, 0), 0);
    const rows = state.categories.map((c, ci) => {
      const series = perMonth.map((m) => m[ci].spent);
      const total = period.reduce((s, k) => s + series[months.indexOf(k)], 0);
      const ref = (Number(c.limit) || 0) * monthsWithData;
      const diff = ref ? (total / ref - 1) * 100 : null;
      return { name: c.name, total, series, diff };
    }).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
    const maxSeries = Math.max(1, ...rows.flatMap((r) => r.series));
    const worst = rows.filter((r) => r.diff != null && r.diff > 5).sort((a, b) => b.diff - a.diff)[0];

    const catRows = rows.map((r) => {
      const cmp = r.diff == null ? 'Sin límite' : r.diff > 5 ? `+${Math.round(r.diff)}% sobre` : r.diff < -5 ? `${Math.round(-r.diff)}% bajo` : 'En línea';
      const tone = r.diff != null && r.diff > 5 ? 'red' : r.diff != null && r.diff < -5 ? 'green' : '';
      return `<button class="mov" data-act="cat" data-id="${esc(r.name)}">
        <span class="grow"><b>${esc(r.name)}</b><small>${esc(short(r.total))} · ${pctTxt(totalSpend ? (r.total / totalSpend) * 100 : 0)} del gasto · <span class="${tone ? 'tone-' + tone : ''}">${cmp}</span></small></span>
        <span class="mini">${r.series.map((v, i) => `<i class="${v ? '' : 'none'}" style="height:${v ? Math.max(8, (v / maxSeries) * 100) : 8}%;${period.includes(months[i]) ? '' : 'opacity:.35'}"></i>`).join('')}</span>
      </button>`;
    }).join('');

    return `<section class="dark">
        <div class="lbl">Ahorro de enero a ${esc(L.monthName(curMonth))}</div>
        <div class="big num">${esc(short(income - expense))}</div>
        <div class="cols">
          <div><span class="lbl">Ingresos</span><b class="num inc">${esc(short(income))}</b></div>
          <div><span class="lbl">Gastos</span><b class="num">${esc(short(expense))}</b></div>
        </div>
        <hr>
        <div class="line"><span>Tasa de ahorro</span><b>${income ? pctTxt(((income - expense) / income) * 100) : '—'}</b></div>
      </section>
      <section class="card r20" style="margin-top:12px">
        <div class="sec-head"><h2>Gasto por mes</h2><span class="legend" style="margin:0"><span><i class="dot amber"></i>Presupuesto</span></span></div>
        <div class="chart">${cols}<div class="budget" style="bottom:${(budget / scale) * 100}%"></div></div>
        <div class="chart-lbl">${L.MON.map((m, i) => `<span class="${ui.yearSel === months[i] ? 'on' : ''}">${m.charAt(0).toUpperCase()}</span>`).join('')}</div>
      </section>
      <section class="sec">
        <div class="sec-head"><h2>Categorías · ${ui.yearSel ? esc(cap(L.monthName(ui.yearSel))) : 'Año'}</h2>${ui.yearSel ? '<button class="link" data-act="year-month" data-v="">Ver año ✕</button>' : ''}</div>
        <div class="list-card">${catRows || '<div class="empty">Sin movimientos en el período</div>'}</div>
        ${worst ? `<div class="notice red">La categoría que más se excedió fue ${esc(worst.name)}: ${Math.round(worst.diff)}% sobre su presupuesto.</div>` : ''}
      </section>`;
  }

  // ---------- Pantalla: Deudas ----------
  function loanBill(loan, key = curMonth) {
    return state.bills.find((b) => b.loanId === loan.id && L.monthKey(b.due) === key);
  }

  function renderDeudas() {
    const loans = state.loans;
    const known = loans.filter((l) => l.balance != null);
    const totalBalance = known.reduce((s, l) => s + cop({ amount: l.balance, cur: l.cur }), 0);
    const monthly = loans.reduce((s, l) => s + cop({ amount: l.installment, cur: l.cur }), 0);
    const paid = loans.filter((l) => (loanBill(l) || {}).paid).length;

    const cards = loans.map((l) => {
      const b = loanBill(l);
      const info = b ? L.dueInfo(b, today) : null;
      let chip = '';
      if (info) {
        if (info.state === 'paid') chip = '<span class="chip green">Pagada</span>';
        else if (info.state === 'overdue') chip = '<span class="chip red">Vencida</span>';
        else chip = `<span class="chip ${L.isUrgent(info) ? 'amber' : ''}">Vence ${L.dayOf(b.due)} ${L.MON[Number(b.due.slice(5, 7)) - 1]}</span>`;
      }
      const hasCount = l.paidCount != null && l.totalCount;
      const line = [hasCount ? `Cuota ${l.paidCount} de ${l.totalCount}` : 'Cuota mensual', l.capital ? `capital ${orig({ amount: l.capital, cur: l.cur })}` : ''].filter(Boolean).join(' · ');
      return `<button class="card cat-card tap" data-act="loan" data-id="${l.id}">
        <div class="top"><span class="name">${esc(l.name)}</span>${chip}</div>
        <div class="meta" style="margin:-4px 0 10px">${esc(line)}</div>
        ${hasCount ? bar((l.paidCount / l.totalCount) * 100, 'green', { size: 'h7' }) : ''}
        <div class="meta"><span>Saldo ${l.balance != null ? `<b class="num">${esc(orig({ amount: l.balance, cur: l.cur }))}</b>` : '—'}</span>
          <span class="num">Cuota ${esc(orig({ amount: l.installment, cur: l.cur }))} · día ${l.day}</span></div>
      </button>`;
    }).join('');

    return header('Hipotecas y préstamos', 'Deudas') + `
      <section class="dark">
        <div class="lbl">Saldo total adeudado</div>
        <div class="big num">${known.length ? esc(money(totalBalance)) : '—'}</div>
        ${known.length < loans.length ? `<div class="lbl" style="margin-top:4px">${known.length ? 'Faltan saldos: ' : ''}Tocá cada préstamo para cargar su saldo</div>` : ''}
        <hr>
        <div class="line"><span>Cuotas del mes</span><b class="num">${esc(money(monthly))}</b></div>
        <div class="line"><span>Pagadas</span><b>${paid} de ${loans.length}</b></div>
      </section>
      <div class="stack" style="margin-top:12px">${cards || '<div class="card empty">No hay préstamos cargados</div>'}</div>
      ${state.synced ? '' : '<button class="dashed" data-act="loan-new">+ Nuevo préstamo</button>'}`;
  }

  // ---------- Render ----------
  const SCREENS = { inicio: renderInicio, vencimientos: renderVencimientos, presupuesto: renderPresupuesto, deudas: renderDeudas };

  function renderScreen() {
    $('#screen').innerHTML = SCREENS[ui.tab]();
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === ui.tab));
    const n = urgentBills().length;
    const badge = $('#badge');
    badge.hidden = !n;
    badge.textContent = n;
  }

  function refresh() {
    renderScreen();
    if (ui.sheet) renderSheet();
  }

  // ---------- Hojas inferiores ----------
  function openSheet(render, mount) {
    ui.sheet = { render, mount };
    const sheet = $('#sheet');
    const scrim = $('#scrim');
    sheet.hidden = false;
    scrim.hidden = false;
    renderSheet();
    sheet.scrollTop = 0;
    requestAnimationFrame(() => { sheet.classList.add('open'); scrim.classList.add('open'); });
  }

  function renderSheet() {
    const sheet = $('#sheet');
    const top = sheet.scrollTop;
    sheet.innerHTML = '<div class="handle"></div>' + ui.sheet.render();
    sheet.scrollTop = top;
    if (ui.sheet.mount) ui.sheet.mount(sheet);
  }

  function closeSheet() {
    ui.sheet = null;
    const sheet = $('#sheet');
    const scrim = $('#scrim');
    sheet.classList.remove('open');
    scrim.classList.remove('open');
    setTimeout(() => { if (!ui.sheet) { sheet.hidden = true; scrim.hidden = true; sheet.innerHTML = ''; } }, 300);
  }

  const pills = (items, isOn, act, extra = '') => items.map(([v, label]) =>
    `<button class="pill ${isOn(v) ? 'on' : ''}" data-act="${act}" data-v="${esc(v)}" ${extra}>${esc(label)}</button>`).join('');

  // --- Detalle de factura ---
  const ALERT_OPTS = [[0, 'El mismo día'], [1, '1 día antes'], [3, '3 días antes'], [7, '7 días antes']];

  function openBill(id) {
    openSheet(() => {
      const b = state.bills.find((x) => x.id === id);
      if (!b) return '<div class="empty">La factura ya no existe.</div>';
      const info = L.dueInfo(b, today);
      const loan = b.loanId && state.loans.find((l) => l.id === b.loanId);
      const chipTone = info.state === 'paid' ? 'green' : info.tone === 'neutral' ? '' : info.tone;
      return `<h3>${esc(b.name)}</h3>
        <p class="lead"><span class="chip ${chipTone}">${esc(info.label)}</span></p>
        <div class="card">
          <div class="kv"><span>Categoría</span><b>${esc([b.cat, b.sub].filter(Boolean).join(' · '))}</b></div>
          <div class="kv"><span>Monto</span><b class="num">${esc(orig(b))}${b.cur !== dc() ? `<br><small style="color:var(--ink-2);font-weight:500">≈ ${esc(money(cop(b)))}</small>` : ''}</b></div>
          <div class="kv"><span>Vencimiento</span><b>${esc(cap(L.longDate(b.due)))}</b></div>
          ${loan && loan.balance != null ? `<div class="kv"><span>Saldo del préstamo</span><b class="num">${esc(orig({ amount: loan.balance, cur: loan.cur }))}</b></div>` : ''}
          ${b.templateId ? '<div class="kv"><span>Repetición</span><b>Todos los meses</b></div>' : ''}
        </div>
        <span class="field-label">Recordarme</span>
        <div class="pills">${pills(ALERT_OPTS, (v) => (b.alerts || []).includes(Number(v)), 'bill-alert', `data-id="${b.id}"`)}</div>
        <span class="field-label">Medio de pago</span>
        <div class="pills">${pills(state.methods.map((m) => [m, m]), (v) => v === b.method, 'bill-method', `data-id="${b.id}"`)}</div>
        <button class="primary" data-act="toggle-bill" data-id="${b.id}">${b.paid ? 'Desmarcar pago' : 'Marcar como pagada'}</button>
        <button class="secondary" data-act="ics-bill" data-id="${b.id}">Agregar al calendario</button>
        ${b.templateId ? `<button class="danger-link" data-act="bill-stop" data-id="${b.id}">Dejar de repetir</button>` : ''}
        <button class="danger-link" data-act="bill-del" data-id="${b.id}">Eliminar factura</button>`;
    });
  }

  function togglePaid(id) {
    const b = state.bills.find((x) => x.id === id);
    if (!b) return;
    const before = L.categoryStats(state, L.monthKey(b.due), today).find((s) => s.name === b.cat);
    b.paid = !b.paid;
    if (b.paid) { b.method = b.method || 'Transferencia'; b.paidAt = today; }
    const loan = b.loanId && !state.synced && state.loans.find((l) => l.id === b.loanId);
    if (loan && loan.paidCount != null) loan.paidCount = Math.max(0, loan.paidCount + (b.paid ? 1 : -1));
    if (b.paid) {
      const after = L.categoryStats(state, L.monthKey(b.due), today).find((s) => s.name === b.cat);
      if (after && after.limit && after.pct >= 100 && (!before || before.pct < 100)) toast(`Pagada. ${b.cat} superó el presupuesto (${pctTxt(after.pct)})`, 'red');
      else toast(`Pagada: ${b.name} · ${shown(b)}`, 'green');
    } else {
      toast(`Pago desmarcado: ${b.name}`);
    }
    save();
  }

  // --- Detalle de categoría ---
  function openCategory(name) {
    const c = state.categories.find((x) => x.name === name);
    if (!c) return;
    let digits = String(Math.round(c.limit || 0));
    openSheet(() => {
      const s = L.categoryStats(state, curMonth, today).find((x) => x.name === name);
      const items = [...s.movs.map((m) => ({ ...m, kind: 'mov', d: m.date })), ...s.bills.map((b) => ({ ...b, kind: 'bill', d: b.due }))]
        .sort((a, b) => b.d.localeCompare(a.d));
      return `<h3>${esc(name)}</h3>
        <p class="lead">${esc(cap(L.monthLabel(curMonth)))} ${statusChip(s)}</p>
        <div class="card">
          <div class="kv"><span>Gastado</span><b class="num">${esc(money(s.spent))}</b></div>
          <div class="kv"><span>Del límite</span><b>${s.limit ? pctTxt(s.pct) : '—'}</b></div>
          <div class="kv"><span>Proyección de cierre</span><b class="num">${esc(money(s.projection))}${s.limit ? ` · ${pctTxt(s.projPct)}` : ''}</b></div>
        </div>
        ${state.synced ? `<div class="notice">Límite del mes: ${esc(money(c.limit))}. Se edita en la pestaña Presupuesto de la planilla.</div>` : `
        <span class="field-label">Límite mensual (COP)</span>
        <div class="stepper">
          <button data-act="limit-step" data-v="-50000" aria-label="Restar 50.000">−</button>
          <input class="input num" id="limit" inputmode="numeric" value="${L.groupDigits(digits)}" aria-label="Límite mensual">
          <button data-act="limit-step" data-v="50000" aria-label="Sumar 50.000">+</button>
        </div>
        <button class="primary" data-act="limit-save" data-id="${esc(name)}">Guardar límite</button>`}
        <span class="field-label">Movimientos y facturas del mes</span>
        <div class="list-card">${items.length ? items.map((it) => (it.kind === 'mov' ? movRow(it) : `
          <button class="mov" data-act="bill" data-id="${it.id}"><span class="grow"><b>${esc(it.name)}</b><small>Factura · ${esc(L.dueInfo(it, today).label)}</small></span><span class="amt">${esc(shown(it))}</span></button>`)).join('') : '<div class="empty">Sin movimientos este mes</div>'}</div>`;
    }, (sheet) => {
      const input = sheet.querySelector('#limit');
      if (!input) return;
      input.oninput = () => { digits = L.cleanDigits(input.value); input.value = L.groupDigits(digits); };
      sheet.querySelectorAll('[data-act="limit-step"]').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          digits = String(Math.max(0, (Number(digits) || 0) + Number(btn.dataset.v)));
          input.value = L.groupDigits(digits);
        };
      });
      sheet.querySelector('[data-act="limit-save"]').onclick = (e) => {
        e.stopPropagation();
        c.limit = Number(digits) || 0;
        toast(`Límite de ${name}: ${L.formatMoney(c.limit, 'COP')}`);
        save();
      };
    });
  }

  // --- Detalle de movimiento ---
  function openMovement(id) {
    openSheet(() => {
      const m = state.movements.find((x) => x.id === id);
      if (!m) return '<div class="empty">El movimiento ya no existe.</div>';
      return `<h3>${esc(m.note || m.sub || m.cat)}</h3>
        <p class="lead">${m.type === 'inc' ? 'Ingreso' : 'Gasto'}</p>
        <div class="card">
          <div class="kv"><span>Categoría</span><b>${esc([m.cat, m.sub].filter(Boolean).join(' · '))}</b></div>
          <div class="kv"><span>Fecha</span><b>${esc(cap(L.longDate(m.date)))}</b></div>
          <div class="kv"><span>Monto</span><b class="num">${esc(orig(m))}${m.cur !== dc() ? `<br><small style="color:var(--ink-2);font-weight:500">≈ ${esc(money(cop(m)))}</small>` : ''}</b></div>
          ${m.method ? `<div class="kv"><span>Medio de pago</span><b>${esc(m.method)}</b></div>` : ''}
        </div>
        <button class="danger-link" data-act="mov-del" data-id="${m.id}">Eliminar movimiento</button>`;
    });
  }

  // --- Agregar (gasto, ingreso o factura) ---
  let form = null;

  function newForm(mode, extra) {
    const m = mode || 'exp';
    return {
      mode: m, digits: '', cur: 'COP',
      cat: m === 'inc' ? state.incomeCats[0] : state.categories[0].name,
      sub: '', note: '', method: state.methods[0], date: today, due: today,
      recurring: false, alerts: [3, 0], scanNote: null, ...extra,
    };
  }

  function impact() {
    if (form.mode === 'inc' || !form.digits) return null;
    const key = L.monthKey(form.mode === 'bill' ? form.due : form.date);
    const s = L.categoryStats(state, key, today).find((x) => x.name === form.cat);
    if (!s || !s.limit) return null;
    const add = L.convert(Number(form.digits), form.cur, 'COP', rates());
    const pct = ((s.spent + add) / s.limit) * 100;
    const tone = pct >= 100 ? 'red' : pct >= state.settings.threshold ? 'amber' : 'green';
    return { tone, text: `${form.cat}: ${pctTxt(s.pct)} → ${pctTxt(pct)} del presupuesto${form.mode === 'bill' ? ' al pagarla' : ''}` };
  }

  function openAdd(mode, extra) {
    form = newForm(mode, extra);
    openSheet(renderAdd, mountAdd);
  }

  function renderAdd() {
    const f = form;
    const cats = f.mode === 'inc' ? state.incomeCats : state.categories.map((c) => c.name);
    const catObj = state.categories.find((c) => c.name === f.cat);
    const imp = impact();
    return `<h3>Agregar</h3>
      ${f.scanNote ? `<div class="notice amber" style="margin:6px 0 14px">${esc(f.scanNote)}</div>` : `
      <button class="shortcut" style="margin:6px 0 14px" data-act="scan"><span class="ico">${scanIcon}</span><span class="grow"><b>Escanear ticket o factura</b></span><span class="chev">›</span></button>`}
      <div class="seg wide">${[['exp', 'Gasto'], ['inc', 'Ingreso'], ['bill', 'Factura']].map(([v, l]) => `<button class="${f.mode === v ? 'on' : ''}" data-act="form-mode" data-v="${v}">${l}</button>`).join('')}</div>
      <div class="amount-row"><span class="cur">${f.cur === 'COP' ? '$' : f.cur === 'ARS' ? 'AR$' : 'US$'}</span>
        <input id="f-amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${L.groupDigits(f.digits)}" aria-label="Monto"></div>
      <div class="pills" style="margin-top:10px">${pills(L.CURRENCIES.map((c) => [c, c]), (v) => v === f.cur, 'form-cur')}</div>
      <span class="field-label">Categoría</span>
      <div class="pills scroll">${pills(cats.map((c) => [c, c]), (v) => v === f.cat, 'form-cat')}${f.mode !== 'inc' ? '<button class="pill" data-act="new-cat" data-v="add">+ Nueva</button>' : ''}</div>
      ${f.mode !== 'inc' && catObj && catObj.subs.length ? `<span class="field-label">Subcategoría</span>
        <div class="pills scroll">${pills(catObj.subs.map((s) => [s, s]), (v) => v === f.sub, 'form-sub')}</div>` : ''}
      <span class="field-label">${f.mode === 'bill' ? 'Nombre de la factura' : 'Comentario'}</span>
      <input class="input" id="f-note" maxlength="60" value="${esc(f.note)}" placeholder="${f.mode === 'bill' ? 'Ej: Internet hogar' : 'Opcional'}">
      ${f.mode === 'bill' ? `
        <span class="field-label">Vencimiento</span>
        <input class="input" id="f-due" type="date" value="${f.due}">
        <div class="card setting-row" style="margin-top:12px"><span><b>Se repite cada mes</b><small>Se crea la factura de cada mes</small></span>
          <button class="switch ${f.recurring ? 'on' : ''}" data-act="form-rec" aria-label="Se repite cada mes" aria-pressed="${f.recurring}"></button></div>
        <span class="field-label">Recordarme</span>
        <div class="pills">${pills(ALERT_OPTS, (v) => f.alerts.includes(Number(v)), 'form-alert')}</div>` : `
        <span class="field-label">Fecha</span>
        <input class="input" id="f-date" type="date" value="${f.date}">`}
      ${f.mode === 'exp' ? `<span class="field-label">Medio de pago</span>
        <div class="pills">${pills(state.methods.map((m) => [m, m]), (v) => v === f.method, 'form-method')}</div>` : ''}
      <div id="f-impact">${imp ? `<div class="notice ${imp.tone}">${esc(imp.text)}</div>` : ''}</div>
      <button class="primary" id="f-save" data-act="form-save" ${f.digits ? '' : 'disabled'}>${f.mode === 'exp' ? 'Guardar gasto' : f.mode === 'inc' ? 'Guardar ingreso' : 'Guardar factura'}</button>`;
  }

  function mountAdd(sheet) {
    const amount = sheet.querySelector('#f-amount');
    amount.oninput = () => {
      form.digits = L.cleanDigits(amount.value);
      amount.value = L.groupDigits(form.digits);
      sheet.querySelector('#f-save').disabled = !form.digits;
      const imp = impact();
      sheet.querySelector('#f-impact').innerHTML = imp ? `<div class="notice ${imp.tone}">${esc(imp.text)}</div>` : '';
    };
    const bind = (sel, key) => { const el = sheet.querySelector(sel); if (el) el.oninput = () => { form[key] = el.value; }; };
    bind('#f-note', 'note');
    bind('#f-date', 'date');
    bind('#f-due', 'due');
    const due = sheet.querySelector('#f-due');
    if (due) due.onchange = () => { form.due = due.value; renderSheet(); };
  }

  function saveForm() {
    const f = form;
    const amount = Number(f.digits);
    if (!amount) return;
    if (f.mode === 'bill') {
      if (!f.due) return toast('Elegí la fecha de vencimiento', 'red');
      const name = f.note.trim() || f.sub || f.cat;
      if (f.recurring) {
        const r = { id: L.uid(), name, cat: f.cat, sub: f.sub, amount, cur: f.cur, day: L.dayOf(f.due), alerts: [...f.alerts], startMonth: L.monthKey(f.due) };
        state.recurring.push(r);
        state.bills.push({ id: L.uid(), templateId: r.id, name, cat: f.cat, sub: f.sub, amount, cur: f.cur, due: f.due, paid: false, method: '', loanId: null, alerts: [...f.alerts] });
        // Con la planilla conectada, las facturas de los meses siguientes las crea el servidor.
        if (!state.synced) {
          for (let k = L.addMonths(L.monthKey(f.due), 1); k <= L.addMonths(curMonth, 1); k = L.addMonths(k, 1)) L.ensureRecurring(state, k);
        }
      } else {
        state.bills.push({ id: L.uid(), templateId: null, name, cat: f.cat, sub: f.sub, amount, cur: f.cur, due: f.due, paid: false, method: '', loanId: null, alerts: [...f.alerts] });
      }
      toast(`Factura guardada · vence el ${L.shortDate(f.due)}`, 'green');
    } else {
      if (!f.date) return toast('Elegí la fecha', 'red');
      state.movements.push({ id: L.uid(), date: f.date, type: f.mode, cat: f.cat, sub: f.mode === 'inc' ? '' : f.sub, note: f.note.trim(), amount, cur: f.cur, method: f.mode === 'exp' ? f.method : '' });
      if (f.mode === 'inc') {
        toast(`Ingreso guardado en ${f.cat}`, 'green');
      } else {
        const s = L.categoryStats(state, L.monthKey(f.date), today).find((x) => x.name === f.cat);
        if (s && s.limit && s.pct >= 100) toast(`Te pasaste en ${f.cat} (${pctTxt(s.pct)})`, 'red');
        else if (s && s.limit && s.pct >= state.settings.threshold) toast(`${f.cat} llegó al ${pctTxt(s.pct)}`, 'amber');
        else toast(`Gasto guardado en ${f.cat}`, 'green');
      }
    }
    form = null;
    closeSheet();
    save();
  }

  // --- Nueva categoría ---
  function openNewCategory(returnToAdd) {
    const saved = form;
    const nc = { name: '', digits: '', subs: '' };
    openSheet(() => `<h3>Nueva categoría</h3>
      <span class="field-label">Nombre</span>
      <input class="input" id="nc-name" maxlength="30" placeholder="Ej: Vacaciones" value="${esc(nc.name)}">
      <span class="field-label">Límite mensual (COP)</span>
      <input class="input num" id="nc-limit" inputmode="numeric" placeholder="0" value="${L.groupDigits(nc.digits)}">
      <span class="field-label">Subcategorías (separadas por coma)</span>
      <input class="input" id="nc-subs" placeholder="Ej: Pasajes, Hotel" value="${esc(nc.subs)}">
      <button class="primary" id="nc-save" ${nc.name.trim() ? '' : 'disabled'}>Crear categoría</button>`,
    (sheet) => {
      const name = sheet.querySelector('#nc-name');
      const limit = sheet.querySelector('#nc-limit');
      const subs = sheet.querySelector('#nc-subs');
      const btn = sheet.querySelector('#nc-save');
      name.oninput = () => { nc.name = name.value; btn.disabled = !nc.name.trim(); };
      limit.oninput = () => { nc.digits = L.cleanDigits(limit.value); limit.value = L.groupDigits(nc.digits); };
      subs.oninput = () => { nc.subs = subs.value; };
      btn.onclick = (e) => {
        e.stopPropagation();
        const n = nc.name.trim();
        if (state.categories.some((c) => c.name.toLowerCase() === n.toLowerCase())) return toast('Esa categoría ya existe', 'red');
        state.categories.push({ name: n, group: n, limit: Number(nc.digits) || 0, subs: nc.subs.split(',').map((s) => s.trim()).filter(Boolean) });
        persist();
        toast(`Categoría creada: ${n}`, 'green');
        if (returnToAdd && saved) {
          form = { ...saved, cat: n, sub: '' };
          openSheet(renderAdd, mountAdd);
          renderScreen();
        } else {
          closeSheet();
          refresh();
        }
      };
    });
  }

  // --- Factura por cobrar ---
  function openNewReceivable() {
    const r = { client: '', digits: '', cur: 'COP', issued: today, due: L.toISO(new Date(Date.now() + 30 * 86400000)) };
    openSheet(() => `<h3>Nueva factura emitida</h3>
      <p class="lead">Al marcarla como cobrada se crea un ingreso en Sueldo Karo.</p>
      <span class="field-label">Cliente</span>
      <input class="input" id="r-client" maxlength="50" value="${esc(r.client)}">
      <span class="field-label">Valor</span>
      <div class="amount-row"><span class="cur">${r.cur === 'COP' ? '$' : r.cur === 'ARS' ? 'AR$' : 'US$'}</span><input id="r-amount" inputmode="numeric" placeholder="0" value="${L.groupDigits(r.digits)}"></div>
      <div class="pills" style="margin-top:10px">${pills(L.CURRENCIES.map((c) => [c, c]), (v) => v === r.cur, 'r-cur')}</div>
      <div class="two"><div><span class="field-label">Emisión</span><input class="input" id="r-issued" type="date" value="${r.issued}"></div>
        <div><span class="field-label">Vencimiento</span><input class="input" id="r-due" type="date" value="${r.due}"></div></div>
      <button class="primary" id="r-save" ${r.client.trim() && r.digits ? '' : 'disabled'}>Guardar</button>`,
    (sheet) => {
      const btn = sheet.querySelector('#r-save');
      const check = () => { btn.disabled = !(r.client.trim() && r.digits && r.due); };
      sheet.querySelector('#r-client').oninput = (e) => { r.client = e.target.value; check(); };
      const amt = sheet.querySelector('#r-amount');
      amt.oninput = () => { r.digits = L.cleanDigits(amt.value); amt.value = L.groupDigits(r.digits); check(); };
      sheet.querySelector('#r-issued').oninput = (e) => { r.issued = e.target.value; };
      sheet.querySelector('#r-due').oninput = (e) => { r.due = e.target.value; check(); };
      sheet.querySelectorAll('[data-act="r-cur"]').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); r.cur = b.dataset.v; renderSheet(); };
      });
      btn.onclick = (e) => {
        e.stopPropagation();
        state.receivables.push({ id: L.uid(), client: r.client.trim(), issued: r.issued, due: r.due, amount: Number(r.digits), cur: r.cur, collected: false, incomeId: null });
        toast('Factura emitida guardada', 'green');
        closeSheet();
        save();
      };
    });
  }

  function toggleReceivable(id) {
    const r = state.receivables.find((x) => x.id === id);
    if (!r) return;
    if (!r.collected) {
      const mov = { id: L.uid(), date: today, type: 'inc', cat: 'Sueldo Karo', sub: '', note: `Cobro ${r.client}`, amount: r.amount, cur: r.cur, method: 'Transferencia' };
      state.movements.push(mov);
      r.collected = true;
      r.collectedAt = today;
      r.incomeId = mov.id;
      toast(`Cobrada: ${r.client} · ${shown(r)}`, 'green');
    } else {
      state.movements = state.movements.filter((m) => m.id !== r.incomeId);
      r.collected = false;
      r.incomeId = null;
      toast('Cobro deshecho');
    }
    save();
  }

  // --- Préstamo ---
  // Con la planilla conectada, los préstamos se leen de las pestañas Deudas y Cuotas.
  function openLoanSynced(loan) {
    openSheet(() => {
      const b = loanBill(loan);
      const fmt = (v) => (v == null ? '—' : esc(orig({ amount: v, cur: loan.cur })));
      return `<h3>${esc(loan.name)}</h3>
        <p class="lead">Datos de la tabla de amortización de la planilla</p>
        <div class="card">
          <div class="kv"><span>Capital</span><b class="num">${fmt(loan.capital)}</b></div>
          <div class="kv"><span>Saldo actual</span><b class="num">${fmt(loan.balance)}</b></div>
          <div class="kv"><span>Próxima cuota</span><b class="num">${fmt(loan.installment)}${loan.day ? ' · día ' + loan.day : ''}</b></div>
          <div class="kv"><span>Cuotas vencidas</span><b>${loan.paidCount ?? '—'} de ${loan.totalCount ?? '—'}</b></div>
        </div>
        <div class="notice">Para cambiar estos datos, editá las pestañas Deudas y Cuotas de la planilla.</div>
        ${b ? `<button class="secondary" data-act="bill" data-id="${b.id}">Ver cuota de ${esc(L.monthName(curMonth))}</button>` : ''}`;
    });
  }

  function openLoan(id) {
    if (state.synced && id) return openLoanSynced(state.loans.find((l) => l.id === id));
    const isNew = !id;
    const loan = isNew
      ? { id: L.uid(), name: '', cur: 'COP', installment: 0, day: 10, balance: null, capital: null, paidCount: null, totalCount: null }
      : state.loans.find((l) => l.id === id);
    if (!loan) return;
    const v = {
      name: loan.name, cur: loan.cur, installment: String(loan.installment || ''), day: String(loan.day),
      balance: loan.balance != null ? String(Math.round(loan.balance)) : '', capital: loan.capital ? String(Math.round(loan.capital)) : '',
      paidCount: loan.paidCount != null ? String(loan.paidCount) : '', totalCount: loan.totalCount ? String(loan.totalCount) : '',
    };
    const field = (key, label, money) => `<div><span class="field-label">${label}</span><input class="input num" data-k="${key}" data-money="${money ? 1 : ''}" inputmode="numeric" value="${money ? L.groupDigits(v[key]) : esc(v[key])}"></div>`;
    openSheet(() => {
      const b = !isNew && loanBill(loan);
      return `<h3>${isNew ? 'Nuevo préstamo' : esc(loan.name)}</h3>
        <p class="lead">${isNew ? 'Se creará una factura mensual con la cuota.' : `Cuota en ${loan.cur}`}</p>
        ${isNew ? `<span class="field-label">Nombre</span><input class="input" data-k="name" value="${esc(v.name)}" placeholder="Ej: Préstamo auto">
          <span class="field-label">Moneda</span><div class="pills">${pills(L.CURRENCIES.map((c) => [c, c]), (x) => x === v.cur, 'loan-cur')}</div>` : ''}
        <div class="two">${field('installment', 'Cuota', true)}${field('day', 'Día de vencimiento')}</div>
        <div class="two">${field('balance', 'Saldo actual', true)}${field('capital', 'Capital original', true)}</div>
        <div class="two">${field('paidCount', 'Cuotas pagadas')}${field('totalCount', 'Total de cuotas')}</div>
        <button class="primary" id="loan-save">Guardar</button>
        ${b ? `<button class="secondary" data-act="bill" data-id="${b.id}">Ver cuota de ${esc(L.monthName(curMonth))}</button>` : ''}
        ${isNew ? '' : `<button class="danger-link" data-act="loan-del" data-id="${loan.id}">Eliminar préstamo</button>`}`;
    }, (sheet) => {
      sheet.querySelectorAll('[data-k]').forEach((inp) => {
        inp.oninput = () => {
          const k = inp.dataset.k;
          if (k === 'name') { v.name = inp.value; return; }
          v[k] = L.cleanDigits(inp.value);
          inp.value = inp.dataset.money ? L.groupDigits(v[k]) : v[k];
        };
      });
      sheet.querySelectorAll('[data-act="loan-cur"]').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); v.cur = b.dataset.v; renderSheet(); };
      });
      sheet.querySelector('#loan-save').onclick = (e) => {
        e.stopPropagation();
        const installment = Number(v.installment);
        const day = Math.min(31, Math.max(1, Number(v.day) || 1));
        if (isNew && !v.name.trim()) return toast('Poné un nombre', 'red');
        if (!installment) return toast('Cargá el valor de la cuota', 'red');
        const num = (s) => (s === '' ? null : Number(s));
        Object.assign(loan, { installment, day, balance: num(v.balance), capital: num(v.capital), paidCount: num(v.paidCount), totalCount: num(v.totalCount) });
        if (isNew) {
          Object.assign(loan, { name: v.name.trim(), cur: v.cur });
          state.loans.push(loan);
          state.recurring.push({ id: 'r-' + loan.id, name: loan.name, cat: 'Obligaciones financieras', sub: 'Préstamo', amount: installment, cur: loan.cur, day, loanId: loan.id, alerts: [3, 0], startMonth: curMonth });
          L.ensureRecurring(state, curMonth);
          L.ensureRecurring(state, L.addMonths(curMonth, 1));
        } else {
          const r = state.recurring.find((x) => x.loanId === loan.id);
          if (r) Object.assign(r, { amount: installment, day });
          state.bills.filter((b) => b.loanId === loan.id && !b.paid && b.due >= `${curMonth}-01`)
            .forEach((b) => Object.assign(b, { amount: installment, due: L.dateInMonth(L.monthKey(b.due), day) }));
        }
        toast('Préstamo guardado', 'green');
        closeSheet();
        save();
      };
    });
  }

  // --- Todas las alertas ---
  function openAllAlerts() {
    openSheet(() => {
      const alerts = L.buildAlerts(state, today);
      return `<h3>Alertas</h3><p class="lead">${alerts.length} en total</p>
        <div class="stack">${alerts.map(alertRow).join('') || '<div class="card empty">Sin alertas</div>'}</div>`;
    });
  }

  // --- Escanear ---
  const scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete scripts[src]; reject(new Error('No se pudo cargar ' + src)); };
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }

  function openScan() {
    const sc = { mode: 'ticket', img: null, status: '', progress: 0, fields: [], busy: false };
    const fileInputs = `
      <label class="secondary" style="margin-top:14px">Tomar foto<input type="file" accept="image/*" capture="environment" data-scan-file hidden></label>
      <label class="secondary">Elegir foto<input type="file" accept="image/*" data-scan-file hidden></label>`;
    openSheet(() => `<h3>Escanear</h3>
      <p class="lead">Leemos comercio, total y fecha. Siempre vas a poder revisar antes de guardar.</p>
      <div class="seg wide">${[['ticket', 'Ticket'], ['factura', 'Factura']].map(([v, l]) => `<button class="${sc.mode === v ? 'on' : ''}" data-act="scan-mode" data-v="${v}">${l}</button>`).join('')}</div>
      <div class="scan-box">${sc.img ? `<img src="${sc.img}" alt="Foto a leer">` : `<div><div style="font-weight:700;margin-bottom:4px">Encuadrá el ${sc.mode === 'ticket' ? 'ticket' : 'documento'} completo</div><small style="color:var(--ink-2)">Con buena luz y sin sombras</small></div>`}</div>
      ${sc.busy || sc.fields.length ? `<div class="progress"><div style="width:${Math.round(sc.progress * 100)}%"></div></div>` : ''}
      ${sc.status ? `<p class="lead" style="margin-top:8px">${esc(sc.status)}</p>` : ''}
      <div class="card" ${sc.fields.length ? '' : 'hidden'}>${sc.fields.map(([k, val]) => `<div class="read-field"><span>${esc(k)}</span><b>${esc(val)}</b></div>`).join('')}</div>
      ${sc.busy ? '' : fileInputs}
      <button class="danger-link" style="color:var(--ink-2)" data-act="add" data-v="${sc.mode === 'factura' ? 'bill' : 'exp'}">Cargar a mano</button>`,
    (sheet) => {
      sheet.querySelectorAll('[data-act="scan-mode"]').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); sc.mode = b.dataset.v; renderSheet(); };
      });
      sheet.querySelectorAll('[data-scan-file]').forEach((inp) => {
        inp.onchange = async () => {
          const file = inp.files[0];
          if (!file) return;
          sc.img = URL.createObjectURL(file);
          sc.busy = true; sc.fields = []; sc.progress = 0.05; sc.status = 'Preparando lector…';
          renderSheet();
          try {
            await loadScript(TESSERACT_SRC);
            const res = await window.Tesseract.recognize(file, 'spa', {
              logger: (m) => {
                if (m.status === 'recognizing text') {
                  sc.progress = 0.3 + m.progress * 0.7; sc.status = 'Leyendo la imagen…';
                  const bar = document.querySelector('#sheet .progress div');
                  if (bar) bar.style.width = Math.round(sc.progress * 100) + '%';
                }
              },
            });
            const r = L.parseReceipt(res.data.text);
            sc.status = 'Listo. Revisá los datos.';
            sc.progress = 1;
            sc.busy = false;
            const fields = [
              [sc.mode === 'ticket' ? 'Comercio' : 'Emisor', r.merchant || '—'],
              ['Total', r.total ? L.formatMoney(r.total, 'COP') : '—'],
              [sc.mode === 'ticket' ? 'Fecha' : 'Vencimiento', r.date ? L.shortDate(r.date) : '—'],
              ['Categoría sugerida', r.cat || '—'],
            ];
            for (const fld of fields) {
              if (!ui.sheet) return;
              sc.fields.push(fld);
              renderSheet();
              await new Promise((ok) => setTimeout(ok, 550));
            }
            if (!ui.sheet) return;
            const isBill = sc.mode === 'factura';
            openAdd(isBill ? 'bill' : 'exp', {
              digits: r.total ? String(r.total) : '',
              note: r.merchant ? r.merchant.charAt(0) + r.merchant.slice(1).toLowerCase() : '',
              cat: r.cat || state.categories[0].name, sub: r.sub || '',
              ...(r.date ? (isBill ? { due: r.date } : { date: r.date }) : {}),
              scanNote: `Leído del ${isBill ? 'documento' : 'ticket'}: ${[r.merchant, r.total ? L.formatMoney(r.total, 'COP') : ''].filter(Boolean).join(' · ') || 'sin datos claros'}. Revisá los datos antes de guardar.`,
            });
          } catch (err) {
            sc.busy = false;
            sc.status = 'No se pudo leer la imagen. Revisá la conexión o cargalo a mano.';
            renderSheet();
          }
        };
      });
    });
  }

  // --- Ajustes ---
  function openSettings() {
    openSheet(() => {
      const s = state.settings;
      const hasSamples = state.movements.some((m) => m.sample) || state.recurring.some((r) => r.sample) || state.receivables.some((r) => r.sample);
      const rateInput = (c) => `<div><span class="field-label">1 ${c} en COP</span><input class="input num" data-rate="${c}" inputmode="decimal" value="${String(s.rates[c]).replace('.', ',')}"></div>`;
      return `<h3>Ajustes</h3>
        <span class="field-label">Planilla de Google</span>
        ${syncCard()}

        <span class="field-label">Alertas · avisarme al llegar al</span>
        <div class="pills">${[70, 80, 90].map((n) => `<button class="pill ${n === s.threshold ? 'on' : ''}" data-act="threshold" data-v="${n}">${n}%</button>`).join('')}</div>

        <span class="field-label">Calendario</span>
        ${state.synced ? `<div class="notice green" style="margin-top:0">Los vencimientos se agregan solos al calendario «Cuentas Casa» de Google, a las 9:00 y con tus avisos.</div>` : `
        <div class="card setting-row"><span><b>Agregar vencimientos</b><small>Archivo .ics: eventos a las 9:00 con tus avisos, próximos 12 meses. Abrilo en el teléfono para sumarlos.</small></span>
          <button class="pill on" data-act="ics">Descargar</button></div>`}

        <span class="field-label">Monedas</span>
        <div class="card">
          <div class="two">${rateInput('USD')}${rateInput('ARS')}</div>
          <p class="lead" style="margin:10px 0 0">Actualizado ${esc(s.ratesUpdated)} · ${esc(s.ratesSource)}</p>
          <button class="secondary" data-act="rates-update">Actualizar en línea</button>
        </div>

        <span class="field-label">Categorías</span>
        <button class="dashed" style="margin:0" data-act="new-cat">+ Nueva categoría</button>

        <span class="field-label">Importar y exportar</span>
        <div class="card">
          <label class="secondary" style="margin-top:0">Importar Excel (.xlsx)<input type="file" accept=".xlsx,.xls" data-import="xlsx" hidden></label>
          <button class="secondary" data-act="export-csv">Exportar movimientos (CSV)</button>
          <button class="secondary" data-act="export-json">Copia de seguridad</button>
          ${state.synced ? '' : '<label class="secondary">Restaurar copia<input type="file" accept="application/json,.json" data-import="json" hidden></label>'}
          <p class="lead" style="margin:10px 0 0">Excel: se lee la hoja «Movimientos Reales» (Fecha, Categoría, Descripción, Moneda, Importe, Medio de pago, Comentarios).</p>
        </div>

        ${state.synced ? '' : `<span class="field-label">Datos</span>
        ${hasSamples ? '<button class="secondary" data-act="clear-samples">Quitar datos de ejemplo</button>' : ''}
        <button class="danger-link" data-act="reset">Borrar todo y empezar de cero</button>`}`;
    }, (sheet) => {
      const form = sheet.querySelector('#sync-form');
      if (form) {
        form.onsubmit = (e) => {
          e.preventDefault();
          const raw = form.url.value.replace(/\s+/g, '');
          // También se puede pegar el enlace de conexión completo que arma la planilla.
          const pasted = raw.includes('#conectar=') ? L.parseConnectHash(raw.slice(raw.indexOf('#'))) : null;
          const url = pasted ? pasted.url : raw;
          const token = pasted ? pasted.token : form.token.value.trim();
          if (!url) return toast('Pegá la dirección de la aplicación web (termina en /exec)', 'red');
          if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) return toast('La dirección tiene que empezar con https://script.google.com/ y terminar en /exec', 'red');
          if (!token) return toast('Falta el código de acceso', 'red');
          connect(url, token, (pasted && pasted.user) || form.quien.value);
        };
        form.querySelectorAll('input[name="quien"]').forEach((radio) => {
          radio.onchange = () => form.querySelectorAll('label.pill').forEach((l) => l.classList.toggle('on', l.contains(form.querySelector('input[name="quien"]:checked'))));
        });
      }
      sheet.querySelectorAll('[data-rate]').forEach((inp) => {
        inp.onchange = () => {
          const v = L.parseNumber(inp.value);
          if (!(v > 0)) { toast('Tasa inválida', 'red'); renderSheet(); return; }
          state.settings.rates[inp.dataset.rate] = v;
          state.settings.ratesUpdated = today;
          state.settings.ratesSource = 'manual';
          toast(`Tasa ${inp.dataset.rate} actualizada`);
          save();
        };
      });
      sheet.querySelectorAll('[data-import]').forEach((inp) => {
        inp.onchange = () => {
          const file = inp.files[0];
          inp.value = '';
          if (file) (inp.dataset.import === 'xlsx' ? importXlsx(file) : importJson(file));
        };
      });
    });
    ui.sheet.isSettings = true;
  }

  function syncCard() {
    if (isSynced()) {
      const when = sync.lastSync ? new Date(sync.lastSync).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
      const status = sync.error ? `<div class="notice red">${esc(sync.error)}${sync.pending.length ? ` · ${sync.pending.length} cambios por enviar` : ''}</div>`
        : sync.pending.length ? `<div class="notice amber">${sync.pending.length} cambios enviándose…</div>` : '';
      return `<div class="card">
          <div class="kv"><span>Estado</span><b class="tone-green">Conectada${sync.user ? ' · ' + esc(sync.user) : ''}</b></div>
          <div class="kv"><span>Última sincronización</span><b>${esc(when)}</b></div>
          ${status}
          <button class="secondary" data-act="sync-now">Sincronizar ahora</button>
          <button class="danger-link" data-act="sync-off">Desconectar</button>
        </div>`;
    }
    return `<div class="card">
        <p class="lead" style="margin:0 0 10px">Conectá la app a la planilla para compartir los datos entre los dos. Lo más simple es abrir el enlace de «Cuentas Casa → 2. Conectar la app» en la planilla.</p>
        <form id="sync-form">
          <input class="input" name="url" placeholder="Enlace de conexión o https://script.google.com/…/exec" autocomplete="off">
          <input class="input" name="token" placeholder="Código de acceso" autocomplete="off" style="margin-top:8px">
          <div class="two" style="margin-top:8px">
            <label class="pill on" style="text-align:center"><input type="radio" name="quien" value="Alan" checked hidden> Alan</label>
            <label class="pill" style="text-align:center"><input type="radio" name="quien" value="Karo" hidden> Karo</label>
          </div>
          <button class="primary" style="margin-top:12px">Conectar</button>
        </form>
      </div>`;
  }

  async function updateRates() {
    toast('Actualizando tasas…');
    try {
      let trm = null;
      try {
        const r = await fetch('https://www.datos.gov.co/resource/32sa-8pi3.json?$order=vigenciadesde%20DESC&$limit=1');
        trm = Number((await r.json())[0].valor);
      } catch (e) { /* se usa la otra fuente */ }
      const fx = await (await fetch('https://open.er-api.com/v6/latest/USD')).json();
      const usd = trm || fx.rates.COP;
      if (!(usd > 0) || !(fx.rates.ARS > 0)) throw new Error('sin datos');
      state.settings.rates.USD = Math.round(usd * 100) / 100;
      state.settings.rates.ARS = Math.round((usd / fx.rates.ARS) * 100000) / 100000;
      state.settings.ratesUpdated = today;
      state.settings.ratesSource = trm ? 'TRM (datos.gov.co) · open.er-api.com' : 'open.er-api.com';
      toast('Tasas actualizadas', 'green');
      save();
    } catch (e) {
      toast('No se pudieron actualizar las tasas. Podés cargarlas a mano.', 'red');
    }
  }

  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importXlsx(file) {
    try {
      toast('Leyendo Excel…');
      await loadScript(XLSX_SRC);
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const name = wb.SheetNames.find((n) => /movimientos/i.test(n)) || wb.SheetNames[0];
      const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
      const { movements, skipped } = L.parseMovementRows(rows, state);
      const sig = (m) => [m.date, m.type, m.cat, m.amount, m.cur, m.note].join('|');
      const existing = new Set(state.movements.map(sig));
      const fresh = movements.filter((m) => !existing.has(sig(m)));
      if (!fresh.length) return toast('No hay movimientos nuevos para importar');
      if (!confirm(`Se importarán ${fresh.length} movimientos de «${name}»${movements.length - fresh.length ? ` (${movements.length - fresh.length} repetidos omitidos)` : ''}${skipped ? `; ${skipped} filas sin fecha o importe se ignoran` : ''}. ¿Continuar?`)) return;
      state.movements.push(...fresh);
      toast(`${fresh.length} movimientos importados`, 'green');
      save();
    } catch (e) {
      toast(`No se pudo importar: ${e.message}`, 'red');
    }
  }

  async function importJson(file) {
    try {
      const s = L.normalizeState(JSON.parse(await file.text()), today);
      if (!s) throw new Error('formato');
      if (!confirm('Esto reemplaza todos los datos actuales. ¿Continuar?')) return;
      state = s;
      L.ensureRecurring(state, curMonth);
      L.ensureRecurring(state, L.addMonths(curMonth, 1));
      toast('Copia restaurada', 'green');
      closeSheet();
      save();
    } catch (e) {
      toast('El archivo no es una copia válida', 'red');
    }
  }

  // ---------- Acciones ----------
  const ACTIONS = {
    tab: (d) => { ui.tab = d.v; closeSheet(); renderScreen(); window.scrollTo(0, 0); },
    cur: (d) => { state.settings.displayCur = d.v; save(); },
    settings: () => openSettings(),
    add: (d) => openAdd(d.v || 'exp'),
    scan: () => openScan(),
    bill: (d) => openBill(d.id),
    'toggle-bill': (d) => togglePaid(d.id),
    cat: (d) => openCategory(d.id),
    mov: (d) => openMovement(d.id),
    loan: (d) => openLoan(d.id),
    'loan-new': () => openLoan(null),
    'all-alerts': () => openAllAlerts(),
    alert: (d) => {
      if (d.kind === 'bill') openBill(d.id);
      else if (d.kind === 'cat') openCategory(d.id);
      else { closeSheet(); ui.tab = 'vencimientos'; ui.vencMode = 'collect'; renderScreen(); window.scrollTo(0, 0); }
    },
    'venc-mode': (d) => { ui.vencMode = d.v; renderScreen(); },
    'cal-month': (d) => { ui.vencMonth = L.addMonths(ui.vencMonth, Number(d.v)); ui.selDay = null; renderScreen(); },
    day: (d) => { ui.selDay = d.v && d.v !== ui.selDay ? d.v : null; renderScreen(); },
    'bud-mode': (d) => { ui.budMode = d.v; renderScreen(); },
    'year-month': (d) => { ui.yearSel = d.v && d.v !== ui.yearSel ? d.v : null; renderScreen(); },
    threshold: (d) => { state.settings.threshold = Number(d.v); save(); },
    'new-cat': (d) => openNewCategory(d.v === 'add'),
    'recv-toggle': (d) => toggleReceivable(d.id),
    'recv-add': () => openNewReceivable(),
    ics: () => { download('cuentas-casa-vencimientos.ics', L.toICS(state, today), 'text/calendar'); toast('Archivo de calendario descargado'); },
    'ics-bill': (d) => {
      const b = state.bills.find((x) => x.id === d.id);
      const only = { ...state, bills: [{ ...b, templateId: null }], recurring: [] };
      download(`${b.name}.ics`, L.toICS(only, today), 'text/calendar');
    },
    'bill-alert': (d) => {
      const b = state.bills.find((x) => x.id === d.id);
      const n = Number(d.v);
      b.alerts = b.alerts.includes(n) ? b.alerts.filter((x) => x !== n) : [...b.alerts, n].sort((a, z) => a - z);
      save();
    },
    'bill-method': (d) => { state.bills.find((x) => x.id === d.id).method = d.v; save(); },
    'bill-del': (d) => {
      if (!confirm('¿Eliminar esta factura?')) return;
      state.bills = state.bills.filter((x) => x.id !== d.id);
      closeSheet();
      save();
    },
    'bill-stop': (d) => {
      const b = state.bills.find((x) => x.id === d.id);
      if (!confirm(`«${b.name}» dejará de crearse cada mes. ¿Continuar?`)) return;
      state.recurring = state.recurring.filter((r) => r.id !== b.templateId);
      state.bills = state.bills.filter((x) => !(x.templateId === b.templateId && !x.paid && L.monthKey(x.due) > L.monthKey(b.due)));
      state.bills.forEach((x) => { if (x.templateId === b.templateId) x.templateId = null; });
      toast('Ya no se repite');
      save();
    },
    'mov-del': (d) => {
      if (!confirm('¿Eliminar este movimiento?')) return;
      state.movements = state.movements.filter((m) => m.id !== d.id);
      state.receivables.forEach((r) => { if (r.incomeId === d.id) { r.collected = false; r.incomeId = null; } });
      closeSheet();
      save();
    },
    'loan-del': (d) => {
      if (!confirm('Se elimina el préstamo y sus cuotas pendientes. ¿Continuar?')) return;
      state.loans = state.loans.filter((l) => l.id !== d.id);
      state.recurring = state.recurring.filter((r) => r.loanId !== d.id);
      state.bills = state.bills.filter((b) => !(b.loanId === d.id && !b.paid));
      closeSheet();
      save();
    },
    'form-mode': (d) => {
      const prev = form.mode;
      form.mode = d.v;
      if ((prev === 'inc') !== (d.v === 'inc')) { form.cat = d.v === 'inc' ? state.incomeCats[0] : state.categories[0].name; form.sub = ''; }
      renderSheet();
    },
    'form-cur': (d) => { form.cur = d.v; renderSheet(); },
    'form-cat': (d) => { form.cat = d.v; form.sub = ''; renderSheet(); },
    'form-sub': (d) => { form.sub = form.sub === d.v ? '' : d.v; renderSheet(); },
    'form-method': (d) => { form.method = d.v; renderSheet(); },
    'form-rec': () => { form.recurring = !form.recurring; renderSheet(); },
    'form-alert': (d) => {
      const n = Number(d.v);
      form.alerts = form.alerts.includes(n) ? form.alerts.filter((x) => x !== n) : [...form.alerts, n];
      renderSheet();
    },
    'form-save': () => saveForm(),
    'rates-update': () => updateRates(),
    'sync-now': async () => {
      sync.error = null;
      try {
        if (sync.pending.length) await push();
        else await pull();
        toast(sync.error ? `No se pudo sincronizar: ${sync.error}` : 'Sincronizado', sync.error ? 'red' : 'green');
      } catch (e) {
        sync.error = e.message;
        toast(`No se pudo sincronizar: ${e.message}`, 'red');
      }
      if (ui.sheet) renderSheet();
    },
    'sync-off': () => disconnect(),
    'export-csv': () => download(`cuentas-casa-${today}.csv`, '﻿' + L.toCSV(state), 'text/csv'),
    'export-json': () => download(`cuentas-casa-backup-${today}.json`, JSON.stringify(state, null, 2), 'application/json'),
    'clear-samples': () => {
      if (!confirm('Se quitan los movimientos, facturas y cobros de ejemplo. Quedan las categorías y los préstamos. ¿Continuar?')) return;
      L.clearSamples(state);
      toast('Datos de ejemplo quitados');
      save();
    },
    reset: () => {
      if (!confirm('Se borran TODOS los datos de este dispositivo. ¿Seguro?')) return;
      state = L.baseState(today);
      L.ensureRecurring(state, curMonth);
      L.ensureRecurring(state, L.addMonths(curMonth, 1));
      closeSheet();
      save();
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act], [data-tab]');
    if (!el) return;
    if (el.dataset.tab) return ACTIONS.tab({ v: el.dataset.tab });
    const fn = ACTIONS[el.dataset.act];
    if (fn) fn(el.dataset);
  });
  $('#scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.sheet) closeSheet(); });

  renderScreen();
  showOverdueNotice();

  // Enlace de conexión generado desde la planilla (Cuentas Casa → Conectar la app).
  // Se lee al abrir y también cuando cambia el #: si la app ya estaba abierta, el enlace no recarga la página.
  function handleConnectLink() {
    if (!/conectar=/.test(location.hash)) return false;
    const link = L.parseConnectHash(location.hash);
    history.replaceState(null, '', location.pathname + location.search);
    if (!link) {
      toast('El enlace de conexión está incompleto. Volvé a copiarlo desde la planilla.', 'red');
      return true;
    }
    closeSheet();
    connect(link.url, link.token, link.user);
    return true;
  }
  window.addEventListener('hashchange', handleConnectLink);
  if (!handleConnectLink() && isSynced()) poll();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', poll);
  window.addEventListener('online', poll);
})();
