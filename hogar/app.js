(function () {
  'use strict';

  const L = window.HomeLib;
  const STORAGE_KEY = 'hogar-app-v1';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  // ---------- Estado ----------
  function load() {
    try {
      return L.normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch (e) {
      return L.defaultState();
    }
  }

  let state = load();
  const today = L.todayISO();
  const ui = {
    view: 'inicio',
    finMonth: L.monthKey(today),
    calMonth: L.monthKey(today),
    selectedDay: today,
  };

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('No se pudo guardar en este navegador');
    }
    render();
  }

  const money = (n) => L.formatMoney(n, state.currency);

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function shortDate(iso) {
    const d = L.parseISO(iso);
    return d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function dueTag(due) {
    if (!due) return '';
    const diff = L.daysBetween(today, due);
    if (diff < 0) return `<span class="tag overdue">Atrasada ${-diff}d</span>`;
    if (diff === 0) return '<span class="tag">Hoy</span>';
    if (diff === 1) return '<span class="tag">Mañana</span>';
    return `<span class="tag">${esc(shortDate(due))}</span>`;
  }

  const PRIORITY_LABEL = { high: 'Alta', medium: 'Media', low: 'Baja' };
  const REPEAT_LABEL = { daily: 'cada día', weekly: 'cada semana', monthly: 'cada mes' };

  function optionList(values, selected) {
    return values.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');
  }

  function bars(rows) {
    return rows.map((r) => `
      <div class="bar-row">
        <div class="bar-label"><span>${esc(r.label)}</span><span class="muted">${esc(r.value)}</span></div>
        <div class="bar ${r.cls || ''}"><div style="width:${Math.min(100, Math.max(0, r.pct))}%"></div></div>
      </div>`).join('');
  }

  function taskItem(t) {
    const sub = [t.assignee, t.repeat !== 'none' && REPEAT_LABEL[t.repeat]].filter(Boolean).map(esc).join(' · ');
    return `
      <li class="${t.done ? 'done' : ''}">
        <input type="checkbox" data-task-toggle="${t.id}" ${t.done ? 'checked' : ''} aria-label="Completar">
        <div class="grow">
          <div class="title">${esc(t.title)}</div>
          ${sub ? `<div class="sub">${sub}</div>` : ''}
        </div>
        ${t.priority === 'high' && !t.done ? '<span class="tag high">Alta</span>' : ''}
        ${t.done ? '' : dueTag(t.due)}
        <button class="icon" data-task-del="${t.id}" aria-label="Eliminar">✕</button>
      </li>`;
  }

  // ---------- Render ----------
  function renderHome() {
    const sum = L.summarizeMonth(state.transactions, L.monthKey(today));
    $('#home-income').textContent = money(sum.income);
    $('#home-expense').textContent = money(sum.expense);
    const bal = $('#home-balance');
    bal.textContent = money(sum.balance);
    bal.className = sum.balance >= 0 ? 'pos' : 'neg';

    const urgent = L.sortTasks(state.tasks.filter((t) => !t.done && t.due && t.due <= today));
    $('#home-tasks').innerHTML = urgent.length
      ? urgent.map(taskItem).join('')
      : '<li class="muted">Nada pendiente para hoy 🎉</li>';

    const agenda = L.agendaByDate(state);
    const items = [];
    for (let i = 0; i < 7; i++) {
      const d = L.parseISO(today);
      d.setDate(d.getDate() + i);
      const iso = L.toISO(d);
      for (const it of agenda[iso] || []) items.push({ iso, ...it });
    }
    $('#home-agenda').innerHTML = items.length
      ? items.map((it) => `
          <li>
            <div class="grow">
              <div>${esc(it.title)}</div>
              <div class="sub">${esc(shortDate(it.iso))}${it.time ? ' · ' + esc(it.time) : ''}${it.assignee ? ' · ' + esc(it.assignee) : ''}</div>
            </div>
            <span class="tag ${it.kind === 'event' ? 'event' : ''}">${it.kind === 'event' ? 'Evento' : 'Tarea'}</span>
          </li>`).join('')
      : '<li class="muted">Sin eventos ni tareas en los próximos días.</li>';

    const budgets = L.budgetStatus(state.budgets, sum.byCategory);
    $('#home-budgets').innerHTML = budgets.length
      ? bars(budgets.map((b) => ({
          label: b.category,
          value: `${money(b.spent)} de ${money(b.limit)} (${b.pct}%)`,
          pct: b.pct,
          cls: b.pct > 100 ? 'over' : b.pct >= 80 ? 'warn' : '',
        })))
      : '<p class="muted">Definí presupuestos en Ajustes para controlar tus gastos.</p>';
  }

  function renderFinance() {
    $('#fin-month-label').textContent = L.monthLabel(ui.finMonth);
    const sum = L.summarizeMonth(state.transactions, ui.finMonth);
    $('#fin-income').textContent = money(sum.income);
    $('#fin-expense').textContent = money(sum.expense);
    const bal = $('#fin-balance');
    bal.textContent = money(sum.balance);
    bal.className = sum.balance >= 0 ? 'pos' : 'neg';

    const form = $('#tx-form');
    const type = form.type.value;
    const currentCat = form.category.value;
    form.category.innerHTML = optionList(state.categories[type], currentCat);
    const currentMember = form.member.value;
    form.member.innerHTML = optionList(state.members, currentMember);

    const cats = Object.entries(sum.byCategory).sort((a, b) => b[1] - a[1]);
    $('#fin-categories').innerHTML = cats.length
      ? bars(cats.map(([c, v]) => ({
          label: c,
          value: `${money(v)} · ${Math.round((v / sum.expense) * 100)}%`,
          pct: (v / cats[0][1]) * 100,
          cls: state.budgets[c] && v > state.budgets[c] ? 'over' : '',
        })))
      : '<p class="muted">Sin gastos registrados este mes.</p>';

    const filter = $('#fin-filter').value;
    const rows = state.transactions
      .filter((t) => L.monthKey(t.date) === ui.finMonth && (filter === 'all' || t.type === filter))
      .sort((a, b) => b.date.localeCompare(a.date));
    $('#fin-table').innerHTML = rows.map((t) => `
      <tr>
        <td>${esc(shortDate(t.date))}</td>
        <td><div>${esc(t.description || t.category)}</div>${t.description ? `<div class="muted" style="font-size:.8rem">${esc(t.category)}</div>` : ''}</td>
        <td>${esc(t.member || '')}</td>
        <td class="num ${t.type === 'income' ? 'pos' : 'neg'}">${t.type === 'income' ? '+' : '−'}${esc(money(t.amount))}</td>
        <td><button class="icon" data-tx-del="${t.id}" aria-label="Eliminar">✕</button></td>
      </tr>`).join('');
    $('#fin-empty').style.display = rows.length ? 'none' : '';
  }

  function renderTasks() {
    const form = $('#task-form');
    form.assignee.innerHTML = optionList(state.members, form.assignee.value);

    const memberSel = $('#task-filter-member');
    const currentMember = memberSel.value || 'all';
    memberSel.innerHTML = '<option value="all">Todos</option>' + optionList(state.members, currentMember);

    const status = $('#task-filter-status').value;
    const list = L.sortTasks(state.tasks).filter((t) =>
      (status === 'all' || (status === 'done') === t.done) &&
      (currentMember === 'all' || t.assignee === currentMember));
    $('#task-list').innerHTML = list.map(taskItem).join('');
    $('#task-empty').style.display = list.length ? 'none' : '';
  }

  function renderCalendar() {
    $('#cal-month-label').textContent = L.monthLabel(ui.calMonth);
    const agenda = L.agendaByDate(state);
    $('#cal-grid').innerHTML = L.monthGrid(ui.calMonth).map((d) => {
      const items = agenda[d.iso] || [];
      const cls = ['cal-day', d.inMonth ? '' : 'out', d.iso === today ? 'today' : '', d.iso === ui.selectedDay ? 'selected' : '']
        .filter(Boolean).join(' ');
      const shown = items.slice(0, 3).map((it) =>
        `<span class="item ${it.kind}">${it.time ? esc(it.time) + ' ' : ''}${esc(it.title)}</span>`).join('');
      const more = items.length > 3 ? `<span class="more">+${items.length - 3} más</span>` : '';
      const dots = items.map((it) => `<span class="dot ${it.kind}"></span>`).join('');
      return `<button type="button" class="${cls}" data-day="${d.iso}">
        <span class="num">${d.day}</span>
        <span class="items">${shown}${more}</span>
        <span class="dots">${dots}</span>
      </button>`;
    }).join('');

    const dayLabel = L.parseISO(ui.selectedDay).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
    $('#day-label').textContent = dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1);
    const dayItems = agenda[ui.selectedDay] || [];
    $('#day-list').innerHTML = dayItems.map((it) => `
      <li>
        <div class="grow">
          <div>${it.time ? `<strong>${esc(it.time)}</strong> ` : ''}${esc(it.title)}</div>
          ${it.notes ? `<div class="sub">${esc(it.notes)}</div>` : ''}
          ${it.kind === 'task' ? `<div class="sub">Tarea · ${esc(it.assignee || '')}</div>` : ''}
        </div>
        <span class="tag ${it.kind === 'event' ? 'event' : ''}">${it.kind === 'event' ? 'Evento' : 'Tarea'}</span>
        ${it.kind === 'event'
          ? `<button class="icon" data-event-del="${it.id}" aria-label="Eliminar">✕</button>`
          : `<input type="checkbox" data-task-toggle="${it.id}" aria-label="Completar">`}
      </li>`).join('');
    $('#day-empty').style.display = dayItems.length ? 'none' : '';
    $('#event-form').date.value = ui.selectedDay;
  }

  function renderSettings() {
    const chip = (label, attr, value) =>
      `<li>${esc(label)}<button class="icon" ${attr}="${esc(value)}" aria-label="Quitar">✕</button></li>`;
    $('#members-list').innerHTML = state.members.map((m) => chip(m, 'data-member-del', m)).join('');
    $('#cat-expense').innerHTML = state.categories.expense.map((c) => chip(c, 'data-cat-del', 'expense|' + c)).join('');
    $('#cat-income').innerHTML = state.categories.income.map((c) => chip(c, 'data-cat-del', 'income|' + c)).join('');
    $('#budget-fields').innerHTML = `<div class="row" style="flex-wrap:wrap">` + state.categories.expense.map((c) => `
      <label style="flex:1 1 140px">${esc(c)}
        <input type="number" min="0" step="1" name="budget" data-cat="${esc(c)}" value="${state.budgets[c] || ''}" placeholder="Sin límite">
      </label>`).join('') + '</div>';
  }

  const RENDERERS = {
    inicio: renderHome,
    finanzas: renderFinance,
    tareas: renderTasks,
    calendario: renderCalendar,
    ajustes: renderSettings,
  };

  function render() {
    RENDERERS[ui.view]();
  }

  function showView(view) {
    ui.view = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    render();
    window.scrollTo(0, 0);
  }

  // ---------- Eventos ----------
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // Acciones con delegación (listas que se re-renderizan).
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-task-del],[data-tx-del],[data-event-del],[data-member-del],[data-cat-del],[data-day],[data-fin-month],[data-cal-month]');
    if (!el) return;
    const d = el.dataset;
    if (d.taskDel) {
      state.tasks = state.tasks.filter((t) => t.id !== d.taskDel);
      save();
    } else if (d.txDel) {
      if (!confirm('¿Eliminar este movimiento?')) return;
      state.transactions = state.transactions.filter((t) => t.id !== d.txDel);
      save();
    } else if (d.eventDel) {
      state.events = state.events.filter((ev) => ev.id !== d.eventDel);
      save();
    } else if (d.memberDel) {
      if (state.members.length === 1) return toast('Tiene que haber al menos un miembro');
      state.members = state.members.filter((m) => m !== d.memberDel);
      save();
    } else if (d.catDel) {
      const [type, name] = d.catDel.split(/\|(.*)/s);
      if (state.categories[type].length === 1) return toast('Tiene que haber al menos una categoría');
      state.categories[type] = state.categories[type].filter((c) => c !== name);
      delete state.budgets[name];
      save();
    } else if (d.day) {
      ui.selectedDay = d.day;
      if (L.monthKey(d.day) !== ui.calMonth) ui.calMonth = L.monthKey(d.day);
      render();
    } else if (d.finMonth) {
      ui.finMonth = L.addMonths(ui.finMonth, Number(d.finMonth));
      render();
    } else if (d.calMonth) {
      ui.calMonth = L.addMonths(ui.calMonth, Number(d.calMonth));
      render();
    }
  });

  document.addEventListener('change', (e) => {
    const id = e.target.dataset && e.target.dataset.taskToggle;
    if (!id) return;
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    if (task.done) {
      state.tasks = state.tasks.map((t) => (t.id === id ? { ...t, done: false, doneAt: null } : t));
    } else {
      state.tasks = L.completeTask(state.tasks, id, today);
      if (task.repeat && task.repeat !== 'none') toast('¡Hecho! Se agendó la próxima');
    }
    save();
  });

  $('#tx-form').addEventListener('change', (e) => {
    if (e.target.name === 'type') renderFinance();
  });

  $('#tx-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    state.transactions.push({
      id: L.uid(),
      type: f.type.value,
      amount: Math.round(parseFloat(f.amount.value) * 100) / 100,
      category: f.category.value,
      description: f.description.value.trim(),
      date: f.date.value,
      member: f.member.value,
    });
    ui.finMonth = L.monthKey(f.date.value);
    f.amount.value = '';
    f.description.value = '';
    f.amount.focus();
    toast('Movimiento agregado');
    save();
  });

  $('#fin-filter').addEventListener('change', renderFinance);
  $('#task-filter-status').addEventListener('change', renderTasks);
  $('#task-filter-member').addEventListener('change', renderTasks);

  $('#task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const repeat = f.repeat.value;
    state.tasks.push({
      id: L.uid(),
      title: f.title.value.trim(),
      assignee: f.assignee.value,
      // Una tarea repetitiva necesita fecha para calcular la siguiente.
      due: f.due.value || (repeat !== 'none' ? today : ''),
      priority: f.priority.value,
      repeat,
      done: false,
    });
    f.title.value = '';
    f.title.focus();
    toast('Tarea agregada');
    save();
  });

  $('#cal-today').addEventListener('click', () => {
    ui.calMonth = L.monthKey(today);
    ui.selectedDay = today;
    render();
  });

  $('#event-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    state.events.push({
      id: L.uid(),
      title: f.title.value.trim(),
      date: f.date.value,
      time: f.time.value,
      notes: f.notes.value.trim(),
    });
    ui.selectedDay = f.date.value;
    ui.calMonth = L.monthKey(f.date.value);
    f.title.value = '';
    f.time.value = '';
    f.notes.value = '';
    toast('Evento agregado');
    save();
  });

  $('#member-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (state.members.includes(name)) return toast('Ese miembro ya existe');
    state.members.push(name);
    e.target.reset();
    save();
  });

  $('#category-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const type = e.target.type.value;
    const name = e.target.name.value.trim();
    if (state.categories[type].includes(name)) return toast('Esa categoría ya existe');
    state.categories[type].push(name);
    e.target.name.value = '';
    save();
  });

  $('#budget-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const budgets = {};
    e.target.querySelectorAll('input[name="budget"]').forEach((inp) => {
      const v = parseFloat(inp.value);
      if (v > 0) budgets[inp.dataset.cat] = v;
    });
    state.budgets = budgets;
    toast('Presupuestos guardados');
    save();
  });

  $('#export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hogar-backup-${today}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('#import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm('Esto reemplaza todos los datos actuales. ¿Continuar?')) return;
      state = L.normalizeState(data);
      toast('Datos importados');
      save();
    } catch (err) {
      toast('El archivo no es válido');
    } finally {
      e.target.value = '';
    }
  });

  $('#reset-btn').addEventListener('click', () => {
    if (!confirm('Se van a borrar TODOS los datos. ¿Seguro?')) return;
    state = L.defaultState();
    save();
  });

  // ---------- Inicio ----------
  $('#today-label').textContent = L.parseISO(today).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#tx-form').date.value = today;
  render();
})();
