import { jkDrivers } from './jk/index.js';
import { antDrivers } from './ant/index.js';
import { dalyDrivers } from './daly/index.js';
import { atorchDrivers } from './atorch/index.js';
import { neeyDrivers } from './neey/index.js';
import { dalyBalancerDrivers } from './daly-balancer/index.js';
import { jbdDefinition, jbdUpRs485Definition } from './jbd/index.js';
import { seplosDrivers } from './seplos/index.js';
import { ksDrivers } from './ks/index.js';
import { deyeBleDefinition, deyeCanDefinition, deyeRs485Definition } from './deye/index.js';

/**
 * @typedef {{ name: string, chunkSize?: number, create: (link: import('@ubms/transport').Link) => { stop?: () => void } }} DemoDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition & { demo?: DemoDefinition }} DriverDefinitionWithDemo
 */

/**
 * All driver definitions, in detection order. Each family keeps its definitions in its own
 * folder; a definition may carry a `demo` entry with a device simulator that speaks the real
 * protocol over an in-memory link.
 *
 * Bluetooth candidates are ranked by name first (registry.js), so this order only decides among
 * equal ranks, for example for renamed devices:
 * - FFE0 / FFE1 (JK, NEEY, ANT, Atorch): the two JK probes first (JK BMS are the most common and
 *   have user defined names), then NEEY, then ANT. Atorch meters only listen during detection and
 *   come last, so that the default demo stays `jk-ble` and an unknown FFE0 device gets the quick
 *   write probes before the three second listen window.
 * - FF00 and FFF0 (JBD, Daly, Seplos): `jbd` first (one short read that a JBD answers in about
 *   0.25 s, and an unnamed FF00 device is more often a JBD than a Daly), then the Daly balancer
 *   before `daly-modbus`, which would accept a balancer, then the Daly BMS drivers, then Seplos
 *   (its names BPxx, SPxxB, XZH rank first anyway). `ks-ble` sits right after `jbd`: KS modules
 *   advertise no recognisable name and answer only the 7B frames (docs/protocols/ks.md section 6).
 * - FFF1 (Deye): no other family uses it, so `deye-ble` only matters for ties and sits after
 *   Seplos and before Atorch.
 * - Serial: the rare address based `jbd-up-rs485` after the Daly drivers, then `deye-rs485`
 *   (one short AA 55 read that Seplos and Pylontech packs ignore; after Seplos a Deye pack would
 *   first sit through the three Seplos trials). `deye-can` needs an SLCAN USB-CAN adapter and
 *   carries `links.serial.autoDetect: false`, so it runs only when selected explicitly.
 * See the detection sections of docs/protocols/*.md and the comments in each family's index.js.
 * @type {DriverDefinitionWithDemo[]}
 */
export const drivers = [
  ...jkDrivers,
  ...neeyDrivers,
  ...antDrivers,
  jbdDefinition,
  ...ksDrivers,
  ...dalyBalancerDrivers,
  ...dalyDrivers,
  jbdUpRs485Definition,
  deyeRs485Definition,
  ...seplosDrivers,
  deyeBleDefinition,
  deyeCanDefinition,
  ...atorchDrivers,
];

export { SimBattery } from './common/sim-battery.js';
