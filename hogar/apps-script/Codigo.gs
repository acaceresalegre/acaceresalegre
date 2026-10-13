/**
 * Cuentas Casa: servidor de sincronización (Google Apps Script).
 *
 * Va pegado en la planilla «Cuentas Casa - base de datos» (Extensiones → Apps Script)
 * y se publica como aplicación web. La app lee y escribe la planilla a través de este
 * script, que además genera las facturas de cada mes y las agenda en Google Calendar.
 */

var APP_URL = 'https://acaceresalegre.github.io/acaceresalegre/';
var CALENDAR_NAME_DEFAULT = 'Cuentas Casa';
var EVENT_HOUR = 9;

// Pestañas que maneja la app. key: columnas que identifican una fila.
var TABLES = {
  'Movimientos': {
    key: ['ID'], dates: ['Fecha'],
    text: ['ID', 'Tipo', 'Categoría', 'Subcategoría', 'Moneda', 'Medio de pago', 'Entidad', 'Comentarios', 'Cargado por'],
  },
  'Facturas': {
    key: ['ID'], dates: ['Vence', 'Fecha de pago'],
    text: ['ID', 'Nombre', 'Categoría', 'Subcategoría', 'Moneda', 'Pagada', 'Medio de pago', 'Recurrente ID',
      'Préstamo ID', 'Avisos (días antes)', 'Evento de calendario'],
  },
  'Recurrentes': {
    key: ['ID'], dates: [],
    text: ['ID', 'Nombre', 'Categoría', 'Subcategoría', 'Moneda', 'Avisos (días antes)', 'Activa'],
    softDelete: { column: 'Activa', value: 'No' },
  },
  'Por cobrar': {
    key: ['ID'], dates: ['Fecha de emisión', 'Vence', 'Fecha de cobro'],
    text: ['ID', 'NIT', 'Cliente', 'Moneda', 'Estado', 'Movimiento ID'],
  },
  'Categorías': { key: ['Categoría', 'Subcategoría'], dates: [], text: ['Categoría', 'Subcategoría', 'Tipo'] },
  'Ajustes': { key: ['Ajuste'], dates: [], text: ['Ajuste', 'Fuente o nota'] },
  'Deudas': { readOnly: true, dates: ['Próximo vencimiento'] },
  'Presupuesto': { readOnly: true, dates: ['Mes'] },
  'Listas': { readOnly: true, dates: [] },
};
var PULL_TABLES = ['Movimientos', 'Facturas', 'Recurrentes', 'Por cobrar', 'Categorías', 'Ajustes', 'Deudas', 'Presupuesto', 'Listas'];

// ---------- Entrada web ----------

function doGet(e) {
  var p = (e && e.parameter) || {};
  return respond(function () {
    checkToken(p.token);
    if (p.action === 'version') return { ok: true, version: getVersion() };
    return pullPayload();
  });
}

function doPost(e) {
  return respond(function () {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkToken(body.token);
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var touchedBills = applyOps(body.ops || [], String(body.user || ''));
      var generated = generarFacturas();
      syncEventsFor(touchedBills.concat(generated));
      if ((body.ops || []).length || generated.length) bumpVersion();
    } finally {
      lock.releaseLock();
    }
    return pullPayload();
  });
}

function respond(fn) {
  var out;
  try {
    out = fn();
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('token');
  if (!expected || token !== expected) throw new Error('Código de acceso inválido');
}

function pullPayload() {
  var tables = {};
  PULL_TABLES.forEach(function (name) { tables[name] = readTable(name).rows; });
  return { ok: true, version: getVersion(), tables: tables };
}

// ---------- Versión (para que la app sepa si hay cambios) ----------

function getVersion() {
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty('version');
  if (!v) { v = String(Date.now()); props.setProperty('version', v); }
  return v;
}

// Siempre creciente, aunque dos cambios caigan en el mismo milisegundo.
function bumpVersion() {
  var props = PropertiesService.getScriptProperties();
  var next = Math.max(Date.now(), Number(props.getProperty('version') || 0) + 1);
  props.setProperty('version', String(next));
}

// Activador simple: cualquier edición a mano en la planilla avisa a la app.
function onEdit() {
  bumpVersion();
}

// ---------- Lectura y escritura de pestañas ----------

function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }
function tz() { return ss().getSpreadsheetTimeZone(); }

function sheetOf(name) {
  var sh = ss().getSheetByName(name);
  if (!sh) throw new Error('Falta la pestaña «' + name + '»');
  return sh;
}

function cellOut(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz(), 'yyyy-MM-dd');
  return v;
}

function readTable(name) {
  var sh = sheetOf(name);
  var values = sh.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  var index = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.every(function (v) { return v === '' || v === null; })) continue;
    var obj = {};
    headers.forEach(function (h, c) { if (h && row[c] !== '' && row[c] !== null) obj[h] = cellOut(row[c]); });
    rows.push(obj);
    index.push(r + 1);
  }
  return { sheet: sh, headers: headers, rows: rows, rowNumbers: index };
}

function keyOf(cfg, obj) {
  return cfg.key.map(function (k) { return String(obj[k] === undefined || obj[k] === null ? '' : obj[k]).trim(); }).join('|');
}

function cellIn(cfg, header, value) {
  if (value === undefined || value === null) return '';
  if (cfg.dates.indexOf(header) >= 0 && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Utilities.parseDate(value + ' 12:00', tz(), 'yyyy-MM-dd HH:mm');
  }
  return value;
}

// Aplica los cambios de la app. Devuelve los ID de facturas tocadas.
function applyOps(ops, user) {
  var touched = [];
  var byTable = {};
  ops.forEach(function (op) { (byTable[op.table] = byTable[op.table] || []).push(op); });
  Object.keys(byTable).forEach(function (name) {
    var cfg = TABLES[name];
    if (!cfg || cfg.readOnly) throw new Error('La pestaña «' + name + '» no se puede modificar desde la app');
    var t = readTable(name);
    var where = {};
    t.rows.forEach(function (row, i) { where[keyOf(cfg, row)] = t.rowNumbers[i]; });
    var deletes = [];
    byTable[name].forEach(function (op) {
      var row = op.row || {};
      var k = keyOf(cfg, row);
      if (!k.replace(/\|/g, '')) return;
      var rowNumber = where[k];
      if (op.op === 'delete') {
        if (!rowNumber) return;
        if (cfg.softDelete) {
          writeCells(t, cfg, rowNumber, (function () { var o = {}; o[cfg.softDelete.column] = cfg.softDelete.value; return o; })());
        } else {
          deletes.push(rowNumber);
          if (name === 'Facturas') deleteEventFor(t, rowNumber);
        }
        return;
      }
      var data = {};
      Object.keys(row).forEach(function (h) { data[h] = row[h]; });
      if (t.headers.indexOf('Actualizado') >= 0) data['Actualizado'] = new Date();
      if (!rowNumber) {
        if (t.headers.indexOf('Cargado por') >= 0 && user) data['Cargado por'] = user;
        rowNumber = appendRow(t, cfg);
        where[k] = rowNumber;
      }
      writeCells(t, cfg, rowNumber, data);
      if (name === 'Facturas') touched.push(String(row.ID));
    });
    deletes.sort(function (a, b) { return b - a; }).forEach(function (n) { t.sheet.deleteRow(n); });
  });
  return touched;
}

function appendRow(t, cfg) {
  var sh = t.sheet;
  var n = sh.getLastRow() + 1;
  if (n > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
  if (n > 2) sh.getRange(2, 1, 1, t.headers.length).copyFormatToRange(sh, 1, t.headers.length, n, n);
  (cfg.text || []).forEach(function (h) {
    var c = t.headers.indexOf(h);
    if (c >= 0) sh.getRange(n, c + 1).setNumberFormat('@');
  });
  return n;
}

// Escribe solo las columnas recibidas; las demás de la fila quedan como estaban.
function writeCells(t, cfg, rowNumber, data) {
  var range = t.sheet.getRange(rowNumber, 1, 1, t.headers.length);
  var row = range.getValues()[0];
  Object.keys(data).forEach(function (h) {
    var c = t.headers.indexOf(h);
    if (c >= 0) row[c] = cellIn(cfg, h, data[h]);
  });
  range.setValues([row]);
}

// ---------- Facturas de cada mes ----------

function monthKeyOf(iso) { return String(iso).slice(0, 7); }

function addMonthsKey(key, delta) {
  var y = Number(key.slice(0, 4));
  var m = Number(key.slice(5, 7)) - 1 + delta;
  var d = new Date(y, m, 1);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

function dateInMonth(key, day) {
  var y = Number(key.slice(0, 4));
  var m = Number(key.slice(5, 7));
  var last = new Date(y, m, 0).getDate();
  return key + '-' + ('0' + Math.min(Number(day) || 1, last)).slice(-2);
}

function todayIso() { return Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd'); }

function newId(prefix) { return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }

// Crea las facturas del mes actual y el siguiente desde Recurrentes y Cuotas. Devuelve los ID creados.
function generarFacturas() {
  var months = [monthKeyOf(todayIso())];
  months.push(addMonthsKey(months[0], 1));
  var bills = readTable('Facturas').rows;
  var has = {};
  bills.forEach(function (b) {
    var m = monthKeyOf(b['Vence'] || '');
    if (b['Recurrente ID']) has['R|' + b['Recurrente ID'] + '|' + m] = true;
    if (b['Préstamo ID']) has['P|' + b['Préstamo ID'] + '|' + m] = true;
  });
  // No se crean facturas que vencían antes de instalar: ya estarían pagadas por fuera de la app.
  var desde = PropertiesService.getScriptProperties().getProperty('instaladoEl') || todayIso();
  var nuevos = [];
  readTable('Recurrentes').rows.forEach(function (r) {
    if (String(r['Activa'] || 'Sí') === 'No' || !r['ID']) return;
    months.forEach(function (m) {
      if (has['R|' + r['ID'] + '|' + m] || dateInMonth(m, r['Día']) < desde) return;
      nuevos.push({ ID: newId('F'), Nombre: r['Nombre'], 'Categoría': r['Categoría'], 'Subcategoría': r['Subcategoría'] || '',
        Moneda: r['Moneda'] || 'COP', Importe: Number(r['Importe']) || 0, Vence: dateInMonth(m, r['Día']), Pagada: 'No',
        'Recurrente ID': r['ID'], 'Avisos (días antes)': String(r['Avisos (días antes)'] || '3,0') });
    });
  });
  var deudas = {};
  readTable('Deudas').rows.forEach(function (d) { deudas[d['ID']] = d['Préstamo']; });
  var cuotas = ss().getSheetByName('Cuotas') ? readTable('Cuotas').rows : [];
  cuotas.forEach(function (c) {
    var m = monthKeyOf(c['Vencimiento'] || '');
    var id = c['ID préstamo'];
    if (months.indexOf(m) < 0 || !(Number(c['Cuota']) > 0) || has['P|' + id + '|' + m] || c['Vencimiento'] < desde) return;
    has['P|' + id + '|' + m] = true;
    var name = deudas[id] || c['Préstamo'] || id;
    nuevos.push({ ID: newId('F'), Nombre: name, 'Categoría': 'Obligaciones_financieras', 'Subcategoría': name,
      Moneda: c['Moneda'] || 'COP', Importe: Number(c['Cuota']), Vence: c['Vencimiento'], Pagada: 'No',
      'Préstamo ID': id, 'Avisos (días antes)': '3,0' });
  });
  if (nuevos.length) applyOps(nuevos.map(function (row) { return { table: 'Facturas', op: 'upsert', row: row }; }), 'Automático');
  return nuevos.map(function (r) { return r.ID; });
}

// ---------- Google Calendar ----------

function calendar() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('calendarId');
  var cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    var name = settingValue('Calendario') || CALENDAR_NAME_DEFAULT;
    var found = CalendarApp.getCalendarsByName(name);
    cal = found.length ? found[0] : CalendarApp.createCalendar(name);
    props.setProperty('calendarId', cal.getId());
  }
  return cal;
}

function settingValue(name) {
  try {
    var rows = readTable('Ajustes').rows;
    for (var i = 0; i < rows.length; i++) if (rows[i]['Ajuste'] === name) return rows[i]['Valor'];
  } catch (e) { /* sin pestaña Ajustes */ }
  return null;
}

var PREFIX = { COP: '$', ARS: 'AR$', USD: 'US$' };
function money(amount, cur) {
  var dec = cur === 'USD' ? 2 : 0;
  var parts = Math.abs(Number(amount) || 0).toFixed(dec).split('.');
  var n = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (parts[1] ? ',' + parts[1] : '');
  return (PREFIX[cur] || '$') + ' ' + n;
}

function parseAlerts(v) {
  var list = String(v === undefined || v === null || v === '' ? '3,0' : v).split(/[,;\s]+/)
    .map(Number).filter(function (n) { return !isNaN(n) && n >= 0 && n <= 28; });
  if (typeof v === 'number') list = [v];
  return list.slice(0, 5);
}

function eventSpec(b) {
  var paid = String(b['Pagada']) === 'Sí';
  var alerts = paid ? [] : parseAlerts(b['Avisos (días antes)']);
  var title = (paid ? '✓ Pagada: ' : 'Pagar ') + b['Nombre'] + ' · ' + money(b['Importe'], b['Moneda']);
  var start = Utilities.parseDate(b['Vence'] + ' ' + ('0' + EVENT_HOUR).slice(-2) + ':00', tz(), 'yyyy-MM-dd HH:mm');
  var end = new Date(start.getTime() + 30 * 60000);
  var sig = [title, b['Vence'], alerts.join(',')].join('|');
  return { title: title, start: start, end: end, alerts: alerts, sig: sig,
    description: [b['Categoría'], b['Subcategoría']].filter(String).join(' · ') + '\nCuentas Casa' };
}

// Crea o actualiza el evento de cada factura indicada (o de todas las del período si ids es null).
function syncEventsFor(ids) {
  if (ids && !ids.length) return;
  var t = readTable('Facturas');
  var col = t.headers.indexOf('Evento de calendario');
  if (col < 0) return;
  var cal = calendar();
  var from = isoAdd(todayIso(), -35);
  var to = isoAdd(todayIso(), 400);
  var wanted = ids ? ids.reduce(function (o, id) { o[id] = true; return o; }, {}) : null;
  t.rows.forEach(function (b, i) {
    if (wanted && !wanted[String(b['ID'])]) return;
    if (!b['Vence'] || b['Vence'] < from || b['Vence'] > to) return;
    var spec = eventSpec(b);
    var ev = b['Evento de calendario'] ? cal.getEventById(String(b['Evento de calendario'])) : null;
    if (ev && ev.getTag('sig') === spec.sig) return;
    if (!ev) {
      ev = cal.createEvent(spec.title, spec.start, spec.end, { description: spec.description });
      ev.setTag('facturaId', String(b['ID']));
      t.sheet.getRange(t.rowNumbers[i], col + 1).setValue(ev.getId());
    } else {
      ev.setTitle(spec.title);
      ev.setTime(spec.start, spec.end);
      ev.setDescription(spec.description);
    }
    ev.removeAllReminders();
    spec.alerts.forEach(function (d) { ev.addPopupReminder(Math.max(d * 1440, 0)); });
    ev.setTag('sig', spec.sig);
  });
}

function deleteEventFor(t, rowNumber) {
  var col = t.headers.indexOf('Evento de calendario');
  if (col < 0) return;
  var id = t.sheet.getRange(rowNumber, col + 1).getValue();
  if (!id) return;
  try {
    var ev = calendar().getEventById(String(id));
    if (ev) ev.deleteEvent();
  } catch (e) { /* el evento ya no existe */ }
}

// Borra eventos de facturas que ya no están en la planilla.
function limpiarEventos() {
  var ids = {};
  readTable('Facturas').rows.forEach(function (b) { ids[String(b['ID'])] = true; });
  var start = Utilities.parseDate(isoAdd(todayIso(), -35) + ' 00:00', tz(), 'yyyy-MM-dd HH:mm');
  var end = Utilities.parseDate(isoAdd(todayIso(), 400) + ' 00:00', tz(), 'yyyy-MM-dd HH:mm');
  calendar().getEvents(start, end).forEach(function (ev) {
    var fid = ev.getTag('facturaId');
    if (fid && !ids[fid]) ev.deleteEvent();
  });
}

function isoAdd(iso, days) {
  var d = Utilities.parseDate(iso + ' 12:00', tz(), 'yyyy-MM-dd HH:mm');
  return Utilities.formatDate(new Date(d.getTime() + days * 86400000), tz(), 'yyyy-MM-dd');
}

// ---------- Tarea programada ----------

function tareaPeriodica() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var generated = generarFacturas();
    syncEventsFor(null);
    limpiarEventos();
    if (generated.length) bumpVersion();
  } finally {
    lock.releaseLock();
  }
}

// ---------- Instalación y menú ----------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Cuentas Casa')
    .addItem('1. Instalar', 'instalar')
    .addItem('2. Conectar la app', 'conectarApp')
    .addItem('Cambiar la dirección de la app web', 'cambiarDireccion')
    .addSeparator()
    .addItem('Crear facturas y actualizar calendario ahora', 'tareaPeriodica')
    .addToUi();
}

function instalar() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('token')) props.setProperty('token', Utilities.getUuid().replace(/-/g, ''));
  if (!props.getProperty('instaladoEl')) props.setProperty('instaladoEl', todayIso());
  // Columnas de texto: evita que Sheets convierta "3,0" o un NIT en número.
  Object.keys(TABLES).forEach(function (name) {
    var cfg = TABLES[name];
    if (cfg.readOnly) return;
    var sh = ss().getSheetByName(name);
    if (!sh) return;
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    (cfg.text || []).forEach(function (h) {
      var c = headers.indexOf(h);
      if (c >= 0 && sh.getMaxRows() > 1) sh.getRange(2, c + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  });
  corregirTasaArs();
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'tareaPeriodica') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('tareaPeriodica').timeBased().everyHours(1).create();
  tareaPeriodica();
  SpreadsheetApp.getUi().alert('Listo', 'Se crearon las facturas del mes, el calendario «' + calendar().getName() +
    '» y la actualización automática cada hora.\n\nAhora usá «2. Conectar la app».', SpreadsheetApp.getUi().ButtonSet.OK);
}

// La primera versión de la planilla guardó la tasa ARS redondeada a 2,14.
function corregirTasaArs() {
  var t = readTable('Ajustes');
  t.rows.forEach(function (r, i) {
    if (r['Ajuste'] === 'Tasa ARS (COP por 1 ARS)' && Number(r['Valor']) === 2.14) {
      t.sheet.getRange(t.rowNumbers[i], t.headers.indexOf('Valor') + 1).setValue(2.13845);
    }
  });
}

function conectarApp() {
  var ui = SpreadsheetApp.getUi();
  var token = PropertiesService.getScriptProperties().getProperty('token');
  if (!token) { ui.alert('Primero usá «1. Instalar».'); return; }
  // No se usa ScriptApp.getService().getUrl(): en el editor nuevo puede devolver una dirección
  // que termina en /exec pero no es la implementación publicada. Se pide una vez y se guarda.
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('webAppUrl');
  if (!url) {
    var res = ui.prompt('Dirección de la aplicación web',
      'Pegá la URL de la aplicación web (Apps Script → Implementar → Gestionar implementaciones). Termina en /exec.',
      ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return;
    url = res.getResponseText().replace(/\s+/g, '');
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
      ui.alert('Esa dirección no parece la de la aplicación web: tiene que empezar con https://script.google.com/ y terminar en /exec.');
      return;
    }
    props.setProperty('webAppUrl', url);
  }
  var link = function (who) {
    return APP_URL + '#conectar=' + encodeURIComponent(url) + '&token=' + token + '&quien=' + encodeURIComponent(who);
  };
  var html = '<div style="font:14px Arial;line-height:1.5">' +
    '<p>Abrí el enlace de cada uno <b>en su celular</b> (por ejemplo, mandándoselo por WhatsApp a uno mismo):</p>' +
    '<p><a target="_blank" href="' + link('Alan') + '">Conectar la app de Alan</a></p>' +
    '<p><a target="_blank" href="' + link('Karo') + '">Conectar la app de Karo</a></p>' +
    '<p style="color:#6F6B63">Si el enlace no funciona, en la app andá a Ajustes → Planilla de Google y cargá a mano:</p>' +
    '<p style="font:12px monospace;word-break:break-all">Dirección: ' + url + '<br>Código: ' + token + '</p>' +
    '<p style="color:#6F6B63">Los enlaces y el código dan acceso a la planilla: no los compartas con nadie más.</p></div>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(460).setHeight(380), 'Conectar la app');
}

function cambiarDireccion() {
  PropertiesService.getScriptProperties().deleteProperty('webAppUrl');
  conectarApp();
}
