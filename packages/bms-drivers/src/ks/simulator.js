import { SimBattery } from '../common/sim-battery.js';
import { every } from '../common/util.js';
import { END, FET, FN, START, cToKelvin, createAssembler } from './protocol.js';

/**
 * Device side of a KS BMS board (docs/protocols/ks.md) for the demo mode and tests, on top of the
 * protocol independent SimBattery.
 *
 * Settings values: the voltage, temperature and current blocks of the KS48200 capture in [SY]
 * (docs/pdus/BL-250-100-100.txt) with the current limits scaled to 100 Ah; the basic block and the
 * capacities are simulator choices. Texts and versions: unset model texts (0xFF) as in every
 * capture, a demo serial number, and no answer to 0xF3, as in the KS48100 capture.
 *
 * Writes `7B <register> 02 <hi> <lo> 7D` are applied without an answer (spec 4) when the register
 * is in the map and the value is plausible (simulator choice); others are ignored, so only the
 * read-back shows them.
 */

/** @typedef {import('@ubms/transport').Link} Link */

/** @param {number} v */
const word = (v) => [(v >> 8) & 0xff, v & 0xff];
/** @param {number} fn @param {number[]} data */
const frame = (fn, data) => Uint8Array.from([START, fn, data.length, ...data, END]);
/** @param {string} text @param {number} size */
const ascii = (text, size) => Array.from({ length: size }, (_, i) => (i < text.length ? text.charCodeAt(i) & 0x7f : 0xff));

/**
 * @param {Link} link device side of a link
 * @param {Object} [opts]
 * @param {SimBattery} [opts.battery]
 * @param {number} [opts.stepMs] simulation step (0: no timer, call `step()`)
 * @param {number} [opts.answerDelayMs]
 * @param {boolean} [opts.type2] answer the status at 0x61 instead of 0x01 (spec 3.1)
 * @param {number[]} [opts.silent] read functions that get no answer
 * @param {number[]} [opts.ignoreWrites] registers whose writes are dropped (tests)
 */
export function createKsSimulator(link, opts = {}) {
  const sim = opts.battery ?? new SimBattery({ cells: 16, capacityAh: 100, chemistry: 'lfp', soc: 64, tempSensors: 4, seed: 41, maxCurrent: 20 });
  const stepMs = opts.stepMs ?? 1000;
  const answerDelayMs = opts.answerDelayMs ?? 40;
  const silent = new Set(opts.silent ?? [FN.SOFTWARE_VERSION]);
  /** Register image 0x10..0x45. */
  const regs = new Uint16Array(0x46);
  // Basic block 0x10..0x19 (simulator choice).
  regs.set([3550, 2800, 3400, 30, 0, 0, 3330, 3300, 3270, 3230], 0x10);
  // Capacities 0x1A nominal, 0x1B cycle, 0x1C full (0.01 Ah).
  regs.set([Math.round(sim.capacityAh * 100), Math.round(sim.capacityAh * 80), Math.round(sim.capacityAh * 100)], 0x1a);
  // Voltage block 0x20..0x2B, temperature block 0x30..0x3B: KS48200 capture.
  regs.set([3650, 3380, 2000, 2500, 3000, 3000, 5840, 5440, 3000, 4000, 4800, 3000], 0x20);
  regs.set([3281, 3231, 3000, 2721, 2781, 3000, 3331, 3281, 3000, 2531, 2581, 3000], 0x30);
  // Current block 0x40..0x45: 105 A, 3 s, no recovery delay (scaled from the capture).
  regs.set([10500, 3000, 0, 10500, 3000, 0], 0x40);
  const state = { reads: 0, writes: 0, protection: 0 };
  /** @type {Uint8Array[]} */
  const received = [];

  /** @param {number} dt seconds */
  const step = (dt) => sim.step(dt);

  const status = () => {
    const temps = sim.temps;
    const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
    const balanceMask = sim.balancing.reduce((m, on, i) => (on ? m | (1 << i) : m), 0) >>> 0;
    let fet = 0;
    if (sim.switches.charge) fet |= FET.CHARGE_MOS;
    if (sim.switches.discharge) fet |= FET.DISCHARGE_MOS;
    if (sim.current > 0.15) fet |= FET.STATE_CHARGING;
    if (sim.current < -0.15) fet |= FET.STATE_DISCHARGING;
    const full = regs[0x1c] / 100;
    return [
      ...word(Math.round(sim.soc)),
      ...word(Math.round(sim.voltage * 100)),
      ...word(Math.round(avg * 10) & 0xffff),
      ...word(Math.round(sim.ambient * 10) & 0xffff),
      ...word(Math.round(sim.mosTemp * 10) & 0xffff),
      ...word(Math.round(sim.current * 100) & 0xffff),
      ...word(Math.round((full * sim.soc) / 100 * 100)),
      ...word(regs[0x1c]),
      ...word(regs[0x1a]),
      ...word(regs[0x1b]),
      ...word(sim.cycles),
      (balanceMask >>> 24) & 0xff,
      (balanceMask >>> 16) & 0xff,
      (balanceMask >>> 8) & 0xff,
      balanceMask & 0xff,
      ...word(fet),
      ...word(state.protection),
      ...word(100),
    ];
  };

  /** @param {number} fn */
  const answer = (fn) => {
    switch (fn) {
      case FN.STATUS:
      case FN.STATUS_2:
        return (fn === FN.STATUS_2) === !!opts.type2 ? frame(fn, status()) : null;
      case FN.CELLS:
        return frame(fn, [sim.cellCount, ...sim.cellVoltages().flatMap((v) => word(Math.round(v * 1000)))]);
      case FN.TEMPS:
        return frame(fn, [sim.temps.length, ...sim.temps.flatMap((t) => word(cToKelvin(t)))]);
      case FN.BASIC:
        return frame(fn, Array.from(regs.subarray(0x10, 0x1a)).flatMap(word));
      case FN.VOLTAGE:
        return frame(fn, Array.from(regs.subarray(0x20, 0x2c)).flatMap(word));
      case FN.TEMPERATURE:
        return frame(fn, Array.from(regs.subarray(0x30, 0x3c)).flatMap(word));
      case FN.CURRENT:
        return frame(fn, Array.from(regs.subarray(0x40, 0x46)).flatMap(word));
      case FN.HISTORY:
        return frame(fn, [0, 1, 0, 0, 0, 2, 0, 3, 0, 0, 0, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 0]);
      case FN.DATE:
        return frame(fn, [0xff, 0xff, 0xff]);
      case FN.MODEL_NAME:
        return frame(fn, ascii('', 30));
      case FN.SERIAL:
        return frame(fn, ascii('KS48100-DEMO-0001', 17));
      case FN.MODEL_TYPE:
        return frame(fn, ascii('', 20));
      case FN.MODULE_VERSION:
        return frame(fn, ascii('KS_BLE_WIFI_Ver1.0.0_20240313', 29));
      case FN.PROGRAM_VERSION:
        return frame(fn, [2, 1, 1]);
      case FN.BOOT_VERSION:
        return frame(fn, [255, 255]);
      default:
        return null;
    }
  };

  /** @param {number} register @param {number} value */
  const applies = (register, value) => {
    if (register === 0x1d || register === 0x1e) return value === 0 || value === 1;
    if (register >= 0x10 && register <= 0x1c) return register !== 0x14 && register !== 0x15 && value > 0;
    return (register >= 0x20 && register <= 0x2b) || (register >= 0x30 && register <= 0x3b) || (register >= 0x40 && register <= 0x45);
  };

  /** @param {Uint8Array} bytes */
  const reply = (bytes) => {
    const send = () => {
      if (link.isOpen) link.write(bytes).catch(() => {});
    };
    if (answerDelayMs > 0) {
      const t = setTimeout(send, answerDelayMs);
      /** @type {any} */ (t).unref?.();
    } else send();
  };

  /** @param {Uint8Array} f */
  const handle = (f) => {
    received.push(f);
    const fn = f[1];
    if (f[2] === 2) {
      const value = (f[3] << 8) | f[4];
      if (opts.ignoreWrites?.includes(fn) || !applies(fn, value)) return;
      state.writes++;
      if (fn === 0x1d) sim.switches.charge = value === 1;
      else if (fn === 0x1e) sim.switches.discharge = value === 1;
      else regs[fn] = value;
      return;
    }
    if (f[2] !== 0 || silent.has(fn)) return;
    const out = answer(fn);
    if (!out) return;
    state.reads++;
    reply(out);
  };

  const assembler = createAssembler({ onFrame: handle });
  const off = link.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));
  const stopTimer = stepMs > 0 ? every(() => step(stepMs / 1000), stepMs) : () => {};
  step(0);

  return {
    battery: sim,
    registers: regs,
    state,
    received,
    step,
    stop() {
      stopTimer();
      off();
    },
  };
}
