import { FrameAssembler } from '@ubms/transport';
import { msg } from '@ubms/bms-core';

/**
 * Frames of the KS ("Kesheng", 科圣) BMS boards KS48100 / KS48200 / KS48300 over their Bluetooth
 * module (docs/protocols/ks.md, "spec" below). Every frame, request and answer, is
 *
 *   7B <function> <length> <data: length bytes> 7D
 *
 * with big endian 16 bit words and no checksum. A read request carries no data (`7B 01 00 7D`);
 * a register write carries one word (`7B <register> 02 <hi> <lo> 7D`, spec 4). All offsets below
 * are frame offsets (the first data byte is offset 3), as in the spec tables.
 */

export const START = 0x7b;
export const END = 0x7d;

/** Read functions (spec 3). */
export const FN = Object.freeze({
  STATUS: 0x01,
  CELLS: 0x02,
  TEMPS: 0x03,
  BASIC: 0x04,
  VOLTAGE: 0x05,
  TEMPERATURE: 0x06,
  CURRENT: 0x07,
  HISTORY: 0x08,
  DATE: 0x09,
  MODEL_NAME: 0x0a,
  SERIAL: 0x0b,
  MODEL_TYPE: 0x0c,
  /** Status of the "device type 2" boards: same layout as 0x01 (spec 3.1). */
  STATUS_2: 0x61,
  MODULE_VERSION: 0x74,
  SOFTWARE_VERSION: 0xf3,
  PROGRAM_VERSION: 0xf4,
  BOOT_VERSION: 0xf5,
});

/** Kelvin offset of the temperatures in 0.1 K (raw = °C x 10 + 2731, spec 3.3, 3.6). */
export const KELVIN_OFFSET = 2731;

/** Largest data length seen is 0x21 (cells of a 16S pack); 24 cells need 0x31 (spec 3.2). */
const MAX_FRAME = 4 + 0xff;

/**
 * Encode a read request.
 * @param {number} fn
 */
export const encodeRead = (fn) => Uint8Array.of(START, fn & 0xff, 0x00, END);

/**
 * Encode a register write (spec 4).
 * @param {number} register
 * @param {number} value 0..65535
 */
export function encodeWrite(register, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`KS register value out of range: ${value}`);
  return Uint8Array.of(START, register & 0xff, 0x02, (value >> 8) & 0xff, value & 0xff, END);
}

/**
 * Frame assembler for both directions: the length byte decides the frame size, the end byte
 * checks it (a payload byte 0x7B after a lost notification resynchronises on the next start).
 * @param {{ onFrame: (f: Uint8Array) => void, onDiscard?: (b: Uint8Array, reason: string) => void }} handlers
 */
export function createAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({
    sync: [[START]],
    length: (buf) => (buf.length < 3 ? 0 : buf[2] + 4),
    validate: (f) => f[f.length - 1] === END,
    maxLength: MAX_FRAME,
    onFrame,
    onDiscard,
  });
}

/** @param {Uint8Array} f @param {number} o */
export const u16 = (f, o) => ((f[o] << 8) | f[o + 1]) >>> 0;
/** @param {Uint8Array} f @param {number} o */
export const i16 = (f, o) => {
  const v = u16(f, o);
  return v >= 0x8000 ? v - 0x10000 : v;
};
/** @param {Uint8Array} f @param {number} o */
const u32 = (f, o) => ((f[o] << 24) | (f[o + 1] << 16) | (f[o + 2] << 8) | f[o + 3]) >>> 0;

/** Raw temperature in 0.1 K to °C with one decimal. @param {number} raw */
export const kelvinToC = (raw) => Math.round(raw - KELVIN_OFFSET) / 10;
/** °C to the raw 0.1 K value. @param {number} c */
export const cToKelvin = (c) => Math.round(c * 10 + KELVIN_OFFSET);

/** Data bytes of a frame (without start, function, length and end). @param {Uint8Array} f */
export const dataOf = (f) => f.subarray(3, 3 + f[2]);

/**
 * Status 0x01 / 0x61 (spec 3.1). Length 0x20 on every capture; the state of health word at offset
 * 33 is read only when the frame is that long.
 * @param {Uint8Array} f
 */
export function parseStatus(f) {
  if (f[2] < 0x1e) throw new Error(`KS status frame too short (${f[2]} bytes)`);
  return {
    soc: u16(f, 3),
    voltage: u16(f, 5) / 100,
    averageTemp: i16(f, 7) / 10,
    ambientTemp: i16(f, 9) / 10,
    mosTemp: i16(f, 11) / 10,
    current: i16(f, 13) / 100,
    remainingAh: u16(f, 15) / 100,
    fullAh: u16(f, 17) / 100,
    nominalAh: u16(f, 19) / 100,
    cycleAh: u16(f, 21) / 100,
    cycles: u16(f, 23),
    balanceMask: u32(f, 25),
    fet: u16(f, 29),
    protection: u16(f, 31),
    soh: f[2] >= 0x20 ? u16(f, 33) : undefined,
  };
}

/** FET status word, offset 29 (spec 3.1). */
export const FET = Object.freeze({
  /** Battery state charging (bit 0) and discharging (bit 1). */
  STATE_CHARGING: 0x0001,
  STATE_DISCHARGING: 0x0002,
  CHARGE_MOS: 0x0004,
  DISCHARGE_MOS: 0x0008,
  /** The charge current limiter (bits 4 and 5, spec 3.1, which one is which is unverified). */
  LIMITING: 0x0030,
});

/**
 * Cell voltages 0x02: count, then one word per cell in mV (spec 3.2).
 * @param {Uint8Array} f
 */
export function parseCells(f) {
  const count = f[3];
  if (f[2] < 1 + 2 * count) throw new Error(`KS cell frame shorter than ${count} cells`);
  return Array.from({ length: count }, (_, i) => u16(f, 4 + 2 * i) / 1000);
}

/**
 * Temperatures 0x03: count, then one word per probe in 0.1 K (spec 3.3).
 * @param {Uint8Array} f
 */
export function parseTemps(f) {
  const count = f[3];
  if (f[2] < 1 + 2 * count) throw new Error(`KS temperature frame shorter than ${count} probes`);
  return Array.from({ length: count }, (_, i) => kelvinToC(u16(f, 4 + 2 * i)));
}

/**
 * Words of a settings block 0x04..0x07 (spec 3.4 to 3.7).
 * @param {Uint8Array} f
 */
export function parseWords(f) {
  const n = Math.floor(f[2] / 2);
  return Array.from({ length: n }, (_, i) => u16(f, 3 + 2 * i));
}

/**
 * ASCII text of 0x0A, 0x0B, 0x0C and 0x74: empty when the length is 0 or the text is unset (0xFF
 * filled, spec 3.8). Trailing NUL, space and 0xFF bytes are dropped.
 * @param {Uint8Array} f
 */
export function parseText(f) {
  const d = Array.from(dataOf(f));
  if (!d.length || d[0] === 0xff) return '';
  let end = d.length;
  while (end > 0 && (d[end - 1] === 0 || d[end - 1] === 0x20 || d[end - 1] === 0xff)) end--;
  return d
    .slice(0, end)
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '?'))
    .join('');
}

/**
 * Manufacturing date 0x09: year - 2000, month, day; 0xFF bytes mean unset (spec 3.8).
 * @param {Uint8Array} f
 */
export function parseDate(f) {
  const [y, m, d] = dataOf(f);
  if (f[2] < 3 || y === 0xff || m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${2000 + y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Version numbers 0xF3 / 0xF4 / 0xF5: the data bytes joined with dots (spec 3.9).
 * @param {Uint8Array} f
 */
export const parseVersion = (f) => Array.from(dataOf(f)).join('.');

/** Protection counters of 0x08, in frame order (spec 3.10). */
export const HISTORY_KEYS = Object.freeze([
  'shortCircuit',
  'chargeOvercurrent',
  'dischargeOvercurrent',
  'cellOvervoltage',
  'counter5',
  'packOvervoltage',
  'packUndervoltage',
  'chargeOvertemperature',
  'chargeUndertemperature',
  'dischargeOvertemperature',
  'dischargeUndertemperature',
]);

/**
 * Protection counters 0x08 (spec 3.10).
 * @param {Uint8Array} f
 * @returns {Record<string, number>}
 */
export function parseHistory(f) {
  /** @type {Record<string, number>} */
  const out = {};
  HISTORY_KEYS.forEach((k, i) => {
    if (3 + 2 * i + 1 < 3 + f[2]) out[k] = u16(f, 3 + 2 * i);
  });
  return out;
}

/**
 * Protection word, offset 31 (spec 3.1, bit names from [SY]). Bits 0 to 3 do not say whether the
 * cell or the pack limit tripped, so they keep driver specific ids.
 * @type {import('../common/util.js').AlarmBit[]}
 */
export const PROTECTION_BITS = [
  { bit: 0, id: 'ks.overcurrent', severity: 'protection', label: msg('Overcurrent protection') },
  { bit: 1, id: 'ks.undercurrent', severity: 'protection', label: msg('Undercurrent protection') },
  { bit: 2, id: 'ks.overvoltage', severity: 'protection', label: msg('Overvoltage protection') },
  { bit: 3, id: 'ks.undervoltage', severity: 'protection', label: msg('Undervoltage protection') },
  { bit: 4, id: 'charge_overtemperature' },
  { bit: 5, id: 'charge_undertemperature' },
  { bit: 6, id: 'discharge_overtemperature' },
  { bit: 7, id: 'discharge_undertemperature' },
  { bit: 8, id: 'charge_overcurrent' },
  { bit: 9, id: 'discharge_overcurrent' },
  { bit: 10, id: 'short_circuit' },
  { bit: 11, id: 'afe_fault' },
  { bit: 12, id: 'ks.mos_software_lock', severity: 'info', label: msg('MOSFET switched off by software') },
  { bit: 13, id: 'charge_mos_fault' },
  { bit: 14, id: 'discharge_mos_fault' },
  { bit: 15, id: 'ks.protection_bit15', severity: 'warning', label: msg('Protection bit 15 (reserved) set') },
];

/** English frame names for the protocol log. */
const NAMES = {
  [FN.STATUS]: 'Status',
  [FN.STATUS_2]: 'Status (type 2)',
  [FN.CELLS]: 'Cell voltages',
  [FN.TEMPS]: 'Temperatures',
  [FN.BASIC]: 'Basic settings',
  [FN.VOLTAGE]: 'Voltage protection settings',
  [FN.TEMPERATURE]: 'Temperature protection settings',
  [FN.CURRENT]: 'Current protection settings',
  [FN.HISTORY]: 'Protection counters',
  [FN.DATE]: 'Manufacturing date',
  [FN.MODEL_NAME]: 'Model name',
  [FN.SERIAL]: 'Serial number',
  [FN.MODEL_TYPE]: 'Model type',
  [FN.MODULE_VERSION]: 'Bluetooth module version',
  [FN.SOFTWARE_VERSION]: 'Software version',
  [FN.PROGRAM_VERSION]: 'BMS program version',
  [FN.BOOT_VERSION]: 'Boot version',
};

/** Register write targets (spec 4): 0x10..0x1E and 0x20..0x45. */
const isRegister = (/** @type {number} */ fn) => (fn >= 0x10 && fn <= 0x1e) || (fn >= 0x20 && fn <= 0x2b) || (fn >= 0x30 && fn <= 0x3b) || (fn >= 0x40 && fn <= 0x45);

/**
 * Name and short decode of a frame for the protocol log.
 * @param {Uint8Array} f
 * @param {'tx'|'rx'} direction
 * @returns {{ name: string, decode?: string } | null}
 */
export function describe(f, direction) {
  if (f.length < 4 || f[0] !== START) return null;
  const fn = f[1];
  if (direction === 'tx' && f[2] === 2 && isRegister(fn)) {
    return { name: `Write register 0x${fn.toString(16).toUpperCase().padStart(2, '0')}`, decode: `value ${u16(f, 3)}` };
  }
  const name = /** @type {Record<number, string>} */ (NAMES)[fn];
  if (!name) return { name: `Function 0x${fn.toString(16).toUpperCase().padStart(2, '0')}` };
  if (direction === 'tx') return { name: `Read ${name.toLowerCase()}` };
  try {
    if (fn === FN.STATUS || fn === FN.STATUS_2) {
      const s = parseStatus(f);
      return { name, decode: `${s.voltage.toFixed(2)} V, ${s.current.toFixed(2)} A, SOC ${s.soc} %, FET 0x${s.fet.toString(16)}, protection 0x${s.protection.toString(16)}` };
    }
    if (fn === FN.CELLS) return { name, decode: `${f[3]} cells` };
    if (fn === FN.TEMPS) return { name, decode: parseTemps(f).map((t) => `${t} °C`).join(', ') };
    if (fn === FN.SERIAL || fn === FN.MODEL_NAME || fn === FN.MODEL_TYPE || fn === FN.MODULE_VERSION) return { name, decode: parseText(f) || 'unset' };
  } catch {
    return { name };
  }
  return { name };
}
