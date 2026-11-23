#!/usr/bin/env node
/**
 * Headless smoke test of the built single-file app.
 *
 * Starts a Chromium-based browser in headless mode (no window, separate temporary profile),
 * opens dist/index.html from disk, runs scenarios (connect screen, demo sessions of every driver,
 * all main views, mobile and desktop sizes), collects console errors and uncaught exceptions, and
 * saves screenshots.
 *
 * Usage: node scripts/smoke.mjs [--out .smoke] [--browser <path>] [--only <scenario substring>]
 * Exit code 1 when a page reported errors.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const outDir = path.resolve(root, arg('--out', '.smoke'));
const only = arg('--only', '');
const page = path.join(root, 'dist', 'index.html');
if (!existsSync(page)) {
  console.error('dist/index.html not found, run "npm run build" first');
  process.exit(2);
}

const candidates = [
  arg('--browser'),
  process.env.UBMS_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
if (!exe) {
  console.error('No Chromium-based browser found. Pass --browser <path> or set UBMS_BROWSER.');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'ubms-smoke-'));

// Headless only: never start a visible browser window.
const browser = spawn(
  exe,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--hide-scrollbars',
    '--mute-audio',
    '--lang=en-US',
    '--accept-lang=en-US,en',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--allow-file-access-from-files',
    // CI runners on Ubuntu 24.04 restrict the user namespaces the Chrome sandbox needs (AppArmor),
    // so Chrome exits at once there; the sandbox stays on everywhere else.
    ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
);

/** The end of the browser's error output, shown when it does not start. */
let browserErr = '';
browser.stderr.on('data', (/** @type {Buffer} */ d) => {
  browserErr = (browserErr + d.toString()).slice(-4000);
});
/** @type {number | null} */
let browserExit = null;
browser.on('exit', (code) => (browserExit = code));
browser.on('error', () => {});

/** DevTools port of the browser; 0 until it is known. */
let port = 0;

/** The launcher process may hand over to a child and exit, so read the port from the profile. */
async function waitForPort() {
  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 600; i++) {
    if (existsSync(file)) {
      const [p] = readFileSync(file, 'utf8').split('\n');
      if (p && Number(p) > 0) return Number(p);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`Browser exit code: ${browserExit ?? 'still running'}`);
  console.error(browserErr);
  throw new Error('Browser did not start (no DevToolsActivePort)');
}

/**
 * Close the whole headless browser through CDP (works even when the launcher already exited),
 * then wait a few seconds for the spawned process to end and kill it when it does not.
 */
async function closeBrowser() {
  if (port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
      const { webSocketDebuggerUrl } = await res.json();
      const ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise((r, j) => {
        ws.onopen = r;
        ws.onerror = j;
        setTimeout(() => j(new Error('timeout')), 5000);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      /* fall back to killing the spawned process */
    }
  }
  if (browserExit === null) {
    await new Promise((r) => {
      browser.once('exit', r);
      setTimeout(r, 5000);
    });
  }
  browser.kill();
}

/** Time a CDP call may take before the step fails (on top of the step's own promise). */
const CDP_TIMEOUT = 60_000;

/** Minimal CDP client for one page target. */
async function openPage() {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  // A crashed tab or a closed connection fails every call still waiting for an answer.
  ws.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error('DevTools connection closed'));
    pending.clear();
  };
  // A page promise that never settles (awaitPromise) must not hang the whole run.
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new Error(`${method} timed out after ${CDP_TIMEOUT / 1000} s`));
      }, CDP_TIMEOUT);
      const done = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      pending.set(n, { resolve: done(resolve), reject: done(reject) });
      if (ws.readyState !== WebSocket.OPEN) {
        pending.get(n).reject(new Error('DevTools connection closed'));
        pending.delete(n);
        return;
      }
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return {
    send,
    on: (fn) => listeners.add(fn),
    close: async () => {
      ws.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const baseUrl = pathToFileURL(page).href;

/**
 * @param {string} name
 * @param {{ hash: string, width: number, height: number, mobile: boolean, wait?: number, steps?: Array<{ hash?: string, eval?: string, wait?: number, shot?: string }>, dark?: boolean }} sc
 */
async function scenario(name, sc) {
  const p = await openPage();
  const errors = [];
  p.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url ?? '')) errors.push(m.params.entry.text);
  });
  const shots = [];
  try {
    await p.send('Runtime.enable');
    await p.send('Log.enable');
    await p.send('Page.enable');
    await p.send('Emulation.setDeviceMetricsOverride', { width: sc.width, height: sc.height, deviceScaleFactor: 1, mobile: sc.mobile });
    if (sc.dark) await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    if (sc.initScript) await p.send('Page.addScriptToEvaluateOnNewDocument', { source: sc.initScript });
    await p.send('Page.navigate', { url: `${baseUrl}#${sc.hash}` });
    await sleep(sc.wait ?? 1500);
    for (const step of sc.steps ?? [{ shot: name }]) {
      if (step.eval) {
        const r = await p.send('Runtime.evaluate', { expression: step.eval, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) errors.push(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        else if (r.result?.value === false) errors.push(`check failed: ${step.eval.slice(0, 120)}`);
      }
      if (step.hash) {
        await p.send('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(step.hash)}` });
      }
      await sleep(step.wait ?? 700);
      if (step.shot) {
        const { data } = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const file = path.join(outDir, `${step.shot}.png`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        shots.push(path.relative(root, file));
      }
    }
  } catch (e) {
    // A step that timed out or lost the page fails this scenario; the next one still runs.
    errors.push(`step failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    await p.close();
  }
  return { name, errors, shots };
}

// mobile:false keeps screenshots stable in headless mode; layout depends only on the width.
const phone = { width: 390, height: 844, mobile: false };
const desktop = { width: 1366, height: 860, mobile: false };

/** Text that must appear somewhere in the app (walks shadow roots). */
const hasText = (s) =>
  `(() => { const walk = (n) => { if (n.shadowRoot && walk(n.shadowRoot)) return true; for (const c of n.children ?? []) if (walk(c)) return true; return (n.textContent ?? '').includes(${JSON.stringify(s)}); }; return walk(document.querySelector('ubms-app')); })()`;

/** Write one plain number setting through the app controller, check the read-back, restore it. */
const writeCheck = `(async () => {
  const c = window.ubms;
  const s = c.session;
  if (!s.driver?.capabilities.writeSettings) return true;
  const schema = s.driver.getSettingsSchema();
  const values = s.settings.values ?? {};
  for (const g of schema.groups) for (const f of g.fields) {
    if (f.type !== 'number' || f.readOnly || f.danger || f.advanced || f.validate) continue;
    const v = values[f.id];
    if (typeof v !== 'number') continue;
    const step = f.step ?? 1;
    let nv = Math.round((v + step) / step) * step;
    if (f.max !== undefined && nv > f.max) nv = Math.round((v - step) / step) * step;
    const res = await c.writeSettings([{ id: f.id, value: nv }], { quiet: true });
    const ok = res[0]?.ok && res[0]?.verified !== false;
    await c.writeSettings([{ id: f.id, value: v }], { quiet: true });
    if (!ok) console.error('write check failed for ' + f.id + ': ' + JSON.stringify(res[0]));
    return !!ok;
  }
  return true;
})()`;

/** A rich synthetic snapshot rendered without any driver, to check layouts of every widget. */
const fixture = `(() => {
  const c = window.ubms;
  const cells = Array.from({ length: 16 }, (_, i) => 3.30 + Math.sin(i) * 0.012 + (i === 6 ? 0.025 : 0));
  const snap = {
    timestamp: Date.now(), voltage: 52.95, current: -23.4, power: -1239.0, soc: 64, soh: 98,
    capacityRemaining: 179.2, capacityFull: 280, capacityNominal: 280, cycles: 112, cycleCapacity: 31360,
    uptime: 912345, cells, cellResistances: cells.map((_, i) => 0.9 + (i % 4) * 0.12),
    balancing: cells.map((_, i) => i === 6), balancingActive: true, balanceCurrent: 0.42,
    temperatures: [
      { id: 'mos', label: 'MOSFET', value: 31.5, kind: 'mos' },
      { id: 't1', label: 'Sensor 1', value: 24.1, kind: 'cell' },
      { id: 't2', label: 'Sensor 2', value: 47.9, kind: 'cell' },
    ],
    switches: { charge: true, discharge: true, balance: true, heater: false },
    alarms: [
      { id: 'cell_voltage_difference', label: 'Cell voltage difference too high', severity: 'warning', source: 'bit 2' },
      { id: 'charge_overtemperature', label: 'Charge overtemperature', severity: 'protection' },
    ],
    extra: { state: { label: 'System state', value: 'Discharging' }, rt: { label: 'Remaining time', value: 7.6, unit: 'h', decimals: 1 } },
    cellStats: { count: 16, min: Math.min(...cells), max: Math.max(...cells), avg: cells.reduce((a, b) => a + b) / 16, delta: Math.max(...cells) - Math.min(...cells), sum: cells.reduce((a, b) => a + b), minIndex: cells.indexOf(Math.min(...cells)), maxIndex: cells.indexOf(Math.max(...cells)) },
    state: 'discharging', timeToEmpty: 7.66,
  };
  c.session.lastDataAt = Date.now() + 3600e3;
  c.store.set({ state: 'connected', snapshot: snap, device: { driverId: 'fixture', vendor: 'Fixture BMS', protocol: 'Fixture protocol', deviceName: 'FIX-16S', linkKind: 'demo', deviceType: 'bms' } });
  return true;
})()`;

/** The Charts view element (inside the app's shadow root). */
const chartsView = `document.querySelector('ubms-app').shadowRoot.querySelector('view-charts')`;

/** Every chart canvas of the Charts view has drawn pixels (at least `min` charts). */
const chartsDrawn = (min) => `(() => {
  const v = ${chartsView};
  const charts = v ? [...v.shadowRoot.querySelectorAll('ui-chart')] : [];
  if (charts.length < ${min}) return false;
  return charts.every((c) => {
    const cv = c.shadowRoot.querySelector('canvas.base');
    if (!cv || !cv.width || !cv.height) return false;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    return n > 300;
  });
})()`;

/** The chart cards share the time axis: the same plot left edge and width in every card. */
const chartsAligned = `(() => {
  const charts = [...${chartsView}.shadowRoot.querySelectorAll('ui-chart')];
  const xs = new Set(charts.map((c) => c.__layout?.plot.x));
  const ws = new Set(charts.map((c) => c.__layout?.plot.w));
  return charts.length > 1 && xs.size === 1 && ws.size === 1 && !xs.has(undefined);
})()`;

/** The CSV export (built through the view, no download) has a header and data rows. */
const chartsCsv = (minRows) => `(() => {
  const csv = ${chartsView}.buildCsv();
  const lines = csv.replace(/^\\uFEFF/, '').split('\\r\\n').filter(Boolean);
  return csv.endsWith('\\r\\n') && lines.length > ${minRows} && lines[0].startsWith('Time,Unix time (ms),Voltage (V)') && /^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d[+-]\\d\\d:\\d\\d,\\d{13},/.test(lines[1]);
})()`;

/** The PNG export draws every visible chart into one image. */
const chartsPng = `${chartsView}.buildPng().then((b) => !!b && b.type === 'image/png' && b.size > 8000)`;

/** One hour of a stored 4 cell battery (a record per 4 s, a gap in the middle) in the persistent store. */
const seedHistory = `(async () => {
  const s = window.ubms.historyStore;
  const now = Date.now();
  const recs = [];
  for (let i = 0; i < 900; i++) {
    if (i > 420 && i < 470) continue;
    const c = [3.31, 3.322, 3.305, 3.318].map((v, k) => Math.round((v + 0.012 * Math.sin(i / 60 + k) + (0.0004 * i) / 9) * 1000) / 1000);
    const u = Math.round(c.reduce((a, b) => a + b) * 1000) / 1000;
    const cur = Math.round(25 * Math.sin(i / 120) * 1000) / 1000;
    const cmin = Math.min(...c);
    const cmax = Math.max(...c);
    recs.push({
      t: now - (900 - i) * 4000, u, i: cur, p: Math.round(u * cur * 10) / 10, soc: Math.round((52 + i / 30) * 10) / 10,
      cmin, cmax, cavg: Math.round((u / 4) * 1000) / 1000, cdel: Math.round((cmax - cmin) * 10000) / 10000, c,
      tc: [Math.round((24 + 3 * Math.sin(i / 200)) * 10) / 10, Math.round((21 + i / 300) * 10) / 10],
    });
  }
  await s.remove('sn:smoke:0001');
  await s.writeMeta('sn:smoke:0001', { name: 'Smoke stored BMS', vendor: 'Smoke', cellCount: 4, tempLabels: ['MOSFET', 'Sensor 1'] });
  await s.append('sn:smoke:0001', recs);
  const list = await s.list();
  return list.some((d) => d.key === 'sn:smoke:0001' && d.count === recs.length);
})()`;

/**
 * Files of the imitated plugin folder (plugins_list in scripts/tauri-mock.js): the example plugin,
 * one that fails in register(), and one the bridge refused. Every Tauri scenario loads them.
 */
const mockPlugins = {
  plugins: [
    { file: 'example-bms.js', source: readFileSync(path.join(root, 'examples', 'plugins', 'example-bms.js'), 'utf8') },
    { file: 'zz-broken.js', source: "export default function register() { throw new Error('Broken on purpose'); }" },
  ],
  errors: [{ file: 'huge.js', error: 'The file is larger than 1 MiB' }],
};

/** Imitation of the Tauri bridge, see scripts/tauri-mock.js, with the plugin files above. */
const tauriMock = `window.__tauriMockPlugins = ${JSON.stringify(mockPlugins)};\n${readFileSync(path.join(root, 'scripts', 'tauri-mock.js'), 'utf8')}`;

/** An element in the shadow root of one view of the app, for example viewPart('view-more', 'ui-list-row'). */
const viewPart = (view, selector) =>
  `document.querySelector('ubms-app').shadowRoot.querySelector(${JSON.stringify(view)})?.shadowRoot.querySelector(${JSON.stringify(selector)})`;

const scenarios = [
  [
    'connect-phone',
    {
      ...phone,
      hash: '/connect',
      steps: [
        { eval: hasText('ubms'), shot: 'connect-phone' },
        // The browser has no plugins: no Plugins row in More, and the view says so.
        { hash: '/more' },
        { eval: `!!${viewPart('view-more', 'ui-list-row')} && !${viewPart('view-more', 'ui-list-row[href="#/plugins"]')}` },
        { hash: '/plugins' },
        { eval: hasText('Plugins are available in the desktop app only.') },
      ],
    },
  ],
  ['connect-desktop-dark', { ...desktop, dark: true, hash: '/connect', steps: [{ shot: 'connect-desktop-dark' }] }],
  ['prefs-phone', { ...phone, hash: '/prefs', steps: [{ shot: 'prefs-phone' }] }],
  [
    'fixture-phone',
    { ...phone, hash: '/connect', steps: [{ eval: fixture, hash: '/overview', shot: 'fixture-overview-phone' }, { hash: '/cells', shot: 'fixture-cells-phone' }] },
  ],
  [
    'i18n-uk-phone',
    {
      ...phone,
      hash: '/connect',
      steps: [
        { eval: `(window.ubms.setPref('lang', 'uk'), true)`, shot: 'i18n-uk-connect-phone' },
        { eval: fixture, hash: '/overview', shot: 'i18n-uk-overview-phone' },
        { eval: `(window.ubms.setPref('lang', 'en'), true)` },
      ],
    },
  ],
  [
    'i18n-uk-jk-phone',
    {
      ...phone,
      hash: '/connect',
      steps: [
        { eval: `(window.ubms.setPref('lang', 'uk'), window.ubms.connectDemo('jk-ble').then(() => true))`, wait: 3500, shot: 'i18n-uk-jk-overview-phone' },
        { hash: '/settings/cell_voltage', wait: 2500, shot: 'i18n-uk-jk-settings-phone' },
        { hash: '/settings/temperature', shot: 'i18n-uk-jk-temperature-phone' },
        { eval: `(window.ubms.setPref('lang', 'en'), true)` },
      ],
    },
  ],
  [
    'tauri-mock-phone',
    {
      ...phone,
      hash: '/connect',
      initScript: tauriMock,
      steps: [
        { eval: `window.ubms.nativeBle === true && window.ubms.nativeSerial === true` },
        {
          eval: `(window.ubms.setPref('transport', 'ble'), window.ubms.setPref('selection', 'auto'), window.ubms.startBleScan().then(() => true))`,
          wait: 900,
          shot: 'tauri-scan-phone',
        },
        { eval: `window.ubms.state.scan.devices.length === 2` },
        {
          eval: `window.ubms.connectScannedDevice(window.ubms.state.scan.devices.find((d) => d.name.startsWith('JK'))).then(() => window.ubms.state.state === 'connected' && window.ubms.state.device.driverId === 'jk-ble')`,
          wait: 2500,
          shot: 'tauri-jk-overview-phone',
        },
        { eval: `(window.ubms.state.snapshot?.cells?.length ?? 0) > 0` },
        // Charts on the desktop path: history files through the bridge, exports through save_file.
        { hash: '/charts', wait: 3000, shot: 'tauri-charts-phone' },
        { eval: hasText('C:/ubms-mock/history') },
        { eval: chartsDrawn(3) },
        {
          eval: `${chartsView}.exportCsv().then((path) => typeof path === 'string' && path.startsWith('C:/Users/mock/Downloads/') && path.endsWith('.csv') && window.__tauriMock.savedFiles.length === 1)`,
          wait: 300,
        },
        { eval: `window.ubms.recorder.flush().then(() => window.__tauriMock.calls.history_append >= 1 && window.__tauriMock.historyKeys.some((k) => k.startsWith('sn:jk:')))` },
        {
          // Closing the window writes the readings taken since the last write, then lets it close.
          eval: `new Promise((r) => setTimeout(r, 2600)).then(() => { const before = window.__tauriMock.calls.history_append ?? 0; return window.__tauriMock.requestClose().then((c) => c.handlers === 1 && c.destroyed === 1 && window.__tauriMock.calls.history_append > before); })`,
        },
        // The stored device list reports the time of the last record, not the meta write.
        {
          eval: `window.ubms.historyStore.list().then((l) => l.length > 0 && l.every((d) => { const lines = window.__tauriMock.historyLines(d.key); return lines.length > 0 && d.last === JSON.parse(lines.at(-1)).t; }))`,
        },
        {
          // Recent devices connect with the remembered driver, whatever type is selected now.
          eval: `window.ubms.disconnect().then(() => (window.ubms.setPref('selection', 'family:ant'), window.ubms.connectRecent(window.ubms.state.recent.find((r) => r.kind === 'ble')))).then(() => window.ubms.state.state === 'connected' && window.ubms.state.device.driverId === 'jk-ble')`,
          wait: 1500,
        },
        {
          // The device drops the link: the session reconnects by id, without a scan.
          eval: `(window.ubms.setPref('selection', 'auto'), window.__tauriMock.dropBle(window.ubms.state.recent.find((r) => r.kind === 'ble').id))`,
          wait: 4000,
        },
        {
          eval: `window.ubms.state.state === 'connected' && window.__tauriMock.listenerCount('ble://disconnected') === 1 && window.__tauriMock.listenerCount('ble://notify') === 1`,
        },
        {
          eval: `window.ubms.disconnect().then(() => (window.ubms.setPref('transport', 'serial'), window.ubms.setPref('selection', 'family:daly'), true))`,
          hash: '/connect',
          wait: 1200,
          shot: 'tauri-ports-phone',
        },
        {
          eval: `window.ubms.connectSerialPort({ path: 'COM7' }).then(() => window.ubms.state.state === 'connected' && window.ubms.state.device.driverId === 'daly')`,
          wait: 3000,
          shot: 'tauri-daly-overview-phone',
        },
        { eval: `(window.ubms.state.snapshot?.cells?.length ?? 0) > 0` },
        {
          // The adapter is unplugged: the link closes and the bridge forgets the port.
          eval: `window.__tauriMock.dropSerial(window.__tauriMock.openSerial[0])`,
          wait: 800,
        },
        {
          eval: `window.ubms.state.state === 'error' && window.__tauriMock.openSerial.length === 0 && window.__tauriMock.listenerCount('serial://data') === 0`,
        },
        {
          // Nothing of the lost link holds the port: it opens again (ports are exclusive on Windows).
          eval: `window.ubms.connectSerialPort({ path: 'COM7' }).then(() => window.ubms.state.state === 'connected')`,
          wait: 1500,
        },
        {
          eval: `window.ubms.disconnect().then(() => (window.ubms.setPref('transport', 'ble'), window.ubms.setPref('selection', 'auto'), ['ble://device', 'ble://notify', 'ble://disconnected', 'serial://data', 'serial://closed'].every((e) => window.__tauriMock.listenerCount(e) === 0)))`,
        },
        {
          // Every session wrote its records (on disconnect at the latest) and a meta file.
          eval: `window.ubms.historyStore.list().then((list) => window.__tauriMock.calls.history_append >= 3 && window.__tauriMock.calls.history_write_meta >= 2 && list.length >= 2 && list.every((d) => d.bytes > 0 && d.meta?.name))`,
        },
      ],
    },
  ],
  [
    'tauri-plugins-phone',
    {
      ...phone,
      hash: '/more',
      initScript: tauriMock,
      steps: [
        // Loaded before the first screen: the example driver comes after the built-in drivers.
        {
          eval: `window.ubms.state.plugins.loaded && window.ubms.registry.list().at(-1)?.id === 'example-bms' && window.ubms.state.plugins.plugins.length === 1 && window.ubms.state.plugins.plugins[0].file === 'example-bms.js' && window.ubms.state.plugins.plugins[0].drivers.join() === 'example-bms'`,
        },
        { eval: `window.ubms.state.plugins.failures.map((f) => f.file).join() === 'huge.js,zz-broken.js' && window.ubms.state.plugins.dirs.join() === 'C:/ubms-mock/plugins'` },
        { eval: `window.ubms.log.entries().some((e) => e.source === 'plugins' && /Plugin example-bms\\.js loaded/.test(e.text ?? ''))` },
        { eval: `!!${viewPart('view-more', 'ui-list-row[href="#/plugins"]')}`, shot: 'tauri-more-phone' },
        { hash: '/plugins', wait: 900, shot: 'tauri-plugins-phone' },
        { eval: hasText('C:/ubms-mock/plugins') },
        { eval: hasText('Example BMS') },
        { eval: hasText('example-bms.js') },
        { eval: hasText('EXB1 example protocol') },
        { eval: hasText('zz-broken.js') },
        { eval: hasText('register(api) failed: Broken on purpose') },
        { eval: hasText('The file is larger than 1 MiB') },
        // Offered like a built-in driver: device type list, detection and the demo list.
        { eval: `(window.ubms.setPref('transport', 'serial'), true)`, hash: '/connect', wait: 900 },
        { eval: `!!${viewPart('view-connect', 'option[value="family:example"]')} && !!${viewPart('view-connect', 'option[value="example-bms"]')}` },
        {
          eval: `window.ubms.registry.serialCandidates().at(-1)?.definition.id === 'example-bms' && window.ubms.registry.bleCandidates({ name: 'EXB-8S100' })[0]?.definition.id === 'example-bms'`,
        },
        { eval: `(window.ubms.setPref('transport', 'demo'), true)`, wait: 600 },
        { eval: `!!${viewPart('view-connect', 'option[value="example-bms"]')}`, shot: 'tauri-plugin-demo-list-phone' },
        {
          eval: `window.ubms.connectDemo('example-bms').then(() => window.ubms.state.state === 'connected' && window.ubms.state.device.driverId === 'example-bms')`,
          wait: 2500,
          shot: 'tauri-plugin-demo-overview-phone',
        },
        { eval: `window.ubms.state.snapshot?.cells?.length === 8 && window.ubms.state.info?.model === 'EXB-8S100'` },
        { hash: '/settings', wait: 2000, shot: 'tauri-plugin-demo-settings-phone' },
        { eval: `window.ubms.state.settings.values?.['cell.ovp'] === 3.65` },
        { eval: writeCheck, wait: 300 },
        { eval: `window.ubms.disconnect().then(() => (window.ubms.setPref('transport', 'ble'), window.ubms.setPref('selection', 'auto'), true))` },
      ],
    },
  ],
  ['tauri-plugins-desktop', { ...desktop, hash: '/plugins', initScript: tauriMock, steps: [{ eval: hasText('Example BMS'), shot: 'tauri-plugins-desktop' }] }],
  [
    'charts-demo-phone',
    {
      ...phone,
      hash: '/connect',
      steps: [
        {
          eval: `(window.ubms.setPref('historyIntervalMs', 1000), window.ubms.setPref('chartRange', '5m'), window.ubms.connectDemo('jk-ble').then(() => window.ubms.state.state === 'connected'))`,
          wait: 6500,
        },
        { hash: '/charts', wait: 1500, shot: 'charts-demo-phone' },
        { eval: chartsDrawn(3) },
        { eval: chartsCsv(3) },
        { eval: chartsPng },
        // Demo sessions stay in memory: nothing reaches the persistent store.
        { eval: `window.ubms.historyStore.list().then((l) => !l.some((d) => d.meta?.driverId === 'jk-ble'))` },
        { eval: `(window.ubms.setPref('theme', 'dark'), window.ubms.setPref('chartCells', 'all'), true)`, wait: 900, shot: 'charts-demo-phone-dark' },
        { eval: chartsDrawn(3) },
        {
          eval: `(window.ubms.setPref('theme', 'auto'), window.ubms.setPref('chartCells', 'summary'), window.ubms.setPref('historyIntervalMs', 2000), window.ubms.setPref('chartRange', '15m'), true)`,
        },
      ],
    },
  ],
  [
    'charts-demo-desktop',
    {
      ...desktop,
      hash: '/connect',
      steps: [
        {
          eval: `(window.ubms.setPref('historyIntervalMs', 1000), window.ubms.setPref('chartRange', 'all'), window.ubms.connectDemo('ant').then(() => window.ubms.state.state === 'connected'))`,
          wait: 6500,
        },
        { hash: '/charts', wait: 1500, shot: 'charts-demo-desktop' },
        { eval: chartsDrawn(3) },
        { eval: chartsAligned },
        { eval: chartsCsv(3) },
        { eval: `(window.ubms.setPref('theme', 'dark'), true)`, wait: 900, shot: 'charts-demo-desktop-dark' },
        { eval: `(window.ubms.setPref('theme', 'auto'), window.ubms.setPref('historyIntervalMs', 2000), window.ubms.setPref('chartRange', '15m'), true)` },
      ],
    },
  ],
  [
    'overview-other-device-phone',
    {
      ...phone,
      hash: '/connect',
      steps: [
        { eval: `window.ubms.connectDemo('jbd').then(() => window.ubms.state.state === 'connected')`, hash: '/overview', wait: 2500 },
        {
          // The quiet button at the end of the overview disconnects and opens the connect screen.
          eval: `(() => { const b = document.querySelector('ubms-app').shadowRoot.querySelector('view-overview').shadowRoot.querySelector('.other-device button'); b.scrollIntoView(); return !!b; })()`,
          wait: 400,
          shot: 'overview-other-device-phone',
        },
        { eval: `(document.querySelector('ubms-app').shadowRoot.querySelector('view-overview').shadowRoot.querySelector('.other-device button').click(), true)`, wait: 1500 },
        { eval: `window.ubms.state.state === 'idle' && location.hash === '#/connect'` },
      ],
    },
  ],
  [
    'settings-login-phone',
    {
      ...phone,
      hash: '/connect',
      steps: [
        { eval: `window.ubms.connectDemo('ant').then(() => window.ubms.state.state === 'connected')`, wait: 1500 },
        { hash: '/settings', wait: 2500 },
        // A BMS that refused read access: the notice offers the password right there.
        {
          eval: `(window.ubms.store.set((st) => ({ settings: { ...st.settings, notice: 'The BMS answered with empty parameter pages: it did not grant read access. Enter the BMS password (the one of the ANT app) to read the settings.', passwordField: 'ant.password' } })), true)`,
          wait: 500,
          shot: 'settings-login-phone',
        },
        { eval: `!!document.querySelector('ubms-app').shadowRoot.querySelector('view-settings').shadowRoot.querySelector('.notice form.login input[type=password]')` },
      ],
    },
  ],
  [
    'charts-atorch-phone',
    {
      ...phone,
      hash: '/connect',
      steps: [
        {
          eval: `(window.ubms.setPref('historyIntervalMs', 1000), window.ubms.setPref('chartRange', '5m'), window.ubms.connectDemo('atorch').then(() => window.ubms.state.state === 'connected'))`,
          wait: 6500,
        },
        // A meter: driver extra values (energy, capacity, duration) get their own charts.
        { hash: '/charts', wait: 1500 },
        { eval: hasText('Energy') },
        { eval: hasText('Duration') },
        { eval: `(${chartsView}.shadowRoot.querySelector('.chips button:last-child').scrollIntoView(), true)`, wait: 300 },
        { eval: `(() => { const v = ${chartsView}; const c = [...v.shadowRoot.querySelectorAll('ui-chart')].at(-1); c.scrollIntoView(); return true; })()`, wait: 600, shot: 'charts-atorch-phone' },
        { eval: chartsDrawn(5) },
        { eval: `(() => { const h = ${chartsView}.buildCsv().split(String.fromCharCode(13, 10))[0]; return h.includes('Energy (Wh)') && h.includes('Duration (min)'); })()` },
        { eval: `(window.ubms.setPref('historyIntervalMs', 2000), window.ubms.setPref('chartRange', '15m'), true)` },
      ],
    },
  ],
  [
    'charts-stored-phone',
    {
      ...phone,
      hash: '/connect',
      steps: [
        // Browser storage (IndexedDB): a device stored earlier, viewed while nothing is connected.
        { eval: seedHistory },
        { eval: `(window.ubms.setPref('chartRange', '1h'), true)`, hash: '/charts', wait: 1500, shot: 'charts-stored-phone' },
        { eval: chartsDrawn(4) },
        { eval: chartsCsv(800) },
        { eval: hasText('Browser storage on this device') },
        { eval: hasText('Smoke stored BMS') },
        { eval: chartsAligned },
        { eval: `(window.ubms.setPref('chartRange', 'all'), window.ubms.setPref('chartCells', 'all'), true)`, wait: 1200 },
        { eval: chartsDrawn(4) },
        { eval: chartsAligned },
        {
          // Period: a fixed window from 40 to 20 minutes ago inside the stored hour.
          eval: `(() => { const now = Date.now(); window.ubms.setPref('chartFrom', now - 40 * 60000); window.ubms.setPref('chartTo', now - 20 * 60000); window.ubms.setPref('chartCells', 'summary'); window.ubms.setPref('chartRange', 'custom'); return true; })()`,
          wait: 1200,
          shot: 'charts-period-phone',
        },
        { eval: chartsDrawn(4) },
        { eval: `${chartsView}.shadowRoot.querySelectorAll('.period input[type=datetime-local]').length === 2` },
        {
          // Every exported row lies inside the period (about 300 records of 4 s).
          eval: `(() => { const rows = ${chartsView}.buildCsv().split(String.fromCharCode(13, 10)).filter(Boolean).slice(1); const now = Date.now(); const ts = rows.map((r) => Number(r.split(',')[1])); return rows.length > 250 && rows.length < 330 && ts.every((t) => t >= now - 41 * 60000 && t <= now - 19 * 60000); })()`,
        },
        { eval: `(window.ubms.setPref('chartRange', 'all'), window.ubms.setPref('chartCells', 'all'), true)`, wait: 900 },
        {
          // A device that was disconnected with nothing stored: an empty state, not another battery.
          eval: `(() => { const v = ${chartsView}; v.gone = { key: 'sn:smoke:gone', name: 'Gone BMS' }; v.selected = 'stored:sn:smoke:gone'; return true; })()`,
          wait: 600,
        },
        { eval: hasText('No readings of Gone BMS were saved.') },
        { eval: `!${chartsView}.shadowRoot.querySelector('ui-chart')` },
        { eval: `(${chartsView}.selected = '', true)`, wait: 600 },
        { eval: `(window.ubms.setPref('chartRange', '15m'), window.ubms.setPref('chartCells', 'summary'), window.ubms.historyStore.remove('sn:smoke:0001').then(() => true))` },
      ],
    },
  ],
  [
    'charts-stored-desktop',
    {
      ...desktop,
      hash: '/connect',
      steps: [
        { eval: seedHistory },
        { eval: `(window.ubms.setPref('chartRange', '1h'), true)`, hash: '/charts', wait: 1500, shot: 'charts-stored-desktop' },
        { eval: chartsDrawn(4) },
        { eval: chartsAligned },
        { eval: chartsPng },
        { eval: `(window.ubms.setPref('chartRange', '15m'), window.ubms.historyStore.remove('sn:smoke:0001').then(() => true))` },
      ],
    },
  ],
  [
    'fixture-desktop',
    { ...desktop, hash: '/connect', steps: [{ eval: fixture, hash: '/overview', shot: 'fixture-overview-desktop' }, { hash: '/cells', shot: 'fixture-cells-desktop' }] },
  ],
];

/**
 * Ids of the drivers that ship a simulator. Waits for the app module to run (it is large and
 * a cold browser can be slow) and fails instead of silently dropping every demo scenario.
 */
async function readDemoIds() {
  const p = await openPage();
  try {
    await p.send('Runtime.enable');
    await p.send('Page.navigate', { url: `${baseUrl}#/connect` });
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const ready = await p.send('Runtime.evaluate', { expression: '!!window.ubms?.registry', returnByValue: true });
      if (ready.result?.value === true) break;
    }
    const r = await p.send('Runtime.evaluate', { expression: 'window.ubms.registry.list().filter((d) => d.demo).map((d) => d.id)', returnByValue: true });
    if (r.exceptionDetails) throw new Error(`Reading the demo drivers failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    const ids = r.result?.value;
    if (!Array.isArray(ids) || !ids.length) throw new Error('No demo drivers found');
    return ids;
  } finally {
    await p.close();
  }
}

/** Demo sessions for every driver that ships a simulator. @param {string[]} demoIds */
function addDemoScenarios(demoIds) {
  for (const id of demoIds) {
    scenarios.push([
      `demo-${id}-phone`,
      {
        ...phone,
        hash: `/connect?demo=${id}`,
        wait: 3500,
        steps: [
          { eval: `window.ubms.state.state === 'connected'`, shot: `demo-${id}-overview-phone` },
          { hash: '/cells', shot: `demo-${id}-cells-phone` },
          { hash: '/settings', wait: 2500, shot: `demo-${id}-settings-phone` },
          // Read only drivers without settings (jbd-up-rs485) have nothing to load.
          { eval: `!window.ubms.session.driver?.capabilities.settings || window.ubms.state.settings.values !== null` },
          { eval: writeCheck, wait: 300 },
          { hash: `/settings/${'cell_voltage'}`, shot: `demo-${id}-settings-group-phone` },
          { hash: '/settings/controls', shot: `demo-${id}-settings-controls-phone` },
          { hash: '/settings/actions', shot: `demo-${id}-settings-actions-phone` },
          { hash: '/info', shot: `demo-${id}-info-phone` },
          { hash: '/log', shot: `demo-${id}-log-phone` },
        ],
      },
    ]);
    scenarios.push([
      `demo-${id}-desktop`,
      {
        ...desktop,
        hash: `/connect?demo=${id}`,
        wait: 3500,
        steps: [{ shot: `demo-${id}-overview-desktop` }, { hash: '/settings', wait: 2500, shot: `demo-${id}-settings-desktop` }],
      },
    ]);
  }
}

let failed = 0;
// Everything that talks to the browser runs inside try, so the browser and its profile are
// removed whatever fails (also when the browser never reports its port).
try {
  port = await waitForPort();
  addDemoScenarios(await readDemoIds());
  for (const [name, sc] of scenarios) {
    if (only && !name.includes(only)) continue;
    const r = await scenario(name, sc);
    const status = r.errors.length ? 'FAIL' : 'ok';
    if (r.errors.length) failed++;
    console.log(`${status.padEnd(4)} ${name}  ${r.shots.join(', ')}`);
    for (const e of r.errors) console.log(`     ${String(e).split('\n')[0]}`);
  }
} finally {
  await closeBrowser();
  try {
    // The browser may still hold a lock on the profile for a moment after it exits.
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    console.error(`Could not remove the browser profile ${profile}: ${e instanceof Error ? e.message : e}`);
  }
}
console.log(failed ? `${failed} scenario(s) with errors` : 'All scenarios passed');
process.exit(failed ? 1 : 0);
