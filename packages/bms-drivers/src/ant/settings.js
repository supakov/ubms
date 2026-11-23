import { field, buildSchema, relation, msg, round } from '@ubms/bms-core';
import { CONTROL, OLD_CONTROL, ADDR, DEFAULT_PASSWORD_L5, OLD_CAPTURED_PASSWORD } from './protocol.js';

/**
 * ANT settings schemas and raw/engineering conversion (docs/protocols/ant.md section 7).
 *
 * Safety rule: a parameter whose register, unit or scaling the specification marks unverified,
 * disputed, or documents from a single source (the 2024 app map only, "Y") is `readOnly`: it is
 * shown but never written. Writable parameters are confirmed by at least two independent sources
 * (ESPHome "E" and the vendor PC tool lists "B", most of them also captured, "C").
 *
 * Limits (`min`/`max`) are generic plausibility bounds for the UI. The vendor documents no
 * ranges (spec 7.1), so they cover every chemistry the BMS supports (LTO to NMC) rather than
 * device limits.
 *
 * Field `meta` (driver private):
 * - `{ kind: 'register', address, size, scale, signed?, format? }` ANT_NEW parameter (byte address)
 * - `{ kind: 'control', on, off }` boolean switch sent as two control actions
 * - `{ kind: 'action', action }` one-shot control action
 * - `{ kind: 'local' }` value kept in the app (password)
 * - `{ kind: 'old-param', param, scale, signed?, highParam? }` ANT_OLD parameter number
 * - `{ kind: 'old-control', address }` ANT_OLD switch (value 1 on, 0 off)
 * - `{ kind: 'old-action', address }` ANT_OLD one-shot control address
 *
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 *
 * @typedef {Object} RegisterMeta
 * @property {'register'} kind
 * @property {number} address byte address
 * @property {number} size bytes: 2 (u16/i16), 4 (u32) or the length of an ASCII field
 * @property {number} [scale] engineering value = raw x scale
 * @property {boolean} [signed] i16
 * @property {'ascii'|'capacity'} [format] 'capacity': unit disputed, resolved against the status frame
 */

const UNCONFIRMED = msg('The encoding of this value is not confirmed yet, so it is shown but never written.');
const CAPACITY_UNCONFIRMED = msg(
  'Sources disagree on the unit of this register (Ah or micro Ah). The app derives it from the status frame; the value is shown but never written until the encoding is confirmed.',
);
const LEGACY_READ_ONLY = msg('Parameter writes of the old protocol are not confirmed yet, so this value is shown but never written.');
/** Charge and discharge switches show the command state, not the MOSFET state (driver `switchOn`). */
const MOS_SWITCH_NOTE = msg(
  'Off only after an off command. While a protection or a full battery holds the MOSFET off, the switch stays On, because the BMS turns the MOSFET back on by itself. The overview shows the actual MOSFET state.',
);

const PROT_ABOVE_REC = msg('Protection must be above its recovery value');
const REC_BELOW_PROT = msg('Recovery must be below protection');
const PROT_BELOW_REC = msg('Protection must be below its recovery value');
const REC_ABOVE_PROT = msg('Recovery must be above protection');
const L2_ABOVE_L1 = msg('Level 2 must be above level 1');
const L1_BELOW_L2 = msg('Level 1 must be below level 2');
const L2_BELOW_L1 = msg('Level 2 must be below level 1');
const L1_ABOVE_L2 = msg('Level 1 must be above level 2');
const ALARM_ABOVE_REC = msg('Alarm must be above its recovery value');
const REC_BELOW_ALARM = msg('Recovery must be below the alarm value');
const ALARM_BELOW_REC = msg('Alarm must be below its recovery value');
const REC_ABOVE_ALARM = msg('Recovery must be above the alarm value');
const STOP_BELOW_START = msg('Stop difference must be below the start difference');
const START_ABOVE_STOP = msg('Start difference must be above the stop difference');
const START_NOT_ABOVE_LIMIT = msg('Start voltage must not exceed the limit voltage');
const LIMIT_NOT_BELOW_START = msg('Limit voltage must not be below the start voltage');
const SOC2_NOT_ABOVE_SOC1 = msg('Level 2 must not exceed level 1');
const SOC1_NOT_BELOW_SOC2 = msg('Level 1 must not be below level 2');

/** @param {...((values: Record<string, any>) => string | null)} checks */
function all(...checks) {
  return (/** @type {Record<string, any>} */ values) => {
    for (const c of checks) {
      const e = c(values);
      if (e) return e;
    }
    return null;
  };
}

/**
 * Temperature registers (block 56): documented by the 2024 app map only, but the values read
 * correctly on an ANT-BLE20PHUB (user report 2026-11-23), so they are written like the other
 * u16/i16 registers; the session reads every write back.
 */
const TEMP_NOTE = msg('Read correctly on an ANT BMS; the write is checked by reading the value back.');
const TEMP = { min: -40, max: 120, description: TEMP_NOTE };
const BATTERY_ID_NOTE = msg('Up to 32 ASCII characters. The write is checked by reading the battery ID back.');

const CELL_V = { min: 1, max: 4.5 };
const CELL_DIFF = { min: 0.001, max: 2 };
const PACK_V = { min: 1, max: 150 };
const CURRENT = { min: 0.1, max: 1000 };
const DELAY_S = { min: 0, max: 600 };

/**
 * Writable ANT_NEW register field.
 * @param {string} id
 * @param {{ address: number, scale?: number, size?: number, signed?: boolean, format?: 'ascii'|'capacity' }} reg
 * @param {Partial<SettingField>} [overrides]
 */
function reg(id, reg, overrides = {}) {
  return field(id, { ...overrides, meta: /** @type {RegisterMeta} */ ({ kind: 'register', size: 2, scale: 1, ...reg }) });
}

/**
 * ANT_NEW register that is shown but never written (encoding not confirmed).
 * @param {string} id
 * @param {{ address: number, scale?: number, size?: number, signed?: boolean, format?: 'ascii'|'capacity' }} r
 * @param {Partial<SettingField>} [overrides]
 */
function roReg(id, r, overrides = {}) {
  return reg(id, r, { description: UNCONFIRMED, ...overrides, readOnly: true });
}

/** @param {string} label */
const cellV = (label) => ({ label, group: 'cell_voltage', unit: 'V', decimals: 3, ...CELL_V });
/** @param {string} label */
const cellDiff = (label) => ({ label, group: 'cell_voltage', unit: 'V', decimals: 3, ...CELL_DIFF });
/** @param {string} label */
const packV = (label) => ({ label, group: 'pack_voltage', unit: 'V', decimals: 1, ...PACK_V });
/** @param {string} label */
const amps = (label) => ({ label, group: 'current', unit: 'A', decimals: 1, ...CURRENT });
/** @param {string} label */
const degrees = (label) => ({ label, group: 'temperature', unit: '°C', decimals: 0, ...TEMP });

/**
 * Pair of temperature registers: a limit and its recovery. High limits stay above their
 * recovery, low limits below it.
 * @param {string} id limit field id
 * @param {string} recId recovery field id
 * @param {'high'|'low'} kind
 * @param {boolean} alarm alarm pair (other messages)
 */
const tempPair = (id, recId, kind, alarm = false) => {
  const high = kind === 'high';
  return {
    limit: relation(id, high ? '>' : '<', recId, alarm ? (high ? ALARM_ABOVE_REC : ALARM_BELOW_REC) : high ? PROT_ABOVE_REC : PROT_BELOW_REC),
    recovery: relation(recId, high ? '<' : '>', id, alarm ? (high ? REC_BELOW_ALARM : REC_ABOVE_ALARM) : high ? REC_BELOW_PROT : REC_ABOVE_PROT),
  };
};
const T_CHARGE_HIGH = tempPair('charge.otp', 'charge.otpr', 'high');
const T_DISCHARGE_HIGH = tempPair('discharge.otp', 'discharge.otpr', 'high');
const T_MOS_HIGH = tempPair('mos.otp', 'mos.otpr', 'high');
const T_CHARGE_LOW = tempPair('charge.utp', 'charge.utpr', 'low');
const T_DISCHARGE_LOW = tempPair('discharge.utp', 'discharge.utpr', 'low');
const A_CHARGE_HIGH = tempPair('ant.charge_ot_alarm', 'ant.charge_ot_alarm_recovery', 'high', true);
const A_DISCHARGE_HIGH = tempPair('ant.discharge_ot_alarm', 'ant.discharge_ot_alarm_recovery', 'high', true);
const A_MOS_HIGH = tempPair('ant.mos_ot_alarm', 'ant.mos_ot_alarm_recovery', 'high', true);
const A_CHARGE_LOW = tempPair('ant.charge_ut_alarm', 'ant.charge_ut_alarm_recovery', 'low', true);
const A_DISCHARGE_LOW = tempPair('ant.discharge_ut_alarm', 'ant.discharge_ut_alarm_recovery', 'low', true);

/**
 * One-shot ANT_NEW action field.
 * @param {string} id
 * @param {string} label
 * @param {number} action control code
 * @param {Partial<SettingField>} [overrides]
 */
function action(id, label, action, overrides = {}) {
  return field(id, { label, group: 'actions', type: 'action', ...overrides, meta: { kind: 'action', action } });
}

/** Password field shared by both generations; the value lives in the driver instance. */
function passwordField(description, maxLength) {
  return field('ant.password', { label: msg('BMS password'), group: 'identity', type: 'text', maxLength, description, secret: true, meta: { kind: 'local' } });
}

/**
 * Block reads used to load the ANT_NEW settings, at most 64 bytes each (spec 4.3, 7.1).
 * The system block (298) is not read: it is documented by the 2024 app only and may not exist on
 * 2021 firmware, which would only slow the settings load down.
 */
export const NEW_SETTING_BLOCKS = Object.freeze([
  { address: 0, length: 52, name: 'voltage' },
  { address: 56, length: 44, name: 'temperature' },
  { address: 104, length: 32, name: 'current' },
  { address: 140, length: 12, name: 'balance' },
  { address: 152, length: 64, name: 'battery' },
  { address: ADDR.PACK_ID, length: 32, name: 'pack id' },
  { address: 378, length: 18, name: 'other' },
]);

/**
 * Settings schema of the ANT_NEW protocol.
 * @param {{ serial?: boolean }} [opts] serial links also get the Bluetooth module on/off actions
 * @returns {SettingsSchema}
 */
export function buildAntSchema({ serial = false } = {}) {
  /** @type {SettingField[]} */
  const fields = [
    // Cell voltage (block 0, spec 7.1: E B Y C, values seen in captures).
    reg('cell.ovp', { address: 0, scale: 0.001 }, {
      ...CELL_V,
      validate: all(relation('cell.ovp', '>', 'cell.ovpr', PROT_ABOVE_REC), relation('cell.ovp', '<', 'ant.cell_ovp2', L1_BELOW_L2)),
    }),
    reg('cell.ovpr', { address: 2, scale: 0.001 }, { ...CELL_V, validate: relation('cell.ovpr', '<', 'cell.ovp', REC_BELOW_PROT) }),
    reg('ant.cell_ovp2', { address: 4, scale: 0.001 }, {
      ...cellV(msg('Cell overvoltage protection, level 2')),
      advanced: true,
      validate: all(relation('ant.cell_ovp2', '>', 'cell.ovp', L2_ABOVE_L1), relation('ant.cell_ovp2', '>', 'ant.cell_ovpr2', PROT_ABOVE_REC)),
    }),
    reg('ant.cell_ovpr2', { address: 6, scale: 0.001 }, {
      ...cellV(msg('Cell overvoltage recovery, level 2')),
      advanced: true,
      validate: relation('ant.cell_ovpr2', '<', 'ant.cell_ovp2', REC_BELOW_PROT),
    }),
    reg('cell.uvp', { address: 12, scale: 0.001 }, {
      ...CELL_V,
      validate: all(relation('cell.uvp', '<', 'cell.uvpr', PROT_BELOW_REC), relation('cell.uvp', '>', 'ant.cell_uvp2', L1_ABOVE_L2)),
    }),
    reg('cell.uvpr', { address: 14, scale: 0.001 }, { ...CELL_V, validate: relation('cell.uvpr', '>', 'cell.uvp', REC_ABOVE_PROT) }),
    reg('ant.cell_uvp2', { address: 16, scale: 0.001 }, {
      ...cellV(msg('Cell undervoltage protection, level 2')),
      advanced: true,
      validate: all(relation('ant.cell_uvp2', '<', 'cell.uvp', L2_BELOW_L1), relation('ant.cell_uvp2', '<', 'ant.cell_uvpr2', PROT_BELOW_REC)),
    }),
    reg('ant.cell_uvpr2', { address: 18, scale: 0.001 }, {
      ...cellV(msg('Cell undervoltage recovery, level 2')),
      advanced: true,
      validate: relation('ant.cell_uvpr2', '>', 'ant.cell_uvp2', REC_ABOVE_PROT),
    }),
    reg('cell.diff_protection', { address: 24, scale: 0.001 }, {
      ...CELL_DIFF,
      validate: relation('cell.diff_protection', '>', 'ant.cell_diff_recovery', PROT_ABOVE_REC),
    }),
    reg('ant.cell_diff_recovery', { address: 26, scale: 0.001 }, {
      ...cellDiff(msg('Cell voltage difference recovery')),
      validate: relation('ant.cell_diff_recovery', '<', 'cell.diff_protection', REC_BELOW_PROT),
    }),
    reg('cell.ov_alarm', { address: 32, scale: 0.001 }, { ...CELL_V, validate: relation('cell.ov_alarm', '>', 'ant.cell_ov_alarm_recovery', ALARM_ABOVE_REC) }),
    reg('ant.cell_ov_alarm_recovery', { address: 34, scale: 0.001 }, {
      ...cellV(msg('Cell high voltage alarm recovery')),
      advanced: true,
      validate: relation('ant.cell_ov_alarm_recovery', '<', 'cell.ov_alarm', REC_BELOW_ALARM),
    }),
    reg('cell.uv_alarm', { address: 40, scale: 0.001 }, { ...CELL_V, validate: relation('cell.uv_alarm', '<', 'ant.cell_uv_alarm_recovery', ALARM_BELOW_REC) }),
    reg('ant.cell_uv_alarm_recovery', { address: 42, scale: 0.001 }, {
      ...cellV(msg('Cell low voltage alarm recovery')),
      advanced: true,
      validate: relation('ant.cell_uv_alarm_recovery', '>', 'cell.uv_alarm', REC_ABOVE_ALARM),
    }),
    reg('cell.diff_alarm', { address: 48, scale: 0.001 }, {
      ...CELL_DIFF,
      validate: relation('cell.diff_alarm', '>', 'ant.cell_diff_alarm_recovery', ALARM_ABOVE_REC),
    }),
    reg('ant.cell_diff_alarm_recovery', { address: 50, scale: 0.001 }, {
      ...cellDiff(msg('Cell voltage difference alarm recovery')),
      advanced: true,
      validate: relation('ant.cell_diff_alarm_recovery', '<', 'cell.diff_alarm', REC_BELOW_ALARM),
    }),

    // Pack voltage (block 0).
    reg('pack.ovp', { address: 8, scale: 0.1 }, { ...PACK_V, validate: relation('pack.ovp', '>', 'pack.ovpr', PROT_ABOVE_REC) }),
    reg('pack.ovpr', { address: 10, scale: 0.1 }, { ...PACK_V, validate: relation('pack.ovpr', '<', 'pack.ovp', REC_BELOW_PROT) }),
    reg('pack.uvp', { address: 20, scale: 0.1 }, { ...PACK_V, validate: relation('pack.uvp', '<', 'pack.uvpr', PROT_BELOW_REC) }),
    reg('pack.uvpr', { address: 22, scale: 0.1 }, { ...PACK_V, validate: relation('pack.uvpr', '>', 'pack.uvp', REC_ABOVE_PROT) }),
    reg('pack.ov_alarm', { address: 36, scale: 0.1 }, { ...PACK_V, validate: relation('pack.ov_alarm', '>', 'ant.pack_ov_alarm_recovery', ALARM_ABOVE_REC) }),
    reg('ant.pack_ov_alarm_recovery', { address: 38, scale: 0.1 }, {
      ...packV(msg('Pack high voltage alarm recovery')),
      advanced: true,
      validate: relation('ant.pack_ov_alarm_recovery', '<', 'pack.ov_alarm', REC_BELOW_ALARM),
    }),
    reg('pack.uv_alarm', { address: 44, scale: 0.1 }, { ...PACK_V, validate: relation('pack.uv_alarm', '<', 'ant.pack_uv_alarm_recovery', ALARM_BELOW_REC) }),
    reg('ant.pack_uv_alarm_recovery', { address: 46, scale: 0.1 }, {
      ...packV(msg('Pack low voltage alarm recovery')),
      advanced: true,
      validate: relation('ant.pack_uv_alarm_recovery', '>', 'pack.uv_alarm', REC_ABOVE_ALARM),
    }),

    // Temperature (block 56): documented by the 2024 app map; read correctly on hardware and
    // writable since 2026-11-23 (see TEMP_NOTE, spec 7.1). High protections u16, the rest i16.
    reg('charge.otp', { address: 56 }, { decimals: 0, ...TEMP, validate: T_CHARGE_HIGH.limit }),
    reg('charge.otpr', { address: 58 }, { decimals: 0, ...TEMP, validate: T_CHARGE_HIGH.recovery }),
    reg('discharge.otp', { address: 60 }, { decimals: 0, ...TEMP, validate: T_DISCHARGE_HIGH.limit }),
    reg('discharge.otpr', { address: 62 }, { decimals: 0, ...TEMP, validate: T_DISCHARGE_HIGH.recovery }),
    reg('mos.otp', { address: 64 }, { decimals: 0, ...TEMP, validate: T_MOS_HIGH.limit }),
    reg('mos.otpr', { address: 66 }, { decimals: 0, ...TEMP, validate: T_MOS_HIGH.recovery }),
    reg('charge.utp', { address: 68, signed: true }, { decimals: 0, ...TEMP, validate: T_CHARGE_LOW.limit }),
    reg('charge.utpr', { address: 70, signed: true }, { decimals: 0, ...TEMP, validate: T_CHARGE_LOW.recovery }),
    reg('discharge.utp', { address: 72, signed: true }, { decimals: 0, ...TEMP, validate: T_DISCHARGE_LOW.limit }),
    reg('discharge.utpr', { address: 74, signed: true }, { decimals: 0, ...TEMP, validate: T_DISCHARGE_LOW.recovery }),
    reg('ant.charge_ot_alarm', { address: 76, signed: true }, { ...degrees(msg('Charge high temperature alarm')), validate: A_CHARGE_HIGH.limit }),
    reg('ant.charge_ot_alarm_recovery', { address: 78, signed: true }, { ...degrees(msg('Charge high temperature alarm recovery')), advanced: true, validate: A_CHARGE_HIGH.recovery }),
    reg('ant.discharge_ot_alarm', { address: 80, signed: true }, { ...degrees(msg('Discharge high temperature alarm')), validate: A_DISCHARGE_HIGH.limit }),
    reg('ant.discharge_ot_alarm_recovery', { address: 82, signed: true }, { ...degrees(msg('Discharge high temperature alarm recovery')), advanced: true, validate: A_DISCHARGE_HIGH.recovery }),
    reg('ant.mos_ot_alarm', { address: 84, signed: true }, { ...degrees(msg('MOSFET high temperature alarm')), validate: A_MOS_HIGH.limit }),
    reg('ant.mos_ot_alarm_recovery', { address: 86, signed: true }, { ...degrees(msg('MOSFET high temperature alarm recovery')), advanced: true, validate: A_MOS_HIGH.recovery }),
    reg('ant.charge_ut_alarm', { address: 88, signed: true }, { ...degrees(msg('Charge low temperature alarm')), validate: A_CHARGE_LOW.limit }),
    reg('ant.charge_ut_alarm_recovery', { address: 90, signed: true }, { ...degrees(msg('Charge low temperature alarm recovery')), advanced: true, validate: A_CHARGE_LOW.recovery }),
    reg('ant.discharge_ut_alarm', { address: 92, signed: true }, { ...degrees(msg('Discharge low temperature alarm')), validate: A_DISCHARGE_LOW.limit }),
    reg('ant.discharge_ut_alarm_recovery', { address: 94, signed: true }, { ...degrees(msg('Discharge low temperature alarm recovery')), advanced: true, validate: A_DISCHARGE_LOW.recovery }),

    // Current (block 104, E B Y; 104..110 also written in captures).
    reg('charge.ocp', { address: 104, scale: 0.1 }, CURRENT),
    reg('charge.ocp_delay', { address: 106 }, DELAY_S),
    reg('discharge.ocp', { address: 108, scale: 0.1 }, CURRENT),
    reg('discharge.ocp_delay', { address: 110 }, DELAY_S),
    reg('discharge.ocp2', { address: 112, scale: 0.1 }, { ...CURRENT, max: 2000 }),
    reg('discharge.ocp2_delay', { address: 114 }, { min: 0, max: 60000 }),
    reg('scp.current', { address: 116 }, { min: 1, max: 5000 }),
    reg('scp.delay', { address: 118 }, { min: 0, max: 65000 }),
    reg('charge.oc_alarm', { address: 124, scale: 0.1 }, CURRENT),
    reg('ant.charge_oc_alarm_recovery', { address: 126, scale: 0.1 }, { ...amps(msg('Charge overcurrent alarm recovery')), advanced: true }),
    reg('discharge.oc_alarm', { address: 128, scale: 0.1 }, CURRENT),
    reg('ant.discharge_oc_alarm_recovery', { address: 130, scale: 0.1 }, { ...amps(msg('Discharge overcurrent alarm recovery')), advanced: true }),

    // SOC warnings (block 104).
    reg('soc.low_alarm', { address: 132 }, { min: 0, max: 100, validate: relation('soc.low_alarm', '>=', 'ant.soc_low_alarm2', SOC1_NOT_BELOW_SOC2) }),
    reg('ant.soc_low_alarm2', { address: 134 }, {
      label: msg('Low SOC alarm, level 2'),
      group: 'capacity',
      unit: '%',
      decimals: 0,
      min: 0,
      max: 100,
      validate: relation('ant.soc_low_alarm2', '<=', 'soc.low_alarm', SOC2_NOT_ABOVE_SOC1),
    }),

    // Balancing (block 140, E B Y).
    reg('ant.balance_limit_voltage', { address: 140, scale: 0.001 }, {
      label: msg('Balance limit voltage'),
      group: 'balancing',
      unit: 'V',
      decimals: 3,
      ...CELL_V,
      description: msg('No balancing above this cell voltage'),
      validate: relation('ant.balance_limit_voltage', '>=', 'balance.start_voltage', LIMIT_NOT_BELOW_START),
    }),
    reg('balance.start_voltage', { address: 142, scale: 0.001 }, {
      ...CELL_V,
      description: msg('Balancing while charging starts above this cell voltage'),
      validate: relation('balance.start_voltage', '<=', 'ant.balance_limit_voltage', START_NOT_ABOVE_LIMIT),
    }),
    reg('balance.trigger_delta', { address: 144, scale: 0.001 }, {
      ...CELL_DIFF,
      validate: relation('balance.trigger_delta', '>', 'ant.balance_stop_delta', START_ABOVE_STOP),
    }),
    reg('ant.balance_stop_delta', { address: 146, scale: 0.001 }, {
      label: msg('Balance stop voltage difference'),
      group: 'balancing',
      unit: 'V',
      decimals: 3,
      ...CELL_DIFF,
      validate: relation('ant.balance_stop_delta', '<', 'balance.trigger_delta', STOP_BELOW_START),
    }),
    // Unit disputed: mA in ESPHome and the PC tool, unit "N" in the 2024 app map (spec 7.1).
    roReg('ant.balance_current', { address: 148 }, { label: msg('Balance current'), group: 'balancing', unit: 'mA', decimals: 0 }),
    reg('ant.balance_charge_current', { address: 150, scale: 0.1 }, {
      label: msg('Balance charging current'),
      group: 'balancing',
      unit: 'A',
      decimals: 1,
      min: 0,
      max: 1000,
      advanced: true,
    }),

    // Battery (block 152). Register 152 (cell type) is left out: its value encoding is unverified;
    // the "load defaults" actions are the recommended way to switch chemistry (spec 7.1).
    reg('system.cell_count', { address: 154 }, { min: 1, max: 32, step: 1, danger: true, advanced: true }),
    // Scale disputed (0.1 or 1 milliohm, spec 7.1): the raw register value is shown without unit.
    roReg('ant.ir_compensation', { address: 156 }, {
      label: msg('Undervoltage internal resistance compensation (raw value)'),
      group: 'system',
      decimals: 0,
      advanced: true,
    }),
    reg('cell.power_off_voltage', { address: 158, scale: 0.001 }, CELL_V),
    reg('ant.charge_request_current', { address: 160, scale: 0.1 }, {
      label: msg('Maximum requested charge current'),
      group: 'charging',
      unit: 'A',
      decimals: 1,
      min: 0,
      max: 1000,
      advanced: true,
    }),
    // u32 capacity registers: unit disputed between sources (spec 7.3), resolved for display only.
    roReg('capacity.nominal', { address: 162, size: 4, format: 'capacity' }, { description: CAPACITY_UNCONFIRMED }),
    roReg('capacity.remaining', { address: 166, size: 4, format: 'capacity' }, { description: CAPACITY_UNCONFIRMED, advanced: true }),
    // SOC versus open circuit voltage table, 2024 app map only.
    roReg('charge.soc100_voltage', { address: 174, scale: 0.001 }, { advanced: true }),
    roReg('ant.ocv_90', { address: 176, scale: 0.001 }, ocv(msg('Cell voltage at 90 % SOC'))),
    roReg('ant.ocv_80', { address: 178, scale: 0.001 }, ocv(msg('Cell voltage at 80 % SOC'))),
    roReg('ant.ocv_70', { address: 180, scale: 0.001 }, ocv(msg('Cell voltage at 70 % SOC'))),
    roReg('ant.ocv_60', { address: 182, scale: 0.001 }, ocv(msg('Cell voltage at 60 % SOC'))),
    roReg('ant.ocv_50', { address: 184, scale: 0.001 }, ocv(msg('Cell voltage at 50 % SOC'))),
    roReg('ant.ocv_40', { address: 186, scale: 0.001 }, ocv(msg('Cell voltage at 40 % SOC'))),
    roReg('ant.ocv_30', { address: 188, scale: 0.001 }, ocv(msg('Cell voltage at 30 % SOC'))),
    roReg('ant.ocv_20', { address: 190, scale: 0.001 }, ocv(msg('Cell voltage at 20 % SOC'))),
    roReg('ant.ocv_10', { address: 192, scale: 0.001 }, ocv(msg('Cell voltage at 10 % SOC'))),
    roReg('charge.soc0_voltage', { address: 194, scale: 0.001 }, { advanced: true }),
    // 196 (SOC calibration method, values unknown) and 198..260 (wire resistance, 2024 app only)
    // are not exposed.

    // Other group (block 378, E B Y).
    reg('ant.wheel_circumference', { address: 378 }, { label: msg('Wheel circumference'), group: 'system', unit: 'mm', decimals: 0, min: 0, max: 65000, advanced: true }),
    reg('ant.wheel_pulses', { address: 380 }, { label: msg('Pulses per wheel revolution'), group: 'system', decimals: 0, min: 0, max: 65000, advanced: true }),
    reg('ant.slave_modules', { address: 382 }, { label: msg('Number of slave modules'), group: 'system', decimals: 0, min: 0, max: 255, advanced: true }),

    // Identity.
    reg('ant.pack_id', { address: ADDR.PACK_ID, size: 32, format: 'ascii' }, {
      label: msg('Battery ID'),
      group: 'identity',
      type: 'text',
      maxLength: 32,
      description: BATTERY_ID_NOTE,
    }),
    passwordField(
      msg(
        'Level 5 password, sent with function 0x23 before every write, switch and action. Factory default 123456789abc. It is kept in this app only and never read from the BMS.',
      ),
      12,
    ),

    // Switches (spec 8).
    field('switch.charge', { description: MOS_SWITCH_NOTE, meta: { kind: 'control', on: CONTROL.CHARGE_ON, off: CONTROL.CHARGE_OFF } }),
    field('switch.discharge', { description: MOS_SWITCH_NOTE, meta: { kind: 'control', on: CONTROL.DISCHARGE_ON, off: CONTROL.DISCHARGE_OFF } }),
    field('switch.balance', {
      description: msg('Starts or stops manual balancing. The state shows whether the balancer is working, automatically or manually.'),
      meta: { kind: 'control', on: CONTROL.BALANCE_ON, off: CONTROL.BALANCE_OFF },
    }),
    field('switch.buzzer', {
      description: msg('The BMS does not report the buzzer state; the switch shows the last command sent from this app.'),
      meta: { kind: 'control', on: CONTROL.BUZZER_ON, off: CONTROL.BUZZER_OFF },
    }),

    // One-shot actions (spec 5.5, 8).
    action('ant.current_zero', msg('Zero current calibration'), CONTROL.CURRENT_ZERO, {
      danger: true,
      description: msg('Sets the current reading to zero. Run it only while no current flows.'),
    }),
    action('ant.restart', msg('Restart BMS'), CONTROL.RESTART, { danger: true, description: msg('Restarts the BMS. The output may be interrupted while it restarts.') }),
    action('ant.shutdown', msg('Switch BMS off'), CONTROL.SHUTDOWN, { danger: true, description: msg('The BMS powers itself off and the connection is lost.') }),
    action('ant.factory_reset', msg('Factory reset'), CONTROL.FACTORY_RESET, {
      danger: true,
      advanced: true,
      description: msg('Restores the factory settings of the BMS. All protection parameters are overwritten.'),
    }),
    action('ant.defaults_lfp', msg('Load LiFePO4 defaults'), CONTROL.DEFAULTS_LFP, {
      danger: true,
      advanced: true,
      description: msg('Overwrites the protection parameters with the vendor defaults for LiFePO4 cells.'),
    }),
    action('ant.defaults_nmc', msg('Load ternary lithium (NMC) defaults'), CONTROL.DEFAULTS_NMC, {
      danger: true,
      advanced: true,
      description: msg('Overwrites the protection parameters with the vendor defaults for ternary lithium (NMC) cells.'),
    }),
    action('ant.defaults_lto', msg('Load lithium titanate (LTO) defaults'), CONTROL.DEFAULTS_LTO, {
      danger: true,
      advanced: true,
      description: msg('Overwrites the protection parameters with the vendor defaults for lithium titanate (LTO) cells.'),
    }),
    action('ant.clear_log', msg('Clear system log'), CONTROL.CLEAR_LOG, { advanced: true }),
    action('ant.clear_discharge_ah', msg('Clear discharge cycle Ah'), CONTROL.CLEAR_DISCHARGE_AH, { advanced: true }),
    action('ant.clear_charge_ah', msg('Clear charge cycle Ah'), CONTROL.CLEAR_CHARGE_AH, { advanced: true }),
    action('ant.clear_discharge_time', msg('Clear discharge time'), CONTROL.CLEAR_DISCHARGE_TIME, { advanced: true }),
    action('ant.clear_charge_time', msg('Clear charge time'), CONTROL.CLEAR_CHARGE_TIME, { advanced: true }),
    action('ant.clear_runtime', msg('Clear running time'), CONTROL.CLEAR_RUNTIME, { advanced: true }),
    action('ant.clear_protect_time', msg('Clear protection time'), CONTROL.CLEAR_PROTECT_TIME, { advanced: true }),
  ];
  // Bluetooth off cuts a Bluetooth link, so the module switch is offered on the UART only (spec 12.2 item 21).
  if (serial) {
    fields.push(
      action('ant.bluetooth_off', msg('Switch Bluetooth off'), CONTROL.BLUETOOTH_OFF, {
        advanced: true,
        description: msg('Disables the Bluetooth module of the BMS. Offered on the serial port only, because it would cut a Bluetooth connection.'),
      }),
      action('ant.bluetooth_on', msg('Switch Bluetooth on'), CONTROL.BLUETOOTH_ON, { advanced: true }),
    );
  }
  return buildSchema(fields);
}

/** @param {string} label */
function ocv(label) {
  return { label, group: 'capacity', unit: 'V', decimals: 3, advanced: true };
}

// ---------------------------------------------------------------------------------------------
// ANT_NEW conversion
// ---------------------------------------------------------------------------------------------

/**
 * Sparse image of the parameter area: byte address to byte value, filled by block reads.
 * @returns {Map<number, number>}
 */
export function createRegisterImage() {
  return new Map();
}

/**
 * Store the data of a 0x12 answer in the image.
 * @param {Map<number, number>} image
 * @param {number} address start address of the answer
 * @param {ArrayLike<number>} data
 */
export function storeBlock(image, address, data) {
  for (let i = 0; i < data.length; i++) image.set(address + i, data[i]);
}

/**
 * Raw register value at an address, or undefined when not (completely) read.
 * @param {Map<number, number>} image
 * @param {number} address
 * @param {number} size 2 or 4
 */
export function rawRegister(image, address, size) {
  let raw = 0;
  for (let i = size - 1; i >= 0; i--) {
    const b = image.get(address + i);
    if (b === undefined) return undefined;
    raw = raw * 256 + b;
  }
  return raw;
}

/**
 * Engineering value of a raw register value. 0xFFFF (u16) and 0xFFFFFFFF (u32) mean "not
 * configured" and give undefined (spec 6.2).
 * @param {RegisterMeta} meta
 * @param {number} raw
 * @param {number} [decimals]
 * @returns {number | undefined}
 */
export function rawToValue(meta, raw, decimals = 3) {
  const size = meta.size ?? 2;
  if ((size === 2 && raw === 0xffff) || (size === 4 && raw === 0xffffffff)) return undefined;
  const v = meta.signed && size === 2 && raw >= 0x8000 ? raw - 0x10000 : raw;
  return round(v * (meta.scale ?? 1), decimals);
}

/**
 * Raw register value for an engineering value. Throws when the value cannot be encoded.
 * @param {RegisterMeta} meta
 * @param {number} value
 * @returns {number}
 */
/**
 * NUL padded ASCII bytes of a text register (battery ID). Printable ASCII only, at most the
 * register size.
 * @param {RegisterMeta} meta
 * @param {string} value
 * @returns {Uint8Array}
 */
export function asciiToBytes(meta, value) {
  const text = String(value ?? '');
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error(msg('Only ASCII letters, digits and symbols are allowed'));
  const size = meta.size ?? 2;
  if (text.length > size) throw new Error(msg('The text is too long'));
  const bytes = new Uint8Array(size);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/**
 * Raw register value of an engineering value.
 * @param {RegisterMeta} meta
 * @param {number} value
 * @returns {number}
 */
export function valueToRaw(meta, value) {
  const raw = Math.round(value / (meta.scale ?? 1));
  const size = meta.size ?? 2;
  if (!Number.isFinite(raw)) throw new Error(msg('Invalid value'));
  if (size === 2 && meta.signed) {
    if (raw < -0x8000 || raw > 0x7fff) throw new Error(msg('The value is out of the register range'));
    return raw & 0xffff;
  }
  // 0xFFFF is reserved for "not configured".
  const max = size === 4 ? 0xfffffffe : 0xfffe;
  if (raw < 0 || raw > max) throw new Error(msg('The value is out of the register range'));
  return raw;
}

/**
 * Decode one register field from the image.
 * @param {SettingField} f
 * @param {Map<number, number>} image
 * @param {{ capacityUnit?: number }} [ctx] unit of the u32 capacity registers in Ah per raw step
 */
export function decodeField(f, image, ctx = {}) {
  const meta = /** @type {RegisterMeta} */ (f.meta);
  if (meta.format === 'ascii') {
    const bytes = [];
    for (let i = 0; i < meta.size; i++) {
      const b = image.get(meta.address + i);
      if (b === undefined) return undefined;
      bytes.push(b);
    }
    let s = '';
    for (const b of bytes) {
      if (b === 0x00 || b === 0xff) break;
      if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    }
    return s.trim();
  }
  const raw = rawRegister(image, meta.address, meta.size ?? 2);
  if (raw === undefined) return undefined;
  if (meta.format === 'capacity') {
    if (ctx.capacityUnit === undefined || raw === 0xffffffff) return undefined;
    return round(raw * ctx.capacityUnit, f.decimals ?? 1);
  }
  return rawToValue(meta, raw, f.decimals ?? 3);
}

/**
 * Unit of the disputed u32 capacity registers (spec 7.3): compare register 162 with the full
 * capacity of the status frame. Raw equal to the status raw value means micro Ah, raw equal to
 * the capacity in Ah means Ah. Undefined when neither matches.
 * @param {Map<number, number>} image
 * @param {number | undefined} statusCapacityAh full capacity from the status frame
 * @returns {number | undefined} Ah per raw step
 */
export function capacityUnit(image, statusCapacityAh) {
  const raw = rawRegister(image, 162, 4);
  if (raw === undefined || statusCapacityAh === undefined || !(statusCapacityAh > 0)) return undefined;
  if (raw === Math.round(statusCapacityAh * 1e6)) return 1e-6;
  if (raw === Math.round(statusCapacityAh)) return 1;
  return undefined;
}

/**
 * Values of every register field present in the image (absent and unconfigured registers are
 * left out, so the session does not report them as mismatches).
 * @param {SettingsSchema} schema
 * @param {Map<number, number>} image
 * @param {{ capacityUnit?: number }} [ctx]
 * @returns {Record<string, any>}
 */
export function decodeSettings(schema, image, ctx = {}) {
  /** @type {Record<string, any>} */
  const values = {};
  for (const g of schema.groups) {
    for (const f of g.fields) {
      if (f.meta?.kind !== 'register') continue;
      const v = decodeField(f, image, ctx);
      if (v !== undefined) values[f.id] = v;
    }
  }
  return values;
}

/**
 * Find the register field at an address (tests and tools).
 * @param {SettingsSchema} schema
 * @param {number} address
 */
export function fieldAtAddress(schema, address) {
  for (const g of schema.groups) for (const f of g.fields) if (f.meta?.kind === 'register' && f.meta.address === address) return f;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// ANT_OLD (legacy) schema
// ---------------------------------------------------------------------------------------------

/**
 * Read-only ANT_OLD parameter (spec 7.4, rows where the decompiled enum and the PC tool list agree
 * on the scale; disputed rows are left out).
 * @param {string} id
 * @param {number} param parameter number
 * @param {number} scale
 * @param {Partial<SettingField>} [overrides]
 * @param {{ signed?: boolean, highParam?: number }} [extra]
 */
function oldParam(id, param, scale, overrides = {}, extra = {}) {
  return field(id, { description: LEGACY_READ_ONLY, ...overrides, readOnly: true, meta: { kind: 'old-param', param, scale, ...extra } });
}

/**
 * Settings schema of the ANT_OLD protocol: parameters are read only (no parameter write is
 * captured, spec 7.4); the MOSFET switches use the captured control frames (spec 5.6).
 * @returns {SettingsSchema}
 */
export function buildAntLegacySchema() {
  const fields = [
    oldParam('cell.ovp', 3, 0.001),
    oldParam('cell.ovpr', 5, 0.001),
    oldParam('cell.uvp', 4, 0.001),
    oldParam('cell.uvpr', 6, 0.001),
    oldParam('cell.ov_alarm', 1, 0.001),
    oldParam('cell.uv_alarm', 2, 0.001),
    oldParam('cell.diff_protection', 44, 0.001),
    oldParam('cell.power_off_voltage', 43, 0.001),
    oldParam('pack.ovp', 7, 0.1),
    oldParam('pack.uvp', 8, 0.1),
    oldParam('charge.ocp', 9, 0.1),
    oldParam('charge.ocp_delay', 10, 1),
    oldParam('discharge.ocp', 11, 0.1),
    oldParam('discharge.ocp_delay', 12, 1),
    oldParam('discharge.ocp2', 162, 0.1),
    oldParam('scp.delay', 21, 1),
    oldParam('charge.otp', 25, 1, { decimals: 0 }, { signed: true }),
    oldParam('charge.otpr', 26, 1, { decimals: 0 }, { signed: true }),
    oldParam('discharge.otp', 27, 1, { decimals: 0 }, { signed: true }),
    oldParam('discharge.otpr', 28, 1, { decimals: 0 }, { signed: true }),
    oldParam('mos.otp', 29, 1, { decimals: 0 }, { signed: true }),
    oldParam('mos.otpr', 30, 1, { decimals: 0 }, { signed: true }),
    oldParam('ant.balance_limit_voltage', 13, 0.001, { label: msg('Balance limit voltage'), group: 'balancing', unit: 'V', decimals: 3 }),
    oldParam('balance.start_voltage', 14, 0.001),
    oldParam('balance.trigger_delta', 15, 0.001),
    oldParam('ant.balance_current', 16, 10, { label: msg('Balance current'), group: 'balancing', unit: 'mA', decimals: 0 }),
    oldParam('capacity.nominal', 31, 1e-6, { decimals: 1 }, { highParam: 32 }),
    oldParam('system.cell_count', 24, 1, { decimals: 0 }),
    oldParam('system.sleep_delay', 22, 1),
    oldParam('ant.current_sensor_range', 18, 0.1, { label: msg('Current sensor range'), group: 'system', unit: 'A', decimals: 1, advanced: true }),
    oldParam('ant.startup_current', 19, 1, { label: msg('Startup current'), group: 'system', unit: 'A', decimals: 0, advanced: true }),
    oldParam('ant.slave_modules', 45, 1, { label: msg('Number of slave modules'), group: 'system', decimals: 0, advanced: true }),
    oldParam('ant.wheel_circumference', 41, 1, { label: msg('Wheel circumference'), group: 'system', unit: 'mm', decimals: 0, advanced: true }),
    oldParam('ant.wheel_pulses', 42, 1, { label: msg('Pulses per wheel revolution'), group: 'system', decimals: 0, advanced: true }),
    passwordField(
      msg('Password sent as four A5 A5 F1..F4 frames before every switch and action command. It is kept in this app only and never read from the BMS. 12345678 is the value seen in captured sessions.'),
      8,
    ),
    field('switch.charge', { description: MOS_SWITCH_NOTE, meta: { kind: 'old-control', address: OLD_CONTROL.CHARGE } }),
    field('switch.discharge', { description: MOS_SWITCH_NOTE, meta: { kind: 'old-control', address: OLD_CONTROL.DISCHARGE } }),
    field('ant.balance_toggle', {
      label: msg('Toggle automatic balancing'),
      group: 'actions',
      type: 'action',
      description: msg('The old protocol only offers a toggle; the BMS does not report whether automatic balancing is enabled.'),
      meta: { kind: 'old-action', address: OLD_CONTROL.BALANCE_TOGGLE },
    }),
    field('ant.restart', {
      label: msg('Restart BMS'),
      group: 'actions',
      type: 'action',
      danger: true,
      description: msg('Restarts the BMS. The output may be interrupted while it restarts.'),
      meta: { kind: 'old-action', address: OLD_CONTROL.REBOOT },
    }),
  ];
  return buildSchema(fields);
}

/**
 * Engineering value of an ANT_OLD parameter (u16be per parameter; u32 split over two parameters,
 * low word first, spec 7.4).
 * @param {SettingField} f
 * @param {number} raw u16 (or combined u32)
 */
export function legacyValue(f, raw) {
  const meta = f.meta;
  const v = meta.signed && raw >= 0x8000 && !meta.highParam ? raw - 0x10000 : raw;
  return round(v * meta.scale, f.decimals ?? 3);
}

/** Initial value of the password field per generation (factory default, or the captured value for ANT_OLD). */
export const DEFAULT_PASSWORDS = Object.freeze({ new: DEFAULT_PASSWORD_L5, old: OLD_CAPTURED_PASSWORD });
