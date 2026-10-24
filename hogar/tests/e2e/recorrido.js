// Recorrido automático de la app en un navegador, conectada a una planilla simulada (tests/fake-gas.js).
// Corre en cada publicación (ver .github/workflows/pages.yml). Recorre todas las pantallas en celular y
// computadora y hace las tareas principales; falla si algo da error, se desborda o no llega a la planilla.
//
//   npm install --no-save playwright && npx playwright install chromium
//   node hogar/tests/e2e/recorrido.js [carpeta-de-capturas]
//
// CHROMIUM_PATH permite usar un Chromium ya instalado.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium, devices } = require('playwright');
const { createGas } = require('../fake-gas');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(process.cwd(), 'recorrido'));
const SCRIPT = 'https://script.google.com/macros/s/AKfyRECORRIDO/exec';
fs.mkdirSync(OUT, { recursive: true });

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const day = (offsetMonths, d) => new Date(now.getFullYear(), now.getMonth() + offsetMonths, d);
const monthStart = (offset) => day(offset, 1);
const mk = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

// Datos ficticios: nada real.
function planilla() {
  const presupuesto = [['Mes', 'Categoría', 'Subcategoría', 'Moneda', 'Importe']];
  for (const off of [0, -12]) {
    presupuesto.push([monthStart(off), 'Alimentación', 'Supermercado', 'COP', 900000], [monthStart(off), 'Alimentación', 'Domicilios', 'COP', 200000],
      [monthStart(off), 'Gastos_Fijos', 'Internet', 'COP', 120000], [monthStart(off), 'Ocio', 'Salidas', 'COP', 300000]);
  }
  return {
    'Movimientos': [
      ['ID', 'Fecha', 'Tipo', 'Categoría', 'Subcategoría', 'Moneda', 'Importe', 'Medio de pago', 'Entidad', 'Comentarios', 'Cargado por', 'Actualizado'],
      ['M1', day(0, 1), 'Ingreso', 'Ingresos', 'Sueldo Alan', 'COP', 6000000, 'Transferencia', '', '', 'Alan', ''],
      ['M2', day(0, 1), 'Gasto', 'Alimentación', 'Supermercado', 'COP', 320000, 'Tarjeta Débito', '', 'Mercado', 'Karo', ''],
    ],
    'Facturas': [['ID', 'Nombre', 'Categoría', 'Subcategoría', 'Moneda', 'Importe', 'Vence', 'Pagada', 'Fecha de pago', 'Medio de pago',
      'Recurrente ID', 'Préstamo ID', 'Avisos (días antes)', 'Evento de calendario', 'Actualizado']],
    'Recurrentes': [['ID', 'Nombre', 'Categoría', 'Subcategoría', 'Moneda', 'Importe', 'Día', 'Avisos (días antes)', 'Activa'],
      ['R1', 'Internet hogar', 'Gastos_Fijos', 'Internet', 'COP', 110000, 28, '3,0', 'Sí']],
    'Por cobrar': [['ID', 'Fecha de emisión', 'NIT', 'Cliente', 'Moneda', 'Valor', 'Vence', 'Estado', 'Fecha de cobro', 'Movimiento ID', 'Actualizado'],
      ['C1', day(-1, 5), '900000001', 'Clínica Ejemplo', 'COP', 1000000, day(0, 5), 'Pendiente', '', '', '']],
    'Categorías': [['Categoría', 'Subcategoría', 'Tipo'],
      ['Alimentación', 'Supermercado', 'Gasto'], ['Alimentación', 'Domicilios', 'Gasto'], ['Gastos_Fijos', 'Internet', 'Gasto'],
      ['Ocio', 'Salidas', 'Gasto'], ['Ingresos', 'Sueldo Alan', 'Ingreso'], ['Ingresos', 'Sueldo Karo', 'Ingreso']],
    'Ajustes': [['Ajuste', 'Valor', 'Fuente o nota'], ['Tasa USD (COP por 1 USD)', 4000, ''], ['Tasa ARS (COP por 1 ARS)', 3, '']],
    'Deudas': [['ID', 'Préstamo', 'Moneda', 'Capital', 'Próxima cuota']],
    'Presupuesto': presupuesto,
    'Listas': [['Medio de pago', 'Moneda'], ['Efectivo', 'COP'], ['Tarjeta Débito', 'USD'], ['Tarjeta Crédito', 'ARS']],
    'Cuentas y bienes': [['ID', 'Nombre', 'Tipo', 'Moneda', 'Activa', 'Comentarios', 'Actualizado'],
      ['A1', 'Banco', 'Cuenta bancaria', 'COP', 'Sí', '', ''], ['A2', 'Tarjeta', 'Tarjeta de crédito', 'COP', 'Sí', '', '']],
  };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function serve() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html');
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((ok) => server.listen(0, 'localhost', () => ok(server)));
}

const rowsOf = (gas, name) => {
  const [h, ...rows] = gas.sheets[name].data;
  return rows.filter((r) => r.some((v) => v !== '' && v != null)).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
};

(async () => {
  const server = await serve();
  const BASE = `http://localhost:${server.address().port}/index.html`;
  const gas = createGas(planilla(), { token: 'tok-recorrido' });
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  const step = async (name, fn) => {
    process.stdout.write(`· ${name} … `);
    await fn();
    console.log('ok');
  };

  let current = null;
  async function open(device, file) {
    const ctx = await browser.newContext(device);
    // Como la app instalada en la pantalla de inicio (así no aparece el aviso de Safari en iPhone).
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    await ctx.route(SCRIPT + '*', async (route) => {
      const out = gas.post(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${file}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) errors.push(`${file}: ${m.text()}`); });
    page.on('dialog', (d) => d.accept());
    current = page;
    return { ctx, page };
  }

  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });
  const noOverflow = async (page, where) => {
    const w = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(w <= 1, `${where}: la pantalla se desborda ${w}px a lo ancho`);
  };
  const sheetOpen = (page) => page.waitForSelector('#sheet:not([hidden])');
  const closeSheet = async (page) => {
    if (!(await page.locator('#sheet.open').count())) return;
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#sheet.open'), null, { timeout: 5000 });
  };

  try {
    const { ctx, page } = await open({ ...devices['iPhone 13'] }, 'celular');
    await step('conectar con el enlace de la planilla', async () => {
      await page.goto(`${BASE}#conectar=${encodeURIComponent(SCRIPT)}&token=tok-recorrido&quien=Alan`);
      await page.waitForFunction(() => (JSON.parse(localStorage.getItem('cuentas-casa-sync') || '{}').user === 'Alan'), null, { timeout: 8000 });
      await page.waitForTimeout(800);
      await closeSheet(page);
    });

    await step('cada pantalla del celular', async () => {
      const go = async (tab, extra) => {
        await closeSheet(page);
        await page.click(`.tabbar [data-tab="${tab}"]`);
        await page.waitForTimeout(250);
        if (extra) { await page.click(extra); await page.waitForTimeout(250); }
      };
      const screens = [
        ['inicio'], ['vencimientos'], ['vencimientos', '[data-act="venc-mode"][data-v="plan"]'], ['vencimientos', '[data-act="venc-mode"][data-v="collect"]'],
        ['presupuesto'], ['metas'], ['metas', '[data-act="tab"][data-v="deudas"]'], ['metas', '[data-act="tab"][data-v="balance"]'],
      ];
      for (const [tab, extra] of screens) {
        await go(tab, extra);
        const name = 'celu-' + tab + (extra ? '-' + extra.match(/data-v="(\w+)"/)[1] : '');
        assert.ok((await page.locator('#screen').innerText()).trim().length > 20, `${name} quedó vacía`);
        await noOverflow(page, name);
        await shot(page, name);
      }
      for (const view of ['Patrimonio', 'Flujo']) {
        await page.click(`[data-act="bal-view"]:has-text("${view}")`);
        await page.waitForTimeout(200);
        await noOverflow(page, 'balance ' + view);
      }
    });

    const add = async (mode) => {
      await page.click('.tabbar .plus');
      await sheetOpen(page);
      if (mode) await page.click(`#sheet [data-act="form-mode"][data-v="${mode}"]`);
    };
    const sync = async () => {
      await page.waitForFunction(() => !(JSON.parse(localStorage.getItem('cuentas-casa-sync') || '{}').pending || []).length, null, { timeout: 8000 });
    };

    await step('cargar un gasto', async () => {
      await page.click('.tabbar [data-tab="inicio"]');
      await add();
      await page.fill('#f-amount', '45000');
      await page.fill('#f-note', 'Recorrido gasto');
      await shot(page, 'form-gasto');
      await page.click('#f-save');
      await sync();
      const m = rowsOf(gas, 'Movimientos').find((r) => r['Comentarios'] === 'Recorrido gasto');
      assert.ok(m, 'el gasto no llegó a la planilla');
      assert.equal(m['Importe'], 45000);
      assert.equal(m['Cargado por'], 'Alan');
    });

    await step('cargar una devolución', async () => {
      await add('exp');
      await page.click('#sheet [data-act="form-withdraw"][data-v="1"]');
      await page.fill('#f-amount', '15000');
      await page.fill('#f-note', 'Recorrido devolución');
      await page.click('#f-save');
      await sync();
      const m = rowsOf(gas, 'Movimientos').find((r) => r['Comentarios'] === 'Recorrido devolución');
      assert.equal(m && m['Importe'], -15000, 'la devolución tiene que quedar en negativo');
    });

    await step('transferir de la cuenta a la tarjeta', async () => {
      await add('xfer');
      await page.fill('#f-amount', '200000');
      await page.click('#sheet [data-act="form-from"][data-v="A1"]');
      await page.click('#sheet [data-act="form-to"][data-v="A2"]');
      await shot(page, 'form-transferencia');
      await page.click('#f-save');
      await sync();
      const m = rowsOf(gas, 'Movimientos').find((r) => r['Tipo'] === 'Transferencia');
      assert.ok(m && m['Origen ID'] === 'A1' && m['Destino ID'] === 'A2', 'la transferencia no llegó bien');
    });

    await step('editar el presupuesto de una categoría', async () => {
      await page.click('.tabbar [data-tab="presupuesto"]');
      await page.waitForTimeout(250);
      await page.click('#screen [data-act="cat"]:has-text("Alimentación")');
      await sheetOpen(page);
      await page.click('#sheet [data-act="budget-edit"]');
      await page.waitForTimeout(200);
      await page.fill('#sheet input[data-bud="Supermercado"]', '1000000');
      await shot(page, 'presupuesto-editar');
      await page.click('#sheet [data-act="bud-save"]');
      await sync();
      const fila = rowsOf(gas, 'Presupuesto').find((r) => r['Categoría'] === 'Alimentación' && r['Subcategoría'] === 'Supermercado' && r['Mes'] instanceof Date && mk(r['Mes']) === mk(now));
      assert.equal(fila && fila['Importe'], 1000000, 'el presupuesto no cambió en la planilla');
      const otros = rowsOf(gas, 'Presupuesto').filter((r) => r['Categoría'] === 'Ocio');
      assert.equal(otros.length, 2, 'las otras categorías no se tocan');
    });

    await step('editar la factura mensual desde Ajustes', async () => {
      await page.click('.tabbar [data-tab="inicio"]');
      await page.click('#screen [data-act="settings"]');
      await sheetOpen(page);
      await page.click('#sheet [data-act="rec-list"]');
      await page.waitForTimeout(200);
      await page.click('#sheet [data-act="rec-edit"][data-id="R1"]');
      await page.waitForTimeout(200);
      await page.fill('#b-amount', '125000');
      await page.fill('#b-day', '20');
      await page.click('#sheet [data-act="bf-save"]');
      await sync();
      const r = rowsOf(gas, 'Recurrentes').find((x) => x['ID'] === 'R1');
      assert.equal(r['Importe'], 125000);
      assert.equal(Number(r['Día']), 20);
      const pend = rowsOf(gas, 'Facturas').filter((b) => b['Recurrente ID'] === 'R1' && b['Pagada'] !== 'Sí');
      assert.ok(pend.length && pend.every((b) => b['Importe'] === 125000), 'las facturas sin pagar siguen con el monto viejo');
    });

    await step('cobrar una factura con retención en la fuente', async () => {
      await page.click('.tabbar [data-tab="vencimientos"]');
      await page.click('[data-act="venc-mode"][data-v="collect"]');
      await page.click('#screen [data-act="recv"][data-id="C1"]');
      await sheetOpen(page);
      await page.fill('#c-amount', '890000');
      await page.click('#sheet [data-act="recv-rest"][data-v="ret"]');
      await shot(page, 'cobro-retencion');
      await page.click('#c-save');
      await sync();
      const c = rowsOf(gas, 'Por cobrar').find((x) => x['ID'] === 'C1');
      assert.equal(c['Estado'], 'Cobrada');
      assert.equal(c['Retención'], 110000);
      await page.waitForTimeout(300);
      assert.match(await page.locator('#screen').innerText(), /Retención en la fuente \d{4}/);
    });

    await step('abre sin conexión', async () => {
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload();
      await page.waitForTimeout(600);
      await ctx.setOffline(true);
      await page.reload();
      await page.waitForTimeout(800);
      assert.ok((await page.locator('#screen').innerText()).includes('Cuentas Casa'), 'sin conexión no abre');
      await shot(page, 'sin-conexion');
      await ctx.setOffline(false);
    });
    await ctx.close();

    await step('pantallas de computadora', async () => {
      const { ctx: dctx, page: desk } = await open({ viewport: { width: 1280, height: 860 } }, 'computadora');
      await desk.goto(BASE);
      await desk.waitForTimeout(500);
      for (const tab of ['inicio', 'movimientos', 'vencimientos', 'presupuesto', 'metas', 'deudas', 'balance']) {
        await desk.click(`.side-tab[data-tab="${tab}"]`);
        await desk.waitForTimeout(300);
        assert.ok((await desk.locator('#screen').innerText()).trim().length > 20, `${tab} quedó vacía`);
        await noOverflow(desk, 'computadora ' + tab);
        await shot(desk, 'compu-' + tab);
      }
      await dctx.close();
    });

    assert.deepEqual(errors, [], 'errores en la consola');
    console.log(`\nRecorrido completo. Capturas en ${OUT}`);
  } catch (e) {
    console.log('FALLÓ');
    console.error(e.message);
    if (current) await current.screenshot({ path: path.join(OUT, 'fallo.png') }).catch(() => {});
    if (errors.length) console.error('Errores de la página:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
