// Gráficos del dashboard como SVG (sin dependencias). Cada función recibe los datos ya calculados
// y el ancho real del contenedor, y devuelve { svg, hover } para que la app arme los tooltips.
(function (root) {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const r1 = (n) => Math.round(n * 10) / 10;

  // Escala "linda": 0 a un máximo redondo con ~4 marcas.
  function niceScale(max, ticks = 4) {
    if (!(max > 0)) return { max: 1, step: 1, ticks: [0, 1] };
    const raw = max / ticks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const top = Math.ceil(max / step) * step;
    const list = [];
    for (let v = 0; v <= top + step / 2; v += step) list.push(v);
    return { max: top, step, ticks: list };
  }

  // Columna con 4px redondeados arriba y base cuadrada.
  function colPath(x, y, w, h) {
    if (h <= 0) return '';
    const r = Math.min(4, h, w / 2);
    return `M${r1(x)},${r1(y + h)}V${r1(y + r)}Q${r1(x)},${r1(y)} ${r1(x + r)},${r1(y)}H${r1(x + w - r)}` +
      `Q${r1(x + w)},${r1(y)} ${r1(x + w)},${r1(y + r)}V${r1(y + h)}Z`;
  }

  // Barra horizontal con 4px redondeados en el extremo derecho.
  function barPath(x, y, w, h) {
    if (w <= 0) return '';
    const r = Math.min(4, w, h / 2);
    return `M${r1(x)},${r1(y)}H${r1(x + w - r)}Q${r1(x + w)},${r1(y)} ${r1(x + w)},${r1(y + r)}` +
      `V${r1(y + h - r)}Q${r1(x + w)},${r1(y + h)} ${r1(x + w - r)},${r1(y + h)}H${r1(x)}Z`;
  }

  const tipAttr = (title, rows) => `data-tip="${esc(JSON.stringify({ t: title, r: rows }))}"`;

  function yAxis(scale, y, left, right, fmt) {
    return scale.ticks.map((v) => {
      const yy = r1(y(v));
      return `<line class="viz-grid" x1="${left}" x2="${right}" y1="${yy}" y2="${yy}"/>` +
        `<text class="viz-tick" x="${left - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${esc(fmt(v))}</text>`;
    }).join('');
  }

  // Ingresos y gastos por mes: columnas agrupadas. Se resalta el mes elegido.
  function trend({ months, selected, width, height = 240, fmtAxis, fmtVal }) {
    const m = { l: 64, r: 8, t: 12, b: 28 };
    const pw = Math.max(10, width - m.l - m.r);
    const ph = height - m.t - m.b;
    const scale = niceScale(Math.max(0, ...months.flatMap((x) => [x.income, x.expense])));
    const y = (v) => m.t + ph - (v / scale.max) * ph;
    const band = pw / months.length;
    const bw = Math.max(3, Math.min(24, (band - 10) / 2));
    let out = yAxis(scale, y, m.l, width - m.r, fmtAxis);
    months.forEach((mo, i) => {
      const cx = m.l + band * i + band / 2;
      const sel = mo.key === selected;
      const cls = sel ? '' : ' viz-dim';
      if (mo.hasData) {
        const hi = (mo.income / scale.max) * ph;
        const he = (mo.expense / scale.max) * ph;
        out += `<path class="viz-inc${cls}" d="${colPath(cx - bw - 1, m.t + ph - hi, bw, hi)}"/>`;
        out += `<path class="viz-exp${cls}" d="${colPath(cx + 1, m.t + ph - he, bw, he)}"/>`;
      }
      out += `<text class="viz-tick${sel ? ' viz-sel' : ''}" x="${r1(cx)}" y="${height - 8}" text-anchor="middle">${esc(mo.label)}</text>`;
      const rows = mo.hasData
        ? [['Ingresos', fmtVal(mo.income), 'inc'], ['Gastos', fmtVal(mo.expense), 'exp'], ['Ahorro', fmtVal(mo.income - mo.expense), '']]
        : [['Sin movimientos', '', '']];
      out += `<rect class="viz-hit" x="${r1(cx - band / 2)}" y="${m.t}" width="${r1(band)}" height="${ph}" data-month="${esc(mo.key)}" tabindex="0" ${tipAttr(mo.title, rows)}/>`;
    });
    out += `<line class="viz-axis" x1="${m.l}" x2="${width - m.r}" y1="${m.t + ph}" y2="${m.t + ph}"/>`;
    return { svg: `<svg class="viz" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ingresos y gastos por mes">${out}</svg>` };
  }

  // Gasto acumulado del mes contra el presupuesto, con proyección de cierre.
  function cumulative({ dim, cumulative: cum, lastDay, budget, projection, showProjection, width, height = 240, fmtAxis, fmtVal, fmtLabel = fmtVal, dayLabel }) {
    const m = { l: 64, r: 112, t: 16, b: 28 };
    const pw = Math.max(10, width - m.l - m.r);
    const ph = height - m.t - m.b;
    const top = Math.max(budget, showProjection ? projection : 0, ...cum);
    const scale = niceScale(top);
    const x = (d) => m.l + ((d - 1) / Math.max(1, dim - 1)) * pw;
    const y = (v) => m.t + ph - (v / scale.max) * ph;
    let out = yAxis(scale, y, m.l, m.l + pw, fmtAxis);
    [1, 8, 15, 22, dim].forEach((d) => {
      out += `<text class="viz-tick" x="${r1(x(d))}" y="${height - 8}" text-anchor="middle">${esc(dayLabel(d))}</text>`;
    });
    out += `<line class="viz-axis" x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}"/>`;
    const labels = [];
    if (budget > 0) {
      out += `<line class="viz-ref" x1="${r1(x(1))}" y1="${r1(y(budget / dim))}" x2="${r1(x(dim))}" y2="${r1(y(budget))}"/>`;
      labels.push({ y: y(budget), text: 'Presupuesto ' + fmtLabel(budget), cls: 'viz-label' });
    }
    if (lastDay > 0) {
      const pts = cum.slice(0, lastDay).map((v, i) => `${r1(x(i + 1))},${r1(y(v))}`);
      out += `<path class="viz-area" d="M${r1(x(1))},${m.t + ph}L${pts.join('L')}L${r1(x(lastDay))},${m.t + ph}Z"/>`;
      out += `<polyline class="viz-line" points="${pts.join(' ')}"/>`;
      if (showProjection && lastDay < dim) {
        out += `<line class="viz-proj" x1="${r1(x(lastDay))}" y1="${r1(y(cum[lastDay - 1]))}" x2="${r1(x(dim))}" y2="${r1(y(projection))}"/>`;
        labels.push({ y: y(projection), text: 'Proyección ' + fmtLabel(projection), cls: 'viz-label' });
      } else {
        labels.push({ y: y(cum[lastDay - 1]), text: 'Gastado ' + fmtLabel(cum[lastDay - 1]), cls: 'viz-label' });
      }
      out += `<circle class="viz-dot" cx="${r1(x(lastDay))}" cy="${r1(y(cum[lastDay - 1]))}" r="4"/>`;
    }
    // Etiquetas al final de cada línea; si quedan encimadas se separan lo justo.
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) {
      if (labels[i].y - labels[i - 1].y < 16) labels[i].y = labels[i - 1].y + 16;
    }
    labels.forEach((l) => {
      out += `<text class="${l.cls}" x="${r1(m.l + pw + 8)}" y="${r1(l.y)}" dominant-baseline="middle">${esc(l.text)}</text>`;
    });
    out += `<rect class="viz-hit" x="${m.l}" y="${m.t}" width="${r1(pw)}" height="${ph}" data-cross="1"/>`;
    out += `<line class="viz-cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" visibility="hidden"/>`;
    // Datos para el tooltip con cruz: cada día, sus valores.
    const items = [];
    for (let d = 1; d <= dim; d++) {
      const rows = [];
      if (d <= lastDay) rows.push(['Gastado acumulado', fmtVal(cum[d - 1]), 'exp']);
      else if (showProjection) rows.push(['Proyección', fmtVal(cum[lastDay - 1] + ((projection - cum[lastDay - 1]) * (d - lastDay)) / Math.max(1, dim - lastDay)), 'exp']);
      if (budget > 0) rows.push(['Presupuesto al ritmo', fmtVal((budget / dim) * d), 'ref']);
      items.push({ x: r1(x(d)), title: dayLabel(d, true), rows });
    }
    return {
      svg: `<svg class="viz" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Gasto acumulado del mes">${out}</svg>`,
      hover: items,
    };
  }

  // Gasto por categoría con la marca del presupuesto de cada una.
  function categories({ rows, width, fmtVal, statusText }) {
    const rowH = 34;
    const labelW = Math.min(180, Math.max(110, width * 0.26));
    const valueW = Math.min(230, width * 0.36);
    const x0 = labelW + 8;
    const pw = Math.max(10, width - x0 - valueW);
    const max = Math.max(1, ...rows.flatMap((r) => [r.spent, r.limit || 0]));
    const height = rows.length * rowH + 4;
    let out = '';
    rows.forEach((r, i) => {
      const yc = i * rowH + rowH / 2;
      const w = (r.spent / max) * pw;
      out += `<text class="viz-cat" x="${labelW}" y="${yc}" text-anchor="end" dominant-baseline="middle">${esc(r.name)}</text>`;
      out += `<rect class="viz-track" x="${x0}" y="${yc - 6}" width="${r1(pw)}" height="12" rx="4"/>`;
      out += `<path class="viz-exp" d="${barPath(x0, yc - 6, w, 12)}"/>`;
      if (r.limit > 0) {
        const tx = x0 + (r.limit / max) * pw;
        out += `<line class="viz-tickmark" x1="${r1(tx)}" x2="${r1(tx)}" y1="${yc - 10}" y2="${yc + 10}"/>`;
      }
      const pct = r.limit > 0 ? ` · ${Math.round((r.spent / r.limit) * 100)}%` : ' · sin límite';
      out += `<text class="viz-label" x="${r1(x0 + pw + 12)}" y="${yc}" dominant-baseline="middle">${esc(fmtVal(r.spent) + pct)}` +
        (r.limit > 0 && r.spent > r.limit ? `<tspan class="viz-bad"> ▲ ${esc(statusText)}</tspan>` : '') + '</text>';
      const tip = [['Gastado', fmtVal(r.spent), 'exp']];
      if (r.limit > 0) tip.push(['Presupuesto', fmtVal(r.limit), 'ref'], ['Usado', Math.round((r.spent / r.limit) * 100) + '%', '']);
      out += `<rect class="viz-hit" x="0" y="${i * rowH}" width="${width}" height="${rowH}" data-cat="${esc(r.name)}" tabindex="0" ${tipAttr(r.name, tip)}/>`;
    });
    return { svg: `<svg class="viz" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Gasto por categoría">${out}</svg>` };
  }

  // Varias series en líneas mes a mes (admite negativos). Los meses sin datos cortan la línea.
  function lines({ points, series, width, height = 240, fmtAxis, fmtVal }) {
    const m = { l: 64, r: 12, t: 12, b: 28 };
    const pw = Math.max(10, width - m.l - m.r);
    const ph = height - m.t - m.b;
    const vals = points.filter((p) => p.hasData).flatMap((p) => series.map((s) => p.values[s.k]));
    const lo = Math.min(0, ...vals);
    const hi = Math.max(0, ...vals);
    const up = niceScale(hi);
    const down = niceScale(-lo);
    const step = Math.max(up.step, down.step);
    const top = Math.ceil(hi / step) * step || step;
    const bottom = -Math.ceil(-lo / step) * step;
    const y = (v) => m.t + ph - ((v - bottom) / (top - bottom)) * ph;
    const band = pw / points.length;
    const x = (i) => m.l + band * i + band / 2;
    let out = '';
    for (let v = bottom; v <= top + step / 2; v += step) {
      const yy = r1(y(v));
      out += `<line class="${v === 0 ? 'viz-axis' : 'viz-grid'}" x1="${m.l}" x2="${width - m.r}" y1="${yy}" y2="${yy}"/>` +
        `<text class="viz-tick" x="${m.l - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${esc(fmtAxis(v))}</text>`;
    }
    for (const s of series) {
      let seg = [];
      const flush = () => { if (seg.length > 1) out += `<polyline class="viz-series ${s.cls}" points="${seg.join(' ')}"/>`; seg = []; };
      points.forEach((p, i) => {
        if (!p.hasData) { flush(); return; }
        seg.push(`${r1(x(i))},${r1(y(p.values[s.k]))}`);
        out += `<circle class="viz-pt ${s.cls}" cx="${r1(x(i))}" cy="${r1(y(p.values[s.k]))}" r="${s.strong ? 4 : 3}"/>`;
      });
      flush();
    }
    points.forEach((p, i) => {
      out += `<text class="viz-tick" x="${r1(x(i))}" y="${height - 8}" text-anchor="middle">${esc(p.label)}</text>`;
      const rows = p.hasData ? series.map((s) => [s.label, fmtVal(p.values[s.k]), s.tip || '']) : [['Sin saldos cargados', '', '']];
      out += `<rect class="viz-hit" x="${r1(x(i) - band / 2)}" y="${m.t}" width="${r1(band)}" height="${ph}" tabindex="0" ${tipAttr(p.title, rows)}/>`;
    });
    return { svg: `<svg class="viz" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Evolución del patrimonio">${out}</svg>` };
  }

  const api = { niceScale, colPath, barPath, trend, cumulative, categories, lines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CasaCharts = api;
})(typeof window !== 'undefined' ? window : globalThis);
