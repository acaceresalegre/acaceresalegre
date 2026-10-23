(function () {
  'use strict';

  const L = window.CasaLib;
  const C = window.CasaCharts;
  const desktopMQ = window.matchMedia('(min-width: 1024px)');
  const isDesktop = () => desktopMQ.matches;
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
    dashMonth: null, // mes del dashboard (null = mes actual)
    balMonth: null, // mes del balance (null = mes anterior, el último cerrado)
    balView: 'res', // en el celular: res | pat | flujo
    debtExtra: 0,
    debtStrategy: 'avalanche',
    mov: { q: '', period: 'month', month: null, type: 'all', cat: '', method: '', person: '', sort: 'date', dir: 'desc', limit: 100 },
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
    localEdits++;
    const rows = L.stateToRows(state);
    const ops = L.diffRows(sync.snapshot, rows);
    sync.snapshot = rows;
    if (!ops.length) return;
    sync.pending.push(...ops);
    saveSync();
    push();
  }

  // Todo viaja por POST con el código en el cuerpo (no en la dirección, que queda en registros e historial).
  // text/plain evita la consulta previa de CORS que Apps Script no responde.
  async function call(method, params, body) {
    const res = await fetch(sync.url, { method: 'POST', body: JSON.stringify({ ...params, ...body, token: sync.token }) });
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

  // Una lectura que tardó no pisa cambios hechos mientras tanto ni una versión más nueva ya recibida.
  let localEdits = 0;
  async function pull() {
    const before = localEdits;
    const data = await call('GET', { action: 'pull' });
    if (sync.pending.length || pushing || localEdits !== before) return;
    if (sync.version && Number(data.version) < Number(sync.version)) return;
    applyPull(data);
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
      const dep = (url.match(/\/s\/([^/]+)\//) || [])[1] || '';
      if (!confirm(`Conectado a la planilla (implementación …${dep.slice(-6)}). Los datos de este dispositivo se reemplazan por los de la planilla (${data.tables['Movimientos'].length} movimientos). ¿Continuar?`)) {
        Object.assign(sync, prev);
        return;
      }
      applyPull(data);
      toast(`Sincronizado con la planilla${user ? ' como ' + user : ''}`, 'green');
      if (isIOSBrowser()) setTimeout(openIOSNotice, 600);
    } catch (e) {
      Object.assign(sync, prev);
      saveSync();
      // fetch falla sin respuesta cuando la dirección no es la de la implementación publicada.
      const msg = e instanceof TypeError
        ? 'La planilla no respondió. Revisá que la dirección sea la de Implementar → Gestionar implementaciones (termina en /exec).'
        : e.message;
      toast(`No se pudo conectar: ${msg}`, 'red');
    }
  }

  // En iPhone, Safari y la app agregada a la pantalla de inicio guardan datos por separado: conectar en Safari
  // no conecta la app del ícono. Se avisa y se ofrece copiar el enlace para pegarlo dentro de la app.
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  const isIOSBrowser = () => isIOS() && !isStandalone();
  const connectLink = () => `${location.origin}${location.pathname}#conectar=${encodeURIComponent(sync.url)}&token=${encodeURIComponent(sync.token)}&quien=${encodeURIComponent(sync.user || '')}`;

  function openIOSNotice() {
    openSheet(() => `<h3>Quedó conectada en Safari</h3>
      <p class="lead">Si usás Cuentas Casa desde el ícono de la pantalla de inicio, esa app guarda sus datos aparte y todavía no está conectada.</p>
      <ol class="card steps">
        <li>Tocá <b>Copiar enlace</b>.</li>
        <li>Abrí Cuentas Casa desde el <b>ícono de inicio</b>.</li>
        <li>Tocá <b>⋯ → Pegar el enlace de conexión</b>.</li>
      </ol>
      <button class="primary" data-act="copy-link">Copiar enlace</button>
      <button class="secondary" data-act="close-sheet">Uso la app en Safari, está bien así</button>`);
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
      <button class="check ${b.paid ? 'on' : info.state === 'overdue' ? 'over' : ''}" data-act="toggle-bill" data-id="${esc(b.id)}" aria-label="${b.paid ? 'Desmarcar pago' : 'Marcar como pagada'}"><i>${b.paid ? '✓' : ''}</i></button>
      <button class="body" data-act="bill" data-id="${esc(b.id)}">
        <span class="grow"><div class="name">${esc(b.name)}</div><div class="due ${tone ? 'tone-' + tone : ''}">${esc(info.label)}</div></span>
        <span class="right"><b class="amt">${esc(shown(b))}</b><small>${esc(b.cat)}</small></span>
      </button>
    </div>`;
  }

  const movTitle = (m) => m.note || (m.type === 'save' ? `${m.amount < 0 ? 'Retiro de' : 'Aporte a'} ${m.cat}` : m.sub || m.cat);
  const amtCls = (m) => (m.type === 'inc' ? 'inc' : m.type === 'save' ? 'save' : '');
  const amtSign = (m) => (m.type === 'inc' ? '+' : m.type === 'save' && m.amount > 0 ? '→ ' : '');

  function movRow(m) {
    const when = L.monthKey(m.date) === curMonth ? `día ${L.dayOf(m.date)}` : dateTxt(m.date);
    const sub = [m.type === 'save' ? 'Ahorro' : '', m.cat, m.sub, when, L.personOf(m)].filter(Boolean).join(' · ');
    return `<button class="mov" data-act="mov" data-id="${esc(m.id)}">
      <span class="grow"><b>${esc(movTitle(m))}</b><small>${esc(sub)}</small></span>
      <span class="amt ${amtCls(m)}">${amtSign(m)}${esc(shown(m))}</span>
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
        ${sum.saved ? `<div class="line"><span>Aportado a metas</span><b class="num">${esc(money(sum.saved))}</b></div>` : ''}
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

      ${(state.goals || []).length ? `<section class="sec">
        <button class="card r20 tap" data-act="tab" data-v="metas">
          <div class="sec-head" style="margin-bottom:6px"><h2>Metas de ahorro</h2><span class="chev">›</span></div>
          ${state.goals.slice(0, 3).map((g) => {
            const p = L.goalProgress(state, g, today);
            return `<div class="meta" style="margin-top:8px"><span>${esc(g.name)}</span><span class="num">${pctTxt(p.pct)}</span></div>${bar(p.pct, p.status === 'done' ? 'green' : 'save')}`;
          }).join('')}
        </button>
      </section>` : ''}

      <section class="sec">
        <div class="sec-head"><h2>Últimos movimientos</h2><button class="link" data-act="tab" data-v="movimientos">Ver todos</button></div>
        <div class="list-card">${movs.length ? movs.map(movRow).join('') : '<div class="empty">Sin movimientos este mes</div>'}</div>
      </section>`;
  }

  // ---------- Pantalla: Vencimientos ----------
  function renderVencimientos() {
    const pending = state.bills.filter((b) => !b.paid && L.monthKey(b.due) <= curMonth);
    const sub = `${pending.length} por pagar · ${money(pending.reduce((s, b) => s + cop(b), 0))}`;
    const seg = `<div class="seg wide">
      <button class="${ui.vencMode === 'pay' ? 'on' : ''}" data-act="venc-mode" data-v="pay">Por pagar</button>
      <button class="${ui.vencMode === 'plan' ? 'on' : ''}" data-act="venc-mode" data-v="plan">Plan por cobro</button>
      <button class="${ui.vencMode === 'collect' ? 'on' : ''}" data-act="venc-mode" data-v="collect">Por cobrar</button>
    </div>`;
    return header(sub, 'Vencimientos') + seg + (ui.vencMode === 'pay' ? renderPorPagar() : ui.vencMode === 'plan' ? renderPlanCobro() : renderPorCobrar());
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

    return `<div class="split"><div class="col-side"><section class="card r22">
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
      </div></div>
      <div>${list}
      <button class="dashed" data-act="add" data-v="bill">+ Nueva factura</button></div></div>`;
  }

  // --- Plan por cobro: de un sueldo al siguiente, ¿alcanza? ---
  const dm = (iso) => `${L.dayOf(iso)} ${L.MON[Number(iso.slice(5, 7)) - 1]}`;
  function renderPlanCobro() {
    const p = L.paycheckPlan(state, today);
    if (!p.periods.length) {
      return `<div class="card empty" style="margin-top:16px">Todavía no sabemos cuándo cobran. Configurá los sueldos y otros cobros fijos para armar el plan.</div>
        <button class="primary" data-act="income-plan">Configurar cobros</button>`;
    }
    const cards = p.periods.map((x) => {
      const range = x.start === x.end ? dm(x.start) : `${dm(x.start)} al ${dm(x.end)}`;
      return `<section class="card r20 stmt pay-period ${x.current ? 'current' : ''}">
        <div class="sec-head"><h2>${x.current ? 'Ahora · ' : ''}${esc(range)}</h2>${x.free < 0 ? '<span class="chip red">No alcanza</span>' : x.free < x.income * 0.1 ? '<span class="chip amber">Justo</span>' : '<span class="chip green">Alcanza</span>'}</div>
        ${x.incomes.map((e) => line(`${esc(e.name)}${e.received ? ' <small>cobrado</small>' : ''}`, e.amount, 'ind')).join('') || '<div class="st-row ind muted"><span>Sin cobros en este tramo</span><b>—</b></div>'}
        ${x.spent ? line('Ya gastado desde el cobro', -x.spent, 'ind') : ''}
        ${x.bills.map((b) => line(`<button class="link" data-act="bill" data-id="${esc(b.id)}">${esc(b.name)}</button> <small>${esc(dm(b.due))}${b.paid ? ' · pagada' : b.overdue ? ' · vencida' : ''}</small>`, b.paid ? null : -b.amount, 'ind' + (b.paid ? ' muted' : b.overdue ? ' tone-red' : ''))).join('')}
        ${line(`Gastos del día a día <small>${x.days} día${x.days === 1 ? '' : 's'}${x.current ? ' que quedan' : ''}</small>`, -x.variable, 'ind')}
        ${line(x.current ? 'Libre en lo que queda del tramo' : 'Libre en el tramo', x.free, 'total ' + (x.free < 0 ? 'tone-red' : ''))}
        <div class="st-note">Acumulado desde hoy: <b class="${x.cumulative < 0 ? 'tone-red' : ''}">${esc(money(x.cumulative))}</b></div>
      </section>`;
    }).join('');
    return `<div class="notice ${p.inferred ? 'amber' : ''}" style="margin:14px 0">${p.inferred
      ? 'Cobros estimados con los ingresos de los últimos 3 meses. Configuralos para que el plan sea exacto.'
      : 'Facturas por pagar y gastos del día a día de cada tramo entre cobros.'}
        Gastos del día a día: ${esc(money(p.perDay))} por día (promedio de los últimos 90 días).</div>
      <div class="pay-grid">${cards}</div>
      <button class="dashed" data-act="income-plan">${p.inferred ? 'Configurar cobros' : 'Editar cobros'}</button>`;
  }

  // --- Configurar cobros esperados ---
  let incForm = null;
  function openIncomePlan() {
    const base = (state.incomePlan || []).length ? state.incomePlan : L.inferIncomePlan(state, today);
    incForm = base.map((p) => ({ id: p.inferred ? null : p.id, name: p.name, cat: p.cat, cur: p.cur, digits: String(Math.round(p.amount)), days: p.days.join(', ') }));
    if (!incForm.length) incForm.push({ id: null, name: state.incomeCats[0], cat: state.incomeCats[0], cur: 'COP', digits: '', days: '' });
    openSheet(() => `<h3>Cobros esperados</h3>
      <p class="lead">Sueldos y otros ingresos fijos, con el día del mes en que llegan. Para la quincena poné «15, 30».</p>
      ${incForm.map((f, i) => `<div class="card inc-row">
        <div class="pills scroll">${pills(state.incomeCats.map((c) => [c, c]), (v) => v === f.cat, 'inc-cat', `data-i="${i}"`)}</div>
        <div class="inc-fields">
          <div class="amount-row small"><span class="cur">$</span><input data-inc="${i}" data-k="digits" inputmode="numeric" placeholder="Monto" value="${L.groupDigits(f.digits)}" aria-label="Monto"></div>
          <input class="input" data-inc="${i}" data-k="days" inputmode="numeric" placeholder="Días: 15, 30" value="${esc(f.days)}" aria-label="Días de cobro">
        </div>
        <button class="danger-link" data-act="inc-del" data-v="${i}">Quitar</button>
      </div>`).join('')}
      <button class="pill" data-act="inc-add">+ Otro cobro</button>
      <button class="primary" data-act="inc-save">Guardar cobros</button>`,
    (sheet) => {
      sheet.querySelectorAll('[data-inc]').forEach((el) => {
        el.oninput = () => {
          const f = incForm[Number(el.dataset.inc)];
          if (el.dataset.k === 'digits') { f.digits = L.cleanDigits(el.value); el.value = L.groupDigits(f.digits); } else f.days = el.value;
        };
      });
    });
  }

  function saveIncomePlan() {
    const next = incForm.filter((f) => Number(f.digits) && L.parseDays(f.days).length)
      .map((f) => ({ id: f.id || L.uid(), name: f.name || f.cat, cat: f.cat, cur: f.cur || 'COP', amount: Number(f.digits), days: L.parseDays(f.days) }));
    if (incForm.some((f) => Number(f.digits) && !L.parseDays(f.days).length)) return toast('Falta el día de cobro en algún ingreso', 'red');
    state.incomePlan = next;
    incForm = null;
    closeSheet();
    toast(`${next.length} cobro${next.length === 1 ? '' : 's'} guardado${next.length === 1 ? '' : 's'}`, 'green');
    save();
  }

  function renderPorCobrar() {
    const withInfo = state.receivables.map((r) => ({ r, info: L.receivableInfo(state, r) }));
    const pend = withInfo.filter((x) => x.info.status !== 'done').sort((a, b) => a.r.due.localeCompare(b.r.due));
    const done = withInfo.filter((x) => x.info.status === 'done').sort((a, b) => b.r.due.localeCompare(a.r.due));
    const total = pend.reduce((s, x) => s + cop({ amount: x.info.pending, cur: x.r.cur }), 0);
    const overdue = pend.filter((x) => x.r.due < today).length;
    const partial = pend.filter((x) => x.info.status === 'partial').length;
    const row = ({ r, info }) => {
      const d = L.daysBetween(today, r.due);
      const when = d < 0 ? `hace ${-d} días` : d === 0 ? 'hoy' : `en ${d} días`;
      const isDone = info.status === 'done';
      const sub = info.status === 'partial'
        ? `Cobrado ${esc(L.formatMoney(info.collected, r.cur))} · falta ${esc(L.formatMoney(info.pending, r.cur))}`
        : isDone ? (info.writtenOff > 0.5 ? `Cobrado ${esc(L.formatMoney(info.collected, r.cur))} · sin cobrar ${esc(L.formatMoney(info.writtenOff, r.cur))}` : 'Cobrada')
          : `Vence el ${esc(L.shortDate(r.due))} · ${when}`;
      return `<button class="bill recv ${isDone ? 'paid' : ''}" data-act="recv" data-id="${esc(r.id)}">
        <span class="body"><span class="grow"><span class="name">${esc(r.client)}</span>
          <span class="due ${!isDone && d < 0 ? 'tone-red' : ''}">${info.status === 'partial' ? '<span class="chip amber">Parcial</span> ' : ''}${sub}</span>
          ${info.status === 'partial' ? bar((info.collected / r.amount) * 100, 'green') : ''}</span>
          <span class="right"><b class="amt">${esc(shown(r))}</b></span></span>
        <span class="pill ${isDone ? '' : 'on'}">${isDone ? 'Ver' : 'Cobrar'}</span>
      </button>`;
    };
    return `<section class="dark">
        <div class="lbl">Pendiente de cobro</div>
        <div class="big num">${esc(money(total))}</div>
        <hr>
        <div class="line"><span>Facturas pendientes</span><b>${pend.length}${partial ? ` · ${partial} con cobro parcial` : ''}</b></div>
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
      <div class="stack cat-grid" style="margin-top:12px">${cards}</div>
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
      return `<button class="card cat-card tap" data-act="loan" data-id="${esc(l.id)}">
        <div class="top"><span class="name">${esc(l.name)}</span>${chip}</div>
        <div class="meta" style="margin:-4px 0 10px">${esc(line)}</div>
        ${hasCount ? bar((l.paidCount / l.totalCount) * 100, 'green', { size: 'h7' }) : ''}
        <div class="meta"><span>Saldo ${l.balance != null ? `<b class="num">${esc(orig({ amount: l.balance, cur: l.cur }))}</b>` : '—'}</span>
          <span class="num">Cuota ${esc(orig({ amount: l.installment, cur: l.cur }))} · día ${l.day}</span></div>
      </button>`;
    }).join('');

    return header('Hipotecas y préstamos', 'Deudas') + patSeg() + `
      <section class="dark">
        <div class="lbl">Saldo total adeudado</div>
        <div class="big num">${known.length ? esc(money(totalBalance)) : '—'}</div>
        ${known.length < loans.length ? `<div class="lbl" style="margin-top:4px">${known.length ? 'Faltan saldos: ' : ''}Tocá cada préstamo para cargar su saldo</div>` : ''}
        <hr>
        <div class="line"><span>Cuotas del mes</span><b class="num">${esc(money(monthly))}</b></div>
        <div class="line"><span>Pagadas</span><b>${paid} de ${loans.length}</b></div>
      </section>
      <div class="stack loan-grid" style="margin-top:12px">${cards || '<div class="card empty">No hay préstamos cargados</div>'}</div>
      ${state.synced ? '' : '<button class="dashed" data-act="loan-new">+ Nuevo préstamo</button>'}
      ${loans.length ? debtPlanCard() : ''}`;
  }

  // --- Plan para salir de las deudas ---
  function debtPlanCard() {
    return `<section class="card r20 stmt" style="margin-top:16px">
      <div class="sec-head"><h2>Plan para salir de las deudas</h2></div>
      <p class="st-note" style="margin-top:0">¿Qué pasa si sumás un pago extra por mes? Cuando un préstamo termina, su cuota se suma al extra.</p>
      <div class="debt-inputs">
        <div class="amount-row small"><span class="cur">$</span><input id="debt-extra" inputmode="numeric" placeholder="Pago extra por mes" value="${L.groupDigits(String(ui.debtExtra || ''))}" aria-label="Pago extra por mes"></div>
        <div class="seg">${[['avalanche', 'Avalancha'], ['snowball', 'Bola de nieve']].map(([v, l]) => `<button class="${ui.debtStrategy === v ? 'on' : ''}" data-act="debt-strategy" data-v="${v}">${l}</button>`).join('')}</div>
      </div>
      <div id="debt-plan">${debtPlanResults()}</div>
    </section>`;
  }

  function debtPlanResults() {
    const p = L.debtPlan(state, today, { extra: ui.debtExtra, strategy: ui.debtStrategy });
    if (!p.loans.length) return '<div class="empty">No hay saldos de préstamos para simular.</div>';
    const end = (k) => (k ? cap(monthTxt(k)) : 'No termina');
    const byOrder = p.order.map((id) => p.loans.find((l) => l.id === id));
    const rate = (l) => (l.rate ? (l.rate * 100).toFixed(1).replace('.', ',') + '%' : 'sin tasa');
    return `<div class="debt-list">${byOrder.map((l, i) => `<div class="debt-row">
        <span class="n">${i + 1}</span>
        <span class="grow"><b>${esc(l.name)}</b><small>${esc(short(l.balance))} · ${rate(l)}</small></span>
        <span class="when"><small>Hoy</small>${esc(end(l.baseEnd))}</span>
        <span class="when"><small>Con el plan</small><b class="${l.planEnd && l.planEnd !== l.baseEnd ? 'tone-green' : ''}">${esc(end(l.planEnd))}</b></span>
      </div>`).join('')}</div>
      ${p.baseInterest != null ? line('Intereses que pagarías hoy', p.baseInterest, 'ind') : ''}
      ${p.planInterest != null && p.extra ? line('Intereses con el plan', p.planInterest, 'ind') : ''}
      ${p.saved != null && p.extra ? line('Ahorro en intereses', p.saved, 'total ' + (p.saved > 0 ? 'tone-green' : '')) : ''}
      ${p.endless.length ? `<div class="notice amber" style="margin-top:12px">${esc(p.endless.join(', '))}: con la cuota actual no se termina${p.endless.length > 1 ? 'n' : ''} nunca (la cuota no cubre el interés)${p.planEnd ? `; con el plan, sí: ${esc(monthTxt(p.planEnd))}` : ''}.</div>` : ''}
      <div class="st-note">${p.extra ? `${p.planEnd ? `Sin deudas en <b>${esc(monthTxt(p.planEnd))}</b>` : 'Con este extra no se terminan todas'}${p.monthsSaved ? `, ${p.monthsSaved} mes${p.monthsSaved === 1 ? '' : 'es'} antes` : ''}. ` : 'Escribí un pago extra para ver cuánto se adelanta. '}
        ${ui.debtStrategy === 'snowball' ? 'Bola de nieve: primero la de menor saldo, para cerrar préstamos rápido.' : 'Avalancha: primero la de mayor tasa, la que más interés ahorra.'}
        Se simula con la tasa (TNA) de la pestaña Deudas y la cuota sin seguros, en ${esc(dc())} al cambio de hoy.</div>`;
  }

  // ---------- Pantalla: Metas ----------
  // En el celular Metas y Deudas comparten la pestaña «Patrimonio».
  const patSeg = () => (isDesktop() ? '' : `<div class="seg wide" style="margin-bottom:14px">${[['metas', 'Metas'], ['deudas', 'Deudas'], ['balance', 'Balance']]
    .map(([v, l]) => `<button class="${ui.tab === v ? 'on' : ''}" data-act="tab" data-v="${v}">${l}</button>`).join('')}</div>`);
  const GOAL_CHIP = {
    done: '<span class="chip green">Cumplida</span>', ok: '<span class="chip green">Al día</span>',
    behind: '<span class="chip amber">Atrasada</span>', late: '<span class="chip red">Venció el plazo</span>', nodate: '<span class="chip">Sin fecha</span>',
  };
  const monthTxt = (key) => L.MON[Number(key.slice(5, 7)) - 1] + ' ' + key.slice(0, 4);
  const gMoney = (g, v) => L.formatMoney(v, g.cur);

  function goalLines(g, p) {
    if (p.status === 'done') return [`Ahorraste ${gMoney(g, p.saved)}: meta cumplida.`];
    const out = [];
    if (p.needed != null && p.status !== 'late') out.push(`Faltan ${gMoney(g, p.left)}: ${gMoney(g, p.needed)} por mes hasta ${monthTxt(g.due.slice(0, 7))}`);
    else out.push(`Faltan ${gMoney(g, p.left)}`);
    out.push(p.pace > 0 ? `Ritmo de los últimos 3 meses: ${gMoney(g, p.pace)} por mes${p.eta ? ` → la alcanzás en ${monthTxt(p.eta)}` : ''}` : 'Todavía sin aportes en los últimos 3 meses');
    return out;
  }

  function goalCard(g) {
    const p = L.goalProgress(state, g, today);
    return `<div class="card cat-card goal-card">
      <button class="tap goal-open" data-act="goal" data-id="${esc(g.id)}">
        <div class="top"><span class="name">${esc(g.name)}</span>${GOAL_CHIP[p.status]}</div>
        <div class="goal-amt"><b class="num">${esc(gMoney(g, p.saved))}</b><span> de ${esc(gMoney(g, p.target))} · ${pctTxt(p.pct)}</span></div>
        ${bar(p.pct, p.status === 'done' ? 'green' : 'save', { size: 'h7' })}
        <div class="goal-lines">${goalLines(g, p).map((t) => `<small>${esc(t)}</small>`).join('')}</div>
      </button>
      <button class="pill" data-act="goal-add" data-id="${esc(g.id)}">+ Aportar</button>
    </div>`;
  }

  function renderMetas() {
    const goals = state.goals || [];
    const rows = goals.map((g) => ({ g, p: L.goalProgress(state, g, today) }));
    const totalSaved = rows.reduce((s, r) => s + cop({ amount: r.p.saved, cur: r.g.cur }), 0);
    const totalTarget = rows.reduce((s, r) => s + cop({ amount: r.p.target, cur: r.g.cur }), 0);
    const month = L.monthSummary(state, curMonth).saved;
    return header('Ahorro', 'Metas') + patSeg() + `
      <section class="dark">
        <div class="lbl">Ahorrado en metas</div>
        <div class="big num">${esc(money(totalSaved))}</div>
        <div class="cols">
          <div><span class="lbl">Objetivo total</span><b class="num">${esc(money(totalTarget))}</b></div>
          <div><span class="lbl">Aportado en ${esc(L.monthName(curMonth))}</span><b class="num inc">${esc(money(month))}</b></div>
        </div>
      </section>
      <div class="stack loan-grid" style="margin-top:12px">${goals.length ? goals.map(goalCard).join('')
        : '<div class="card empty">Todavía no hay metas. Creá una con el monto, la fecha y lo que ya tengan ahorrado.</div>'}</div>
      <button class="dashed" data-act="goal-new">+ Nueva meta</button>
      <p class="hint" style="margin-top:12px">Los aportes se cargan con <b>+ Agregar → Ahorro</b>. No cuentan como gasto ni entran en el presupuesto,
        pero se descuentan de lo que «te quedaría» a fin de mes.</p>`;
  }

  // --- Detalle y formulario de meta ---
  function openGoal(id) {
    openSheet(() => {
      const g = (state.goals || []).find((x) => x.id === id);
      if (!g) return '<div class="empty">La meta ya no existe.</div>';
      const p = L.goalProgress(state, g, today);
      return `<h3>${esc(g.name)}</h3>
        <p class="lead">${GOAL_CHIP[p.status]}</p>
        ${bar(p.pct, p.status === 'done' ? 'green' : 'save', { size: 'h7' })}
        <div class="card" style="margin-top:12px">
          <div class="kv"><span>Ahorrado</span><b class="num">${esc(gMoney(g, p.saved))} · ${pctTxt(p.pct)}</b></div>
          <div class="kv"><span>Objetivo</span><b class="num">${esc(gMoney(g, p.target))}</b></div>
          ${g.due ? `<div class="kv"><span>Fecha objetivo</span><b>${esc(cap(L.longDate(g.due)) + (g.due.slice(0, 4) !== today.slice(0, 4) ? ' de ' + g.due.slice(0, 4) : ''))}</b></div>` : ''}
          ${g.initial ? `<div class="kv"><span>Ahorro inicial</span><b class="num">${esc(gMoney(g, g.initial))}</b></div>` : ''}
          ${p.needed != null && p.left > 0 ? `<div class="kv"><span>Hace falta por mes</span><b class="num">${esc(gMoney(g, p.needed))}</b></div>` : ''}
          <div class="kv"><span>Ritmo (últimos 3 meses)</span><b class="num">${esc(gMoney(g, p.pace))} / mes</b></div>
          ${p.eta ? `<div class="kv"><span>A este ritmo</span><b>${esc(cap(monthTxt(p.eta)))}</b></div>` : ''}
        </div>
        <button class="primary" data-act="goal-add" data-id="${esc(g.id)}">Aportar</button>
        <div class="sec-head" style="margin-top:18px"><h2>Aportes</h2></div>
        <div class="list-card">${p.movs.length ? p.movs.map(movRow).join('') : '<div class="empty">Sin aportes todavía.</div>'}</div>
        <button class="pill" style="margin-top:14px" data-act="goal-edit" data-id="${esc(g.id)}">Editar meta</button>
        <button class="danger-link" data-act="goal-del" data-id="${esc(g.id)}">Eliminar meta</button>`;
    });
  }

  let goalForm = null;
  function openGoalForm(id) {
    const g = id && (state.goals || []).find((x) => x.id === id);
    goalForm = g ? { id: g.id, name: g.name, digits: String(Math.round(g.target)), cur: g.cur, due: g.due || '', initial: g.initial ? String(Math.round(g.initial)) : '', note: g.note || '' }
      : { id: null, name: '', digits: '', cur: 'COP', due: '', initial: '', note: '' };
    openSheet(renderGoalForm, mountGoalForm);
  }

  function renderGoalForm() {
    const f = goalForm;
    return `<h3>${f.id ? 'Editar meta' : 'Nueva meta'}</h3>
      <span class="field-label">Nombre</span>
      <input class="input" id="g-name" maxlength="40" value="${esc(f.name)}" placeholder="Ej: Vacaciones, fondo de emergencia">
      <span class="field-label">Monto objetivo</span>
      <div class="amount-row"><span class="cur">${f.cur === 'COP' ? '$' : f.cur === 'ARS' ? 'AR$' : 'US$'}</span>
        <input id="g-target" inputmode="numeric" autocomplete="off" placeholder="0" value="${L.groupDigits(f.digits)}" aria-label="Monto objetivo"></div>
      <div class="pills" style="margin-top:10px">${pills(L.CURRENCIES.map((c) => [c, c]), (v) => v === f.cur, 'goal-cur')}</div>
      <span class="field-label">Fecha objetivo <small class="hint">· opcional</small></span>
      <input class="input" id="g-due" type="date" value="${esc(f.due)}">
      <span class="field-label">Ya ahorrado <small class="hint">· opcional, lo que tenían antes de empezar a cargar aportes</small></span>
      <input class="input" id="g-initial" inputmode="numeric" autocomplete="off" placeholder="0" value="${L.groupDigits(f.initial)}">
      <button class="primary" id="g-save" data-act="goal-save" ${f.name.trim() && f.digits ? '' : 'disabled'}>${f.id ? 'Guardar cambios' : 'Crear meta'}</button>`;
  }

  function mountGoalForm(sheet) {
    const btn = sheet.querySelector('#g-save');
    const check = () => { btn.disabled = !(goalForm.name.trim() && goalForm.digits); };
    const name = sheet.querySelector('#g-name');
    name.oninput = () => { goalForm.name = name.value; check(); };
    const money = (sel, key) => {
      const el = sheet.querySelector(sel);
      el.oninput = () => { goalForm[key] = L.cleanDigits(el.value); el.value = L.groupDigits(goalForm[key]); check(); };
    };
    money('#g-target', 'digits');
    money('#g-initial', 'initial');
    const due = sheet.querySelector('#g-due');
    due.oninput = () => { goalForm.due = due.value; };
  }

  function saveGoal() {
    const f = goalForm;
    if (!f.name.trim() || !Number(f.digits)) return;
    const data = { name: f.name.trim(), target: Number(f.digits), cur: f.cur, due: f.due || '', initial: Number(f.initial) || 0, note: f.note || '' };
    state.goals = state.goals || [];
    const g = f.id && state.goals.find((x) => x.id === f.id);
    if (g) {
      Object.assign(g, data);
      // Los aportes guardan el nombre de la meta para leerlos en la planilla.
      state.movements.forEach((m) => { if (m.type === 'save' && m.goalId === g.id) m.cat = g.name; });
    } else state.goals.push({ id: L.uid(), ...data });
    toast(g ? 'Meta actualizada' : `Meta «${data.name}» creada`, 'green');
    goalForm = null;
    closeSheet();
    save();
  }

  // ---------- Pantalla: Balance ----------
  const balKey = () => ui.balMonth || L.addMonths(curMonth, -1);
  const line = (label, amount, cls = '', extra = '') =>
    `<div class="st-row ${cls}"><span>${label}</span><b class="num">${amount == null ? '—' : esc(money(amount))}${extra}</b></div>`;
  const neg = (v) => -v;

  function resultsCard(key) {
    const r = L.incomeStatement(state, key);
    const prev = L.incomeStatement(state, L.addMonths(key, -1));
    return `<div class="card r20 stmt">
      <div class="sec-head"><h2>Estado de resultados</h2><span class="chip">${esc(cap(L.monthLabel(key)))}</span></div>
      <div class="st-head">Ingresos</div>
      ${r.income.map((x) => line(esc(x.name), x.amount, 'ind')).join('') || '<div class="st-row ind"><span>Sin ingresos</span><b>—</b></div>'}
      ${line('Total ingresos', r.totalIncome, 'sub')}
      <div class="st-head">Gastos</div>
      ${r.expense.map((x) => line(esc(x.name), neg(x.amount), 'ind')).join('') || '<div class="st-row ind"><span>Sin gastos</span><b>—</b></div>'}
      ${line('Total gastos', neg(r.totalExpense), 'sub')}
      ${r.financial.length ? `<div class="st-head">Gastos financieros</div>
        ${r.financial.map((x) => line(`${esc(x.name)} <small>${x.estimated ? (x.interest ? 'interés estimado (sin tabla de cuotas)' : '') : `interés${x.other ? ' + seguros' : ''}`}</small>`, neg(x.interest + x.other), 'ind')).join('')}
        ${line('Total financieros', neg(r.totalFinancial), 'sub')}` : ''}
      ${line(`Resultado del mes${r.margin != null ? ` <small>${pctTxt(r.margin)} de los ingresos</small>` : ''}`, r.result, 'total ' + (r.result < 0 ? 'tone-red' : ''))}
      <div class="st-note">Mes anterior: ${esc(money(prev.result))}.
        ${r.unpaid ? `Incluye ${esc(money(r.unpaid))} de facturas del mes todavía sin pagar. ` : ''}
        ${r.principal ? `La amortización de préstamos del mes (${esc(money(r.principal))}) baja la deuda: no es gasto.` : ''}
        Los aportes a metas tampoco son gasto.</div>
    </div>`;
  }

  function patrimonyCard(key) {
    const b = L.balanceSheet(state, key, today);
    const prev = L.balanceSheet(state, L.addMonths(key, -1), today);
    const acc = (x) => line(`<button class="link" data-act="account" data-id="${esc(x.id)}">${esc(x.name)}</button>${x.stale ? ` <small>saldo de ${esc(L.MON[Number(x.month.slice(5, 7)) - 1])} ${x.month.slice(0, 4)}</small>` : ''}`, x.amount, 'ind');
    const diff = b.netWorth - prev.netWorth;
    const hasAccounts = (state.accounts || []).length > 0;
    return `<div class="card r20 stmt">
      <div class="sec-head"><h2>Situación patrimonial</h2><span class="chip">al ${L.dayOf(L.dateInMonth(key, 31))} ${esc(L.MON[Number(key.slice(5, 7)) - 1])}</span></div>
      <div class="st-head">Activos</div>
      ${b.groups.cash.length ? `<div class="st-sub">Disponible</div>${b.groups.cash.map(acc).join('')}` : ''}
      ${b.groups.invest.length ? `<div class="st-sub">Inversiones</div>${b.groups.invest.map(acc).join('')}` : ''}
      ${b.receivables.length ? line(`Por cobrar <small>${b.receivables.length} factura${b.receivables.length > 1 ? 's' : ''}</small>`, b.assets.receivables, 'ind') : ''}
      ${b.groups.asset.length ? `<div class="st-sub">Bienes</div>${b.groups.asset.map(acc).join('')}` : ''}
      ${b.missing.length ? `<div class="st-row ind muted"><span>Sin saldo: ${b.missing.map((a) => esc(a.name)).join(', ')}</span><b>—</b></div>` : ''}
      ${line('Total activos', b.totalAssets, 'sub')}
      <div class="st-head">Pasivos</div>
      ${b.loans.map((x) => line(esc(x.name), neg(x.amount), 'ind')).join('')}
      ${b.noData.length ? `<div class="st-row ind muted"><span>Sin datos de saldo: ${esc(b.noData.join(', '))}</span><b>—</b></div>` : ''}
      ${b.payables.length ? line(`Facturas impagas <small>${b.payables.length}</small>`, neg(b.totalPayables), 'ind') : ''}
      ${line('Total pasivos', neg(b.totalLiabilities), 'sub')}
      ${line('Patrimonio neto', b.netWorth, 'total ' + (b.netWorth < 0 ? 'tone-red' : ''))}
      <div class="st-note">${!hasAccounts ? 'Cargá tus cuentas y bienes para completar los activos. '
        : prev.missing.length ? `Sin comparación con ${esc(L.monthName(L.addMonths(key, -1)))}: faltaban saldos de ${prev.missing.map((a) => esc(a.name)).join(', ')}. `
          : `Variación contra el mes anterior: <b class="${diff < 0 ? 'tone-red' : 'tone-green'}">${diff >= 0 ? '+' : ''}${esc(money(diff))}</b>. `}
        Préstamos según la tabla de cuotas; montos en ${esc(dc())} al tipo de cambio actual.</div>
      <div class="st-actions">
        ${hasAccounts ? `<button class="primary" data-act="balances-edit" data-v="${key}">Actualizar saldos de ${esc(L.monthName(key))}</button>` : ''}
        <button class="pill" data-act="account-new">+ Cuenta o bien</button>
      </div>
    </div>`;
  }

  function flowCard(key) {
    const f = L.cashFlow(state, key);
    const prevKey = L.addMonths(key, -1);
    const body = !f.hasAccounts
      ? '<div class="empty">Agregá tus cuentas bancarias, efectivo y billeteras en Situación patrimonial para ver el flujo.</div>'
      : `${line(`Saldo al cierre de ${esc(L.monthName(prevKey))}`, f.opening, 'sub')}
        ${line('Cobros (ingresos registrados)', f.receipts, 'ind')}
        ${line('Gastos pagados', neg(f.spending), 'ind')}
        ${f.loanPayments ? line('Cuotas de préstamos pagadas', neg(f.loanPayments), 'ind') : ''}
        ${line('Flujo registrado', f.recorded, 'sub')}
        ${line(`Saldo al cierre de ${esc(L.monthName(key))}`, f.closing, 'sub')}
        ${line('Variación real de las cuentas', f.change, 'ind')}
        ${line('Diferencia sin registrar', f.unexplained, 'total ' + (Math.abs(f.unexplained) > 0.5 ? (f.unexplained < 0 ? 'tone-red' : 'tone-green') : ''))}
        <div class="st-note">${f.complete ? (f.unexplained < 0
          ? 'Salió más plata de la registrada: puede haber gastos sin cargar o pagos con tarjeta de crédito.'
          : f.unexplained > 0 ? 'Entró más plata de la registrada: puede haber ingresos sin cargar.' : 'Todo lo que se movió está registrado.')
          : `Para que el flujo cierre hacen falta los saldos de todas las cuentas líquidas al cierre de ${esc(L.monthName(prevKey))} y de ${esc(L.monthName(key))}.`}</div>`;
    return `<div class="card r20 stmt">
      <div class="sec-head"><h2>Flujo de efectivo</h2><span class="chip">${esc(cap(L.monthLabel(key)))}</span></div>
      ${body}
    </div>`;
  }

  function worthCard(key) {
    return `<div class="card r20">
      <div class="sec-head"><h2>Evolución del patrimonio</h2></div>
      <div class="viz-legend"><span><i class="ln net"></i>Patrimonio neto</span><span><i class="ln inc"></i>Activos</span><span><i class="ln exp"></i>Pasivos</span></div>
      <div class="chart-box" data-chart="networth" data-key="${key}"></div>
    </div>`;
  }

  function renderBalance() {
    const key = balKey();
    const nav = `<div class="filters">
        <span class="month-nav"><button data-act="bal-month" data-v="-1" aria-label="Mes anterior">‹</button><b>${esc(L.monthLabel(key))}</b><button data-act="bal-month" data-v="1" aria-label="Mes siguiente">›</button></span>
      </div>`;
    if (isDesktop()) {
      return header('Estados del hogar', 'Balance') + nav + `
        <div class="dash bal-grid">
          <section class="span-6 stack">${resultsCard(key)}${worthCard(key)}</section>
          <section class="span-6 stack">${patrimonyCard(key)}${flowCard(key)}</section>
        </div>`;
    }
    const views = [['res', 'Resultados'], ['pat', 'Patrimonio'], ['flujo', 'Flujo']];
    return header('Estados del hogar', 'Balance') + patSeg() + nav + `
      <div class="seg wide" style="margin-bottom:12px">${views.map(([v, l]) => `<button class="${ui.balView === v ? 'on' : ''}" data-act="bal-view" data-v="${v}">${l}</button>`).join('')}</div>
      ${ui.balView === 'pat' ? worthCard(key) + '<div style="height:12px"></div>' + patrimonyCard(key) : ui.balView === 'flujo' ? flowCard(key) : resultsCard(key)}`;
  }

  // --- Cuentas y bienes ---
  let accForm = null;
  function openAccountForm(id) {
    const a = id && (state.accounts || []).find((x) => x.id === id);
    accForm = a ? { ...a } : { id: null, name: '', kind: 'Cuenta bancaria', cur: 'COP', note: '' };
    openSheet(() => {
      const f = accForm;
      return `<h3>${f.id ? 'Editar cuenta o bien' : 'Nueva cuenta o bien'}</h3>
        <span class="field-label">Nombre</span>
        <input class="input" id="a-name" maxlength="40" value="${esc(f.name)}" placeholder="Ej: Bancolombia ahorros, Departamento">
        <span class="field-label">Tipo</span>
        <div class="pills">${pills(L.ACCOUNT_KINDS.map((k) => [k, k]), (v) => v === f.kind, 'acc-kind')}</div>
        <span class="field-label">Moneda</span>
        <div class="pills">${pills(L.CURRENCIES.map((c) => [c, c]), (v) => v === f.cur, 'acc-cur')}</div>
        <p class="hint" style="margin-top:12px">${L.kindClass(f.kind) === 'cash' ? 'Cuenta líquida: entra en el disponible y en el flujo de efectivo.' : L.kindClass(f.kind) === 'invest' ? 'Inversión: suma al patrimonio, no al flujo de efectivo.' : 'Bien: cargá su valor estimado; suma al patrimonio.'}</p>
        <button class="primary" id="a-save" data-act="acc-save" ${f.name.trim() ? '' : 'disabled'}>${f.id ? 'Guardar cambios' : 'Agregar'}</button>
        ${f.id ? `<button class="danger-link" data-act="acc-del" data-id="${esc(f.id)}">Quitar de la lista</button>` : ''}`;
    }, (sheet) => {
      const name = sheet.querySelector('#a-name');
      name.oninput = () => { accForm.name = name.value; sheet.querySelector('#a-save').disabled = !name.value.trim(); };
    });
  }

  function saveAccount() {
    const f = accForm;
    if (!f.name.trim()) return;
    state.accounts = state.accounts || [];
    const data = { name: f.name.trim(), kind: f.kind, cur: f.cur, note: f.note || '' };
    const a = f.id && state.accounts.find((x) => x.id === f.id);
    if (a) Object.assign(a, data); else state.accounts.push({ id: L.uid(), ...data });
    accForm = null;
    closeSheet();
    toast(a ? 'Cuenta actualizada' : `«${data.name}» agregada. Cargale el saldo con «Actualizar saldos».`, 'green');
    save();
  }

  // --- Saldos de cierre del mes ---
  let balForm = null;
  function openBalancesForm(key) {
    balForm = { key, values: {} };
    (state.accounts || []).forEach((a) => {
      const b = (state.balances || []).find((x) => x.accountId === a.id && x.month === key);
      balForm.values[a.id] = b ? String(Math.round(Math.abs(b.amount))) : '';
      balForm.values[a.id + ':neg'] = Boolean(b && b.amount < 0);
    });
    openSheet(() => {
      const f = balForm;
      return `<h3>Saldos al cierre de ${esc(L.monthName(f.key))}</h3>
        <p class="lead">Lo que había en cada cuenta el último día del mes (o el valor estimado de cada bien). Dejá vacío lo que no sepas.</p>
        ${(state.accounts || []).map((a) => {
          const last = L.accountBalance(state, a.id, L.addMonths(f.key, -1));
          return `<span class="field-label">${esc(a.name)} <small class="hint">· ${esc(a.kind)}${last ? ` · antes ${esc(L.formatMoney(last.amount, a.cur))}` : ''}</small></span>
          <div class="amount-row small"><span class="cur">${a.cur === 'COP' ? '$' : a.cur === 'ARS' ? 'AR$' : 'US$'}</span>
            <input data-acc="${esc(a.id)}" inputmode="numeric" autocomplete="off" placeholder="0" value="${L.groupDigits(f.values[a.id])}" aria-label="Saldo de ${esc(a.name)}"></div>`;
        }).join('')}
        <button class="primary" data-act="bal-save">Guardar saldos</button>`;
    }, (sheet) => {
      sheet.querySelectorAll('input[data-acc]').forEach((el) => {
        el.oninput = () => { balForm.values[el.dataset.acc] = L.cleanDigits(el.value); el.value = L.groupDigits(balForm.values[el.dataset.acc]); };
      });
    });
  }

  function saveBalances() {
    const f = balForm;
    state.balances = (state.balances || []).filter((b) => b.month !== f.key || !(f.key && f.values[b.accountId] !== undefined));
    let n = 0;
    (state.accounts || []).forEach((a) => {
      const v = f.values[a.id];
      if (v === '' || v === undefined) return;
      state.balances.push({ accountId: a.id, month: f.key, amount: Number(v) * (f.values[a.id + ':neg'] ? -1 : 1) });
      n++;
    });
    balForm = null;
    closeSheet();
    toast(`${n} saldo${n === 1 ? '' : 's'} de ${L.monthName(f.key)} guardado${n === 1 ? '' : 's'}`, 'green');
    save();
  }

  // ---------- Render ----------
  // ---------- Pantalla: Resumen (computadora) ----------
  const monthTitle = (key) => cap(L.monthLabel(key));
  const dateTxt = (iso) => L.shortDate(iso) + (iso.slice(0, 4) !== today.slice(0, 4) ? ' ' + iso.slice(0, 4) : '');
  const shortMonth = (key) => L.MON[Number(key.slice(5, 7)) - 1] + (key.endsWith('-01') ? ' ' + key.slice(2, 4) : '');

  function delta(now, before, upIsGood) {
    if (!before) return '<div class="delta">Sin datos del mes anterior</div>';
    const pct = ((now - before) / Math.abs(before)) * 100;
    if (Math.abs(pct) < 0.5) return '<div class="delta">Igual que el mes anterior</div>';
    const good = pct > 0 === upIsGood;
    return `<div class="delta"><span class="${good ? 'tone-green' : 'tone-red'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(Math.round(pct))}%</span> vs. mes anterior</div>`;
  }

  function renderDashboard() {
    const key = ui.dashMonth || curMonth;
    const prev = L.addMonths(key, -1);
    const sum = L.monthSummary(state, key);
    const before = L.monthSummary(state, prev);
    const stats = L.categoryStats(state, key, today);
    const limit = stats.reduce((s, c) => s + c.limit, 0);
    const spent = stats.reduce((s, c) => s + c.spent, 0);
    const rate = sum.income ? (sum.balance / sum.income) * 100 : null;
    const rateBefore = before.income ? (before.balance / before.income) * 100 : null;
    const alerts = L.buildAlerts(state, today);
    const upcoming = state.bills.filter((b) => !b.paid).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6);
    const movs = L.filterMovements(state, { period: 'month', month: key }, today).list.slice(0, 8);
    const isCur = key === curMonth;

    return header('Resumen financiero', 'Resumen') + `
      <div class="filters">
        <span class="month-nav"><button data-act="dash-month" data-v="-1" aria-label="Mes anterior">‹</button><b>${esc(L.monthLabel(key))}</b><button data-act="dash-month" data-v="1" aria-label="Mes siguiente">›</button></span>
        ${isCur ? '' : '<button class="pill" data-act="dash-month" data-v="0">Mes actual</button>'}
      </div>
      <div class="kpis">
        <div class="tile hero"><div class="lbl">Ahorro de ${esc(L.monthName(key))}</div>
          <div class="big num ${sum.balance < 0 ? 'tone-red' : ''}">${esc(money(sum.balance))}</div>
          <div class="delta">${isCur ? `Te quedaría a fin de mes ${esc(money(sum.remaining))}` : `Facturas sin pagar ${esc(money(sum.pending))}`}${sum.saved ? ` · a metas ${esc(short(sum.saved))}` : ''}</div></div>
        <div class="tile"><div class="lbl">Ingresos</div><div class="val">${esc(short(sum.income))}</div>${delta(sum.income, before.income, true)}</div>
        <div class="tile"><div class="lbl">Gastos</div><div class="val">${esc(short(sum.expense))}</div>${delta(sum.expense, before.expense, false)}</div>
        <div class="tile"><div class="lbl">Tasa de ahorro</div><div class="val">${rate === null ? '—' : pctTxt(rate)}</div>
          <div class="delta">${rate !== null && rateBefore !== null ? `Mes anterior: ${pctTxt(rateBefore)}` : 'Ahorro sobre ingresos'}</div></div>
        <div class="tile"><div class="lbl">Presupuesto usado</div><div class="val">${limit ? pctTxt((spent / limit) * 100) : '—'}</div>
          <div class="delta">${esc(short(spent))} de ${esc(short(limit))}${isCur ? ` · día ${L.dayOf(today)} de ${L.daysInMonth(key)}` : ''}</div></div>
      </div>

      <div class="dash" style="margin-top:16px">
        <section class="card r20 span-7">
          <div class="sec-head"><h2>Ingresos y gastos · últimos 12 meses</h2></div>
          <div class="viz-legend"><span><i class="sw inc"></i>Ingresos</span><span><i class="sw exp"></i>Gastos</span></div>
          <div class="chart-box" data-chart="trend"></div>
          <details class="data-table"><summary>Ver tabla</summary>${trendTable(key)}</details>
        </section>
        <section class="card r20 span-5">
          <div class="sec-head"><h2>Gasto acumulado de ${esc(L.monthName(key))}</h2></div>
          <div class="viz-legend"><span><i class="ln exp"></i>Gastado</span>${isCur ? '<span><i class="ln exp dash"></i>Proyección</span>' : ''}<span><i class="ln ref"></i>Presupuesto</span></div>
          <div class="chart-box" data-chart="cumulative"></div>
        </section>
        <section class="card r20 span-7">
          <div class="sec-head"><h2>Gasto por categoría</h2><button class="link" data-act="tab" data-v="presupuesto">Ver presupuesto</button></div>
          <div class="viz-legend"><span><i class="sw exp"></i>Gastado</span><span><i class="tk"></i>Presupuesto</span></div>
          <div class="chart-box" data-chart="categories"></div>
        </section>
        <section class="span-5 stack">
          <div class="card r20">
            <div class="sec-head"><h2>Gastos por persona</h2></div>
            ${personCard(key)}
          </div>
          <div class="card r20">
            <div class="sec-head"><h2>Próximos vencimientos</h2><button class="link" data-act="tab" data-v="vencimientos">Ver todos</button></div>
            <div class="stack">${upcoming.length ? upcoming.map(billRow).join('') : '<div class="empty">No hay facturas pendientes.</div>'}</div>
          </div>
          <div class="card r20">
            <div class="sec-head"><h2>Alertas</h2>${alerts.length > 5 ? `<button class="link" data-act="all-alerts">Ver todas (${alerts.length})</button>` : ''}</div>
            <div class="stack">${alerts.length ? alerts.slice(0, 5).map(alertRow).join('') : '<div class="empty">Todo en orden.</div>'}</div>
          </div>
        </section>
        <section class="span-12">
          <div class="sec-head"><h2>Movimientos de ${esc(L.monthName(key))}</h2><button class="link" data-act="mov-open-month" data-v="${key}">Ver todos</button></div>
          ${movTable(movs, false)}
        </section>
      </div>`;
  }

  // Gastos del mes (movimientos) según quién pagó o, si no se indicó, quién los cargó.
  function personCard(key) {
    const rows = L.spendByPerson(state, key).filter((r) => r.expense > 0);
    if (!rows.length) return '<div class="empty">Sin gastos cargados en el mes.</div>';
    const total = rows.reduce((s, r) => s + r.expense, 0);
    return `<div class="stack">${rows.map((r) => `<button class="person-row" data-act="mov-person" data-v="${esc(r.name === 'Sin asignar' ? '-' : r.name)}" data-month="${key}">
        <span class="kv"><span>${esc(r.name)}</span><b class="num">${esc(money(r.expense))} <small>${pctTxt((r.expense / total) * 100)}</small></b></span>
        ${bar((r.expense / total) * 100, 'exp')}</button>`).join('')}</div>
      <p class="hint" style="margin-top:10px">Cuenta quién pagó; si no se indicó, quién lo cargó. Las facturas no se reparten.</p>`;
  }

  function trendTable(key) {
    const rows = L.monthSeries(state, key, 12);
    return `<div class="tbl-wrap" style="margin-top:8px"><table class="tbl"><thead><tr><th>Mes</th><th class="n">Ingresos</th><th class="n">Gastos</th><th class="n">Ahorro</th></tr></thead><tbody>${
      rows.map((m) => `<tr><td>${esc(monthTitle(m.key))}</td><td class="n">${esc(money(m.income))}</td><td class="n">${esc(money(m.expense))}</td><td class="n">${esc(money(m.income - m.expense))}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // Dibuja los gráficos con el ancho real de su contenedor.
  function drawCharts() {
    const key = ui.dashMonth || curMonth;
    document.querySelectorAll('.chart-box[data-chart]').forEach((box) => {
      const width = Math.floor(box.clientWidth);
      if (!width) return;
      const fmtVal = (v) => money(v);
      const fmtAxis = (v) => (v ? short(v) : '0');
      let res;
      if (box.dataset.chart === 'trend') {
        const months = L.monthSeries(state, key, 12).map((m) => ({ ...m, label: shortMonth(m.key), title: monthTitle(m.key) }));
        res = C.trend({ months, selected: key, width, fmtAxis, fmtVal });
      } else if (box.dataset.chart === 'cumulative') {
        const d = L.dailySpend(state, key, today);
        const lastDay = key < curMonth ? d.dim : key === curMonth ? L.dayOf(today) : 0;
        res = C.cumulative({
          ...d, lastDay, showProjection: key === curMonth, width, fmtAxis, fmtVal, fmtLabel: (v) => short(v),
          dayLabel: (n, long) => (long ? cap(L.longDate(`${key}-${String(n).padStart(2, '0')}`)) : String(n)),
        });
      } else if (box.dataset.chart === 'networth') {
        const pts = L.netWorthSeries(state, box.dataset.key, 12, today).map((x) => ({
          key: x.key, label: shortMonth(x.key), title: monthTitle(x.key), hasData: x.hasData,
          values: { net: x.net, assets: x.assets, liabilities: -x.liabilities },
        }));
        res = pts.some((x) => x.hasData) ? C.lines({ points: pts, width, fmtAxis, fmtVal, series: [
          { k: 'assets', label: 'Activos', cls: 'inc', tip: 'inc' }, { k: 'liabilities', label: 'Pasivos', cls: 'exp', tip: 'exp' },
          { k: 'net', label: 'Patrimonio neto', cls: 'net', tip: 'ref', strong: true }] })
          : { svg: '<div class="empty">Cargá los saldos de tus cuentas y bienes para ver la evolución.</div>' };
      } else if (box.dataset.chart === 'categories') {
        const rows = L.categoryStats(state, key, today).filter((c) => c.spent > 0 || c.limit > 0)
          .sort((a, b) => b.spent - a.spent || b.limit - a.limit).map((c) => ({ name: c.name, spent: c.spent, limit: c.limit }));
        res = rows.length ? C.categories({ rows, width, fmtVal: (v) => short(v), statusText: 'excedido' }) : { svg: '<div class="empty">Sin gastos en el mes</div>' };
      }
      box.innerHTML = res.svg;
      box._hover = res.hover || null;
    });
  }

  // ---------- Pantalla: Movimientos (lista completa) ----------
  function movTable(list, sortable) {
    if (!list.length) return '<div class="card empty">Sin movimientos para estos filtros</div>';
    if (!isDesktop()) return `<div class="list-card">${list.map(movRow).join('')}</div>`;
    const f = ui.mov;
    const th = (label, sortKey, cls = '') => {
      if (!sortable || !sortKey) return `<th class="${cls}">${label}</th>`;
      const arrow = f.sort === sortKey ? (f.dir === 'asc' ? ' ↑' : ' ↓') : '';
      return `<th class="${cls}"><button data-act="mov-sort" data-v="${sortKey}">${label}${arrow}</button></th>`;
    };
    return `<div class="tbl-wrap"><table class="tbl">
      <thead><tr>${th('Fecha', 'date')}${th('Detalle')}${th('Categoría')}${th('Medio de pago')}${th('Persona')}${th('Importe', 'amount', 'n')}${th(`En ${dc()}`, null, 'n')}</tr></thead>
      <tbody>${list.map((m) => `<tr data-act="mov" data-id="${esc(m.id)}">
        <td>${esc(dateTxt(m.date))}</td>
        <td>${esc(movTitle(m))}</td>
        <td>${m.type === 'save' ? `Ahorro<br><small>${esc(m.cat)}</small>` : `${esc(m.cat)}${m.sub ? `<br><small>${esc(m.sub)}</small>` : ''}`}</td>
        <td>${esc(m.method || '')}</td>
        <td>${esc(L.personOf(m))}${m.paidBy && m.by && m.by !== m.paidBy ? `<br><small>cargó ${esc(m.by)}</small>` : ''}</td>
        <td class="n ${amtCls(m)}">${amtSign(m)}${esc(orig(m))}</td>
        <td class="n">${esc(money(cop(m)))}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  function renderMovimientos() {
    const f = ui.mov;
    const key = f.month || curMonth;
    const cats = [...state.categories.map((c) => c.name), ...state.incomeCats];
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    return header('Gastos e ingresos', 'Movimientos') + `
      <div class="filters">
        <input class="input search" id="mov-q" type="search" placeholder="Buscar comentario, categoría…" value="${esc(f.q)}" aria-label="Buscar">
        <select id="mov-period" aria-label="Período">${[['month', 'Mes'], ['3m', 'Últimos 3 meses'], ['year', 'Año ' + key.slice(0, 4)], ['all', 'Todo']].map(([v, l]) => opt(v, l, f.period)).join('')}</select>
        ${f.period === 'month' ? `<span class="month-nav"><button data-act="mov-month" data-v="-1" aria-label="Mes anterior">‹</button><b>${esc(L.monthLabel(key))}</b><button data-act="mov-month" data-v="1" aria-label="Mes siguiente">›</button></span>` : ''}
        <select id="mov-type" aria-label="Tipo">${[['all', 'Todos los tipos'], ['exp', 'Gastos'], ['inc', 'Ingresos'], ['save', 'Ahorro']].map(([v, l]) => opt(v, l, f.type)).join('')}</select>
        <select id="mov-cat" aria-label="Categoría">${opt('', 'Todas las categorías', f.cat)}${cats.map((c) => opt(c, c, f.cat)).join('')}</select>
        <select id="mov-method" aria-label="Medio de pago">${opt('', 'Todos los medios', f.method)}${state.methods.map((m) => opt(m, m, f.method)).join('')}</select>
        <select id="mov-person" aria-label="Persona">${opt('', 'Todas las personas', f.person)}${L.peopleOf(state).map((p) => opt(p, p, f.person)).join('')}${opt('-', 'Sin asignar', f.person)}</select>
        <button class="pill" data-act="mov-csv">Exportar CSV</button>
      </div>
      <div id="mov-results">${renderMovResults()}</div>`;
  }

  function movResults() {
    return L.filterMovements(state, { ...ui.mov, month: ui.mov.month || curMonth }, today);
  }

  function renderMovResults() {
    const r = movResults();
    const shown = r.list.slice(0, ui.mov.limit);
    return `<div class="totals"><span><b>${r.list.length}</b> movimientos</span><span>Ingresos <b>${esc(money(r.income))}</b></span>
        <span>Gastos <b>${esc(money(r.expense))}</b></span><span>Neto <b class="${r.net < 0 ? 'tone-red' : ''}">${esc(money(r.net))}</b></span>${r.saved ? `<span>A metas <b>${esc(money(r.saved))}</b></span>` : ''}</div>
      ${movTable(shown, true)}
      ${r.list.length > shown.length ? `<button class="more" data-act="mov-more">Mostrar ${Math.min(100, r.list.length - shown.length)} más</button>` : ''}`;
  }

  function refreshMovResults() {
    const box = $('#mov-results');
    if (box) box.innerHTML = renderMovResults();
  }

  const SCREENS = {
    inicio: () => (isDesktop() ? renderDashboard() : renderInicio()),
    movimientos: renderMovimientos, vencimientos: renderVencimientos, presupuesto: renderPresupuesto, deudas: renderDeudas, metas: renderMetas, balance: renderBalance,
  };

  function renderScreen() {
    $('#screen').innerHTML = SCREENS[ui.tab]();
    const mobileTab = ['deudas', 'balance'].includes(ui.tab) ? 'metas' : ui.tab;
    document.querySelectorAll('.side-tab[data-tab]').forEach((t) => t.classList.toggle('on', t.dataset.tab === ui.tab));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === mobileTab));
    const n = urgentBills().length;
    ['#badge', '#badge-side'].forEach((sel) => {
      const badge = $(sel);
      badge.hidden = !n;
      badge.textContent = n;
    });
    const side = $('#side-sync');
    if (side) side.textContent = isSynced() ? `Planilla conectada${sync.user ? ' · ' + sync.user : ''}` : 'Datos solo en este dispositivo';
    drawCharts();
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
        <div class="pills">${pills(ALERT_OPTS, (v) => (b.alerts || []).includes(Number(v)), 'bill-alert', `data-id="${esc(b.id)}"`)}</div>
        <span class="field-label">Medio de pago</span>
        <div class="pills">${pills(state.methods.map((m) => [m, m]), (v) => v === b.method, 'bill-method', `data-id="${esc(b.id)}"`)}</div>
        <button class="primary" data-act="toggle-bill" data-id="${esc(b.id)}">${b.paid ? 'Desmarcar pago' : 'Marcar como pagada'}</button>
        <button class="secondary" data-act="ics-bill" data-id="${esc(b.id)}">Agregar al calendario</button>
        ${b.templateId ? `<button class="danger-link" data-act="bill-stop" data-id="${esc(b.id)}">Dejar de repetir</button>` : ''}
        <button class="danger-link" data-act="bill-del" data-id="${esc(b.id)}">Eliminar factura</button>`;
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
          <button class="mov" data-act="bill" data-id="${esc(it.id)}"><span class="grow"><b>${esc(it.name)}</b><small>Factura · ${esc(L.dueInfo(it, today).label)}</small></span><span class="amt">${esc(shown(it))}</span></button>`)).join('') : '<div class="empty">Sin movimientos este mes</div>'}</div>`;
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
      return `<h3>${esc(movTitle(m))}</h3>
        <p class="lead">${m.type === 'inc' ? 'Ingreso' : m.type === 'save' ? (m.amount < 0 ? 'Retiro de ahorro' : 'Aporte a una meta') : 'Gasto'}</p>
        <div class="card">
          <div class="kv"><span>${m.type === 'save' ? 'Meta' : 'Categoría'}</span><b>${esc([m.cat, m.sub].filter(Boolean).join(' · '))}</b></div>
          <div class="kv"><span>Fecha</span><b>${esc(cap(L.longDate(m.date)))}</b></div>
          <div class="kv"><span>Monto</span><b class="num">${esc(orig(m))}${m.cur !== dc() ? `<br><small style="color:var(--ink-2);font-weight:500">≈ ${esc(money(cop(m)))}</small>` : ''}</b></div>
          ${m.method ? `<div class="kv"><span>Medio de pago</span><b>${esc(m.method)}</b></div>` : ''}
          ${m.paidBy ? `<div class="kv"><span>${m.type === 'inc' ? 'Lo recibió' : m.type === 'save' ? 'Aportó' : 'Pagó'}</span><b>${esc(m.paidBy)}</b></div>` : ''}
          ${m.by ? `<div class="kv"><span>Cargado por</span><b>${esc(m.by)}</b></div>` : ''}
        </div>
        <button class="primary" data-act="mov-edit" data-id="${esc(m.id)}">Editar</button>
        <button class="danger-link" data-act="mov-del" data-id="${esc(m.id)}">Eliminar movimiento</button>`;
    });
  }

  function editMovement(id) {
    const m = state.movements.find((x) => x.id === id);
    if (!m) return;
    openAdd(m.type, { editId: m.id, digits: String(Math.round(Math.abs(m.amount))), withdraw: m.amount < 0, goalId: m.goalId || '', cur: m.cur, cat: m.cat, sub: m.sub || '',
      note: m.note || '', method: m.method || state.methods[0], paidBy: m.paidBy || '', date: m.date });
  }

  // --- Agregar (gasto, ingreso o factura) ---
  let form = null;

  function newForm(mode, extra) {
    const m = mode || 'exp';
    return {
      mode: m, digits: '', cur: 'COP',
      cat: m === 'inc' ? state.incomeCats[0] : state.categories[0].name,
      sub: '', note: '', method: state.methods[0], paidBy: '', date: today, due: today,
      recurring: false, alerts: [3, 0], scanNote: null, withdraw: false,
      goalId: ((state.goals || [])[0] || {}).id || '', ...extra,
    };
  }

  function impact() {
    if (form.mode === 'save') {
      const g = (state.goals || []).find((x) => x.id === form.goalId);
      if (!g || !form.digits) return null;
      const p = L.goalProgress(state, g, today);
      const sign = form.withdraw ? -1 : 1;
      const prevAmt = form.editId ? (state.movements.find((m) => m.id === form.editId) || {}) : null;
      const before = p.saved - (prevAmt && prevAmt.goalId === g.id ? L.convert(prevAmt.amount, prevAmt.cur, g.cur, rates()) : 0);
      const after = before + sign * L.convert(Number(form.digits), form.cur, g.cur, rates());
      const pct = (v) => (p.target ? Math.max(0, (v / p.target) * 100) : 0);
      return { tone: after >= p.target ? 'green' : '', text: `${g.name}: ${pctTxt(pct(before))} → ${pctTxt(pct(after))} de la meta` };
    }
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

  // Categoría y subcategoría; se redibuja sola cuando el comentario sugiere otra categoría.
  function catBlock() {
    const f = form;
    const cats = f.mode === 'inc' ? state.incomeCats : state.categories.map((c) => c.name);
    const catObj = state.categories.find((c) => c.name === f.cat);
    const sug = f.suggested && f.suggested.cat === f.cat && !f.catTouched ? f.suggested : null;
    return `<span class="field-label">Categoría${sug ? ` <small class="hint">· sugerida ${sug.source === 'regla' ? `por la regla «${esc(sug.match)}»` : 'por movimientos anteriores'}</small>` : ''}</span>
      <div class="pills scroll">${pills(cats.map((c) => [c, c]), (v) => v === f.cat, 'form-cat')}${f.mode !== 'inc' ? '<button class="pill" data-act="new-cat" data-v="add">+ Nueva</button>' : ''}</div>
      ${f.mode !== 'inc' && catObj && catObj.subs.length ? `<span class="field-label">Subcategoría</span>
        <div class="pills scroll">${pills(catObj.subs.map((s) => [s, s]), (v) => v === f.sub, 'form-sub')}</div>` : ''}`;
  }

  // Sugiere categoría a partir del comentario mientras no se haya elegido una a mano.
  function suggestFromNote(sheet) {
    const f = form;
    if (f.editId || f.catTouched || f.mode === 'save') return;
    const sug = L.suggestCategory(state, f.note, f.mode === 'inc' ? 'inc' : 'exp');
    if (!sug || (sug.cat === f.cat && sug.sub === f.sub && f.suggested)) return;
    Object.assign(f, { cat: sug.cat, sub: sug.sub, suggested: sug });
    sheet.querySelector('#f-cat').innerHTML = catBlock();
    sheet.querySelectorAll('#f-cat .pill.on').forEach((el) => el.scrollIntoView({ block: 'nearest', inline: 'center' }));
    const imp = impact();
    sheet.querySelector('#f-impact').innerHTML = imp ? `<div class="notice ${imp.tone}">${esc(imp.text)}</div>` : '';
  }

  function renderAdd() {
    const f = form;
    const imp = impact();
    const people = L.peopleOf(state);
    if (sync.user && !people.includes(sync.user)) people.push(sync.user);
    const modes = f.editId ? (f.mode === 'save' ? [['save', 'Ahorro']] : [['exp', 'Gasto'], ['inc', 'Ingreso']])
      : [['exp', 'Gasto'], ['inc', 'Ingreso'], ['bill', 'Factura'], ['save', 'Ahorro']];
    const goals = state.goals || [];
    if (f.mode === 'save' && !goals.length) {
      return `<h3>Agregar</h3><div class="seg wide">${modes.map(([v, l]) => `<button class="${f.mode === v ? 'on' : ''}" data-act="form-mode" data-v="${v}">${l}</button>`).join('')}</div>
        <div class="card empty" style="margin-top:14px">Los aportes se hacen a una meta. Todavía no hay ninguna.</div>
        <button class="primary" data-act="goal-new">Crear una meta</button>`;
    }
    return `<h3>${f.editId ? 'Editar movimiento' : 'Agregar'}</h3>
      ${f.scanNote ? `<div class="notice amber" style="margin:6px 0 ${f.scanText ? 4 : 14}px">${esc(f.scanNote)}</div>${f.scanText ? `<details class="scan-text"><summary>Ver el texto leído</summary><pre>${esc(f.scanText.trim())}</pre></details>` : ''}` : f.editId ? '<div style="height:10px"></div>' : `
      <button class="shortcut" style="margin:6px 0 14px" data-act="scan"><span class="ico">${scanIcon}</span><span class="grow"><b>Escanear ticket o factura</b></span><span class="chev">›</span></button>`}
      <div class="seg wide">${modes.map(([v, l]) => `<button class="${f.mode === v ? 'on' : ''}" data-act="form-mode" data-v="${v}">${l}</button>`).join('')}</div>
      <div class="amount-row"><span class="cur">${f.cur === 'COP' ? '$' : f.cur === 'ARS' ? 'AR$' : 'US$'}</span>
        <input id="f-amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${L.groupDigits(f.digits)}" aria-label="Monto"></div>
      <div class="pills" style="margin-top:10px">${pills(L.CURRENCIES.map((c) => [c, c]), (v) => v === f.cur, 'form-cur')}</div>
      ${f.mode === 'save' ? `<div class="seg" style="margin-top:12px">${[[false, 'Aporte'], [true, 'Retiro']].map(([v, l]) => `<button class="${f.withdraw === v ? 'on' : ''}" data-act="form-withdraw" data-v="${v ? 1 : ''}">${l}</button>`).join('')}</div>
        <span class="field-label">Meta</span>
        <div class="pills scroll">${pills(goals.map((g) => [g.id, g.name]), (v) => v === f.goalId, 'form-goal')}</div>` : `<div id="f-cat">${catBlock()}</div>`}
      <span class="field-label">${f.mode === 'bill' ? 'Nombre de la factura' : 'Comentario'}</span>
      <input class="input" id="f-note" maxlength="60" value="${esc(f.note)}" placeholder="${f.mode === 'bill' ? 'Ej: Internet hogar' : 'Opcional'}">
      ${f.mode === 'bill' ? `
        <span class="field-label">Vencimiento</span>
        <input class="input" id="f-due" type="date" value="${esc(f.due)}">
        <div class="card setting-row" style="margin-top:12px"><span><b>Se repite cada mes</b><small>Se crea la factura de cada mes</small></span>
          <button class="switch ${f.recurring ? 'on' : ''}" data-act="form-rec" aria-label="Se repite cada mes" aria-pressed="${f.recurring}"></button></div>
        <span class="field-label">Recordarme</span>
        <div class="pills">${pills(ALERT_OPTS, (v) => f.alerts.includes(Number(v)), 'form-alert')}</div>` : `
        <span class="field-label">Fecha</span>
        <input class="input" id="f-date" type="date" value="${esc(f.date)}">`}
      ${f.mode === 'exp' ? `<span class="field-label">Medio de pago</span>
        <div class="pills">${pills(state.methods.map((m) => [m, m]), (v) => v === f.method, 'form-method')}</div>` : ''}
      ${f.mode !== 'bill' ? `<span class="field-label">${f.mode === 'inc' ? '¿Quién lo recibió?' : f.mode === 'save' ? '¿Quién aportó?' : '¿Quién pagó?'} <small class="hint">· opcional</small></span>
        <div class="pills">${pills(people.map((p) => [p, p]), (v) => v === f.paidBy, 'form-paid')}</div>` : ''}
      <div id="f-impact">${imp ? `<div class="notice ${imp.tone}">${esc(imp.text)}</div>` : ''}</div>
      <button class="primary" id="f-save" data-act="form-save" ${f.digits ? '' : 'disabled'}>${f.editId ? 'Guardar cambios' : { exp: 'Guardar gasto', inc: 'Guardar ingreso', bill: 'Guardar factura', save: f.withdraw ? 'Guardar retiro' : 'Guardar aporte' }[f.mode]}</button>`;
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
    const note = sheet.querySelector('#f-note');
    if (note) note.addEventListener('input', () => suggestFromNote(sheet));
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
      const goal = f.mode === 'save' && (state.goals || []).find((g) => g.id === f.goalId);
      if (f.mode === 'save' && !goal) return toast('Elegí la meta', 'red');
      const data = goal
        ? { date: f.date, type: 'save', goalId: goal.id, cat: goal.name, sub: '', note: f.note.trim(), amount: f.withdraw ? -amount : amount, cur: f.cur, method: '', paidBy: f.paidBy || '' }
        : { date: f.date, type: f.mode, cat: f.cat, sub: f.mode === 'inc' ? '' : f.sub, note: f.note.trim(), amount, cur: f.cur,
          method: f.mode === 'exp' ? f.method : '', paidBy: f.paidBy || '' };
      const existing = f.editId && state.movements.find((m) => m.id === f.editId);
      if (existing) {
        Object.assign(existing, data);
        toast('Movimiento actualizado', 'green');
      } else state.movements.push({ id: L.uid(), ...data, by: sync.user || '' }); // la planilla completa «Cargado por» igual
      if (existing) { /* aviso ya mostrado */ } else if (goal) {
        const p = L.goalProgress(state, goal, today);
        toast(`${f.withdraw ? 'Retiro' : 'Aporte'} guardado · ${goal.name} al ${pctTxt(p.pct)}`, 'green');
      } else if (f.mode === 'inc') {
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
        queueChanges();
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

  // --- Cobros de una factura emitida (totales o parciales) ---
  let collectForm = null;
  function openCollect(id) {
    const r = state.receivables.find((x) => x.id === id);
    if (!r) return;
    const info = L.receivableInfo(state, r);
    const lastCat = info.payments.length ? info.payments[info.payments.length - 1].cat : null;
    collectForm = { id, digits: String(Math.round(info.pending)), date: today, rest: 'open',
      cat: lastCat || (state.incomeCats.includes('Sueldo Karo') ? 'Sueldo Karo' : state.incomeCats[0]) };
    openSheet(() => {
      const rr = state.receivables.find((x) => x.id === collectForm.id);
      if (!rr) return '<div class="empty">La factura ya no existe.</div>';
      const inf = L.receivableInfo(state, rr);
      const f = collectForm;
      const amt = Number(f.digits) || 0;
      const short = inf.status !== 'done' && amt > 0 && amt < inf.pending - 0.5;
      const fm = (v) => esc(L.formatMoney(v, rr.cur));
      return `<h3>${esc(rr.client)}</h3>
        <p class="lead">Factura emitida${rr.issued ? ` el ${esc(L.shortDate(rr.issued))}` : ''} · vence el ${esc(L.shortDate(rr.due))}</p>
        <div class="card">
          <div class="kv"><span>Valor</span><b class="num">${fm(rr.amount)}</b></div>
          <div class="kv"><span>Cobrado</span><b class="num tone-green">${fm(inf.collected)}</b></div>
          ${inf.writtenOff > 0.5 ? `<div class="kv"><span>No se cobra <small>retención o descuento</small></span><b class="num">${fm(inf.writtenOff)}</b></div>`
            : `<div class="kv"><span>Falta cobrar</span><b class="num ${inf.pending ? 'tone-red' : ''}">${fm(inf.pending)}</b></div>`}
        </div>
        ${inf.payments.length ? `<span class="field-label">Cobros</span>
          <div class="card">${inf.payments.map((m) => `<div class="kv"><span>${esc(L.shortDate(m.date))} <small>${esc(m.cat)}</small></span>
            <b class="num">${esc(L.formatMoney(m.amount, m.cur))} <button class="link" data-act="recv-undo" data-id="${esc(m.id)}">Quitar</button></b></div>`).join('')}</div>` : ''}
        ${inf.status === 'done' ? `<button class="pill" style="margin-top:14px" data-act="recv-reopen" data-id="${esc(rr.id)}">Reabrir (falta cobrar)</button>` : `
          <span class="field-label">Monto cobrado</span>
          <div class="amount-row"><span class="cur">${rr.cur === 'COP' ? '$' : rr.cur === 'ARS' ? 'AR$' : 'US$'}</span>
            <input id="c-amount" inputmode="numeric" autocomplete="off" value="${L.groupDigits(f.digits)}" aria-label="Monto cobrado"></div>
          <div id="c-rest">${restBlock(short, inf.pending - amt, rr.cur)}</div>
          <span class="field-label">Fecha del cobro</span>
          <input class="input" id="c-date" type="date" value="${esc(f.date)}">
          <span class="field-label">Se registra como ingreso en</span>
          <div class="pills scroll">${pills(state.incomeCats.map((c) => [c, c]), (v) => v === f.cat, 'recv-cat')}</div>
          <button class="primary" id="c-save" data-act="recv-save" ${amt > 0 ? '' : 'disabled'}>Registrar cobro</button>`}`;
    }, (sheet) => {
      const amount = sheet.querySelector('#c-amount');
      if (!amount) return;
      amount.oninput = () => {
        collectForm.digits = L.cleanDigits(amount.value);
        amount.value = L.groupDigits(collectForm.digits);
        const rr = state.receivables.find((x) => x.id === collectForm.id);
        const inf = L.receivableInfo(state, rr);
        const amt = Number(collectForm.digits) || 0;
        sheet.querySelector('#c-rest').innerHTML = restBlock(amt > 0 && amt < inf.pending - 0.5, inf.pending - amt, rr.cur);
        sheet.querySelector('#c-save').disabled = !amt;
      };
      const date = sheet.querySelector('#c-date');
      date.oninput = () => { collectForm.date = date.value; };
    });
  }

  // Si se cobra menos de lo que falta: queda pendiente o se da por cobrada (retención en la fuente, descuento).
  function restBlock(short, rest, cur) {
    if (!short) return '';
    return `<span class="field-label">Faltan ${esc(L.formatMoney(rest, cur))}. ¿Qué pasa con eso?</span>
      <div class="seg wide">${[['open', 'Queda pendiente'], ['close', 'No se cobra']].map(([v, l]) =>
        `<button class="${collectForm.rest === v ? 'on' : ''}" data-act="recv-rest" data-v="${v}">${l}</button>`).join('')}</div>
      ${collectForm.rest === 'close' ? '<p class="hint" style="margin-top:6px">Por ejemplo, la retención en la fuente o un descuento. La factura queda cobrada.</p>' : ''}`;
  }

  function saveCollect() {
    const f = collectForm;
    const r = state.receivables.find((x) => x.id === f.id);
    const amount = Number(f.digits) || 0;
    if (!r || !amount) return;
    if (!f.date) return toast('Elegí la fecha del cobro', 'red');
    const before = L.receivableInfo(state, r);
    const mov = { id: L.uid(), date: f.date, type: 'inc', cat: f.cat, sub: '', note: `Cobro ${r.client}`, amount, cur: r.cur,
      method: 'Transferencia', receivableId: r.id, by: sync.user || '' };
    state.movements.push(mov);
    if (!r.incomeId) r.incomeId = mov.id;
    const left = before.pending - amount;
    if (left < 0.5 || f.rest === 'close') { r.collected = true; r.collectedAt = f.date; }
    collectForm = null;
    closeSheet();
    toast(r.collected ? `Cobrada: ${r.client}${left > 0.5 ? ` · sin cobrar ${L.formatMoney(left, r.cur)}` : ''}`
      : `Cobro parcial: falta ${L.formatMoney(left, r.cur)}`, 'green');
    save();
  }

  // Quitar un cobro: la factura vuelve a quedar con saldo pendiente.
  function undoCollect(movId) {
    const m = state.movements.find((x) => x.id === movId);
    if (!m || !confirm('¿Quitar este cobro? Se borra también el ingreso.')) return;
    state.movements = state.movements.filter((x) => x.id !== movId);
    for (const r of state.receivables) {
      if (r.id !== m.receivableId && r.incomeId !== movId) continue;
      r.collected = false;
      r.collectedAt = null;
      if (r.incomeId === movId) r.incomeId = null;
    }
    save();
    renderSheet();
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
        ${b ? `<button class="secondary" data-act="bill" data-id="${esc(b.id)}">Ver cuota de ${esc(L.monthName(curMonth))}</button>` : ''}`;
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
        ${b ? `<button class="secondary" data-act="bill" data-id="${esc(b.id)}">Ver cuota de ${esc(L.monthName(curMonth))}</button>` : ''}
        ${isNew ? '' : `<button class="danger-link" data-act="loan-del" data-id="${esc(loan.id)}">Eliminar préstamo</button>`}`;
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

  // Achica la foto (lado mayor 1600 px), la endereza según la cámara, la pasa a grises y estira el contraste.
  // Así el lector trabaja con menos ruido y la subida a la planilla es liviana.
  async function prepImage(file) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {
      src = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = URL.createObjectURL(file); });
    }
    const w0 = src.width;
    const h0 = src.height;
    const k = Math.min(1, 1600 / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w0 * k);
    canvas.height = Math.round(h0 * k);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      d[i] = g;
      hist[g]++;
    }
    const n = d.length / 4;
    let lo = 0;
    let hi = 255;
    for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.02;) lo++;
    for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * 0.02;) hi--;
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { canvas, dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  }

  // Texto de la foto: primero con el lector de Google (vía la planilla), si no, con el lector del celular.
  async function readImage(prepared, progress) {
    if (isSynced() && navigator.onLine !== false) {
      try {
        progress(0.35, 'Leyendo con Google…');
        const res = await call('POST', null, { action: 'ocr', image: prepared.base64, mime: 'image/jpeg' });
        if (res.text && res.text.trim()) return { text: res.text, source: 'google' };
      } catch (e) { /* sigue con el lector del celular */ }
    }
    progress(0.1, 'Preparando lector…');
    await loadScript(TESSERACT_SRC);
    const res = await window.Tesseract.recognize(prepared.canvas, 'spa', {
      logger: (m) => { if (m.status === 'recognizing text') progress(0.3 + m.progress * 0.7, 'Leyendo la imagen…'); },
    });
    return { text: res.data.text, source: 'local' };
  }

  // Categoría para lo escaneado: reglas e historial del comercio; si no, la pista del ticket si existe en la lista.
  function scanCategory(r) {
    const sug = r.merchant && L.suggestCategory(state, r.merchant, 'exp');
    if (sug) return { cat: sug.cat, sub: sug.sub, suggested: sug };
    const c = state.categories.find((x) => x.name === r.cat);
    if (c) return { cat: c.name, sub: c.subs.includes(r.sub) ? r.sub : '' };
    return { cat: state.categories[0].name, sub: '' };
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
      ${sc.status ? `<p class="lead" style="margin-top:8px" data-scan-status>${esc(sc.status)}</p>` : ''}
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
          sc.busy = true; sc.fields = []; sc.progress = 0.05; sc.status = 'Preparando la foto…';
          renderSheet();
          const progress = (p, msg) => {
            sc.progress = p;
            const bar = document.querySelector('#sheet .progress div');
            if (bar) bar.style.width = Math.round(p * 100) + '%';
            if (msg && msg !== sc.status) {
              sc.status = msg;
              const st = document.querySelector('#sheet [data-scan-status]');
              if (st) st.textContent = msg;
            }
          };
          try {
            const prepared = await prepImage(file);
            const read = await readImage(prepared, progress);
            const r = L.parseReceipt(read.text, sc.mode, today);
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
              ...scanCategory(r),
              ...(r.date ? (isBill ? { due: r.date } : { date: r.date }) : {}),
              scanNote: `Leído del ${isBill ? 'documento' : 'ticket'}${read.source === 'google' ? ' con Google' : ''}: ${[r.merchant, r.total ? L.formatMoney(r.total, 'COP') : ''].filter(Boolean).join(' · ') || 'sin datos claros'}.${r.total ? '' : ' No encontramos el total: cargalo a mano.'} Revisá los datos antes de guardar.`,
              scanText: read.text,
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
          const pasted = L.parseConnectLink(raw);
          if (!pasted && /conectar/i.test(raw)) return toast('El enlace está incompleto. Volvé a copiarlo entero desde el mensaje.', 'red');
          // El iPhone suele poner en mayúscula la primera letra: la dirección se normaliza.
          const url = pasted ? pasted.url : raw.replace(/^https:\/\//i, 'https://');
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
          <button class="secondary" data-act="copy-link">Copiar enlace para conectar otro dispositivo</button>
          <button class="danger-link" data-act="sync-off">Desconectar</button>
        </div>`;
    }
    return `<div class="card">
        <p class="lead" style="margin:0 0 10px">Conectá la app a la planilla para compartir los datos entre los dos. Lo más simple es abrir el enlace de «Cuentas Casa → 2. Conectar la app» en la planilla.</p>
        <form id="sync-form">
          ${navigator.clipboard && navigator.clipboard.readText ? '<button type="button" class="primary" style="margin:0 0 10px" data-act="paste-link">Pegar el enlace de conexión</button>' : ''}
          <input class="input" name="url" placeholder="Enlace de conexión o https://script.google.com/…/exec" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url">
          <input class="input" name="token" placeholder="Código de acceso" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="margin-top:8px">
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
    'income-plan': () => openIncomePlan(),
    'inc-cat': (d) => { const f = incForm[Number(d.i)]; f.cat = d.v; f.name = d.v; renderSheet(); },
    'inc-add': () => { incForm.push({ id: null, name: state.incomeCats[0], cat: state.incomeCats[0], cur: 'COP', digits: '', days: '' }); renderSheet(); },
    'inc-del': (d) => { incForm.splice(Number(d.v), 1); renderSheet(); },
    'inc-save': () => saveIncomePlan(),
    'debt-strategy': (d) => { ui.debtStrategy = d.v; renderScreen(); },
    'cal-month': (d) => { ui.vencMonth = L.addMonths(ui.vencMonth, Number(d.v)); ui.selDay = null; renderScreen(); },
    day: (d) => { ui.selDay = d.v && d.v !== ui.selDay ? d.v : null; renderScreen(); },
    'bud-mode': (d) => { ui.budMode = d.v; renderScreen(); },
    'year-month': (d) => { ui.yearSel = d.v && d.v !== ui.yearSel ? d.v : null; renderScreen(); },
    threshold: (d) => { state.settings.threshold = Number(d.v); save(); },
    'new-cat': (d) => openNewCategory(d.v === 'add'),
    recv: (d) => openCollect(d.id),
    'recv-toggle': (d) => openCollect(d.id),
    'recv-save': () => saveCollect(),
    'recv-undo': (d) => undoCollect(d.id),
    'recv-reopen': (d) => {
      const r = state.receivables.find((x) => x.id === d.id);
      if (!r) return;
      r.collected = false;
      r.collectedAt = null;
      save();
      renderSheet();
    },
    'recv-rest': (d) => {
      collectForm.rest = d.v;
      const el = document.querySelector('#c-rest');
      const r = state.receivables.find((x) => x.id === collectForm.id);
      const inf = L.receivableInfo(state, r);
      const amt = Number(collectForm.digits) || 0;
      if (el) el.innerHTML = restBlock(amt > 0 && amt < inf.pending - 0.5, inf.pending - amt, r.cur);
    },
    'recv-cat': (d) => { collectForm.cat = d.v; renderSheet(); },
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
      const gone = state.movements.find((m) => m.id === d.id);
      state.movements = state.movements.filter((m) => m.id !== d.id);
      // Si era el cobro de una factura emitida, la factura vuelve a quedar con saldo pendiente.
      state.receivables.forEach((r) => {
        if (!gone || (gone.receivableId !== r.id && r.incomeId !== gone.id)) return;
        if (r.incomeId === gone.id) r.incomeId = null;
        r.collected = false;
        r.collectedAt = null;
      });
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
    'form-goal': (d) => { form.goalId = d.v; renderSheet(); },
    'bal-month': (d) => { ui.balMonth = L.addMonths(balKey(), Number(d.v)); renderScreen(); },
    'bal-view': (d) => { ui.balView = d.v; renderScreen(); },
    account: (d) => openAccountForm(d.id),
    'account-new': () => openAccountForm(null),
    'acc-kind': (d) => { accForm.kind = d.v; renderSheet(); },
    'acc-cur': (d) => { accForm.cur = d.v; renderSheet(); },
    'acc-save': () => saveAccount(),
    'acc-del': (d) => {
      const a = (state.accounts || []).find((x) => x.id === d.id);
      if (!a || !confirm(`¿Quitar «${a.name}» de la lista? Sus saldos anteriores quedan en la planilla.`)) return;
      state.accounts = state.accounts.filter((x) => x.id !== d.id);
      closeSheet();
      save();
    },
    'balances-edit': (d) => openBalancesForm(d.v),
    'bal-save': () => saveBalances(),
    'form-withdraw': (d) => { form.withdraw = Boolean(d.v); renderSheet(); },
    goal: (d) => openGoal(d.id),
    'goal-new': () => openGoalForm(null),
    'goal-edit': (d) => openGoalForm(d.id),
    'goal-add': (d) => openAdd('save', { goalId: d.id }),
    'goal-cur': (d) => { goalForm.cur = d.v; renderSheet(); },
    'goal-save': () => saveGoal(),
    'goal-del': (d) => {
      const g = (state.goals || []).find((x) => x.id === d.id);
      if (!g || !confirm(`¿Eliminar la meta «${g.name}»? Sus aportes quedan en Movimientos como ahorro.`)) return;
      state.goals = state.goals.filter((x) => x.id !== d.id);
      closeSheet();
      save();
    },
    'form-cat': (d) => { form.cat = d.v; form.sub = ''; form.catTouched = true; renderSheet(); },
    'form-sub': (d) => { form.sub = form.sub === d.v ? '' : d.v; form.catTouched = true; renderSheet(); },
    'form-paid': (d) => { form.paidBy = form.paidBy === d.v ? '' : d.v; renderSheet(); },
    'form-method': (d) => { form.method = d.v; renderSheet(); },
    'form-rec': () => { form.recurring = !form.recurring; renderSheet(); },
    'form-alert': (d) => {
      const n = Number(d.v);
      form.alerts = form.alerts.includes(n) ? form.alerts.filter((x) => x !== n) : [...form.alerts, n];
      renderSheet();
    },
    'form-save': () => saveForm(),
    'rates-update': () => updateRates(),
    'copy-link': async () => {
      try { await navigator.clipboard.writeText(connectLink()); toast('Enlace copiado. Ahora abrí la app desde el ícono de inicio.', 'green'); } catch (e) {
        prompt('Copiá este enlace y pegalo en la app:', connectLink());
      }
    },
    'close-sheet': () => closeSheet(),
    'paste-link': async () => {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch (e) { return toast('No se pudo leer el portapapeles. Pegalo en el primer campo.', 'red'); }
      const link = L.parseConnectLink(text);
      if (!link) return toast('Lo copiado no es un enlace de conexión. Copiá el enlace entero del mensaje.', 'red');
      closeSheet();
      connect(link.url, link.token, link.user);
    },
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
    'dash-month': (d) => { ui.dashMonth = Number(d.v) ? L.addMonths(ui.dashMonth || curMonth, Number(d.v)) : null; renderScreen(); },
    'mov-open-month': (d) => { Object.assign(ui.mov, { period: 'month', month: d.v, limit: 100 }); ACTIONS.tab({ v: 'movimientos' }); },
    'mov-month': (d) => { ui.mov.month = L.addMonths(ui.mov.month || curMonth, Number(d.v)); ui.mov.limit = 100; renderScreen(); },
    'mov-sort': (d) => {
      ui.mov.dir = ui.mov.sort === d.v && ui.mov.dir === 'desc' ? 'asc' : 'desc';
      ui.mov.sort = d.v;
      refreshMovResults();
    },
    'mov-more': () => { ui.mov.limit += 100; refreshMovResults(); },
    'mov-person': (d) => {
      Object.assign(ui.mov, { q: '', period: 'month', month: d.month, type: 'exp', cat: '', method: '', person: d.v, limit: 100 });
      ACTIONS.tab({ v: 'movimientos' });
    },
    'mov-csv': () => {
      const r = movResults();
      download(`cuentas-casa-movimientos-${today}.csv`, '\ufeff' + L.toCSV({ movements: r.list, bills: [] }), 'text/csv');
    },
    'mov-edit': (d) => editMovement(d.id),
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

  // Filtros de Movimientos: solo se vuelve a dibujar la tabla, así el buscador no pierde el foco.
  document.addEventListener('input', (e) => {
    if (e.target.id === 'mov-q') { ui.mov.q = e.target.value; ui.mov.limit = 100; refreshMovResults(); }
    if (e.target.id === 'debt-extra') {
      const digits = L.cleanDigits(e.target.value);
      e.target.value = L.groupDigits(digits);
      ui.debtExtra = Number(digits) || 0;
      const box = $('#debt-plan');
      if (box) box.innerHTML = debtPlanResults();
    }
  });
  document.addEventListener('change', (e) => {
    const map = { 'mov-period': 'period', 'mov-type': 'type', 'mov-cat': 'cat', 'mov-method': 'method', 'mov-person': 'person' };
    if (!map[e.target.id]) return;
    ui.mov[map[e.target.id]] = e.target.value;
    ui.mov.limit = 100;
    if (e.target.id === 'mov-period') renderScreen();
    else refreshMovResults();
  });

  // Tooltips de los gráficos (el texto se arma con textContent: los nombres vienen de la planilla).
  const tip = $('#viz-tip');
  function showTip(data, x, y) {
    tip.replaceChildren();
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = data.t;
    tip.appendChild(t);
    for (const [label, value, key] of data.r) {
      const row = document.createElement('div');
      row.className = 'r';
      const k = document.createElement('i');
      if (key) k.className = key;
      const b = document.createElement('b');
      b.textContent = value;
      const sp = document.createElement('span');
      sp.textContent = label;
      row.append(k, b, sp);
      tip.appendChild(row);
    }
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 14)) + 'px';
    tip.style.top = Math.max(8, y - h - 12) + 'px';
  }
  const hideTip = () => {
    tip.hidden = true;
    document.querySelectorAll('.viz-cross').forEach((l) => l.setAttribute('visibility', 'hidden'));
  };
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip], [data-cross]');
    if (!el) { if (!tip.hidden) hideTip(); return; }
    if (el.dataset.tip) return showTip(JSON.parse(el.dataset.tip), e.clientX, e.clientY);
    const box = el.closest('.chart-box');
    const items = box && box._hover;
    if (!items) return;
    const svg = el.ownerSVGElement;
    const px = e.clientX - svg.getBoundingClientRect().left;
    const near = items.reduce((a, b) => (Math.abs(b.x - px) < Math.abs(a.x - px) ? b : a));
    const line = svg.querySelector('.viz-cross');
    line.setAttribute('x1', near.x);
    line.setAttribute('x2', near.x);
    line.setAttribute('visibility', 'visible');
    showTip({ t: near.title, r: near.rows }, e.clientX, e.clientY);
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    showTip(JSON.parse(el.dataset.tip), r.left + r.width / 2, r.top);
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('scroll', hideTip, true);

  // Clic en un mes del gráfico: el dashboard pasa a ese mes. Clic en una categoría: su detalle.
  document.addEventListener('click', (e) => {
    const m = e.target.closest && e.target.closest('[data-month]');
    if (m) { ui.dashMonth = m.dataset.month === curMonth ? null : m.dataset.month; hideTip(); renderScreen(); return; }
    const c = e.target.closest && e.target.closest('[data-cat]');
    if (c) { hideTip(); openCategory(c.dataset.cat); }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 120); });
  desktopMQ.addEventListener('change', () => renderScreen());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.sheet) closeSheet(); });

  renderScreen();
  showOverdueNotice();

  // Enlace de conexión generado desde la planilla (Cuentas Casa → Conectar la app).
  // Se lee al abrir y también cuando cambia el #: si la app ya estaba abierta, el enlace no recarga la página.
  function handleConnectLink() {
    if (!/conectar(=|%3D)/i.test(location.hash)) return false;
    const link = L.parseConnectLink(location.hash);
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
