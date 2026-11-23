import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProtocolLog, FrameChannel, createLinkPair, fromHex, hex, concat, crc16Modbus } from '@ubms/transport';
import { BmsSession, DriverRegistry, SETTINGS, SETTING_GROUPS, deriveSnapshot, validateAll } from '@ubms/bms-core';
import { SimBattery } from '../src/common/sim-battery.js';
import * as P from '../src/ant/protocol.js';
import {
  buildAntSchema,
  buildAntLegacySchema,
  capacityUnit,
  createRegisterImage,
  decodeSettings,
  fieldAtAddress,
  rawToValue,
  storeBlock,
  valueToRaw,
} from '../src/ant/settings.js';
import { antDrivers, createAntSimulator, createAntLegacySimulator, isBlankPage, parametersLocked, newStatusSnapshot, oldStatusSnapshot } from '../src/ant/index.js';

const vectors = JSON.parse(readFileSync(new URL('./vectors/ant.json', import.meta.url), 'utf8'));
/** @param {string} id */
const vector = (id) => {
  const v = vectors.find((x) => x.id === id);
  assert.ok(v, `vector ${id} exists`);
  return v;
};
/** @param {string} id */
const bytesOf = (id) => fromHex(vector(id).hex);

/** Decimal places of a number literal from the vectors file. @param {number} x */
const decimals = (x) => {
  const s = String(x);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};

/**
 * Some vector values are rounded by their source ("some rounded"), so numbers match within half a
 * unit of their last decimal or 1e-6 relative, whichever is larger.
 * @param {any} actual
 * @param {any} expected
 * @returns {boolean}
 */
function close(actual, expected) {
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Math.abs(actual - expected) <= Math.max(0.5 * 10 ** -decimals(expected), Math.abs(expected) * 1e-6) + 1e-9;
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => close(actual[i], e));
  return actual === expected;
}

/** @param {Uint8Array} data */
const words = (data) => Array.from({ length: data.length >> 1 }, (_, i) => data[2 * i] | (data[2 * i + 1] << 8));

/** Deterministic chunk sizes for fragmentation tests. @param {number} seed */
function chunker(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return 1 + (s % 37);
  };
}

/**
 * @param {Uint8Array} bytes
 * @param {(chunk: Uint8Array) => void} push
 * @param {() => number} size
 */
function feed(bytes, push, size) {
  for (let i = 0; i < bytes.length; ) {
    const n = size();
    push(bytes.subarray(i, i + n));
    i += n;
  }
}

/**
 * @param {() => any} fn
 * @param {number} [timeout]
 */
async function until(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}

const schema = buildAntSchema();

// Vector fields that live in the settings layer rather than in the frame parser.
const SETTING_KEYS = {
  cellOvervoltageProtection: 'cell.ovp',
  cellOvervoltageRecovery: 'cell.ovpr',
  packOvervoltageProtection: 'pack.ovp',
  cellUndervoltageProtection: 'cell.uvp',
  cellVoltageDifferenceProtection: 'cell.diff_protection',
  cellVoltageDifferenceWarningRecovery: 'ant.cell_diff_alarm_recovery',
};

/**
 * Parse an rx vector with the matching parser and return a getter for every expected key.
 * @param {any} v
 */
function parseVector(v) {
  const b = fromHex(v.hex);
  if (v.variant === 'ANT_OLD') {
    const p = b.length === P.OLD_STATUS_LENGTH ? P.parseOldStatus(b) : P.parseOldCommand(b);
    return (/** @type {string} */ key) => (key === 'temperatureRaw91to97' ? p.temperatureRaw91to101.slice(0, 4) : p[key]);
  }
  assert.ok(P.validateNewFrame(b), `${v.id} is a valid frame`);
  const func = b[2];
  if (func === P.RSP.STATUS) {
    const p = P.parseStatus(b);
    return (/** @type {string} */ key) => p[key];
  }
  if (func === P.RSP.READ) {
    const address = P.parseNewFrame(b).address;
    const p = address === P.ADDR.DEVICE_INFO ? P.parseDeviceInfo(b) : address === P.ADDR.PACK_ID ? P.parsePackId(b) : P.parseReadResponse(b);
    const image = createRegisterImage();
    if ('data' in p) storeBlock(image, p.address, p.data);
    const values = decodeSettings(schema, image);
    return (/** @type {string} */ key) => {
      if (key === 'value') {
        const f = fieldAtAddress(schema, p.address);
        assert.ok(f, `${v.id}: a settings field exists at ${p.address}`);
        return rawToValue(f.meta, p.rawValue, f.decimals);
      }
      if (key === 'rawValues') return words(p.data);
      if (key in SETTING_KEYS) return values[SETTING_KEYS[/** @type {keyof typeof SETTING_KEYS} */ (key)]];
      return p[key];
    };
  }
  const parsers = { [P.RSP.WRITE]: P.parseWriteResponse, [P.RSP.AUTH]: P.parseAuthResponse, [P.RSP.CONTROL]: P.parseControlResponse };
  const p = (parsers[func] ?? P.parseRawResponse)(b);
  return (/** @type {string} */ key) => p[key];
}

test('every rx vector parses to its expected values', () => {
  const rx = vectors.filter((v) => v.direction === 'rx' && v.expected && v.id !== 'new-stream-device-info-then-status');
  assert.ok(rx.length >= 68, `${rx.length} rx vectors`);
  let checked = 0;
  for (const v of rx) {
    const get = parseVector(v);
    for (const [key, want] of Object.entries(v.expected)) {
      const got = get(key);
      assert.ok(close(got, want), `${v.id}: ${key} = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      checked++;
    }
  }
  assert.ok(checked > 600, `${checked} values`);
});

/**
 * Encoder call for a tx vector, chosen from its expected fields.
 * @param {any} v
 */
function encodeTx(v) {
  const e = v.expected;
  if (v.variant === 'ANT_OLD') return P.encodeOldCommand(e.header, e.address, e.value);
  switch (e.function) {
    case P.FN.STATUS:
      return P.newStatusRequest();
    case P.FN.READ:
      return e.address === P.ADDR.DEVICE_INFO && e.length === 32 ? P.newDeviceInfoRequest() : P.newReadRequest(e.address, e.length);
    case P.FN.LOG:
      return P.newLogRequest(e.address);
    case P.FN.CHIP_ID:
      return P.newChipIdRequest();
    case P.FN.SYSTEM_INFO:
      return P.newSystemInfoRequest();
    case P.FN.GPRS:
      return P.newGprsRequest();
    case P.FN.WRITE:
      return P.newWriteRequest(e.address, e.rawValue, e.length);
    case P.FN.AUTH:
      return P.newAuthRequest(e.password, e.address);
    case P.FN.CONTROL:
      return P.newControlRequest(e.address);
    case P.FN.FACTORY_RESET_2024:
      return P.encodeNewRequest(e.function, e.address, e.length);
    default:
      throw new Error(`no encoder for ${v.id}`);
  }
}

test('every tx vector equals the encoder output and decodes back', () => {
  const tx = vectors.filter((v) => v.direction === 'tx');
  assert.ok(tx.length > 100);
  for (const v of tx) {
    const bytes = encodeTx(v);
    assert.equal(hex(bytes), v.hex.toUpperCase(), v.id);
    const d = P.describe(bytes);
    assert.ok(d && !/^Unknown/.test(d.name), `${v.id} has a log name`);
    if (v.variant === 'ANT_NEW') {
      const back = P.parseNewRequest(bytes, { revealPassword: true });
      for (const [key, want] of Object.entries(v.expected)) assert.equal(back[key], want, `${v.id}: ${key}`);
    } else {
      assert.deepEqual(P.parseOldCommand(bytes), v.expected, v.id);
    }
  }
  // Named encoders and constants against the captured frames.
  assert.equal(hex(P.newSaveRequest()), vector('new-req-control-save-apply').hex);
  assert.equal(hex(P.newAuthRequest(P.DEFAULT_PASSWORD_L1, P.ADDR.PASSWORD_L1)), vector('new-req-auth-level1-default').hex);
  assert.equal(hex(P.newAuthRequest(P.DEFAULT_PASSWORD_L5)), vector('new-req-auth-level5-default').hex);
  assert.equal(hex(P.oldStatusRequestBt()), vector('old-req-status-ble').hex);
  assert.equal(hex(P.oldStatusRequestUart()), vector('old-req-status-uart').hex);
  assert.equal(hex(P.oldReadRequest(31)), vector('old-req-read-param-capacity-low').hex);
  assert.equal(hex(P.oldApplyCommand()), vector('old-req-apply').hex);
  assert.deepEqual(
    P.oldPasswordFrames(P.OLD_CAPTURED_PASSWORD).map((f) => hex(f)),
    [1, 2, 3, 4].map((k) => vector(`old-req-password-${k}`).hex),
  );
  assert.equal(hex(P.oldWriteCommand(P.OLD_CONTROL.CHARGE, 0)), vector('old-req-charge-mos-off').hex);
  assert.equal(hex(P.oldWriteCommand(P.OLD_CONTROL.DISCHARGE, 1)), vector('old-req-discharge-mos-on').hex);
  const controls = {
    'discharge-mos-off': 'DISCHARGE_OFF',
    'discharge-mos-on': 'DISCHARGE_ON',
    'charge-mos-off': 'CHARGE_OFF',
    'charge-mos-on': 'CHARGE_ON',
    'save-apply': 'SAVE',
    'current-zero': 'CURRENT_ZERO',
    restart: 'RESTART',
    shutdown: 'SHUTDOWN',
    'factory-reset': 'FACTORY_RESET',
    'balance-on': 'BALANCE_ON',
    'balance-off': 'BALANCE_OFF',
    'clear-system-log': 'CLEAR_LOG',
    'bluetooth-init': 'BLUETOOTH_INIT',
    'bluetooth-off': 'BLUETOOTH_OFF',
    'bluetooth-on': 'BLUETOOTH_ON',
    'buzzer-on': 'BUZZER_ON',
    'buzzer-off': 'BUZZER_OFF',
    'clear-discharge-cycle-ah': 'CLEAR_DISCHARGE_AH',
    'clear-charge-cycle-ah': 'CLEAR_CHARGE_AH',
    'clear-discharge-time': 'CLEAR_DISCHARGE_TIME',
    'clear-charge-time': 'CLEAR_CHARGE_TIME',
    'clear-running-time': 'CLEAR_RUNTIME',
    'clear-protect-time': 'CLEAR_PROTECT_TIME',
    'load-lto-defaults': 'DEFAULTS_LTO',
    'load-nmc-defaults': 'DEFAULTS_NMC',
    'load-lfp-defaults': 'DEFAULTS_LFP',
    'reset-hardware': 'RESET_HARDWARE',
    'save-customer-data': 'SAVE_CUSTOMER_DATA',
    'user-parameters': 'USER_PARAMETERS',
  };
  for (const [suffix, key] of Object.entries(controls)) {
    assert.equal(hex(P.newControlRequest(P.CONTROL[/** @type {keyof typeof P.CONTROL} */ (key)])), vector(`new-req-control-${suffix}`).hex, key);
  }
  // Settings layer: engineering value -> raw -> write frame equals the captured writes.
  const writes = [
    ['cell.ovp', 3.65, 'new-req-write-cell-ovp-3650mv'],
    ['cell.ovpr', 3.55, 'new-req-write-cell-ovp-recovery-3550mv'],
    ['charge.ocp', 50, 'new-req-write-charge-ocp-50a'],
    ['charge.ocp_delay', 5, 'new-req-write-charge-ocp-delay-5s'],
    ['discharge.ocp', 300, 'new-req-write-discharge-ocp-300a'],
    ['discharge.ocp_delay', 5, 'new-req-write-discharge-ocp-delay-5s'],
  ];
  for (const [id, value, vid] of writes) {
    const f = schema.groups.flatMap((g) => g.fields).find((x) => x.id === id);
    assert.ok(f && !f.readOnly, id);
    assert.equal(hex(P.newWriteRequest(f.meta.address, valueToRaw(f.meta, /** @type {number} */ (value)), f.meta.size)), vector(/** @type {string} */ (vid)).hex, id);
  }
});

test('CRC-16/MODBUS, extra section and frame validation', () => {
  assert.equal(crc16Modbus(Array.from('123456789', (c) => c.charCodeAt(0))), 0x4b37);
  for (const [extra, crc] of [
    ['FF0B0000', '41F2'],
    ['FF0A0000', '1032'],
    ['FF050000', '2031'],
  ]) {
    const c = crc16Modbus(fromHex(extra));
    assert.equal(hex([c & 0xff, c >> 8]), crc, extra);
  }
  const info = bytesOf('new-rsp-device-info-16zm');
  assert.ok(P.validateNewFrame(info));
  const badPrimary = info.slice();
  badPrimary[10] ^= 0x01;
  assert.equal(P.validateNewFrame(badPrimary), false);
  const badExtra = info.slice();
  badExtra[info.length - 4] ^= 0x01;
  assert.equal(P.validateNewFrame(badExtra), false);
  const badTail = bytesOf('new-rsp-control-ack-save');
  badTail[badTail.length - 1] = 0x56;
  assert.equal(P.validateNewFrame(badTail), false);
  // Response encoder reproduces captured frames including the extra section.
  const p = P.parseNewFrame(info);
  assert.equal(hex(P.encodeNewResponse(p.func, p.address, p.data, { status: /** @type {number} */ (p.extraStatus) })), hex(info));
  const old = bytesOf('old-rsp-status-14s-ble');
  assert.ok(P.isOldStatusFrame(old));
  const badOld = old.slice();
  badOld[40] ^= 0x10;
  assert.equal(P.validateOldStatus(badOld), false);
});

test('ANT_NEW assembler: BLE fragments, back to back frames, garbage, corrupt frames, U inside text', () => {
  const stream = vector('new-stream-device-info-then-status');
  /** @type {Uint8Array[]} */
  let frames = [];
  let asm = P.createNewAssembler({ onFrame: (f) => frames.push(f) });
  const bytes = fromHex(stream.hex);
  for (let i = 0; i < bytes.length; i += 20) asm.push(bytes.subarray(i, i + 20));
  assert.equal(frames.length, stream.expected.frameCount);
  assert.deepEqual(
    frames.map((f) => f.length),
    stream.expected.frameLengths,
  );
  assert.deepEqual(
    frames.map((f) => f[2]),
    stream.expected.frameFunctions,
  );

  // Every captured response, separated by junk, a corrupted copy and a lone 7E, in random chunks.
  const good = vectors.filter((v) => v.variant === 'ANT_NEW' && v.direction === 'rx' && v.id !== stream.id).map((v) => fromHex(v.hex));
  const corrupt = good[0].slice();
  corrupt[20] ^= 0xff;
  const junk = [0x00, 0x55, 0xaa, 0x55, 0xff, 0x7e];
  const parts = [Uint8Array.from(junk), corrupt];
  for (const g of good) parts.push(g, Uint8Array.from(junk));
  frames = [];
  /** @type {string[]} */
  const reasons = [];
  asm = P.createNewAssembler({ onFrame: (f) => frames.push(f), onDiscard: (_b, reason) => reasons.push(reason) });
  feed(concat(...parts), (c) => asm.push(c), chunker(7));
  assert.deepEqual(
    frames.map((f) => hex(f)),
    good.map((g) => hex(g)),
  );
  assert.ok(reasons.length > 0, 'junk and the corrupt frame are reported');

  // A chunk ending on the 0x55 of "UB" inside a version string must not end the frame.
  const uFrame = bytesOf('new-rsp-device-info-22aaub-u-in-version');
  const split = uFrame.indexOf(0x55, 6) + 1;
  assert.ok(split > 6 && split < uFrame.length - 8);
  frames = [];
  asm = P.createNewAssembler({ onFrame: (f) => frames.push(f) });
  asm.push(uFrame.subarray(0, split));
  assert.equal(frames.length, 0);
  asm.push(uFrame.subarray(split));
  assert.equal(frames.length, 1);
  assert.equal(P.parseDeviceInfo(frames[0]).softwareVersion, '22AAUB00-241008A');
});

test('legacy and device side assemblers', () => {
  // Old status after an adapter echo, with ten 0xFF junk bytes appended (spec 3.6), in fragments.
  const status = bytesOf('old-rsp-status-8s-charging-2');
  const echo = P.oldStatusRequestUart();
  const ffs = new Uint8Array(10).fill(0xff);
  const newFrame = bytesOf('new-rsp-control-ack-save');
  /** @type {Uint8Array[]} */
  const frames = [];
  const asm = P.createLegacyAssembler({ onFrame: (f) => frames.push(f) });
  feed(concat(echo, status, ffs, newFrame, status), (c) => asm.push(c), chunker(3));
  assert.deepEqual(
    frames.map((f) => hex(f)),
    [echo, status, newFrame, status].map((f) => hex(f)),
  );

  // Device side: ANT_NEW requests of every length and old commands, back to back.
  const requests = vectors.filter((v) => v.direction === 'tx').map((v) => fromHex(v.hex));
  /** @type {Uint8Array[]} */
  const got = [];
  const dev = P.createRequestAssembler({ onFrame: (f) => got.push(f) });
  feed(concat(...requests), (c) => dev.push(c), chunker(11));
  assert.deepEqual(
    got.map((f) => hex(f)),
    requests.map((f) => hex(f)),
  );
});

test('status encoders reproduce captured frames', () => {
  for (const v of vectors.filter((x) => x.direction === 'rx' && /status/.test(x.id) && x.id !== 'new-stream-device-info-then-status')) {
    const b = fromHex(v.hex);
    if (v.variant === 'ANT_NEW') {
      assert.equal(hex(P.encodeStatus(P.parseStatus(b))), hex(b), v.id);
    } else {
      const parsed = P.parseOldStatus(b);
      assert.deepEqual(P.parseOldStatus(P.encodeOldStatus(parsed)), parsed, v.id);
    }
  }
});

test('snapshot mapping: sign, switches, temperatures, alarms, extras', () => {
  const dis = newStatusSnapshot(P.parseStatus(bytesOf('new-rsp-status-22s-discharging')));
  assert.equal(dis.current, -2.2);
  assert.equal(dis.power, -111);
  assert.equal(deriveSnapshot({ ...dis, timestamp: 1 }).state, 'discharging');
  assert.deepEqual(dis.switches, { charge: true, discharge: true, balance: false });
  assert.deepEqual(
    dis.temperatures?.map((t) => t.id),
    ['t1', 't2', 't3', 't4', 'mos', 'balancer'],
  );
  assert.equal(dis.extra?.systemState.value, 'Discharging');
  assert.equal(dis.extra?.batteryType.value, 'Lithium titanate (LTO)');
  assert.deepEqual(dis.alarms, []);

  const prot = newStatusSnapshot(P.parseStatus(bytesOf('new-rsp-status-14s-charge-protect')));
  assert.deepEqual(
    prot.temperatures?.map((t) => t.id),
    ['t1', 't2', 't4', 'mos', 'balancer'],
    'the -40 probe is absent',
  );
  assert.equal(prot.switches?.charge, false);
  assert.deepEqual(
    prot.alarms?.map((a) => [a.id, a.severity, a.source]),
    [['cell_overvoltage', 'protection', 'protection bit 1']],
  );
  assert.equal(prot.extra?.chargeMos.value, 'Cell overvoltage protection');

  const off = newStatusSnapshot(P.parseStatus(bytesOf('new-rsp-status-22s-both-mos-off')));
  assert.deepEqual(off.switches, { charge: false, discharge: false, balance: false });
  assert.deepEqual(off.alarms?.map((a) => a.id).sort(), ['ant.charge_manual_off', 'ant.discharge_manual_off']);
  assert.equal(off.extra?.dischargeMos.value, 'Switched off manually');

  const low = newStatusSnapshot(P.parseStatus(bytesOf('new-rsp-status-16s-soc-low')));
  assert.deepEqual(low.alarms?.map((a) => a.id).sort(), ['ant.soc_low_2', 'soc_low']);
  assert.equal(low.extra?.batteryType, undefined, 'battery type 0 is not reported');

  const standby = newStatusSnapshot(P.parseStatus(bytesOf('new-rsp-status-20s-standby-14b-block')));
  assert.ok(Math.abs(/** @type {number} */ (standby.extra?.timeToEmpty.value) - 2182 / 60) < 1e-9);

  // Charging: ANT reports negative current, the model positive. High word alarm bits keep their number.
  const base = P.parseStatus(bytesOf('new-rsp-status-16s-esphome'));
  const charging = P.parseStatus(P.encodeStatus({ ...base, current: -12.6, power: -666, protectionMask1: 1 << 8, warningMask0: 1 }));
  const snap = newStatusSnapshot(charging);
  assert.equal(snap.current, 12.6);
  assert.equal(snap.power, 666);
  assert.deepEqual(
    snap.alarms?.map((a) => [a.id, a.severity, a.source]),
    [
      ['ant.relay_stuck', 'fault', 'protection bit 40'],
      ['cell_overvoltage', 'warning', 'warning bit 0'],
    ],
  );
  const idle = newStatusSnapshot(base);
  assert.equal(Object.is(newStatusSnapshot({ ...base, current: 0 }).current, 0), true, 'no negative zero');
  assert.equal(idle.capacityFull, 280);

  // Old protocol: charging frame of a 2020 board, power placeholder of a 2021 board.
  const oldCharging = oldStatusSnapshot(P.parseOldStatus(bytesOf('old-rsp-status-8s-charging')));
  assert.equal(oldCharging.current, 10.7);
  assert.equal(oldCharging.power, 285);
  assert.equal(oldCharging.capacityFull, undefined, 'capacity 0 is not reported');
  const placeholder = oldStatusSnapshot(P.parseOldStatus(bytesOf('old-rsp-status-2021-board-power-9999')));
  assert.equal(placeholder.power, undefined);
  const derived = deriveSnapshot({ ...placeholder, timestamp: 1 });
  assert.ok(close(derived.power, /** @type {number} */ (placeholder.voltage) * /** @type {number} */ (placeholder.current)));
  assert.deepEqual(placeholder.switches, { charge: false, discharge: false });
  assert.deepEqual(placeholder.alarms?.map((a) => a.id).sort(), ['ant.charge_manual_off', 'ant.discharge_manual_off']);
  // Absent probes: 2020 boards fill 0 (NTC 3 and 4 of this frame), 2021 boards send -40 (spec 12.2 item 11).
  assert.deepEqual(
    oldCharging.temperatures?.map((t) => t.id),
    ['t1', 't2', 'mos', 'balancer'],
  );
  assert.deepEqual(
    placeholder.temperatures?.map((t) => t.id),
    ['t1', 't2', 'mos', 'balancer'],
  );
  const base2020 = P.parseOldStatus(bytesOf('old-rsp-status-8s-charging'));
  const ntc = (/** @type {number[]} */ temperatures, /** @type {Set<number>} */ seen = new Set()) =>
    oldStatusSnapshot({ ...base2020, temperatures }, seen)
      .temperatures?.filter((t) => t.kind === 'cell')
      .map((t) => `${t.id}=${t.value}`);
  assert.deepEqual(ntc([0, 15, 0, 0]), ['t1=0', 't2=15'], 'a leading 0 is a real 0 degC');
  assert.deepEqual(ntc([0, 0, 0, 0]), ['t1=0', 't2=0', 't3=0', 't4=0'], 'nothing tells absent from 0 degC');
  assert.deepEqual(ntc([5, 0, -40, -40]), ['t1=5', 't2=0'], 'with -40 for absent probes, 0 is a reading');
  const seen = new Set();
  ntc([3, 2, 0, 0], seen);
  assert.deepEqual(ntc([1, 0, 0, 0], seen), ['t1=1', 't2=0'], 'a probe that reported a value stays visible at 0 degC');
  const oldProt =oldStatusSnapshot(P.parseOldStatus(P.encodeOldStatus({ ...P.parseOldStatus(bytesOf('old-rsp-status-14s-ble')), chargeMosState: 2 })));
  assert.deepEqual(
    oldProt.alarms?.map((a) => [a.id, a.source]),
    [['cell_overvoltage', 'charge MOSFET state 2']],
  );
});

test('settings schema: ids, safety rules, conversions and relations', () => {
  const fields = schema.groups.flatMap((g) => g.fields);
  const legacy = buildAntLegacySchema().groups.flatMap((g) => g.fields);
  for (const f of [...fields, ...legacy]) {
    assert.ok(f.id in SETTINGS || f.id.startsWith('ant.'), `${f.id} is canonical or ant.*`);
    assert.ok(f.label && f.group in SETTING_GROUPS, `${f.id} has a label and a catalog group`);
    if (f.readOnly) assert.ok(f.description, `${f.id} explains why it is read only`);
    if (f.type === 'number' && !f.readOnly) assert.ok(Number.isFinite(f.min) && Number.isFinite(f.max), `${f.id} has limits`);
    if (f.type === 'action') assert.equal(f.group, 'actions');
  }
  // Registers confirmed by two sources are writable (spec 7.1), plus the temperature block and
  // the battery ID, which read correctly on hardware (2026-11-23).
  const temperatures = Array.from({ length: 20 }, (_, i) => 56 + 2 * i);
  const writable = fields.filter((f) => f.meta?.kind === 'register' && !f.readOnly).map((f) => f.meta.address);
  assert.deepEqual(
    writable.sort((a, b) => a - b),
    [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, ...temperatures, 104, 106, 108, 110, 112, 114, 116, 118, 124, 126, 128, 130, 132, 134, 140, 142, 144, 146, 150, 154, 158, 160, P.ADDR.PACK_ID, 378, 380, 382],
  );
  const readOnly = new Set(fields.filter((f) => f.meta?.kind === 'register' && f.readOnly).map((f) => f.meta.address));
  for (const a of [148, 156, 162, 166, 174, 194]) assert.ok(readOnly.has(a), `register ${a} is read only`);
  // Temperature limits stay on the right side of their recovery values.
  const temp = validateAll(schema, { 'charge.otp': 50, 'charge.otpr': 55, 'discharge.utp': 5, 'discharge.utpr': -5, 'ant.mos_ot_alarm': 80, 'ant.mos_ot_alarm_recovery': 70 });
  assert.ok(temp['charge.otp'] && temp['charge.otpr'], 'high protection above its recovery');
  assert.ok(temp['discharge.utp'] && temp['discharge.utpr'], 'low protection below its recovery');
  assert.equal(temp['ant.mos_ot_alarm'], undefined);
  assert.ok(!fields.some((f) => f.meta?.kind === 'register' && f.meta.address === 152), 'cell type register (encoding unverified) is not exposed');
  assert.deepEqual(
    legacy
      .filter((f) => !f.readOnly && f.type !== 'action')
      .map((f) => f.id)
      .sort(),
    ['ant.password', 'switch.charge', 'switch.discharge'],
  );
  // Danger flags on risky actions, Bluetooth switch only on serial links.
  const action = (/** @type {string} */ id) => fields.find((f) => f.id === id);
  for (const id of ['ant.restart', 'ant.shutdown', 'ant.factory_reset', 'ant.defaults_lfp', 'ant.current_zero']) assert.equal(action(id)?.danger, true, id);
  assert.equal(action('ant.bluetooth_off'), undefined);
  assert.ok(buildAntSchema({ serial: true }).groups.some((g) => g.fields.some((f) => f.id === 'ant.bluetooth_off')));
  assert.equal(fields.find((f) => f.id === 'ant.password')?.type, 'text');

  // Conversions.
  const meta = (/** @type {string} */ id) => /** @type {any} */ (fields.find((f) => f.id === id)).meta;
  assert.equal(rawToValue(meta('cell.ovp'), 0xffff), undefined, '0xFFFF means not configured');
  assert.equal(rawToValue(meta('discharge.utp'), 0xffec, 0), -20);
  assert.equal(valueToRaw(meta('pack.ovp'), 58.4), 584);
  assert.equal(valueToRaw(meta('cell.ovp'), 3.6), 3600);
  assert.throws(() => valueToRaw(meta('cell.ovp'), 70));
  assert.throws(() => valueToRaw(meta('cell.ovp'), -1));
  const image = createRegisterImage();
  const cap = new Uint8Array(4);
  new DataView(cap.buffer).setUint32(0, 280e6, true);
  storeBlock(image, 162, cap);
  assert.equal(capacityUnit(image, 280), 1e-6);
  assert.equal(capacityUnit(image, 100), undefined);
  new DataView(cap.buffer).setUint32(0, 280, true);
  storeBlock(image, 162, cap);
  assert.equal(capacityUnit(image, 280), 1);
  assert.equal(decodeSettings(schema, image, { capacityUnit: 1 })['capacity.nominal'], 280);

  // An unconfigured 2024 block (all 0xFFFF) gives no values at all.
  const unconfigured = P.parseReadResponse(bytesOf('new-rsp-read-voltage-block-unconfigured'));
  const empty = createRegisterImage();
  storeBlock(empty, unconfigured.address, unconfigured.data);
  assert.deepEqual(decodeSettings(schema, empty), {});

  // Cross-field rules (spec 7.2) apply to both fields of a pair.
  const errors = validateAll(schema, { 'cell.ovp': 3.5, 'cell.ovpr': 3.55, 'ant.cell_ovp2': 3.8, 'balance.trigger_delta': 0.005, 'ant.balance_stop_delta': 0.01 });
  assert.deepEqual(Object.keys(errors).sort(), ['ant.balance_stop_delta', 'balance.trigger_delta', 'cell.ovp', 'cell.ovpr']);
  assert.deepEqual(validateAll(schema, { 'cell.ovp': 3.65, 'cell.ovpr': 3.55, 'ant.cell_ovp2': 3.8, 'ant.cell_ovpr2': 3.7 }), {});
});

test('definitions: BLE profile, names, serial order, demo', () => {
  assert.deepEqual(
    antDrivers.map((d) => d.id),
    ['ant', 'ant-legacy'],
  );
  for (const d of antDrivers) {
    assert.equal(d.family, 'ant');
    assert.equal(d.vendor, 'ANT BMS');
    const p = d.links.ble?.profiles[0];
    assert.deepEqual([p?.service, p?.notify, p?.write, p?.chunkSize], [0xffe0, 0xffe1, 0xffe1, 20]);
    assert.deepEqual(
      d.links.serial?.profiles.map((s) => s.baudRate),
      [19200, 9600],
    );
  }
  assert.match(antDrivers[0].demo?.name ?? '', /^ANT-BLE/);
  assert.equal(antDrivers[1].demo, undefined);
  const registry = new DriverRegistry(antDrivers);
  const filters = registry.bleRequest({ selection: 'ant' }).request.filters;
  assert.deepEqual(filters, [{ namePrefix: 'ANT-BLE' }, { namePrefix: 'ANT@BLE' }]);
  const ffe0 = ['0000ffe0-0000-1000-8000-00805f9b34fb'];
  assert.deepEqual(
    registry.bleCandidates({ name: 'ANT@BLE24CBUB-1231\r', services: ffe0 }).map((c) => [c.definition.id, c.score]),
    [
      ['ant', 10],
      ['ant-legacy', 0],
    ],
  );
  // Old style names match both; the 2021 protocol is probed first (spec 11.2).
  assert.deepEqual(
    registry.bleCandidates({ name: 'ANT-BLE16S', services: ffe0 }).map((c) => c.definition.id),
    ['ant', 'ant-legacy'],
  );
  assert.ok(antDrivers[1].links.ble?.namePatterns?.some((re) => re.test('ANT-BLE24C-001')));
  assert.ok(!antDrivers[1].links.ble?.namePatterns?.some((re) => re.test('ANT-BLE24BHUB')));
});

test('simulator round trip over a fragmented link', async () => {
  const { host, device } = createLinkPair({ deviceChunkSize: 20 });
  await host.open();
  await device.open();
  const sim = createAntSimulator(device, { tickMs: 0 });
  const ch = new FrameChannel(host, { createAssembler: P.createNewAssembler, describe: P.describe }).start();
  const req = (/** @type {Uint8Array} */ bytes, /** @type {number} */ func) => ch.request(bytes, { match: (f) => f[2] === func, timeout: 500 });

  const st = P.parseStatus(await req(P.newStatusRequest(), P.RSP.STATUS));
  assert.equal(st.cellCount, 16);
  assert.equal(st.optionalBlockBytes, 12);
  assert.equal(st.temperatures.at(-1), P.ABSENT_TEMPERATURE);
  assert.ok(Math.abs(st.packVoltage - st.cellVoltages.reduce((a, b) => a + b, 0)) < 0.011);

  // Permission level 0: pages read as 0xFF bytes until a password grants read access.
  assert.equal(st.permission, 0);
  const locked = P.parseDeviceInfo(await req(P.newDeviceInfoRequest(), P.RSP.READ));
  assert.deepEqual([locked.hardwareVersion, locked.softwareVersion], ['', '']);
  const auth = P.parseAuthResponse(await req(P.newAuthRequest(P.DEFAULT_PASSWORD_L1, P.ADDR.PASSWORD_L1), P.RSP.AUTH));
  assert.equal(auth.permissionLevel, 1);
  const info = P.parseDeviceInfo(await req(P.newDeviceInfoRequest(), P.RSP.READ));
  assert.deepEqual([info.hardwareVersion, info.softwareVersion, info.extraStatus], ['16ZMB0TB120A', '16ZMUB00-220501A', P.EXTRA.READ]);

  const block = P.parseReadResponse(await req(P.newReadRequest(0, 52), P.RSP.READ));
  const image = createRegisterImage();
  storeBlock(image, 0, block.data);
  assert.equal(decodeSettings(schema, image)['cell.ovp'], 3.65);

  // Controls are ignored until a password was accepted (simulator model of the spec 4.3 reports).
  assert.equal(P.parseControlResponse(await req(P.newControlRequest(P.CONTROL.CHARGE_OFF), P.RSP.CONTROL)).result, 1);
  assert.equal(sim.battery.switches.charge, true);
  assert.equal(P.parseAuthResponse(await req(P.newAuthRequest('wrong'), P.RSP.AUTH)).permissionLevel, 0);
  assert.equal(P.parseAuthResponse(await req(P.newAuthRequest(P.DEFAULT_PASSWORD_L5), P.RSP.AUTH)).permissionLevel, 5);
  await req(P.newControlRequest(P.CONTROL.CHARGE_OFF), P.RSP.CONTROL);
  assert.equal(sim.battery.switches.charge, false);
  const after = P.parseStatus(await req(P.newStatusRequest(), P.RSP.STATUS));
  assert.equal(after.chargeMosState, 15);
  assert.equal((after.protectionMask0 >>> 21) & 1, 1);

  const echo = P.parseWriteResponse(await req(P.newWriteRequest(0, 3600), P.RSP.WRITE));
  assert.deepEqual([echo.address, echo.rawValue, echo.extraStatus], [0, 3600, P.EXTRA.WRITE]);
  assert.equal(P.parseReadResponse(await req(P.newReadRequest(0, 2), P.RSP.READ)).rawValue, 3600);
  assert.equal(P.parseControlResponse(await req(P.newControlRequest(P.CONTROL.CLEAR_LOG), P.RSP.CONTROL)).result, 3);
  ch.stop();

  // Like most 2021 boards the simulator also answers the old status request, power reads 9999.
  const legacy = new FrameChannel(host, { createAssembler: P.createLegacyAssembler, describe: P.describe }).start();
  const old = P.parseOldStatus(await legacy.request(P.oldStatusRequestBt(), { match: P.isOldStatusFrame, timeout: 500 }));
  assert.equal(old.cellCount, 16);
  assert.equal(old.power, P.OLD_POWER_PLACEHOLDER);
  legacy.stop();
  sim.stop();
  await host.close();
  await device.close();
});

/**
 * Session over a memory link with a simulator on the device side.
 * @param {(device: import('@ubms/transport').Link) => { stop: () => void }} createSim
 * @param {{ chunk?: number }} [opts]
 */
async function startSession(createSim, { chunk = 20 } = {}) {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(antDrivers), log, pollIntervalMs: 50, probeTimeoutMs: 1000 });
  const { host, device } = createLinkPair({ log, deviceChunkSize: chunk });
  await device.open();
  const sim = createSim(device);
  const close = async () => {
    await session.disconnect();
    sim.stop();
    await device.close();
  };
  return { log, session, host, device, sim, close };
}

test('session: ANT 2021+ protocol end to end (snapshot, info, settings, writes, switches, actions)', async () => {
  const battery = new SimBattery({ cells: 16, capacityAh: 280, chemistry: 'lfp', soc: 72, tempSensors: 3, seed: 11 });
  battery.current = 12.5; // charging; the timer is off, so the value stays
  /** @type {ReturnType<typeof createAntSimulator>} */
  let sim = /** @type {any} */ (null);
  const s = await startSession((device) => (sim = createAntSimulator(device, { battery, tickMs: 0 })));
  const { session } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant' });
    assert.equal(session.state, 'connected');
    assert.equal(session.variant, 'ANT_NEW');

    const snap = await until(() => session.snapshot);
    assert.ok(close(snap.current, 12.5), `current ${snap.current} is positive while charging`);
    assert.equal(snap.state, 'charging');
    assert.ok(/** @type {number} */ (snap.power) > 0);
    assert.equal(snap.cells?.length, 16);
    assert.ok(Math.abs(/** @type {number} */ (snap.voltage) - /** @type {number} */ (snap.cellStats?.sum)) < 0.011);
    assert.equal(snap.soc, 72);
    assert.equal(snap.capacityFull, 280);
    assert.deepEqual(
      snap.temperatures?.map((t) => t.id),
      ['t1', 't2', 't3', 'mos', 'balancer'],
    );
    assert.deepEqual(snap.switches, { charge: true, discharge: true, balance: false });
    assert.equal(snap.extra?.systemState.value, 'Charging');

    const info = await until(() => (session.info?.softwareVersion ? session.info : null));
    assert.deepEqual([info.vendor, info.model, info.hardwareVersion, info.softwareVersion, info.name], ['ANT BMS', '16ZMB0TB120A', '16ZMB0TB120A', '16ZMUB00-220501A', 'ubms demo']);
    assert.equal(info.protocol, 'ANT 2021+ protocol');

    const settings = await session.loadSettings();
    assert.equal(settings.error, null);
    const values = /** @type {Record<string, any>} */ (settings.values);
    const expected = {
      'cell.ovp': 3.65,
      'cell.ovpr': 3.55,
      'pack.ovp': 58.4,
      'pack.uvp': 41.6,
      'charge.ocp': 150,
      'discharge.ocp2_delay': 300,
      'scp.current': 800,
      'charge.otp': 55,
      'discharge.utp': -20,
      'balance.trigger_delta': 0.01,
      'soc.low_alarm': 15,
      'system.cell_count': 16,
      'cell.power_off_voltage': 2.5,
      'capacity.nominal': 280,
      'capacity.remaining': 201.6,
      'charge.soc100_voltage': 3.45,
      'ant.pack_id': 'ubms demo',
      'switch.charge': true,
      'switch.discharge': true,
      'switch.balance': false,
    };
    for (const [id, v] of Object.entries(expected)) assert.equal(values[id], v, id);
    assert.ok(Object.keys(values).length >= 85, `${Object.keys(values).length} values`);
    // The password stays in the app: settings values end up in exports and log exports.
    assert.equal('ant.password' in values, false);
    assert.equal(JSON.stringify(values).includes(P.DEFAULT_PASSWORD_L5), false);

    // Wrong password: the switch command is ignored and the read-back reports it.
    let r = await session.writeSettings([{ id: 'ant.password', value: 'not-the-one' }]);
    assert.deepEqual([r[0].ok, r[0].verified], [true, undefined]);
    assert.equal(JSON.stringify(session.settings.values).includes('not-the-one'), false);
    r = await session.writeSettings([{ id: 'switch.discharge', value: false }]);
    assert.deepEqual([r[0].ok, r[0].verified], [true, false]);
    assert.equal(sim.battery.switches.discharge, true);
    r = await session.writeSettings([{ id: 'ant.password', value: P.DEFAULT_PASSWORD_L5 }]);
    assert.equal(r[0].ok, true);

    // Parameter write: password, write, save; verified by the read-back.
    r = await session.writeSettings([{ id: 'cell.ovp', value: 3.6 }]);
    assert.deepEqual([r[0].ok, r[0].verified], [true, true]);
    assert.equal(sim.registers[0] | (sim.registers[1] << 8), 3600);
    const writeAt = sim.received.findLastIndex((f) => f[0] === 0x7e && f[2] === P.FN.WRITE);
    assert.equal(sim.received[writeAt - 1][2], P.FN.AUTH, 'password right before the write');
    assert.deepEqual([sim.received[writeAt + 1][2], sim.received[writeAt + 1][3]], [P.FN.CONTROL, P.CONTROL.SAVE], 'save right after the write');
    assert.equal(session.settings.values?.['cell.ovp'], 3.6);

    // Validation and read-only rules.
    r = await session.writeSettings([
      { id: 'cell.ovp', value: 9 },
      { id: 'capacity.nominal', value: 100 },
    ]);
    assert.deepEqual(
      r.map((x) => x.ok),
      [false, false],
    );

    // Temperatures and the battery ID are written and read back.
    r = await session.writeSettings([
      { id: 'charge.otp', value: 50 },
      { id: 'discharge.utp', value: -15 },
      { id: 'ant.pack_id', value: 'Garage 48V' },
    ]);
    assert.deepEqual(
      r.map((x) => [x.id, x.ok, x.verified]),
      [
        ['charge.otp', true, true],
        ['discharge.utp', true, true],
        ['ant.pack_id', true, true],
      ],
    );
    assert.equal(session.settings.values?.['ant.pack_id'], 'Garage 48V');
    const idWrite = sim.received.findLast((f) => f[0] === 0x7e && f[2] === P.FN.WRITE && (f[3] | (f[4] << 8)) === P.ADDR.PACK_ID);
    assert.equal(idWrite?.[5], 32, 'the whole 32 byte battery ID is written, NUL padded');
    r = await session.writeSettings([{ id: 'ant.pack_id', value: 'Ünicode' }]);
    assert.equal(r[0].ok, false, 'non ASCII text is refused');

    // Switch off with verification, then on again like the overview toggle (no reload).
    r = await session.writeSettings([{ id: 'switch.charge', value: false }]);
    assert.deepEqual([r[0].ok, r[0].verified], [true, true]);
    assert.equal(sim.battery.switches.charge, false);
    assert.equal(session.snapshot?.switches?.charge, false);
    assert.ok(session.snapshot?.alarms?.some((a) => a.id === 'ant.charge_manual_off'));
    r = await session.writeSettings([{ id: 'switch.charge', value: true }], { reload: false });
    assert.equal(r[0].ok, true);
    assert.equal(sim.battery.switches.charge, true);
    await until(() => session.snapshot?.switches?.charge === true);

    // Buzzer has no read-back: the last command is reported.
    r = await session.writeSettings([{ id: 'switch.buzzer', value: true }]);
    assert.deepEqual([r[0].ok, r[0].verified], [true, true]);
    assert.equal(sim.state.buzzer, true);

    // One-shot action.
    await session.runAction('ant.clear_charge_ah');
    assert.equal(sim.state.totals.chargeAh, 0);
    await assert.rejects(session.runAction('cell.ovp'));
  } finally {
    await s.close();
  }
  assert.equal(session.state, 'idle');
});

test('session: auto detection on a serial port picks the 2021+ protocol at 19200 baud', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(antDrivers), log, pollIntervalMs: 50, probeTimeoutMs: 600 });
  /** @type {Array<{ stop: () => void }>} */
  const sims = [];
  /** @type {number[]} */
  const bauds = [];
  const port = {
    async openLink(/** @type {{ baudRate: number }} */ options) {
      bauds.push(options.baudRate);
      const { host, device } = createLinkPair({ log, kind: 'serial' });
      await host.open();
      await device.open();
      sims.push(createAntSimulator(device, { tickMs: 0 }));
      return host;
    },
  };
  try {
    await session.connect({ kind: 'serial', handle: port, selection: 'auto' });
    assert.equal(session.definition?.id, 'ant');
    assert.deepEqual(bauds, [19200]);
    // Serial links also offer the Bluetooth module switch.
    assert.ok(session.driver?.getSettingsSchema()?.groups.some((g) => g.fields.some((f) => f.id === 'ant.bluetooth_off')));
  } finally {
    await session.disconnect();
    for (const sim of sims) sim.stop();
  }
});

test('session: the legacy probe rejects a board that answers the 2021+ protocol', async () => {
  const s = await startSession((device) => createAntSimulator(device, { tickMs: 0 }));
  try {
    await assert.rejects(s.session.connect({ kind: 'link', link: s.host, selection: 'ant-legacy' }), /no valid answer/);
    assert.equal(s.session.state, 'error');
    // The simulator answered the old status request (2021 board), so the rejection came from step 5.
    assert.ok(s.log.entries().some((e) => e.kind === 'event' && /also answers the ANT 2021\+ protocol/.test(e.text ?? '')));
  } finally {
    await s.close();
  }
});

test('session: ANT legacy protocol end to end against the legacy simulator', async () => {
  const battery = new SimBattery({ cells: 14, capacityAh: 170, chemistry: 'nmc', soc: 41, tempSensors: 2, seed: 5 });
  battery.current = 8; // charging
  /** @type {ReturnType<typeof createAntLegacySimulator>} */
  let sim = /** @type {any} */ (null);
  const s = await startSession((device) => (sim = createAntLegacySimulator(device, { battery, tickMs: 0 })));
  const { session } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant-legacy' });
    assert.equal(session.variant, 'ANT_OLD');
    const snap = await until(() => session.snapshot);
    assert.ok(close(snap.current, 8), `current ${snap.current} is positive while charging`);
    assert.ok(/** @type {number} */ (snap.power) > 0);
    assert.equal(snap.cells?.length, 14);
    assert.deepEqual(
      snap.temperatures?.map((t) => t.id),
      ['t1', 't2', 'mos', 'balancer'],
    );
    assert.deepEqual(snap.switches, { charge: true, discharge: true });

    const settings = await session.loadSettings();
    const values = /** @type {Record<string, any>} */ (settings.values);
    for (const [id, v] of Object.entries({ 'cell.ovp': 4.2, 'pack.ovp': 58.8, 'charge.otp': 55, 'capacity.nominal': 170, 'system.cell_count': 14, 'ant.wheel_pulses': 0, 'switch.charge': true })) {
      assert.equal(values[id], v, id);
    }

    // Password frames, command and apply; the switch state follows.
    let r = await session.writeSettings([{ id: 'switch.charge', value: false }], { reload: false });
    assert.equal(r[0].ok, true);
    assert.equal(sim.battery.switches.charge, false);
    assert.equal(session.snapshot?.switches?.charge, false);
    const at = sim.received.findLastIndex((f) => f[0] === P.OLD_HEADER.WRITE && f[2] === P.OLD_CONTROL.CHARGE);
    assert.deepEqual(
      sim.received.slice(at - 4, at + 2).map((f) => f[2]),
      [0xf1, 0xf2, 0xf3, 0xf4, P.OLD_CONTROL.CHARGE, P.OLD_CONTROL.APPLY],
    );
    assert.equal(P.parseOldCommand(sim.received[at]).value, 0);

    // Wrong password: A5 A5 F5 00 01 F6 is reported as a rejection.
    r = await session.writeSettings([{ id: 'ant.password', value: '87654321' }], { reload: false });
    assert.equal(r[0].ok, true);
    r = await session.writeSettings([{ id: 'switch.charge', value: true }], { reload: false });
    assert.equal(r[0].ok, false);
    assert.match(r[0].error ?? '', /rejected/);
    assert.equal(sim.battery.switches.charge, false);
    r = await session.writeSettings([{ id: 'ant.password', value: '1234' }], { reload: false });
    assert.equal(r[0].ok, false, 'old passwords have 8 characters');

    r = await session.writeSettings([{ id: 'cell.ovp', value: 4.1 }]);
    assert.equal(r[0].ok, false, 'old protocol parameters are read only');
  } finally {
    await s.close();
  }
});

test('session: legacy settings fall back to the status when parameter reads are not answered', async () => {
  const s = await startSession((device) => createAntLegacySimulator(device, { tickMs: 0, answerParams: false }));
  try {
    await s.session.connect({ kind: 'link', link: s.host, selection: 'ant-legacy' });
    const settings = await s.session.loadSettings();
    assert.equal(settings.error, null);
    assert.deepEqual(Object.keys(/** @type {any} */ (settings.values)).sort(), ['switch.charge', 'switch.discharge']);
    assert.ok(s.log.entries().some((e) => e.kind === 'event' && /does not answer parameter reads/.test(e.text ?? '')));
  } finally {
    await s.close();
  }
});

/**
 * Serial host link that also receives every byte it writes, like a UART adapter with echo.
 * @param {ProtocolLog} log
 * @param {boolean} echo
 */
function serialPair(log, echo) {
  const pair = createLinkPair({ log, kind: 'serial' });
  if (echo) {
    const write = pair.host._write.bind(pair.host);
    pair.host._write = async (/** @type {Uint8Array} */ bytes) => {
      const copy = Uint8Array.from(bytes);
      queueMicrotask(() => {
        if (pair.host.state === 'open') pair.host._receive(copy);
      });
      return write(bytes);
    };
  }
  return pair;
}

test('session: legacy parameter reads on a UART adapter that echoes the requests', async () => {
  for (const [echo, answerParams] of [
    [true, false],
    [true, true],
    [false, true],
  ]) {
    const log = new ProtocolLog();
    const { host, device } = serialPair(log, echo);
    await host.open();
    await device.open();
    const sim = createAntLegacySimulator(device, { tickMs: 0, answerParams });
    // One zero parameter is enough (a 0 answer equals the request, so it waits for the timeout).
    sim.params.set(41, 1000);
    sim.params.set(45, 1);
    // A parameter this BMS does not answer: on the echoing adapter only the request comes back.
    if (echo) sim.params.delete(16);
    const session = new BmsSession({ registry: new DriverRegistry(antDrivers), log, pollIntervalMs: 100000 });
    const label = `echo ${echo}, answers ${answerParams}`;
    try {
      await session.connect({ kind: 'link', link: host, selection: 'ant-legacy' });
      const settings = await session.loadSettings();
      assert.equal(settings.error, null, label);
      const values = /** @type {Record<string, any>} */ (settings.values);
      if (!answerParams) {
        // The echo of an unanswered read is not a 0 answer: only the status values remain.
        assert.deepEqual(Object.keys(values).sort(), ['switch.charge', 'switch.discharge'], label);
        assert.ok(log.entries().some((e) => e.kind === 'event' && /does not answer parameter reads/.test(e.text ?? '')), label);
        continue;
      }
      // A parameter that is really 0 still reads 0, with or without the echo.
      for (const [id, v] of Object.entries({ 'cell.ovp': 4.2, 'capacity.nominal': 170, 'ant.wheel_circumference': 1000, 'ant.wheel_pulses': 0 })) {
        assert.equal(values[id], v, `${label}: ${id}`);
      }
      if (echo) assert.equal(values['ant.balance_current'], undefined, `${label}: the echo of an unanswered read is not a 0`);
    } finally {
      await session.disconnect();
      sim.stop();
      await device.close();
    }
  }
});

test('settings switches stay On while the BMS holds a MOSFET off, and Off after an off command', async () => {
  /**
   * Run a session whose status answers are patched with `override`.
   * @param {(device: any) => { stop: () => void }} make
   * @param {string} selection
   * @param {(frame: Uint8Array, override: Record<string, number>) => Uint8Array} patch
   * @param {Array<[Record<string, number>, Record<string, boolean>]>} cases
   */
  const run = async (make, selection, patch, cases) => {
    /** @type {Record<string, number>} */
    let override = {};
    const s = await startSession((device) => {
      const write = device.write.bind(device);
      device.write = (/** @type {Uint8Array} */ bytes, /** @type {any} */ meta) => write(patch(bytes, override), meta);
      return make(device);
    });
    try {
      await s.session.connect({ kind: 'link', link: s.host, selection });
      for (const [o, want] of cases) {
        override = o;
        const values = /** @type {Record<string, any>} */ ((await s.session.loadSettings()).values);
        for (const [id, v] of Object.entries(want)) assert.equal(values[id], v, `${selection} ${JSON.stringify(o)} ${id}`);
      }
      // The snapshot keeps the actual MOSFET state (off in the last case).
      await until(() => s.session.snapshot?.switches?.charge === false);
    } finally {
      await s.close();
    }
  };
  const newPatch = (/** @type {Uint8Array} */ f, /** @type {Record<string, number>} */ o) =>
    P.isStatusFrame(f) && f[2] === P.RSP.STATUS ? P.encodeStatus({ ...P.parseStatus(f), ...o }) : f;
  await run((device) => createAntSimulator(device, { tickMs: 0 }), 'ant', newPatch, [
    [{ chargeMosState: 2, protectionMask0: 1 << 1 }, { 'switch.charge': true, 'switch.discharge': true }],
    [{ chargeMosState: 4 }, { 'switch.charge': true }],
    // Switched off by command while a protection holds the MOSFET: state 2 with protection bit 21.
    [{ chargeMosState: 2, protectionMask0: (1 << 1) | (1 << 21) }, { 'switch.charge': false }],
    [{ chargeMosState: 15, dischargeMosState: 15, protectionMask0: (1 << 17) | (1 << 21) }, { 'switch.charge': false, 'switch.discharge': false }],
    [{ chargeMosState: 0 }, { 'switch.charge': false }],
  ]);
  const oldPatch = (/** @type {Uint8Array} */ f, /** @type {Record<string, number>} */ o) => (P.isOldStatusFrame(f) ? P.encodeOldStatus({ ...P.parseOldStatus(f), ...o }) : f);
  // No parameter answers: the settings load stops after the first unanswered read.
  await run((device) => createAntLegacySimulator(device, { tickMs: 0, answerParams: false }), 'ant-legacy', oldPatch, [
    [{ chargeMosState: 4, dischargeMosState: 2 }, { 'switch.charge': true, 'switch.discharge': true }],
    [{ chargeMosState: 15 }, { 'switch.charge': false }],
    [{ chargeMosState: 0 }, { 'switch.charge': false }],
  ]);
});

// ---------------------------------------------------------------------------------------------
// Read access (field log of an ANT-BLE20PHUB, ubms-log-2026-11-20T10-26-50.json)
// ---------------------------------------------------------------------------------------------

/** Frames of the field log: status at permission level 0, then parameter and version pages of 0xFF bytes. */
const FIELD = {
  status:
    '7EA11100007E0002020800000000000000000000C401000000000000000000000000000D020D010D010D010D010D000D000D0F000F0011001200680AE9FF630064000101000000B10819D3465C18ACE68B03C3FFFFFF1916EF0500000000020D0200000D01000200000D000080007C00B202F2FA1CAA86033C23910322630202AA4C4B0126F0AA55',
  packIdPage: `7EA112060120${'FF'.repeat(32)}B94EFF01000424090400363DAA55`,
  versionPage: `7EA1126C0220${'FF'.repeat(32)}6B36FF0100048A1409008243AA55`,
};

test('field log: permission level 0 and parameter pages of 0xFF bytes', () => {
  const st = P.parseStatus(fromHex(FIELD.status));
  assert.deepEqual([st.permission, st.cellCount, st.packVoltage], [0, 8, 26.64]);
  const page = P.parseReadResponse(fromHex(FIELD.packIdPage));
  assert.deepEqual([page.address, page.data.length, isBlankPage(page.data)], [262, 32, true]);
  const version = P.parseDeviceInfo(fromHex(FIELD.versionPage));
  assert.deepEqual([version.hardwareVersion, version.softwareVersion], ['', '']);
  assert.equal(isBlankPage(Uint8Array.of(0xff, 0x00)), false);
  assert.equal(isBlankPage(new Uint8Array(0)), false);
});

test('session: logs in before reading when the status reports permission level 0', async () => {
  /** @type {ReturnType<typeof createAntSimulator>} */
  let sim = /** @type {any} */ (null);
  const s = await startSession((device) => (sim = createAntSimulator(device, { tickMs: 0 })));
  const { session } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant' });
    const info = await until(() => (session.info?.softwareVersion ? session.info : null));
    assert.equal(info.hardwareVersion, '16ZMB0TB120A');
    const settings = await session.loadSettings();
    assert.equal(settings.error, null);
    assert.equal(settings.notice, null);
    assert.equal(settings.values?.['cell.ovp'], 3.65);
    // The default level 1 password, as the vendor app sends it, before the first page read.
    const firstRead = sim.received.findIndex((f) => f[0] === 0x7e && f[2] === P.FN.READ);
    const auth = sim.received.findIndex((f) => f[0] === 0x7e && f[2] === P.FN.AUTH);
    assert.ok(auth >= 0 && auth < firstRead, 'password before the first page read');
    assert.equal(u16(sim.received[auth], 3), P.ADDR.PASSWORD_L1);
  } finally {
    await s.close();
  }
});

test('session: empty pages without read access give a notice, the right password fixes it', async () => {
  /** @type {ReturnType<typeof createAntSimulator>} */
  let sim = /** @type {any} */ (null);
  const s = await startSession((device) => (sim = createAntSimulator(device, { tickMs: 0, password: 'own-pass', level1Password: null })));
  const { session } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant' });
    let settings = await session.loadSettings();
    assert.equal(settings.error, null, 'the switches and the password field stay usable');
    assert.equal(settings.values?.['cell.ovp'], undefined);
    assert.equal(settings.values?.['switch.charge'], true);
    assert.match(String(settings.notice), /did not grant read access/);
    assert.equal(settings.passwordField, 'ant.password', 'the UI offers the password with the notice');
    const r = await session.writeSettings([{ id: 'ant.password', value: 'own-pass' }]);
    assert.equal(r[0].ok, true);
    settings = await session.loadSettings();
    assert.equal(settings.notice, null);
    assert.equal(settings.passwordField, null);
    assert.equal(settings.values?.['cell.ovp'], 3.65);
    assert.ok(sim.received.some((f) => f[0] === 0x7e && f[2] === P.FN.AUTH && u16(f, 3) === P.ADDR.PASSWORD_L5));
  } finally {
    await s.close();
  }
});

test('session: a changed app password (level 1) typed once unlocks reading', async () => {
  /** @type {ReturnType<typeof createAntSimulator>} */
  let sim = /** @type {any} */ (null);
  const s = await startSession((device) => (sim = createAntSimulator(device, { tickMs: 0, level1Password: 'app-pass', password: 'factory-l5x' })));
  const { session } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant' });
    let settings = await session.loadSettings();
    assert.equal(settings.values?.['cell.ovp'], undefined);
    assert.equal(settings.passwordField, 'ant.password');
    await session.writeSettings([{ id: 'ant.password', value: 'app-pass' }]);
    settings = session.settings;
    assert.equal(settings.notice, null);
    assert.equal(settings.values?.['cell.ovp'], 3.65);
    const level1 = sim.received.filter((f) => f[0] === 0x7e && f[2] === P.FN.AUTH && u16(f, 3) === P.ADDR.PASSWORD_L1);
    assert.ok(level1.some((f) => String.fromCharCode(...f.subarray(6, 6 + f[5])) === 'app-pass'), 'the typed password tried as level 1');
  } finally {
    await s.close();
  }
});

/** Second field log of the same board (2026-11-20, 12:19): level 1, identity readable, parameters refused. */
const FIELD2 = {
  status:
    '7EA11100007E0102020800000000000000000000C4010000000000000000000000000C0D0D0D0C0D0C0D0D0D0B0D0C0D0C0D0F000F0010001100700AEEFF640064000101000000B108198C50971840EE8B03D0FFFFFFBB30EF05000000000D0D02000B0D060002000C0D000080007C00B202F2FA1CAA860364329103226302024C674B01295EAA55',
  packIdPage: '7EA1120601204E4F4445330000000000000000000000000000000000000000000000000000002BF7FF0B000041F2AA55',
  voltagePage: `7EA112000034${'FF'.repeat(52)}49A7FF01000432010300B187AA55`,
};

test('field log 2: level 1 serves the pack id and still refuses the parameter pages', () => {
  assert.equal(P.parseStatus(fromHex(FIELD2.status)).permission, 1);
  const id = P.parseReadResponse(fromHex(FIELD2.packIdPage));
  assert.deepEqual([id.address, isBlankPage(id.data), id.extraStatus], [262, false, 0x0b]);
  assert.equal(P.parsePackId(fromHex(FIELD2.packIdPage)).packId, 'NODE3');
  const v = P.parseReadResponse(fromHex(FIELD2.voltagePage));
  assert.deepEqual([v.address, v.data.length, isBlankPage(v.data), v.extraStatus], [0, 52, true, 1]);
  // Six of seven pages blank, one readable: locked all the same, because block 0 is blank.
  assert.equal(parametersLocked({ answered: 7, blank: 6, blankAt: new Set([0, 56, 104, 140, 152, 378]) }), true);
  assert.equal(parametersLocked({ answered: 7, blank: 1, blankAt: new Set([262]) }), false, 'an empty pack id is not a lock');
  assert.equal(parametersLocked({ answered: 2, blank: 2, blankAt: new Set([56, 104]) }), true);
  assert.equal(parametersLocked({ answered: 0, blank: 0, blankAt: new Set() }), false);
});

test('session: parameters that need level 5 are unlocked with the factory password, unasked', async () => {
  /** @type {ReturnType<typeof createAntSimulator>} */
  let sim = /** @type {any} */ (null);
  const s = await startSession((device) => (sim = createAntSimulator(device, { tickMs: 0, paramReadLevel: 5 })));
  const { session } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant' });
    const info = await until(() => (session.info?.softwareVersion ? session.info : null));
    assert.equal(info.hardwareVersion, '16ZMB0TB120A', 'level 1 is enough for the versions');
    const settings = await session.loadSettings();
    assert.equal(settings.notice, null);
    assert.equal(settings.values?.['cell.ovp'], 3.65);
    assert.ok(sim.received.some((f) => f[0] === 0x7e && f[2] === P.FN.AUTH && u16(f, 3) === P.ADDR.PASSWORD_L5));
    assert.equal(JSON.stringify(session.log.export()).includes('unlocked with a factory password as level 5') || session.log.entries().some((e) => /unlocked with/.test(e.text ?? '')), true);
  } finally {
    await s.close();
  }
});

test('session: level 1 without the parameter password asks for it and remembers a failed one', async () => {
  /** @type {ReturnType<typeof createAntSimulator>} */
  let sim = /** @type {any} */ (null);
  const s = await startSession((device) => (sim = createAntSimulator(device, { tickMs: 0, paramReadLevel: 5, password: 'own-pass' })));
  const { session } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant' });
    let settings = await session.loadSettings();
    assert.equal(settings.values?.['cell.ovp'], undefined);
    assert.equal(settings.values?.['ant.pack_id'], 'ubms demo', 'the pack id page is readable at level 1');
    assert.match(String(settings.notice), /did not grant read access/);
    assert.equal(settings.passwordField, 'ant.password');
    const authCount = () => sim.received.filter((f) => f[0] === 0x7e && f[2] === P.FN.AUTH).length;
    const before = authCount();
    settings = await session.loadSettings();
    assert.equal(authCount(), before, 'a reload does not repeat the passwords that failed');
    assert.match(String(settings.notice), /did not grant read access/);
    await session.writeSettings([{ id: 'ant.password', value: 'own-pass' }]);
    assert.equal(session.settings.notice, null);
    assert.equal(session.settings.values?.['cell.ovp'], 3.65);
  } finally {
    await s.close();
  }
});

test('session: a factory password at level 3 unlocks the parameters', async () => {
  const s = await startSession((device) => createAntSimulator(device, { tickMs: 0, paramReadLevel: 3, password: 'other-l5', lowLevelPasswords: { 3: P.DEFAULT_PASSWORD_L1 } }));
  const { session } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant' });
    const settings = await session.loadSettings();
    assert.equal(settings.notice, null);
    assert.equal(settings.values?.['cell.ovp'], 3.65);
  } finally {
    await s.close();
  }
});

/** @param {Uint8Array[]} frames @param {number} func */
const countNew = (frames, func) => frames.filter((f) => f[0] === 0x7e && f[2] === func).length;

test('session: a silent BMS does not lock the settings blocks, and a silent read stops early', async () => {
  /** @type {ReturnType<typeof createAntSimulator>} */
  let sim = /** @type {any} */ (null);
  const s = await startSession((device) => (sim = createAntSimulator(device, { tickMs: 0 })));
  const { session } = s;
  session.pollIntervalMs = 100000;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant' });
    assert.equal((await session.loadSettings()).values?.['cell.ovp'], 3.65);
    sim.state.sleepUntil = Date.now() + 10 * 60 * 1000; // restarting, asleep or out of range
    for (let i = 0; i < 2; i++) {
      const before = countNew(sim.received, P.FN.READ);
      const settings = await session.loadSettings();
      assert.match(String(settings.error), /did not answer the settings requests/);
      assert.equal(countNew(sim.received, P.FN.READ) - before, 3, 'only the first block is requested (3 attempts)');
    }
    sim.state.sleepUntil = 0;
    const settings = await session.loadSettings();
    assert.equal(settings.error, null);
    assert.equal(settings.values?.['cell.ovp'], 3.65, 'every block is read again');
  } finally {
    await s.close();
  }
});

test('session: a block that fails while the BMS answers is left out for three reads, then read again', async () => {
  const block = 56;
  let drop = true;
  /** @type {ReturnType<typeof createAntSimulator>} */
  let sim = /** @type {any} */ (null);
  const s = await startSession((device) => {
    const write = device.write.bind(device);
    device.write = (/** @type {Uint8Array} */ bytes, /** @type {any} */ meta) =>
      drop && bytes[0] === 0x7e && bytes[2] === P.RSP.READ && u16(bytes, 3) === block ? Promise.resolve() : write(bytes, meta);
    return (sim = createAntSimulator(device, { tickMs: 0 }));
  });
  const { session } = s;
  session.pollIntervalMs = 100000;
  const requests = () => sim.received.filter((f) => f[0] === 0x7e && f[2] === P.FN.READ && u16(f, 3) === block).length;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant' });
    for (let i = 0; i < 2; i++) {
      const settings = await session.loadSettings();
      assert.equal(settings.values?.['cell.ovp'], 3.65);
      assert.equal(settings.values?.['charge.otp'], undefined);
    }
    const before = requests();
    drop = false;
    for (let i = 0; i < 3; i++) await session.loadSettings();
    assert.equal(requests(), before, 'skipped in the next three reads');
    const settings = await session.loadSettings();
    assert.equal(requests(), before + 1, 'requested again after that');
    assert.equal(typeof settings.values?.['charge.otp'], 'number');
  } finally {
    await s.close();
  }
});

test('session: legacy settings of a silent BMS report the silence and do not give up on the parameters', async () => {
  let mute = false;
  const s = await startSession((device) => {
    const write = device.write.bind(device);
    device.write = (/** @type {Uint8Array} */ bytes, /** @type {any} */ meta) => (mute ? Promise.resolve() : write(bytes, meta));
    return createAntLegacySimulator(device, { tickMs: 0 });
  });
  const { session } = s;
  session.pollIntervalMs = 100000;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant-legacy' });
    mute = true;
    let settings = await session.loadSettings();
    assert.match(String(settings.error), /did not answer the settings requests/, 'no cached switch values as a success');
    mute = false;
    settings = await session.loadSettings();
    assert.equal(settings.error, null);
    assert.equal(settings.values?.['cell.ovp'], 4.2, 'the parameters are read once the BMS answers again');
  } finally {
    await s.close();
  }
});

test('session: read access logins that the BMS refused are not repeated, level 1 gets at most 8 characters', async () => {
  /** @type {ReturnType<typeof createAntSimulator>} */
  let sim = /** @type {any} */ (null);
  const s = await startSession((device) => (sim = createAntSimulator(device, { tickMs: 0, password: 'OwnerSecret1', level1Password: 'ownerpw1' })));
  const { session } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'ant' });
    await until(() => session.info);
    let settings = await session.loadSettings();
    assert.equal(settings.passwordField, 'ant.password');
    const auth = () => sim.received.filter((f) => f[0] === 0x7e && f[2] === P.FN.AUTH);
    for (const f of auth()) {
      const address = u16(f, 3);
      assert.ok(address === P.ADDR.PASSWORD_L5 ? f[5] <= 12 : f[5] <= 8, `password frame at ${address} with ${f[5]} bytes`);
    }
    const before = auth().length;
    for (let i = 0; i < 3; i++) await session.loadSettings();
    assert.equal(auth().length, before, 'reloads send no password the BMS refused');
    await session.writeSettings([{ id: 'ant.password', value: 'ownerpw1' }]);
    settings = session.settings;
    assert.ok(auth().length > before, 'a typed password is tried');
    assert.equal(settings.values?.['cell.ovp'], 3.65);
  } finally {
    await s.close();
  }
});

/** @param {Uint8Array} b @param {number} at */
function u16(b, at) {
  return b[at] | (b[at + 1] << 8);
}

