import { field, buildSchema, relation, msg } from '@ubms/bms-core';
import { r } from '../common/util.js';
import {
  CMD,
  CONTROL_BITS,
  JK02_DEVICE_SETTINGS,
  JK02_SETTINGS,
  JK04_SETTINGS_LAYOUT,
  PB_CONTROLS_REGISTER,
  UART_ID,
  VARIANT,
  controlBitRegister,
  encodeJk04Write,
  encodeWrite,
  pbSettingsRegister,
  pbWriteU16,
  pbWriteU32,
} from './protocol.js';

/**
 * JK settings schemas and raw/engineering conversion (docs/protocols/jk.md sections 6.2, 7, 8).
 *
 * One schema per protocol variant and link, because the write registers differ: JK02_32S and
 * JK02_24S share registers 0x01..0x20 but differ from 0x21 on (spec 12 item 5), JK04 uses float32
 * values at other registers, JK-PB over RS485 writes Modbus registers, and the 4E57 UART port
 * only takes the switch writes. Nothing is written before the variant is confirmed (the driver
 * reports `writeSettings: false` until then).
 *
 * Safety rule: a value whose register, unit or encoding the specification marks unverified,
 * inferred or conflicting is `readOnly` (shown, never written) with a description saying so; a
 * value without a known write register is read only as well. Limits are the input ranges used by
 * ESPHome and batmon-ha (spec 7: the BMS's own limits are not documented).
 *
 * Field `meta` (driver private):
 * - `kind`: 'reg' (value of a parsed frame), 'bit' (controls bitmask S282), 'calibration'
 *   (write only), 'action' (button), 'command' (one-shot write of a fixed value), 'soc' (SOC
 *   calibration), 'wire' (wire resistance), 'uart' (4E57 data id)
 * - `source`: 'settings' | 'device' | 'cell' | 'uart', the parsed frame holding the value
 * - `name`: field name in that parsed frame; `scale`: engineering value = raw x scale
 * - `write`: `{ link: 'ble', register, length, float? }`, `{ link: 'pb', register, size, bit? }`,
 *   `{ link: 'uart', dataId }` or null
 * - `guard`: `{ nonZero }` or `{ min }`: the current value shows whether the firmware supports
 *   the setting; the driver refuses the write otherwise
 *
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 *
 * @typedef {{ link: 'ble', register: number, length: 1|2|4, float?: boolean }
 *   | { link: 'pb', register: number, size: 2|4, bit?: number }
 *   | { link: 'uart', dataId: number }} WriteTarget
 */

// Descriptions ---------------------------------------------------------------------------------

const UNCONFIRMED = msg('The encoding of this value is not confirmed yet, so it is shown but never written.');
const NO_WRITE = msg('No write command is known for this value, so it is shown but never written.');
const NO_RS485_WRITE = msg('No RS485 write register is known for this value, so it is shown but never written.');
const PB_BYTE_ORDER = msg('The byte order of this RS485 register is not confirmed, so the value is shown but never written over RS485.');
const PB_PORT_MODE = msg('Changing the port mode over the RS485 link could cut the connection, so it is not written over RS485.');
const INFERRED_SWITCH = msg('The write command of this switch is inferred and not confirmed, so it is shown but never written.');
const SCP_DELAY = msg(
  'The unit differs between firmware versions (microseconds on older firmware, unknown from firmware 15.26 on), so this value is shown but never written.',
);
const SLEEP_VOLTAGE = msg('Some firmware versions report a value of unknown meaning here; it is hidden then and not written.');
const SLEEP_VOLTAGE_24S = msg('The meaning of this value on firmware below 11 is unknown, so it is shown but never written.');
const FEATURE_ZERO = msg('Reads 0 when the firmware lacks this feature; it is not written then.');
const HEATING_FIRMWARE = msg('Used by newer firmware (JK-PB hardware 15A with firmware 15.41 or later); older units heat according to the charge undertemperature settings.');
const WIRE_RESISTANCE = msg('Milliohm according to most sources (not confirmed). No write command is known, so it is shown but never written.');
const UART_READ_ONLY = msg('Only the MOSFET and balancer switches can be written over this port; other values are shown but never written.');
const PROTOCOL_CHANGE = msg('A connected inverter or display stops communicating until it uses the same protocol.');
const CELL_COUNT = msg('Must match the number of connected cells. A wrong value disables cell protection or raises alarms.');

// Cross-field messages -------------------------------------------------------------------------

const PROT_ABOVE_REC = msg('Protection must be above its recovery value');
const REC_BELOW_PROT = msg('Recovery must be below protection');
const PROT_BELOW_REC = msg('Protection must be below its recovery value');
const REC_ABOVE_PROT = msg('Recovery must be above protection');
const OVPR_ABOVE_UVPR = msg('Overvoltage recovery must be above undervoltage recovery');
const UVPR_BELOW_OVPR = msg('Undervoltage recovery must be below overvoltage recovery');
const UVP_ABOVE_POWER_OFF = msg('Undervoltage protection must be above the power off voltage');
const POWER_OFF_BELOW_UVP = msg('Power off voltage must be below undervoltage protection');
const OVP_ABOVE_CHARGE = msg('Overvoltage protection must be above the charge, float and 100 % SOC voltages');
const CHARGE_BELOW_OVP = msg('Must be below overvoltage protection');
const RCV_ABOVE_RFV = msg('Charge request voltage must be above the float voltage');
const RFV_BELOW_RCV = msg('Float voltage must be below the charge request voltage');
const RCV_NOT_BELOW_SOC100 = msg('Charge request voltage must not be below the 100 % SOC voltage');
const SOC100_NOT_ABOVE_RCV = msg('100 % SOC voltage must not exceed the charge request voltage');
const SOC100_ABOVE_SOC0 = msg('100 % SOC voltage must be above the 0 % SOC voltage');
const SOC0_BELOW_SOC100 = msg('0 % SOC voltage must be below the 100 % SOC voltage');
const OVP_ABOVE_BALANCE = msg('Overvoltage protection must be above the balance start voltage');
const BALANCE_BELOW_OVP = msg('Balance start voltage must be below overvoltage protection');
const HEAT_START_BELOW_STOP = msg('Heating start temperature must be below the stop temperature');
const HEAT_STOP_ABOVE_START = msg('Heating stop temperature must be above the start temperature');

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
 * `relation` that is skipped while either value is 0 (feature absent, spec 7.8).
 * @param {string} a
 * @param {'>'|'<'|'>='|'<='} op
 * @param {string} b
 * @param {string} message
 */
const relSet = (a, op, b, message) => {
  const check = relation(a, op, b, message);
  return (/** @type {Record<string, any>} */ values) => (values[a] === 0 || values[b] === 0 ? null : check(values));
};

// Options --------------------------------------------------------------------------------------

/** UART protocol index (spec 9.6); newer firmware may report other numbers. */
const UART_PROTOCOLS = [
  msg('4G-GPS remote module common protocol V4.2'),
  msg('JK BMS RS485 Modbus V1.0'),
  msg('NIU U series'),
  msg('China Tower shared battery cabinet V1.1'),
  msg('PACE RS485 Modbus V1.3'),
  msg('Pylon low voltage RS485 V3.5'),
  msg('Growatt BMS RS485 1xSxxP ESS Rev 2.01'),
  msg('Voltronic inverter and BMS 485 (2020-03-25)'),
  msg('China Tower shared battery cabinet V2.0'),
  msg('WOW RS485 Modbus V1.3'),
  msg('JK BMS LCD protocol V2.0'),
  msg('UART1 user customization'),
  msg('UART2 user customization'),
  msg('JK BMS RS485 Modbus V1.0 at 9600 baud'),
  msg('Pylon low voltage RS485 V3.5 at 9600 baud'),
  msg('JK BMS PBxx series LCD protocol V1.0'),
  msg('JK BMS LIN bus V1.0'),
  msg('RS485 protocol 17'),
  msg('RS485 protocol 18'),
  msg('RS485 protocol 19'),
  msg('RS485 protocol 20'),
].map((label, value) => ({ value, label }));

/** CAN protocol index (spec 9.6). */
const CAN_PROTOCOLS = [
  msg('JK BMS CAN 250K V2.0'),
  msg('Deye low voltage hybrid inverter V1.0'),
  msg('Pylon low voltage V1.2'),
  msg('Growatt BMS CAN bus low voltage Rev 05'),
  msg('Victron CAN bus BMS (2017-07-17)'),
  msg('Megarevo hybrid BMS CAN V1.0'),
  msg('JK BMS CAN 500K V2.0'),
  msg('INVT BMS CAN V1.02'),
  msg('GoodWe LV BMS (EX/EM/S-BP/BP)'),
  msg('FSS ConnectingBat TI-en-10 V1.0'),
  msg('MUST PV1800F CAN 1.04.04'),
  msg('LuxpowerTek battery CAN V01'),
  msg('CAN user customization 1'),
  msg('CAN user customization 2'),
].map((label, value) => ({ value, label }));

/** LCD buzzer and dry contact trigger index (spec 9.6). */
const TRIGGERS = [
  msg('Off'),
  msg('Low SOC'),
  msg('Battery overvoltage'),
  msg('Battery undervoltage'),
  msg('Cell overvoltage'),
  msg('Cell undervoltage'),
  msg('Charge overcurrent'),
  msg('Discharge overcurrent'),
  msg('Battery overtemperature'),
  msg('MOSFET overtemperature'),
  msg('System alarm'),
  msg('Battery low temperature'),
  msg('Remote control'),
  msg('Above SOC'),
  msg('MOSFET abnormal'),
].map((label, value) => ({ value, label }));

/** Battery type of the 4E57 port (ID 0xAF) and of the cell info frame (C275), spec 9.6. */
export const BATTERY_TYPES = [
  { value: 0, label: msg('LiFePO4') },
  { value: 1, label: msg('Li-ion (NMC)') },
  { value: 2, label: msg('LTO') },
];

/** Labels of the wire resistance fields (literal for the translation checker). */
const WIRE_LABELS = [
  msg('Cell 1 wire resistance'),
  msg('Cell 2 wire resistance'),
  msg('Cell 3 wire resistance'),
  msg('Cell 4 wire resistance'),
  msg('Cell 5 wire resistance'),
  msg('Cell 6 wire resistance'),
  msg('Cell 7 wire resistance'),
  msg('Cell 8 wire resistance'),
  msg('Cell 9 wire resistance'),
  msg('Cell 10 wire resistance'),
  msg('Cell 11 wire resistance'),
  msg('Cell 12 wire resistance'),
  msg('Cell 13 wire resistance'),
  msg('Cell 14 wire resistance'),
  msg('Cell 15 wire resistance'),
  msg('Cell 16 wire resistance'),
  msg('Cell 17 wire resistance'),
  msg('Cell 18 wire resistance'),
  msg('Cell 19 wire resistance'),
  msg('Cell 20 wire resistance'),
  msg('Cell 21 wire resistance'),
  msg('Cell 22 wire resistance'),
  msg('Cell 23 wire resistance'),
  msg('Cell 24 wire resistance'),
  msg('Cell 25 wire resistance'),
  msg('Cell 26 wire resistance'),
  msg('Cell 27 wire resistance'),
  msg('Cell 28 wire resistance'),
  msg('Cell 29 wire resistance'),
  msg('Cell 30 wire resistance'),
  msg('Cell 31 wire resistance'),
  msg('Cell 32 wire resistance'),
];

// Limits ---------------------------------------------------------------------------------------

/** Cell protection voltages, [SY] input range 1.200 to 4.350 V (spec 7.1). */
const CELL_V = { min: 1.2, max: 4.35 };
/** SOC 0/100 %, charge request and float voltages: up to 4.35 V as in batmon-ha (spec 7.1). */
const CELL_V_WIDE = { min: 1, max: 4.35 };
/** Delays and recovery times, 2 to 600 s (spec 7.2). */
const DELAY_S = { min: 2, max: 600 };

// JK02 schema (JK02_24S, JK02_32S over BLE, JK02_32S frames over JK-PB RS485) ------------------

/**
 * @param {{ variant?: string, link?: 'ble'|'pb', cellCount?: number }} [opts]
 * @returns {SettingsSchema}
 */
export function buildJkSchema({ variant = VARIANT.JK02_32S, link = 'ble', cellCount = 0 } = {}) {
  if (variant === VARIANT.JK04) return buildJk04Schema();
  const is32 = variant !== VARIANT.JK02_24S;
  const pb = link === 'pb';
  /** @type {SettingField[]} */
  const fields = [];

  /**
   * Field backed by a settings frame value.
   * @param {string} id
   * @param {string} name settings layout field
   * @param {Partial<SettingField>} [props]
   * @param {{ ro?: boolean, reason?: string, guard?: { nonZero?: boolean, min?: number } }} [opts]
   */
  const reg = (id, name, props = {}, { ro = false, reason, guard } = {}) => {
    const spec = JK02_SETTINGS[name];
    if (spec.only32 && !is32) return;
    /** @type {WriteTarget | null} */
    let write = null;
    if (!ro && pb) {
      // The 4 byte settings have documented registers 0x1000 + offset - 6 (spec 6.2).
      if (spec.type === 'u32' || spec.type === 'i32' || spec.type === 'bool32') write = { link: 'pb', register: pbSettingsRegister(spec.offset), size: 4 };
    } else if (!ro) {
      const register = is32 ? spec.reg32 : spec.reg24;
      if (register !== undefined && spec.length) write = { link: 'ble', register, length: spec.length };
    }
    const meta = { kind: 'reg', source: 'settings', name, scale: spec.scale ?? 1, write, ...(guard ? { guard } : {}) };
    fields.push(field(id, { ...props, ...(write ? {} : { readOnly: true, description: reason ?? (pb ? NO_RS485_WRITE : NO_WRITE) }), meta }));
  };

  /**
   * Switch stored as one bit of the controls bitmask S282 (JK02_32S only, spec 8.1, 9.5).
   * @param {string} id
   * @param {number} bit
   * @param {Partial<SettingField>} [props]
   * @param {{ ro?: boolean, reason?: string }} [opts]
   */
  const bit = (id, bit, props = {}, { ro = false, reason } = {}) => {
    if (!is32) return;
    const def = CONTROL_BITS[bit];
    /** @type {WriteTarget | null} */
    let write = null;
    if (!ro && !def.inferred) write = pb ? { link: 'pb', register: PB_CONTROLS_REGISTER, size: 2, bit } : { link: 'ble', register: controlBitRegister(bit), length: 4 };
    const meta = { kind: 'bit', source: 'settings', name: def.name, bit, write };
    fields.push(field(id, { type: 'boolean', ...props, ...(write ? {} : { readOnly: true, description: reason ?? INFERRED_SWITCH }), meta }));
  };

  /**
   * Field backed by a device info frame value (JK02_32S only, spec 7.1, 7.7).
   * @param {string} id
   * @param {string} name
   * @param {Partial<SettingField>} [props]
   * @param {{ ro?: boolean, reason?: string }} [opts]
   */
  const dev = (id, name, props = {}, { ro = false, reason } = {}) => {
    if (!is32) return;
    const d = JK02_DEVICE_SETTINGS.find((x) => x.name === name);
    /** @type {WriteTarget | null} */
    const write = !ro && !pb && d ? { link: 'ble', register: d.register, length: d.length } : null;
    const meta = { kind: 'reg', source: 'device', name, scale: d?.scale ?? 1, write };
    fields.push(field(id, { ...props, ...(write ? {} : { readOnly: true, description: reason ?? (pb ? NO_RS485_WRITE : NO_WRITE) }), meta }));
  };

  // Cell voltage protection (spec 7.1).
  reg('cell.ovp', 'cellOvp', {
    ...CELL_V,
    validate: all(
      relation('cell.ovp', '>', 'cell.ovpr', PROT_ABOVE_REC),
      relSet('cell.ovp', '>', 'charge.request_voltage', OVP_ABOVE_CHARGE),
      relSet('cell.ovp', '>', 'charge.float_voltage', OVP_ABOVE_CHARGE),
      relSet('cell.ovp', '>', 'charge.soc100_voltage', OVP_ABOVE_CHARGE),
      relation('cell.ovp', '>', 'balance.start_voltage', OVP_ABOVE_BALANCE),
    ),
  });
  reg('cell.ovpr', 'cellOvpr', {
    ...CELL_V,
    validate: all(relation('cell.ovpr', '<', 'cell.ovp', REC_BELOW_PROT), relation('cell.ovpr', '>', 'cell.uvpr', OVPR_ABOVE_UVPR)),
  });
  reg('cell.uvp', 'cellUvp', {
    ...CELL_V,
    validate: all(relation('cell.uvp', '<', 'cell.uvpr', PROT_BELOW_REC), relation('cell.uvp', '>', 'cell.power_off_voltage', UVP_ABOVE_POWER_OFF)),
  });
  reg('cell.uvpr', 'cellUvpr', {
    ...CELL_V,
    validate: all(relation('cell.uvpr', '>', 'cell.uvp', REC_ABOVE_PROT), relation('cell.uvpr', '<', 'cell.ovpr', UVPR_BELOW_OVPR)),
  });
  reg('cell.power_off_voltage', 'powerOffVoltage', { ...CELL_V, validate: relation('cell.power_off_voltage', '<', 'cell.uvp', POWER_OFF_BELOW_UVP) });

  // Charging (spec 7.1).
  reg(
    'charge.request_voltage',
    'cellRcv',
    {
      ...CELL_V_WIDE,
      description: FEATURE_ZERO,
      validate: all(
        relSet('charge.request_voltage', '<', 'cell.ovp', CHARGE_BELOW_OVP),
        relSet('charge.request_voltage', '>', 'charge.float_voltage', RCV_ABOVE_RFV),
        relSet('charge.request_voltage', '>=', 'charge.soc100_voltage', RCV_NOT_BELOW_SOC100),
      ),
    },
    { guard: { nonZero: true } },
  );
  reg(
    'charge.float_voltage',
    'cellRfv',
    {
      ...CELL_V_WIDE,
      description: FEATURE_ZERO,
      validate: all(relSet('charge.float_voltage', '<', 'charge.request_voltage', RFV_BELOW_RCV), relSet('charge.float_voltage', '<', 'cell.ovp', CHARGE_BELOW_OVP)),
    },
    { guard: { nonZero: true } },
  );
  dev('jk.rcv_time', 'rcvTime', { label: msg('Absorption time at the charge request voltage'), group: 'charging', unit: 'h', decimals: 1, min: 0, max: 18.2, advanced: true });
  dev('jk.rfv_time', 'rfvTime', { label: msg('Float time at the float voltage'), group: 'charging', unit: 'h', decimals: 1, min: 0, max: 18.2, advanced: true });
  dev('jk.rebulk_soc', 'reBulkSoc', { label: msg('Re-bulk SOC'), group: 'charging', unit: '%', decimals: 0, min: 0, max: 50, advanced: true });
  bit('jk.charging_float_mode', 9, { label: msg('Float charge mode'), group: 'charging' });

  // Capacity and SOC voltages (spec 7.5, 7.1).
  reg('capacity.nominal', 'nominalCapacity', { min: 2, max: 20000 });
  reg(
    'charge.soc100_voltage',
    'cellSoc100Voltage',
    {
      ...CELL_V_WIDE,
      description: FEATURE_ZERO,
      validate: all(
        relSet('charge.soc100_voltage', '>', 'charge.soc0_voltage', SOC100_ABOVE_SOC0),
        relSet('charge.soc100_voltage', '<', 'cell.ovp', CHARGE_BELOW_OVP),
        relSet('charge.soc100_voltage', '<=', 'charge.request_voltage', SOC100_NOT_ABOVE_RCV),
      ),
    },
    { guard: { nonZero: true } },
  );
  reg(
    'charge.soc0_voltage',
    'cellSoc0Voltage',
    { ...CELL_V_WIDE, description: FEATURE_ZERO, validate: relSet('charge.soc0_voltage', '<', 'charge.soc100_voltage', SOC0_BELOW_SOC100) },
    { guard: { nonZero: true } },
  );

  // Current protection (spec 7.2).
  reg('charge.ocp', 'maxChargeCurrent', { min: 1, max: 600 });
  reg('charge.ocp_delay', 'chargeOcpDelay', DELAY_S);
  reg('charge.ocp_recovery', 'chargeOcpRecoveryTime', DELAY_S);
  reg('discharge.ocp', 'maxDischargeCurrent', { min: 1, max: 1200 });
  reg('discharge.ocp_delay', 'dischargeOcpDelay', DELAY_S);
  reg('discharge.ocp_recovery', 'dischargeOcpRecoveryTime', DELAY_S);
  // Unit unverified on firmware >= 15.26, and it can disable protection (spec 6.2, 7.8).
  reg('scp.delay', 'scpDelay', { advanced: true }, { ro: true, reason: SCP_DELAY });
  reg('scp.recovery', 'scpRecoveryTime', DELAY_S);
  reg('jk.precharge_time', 'prechargeTime', { label: msg('Precharge time'), group: 'current', unit: 's', decimals: 0, min: 0, max: 255, advanced: true });
  bit('jk.discharge_ocp2_enabled', 12, { label: msg('Discharge overcurrent level 2 enabled'), group: 'current', advanced: true });
  bit('jk.discharge_ocp3_enabled', 13, { label: msg('Discharge overcurrent level 3 enabled'), group: 'current', advanced: true });

  // Temperature (spec 7.3).
  reg('charge.otp', 'chargeOtp', { min: 30, max: 80, validate: relation('charge.otp', '>', 'charge.otpr', PROT_ABOVE_REC) });
  reg('charge.otpr', 'chargeOtpr', { min: 30, max: 80, validate: relation('charge.otpr', '<', 'charge.otp', REC_BELOW_PROT) });
  reg('discharge.otp', 'dischargeOtp', { min: 30, max: 80, validate: relation('discharge.otp', '>', 'discharge.otpr', PROT_ABOVE_REC) });
  reg('discharge.otpr', 'dischargeOtpr', { min: 30, max: 80, validate: relation('discharge.otpr', '<', 'discharge.otp', REC_BELOW_PROT) });
  reg('charge.utp', 'chargeUtp', { min: -45, max: 20, validate: relation('charge.utp', '<', 'charge.utpr', PROT_BELOW_REC) });
  reg('charge.utpr', 'chargeUtpr', { min: -45, max: 20, validate: relation('charge.utpr', '>', 'charge.utp', REC_ABOVE_PROT) });
  // Plausible in three captures; the write of 0x3A / 0x3B (one signed byte, like the heating
  // temperatures 0x37 / 0x38) is enabled at the user's request (2026-11-23) and checked by the
  // read-back of every write (spec 6.2, 7.3). No RS485 register: read only on JK-PB RS485.
  reg('discharge.utp', 'dischargeUtp', { decimals: 0, min: -40, max: 20, validate: relation('discharge.utp', '<', 'discharge.utpr', PROT_BELOW_REC) });
  reg('discharge.utpr', 'dischargeUtpr', { decimals: 0, min: -40, max: 25, validate: relation('discharge.utpr', '>', 'discharge.utp', REC_ABOVE_PROT) });
  reg('mos.otp', 'mosOtp', { min: 50, max: 110, validate: relation('mos.otp', '>', 'mos.otpr', PROT_ABOVE_REC) });
  reg('mos.otpr', 'mosOtpr', { min: 50, max: 110, validate: relation('mos.otpr', '<', 'mos.otp', REC_BELOW_PROT) });
  // PB register 0x1116 holds both bytes; their order is inferred (spec 6.2).
  reg(
    'jk.heating_start_temperature',
    'heatingStartTemperature',
    {
      label: msg('Heating start temperature'),
      group: 'temperature',
      unit: '°C',
      decimals: 0,
      min: -40,
      max: 100,
      description: HEATING_FIRMWARE,
      validate: relation('jk.heating_start_temperature', '<', 'jk.heating_stop_temperature', HEAT_START_BELOW_STOP),
    },
    { ro: pb, reason: PB_BYTE_ORDER },
  );
  reg(
    'jk.heating_stop_temperature',
    'heatingStopTemperature',
    {
      label: msg('Heating stop temperature'),
      group: 'temperature',
      unit: '°C',
      decimals: 0,
      min: -40,
      max: 100,
      description: HEATING_FIRMWARE,
      validate: relation('jk.heating_stop_temperature', '>', 'jk.heating_start_temperature', HEAT_STOP_ABOVE_START),
    },
    { ro: pb, reason: PB_BYTE_ORDER },
  );
  bit('jk.disable_temperature_sensors', 1, {
    label: msg('Disable temperature sensors'),
    group: 'temperature',
    danger: true,
    advanced: true,
    description: msg('Switches temperature protection off. Only for packs without temperature sensors.'),
  });

  // Balancing (spec 7.4).
  reg('balance.start_voltage', 'balanceStartVoltage', { min: 1.2, max: 4.25, validate: relation('balance.start_voltage', '<', 'cell.ovp', BALANCE_BELOW_OVP) });
  reg('balance.trigger_delta', 'balanceTriggerVoltage', { min: 0.003, max: 1 });
  reg('balance.max_current', 'maxBalanceCurrent', { min: 0.3, max: 15 });

  // Switches (spec 8.1).
  reg('switch.charge', 'chargeSwitch');
  reg('switch.discharge', 'dischargeSwitch');
  reg('switch.balance', 'balancerSwitch');
  bit('switch.heater', 0, { description: msg('Enables the heating function of the BMS.') });
  bit('switch.display', 4);

  // System (spec 7.5, 7.7).
  reg('system.cell_count', 'cellCount', { min: 2, max: is32 ? 32 : 24, step: 1, danger: true, advanced: true, description: CELL_COUNT });
  reg('system.address', 'deviceAddress', {}, { ro: true, reason: msg('Set with the DIP switches on the BMS.') });
  bit('jk.smart_sleep', 6, { label: msg('Smart sleep'), group: 'system' });
  if (is32) {
    reg(
      'jk.smart_sleep_voltage',
      'smartSleepVoltage',
      { label: msg('Smart sleep voltage'), group: 'system', unit: 'V', decimals: 3, min: 1, max: 3.65, description: SLEEP_VOLTAGE },
      { guard: { min: 1 } },
    );
  } else {
    reg('jk.smart_sleep_voltage', 'smartSleepVoltage', { label: msg('Smart sleep voltage'), group: 'system', unit: 'V', decimals: 3 }, { ro: true, reason: SLEEP_VOLTAGE_24S, guard: { min: 1 } });
  }
  // PB register 0x1118 (high byte) is inferred (spec 6.2).
  reg('jk.smart_sleep_hours', 'smartSleepDelay', { label: msg('Smart sleep delay'), group: 'system', unit: 'h', decimals: 0, min: 1, max: 100 }, { ro: pb, reason: PB_BYTE_ORDER });
  bit(
    'jk.port_rs485',
    3,
    {
      label: msg('Multiplexed port mode'),
      group: 'system',
      type: 'enum',
      options: [
        { value: 0, label: msg('CAN') },
        { value: 1, label: msg('RS485') },
      ],
      danger: true,
      advanced: true,
    },
    { ro: pb, reason: PB_PORT_MODE },
  );
  bit('jk.disable_pcl_module', 7, { label: msg('Disable PCL module'), group: 'system', advanced: true });
  bit('jk.timed_stored_data', 8, { label: msg('Timed data storage'), group: 'system', advanced: true });
  bit('jk.emergency_button_trigger', 10, { label: msg('Emergency button trigger'), group: 'system', advanced: true });
  bit('jk.dry_contact_alarm_intermittent', 11, { label: msg('Intermittent dry contact alarm'), group: 'system', advanced: true });
  const lockText = msg('Blocks the MOSFETs until a GPS module unlocks them.');
  bit('jk.gps_locked_charging', 14, { label: msg('GPS lock for charging'), group: 'system', danger: true, advanced: true, description: lockText });
  bit('jk.gps_locked_discharging', 15, { label: msg('GPS lock for discharging'), group: 'system', danger: true, advanced: true, description: lockText });
  // Registers 0x29 and 0x2C follow the 0x27 + bit pattern but were never seen (spec 8.1).
  bit('jk.gps_heartbeat', 2, { label: msg('GPS heartbeat'), group: 'system', advanced: true }, { ro: true });
  bit('jk.special_charger', 5, { label: msg('Special charger'), group: 'system', advanced: true }, { ro: true });
  dev('jk.emergency_duration', 'emergencyDuration', { label: msg('Emergency mode duration'), group: 'system', unit: 'min', decimals: 0, min: 1, max: 255, advanced: true });
  const protocol = { group: 'system', type: /** @type {const} */ ('enum'), danger: true, advanced: true, description: PROTOCOL_CHANGE };
  dev('jk.uart1_protocol', 'uart1Protocol', { label: msg('UART1 protocol'), options: UART_PROTOCOLS, ...protocol });
  dev('jk.uart2_protocol', 'uart2Protocol', { label: msg('UART2 protocol'), options: UART_PROTOCOLS, ...protocol });
  dev('jk.uart3_protocol', 'uart3Protocol', { label: msg('UART3 protocol'), options: UART_PROTOCOLS, ...protocol });
  dev('jk.can_protocol', 'canProtocol', { label: msg('CAN protocol'), options: CAN_PROTOCOLS, ...protocol });
  const trigger = { group: 'system', type: /** @type {const} */ ('enum'), options: TRIGGERS, advanced: true };
  dev('jk.lcd_buzzer_trigger', 'lcdBuzzerTrigger', { label: msg('LCD buzzer trigger'), ...trigger });
  dev('jk.dry1_trigger', 'dry1Trigger', { label: msg('Dry contact 1 trigger'), ...trigger });
  dev('jk.dry2_trigger', 'dry2Trigger', { label: msg('Dry contact 2 trigger'), ...trigger });
  // Trigger and release values: no write register known (spec 7.7); units depend on the trigger.
  const raw = { group: 'system', decimals: 0, advanced: true };
  dev('jk.lcd_buzzer_trigger_value', 'lcdBuzzerTriggerValue', { label: msg('LCD buzzer trigger value (raw)'), ...raw }, { ro: true });
  dev('jk.lcd_buzzer_release_value', 'lcdBuzzerReleaseValue', { label: msg('LCD buzzer release value (raw)'), ...raw }, { ro: true });
  dev('jk.dry1_trigger_value', 'dry1TriggerValue', { label: msg('Dry contact 1 trigger value (raw)'), ...raw }, { ro: true });
  dev('jk.dry1_release_value', 'dry1ReleaseValue', { label: msg('Dry contact 1 release value (raw)'), ...raw }, { ro: true });
  dev('jk.dry2_trigger_value', 'dry2TriggerValue', { label: msg('Dry contact 2 trigger value (raw)'), ...raw }, { ro: true });
  dev('jk.dry2_release_value', 'dry2ReleaseValue', { label: msg('Dry contact 2 release value (raw)'), ...raw }, { ro: true });
  dev('jk.data_stored_period', 'dataStoredPeriod', { label: msg('Data storage interval'), group: 'system', unit: 's', decimals: 0, advanced: true }, { ro: true });

  // Calibration (spec 7.6): write only, JK02_32S over BLE. The JK02_24S registers (0x21, 0x24)
  // have a single source and the PB block 0x1600 is untested on hardware, so both are left out.
  if (is32 && !pb) {
    fields.push(
      field('calibration.voltage', {
        decimals: 3,
        min: 1,
        max: 200,
        danger: true,
        advanced: true,
        writeOnly: true,
        description: msg('Enter the pack voltage measured with an accurate meter. The BMS does not report this value, so it cannot be read back.'),
        meta: { kind: 'calibration', scale: 0.001, write: { link: 'ble', register: 0x64, length: 4 } },
      }),
      field('calibration.current', {
        decimals: 3,
        min: 0,
        max: 1000,
        danger: true,
        advanced: true,
        writeOnly: true,
        description: msg('Enter the charge current measured with an accurate meter while it flows. The BMS does not report this value, so it cannot be read back.'),
        meta: { kind: 'calibration', scale: 0.001, write: { link: 'ble', register: 0x67, length: 4 } },
      }),
    );
  }

  // Identity: no write registers known on JK02_32S (spec 7.7).
  fields.push(field('identity.name', { readOnly: true, description: NO_WRITE, meta: { kind: 'reg', source: 'device', name: 'deviceName', write: null } }));

  // Wire resistance per cell (S142 on 32S, S158 on 24S): unit unverified, no write register.
  const wires = Math.min(Math.max(0, cellCount), is32 ? 32 : 24);
  for (let i = 0; i < wires; i++) {
    fields.push(
      field(`jk.wire_resistance_${i + 1}`, {
        label: WIRE_LABELS[i],
        group: 'wire_resistance',
        unit: 'mΩ',
        decimals: 0,
        readOnly: true,
        description: WIRE_RESISTANCE,
        advanced: true,
        meta: { kind: 'wire', source: 'settings', index: i, write: null },
      }),
    );
  }

  // One-shot actions (spec 5.1, 8.2): JK02_32S over BLE only (the PB block 0x1600 is untested).
  if (is32 && !pb) {
    /** @param {string} id @param {string} label @param {number} register @param {Partial<SettingField>} [o] */
    const action = (id, label, register, o = {}) => fields.push(field(id, { label, group: 'actions', type: 'action', ...o, meta: { kind: 'action', register } }));
    action('jk.restart', msg('Restart BMS'), CMD.RESTART, { danger: true, description: msg('Restarts the BMS. The output may be interrupted while it restarts.') });
    action('jk.shutdown', msg('Switch BMS off'), CMD.SHUTDOWN, { danger: true, description: msg('The BMS powers itself off and the connection is lost.') });
    action('jk.factory_reset', msg('Factory reset'), CMD.FACTORY_RESET, {
      danger: true,
      advanced: true,
      description: msg('Restores the factory settings. All protection settings are overwritten; check them afterwards.'),
    });
    const preset = msg('Overwrites the protection settings with the defaults for this chemistry. Check all settings afterwards.');
    action('jk.preset_lfp', msg('Load LiFePO4 defaults'), CMD.PRESET_LFP, { danger: true, advanced: true, description: preset });
    action('jk.preset_liion', msg('Load ternary lithium (NMC) defaults'), CMD.PRESET_LIION, { danger: true, advanced: true, description: preset });
    action('jk.preset_lto', msg('Load lithium titanate (LTO) defaults'), CMD.PRESET_LTO, { danger: true, advanced: true, description: preset });
    // Emergency mode 0x6B (spec 8.1): one-shot commands rather than a stored setting, so a
    // settings file can never switch it on; the countdown is shown with the live data. The PB
    // register 0x1610 is untested and not used.
    /** @param {string} id @param {string} label @param {0|1} value @param {Partial<SettingField>} [o] */
    const command = (id, label, value, o = {}) =>
      fields.push(field(id, { label, group: 'actions', type: 'action', ...o, meta: { kind: 'command', register: CMD.EMERGENCY, length: 4, value } }));
    command('jk.emergency_on', msg('Start emergency mode'), 1, {
      danger: true,
      advanced: true,
      description: msg('Allows discharging for the emergency duration even while a protection is active.'),
    });
    command('jk.emergency_off', msg('Stop emergency mode'), 0, { advanced: true });
    // SOC calibration 0x6E is confirmed for JK02_32S by ESPHome and batmon-ha (spec 7.5, 8.2).
    fields.push(
      field('jk.soc_full', {
        label: msg('Set state of charge'),
        group: 'actions',
        type: 'action',
        description: msg('Sets the state of charge to the entered value, for example 100 % after a full charge.'),
        argument: { unit: '%', min: 0, max: 100, step: 1, decimals: 0, default: 100 },
        meta: { kind: 'soc', register: CMD.SOC_CALIBRATION, value: 100 },
      }),
    );
  }

  return buildSchema(fields);
}

// JK04 schema ----------------------------------------------------------------------------------

/**
 * Description of the JK04 balance start voltage: ESPHome writes register 0x58, the register rule
 * of the captured JK04 writes (settings offset - 6) gives 0x5C, and no capture shows the write
 * (docs/protocols/jk-balancer.md section 12 item 1). Unverified, so it is shown but never written.
 */
export const JK04_START_VOLTAGE_READ_ONLY = msg(
  'The write register of this value is not confirmed (0x58 in ESPHome, 0x5C by the register rule) and its meaning is unclear, so it is shown but never written.',
);

/**
 * JK04 balancer (spec 6.4, 5.2): float32 values, written with the same registers by ESPHome and
 * batmon-ha. The balance start voltage stays read only (see JK04_START_VOLTAGE_READ_ONLY).
 * @returns {SettingsSchema}
 */
export function buildJk04Schema() {
  /**
   * @param {string} id
   * @param {string} name
   * @param {Partial<SettingField>} [props]
   */
  const j = (id, name, props = {}) => {
    const s = /** @type {(typeof JK04_SETTINGS_LAYOUT)[number]} */ (JK04_SETTINGS_LAYOUT.find((x) => x.name === name));
    return field(id, { ...props, meta: { kind: 'reg', source: 'settings', name, scale: 1, write: { link: 'ble', register: s.register, length: s.length, float: s.type === 'f32' } } });
  };
  return buildSchema([
    j('cell.power_off_voltage', 'powerOffVoltage', { min: 2, max: 3.7 }),
    field('balance.start_voltage', { readOnly: true, description: JK04_START_VOLTAGE_READ_ONLY, meta: { kind: 'reg', source: 'settings', name: 'balanceStartVoltage' } }),
    j('balance.trigger_delta', 'balanceTriggerVoltage', { min: 0.002, max: 1 }),
    j('balance.max_current', 'maxBalanceCurrent', { decimals: 2, min: 0.1, max: 10 }),
    j('switch.balance', 'balancerSwitch'),
    j('system.cell_count', 'cellCount', { min: 1, max: 24, step: 1, danger: true, advanced: true, description: CELL_COUNT }),
    j('jk.voltage_reference', 'voltageCalibration', {
      label: msg('Voltage reference'),
      group: 'calibration',
      unit: 'V',
      decimals: 4,
      min: 2.8,
      max: 3.2,
      danger: true,
      advanced: true,
      description: msg('ADC reference of the balancer (about 3.03 V); it scales every voltage reading.'),
    }),
  ]);
}

// 4E57 UART schema ------------------------------------------------------------------------------

/**
 * JK-B "4E 57" port (spec 6.6): every value of the read-all reply is shown; only the charge and
 * discharge MOSFET and balancer switches are written (1 byte writes confirmed by captures).
 * @returns {SettingsSchema}
 */
export function buildJkUartSchema() {
  /**
   * @param {string} id
   * @param {string} name
   * @param {Partial<SettingField>} [props]
   */
  const ro = (id, name, props = {}) => field(id, { ...props, readOnly: true, description: props.description ?? UART_READ_ONLY, meta: { kind: 'uart', source: 'uart', name, write: null } });
  /** @param {string} id @param {string} name @param {number} dataId @param {Partial<SettingField>} [props] */
  const sw = (id, name, dataId, props = {}) => field(id, { ...props, meta: { kind: 'uart', source: 'uart', name, write: { link: 'uart', dataId } } });
  const deg = { decimals: 0 };
  return buildSchema([
    sw('switch.charge', 'chargeSwitch', UART_ID.CHARGE_SWITCH),
    sw('switch.discharge', 'dischargeSwitch', UART_ID.DISCHARGE_SWITCH),
    // Firmware 11 refuses this write according to ESPHome (spec 6.6); the read-back tells.
    sw('switch.balance', 'balancerSwitch', UART_ID.BALANCER_SWITCH, { description: msg('Some firmware versions refuse this switch over the UART port.') }),
    ro('cell.ovp', 'cellOvp'),
    ro('cell.ovpr', 'cellOvpr'),
    ro('cell.ovp_delay', 'cellOvpDelay'),
    ro('cell.uvp', 'cellUvp'),
    ro('cell.uvpr', 'cellUvpr'),
    ro('cell.uvp_delay', 'cellUvpDelay'),
    ro('cell.diff_protection', 'cellDeltaProtection'),
    ro('pack.ovp', 'packOvp', { decimals: 2 }),
    ro('pack.uvp', 'packUvp', { decimals: 2 }),
    ro('charge.ocp', 'chargeOcp', { decimals: 0 }),
    ro('charge.ocp_delay', 'chargeOcpDelay'),
    ro('discharge.ocp', 'dischargeOcp', { decimals: 0 }),
    ro('discharge.ocp_delay', 'dischargeOcpDelay'),
    ro('charge.otp', 'chargeOtp', deg),
    ro('discharge.otp', 'dischargeOtp', deg),
    ro('charge.utp', 'chargeUtp', deg),
    ro('charge.utpr', 'chargeUtpr', deg),
    ro('discharge.utp', 'dischargeUtp', deg),
    ro('discharge.utpr', 'dischargeUtpr', deg),
    ro('mos.otp', 'mosOtp', deg),
    ro('mos.otpr', 'mosOtpr', deg),
    ro('jk.box_otp', 'boxOtp', { label: msg('Battery box overtemperature protection'), group: 'temperature', unit: '°C', decimals: 0 }),
    ro('jk.box_otpr', 'boxOtpr', { label: msg('Battery box overtemperature recovery'), group: 'temperature', unit: '°C', decimals: 0 }),
    ro('jk.temp_diff_protection', 'tempDiffProtection', { label: msg('Temperature difference protection'), group: 'temperature', unit: '°C', decimals: 0 }),
    ro('balance.start_voltage', 'balanceStartVoltage'),
    ro('balance.trigger_delta', 'balanceTriggerVoltage'),
    ro('capacity.nominal', 'capacitySetting', { decimals: 0 }),
    ro('jk.actual_capacity', 'actualCapacity', { label: msg('Actual capacity'), group: 'capacity', unit: 'Ah', decimals: 0 }),
    ro('soc.low_alarm', 'lowCapacityAlarm'),
    ro('system.cell_count', 'cellCountSetting'),
    ro('system.battery_type', 'batteryType', { options: BATTERY_TYPES }),
    ro('system.address', 'boardAddress'),
    ro('system.sleep_delay', 'sleepWaitTime'),
    ro('jk.dedicated_charger', 'dedicatedCharger', { label: msg('Dedicated charger'), group: 'system', type: 'boolean' }),
    ro('jk.current_calibration', 'currentCalibration', { label: msg('Current calibration value'), group: 'calibration', unit: 'A', decimals: 3 }),
  ]);
}

// Conversion -----------------------------------------------------------------------------------

/**
 * Settings values (engineering units) from the parsed frames.
 * @param {SettingsSchema} schema
 * @param {{ settings?: Record<string, any> | null, device?: Record<string, any> | null, uart?: Record<string, any> | null }} sources
 * @returns {Record<string, any>}
 */
export function decodeJkSettings(schema, sources) {
  /** @type {Record<string, any>} */
  const values = {};
  for (const g of schema.groups) {
    for (const f of g.fields) {
      const m = f.meta;
      if (!m || f.type === 'action') continue;
      const src = sources[/** @type {'settings'|'device'|'cell'|'uart'} */ (m.source)];
      /** @type {any} */
      let v;
      if (m.kind === 'wire') {
        const w = src?.wireResistances?.[m.index];
        v = w === undefined ? undefined : r(w * 1000, 3);
      } else if (m.kind === 'calibration') v = undefined;
      else v = src?.[m.name];
      if (v === undefined || v === null || v === '') continue;
      if (f.type === 'enum' && typeof v === 'boolean') v = v ? 1 : 0;
      // A value below the guard has an unknown meaning on this firmware (smart sleep voltage 600).
      if (m.guard?.min !== undefined && typeof v === 'number' && v < m.guard.min) continue;
      values[f.id] = v;
    }
  }
  return values;
}

/**
 * Raw integer of a JK02 value: booleans 1/0, numbers value / scale (two's complement on the wire).
 * @param {SettingField} f
 * @param {any} value
 */
export function rawValue(f, value) {
  if (f.type === 'boolean') return value ? 1 : 0;
  const scale = f.meta?.scale ?? 1;
  return Math.round(Number(value) / scale);
}

/**
 * Reason why the current value forbids a write (firmware without the feature), or null.
 * @param {SettingField} f
 * @param {any} current value read from the device (undefined when unknown)
 */
export function guardProblem(f, current) {
  const g = f.meta?.guard;
  if (!g) return null;
  if (g.nonZero && current === 0) return msg('This firmware does not support this setting (it reads 0), so it is not written.');
  if (g.min !== undefined && typeof current === 'number' && current < g.min) return msg('The meaning of this value is unknown on this firmware, so it is not written.');
  return null;
}

/**
 * BLE command frame that writes a field (JK02: scaled integer, JK04: float32 or integer).
 * @param {SettingField} f
 * @param {any} value engineering units
 */
export function bleWriteFrame(f, value) {
  const w = f.meta?.write;
  if (!w || w.link !== 'ble') throw new Error(msg('This value is read only'));
  if (w.float) return encodeJk04Write(w.register, 4, Number(value));
  return encodeWrite(w.register, w.length, rawValue(f, value));
}

/**
 * Modbus FC 0x10 frame that writes a field on a JK-PB (big endian at a byte address).
 * @param {number} address device address
 * @param {SettingField} f
 * @param {any} value engineering units
 * @param {number} [controls] current controls word (needed for bit fields)
 */
export function pbWriteFrame(address, f, value, controls) {
  const w = f.meta?.write;
  if (!w || w.link !== 'pb') throw new Error(msg('This value is read only'));
  if (w.bit !== undefined) {
    if (!Number.isInteger(controls)) throw new Error(msg('The current switch states are unknown, read the settings first'));
    const word = value ? /** @type {number} */ (controls) | (1 << w.bit) : /** @type {number} */ (controls) & ~(1 << w.bit);
    return pbWriteU16(address, w.register, word & 0xffff);
  }
  return pbWriteU32(address, w.register, rawValue(f, value));
}
