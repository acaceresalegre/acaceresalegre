// Simulación mínima de Google Apps Script para probar apps-script/Codigo.gs en Node.
// Cubre solo lo que usa el script: hojas como matrices, propiedades, calendario y respuestas web.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pad = (n) => String(n).padStart(2, '0');

class FakeRange {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = this.sheet.data[this.row - 1 + r] || [];
      const vals = [];
      for (let c = 0; c < this.cols; c++) {
        const v = line[this.col - 1 + c];
        vals.push(v === undefined || v === null ? '' : v);
      }
      out.push(vals);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  setNumberFormat() { return this; }
  copyFormatToRange() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
}

class FakeSheet {
  constructor(name, data) {
    this.name = name;
    this.data = data.map((r) => r.slice());
    this.maxRows = Math.max(this.data.length, 1000);
  }
  set(row, col, v) {
    while (this.data.length < row) this.data.push([]);
    this.data[row - 1][col - 1] = v;
  }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.data.length; r > 0; r--) {
      if ((this.data[r - 1] || []).some((v) => v !== '' && v !== null && v !== undefined)) return r;
    }
    return 0;
  }
  getLastColumn() { return Math.max(0, ...this.data.map((r) => r.length)); }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  deleteRow(n) { this.data.splice(n - 1, 1); }
  getRange(row, col, rows = 1, cols = 1) { return new FakeRange(this, row, col, rows, cols); }
  getDataRange() { return new FakeRange(this, 1, 1, this.getLastRow(), this.getLastColumn()); }
  setFrozenRows() { return this; }
}

class FakeEvent {
  constructor(cal, title, start, end, opts) {
    Object.assign(this, { cal, title, start, end, description: (opts || {}).description || '', tags: {}, reminders: [] });
    this.id = 'ev' + (++FakeEvent.seq) + '@google.com';
  }
  getId() { return this.id; }
  getTitle() { return this.title; }
  setTitle(t) { this.title = t; }
  setTime(s, e) { this.start = s; this.end = e; }
  setDescription(d) { this.description = d; }
  getTag(k) { return this.tags[k] === undefined ? null : this.tags[k]; }
  setTag(k, v) { this.tags[k] = v; }
  removeAllReminders() { this.reminders = []; }
  addPopupReminder(m) { this.reminders.push(m); }
  deleteEvent() { this.cal.events = this.cal.events.filter((e) => e !== this); }
}
FakeEvent.seq = 0;

class FakeCalendar {
  constructor(name) { this.name = name; this.id = 'cal-' + name; this.events = []; }
  getId() { return this.id; }
  getName() { return this.name; }
  createEvent(title, start, end, opts) { const e = new FakeEvent(this, title, start, end, opts); this.events.push(e); return e; }
  getEventById(id) { return this.events.find((e) => e.id === id) || null; }
  getEvents(start, end) { return this.events.filter((e) => e.start >= start && e.start < end); }
}

// tables: { 'Movimientos': [[headers...], [row...]], ... }. Fechas como objetos Date.
function createGas(tables, opts = {}) {
  const sheets = Object.fromEntries(Object.entries(tables).map(([n, d]) => [n, new FakeSheet(n, d)]));
  const props = { token: opts.token || 'secreto' };
  const calendars = [];
  const ui = { prompts: [], promptAnswer: null, dialogs: [], alerts: [] };
  const mails = [];
  const triggers = [];
  const now = opts.now || (() => new Date());

  const Utilities = {
    formatDate(d, _tz, fmt) {
      const map = { yyyy: d.getFullYear(), MM: pad(d.getMonth() + 1), dd: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()) };
      return fmt.replace(/yyyy|MM|dd|HH|mm/g, (k) => map[k]);
    },
    parseDate(s) {
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/);
      return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    },
    getUuid() { return require('crypto').randomUUID(); },
  };
  class FixedDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(now().getTime()); }
    static now() { return now().getTime(); }
    static [Symbol.hasInstance](x) { return x instanceof Date; }
  }
  const sandbox = {
    Date: FixedDate,
    Math, JSON, String, Number, Object, Array, Error, isNaN, encodeURIComponent,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets[n] || null,
        getSpreadsheetTimeZone: () => 'America/Bogota',
        getUrl: () => 'https://docs.google.com/spreadsheets/d/PRUEBA/edit',
        insertSheet: (n) => (sheets[n] = new FakeSheet(n, [])),
      }),
      getUi: () => ({
        ButtonSet: { OK: 'ok', OK_CANCEL: 'okc' }, Button: { OK: 'ok', CANCEL: 'cancel' },
        alert: (...a) => ui.alerts.push(a.join(' ')),
        prompt: (title) => {
          ui.prompts.push(title);
          return { getSelectedButton: () => (ui.promptAnswer === null ? 'cancel' : 'ok'), getResponseText: () => ui.promptAnswer || '' };
        },
        showModalDialog: (html, title) => ui.dialogs.push({ title, html: html.html }),
        createMenu() { return { addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }; } }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    CalendarApp: {
      getCalendarById: (id) => calendars.find((c) => c.id === id) || null,
      getCalendarsByName: (n) => calendars.filter((c) => c.name === n),
      createCalendar: (n) => { const c = new FakeCalendar(n); calendars.push(c); return c; },
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((fn) => ({ getHandlerFunction: () => fn })),
      deleteTrigger: (tr) => { triggers.splice(triggers.indexOf(tr.getHandlerFunction()), 1); },
      newTrigger: (fn) => ({ timeBased() { return this; }, everyHours() { return this; }, everyDays() { return this; }, atHour() { return this; }, create() { triggers.push(fn); } }),
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => opts.owner || 'alan@example.com' }) },
    MailApp: { sendEmail: (m) => mails.push(m) },
    Utilities,
    HtmlService: { createHtmlOutput: (html) => ({ html, setWidth() { return this; }, setHeight() { return this; } }) },
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Codigo.gs'), 'utf8');
  vm.runInContext(code, sandbox);

  return {
    sheets, props, calendars, sandbox, ui, mails, triggers,
    get(params) { return JSON.parse(sandbox.doGet({ parameter: params }).text); },
    post(body) { return JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).text); },
    run(fn) { return sandbox[fn](); },
  };
}

module.exports = { createGas, FakeSheet };
