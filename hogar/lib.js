// Lógica pura (sin DOM) de la app. Se usa en el navegador y en los tests de Node.
(function (root) {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');

  function toISO(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Parsea 'YYYY-MM-DD' como fecha local (evita corrimientos por zona horaria).
  function parseISO(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function todayISO() {
    return toISO(new Date());
  }

  function monthKey(iso) {
    return iso.slice(0, 7);
  }

  function addMonths(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function formatMoney(n, currency) {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: currency || 'ARS',
      maximumFractionDigits: 2,
    }).format(n || 0);
  }

  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  function monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }

  // Totales de un mes: ingresos, gastos, balance y gastos por categoría.
  function summarizeMonth(transactions, key) {
    const res = { income: 0, expense: 0, balance: 0, byCategory: {} };
    for (const t of transactions) {
      if (monthKey(t.date) !== key) continue;
      const amount = Number(t.amount) || 0;
      if (t.type === 'income') {
        res.income += amount;
      } else {
        res.expense += amount;
        res.byCategory[t.category] = (res.byCategory[t.category] || 0) + amount;
      }
    }
    res.balance = res.income - res.expense;
    return res;
  }

  // Estado de cada presupuesto: gastado, restante y porcentaje usado.
  function budgetStatus(budgets, byCategory) {
    return Object.entries(budgets)
      .filter(([, limit]) => Number(limit) > 0)
      .map(([category, limit]) => {
        const spent = byCategory[category] || 0;
        return {
          category,
          limit: Number(limit),
          spent,
          remaining: Number(limit) - spent,
          pct: Math.round((spent / Number(limit)) * 100),
        };
      });
  }

  // Próxima fecha de una tarea repetitiva. Para mensual, ajusta al último día
  // del mes si el día original no existe (ej. 31 -> 30 de abril).
  function nextDueDate(iso, repeat) {
    const d = parseISO(iso);
    if (repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else if (repeat === 'monthly') {
      const day = d.getDate();
      const target = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      target.setDate(Math.min(day, lastDay));
      return toISO(target);
    } else return null;
    return toISO(d);
  }

  // Grilla de 6 semanas (lunes a domingo) que contiene el mes indicado.
  function monthGrid(key) {
    const [y, m] = key.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const offset = (first.getDay() + 6) % 7; // lunes = 0
    const start = new Date(y, m - 1, 1 - offset);
    const days = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = toISO(d);
      days.push({ iso, day: d.getDate(), inMonth: monthKey(iso) === key });
    }
    return days;
  }

  // Agenda por fecha: eventos y tareas pendientes con vencimiento.
  function agendaByDate(state) {
    const map = {};
    const push = (date, item) => (map[date] = map[date] || []).push(item);
    for (const e of state.events) push(e.date, { kind: 'event', ...e });
    for (const t of state.tasks) {
      if (t.due && !t.done) push(t.due, { kind: 'task', ...t });
    }
    for (const list of Object.values(map)) {
      list.sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
    }
    return map;
  }

  function daysBetween(fromIso, toIsoStr) {
    return Math.round((parseISO(toIsoStr) - parseISO(fromIso)) / 86400000);
  }

  const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

  // Pendientes primero, luego por vencimiento (sin fecha al final) y prioridad.
  function sortTasks(tasks) {
    return [...tasks].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const da = a.due || '9999-12-31';
      const db = b.due || '9999-12-31';
      if (da !== db) return da.localeCompare(db);
      return (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
    });
  }

  // Completa una tarea; si se repite, agrega la siguiente ocurrencia.
  function completeTask(tasks, id, today) {
    const out = [];
    for (const t of tasks) {
      if (t.id !== id) { out.push(t); continue; }
      out.push({ ...t, done: true, doneAt: today });
      if (t.repeat && t.repeat !== 'none') {
        const next = nextDueDate(t.due || today, t.repeat);
        out.push({ ...t, id: uid(), done: false, doneAt: null, due: next });
      }
    }
    return out;
  }

  function defaultState() {
    return {
      version: 1,
      currency: 'ARS',
      members: ['Yo'],
      categories: {
        expense: ['Supermercado', 'Servicios', 'Alquiler/Expensas', 'Transporte', 'Salud',
          'Educación', 'Ocio', 'Ropa', 'Hogar', 'Otros'],
        income: ['Sueldo', 'Extras', 'Otros ingresos'],
      },
      budgets: {},
      transactions: [],
      tasks: [],
      events: [],
    };
  }

  // Une un estado guardado/importado con los valores por defecto.
  function normalizeState(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== 'object') return base;
    const s = { ...base, ...raw };
    s.categories = { ...base.categories, ...(raw.categories || {}) };
    for (const k of ['members', 'transactions', 'tasks', 'events']) {
      if (!Array.isArray(s[k])) s[k] = base[k];
    }
    if (!s.members.length) s.members = base.members;
    if (!s.budgets || typeof s.budgets !== 'object') s.budgets = {};
    return s;
  }

  const api = {
    toISO, parseISO, todayISO, monthKey, addMonths, uid, formatMoney, monthLabel,
    summarizeMonth, budgetStatus, nextDueDate, monthGrid, agendaByDate, daysBetween,
    sortTasks, completeTask, defaultState, normalizeState,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HomeLib = api;
})(typeof window !== 'undefined' ? window : globalThis);
