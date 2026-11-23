import {
  ProtocolLog,
  WebBluetoothProvider,
  WebSerialProvider,
  TauriBleProvider,
  TauriSerialProvider,
  createLinkPair,
  detectEnvironment,
  isTauri,
} from '@ubms/transport';
import { BmsSession, DriverRegistry, fieldMap, coerce, msg } from '@ubms/bms-core';
import { drivers } from '@ubms/bms-drivers';
import {
  Store,
  createStorage,
  i18n,
  negotiateLocale,
  applyTheme,
  toast,
  t,
  downloadFile,
  setFileSaver,
  createSeriesStore,
  indexedDbBackend,
  tauriFileBackend,
  memoryBackend,
  fallbackBackend,
} from '@ubms/ui';
import { HistoryRecorder } from './history/recorder.js';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'uk', name: 'Українська' },
  { code: 'ru', name: 'Русский' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
];

/**
 * @typedef {Object} Prefs
 * @property {string} lang
 * @property {'auto'|'light'|'dark'} theme
 * @property {number} pollMs
 * @property {boolean} keepAwake
 * @property {boolean} showAdvanced
 * @property {number} logCapacity
 * @property {boolean} logRaw show raw rx chunks in the log view
 * @property {'ble'|'serial'|'demo'} transport
 * @property {string} selection driver selection ('auto', family or driver id)
 * @property {string} demoDriver
 * @property {boolean} showAllBle
 * @property {boolean} adaptersOnly
 * @property {string} serialAddress RS485 device address or board number, empty for the protocol default
 * @property {boolean} historyEnabled store the readings for the Charts view
 * @property {number} historyIntervalMs time between two history records
 * @property {number} historyRetentionDays delete older records when a device connects, 0 keeps everything
 * @property {string} chartRange Charts view range: '5m', '10m', '15m', '30m', '1h', '2h', 'all' or
 *   'custom' (chartFrom to chartTo)
 * @property {number} chartFrom start of the custom range, epoch ms (0: not set yet)
 * @property {number} chartTo end of the custom range, epoch ms (0: not set yet)
 * @property {string[]} chartHidden chart groups switched off in the Charts view
 * @property {'summary'|'all'} chartCells cell chart: lowest, highest and average, or every cell
 *
 * @typedef {{ id: string, name: string, kind: 'ble'|'serial', driverId?: string, at: number }} RecentDevice
 *
 * @typedef {Object} AppState
 * @property {Prefs} prefs
 * @property {ReturnType<typeof detectEnvironment>} env
 * @property {{ ble: { available: boolean, reason?: string }, serial: { available: boolean, reason?: string } }} availability
 * @property {import('@ubms/bms-core/session').SessionState} state
 * @property {string | null} error
 * @property {{ index: number, total: number, protocol: string } | null} detect
 * @property {{ driverId: string, vendor: string, protocol: string, variant?: string, deviceName: string, linkKind: string, deviceType: string } | null} device
 * @property {import('@ubms/bms-core/model').BmsSnapshot | null} snapshot
 * @property {import('@ubms/bms-core/model').DeviceInfo | null} info
 * @property {import('@ubms/bms-core/session').SettingsState} settings
 * @property {number} historyRev
 * @property {RecentDevice[]} recent
 * @property {{ active: boolean, devices: ScannedDevice[] }} scan native Bluetooth scan (desktop app)
 * @property {{ loading: boolean, list: Array<{ path: string, name?: string, usbVendorId?: number, usbProductId?: number }> }} ports native port list (desktop app)
 * @property {RecordingState | null} recording history recording of the connected device
 * @property {import('@ubms/ui/timeseries').SeriesStoreInfo | null} historyInfo where the history is stored
 * @property {import('./plugins.js').PluginReport & { loaded: boolean }} plugins desktop plugins (apps/web/src/plugins.js)
 *
 * @typedef {{ id: number, key: string | null, name: string, demo: boolean, epoch: number, rev: number, error: string | null }} RecordingState
 *
 * @typedef {{ id: string, name: string, rssi?: number, services?: string[] }} ScannedDevice
 */

const DEFAULT_PREFS = /** @type {Prefs} */ ({
  lang: '',
  theme: 'auto',
  pollMs: 1000,
  keepAwake: true,
  showAdvanced: false,
  logCapacity: 5000,
  logRaw: false,
  transport: 'ble',
  selection: 'auto',
  demoDriver: '',
  showAllBle: false,
  adaptersOnly: false,
  serialAddress: '',
  historyEnabled: true,
  historyIntervalMs: 2000,
  historyRetentionDays: 0,
  chartRange: '15m',
  chartFrom: 0,
  chartTo: 0,
  chartHidden: ['power', 'capacity'],
  chartCells: 'summary',
});

/** Choices offered in the preferences. */
export const HISTORY_INTERVALS = [1000, 2000, 5000, 10000, 30000, 60000];
export const HISTORY_RETENTION_DAYS = [0, 7, 30, 90, 365];

/**
 * Base64 of a blob, for the desktop bridge (`save_file`). The browser encodes it natively (a data
 * URL), without a binary string of the whole file in JavaScript.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      // 'data:<type>;base64,<data>'; an empty blob may give 'data:' without a comma.
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error ?? new Error(msg('Could not read the file data')));
    reader.readAsDataURL(blob);
  });
}

/** Values a settings file may hold for a boolean field. */
const IMPORT_BOOLEANS = new Set([true, false, 0, 1, 'true', 'false', '0', '1']);

/**
 * Does a value of a settings file fit the field's type? Booleans only as true/false (or 0/1),
 * texts and numbers only as strings or numbers, never null or objects.
 * @param {import('@ubms/bms-core/settings').SettingField} f
 * @param {unknown} raw
 */
function importable(f, raw) {
  if (f.type === 'boolean') return IMPORT_BOOLEANS.has(/** @type {any} */ (raw));
  return typeof raw === 'string' || typeof raw === 'number';
}

/** Longest wait for the last history write when the desktop window closes. */
const CLOSE_FLUSH_MS = 1500;

/**
 * Setting values without passwords and other secrets, for files a user may share (settings and
 * log exports). A field counts as secret when it has `secret: true` or its id names a password.
 * @param {import('@ubms/bms-core/settings').SettingsSchema | null | undefined} schema
 * @param {Record<string, any> | null | undefined} values
 * @returns {Record<string, any> | null | undefined}
 */
export function withoutSecrets(schema, values) {
  if (!values) return values;
  const fields = fieldMap(schema);
  return Object.fromEntries(
    Object.entries(values).filter(([id]) => {
      const f = fields.get(id);
      return !f?.secret && !/password/i.test(id);
    }),
  );
}

/** The first driver with a demo; DEFAULT_PREFS cannot name it before the drivers are known. */
function defaultDemoDriver() {
  return drivers.find((d) => d.demo)?.id ?? '';
}

/**
 * Does the BMS type choice have a driver for the chosen link? A choice without one would still be
 * used for connecting while the type list shows another option. The demo tab ignores the choice.
 * @param {DriverRegistry} registry
 * @param {Prefs} prefs
 */
function selectionFits(registry, { selection, transport }) {
  return transport === 'demo' || selection === 'auto' || registry.select(selection, transport).length > 0;
}

export class AppController {
  constructor() {
    this.storage = createStorage('ubms');
    const saved = this.storage.get('prefs', {});
    /** @type {Prefs} */
    const prefs = { ...DEFAULT_PREFS, ...saved };
    if (!prefs.lang) {
      prefs.lang = negotiateLocale(
        LANGUAGES.map((l) => l.code),
        typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [],
      );
    }
    this.log = new ProtocolLog({ capacity: prefs.logCapacity });
    this.registry = new DriverRegistry(drivers);
    if (!prefs.demoDriver || !this.registry.get(prefs.demoDriver)) prefs.demoDriver = defaultDemoDriver();
    if (!selectionFits(this.registry, prefs)) prefs.selection = 'auto';
    this.session = new BmsSession({ registry: this.registry, log: this.log, pollIntervalMs: prefs.pollMs });
    const tauri = isTauri();
    this.providers = {
      ble: tauri ? new TauriBleProvider({ log: this.log }) : new WebBluetoothProvider({ log: this.log }),
      serial: tauri ? new TauriSerialProvider({ log: this.log }) : new WebSerialProvider({ log: this.log }),
    };
    /** @type {any} */
    this.wakeLock = null;
    /** @type {(() => void) | null} */
    this.stopDemo = null;

    /** @type {Store<AppState>} */
    this.store = new Store(
      /** @type {AppState} */ ({
        prefs,
        env: detectEnvironment(),
        availability: { ble: { available: false }, serial: { available: false } },
        state: 'idle',
        error: null,
        detect: null,
        device: null,
        snapshot: null,
        info: null,
        settings: { schema: null, values: null, loading: false, error: null },
        historyRev: 0,
        recent: this.storage.get('recent', []),
        scan: { active: false, devices: [] },
        ports: { loading: false, list: [] },
        recording: null,
        historyInfo: null,
        plugins: { loaded: false, dirs: [], plugins: [], failures: [] },
      }),
    );
    /** @type {(() => Promise<void>) | null} */
    this.stopScanFn = null;
    /** Number of the latest availability check; an older one that finishes later is ignored. */
    this.availabilitySeq = 0;
    /** Persistent browser storage was requested for the history (once per page). */
    this.persistAsked = false;

    i18n.setLocale(prefs.lang);
    applyTheme(prefs.theme);
    this.#wireSession();
    this.#setupHistory(tauri);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.#updateWakeLock();
          this.refreshAvailability();
        }
      });
    }
  }

  get state() {
    return this.store.get();
  }

  /**
   * Chart history: the store (desktop files, IndexedDB in the browser, memory when neither works,
   * also when IndexedDB exists but cannot be opened), a memory store for demo sessions and the
   * recorder. The desktop app also saves exports through the bridge, because blob downloads do not
   * work in every webview, and writes the last readings before its window closes.
   * @param {boolean} tauri
   */
  #setupHistory(tauri) {
    /** @type {((cmd: string, args?: Record<string, any>) => Promise<any>) | null} */
    const invoke = tauri
      ? async (cmd, args) => {
          try {
            return await /** @type {any} */ (window).__TAURI__.core.invoke(cmd, args);
          } catch (err) {
            throw err instanceof Error ? err : new Error(String(err));
          }
        }
      : null;
    const backend = invoke ? tauriFileBackend(invoke) : fallbackBackend(indexedDbBackend('ubms-history'), memoryBackend());
    /** Stored history of every device. */
    this.historyStore = createSeriesStore(backend);
    /** Demo sessions are recorded in memory only, never persisted. */
    this.demoHistoryStore = createSeriesStore(memoryBackend());
    this.recorder = new HistoryRecorder({
      session: this.session,
      store: this.historyStore,
      demoStore: this.demoHistoryStore,
      prefs: () => this.state.prefs,
      warn: (message) => this.log.warn(`History: ${message}`),
      onChange: (live) => {
        this.store.set({
          recording: live
            ? { id: live.id, key: live.key, name: live.meta?.name ?? '', demo: live.demo, epoch: live.epoch, rev: live.rev, error: live.error }
            : null,
        });
        // The first device whose readings are stored: ask the browser to keep them.
        if (live?.key && !live.demo && this.state.prefs.historyEnabled) this.#askPersistentStorage();
      },
    });
    if (invoke) {
      this.#flushOnClose();
      setFileSaver(async (name, blob) => {
        try {
          const path = await invoke('save_file', { name, data: await blobToBase64(blob) });
          toast(t('Saved to {path}', { path: String(path) }), { tone: 'ok', timeout: 8000 });
          return path;
        } catch (err) {
          toast(t('Could not save the file: {error}', { error: t(err instanceof Error ? err.message : String(err)) }), { tone: 'danger', timeout: 9000 });
          return null;
        }
      });
    }
  }

  /**
   * Browser storage is "best effort" by default: under storage pressure (common on phones) the
   * browser may delete it. Ask once, when the first readings are stored, that it is kept. Chromium
   * and Safari decide without asking the user, Firefox may ask.
   */
  async #askPersistentStorage() {
    if (this.persistAsked) return;
    this.persistAsked = true;
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage?.persist) return;
    try {
      if ((await this.historyStore.info()).kind !== 'indexeddb') return;
      if (!(await storage.persisted?.())) await storage.persist();
    } catch {
      // Not granted or not supported: the data is still stored, only not protected.
    }
    this.refreshHistoryInfo();
  }

  /**
   * Desktop app: the window close destroys the webview, and a write started on 'pagehide' may not
   * reach the bridge any more. Write the buffered readings first (at most CLOSE_FLUSH_MS), then let
   * the window close. Tauri closes the window after the handler (`core:window:allow-destroy`).
   */
  #flushOnClose() {
    const win = /** @type {any} */ (typeof window !== 'undefined' ? window : {}).__TAURI__?.window?.getCurrentWindow?.();
    if (typeof win?.onCloseRequested !== 'function') return;
    Promise.resolve(
      win.onCloseRequested(async () => {
        const wait = new Promise((resolve) => setTimeout(resolve, CLOSE_FLUSH_MS));
        await Promise.race([this.recorder.flush().catch(() => {}), wait]);
      }),
    ).catch((/** @type {unknown} */ err) => this.log.warn(`History: no flush on close (${err instanceof Error ? err.message : String(err)})`));
  }

  /** Read where the history is stored (shown in Charts and Preferences). */
  async refreshHistoryInfo() {
    try {
      /** @type {import('@ubms/ui/timeseries').SeriesStoreInfo} */
      let info = await this.historyStore.info();
      const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
      if (info.kind === 'indexeddb' && storage?.persisted) info = { ...info, persisted: await storage.persisted().catch(() => false) };
      this.store.set({ historyInfo: info });
    } catch {
      this.store.set({ historyInfo: { kind: 'memory', persistent: false } });
    }
  }

  async init() {
    this.refreshHistoryInfo();
    await this.refreshAvailability();
    // Bluetooth can be switched on while the app is open. Check again when the browser or the
    // desktop bridge (provider.onAvailabilityChange, ble://adapter) reports a change, and when the
    // window gets the focus back (not every browser sends availabilitychanged).
    const bt = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : {}).bluetooth;
    bt?.addEventListener?.('availabilitychanged', () => this.refreshAvailability());
    const ble = /** @type {any} */ (this.providers.ble);
    Promise.resolve(ble.onAvailabilityChange?.(() => this.refreshAvailability())).catch(() => {});
    if (typeof window !== 'undefined') window.addEventListener('focus', () => this.refreshAvailability());
  }

  /** Check again whether Bluetooth and serial ports can be used. */
  async refreshAvailability() {
    const seq = ++this.availabilitySeq;
    const [ble, serial] = await Promise.all([this.providers.ble.availability(), this.providers.serial.availability()]);
    if (seq !== this.availabilitySeq) return; // a newer check is running
    const availability = { ble, serial };
    if (JSON.stringify(availability) !== JSON.stringify(this.state.availability)) this.store.set({ availability });
  }

  #wireSession() {
    const s = this.session;
    s.on('state', ({ state, error }) => {
      /** @type {Partial<AppState>} */
      const patch = { state, error: error ? error.message : null };
      if (state === 'connected') {
        const def = /** @type {any} */ (s.definition);
        patch.detect = null;
        patch.device = {
          driverId: def.id,
          vendor: def.vendor,
          protocol: def.protocol,
          variant: s.variant,
          deviceName: s.link?.name ?? '',
          linkKind: s.link?.kind ?? '',
          deviceType: def.deviceType,
        };
        this.#rememberDevice();
      }
      if (state === 'idle' || state === 'error' || state === 'connecting') {
        patch.detect = null;
        // 'connecting' starts a new connection, also straight from the error state: the data of
        // the previous device must not be shown (or written back) as data of the new one.
        if (state === 'idle' || state === 'connecting') {
          patch.device = null;
          patch.snapshot = null;
          patch.info = null;
          patch.settings = { schema: null, values: null, loading: false, error: null };
        }
      }
      this.store.set(patch);
      this.#updateWakeLock();
    });
    s.on('detect', (d) => this.store.set({ detect: d }));
    s.on('snapshot', (snap) => this.store.set((st) => ({ snapshot: snap, historyRev: st.historyRev + 1 })));
    s.on('info', (info) => this.store.set({ info: { ...info } }));
    s.on('settings', (settings) => this.store.set({ settings: { ...settings } }));
    s.on('variant', (variant) => this.store.set((st) => ({ device: st.device ? { ...st.device, variant } : st.device })));
  }

  /**
   * @template {keyof Prefs} K
   * @param {K} key
   * @param {Prefs[K]} value
   */
  setPref(key, value) {
    const prefs = { ...this.state.prefs, [key]: value };
    if (key === 'transport' && !selectionFits(this.registry, prefs)) prefs.selection = 'auto';
    this.storage.set('prefs', prefs);
    this.store.set({ prefs });
    if (key === 'lang') i18n.setLocale(/** @type {string} */ (value));
    if (key === 'theme') applyTheme(/** @type {any} */ (value));
    if (key === 'pollMs') this.session.setPollInterval(/** @type {number} */ (value));
    if (key === 'logCapacity') this.log.capacity = /** @type {number} */ (value);
    if (key === 'keepAwake') this.#updateWakeLock();
  }

  resetPrefs() {
    // The language stays: keep it stored too, or the next start picks the browser language again.
    const prefs = { ...DEFAULT_PREFS, lang: this.state.prefs.lang, demoDriver: defaultDemoDriver() };
    this.storage.set('prefs', prefs);
    this.store.set({ prefs });
    applyTheme(prefs.theme);
    this.session.setPollInterval(prefs.pollMs);
    this.log.capacity = prefs.logCapacity;
    this.#updateWakeLock();
  }

  /**
   * Desktop plugins are loaded and their drivers registered (apps/web/src/plugins.js): keep the
   * report for the Plugins view, and bring back a saved demo or device type choice that names a
   * plugin driver. The constructor dropped it while only the built-in drivers were known; the
   * saved preferences still have it.
   * @param {import('./plugins.js').PluginReport} report
   */
  setPlugins(report) {
    const saved = /** @type {Partial<Prefs>} */ (this.storage.get('prefs', {}));
    const prefs = { ...this.state.prefs };
    if (saved.demoDriver && /** @type {any} */ (this.registry.get(saved.demoDriver))?.demo) prefs.demoDriver = saved.demoDriver;
    if (saved.selection && selectionFits(this.registry, { ...prefs, selection: saved.selection })) prefs.selection = saved.selection;
    this.store.set({ plugins: { loaded: true, ...report }, prefs });
  }

  /** Is the current selection filterable in the Bluetooth chooser? */
  bleFilterInfo() {
    const { selection, showAllBle } = this.state.prefs;
    return this.registry.bleRequest({ selection, showAll: showAllBle });
  }

  async connectBle() {
    const { selection } = this.state.prefs;
    const { request } = this.bleFilterInfo();
    let device;
    try {
      device = await /** @type {WebBluetoothProvider} */ (this.providers.ble).request(request);
    } catch (err) {
      if (/** @type {any} */ (err)?.name === 'NotFoundError') return; // chooser cancelled
      throw err;
    }
    await this.#connect({ kind: 'ble', handle: device, selection });
  }

  async connectSerial() {
    const { selection, adaptersOnly } = this.state.prefs;
    let port;
    try {
      port = await /** @type {WebSerialProvider} */ (this.providers.serial).request({ adaptersOnly });
    } catch (err) {
      if (/** @type {any} */ (err)?.name === 'NotFoundError') return;
      throw err;
    }
    await this.#connect({ kind: 'serial', handle: port, selection, options: this.#serialOptions() });
  }

  /** RS485 device address or board number from the Connect screen; empty for the protocol default. */
  #serialOptions() {
    const address = Number.parseInt(this.state.prefs.serialAddress, 10);
    return Number.isFinite(address) ? { address, board: address } : {};
  }

  /** True when Bluetooth devices are found by an in-app scan (desktop app) instead of a browser chooser. */
  get nativeBle() {
    return !!(/** @type {any} */ (this.providers.ble).capabilities?.scan);
  }

  /** True when serial ports are listed by the app (desktop app) instead of a browser chooser. */
  get nativeSerial() {
    return !!(/** @type {any} */ (this.providers.serial).capabilities?.list);
  }

  /** Start an in-app Bluetooth scan (desktop app). Results go to `state.scan.devices`. */
  async startBleScan() {
    await this.stopBleScan();
    // Every start and stop counts up: results, errors and the timer of an older scan are ignored.
    const seq = ++this.scanSeq;
    const { selection, showAllBle } = this.state.prefs;
    const defs = this.registry.select(selection, 'ble');
    const filters = showAllBle
      ? {}
      : {
          namePrefixes: [...new Set(defs.flatMap((d) => d.links.ble?.namePrefixes ?? []))],
          services: [...new Set(defs.flatMap((d) => d.links.ble?.advertisedServices ?? []))],
          manufacturerIds: [...new Set(defs.flatMap((d) => d.links.ble?.manufacturerIds ?? []))],
        };
    this.store.set({ scan: { active: true, devices: [] } });
    const provider = /** @type {any} */ (this.providers.ble);
    try {
      const stop = await provider.scan({ ...filters, timeoutMs: 20000 }, (/** @type {ScannedDevice} */ d) => {
        if (seq !== this.scanSeq) return;
        const devices = [...this.state.scan.devices];
        const i = devices.findIndex((x) => x.id === d.id);
        const entry = { id: d.id, name: d.name || t('Unnamed device'), rssi: d.rssi, services: d.services };
        if (i >= 0) devices[i] = { ...devices[i], ...entry };
        else devices.push(entry);
        this.store.set({ scan: { active: this.state.scan.active, devices } });
      });
      if (seq !== this.scanSeq) {
        // Stopped (or restarted) while the scan was starting. After a restart the provider's stop
        // only removes this scan's listener, so it cannot end the newer scan.
        await stop().catch(() => {});
        return;
      }
      this.stopScanFn = stop;
      // This scan's own timer; stopBleScan() clears it, so it never stops a later scan.
      this.scanTimer = setTimeout(() => {
        if (seq === this.scanSeq) this.stopBleScan();
      }, 20000);
    } catch (err) {
      if (seq !== this.scanSeq) return;
      this.store.set({ scan: { active: false, devices: this.state.scan.devices } });
      toast(t(err instanceof Error ? err.message : String(err)), { tone: 'danger' });
    }
  }

  async stopBleScan() {
    this.scanSeq = (this.scanSeq ?? 0) + 1;
    clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    const stop = this.stopScanFn;
    this.stopScanFn = null;
    if (stop) await stop().catch(() => {});
    if (this.state.scan.active) this.store.set({ scan: { active: false, devices: this.state.scan.devices } });
  }

  /**
   * @param {ScannedDevice} device
   * @param {string} [selection] driver choice; Recent devices pass the driver they were used with
   */
  async connectScannedDevice(device, selection = this.state.prefs.selection) {
    await this.stopBleScan();
    const handle = /** @type {any} */ (this.providers.ble).get(device);
    await this.#connect({ kind: 'ble', handle, selection });
  }

  /** @param {RecentDevice} recent */
  async #connectRecentByScan(recent) {
    const showAll = this.state.prefs.showAllBle;
    if (!showAll) this.setPref('showAllBle', true);
    await this.startBleScan();
    if (!showAll) this.setPref('showAllBle', false);
    if (!this.stopScanFn) return; // the scan did not start; startBleScan() told the user why
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && this.state.scan.active) {
      const found = this.state.scan.devices.find((d) => d.id === recent.id);
      // Like the browser path: the remembered driver, not the type selected right now.
      if (found) return this.connectScannedDevice(found, recent.driverId ?? 'auto');
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!this.state.scan.active) return; // stopped by the user or replaced by another scan
    await this.stopBleScan();
    toast(t('{name} was not found. Wake the BMS up and scan again.', { name: recent.name }), { tone: 'warn' });
  }

  /** Refresh the serial port list (desktop app). */
  async listSerialPorts() {
    // An older, slower refresh must not replace the result of a newer one.
    const seq = (this.portsSeq ?? 0) + 1;
    this.portsSeq = seq;
    this.store.set({ ports: { loading: true, list: this.state.ports.list } });
    try {
      const ports = await /** @type {any} */ (this.providers.serial).list();
      if (seq !== this.portsSeq) return;
      this.serialHandles = ports;
      this.store.set({ ports: { loading: false, list: ports.map((/** @type {any} */ p) => ({ ...p.info })) } });
    } catch (err) {
      if (seq !== this.portsSeq) return;
      this.store.set({ ports: { loading: false, list: [] } });
      toast(t(err instanceof Error ? err.message : String(err)), { tone: 'danger' });
    }
  }

  /**
   * @param {{ path: string }} port
   * @param {string} [selection] driver choice; Recent devices pass the driver they were used with
   */
  async connectSerialPort(port, selection = this.state.prefs.selection) {
    const handle = (this.serialHandles ?? []).find((/** @type {any} */ h) => h.info.path === port.path);
    if (!handle) return;
    const address = Number.parseInt(this.state.prefs.serialAddress, 10);
    const options = Number.isFinite(address) ? { address, board: address } : {};
    await this.#connect({ kind: 'serial', handle, selection, options });
  }

  /** @param {RecentDevice} recent */
  async connectRecent(recent) {
    // Desktop app: no browser permissions; find the device by a short scan or the port list.
    if (recent.kind === 'ble' && this.nativeBle) return this.#connectRecentByScan(recent);
    if (recent.kind === 'serial' && this.nativeSerial) {
      await this.listSerialPorts();
      if (this.state.ports.list.some((p) => p.path === recent.id)) {
        return this.connectSerialPort({ path: recent.id }, recent.driverId ?? 'auto');
      }
      toast(t('The port {name} is not available. Check the adapter and pick a port from the list.', { name: recent.name }), { tone: 'warn' });
      return;
    }
    const provider = recent.kind === 'ble' ? this.providers.ble : this.providers.serial;
    const known = await provider.known();
    const handle = known.find((h) => h.id === recent.id);
    if (!handle) {
      toast(t('The browser needs your permission again. Pick the device in the list.'), { tone: 'info' });
      if (recent.kind === 'ble') return this.connectBle();
      return this.connectSerial();
    }
    await this.#connect({ kind: recent.kind, handle, selection: recent.driverId ?? 'auto' });
  }

  /** @param {string} [driverId] */
  async connectDemo(driverId = this.state.prefs.demoDriver) {
    const def = this.registry.get(driverId);
    if (!def?.demo) throw new Error(`No demo for ${driverId}`);
    const { host, device } = createLinkPair({
      log: this.log,
      name: def.demo.name,
      kind: 'demo',
      latencyMs: 15,
      deviceChunkSize: def.demo.chunkSize ?? 0,
    });
    await device.open();
    const sim = def.demo.create(device);
    const stop = () => {
      sim.stop?.();
      device.close();
    };
    this.stopDemo = stop;
    host.once('close', () => {
      // Stop this demo only: a demo started while this one was connected owns stopDemo by now.
      stop();
      if (this.stopDemo === stop) this.stopDemo = null;
    });
    await this.#connect({ kind: 'link', link: host, selection: def.id });
  }

  /** @param {import('@ubms/bms-core/session').ConnectTarget} target */
  async #connect(target) {
    // Granted ports (Recent devices) come without options: use the RS485 address of the Connect
    // screen, like the port chooser does.
    if (target.kind === 'serial' && !target.options) target = { ...target, options: this.#serialOptions() };
    try {
      await this.session.connect(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/** @type {any} */ (err)?.code !== 'cancelled') toast(t(message), { tone: 'danger', timeout: 7000 });
    }
  }

  async cancel() {
    await this.session.disconnect();
  }

  async disconnect() {
    await this.session.disconnect();
  }

  async reconnect() {
    try {
      await this.session.reconnect();
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'cancelled') toast(t(err instanceof Error ? err.message : String(err)), { tone: 'danger' });
    }
  }

  #rememberDevice() {
    const target = this.session.target;
    if (!target || (target.kind !== 'ble' && target.kind !== 'serial')) return;
    const handle = target.handle;
    // A Web Serial port without a stable id (no USB ids, or two adapters with the same ids) gets
    // an id that is valid for this page only: such an entry would never work after a reload.
    if (target.kind === 'serial' && /** @type {any} */ (handle).unique === false) return;
    /** @type {RecentDevice} */
    const entry = { id: handle.id, name: handle.name, kind: target.kind, driverId: this.session.definition?.id, at: Date.now() };
    const recent = [entry, ...this.state.recent.filter((r) => !(r.id === entry.id && r.kind === entry.kind))].slice(0, 8);
    this.storage.set('recent', recent);
    this.store.set({ recent });
  }

  /** @param {RecentDevice} r */
  forgetRecent(r) {
    const recent = this.state.recent.filter((x) => !(x.id === r.id && x.kind === r.kind));
    this.storage.set('recent', recent);
    this.store.set({ recent });
  }

  async #updateWakeLock() {
    const want = this.state.prefs.keepAwake && this.state.state === 'connected' && document.visibilityState === 'visible';
    const wl = /** @type {any} */ (navigator).wakeLock;
    try {
      if (want && !this.wakeLock && wl) {
        this.wakeLock = await wl.request('screen');
        this.wakeLock.addEventListener?.('release', () => (this.wakeLock = null));
      } else if (!want && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {
      this.wakeLock = null;
    }
  }

  // ---------- settings ----------

  async loadSettings() {
    try {
      await this.session.loadSettings();
      const err = this.session.settings.error;
      if (err) toast(t('Could not read settings: {error}', { error: t(err) }), { tone: 'danger' });
    } catch (err) {
      toast(t(err instanceof Error ? err.message : String(err)), { tone: 'danger' });
    }
  }

  /**
   * @param {Array<{ id: string, value: any }>} changes
   * @param {{ reload?: boolean, quiet?: boolean }} [opts]
   */
  async writeSettings(changes, { reload = true, quiet = false } = {}) {
    /** @type {import('@ubms/bms-core/session').WriteResult[]} */
    let results;
    try {
      results = await this.session.writeSettings(changes, { reload });
    } catch (err) {
      // No driver any more (the link dropped while the confirmation was open): nothing was written.
      const error = err instanceof Error ? err.message : String(err);
      toast(t(error), { tone: 'danger' });
      return changes.map((c) => ({ id: c.id, ok: false, error }));
    }
    const failed = results.filter((r) => !r.ok);
    const unverified = results.filter((r) => r.ok && r.verified === false);
    // Accepted, but the values could not be read back: the device has not confirmed them.
    const unread = results.filter((r) => r.ok && r.readBackError);
    if (failed.length) {
      toast(
        t('{count} setting(s) failed: {list}', { count: failed.length, list: failed.map((r) => `${r.id} (${t(r.error ?? '', r.errorParams)})`).join(', ') }),
        {
          tone: 'danger',
          timeout: 9000,
        },
      );
    } else if (unverified.length) {
      toast(t('Written, but the device reports a different value for: {list}', { list: unverified.map((r) => r.id).join(', ') }), { tone: 'warn', timeout: 9000 });
    } else if (unread.length) {
      toast(t('Written, but the settings could not be read back: {error}', { error: t(unread[0].readBackError ?? '') }), { tone: 'warn', timeout: 9000 });
    } else if (!quiet) {
      toast(t('{count} setting(s) written', { count: results.length }), { tone: 'ok' });
    }
    return results;
  }

  /** @param {string} id @param {any} [arg] */
  async runAction(id, arg) {
    try {
      await this.session.runAction(id, arg);
      toast(t('Done'), { tone: 'ok' });
    } catch (err) {
      toast(t(err instanceof Error ? err.message : String(err)), { tone: 'danger' });
    }
  }

  /** Export the current settings to a JSON file. */
  exportSettings() {
    const { settings, device, info } = this.state;
    if (!settings.values || !device) return;
    const data = {
      format: 'ubms-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      driver: device.driverId,
      protocol: device.protocol,
      variant: device.variant,
      device: info,
      values: withoutSecrets(settings.schema, settings.values),
    };
    const name = `${(info?.name || device.deviceName || device.driverId).replace(/[^\w.-]+/g, '_')}-settings-${new Date().toISOString().slice(0, 10)}.json`;
    downloadFile(name, JSON.stringify(data, null, 2));
  }

  /**
   * Compare a settings export with the current values. Returns writable changes.
   * @param {string} text
   */
  parseSettingsImport(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (data?.format !== 'ubms-settings') throw new Error(msg('Not a ubms settings file'));
    const { settings, device } = this.state;
    const fields = fieldMap(settings.schema);
    /** @type {Array<{ id: string, value: any, from: any }>} */
    const changes = [];
    const skipped = [];
    for (const [id, raw] of Object.entries(data.values ?? {})) {
      const f = fields.get(id);
      if (!f || f.readOnly || f.type === 'action') {
        skipped.push(id);
        continue;
      }
      // coerce() reads form input: it turns anything unknown into Off and null into ''. A value of
      // the file that is not of the field's kind is skipped instead of becoming a change.
      const value = importable(f, raw) ? coerce(f, raw) : undefined;
      if (value === undefined) {
        skipped.push(id);
        continue;
      }
      const current = settings.values?.[id];
      if (current !== undefined && String(current) === String(value)) continue;
      changes.push({ id, value, from: current });
    }
    return { changes, skipped, sameDriver: data.driver === device?.driverId };
  }

  exportLog({ includeDecoded = true } = {}) {
    const { device, info, snapshot, settings } = this.state;
    const data = this.log.export({
      includeDecoded,
      meta: {
        app: 'ubms',
        version: __APP_VERSION__,
        revision: __APP_REVISION__,
        commit: __APP_COMMIT__,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        device,
        info,
        snapshot,
        settings: withoutSecrets(settings.schema, settings.values),
      },
    });
    downloadFile(`ubms-log-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`, JSON.stringify(data, null, 1));
  }

  exportLogText() {
    const entries = this.log.entries();
    const t0 = entries[0]?.t;
    const text = entries.map((e) => ProtocolLog.formatLine(e, t0)).join('\n');
    downloadFile(`ubms-log-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`, text, 'text/plain');
  }
}
