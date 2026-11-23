import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProtocolLog, createLinkPair, fromHex, hex, concat, sleep, sum8, sum16, u16be, setU16le, setU32le, setU32be } from '@ubms/transport';
import { BmsSession, DriverRegistry, SETTING_GROUPS, SETTINGS, fieldMap, validateAll } from '@ubms/bms-core';
import * as P from '../src/jk/protocol.js';
import { buildJkSchema, buildJk04Schema, buildJkUartSchema } from '../src/jk/settings.js';
import { jkDrivers, jkBleDefinition, jkPbDefinition, jkUartDefinition, createJkSimulator, jk02Snapshot, jk04Snapshot, uartSnapshot, deviceInfoModel } from '../src/jk/index.js';
import { drivers } from '../src/index.js';

/** @type {Array<{ id: string, variant: string, link: string, direction: string, hex: string, expected: Record<string, any> }>} */
const vectors = JSON.parse(readFileSync(new URL('./vectors/jk.json', import.meta.url), 'utf8'));
const byId = (/** @type {string} */ id) => {
  const v = vectors.find((x) => x.id === id);
  assert.ok(v, `vector ${id}`);
  return /** @type {NonNullable<typeof v>} */ (v);
};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Decimals written in a number literal. @param {number} n */
function decimalsOf(n) {
  const s = String(n);
  if (s.includes('e')) return 12;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Deep comparison with a tolerance of half a unit in the last written decimal of the expected
 * number (vectors round to 3 or 4 decimals), at least 1e-6.
 * @param {any} actual
 * @param {any} expected
 * @param {string} path
 */
function assertClose(actual, expected, path) {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', `${path}: expected ${expected}, got ${JSON.stringify(actual)}`);
    const tol = Math.max(1e-6, 0.5 * 10 ** -decimalsOf(expected)) + 1e-12;
    assert.ok(Math.abs(actual - expected) <= tol, `${path}: got ${actual}, expected ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array, got ${JSON.stringify(actual)}`);
    assert.equal(actual.length, expected.length, `${path}: length`);
    expected.forEach((e, i) => assertClose(actual[i], e, `${path}[${i}]`));
  } else if (expected !== null && typeof expected === 'object') {
    for (const [k, e] of Object.entries(expected)) assertClose(actual?.[k], e, `${path}.${k}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

/**
 * Value of a vector key in a parsed object (vector names like cellVoltage11 map to arrays).
 * @param {Record<string, any>} parsed
 * @param {string} key
 * @param {any} expected
 */
function actualFor(parsed, key, expected) {
  let m;
  if ((m = /^cellVoltage(\d+)$/.exec(key))) return parsed.cellVoltages?.[Number(m[1]) - 1];
  if ((m = /^cellResistance(\d+)$/.exec(key))) return parsed.cellResistances?.[Number(m[1]) - 1];
  if (key === 'serialNumberFirst8') return parsed.serialNumber?.slice(0, 8);
  // ESPHome publishes the date as "20" + YYMMDD; the frame holds YYMMDD.
  if (key === 'manufacturingDate' && typeof expected === 'string' && expected.length === 8) return `20${parsed.manufacturingDate}`;
  return parsed[key];
}

/**
 * Run bytes through an assembler in chunks of the given sizes (cyclic).
 * @param {(h: { onFrame: (f: Uint8Array) => void, onDiscard?: (b: Uint8Array, reason: string) => void }) => { push: (c: Uint8Array) => void }} factory
 * @param {Uint8Array} bytes
 * @param {number[]} [sizes]
 */
function assemble(factory, bytes, sizes = [bytes.length]) {
  /** @type {Uint8Array[]} */
  const frames = [];
  let discarded = 0;
  const asm = factory({ onFrame: (f) => frames.push(f), onDiscard: (b) => (discarded += b.length) });
  for (let o = 0, k = 0; o < bytes.length; k++) {
    const n = sizes[k % sizes.length];
    asm.push(bytes.subarray(o, o + n));
    o += n;
  }
  return { frames, discarded };
}

/** @param {Uint8Array} frame @param {string} variant */
function parseData(frame, variant) {
  switch (frame[4]) {
    case P.FRAME_TYPE.SETTINGS:
      return P.parseSettings(frame, variant);
    case P.FRAME_TYPE.CELL_INFO:
      return variant === P.VARIANT.JK04 ? P.parseJk04CellInfo(frame) : P.parseCellInfo(frame, variant);
    case P.FRAME_TYPE.DEVICE_INFO:
      return P.parseDeviceInfo(frame);
    default:
      return P.parseEventLog(frame);
  }
}

/** Poll a condition. @param {() => any} cond @param {number} [timeout] */
async function waitFor(cond, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(20);
  }
  assert.fail('condition not met in time');
}

const AT = Uint8Array.from([0x41, 0x54, 0x0d, 0x0a]);

/** Device side write that ignores a closed link. @param {import('@ubms/transport').Link} device @param {Uint8Array} bytes */
const tx = (device, bytes) => {
  device.write(bytes).catch(() => {});
};
const STREAM_KEYS = new Set(['ackFrames', 'junkBytes', 'frameTypes', 'trailingAck', 'trailingJunkBytes', 'frameLength']);

// ---------------------------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------------------------

test('BLE data frame vectors decode to the documented values', () => {
  let checked = 0;
  for (const v of vectors.filter((x) => x.link === 'ble' && x.direction === 'rx')) {
    const bytes = fromHex(v.hex);
    const keys = Object.keys(v.expected).filter((k) => !STREAM_KEYS.has(k));
    if (bytes.length < P.DATA_FRAME_LENGTH || !keys.length) continue;
    const frame = bytes.subarray(0, P.DATA_FRAME_LENGTH);
    const parsed = parseData(frame, v.variant);
    for (const k of keys) assertClose(actualFor(parsed, k, v.expected[k]), v.expected[k], `${v.id}.${k}`);
    checked++;
  }
  assert.ok(checked >= 45, `checked ${checked} frames`);
});

test('BLE ACK, AT text, trailing bytes and notify stream vectors reassemble as documented', () => {
  const ack = byId('ble-rx-ack-c8');
  assertClose(P.parseCommandFrame(fromHex(ack.hex)), ack.expected, ack.id);
  assert.ok(P.isAckFrame(fromHex(ack.hex)));

  for (const v of vectors.filter((x) => x.link === 'ble' && x.direction === 'rx' && Object.keys(x.expected).some((k) => STREAM_KEYS.has(k)))) {
    for (const sizes of [[20], [128, 128, 44], [1000]]) {
      const { frames, discarded } = assemble(P.createBleAssembler, fromHex(v.hex), sizes);
      const data = frames.filter((f) => f.length === P.DATA_FRAME_LENGTH);
      const acks = frames.filter((f) => P.isAckFrame(f));
      const e = v.expected;
      if ('ackFrames' in e) assert.equal(acks.length, e.ackFrames, `${v.id} ACK frames`);
      if ('junkBytes' in e) assert.equal(discarded, e.junkBytes, `${v.id} junk bytes`);
      if ('frameTypes' in e) assert.deepEqual(data.map((f) => f[4]), e.frameTypes, `${v.id} frame types`);
      if ('trailingAck' in e) assert.equal(acks.length > 0, e.trailingAck, `${v.id} trailing ACK`);
      if ('trailingJunkBytes' in e) assert.equal(discarded, e.trailingJunkBytes, `${v.id} trailing junk`);
      if ('frameLength' in e) assert.equal(data[0]?.length, e.frameLength, `${v.id} frame length`);
    }
  }
});

test('a frame with a wrong checksum is rejected by the BLE assembler', () => {
  const v = byId('batmon-b2a8s30p-fw1904-corrupt-cell-info');
  const bytes = fromHex(v.hex);
  assert.equal(P.parseCellInfo(bytes).checksumValid, false);
  assert.equal(P.isDataFrame(bytes), false);
  const { frames } = assemble(P.createBleAssembler, bytes, [20]);
  assert.equal(frames.length, 0);
});

test('BLE command vectors equal the encoder output', () => {
  for (const v of vectors.filter((x) => x.link === 'ble' && x.direction === 'tx')) {
    const bytes = fromHex(v.hex);
    const e = v.expected;
    /** @type {Uint8Array} */
    let encoded;
    if (v.variant === 'JK04' && e.length) encoded = P.encodeJk04Write(e.register, e.length, e.value);
    else if (e.ascii !== undefined) encoded = P.encodeTextWrite(e.register, e.ascii);
    else if (e.length === 0) encoded = P.encodeCommand(e.register);
    else encoded = P.encodeWrite(e.register, e.length, e.rawValue);
    const parsed = P.parseCommandFrame(bytes);
    assert.ok(parsed.checksumValid, `${v.id} checksum`);
    const filler = bytes.subarray(6 + e.length, 19);
    if (filler.every((b) => b === 0)) {
      assert.equal(hex(encoded), hex(bytes), v.id);
    } else {
      // Captured from the JK app: random filler before the checksum (spec 3.1). Same command bytes.
      assert.equal(hex(encoded.subarray(0, 6 + e.length)), hex(bytes.subarray(0, 6 + e.length)), v.id);
    }
    const { value: _value, note: _note, ...rest } = e;
    if (v.variant !== 'JK04') assertClose(parsed, rest, v.id);
  }
  // Named request helpers.
  assert.equal(hex(P.deviceInfoRequest()), byId('ble-cmd-device-info-jk02-32s').hex);
  assert.equal(hex(P.settingsRequest()), byId('ble-cmd-settings-and-stream-jk02-32s').hex);
  assert.equal(hex(P.eventLogRequest()), byId('ble-cmd-logbook').hex);
  assert.equal(hex(P.ackFrame()), byId('ble-rx-ack-c8').hex);
});

test('JK-PB RS485 vectors: trigger and write encoders, 300 byte answers with the FC 0x10 answer', () => {
  for (const v of vectors.filter((x) => x.variant === 'JK_PB_MODBUS')) {
    const bytes = fromHex(v.hex);
    const e = v.expected;
    if (v.direction === 'tx') {
      const req = P.parseModbusRequest(bytes);
      assert.ok(req.crcValid, `${v.id} CRC`);
      /** @type {Uint8Array} */
      let encoded;
      if (bytes[1] === 0x03) encoded = P.modbusReadRequest(e.address, e.register, e.quantity);
      else if (e.expectFrameType !== undefined) encoded = P.pbTriggerRequest(e.address, e.register);
      else if (e.quantity === 2) encoded = P.pbWriteU32(e.address, e.register, e.value);
      else encoded = P.pbWriteU16(e.address, e.register, e.value);
      assert.equal(hex(encoded), v.hex, v.id);
      const { setting: _s, expectFrameType, ...rest } = e;
      assertClose(req, rest, v.id);
      if (expectFrameType !== undefined) assert.equal(P.PB_TRIGGER_TYPE[req.register], expectFrameType, `${v.id} frame type`);
      continue;
    }
    const { frames } = assemble(P.createPbAssembler(), bytes, [64]);
    if (bytes.length === 5) {
      assert.equal(frames.length, 1, v.id);
      assertClose(P.parseModbusResponse(frames[0]), e, v.id);
      continue;
    }
    const frame = frames.find((f) => f.length === P.DATA_FRAME_LENGTH);
    const ack = frames.find((f) => f.length === 8);
    assert.ok(frame && ack, `${v.id} frame and answer`);
    const parsed = { ...parseData(frame, P.VARIANT.JK02_32S), frameCounterByte5: frame[5], ackHex: hex(ack) };
    for (const [k, x] of Object.entries(e)) assertClose(actualFor(parsed, k, x), x, `${v.id}.${k}`);
    assert.ok(P.isPbWriteAck(ack, 1, u16be(ack, 2)));
  }
});

test('4E57 UART vectors: request encoders and reply parsing', () => {
  for (const v of vectors.filter((x) => x.variant === 'JK_UART_4E57')) {
    const bytes = fromHex(v.hex);
    const e = v.expected;
    assert.ok(P.validateUartFrame(bytes), `${v.id} checksum`);
    if (v.direction === 'tx') {
      const req = P.parseUartRequest(bytes);
      assertClose(req, e, v.id);
      const info = req.value === undefined ? (bytes[8] === P.UART_CMD.PAIR ? [0, 0] : [req.dataId]) : [req.dataId, req.value];
      assert.equal(hex(P.encodeUartFrame({ command: req.command, source: req.source, transportType: req.transportType, info })), v.hex, v.id);
      continue;
    }
    const { frames } = assemble(P.createUartAssembler, bytes, [32]);
    assert.equal(frames.length, 1, `${v.id} assembled`);
    assert.ok(P.isUartReadReply(frames[0]), `${v.id} reply check`);
    assertClose(P.parseUartFrame(frames[0]), e, v.id);
  }
  assert.equal(hex(P.uartReadAll()), byId('uart-cmd-read-all-source-pc').hex);
  assert.equal(hex(P.uartSwitchWrite(P.UART_ID.CHARGE_SWITCH, 1)), byId('uart-cmd-write-charge-mos-on').hex);
  assert.equal(hex(P.uartSwitchWrite(P.UART_ID.DISCHARGE_SWITCH, 0)), byId('uart-cmd-write-discharge-mos-off').hex);
  assert.deepEqual(P.splitUartVersion('H7.X__S7.1.0H__'), { hardwareVersion: 'H7.X', softwareVersion: '7.1.0H' });
  assert.deepEqual(P.splitUartVersion('11.XW_S11.261__'), { hardwareVersion: '11.XW', softwareVersion: '11.261' });
  assert.equal(P.uartTemperature(101), -1);
  assert.equal(P.uartCurrent(0x80d0, 1), 2.08);
  assert.equal(P.uartCurrent(9500, 0), 5);
});

// ---------------------------------------------------------------------------------------------
// Framing and layouts
// ---------------------------------------------------------------------------------------------

/** A plausible 16 cell JK02 sample in parser field names. */
function sampleCell() {
  const cells = Array.from({ length: 16 }, (_, i) => 3.3 + (i % 5) * 0.002);
  return {
    cellVoltages: cells,
    cellResistances: cells.map((_, i) => 0.06 + i * 0.001),
    cellVoltageAverage: 3.304,
    cellVoltageDelta: 0.008,
    cellVoltageMaxIndex: 4,
    cellVoltageMinIndex: 0,
    temperatureMos: 25.3,
    temperature1: -4.5,
    temperature2: null,
    temperature3: 22.1,
    temperature4: null,
    temperature5: null,
    temperatureSensorMask: 0x0b,
    wireResistanceWarningMask: 0,
    totalVoltage: 52.864,
    powerRaw: 528.64,
    current: -10.5,
    errorsBitmask: (1 << 4) | (1 << 14) | (1 << 25),
    balanceCurrent: -0.25,
    balancingAction: 2,
    soc: 61,
    capacityRemaining: 170.8,
    fullChargeCapacity: 280,
    cycleCount: 12,
    totalCycleCapacity: 3400.5,
    soh: 98,
    precharging: 0,
    totalRuntime: 123456,
    chargingMos: true,
    dischargingMos: true,
    heating: false,
    emergencyTimeCountdown: 0,
    chargeStatus: 1,
    batteryType: 0,
  };
}

test('cell info, settings and device info encoders round trip through the parsers (24S and 32S)', () => {
  for (const variant of [P.VARIANT.JK02_32S, P.VARIANT.JK02_24S]) {
    const c = sampleCell();
    const cell = P.parseCellInfo(P.encodeCellInfo(c, variant, 7), variant);
    const { temperature3, temperature4, temperature5, chargeStatus, batteryType, temperatureSensorMask, errorsBitmask, ...common } = c;
    assertClose(cell, common, `${variant} cell info`);
    assert.equal(cell.errorsBitmask, variant === P.VARIANT.JK02_32S ? errorsBitmask : errorsBitmask & 0xffff, 'error bits (u16 on 24S)');
    assert.equal(cell.cellCount, 16);
    assert.equal(cell.frameCounter, 7);
    assert.equal(cell.cellVoltageMinNumber, 1);
    assert.equal(cell.cellVoltageMaxNumber, 5);
    if (variant === P.VARIANT.JK02_32S) assertClose(cell, { temperature3, chargeStatus, batteryType, temperatureSensorMask }, variant);
    else assert.equal(cell.temperature3, undefined);

    const s = { cellOvp: 3.65, cellOvpr: 3.4, cellUvp: 2.6, chargeUtp: -5, chargeSwitch: true, balancerSwitch: false, nominalCapacity: 280, scpDelay: 1500, balanceStartVoltage: 3.4 };
    const extra32 = { heatingEnabled: true, displayAlwaysOn: true, gpsLockedDischarging: false, heatingStartTemperature: -3, smartSleepDelay: 24, dischargeUtp: -10, prechargeTime: 4 };
    const settings = P.parseSettings(P.encodeSettings(variant === P.VARIANT.JK02_32S ? { ...s, ...extra32 } : s, variant), variant);
    assertClose(settings, s, `${variant} settings`);
    if (variant === P.VARIANT.JK02_32S) {
      assertClose(settings, extra32, `${variant} settings`);
      assert.equal(settings.controlsBitmask, 0x0011);
    }
  }
  const d = { model: 'JK_PB2A16S20P', hardwareVersion: '19A', softwareVersion: '19.27', uptime: 3600, powerOnCount: 5, deviceName: 'My pack', serialNumber: '506177F49001234', manufacturingDate: '250315', rcvTime: 0.5, uart1Protocol: 1, reBulkSoc: 5 };
  assertClose(P.parseDeviceInfo(P.encodeDeviceInfo(d)), d, 'device info');
});

test('BLE assembler: fragmented, back-to-back, 320 byte notifications, AT text and spliced frames', () => {
  const cell = P.encodeCellInfo(sampleCell(), P.VARIANT.JK02_32S, 1);
  const settings = P.encodeSettings({ cellOvp: 3.65 }, P.VARIANT.JK02_32S, 2);
  const ack = P.ackFrame();
  const stream = concat(AT, cell, ack, AT, settings, cell);
  for (const sizes of [[1], [7, 20, 128, 3], [20], [244], [stream.length]]) {
    const { frames, discarded } = assemble(P.createBleAssembler, stream, sizes);
    assert.deepEqual(
      frames.map((f) => (f.length === 20 ? 'ack' : f[4])),
      [2, 'ack', 1, 2],
      `chunks ${sizes}`,
    );
    assert.equal(discarded, 8, `AT text discarded with chunks ${sizes}`);
  }
  // 320 byte notifications: a frame followed by 20 more bytes (an ACK or zero filler).
  for (const tail of [ack, new Uint8Array(20)]) {
    const { frames } = assemble(P.createBleAssembler, concat(cell, tail, cell, tail), [320]);
    assert.equal(frames.filter((f) => f.length === 300).length, 2);
  }
  // A lost notification splices two frames: the complete frame after the fragment survives.
  for (const cut of [40, 150, 290]) {
    const { frames } = assemble(P.createBleAssembler, concat(settings.subarray(0, cut), cell, ack), [20]);
    assert.deepEqual(
      frames.map((f) => f.length),
      [300, 20],
      `fragment of ${cut} bytes`,
    );
    assert.equal(frames[0][4], P.FRAME_TYPE.CELL_INFO);
  }
});

test('JK-PB assembler skips adapter echo and stray bytes, keeps the answers of every address', () => {
  const answer = fromHex(byId('pb-rs485-response-type2-addr1').hex);
  const echo = P.pbTriggerRequest(1, P.PB_TRIGGER.CELL_INFO);
  const master = P.pbTriggerRequest(2, P.PB_TRIGGER.CELL_INFO);
  const other = P.modbusWriteAck(master);
  const stream = concat(echo, Uint8Array.of(0), master, other, answer.subarray(0, 300), Uint8Array.of(0), answer.subarray(300), Uint8Array.of(0));
  const { frames } = assemble(P.createPbAssembler(), stream, [17]);
  // The answer of pack 2 stays as a separator: the 300 byte frames carry no address.
  assert.deepEqual(
    frames.map((f) => f.length),
    [8, 300, 8],
  );
  assert.ok(P.isPbWriteAck(frames[0], 2, P.PB_TRIGGER.CELL_INFO));
  assert.ok(P.isPbWriteAck(frames[2], 1, P.PB_TRIGGER.CELL_INFO));
});

test('variant helpers: software version boundary and JK04 detection', () => {
  assert.equal(P.softwareMajor('19.27'), 19);
  assert.equal(P.softwareMajor('10.07D30'), 10);
  assert.equal(P.softwareMajor('8.0.3M'), 8);
  assert.ok(Number.isNaN(P.softwareMajor('')));
  assert.equal(P.variantFromSoftware('10.07'), P.VARIANT.JK02_24S);
  assert.equal(P.variantFromSoftware('11.48'), P.VARIANT.JK02_32S);
  assert.equal(P.variantFromSoftware('11.21h'), P.VARIANT.JK02_32S);
  for (const v of vectors.filter((x) => x.link === 'ble' && x.direction === 'rx' && x.hex.length === 600 && fromHex(x.hex)[4] === 2)) {
    assert.equal(P.looksLikeJk04CellInfo(fromHex(v.hex)), v.variant === 'JK04', `${v.id} JK04 test`);
  }
  // The captured JK04 has its balancer on (S114 = 1): ambiguous, so the settings test says no (spec 11.3).
  const jk04Settings = fromHex(byId('jk04-b5a24s-settings').hex);
  assert.equal(P.looksLikeJk04Settings(jk04Settings), false);
  const off = Uint8Array.from(jk04Settings);
  off[114] = 0;
  assert.equal(P.looksLikeJk04Settings(off), true);
  assert.equal(P.looksLikeJk04Settings(fromHex(byId('jk02-32s-v19-settings-full').hex)), false);
  assert.equal(P.looksLikeJk04Settings(fromHex(byId('syssi-b2a24s20p-fw1007-settings').hex)), false);
});

test('describe names every frame kind for the protocol log', () => {
  const frames = [
    P.deviceInfoRequest(),
    P.settingsRequest(),
    P.ackFrame(),
    P.encodeWrite(0x04, 4, 3650),
    fromHex(byId('jk02-32s-v19-cell-info').hex),
    fromHex(byId('jk02-32s-v19-settings').hex),
    fromHex(byId('jk02-32s-v19-device-info').hex),
    fromHex(byId('jk02-32s-logbook').hex),
    P.pbTriggerRequest(1, P.PB_TRIGGER.SETTINGS),
    fromHex(byId('pb-rs485-exception-illegal-value-addr2').hex),
    P.uartReadAll(),
    fromHex(byId('uart-rx-b1a20s15p-14s').hex),
  ];
  for (const f of frames) {
    const d = P.describe(f, P.VARIANT.JK02_32S);
    assert.ok(d?.name, `name for ${hex(f.subarray(0, 6))}`);
    assert.doesNotThrow(() => d?.decode?.());
  }
  assert.equal(P.describe(P.encodeWrite(0x04, 4, 3650), P.VARIANT.JK02_32S)?.name, 'Write cellOvp (0x04)');
  assert.equal(P.describe(P.encodeWrite(0x26, 4, 2500), P.VARIANT.JK02_24S)?.name, 'Write balanceStartVoltage (0x26)');
  assert.equal(P.describe(fromHex(byId('jk04-b5a24s-cell-info').hex))?.decode?.().balancingAction, 2);
});

// ---------------------------------------------------------------------------------------------
// Snapshots and device info
// ---------------------------------------------------------------------------------------------

test('JK02 snapshot: units, current sign, temperatures, alarms, switches and extras', () => {
  const c = P.parseCellInfo(P.encodeCellInfo(sampleCell(), P.VARIANT.JK02_32S), P.VARIANT.JK02_32S);
  const settings = P.parseSettings(P.encodeSettings({ nominalCapacity: 280, balancerSwitch: true, heatingEnabled: true }, P.VARIANT.JK02_32S), P.VARIANT.JK02_32S);
  const s = jk02Snapshot(c, { variant: P.VARIANT.JK02_32S, settings, firmwareMajor: 19 });
  assert.equal(s.current, -10.5, 'JK reports negative current while discharging, like the model');
  assert.equal(s.power, -555.072);
  assert.equal(s.voltage, 52.864);
  assert.equal(s.capacityNominal, 280);
  assert.equal(s.capacityFull, 280);
  assert.equal(s.cells?.length, 16);
  assert.equal(s.cellResistances?.[0], 60, 'milliohm');
  assert.equal(s.balanceCurrent, -0.25);
  assert.equal(s.balancingActive, true);
  // Mask 0x0B: MOSFET, T1 and T3 present; T2 is absent (-2000) anyway.
  assert.deepEqual(
    s.temperatures?.map((t) => [t.id, t.kind, t.value]),
    [
      ['mos', 'mos', 25.3],
      ['t1', 'cell', -4.5],
      ['t3', 'cell', 22.1],
    ],
  );
  assert.deepEqual(
    s.alarms?.map((a) => a.id),
    ['cell_overvoltage', 'short_circuit', 'jk.discharge_ocp2'],
  );
  assert.deepEqual(s.switches, { charge: true, discharge: true, balance: true, heater: true, precharge: false });
  assert.equal(s.extra?.heating?.value, false, 'heating enabled, heater not running');
  assert.equal(s.extra?.chargeStage?.value, 'Absorption');
  assert.equal(s.extra?.balancer?.value, 'Discharging balancer');
  assert.equal(s.extra?.batteryType?.value, 'LiFePO4');
  // 24S: no presence mask, no heater switch, bits 16+ ignored.
  const c24 = P.parseCellInfo(fromHex(byId('mppsolar-jk02-24s-cell-info-absent-sensors').hex), P.VARIANT.JK02_24S);
  const s24 = jk02Snapshot(c24, { variant: P.VARIANT.JK02_24S });
  assert.deepEqual(
    s24.temperatures?.map((t) => t.id),
    ['mos'],
  );
  assert.equal(s24.switches?.heater, undefined);
  assert.equal(s24.extra?.chargeStage, undefined);
  // A vector with a known current sign: charging on JK02_24S.
  const charging = jk02Snapshot(P.parseCellInfo(fromHex(byId('aiobmsble-jk02-24s-cell-info').hex), P.VARIANT.JK02_24S), { variant: P.VARIANT.JK02_24S });
  assert.equal(charging.current, 2.329);
  assert.ok(/** @type {number} */ (charging.power) > 0);
  // 24S bytes 202..205 are one i32 of unknown meaning: no heating current from its upper half.
  for (const id of ['mppsolar-jk02-24s-cell-info', 'mppsolar-jk02-24s-cell-info-discharging-balancer']) {
    const cell = P.parseCellInfo(fromHex(byId(id).hex), P.VARIANT.JK02_24S);
    assert.equal(cell.heatingCurrent, undefined, id);
    assert.equal(jk02Snapshot(cell, { variant: P.VARIANT.JK02_24S }).extra?.heatingCurrent, undefined, id);
  }
});

test('JK02_32S snapshot: temperatures 4 and 5 only from software 14 on (captured frames)', () => {
  const ids = (/** @type {string} */ id, /** @type {number} */ firmwareMajor) =>
    jk02Snapshot(P.parseCellInfo(fromHex(byId(id).hex).subarray(0, 300), P.VARIANT.JK02_32S), { variant: P.VARIANT.JK02_32S, firmwareMajor }).temperatures?.map((t) => [t.id, t.value]);
  // JK-B2A8S20P sw 11.48 and 11.50: all presence bits set, C256 and C258 read 0.
  assert.deepEqual(ids('aiobmsble-jk02-32s-cell-info', 11), [
    ['mos', 31],
    ['t1', 28.4],
    ['t2', 29.2],
    ['t3', 31],
  ]);
  assert.deepEqual(
    ids('batmon-b2a8s20p-fw1150-cell-info', 11)?.map(([id]) => id),
    ['mos', 't1', 't2', 't3'],
  );
  // Software 14.20 has them; an unknown version keeps them.
  assert.deepEqual(ids('jk02-32s-v11-cell-info', 14)?.slice(3), [
    ['t3', 17.3],
    ['t4', 17.9],
    ['t5', 18],
  ]);
  assert.equal(ids('aiobmsble-jk02-32s-cell-info', NaN)?.length, 6);
});

test('JK04 and 4E57 snapshots, device info mapping', () => {
  const j = jk04Snapshot(P.parseJk04CellInfo(fromHex(byId('jk04-b5a24s-cell-info-full').hex)), {
    settings: P.parseJk04Settings(fromHex(byId('jk04-b5a24s-settings').hex)),
  });
  assert.equal(j.cells?.length, 16);
  assert.equal(j.cells?.[0], 3.3167);
  assert.equal(j.balanceCurrent, -2.599);
  assert.equal(j.switches?.balance, true);
  assert.equal(j.current, undefined);

  const st = P.parseUartFrame(fromHex(byId('uart-rx-b1a20s15p-14s').hex));
  const u = uartSnapshot(st);
  assert.equal(u.current, 4.53);
  assert.equal(u.voltage, 55.78);
  // The balancer switch is the 0x9D setting (1 here); status bit 2 means balancing runs (spec 9.3).
  assert.deepEqual(u.switches, { charge: true, discharge: true, balance: true });
  assert.equal(u.balancingActive, false);
  assert.equal(u.extra?.batteryPresent, undefined);
  assert.deepEqual(
    u.temperatures?.map((t) => [t.id, t.value]),
    [
      ['mos', 33],
      ['t1', 28],
      ['t2', 30],
    ],
  );
  const lfp = uartSnapshot(P.parseUartFrame(fromHex(byId('uart-rx-bd6a17s6p-16s-lfp').hex)));
  assert.equal(lfp.current, -0.69);
  assert.equal(lfp.switches?.balance, true);
  assert.equal(lfp.balancingActive, false);
  for (const id of ['uart-rx-b2a24s15p-13s-liion', 'uart-rx-14s-protocol-doc']) {
    const s = uartSnapshot(P.parseUartFrame(fromHex(byId(id).hex)));
    assert.equal(s.balancingActive, true, id);
    assert.equal(s.switches?.balance, true, id);
    assert.equal(s.extra?.batteryPresent, undefined, id);
  }

  const info = deviceInfoModel(P.parseDeviceInfo(fromHex(byId('jk02-24s-v10-device-info').hex)), P.VARIANT.JK02_24S);
  assert.deepEqual(info, {
    vendor: 'JK BMS',
    model: 'JK-B2A24S20P',
    name: 'JK-B2A24S20P',
    hardwareVersion: '10.XG',
    softwareVersion: '10.07',
    serialNumber: '2041803028',
    manufactureDate: '2022-05-11',
    protocol: 'JK02_24S',
    uptime: info.uptime,
    powerOnCount: 1,
  });
});

// ---------------------------------------------------------------------------------------------
// Settings schemas
// ---------------------------------------------------------------------------------------------

/** @param {import('@ubms/bms-core/settings').SettingsSchema} schema */
function census(schema) {
  const fields = schema.groups.flatMap((g) => g.fields);
  return {
    fields,
    writable: fields.filter((f) => f.type !== 'action' && !f.readOnly).length,
    readOnly: fields.filter((f) => f.readOnly).length,
    actions: fields.filter((f) => f.type === 'action').length,
  };
}

test('settings schemas per variant use the right registers and keep unverified values read only', () => {
  const s32 = fieldMap(buildJkSchema({ variant: P.VARIANT.JK02_32S, cellCount: 16 }));
  const s24 = fieldMap(buildJkSchema({ variant: P.VARIANT.JK02_24S, cellCount: 16 }));
  const spb = fieldMap(buildJkSchema({ variant: P.VARIANT.JK02_32S, link: 'pb', cellCount: 8 }));
  const s04 = fieldMap(buildJk04Schema());
  const suart = fieldMap(buildJkUartSchema());

  // Registers that differ between the layouts (spec 12 item 5).
  assert.deepEqual(s32.get('balance.start_voltage')?.meta.write, { link: 'ble', register: 0x22, length: 4 });
  assert.deepEqual(s24.get('balance.start_voltage')?.meta.write, { link: 'ble', register: 0x26, length: 4 });
  assert.deepEqual(spb.get('balance.start_voltage')?.meta.write, { link: 'pb', register: 0x1084, size: 4 });
  assert.deepEqual(s32.get('jk.precharge_time')?.meta.write, { link: 'ble', register: 0x25, length: 4 });
  assert.equal(s24.has('jk.precharge_time'), false);
  assert.deepEqual(s32.get('switch.heater')?.meta.write, { link: 'ble', register: 0x27, length: 4 });
  assert.equal(s24.has('switch.heater'), false, '0x27 is a wire resistance register on JK02_24S');
  assert.deepEqual(spb.get('switch.display')?.meta.write, { link: 'pb', register: 0x1114, size: 2, bit: 4 });
  assert.deepEqual(s04.get('cell.power_off_voltage')?.meta.write, { link: 'ble', register: 0x20, length: 4, float: true });
  assert.deepEqual(s04.get('switch.balance')?.meta.write, { link: 'ble', register: 0x6c, length: 1, float: false });
  assert.equal(s04.has('capacity.nominal'), false, '0x20 is the power off voltage on JK04');

  // Unverified, inferred or without a write register: shown, never written.
  for (const [m, ids] of /** @type {Array<[Map<string, any>, string[]]>} */ ([
    [s32, ['scp.delay', 'jk.gps_heartbeat', 'jk.special_charger', 'system.address', 'identity.name', 'jk.wire_resistance_1', 'jk.data_stored_period']],
    [s24, ['scp.delay', 'jk.smart_sleep_voltage', 'jk.wire_resistance_16']],
    [spb, ['jk.heating_start_temperature', 'jk.smart_sleep_hours', 'jk.port_rs485', 'jk.rcv_time', 'jk.uart1_protocol', 'scp.delay']],
    [suart, ['cell.ovp', 'capacity.nominal', 'system.cell_count']],
  ])) {
    for (const id of ids) assert.equal(m.get(id)?.readOnly, true, `${id} read only`);
  }
  for (const id of ['switch.charge', 'switch.discharge', 'switch.balance']) assert.equal(suart.get(id)?.readOnly, undefined, `${id} writable on UART`);
  // Discharge low temperature: one signed byte at 0x3A / 0x3B over BLE (JK02_32S), no RS485 register.
  assert.deepEqual(s32.get('discharge.utp')?.meta.write, { link: 'ble', register: 0x3a, length: 1 });
  assert.deepEqual(s32.get('discharge.utpr')?.meta.write, { link: 'ble', register: 0x3b, length: 1 });
  assert.equal(spb.get('discharge.utp')?.readOnly, true);
  assert.equal(s24.has('discharge.utp'), false);
  // Calibration and actions only where they are confirmed: JK02_32S over BLE.
  for (const id of ['calibration.voltage', 'jk.restart', 'jk.factory_reset', 'jk.soc_full', 'jk.emergency_on']) {
    assert.ok(s32.has(id), id);
    assert.equal(s24.has(id), false, id);
    assert.equal(spb.has(id), false, id);
  }
  assert.equal(s32.get('jk.factory_reset')?.danger, true);
  assert.equal(s32.get('system.cell_count')?.danger, true);
  assert.equal(s32.get('system.cell_count')?.max, 32);
  assert.equal(s24.get('system.cell_count')?.max, 24);

  // Ids: canonical when in the catalog, otherwise jk. prefixed; groups known; unique.
  for (const m of [s32, s24, spb, s04, suart]) {
    for (const f of m.values()) {
      assert.ok(SETTINGS[f.id] || f.id.startsWith('jk.'), `id ${f.id}`);
      assert.ok(SETTING_GROUPS[f.group], `group ${f.group} of ${f.id}`);
      assert.ok(f.label && f.label !== f.id, `label of ${f.id}`);
      if (f.type === 'enum') assert.ok(f.options?.length, `options of ${f.id}`);
    }
  }
  const all = buildJkSchema({ variant: P.VARIANT.JK02_32S, cellCount: 32 }).groups.flatMap((g) => g.fields.map((f) => f.id));
  assert.equal(new Set(all).size, all.length, 'unique ids');
});

test('cross-field validators follow the JK rules', () => {
  const schema = buildJkSchema({ variant: P.VARIANT.JK02_32S });
  const ok = {
    'cell.ovp': 3.65,
    'cell.ovpr': 3.45,
    'cell.uvp': 2.6,
    'cell.uvpr': 2.8,
    'cell.power_off_voltage': 2.5,
    'charge.request_voltage': 3.5,
    'charge.float_voltage': 3.35,
    'charge.soc100_voltage': 3.45,
    'charge.soc0_voltage': 3.0,
    'balance.start_voltage': 3.4,
    'charge.utp': 2,
    'charge.utpr': 5,
    'mos.otp': 80,
    'mos.otpr': 70,
  };
  assert.deepEqual(validateAll(schema, ok), {});
  const bad = validateAll(schema, { ...ok, 'cell.ovpr': 3.7, 'charge.utpr': 0, 'cell.power_off_voltage': 2.7 });
  assert.ok(bad['cell.ovp'] && bad['cell.ovpr'], 'OVP / OVPR pair');
  assert.ok(bad['charge.utp'] && bad['charge.utpr'], 'UTP / UTPR pair');
  assert.ok(bad['cell.power_off_voltage'] && bad['cell.uvp'], 'power off below UVP');
  // 0 means "feature absent" for the request and float voltages: their rules are skipped.
  assert.deepEqual(validateAll(schema, { ...ok, 'charge.request_voltage': 0, 'charge.float_voltage': 0 }), {});
});

test('schema census per variant', () => {
  const counts = {
    'JK02_32S BLE': census(buildJkSchema({ variant: P.VARIANT.JK02_32S, cellCount: 16 })),
    'JK02_24S BLE': census(buildJkSchema({ variant: P.VARIANT.JK02_24S, cellCount: 16 })),
    'JK04 BLE': census(buildJk04Schema()),
    'JK-PB RS485': census(buildJkSchema({ variant: P.VARIANT.JK02_32S, link: 'pb', cellCount: 16 })),
    '4E57 UART': census(buildJkUartSchema()),
  };
  for (const [name, c] of Object.entries(counts)) {
    assert.ok(c.writable > 0, name);
    console.log(`${name}: ${c.writable} writable, ${c.readOnly} read only, ${c.actions} actions`);
  }
  assert.equal(counts['JK02_24S BLE'].actions, 0);
  assert.equal(counts['JK-PB RS485'].actions, 0);
  assert.equal(counts['4E57 UART'].writable, 3);
});

// ---------------------------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------------------------

test('simulator answers requests, streams and applies writes like the device', async () => {
  const { host, device } = createLinkPair({ deviceChunkSize: 20 });
  await host.open();
  await device.open();
  const sim = createJkSimulator(device, { streamMs: 0, junk: false, dropWritesMs: 400 });
  /** @type {Uint8Array[]} */
  const frames = [];
  const asm = P.createBleAssembler({ onFrame: (f) => frames.push(f) });
  host.on('data', (c) => asm.push(c));
  const types = () => frames.map((f) => (f.length === 20 ? 'ack' : f[4]));

  await host.write(P.deviceInfoRequest());
  await waitFor(() => frames.length >= 2);
  assert.deepEqual(types(), [3, 'ack']);
  assert.equal(P.parseDeviceInfo(frames[0]).softwareVersion, '19.27');

  frames.length = 0;
  await host.write(P.settingsRequest());
  await waitFor(() => frames.length >= 2);
  assert.deepEqual(types(), [1, 3]);
  assert.equal(P.parseSettings(frames[0]).cellOvp, 3.65);
  sim.sendCellInfo();
  await waitFor(() => frames.length >= 3);
  const cell = P.parseCellInfo(frames[2]);
  assert.equal(cell.cellCount, 16);
  assert.equal(P.cellInfoProblem(cell, P.VARIANT.JK02_32S), null);

  // Too soon after the settings request: acknowledged, not applied (spec 4.2).
  frames.length = 0;
  await host.write(P.encodeWrite(0x04, 4, 3600));
  await waitFor(() => frames.length >= 1);
  assert.ok(P.isAckFrame(frames[0]));
  assert.equal(sim.settings.cellOvp, 3.65);
  assert.equal(sim.state.droppedWrites, 1);
  await sleep(450);
  await host.write(P.encodeWrite(0x04, 4, 3600));
  await host.write(P.encodeWrite(0x1d, 4, 0));
  await host.write(P.encodeWrite(P.controlBitRegister(4), 4, 1));
  await host.write(P.encodeWrite(0xb5, 1, 45));
  await waitFor(() => frames.length >= 4);
  assert.equal(sim.settings.cellOvp, 3.6);
  assert.equal(sim.battery.switches.charge, false);
  assert.equal(sim.settings.displayAlwaysOn, true);
  assert.equal(sim.deviceInfo.emergencyDuration, 45);
  frames.length = 0;
  await host.write(P.settingsRequest());
  await waitFor(() => frames.length >= 1);
  const s = P.parseSettings(frames[0]);
  assert.equal(s.cellOvp, 3.6);
  assert.equal(s.chargeSwitch, false);
  assert.equal(s.displayAlwaysOn, true);
  sim.stop();
});

// ---------------------------------------------------------------------------------------------
// Session level: Bluetooth
// ---------------------------------------------------------------------------------------------

/**
 * Fake Web Bluetooth device handle whose channel is a memory link to a device simulator.
 * @param {ProtocolLog} log
 * @param {{ name?: string, attach?: (device: import('@ubms/transport').MemoryLink) => any }} [opts]
 */
function fakeBleHandle(log, { name = 'JK_PB2A16S20P', attach = (device) => createJkSimulator(device, { streamMs: 200 }) } = {}) {
  /** @type {any[]} */
  const sims = [];
  return {
    name,
    connected: false,
    sims,
    async connect() {
      this.connected = true;
    },
    async disconnect() {
      this.connected = false;
    },
    async discover() {
      return [{ uuid: '0000ffe0-0000-1000-8000-00805f9b34fb', characteristics: [] }];
    },
    /** @param {{ chunkSize?: number }} profile */
    async openChannel(profile) {
      const { host, device } = createLinkPair({ log, deviceChunkSize: profile.chunkSize ?? 20 });
      await host.open();
      await device.open();
      sims.push(attach(device));
      return host;
    },
  };
}

test('session: JK02_32S over Bluetooth with selection "jk", snapshots, settings write and switch', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(drivers), log, pollIntervalMs: 200 });
  const handle = fakeBleHandle(log);
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'ble', handle, selection: 'jk' });
  try {
    assert.equal(session.state, 'connected');
    assert.equal(session.definition?.id, 'jk-ble');
    assert.equal(session.variant, 'JK02_32S');
    assert.equal(session.driver?.capabilities.writeSettings, true);
    assert.equal(session.info?.model, 'JK_PB2A16S20P');
    assert.equal(session.info?.softwareVersion, '19.27');
    assert.equal(session.info?.manufactureDate, '2025-03-15');

    await waitFor(() => snapshots.length >= 2);
    const s = snapshots.at(-1);
    assert.equal(s.cells.length, 16);
    assert.ok(s.cells.every((/** @type {number} */ v) => v > 2.5 && v < 3.7));
    assert.ok(Math.abs(s.voltage - s.cells.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0)) < 0.01);
    assert.ok(s.soc >= 0 && s.soc <= 100);
    assert.equal(s.cellStats.count, 16);
    assert.ok(s.temperatures.some((/** @type {any} */ t) => t.id === 'mos'));
    assert.equal(s.switches.charge, true);
    assert.equal(s.capacityNominal, 280);
    // Throttled to about two snapshots per second.
    const t0 = snapshots.length;
    await sleep(1000);
    assert.ok(snapshots.length - t0 <= 3, `${snapshots.length - t0} snapshots in 1 s`);

    const settings = await session.loadSettings();
    assert.equal(settings.error, null);
    assert.equal(settings.values?.['cell.ovp'], 3.65);
    assert.equal(settings.values?.['switch.charge'], true);
    assert.equal(settings.values?.['jk.uart1_protocol'], 1);
    assert.equal(settings.values?.['jk.smart_sleep_voltage'], 3.5);
    assert.equal(settings.values?.['jk.wire_resistance_1'], 0);

    const results = await session.writeSettings([{ id: 'cell.ovp', value: 3.6 }]);
    assert.deepEqual(
      results.map((r) => [r.id, r.ok, r.verified]),
      [['cell.ovp', true, true]],
    );
    const sim = handle.sims.at(-1);
    assert.equal(sim.settings.cellOvp, 3.6);
    assert.equal(sim.state.droppedWrites, 0, 'writes wait for the settle time after a settings request');
    const sent = sim.received.find((/** @type {Uint8Array} */ f) => f[4] === 0x04 && f[5] === 4);
    assert.equal(hex(sent), hex(P.encodeWrite(0x04, 4, 3600)));

    const off = await session.writeSettings([{ id: 'switch.charge', value: false }], { reload: false });
    assert.equal(off[0].ok, true);
    await waitFor(() => snapshots.at(-1).switches.charge === false);
    const back = await session.writeSettings([{ id: 'switch.charge', value: true }]);
    assert.equal(back[0].verified, true);

    const refused = await session.writeSettings([{ id: 'scp.delay', value: 10 }]);
    assert.equal(refused[0].ok, false);

    await session.runAction('jk.soc_full');
    await waitFor(() => snapshots.at(-1).soc === 100);
    await session.runAction('jk.emergency_on');
    await waitFor(() => snapshots.at(-1).extra.emergency?.value > 0);
    await session.runAction('jk.emergency_off');
    await waitFor(() => snapshots.at(-1).extra.emergency === undefined);
  } finally {
    await session.disconnect();
  }
  assert.equal(session.state, 'idle');
});

test('session: JK02_24S simulator is detected from the data and written with 24S registers', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(jkDrivers), log, pollIntervalMs: 200 });
  const handle = fakeBleHandle(log, { name: 'JK-B2A24S20P', attach: (device) => createJkSimulator(device, { variant: 'JK02_24S', streamMs: 200 }) });
  await session.connect({ kind: 'ble', handle, selection: 'jk-ble' });
  try {
    assert.equal(session.variant, 'JK02_24S');
    assert.equal(session.driver?.capabilities.writeSettings, true);
    const settings = await session.loadSettings();
    assert.equal(settings.values?.['balance.start_voltage'], 3.45);
    assert.equal(settings.values?.['jk.smart_sleep_voltage'], undefined, '600 on old firmware is not shown as 0.6 V');
    assert.equal(fieldMap(settings.schema).has('jk.precharge_time'), false);
    const results = await session.writeSettings([{ id: 'balance.start_voltage', value: 3.4 }]);
    assert.equal(results[0].verified, true);
    const sim = handle.sims.at(-1);
    assert.ok(sim.received.some((/** @type {Uint8Array} */ f) => hex(f) === hex(P.encodeWrite(0x26, 4, 3400))));
    // Firmware without the request voltage reads 0: no write.
    const rcv = await session.writeSettings([{ id: 'charge.request_voltage', value: 3.5 }], { reload: false });
    assert.equal(rcv[0].ok, false);
  } finally {
    await session.disconnect();
  }
});

test('BLE driver: no writes until the variant is confirmed by data', async () => {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20 });
  await host.open();
  await device.open();
  const sim = createJkSimulator(device, { variant: 'JK02_24S', streamMs: 0 });
  const driver = jkBleDefinition.create({ link: host, log });
  try {
    const probe = await driver.probe({ timeout: 500 });
    assert.equal(probe?.variant, 'JK02_24S');
    assert.equal(probe?.confidence, 0.6);
    assert.equal(driver.capabilities.writeSettings, false);
    await assert.rejects(driver.writeSetting('cell.ovp', 3.6), /not confirmed/);
    sim.sendCellInfo();
    await waitFor(() => /** @type {any} */ (driver).variantConfirmed);
    assert.equal(driver.variant, 'JK02_24S');
    assert.equal(driver.capabilities.writeSettings, true);
  } finally {
    driver.dispose();
    sim.stop();
  }
});

test('BLE driver: a JK04 frame that fails the strict JK04 test does not confirm JK02_24S', async () => {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20 });
  await host.open();
  await device.open();
  const info = fromHex(byId('jk04-b2a16s-device-info').hex);
  const settings = fromHex(byId('jk04-b5a24s-settings').hex);
  const good = fromHex(byId('jk04-b5a24s-cell-info').hex);
  const low = Uint8Array.from(good);
  low.set(P.f32leBytes(0.3), 6 + 4 * 15); // cell 16 at 0.30 V: lead fault or deep discharge
  low[299] = sum8(low, 0, 299);
  assert.equal(P.looksLikeJk04CellInfo(low), false);
  const asm = P.createCommandAssembler({
    onFrame: (f) => {
      if (f[4] === P.CMD.DEVICE_INFO) tx(device, info);
      else if (f[4] === P.CMD.SETTINGS) {
        tx(device, settings);
        tx(device, low);
      }
    },
  });
  device.on('data', (c) => asm.push(c));
  const driver = jkBleDefinition.create({ link: host, log });
  const d = /** @type {any} */ (driver);
  try {
    const probe = await driver.probe({ timeout: 500 });
    assert.equal(probe?.confidence, 0.6, 'detection from the data must not confirm JK02_24S');
    assert.equal(driver.capabilities.writeSettings, false);
    await assert.rejects(driver.writeSetting('capacity.nominal', 280), /not confirmed/);
    d.lastCellAt = 0;
    tx(device, low); // the same frame from the stream
    await waitFor(() => d.lastCellAt > 0);
    assert.equal(d.variantConfirmed, false);
    tx(device, good);
    await waitFor(() => d.variantConfirmed);
    assert.equal(driver.variant, 'JK04');
  } finally {
    driver.dispose();
  }
});

test('BLE driver: a stream of implausible cell info stays alive but the watchdog reports no data', async () => {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20 });
  await host.open();
  await device.open();
  const info = fromHex(byId('jk02-32s-v19-device-info').hex);
  const good = Uint8Array.from(fromHex(byId('jk02-32s-v19-cell-info').hex).subarray(0, 300));
  const bad = Uint8Array.from(good);
  bad[173] = 150; // SOC 150 %
  bad[299] = sum8(bad, 0, 299);
  /** @type {Uint8Array[]} */
  const received = [];
  const asm = P.createCommandAssembler({
    onFrame: (f) => {
      received.push(f);
      if (f[4] === P.CMD.DEVICE_INFO) tx(device, info);
    },
  });
  device.on('data', (c) => asm.push(c));
  const driver = jkBleDefinition.create({ link: host, log });
  const d = /** @type {any} */ (driver);
  try {
    assert.equal((await driver.probe({ timeout: 500 }))?.variant, 'JK02_32S');
    d.streaming = true;
    d.streamSince = Date.now() - 60000; // streaming for a minute
    d.lastTriggerAt = 0;
    tx(device, bad);
    await waitFor(() => d.lastCellAt > 0);
    await assert.rejects(driver.poll(), /No data from the BMS/);
    assert.ok(!received.some((f) => f[4] === P.CMD.SETTINGS), 'frames arrive, so the stream is not requested again');
    tx(device, good);
    await waitFor(() => d.lastValidCellAt > 0);
    await driver.poll();
  } finally {
    driver.dispose();
  }
});

/**
 * Replay of captured JK04 frames: device info on 0x97, settings and cell info on 0x96, ACK for
 * writes.
 * @param {import('@ubms/transport').MemoryLink} device
 */
function jk04Device(device) {
  const info = fromHex(byId('jk04-b2a16s-device-info').hex);
  const settings = fromHex(byId('jk04-b5a24s-settings').hex);
  const cell = fromHex(byId('jk04-b5a24s-cell-info').hex);
  /** @type {Uint8Array[]} */
  const received = [];
  const asm = P.createCommandAssembler({
    onFrame: (f) => {
      received.push(f);
      if (f[4] === P.CMD.DEVICE_INFO) tx(device, info);
      else if (f[4] === P.CMD.SETTINGS) {
        tx(device, settings);
        tx(device, cell);
        setTimeout(() => tx(device, cell), 50).unref?.();
      } else tx(device, P.ackFrame());
    },
  });
  device.on('data', (c) => asm.push(c));
  return { received, stop() {} };
}

test('session: JK04 balancer recognised from its cell info frames (captured frames)', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(jkDrivers), log, pollIntervalMs: 200 });
  const handle = fakeBleHandle(log, { name: 'BMS', attach: jk04Device });
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'ble', handle, selection: 'jk' });
  try {
    assert.equal(session.variant, 'JK04');
    await waitFor(() => snapshots.length >= 1);
    assert.equal(snapshots[0].cells.length, 16);
    assert.ok(Math.abs(snapshots[0].balanceCurrent + 2.6) < 0.01);
    const settings = await session.loadSettings();
    assert.equal(settings.values?.['balance.trigger_delta'], 0.008);
    assert.equal(settings.values?.['system.cell_count'], 16);
    await session.writeSettings([{ id: 'balance.trigger_delta', value: 0.008 }], { reload: false });
    const sim = handle.sims.at(-1);
    assert.ok(sim.received.some((/** @type {Uint8Array} */ f) => hex(f) === byId('ble-cmd-jk04-balance-trigger-8mv').hex));
  } finally {
    await session.disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// Session level: JK-PB over RS485 and 4E57 over UART (captured answers)
// ---------------------------------------------------------------------------------------------

/**
 * Fake JK-PB at address 1 that answers triggers with the captured 308 byte answers, echoes every
 * request first like the CH341 adapter, and applies FC 0x10 writes to its settings frame.
 * @param {import('@ubms/transport').MemoryLink} device
 */
function pbDevice(device) {
  const answers = {
    [P.PB_TRIGGER.DEVICE_INFO]: fromHex(byId('pb-rs485-response-type3-addr1').hex),
    [P.PB_TRIGGER.SETTINGS]: fromHex(byId('pb-rs485-response-type1-addr1').hex),
    [P.PB_TRIGGER.CELL_INFO]: fromHex(byId('pb-rs485-response-type2-addr1').hex),
  };
  const settings = answers[P.PB_TRIGGER.SETTINGS];
  /** @type {Uint8Array[]} */
  const received = [];
  // Set by a test: the settings trigger is answered with Modbus exception 4.
  const state = { received, refuseSettings: false };
  const asm = P.createModbusRequestAssembler(1)({
    onFrame: (f) => {
      received.push(f);
      tx(device, f); // adapter echo
      const req = P.parseModbusRequest(f);
      if (state.refuseSettings && req.register === P.PB_TRIGGER.SETTINGS) {
        tx(device, P.modbusException(1, 0x10, 4));
        return;
      }
      const answer = /** @type {Record<number, Uint8Array>} */ (answers)[req.register];
      if (answer) {
        tx(device, answer);
        return;
      }
      if (req.register === 0x1504) {
        tx(device, P.modbusException(1, 0x10, 3));
        return;
      }
      const offset = req.register - 0x1000 + 6;
      if (req.byteCount === 4) setU32le(settings, offset, req.value);
      else setU16le(settings, offset, req.value);
      settings[299] = sum8(settings, 0, 299);
      tx(device, P.modbusWriteAck(f));
    },
  });
  device.on('data', (c) => asm.push(c));
  return state;
}

/**
 * @param {ProtocolLog} log
 * @param {(device: import('@ubms/transport').MemoryLink) => any} attach
 */
function fakePort(log, attach) {
  /** @type {any[]} */
  const devices = [];
  return {
    devices,
    async openLink() {
      const { host, device } = createLinkPair({ log, deviceChunkSize: 32 });
      await host.open();
      await device.open();
      devices.push(attach(device));
      return host;
    },
  };
}

test('session: JK-PB over RS485 with trigger requests, Modbus writes and the controls word', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(drivers), log, pollIntervalMs: 500 });
  const port = fakePort(log, pbDevice);
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'serial', handle: port, selection: 'jk-pb-rs485' });
  try {
    assert.equal(session.definition?.id, 'jk-pb-rs485');
    assert.equal(session.variant, 'JK02_32S');
    assert.equal(session.info?.model, 'JK_PB2A16S15P');
    await waitFor(() => snapshots.length >= 1);
    const s = snapshots[0];
    assert.equal(s.cells.length, 8);
    assert.equal(s.current, 17.841);
    assert.equal(s.capacityNominal, 220);
    const dev = port.devices.at(-1);
    assert.equal(hex(dev.received[0]), byId('pb-rs485-trigger-161c-addr1').hex);
    assert.ok(dev.received.some((/** @type {Uint8Array} */ f) => hex(f) === byId('pb-rs485-trigger-1620-addr1').hex));

    const settings = await session.loadSettings();
    assert.equal(settings.values?.['cell.ovp'], 3.65);
    assert.equal(settings.values?.['switch.display'], true);
    const results = await session.writeSettings([
      { id: 'cell.ovp', value: 3.6 },
      { id: 'switch.display', value: false },
    ]);
    assert.deepEqual(
      results.map((r) => [r.id, r.ok, r.verified]),
      [
        ['cell.ovp', true, true],
        ['switch.display', true, true],
      ],
    );
    assert.ok(dev.received.some((/** @type {Uint8Array} */ f) => hex(f) === hex(P.pbWriteU32(1, 0x100c, 3600))));
    // Controls word 848 (bits 4, 6, 8, 9) with bit 4 cleared.
    assert.ok(dev.received.some((/** @type {Uint8Array} */ f) => hex(f) === hex(P.pbWriteU16(1, 0x1114, 848 & ~0x10))));

    // A refused trigger reaches the settings screen as a translatable message; the detail is logged.
    dev.refuseSettings = true;
    const refused = await session.loadSettings();
    assert.equal(refused.error, 'The BMS refused the command');
  } finally {
    await session.disconnect();
  }
});

/**
 * Shared RS485 bus with packs 1 and 2 (spec 4.3). Right before every answer of pack 1, the answer
 * of pack 2 to the master passes: a frame of the same type (99 A, DIP address 2), then its FC 0x10
 * answer. `mode`: 'answer' (frame and answer of pack 1), 'answer only' (its frame is lost),
 * 'silent'. `chatter()` sends pack 2's answers without any request of the host.
 * @param {import('@ubms/transport').MemoryLink} device
 */
function sharedPbBus(device) {
  /** @type {Record<number, Uint8Array>} */
  const own = {
    [P.PB_TRIGGER.DEVICE_INFO]: fromHex(byId('pb-rs485-response-type3-addr1').hex).subarray(0, 300),
    [P.PB_TRIGGER.SETTINGS]: fromHex(byId('pb-rs485-response-type1-addr1').hex).subarray(0, 300),
    [P.PB_TRIGGER.CELL_INFO]: fromHex(byId('pb-rs485-response-type2-addr1').hex).subarray(0, 300),
  };
  /** @type {Record<number, Uint8Array>} */
  const other = {};
  for (const [reg, f] of Object.entries(own)) {
    const g = Uint8Array.from(f);
    if (g[4] === P.FRAME_TYPE.CELL_INFO) setU32le(g, 158, 99000);
    if (g[4] === P.FRAME_TYPE.SETTINGS) g[270] = 2;
    g[299] = sum8(g, 0, 299);
    other[Number(reg)] = g;
  }
  const bus = { mode: 'answer' };
  /** @param {number} reg */
  const pack2 = (reg) => {
    tx(device, other[reg]);
    tx(device, P.modbusWriteAck(P.pbTriggerRequest(2, reg)));
  };
  const asm = P.createModbusRequestAssembler(1)({
    onFrame: (f) => {
      const reg = P.parseModbusRequest(f).register;
      if (!own[reg]) return;
      pack2(reg);
      if (bus.mode === 'answer') tx(device, own[reg]);
      if (bus.mode !== 'silent') tx(device, P.modbusWriteAck(f));
    },
  });
  device.on('data', (c) => asm.push(c));
  return { bus, chatter: () => Object.values(P.PB_TRIGGER).forEach(pack2) };
}

test('JK-PB on a shared bus: frames of other packs are never taken for this address', async () => {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, deviceChunkSize: 32 });
  await host.open();
  await device.open();
  const { bus, chatter } = sharedPbBus(device);
  const driver = jkPbDefinition.create({ link: host, log });
  /** @type {any[]} */
  const snapshots = [];
  driver.on('snapshot', (s) => snapshots.push(s));
  try {
    assert.equal((await driver.probe({ timeout: 1000 }))?.info?.model, 'JK_PB2A16S15P');
    await driver.start();
    assert.equal(/** @type {any} */ (driver).settingsFrame?.[270], 1, 'settings frame of DIP address 1');
    await driver.poll();
    assert.equal(snapshots.at(-1)?.current, 17.841, 'pack 1, not pack 2 (99 A)');
    bus.mode = 'answer only';
    await assert.rejects(driver.poll(), /Incomplete response/);
    await assert.rejects(driver.readSettings(), /Incomplete response/);
    bus.mode = 'silent';
    await assert.rejects(driver.poll(), /No response/);
    assert.equal(snapshots.length, 1);
  } finally {
    driver.dispose();
  }

  // Address 3 is not on the bus, only pack 2 talks: nothing is detected.
  const pair = createLinkPair({ log, deviceChunkSize: 32 });
  await pair.host.open();
  await pair.device.open();
  const other = sharedPbBus(pair.device);
  const timer = setInterval(other.chatter, 100);
  const absent = jkPbDefinition.create({ link: pair.host, log, options: { address: 3 } });
  try {
    assert.equal(await absent.probe({ timeout: 1000 }), null);
  } finally {
    clearInterval(timer);
    absent.dispose();
  }
});

/**
 * Offset of a data id value in a 4E57 reply (walks the id list like the parser).
 * @param {Uint8Array} frame
 * @param {number} id
 */
function uartValueOffset(frame, id) {
  const L = u16be(frame, 2);
  for (let o = 11; o < L - 7; ) {
    const d = frame[o];
    if (d === id) return o + 1;
    if (d === P.UART_ID.CELLS) o += 2 + frame[o + 1];
    else o += 1 + P.UART_ID_WIDTH[d];
  }
  return -1;
}

/**
 * Fake JK-B on the 4E57 port answering "read all" with a captured reply and applying the switch
 * writes to it.
 * @param {import('@ubms/transport').MemoryLink} device
 */
function uartDevice(device) {
  const reply = fromHex(byId('uart-rx-bd6a17s6p-16s-lfp').hex);
  /** @type {Uint8Array[]} */
  const received = [];
  const asm = P.createUartAssembler({
    onFrame: (f) => {
      received.push(f);
      const req = P.parseUartRequest(f);
      if (req.command === P.UART_CMD.READ_ALL) {
        tx(device, reply);
        return;
      }
      if (req.command === P.UART_CMD.WRITE) {
        const o = uartValueOffset(reply, req.dataId);
        reply[o] = /** @type {number} */ (req.value);
        const status = uartValueOffset(reply, 0x8c);
        // Bits 0 and 1 follow the MOSFET switches; bit 2 is balancing activity, not 0x9D (spec 9.3).
        const bit = { [P.UART_ID.CHARGE_SWITCH]: 1, [P.UART_ID.DISCHARGE_SWITCH]: 2 }[req.dataId] ?? 0;
        reply[status + 1] = req.value ? reply[status + 1] | bit : reply[status + 1] & ~bit;
        const L = u16be(reply, 2);
        setU32be(reply, L - 2, sum16(reply, 0, L - 2));
        tx(device, P.encodeUartFrame({ command: P.UART_CMD.WRITE, source: P.UART_SOURCE.BMS, transportType: 1, info: [req.dataId] }));
      }
    },
  });
  device.on('data', (c) => asm.push(c));
  return { received };
}

test('session: JK-B 4E57 over UART, read all and switch writes', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(drivers), log, pollIntervalMs: 1000 });
  const port = fakePort(log, uartDevice);
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'serial', handle: port, selection: 'jk-uart' });
  try {
    assert.equal(session.variant, 'JK_UART_4E57');
    assert.equal(session.info?.softwareVersion, '7.1.0H');
    await waitFor(() => snapshots.length >= 1);
    assert.equal(snapshots[0].cells.length, 16);
    assert.equal(snapshots[0].current, -0.69);
    assert.equal(snapshots[0].switches.charge, true);
    // Balancer enabled (0x9D = 1) but idle (status bit 2 clear): the switch shows on.
    assert.equal(snapshots[0].switches.balance, true);
    assert.equal(snapshots[0].balancingActive, false);
    const settings = await session.loadSettings();
    assert.equal(settings.values?.['cell.ovp'], 3.65);
    assert.equal(settings.values?.['switch.charge'], true);
    const results = await session.writeSettings([{ id: 'switch.charge', value: false }]);
    assert.deepEqual(
      results.map((r) => [r.ok, r.verified]),
      [[true, true]],
    );
    const dev = port.devices.at(-1);
    assert.ok(dev.received.some((/** @type {Uint8Array} */ f) => hex(f) === byId('uart-cmd-write-charge-mos-off').hex));
    const balanceOff = await session.writeSettings([{ id: 'switch.balance', value: false }], { reload: false });
    assert.equal(balanceOff[0].ok, true);
    const count = snapshots.length;
    await waitFor(() => snapshots.length > count && snapshots.at(-1).switches.balance === false);
    const refused = await session.writeSettings([{ id: 'cell.ovp', value: 3.6 }]);
    assert.equal(refused[0].ok, false);
  } finally {
    await session.disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// Definitions and registry
// ---------------------------------------------------------------------------------------------

test('definitions: order, links, demo and detection ranking', () => {
  // The JK balancer drivers are registered here too (order checked in jk-balancer.test.js).
  assert.deepEqual(
    jkDrivers.map((d) => d.id),
    ['jk-balancer-ble', 'jk-ble', 'jk-pb-rs485', 'jk-uart', 'jk-balancer-rs485'],
  );
  assert.equal(drivers[0].id, 'jk-balancer-ble');
  assert.equal(jkBleDefinition.demo?.chunkSize, 20);
  assert.match(jkBleDefinition.demo?.name ?? '', /\(demo\)$/);
  const profile = jkBleDefinition.links.ble?.profiles[0];
  assert.equal(profile?.service, 0xffe0);
  assert.equal(profile?.chunkSize, 20);
  assert.equal(jkPbDefinition.links.serial?.profiles[0].baudRate, 115200);
  assert.equal(jkUartDefinition.links.serial?.profiles[0].baudRate, 115200);
  for (const d of jkDrivers) assert.equal(d.family, 'jk');

  const registry = new DriverRegistry(drivers);
  const req = registry.bleRequest({ selection: 'jk' });
  assert.equal(req.filterable, true);
  assert.ok(req.request.filters?.some((f) => f.namePrefix === 'JK-'));
  assert.ok(req.request.filters?.some((f) => f.manufacturerData?.[0].companyIdentifier === 0x0b65));
  // JK names rank the balancer driver equally; its probe runs first and leaves JK BMSes to jk-ble.
  assert.deepEqual(
    registry
      .bleCandidates({ name: 'JK_B2A8S20P' })
      .slice(0, 2)
      .map((c) => c.definition.id),
    ['jk-balancer-ble', 'jk-ble'],
  );
  assert.equal(registry.bleCandidates({ name: '506036N46002293-00' })[0].definition.id, 'jk-ble');
  assert.equal(registry.bleCandidates({ name: 'ANT-BLE16ZMUB' })[0].definition.family, 'ant');
});
