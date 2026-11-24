# Protocols

Implementation-ready specifications of every supported protocol, with sources and real frames.
Each specification is the reference for its driver in `packages/bms-drivers/src/<family>/`, and
the frames in `packages/bms-drivers/test/vectors/<family>.json` are the reference for its tests.

| Family | Specification | Variants | Links |
| --- | --- | --- | --- |
| JK BMS (Jikong) | [jk.md](jk.md) | JK02 24S and 32S (BLE), JK04 (BLE), JK-PB RS485 Modbus, JK-B UART "4E 57" | BLE, RS485, UART |
| ANT BMS | [ant.md](ant.md) | 2021+ protocol (7E A1 frames), legacy protocol (AA 55 AA FF status) | BLE, UART |
| Daly BMS | [daly.md](daly.md) | classic 13-byte protocol, newer Modbus style protocol | BLE, UART, RS485 |
| JK active balancers | [jk-balancer.md](jk-balancer.md) | JK04 (BLE), JK-DZ11-B2A24S RS485 | BLE, RS485 |
| Atorch meters and loads | [atorch.md](atorch.md) | FF 55 reports and commands, PX100 load frames | BLE |
| NEEY active balancers | [neey.md](neey.md) | V1 (100-byte settings), V2 (150-byte settings, EK-B models) | BLE |
| Daly active balancers | [daly-balancer.md](daly-balancer.md) | Modbus D2 | BLE, UART |
| JBD BMS | [jbd.md](jbd.md) | DD A5 protocol, UP series Modbus style protocol | BLE, UART, RS485 |
| Seplos BMS | [seplos.md](seplos.md) | version 2 ASCII and its Bluetooth binary form, version 3 Modbus RTU | BLE, RS485, RS232 |
| KS BMS (KS48100, KS48200, KS48300) | [ks.md](ks.md) | 7B frames | BLE |
| Deye batteries | [deye.md](deye.md) | AA 55 protocol (RS485 and AES encrypted Bluetooth), PCS CAN broadcast (Pylontech style) | RS485, BLE, CAN through SLCAN |

## Drivers

| Driver id | Family | Specification sections | Detection |
| --- | --- | --- | --- |
| `jk-balancer-ble` | JK | JK04 balancer | device info request 0x97, then the first cell frame after 0x96 must have the JK04 layout; registered before `jk-ble` |
| `jk-ble` | JK | JK02 24S and 32S, JK04 | device info request 0x97, variant from the software version and the first cell frame |
| `jk-pb-rs485` | JK | JK-PB RS485 | FC 0x10 frame trigger to the configured address |
| `jk-uart` | JK | 4E 57 UART | read-all command |
| `jk-balancer-rs485` | JK | RS485 balancer | read request 55 AA 01 FF 00 00 FF at 9600 baud, 74-byte EB 90 answer with plausible cells |
| `neey-ble` | NEEY | V1 and V2 | device info request AA 55 11 01 01 00 14 00 (sum8, then the xor8 form of the old app once); registered after JK and before ANT |
| `ant` | ANT | 2021+ protocol | status request 7E A1 01 |
| `ant-legacy` | ANT | legacy protocol | status request DB DB 00 00 00 00 (BLE) or 5A 5A 00 00 01 01 (UART) |
| `jbd` | JBD | DD A5 | basic info read DD A5 03 00 FF FD 77, on FF00 at most one app key frame; registered before the Daly drivers |
| `ks-ble` | KS | 7B frames | status read 7B 01 00 7D, then 7B 61 00 7D, plausible status; right after `jbd` (same FF00 layout, no name to rank by) |
| `daly-balancer` | Daly | Modbus D2 balancer | D2 read of 62 status registers with plausible cells; registered before `daly-modbus`, which would accept a balancer |
| `daly-modbus` | Daly | Modbus D2 and 0x81 | status register read (D2 first, then the 0x81 map) |
| `daly` | Daly | classic A5 | 0x90 request (twice, Daly modules sleep) then 0x94 |
| `jbd-up-rs485` | JBD | UP series | Modbus read at the configured address; serial only, after the Daly drivers |
| `deye-rs485` | Deye | AA 55 over RS485 | read AA 55 01 01 00 00 20 0D 0A at 9600 baud, CRC and plausibility checks; before Seplos |
| `seplos-v3` | Seplos | version 3 | Modbus function 0x04 and 0x01 reads |
| `seplos-v2-ble` | Seplos | version 2 over Bluetooth | 0x51 and 0x61 reads |
| `seplos-v2` | Seplos | version 2 ASCII | 0x51 and 0x42 reads at 19200, then 9600 baud |
| `deye-ble` | Deye | AA 55 in an AES session | handshake message `random`, only a Deye BMS computes the expected cipher block from the advertised name |
| `deye-can` | Deye | PCS CAN through SLCAN | explicit selection only (`autoDetect: false`); opens the adapter listen-only and never transmits a CAN frame |
| `atorch` | Atorch | FF 55 | listens for a report for up to 3 s and never writes; registered last |

The table lists the drivers in detection order, which is the registration order in
`packages/bms-drivers/src/index.js`.

## Common notes

- **Byte order and units.** Each table states the byte order and scaling. Drivers convert to the
  unified model: volts, amperes, watts, ampere hours, degrees Celsius, percent, seconds. Current
  is positive while charging in the model, whatever the device convention is.
- **Shared Bluetooth UUIDs.** JK BMS and ANT BMS both use service `FFE0` with characteristic
  `FFE1`. Detection therefore always validates the answer (preamble, length, checksum, function)
  instead of trusting UUIDs or names.
- **Fragmentation.** BLE notifications carry 20 bytes unless a larger MTU was negotiated, and
  devices may split or merge frames arbitrarily. Every driver uses a `FrameAssembler` that finds
  the frame start, reads the length and validates the checksum (see
  [architecture](../architecture.md#data-flow)).
- **Safety.** Settings whose encoding is not confirmed by at least one capture or by the vendor
  documentation are shown read-only. Writes are always validated, confirmed by the user, logged
  and verified by reading back.
- **Status markers.** `unverified` in a specification means no capture or vendor document
  confirms the item; implementations treat such items conservatively.

## Adding captures

Export a protocol log from the app (Log, Export), find the frames of interest and add them to the
vector file with a short description and the decoded values you expect. Mention the device
model, hardware and firmware version.
