import { buildSchema, field, msg, relation, round } from '@ubms/bms-core';
import { FET, FN, KELVIN_OFFSET } from './protocol.js';

/**
 * Settings of the KS BMS boards (docs/protocols/ks.md section 4) and the conversion between
 * engineering units and register values.
 *
 * Every value is read from the blocks 0x04 to 0x07 and the status frame 0x01 (spec 3). Every
 * register is written with `7B <register> 02 <hi> <lo> 7D` (spec 4). The register numbers and
 * their order inside the blocks come from the open source driver [SY]; they are not confirmed by
 * a capture of the official app or on the board of this project. Following the project rule for
 * unconfirmed encodings, the schema is read only by default (`writable: false`); with
 * `writable: true` (tests, and once a board confirms the map) the driver reads the block back after
 * each write and reports a value the BMS did not take, and the UI asks before each write (`danger`).
 *
 * Not in the schema: registers 0x14 and 0x15 of the basic block (meaning unknown, spec 3.4).
 *
 * Field `meta` (driver private): `{ register, block, index, scale, offset }`. `block` is the read
 * function holding the value (0x04..0x07, or 0x01 for the capacities and switches), `index` the
 * word index inside a settings block or the status key, `scale` engineering units per raw unit,
 * `offset` the raw offset (2731 for temperatures in 0.1 K). Booleans carry `bit` (FET word) instead.
 *
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 */

const READ_ONLY_NOTE = msg('Known only from an open source KS driver and not confirmed by a capture, so ubms shows the value but does not write it yet.');
const NOTE = msg('Register taken from an open source KS driver and not confirmed on every board: each write is checked by reading the value back.');
const SWITCH_NOTE = msg('Switches the MOSFET as the open source KS driver does (register 0x1D or 0x1E). The status frame shows whether the BMS took it.');
const CYCLE_NOTE = msg('Charge counted as one cycle (meaning taken from the register name, unverified). Each write is checked by reading the value back.');
const CUTOFF_NOTE = msg('Cell voltage that the BMS treats as empty (meaning taken from the register name, unverified). Each write is checked by reading the value back.');
const FULL_NOTE = msg('Cell voltage that the BMS treats as full (meaning taken from the register name, unverified). Each write is checked by reading the value back.');

const PROT_ABOVE_REC = msg('Protection must be above its recovery value');
const REC_BELOW_PROT = msg('Recovery must be below protection');
const PROT_BELOW_REC = msg('Protection must be below its recovery value');
const REC_ABOVE_PROT = msg('Recovery must be above protection');
const PERCENT_ORDER = msg('The SOC voltages must fall from 80 % to 20 %');

/** First register of each settings block (spec 3.4 to 3.7). */
export const BLOCK_START = Object.freeze({ [FN.BASIC]: 0x10, [FN.VOLTAGE]: 0x20, [FN.TEMPERATURE]: 0x30, [FN.CURRENT]: 0x40 });

/** Registers kept in the status frame (spec 3.1, 4). */
export const STATUS_REGISTERS = Object.freeze({ 0x1a: 'nominalAh', 0x1b: 'cycleAh', 0x1c: 'fullAh' });

/** MOSFET switch registers and their FET status bits (spec 4). */
export const SWITCH_REGISTERS = Object.freeze({ 0x1d: FET.CHARGE_MOS, 0x1e: FET.DISCHARGE_MOS });

/** Whether the fields built next are writable (set by buildKsSchema). */
let writable = false;

/**
 * Write related properties: writable fields ask before writing, read only fields say why.
 * @param {string} note description of a writable field
 */
const access = (note) => (writable ? { danger: true, description: note } : { readOnly: true, description: READ_ONLY_NOTE });

/**
 * A register value inside a settings block.
 * @param {string} id
 * @param {number} register
 * @param {number} scale engineering units per raw unit
 * @param {Partial<SettingField>} [props]
 * @param {number} [offset] raw offset
 */
function reg(id, register, scale, props = {}, offset = 0) {
  const block = register >= 0x40 ? FN.CURRENT : register >= 0x30 ? FN.TEMPERATURE : register >= 0x20 ? FN.VOLTAGE : FN.BASIC;
  const statusKey = /** @type {Record<number, string>} */ (STATUS_REGISTERS)[register];
  const { description, ...rest } = props;
  return field(id, {
    ...access(description ?? NOTE),
    ...rest,
    meta: statusKey ? { register, block: FN.STATUS, index: statusKey, scale, offset } : { register, block, index: register - BLOCK_START[block], scale, offset },
  });
}

/** @param {string} id @param {number} register @param {Partial<SettingField>} [props] */
const cellVolt = (id, register, props = {}) => reg(id, register, 0.001, { unit: 'V', decimals: 3, min: 2, max: 4.5, ...props });
/** @param {string} id @param {number} register @param {Partial<SettingField>} [props] */
const packVolt = (id, register, props = {}) => reg(id, register, 0.01, { unit: 'V', decimals: 2, min: 5, max: 100, ...props });
/** Delays in ms, shown in seconds. @param {string} id @param {number} register @param {Partial<SettingField>} [props] */
const delay = (id, register, props = {}) => reg(id, register, 0.001, { unit: 's', decimals: 1, min: 0, max: 65, ...props });
/** @param {string} id @param {number} register @param {Partial<SettingField>} [props] */
const degrees = (id, register, props = {}) => reg(id, register, 0.1, { unit: '°C', decimals: 0, step: 1, min: -40, max: 100, ...props }, KELVIN_OFFSET);
/** @param {string} id @param {number} register @param {Partial<SettingField>} [props] */
const amps = (id, register, props = {}) => reg(id, register, 0.01, { unit: 'A', decimals: 1, min: 1, max: 655, ...props });
/** @param {string} id @param {number} register @param {Partial<SettingField>} [props] */
const ah = (id, register, props = {}) => reg(id, register, 0.01, { unit: 'Ah', decimals: 1, min: 1, max: 655, ...props });

/**
 * Limit and recovery validators of one protection pair.
 * @param {string} limit
 * @param {string} recovery
 * @param {'high'|'low'} kind
 */
const pair = (limit, recovery, kind) =>
  kind === 'high'
    ? { limit: relation(limit, '>', recovery, PROT_ABOVE_REC), recovery: relation(recovery, '<', limit, REC_BELOW_PROT) }
    : { limit: relation(limit, '<', recovery, PROT_BELOW_REC), recovery: relation(recovery, '>', limit, REC_ABOVE_PROT) };

/**
 * @param {string} label
 * @param {Partial<SettingField>} [props]
 */
const socVolt = (label, props = {}) => ({ label, group: 'capacity', ...props });

/**
 * @param {{ writable?: boolean }} [opts] writable: offer the register writes (default false)
 * @returns {SettingsSchema}
 */
export function buildKsSchema(opts = {}) {
  writable = opts.writable === true;
  const cellOv = pair('cell.ovp', 'cell.ovpr', 'high');
  const cellUv = pair('cell.uvp', 'cell.uvpr', 'low');
  const packOv = pair('pack.ovp', 'pack.ovpr', 'high');
  const packUv = pair('pack.uvp', 'pack.uvpr', 'low');
  const chOt = pair('charge.otp', 'charge.otpr', 'high');
  const chUt = pair('charge.utp', 'charge.utpr', 'low');
  const dsOt = pair('discharge.otp', 'discharge.otpr', 'high');
  const dsUt = pair('discharge.utp', 'discharge.utpr', 'low');
  /** @param {string} self @param {'>'|'<'} op @param {string} other */
  const order = (self, op, other) => relation(self, op, other, PERCENT_ORDER);
  return buildSchema([
    // Switches (status frame, FET word).
    field('switch.charge', { ...access(SWITCH_NOTE), meta: { register: 0x1d, block: FN.STATUS, bit: FET.CHARGE_MOS } }),
    field('switch.discharge', { ...access(SWITCH_NOTE), meta: { register: 0x1e, block: FN.STATUS, bit: FET.DISCHARGE_MOS } }),
    // Cell voltage 0x05.
    cellVolt('cell.ovp', 0x20, { min: 3, validate: cellOv.limit }),
    cellVolt('cell.ovpr', 0x21, { min: 3, validate: cellOv.recovery }),
    delay('cell.ovp_delay', 0x22),
    cellVolt('cell.uvp', 0x23, { max: 4, validate: cellUv.limit }),
    cellVolt('cell.uvpr', 0x24, { max: 4, validate: cellUv.recovery }),
    delay('cell.uvp_delay', 0x25),
    // Pack voltage 0x05.
    packVolt('pack.ovp', 0x26, { validate: packOv.limit }),
    packVolt('pack.ovpr', 0x27, { validate: packOv.recovery }),
    delay('ks.pack_ovp_delay', 0x28, { label: msg('Pack overvoltage delay'), group: 'pack_voltage' }),
    packVolt('pack.uvp', 0x29, { validate: packUv.limit }),
    packVolt('pack.uvpr', 0x2a, { validate: packUv.recovery }),
    delay('ks.pack_uvp_delay', 0x2b, { label: msg('Pack undervoltage delay'), group: 'pack_voltage' }),
    // Current 0x07. Recovery delays in 10 ms steps (spec 3.7).
    amps('charge.ocp', 0x40),
    delay('charge.ocp_delay', 0x41),
    reg('charge.ocp_recovery', 0x42, 0.01, { unit: 's', decimals: 1, min: 0, max: 655 }),
    amps('discharge.ocp', 0x43),
    delay('discharge.ocp_delay', 0x44),
    reg('discharge.ocp_recovery', 0x45, 0.01, { unit: 's', decimals: 1, min: 0, max: 655 }),
    // Temperature 0x06.
    degrees('charge.otp', 0x30, { validate: chOt.limit }),
    degrees('charge.otpr', 0x31, { validate: chOt.recovery }),
    delay('ks.charge_otp_delay', 0x32, { label: msg('Charge overtemperature delay'), group: 'temperature' }),
    degrees('charge.utp', 0x33, { validate: chUt.limit }),
    degrees('charge.utpr', 0x34, { validate: chUt.recovery }),
    delay('ks.charge_utp_delay', 0x35, { label: msg('Charge undertemperature delay'), group: 'temperature' }),
    degrees('discharge.otp', 0x36, { validate: dsOt.limit }),
    degrees('discharge.otpr', 0x37, { validate: dsOt.recovery }),
    delay('ks.discharge_otp_delay', 0x38, { label: msg('Discharge overtemperature delay'), group: 'temperature' }),
    degrees('discharge.utp', 0x39, { validate: dsUt.limit }),
    degrees('discharge.utpr', 0x3a, { validate: dsUt.recovery }),
    delay('ks.discharge_utp_delay', 0x3b, { label: msg('Discharge undertemperature delay'), group: 'temperature' }),
    // Balancing 0x04.
    cellVolt('balance.start_voltage', 0x12),
    cellVolt('balance.trigger_delta', 0x13, { min: 0.001, max: 1 }),
    // Capacity: 0x04 and the status frame.
    ah('capacity.nominal', 0x1a),
    ah('ks.full_capacity', 0x1c, { label: msg('Full charge capacity'), group: 'capacity' }),
    ah('capacity.cycle', 0x1b, { description: CYCLE_NOTE }),
    cellVolt('ks.cell_full_voltage', 0x10, { ...socVolt(msg('Cell full voltage')), description: FULL_NOTE }),
    cellVolt('ks.soc80_voltage', 0x16, { ...socVolt(msg('Cell voltage at 80 % SOC')), validate: order('ks.soc80_voltage', '>', 'ks.soc60_voltage') }),
    cellVolt('ks.soc60_voltage', 0x17, { ...socVolt(msg('Cell voltage at 60 % SOC')), validate: order('ks.soc60_voltage', '>', 'ks.soc40_voltage') }),
    cellVolt('ks.soc40_voltage', 0x18, { ...socVolt(msg('Cell voltage at 40 % SOC')), validate: order('ks.soc40_voltage', '>', 'ks.soc20_voltage') }),
    cellVolt('ks.soc20_voltage', 0x19, { ...socVolt(msg('Cell voltage at 20 % SOC')), validate: order('ks.soc20_voltage', '<', 'ks.soc40_voltage') }),
    cellVolt('ks.cell_cutoff_voltage', 0x11, { ...socVolt(msg('Cell cutoff voltage')), description: CUTOFF_NOTE }),
  ]);
}

/**
 * Engineering value of a numeric field from its raw register value.
 * @param {SettingField} f
 * @param {number} raw
 */
export function rawToValue(f, raw) {
  return round((raw - (f.meta.offset ?? 0)) * f.meta.scale, Math.max(f.decimals ?? 3, 3));
}

/**
 * Raw register value of a numeric field; undefined outside the schema range or 0..65535.
 * @param {SettingField} f
 * @param {number} value
 */
export function valueToRaw(f, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if ((f.min !== undefined && value < f.min - 1e-9) || (f.max !== undefined && value > f.max + 1e-9)) return undefined;
  const raw = Math.round(value / f.meta.scale + (f.meta.offset ?? 0));
  return raw >= 0 && raw <= 0xffff ? raw : undefined;
}

/**
 * Raw value of a field from the parsed blocks.
 * @param {SettingField} f
 * @param {{ blocks: Record<number, number[]>, status: Record<string, any> | null }} src
 * @returns {number | boolean | undefined}
 */
export function currentRaw(f, { blocks, status }) {
  if (f.type === 'boolean') return status ? (status.fet & f.meta.bit) !== 0 : undefined;
  if (f.meta.block === FN.STATUS) {
    const v = status?.[f.meta.index];
    return typeof v === 'number' ? Math.round(v * 100) : undefined;
  }
  return blocks[f.meta.block]?.[f.meta.index];
}

/**
 * Values of the whole schema from the parsed blocks (missing blocks leave their fields out).
 * @param {SettingsSchema} schema
 * @param {{ blocks: Record<number, number[]>, status: Record<string, any> | null }} src
 */
export function decodeKsSettings(schema, src) {
  /** @type {Record<string, any>} */
  const values = {};
  for (const g of schema.groups) {
    for (const f of g.fields) {
      const raw = currentRaw(f, src);
      if (raw === undefined) continue;
      values[f.id] = typeof raw === 'boolean' ? raw : rawToValue(f, raw);
    }
  }
  return values;
}
