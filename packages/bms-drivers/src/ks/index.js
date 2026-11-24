import { ksDefinition } from './driver.js';

/**
 * Driver definitions of the KS family (docs/protocols/ks.md, "spec" below):
 * - `ks-ble`: the 7B frames over the Bluetooth module of the KS48100 / KS48200 / KS48300 boards
 *   (service FF00). Its probe is the read-only status request `7B 01 00 7D`, then `7B 61 00 7D`
 *   for the "type 2" boards, accepted only for a plausible status (spec 6).
 *
 * Registration (spec 6): KS shares the FF00 layout with JBD (and the Daly fallback layout). The
 * modules advertise no recognisable name, so the registration order decides: `ks-ble` right after
 * `jbd`. A JBD answers its own probe in about 0.25 s and never gets a 7B frame; a KS module first
 * sits through the unanswered JBD reads (about 3.75 s), and a Daly module on FF00 pays the two
 * unanswered KS reads (2.5 s). Choosing the KS type in the connect screen skips the other probes.
 * @type {import('../index.js').DriverDefinitionWithDemo[]}
 */
export const ksDrivers = [ksDefinition];

export { KS_BLE_PROFILE, KS_VENDOR, KsDriver, VARIANT, ksDefinition, ksInfo, ksSnapshot, statusProblem } from './driver.js';
export { createKsSimulator } from './simulator.js';
export { buildKsSchema, decodeKsSettings, rawToValue, valueToRaw } from './settings.js';
export * as ksProtocol from './protocol.js';
