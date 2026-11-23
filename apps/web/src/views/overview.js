import { html, css, nothing } from 'lit';
import { UiElement, define, sharedStyles, StoreController, icon, t, confirmDialog } from '@ubms/ui';
import { fieldMap, msg } from '@ubms/bms-core';
import { num, autoDecimals, hoursDuration } from '../format.js';
import '../components/bms-widgets.js';

const SWITCHES = [
  { key: 'charge', id: 'switch.charge', label: msg('Charge'), icon: 'bolt' },
  { key: 'discharge', id: 'switch.discharge', label: msg('Discharge'), icon: 'power' },
  { key: 'balance', id: 'switch.balance', label: msg('Balancer'), icon: 'balance' },
  { key: 'heater', id: 'switch.heater', label: msg('Heater'), icon: 'flame' },
];

export class ViewOverview extends UiElement {
  static properties = {
    ctrl: { attribute: false },
    pending: { state: true },
    switching: { state: true },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
      .grid {
        display: grid;
        gap: 12px;
        grid-template-columns: 1fr;
      }
      @media (min-width: 720px) {
        .grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .span2 {
          grid-column: span 2;
        }
      }
      @media (min-width: 1180px) {
        .grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .span2 {
          grid-column: span 2;
        }
      }
      .card {
        padding: 14px 16px;
        min-width: 0;
      }
      .other-device {
        display: flex;
        justify-content: center;
        margin-top: 14px;
      }
      .other-device .btn {
        color: var(--ui-text-muted);
      }
      .card h2 {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }
      .card h2 a {
        margin-left: auto;
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--ui-primary);
        text-decoration: none;
      }
      .hero {
        display: flex;
        align-items: center;
        gap: 18px;
        flex-wrap: wrap;
      }
      .soc {
        font-size: 2.4rem;
        font-weight: 750;
        letter-spacing: -0.03em;
        font-variant-numeric: tabular-nums;
        line-height: 1;
      }
      .soc small {
        font-size: 1rem;
        color: var(--ui-text-muted);
      }
      .state {
        margin-top: 6px;
        font-size: 0.85rem;
        font-weight: 650;
      }
      .state.charging {
        color: var(--ui-charge);
      }
      .state.discharging {
        color: var(--ui-discharge);
      }
      .state.idle {
        color: var(--ui-text-muted);
      }
      .metrics {
        flex: 1;
        min-width: 220px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 8px;
      }
      .switches {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
        gap: 8px;
      }
      .sw {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: var(--ui-radius-sm);
        background: var(--ui-surface-2);
      }
      .sw .name {
        flex: 1;
        min-width: 0;
        font-weight: 600;
        font-size: 0.9rem;
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sw ui-switch {
        flex: none;
      }
      .state-dot {
        font-size: 0.78rem;
        font-weight: 700;
      }
      .on {
        color: var(--ui-ok);
      }
      .off {
        color: var(--ui-text-faint);
      }
      .cellsum {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
        margin-bottom: 12px;
      }
      .kv {
        font-size: 0.78rem;
        color: var(--ui-text-muted);
      }
      .kv b {
        display: block;
        font-size: 1rem;
        color: var(--ui-text);
        font-variant-numeric: tabular-nums;
      }
      .trend-label {
        display: flex;
        justify-content: space-between;
        font-size: 0.8rem;
        color: var(--ui-text-muted);
        margin: 4px 0 2px;
      }
      dl {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 6px 12px;
        margin: 0;
        font-size: 0.92rem;
      }
      dt {
        color: var(--ui-text-muted);
      }
      dd {
        margin: 0;
        text-align: right;
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .waiting {
        padding: 40px 0;
      }
    `,
  ];

  constructor() {
    super();
    /** @type {import('../controller.js').AppController} */
    this.ctrl = /** @type {any} */ (null);
    /** @type {Record<string, boolean>} */
    this.pending = {};
    this.switching = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.sc = new StoreController(this, this.ctrl.store, (s) => ({ snapshot: s.snapshot, rev: s.historyRev, device: s.device }));
  }

  render() {
    const s = this.sc.value.snapshot;
    if (!s) {
      return html`<ui-empty class="waiting" icon="clock" heading=${t('Waiting for data…')} text=${t('The first readings usually arrive within a few seconds.')}></ui-empty>`;
    }
    return html`<div class="grid">
        ${this.#hero(s)} ${this.#alarms(s)} ${this.#switches(s)} ${this.#cells(s)} ${this.#temps(s)} ${this.#battery(s)} ${this.#trend()}
        ${this.#extra(s)}
      </div>
      <div class="other-device">
        <button class="btn small ghost" ?disabled=${this.switching} @click=${this.#otherDevice}>${icon('link', { size: 16 })}${t('Connect another device')}</button>
      </div>`;
  }

  /** Disconnect and open the connect screen in one step (otherwise More, Disconnect). */
  #otherDevice = async () => {
    this.switching = true;
    try {
      await this.ctrl.disconnect();
    } finally {
      this.switching = false;
      location.hash = '#/connect';
    }
  };

  /** @param {import('@ubms/bms-core/model').BmsSnapshot} s */
  #hero(s) {
    const soc = s.soc;
    const tone = soc === undefined ? '' : soc <= 10 ? 'danger' : soc <= 25 ? 'warn' : 'ok';
    const stateLabel = s.state === 'charging' ? t('Charging') : s.state === 'discharging' ? t('Discharging') : t('Idle');
    const currentTone = s.state === 'charging' ? 'charge' : s.state === 'discharging' ? 'discharge' : '';
    return html`<section class="card span2">
      <div class="hero">
        ${soc !== undefined
          ? html`<ui-ring .value=${soc} tone=${tone} size="148" thickness="13">
              <div>
                <div class="soc">${num(soc, 0)}<small> %</small></div>
                <div class="state ${s.state ?? 'idle'}">${stateLabel}</div>
              </div>
            </ui-ring>`
          : nothing}
        <div class="metrics">
          <ui-stat label=${t('Voltage')} icon="battery" .value=${num(s.voltage, 2)} unit="V"></ui-stat>
          ${s.current != null
            ? html`<ui-stat label=${t('Current')} icon="current" .value=${num(s.current, 2, { signed: true })} unit="A" tone=${currentTone}></ui-stat>`
            : nothing}
          ${s.power != null
            ? html`<ui-stat label=${t('Power')} icon="bolt" .value=${num(s.power, autoDecimals(s.power, 1), { signed: true })} unit="W" tone=${currentTone}></ui-stat>`
            : nothing}
          ${s.capacityRemaining !== undefined
            ? html`<ui-stat
                label=${t('Remaining')}
                icon="gauge"
                .value=${num(s.capacityRemaining, 1)}
                unit="Ah"
                hint=${s.capacityFull ?? s.capacityNominal ? t('of {total} Ah', { total: num(s.capacityFull ?? s.capacityNominal, 1) }) : ''}
              ></ui-stat>`
            : s.cellStats
              ? html`<ui-stat label=${t('Cell difference')} icon="cells" .value=${num(s.cellStats.delta * 1000, 0)} unit="mV"></ui-stat>`
              : nothing}
        </div>
      </div>
    </section>`;
  }

  /** @param {import('@ubms/bms-core/model').BmsSnapshot} s */
  #alarms(s) {
    return html`<section class="card">
      <h2>${icon('warning', { size: 18 })}${t('Alarms')}</h2>
      <bms-alarm-list .alarms=${s.alarms ?? []}></bms-alarm-list>
    </section>`;
  }

  /** @param {import('@ubms/bms-core/model').BmsSnapshot} s */
  #switches(s) {
    const sw = s.switches ?? {};
    const present = SWITCHES.filter((x) => /** @type {any} */ (sw)[x.key] !== undefined);
    if (!present.length) return nothing;
    const driver = this.ctrl.session.driver;
    const writable = driver?.capabilities.writeSettings ? fieldMap(driver.getSettingsSchema()) : new Map();
    return html`<section class="card">
      <h2>${icon('power', { size: 18 })}${t('Switches')}</h2>
      <div class="switches">
        ${present.map((x) => {
          const on = !!(/** @type {any} */ (sw)[x.key]);
          const canWrite = writable.has(x.id) && !writable.get(x.id)?.readOnly;
          return html`<div class="sw">
            <span class="name">${icon(x.icon, { size: 16 })}${t(x.label)}</span>
            ${canWrite
              ? html`<ui-switch .checked=${on} .busy=${!!this.pending[x.id]} label=${t(x.label)} @change=${(/** @type {any} */ e) => this.#toggle(x, e.detail.checked)}></ui-switch>`
              : html`<span class="state-dot ${on ? 'on' : 'off'}">${on ? t('On') : t('Off')}</span>`}
          </div>`;
        })}
      </div>
      ${s.balancingActive !== undefined
        ? html`<div class="muted" style="margin-top:10px;font-size:.85rem">
            ${s.balancingActive ? t('Balancing now') : t('Not balancing')}${s.balanceCurrent !== undefined && s.balancingActive
              ? html` · ${num(s.balanceCurrent, 3, { signed: true })} A`
              : nothing}
          </div>`
        : nothing}
    </section>`;
  }

  /**
   * @param {{ id: string, label: string, key: string }} x
   * @param {boolean} value
   */
  async #toggle(x, value) {
    const mosfet = x.key === 'discharge' || x.key === 'charge';
    const driver = this.ctrl.session.driver;
    const f = driver ? fieldMap(driver.getSettingsSchema()).get(x.id) : undefined;
    // Charge and discharge are confirmed when they go off; other switches the driver marks as
    // dangerous (the NEEY balancer) both ways, like the Settings view does.
    if ((!value && mosfet) || (f?.danger && !mosfet)) {
      const ok = await confirmDialog({
        title: value ? t('Turn on {name}?', { name: t(x.label) }) : t('Turn off {name}?', { name: t(x.label) }),
        message: x.key === 'discharge' ? t('Connected loads will lose power.') : x.key === 'charge' ? t('The battery will stop accepting charge.') : f?.description ? t(f.description) : '',
        confirmLabel: value ? t('Turn on') : t('Turn off'),
        danger: true,
      });
      if (!ok) return;
    }
    this.pending = { ...this.pending, [x.id]: true };
    try {
      await this.ctrl.writeSettings([{ id: x.id, value }], { reload: false, quiet: true });
    } finally {
      setTimeout(() => (this.pending = { ...this.pending, [x.id]: false }), 1200);
    }
  }

  /** @param {import('@ubms/bms-core/model').BmsSnapshot} s */
  #cells(s) {
    const st = s.cellStats;
    if (!st) return nothing;
    return html`<section class="card">
      <h2>${icon('cells', { size: 18 })}${t('Cells')}<a href="#/cells">${t('Details')}</a></h2>
      <div class="cellsum">
        <div class="kv">${t('Min')}<b>${num(st.min, 3)}</b>#${st.minIndex + 1}</div>
        <div class="kv">${t('Max')}<b>${num(st.max, 3)}</b>#${st.maxIndex + 1}</div>
        <div class="kv">${t('Delta')}<b>${num(st.delta * 1000, 0)}</b>mV</div>
        <div class="kv">${t('Average')}<b>${num(st.avg, 3)}</b>V</div>
      </div>
      <bms-cell-bars .cells=${s.cells ?? []} .balancing=${s.balancing ?? []}></bms-cell-bars>
    </section>`;
  }

  /** @param {import('@ubms/bms-core/model').BmsSnapshot} s */
  #temps(s) {
    if (!s.temperatures?.length) return nothing;
    return html`<section class="card">
      <h2>${icon('thermometer', { size: 18 })}${t('Temperatures')}</h2>
      <bms-temp-list .temps=${s.temperatures}></bms-temp-list>
    </section>`;
  }

  /** @param {import('@ubms/bms-core/model').BmsSnapshot} s */
  #battery(s) {
    /** @type {Array<[string, string]>} */
    const rows = [];
    if (s.capacityFull !== undefined) rows.push([t('Full charge capacity'), `${num(s.capacityFull, 1)} Ah`]);
    if (s.capacityNominal !== undefined) rows.push([t('Nominal capacity'), `${num(s.capacityNominal, 1)} Ah`]);
    if (s.cycles !== undefined) rows.push([t('Cycles'), num(s.cycles, 0)]);
    if (s.cycleCapacity !== undefined) rows.push([t('Total cycled capacity'), `${num(s.cycleCapacity, 0)} Ah`]);
    if (s.soh !== undefined) rows.push([t('State of health'), `${num(s.soh, 0)} %`]);
    if (s.timeToEmpty !== undefined) rows.push([t('Time to empty'), hoursDuration(s.timeToEmpty)]);
    if (s.timeToFull !== undefined) rows.push([t('Time to full'), hoursDuration(s.timeToFull)]);
    if (!rows.length) return nothing;
    return html`<section class="card">
      <h2>${icon('battery', { size: 18 })}${t('Battery')}</h2>
      <dl>${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
    </section>`;
  }

  #trend() {
    const h = this.ctrl.session.history;
    const win = 10 * 60 * 1000;
    const current = h.series('current', win);
    const voltage = h.series('voltage', win);
    if (current.length < 3 && voltage.length < 3) return nothing;
    const last = current.at(-1)?.v ?? 0;
    return html`<section class="card">
      <h2>${icon('current', { size: 18 })}${t('Last 10 minutes')}<a href="#/charts">${t('Charts')}</a></h2>
      ${current.length > 2
        ? html`<div class="trend-label"><span>${t('Current')}</span><span>${num(Math.min(...current.map((p) => p.v)), 1)} / ${num(Math.max(...current.map((p) => p.v)), 1)} A</span></div>
            <ui-sparkline .points=${current} zero tone=${last > 0.15 ? 'charge' : last < -0.15 ? 'discharge' : ''}></ui-sparkline>`
        : nothing}
      ${voltage.length > 2
        ? html`<div class="trend-label"><span>${t('Voltage')}</span><span>${num(Math.min(...voltage.map((p) => p.v)), 2)} / ${num(Math.max(...voltage.map((p) => p.v)), 2)} V</span></div>
            <ui-sparkline .points=${voltage}></ui-sparkline>`
        : nothing}
    </section>`;
  }

  /** @param {import('@ubms/bms-core/model').BmsSnapshot} s */
  #extra(s) {
    const entries = Object.entries(s.extra ?? {});
    if (!entries.length) return nothing;
    return html`<section class="card">
      <h2>${icon('list', { size: 18 })}${t('More values')}</h2>
      <dl>
        ${entries.map(([, e]) => {
          const v = typeof e.value === 'number' ? num(e.value, e.decimals ?? 2) : typeof e.value === 'boolean' ? (e.value ? t('Yes') : t('No')) : t(String(e.value));
          return html`<dt>${t(e.label)}</dt><dd>${v}${e.unit ? ` ${e.unit}` : ''}</dd>`;
        })}
      </dl>
    </section>`;
  }
}
define('view-overview', ViewOverview);
