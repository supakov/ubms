import { BaseDriver, msg, alarm, fieldMap, SEVERITY_ORDER } from '@ubms/bms-core';
import { FrameChannel, sleep, equals, u16le } from '@ubms/transport';
import { alarmsFromBits } from '../common/util.js';
import {
  ABSENT_TEMPERATURE,
  ADDR,
  BALANCE_STATES,
  BALANCING_STATES,
  BATTERY_TYPES,
  CHARGE_MOS_STATES,
  CONTROL,
  CONTROL_NAMES,
  DEFAULT_PASSWORD_L1,
  DISCHARGE_MOS_STATES,
  OLD_BALANCE_STATES,
  OLD_CHARGE_MOS_STATES,
  OLD_DISCHARGE_MOS_STATES,
  OLD_HEADER,
  OLD_POWER_PLACEHOLDER,
  PROTECTION_BITS,
  RSP,
  SYSTEM_STATES,
  WARNING_BITS,
  createLegacyAssembler,
  createNewAssembler,
  describe,
  isOldRejection,
  isOldStatusFrame,
  isStatusFrame,
  newAuthRequest,
  newChipIdRequest,
  newControlRequest,
  newDeviceInfoRequest,
  newReadRequest,
  newStatusRequest,
  newWriteRequest,
  oldApplyCommand,
  oldPasswordFrames,
  oldReadRequest,
  oldStatusRequestBt,
  oldStatusRequestUart,
  oldWriteCommand,
  parseAuthResponse,
  parseControlResponse,
  parseDeviceInfo,
  parseOldCommand,
  parseOldStatus,
  parsePackId,
  parseRawResponse,
  parseReadResponse,
  parseStatus,
  parseWriteResponse,
  newWriteBytesRequest,
} from './protocol.js';
import {
  asciiToBytes,
  DEFAULT_PASSWORDS,
  NEW_SETTING_BLOCKS,
  buildAntLegacySchema,
  buildAntSchema,
  capacityUnit,
  createRegisterImage,
  decodeSettings,
  legacyValue,
  storeBlock,
  valueToRaw,
} from './settings.js';
import { createAntSimulator } from './simulator.js';

/**
 * ANT BMS drivers (docs/protocols/ant.md): `ant` speaks the 2021+ protocol (ANT_NEW), `ant-legacy`
 * the protocol of boards up to about 2020 (ANT_OLD). Both run on the same BLE profile (service
 * FFE0, characteristic FFE1 for writes and notifications) and on a 3.3 V TTL UART.
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').TemperatureReading} TemperatureReading
 * @typedef {import('@ubms/bms-core/model').AlarmState} AlarmState
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 * @typedef {import('./protocol.js').AntStatus} AntStatus
 * @typedef {import('./protocol.js').AntOldStatus} AntOldStatus
 */

export const ANT_VENDOR = 'ANT BMS';

/** Labels of the NTC probes (literal for the translation checker). */
const NTC_LABELS = [
  msg('Temperature 1'),
  msg('Temperature 2'),
  msg('Temperature 3'),
  msg('Temperature 4'),
  msg('Temperature 5'),
  msg('Temperature 6'),
  msg('Temperature 7'),
  msg('Temperature 8'),
];

/**
 * Negate a device value (ANT reports current and power positive while discharging) without
 * producing -0.
 * @param {number} v
 */
const flip = (v) => (v === 0 ? 0 : -v);

/**
 * Per cell flags of a bit mask (bit 0 = cell 1).
 * @param {number} mask
 * @param {number} count
 */
const maskBits = (mask, count) => Array.from({ length: count }, (_, i) => i < 32 && ((mask >>> i) & 1) === 1);

/**
 * Label of a code from a table, or the number itself for unknown codes.
 * @param {Record<number, string>} table
 * @param {number} code
 */
const codeLabel = (table, code) => table[code] ?? String(code);

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));

/** @param {import('@ubms/transport').Link} link */
const isSerialLink = (link) => /serial/.test(link?.kind ?? '');

/**
 * `alarmsFromBits` for a 64 bit mask stored as two u32 words; bit numbers in `table` are absolute.
 * @param {number} lo bits 0..31
 * @param {number} hi bits 32..63
 * @param {import('./protocol.js').AntAlarmBit[]} table
 * @param {string} prefix source prefix, for example 'protection bit'
 * @returns {AlarmState[]}
 */
function alarms64(lo, hi, table, prefix) {
  const low = table.filter((d) => d.bit < 32);
  const high = table.filter((d) => d.bit >= 32).map((d) => ({ ...d, bit: d.bit - 32 }));
  return [
    ...alarmsFromBits(lo, low, prefix),
    ...alarmsFromBits(hi, high, prefix).map((a) => ({ ...a, source: `${prefix} ${Number(String(a.source).slice(prefix.length + 1)) + 32}` })),
  ];
}

/**
 * Keep one alarm per id, the most severe one (a protection bit and its pre-warning bit often
 * fire together).
 * @param {AlarmState[]} alarms
 */
function mostSevere(alarms) {
  /** @type {Map<string, AlarmState>} */
  const best = new Map();
  const rank = (/** @type {AlarmState} */ a) => /** @type {Record<string, number>} */ (SEVERITY_ORDER)[a.severity ?? 'warning'] ?? 9;
  for (const a of alarms) {
    const prev = best.get(a.id);
    if (!prev || rank(a) < rank(prev)) best.set(a.id, a);
  }
  return [...best.values()];
}

/**
 * Unified snapshot from an ANT_NEW status (spec 6.1, 9).
 * @param {AntStatus} st
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function newStatusSnapshot(st) {
  /** @type {TemperatureReading[]} */
  const temperatures = [];
  st.temperatures.forEach((t, j) => {
    if (t !== ABSENT_TEMPERATURE) temperatures.push({ id: `t${j + 1}`, label: NTC_LABELS[j] ?? msg('Temperature'), value: t, kind: 'cell' });
  });
  temperatures.push({ id: 'mos', label: msg('MOSFET temperature'), value: st.mosTemperature, kind: 'mos' });
  temperatures.push({ id: 'balancer', label: msg('Balancer temperature'), value: st.balancerTemperature, kind: 'balancer' });

  /** @type {Record<string, ExtraValue>} */
  const extra = {
    systemState: { label: msg('System state'), value: codeLabel(SYSTEM_STATES, st.systemState) },
    chargeMos: { label: msg('Charge MOSFET'), value: codeLabel(CHARGE_MOS_STATES, st.chargeMosState) },
    dischargeMos: { label: msg('Discharge MOSFET'), value: codeLabel(DISCHARGE_MOS_STATES, st.dischargeMosState) },
    balancer: { label: msg('Balancer state'), value: codeLabel(BALANCE_STATES, st.balanceState) },
  };
  if (st.batteryType) extra.batteryType = { label: msg('Battery type'), value: codeLabel(BATTERY_TYPES, st.batteryType) };
  if (st.chargeTimeRemainingMin !== undefined) {
    extra.timeToFull = { label: msg('Time to full (BMS estimate)'), value: st.chargeTimeRemainingMin / 60, unit: 'h', decimals: 1 };
  }
  if (st.dischargeTimeRemainingMin !== undefined) {
    extra.timeToEmpty = { label: msg('Time to empty (BMS estimate)'), value: st.dischargeTimeRemainingMin / 60, unit: 'h', decimals: 1 };
  }
  // Totals: ESPHome scale (0.001 Ah) fits 2021 firmware; unverified on 2024 firmware (spec 6.1).
  extra.totalCharged = { label: msg('Total charged'), value: st.totalChargeAh, unit: 'Ah', decimals: 1 };
  extra.totalDischarged = { label: msg('Total discharged'), value: st.totalDischargeAh, unit: 'Ah', decimals: 1 };
  extra.totalChargeTime = { label: msg('Total charge time'), value: st.totalChargeTimeS / 3600, unit: 'h', decimals: 1 };
  extra.totalDischargeTime = { label: msg('Total discharge time'), value: st.totalDischargeTimeS / 3600, unit: 'h', decimals: 1 };
  extra.permission = { label: msg('Permission level'), value: st.permission, decimals: 0 };

  return {
    voltage: st.packVoltage,
    current: flip(st.current),
    power: flip(st.power),
    soc: st.soc,
    soh: st.soh,
    capacityRemaining: st.remainingAh,
    capacityFull: st.capacityAh,
    cycleCapacity: st.cycleAh,
    uptime: st.uptimeS,
    cells: st.cellVoltages,
    balancing: maskBits(st.balancingCellMask, st.cellCount),
    balancingActive: st.balancingCellMask !== 0 || BALANCING_STATES.includes(st.balanceState),
    temperatures,
    switches: {
      charge: st.chargeMosState === 1,
      discharge: st.dischargeMosState === 1,
      // Manual balance on shows state 4 in the capture, 5 is "manual balancing" in the 2024 app (spec 8).
      balance: st.balanceState === 4 || st.balanceState === 5,
    },
    alarms: mostSevere([
      ...alarms64(st.protectionMask0, st.protectionMask1, PROTECTION_BITS, 'protection bit'),
      ...alarms64(st.warningMask0, st.warningMask1, WARNING_BITS, 'warning bit'),
    ]),
    extra,
  };
}

/** Alarm ids implied by ANT_OLD charge MOSFET states (table 9.8). */
const OLD_CHARGE_ALARMS = /** @type {Record<number, [string, Partial<AlarmState>?]>} */ ({
  2: ['cell_overvoltage'],
  3: ['charge_overcurrent'],
  5: ['pack_overvoltage'],
  6: ['charge_overtemperature'],
  7: ['mos_overtemperature'],
  8: ['ant.abnormal_current', { severity: 'fault', label: msg('Abnormal current') }],
  9: ['cell_wire_open'],
  10: ['ant.board_overtemperature', { severity: 'protection', label: msg('Board overtemperature') }],
  13: ['discharge_mos_fault'],
  15: ['ant.charge_manual_off', { severity: 'warning', label: msg('Charge MOSFET switched off manually') }],
});

/** Alarm ids implied by ANT_OLD discharge MOSFET states (table 9.9). */
const OLD_DISCHARGE_ALARMS = /** @type {Record<number, [string, Partial<AlarmState>?]>} */ ({
  2: ['cell_undervoltage'],
  3: ['discharge_overcurrent'],
  5: ['pack_undervoltage'],
  6: ['discharge_overtemperature'],
  7: ['mos_overtemperature'],
  8: ['ant.abnormal_current', { severity: 'fault', label: msg('Abnormal current') }],
  9: ['cell_wire_open'],
  10: ['ant.board_overtemperature', { severity: 'protection', label: msg('Board overtemperature') }],
  12: ['short_circuit'],
  13: ['discharge_mos_fault'],
  14: ['ant.start_failure', { severity: 'fault', label: msg('Failed to switch on') }],
  15: ['ant.discharge_manual_off', { severity: 'warning', label: msg('Discharge MOSFET switched off manually') }],
});

/**
 * Which ANT_OLD NTC slots hold a probe (spec 6.8, 12.2 item 11). -40 marks an absent probe, but
 * 2020 boards fill absent slots with 0 and never send -40. So in a frame without -40, a 0 after
 * the last slot with another value is taken as absent (as batmon-ha does), unless that slot
 * reported another value earlier on this connection: a real probe at 0 degC stays visible. A
 * leading 0, or 0 in every slot, stays a real 0 degC.
 * @param {number[]} temps NTC 1..4
 * @param {Set<number>} seen slots that reported a value other than 0 and -40; updated in place
 * @returns {boolean[]}
 */
function oldProbesPresent(temps, seen) {
  let last = -1;
  temps.forEach((t, j) => {
    if (t !== 0 && t !== ABSENT_TEMPERATURE) {
      seen.add(j);
      last = j;
    }
  });
  const zeroFill = !temps.includes(ABSENT_TEMPERATURE);
  return temps.map((t, j) => t !== ABSENT_TEMPERATURE && !(zeroFill && t === 0 && last >= 0 && j > last && !seen.has(j)));
}

/**
 * Unified snapshot from an ANT_OLD status (spec 6.8). The old frame has no alarm bits; alarms
 * come from the documented reasons in the MOSFET state bytes.
 * @param {AntOldStatus} st
 * @param {Set<number>} [seenProbes] NTC slots (0 based) that reported a temperature other than 0
 *   and -40 on this connection; updated in place. Keeps a probe that reads 0 degC visible on 2020
 *   boards, which report absent probes as 0.
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function oldStatusSnapshot(st, seenProbes = new Set()) {
  /** @type {TemperatureReading[]} */
  const temperatures = [];
  const present = oldProbesPresent(st.temperatures, seenProbes);
  st.temperatures.forEach((t, j) => {
    if (present[j]) temperatures.push({ id: `t${j + 1}`, label: NTC_LABELS[j], value: t, kind: 'cell' });
  });
  temperatures.push({ id: 'mos', label: msg('MOSFET temperature'), value: st.mosTemperature, kind: 'mos' });
  temperatures.push({ id: 'balancer', label: msg('Balancer temperature'), value: st.balancerTemperature, kind: 'balancer' });
  /** @type {AlarmState[]} */
  const alarms = [];
  const c = OLD_CHARGE_ALARMS[st.chargeMosState];
  if (c) alarms.push(alarm(c[0], { ...c[1], source: `charge MOSFET state ${st.chargeMosState}` }));
  const d = OLD_DISCHARGE_ALARMS[st.dischargeMosState];
  if (d) alarms.push(alarm(d[0], { ...d[1], source: `discharge MOSFET state ${st.dischargeMosState}` }));
  return {
    voltage: st.packVoltage,
    current: flip(st.current),
    // 9999 is a placeholder on 2021 boards; leaving power out lets the core compute V x I.
    power: st.power === OLD_POWER_PLACEHOLDER ? undefined : flip(st.power),
    soc: st.soc,
    capacityRemaining: st.remainingAh,
    // Some 2020 boards report 0 (spec 12.2 item 17).
    capacityFull: st.capacityAh > 0 ? st.capacityAh : undefined,
    cycleCapacity: st.cycleAh,
    uptime: st.uptimeS,
    cells: st.cellVoltages,
    balancing: maskBits(st.balancingCellMask, st.cellCount),
    balancingActive: st.balancingCellMask !== 0 || [1, 2, 4].includes(st.balanceState),
    temperatures,
    switches: { charge: st.chargeMosState === 1, discharge: st.dischargeMosState === 1 },
    alarms: mostSevere(alarms),
    extra: {
      chargeMos: { label: msg('Charge MOSFET'), value: codeLabel(OLD_CHARGE_MOS_STATES, st.chargeMosState) },
      dischargeMos: { label: msg('Discharge MOSFET'), value: codeLabel(OLD_DISCHARGE_MOS_STATES, st.dischargeMosState) },
      balancer: { label: msg('Balancer state'), value: codeLabel(OLD_BALANCE_STATES, st.balanceState) },
    },
  };
}

/** MOSFET state "manually turned off" of both generations (spec 9.2, 9.3, 9.8, 9.9). */
const MOS_MANUAL_OFF = 15;

/**
 * Settings value of a charge or discharge switch (spec 8). The switch reads Off while its MOSFET
 * is off by command (state 15, or the "switched off manually" protection bit of ANT_NEW, which is
 * set even while a protection holds the MOSFET) or plainly off (state 0). While the BMS itself
 * holds the MOSFET off (a protection, battery full, waiting) the switch stays On: the BMS turns
 * the MOSFET back on by itself, an Off command must stay possible, and a settings backup must not
 * replay that state as an Off command. The snapshot keeps reporting the actual MOSFET state.
 * @param {number} state MOSFET state code
 * @param {boolean} [manualOffBit]
 */
const switchOn = (state, manualOffBit = false) => state !== 0 && state !== MOS_MANUAL_OFF && !manualOffBit;

/**
 * Switch values of the ANT_NEW settings form (manual off protection bits 17 and 21, spec 9.5).
 * @param {AntStatus} st
 */
export function newSwitchValues(st) {
  return {
    'switch.charge': switchOn(st.chargeMosState, ((st.protectionMask0 >>> 21) & 1) === 1),
    'switch.discharge': switchOn(st.dischargeMosState, ((st.protectionMask0 >>> 17) & 1) === 1),
    // Manual balance on shows state 4 in the capture, 5 is "manual balancing" in the 2024 app (spec 8).
    'switch.balance': st.balanceState === 4 || st.balanceState === 5,
  };
}

/**
 * Switch values of the ANT_OLD settings form.
 * @param {AntOldStatus} st
 */
export function oldSwitchValues(st) {
  return { 'switch.charge': switchOn(st.chargeMosState), 'switch.discharge': switchOn(st.dischargeMosState) };
}

/**
 * Check a password typed by the user: printable ASCII, length limits per generation.
 * @param {any} value
 * @param {'new'|'old'} generation
 */
function checkPassword(value, generation) {
  const s = String(value ?? '');
  if (!/^[\x20-\x7e]*$/.test(s)) throw new Error(msg('The password may contain only ASCII letters, digits and symbols'));
  if (generation === 'new' && (s.length < 1 || s.length > 12)) throw new Error(msg('The password must have 1 to 12 characters'));
  if (generation === 'old' && s.length !== 0 && s.length !== 8) throw new Error(msg('The password must have exactly 8 characters, or be empty'));
  return s;
}

// ---------------------------------------------------------------------------------------------
// ANT_NEW driver
// ---------------------------------------------------------------------------------------------

/**
 * Settings reads in a row in which a block failed while the BMS answered, after which the block
 * is skipped for `BLOCK_SKIP_READS` settings reads and then requested again. Reads in which the
 * BMS answered nothing at all (asleep, restarting, out of range) do not count.
 */
const BLOCK_FAILURE_LIMIT = 2;
/** Settings reads that leave out a block that failed `BLOCK_FAILURE_LIMIT` times. */
const BLOCK_SKIP_READS = 3;

/**
 * True when a parameter page is all 0xFF. One such page is a page that is not configured; when
 * every page is like that, the BMS did not grant read access (field log of an ANT-BLE20PHUB at
 * permission level 0, 2026-11-20).
 * @param {Uint8Array} data
 */
export function isBlankPage(data) {
  return data.length > 0 && data.every((b) => b === 0xff);
}

/**
 * True when the BMS did not let us read the parameters. The first block (cell voltage
 * protections, address 0) is configured on every working BMS, so a blank one means the page was
 * refused; without an answer for it, every answered page being blank says the same. An
 * ANT-BLE20PHUB at permission level 1 served the identity pages (pack id, versions) and still
 * sent every parameter page as 0xFF bytes (field log 2026-11-20, 12:19), so one readable page
 * proves nothing.
 * @param {{ answered: number, blank: number, blankAt: Set<number> }} pages
 */
export function parametersLocked(pages) {
  return pages.answered > 0 && (pages.blankAt.has(NEW_SETTING_BLOCKS[0].address) || pages.blank === pages.answered);
}

/** Password addresses below level 5 (8 character passwords). */
const LOW_LEVEL_PASSWORDS = [ADDR.PASSWORD_L1, ADDR.PASSWORD_L2, ADDR.PASSWORD_L3, ADDR.PASSWORD_L4];

/** @param {number} address password address @returns {number} permission level it belongs to */
const passwordLevel = (address) => (address === ADDR.PASSWORD_L5 ? 5 : LOW_LEVEL_PASSWORDS.indexOf(address) + 1);

export class AntDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.channel = new FrameChannel(ctx.link, { createAssembler: createNewAssembler, describe, log: ctx.log }).start();
    this.schema = buildAntSchema({ serial: isSerialLink(ctx.link) });
    this.fields = fieldMap(this.schema);
    /** Level 5 password; kept in the app (shared session options survive reconnects), never read from the device. */
    this.password = ctx.options?.antPassword ?? DEFAULT_PASSWORDS.new;
    /** @type {AntStatus | null} */
    this.status = null;
    /** Last buzzer command (the BMS does not report the buzzer state). @type {boolean | undefined} */
    this.buzzer = undefined;
    /** @type {Map<number, number>} settings block address to consecutive read failures */
    this.blockFailures = new Map();
    /** @type {Map<number, number>} settings block address to the settings reads that still skip it */
    this.blockSkips = new Map();
    /** Password of these settings with which no login unlocked the parameters (not tried again). @type {string | null} */
    this.unlockFailed = null;
    /** Password of these settings with which no login granted read access (not tried again). @type {string | null} */
    this.readAccessFailed = null;
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 1000, minPollIntervalMs: 500 };
  }

  getSettingsSchema() {
    return this.schema;
  }

  /**
   * Request with log names. Only call inside `this.channel.exclusive()`.
   * @param {Uint8Array} bytes
   * @param {(frame: Uint8Array) => boolean} match
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  #request(bytes, match, { timeout = 1000, retries = 1 } = {}) {
    const d = describe(bytes);
    return this.channel.requestUnqueued(bytes, { match, timeout, retries, name: d?.name, decode: d?.decode });
  }

  /** @param {{ timeout?: number, retries?: number }} [opts] */
  async #readStatus(opts = {}) {
    const frame = await this.#request(newStatusRequest(), isStatusFrame, { timeout: 1500, retries: 1, ...opts });
    const st = parseStatus(frame);
    this.status = st;
    return st;
  }

  /**
   * Read only probe (spec 11.2): status request, accept a CRC valid 0x11 frame with a consistent
   * layout, retry once because the first request is sometimes lost.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const attempt = Math.max(300, Math.min(1500, Math.floor(timeout / 2)));
    try {
      await this.channel.exclusive(() => this.#readStatus({ timeout: attempt, retries: 1 }));
      return { variant: 'ANT_NEW', confidence: 1, info: { vendor: ANT_VENDOR, protocol: this.definition.protocol } };
    } catch {
      return null;
    }
  }

  async poll() {
    const st = await this.channel.exclusive(() => this.#readStatus());
    this.publish(newStatusSnapshot(st));
  }

  /** Device info (0x026C), pack ID (262) and chip id (0x04); each part is optional. */
  async readInfo() {
    const info = await this.channel.exclusive(async () => {
      /** @type {DeviceInfo} */
      const out = { vendor: ANT_VENDOR, protocol: this.definition.protocol };
      // Without read access the version page comes back as 0xFF bytes (spec 4.3).
      await this.#ensureReadAccess(this.status);
      try {
        const f = await this.#request(newDeviceInfoRequest(), (fr) => fr[2] === RSP.READ && u16le(fr, 3) === ADDR.DEVICE_INFO, { retries: 2 });
        const d = parseDeviceInfo(f);
        if (d.hardwareVersion) {
          out.model = d.hardwareVersion;
          out.hardwareVersion = d.hardwareVersion;
        }
        if (d.softwareVersion) out.softwareVersion = d.softwareVersion;
      } catch (err) {
        this.log?.warn(`ANT device info: ${errorText(err)}`);
      }
      try {
        const f = await this.#request(newReadRequest(ADDR.PACK_ID, 32), (fr) => fr[2] === RSP.READ && u16le(fr, 3) === ADDR.PACK_ID, { retries: 1 });
        const id = parsePackId(f).packId;
        if (id) out.name = id;
      } catch (err) {
        this.log?.warn(`ANT battery ID: ${errorText(err)}`);
      }
      try {
        const f = await this.#request(newChipIdRequest(), (fr) => fr[2] === RSP.CHIP_ID, { timeout: 800, retries: 0 });
        out.extra = { chipId: { label: msg('Chip ID'), value: parseRawResponse(f).dataHex } };
      } catch {
        /* optional: not every firmware answers */
      }
      return out;
    });
    return this.publishInfo(info);
  }

  /**
   * Block reads of the parameter area (at most 64 bytes each, retried) and a fresh status for the
   * switch states and the capacity unit.
   */
  async readSettings() {
    return this.channel.exclusive(async () => {
      /** @type {AntStatus | null} */
      let status = null;
      try {
        status = await this.#readStatus({ timeout: 1000, retries: 1 });
      } catch (err) {
        this.log?.warn(`ANT status for settings: ${errorText(err)}`);
      }
      // A board at permission level 0 answers every parameter read with 0xFF bytes (field log of an
      // ANT-BLE20PHUB, 2026-11-20): log in first, as the vendor app does (spec 4.3).
      await this.#ensureReadAccess(status ?? this.status);
      /** @type {Set<number>} blocks this settings read leaves out */
      const skip = new Set();
      for (const [address, left] of this.blockSkips) {
        skip.add(address);
        if (left > 1) this.blockSkips.set(address, left - 1);
        else this.blockSkips.delete(address);
      }
      let pages = await this.#readSettingBlocks(skip, status !== null);
      // The permission byte does not tell whether the parameters can be read (level 1 was not
      // enough on a 20PHUB), so the pages decide: locked ones get the passwords, then a new read.
      if (parametersLocked(pages) && (await this.#unlockParameters())) pages = await this.#readSettingBlocks(skip, true);
      const { image, answered } = pages;
      if (!answered && !status) throw new Error(msg('The BMS did not answer the settings requests'));
      if (parametersLocked(pages)) {
        this.settingsNotice = msg(
          'The BMS answered with empty parameter pages: it did not grant read access. Enter the BMS password (the one of the ANT app) to read the settings.',
        );
        this.settingsPasswordField = 'ant.password';
      }
      const st = status ?? this.status;
      const values = decodeSettings(this.schema, image, { capacityUnit: capacityUnit(image, st?.capacityAh) });
      if (st) Object.assign(values, newSwitchValues(st));
      if (this.buzzer !== undefined) values['switch.buzzer'] = this.buzzer;
      // The password is not returned: settings values end up in exports and log exports.
      return values;
    });
  }

  /**
   * Read every settings block; a block whose data is all 0xFF counts as blank (no read access, or
   * a page that is not configured at all). When the status of this settings read and the first
   * block both went unanswered, the BMS is silent: the other blocks are not requested and the
   * failures are not counted against the blocks. Only call inside `this.channel.exclusive()`.
   * @param {Set<number>} skip addresses of the blocks to leave out
   * @param {boolean} statusAnswered whether the status request of this settings read was answered
   */
  async #readSettingBlocks(skip, statusAnswered) {
    const image = createRegisterImage();
    let answered = 0;
    let blank = 0;
    /** @type {Set<number>} addresses of the blank blocks */
    const blankAt = new Set();
    /** @type {number[]} addresses of the blocks that failed */
    const failed = [];
    for (const block of NEW_SETTING_BLOCKS) {
      if (skip.has(block.address)) continue;
      if (!statusAnswered && !answered && failed.length) break;
      try {
        const f = await this.#request(newReadRequest(block.address, block.length), (fr) => fr[2] === RSP.READ && u16le(fr, 3) === block.address, {
          timeout: 1000,
          retries: 2,
        });
        const data = parseReadResponse(f).data;
        storeBlock(image, block.address, data);
        this.blockFailures.delete(block.address);
        answered++;
        if (isBlankPage(data)) {
          blank++;
          blankAt.add(block.address);
        }
      } catch (err) {
        failed.push(block.address);
        this.log?.warn(`ANT settings block ${block.name} (${block.address}): ${errorText(err)}`);
      }
    }
    if (statusAnswered || answered) {
      for (const address of failed) {
        const n = (this.blockFailures.get(address) ?? 0) + 1;
        if (n < BLOCK_FAILURE_LIMIT) {
          this.blockFailures.set(address, n);
          continue;
        }
        this.blockFailures.delete(address);
        this.blockSkips.set(address, BLOCK_SKIP_READS);
      }
    }
    return { image, answered, blank, blankAt };
  }

  /**
   * Log in until the parameter pages can be read: the password of these settings as level 5 and
   * (when it has at most 8 characters) as levels 1 to 4, then the factory passwords at the same
   * addresses. Which level a board wants for its parameters, and which password the vendor app
   * used, is not documented, so the first parameter block is read after every attempt and decides.
   * A password that unlocked nothing is not tried again until the user changes it. Only call
   * inside `this.channel.exclusive()`.
   * @returns {Promise<boolean>} true when the parameters are readable now
   */
  async #unlockParameters() {
    const own = this.password;
    if (this.unlockFailed === own) return false;
    /** @type {Array<[string, number]>} */
    const tries = [];
    /** @param {string} password @param {number} address */
    const add = (password, address) => {
      const max = address === ADDR.PASSWORD_L5 ? 12 : 8;
      if (password && password.length <= max && !tries.some(([p, a]) => p === password && a === address)) tries.push([password, address]);
    };
    add(own, ADDR.PASSWORD_L5);
    for (const a of LOW_LEVEL_PASSWORDS) add(own, a);
    add(DEFAULT_PASSWORDS.new, ADDR.PASSWORD_L5);
    for (const a of LOW_LEVEL_PASSWORDS) add(DEFAULT_PASSWORD_L1, a);
    const probe = NEW_SETTING_BLOCKS[0];
    let unanswered = 0;
    for (const [password, address] of tries) {
      const level = await this.#authenticate(password, address, { retries: 0 });
      // A board that answers no password frame at all will not answer the next ones either.
      if (level === undefined && ++unanswered >= 2) break;
      try {
        const f = await this.#request(newReadRequest(probe.address, probe.length), (fr) => fr[2] === RSP.READ && u16le(fr, 3) === probe.address, { timeout: 1000, retries: 1 });
        if (!isBlankPage(parseReadResponse(f).data)) {
          const which = password === own ? 'the password of the settings' : 'a factory password';
          this.log?.event(`ANT parameters unlocked with ${which} as level ${passwordLevel(address)}`);
          this.unlockFailed = null;
          return true;
        }
      } catch (err) {
        this.log?.warn(`ANT settings block ${probe.name} (${probe.address}): ${errorText(err)}`);
      }
    }
    this.unlockFailed = own;
    this.log?.warn('ANT parameters stay locked: no password was accepted');
    return false;
  }

  /**
   * Make sure the BMS lets us read the parameter pages (spec 4.3). Nothing is sent when the last
   * status frame reports permission level 1 or higher. Otherwise the passwords are tried until one
   * grants level 1 or higher: the default level 1 password (as the vendor app sends it after
   * connecting), then the password of these settings as level 5 and, when it has at most 8
   * characters, as level 1 (a user who changed the app password types it once; which level it is
   * is not known). When the BMS answered and granted nothing, the same passwords are not sent
   * again until the user changes the password. Pass `null` to log in regardless of the status.
   * Only call inside `this.channel.exclusive()`.
   * @param {AntStatus | null} status
   * @returns {Promise<boolean>} true when read access was already granted, false when a login was needed
   */
  async #ensureReadAccess(status) {
    if (status && status.permission >= 1) return true;
    if (this.readAccessFailed === this.password) return false;
    /** @type {Array<[string, number]>} */
    const tries = [[DEFAULT_PASSWORD_L1, ADDR.PASSWORD_L1]];
    if (this.password) {
      tries.push([this.password, ADDR.PASSWORD_L5]);
      if (this.password !== DEFAULT_PASSWORD_L1 && this.password.length <= 8) tries.push([this.password, ADDR.PASSWORD_L1]);
    }
    let level;
    let answered = false;
    for (const [password, address] of tries) {
      level = await this.#authenticate(password, address);
      if (level !== undefined) answered = true;
      if (Number(level) >= 1) break;
    }
    const granted = Number(level) >= 1;
    // Only a BMS that answered and refused counts; a silent one gets the passwords next time.
    if (!granted && answered) this.readAccessFailed = this.password;
    this.log?.event(granted ? `ANT read access: level ${level}` : 'ANT read access: not granted by the BMS (no password was accepted)');
    return false;
  }

  /**
   * Password frame (0x23), by default the level 5 password before every write and control (spec
   * 4.3). The granted level is reported inconsistently by the boards, and some writes work without
   * it, so a missing or low answer is only logged; the write and its read-back tell whether the BMS
   * accepted the change.
   * @param {string} [password]
   * @param {number} [address]
   * @param {{ retries?: number }} [opts]
   * @returns {Promise<number | undefined>} the granted level from the 0x43 answer
   */
  async #authenticate(password = this.password, address = ADDR.PASSWORD_L5, { retries = 1 } = {}) {
    try {
      const f = await this.#request(newAuthRequest(password, address), (fr) => fr[2] === RSP.AUTH, { timeout: 1000, retries });
      return parseAuthResponse(f).permissionLevel;
    } catch (err) {
      this.log?.warn(`ANT password: ${errorText(err)}`);
      return undefined;
    }
  }

  /**
   * Control action (0x51) and its acknowledgement (0x61).
   * @param {number} action
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #control(action, { timeout = 1500, retries = 1 } = {}) {
    const f = await this.#request(newControlRequest(action), (fr) => fr[2] === RSP.CONTROL && u16le(fr, 3) === action, { timeout, retries });
    const result = parseControlResponse(f).result;
    if (result !== 1) this.log?.event(`ANT ${CONTROL_NAMES[action] ?? action}: acknowledged with result ${result}`);
    return result;
  }

  /**
   * After a switch command, read the status a few times until the switch value (as the settings
   * show it) is the requested one, and publish the snapshots so the UI follows at once.
   * @param {string} id
   * @param {boolean} wanted
   */
  async #awaitSwitch(id, wanted) {
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? 100 : 300);
      try {
        const st = await this.#readStatus({ timeout: 1000, retries: 0 });
        this.publish(newStatusSnapshot(st));
        if (/** @type {Record<string, boolean>} */ (newSwitchValues(st))[id] === wanted) return;
      } catch {
        /* the next attempt or the next poll will tell */
      }
    }
  }

  /**
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    const f = this.fields.get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    if (f.readOnly || f.type === 'action') throw new Error(msg('This value is read only'));
    const meta = f.meta ?? {};
    if (meta.kind === 'local') {
      this.password = checkPassword(value, 'new');
      if (this.ctx.options) this.ctx.options.antPassword = this.password;
      this.unlockFailed = null; // typed again: try it again
      this.readAccessFailed = null;
      return;
    }
    await this.channel.exclusive(async () => {
      if (meta.kind === 'control') {
        await this.#authenticate();
        await this.#control(value ? meta.on : meta.off);
        if (id === 'switch.buzzer') this.buzzer = !!value;
        else await this.#awaitSwitch(id, !!value);
        return;
      }
      if (meta.kind !== 'register') throw new Error(msg('Unknown setting'));
      if (meta.format === 'ascii') {
        // Text register (battery ID): NUL padded bytes, echoed byte for byte.
        const bytes = asciiToBytes(meta, value);
        await this.#authenticate();
        const echo = await this.#request(newWriteBytesRequest(meta.address, bytes), (fr) => fr[2] === RSP.WRITE && u16le(fr, 3) === meta.address, {
          timeout: 1500,
          retries: 1,
        });
        if (!equals(parseWriteResponse(echo).data, bytes)) throw new Error(msg('The BMS did not confirm the written value'));
        await this.#control(CONTROL.SAVE);
        return;
      }
      const raw = valueToRaw(meta, Number(value));
      await this.#authenticate();
      const echo = await this.#request(newWriteRequest(meta.address, raw, meta.size), (fr) => fr[2] === RSP.WRITE && u16le(fr, 3) === meta.address, {
        timeout: 1500,
        retries: 1,
      });
      if (parseWriteResponse(echo).rawValue !== raw) throw new Error(msg('The BMS did not confirm the written value'));
      // Save / apply, as the vendor app does after every parameter write (spec 4.3).
      await this.#control(CONTROL.SAVE);
    });
  }

  /** @param {string} id */
  async runAction(id) {
    const f = this.fields.get(id);
    if (!f || f.type !== 'action' || f.meta?.kind !== 'action') throw new Error(msg('Unknown action'));
    const action = f.meta.action;
    // These may restart or silence the BMS before the acknowledgement arrives.
    const mayNotAnswer = [CONTROL.RESTART, CONTROL.SHUTDOWN, CONTROL.FACTORY_RESET, CONTROL.BLUETOOTH_OFF].includes(action);
    await this.channel.exclusive(async () => {
      await this.#authenticate();
      try {
        await this.#control(action, { timeout: 1500, retries: 0 });
      } catch (err) {
        if (!mayNotAnswer || /** @type {any} */ (err)?.code !== 'TIMEOUT') throw err;
        this.log?.event(`ANT ${CONTROL_NAMES[action]}: no acknowledgement, the BMS may be restarting`);
      }
    });
  }

  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// ANT_OLD driver
// ---------------------------------------------------------------------------------------------

export class AntLegacyDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.channel = new FrameChannel(ctx.link, { createAssembler: createLegacyAssembler, describe, log: ctx.log }).start();
    this.serial = isSerialLink(ctx.link);
    this.schema = buildAntLegacySchema();
    this.fields = fieldMap(this.schema);
    /** 8 character password (empty: no password frames); kept in the app only (survives reconnects). */
    this.password = ctx.options?.antLegacyPassword ?? DEFAULT_PASSWORDS.old;
    /** Status request that answered during the probe. */
    this.statusRequest = this.serial ? oldStatusRequestUart : oldStatusRequestBt;
    /** @type {AntOldStatus | null} */
    this.status = null;
    /** Whether the BMS answers parameter reads (unverified beyond two sources, spec 3.6). */
    /** @type {'unknown'|'ok'|'unsupported'} */
    this.paramReads = 'unknown';
    /**
     * Whether the link returns the bytes written to it, as some UART adapters do (spec 3.6):
     * unknown on a serial port until a parameter answer tells, never on Bluetooth.
     * @type {boolean | undefined}
     */
    this.echo = this.serial ? undefined : false;
    /** NTC slots that reported a temperature other than 0 and -40 (see `oldStatusSnapshot`). */
    this.seenProbes = new Set();
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    // ESPHome polls old boards every 5 s; one second is the fastest rate used here.
    return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 };
  }

  getSettingsSchema() {
    return this.schema;
  }

  /**
   * @param {Uint8Array} bytes
   * @param {(frame: Uint8Array) => boolean} match
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  #request(bytes, match, { timeout = 1500, retries = 1 } = {}) {
    const d = describe(bytes);
    return this.channel.requestUnqueued(bytes, { match, timeout, retries, name: d?.name, decode: d?.decode });
  }

  /** @param {{ timeout?: number, retries?: number }} [opts] */
  async #readStatus(opts = {}) {
    const frame = await this.#request(this.statusRequest(), isOldStatusFrame, opts);
    const st = parseOldStatus(frame);
    this.status = st;
    return st;
  }

  /**
   * Read only probe (spec 11.2 steps 3 and 5): the old status request (`5A5A00000101` then
   * `DBDB00000000` on UART, `DBDB00000000` twice on Bluetooth) must give a 140 byte frame with a
   * valid sum and cell count. A board that also answers the 2021 status request is ANT_NEW and is
   * left to the `ant` driver.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const attempt = Math.max(300, Math.min(1500, Math.floor(timeout / 2)));
    return this.channel.exclusive(async () => {
      const candidates = this.serial ? [oldStatusRequestUart, oldStatusRequestBt] : [oldStatusRequestBt, oldStatusRequestBt];
      let found = false;
      for (const make of candidates) {
        try {
          const frame = await this.#request(make(), isOldStatusFrame, { timeout: attempt, retries: 0 });
          this.status = parseOldStatus(frame);
          this.statusRequest = make;
          found = true;
          break;
        } catch {
          /* try the next request */
        }
      }
      if (!found) return null;
      try {
        await this.#request(newStatusRequest(), (fr) => fr[0] === 0x7e && isStatusFrame(fr), { timeout: Math.min(800, attempt), retries: 0 });
        this.log?.event('ANT legacy probe: the device also answers the ANT 2021+ protocol, which is preferred');
        return null;
      } catch {
        /* a genuine old board */
      }
      return { variant: 'ANT_OLD', confidence: 1, info: { vendor: ANT_VENDOR, protocol: this.definition.protocol } };
    });
  }

  async poll() {
    const st = await this.channel.exclusive(() => this.#readStatus());
    this.publish(oldStatusSnapshot(st, this.seenProbes));
  }

  async readInfo() {
    return this.publishInfo({ vendor: ANT_VENDOR, protocol: this.definition.protocol });
  }

  /**
   * Read parameter N. The answer has the request layout (`5A5A NN VH VL sum`), so an answer with
   * value 0 equals the request, and so does an adapter echo of the request (spec 3.6). The echo
   * arrives first: a copy of the request in front of another frame proves an echoing adapter, an
   * answer alone proves none. Two copies are the echo and a 0 answer. A single copy is a 0 answer
   * only on a link known not to echo; otherwise it is the echo of an unanswered read, so a BMS that
   * does not answer parameter reads is not shown as zeros.
   * @param {number} param
   */
  async #readParam(param) {
    const req = oldReadRequest(param);
    const d = describe(req);
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const frames = await this.channel.requestManyUnqueued(req, {
          match: (fr) => fr.length === 6 && fr[0] === OLD_HEADER.READ && fr[2] === param,
          until: (frs) => frs.some((fr) => !equals(fr, req)),
          timeout: 600,
          partialOnTimeout: true,
          name: d?.name,
          decode: d?.decode,
        });
        const answer = frames.find((fr) => !equals(fr, req));
        if (this.serial && (answer || frames.length > 1)) {
          if (equals(frames[0], req)) this.echo = true;
          else this.echo ??= false;
        }
        if (answer) return parseOldCommand(answer).value;
        if (frames.length > 1 || this.echo === false) return 0;
        lastErr = new Error('Only the echo of the request arrived, no answer');
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async readSettings() {
    return this.channel.exclusive(async () => {
      /** @type {Record<string, any>} */
      const values = {};
      /** @type {AntOldStatus | null} */
      let fresh = null;
      try {
        fresh = await this.#readStatus({ timeout: 1500, retries: 1 });
      } catch (err) {
        this.log?.warn(`ANT status for settings: ${errorText(err)}`);
      }
      const st = fresh ?? this.status;
      if (st) Object.assign(values, oldSwitchValues(st));
      // The password is not returned: settings values end up in exports and log exports.
      let paramAnswered = false;
      if (this.paramReads !== 'unsupported') {
        let stop = false;
        for (const g of this.schema.groups) {
          for (const f of g.fields) {
            if (f.meta?.kind !== 'old-param') continue;
            try {
              let raw = await this.#readParam(f.meta.param);
              if (f.meta.highParam) raw += (await this.#readParam(f.meta.highParam)) * 65536;
              values[f.id] = legacyValue(f, raw);
              this.paramReads = 'ok';
              paramAnswered = true;
            } catch (err) {
              this.log?.warn(`ANT parameter ${f.meta.param}: ${errorText(err)}`);
              if (paramAnswered) continue;
              // Without a fresh status the BMS is silent (asleep, out of range): try again next
              // time. A BMS that answers the status and not this read ignores parameter reads.
              if (fresh && this.paramReads !== 'ok') {
                this.paramReads = 'unsupported';
                this.log?.event('ANT legacy: the BMS does not answer parameter reads, only the status is shown');
              }
              if (!fresh || this.paramReads === 'unsupported') {
                stop = true;
                break;
              }
            }
          }
          if (stop) break;
        }
      }
      if (!fresh && !paramAnswered) throw new Error(msg('The BMS did not answer the settings requests'));
      return values;
    });
  }

  /**
   * Password frames (if a password is set), the command and the apply frame (spec 4.4). An
   * `A5 A5 F5 00 01 F6` answer means the BMS refused the command (inferred, spec 3.6).
   * Call inside `this.channel.exclusive()`.
   * @param {number} address
   * @param {number} value
   */
  async #command(address, value) {
    const frames = [...(this.password ? oldPasswordFrames(this.password) : []), oldWriteCommand(address, value), oldApplyCommand()];
    const rejected = this.channel.waitFor(isOldRejection, frames.length * 50 + 600).then(
      () => true,
      () => false,
    );
    for (const fr of frames) {
      const d = describe(fr);
      await this.link.write(fr, { name: d?.name, decode: d?.decode });
      await sleep(40);
    }
    if (await rejected) throw new Error(msg('The BMS rejected the command. Check the password.'));
  }

  /**
   * @param {string} id
   * @param {boolean} wanted
   */
  async #awaitSwitch(id, wanted) {
    for (let i = 0; i < 3; i++) {
      await sleep(i === 0 ? 100 : 400);
      try {
        const st = await this.#readStatus({ timeout: 1500, retries: 0 });
        this.publish(oldStatusSnapshot(st, this.seenProbes));
        if (/** @type {Record<string, boolean>} */ (oldSwitchValues(st))[id] === wanted) return;
      } catch {
        /* the next poll will tell */
      }
    }
  }

  /**
   * @param {string} id
   * @param {any} value
   */
  async writeSetting(id, value) {
    const f = this.fields.get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    if (f.readOnly || f.type === 'action') throw new Error(msg('This value is read only'));
    if (f.meta?.kind === 'local') {
      this.password = checkPassword(value, 'old');
      if (this.ctx.options) this.ctx.options.antLegacyPassword = this.password;
      return;
    }
    if (f.meta?.kind !== 'old-control') throw new Error(msg('Unknown setting'));
    await this.channel.exclusive(async () => {
      await this.#command(f.meta.address, value ? 1 : 0);
      await this.#awaitSwitch(id, !!value);
    });
  }

  /** @param {string} id */
  async runAction(id) {
    const f = this.fields.get(id);
    if (!f || f.meta?.kind !== 'old-action') throw new Error(msg('Unknown action'));
    await this.channel.exclusive(() => this.#command(f.meta.address, 0));
  }

  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------

/** GATT profile (spec 2.1): service FFE0, FFE1 for requests and notifications, 20 byte writes. */
const bleProfile = (/** @type {string} */ id) => ({
  id,
  label: 'FFE0/FFE1',
  service: 0xffe0,
  notify: 0xffe1,
  write: 0xffe1,
  // Prefer write without response; the transport falls back to write with response (spec 2.1).
  writeMode: /** @type {const} */ ('without-response'),
  chunkSize: 20,
});

/** UART profiles (spec 2.2): 19200 8N1 used by every implementation, 9600 in vendor documents. */
const serialProfiles = (/** @type {string} */ prefix) => [
  { id: `${prefix}-19200`, label: 'UART 19200 8N1', baudRate: 19200, dataBits: /** @type {const} */ (8), stopBits: /** @type {const} */ (1), parity: /** @type {const} */ ('none') },
  { id: `${prefix}-9600`, label: 'UART 9600 8N1', baudRate: 9600, dataBits: /** @type {const} */ (8), stopBits: /** @type {const} */ (1), parity: /** @type {const} */ ('none') },
];

const SERIAL_NOTE = msg('3.3 V TTL UART on the 4 pin Comm connector. VCC must be connected, otherwise the BMS does not answer.');

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const antDefinition = {
  id: 'ant',
  family: 'ant',
  vendor: ANT_VENDOR,
  protocol: msg('ANT 2021+ protocol'),
  deviceType: 'bms',
  description: msg('ANT BMS boards from about mid 2021 on (frames starting with 7E A1), over Bluetooth or the UART port.'),
  links: {
    ble: {
      profiles: [bleProfile('ant-ffe0')],
      // ANT-BLE or ANT@BLE followed by a long model code (spec 1.3, 11.1). JK BMS shares the
      // UUIDs, so detection relies on the name and on the validated probe answer.
      namePrefixes: ['ANT-BLE', 'ANT@BLE'],
      namePatterns: [/^ANT[-@]BLE/],
    },
    serial: { profiles: serialProfiles('ant-uart'), note: SERIAL_NOTE },
  },
  create: (ctx) => new AntDriver(antDefinition, ctx),
  demo: { name: 'ANT-BLE16ZMUB (demo)', chunkSize: 20, create: (link) => createAntSimulator(link) },
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const antLegacyDefinition = {
  id: 'ant-legacy',
  family: 'ant',
  vendor: ANT_VENDOR,
  protocol: msg('ANT legacy protocol'),
  deviceType: 'bms',
  description: msg('ANT BMS boards up to about 2020 (140 byte status frames starting with AA 55 AA FF), over Bluetooth Low Energy or the UART port.'),
  links: {
    ble: {
      profiles: [bleProfile('ant-legacy-ffe0')],
      namePrefixes: ['ANT-BLE'],
      // The vendor app offers the old protocol for 10 character names (ANT-BLE16S, ANT-BLE24C)
      // and names with '-' at index 10 (ANT-BLE24C-001), spec 1.3.
      namePatterns: [/^ANT-BLE\w{3}\s*$/, /^ANT-BLE\w{3}-/],
    },
    serial: { profiles: serialProfiles('ant-legacy-uart'), note: SERIAL_NOTE },
  },
  create: (ctx) => new AntLegacyDriver(antLegacyDefinition, ctx),
};
