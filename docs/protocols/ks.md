# KS BMS (KS48100, KS48200, KS48300)

Boards with the `KS` prefix (KS48100-Ho21, KS48200, KS48300-Ho23), probably made by Kesheng
(科圣), sit in many unbranded wall mounted and rack 16S LiFePO4 packs (51.2 V). The board has a
monochrome LCD with four buttons, a 6 position `ADD` DIP switch, the RJ45 ports `RS485A/CAN` and
`RS485B` (two), and a Bluetooth plus Wi-Fi module behind the front window. The official app is
"lithium battery wifi" by Shenzhen Jizhi Electronics (iOS id6458650222, Android
`com.jizhi.kesheng`); it disappeared from the App Store in 2026.

Driver: `packages/bms-drivers/src/ks/` (`ks-ble`, experimental, settings read only). Only the
Bluetooth path is implemented.

## Sources

- **[SY]** syssi, esphome-ks-bms, commit 4679c0c (2026-11-21):
  https://github.com/syssi/esphome-ks-bms (`components/ks_bms_ble/ks_bms_ble.cpp`, the register
  map in `components/ks_bms_ble/number/__init__.py` and `switch/__init__.py`, the captures in
  `docs/pdus/`). Apache 2.0. Its references: the VoltPolska app
  (https://github.com/ALEGATOR1209/VoltPolska), https://dou.ua/forums/topic/42715/ and
  https://diysolarforum.com/threads/bemory-bms-ks48100.87902/.
- **[SPEC]** KS48100-Ho21 specification (2024, Chinese and English), via
  https://forum.mypower.cz/download/file.php?id=53064 and id=53065: cell limits, connectors, the
  list of inverter protocols.
- **[MAN]** Manual of a pack with the same front panel (LFP48100P to LFP48300P, V2412-Ho-01-04):
  https://manuals.plus/voltronic/lfp48100p-rack-mounted-3u-module-manual (DIP switch, RJ45 pins).
- **[HW]** The board of this project (photos and a screenshot of the official app, 2026-11-24):
  module firmware `KS_BLE_WIFI_Ver1.0.0_20240313`, "BMS Program Version" 2.1.1, "BMS BOOT Version"
  255.255, 16 cells, 4 temperature probes, Quectel FC41D module (Wi-Fi 4 and Bluetooth LE 5.2) on a
  carrier board with a 4 pin `GND TX RX VIN` connector.

Nothing in this file is confirmed by a capture of the official app. The read frames are
confirmed by the [SY] captures of three boards; the register writes only by [SY] code.

## 1. Frame format

Requests and answers have the same layout, without a checksum:

| Offset | Size | Content |
| --- | --- | --- |
| 0 | 1 | `7B` start |
| 1 | 1 | function (read) or register (write) |
| 2 | 1 | data length n |
| 3 | n | data, 16 bit words big endian |
| 3 + n | 1 | `7D` end |

A read request has no data: `7B 01 00 7D`. The answer carries the same function byte. The
assembler takes the frame size from the length byte and checks the end byte; a data byte `7B` after
a lost notification is resynchronised on the next start byte.

## 2. Links

### 2.1 Bluetooth

GATT service `FF00`, notify `FF01`, write `FF02`, written without response ([SY]). This is the
layout of the JBD modules ([jbd.md](jbd.md)); detection tells them apart (section 6). Frames up to
36 bytes arrive in two notifications at the default MTU.

The advertised name is the pack serial number or a model code: `CER2410-018-030-023`,
`TZ-H002-02408-0103`, `12V100A00460` ([SY] README, "probably"), `BL-250-100-100`, `25F-100-065`
(serial frames of the [SY] captures). There is no common prefix, so the definition sets no chooser
filter or name pattern. `TZ-H` names are also listed for JBD modules ([jbd.md](jbd.md) section
11.1). The module takes one Bluetooth connection at a time: close the official app first.

[SY] knows a "device type 2" that answers the status at function `0x61` instead of `0x01`; which
boards these are is not documented.

### 2.2 Other ports (not implemented)

- `RS485A/CAN` (RJ45 pins 1 and 8 B, 2 and 7 A, 4 CAN_H, 5 CAN_L, 6 GND) and `RS485B` (pins 1 and 8
  B2, 2 and 7 A2, 6 GND) ([MAN], [SPEC]). Defaults RS485 9600 baud, CAN 500 kbit/s. The DIP switch
  selects the address (bits 1 to 4) and, on the master, the inverter protocol (bits 5 and 6).
  [SPEC] lists Pylon CAN, Growatt CAN, Victron CAN, Voltronic RS485, the SRNE "WOW" protocol and a
  vendor protocol `科圣-BMS_Protocol_V1_0_0`, which is not public. Whether the board answers the 7B
  frames on RS485 is unverified.
- The module connector `GND TX RX VIN` [HW]: the voltage of VIN and the UART level are unknown
  (the carrier board has a DC-DC converter), so measure before connecting anything.

## 3. Read functions

Offsets are frame offsets (the first data byte is offset 3).

### 3.1 Status `0x01` (`0x61` on type 2 boards), length `0x20`

| Offset | Size | Content | Unit |
| --- | --- | --- | --- |
| 3 | 2 | state of charge | % |
| 5 | 2 | pack voltage | 0.01 V |
| 7 | 2 | average temperature, signed | 0.1 °C |
| 9 | 2 | ambient temperature, signed ([SY]: "ambient?") | 0.1 °C |
| 11 | 2 | MOSFET temperature, signed | 0.1 °C |
| 13 | 2 | current, signed, positive while charging | 0.01 A |
| 15 | 2 | remaining capacity | 0.01 Ah |
| 17 | 2 | full charge capacity (register 0x1C) | 0.01 Ah |
| 19 | 2 | nominal capacity (register 0x1A) | 0.01 Ah |
| 21 | 2 | cycle capacity (register 0x1B) | 0.01 Ah |
| 23 | 2 | cycle count | |
| 25 | 4 | balancing cells, bit i = cell i + 1 | |
| 29 | 2 | FET status: bit 0 charging, bit 1 discharging, bit 2 charge MOSFET on, bit 3 discharge MOSFET on, bits 4 and 5 current limiting | |
| 31 | 2 | protection bits (section 5) | |
| 33 | 2 | state of health, only when the frame is this long | % |

The 16 bit capacity words limit the pack to 655.35 Ah. Bits 0 and 1 of the FET word match the sign of the current in the captures
(`0x0E` at -19.90 A); [SY] calls them balancer charging and discharging.

### 3.2 Cell voltages `0x02`

Data: cell count (1 byte), then one word per cell in mV. Length `0x21` for 16 cells.

### 3.3 Temperatures `0x03`

Data: probe count (1 byte), then one word per probe in 0.1 K: °C = (raw - 2731) / 10. The four
probes sit on the cells ([HW]: the official app calls them "Cell 1 Temperature" to "Cell 4
Temperature").

### 3.4 Basic settings `0x04`, length `0x14`, registers 0x10 to 0x19

| Word | Register | Content ([SY] names) | Unit |
| --- | --- | --- | --- |
| 0 | 0x10 | cell full voltage | mV |
| 1 | 0x11 | cell cutoff voltage | mV |
| 2 | 0x12 | balance open voltage | mV |
| 3 | 0x13 | balance open voltage difference | mV |
| 4 | 0x14 | unknown, integer | |
| 5 | 0x15 | unknown, 0.01 | |
| 6..9 | 0x16..0x19 | cell voltage at 80, 60, 40 and 20 % SOC | mV |

No capture of this block exists; the layout is from the [SY] decoder.

### 3.5 Voltage protection `0x05`, length `0x18`, registers 0x20 to 0x2B

Cell overvoltage protection, recovery, delay; cell undervoltage protection, recovery, delay
(mV, mV, ms); pack overvoltage protection, recovery, delay; pack undervoltage protection,
recovery, delay (0.01 V, 0.01 V, ms). KS48200 capture: 3650, 3380, 2000, 2500, 3000, 3000, 5840,
5440, 3000, 4000, 4800, 3000, which matches the cell limits of [SPEC] (3650 / 3380 mV and
2500 / 3000 mV).

### 3.6 Temperature protection `0x06`, length `0x18`, registers 0x30 to 0x3B

Charge overtemperature, charge undertemperature, discharge overtemperature and discharge
undertemperature, each as protection, recovery (0.1 K) and delay (ms). KS48200 capture: 55 / 50,
-1 / 5, 60 / 55 and -20 / -15 °C, all delays 3 s; [SPEC] gives -1 °C ±3 with recovery 5 °C for
the charge undertemperature protection.

### 3.7 Current protection `0x07`, length `0x0C`, registers 0x40 to 0x45

Charge overcurrent protection (0.01 A), delay (ms), recovery delay (10 ms); the same for
discharge. KS48200 capture: 215 A, 3 s, 0.

### 3.8 Texts and date

| Function | Content | Length in the captures |
| --- | --- | --- |
| `0x09` | manufacturing date: year - 2000, month, day; `FF FF FF` unset | 3 |
| `0x0A` | model name, ASCII; 0xFF filled or length 0 when unset | 0x1E, 0x0F, 0 |
| `0x0B` | serial number, ASCII | 0x13, 0x0E, 0x0B |
| `0x0C` | model type, ASCII; 0xFF filled when unset | 0x14 |
| `0x74` | Bluetooth module firmware, ASCII (`KS_BLE_Ver1.0.0_20240716`) | 0x18 |

### 3.9 Versions

`0xF4`: three bytes, [SY] "hardware version" (2.2.1). The official app shows a three part
"BMS Program Version" (2.1.1 on [HW]), so ubms shows `0xF4` as the software version (unverified
match). `0xF5`: two bytes, boot version (2.57; "BMS BOOT Version" 255.255 on [HW]). `0xF3`: two
bytes, [SY] "software version"; no answer in the KS48100 capture, read once with a short timeout.

### 3.10 Protection counters `0x08`, length `0x16`

Eleven words in this order ([SY] abbreviations in brackets): short circuit (scpt), charge
overcurrent (cot), discharge overcurrent (dot), cell overvoltage (otom), unknown (tomu, [SY]:
"charge undercurrent"), pack overvoltage (oot), pack undervoltage (out), charge overtemperature
(chtt), charge undertemperature (ltct), discharge overtemperature (htdt), discharge
undertemperature (ltdt). ubms labels the fifth counter as unverified.

Function `0x64` ([SY] "status bitmask") got no answer and is not used.

## 4. Register writes

`7B <register> 02 <hi> <lo> 7D`, one word, no answer ([SY] writes without waiting). Registers and
scaling ([SY] `number/__init__.py`, `switch/__init__.py`): 0x10 to 0x13 and 0x16 to 0x19 as in
section 3.4; 0x1A nominal, 0x1B cycle and 0x1C full charge capacity (0.01 Ah); 0x1D charge MOSFET
and 0x1E discharge MOSFET (1 on, 0 off); 0x20 to 0x2B, 0x30 to 0x3B and 0x40 to 0x45 as in
sections 3.5 to 3.7 (temperatures as °C x 10 + 2731).

No capture confirms these writes, so ubms shows every setting read only for now (README rule for
unconfirmed encodings). The write path is implemented and tested on the simulator
(`new KsDriver(definition, ctx, { writable: true })`): it writes only these registers, never 0x14
and 0x15, within the ranges of the settings schema, asks for a confirmation before each write and
reads the block back up to three times (300 ms apart) until it shows the new value; otherwise it
reports that the BMS did not take it. It is switched on once a board confirms the map.

## 5. Protection bits (status offset 31)

[SY] names: 0 overcurrent, 1 undercurrent, 2 overvoltage, 3 undervoltage, 4 charge
overtemperature, 5 charge undertemperature, 6 discharge overtemperature, 7 discharge
undertemperature, 8 charge overcurrent, 9 discharge overcurrent, 10 short circuit, 11 analog front
end error, 12 soft lock MOS, 13 charge MOSFET error, 14 discharge MOSFET error, 15 reserved. Bits 0
to 3 do not say whether the cell or the pack limit tripped, so ubms keeps them as driver specific
alarms. The official app shows "DSG MOS Fault Status" ([HW]), probably bit 14 (unverified).

ubms adds one alarm of its own: charging (current above 0.15 A) while a cell probe reads below
0 °C. [HW] showed probes at -3 and -7 °C with the charge MOSFET on.

## 6. Detection

The probe reads the status `7B 01 00 7D` and then, without an answer, `7B 61 00 7D`; it accepts
a status frame with a pack voltage between 1 and 120 V, SOC and SOH up to 100 % and a remaining
capacity not far above the full capacity. Nothing else is sent.

`ks-ble` is registered right after `jbd`. A JBD answers its own probe in about 0.25 s; a KS module
sits through the unanswered JBD reads (about 3.75 s) and ignores the JBD app key frame (no 7B
start); a Daly module on the FF00 fallback layout pays the two unanswered KS reads. Choosing the KS
type in the connect screen skips the other probes.

## 7. Open questions

- The register map and the switch registers are not confirmed by a capture on any board.
- Bits 4 and 5 of the FET word: which one is the charge current limiter ([SPEC]: 20 A limiter
  module on the board) is unknown.
- The meaning of registers 0x14, 0x15 and of the fifth protection counter.
- Whether RS485A answers the 7B frames, and the Wi-Fi path of the module.
