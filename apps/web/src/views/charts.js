import { html, css, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { UiElement, define, sharedStyles, StoreController, icon, t, i18n, toast, confirmDialog, downloadFile, toCsv, estimateInterval } from '@ubms/ui';
import { UNNAMED_DEVICE, availableSeries, historyGroups, msg } from '@ubms/bms-core';
import { LIVE_WINDOW_MS, mergeRecords } from '../history/recorder.js';
import { num } from '../format.js';

/**
 * English errors of the history store of the UI kit (packages/ui/src/timeseries.js), which knows
 * no msg(): listed here so they reach the catalogs, and translated where they are shown.
 */
export const STORAGE_ERRORS = [msg('IndexedDB is not available'), msg('The history database is blocked by another tab'), msg('Transaction aborted')];

/**
 * Charts of the recorded readings: the connected device live (the window follows the clock) and
 * every device with stored history. One chart card per group of values, all sharing the time
 * axis and a synchronized crosshair. Exports the range as CSV and the visible charts as PNG.
 *
 * @typedef {import('@ubms/bms-core/history').HistoryRecord} HistoryRecord
 * @typedef {import('@ubms/bms-core/history').HistorySeries} HistorySeries
 * @typedef {import('@ubms/bms-core/history').HistoryDeviceMeta} HistoryDeviceMeta
 * @typedef {{ t: number, v: number }} Point
 *
 * @typedef {Object} Source a device the charts can show
 * @property {string} id 'live' or 'stored:<key>'
 * @property {'live'|'stored'} kind
 * @property {string | null} key
 * @property {import('@ubms/ui/timeseries').SeriesStore} store
 * @property {Partial<HistoryDeviceMeta> | null} meta
 * @property {string} name
 * @property {number} [last] time of the last record (desktop files: last change of the file)
 * @property {number} [count] stored records (browser storage)
 * @property {number} [bytes] size of the data file (desktop)
 * @property {boolean} [demo]
 * @property {boolean} [missing] the chosen stored device has no stored history (the device that
 *   was just disconnected, when nothing of it was written)
 *
 * @typedef {Object} ChartData records of one source and range, prepared for the charts
 * @property {string} sourceId
 * @property {string} range
 * @property {number} liveId recording the data belongs to (live source)
 * @property {number} epoch tail epoch of that recording (live source)
 * @property {HistoryRecord[]} records sorted, all records read
 * @property {Partial<HistoryDeviceMeta> | null} meta
 * @property {HistorySeries[]} series every series with data
 * @property {Map<string, Point[]>} points chart points per series id
 * @property {number} interval typical time between records, ms
 * @property {number} version changes whenever points were added
 */

const MINUTE = 60000;

/** Ranges of the segmented control; ms 0 means everything stored. */
export const CHART_RANGES = [
  { id: '5m', ms: 5 * MINUTE },
  { id: '10m', ms: 10 * MINUTE },
  { id: '15m', ms: 15 * MINUTE },
  { id: '30m', ms: 30 * MINUTE },
  { id: '1h', ms: 60 * MINUTE },
  { id: '2h', ms: 120 * MINUTE },
  { id: 'all', ms: 0 },
  // From and to chosen by the user (prefs chartFrom, chartTo); a fixed window, never moving.
  { id: 'custom', ms: 0, custom: true },
];

/** Value of an <input type="datetime-local"> for epoch ms, in local time. @param {number} ms */
export function toLocalInput(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Epoch ms of an <input type="datetime-local"> value (local time); NaN when empty or invalid. @param {string} v */
export function fromLocalInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v ?? ''));
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}

/**
 * Above this many records the points are aggregated (first, lowest, highest and last value per
 * time slot) while they are built, so a week of records does not become millions of objects.
 */
const AGGREGATE_ABOVE = 20000;
const AGGREGATE_SLOTS = 4000;

/** Colors of single series and of the cell summary; per-cell and sensor series use the palette. */
/** @type {Record<string, string>} */
const COLORS = {
  voltage: 'var(--ui-primary)',
  current: 'var(--ui-info)',
  power: 'var(--ui-discharge)',
  soc: 'var(--ui-ok)',
  cellMin: 'var(--ui-info)',
  cellMax: 'var(--ui-danger)',
  cellAvg: 'var(--ui-primary)',
  cellDelta: 'var(--ui-warn)',
  balanceCurrent: 'var(--ui-warn)',
  capacity: 'var(--ui-ok)',
};

/** Groups whose y axis always includes zero (signed values). */
const ZERO_GROUPS = new Set(['current', 'power', 'balance']);

/**
 * Index of the first record with t >= time.
 * @param {Array<{ t: number }>} arr sorted
 * @param {number} time
 */
function lowerBound(arr, time) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].t < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Chart points of history series. With `slots` > 0 and more records than four per slot, keeps per
 * time slot only the first, lowest, highest and last value (the chart downsamples the same way,
 * so the picture is the same).
 * @param {HistoryRecord[]} records sorted by time
 * @param {HistorySeries[]} series
 * @param {number} [slots]
 * @returns {Map<string, Point[]>}
 */
export function seriesPoints(records, series, slots = 0) {
  /** @type {Map<string, Point[]>} */
  const out = new Map(series.map((s) => [s.id, /** @type {Point[]} */ ([])]));
  const n = records.length;
  if (!n) return out;
  if (!slots || n <= slots * 4) {
    for (const r of records) {
      for (const s of series) {
        const v = s.pick(r);
        if (v !== undefined) /** @type {Point[]} */ (out.get(s.id)).push({ t: r.t, v });
      }
    }
    return out;
  }
  const from = records[0].t;
  const span = Math.max(1, records[n - 1].t - from);
  for (const s of series) {
    const pts = /** @type {Point[]} */ (out.get(s.id));
    let slot = -1;
    let ft = 0;
    let fv = 0;
    let lot = 0;
    let lov = 0;
    let hit = 0;
    let hiv = 0;
    let lt = 0;
    let lv = 0;
    const flush = () => {
      if (slot < 0) return;
      const four = [
        { t: ft, v: fv },
        { t: lot, v: lov },
        { t: hit, v: hiv },
        { t: lt, v: lv },
      ].sort((a, b) => a.t - b.t);
      let prev = NaN;
      for (const p of four) {
        if (p.t !== prev) pts.push(p);
        prev = p.t;
      }
    };
    for (let i = 0; i < n; i++) {
      const r = records[i];
      const v = s.pick(r);
      if (v === undefined) continue;
      const k = Math.min(slots - 1, Math.floor(((r.t - from) / span) * slots));
      if (k !== slot) {
        flush();
        slot = k;
        ft = lot = hit = lt = r.t;
        fv = lov = hiv = lv = v;
        continue;
      }
      lt = r.t;
      lv = v;
      if (v < lov) {
        lot = r.t;
        lov = v;
      }
      if (v > hiv) {
        hit = r.t;
        hiv = v;
      }
    }
    flush();
  }
  return out;
}

/**
 * Local time in ISO 8601 with the UTC offset, for example 2026-11-19T14:05:09+02:00.
 * @param {number} time epoch ms
 */
export function isoLocal(time) {
  const d = new Date(time);
  const p = (/** @type {number} */ v) => String(v).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${offset >= 0 ? '+' : '-'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/** @param {number} bytes */
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let k = 0;
  let v = bytes;
  while (v >= 1024 && k < units.length - 1) {
    v /= 1024;
    k++;
  }
  return `${num(v, k ? 1 : 0)} ${units[k]}`;
}

/**
 * Display form of a stored device name: the core's fallback name is English and translated here.
 * @param {string | undefined} name
 */
const shownName = (name) => (name === UNNAMED_DEVICE ? t(UNNAMED_DEVICE) : name ?? '');

/** @param {string} s */
const fileStem = (s) => s.replace(/[\s<>:"/\\|?*\u0000-\u001f\u007f]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 80) || 'device';

/** Range label: localized short durations ("5 min", "1 h") without translation keys. */
/** @param {{ id: string, ms: number }} r */
function rangeLabel(r) {
  if (/** @type {any} */ (r).custom) return t('Period');
  if (!r.ms) return t('All');
  const minutes = r.ms / MINUTE;
  const hours = minutes >= 60 && minutes % 60 === 0;
  try {
    return new Intl.NumberFormat(i18n.locale, { style: 'unit', unit: hours ? 'hour' : 'minute', unitDisplay: 'short' }).format(hours ? minutes / 60 : minutes);
  } catch {
    return hours ? `${minutes / 60} h` : `${minutes} min`;
  }
}

export class ViewCharts extends UiElement {
  static properties = {
    rangeError: { state: true },
    ctrl: { attribute: false },
    selected: { state: true },
    devices: { state: true },
    listed: { state: true },
    listing: { state: true },
    clearing: { state: true },
    gutter: { state: true },
    data: { state: true },
    loading: { state: true },
    cursor: { state: true },
    now: { state: true },
    error: { state: true },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
      .top {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 10px;
        margin-bottom: 10px;
      }
      .device {
        flex: 1 1 260px;
        max-width: 440px;
        min-width: 0;
        min-height: 40px;
      }
      .range {
        flex: 1 1 300px;
        max-width: 500px;
        display: flex;
        gap: 2px;
        padding: 3px;
        border-radius: var(--ui-radius-sm);
        background: var(--ui-surface-2);
        border: 1px solid var(--ui-border);
      }
      .range button {
        /* Width by content plus an equal share: long labels ("10 Min.") fit on phones. */
        flex: 1 1 auto;
        min-width: 0;
        min-height: 34px;
        padding: 0 4px;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: var(--ui-text-muted);
        font-size: 0.82rem;
        font-weight: 650;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
      }
      .range button[aria-pressed='true'] {
        background: var(--ui-surface);
        color: var(--ui-text);
        box-shadow: var(--ui-shadow);
      }
      .range button:focus-visible,
      .chips button:focus-visible {
        outline: 2px solid var(--ui-primary);
        outline-offset: 1px;
      }
      .actions {
        display: flex;
        gap: 6px;
        margin-left: auto;
      }
      .period {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 8px 12px;
        margin-bottom: 12px;
      }
      .period label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1 1 180px;
        max-width: 260px;
        font-size: 0.78rem;
        color: var(--ui-text-muted);
      }
      .period .input {
        min-height: 36px;
      }
      .period-error {
        flex-basis: 100%;
        font-size: 0.82rem;
        color: var(--ui-danger);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        margin-bottom: 12px;
      }
      .chips button {
        appearance: none;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 32px;
        padding: 0 12px;
        border-radius: 999px;
        border: 1px solid var(--ui-border);
        background: var(--ui-surface);
        color: var(--ui-text-muted);
        font: 600 0.8rem var(--ui-font);
        cursor: pointer;
      }
      .chips button[aria-pressed='true'] {
        background: var(--ui-primary-soft);
        border-color: var(--ui-primary);
        color: var(--ui-primary);
      }
      .stack {
        display: grid;
        gap: 12px;
      }
      .card.chart {
        padding: 10px 12px 10px;
        min-width: 0;
      }
      .card.chart h2 {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 8px;
        min-height: 30px;
        font-size: 0.95rem;
        margin: 0 2px 4px;
      }
      .card.chart h2 .name {
        flex: 1;
        min-width: 0;
      }
      .card.chart h2 .now {
        font-variant-numeric: tabular-nums;
        color: var(--ui-text-muted);
        font-size: 0.85rem;
        font-weight: 650;
      }
      .mini {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border-radius: 8px;
        background: var(--ui-surface-2);
        border: 1px solid var(--ui-border);
      }
      .mini button {
        min-height: 28px;
        padding: 0 10px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--ui-text-muted);
        font: 600 0.78rem var(--ui-font);
        white-space: nowrap;
        cursor: pointer;
      }
      .mini button[aria-pressed='true'] {
        background: var(--ui-surface);
        color: var(--ui-text);
        box-shadow: var(--ui-shadow);
      }
      .mini button:focus-visible {
        outline: 2px solid var(--ui-primary);
        outline-offset: 1px;
      }
      .foot {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 12px;
        margin-top: 14px;
        font-size: 0.82rem;
        color: var(--ui-text-muted);
      }
      .foot .where {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .foot .where svg {
        flex: none;
      }
      .loading {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .note {
        margin-bottom: 12px;
        padding: 8px 12px;
        border-radius: var(--ui-radius-sm);
        background: var(--ui-warn-soft);
        color: var(--ui-warn);
        font-size: 0.86rem;
        display: flex;
        gap: 8px;
        align-items: center;
      }
      @media (max-width: 560px) {
        .device,
        .range {
          flex-basis: 100%;
          max-width: none;
        }
        .actions {
          margin-left: 0;
          width: 100%;
        }
        .actions .btn {
          flex: 1;
          padding: 0 8px;
        }
        .actions .btn.icon {
          flex: none;
        }
      }
    `,
  ];

  constructor() {
    super();
    /** @type {import('../controller.js').AppController} */
    this.ctrl = /** @type {any} */ (null);
    /** Chosen source id; '' follows the connected device or the newest stored one. */
    this.selected = '';
    /** @type {import('@ubms/ui/timeseries').SeriesKeyInfo[]} */
    this.devices = [];
    /** @type {ChartData | null} */
    this.data = null;
    this.loading = false;
    /** @type {number | null} */
    this.cursor = null;
    this.now = Date.now();
    /** @type {string | null} */
    this.error = null;
    this.loadSeq = 0;
    this.listSeq = 0;
    /** The stored device list was read at least once. */
    this.listed = false;
    /** The stored device list is being read. */
    this.listing = false;
    /** A history is being deleted. */
    this.clearing = false;
    /** Width left of every plot for the y labels: the widest any card needs, so time axes line up. */
    this.gutter = 0;
    /** Key and name of the device disconnected last (named when nothing of it was stored). */
    this.gone = { key: '', name: '' };
    /** @type {{ key: string, cards: any[] } | null} */
    this.cardCache = null;
    this.rangeError = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this.sc = new StoreController(this, this.ctrl.store, (s) => ({
      range: s.prefs.chartRange,
      from: s.prefs.chartFrom,
      to: s.prefs.chartTo,
      hidden: s.prefs.chartHidden,
      cells: s.prefs.chartCells,
      enabled: s.prefs.historyEnabled,
      info: s.historyInfo,
      recId: s.recording?.id ?? 0,
      recKey: s.recording?.key ?? null,
      recError: s.recording?.error ?? null,
      device: s.device,
      deviceInfo: s.info,
    }));
    this.unsub = this.ctrl.store.subscribe((s, prev) => this.#onStore(s, prev));
    this.timer = setInterval(() => {
      if (this.#isLiveWindow()) this.now = Date.now();
    }, 1000);
    if (!this.ctrl.state.historyInfo) this.ctrl.refreshHistoryInfo();
    this.#refresh();
  }

  disconnectedCallback() {
    this.unsub?.();
    clearInterval(this.timer);
    this.loadSeq++;
    super.disconnectedCallback();
  }

  /** Reload the device list, then the data. */
  async #refresh() {
    const list = this.#loadList();
    // The connected device does not need the list; a stored one is found in it.
    if (!this.ctrl.recorder?.live || this.selected.startsWith('stored:')) await list;
    await this.#load();
  }

  async #loadList() {
    const seq = ++this.listSeq;
    this.listing = true;
    try {
      const list = await this.ctrl.historyStore.list();
      if (seq === this.listSeq) this.devices = list;
    } catch (err) {
      if (seq === this.listSeq) {
        this.devices = [];
        this.error = err instanceof Error ? err.message : String(err);
      }
    }
    if (seq === this.listSeq) {
      this.listed = true;
      this.listing = false;
    }
  }

  /**
   * @param {import('../controller.js').AppState} s
   * @param {import('../controller.js').AppState} prev
   */
  #onStore(s, prev) {
    const rec = s.recording;
    const old = prev.recording;
    const custom = s.prefs.chartRange === 'custom';
    if (s.prefs.chartRange !== prev.prefs.chartRange || (custom && (s.prefs.chartFrom !== prev.prefs.chartFrom || s.prefs.chartTo !== prev.prefs.chartTo))) {
      this.#load();
      return;
    }
    if ((rec?.id ?? 0) !== (old?.id ?? 0)) {
      // A device connected: show it live. A device disconnected: keep showing it, now from the
      // store (a demo session is gone with the connection).
      if (rec) this.selected = '';
      else if (old && (this.selected === 'live' || this.selected === '')) {
        this.selected = old.key && !old.demo ? `stored:${old.key}` : '';
        this.gone = { key: old.key ?? '', name: old.name };
      }
      this.cursor = null;
      this.#refresh();
      return;
    }
    if (!rec || !old) return;
    if (rec.key !== old.key) {
      // The key became known: the stored entry of this device is now the live one.
      this.#loadList();
    }
    const src = this.#current();
    if (src?.kind !== 'live') return;
    const live = this.ctrl.recorder.live;
    const d = this.data;
    if (!live || !d || d.sourceId !== 'live' || d.liveId !== live.id || d.epoch !== live.epoch) {
      if (!this.loading || rec.epoch !== old.epoch) this.#load();
      return;
    }
    if (rec.rev !== old.rev) this.#appendLive(live);
  }

  /** @returns {Source[]} */
  #sources() {
    const live = this.ctrl.recorder?.live;
    const st = this.ctrl.state;
    /** @type {Source[]} */
    const out = [];
    if (live) {
      out.push({
        id: 'live',
        kind: 'live',
        key: live.key,
        store: live.store,
        meta: live.meta,
        name: shownName(live.meta?.name) || st.info?.name || st.device?.deviceName || t('Connected device'),
        demo: live.demo,
      });
    }
    const names = new Map();
    for (const d of this.devices) {
      const n = shownName(d.meta?.name) || d.key;
      names.set(n, (names.get(n) ?? 0) + 1);
    }
    for (const d of this.devices) {
      if (live && !live.demo && d.key === live.key) continue;
      const base = shownName(d.meta?.name) || d.key;
      const sn = d.meta?.serialNumber;
      const address = d.meta?.address;
      // Devices with the same name: the serial number, else the bus address tells them apart.
      const tag = sn ? ` (${sn})` : Number.isInteger(address) ? ` (#${address})` : '';
      out.push({
        id: `stored:${d.key}`,
        kind: 'stored',
        key: d.key,
        store: this.ctrl.historyStore,
        meta: d.meta,
        name: names.get(base) > 1 ? `${base}${tag}` : base,
        last: d.last ?? d.modified,
        count: d.count,
        bytes: d.bytes,
      });
    }
    return out;
  }

  /** @returns {Source | null} */
  #current() {
    const all = this.#sources();
    const found = all.find((s) => s.id === this.selected);
    if (found) return found;
    // The device that was just disconnected and has nothing stored (history off, or nothing was
    // written yet): say so, instead of showing the charts of another battery.
    if (this.selected.startsWith('stored:') && (this.listed || this.listing)) {
      const key = this.selected.slice('stored:'.length);
      return {
        id: this.selected,
        kind: 'stored',
        key,
        store: this.ctrl.historyStore,
        meta: null,
        name: (key === this.gone.key && shownName(this.gone.name)) || key,
        missing: true,
      };
    }
    return all[0] ?? null;
  }

  /** The stored entry of the connected device (size of its history). */
  #liveEntry() {
    const key = this.ctrl.recorder?.live?.key;
    return key ? this.devices.find((d) => d.key === key) : undefined;
  }

  #range() {
    const id = this.ctrl.state.prefs.chartRange;
    return CHART_RANGES.find((r) => r.id === id) ?? CHART_RANGES[2];
  }

  /** The window moves with the clock: a live source and a fixed range. */
  #isLiveWindow() {
    return this.data?.sourceId === 'live' && !this.#custom();
  }

  /** The chosen custom window, or null when another range is selected or it is not set. */
  #custom() {
    const p = this.ctrl.state.prefs;
    if (p.chartRange !== 'custom') return null;
    const from = Number(p.chartFrom);
    const to = Number(p.chartTo);
    return Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > from ? { from, to } : null;
  }

  /**
   * Select a range. 'Period' starts with the window shown now (or the last two hours), so the
   * from and to fields open with sensible values.
   * @param {{ id: string, ms: number, custom?: boolean }} r
   */
  #pickRange(r) {
    if (r.custom && !this.#custom()) {
      const { from, to } = this.#window();
      const end = Number.isFinite(to) ? to : Date.now();
      const start = Number.isFinite(from) && from < end ? from : end - 120 * MINUTE;
      this.ctrl.setPref('chartFrom', Math.floor(start / MINUTE) * MINUTE);
      this.ctrl.setPref('chartTo', Math.ceil(end / MINUTE) * MINUTE);
    }
    this.ctrl.setPref('chartRange', r.id);
  }

  /** @param {'from'|'to'} which @param {Event} e */
  #setBound(which, e) {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const ms = fromLocalInput(input.value);
    const p = this.ctrl.state.prefs;
    const from = which === 'from' ? ms : Number(p.chartFrom);
    const to = which === 'to' ? ms : Number(p.chartTo);
    if (!Number.isFinite(ms) || !(to > from)) {
      this.rangeError = t('The start must be before the end');
      return;
    }
    this.rangeError = '';
    this.ctrl.setPref(which === 'from' ? 'chartFrom' : 'chartTo', ms);
  }

  /** From and to fields of the custom range. */
  #customBar() {
    if (this.#range().id !== 'custom') return nothing;
    const p = this.ctrl.state.prefs;
    return html`<div class="period">
      <label>
        <span>${t('From')}</span>
        <input class="input" type="datetime-local" .value=${toLocalInput(Number(p.chartFrom))} @change=${(/** @type {Event} */ e) => this.#setBound('from', e)} />
      </label>
      <label>
        <span>${t('To')}</span>
        <input class="input" type="datetime-local" .value=${toLocalInput(Number(p.chartTo))} @change=${(/** @type {Event} */ e) => this.#setBound('to', e)} />
      </label>
      ${this.rangeError ? html`<span class="period-error" role="alert">${this.rangeError}</span>` : nothing}
    </div>`;
  }

  async #load() {
    const seq = ++this.loadSeq;
    const src = this.#current();
    const range = this.#range();
    this.cardCache = null;
    if (!src || src.missing) {
      this.data = null;
      this.loading = false;
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      /** @type {HistoryRecord[]} */
      let records;
      let liveId = 0;
      let epoch = 0;
      const custom = this.#custom();
      if (range.custom && !custom) {
        records = [];
      } else if (custom) {
        // A fixed window: the store, plus the readings of the connection not written yet.
        const live = src.kind === 'live' ? this.ctrl.recorder.live : null;
        const key = src.kind === 'live' ? live?.key : src.key;
        const stored = key ? /** @type {HistoryRecord[]} */ (await (live?.store ?? src.store).read(key, custom)) : [];
        if (seq !== this.loadSeq) return;
        const tail = (live?.tail ?? []).filter((r) => r.t >= custom.from && r.t <= custom.to);
        records = live ? mergeRecords(stored, tail) : stored;
        liveId = live?.id ?? 0;
        epoch = live?.epoch ?? 0;
      } else if (src.kind === 'live') {
        const first = this.ctrl.recorder.live;
        if (!range.ms && first?.key) {
          // Everything stored plus what the recorder has not written yet.
          const stored = /** @type {HistoryRecord[]} */ (await first.store.read(first.key, {}));
          if (seq !== this.loadSeq) return;
          const live = this.ctrl.recorder.live;
          records = live && live.id === first.id ? mergeRecords(stored, live.tail) : stored;
        } else {
          const tail = first?.tail ?? [];
          records = range.ms ? tail.slice(lowerBound(tail, Date.now() - Math.min(range.ms, LIVE_WINDOW_MS))) : tail.slice();
        }
        const live = this.ctrl.recorder.live;
        liveId = live?.id ?? 0;
        epoch = live?.epoch ?? 0;
      } else {
        const anchor = src.last ?? Date.now();
        records = /** @type {HistoryRecord[]} */ (await src.store.read(/** @type {string} */ (src.key), range.ms ? { from: anchor - range.ms - MINUTE } : {}));
        if (seq !== this.loadSeq) return;
      }
      const meta = src.kind === 'live' ? this.ctrl.recorder.live?.meta ?? null : src.meta;
      this.data = this.#build(src.id, range.id, records, meta, liveId, epoch);
      this.now = Date.now();
    } catch (err) {
      if (seq !== this.loadSeq) return;
      this.data = null;
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
  }

  /**
   * @param {string} sourceId
   * @param {string} range
   * @param {HistoryRecord[]} records
   * @param {Partial<HistoryDeviceMeta> | null} meta
   * @param {number} liveId
   * @param {number} epoch
   * @returns {ChartData}
   */
  #build(sourceId, range, records, meta, liveId, epoch) {
    const series = availableSeries(records, /** @type {any} */ (meta ?? {}));
    const points = seriesPoints(records, series, records.length > AGGREGATE_ABOVE ? AGGREGATE_SLOTS : 0);
    return { sourceId, range, liveId, epoch, records, meta, series, points, interval: estimateInterval(records), version: 1 };
  }

  /**
   * Add the records the recorder took since the data was built.
   * @param {import('../history/recorder.js').LiveHistory} live
   */
  #appendLive(live) {
    const d = this.data;
    if (!d) return;
    const lastT = d.records.at(-1)?.t ?? -Infinity;
    let i = live.tail.length;
    while (i > 0 && live.tail[i - 1].t > lastT) i--;
    const fresh = live.tail.slice(i);
    if (!fresh.length) return;
    // A value that was not there before (another cell count, a new sensor): build again.
    const known = new Set(d.series.map((s) => s.id));
    if (availableSeries(fresh, /** @type {any} */ (live.meta ?? {})).some((s) => !known.has(s.id))) {
      this.#load();
      return;
    }
    const range = this.#range();
    const custom = this.#custom();
    if (range.custom) {
      // A fixed window takes only the new readings inside it.
      if (!custom) return;
      const inside = fresh.filter((r) => r.t >= custom.from && r.t <= custom.to);
      if (!inside.length) return;
      fresh.splice(0, fresh.length, ...inside);
    }
    // Keep a fixed window from growing without end while the view stays open.
    if (range.ms && d.records.length && d.records[0].t < Date.now() - range.ms - Math.max(range.ms, 10 * MINUTE)) {
      this.#load();
      return;
    }
    for (const r of fresh) {
      d.records.push(r);
      for (const s of d.series) {
        const v = s.pick(r);
        if (v !== undefined) d.points.get(s.id)?.push({ t: r.t, v });
      }
    }
    if (live.meta) d.meta = live.meta;
    this.data = { ...d, version: d.version + 1 };
    this.cardCache = null;
  }

  /**
   * Time window of the charts. Every card gets the same window, also for 'All' (from the first
   * record), so the time axes line up whatever series a card shows. NaN when there is no data.
   */
  #window() {
    const d = this.data;
    const range = this.#range();
    if (!d) return { from: NaN, to: NaN };
    const first = d.records[0]?.t ?? NaN;
    if (range.custom) {
      const custom = this.#custom();
      return custom ? { from: custom.from, to: custom.to } : { from: NaN, to: NaN };
    }
    if (d.sourceId === 'live') {
      const to = Math.max(this.now, d.records.at(-1)?.t ?? 0);
      return { from: range.ms ? to - range.ms : first, to };
    }
    const last = d.records.at(-1)?.t ?? NaN;
    return { from: range.ms ? last - range.ms : first, to: last };
  }

  /** Index range [lo, hi) of the records inside the window. */
  #windowIndexes() {
    const d = this.data;
    if (!d) return { lo: 0, hi: 0 };
    const { from, to } = this.#window();
    const lo = Number.isFinite(from) ? lowerBound(d.records, from) : 0;
    const hi = Number.isFinite(to) ? lowerBound(d.records, to + 1) : d.records.length;
    return { lo, hi: Math.max(lo, hi) };
  }

  /** Records inside the window. */
  #recordsInWindow() {
    const { lo, hi } = this.#windowIndexes();
    return this.data ? this.data.records.slice(lo, hi) : [];
  }

  /** Chart cards of the visible groups (cached until data, choices or language change). */
  #cards() {
    const d = this.data;
    if (!d) return [];
    const { hidden, cells } = this.sc.value;
    const key = `${d.sourceId}|${d.range}|${d.version}|${(hidden ?? []).join(',')}|${cells}|${i18n.locale}`;
    if (this.cardCache?.key === key) return this.cardCache.cards;
    const off = new Set(hidden ?? []);
    const cards = [];
    for (const g of historyGroups(d.series)) {
      if (off.has(g.id)) continue;
      let list = d.series.filter((s) => s.group === g.id);
      if (g.id === 'cells') {
        const each = list.filter((s) => s.cell !== undefined);
        const summary = list.filter((s) => s.cell === undefined);
        list = cells === 'all' && each.length ? each : summary.length ? summary : each;
      }
      if (!list.length) continue;
      cards.push({
        group: g.id,
        title: t(g.label),
        unit: g.unit,
        series: list.map((s) => ({
          id: s.id,
          label: t(s.label, s.params),
          points: d.points.get(s.id) ?? [],
          color: COLORS[s.id],
          unit: s.unit,
          decimals: s.decimals,
        })),
      });
    }
    this.cardCache = { key, cards };
    return cards;
  }

  render() {
    const src = this.#current();
    const sources = src?.missing ? [src, ...this.#sources()] : this.#sources();
    if (!src && !this.listed) return html`<ui-empty icon="clock" heading=${t('Loading…')}></ui-empty>`;
    if (!src) {
      return html`<ui-empty icon="chart" heading=${t('No history yet')} text=${t('Connect a device: its readings are recorded here and kept between sessions.')}>
        <a slot="actions" class="btn primary" href="#/connect">${icon('link', { size: 18 })}${t('Connect')}</a>
      </ui-empty>`;
    }
    const range = this.#range();
    const d = this.data && this.data.sourceId === src.id ? this.data : null;
    const groups = new Set((d?.series ?? []).map((s) => s.group));
    const hidden = new Set(this.sc.value.hidden ?? []);
    const cards = d ? this.#cards() : [];
    return html`
      <div class="top">
        <select class="device" aria-label=${t('Device')} @change=${this.#pick}>
          ${sources.map(
            (s) => {
              const when = s.kind === 'live' ? t('Live') : s.last ? i18n.formatDate(s.last, { dateStyle: 'short', timeStyle: 'short' }) : '';
              return html`<option value=${s.id} .selected=${s.id === src.id}>${when ? `${s.name} · ${when}` : s.name}</option>`;
            },
          )}
        </select>
        <div class="range" role="group" aria-label=${t('Time range')}>
          ${CHART_RANGES.map(
            (r) => html`<button aria-pressed=${r.id === range.id ? 'true' : 'false'} @click=${() => this.#pickRange(r)}>${rangeLabel(r)}</button>`,
          )}
        </div>
        <div class="actions">
          <button class="btn small" ?disabled=${!d?.records.length} @click=${() => this.exportCsv()}>${icon('download', { size: 16 })}${t('Export CSV')}</button>
          <button class="btn small" ?disabled=${!cards.length || !d?.records.length} @click=${() => this.exportPng()}>${icon('chart', { size: 16 })}${t('Export PNG')}</button>
          <button class="btn small danger icon" ?disabled=${this.clearing || src.missing || (!src.key && src.kind !== 'live')} title=${t('Clear history')} aria-label=${t('Clear history')} @click=${this.#clear}>
            ${icon('trash', { size: 16 })}
          </button>
        </div>
      </div>
      ${this.#customBar()}
      ${groups.size
        ? html`<div class="chips" role="group" aria-label=${t('Values')}>
            ${historyGroups(d?.series ?? []).map(
              (g) => html`<button aria-pressed=${hidden.has(g.id) ? 'false' : 'true'} @click=${() => this.#toggleGroup(g.id)}>${t(g.label)}</button>`,
            )}
          </div>`
        : nothing}
      ${this.#notes(src)}
      ${this.#body(src, d, cards)}
      ${this.#foot(src, d)}
    `;
  }

  /** @param {Source} src */
  #notes(src) {
    const err = this.error ?? (src.kind === 'live' ? this.sc.value.recError : null);
    if (err) return html`<div class="note">${icon('warning', { size: 18 })}<span>${t('History storage: {error}', { error: t(err) })}</span></div>`;
    if (src.kind === 'live' && !src.demo && !this.sc.value.enabled) {
      return html`<div class="note">${icon('info', { size: 18 })}<span>${t('Saving the history is off in Preferences: these charts show only the current connection.')}</span></div>`;
    }
    return nothing;
  }

  /**
   * @param {Source} src
   * @param {ChartData | null} d
   * @param {any[]} cards
   */
  #body(src, d, cards) {
    if (src.missing) {
      return this.listing
        ? html`<ui-empty icon="clock" heading=${t('Loading…')}></ui-empty>`
        : html`<ui-empty icon="chart" heading=${t('No history yet')} text=${t('No readings of {name} were saved.', { name: src.name })}></ui-empty>`;
    }
    if (!d) {
      return this.loading
        ? html`<ui-empty icon="clock" heading=${t('Loading…')}></ui-empty>`
        : html`<ui-empty icon="chart" heading=${t('No data')}></ui-empty>`;
    }
    if (!d.records.length) {
      return src.kind === 'live'
        ? html`<ui-empty icon="clock" heading=${t('Waiting for data…')} text=${t('The first readings usually arrive within a few seconds.')}></ui-empty>`
        : html`<ui-empty icon="chart" heading=${t('No readings in this time range')} text=${t('Pick a longer range.')}></ui-empty>`;
    }
    if (!cards.length) return html`<ui-empty icon="chart" heading=${t('Pick at least one value above.')}></ui-empty>`;
    const { from, to } = this.#window();
    const hasEach = d.series.some((s) => s.cell !== undefined);
    const mode = this.sc.value.cells === 'all' ? 'all' : 'summary';
    // Keyed by group: each card keeps its own chart element (and the series hidden in its legend)
    // when other cards come and go.
    return html`<div class="stack" @chart-cursor=${this.#onCursor} @chart-gutter=${this.#onGutter}>
      ${repeat(cards, (c) => c.group, (c) => {
        const latest = c.series.length === 1 && src.kind === 'live' ? c.series[0].points.at(-1) : undefined;
        return html`<section class="card chart">
          <h2>
            <span class="name">${c.title}</span>
            ${latest ? html`<span class="now">${num(latest.v, c.series[0].decimals)} ${c.unit}</span>` : nothing}
            ${c.group === 'cells' && hasEach
              ? html`<span class="mini" role="group" aria-label=${t('Cell voltages')}>
                  <button aria-pressed=${mode === 'summary' ? 'true' : 'false'} @click=${() => this.ctrl.setPref('chartCells', 'summary')}>${t('Min, max, average')}</button>
                  <button aria-pressed=${mode === 'all' ? 'true' : 'false'} @click=${() => this.ctrl.setPref('chartCells', 'all')}>${t('Every cell')}</button>
                </span>`
              : nothing}
          </h2>
          <ui-chart
            .series=${c.series}
            .from=${from}
            .to=${to}
            .unit=${c.unit}
            .interval=${d.interval}
            .zero=${ZERO_GROUPS.has(c.group)}
            .height=${c.series.length > 6 ? 250 : 190}
            .cursor=${this.cursor}
            .gutter=${this.gutter}
            .label=${`${c.title} (${c.unit})`}
            .emptyText=${t('No readings in this time range')}
          ></ui-chart>
        </section>`;
      })}
    </div>`;
  }

  /**
   * @param {Source} src
   * @param {ChartData | null} d
   */
  #foot(src, d) {
    const info = this.sc.value.info;
    /** @type {any[]} */
    const parts = [];
    if (src.demo) {
      parts.push(html`<span class="where">${icon('info', { size: 15 })}${t('Demo sessions are kept in memory only.')}</span>`);
    } else if (info?.kind === 'file') {
      parts.push(
        html`<span class="where">${icon('save', { size: 15 })}<span>${t('Saved in {dir}', { dir: info.dir ?? '' })}</span></span>
          <span class="chip">${info.portable ? t('Portable') : t('User profile')}</span>`,
      );
    } else if (info?.kind === 'indexeddb') {
      parts.push(html`<span class="where">${icon('save', { size: 15 })}${t('Browser storage on this device')}</span>`);
      if (info.persisted === false) parts.push(html`<span>${t('The browser may delete it when storage space runs low.')}</span>`);
    } else if (info) {
      parts.push(html`<span class="where">${icon('warning', { size: 15 })}${t('This browser cannot store the history: it is lost when the page closes.')}</span>`);
    }
    const entry = src.kind === 'live' ? this.#liveEntry() : this.devices.find((x) => x.key === src.key);
    if (!src.demo && entry?.count !== undefined) parts.push(html`<span>${t('{count} records stored', { count: entry.count })}</span>`);
    else if (!src.demo && entry?.bytes !== undefined) parts.push(html`<span>${t('{size} stored', { size: formatBytes(entry.bytes) })}</span>`);
    if (d?.records.length) {
      const { lo, hi } = this.#windowIndexes();
      parts.push(html`<span>${t('{count} records in view', { count: hi - lo })}</span>`);
    }
    if (this.loading) parts.push(html`<span class="loading">${icon('clock', { size: 15 })}${t('Loading…')}</span>`);
    if (this.clearing) parts.push(html`<span class="loading">${icon('trash', { size: 15 })}${t('Deleting…')}</span>`);
    return html`<div class="foot">${parts}</div>`;
  }

  /** @param {Event} e */
  #pick = (e) => {
    this.selected = /** @type {HTMLSelectElement} */ (e.target).value;
    this.cursor = null;
    this.#load();
  };

  /** @param {CustomEvent} e */
  #onCursor = (e) => {
    this.cursor = e.detail?.time ?? null;
  };

  /** A chart's y labels need another width: share the widest with every card. */
  #onGutter = () => this.#updateGutter();

  #updateGutter() {
    const charts = /** @type {any[]} */ ([...(this.renderRoot?.querySelectorAll('ui-chart') ?? [])]);
    const gutter = charts.reduce((max, c) => Math.max(max, Number(c.labelWidth?.()) || 0), 0);
    if (gutter !== this.gutter) this.gutter = gutter;
  }

  /** @param {Map<string, unknown>} changed */
  updated(changed) {
    super.updated?.(changed);
    // A card was removed (a value switched off, another device): the widest may be narrower now.
    if (!changed.has('gutter')) this.#updateGutter();
  }

  /** @param {string} id */
  #toggleGroup(id) {
    const hidden = new Set(this.ctrl.state.prefs.chartHidden ?? []);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    this.ctrl.setPref('chartHidden', [...hidden]);
  }

  #clear = async () => {
    const src = this.#current();
    if (!src) return;
    const ok = await confirmDialog({
      title: t('Clear the history of {name}?', { name: src.name }),
      message: t('All stored readings of this device are deleted. This cannot be undone.'),
      confirmLabel: t('Clear history'),
      danger: true,
    });
    if (!ok) return;
    // Deleting a week of records takes seconds in browser storage.
    this.clearing = true;
    try {
      // Drop the unwritten readings before the removal is queued: a flush during the removal then
      // writes only readings taken after it, behind it in the store's queue.
      if (src.kind === 'live') this.ctrl.recorder.clearLive();
      if (src.key) await src.store.remove(src.key);
      toast(t('History cleared'), { tone: 'ok' });
    } catch (err) {
      toast(t('History storage: {error}', { error: t(err instanceof Error ? err.message : String(err)) }), { tone: 'danger' });
    } finally {
      this.clearing = false;
    }
    if (src.kind === 'stored') this.selected = '';
    await this.#refresh();
  };

  /* ---------- export (also used by the smoke test) ---------- */

  /** Name of the current source for file names and the image header (already translated). */
  #title() {
    return this.#current()?.name || 'ubms';
  }

  /**
   * CSV of the records in the window: time (ISO 8601 with offset), unix ms, then every series with
   * data, each cell and each temperature by its label.
   */
  buildCsv() {
    const records = this.#recordsInWindow();
    const series = availableSeries(records, /** @type {any} */ (this.data?.meta ?? {}));
    const header = [t('Time'), t('Unix time (ms)'), ...series.map((s) => `${t(s.label, s.params)} (${s.unit})`)];
    function* rows() {
      for (const r of records) yield [isoLocal(r.t), r.t, ...series.map((s) => s.pick(r))];
    }
    return toCsv(header, rows(), { bom: true });
  }

  /** @param {string} ext */
  #fileName(ext) {
    const stamp = isoLocal(Date.now()).slice(0, 16).replace(/[T:]/g, '-');
    return `${fileStem(this.#title())}-history-${stamp}.${ext}`;
  }

  exportCsv() {
    if (!this.data?.records.length) return Promise.resolve(null);
    return downloadFile(this.#fileName('csv'), this.buildCsv(), 'text/csv;charset=utf-8');
  }

  /**
   * The visible charts in one image: a header (device, range, export time) and each chart card.
   * @returns {Promise<Blob | null>}
   */
  async buildPng() {
    const charts = /** @type {any[]} */ ([...(this.renderRoot?.querySelectorAll('ui-chart') ?? [])]);
    if (!charts.length) return null;
    const colors = charts[0].colors();
    const W = 1200;
    const pad = 28;
    const headerH = 64;
    const titleH = 24;
    const gap = 22;
    const heights = charts.map((c) => ((c.series?.length ?? 0) > 6 ? 270 : 220));
    const H = pad + headerH + heights.reduce((sum, h) => sum + titleH + h + gap, 0) - gap + pad;
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(scale, scale);
    ctx.fillStyle = colors.surface;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = colors.text;
    ctx.font = `700 20px ${colors.font}`;
    ctx.fillText(this.#title(), pad, pad + 20);
    ctx.fillStyle = colors.muted;
    ctx.font = `13px ${colors.font}`;
    const { from, to } = this.#window();
    const recs = this.#recordsInWindow();
    const a = Number.isFinite(from) ? from : recs[0]?.t ?? Date.now();
    const b = Number.isFinite(to) ? to : recs.at(-1)?.t ?? Date.now();
    let span = '';
    try {
      span = /** @type {any} */ (new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' })).formatRange(a, b);
    } catch {
      span = `${i18n.formatDate(a)} / ${i18n.formatDate(b)}`;
    }
    ctx.fillText(`${rangeLabel(this.#range())}: ${span}   ·   ${t('Exported {time}', { time: i18n.formatDate(Date.now(), { dateStyle: 'medium', timeStyle: 'short' }) })}`, pad, pad + 44);
    let y = pad + headerH;
    // One y label width for every chart, so their time axes line up in the image as well.
    const gutter = charts.reduce((max, chart, i) => Math.max(max, chart.exportLabelWidth(ctx, W - 2 * pad, heights[i])), 0);
    charts.forEach((chart, i) => {
      ctx.fillStyle = colors.text;
      ctx.font = `600 14px ${colors.font}`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillText(chart.label ?? '', pad, y + 15);
      chart.drawTo(ctx, pad, y + titleH, W - 2 * pad, heights[i], { gutter });
      y += titleH + heights[i] + gap;
    });
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  }

  async exportPng() {
    const blob = await this.buildPng();
    if (!blob) return null;
    return downloadFile(this.#fileName('png'), blob, 'image/png');
  }
}
define('view-charts', ViewCharts);
