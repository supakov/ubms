import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolLog, canonicalUuid, createLinkPair, fromHex, hex, sleep } from '@ubms/transport';
import { BmsSession, DriverRegistry, validateAll } from '@ubms/bms-core';
import {
  KS_VENDOR,
  KsDriver,
  VARIANT,
  buildKsSchema,
  createKsSimulator,
  decodeKsSettings,
  ksDefinition,
  ksDrivers,
  ksInfo,
  ksProtocol as P,
  ksSnapshot,
  statusProblem,
  valueToRaw,
} from '../src/ks/index.js';
import { createJbdSimulator, jbdDefinition } from '../src/jbd/index.js';
import { drivers } from '../src/index.js';

/**
 * Captured frames from [SY] (github.com/syssi/esphome-ks-bms, docs/pdus and README): a KS48100 in
 * a 16S 300 Ah pack (CER2410-018-030-023), a KS-48200 (BL-250-100-100) and a KS48300-Ho23.
 */
const CAP = {
  status: '7B01200045148D00DC00B400B40000520575307530000000010000000000 0C00000064 7D',
  status48300: '7B0120005C14BF00D200BE00BEF83A1CE61F4724CC0000000300000000000E000000647D',
  cells: '7B0221100CD80CDA0CD90CD80CD80CD80CD90CD80CD80CD90CD90CD80CD90CD90CD80CD67D',
  temps: '7B0309040B5F0B5F0B5F0B5F7D',
  temps48200: '7B0309040B730B730B690B697D',
  history: '7B081600000001000100690001000000010000000000000000007D',
  date: '7B0903FFFFFF7D',
  modelEmpty: '7B0A007D',
  modelName: '7B0A0F4B424D3230323531323131303037337D',
  serial: '7B0B1343455232343130 2D3031382D3033302D3032337D',
  modelType: '7B0C14FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7D',
  module: '7B74184B535F424C455F566572312E302E305F32303234303731367D',
  program: '7B F4 03 02 02 01 7D',
  boot: '7BF50202397D',
  voltage: '7B05180E420D3407D009C40BB80BB816D015400BB80FA012C00BB87D',
  temperature: '7B06180CD10C9F0BB80AA10ADD0BB80D030CD10BB809E30A150BB87D',
  current: '7B070C53FC0BB8000053FC0BB800007D',
};
/** @param {keyof typeof CAP} k */
const cap = (k) => fromHex(CAP[k].replace(/\s+/g, ''));

/** @param {() => any} cond @param {number} [timeout] */
async function waitFor(cond, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(20);
  }
  assert.fail('condition not met in time');
}

/**
 * Fake Bluetooth device: every opened profile gets a fresh link pair with a device attached.
 * @param {ProtocolLog} log
 * @param {{ name?: string, services?: number[], attach: (device: any) => any }} o
 */
function fakeBleHandle(log, { name = 'BL-250-100-100', services = [0xff00, 0x1800], attach }) {
  /** @type {any[]} */
  const sims = [];
  /** @type {string[]} */
  const profiles = [];
  return {
    name,
    connected: false,
    sims,
    profiles,
    async connect() {
      this.connected = true;
    },
    async disconnect() {
      this.connected = false;
    },
    async discover() {
      return services.map((s) => ({ uuid: canonicalUuid(s), characteristics: [] }));
    },
    /** @param {{ id: string, chunkSize?: number }} profile */
    async openChannel(profile) {
      profiles.push(profile.id);
      const { host, device } = createLinkPair({ log, deviceChunkSize: profile.chunkSize ?? 20 });
      await host.open();
      await device.open();
      sims.push(attach(device));
      return host;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

test('protocol: requests and register writes have the 7B ... 7D layout of [SY]', () => {
  assert.equal(hex(P.encodeRead(P.FN.STATUS)).toUpperCase(), '7B01007D');
  assert.equal(hex(P.encodeRead(P.FN.STATUS_2)).toUpperCase(), '7B61007D');
  assert.equal(hex(P.encodeWrite(0x1d, 0)).toUpperCase(), '7B1D0200007D');
  assert.equal(hex(P.encodeWrite(0x30, 3281)).toUpperCase(), '7B30020CD17D');
  assert.throws(() => P.encodeWrite(0x20, 70000));
  assert.throws(() => P.encodeWrite(0x20, 1.5));
});

test('protocol: status of the KS48100 capture', () => {
  const st = P.parseStatus(cap('status'));
  assert.deepEqual(
    { ...st },
    {
      soc: 69,
      voltage: 52.61,
      averageTemp: 22,
      ambientTemp: 18,
      mosTemp: 18,
      current: 0,
      remainingAh: 209.97,
      fullAh: 300,
      nominalAh: 300,
      cycleAh: 0,
      cycles: 1,
      balanceMask: 0,
      fet: 0x0c,
      protection: 0,
      soh: 100,
    },
  );
  assert.equal(statusProblem(st), null);
  const s48300 = P.parseStatus(cap('status48300'));
  assert.equal(s48300.current, -19.9, 'signed current 0xF83A, discharging');
  assert.equal(s48300.fet, 0x0e, 'discharging state bit with both MOSFETs on');
  assert.equal(statusProblem({ ...st, voltage: 0 }), 'pack voltage 0 V');
  assert.equal(statusProblem({ ...st, soc: 250 }), 'SOC 250 %');
});

test('protocol: cells, temperatures, texts, versions and counters', () => {
  const cells = P.parseCells(cap('cells'));
  assert.equal(cells.length, 16);
  assert.equal(cells[0], 3.288);
  assert.equal(cells[1], 3.29);
  assert.equal(cells[15], 3.286);
  assert.deepEqual(P.parseTemps(cap('temps')), [18, 18, 18, 18]);
  assert.deepEqual(P.parseTemps(cap('temps48200')), [20, 20, 19, 19]);
  assert.equal(P.parseText(cap('serial')), 'CER2410-018-030-023');
  assert.equal(P.parseText(cap('modelName')), 'KBM20251211007' + '3');
  assert.equal(P.parseText(cap('modelEmpty')), '');
  assert.equal(P.parseText(cap('modelType')), '', '0xFF filled means unset');
  assert.equal(P.parseText(cap('module')), 'KS_BLE_Ver1.0.0_20240716');
  assert.equal(P.parseDate(cap('date')), '');
  assert.equal(P.parseDate(fromHex('7B0903180109' + '7D')), '2024-01-09');
  assert.equal(P.parseVersion(cap('program')), '2.2.1');
  assert.equal(P.parseVersion(cap('boot')), '2.57');
  const h = P.parseHistory(cap('history'));
  assert.equal(h.shortCircuit, 0);
  assert.equal(h.chargeOvercurrent, 1);
  assert.equal(h.dischargeOvercurrent, 1);
  assert.equal(h.cellOvervoltage, 105);
  assert.equal(h.counter5, 1);
  assert.equal(h.packUndervoltage, 1);
  assert.equal(h.dischargeUndertemperature, 0);
  assert.equal(Object.keys(h).length, 11);
});

test('protocol: the assembler joins 20 byte notifications and resynchronises after garbage', () => {
  /** @type {Uint8Array[]} */
  const frames = [];
  /** @type {string[]} */
  const discarded = [];
  const a = P.createAssembler({ onFrame: (f) => frames.push(f), onDiscard: (_b, reason) => discarded.push(reason) });
  const status = cap('status');
  a.push(status.subarray(0, 20));
  assert.equal(frames.length, 0);
  a.push(status.subarray(20));
  assert.equal(frames.length, 1);
  assert.equal(hex(frames[0]), hex(status));
  // A lost first notification: the tail of a cell frame, then a complete temperature frame.
  const cells = cap('cells');
  a.push(Uint8Array.from([...cells.subarray(20), ...cap('temps')]));
  assert.equal(frames.length, 2);
  assert.equal(frames[1][1], P.FN.TEMPS);
  assert.ok(discarded.length > 0);
});

test('protocol: the log names reads, writes and answers', () => {
  assert.equal(P.describe(P.encodeRead(P.FN.CELLS), 'tx')?.name, 'Read cell voltages');
  assert.deepEqual(P.describe(P.encodeWrite(0x20, 3650), 'tx'), { name: 'Write register 0x20', decode: 'value 3650' });
  assert.match(P.describe(cap('status'), 'rx')?.decode ?? '', /52\.61 V, 0\.00 A, SOC 69 %/);
  assert.equal(P.describe(cap('serial'), 'rx')?.decode, 'CER2410-018-030-023');
});

// ---------------------------------------------------------------------------------------------
// Snapshot, info, settings
// ---------------------------------------------------------------------------------------------

test('snapshot: values, switches, temperatures and protection bits', () => {
  const st = P.parseStatus(cap('status'));
  const snap = ksSnapshot(st, { cells: P.parseCells(cap('cells')), temps: P.parseTemps(cap('temps')) });
  assert.equal(snap.voltage, 52.61);
  assert.equal(snap.soc, 69);
  assert.equal(snap.soh, 100);
  assert.equal(snap.capacityRemaining, 209.97);
  assert.equal(snap.capacityFull, 300);
  assert.equal(snap.cycles, 1);
  assert.deepEqual(snap.switches, { charge: true, discharge: true });
  assert.equal(snap.cells?.length, 16);
  assert.equal(snap.balancing?.every((b) => b === false), true);
  assert.equal(snap.balancingActive, false);
  assert.deepEqual(
    snap.temperatures?.map((t) => [t.id, t.value, t.kind]),
    [
      ['t1', 18, 'cell'],
      ['t2', 18, 'cell'],
      ['t3', 18, 'cell'],
      ['t4', 18, 'cell'],
      ['mos', 18, 'mos'],
      ['ambient', 18, 'ambient'],
    ],
  );
  assert.deepEqual(snap.alarms, []);
  assert.equal(snap.extra?.limiting.value, false);
  const bad = ksSnapshot({ ...st, protection: (1 << 5) | (1 << 10) | (1 << 12), balanceMask: 0b101, fet: 0x14 }, { cells: [3.3, 3.3, 3.3] });
  assert.deepEqual(
    bad.alarms?.map((a) => [a.id, a.severity]),
    [
      ['charge_undertemperature', 'protection'],
      ['short_circuit', 'protection'],
      ['ks.mos_software_lock', 'info'],
    ],
  );
  assert.deepEqual(bad.balancing, [true, false, true]);
  assert.deepEqual(bad.switches, { charge: true, discharge: false });
  assert.equal(bad.extra?.limiting.value, true);
});

test('snapshot: charging with a cell probe below 0 °C raises the cold charge warning', () => {
  const st = { ...P.parseStatus(cap('status')), current: 10.8 };
  const cold = ksSnapshot(st, { temps: [10, -3, 10, -7] });
  assert.deepEqual(
    cold.alarms?.map((a) => [a.id, a.severity]),
    [['ks.cold_charge', 'warning']],
  );
  assert.deepEqual(ksSnapshot({ ...st, current: -10.8 }, { temps: [10, -3, 10, -7] }).alarms, [], 'discharging in the cold is allowed');
  assert.deepEqual(ksSnapshot(st, { temps: [10, 3, 10, 7] }).alarms, []);
});

test('info: texts, versions and counters', () => {
  const info = ksInfo({
    variant: VARIANT.STATUS_01,
    serial: 'CER2410-018-030-023',
    modelName: '',
    modelType: '',
    date: '',
    module: 'KS_BLE_WIFI_Ver1.0.0_20240313',
    program: '2.1.1',
    boot: '255.255',
    history: P.parseHistory(cap('history')),
  });
  assert.equal(info.vendor, KS_VENDOR);
  assert.equal(info.model, 'KS BMS');
  assert.equal(info.serialNumber, 'CER2410-018-030-023');
  assert.equal(info.softwareVersion, '2.1.1');
  assert.equal(info.manufactureDate, undefined);
  assert.equal(info.extra?.module.value, 'KS_BLE_WIFI_Ver1.0.0_20240313');
  assert.equal(info.extra?.bootVersion.value, '255.255');
  assert.equal(info.extra?.['count.cellOvervoltage'].value, 105);
  assert.equal(info.extra?.softwareF3, undefined);
});

test('settings: the KS48200 capture decodes to the KS specification values', () => {
  const schema = buildKsSchema();
  const values = decodeKsSettings(schema, {
    blocks: { [P.FN.VOLTAGE]: P.parseWords(cap('voltage')), [P.FN.TEMPERATURE]: P.parseWords(cap('temperature')), [P.FN.CURRENT]: P.parseWords(cap('current')) },
    status: P.parseStatus(cap('status')),
  });
  assert.deepEqual(values, {
    'switch.charge': true,
    'switch.discharge': true,
    'cell.ovp': 3.65,
    'cell.ovpr': 3.38,
    'cell.ovp_delay': 2,
    'cell.uvp': 2.5,
    'cell.uvpr': 3,
    'cell.uvp_delay': 3,
    'pack.ovp': 58.4,
    'pack.ovpr': 54.4,
    'ks.pack_ovp_delay': 3,
    'pack.uvp': 40,
    'pack.uvpr': 48,
    'ks.pack_uvp_delay': 3,
    'charge.ocp': 215,
    'charge.ocp_delay': 3,
    'charge.ocp_recovery': 0,
    'discharge.ocp': 215,
    'discharge.ocp_delay': 3,
    'discharge.ocp_recovery': 0,
    'charge.otp': 55,
    'charge.otpr': 50,
    'ks.charge_otp_delay': 3,
    'charge.utp': -1,
    'charge.utpr': 5,
    'ks.charge_utp_delay': 3,
    'discharge.otp': 60,
    'discharge.otpr': 55,
    'ks.discharge_otp_delay': 3,
    'discharge.utp': -20,
    'discharge.utpr': -15,
    'ks.discharge_utp_delay': 3,
    'capacity.nominal': 300,
    'ks.full_capacity': 300,
    'capacity.cycle': 0,
  });
  assert.equal(Object.keys(validateAll(schema, { ...values, 'cell.ovpr': 3.7 })).length > 0, true, 'recovery above protection is refused');
  const fields = new Map(buildKsSchema({ writable: true }).groups.flatMap((g) => g.fields).map((f) => [f.id, f]));
  const otp = /** @type {any} */ (fields.get('charge.otp'));
  assert.equal(valueToRaw(otp, 55), 3281);
  assert.equal(valueToRaw(otp, -1), 2721);
  assert.equal(valueToRaw(otp, 150), undefined, 'outside the schema range');
  assert.equal(valueToRaw(/** @type {any} */ (fields.get('cell.ovp_delay')), 2), 2000);
  assert.equal(valueToRaw(/** @type {any} */ (fields.get('pack.ovp')), 58.4), 5840);
  const all = schema.groups.flatMap((g) => g.fields);
  assert.equal(all.length, 43);
  for (const f of all) assert.equal(f.readOnly, true, `${f.id} is read only by default (unconfirmed encoding)`);
  for (const f of buildKsSchema({ writable: true }).groups.flatMap((g) => g.fields)) {
    assert.equal(f.readOnly, undefined, f.id);
    assert.equal(f.danger, true, `${f.id} asks before writing`);
  }
});

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

test('session: the default driver reads the settings and writes nothing', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(ksDrivers), log, pollIntervalMs: 200 });
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20 });
  await device.open();
  const sim = createKsSimulator(device, { stepMs: 0, answerDelayMs: 5 });
  await session.connect({ kind: 'link', link: host, selection: 'ks-ble' });
  try {
    assert.deepEqual(session.driver?.capabilities, { settings: true, writeSettings: false, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 });
    const settings = await session.loadSettings();
    assert.equal(settings.values['cell.ovp'], 3.65);
    assert.equal(settings.values['ks.cell_full_voltage'], 3.55);
    await assert.rejects(() => /** @type {any} */ (session.driver).writeSetting('cell.ovp', 3.6), /read only/);
    assert.equal(sim.received.some((f) => f[2] === 2), false, 'no write reached the device');
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

/** The definition with the register writes switched on (spec 4), as after a confirmation on hardware. */
const writableKs = { ...ksDefinition, create: (/** @type {any} */ ctx) => new KsDriver(writableKs, ctx, { writable: true }) };

test('session: with writes switched on (connect, poll, info, settings, verified writes, switches)', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([writableKs]), log, pollIntervalMs: 200 });
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20 });
  await device.open();
  const sim = createKsSimulator(device, { stepMs: 0, answerDelayMs: 5, ignoreWrites: [0x45] });
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'link', link: host, selection: 'ks-ble' });
  try {
    assert.equal(session.definition?.id, 'ks-ble');
    assert.equal(session.variant, VARIANT.STATUS_01);
    await waitFor(() => snapshots.length >= 1 && session.info?.serialNumber);
    const s = snapshots.at(-1);
    assert.equal(s.cells.length, 16);
    assert.ok(s.voltage > 50 && s.voltage < 56);
    assert.equal(s.temperatures.filter((/** @type {any} */ t) => t.kind === 'cell').length, 4);
    assert.deepEqual(s.switches, { charge: true, discharge: true });
    assert.equal(session.info?.serialNumber, 'KS48100-DEMO-0001');
    assert.equal(session.info?.softwareVersion, '2.1.1');
    assert.equal(session.info?.extra?.module.value, 'KS_BLE_WIFI_Ver1.0.0_20240313');

    const settings = await session.loadSettings();
    assert.equal(settings.values['cell.ovp'], 3.65);
    assert.equal(settings.values['charge.utp'], -1);
    assert.equal(settings.values['balance.start_voltage'], 3.4);
    assert.equal(settings.values['capacity.nominal'], 100);

    const results = await session.writeSettings([
      { id: 'cell.ovp', value: 3.6 },
      { id: 'charge.utp', value: 2 },
      { id: 'capacity.nominal', value: 105 },
      { id: 'discharge.ocp_recovery', value: 5 },
    ]);
    assert.deepEqual(
      results.map((r) => [r.id, r.ok]),
      [
        ['cell.ovp', true],
        ['charge.utp', true],
        ['capacity.nominal', true],
        ['discharge.ocp_recovery', false],
      ],
    );
    assert.equal(sim.registers[0x20], 3600);
    assert.equal(sim.registers[0x33], 2751);
    assert.equal(sim.registers[0x1a], 10500);
    const writes = sim.received.filter((f) => f[2] === 2).map((f) => hex(f).toUpperCase());
    assert.deepEqual(writes.slice(0, 3), ['7B20020E107D', '7B33020ABF7D', '7B1A0229047D']);

    const sw = await session.writeSettings([{ id: 'switch.charge', value: false }]);
    assert.deepEqual(
      sw.map((r) => r.ok),
      [true],
    );
    assert.equal(sim.battery.switches.charge, false);
    const n = snapshots.length;
    await waitFor(() => snapshots.length > n + 1);
    assert.equal(snapshots.at(-1).switches.charge, false);
    // Only reads and the requested register writes reached the device.
    assert.ok(sim.received.every((f) => f[0] === 0x7b && (f[2] === 0 || f[2] === 2)));
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('session: a "type 2" board answers the status at 0x61', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(ksDrivers), log, pollIntervalMs: 200 });
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20 });
  await device.open();
  const sim = createKsSimulator(device, { stepMs: 0, answerDelayMs: 5, type2: true });
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'link', link: host, selection: 'ks-ble' });
  try {
    assert.equal(session.variant, VARIANT.STATUS_61);
    await waitFor(() => snapshots.length >= 2);
    assert.ok(snapshots.at(-1).voltage > 50);
    assert.ok(sim.received.filter((f) => f[1] === P.FN.STATUS_2).length >= 2);
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('detection: the full registry finds a KS module on FF00 and still gives a JBD to the JBD driver', async () => {
  const jbdIndex = drivers.indexOf(jbdDefinition);
  assert.equal(drivers[jbdIndex + 1], ksDefinition, 'ks-ble right after jbd');
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry: new DriverRegistry(drivers), log, pollIntervalMs: 500 });
    const handle = fakeBleHandle(log, { attach: (device) => createKsSimulator(device, { stepMs: 0, answerDelayMs: 5 }) });
    await session.connect({ kind: 'ble', handle, selection: 'auto' });
    try {
      assert.equal(session.definition?.id, 'ks-ble');
    } finally {
      await session.disconnect();
      handle.sims.forEach((s) => s.stop());
    }
  }
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry: new DriverRegistry(drivers), log, pollIntervalMs: 500 });
    const handle = fakeBleHandle(log, { name: 'JBD-SP04S034', attach: (device) => createJbdSimulator(device) });
    await session.connect({ kind: 'ble', handle, selection: 'auto' });
    try {
      assert.equal(session.definition?.id, 'jbd');
    } finally {
      await session.disconnect();
      handle.sims.forEach((s) => s.stop?.());
    }
  }
});

test('demo: the simulator connects like the app demo', async () => {
  const demo = ksDefinition.demo;
  assert.ok(demo);
  assert.match(demo.name, /\(demo\)$/);
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, deviceChunkSize: demo.chunkSize ?? 0 });
  await device.open();
  const sim = demo.create(device);
  const session = new BmsSession({ registry: new DriverRegistry(drivers), log, pollIntervalMs: 1000 });
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'link', link: host, selection: 'ks-ble' });
  try {
    await waitFor(() => snapshots.length >= 1);
    assert.equal(snapshots[0].cells.length, 16);
  } finally {
    await session.disconnect();
    sim.stop?.();
  }
});

test('definition: KS family, one FF00 profile, no names, experimental', () => {
  const d = ksDefinition;
  assert.deepEqual(ksDrivers, [d]);
  assert.equal(d.id, 'ks-ble');
  assert.equal(d.family, 'ks');
  assert.equal(d.deviceType, 'bms');
  assert.equal(d.experimental, true);
  assert.deepEqual(
    d.links.ble?.profiles.map((p) => [p.service, p.notify, p.write]),
    [[0xff00, 0xff01, 0xff02]],
  );
  assert.equal(d.links.serial, undefined, 'only the Bluetooth path is documented');
  assert.equal(d.links.ble?.namePrefixes, undefined);
});
