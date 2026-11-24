import { BaseDriver, IDLE_CURRENT, alarm, fieldMap, msg } from '@ubms/bms-core';
import { FrameChannel, sleep } from '@ubms/transport';
import { alarmsFromBits } from '../common/util.js';
import {
  FET,
  FN,
  PROTECTION_BITS,
  createAssembler,
  describe,
  encodeRead,
  encodeWrite,
  parseCells,
  parseDate,
  parseHistory,
  parseStatus,
  parseTemps,
  parseText,
  parseVersion,
  parseWords,
} from './protocol.js';
import { buildKsSchema, currentRaw, decodeKsSettings, valueToRaw } from './settings.js';
import { createKsSimulator } from './simulator.js';

/**
 * Driver of the KS BMS boards (KS48100, KS48200, KS48300, often sold as "Kesheng", 科圣, and used
 * in wall mounted 16S LiFePO4 packs) over their Bluetooth module (docs/protocols/ks.md, "spec"
 * below). The module (a Quectel FC41D on the boards seen so far) passes the `7B ... 7D` frames of
 * the BMS through service FF00 (notify FF01, write FF02), the layout of the JBD modules.
 *
 * It polls the status 0x01 (0x61 on "type 2" boards), the cell voltages 0x02 and the cell
 * temperatures 0x03, reads the texts, versions and protection counters as device information,
 * reads the settings blocks 0x04 to 0x07 and can write single registers. The register map comes
 * from the open source driver [SY] and is not confirmed by a capture, so the definition creates
 * the driver read only; with `writable: true` every write is read back.
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 * @typedef {import('@ubms/bms-core/model').TemperatureReading} TemperatureReading
 * @typedef {ReturnType<typeof parseStatus>} KsStatus
 */

export const KS_VENDOR = 'KS (Kesheng)';

/** Variants: the status function the board answers (spec 3.1). */
export const VARIANT = Object.freeze({ STATUS_01: 'KS (status 0x01)', STATUS_61: 'KS (status 0x61)' });

const NO_ANSWER = msg('No answer from the BMS. It may be asleep, out of range or connected to another app.');
const IMPLAUSIBLE = msg('The BMS sent implausible data');
const NOT_APPLIED = msg('The BMS did not take the new value');
const BLOCKS_MISSING = msg('The BMS did not answer every settings block, so some values are missing. Read the settings again.');
const COLD_CHARGE = msg('Charging below 0 °C: LiFePO4 cells must not be charged in the cold');

/** Labels of the cell temperature probes (literal for the translation checker). */
const TEMP_LABELS = [
  msg('Temperature 1'),
  msg('Temperature 2'),
  msg('Temperature 3'),
  msg('Temperature 4'),
  msg('Temperature 5'),
  msg('Temperature 6'),
  msg('Temperature 7'),
  msg('Temperature 8'),
];

/** Labels of the protection counters 0x08 (spec 3.10). */
const COUNTER_LABELS = {
  shortCircuit: msg('Short circuit events'),
  chargeOvercurrent: msg('Charge overcurrent events'),
  dischargeOvercurrent: msg('Discharge overcurrent events'),
  cellOvervoltage: msg('Cell overvoltage events'),
  counter5: msg('Protection counter 5 (meaning unverified)'),
  packOvervoltage: msg('Pack overvoltage events'),
  packUndervoltage: msg('Pack undervoltage events'),
  chargeOvertemperature: msg('Charge overtemperature events'),
  chargeUndertemperature: msg('Charge undertemperature events'),
  dischargeOvertemperature: msg('Discharge overtemperature events'),
  dischargeUndertemperature: msg('Discharge undertemperature events'),
};

/** Answer time per request on Bluetooth (ubms choice; [SY] sends 16 reads back to back). */
const TIMEOUT_MS = 1500;
/** Time for the information reads, which some boards leave unanswered (0xF3, spec 3.9). */
const INFO_TIMEOUT_MS = 800;
/** Pause between a register write and its read-back, and between read-back attempts. */
const WRITE_SETTLE_MS = 300;
const READBACK_TRIES = 3;
/** A lost cell or temperature read keeps the previous values for this many polls. */
const KEEP_POLLS = 2;

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));
/** @param {unknown} err */
const isTimeout = (err) => /** @type {any} */ (err)?.code === 'TIMEOUT';
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** @param {number} v */
const h2 = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * Why a status frame is not usable, or null (spec 3.1, 6).
 * @param {KsStatus} st
 */
export function statusProblem(st) {
  if (!(st.voltage > 1 && st.voltage < 120)) return `pack voltage ${st.voltage} V`;
  if (st.soc > 100) return `SOC ${st.soc} %`;
  if (st.soh !== undefined && st.soh > 100) return `SOH ${st.soh} %`;
  if (st.fullAh > 0 && st.remainingAh > st.fullAh * 1.2 + 1) return `remaining ${st.remainingAh} Ah of ${st.fullAh} Ah`;
  return null;
}

/**
 * Snapshot from the status and the last cell and temperature reads (spec 3.1 to 3.3).
 * @param {KsStatus} st
 * @param {{ cells?: number[] | null, temps?: number[] | null }} [parts]
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function ksSnapshot(st, { cells = null, temps = null } = {}) {
  /** @type {TemperatureReading[]} */
  const temperatures = (temps ?? []).map((value, i) => ({ id: `t${i + 1}`, label: TEMP_LABELS[i] ?? `Temperature ${i + 1}`, value, kind: /** @type {const} */ ('cell') }));
  temperatures.push({ id: 'mos', label: msg('MOSFET temperature'), value: st.mosTemp, kind: 'mos' });
  temperatures.push({ id: 'ambient', label: msg('Ambient temperature'), value: st.ambientTemp, kind: 'ambient' });
  const alarms = alarmsFromBits(st.protection, PROTECTION_BITS, 'protection bit');
  // LiFePO4 must not be charged below 0 °C (an app warning, not a BMS flag).
  if (temps?.length && Math.min(...temps) < 0 && st.current > IDLE_CURRENT) {
    alarms.push(alarm('ks.cold_charge', { severity: 'warning', label: COLD_CHARGE, source: 'ubms: cell temperature and current' }));
  }
  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const snap = {
    voltage: st.voltage,
    current: st.current,
    soc: st.soc,
    capacityRemaining: st.remainingAh,
    capacityFull: st.fullAh,
    capacityNominal: st.nominalAh,
    cycles: st.cycles,
    temperatures,
    switches: { charge: (st.fet & FET.CHARGE_MOS) !== 0, discharge: (st.fet & FET.DISCHARGE_MOS) !== 0 },
    balancingActive: st.balanceMask !== 0,
    alarms,
    extra: {
      limiting: { label: msg('Current limiting active'), value: (st.fet & FET.LIMITING) !== 0 },
    },
  };
  if (st.soh !== undefined) snap.soh = st.soh;
  if (cells?.length) {
    snap.cells = cells;
    snap.balancing = cells.map((_, i) => i < 32 && ((st.balanceMask >>> i) & 1) === 1);
  }
  return snap;
}

/**
 * Device information from the information reads (spec 3.8 to 3.10). Missing reads are left out.
 * @param {{ serial?: string, modelName?: string, modelType?: string, date?: string, module?: string, program?: string, boot?: string, software?: string, history?: Record<string, number> | null, variant?: string }} r
 * @returns {DeviceInfo}
 */
export function ksInfo(r) {
  /** @type {Record<string, ExtraValue>} */
  const extra = {};
  if (r.module) extra.module = { label: msg('Bluetooth module'), value: r.module };
  if (r.boot) extra.bootVersion = { label: msg('Boot version'), value: r.boot };
  if (r.software) extra.softwareF3 = { label: msg('Software version (0xF3)'), value: r.software };
  if (r.modelName && r.modelType) extra.modelType = { label: msg('Model type'), value: r.modelType };
  for (const [k, v] of Object.entries(r.history ?? {})) {
    const label = /** @type {Record<string, string>} */ (COUNTER_LABELS)[k];
    if (label) extra[`count.${k}`] = { label, value: v, decimals: 0 };
  }
  /** @type {DeviceInfo} */
  const info = { vendor: KS_VENDOR, model: r.modelName || r.modelType || 'KS BMS' };
  if (r.variant) info.protocol = r.variant;
  if (r.serial) info.serialNumber = r.serial;
  if (r.date) info.manufactureDate = r.date;
  if (r.program) info.softwareVersion = r.program;
  if (Object.keys(extra).length) info.extra = extra;
  return info;
}

export class KsDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   * @param {{ writable?: boolean }} [opts] writable: offer the register writes (spec 4)
   */
  constructor(definition, ctx, opts = {}) {
    super(definition, ctx);
    this.writable = opts.writable === true;
    this.channel = new FrameChannel(ctx.link, {
      createAssembler: (h) => createAssembler(h),
      describe: (f) => describe(f, 'rx'),
      log: ctx.log,
    }).start();
    this.schema = buildKsSchema({ writable: this.writable });
    this.fields = fieldMap(this.schema);
    /** Status function the board answered in the probe (spec 3.1). */
    this.statusFn = FN.STATUS;
    /** @type {KsStatus | null} */
    this.status = null;
    /** Parsed settings blocks by read function. @type {Record<number, number[]>} */
    this.blocks = {};
    /** Last cell and temperature reads and how many polls they are old. */
    this.parts = { cells: /** @type {number[] | null} */ (null), temps: /** @type {number[] | null} */ (null), cellsAge: 0, tempsAge: 0 };
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    return { settings: true, writeSettings: this.writable, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 };
  }

  getSettingsSchema() {
    return this.schema;
  }

  /**
   * One read and its answer (matched by the function byte). Only call inside
   * `this.channel.exclusive()`.
   * @param {number} fn
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  #read(fn, { timeout = TIMEOUT_MS, retries = 0 } = {}) {
    const bytes = encodeRead(fn);
    const d = describe(bytes, 'tx');
    return this.channel.requestUnqueued(bytes, { match: (f) => f[1] === fn, timeout, retries, name: d?.name, decode: d?.decode });
  }

  /** Read and check the status. Only call inside `this.channel.exclusive()`. */
  async #readStatus() {
    /** @type {KsStatus} */
    let st;
    try {
      st = parseStatus(await this.#read(this.statusFn, { retries: 1 }));
    } catch (err) {
      if (isTimeout(err)) throw new Error(NO_ANSWER);
      throw err;
    }
    const problem = statusProblem(st);
    if (problem) {
      this.log?.warn(`KS status ignored, implausible ${problem}`, { source: this.definition.id });
      throw new Error(IMPLAUSIBLE);
    }
    this.status = st;
    return st;
  }

  /**
   * Read only probe (spec 6): the status read 0x01, then 0x61 for the "type 2" boards. Nothing
   * else is sent.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const perTry = clamp(timeout / 2, 400, TIMEOUT_MS);
    return this.channel.exclusive(async () => {
      for (const fn of [FN.STATUS, FN.STATUS_2]) {
        /** @type {KsStatus} */
        let st;
        try {
          st = parseStatus(await this.#read(fn, { timeout: perTry }));
        } catch (err) {
          if (isTimeout(err)) continue;
          this.log?.warn(`KS probe: ${errorText(err)}`, { source: this.definition.id });
          return null;
        }
        const problem = statusProblem(st);
        if (problem) {
          this.log?.event(`KS probe: implausible status (${problem})`);
          return null;
        }
        this.statusFn = fn;
        this.status = st;
        const variant = fn === FN.STATUS ? VARIANT.STATUS_01 : VARIANT.STATUS_61;
        this.setVariant(variant);
        const info = this.publishInfo(ksInfo({ variant }));
        this.log?.event(`KS BMS: status ${h2(fn)}, ${st.voltage} V, SOC ${st.soc} %`);
        return { variant, confidence: 0.9, info };
      }
      return null;
    });
  }

  /**
   * A cell or temperature read: a lost answer keeps the previous values for KEEP_POLLS polls.
   * Only call inside `this.channel.exclusive()`.
   * @param {'cells'|'temps'} key
   */
  async #part(key) {
    const age = key === 'cells' ? 'cellsAge' : 'tempsAge';
    try {
      const f = await this.#read(key === 'cells' ? FN.CELLS : FN.TEMPS);
      this.parts[key] = key === 'cells' ? parseCells(f) : parseTemps(f);
      this.parts[age] = 0;
    } catch (err) {
      if (!isTimeout(err)) this.log?.warn(`KS ${key}: ${errorText(err)}`, { source: this.definition.id });
      if (++this.parts[age] > KEEP_POLLS) this.parts[key] = null;
    }
    return this.parts[key];
  }

  async poll() {
    const snap = await this.channel.exclusive(async () => {
      const st = await this.#readStatus();
      const cells = await this.#part('cells');
      const temps = await this.#part('temps');
      return ksSnapshot(st, { cells, temps });
    });
    this.publish(snap);
  }

  async readInfo() {
    const info = await this.channel.exclusive(async () => {
      /**
       * @template T
       * @param {number} fn
       * @param {(f: Uint8Array) => T} parse
       * @returns {Promise<T | undefined>}
       */
      const optional = async (fn, parse) => {
        try {
          return parse(await this.#read(fn, { timeout: INFO_TIMEOUT_MS }));
        } catch (err) {
          if (!isTimeout(err)) this.log?.warn(`KS ${h2(fn)}: ${errorText(err)}`, { source: this.definition.id });
          return undefined;
        }
      };
      return ksInfo({
        variant: this.variant,
        serial: await optional(FN.SERIAL, parseText),
        modelName: await optional(FN.MODEL_NAME, parseText),
        modelType: await optional(FN.MODEL_TYPE, parseText),
        date: await optional(FN.DATE, parseDate),
        module: await optional(FN.MODULE_VERSION, parseText),
        program: await optional(FN.PROGRAM_VERSION, parseVersion),
        boot: await optional(FN.BOOT_VERSION, parseVersion),
        software: await optional(FN.SOFTWARE_VERSION, parseVersion),
        history: (await optional(FN.HISTORY, parseHistory)) ?? null,
      });
    });
    return this.publishInfo(info);
  }

  async readSettings() {
    return this.channel.exclusive(async () => {
      await this.#readStatus();
      let missing = 0;
      for (const fn of [FN.BASIC, FN.VOLTAGE, FN.TEMPERATURE, FN.CURRENT]) {
        try {
          this.blocks[fn] = parseWords(await this.#read(fn, { retries: 1 }));
        } catch (err) {
          if (!isTimeout(err)) throw err;
          delete this.blocks[fn];
          missing++;
          this.log?.warn(`KS settings block ${h2(fn)} not answered`, { source: this.definition.id });
        }
      }
      if (missing) this.settingsNotice = BLOCKS_MISSING;
      return decodeKsSettings(this.schema, { blocks: this.blocks, status: this.status });
    });
  }

  /**
   * Current raw value of a field, read with its block. Only call inside `this.channel.exclusive()`.
   * @param {import('@ubms/bms-core/settings').SettingField} f
   */
  async #readBack(f) {
    if (f.meta.block === FN.STATUS) {
      await this.#readStatus();
    } else {
      this.blocks[f.meta.block] = parseWords(await this.#read(f.meta.block, { retries: 1 }));
    }
    return currentRaw(f, { blocks: this.blocks, status: this.status });
  }

  /**
   * Write one register (spec 4). The BMS sends no confirmation, so the block is read back until it
   * shows the new value.
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    const f = this.fields.get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    if (f.readOnly || typeof f.meta?.register !== 'number') throw new Error(msg('This value is read only'));
    /** @type {number | undefined} */
    let raw;
    if (f.type === 'boolean') raw = typeof value === 'boolean' ? (value ? 1 : 0) : undefined;
    else raw = valueToRaw(f, value);
    if (raw === undefined) throw new Error(msg('Invalid value'));
    const expected = f.type === 'boolean' ? raw === 1 : raw;
    await this.channel.exclusive(async () => {
      const bytes = encodeWrite(f.meta.register, raw);
      const d = describe(bytes, 'tx');
      await this.link.write(bytes, { name: d?.name, decode: d?.decode });
      /** @type {number | boolean | undefined} */
      let now;
      for (let i = 0; i < READBACK_TRIES; i++) {
        await sleep(WRITE_SETTLE_MS);
        try {
          now = await this.#readBack(f);
        } catch (err) {
          if (!isTimeout(err) && /** @type {any} */ (err)?.message !== NO_ANSWER) throw err;
          continue;
        }
        if (now === expected) return;
      }
      this.log?.warn(`KS: wrote ${raw} to register ${h2(f.meta.register)}, the read-back shows ${now}`, { source: this.definition.id });
      throw new Error(NOT_APPLIED);
    });
  }

  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------------------------

/**
 * GATT profile of the KS Bluetooth module (spec 2.1, [SY]): service FF00, notify FF01, write FF02,
 * written without response as [SY] does. The same layout as the JBD modules: detection tells them
 * apart by the 7B frames (spec 6).
 */
export const KS_BLE_PROFILE = Object.freeze({
  id: 'ks-ff00',
  label: 'FF00 (FF01/FF02)',
  service: 0xff00,
  notify: 0xff01,
  write: 0xff02,
  writeMode: /** @type {const} */ ('prefer-without-response'),
  chunkSize: 20,
});

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const ksDefinition = {
  id: 'ks-ble',
  family: 'ks',
  vendor: KS_VENDOR,
  protocol: msg('KS 7B frames (Bluetooth)'),
  deviceType: 'bms',
  description: msg(
    'KS BMS boards (KS48100, KS48200, KS48300, "lithium battery wifi" app) in wall mounted 16S LiFePO4 packs, through their Bluetooth module: live data, cell temperatures, protection counters and settings (read only for now).',
  ),
  experimental: true,
  links: {
    ble: {
      profiles: [KS_BLE_PROFILE],
      // The modules advertise the pack serial number or a model code ([SY]: CER2410-018-030-023,
      // BL-250-100-100, 12V100A00460), so there is no name prefix to filter or rank by (spec 2.1).
      optionalServices: [0xff00],
    },
  },
  create: (ctx) => new KsDriver(ksDefinition, ctx),
  demo: { name: 'KS48100 16S (demo)', chunkSize: 20, create: (link) => createKsSimulator(link) },
};
