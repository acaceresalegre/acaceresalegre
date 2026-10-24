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
    text: ['ID', 'Tipo', 'Categoría', 'Subcategoría', 'Moneda', 'Medio de pago', 'Entidad', 'Comentarios', 'Cargado por', 'Pagó', 'Meta ID', 'Por cobrar ID',
      'Origen ID', 'Destino ID'],
    addable: ['Pagó', 'Meta ID', 'Por cobrar ID', 'Origen ID', 'Destino ID'], // columnas nuevas que se agregan solas si la planilla todavía no las tiene
  },
  'Facturas': {
    key: ['ID'], dates: ['Vence', 'Fecha de pago'],
    text: ['ID', 'Nombre', 'Categoría', 'Subcategoría', 'Moneda', 'Pagada', 'Medio de pago', 'Recurrente ID',
      'Préstamo ID', 'Avisos (días antes)', 'Evento de calendario'],
  },
  'Recurrentes': {
    key: ['ID'], dates: [],
    text: ['ID', 'Nombre', 'Categoría', 'Subcategoría', 'Moneda', 'Avisos (días antes)', 'Activa', 'Desde'],
    softDelete: { column: 'Activa', value: 'No' },
    addable: ['Desde'], // primer mes (AAAA-MM) de una factura mensual nueva
  },
  'Por cobrar': {
    key: ['ID'], dates: ['Fecha de emisión', 'Vence', 'Fecha de cobro'],
    text: ['ID', 'NIT', 'Cliente', 'Moneda', 'Estado', 'Movimiento ID'],
    addable: ['Retención'], // parte no cobrada que fue retención en la fuente (saldo a favor en la renta)
  },
  'Categorías': { key: ['Categoría', 'Subcategoría'], dates: [], text: ['Categoría', 'Subcategoría', 'Tipo'] },
  'Ajustes': { key: ['Ajuste'], dates: [], text: ['Ajuste', 'Fuente o nota'],
    allowedKeys: ['Tasa USD (COP por 1 USD)', 'Tasa ARS (COP por 1 ARS)', 'Umbral de aviso de presupuesto'] },
  'Deudas': { readOnly: true, dates: ['Próximo vencimiento'] },
  // Una fila por mes, categoría y subcategoría. La app edita el límite de una categoría (del mes en adelante).
  'Presupuesto': { key: ['Mes', 'Categoría', 'Subcategoría'], dates: ['Mes'], text: ['Categoría', 'Subcategoría', 'Moneda'] },
  'Listas': { readOnly: true, dates: [] },
  'Reglas': { readOnly: true, dates: [], optional: true },
  'Metas': {
    key: ['ID'], dates: ['Fecha objetivo'], optional: true,
    text: ['ID', 'Nombre', 'Moneda', 'Activa', 'Comentarios'],
    softDelete: { column: 'Activa', value: 'No' },
    headers: ['ID', 'Nombre', 'Monto objetivo', 'Moneda', 'Fecha objetivo', 'Ahorro inicial', 'Activa', 'Comentarios', 'Actualizado'],
  },
  'Cuentas y bienes': {
    key: ['ID'], dates: [], optional: true,
    text: ['ID', 'Nombre', 'Tipo', 'Moneda', 'Activa', 'Comentarios'],
    softDelete: { column: 'Activa', value: 'No' },
    headers: ['ID', 'Nombre', 'Tipo', 'Moneda', 'Activa', 'Comentarios', 'Actualizado'],
  },
  // Sueldos y otros cobros que se esperan cada mes (Días de cobro: «15, 30» para una quincena).
  'Ingresos esperados': {
    key: ['ID'], dates: [], optional: true,
    text: ['ID', 'Nombre', 'Subcategoría', 'Moneda', 'Días de cobro', 'Activa'],
    softDelete: { column: 'Activa', value: 'No' },
    headers: ['ID', 'Nombre', 'Subcategoría', 'Moneda', 'Importe', 'Días de cobro', 'Activa', 'Actualizado'],
  },
  // Saldo de cierre de cada cuenta o bien por mes (Mes = día 1 del mes).
  'Saldos': {
    key: ['Cuenta ID', 'Mes'], dates: ['Mes'], optional: true,
    text: ['Cuenta ID', 'Cuenta', 'Moneda'],
    headers: ['Cuenta ID', 'Cuenta', 'Mes', 'Moneda', 'Saldo', 'Actualizado'],
  },
  // Solo lectura y recortada a una ventana de meses (ver pullPayload): amortización, interés y saldo de cada cuota.
  'Cuotas': { readOnly: true, dates: ['Vencimiento'], optional: true },
};
var PULL_TABLES = ['Movimientos', 'Facturas', 'Recurrentes', 'Por cobrar', 'Categorías', 'Ajustes', 'Deudas', 'Presupuesto', 'Listas', 'Reglas', 'Metas', 'Cuentas y bienes', 'Saldos', 'Cuotas', 'Ingresos esperados'];
var CUOTAS_MESES_ATRAS = 25;
var CUOTAS_MESES_ADELANTE = 13;
var REGLAS_HEADERS = ['Contiene', 'Categoría', 'Subcategoría', 'Tipo', 'Activa'];
// Sube con cada cambio de este archivo que la app necesita; la app avisa si la planilla tiene uno más viejo.
var CODIGO_VERSION = 16;
var CARPETA_RESPALDO = 'Backup';
var PREFIJO_RESPALDO = 'Cuentas Casa - respaldo ';
var RESPALDOS_A_GUARDAR = 12;

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
    if (body.action === 'ocr') return { ok: true, text: leerImagen(body.image, body.mime) };
    if (body.action === 'version') return { ok: true, version: getVersion() };
    if (body.action === 'pull') return pullPayload();
    if ((body.ops || []).length > 3000) throw new Error('Demasiados cambios juntos');
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
  PULL_TABLES.forEach(function (name) {
    if (TABLES[name].optional && !ss().getSheetByName(name)) { tables[name] = []; return; }
    tables[name] = readTable(name).rows;
    if (name === 'Cuotas') {
      var hoy = monthKeyOf(todayIso());
      var desde = addMonthsKey(hoy, -CUOTAS_MESES_ATRAS);
      var hasta = addMonthsKey(hoy, CUOTAS_MESES_ADELANTE);
      tables[name] = tables[name].filter(function (c) {
        var k = String(c['Vencimiento'] || '').slice(0, 7);
        return c['ID préstamo'] && k >= desde && k <= hasta;
      });
    }
  });
  var respaldo = PropertiesService.getScriptProperties().getProperty('ultimoRespaldo') || '';
  return { ok: true, version: getVersion(), codigo: CODIGO_VERSION, respaldo: respaldo, tables: tables };
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

// Activador instalable: filas borradas o insertadas a mano también avisan a la app.
function alCambiar() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    completarIds();
  } finally {
    lock.releaseLock();
  }
  bumpVersion();
}

// Filas cargadas a mano en la planilla sin ID: se les pone uno para que la app las vea.
var PREFIJO_ID = { 'Movimientos': 'M', 'Facturas': 'F', 'Recurrentes': 'R', 'Por cobrar': 'C', 'Metas': 'G', 'Cuentas y bienes': 'A', 'Ingresos esperados': 'I' };

function completarIds() {
  var n = 0;
  Object.keys(PREFIJO_ID).forEach(function (name) {
    if (!ss().getSheetByName(name)) return;
    var t = readTable(name);
    var col = t.headers.indexOf('ID');
    if (col < 0) return;
    t.rows.forEach(function (row, i) {
      if (row['ID'] !== undefined && String(row['ID']).trim() !== '') return;
      // Solo si la fila tiene algo más que «Actualizado» (una fila vacía no cuenta).
      var datos = Object.keys(row).filter(function (h) { return h !== 'Actualizado'; });
      if (!datos.length) return;
      t.sheet.getRange(t.rowNumbers[i], col + 1).setValue(newId(PREFIJO_ID[name]));
      n++;
    });
  });
  return n;
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
    if (cfg.optional && !ss().getSheetByName(name)) crearPestana(name, cfg.headers);
    var wanted = {};
    byTable[name].forEach(function (op) { Object.keys(op.row || {}).forEach(function (h) { wanted[h] = true; }); });
    ensureHeaders(name, (cfg.addable || []).filter(function (h) { return wanted[h]; }));
    var t = readTable(name);
    // Clave → filas (puede haber filas duplicadas a mano con el mismo ID).
    var where = {};
    var byNumber = {};
    t.rows.forEach(function (row, i) {
      var k = keyOf(cfg, row);
      (where[k] = where[k] || []).push(t.rowNumbers[i]);
      byNumber[t.rowNumbers[i]] = row;
    });
    var deletes = {};
    byTable[name].forEach(function (op) {
      var row = op.row || {};
      var k = keyOf(cfg, row);
      if (!k.replace(/\|/g, '')) return;
      var found = where[k] || [];
      if (op.op === 'delete') {
        found.forEach(function (n) {
          if (cfg.softDelete) {
            writeCells(t, cfg, n, (function () { var o = {}; o[cfg.softDelete.column] = cfg.softDelete.value; return o; })());
          } else {
            deletes[n] = true;
            if (name === 'Facturas') { deleteEventFor(t, n); recordarOmitida(byNumber[n]); }
          }
        });
        // Si en el mismo envío se vuelve a crear esta clave, va a una fila nueva.
        if (!cfg.softDelete) where[k] = [];
        return;
      }
      if (cfg.allowedKeys && cfg.allowedKeys.indexOf(String(row[cfg.key[0]])) < 0) return;
      var rowNumber = found[0];
      var data = {};
      Object.keys(row).forEach(function (h) { data[h] = row[h]; });
      if (t.headers.indexOf('Actualizado') >= 0) data['Actualizado'] = new Date();
      if (!rowNumber) {
        if (t.headers.indexOf('Cargado por') >= 0 && user) data['Cargado por'] = user;
        rowNumber = appendRow(t, cfg);
        where[k] = [rowNumber];
      }
      writeCells(t, cfg, rowNumber, data);
      if (name === 'Facturas') touched.push(String(row.ID));
    });
    Object.keys(deletes).map(Number).sort(function (a, b) { return b - a; }).forEach(function (n) { t.sheet.deleteRow(n); });
  });
  return touched;
}

// Una factura mensual borrada desde la app no se vuelve a crear para ese mes.
function recordarOmitida(row) {
  if (!row || !row['Recurrente ID'] || !row['Vence']) return;
  PropertiesService.getScriptProperties().setProperty('omitida|' + row['Recurrente ID'] + '|' + monthKeyOf(row['Vence']), '1');
}

// Agrega al final de la fila 1 las columnas que falten (por ejemplo «Pagó» en planillas anteriores).
function ensureHeaders(name, headers) {
  if (!headers.length) return;
  var sh = sheetOf(name);
  var last = sh.getLastColumn();
  var current = sh.getRange(1, 1, 1, last).getValues()[0].map(function (h) { return String(h).trim(); });
  headers.forEach(function (h) {
    if (current.indexOf(h) >= 0) return;
    last++;
    sh.getRange(1, last).setValue(h);
    if (last > 1) sh.getRange(1, last - 1).copyFormatToRange(sh, last, last, 1, 1);
    current.push(h);
  });
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
  // Las celdas con fórmula que la app no toca se reescriben como fórmula, no como su valor.
  var formulas = range.getFormulas()[0];
  formulas.forEach(function (f, c) { if (f) row[c] = f; });
  Object.keys(data).forEach(function (h) {
    var c = t.headers.indexOf(h);
    if (c < 0) return;
    var v = cellIn(cfg, h, data[h]);
    // Un texto que empieza con = o @ quedaría como fórmula: se guarda como texto.
    if (typeof v === 'string' && /^[=@]/.test(v)) v = "'" + v;
    row[c] = v;
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
    var props = PropertiesService.getScriptProperties();
    months.forEach(function (m) {
      if (has['R|' + r['ID'] + '|' + m] || dateInMonth(m, r['Día']) < desde) return;
      if (r['Desde'] && m < String(r['Desde']).slice(0, 7)) return;
      if (props.getProperty('omitida|' + r['ID'] + '|' + m)) return;
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
    var ids = completarIds();
    var generated = generarFacturas();
    syncEventsFor(null);
    limpiarEventos();
    if (generated.length || ids) bumpVersion();
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
    .addItem('Enviar cierre preliminar de prueba', 'probarMailCierre')
    .addItem('Hacer un respaldo ahora', 'respaldarAhora')
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
  ensureHeaders('Movimientos', ['Pagó', 'Meta ID', 'Por cobrar ID', 'Origen ID', 'Destino ID']);
  ensureHeaders('Recurrentes', ['Desde']);
  ensureHeaders('Por cobrar', ['Retención']);
  crearReglas();
  crearPestana('Metas', TABLES['Metas'].headers);
  crearPestana('Cuentas y bienes', TABLES['Cuentas y bienes'].headers);
  crearPestana('Saldos', TABLES['Saldos'].headers);
  crearPestana('Ingresos esperados', TABLES['Ingresos esperados'].headers);
  asegurarAjuste('Correos del resumen', Session.getEffectiveUser().getEmail(),
    'Separados por coma. Reciben el cierre preliminar (' + DIAS_ANTES_CIERRE + ' días antes de fin de mes) y el resumen (día 1).');
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    var fn = tr.getHandlerFunction();
    if (['tareaPeriodica', 'tareaDiaria', 'alCambiar', 'respaldoSemanal'].indexOf(fn) >= 0) ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('tareaPeriodica').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('tareaDiaria').timeBased().everyDays(1).atHour(8).create();
  ScriptApp.newTrigger('alCambiar').forSpreadsheet(ss()).onChange().create();
  ScriptApp.newTrigger('respaldoSemanal').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
  tareaPeriodica();
  if (!PropertiesService.getScriptProperties().getProperty('ultimoRespaldo')) respaldoSemanal();
  SpreadsheetApp.getUi().alert('Listo', 'Se crearon las facturas del mes, el calendario «' + calendar().getName() +
    '», la actualización automática cada hora y un respaldo semanal (domingos) en la carpeta «' + CARPETA_RESPALDO +
    '» de tu Drive.\n\nAhora usá «2. Conectar la app».', SpreadsheetApp.getUi().ButtonSet.OK);
}

// ---------- Respaldo semanal ----------
// Copia la planilla entera en la carpeta «Backup» de Drive y deja solo las últimas RESPALDOS_A_GUARDAR copias
// (las más viejas van a la papelera, de donde Google las borra a los 30 días).

function respaldoSemanal() {
  var carpeta = carpetaRespaldo_();
  var nombre = PREFIJO_RESPALDO + todayIso();
  if (!carpeta.getFilesByName(nombre).hasNext()) DriveApp.getFileById(ss().getId()).makeCopy(nombre, carpeta);
  var copias = [];
  var it = carpeta.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf(PREFIJO_RESPALDO) === 0) copias.push(f);
  }
  // El nombre lleva la fecha AAAA-MM-DD, así que el orden alfabético es el cronológico.
  copias.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  copias.slice(RESPALDOS_A_GUARDAR).forEach(function (f) { f.setTrashed(true); });
  PropertiesService.getScriptProperties().setProperty('ultimoRespaldo', todayIso());
  return { nombre: nombre, carpeta: carpeta };
}

function carpetaRespaldo_() {
  var it = DriveApp.getFoldersByName(CARPETA_RESPALDO);
  return it.hasNext() ? it.next() : DriveApp.createFolder(CARPETA_RESPALDO);
}

function respaldarAhora() {
  var r = respaldoSemanal();
  SpreadsheetApp.getUi().alert('Respaldo listo', 'Se guardó «' + r.nombre + '» en la carpeta «' + CARPETA_RESPALDO +
    '» de tu Drive:\n' + r.carpeta.getUrl() + '\n\nSe guardan las últimas ' + RESPALDOS_A_GUARDAR + ' copias.', SpreadsheetApp.getUi().ButtonSet.OK);
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

// ---------- Mails de cierre ----------
// Cierre preliminar DIAS_ANTES_CIERRE días antes de fin de mes (para corregir) y resumen final el día 1.

var DIAS_ANTES_CIERRE = 4;
var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function tareaDiaria() {
  var hoy = todayIso();
  var key = monthKeyOf(hoy);
  var dia = Number(hoy.slice(8, 10));
  var ultimo = Number(dateInMonth(key, 31).slice(8, 10));
  var props = PropertiesService.getScriptProperties();
  if (dia >= ultimo - DIAS_ANTES_CIERRE && !props.getProperty('mail-pre-' + key)) {
    enviarCierrePreliminar(key);
    props.setProperty('mail-pre-' + key, hoy);
  }
  var anterior = addMonthsKey(key, -1);
  if (dia <= 7 && !props.getProperty('mail-res-' + anterior)) {
    enviarResumenMensual(anterior);
    props.setProperty('mail-res-' + anterior, hoy);
  }
}

function fechaCorta(iso) { return iso ? Number(String(iso).slice(8, 10)) + ' ' + MESES[Number(String(iso).slice(5, 7)) - 1].slice(0, 3) : ''; }
function nombreMes(key) { return MESES[Number(key.slice(5, 7)) - 1] + ' ' + key.slice(0, 4); }
function etiqueta(code) { return String(code || '').replace(/_(.)/g, function (m, c) { return ' ' + c.toLowerCase(); }); }

function tasas() {
  var r = { COP: 1, USD: 3194.44, ARS: 2.13845 };
  readTable('Ajustes').rows.forEach(function (a) {
    var v = Number(a['Valor']);
    if (a['Ajuste'] === 'Tasa USD (COP por 1 USD)' && v > 0) r.USD = v;
    if (a['Ajuste'] === 'Tasa ARS (COP por 1 ARS)' && v > 0) r.ARS = v;
  });
  return r;
}

function aCop(item, campo, rates) { return (Number(item[campo]) || 0) * (rates[item['Moneda'] || 'COP'] || 1); }
function esIngreso(m) { return m['Tipo'] === 'Ingreso' || m['Categoría'] === 'Ingresos'; }
function esAhorro(m) { return m['Tipo'] === 'Ahorro'; }
// Entre cuentas propias o pago del resumen de la tarjeta: no es ingreso ni gasto.
function esTransferencia(m) { return m['Tipo'] === 'Transferencia'; }

// Avance de cada meta activa: ahorro inicial más los aportes, en la moneda de la meta.
function avanceMetas(rates) {
  if (!ss().getSheetByName('Metas')) return [];
  var aportes = {};
  readTable('Movimientos').rows.forEach(function (m) {
    if (esAhorro(m) && m['Meta ID']) aportes[m['Meta ID']] = (aportes[m['Meta ID']] || 0) + aCop(m, 'Importe', rates);
  });
  return readTable('Metas').rows.filter(function (g) { return g['ID'] && g['Activa'] !== 'No'; }).map(function (g) {
    var cur = g['Moneda'] || 'COP';
    var ahorrado = (Number(g['Ahorro inicial']) || 0) + (aportes[g['ID']] || 0) / (rates[cur] || 1);
    var objetivo = Number(g['Monto objetivo']) || 0;
    return { nombre: g['Nombre'], cur: cur, ahorrado: ahorrado, objetivo: objetivo, fecha: g['Fecha objetivo'] || '',
      pct: objetivo ? Math.round((ahorrado / objetivo) * 100) : 0 };
  });
}

function destinatarios() {
  var v = String(settingValue('Correos del resumen') || '');
  var list = v.split(/[,;\s]+/).filter(function (x) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); });
  if (!list.length) list = [Session.getEffectiveUser().getEmail()];
  return list;
}

// Números del mes: ingresos, gastos (movimientos + facturas pagadas), presupuesto por categoría y por persona.
function datosMes(key) {
  var rates = tasas();
  var movs = readTable('Movimientos').rows;
  var bills = readTable('Facturas').rows;
  var presu = readTable('Presupuesto').rows;
  var enMes = function (iso) { return String(iso || '').slice(0, 7) === key; };
  var d = { key: key, ingresos: 0, gastos: 0, aportes: 0, cats: {}, personas: {}, pendientes: [], movs: [], rates: rates };
  var cat = function (c) { return (d.cats[c] = d.cats[c] || { gastado: 0, limite: 0 }); };
  movs.forEach(function (m) {
    if (!enMes(m['Fecha'])) return;
    var v = aCop(m, 'Importe', rates);
    if (esIngreso(m)) { d.ingresos += v; return; }
    if (esAhorro(m)) { d.aportes += v; return; } // aporte a una meta: no es gasto
    if (esTransferencia(m)) return;
    d.gastos += v;
    d.movs.push(m);
    cat(m['Categoría'] || 'Sin categoría').gastado += v;
    var p = m['Pagó'] || m['Cargado por'] || 'Sin asignar';
    d.personas[p] = (d.personas[p] || 0) + v;
  });
  bills.forEach(function (b) {
    if (!enMes(b['Vence'])) return;
    var v = aCop(b, 'Importe', rates);
    if (b['Pagada'] === 'Sí') { d.gastos += v; cat(b['Categoría']).gastado += v; } else d.pendientes.push(b);
  });
  // Por categoría: el presupuesto del mes o, si esa categoría no tiene, el del mismo mes del año anterior.
  var conMes = {};
  presu.forEach(function (r) { if (enMes(r['Mes'])) conMes[r['Categoría']] = true; });
  var antes = addMonthsKey(key, -12);
  presu.forEach(function (r) {
    var k = String(r['Mes'] || '').slice(0, 7);
    if (r['Categoría'] === 'Ingresos' || k !== (conMes[r['Categoría']] ? key : antes)) return;
    cat(r['Categoría']).limite += aCop(r, 'Importe', rates);
  });
  d.pendientes.sort(function (a, b) { return String(a['Vence']).localeCompare(String(b['Vence'])); });
  return d;
}

// Movimientos del mes que conviene revisar antes del cierre.
function paraRevisar(d) {
  var out = [];
  var vistos = {};
  var historico = {};
  var desde = addMonthsKey(d.key, -6);
  readTable('Movimientos').rows.forEach(function (m) {
    var k = String(m['Fecha'] || '').slice(0, 7);
    if (k < desde || k >= d.key || esIngreso(m) || esAhorro(m) || esTransferencia(m)) return;
    (historico[m['Categoría']] = historico[m['Categoría']] || []).push(aCop(m, 'Importe', d.rates));
  });
  var mediana = function (xs) {
    var s = xs.slice().sort(function (a, b) { return a - b; });
    var n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };
  d.movs.forEach(function (m) {
    var motivos = [];
    if (!m['Categoría']) motivos.push('sin categoría');
    else if (!m['Subcategoría']) motivos.push('sin subcategoría');
    var firma = [m['Fecha'], m['Importe'], m['Moneda'], m['Categoría']].join('|');
    if (vistos[firma]) motivos.push('posible duplicado');
    vistos[firma] = true;
    var h = historico[m['Categoría']] || [];
    var v = aCop(m, 'Importe', d.rates);
    if (h.length >= 5 && v >= 200000 && v > 3 * mediana(h)) motivos.push('monto inusual para la categoría');
    if (motivos.length) out.push({ m: m, motivos: motivos });
  });
  return out;
}

// ---------- HTML de los mails ----------
function h(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
var CSS_TD = 'padding:6px 10px;border-bottom:1px solid #EFEBE4;font-size:14px;';
function tabla(cols, filas) {
  if (!filas.length) return '<p style="color:#6F6B63;font-size:14px">Nada para mostrar.</p>';
  return '<table cellspacing="0" style="border-collapse:collapse;width:100%;max-width:640px">' +
    '<tr>' + cols.map(function (c, i) { return '<th style="' + CSS_TD + 'text-align:' + (i ? 'right' : 'left') + ';color:#6F6B63;font-size:12px">' + h(c) + '</th>'; }).join('') + '</tr>' +
    filas.map(function (f) { return '<tr>' + f.map(function (c, i) { return '<td style="' + CSS_TD + 'text-align:' + (i ? 'right' : 'left') + '">' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
    '</table>';
}
function bloque(titulo, html) { return '<h3 style="font-size:16px;margin:24px 0 8px">' + h(titulo) + '</h3>' + html; }
function cifras(items) {
  return '<table cellspacing="0" style="margin:8px 0"><tr>' + items.map(function (it) {
    return '<td style="padding:10px 20px 10px 0"><div style="font-size:12px;color:#6F6B63">' + h(it[0]) + '</div><div style="font-size:20px;font-weight:800">' + h(it[1]) + '</div></td>';
  }).join('') + '</tr></table>';
}
function marco(titulo, cuerpo) {
  return '<div style="font-family:Arial,sans-serif;color:#1C1B19;max-width:680px">' +
    '<h2 style="font-size:22px;margin:0 0 4px">' + h(titulo) + '</h2>' + cuerpo +
    '<p style="margin-top:28px;font-size:13px"><a href="' + APP_URL + '">Abrir Cuentas Casa</a> · <a href="' + ss().getUrl() + '">Abrir la planilla</a></p></div>';
}
function pesos(v) { return money(v, 'COP'); }
function filaCategorias(d, soloAlertas) {
  return Object.keys(d.cats).map(function (c) {
    var x = d.cats[c];
    var pct = x.limite ? Math.round((x.gastado / x.limite) * 100) : null;
    return { c: c, x: x, pct: pct };
  }).filter(function (r) { return r.x.gastado > 0 && (!soloAlertas || (r.pct !== null && r.pct >= umbral())); })
    .sort(function (a, b) { return b.x.gastado - a.x.gastado; })
    .map(function (r) {
      var marca = r.pct === null ? 'sin límite' : (r.pct >= 100 ? '<b style="color:#B3261E">▲ ' + r.pct + '%</b>' : r.pct + '%');
      return [h(etiqueta(r.c)), pesos(r.x.gastado), r.x.limite ? pesos(r.x.limite) : '—', marca];
    });
}
function umbral() {
  var v = Number(settingValue('Umbral de aviso de presupuesto'));
  return v > 0 ? Math.round(v <= 1 ? v * 100 : v) : 80;
}

// Recordatorio para cargar el saldo de cierre de cada cuenta (lo usan el balance y el flujo de efectivo).
function saldosPendientes(key) {
  if (!ss().getSheetByName('Cuentas y bienes') || !ss().getSheetByName('Saldos')) return '';
  var cuentas = readTable('Cuentas y bienes').rows.filter(function (c) { return c['ID'] && c['Activa'] !== 'No'; });
  if (!cuentas.length) return '';
  var cargadas = {};
  readTable('Saldos').rows.forEach(function (r) { if (String(r['Mes'] || '').slice(0, 7) === key) cargadas[r['Cuenta ID']] = true; });
  var faltan = cuentas.filter(function (c) { return !cargadas[c['ID']]; });
  if (!faltan.length) return '';
  return bloque('Saldos de cierre para cargar', '<p style="font-size:14px;margin:0 0 6px">El último día del mes cargá en la app (Balance → Actualizar saldos) el saldo de: ' +
    faltan.map(function (c) { return '<b>' + h(c['Nombre']) + '</b>'; }).join(', ') + '.</p>');
}

function htmlCierrePreliminar(key) {
  var d = datosMes(key);
  var revisar = paraRevisar(d);
  var sig = addMonthsKey(key, 1);
  var proximos = readTable('Facturas').rows.filter(function (b) {
    return b['Pagada'] !== 'Sí' && String(b['Vence']).slice(0, 7) === sig && Number(String(b['Vence']).slice(8, 10)) <= 7;
  }).sort(function (a, b) { return String(a['Vence']).localeCompare(String(b['Vence'])); });
  var cuerpo = '<p style="color:#6F6B63;margin:0">Faltan ' + DIAS_ANTES_CIERRE + ' días para cerrar el mes. Revisá estos puntos y corregí lo que haga falta en la app o en la planilla.</p>' +
    cifras([['Ingresos', pesos(d.ingresos)], ['Gastos', pesos(d.gastos)], ['Facturas sin pagar', pesos(d.pendientes.reduce(function (s, b) { return s + aCop(b, 'Importe', d.rates); }, 0))]]) +
    bloque('Facturas del mes sin marcar como pagadas', tabla(['Factura', 'Vence', 'Importe'],
      d.pendientes.map(function (b) { return [h(b['Nombre']), h(fechaCorta(b['Vence'])), h(money(b['Importe'], b['Moneda']))]; }))) +
    bloque('Movimientos para revisar', tabla(['Movimiento', 'Fecha', 'Importe', 'Motivo'],
      revisar.map(function (r) { return [h(r.m['Comentarios'] || r.m['Subcategoría'] || etiqueta(r.m['Categoría'])), h(fechaCorta(r.m['Fecha'])), h(money(r.m['Importe'], r.m['Moneda'])), h(r.motivos.join(', '))]; }))) +
    bloque('Categorías excedidas o cerca del límite (' + umbral() + '% o más)', tabla(['Categoría', 'Gastado', 'Presupuesto', 'Usado'], filaCategorias(d, true))) +
    saldosPendientes(key) +
    bloque('Vence en los primeros días de ' + nombreMes(sig), tabla(['Factura', 'Vence', 'Importe'],
      proximos.map(function (b) { return [h(b['Nombre']), h(fechaCorta(b['Vence'])), h(money(b['Importe'], b['Moneda']))]; })));
  return { asunto: 'Cuentas Casa · Cierre preliminar de ' + nombreMes(key), html: marco('Cierre preliminar de ' + nombreMes(key), cuerpo) };
}

function htmlResumenMensual(key) {
  var d = datosMes(key);
  var a = datosMes(addMonthsKey(key, -1));
  var ahorro = d.ingresos - d.gastos;
  var tasa = d.ingresos ? Math.round((ahorro / d.ingresos) * 100) + '%' : '—';
  var vs = function (now, before, subeBien) {
    if (!before) return '—';
    var p = Math.round(((now - before) / Math.abs(before)) * 100);
    var bien = p > 0 === subeBien;
    return '<span style="color:' + (p === 0 ? '#6F6B63' : bien ? '#1B7F4B' : '#B3261E') + '">' + (p > 0 ? '▲ ' : p < 0 ? '▼ ' : '') + Math.abs(p) + '%</span>';
  };
  var personas = Object.keys(d.personas).sort(function (x, y) { return d.personas[y] - d.personas[x]; })
    .map(function (p) { return [h(p), pesos(d.personas[p]), d.gastos ? Math.round((d.personas[p] / d.gastos) * 100) + '%' : '—']; });
  var metas = avanceMetas(d.rates);
  var cuerpo = cifras([['Ingresos', pesos(d.ingresos)], ['Gastos', pesos(d.gastos)], ['Ahorro', pesos(ahorro)], ['Tasa de ahorro', tasa]]) +
    (d.aportes ? '<p style="font-size:14px;margin:0">Aportado a metas en el mes: <b>' + h(pesos(d.aportes)) + '</b></p>' : '') +
    bloque('Comparado con ' + nombreMes(addMonthsKey(key, -1)), tabla(['', 'Este mes', 'Mes anterior', 'Variación'], [
      ['Ingresos', pesos(d.ingresos), pesos(a.ingresos), vs(d.ingresos, a.ingresos, true)],
      ['Gastos', pesos(d.gastos), pesos(a.gastos), vs(d.gastos, a.gastos, false)],
    ])) +
    bloque('Gastos por categoría', tabla(['Categoría', 'Gastado', 'Presupuesto', 'Usado'], filaCategorias(d, false))) +
    bloque('Gastos por persona (movimientos)', tabla(['Persona', 'Gastado', 'Del total'], personas)) +
    (metas.length ? bloque('Metas de ahorro', tabla(['Meta', 'Ahorrado', 'Objetivo', 'Avance'], metas.map(function (g) {
      return [h(g.nombre) + (g.fecha ? '<br><span style="color:#6F6B63;font-size:12px">para el ' + h(fechaCorta(g.fecha)) + ' ' + h(String(g.fecha).slice(0, 4)) + '</span>' : ''),
        h(money(g.ahorrado, g.cur)), h(money(g.objetivo, g.cur)), g.pct + '%'];
    }))) : '') +
    bloque('Facturas que quedaron sin pagar', tabla(['Factura', 'Vence', 'Importe'],
      d.pendientes.map(function (b) { return [h(b['Nombre']), h(fechaCorta(b['Vence'])), h(money(b['Importe'], b['Moneda']))]; })));
  return { asunto: 'Cuentas Casa · Resumen de ' + nombreMes(key), html: marco('Resumen de ' + nombreMes(key), cuerpo) };
}

function enviar(m) {
  var to = destinatarios();
  MailApp.sendEmail({ to: to.join(','), subject: m.asunto, htmlBody: m.html, name: 'Cuentas Casa' });
  return to;
}
function enviarCierrePreliminar(key) { return enviar(htmlCierrePreliminar(key)); }
function enviarResumenMensual(key) { return enviar(htmlResumenMensual(key)); }

function probarMailCierre() {
  var to = enviarCierrePreliminar(monthKeyOf(todayIso()));
  SpreadsheetApp.getUi().alert('Se envió el cierre preliminar de prueba a: ' + to.join(', '));
}

// ---------- Instalación de lo nuevo ----------
function crearPestana(name, headers) {
  var sh = ss().getSheetByName(name);
  if (sh) return null;
  sh = ss().insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#1C1B19').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  return sh;
}

function crearReglas() {
  var sh = crearPestana('Reglas', REGLAS_HEADERS);
  if (sh) sh.getRange(2, 1, 1, 5).setValues([['Ejemplo: éxito', 'Alimentación', 'Supermercado', 'Gasto', 'No']]);
}

function asegurarAjuste(nombre, valor, nota) {
  var t = readTable('Ajustes');
  if (t.rows.some(function (r) { return r['Ajuste'] === nombre; })) return;
  var n = t.sheet.getLastRow() + 1;
  var row = t.headers.map(function (hd) { return hd === 'Ajuste' ? nombre : hd === 'Valor' ? valor : hd === 'Fuente o nota' ? nota : ''; });
  t.sheet.getRange(n, 1, 1, row.length).setValues([row]);
}

// ---------- Lectura de tickets con el lector de Google Drive ----------
// La app manda la foto (achicada) y el programa la convierte en un documento de Google con
// reconocimiento de texto, lee el texto y borra el archivo temporal enseguida.
var OCR_MAX_BYTES = 4 * 1024 * 1024;

function leerImagen(base64, mime) {
  if (!base64) throw new Error('Falta la imagen');
  var bytes = Utilities.base64Decode(base64);
  if (bytes.length > OCR_MAX_BYTES) throw new Error('La imagen es demasiado grande');
  var type = /^image\/(jpeg|png|webp)$/.test(mime || '') ? mime : 'image/jpeg';
  var boundary = 'cuentascasa' + Date.now();
  var auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  var subir = function (url, meta) {
    var head = Utilities.newBlob('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
      '\r\n--' + boundary + '\r\nContent-Type: ' + type + '\r\n\r\n').getBytes();
    var tail = Utilities.newBlob('\r\n--' + boundary + '--').getBytes();
    return UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'multipart/related; boundary=' + boundary, payload: head.concat(bytes).concat(tail),
      headers: auth, muteHttpExceptions: true,
    });
  };
  var nombre = 'Cuentas Casa · lectura temporal';
  var doc = 'application/vnd.google-apps.document';
  var res = subir('https://www.googleapis.com/upload/drive/v2/files?uploadType=multipart&convert=true&ocr=true&ocrLanguage=es', { title: nombre, mimeType: doc });
  // Si la versión 2 de la API no está disponible, la 3 también convierte imágenes con reconocimiento de texto.
  if (res.getResponseCode() >= 300) res = subir('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=es', { name: nombre, mimeType: doc });
  if (res.getResponseCode() >= 300) throw new Error('El lector de Google no pudo leer la imagen (' + res.getResponseCode() + ')');
  var id = JSON.parse(res.getContentText()).id;
  try {
    var txt = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=text%2Fplain', { headers: auth, muteHttpExceptions: true });
    if (txt.getResponseCode() >= 300) throw new Error('No se pudo leer el texto (' + txt.getResponseCode() + ')');
    return txt.getContentText();
  } finally {
    UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id, { method: 'delete', headers: auth, muteHttpExceptions: true });
  }
}

// No se llama nunca: hace que Google pida el permiso de Drive que usa leerImagen.
function permisoDrive_() { return DriveApp.getRootFolder(); }
