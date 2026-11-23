# JK BMS (Jikong) communication protocols

Implementation reference for the ubms JK driver: the BLE protocol JK02 in its two layouts (JK02_24S and JK02_32S, the latter also used by the JK-PB series), the old BLE protocol JK04, JK-PB over RS485 (Modbus RTU register map and the FC 0x10 trigger that returns JK02_32S frames) and the JK-B UART/RS485 "4E 57" protocol.

Compiled 2026-11-18 from the source code and tests of the open-source projects listed in section 13, vendor documents published in those repositories, and Bluetooth HCI captures of the official JK app. Every statement carries a source tag. **unverified** marks a value that has a single source, was inferred, or conflicts between sources.

Test vectors: `packages/bms-drivers/test/vectors/jk.json`. Field names written in `code` in this document are the keys used in the `expected` objects of that file.

## Contents

0. Conventions
1. Overview
2. Physical links
3. Frame formats
4. Session flow
5. Commands
6. Responses
7. Settings
8. Controls and actions
9. Bits and enumerations
10. Device information
11. Detection
12. Pitfalls and quirks
13. References

## 0. Conventions

- Offsets are byte offsets from the first header byte of the frame, written as decimal with hex in parentheses, e.g. 118 (0x76).
- Types: u8, i8, u16, i16, u32, i32 (two's complement), f32 = IEEE 754 single precision. LE = little-endian, BE = big-endian. BLE frames and the 300-byte RS485 frames are LE; 4E57 frames and Modbus register values are BE.
- sum8 = arithmetic sum of the listed bytes modulo 256.
- CRC-16/MODBUS = reflected polynomial 0xA001, initial value 0xFFFF, no final XOR, sent low byte first.
- Scale: physical value = raw × scale. "0.001 V" means the raw value is in mV.
- "S130" means settings frame offset 130, "C178" cell info frame offset 178, "D266" device info frame offset 266.
- Source tags (details in section 13): [SY] syssi/esphome-jk-bms, [TX] txubelaxu/esphome-jk-bms, [AIO] patman15/aiobmsble, [BM] fl4p/batmon-ha, [DSB] mr-manuel/venus-os_dbus-serialbattery, [MPP] jblance/mpp-solar, [JKT] sshoecraft/jktool, [JKMB] JK "BMS RS485 Modbus" V1.0 and V1.1, [JK4E57] JK "Communication protocol between monitoring platform and BMS" (2020-12-17), [JKPB] JK PB series user manual, [CAP] btsnoop captures of the official JK app stored in [SY]/docs, [JD] and [VS] two small projects with 4E57 write frames.

## 1. Overview

### 1.1 Families and protocols

| Family | Example models (hardware / software) | BLE | Wired | Sources |
|---|---|---|---|---|
| JK-B, JK-BD smart BMS with software < 11 | JK-B2A24S15P 10.XW/10.07, JK-B2A24S20P 8.x/8.1.2H, JK-BD6A24S10P 8.x/8.0.6G, JK-B2A8S20P 9.x/9.01M3, JK-B1A20S15P 10.XW/10.10 | JK02_24S | 4E57 on the UART-TTL "GPS" port | [SY] README, tests |
| JK-B, JK-BD smart BMS with software ≥ 11 | JK-B2A8S20P 11.XW/11.26, JK-B1A20S15P 11A/11.52 and 18H/18.00, JK-B2A8S30P 15A/15.26, 17H/17.06, sw 19.04, JK-BD6A32S15P 20H/20.19 (32 cells) | JK02_32S | 4E57 still reported on hardware 11 (JK-BD6A20S12P 11.281, JK-B2A8S20P 11.XA/11.48, JK-B2A20S20P 11.284) | [SY] README, [BM] doc/JK-Settings.md and fixtures |
| JK-PB inverter / ESS BMS | JK_PB2A16S15P 14.XA/14.20, 15A/15.38, 15.XA/15.10; JK-PB2A16S20P 19A/19.05 and 19A/19.27 | JK02_32S | RS485: Modbus RTU register map, plus the trigger protocol that returns JK02_32S frames; CAN (not covered) | [SY] tests, [TX], [DSB], [MPP] jkpb.py |
| JK04 active balancer (no MOSFETs, no current shunt) | JK-B2A16S 3.0/3.3.0, JK-B2A24S 3.0/3.2.3, JK-B5A24S 8.X/8.0.3M | JK04 | none known | [SY] tests, [BM] models/jk04.py, [MPP] jk04.py |

Not covered, listed so a driver does not confuse them with the protocols above:
- the "DD A5 ... 77" protocol (JBD style, 9600 baud) of JK's obsolete English RS485 document ([SY] docs/RS485-english-OBSOLETE.pdf) and of [MPP] jk232.py;
- the RS485 protocol of the JK-B1A24S / JK-B2A24S active balancers ("55 AA 01 FF ...", [MPP] jk485.py, [SY] jk_balancer);
- CAN protocols and the display port.

### 1.2 Telling variants apart at runtime

- BLE JK02: request the device info frame (command 0x97) and read the software version string at D30. Major number (digits before the first dot) ≥ 11 selects JK02_32S, otherwise JK02_24S ([AIO] `_init_connection`, [BM] `JKBt.fetch`). [SY] example configuration recommends JK02_32S for hardware ≥ 11, but [SY] README lists "JK-B2A20S20P hw 10.XW, sw 11.21h, using JK02_32S", so the software version is the reliable criterion. Examples: "10.07" gives 24S, "11.48" and "19.27" give 32S.
- JK04 cannot be recognised from the device info frame alone (hardware and software 8.x exist in both families, [BM] jk04.py). Recognise it from the data (section 11.3).
- 4E57 (UART) and JK-PB (RS485 Modbus) are separate wire protocols, selected by link type and confirmed with a probe (section 11).

## 2. Physical links

### 2.1 BLE

| Item | Value | Source |
|---|---|---|
| Service | 0xFFE0, `0000ffe0-0000-1000-8000-00805f9b34fb` | [SY] `JK_BMS_SERVICE_UUID`, [AIO], [BM], [DSB] |
| Data characteristic | 0xFFE1, `0000ffe1-0000-1000-8000-00805f9b34fb`, used for commands and notifications | same |
| Write type | write without response (ATT Write Command); the official app uses it [CAP]; write with response also works ([BM], [DSB] through bleak) | [SY] `write_register`, [CAP] |
| Pairing, PIN | none; the passcodes in the device info frame are enforced by the app only | [BM] `JKBt.__init__` |
| Connections | one central at a time; close the JK app before connecting | [BM] doc/JK-Settings.md |

GATT layouts ([SY] comments in `gattc_event_handler`, [CAP], [DSB] jkbms_brn.py):

| Module | Characteristics in service FFE0 | Remarks |
|---|---|---|
| "new" module ([SY] example MAC 20:21:11:xx) | FFE1 at handle 0x03, properties 0x0C (write, write without response); FFE1 at handle 0x05, properties 0x12 (read, notify), CCCD at 0x06 | two characteristics share UUID FFE1 |
| "old" module ([SY] example MAC C8:47:8C:xx) | FFE1 at handle 0x12, properties 0x1C (write without response, write, notify); FFE2 at handle 0x10, properties 0x04 | further services 1800, 1801, 180A, 180F and F000FFC0 (TI OAD) |

In the official-app captures of a JK-BD6A24S10P (sw 8.0.6G) and of a JK-PB the app writes 0x0100 to the CCCD at handle 0x13 and sends commands to handle 0x12 [CAP].

Web Bluetooth: request the device with the service 0xffe0 (and optionally a manufacturer-data filter, section 11.1), then call `service.getCharacteristics(0xffe1)` (plural). Start notifications on the characteristic whose properties include `notify`, write commands to the one with `writeWithoutResponse` (fallback `write`). With duplicate FFE1 characteristics bleak raises "Multiple Characteristics with this UUID", which is why [DSB] and [BM] fall back to handles.

Notifications: a 300-byte frame always arrives as several notifications. Observed splits: 128 + 128 + 44 bytes ([SY] comment in `decode_jk02_cell_info_`), 128 + 128 + 22 + 22 [CAP JK-PB], 80 + 80 + 80 + 60 ([BM] jk04_fixtures.py, JK-B5A24S) and 20-byte chunks at the default MTU [CAP JK04]. One notification can end a frame and start the next one: [BM] issue 377 shows a 384-byte buffer holding a settings frame plus the first 84 bytes of a device info frame. Web Bluetooth cannot set the MTU, so the driver must reassemble (section 3.4).

Bytes in the notification stream that are not data frames:
- the text `AT\r\n` (41 54 0D 0A) emitted by the BLE UART module, either as a notification of its own (182 times in 47 s in a JK-PB capture [CAP]) or attached to other data ([AIO] `_BT_MODULE_MSG`, [BM] `feed_frames`);
- the 20-byte ACK frame (section 3.3), sometimes appended right after a 300-byte frame ([AIO] test data "JK02_32S_v19.05").

Advertising:
- Local name: the user-editable device name (D46). Seen: "JK_B2A8S20P", "JK-BD4A8S-4P", "BatteryOben-00", "Baterie 1", "506036N46002293-00" ([AIO] test_data/jikong_bms.json). Not usable as the only filter.
- Manufacturer data ([AIO] `matcher_dict_list` and test data):
  - company ID 0x0B65 (2917) with payload `88 A0` followed by the 6-byte Bluetooth address, e.g. `88 A0 C8 47 80 0F D5 C5`;
  - company ID 0x4B4A (ASCII "JK" when read little-endian) with payload `00 01` (JK-BD4A8S-4P).
- Service UUIDs in the advertisement: FFE0, on some devices also FEE7 and F000FFC0.

### 2.2 UART-TTL / RS485 "GPS" port (4E57)

| Item | Value | Source |
|---|---|---|
| Line | UART-TTL 3.3 V, 115200 baud, 8 data bits, no parity, 1 stop bit | [JK4E57] chapter 2 and version table (115200 since V20200329), [SY] esp32-example.yaml |
| Connector | 4-pin JST, 1.25 mm pitch: GND, RX, TX, VBAT; some units label it "RS485". VBAT carries pack voltage, never connect it to an adapter | [SY] README |
| RS485 | same protocol through the JK RS485 adapter on this port | [SY] docs, [DSB] jkbms.py |
| Timing | at least 100 ms between packets, reply within 5 s; [SY] polls every 5 s and discards a partial frame after 50 ms without bytes | [JK4E57] 4.1, [SY] jk_modbus `rx_timeout` |
| Addressing | 4-byte terminal number, always 00 00 00 00 in practice | [JK4E57] 4.2.3, all implementations |

### 2.3 JK-PB RS485

| Item | Value | Source |
|---|---|---|
| Line | RS485 half duplex, 115200 baud, 8N1 | [JKMB] V1.0, [DSB] bms-docs/JKBMS-PB.md, [SY] esp32-jk-pb-modbus-example.yaml |
| Ports | RS485-1: inverter port; RS485-2: parallel bus between packs | [JKPB] |
| Address | 4 DIP switches with weights 1, 2, 4, 8 give 0–15. Address 0 makes the BMS the master of the parallel bus; slaves need distinct addresses 1–15 | [JKPB], [TX] jk_rs485_bms/README.md, [SY] esp32-jk-pb-modbus-example.yaml |
| Framing | Modbus RTU with CRC-16/MODBUS | [JKMB], [DSB], [TX] `crc16_c` |
| Wiring | RJ45 pins 1, 2, 3 = B, A, GND (pins 8, 7, 6 when counted from the other side) | [TX] README diagram |

RS485-1 speaks the protocol chosen with the "UART1 protocol" setting (section 9.6: index 1 = "JK BMS RS485 Modbus V1.0", index 13 = the same at 9600 baud). That UART1 is the RS485-1 port is an inference (**unverified**). The trigger protocol (section 3.6.3) is what the parallel-bus master, the vendor PC tool "JKBMS Monitor", [DSB] and [TX] use ([DSB] JKBMS-PB.md).

USB adapter quirks ([DSB] JKBMS-PB.md): the vendor CH341 adapter echoes the transmitted bytes (up to 11 bytes appear before the answer) and keeps stale bytes across port close and reopen, so flush the input before each request. Single-chip FT232R adapters truncated answers; CH340/CH341 and FT2232H adapters worked.

## 3. Frame formats

### 3.1 BLE command frame (host to BMS), JK02 and JK04

Always 20 bytes ([SY] `build_frame`, [AIO] `_cmd`, [BM] `_jk_command`, [MPP] `get_full_command`, [JKT] `jk_get_info`):

| Offset | Length | Content |
|---|---|---|
| 0 (0x00) | 4 | AA 55 90 EB |
| 4 (0x04) | 1 | register or command code |
| 5 (0x05) | 1 | value length: 0 for requests and buttons; 1, 2 or 4 for values; up to 13 for text |
| 6 (0x06) | 13 | value (LE), then filler up to byte 18 |
| 19 (0x13) | 1 | sum8 of bytes 0..18 |

- Filler: send zeros ([SY], [AIO], [BM]). The official app puts random bytes after the value and includes them in the checksum; the BMS accepts both [CAP]. A [SY] document calls byte 16 a sequence counter, but no implementation sends one and the app captures show random data there (**unverified**, ignore).
- JK02 values: raw = value ÷ scale, as a two's complement integer, written LE into bytes 6.. (4 bytes for length 4, 2 for length 2, 1 for length 1).
- JK04 values: IEEE 754 float32 LE when the length is 4 (the value itself, no scale), integers for lengths 1 and 2 ([SY] `encode_jk04_payload`).
- Example: cell OVP 3.650 V is register 0x04, length 4, raw 3650 = `42 0E 00 00`: `AA 55 90 EB 04 04 42 0E 00 00 00 00 00 00 00 00 00 00 00 D2` ([MPP] test_get_full_command_set_cell_ovp).

### 3.2 Data frame (BMS to host)

Always 300 bytes, on BLE and inside RS485 trigger answers ([SY], [AIO], [BM], [DSB], [MPP], [JKT]):

| Offset | Length | Content |
|---|---|---|
| 0 (0x00) | 4 | 55 AA EB 90 |
| 4 (0x04) | 1 | frame type: 0x01 settings, 0x02 cell info (live data), 0x03 device info, 0x05 event log |
| 5 (0x05) | 1 | frame counter, incremented per frame; RS485 answers carry 0x00 [DSB] or 0x05 [MPP]; do not validate |
| 6 (0x06) | 293 | payload (section 6) |
| 299 (0x12B) | 1 | sum8 of bytes 0..298 |

### 3.3 ACK / ready frame (BMS to host)

`AA 55 90 EB C8 01 01 00 00 00 00 00 00 00 00 00 00 00 00 44`: command-frame layout with register 0xC8, length 1, value 1.
- Sent after each write command. [MPP] treats exactly these 20 bytes as success and anything else as failure.
- Sent after the 0x97 request; [AIO] waits for it ("BMS ready") before asking for cell info. Firmware 19.05 appends it directly to the device info frame ([AIO] test data).
- A write that arrives while the BMS is still answering a 0x96 request is acknowledged but not applied ([BM] `WRITE_SETTLE_S`), so the ACK does not prove success.

### 3.4 Reassembly (BLE notifications and RS485 trigger answers)

Recommended algorithm (combines [BM] `feed_frames`, [SY] `assemble`, [AIO] `_notification_handler`):

1. Append each notification to a byte buffer; cap it (for example 1024 bytes) and clear it on overflow.
2. Search for `55 AA EB 90`. Bytes before it are not part of a data frame: extract ACK frames from them (`AA 55 90 EB C8`, 20 bytes, valid sum8) and drop the rest (`AT\r\n`, Modbus ACKs, adapter echo).
3. If fewer than 300 bytes follow the header, wait. If no header is present, keep only the last 3 bytes (a header can be split across notifications).
4. Take the 300-byte window and accept it if byte 299 equals the sum8 of bytes 0..298, byte 4 is 0x01, 0x02, 0x03 or 0x05, and the header does not occur again inside the window. Emit it and remove the 300 bytes.
5. Otherwise drop the bytes up to the next header occurrence after offset 0 and continue with step 2. A lost notification splices two frames; consuming 300 bytes would also destroy the following good frame.
6. Never assume that a notification starts a frame. Bytes after byte 299 belong to the next item (ACK, AT text or the next frame).
7. sum8 lets 1 of 256 corrupted frames through. Check plausibility before using values: cell voltages 0.5–5 V, pack voltage close to the cell sum, |current| < 2000 A, temperatures −50–150 °C or the "absent" value, SOC ≤ 100, cell count 1–32 ([BM] `_status_frame_implausible`, `implausible_settings`, [DSB] `_cell_count_valid`).

[SY] uses a simpler scheme: clear the buffer when a notification starts with the header, decode as soon as 300 bytes are buffered (checksum always at byte 299, bytes 300..319 ignored). It loses frames when a notification straddles two frames.

### 3.5 4E57 frame (UART "GPS" port)

Big-endian. Layout from [JK4E57] 4.2 and [SY] jk_modbus.cpp:

| Offset | Length | Content |
|---|---|---|
| 0 | 2 | 4E 57 ("NW") |
| 2 | 2 | length L: number of bytes after the two start bytes, including this field and the checksum; frame size = L + 2 |
| 4 | 4 | BMS terminal number, 00 00 00 00 |
| 8 | 1 | command: 0x01 activate, 0x02 write, 0x03 read one data ID, 0x05 pair code (password), 0x06 read all |
| 9 | 1 | frame source: 0x00 BMS, 0x01 Bluetooth, 0x02 GPS, 0x03 PC |
| 10 | 1 | transport type: 0x00 request, 0x01 reply, 0x02 active upload |
| 11 | n | information field. Requests: data ID (0x00 for read all), for writes followed by the value. Replies: data ID and value pairs (section 6.6) |
| L − 7 | 4 | record number: high byte random, low 3 bytes a sequence number; send 00 00 00 00 |
| L − 3 | 1 | end marker 0x68 |
| L − 2 | 4 | checksum: 00 00, then the 16-bit sum (BE) of bytes 0 .. L − 3 |

[JK4E57] describes the checksum as 4 bytes whose high 2 bytes are reserved for a CRC that is not used. Implementations add bytes 0 .. L − 1 (the two zero bytes do not change the sum) and compare with bytes L .. L + 1 ([SY] `parse_jk_modbus_byte_`, [DSB] `read_serial_data_jkbms`, [BM] `crc16_jk`).

Example, read all: `4E 57 00 13 00 00 00 00 06 03 00 00 00 00 00 00 68 00 00 01 29` (L = 0x13, 21 bytes, sum of bytes 0..16 = 0x0129).

Reassembly: wait for 4E 57, read L, collect L + 2 bytes, check the 0x68 at L − 3 and the checksum. [SY] resets the buffer after 50 ms of silence.

### 3.6 JK-PB RS485 frames

#### 3.6.1 Register addressing

Register numbers are byte offsets, not word indexes: the 4-byte "smart sleep voltage" is register 0x1000 and the next value (cell UVP) is 0x1004 ([SY] esp32-jk-pb-modbus-example.yaml header comment, [JKMB] index column, [TX] number/__init__.py). Reading N registers returns 2N bytes starting at that byte offset.

| Base | Content | Relation to the 300-byte frames |
|---|---|---|
| 0x1000 | settings, RW | settings frame offset = register − 0x1000 + 6 |
| 0x1200 | live data, R | JK02_32S cell info offset = register − 0x1200 + 6 |
| 0x1400 | device information and communication settings, R and RW | device info offset = register − 0x1400 + 6 |
| 0x1600 | calibration and control, W | none; also holds the trigger registers 0x161C, 0x161E, 0x1620 |

Sources: [JKMB], [DSB] JKBMS-PB.md ("payload offset = official register byte offset + 6"), checked here against the captured frames.

#### 3.6.2 Standard Modbus RTU (FC 0x03, FC 0x10)

- Read: `addr 03 regHi regLo countHi countLo crcLo crcHi`, answer `addr 03 byteCount data... crcLo crcHi`.
- Write: `addr 10 regHi regLo countHi countLo byteCount data... crcLo crcHi`, answer `addr 10 regHi regLo countHi countLo crcLo crcHi`. A 32-bit value is 2 registers, 4 bytes, BE ([TX] captures, [SY] yaml `U_DWORD`).
- Exception answer `addr (fn | 0x80) code crcLo crcHi`, e.g. `02 90 03 FC 01` (illegal data value) after a refused write ([TX] number/__init__.py capture comment).
- FC 0x03 values are BE ([DSB] JKBMS-PB.md, [SY] yaml). When two 8-bit fields share a register, the field with the lower frame offset is the high byte: 0x12C0 holds charge MOS (high) and discharge MOS (low), 0x12A6 balancing state (high) and SOC (low), 0x12B8 SOH (first byte) ([SY] yaml bitmasks and lambda). For 0x1504 (RCV time, RFV time) [SY] yaml reads RCV from the low byte while [TX] writes RCV into the high byte: **unverified**.
- Reliability ([DSB] JKBMS-PB.md, 4-pack bus): FC 0x03 honours addresses, accepts at most about 40 registers per read (128 failed), but slaves stop answering FC 0x03 a few seconds after the last FC 0x10 traffic and about half the reads failed even then. [DSB] therefore uses the trigger protocol. [SY] polls a single pack with FC 0x03 (one request per value, 15 s interval).

#### 3.6.3 Trigger protocol (FC 0x10 trigger, 300-byte answer)

Request (11 bytes): `addr 10 16 xx 00 01 02 00 00 crcLo crcHi`, a write of one register with value 0:

| Register | Answer |
|---|---|
| 0x1620 | cell info frame, type 0x02 |
| 0x161E | settings frame, type 0x01 |
| 0x161C | device info frame, type 0x03 |

Sources: [DSB] jkbms_pb.py `command_status`, `command_settings`, `command_about`; [TX] jk_rs485_sniffer.cpp `send_request_to_slave`; [MPP] jkpb.py captures; [BM] jk_pb_uart.py.

Answer: the 300-byte frame of section 3.2 in JK02_32S layout, followed by the normal 8-byte FC 0x10 answer `addr 10 16 xx 00 01 crcLo crcHi` ([MPP] captures, 308 bytes). [DSB] saw one 0x00 byte before and one after the 8-byte ACK with its adapters and echo bytes in front. Read until 300 bytes after `55 AA EB 90` plus the ACK have arrived, check sum8 and the ACK (address, function, register, CRC). The 300-byte frame contains no bus address: [DSB] attributes it through the ACK address; [TX] uses S270 (DIP address) for settings frames and the first ACK byte (frame offset 300) for the other types.

## 4. Session flow

### 4.1 BLE (JK02_24S, JK02_32S, JK04)

1. Connect, find FFE0 and the FFE1 characteristics (section 2.1), start notifications.
2. Wait about 100 ms ([BM] `_q` sleeps 0.1 s before every request).
3. Send 0x97. The BMS answers with the device info frame (0x03); several firmwares also send the ACK frame. Timeouts in use: [BM] waits up to 12 s (`TIMEOUT`); [AIO] uses a quarter of the bleak connect timeout with up to 3 retries (`BaseBMS.TIMEOUT`, `MAX_RETRY`). [JKT] repeats 0x97 up to 5 times, 1 s apart, and notes that the device info request must come before the cell info request.
4. Select the variant from the software version (section 1.2).
5. Send 0x96. The BMS answers with one settings frame (0x01) and then streams cell info frames (0x02) without further requests ([SY] button comment, [BM] `connect`). JK-PB firmware sends the device info frame again after the settings frame [CAP].
6. Stream interval measured in official-app captures [CAP]: 0.43 s (JK-BD6A24S10P sw 8.0.6G, JK02_24S), 0.54 s (JK-PB, JK02_32S), about 0.5 s (JK-B2A16S sw 3.3.0, JK04).
7. Keep-alive: none needed while frames stream. If no 0x02 frame arrives for a few seconds, send 0x96 again ([SY] `update()` runs every 5 s and sends 0x96 only while no status frame has been received; [AIO] requests when no fresh frame is buffered). [SY] publishes at most one cell info frame per 2 s (`throttle`).
8. To re-read settings, send 0x96 again; each 0x96 produces a new settings frame. The official app sends 0x96 every few seconds while a settings page is open [CAP]; [BM] re-reads every 5 minutes.
9. Order: [SY], [AIO], [BM], [JKT] and the official app send 0x97 first. [DSB] jkbms_brn sends 0x96 first; a [SY] document states that streaming starts once both requests were sent.
10. The JK-PB app sends a time calibration write (register 0x6C, section 8.2) right after the first 0x96 [CAP].

### 4.2 Writing settings over BLE

1. Let at least 1 s pass after the last 0x96 request: a write during the settings answer is acknowledged but dropped ([BM] `WRITE_SETTLE_S`, measured on a JK-B2A8S30P fw 15.26).
2. Send the write frame and expect the ACK frame (section 3.3).
3. About 1 s later send 0x96 and compare the setting, and preferably all other settings, in the new settings frame ([BM] `READBACK_DELAY_S`, `_write_setting_locked`). Values without a read location (calibration, SOH, presets) cannot be verified.
4. After a switch write [BM] waits 0.2 s and discards its cached settings frame.

### 4.3 JK-PB over RS485

Trigger polling as a software master ([DSB] jkbms_pb.py, [TX] sniffer, [BM] jk_pb_uart.py):
- per pack: 0x161C once at start (device info), 0x161E at start and occasionally (settings; the cell count is needed to decode cell info), 0x1620 on every poll (cell info);
- at least 100–120 ms between requests (`COMMAND_GAP` 0.12 s in [DSB]; 50 ms produced cross-talk; the BMS master waits about 180 ms); the answer arrives 35–50 ms after the request; read timeout 0.5–1 s; one retry;
- the vendor tool reads 0x161C and 0x161E twice at start, then 0x1620 every 800 ms ([DSB] JKBMS-PB.md).

Sharing the bus ([DSB] JKBMS-PB.md, [TX] README and sniffer):
- With a BMS master (DIP address 0) on RS485-2, the master runs a fixed cycle of about 4.4 s: for each known slave 0x1620 then 0x161E (about 260 ms per slave), a scan of addresses 4–15 with 0x1620 (220 ms timeout each), and its own status and settings frames sent without a request. The master never sends 0x161C.
- A client on such a bus can listen to every answer (attributed by ACK address, or by S270 for settings frames) and must transmit only in silent gaps. [TX] waits for 250 ms of silence before transmitting and acts as master itself after 2 s without master traffic. According to [TX] the BMS master does not answer a 0x161C request.
- Without a BMS master (all packs on 1–15) the client is the master; the bus is silent until it polls.

Standard Modbus with a single pack (address 1–15, never 0, [SY] yaml): FC 0x03 reads of the needed values, for example every 15 s; if the BMS stops answering, interleave FC 0x10 triggers (section 3.6.2).

### 4.4 4E57 over UART

- Send "read all" (command 0x06) every 1–5 s ([SY] every 5 s). The reply (command 0x06, source 0x00, type 0x01) lists all data IDs (section 6.6). Command 0x03 with ID 0x00 is answered with all IDs too ([MPP] jkserial.py capture).
- Writes ([SY] `write_register`): pair-code command 0x05, wait 150 ms, then command 0x02 with data ID and value. MOSFET switch writes are reported to work without the pair code ([JD]).
- A sleeping BMS has to be woken with the activation command 0x01 first ([JK4E57] 4.2.4; frame contents **unverified**).

## 5. Commands

All frames are complete, checksums included. "computed" = built with the documented layout, not copied from a capture.

### 5.1 BLE requests and buttons

| Purpose | Variant | Frame | Source |
|---|---|---|---|
| device info request | all | `AA 55 90 EB 97 00 00 00 00 00 00 00 00 00 00 00 00 00 00 11` | [JKT] getInfo, [MPP] jkabstractprotocol comment |
| settings request, starts the cell info stream | all | `AA 55 90 EB 96 00 00 00 00 00 00 00 00 00 00 00 00 00 00 10` | [JKT] getCellInfo, [MPP] test |
| event log request (answer type 0x05) | JK02_32S | `AA 55 90 EB A1 00 00 00 00 00 00 00 00 00 00 00 00 00 00 1B` | [SY] button 0xA1, computed |
| shutdown | JK02_32S | `AA 55 90 EB 65 00 00 00 00 00 00 00 00 00 00 00 00 00 00 DF` | [SY] button, computed |
| restart | JK02_32S | `AA 55 90 EB 66 00 00 00 00 00 00 00 00 00 00 00 00 00 00 E0` | [SY] button, computed |
| factory reset | JK02_32S | `AA 55 90 EB 9D 00 00 00 00 00 00 00 00 00 00 00 00 00 00 17` | [SY] button, computed |
| load Li-ion preset | JK02_32S | `AA 55 90 EB 68 00 00 00 00 00 00 00 00 00 00 00 00 00 00 E2` | [SY] select, computed |
| load LiFePO4 preset | JK02_32S | `AA 55 90 EB 69 00 00 00 00 00 00 00 00 00 00 00 00 00 00 E3` | [SY] select, computed |
| load LTO preset | JK02_32S | `AA 55 90 EB 6A 00 00 00 00 00 00 00 00 00 00 00 00 00 00 E4` | [SY] select, computed |

### 5.2 BLE writes (examples; all registers in sections 7 and 8)

| Purpose | Variant | Frame | Source |
|---|---|---|---|
| charge MOSFET on | JK02 | `AA 55 90 EB 1D 04 01 00 00 00 00 00 00 00 00 00 00 00 00 9C` | [MPP] test_set_charging_on |
| charge MOSFET off | JK02 | `AA 55 90 EB 1D 04 00 00 00 00 00 00 00 00 00 00 00 00 00 9B` | [MPP] test |
| discharge MOSFET on | JK02 | `AA 55 90 EB 1E 04 01 00 00 00 00 00 00 00 00 00 00 00 00 9D` | [MPP] test |
| discharge MOSFET off | JK02 | `AA 55 90 EB 1E 04 00 00 00 00 00 00 00 00 00 00 00 00 00 9C` | [MPP] test |
| balancer on | JK02 | `AA 55 90 EB 1F 04 01 00 00 00 00 00 00 00 00 00 00 00 00 9E` | [SY] switch, computed |
| balancer off | JK02 | `AA 55 90 EB 1F 04 00 00 00 00 00 00 00 00 00 00 00 00 00 9D` | [SY] switch, computed |
| cell OVP 3.650 V | JK02 | `AA 55 90 EB 04 04 42 0E 00 00 00 00 00 00 00 00 00 00 00 D2` | [MPP] test_set_cell_ovp |
| cell OVPR 3.400 V | JK02 | `AA 55 90 EB 05 04 48 0D 00 00 00 00 00 00 00 00 00 00 00 D8` | computed |
| cell UVP 2.600 V | JK02 | `AA 55 90 EB 02 04 28 0A 00 00 00 00 00 00 00 00 00 00 00 B2` | computed |
| cell UVPR 2.800 V | JK02 | `AA 55 90 EB 03 04 F0 0A 00 00 00 00 00 00 00 00 00 00 00 7B` | computed |
| smart sleep voltage 3.286 V | JK02_32S | `AA 55 90 EB 01 04 D6 0C 00 00 00 00 00 00 00 00 00 00 00 61` | [BM] test_encode (value bytes), computed |
| max charge current 100.000 A | JK02 | `AA 55 90 EB 0C 04 A0 86 01 00 00 00 00 00 00 00 00 00 00 B1` | computed |
| charge UTP −5.0 °C | JK02 | `AA 55 90 EB 18 04 CE FF FF FF 00 00 00 00 00 00 00 00 00 61` | [BM] test_encode_negative_temp (value bytes) |
| nominal capacity 280.000 Ah | JK02 | `AA 55 90 EB 20 04 C0 45 04 00 00 00 00 00 00 00 00 00 00 A7` | computed |
| cell count 16 | JK02 | `AA 55 90 EB 1C 04 10 00 00 00 00 00 00 00 00 00 00 00 00 AA` | computed |
| SCP delay 1500 µs | JK02_32S | `AA 55 90 EB 21 04 DC 05 00 00 00 00 00 00 00 00 00 00 00 80` | computed |
| SCP delay 1500 µs | JK02_24S | `AA 55 90 EB 25 04 DC 05 00 00 00 00 00 00 00 00 00 00 00 84` | computed |
| balance start 3.400 V | JK02_32S | `AA 55 90 EB 22 04 48 0D 00 00 00 00 00 00 00 00 00 00 00 F5` | computed |
| balance start 2.500 V | JK02_24S | `AA 55 90 EB 26 04 C4 09 00 00 00 00 00 00 00 00 00 00 00 71` | computed ([MPP] test sends the same value with app filler, checksum FA) |
| precharge time 4 s | JK02_32S | `AA 55 90 EB 25 04 04 00 00 00 00 00 00 00 00 00 00 00 00 A7` | [CAP] value, computed |
| heating start 3 °C | JK02_32S | `AA 55 90 EB 37 01 03 00 00 00 00 00 00 00 00 00 00 00 00 B5` | [CAP] value, computed |
| heating stop 7 °C | JK02_32S | `AA 55 90 EB 38 01 07 00 00 00 00 00 00 00 00 00 00 00 00 BA` | [CAP] value, computed |
| smart sleep delay 23 h | JK02_32S | `AA 55 90 EB 39 01 17 00 00 00 00 00 00 00 00 00 00 00 00 CB` | [SY] test SmartSleepDelay23hFullFrame |
| discharge UTP −10 °C | JK02_32S | `AA 55 90 EB 3A 01 F6 00 00 00 00 00 00 00 00 00 00 00 00 AB` | computed |
| discharge UTPR −5 °C | JK02_32S | `AA 55 90 EB 3B 01 FB 00 00 00 00 00 00 00 00 00 00 00 00 B1` | computed |
| voltage calibration 15.000 V | JK02_32S | `AA 55 90 EB 64 04 98 3A 00 00 00 00 00 00 00 00 00 00 00 B4` | [SY] number comment, computed |
| current calibration 2.000 A | JK02_32S | `AA 55 90 EB 67 04 D0 07 00 00 00 00 00 00 00 00 00 00 00 BC` | computed |
| voltage calibration 53.570 V | JK02_24S | `AA 55 90 EB 21 04 42 D1 00 00 00 00 00 00 00 00 00 00 00 B2` | [SY] number comment, computed |
| current calibration 0.100 A | JK02_24S | `AA 55 90 EB 24 04 64 00 00 00 00 00 00 00 00 00 00 00 00 06` | computed |
| SOC calibration 58 % | JK02_32S | `AA 55 90 EB 6E 01 3A 00 00 00 00 00 00 00 00 00 00 00 00 23` | [SY] number comment, computed |
| SOH calibration 93 % | JK02_32S | `AA 55 90 EB 6F 01 5D 00 00 00 00 00 00 00 00 00 00 00 00 47` | computed |
| RCV time 2.0 h | JK02_32S | `AA 55 90 EB B3 01 14 00 00 00 00 00 00 00 00 00 00 00 00 42` | computed |
| RFV time 9.0 h | JK02_32S | `AA 55 90 EB B4 01 5A 00 00 00 00 00 00 00 00 00 00 00 00 89` | computed |
| emergency duration 31 min | JK02_32S | `AA 55 90 EB B5 01 1F 00 00 00 00 00 00 00 00 00 00 00 00 4F` | [SY] test EmergencyDuration31minFullFrame |
| re-bulk SOC 0 % | JK02_32S | `AA 55 90 EB B7 01 00 00 00 00 00 00 00 00 00 00 00 00 00 32` | computed |
| UART1 protocol index 1 | JK02_32S | `AA 55 90 EB A5 02 01 00 00 00 00 00 00 00 00 00 00 00 00 22` | [SY] test Uart1Proto1FullFrame |
| UART2 protocol index 1 | JK02_32S | `AA 55 90 EB A8 02 01 00 00 00 00 00 00 00 00 00 00 00 00 25` | computed |
| UART3 protocol index 1 | JK02_32S | `AA 55 90 EB B6 02 01 00 00 00 00 00 00 00 00 00 00 00 00 33` | [SY] test comment |
| CAN protocol index 2 | JK02_32S | `AA 55 90 EB A6 02 02 00 00 00 00 00 00 00 00 00 00 00 00 24` | [SY] test CanProto2IsPylon |
| LCD buzzer trigger index 1 | JK02_32S | `AA 55 90 EB A9 02 01 00 00 00 00 00 00 00 00 00 00 00 00 26` | computed |
| DRY1 trigger index 1 | JK02_32S | `AA 55 90 EB AA 02 01 00 00 00 00 00 00 00 00 00 00 00 00 27` | [SY] test comment |
| DRY2 trigger index 1 | JK02_32S | `AA 55 90 EB AB 02 01 00 00 00 00 00 00 00 00 00 00 00 00 28` | [SY] test comment |
| port mode RS485 | JK02_32S | `AA 55 90 EB 2A 04 01 00 00 00 00 00 00 00 00 00 00 00 00 A9` | [SY] test MultiplexedPortModeRs485FullFrame |
| heating switch on | JK02_32S | `AA 55 90 EB 27 04 01 00 00 00 00 00 00 00 00 00 00 00 00 A6` | computed |
| emergency on | JK02_32S | `AA 55 90 EB 6B 04 01 00 00 00 00 00 00 00 00 00 00 00 00 EA` | computed |
| emergency off | JK02_32S | `AA 55 90 EB 6B 04 00 00 00 00 00 00 00 00 00 00 00 00 00 E9` | computed |
| user private data "0123456789012" | JK02_24S | `AA 55 90 EB 9F 0D 30 31 32 33 34 35 36 37 38 39 30 31 32 C6` | [SY] number comment (from [MPP] issue 170) |
| power off voltage 3.2 V | JK04 | `AA 55 90 EB 20 04 CD CC 4C 40 00 00 00 00 00 00 00 00 00 C3` | [SY] test Float32PowerOffVoltage |
| balance trigger 0.008 V | JK04 | `AA 55 90 EB 64 04 6F 12 03 3C 00 00 00 00 00 00 00 00 00 A2` | [SY] test BalanceTrigger8mV |
| max balance current 4.5 A | JK04 | `AA 55 90 EB 68 04 00 00 90 40 00 00 00 00 00 00 00 00 00 B6` | [SY] test MaxBalanceCurrent4p5A |
| balance start 4.25 V | JK04 | `AA 55 90 EB 58 04 00 00 88 40 00 00 00 00 00 00 00 00 00 9E` | computed |
| cell count 16 (u16) | JK04 | `AA 55 90 EB 1C 02 10 00 00 00 00 00 00 00 00 00 00 00 00 A8` | [SY] test CellCount16 |
| balancer on | JK04 | `AA 55 90 EB 6C 01 01 00 00 00 00 00 00 00 00 00 00 00 00 E8` | [SY] test BalancerOn |
| balancer off | JK04 | `AA 55 90 EB 6C 01 00 00 00 00 00 00 00 00 00 00 00 00 00 E7` | [SY] test BalancerOff |

### 5.3 JK-PB RS485

| Purpose | Frame | Source |
|---|---|---|
| address 1, trigger device info (type 0x03) | `01 10 16 1C 00 01 02 00 00 D3 CD` | [MPP] jkpb.py capture |
| address 1, trigger settings (type 0x01) | `01 10 16 1E 00 01 02 00 00 D2 2F` | [MPP] capture |
| address 1, trigger cell info (type 0x02) | `01 10 16 20 00 01 02 00 00 D6 F1` | [MPP] capture |
| address 2, trigger device info | `02 10 16 1C 00 01 02 00 00 C7 3D` | computed |
| address 2, trigger settings | `02 10 16 1E 00 01 02 00 00 C6 DF` | computed |
| address 2, trigger cell info | `02 10 16 20 00 01 02 00 00 C2 01` | computed |
| FC 0x03, address 1, cells 1..10 (20 bytes at 0x1200) | `01 03 12 00 00 0A C0 B5` | [DSB] JKBMS-PB.md (CRC computed) |
| FC 0x03, address 1, model string (16 bytes at 0x1400) | `01 03 14 00 00 08 41 FC` | computed |
| FC 0x10, address 2, balancer off (0x1078 = 0) | `02 10 10 78 00 02 04 00 00 00 00 37 A9` | [TX] capture |
| FC 0x10, address 2, balancer on | `02 10 10 78 00 02 04 00 00 00 01 F6 69` | [TX] capture |
| FC 0x10, address 2, smart sleep 3.500 V (0x1000) | `02 10 10 00 00 02 04 00 00 0D AC 35 C6` | [TX] capture |
| FC 0x10, address 2, balance start 3.440 V (0x1084) | `02 10 10 84 00 02 04 00 00 0D 70 3D CC` | [TX] capture |
| FC 0x10, address 2, charge OCP delay 3 s (0x1030) | `02 10 10 30 00 02 04 00 00 00 03 72 3E` | [TX] capture |
| FC 0x10, address 2, max discharge current 1.100 A (0x1038) | `02 10 10 38 00 02 04 00 00 04 4C 30 AC` | [TX] capture |
| FC 0x10, address 2, controls word 0x0210 (0x1114) | `02 10 11 14 00 01 02 02 10 B0 19` | [TX] capture |
| FC 0x10, address 1, cell OVP 3.650 V (0x100C) | `01 10 10 0C 00 02 04 00 00 0E 42 BA 6B` | computed |
| FC 0x10, address 1, charge MOS off (0x1070) | `01 10 10 70 00 02 04 00 00 00 00 39 4B` | computed |
| FC 0x10, address 1, charge MOS on | `01 10 10 70 00 02 04 00 00 00 01 F8 8B` | computed |
| FC 0x10, address 1, charge UTP −5.0 °C (0x105C) | `01 10 10 5C 00 02 04 FF FF FF CE FB 46` | computed |

### 5.4 4E57

| Purpose | Frame | Source |
|---|---|---|
| read all, source PC | `4E 57 00 13 00 00 00 00 06 03 00 00 00 00 00 00 68 00 00 01 29` | [SY] docs, [DSB] `command_status`, [VS] |
| read all, source GPS | `4E 57 00 13 00 00 00 00 06 02 00 00 00 00 00 00 68 00 00 01 28` | [SY] `read_registers`, computed |
| read one ID (0x85, SOC) | `4E 57 00 13 00 00 00 00 03 03 00 85 00 00 00 00 68 00 00 01 AB` | computed, **unverified** |
| charge MOSFET on (0xAB = 1) | `4E 57 00 14 00 00 00 00 02 03 02 AB 01 00 00 00 00 68 00 00 01 D4` | [JD], [VS] |
| charge MOSFET off | `4E 57 00 14 00 00 00 00 02 03 02 AB 00 00 00 00 00 68 00 00 01 D3` | [JD], [VS] |
| discharge MOSFET on (0xAC = 1) | `4E 57 00 14 00 00 00 00 02 03 02 AC 01 00 00 00 00 68 00 00 01 D5` | [JD], [VS] |
| discharge MOSFET off | `4E 57 00 14 00 00 00 00 02 03 02 AC 00 00 00 00 00 68 00 00 01 D4` | [JD], [VS] |
| balancer on (0x9D = 1) | `4E 57 00 14 00 00 00 00 02 03 02 9D 01 00 00 00 00 68 00 00 01 C6` | [VS] (checksum computed) |
| charge MOSFET on, esphome style (source GPS, type 0) | `4E 57 00 14 00 00 00 00 02 02 00 AB 01 00 00 00 00 68 00 00 01 D1` | [SY] `send`, computed |
| pair code, esphome style | `4E 57 00 14 00 00 00 00 05 02 00 00 00 00 00 00 00 68 00 00 01 28` | [SY] `authenticate_`, computed |
| cell OVP 3650 mV (2-byte ID 0x90) | `4E 57 00 15 00 00 00 00 02 03 02 90 0E 42 00 00 00 00 68 00 00 02 09` | computed from [JK4E57], **unverified** |
| capacity 280 Ah (4-byte ID 0xAA) | `4E 57 00 17 00 00 00 00 02 03 02 AA 00 00 01 18 00 00 00 00 68 00 00 01 EE` | computed from [JK4E57], **unverified** |
| restart (0xBB = 1) | `4E 57 00 14 00 00 00 00 02 03 02 BB 01 00 00 00 00 68 00 00 01 E4` | computed from [JK4E57], **unverified** |

## 6. Responses

### 6.1 Cell info frame (type 0x02), JK02_24S and JK02_32S

Layout rule ([SY] `decode_jk02_cell_info_`, [AIO] `_FIELDS` "JK02_24S has offset −32"): cell voltages start at 6 in both layouts; the block from the cell mask to the last resistance is 16 bytes later on JK02_32S; every field from byte 112 (24S) onwards is 32 bytes later on JK02_32S. Exceptions: the MOSFET temperature (24S at 134, 32S at 144) and the error bitmask (24S u16 at 136, 32S u32 at 166).

| 24S | 32S | Len | Type | Scale | Field | Notes and sources |
|---|---|---|---|---|---|---|
| 0 (0x00) | 0 (0x00) | 4 | bytes | | header 55 AA EB 90 | |
| 4 (0x04) | 4 (0x04) | 1 | u8 | | frame type 0x02 | |
| 5 (0x05) | 5 (0x05) | 1 | u8 | | frame counter | |
| 6 (0x06) | 6 (0x06) | 2 per cell | u16 | 0.001 V | `cellVoltages[n]` at 6 + 2n; 24 slots (6..53) or 32 slots (6..69); 0 = no cell | [SY], [AIO], [BM], [MPP], [JKT], [DSB] |
| 54 (0x36) | 70 (0x46) | 4 | u32 bitmask | | `enabledCellsMask`: bit n set = cell n+1 connected; number of set bits = `cellCount` | [SY], [AIO]; e.g. FF FF 00 00 = 16 cells |
| 58 (0x3A) | 74 (0x4A) | 2 | u16 | 0.001 V | `cellVoltageAverage` | [SY], [MPP], [DSB], [JKMB] CellVolAve |
| 60 (0x3C) | 76 (0x4C) | 2 | u16 | 0.001 V | `cellVoltageDelta` (max − min) | [AIO], [MPP], [DSB], [JKMB] CellVdifMax |
| 62 (0x3E) | 78 (0x4E) | 1 | u8 | | `cellVoltageMaxIndex`, 0-based | [JKMB] MaxVolCellNbr; did not always match the voltages in the same frame, compute locally |
| 63 (0x3F) | 79 (0x4F) | 1 | u8 | | `cellVoltageMinIndex`, 0-based | [JKMB] MinVolCellNbr |
| 64 (0x40) | 80 (0x50) | 2 per cell | u16 | 0.001 Ω | `cellResistances[n]` (balance lead resistance) at 64/80 + 2n | [SY], [MPP], [JKT], [JKMB] CellWireRes |
| 112 (0x70) | | 2 | u16 | | unknown, 0 in all 24S captures | [SY] Unknown112 |
| | 144 (0x90) | 2 | i16 | 0.1 °C | `temperatureMos` | [SY], [AIO], [DSB], [BM], [JKMB] TempMos |
| 114 (0x72) | 146 (0x92) | 4 | u32 bitmask | | `wireResistanceWarningMask`, one bit per cell lead | [SY], [JKMB] CellWireResSta |
| 118 (0x76) | 150 (0x96) | 4 | u32 | 0.001 V | `totalVoltage` | all |
| 122 (0x7A) | 154 (0x9A) | 4 | u32 | 0.001 W | `powerRaw`: magnitude without sign (positive in charge and discharge captures) | [SY], [MPP], [JKMB] BatWatt; for signed power use `totalVoltage × current` ([SY]) |
| 126 (0x7E) | 158 (0x9E) | 4 | i32 | 0.001 A | `current`, positive = charging | all; [BM] reports it with inverted sign |
| 130 (0x82) | 162 (0xA2) | 2 | i16 | 0.1 °C | `temperature1`; raw −2000 (0xF830) = sensor absent | [SY], [AIO], [BM], [MPP] capture |
| 132 (0x84) | 164 (0xA4) | 2 | i16 | 0.1 °C | `temperature2` | same |
| 134 (0x86) | | 2 | i16 | 0.1 °C | `temperatureMos` (24S only) | [SY], [AIO], [MPP], [JKT] |
| 136 (0x88) | | 2 | u16 bitmask | | `errorsBitmask`, bits 0–15 (section 9.1) | [SY], [AIO] |
| | 166 (0xA6) | 4 | u32 bitmask | | `errorsBitmask`, bits 0–31 (section 9.1) | [SY], [AIO], [DSB], [JKMB] alarm register |
| 138 (0x8A) | 170 (0xAA) | 2 | i16 | 0.001 A | `balanceCurrent`: positive with the charging balancer, negative with the discharging balancer | [SY], [AIO], [MPP]; sign seen in captures |
| 140 (0x8C) | 172 (0xAC) | 1 | u8 | | `balancingAction`: 0 off, 1 charging balancer, 2 discharging balancer | [SY], [JKMB] BalanSta; [AIO] `balancing` = value ≠ 0 |
| 141 (0x8D) | 173 (0xAD) | 1 | u8 | % | `soc` | all |
| 142 (0x8E) | 174 (0xAE) | 4 | i32 | 0.001 Ah | `capacityRemaining` | [SY], [AIO], [DSB], [MPP], [JKMB] SOCCapRemain INT32 |
| 146 (0x92) | 178 (0xB2) | 4 | u32 | 0.001 Ah | `fullChargeCapacity` | [SY], [AIO], [MPP]. On firmware ≥ 11 this is a capacity the BMS learns (251.235 Ah on a pack configured to 320 Ah with SOH 79 %); the configured capacity is S130 ([BM] issue 365) |
| 150 (0x96) | 182 (0xB6) | 4 | u32 | | `cycleCount` | all |
| 154 (0x9A) | 186 (0xBA) | 4 | u32 | 0.001 Ah | `totalCycleCapacity` (cumulative charge throughput) | [SY], [MPP], [JKMB] SOCCycleCap |
| 158 (0x9E) | 190 (0xBE) | 1 | u8 | % | `soh` | [SY], [AIO], [DSB] |
| 159 (0x9F) | 191 (0xBF) | 1 | u8 | | `precharging` (0, 1) | [SY], [JKMB] Precharge |
| 160 (0xA0) | 192 (0xC0) | 2 | u16 | | `userAlarm`, raw, meaning unknown | [SY], [JKMB] UserAlarm |
| 162 (0xA2) | 194 (0xC2) | 4 | u32 | s | `totalRuntime` | [SY], [MPP], [JKMB] RunTime |
| 166 (0xA6) | 198 (0xC6) | 1 | u8 | | `chargingMos` (0, 1) | [SY], [AIO], [DSB], [JKMB] |
| 167 (0xA7) | 199 (0xC7) | 1 | u8 | | `dischargingMos` (0, 1) | same |
| 168 (0xA8) | 200 (0xC8) | 1 | u8 | | `prechargingMos` (0, 1) | [SY]; [JKMB] lists a u16 "UserAlarm2" at 200..201 instead, **unverified** |
| 169 (0xA9) | 201 (0xC9) | 1 | u8 | | `balancerWorking` (0, 1) | [SY], logged only; see previous row |
| 170 (0xAA) | 202 (0xCA) | 2 | u16 | s | discharge overcurrent release countdown | [SY], [JKMB] TimeDcOCPR |
| 172 (0xAC) | 204 (0xCC) | 2 | u16 | s | discharge short-circuit release countdown | [JKMB] TimeDcSCPR |
| 174 (0xAE) | 206 (0xCE) | 2 | u16 | s | charge overcurrent release countdown | [JKMB] TimeCOCPR |
| 176 (0xB0) | 208 (0xD0) | 2 | u16 | s | charge short-circuit release countdown | [JKMB] TimeCSCPR |
| 178 (0xB2) | 210 (0xD2) | 2 | u16 | s | undervoltage release countdown | [JKMB] TimeUVPR |
| 180 (0xB4) | 212 (0xD4) | 2 | u16 | s | overvoltage release countdown | [JKMB] TimeOVPR |
| 182 (0xB6) | 214 (0xD6) | 1 | u8 bitmask | | `temperatureSensorMask` (section 9.4) | [SY], [AIO], [DSB] |
| 183 (0xB7) | 215 (0xD7) | 1 | u8 | | `heating` (0, 1) | [SY], [AIO], [DSB] |
| 184 (0xB8) | 216 (0xD8) | 2 | | | reserved | [JKMB] |
| 186 (0xBA) | 218 (0xDA) | 2 | u16 | s | `emergencyTimeCountdown`; > 0 while emergency mode is active | [SY], [JKMB] TimeEmergency |
| 188 (0xBC) | 220 (0xDC) | 2 | u16 | | `dischargeCurrentCorrection` | [SY], [JKMB] BatDisCurCorrect |
| 190 (0xBE) | 222 (0xDE) | 2 | u16 | 0.001 V | `chargeCurrentSensorVoltage` | [SY], [JKMB] VolChargCur |
| 192 (0xC0) | 224 (0xE0) | 2 | u16 | 0.001 V | `dischargeCurrentSensorVoltage` | [SY], [JKMB] VolDischargCur |
| 194 (0xC2) | 226 (0xE2) | 4 | f32 | | `batteryVoltageCorrection` (about 3.0 in all captures) | [JKMB] BatVolCorrect FLOAT; [SY] logs it as an integer |
| | 230 (0xE6) | 2 | u16 | % | PWM charge duty cycle | [JKMB] V1.0 only, **unverified** |
| | 232 (0xE8) | 2 | u16 | % | PWM discharge duty cycle | [JKMB] V1.0 only, **unverified** |
| 202 (0xCA) | 234 (0xEA) | 2 | u16 | 0.01 V | `totalVoltage2` (32S) | [SY], [JKMB] BatVol; on 24S see the next row |
| 204 (0xCC) | 236 (0xEC) | 2 | i16 | 0.001 A | `heatingCurrent` (32S) | [SY] (i16), [AIO] (signed), [DSB] (u16). On 24S, bytes 202..205 are one i32 of unknown meaning (six captures read 1250, 1250, 1250, 2221, -457, -251), so bytes 204..205 are only its sign extension (00 00 or FF FF). ubms decodes neither slot on 24S; [SY] and [AIO] apply the 32S offset minus 32 there. |
| | 244 (0xF4) | 1 | | | reserved | [JKMB] RVD |
| | 245 (0xF5) | 1 | u8 | | `chargerPlugged` (0, 1) | [SY], [JKMB] ChargerPlugged |
| | 246 (0xF6) | 4 | u32 | 0.1 s | `sysRunTicks` | [JKMB] SysRunTicks, **unverified** |
| | 250 (0xFA) | 4 | u32 | s | PVD trigger timestamp | [JKMB] V1.0, **unverified** |
| | 254 (0xFE) | 2 | i16 | 0.1 °C | `temperature3` | [JKMB] TempBat3, [AIO], [BM]. Equals the MOSFET temperature on several units ([DSB] doc, [AIO] v11.48 and [SY] v19 captures) |
| | 256 (0x100) | 2 | i16 | 0.1 °C | `temperature4` | [JKMB] TempBat4, [AIO], [DSB], [BM] |
| | 258 (0x102) | 2 | i16 | 0.1 °C | `temperature5` | [JKMB] TempBat5, [AIO], [DSB], [BM] |
| | 262 (0x106) | 4 | u32 | s | `rtcTicks`; values match seconds since 2020-01-01 00:00 | [JKMB] RTCTicks; time base inferred from captures, **unverified** |
| | 266 (0x10A) | 4 | u32 | | `detailLogCount` | [SY] |
| | 270 (0x10E) | 4 | u32 | s | `timeEnterSleep` (smart sleep countdown) | [SY], [JKMB] TimeEnterSleep |
| | 274 (0x112) | 1 | u8 | | `pclModuleState` | [SY], [JKMB] PCLModuleSta |
| | 275 (0x113) | 1 | u8 | | `batteryType`: 0 LFP, 1 Li-ion, 2 LTO | [SY] |
| | 278 (0x116) | 2 | u16 | s | `chargeStatusTime` (time in the current charge stage) | [SY] |
| | 280 (0x118) | 1 | u8 | | `chargeStatus`: 0 bulk, 1 absorption, 2 float | [SY], [AIO] (read from firmware 15) |
| | 281 (0x119) | 1 | u8 bitmask | | `dryContactMask`: bit 1 DRY1 active, bit 2 DRY2 active | [SY] |
| 299 (0x12B) | 299 (0x12B) | 1 | u8 | | sum8 of bytes 0..298 | |

Unknown ranges: 24S 198..203, 206..298; 32S 238..243, 282..298 (constant-looking bytes).

Derived values used in the test vectors: `cellVoltageMin`, `cellVoltageMax` and their 1-based positions `cellVoltageMinNumber`, `cellVoltageMaxNumber` computed over the first `cellCount` cells with non-zero voltage ([SY] takes the first occurrence); `cellVoltageDeltaDerived` = `cellVoltageMax` − `cellVoltageMin` and `cellVoltageAverageDerived` = mean of those cells (what [SY] publishes; the frame fields `cellVoltageDelta` and `cellVoltageAverage` can differ by a few mV because the BMS samples them separately); `power` = `totalVoltage` × `current`; `balancing` = `balancingAction` ≠ 0 ([AIO]); `totalVoltage` for JK04 = sum of cell voltages.

### 6.2 Settings frame (type 0x01)

Same layout for both JK02 variants up to byte 141. All values LE. "BLE reg" is the write register (section 7 for lengths and ranges); "PB reg" the Modbus register on JK-PB.

| Offset | Len | Type | Scale | Field | BLE reg 32S / 24S | PB reg | Notes and sources |
|---|---|---|---|---|---|---|---|
| 0 (0x00) | 4 | bytes | | header | | | |
| 4 (0x04) | 1 | u8 | | frame type 0x01 | | | |
| 5 (0x05) | 1 | u8 | | frame counter | | | |
| 6 (0x06) | 4 | u32 | 0.001 V | `smartSleepVoltage` | 0x01 / 0x01 | 0x1000 | [SY], [BM], [DSB], [JKMB] VolSmartSleep; reads 600 on sw 10.07 (24S) and sw 11.26 (32S), 3285 to 3550 on sw 11.50 and later; meaning of 600 **unverified** |
| 10 (0x0A) | 4 | u32 | 0.001 V | `cellUvp` | 0x02 / 0x02 | 0x1004 | all |
| 14 (0x0E) | 4 | u32 | 0.001 V | `cellUvpr` | 0x03 / 0x03 | 0x1008 | |
| 18 (0x12) | 4 | u32 | 0.001 V | `cellOvp` | 0x04 / 0x04 | 0x100C | |
| 22 (0x16) | 4 | u32 | 0.001 V | `cellOvpr` | 0x05 / 0x05 | 0x1010 | |
| 26 (0x1A) | 4 | u32 | 0.001 V | `balanceTriggerVoltage` (delta that starts balancing) | 0x06 / 0x06 | 0x1014 | |
| 30 (0x1E) | 4 | u32 | 0.001 V | `cellSoc100Voltage` | 0x07 / 0x07 | 0x1018 | 0 on firmware without the feature |
| 34 (0x22) | 4 | u32 | 0.001 V | `cellSoc0Voltage` | 0x08 / 0x08 | 0x101C | |
| 38 (0x26) | 4 | u32 | 0.001 V | `cellRcv` (requested charge voltage) | 0x09 / 0x09 | 0x1020 | reads 0 on older firmware (hw 11A fw 11.54, fw 11.50, [BM]) |
| 42 (0x2A) | 4 | u32 | 0.001 V | `cellRfv` (requested float voltage) | 0x0A / 0x0A | 0x1024 | same |
| 46 (0x2E) | 4 | u32 | 0.001 V | `powerOffVoltage` | 0x0B / 0x0B | 0x1028 | [JKMB] VolSysPwrOff |
| 50 (0x32) | 4 | u32 | 0.001 A | `maxChargeCurrent` (charge overcurrent threshold) | 0x0C / 0x0C | 0x102C | [JKMB] CurBatCOC |
| 54 (0x36) | 4 | u32 | s | `chargeOcpDelay` | 0x0D / 0x0D | 0x1030 | |
| 58 (0x3A) | 4 | u32 | s | `chargeOcpRecoveryTime` | 0x0E / 0x0E | 0x1034 | |
| 62 (0x3E) | 4 | u32 | 0.001 A | `maxDischargeCurrent` | 0x0F / 0x0F | 0x1038 | [JKMB] CurBatDcOC |
| 66 (0x42) | 4 | u32 | s | `dischargeOcpDelay` | 0x10 / 0x10 | 0x103C | |
| 70 (0x46) | 4 | u32 | s | `dischargeOcpRecoveryTime` | 0x11 / 0x11 | 0x1040 | |
| 74 (0x4A) | 4 | u32 | s | `scpRecoveryTime` | 0x12 / 0x12 | 0x1044 | |
| 78 (0x4E) | 4 | u32 | 0.001 A | `maxBalanceCurrent` | 0x13 / 0x13 | 0x1048 | |
| 82 (0x52) | 4 | i32 | 0.1 °C | `chargeOtp` | 0x14 / 0x14 | 0x104C | |
| 86 (0x56) | 4 | i32 | 0.1 °C | `chargeOtpr` | 0x15 / 0x15 | 0x1050 | |
| 90 (0x5A) | 4 | i32 | 0.1 °C | `dischargeOtp` | 0x16 / 0x16 | 0x1054 | |
| 94 (0x5E) | 4 | i32 | 0.1 °C | `dischargeOtpr` | 0x17 / 0x17 | 0x1058 | |
| 98 (0x62) | 4 | i32 | 0.1 °C | `chargeUtp` | 0x18 / 0x18 | 0x105C | |
| 102 (0x66) | 4 | i32 | 0.1 °C | `chargeUtpr` | 0x19 / 0x19 | 0x1060 | |
| 106 (0x6A) | 4 | i32 | 0.1 °C | `mosOtp` | 0x1A / 0x1A | 0x1064 | |
| 110 (0x6E) | 4 | i32 | 0.1 °C | `mosOtpr` | 0x1B / 0x1B | 0x1068 | |
| 114 (0x72) | 4 | u32 | | `cellCount` | 0x1C / 0x1C | 0x106C | |
| 118 (0x76) | 4 | u32 | | `chargeSwitch` (0, 1) | 0x1D / 0x1D | 0x1070 | |
| 122 (0x7A) | 4 | u32 | | `dischargeSwitch` (0, 1) | 0x1E / 0x1E | 0x1074 | |
| 126 (0x7E) | 4 | u32 | | `balancerSwitch` (0, 1) | 0x1F / 0x1F | 0x1078 | |
| 130 (0x82) | 4 | u32 | 0.001 Ah | `nominalCapacity` (configured capacity) | 0x20 / 0x20 | 0x107C | |
| 134 (0x86) | 4 | u32 | µs | `scpDelay` | 0x21 / 0x25 | 0x1080 | captures: 1000 (sw 10.07), 1500 (sw 11.26, 11.50, 15.10), 5 (sw 15.26, 17.06, 19.04, 19.27, 20.19); unit on newer firmware **unverified** |
| 138 (0x8A) | 4 | u32 | 0.001 V | `balanceStartVoltage` | 0x22 / 0x26 | 0x1084 | |
| 142 (0x8E) | 16 | | | 24S only: unknown, 4 × u32, zero in captures | | | [SY] Unknown142..154 |
| 158 (0x9E) | 96 | u32 each | 0.001 Ω | 24S only: connection wire resistance cells 1–24 | 0x27..0x3E (24S) | | [SY]; unit **unverified** |
| 254 (0xFE) | 45 | | | 24S only: unused (zero in captures) | | | |
| 142 (0x8E) | 128 | u32 each | see note | 32S: connection wire resistance cells 1–32 | not known | 0x1088..0x1104 | [SY] scales 0.001 Ω, [JKMB] unit "u"; **unverified** |
| 270 (0x10E) | 4 | u32, first byte used | | `deviceAddress` (DIP switches) | read only | 0x1108 | 32S; [SY], [DSB], [TX] |
| 274 (0x112) | 4 | u32 | s | `prechargeTime` (pre-discharge time) | 0x25 (32S) | 0x110C | [SY], [CAP] write 4 s, [JKMB] TIMProdischarge |
| 278 (0x116) | 4 | | | unknown | | | |
| 282 (0x11A) | 2 | u16 bitmask | | `controlsBitmask` (section 9.5) | one register per bit (section 8.1) | 0x1114 | [SY], [DSB], [JKMB] |
| 284 (0x11C) | 1 | i8 | °C | `heatingStartTemperature` | 0x37, length 1 | 0x1116, high byte | [SY]; [CAP]: write 3, settings frame then reads 3 |
| 285 (0x11D) | 1 | i8 | °C | `heatingStopTemperature` | 0x38, length 1 | 0x1116, low byte | [CAP]: write 7, reads 7 |
| 286 (0x11E) | 1 | u8 | h | `smartSleepDelay` | 0x39, length 1 | 0x1118, high byte | [SY], [BM], [JKMB] TIMSmartSleep |
| 287 (0x11F) | 1 | u8 | | `dataFieldEnable0`, unknown flags (0xFE in a v19 capture) | | | [SY]; non-zero on 32S, used by [DSB] as 32S detector |
| 288 (0x120) | 8 | | | unknown | | | |
| 296 (0x128) | 1 | i8 | °C | `dischargeUtp` | 0x3A, length 1 | | [SY]; plausible in 3 captures (−10, −35, 0), write **unverified** by captures; ubms writes it since 2026-11-23 and checks the read-back |
| 297 (0x129) | 1 | i8 | °C | `dischargeUtpr` | 0x3B, length 1 | | same (−5, −30, 0) |
| 298 (0x12A) | 1 | | | unknown | | | |
| 299 (0x12B) | 1 | u8 | | sum8 | | | |

The byte order of the PB registers 0x1116 and 0x1118 follows the FC 0x03 rule of section 3.6.2 and is inferred (**unverified**).

Heating temperatures on JK-PB: hardware newer than 15A, or 15A with firmware ≥ 15.41, has dedicated start/stop temperatures (S284, S285); older units heat according to the charge UTP and UTPR ([DSB] `get_settings`). A fw 11.50 BMS reads 60/50 at S284/S285, values without meaning there ([BM] jk_settings.py note).

### 6.3 Device info frame (type 0x03)

Strings are ASCII, NUL padded, but a value may fill its field without a terminating NUL ([SY] test DeviceNameWithoutNullTerminator): limit each read to the field length.

| Offset | Len | Type | Field | Notes and sources |
|---|---|---|---|---|
| 6 (0x06) | 16 | ASCII | `model` (vendor ID), e.g. "JK_PB2A16S15P", "JK-B2A24S20P", "JK-B2A16S" | all |
| 22 (0x16) | 8 | ASCII | `hardwareVersion`, e.g. "10.XG", "14.XA", "15A", "19A", "3.0" | all |
| 30 (0x1E) | 8 | ASCII | `softwareVersion`, e.g. "10.07", "15.38", "19.27", "3.3.0", "8.0.3M" | all |
| 38 (0x26) | 4 | u32 | `uptime` in s | [SY], [MPP], [DSB], [JKMB] ODDRunTime |
| 42 (0x2A) | 4 | u32 | `powerOnCount` | [SY], [MPP], [JKMB] PWROnTimes |
| 46 (0x2E) | 16 | ASCII | `deviceName` (the BLE name) | [SY], [AIO]; [DSB] jkbms_pb calls it serial number |
| 62 (0x3E) | 16 | ASCII | `devicePasscode` (app connection passcode, default "1234") | [SY], [MPP]; readable by anyone in range ([BM]) |
| 78 (0x4E) | 8 | ASCII | `manufacturingDate`, 6 characters YYMMDD; empty on JK04 | [SY] (publishes "20" + YYMMDD), [DSB] |
| 86 (0x56) | 11 or 16 | ASCII | `serialNumber` | older firmware: 10 characters + NUL (11-byte field) followed by the passcode at 97; firmware 19: 15 characters running into 97..101. Read up to the first NUL, at most 16 bytes ([SY] reads 11, [AIO] 8, [DSB] 10) |
| 97 (0x61) | 5 | ASCII | `passcode` ("0000") on older firmware | [SY], [MPP] |
| 102 (0x66) | 16 | ASCII | `userData` (default "Input Userdata") | [SY], [DSB] |
| 118 (0x76) | 16 | ASCII | `setupPasscode` (settings password, default "123456") | [SY], [DSB] (called pin) |
| 134 (0x86) | 16 | ASCII | `userData2` (32S) | [DSB] |
| 150 (0x96) | 34 | | unknown (32S) | |
| 184 (0xB8) | 1 | u8 | `uart1Protocol` index (section 9.6) | [SY]; write 0xA5 |
| 185 (0xB9) | 1 | u8 | `canProtocol` index | [SY]; write 0xA6 |
| 186 (0xBA) | 16 | bitmask | protocols supported on UART1 | [JKMB] UART1MPRTOLEnable; [SY] reads the low 32 bits |
| 202 (0xCA) | 4 | u32 bitmask | protocols supported on CAN | [SY] |
| 206 (0xCE) | 12 | | unknown | |
| 218 (0xDA) | 1 | u8 | `uart2Protocol` index | [SY]; write 0xA8; a v19 unit reports 21, outside the known list |
| 219 (0xDB) | 4 | u32 bitmask | protocols supported on UART2 (low bits) | [SY] |
| 223 (0xDF) | 11 | | unknown | |
| 234 (0xEA) | 1 | u8 | `lcdBuzzerTrigger` index (section 9.6) | [SY]; write 0xA9 |
| 235 (0xEB) | 1 | u8 | `dry1Trigger` index | [SY]; write 0xAA |
| 236 (0xEC) | 1 | u8 | `dry2Trigger` index | [SY]; write 0xAB |
| 237 (0xED) | 1 | u8 | UART protocol library version | [SY], [JKMB] |
| 238 (0xEE) | 4 | i32 | `lcdBuzzerTriggerValue` | [SY], [JKMB]; write register not known |
| 242 (0xF2) | 4 | i32 | `lcdBuzzerReleaseValue` | same |
| 246 (0xF6) | 4 | i32 | `dry1TriggerValue` | same |
| 250 (0xFA) | 4 | i32 | `dry1ReleaseValue` | same |
| 254 (0xFE) | 4 | i32 | `dry2TriggerValue` | same |
| 258 (0x102) | 4 | i32 | `dry2ReleaseValue` | same |
| 262 (0x106) | 4 | u32 | `dataStoredPeriod` in s | [SY], [JKMB]; write register not known |
| 266 (0x10A) | 1 | u8 | `rcvTime`, 0.1 h | [SY], [JKMB] RCVTime; write 0xB3 |
| 267 (0x10B) | 1 | u8 | `rfvTime`, 0.1 h | [SY], [JKMB] RFVTime; write 0xB4 |
| 268 (0x10C) | 1 | u8 | CAN protocol library version | [SY], [JKMB] |
| 269 (0x10D) | 1 | u8 | `emergencyDuration` in min | [SY]; reserved in [JKMB] V1.1; write 0xB5 |
| 270 (0x10E) | 1 | u8 | `uart3Protocol` index | [SY]; write 0xB6 |
| 271 (0x10F) | 7 | bitmask | protocols supported on UART3 (56 bits; [SY] reads the low 32) | [SY] |
| 278 (0x116) | 1 | u8 | `reBulkSoc` in % | [SY]; write 0xB7 |
| 279 (0x117) | 20 | | unknown | |
| 299 (0x12B) | 1 | u8 | sum8 | |

JK02_24S and JK04 frames carry only the fields up to 133; their remaining bytes are zero in captures.

### 6.4 JK04 frames

All values LE; float32 unless stated. JK04 has no pack voltage, current, SOC or temperature fields ([BM] jk04.py). Same commands, header and checksum as JK02.

Cell info (type 0x02), [SY] `decode_jk04_cell_info_`, [BM] `decode_jk04_status`, [MPP] jk04.py:

| Offset | Len | Type | Field | Notes |
|---|---|---|---|---|
| 6 (0x06) | 4 per cell | f32, V | `cellVoltages[n]` at 6 + 4n, 24 slots; 0 = unused | |
| 102 (0x66) | 4 per cell | f32, Ω | `cellResistances[n]` at 102 + 4n, 25 slots ([SY], [MPP]) | |
| 202 (0xCA) | 4 | f32, V | `cellVoltageAverage` (own BMS value, not exactly the mean) | [SY], [BM], [MPP] |
| 206 (0xCE) | 4 | f32, V | `cellVoltageDelta` | |
| 210 (0xD2) | 4 | | unknown, 0 | [SY] |
| 214 (0xD6) | 4 | bitmask | cell mask (FF FF 00 00 for 16 cells, FF FF FF 00 for 24) | [SY], [BM] |
| 218 (0xDA) | 1 | u8 | `cellVoltageMaxIndex`, 0-based | [MPP] (+1 for display), [BM] |
| 219 (0xDB) | 1 | u8 | `cellVoltageMinIndex`, 0-based | |
| 220 (0xDC) | 1 | u8 | `balancingAction`: 0 idle, 1 charging balancer, 2 discharging balancer | [SY], [BM] |
| 221 (0xDD) | 1 | | unknown | |
| 222 (0xDE) | 4 | f32, A | `balanceCurrent`, negative with the discharging balancer | [SY], [BM] |
| 226 (0xE2) | 7 | | unknown, 0 | |
| 233 (0xE9) | 4 | f32 | unknown | [SY], [BM] |
| 237 (0xED) | 49 | | unknown | |
| 286 (0x11E) | 4 | u32, s | `totalRuntime` | [SY] (u32), [MPP] (3 bytes) |
| 290 (0x122) | 4 | | unknown, 0 | |
| 294 (0x126) | 4 | f32 | unknown | |
| 298 (0x12A) | 1 | | unknown | |
| 299 (0x12B) | 1 | u8 | sum8 | |

Settings (type 0x01), [SY] `decode_jk04_settings_`, [BM] `decode_jk04_settings`:

| Offset | Len | Type | Field | Write register |
|---|---|---|---|---|
| 6 (0x06) | 4 | f32 | unknown (1.0 in captures) | |
| 34 (0x22) | 1 | u8 | `cellCount` | 0x1C, length 2, u16 |
| 38 (0x26) | 4 | f32, V | `powerOffVoltage` | 0x20, float |
| 74 (0x4A) | 4 | f32, V | `voltageCalibration`: ADC reference, about 3.03; the app shows the resulting pack voltage instead | 0x44, float |
| 98 (0x62) | 4 | f32, V | `balanceStartVoltage` | 0x58, float (**unverified**: no capture shows the write, the register rule of the captured JK04 writes gives 0x5C, see [jk-balancer.md](jk-balancer.md) section 12 item 1; ubms keeps it read only) |
| 102 (0x66) | 4 | f32 | unknown (3.4 on both known devices) | |
| 106 (0x6A) | 4 | f32, V | `balanceTriggerVoltage` | 0x64, float |
| 110 (0x6E) | 4 | f32, A | `maxBalanceCurrent` | 0x68, float |
| 114 (0x72) | 1 | u8 | `balancerSwitch` | 0x6C, length 1 |

Device info (type 0x03): fields up to 133 as in section 6.3; manufacturing date and serial number are empty.

### 6.5 Event log frame (type 0x05)

Answer to command 0xA1 ([SY] `decode_logbook_`, tests/components/jk_bms_ble/frames_logbook.h):

| Offset | Len | Type | Field |
|---|---|---|---|
| 6 (0x06) | 4 | u32 | `logCount` |
| 10 (0x0A) | 1 | u8 | unknown (0x03 in the capture; "check" in the [SY] test comment) |
| 11 (0x0B) | 5 per entry, 50 entries | u32 + u8 | entry n at 11 + 5n: `seconds` (u32 LE), `code` (u8, section 9.7) |
| 261 (0x105) | 38 | | reserved |
| 299 (0x12B) | 1 | u8 | sum8 |

[SY] formats `seconds` as days, hours, minutes, seconds; whether it counts runtime or time since first start is **unverified**. How to read more than 50 entries is not known.

### 6.6 4E57 data IDs

A reply information field is a sequence of data ID and value. Every ID has a fixed width, except 0x79: a byte count n follows the ID, then n / 3 triplets of cell number (u8, 1-based) and voltage (u16 BE, mV). Sources: [JK4E57] table 5.1, [SY] docs/protocol-design-uart-ttl-gps-port.md and `on_status_data_`, [DSB] jkbms.py, [BM] jikong_uart.py `REGISTER_WIDTHS`, [MPP] jkserial.py.

| ID | Bytes | R/W | Type, unit | Field | Range and notes |
|---|---|---|---|---|---|
| 0x79 | 1 + n | R | see above | `cellVoltages` | n (the byte count) = 3 × number of cells |
| 0x80 | 2 | R | temperature code | `temperatureMos` | rule below |
| 0x81 | 2 | R | temperature code | `temperature1` (battery box) | |
| 0x82 | 2 | R | temperature code | `temperature2` (battery) | |
| 0x83 | 2 | R | u16, 0.01 V | `totalVoltage` | |
| 0x84 | 2 | R | special | `current` | rule below |
| 0x85 | 1 | R | u8, % | `soc` | |
| 0x86 | 1 | R | u8 | `temperatureSensorCount` | |
| 0x87 | 2 | R | u16 | `cycleCount` | |
| 0x89 | 4 | R | u32, Ah | `totalCycleCapacity` | |
| 0x8A | 2 | R | u16 | `cellCount` (number of strings) | |
| 0x8B | 2 | R | bitmask | `warnings` | section 9.2 |
| 0x8C | 2 | R | bitmask | `status` | section 9.3 |
| 0x8E | 2 | RW | u16, 0.01 V | `packOvp` | 10.00–150.00 V |
| 0x8F | 2 | RW | u16, 0.01 V | `packUvp` | 10.00–150.00 V |
| 0x90 | 2 | RW | u16, mV | `cellOvp` | 1000–4500 |
| 0x91 | 2 | RW | u16, mV | `cellOvpr` | 1000–4500 |
| 0x92 | 2 | RW | u16, s | `cellOvpDelay` | 1–60 |
| 0x93 | 2 | RW | u16, mV | `cellUvp` | 1000–4500 |
| 0x94 | 2 | RW | u16, mV | `cellUvpr` | 1000–4500 |
| 0x95 | 2 | RW | u16, s | `cellUvpDelay` | 1–60 |
| 0x96 | 2 | RW | u16, mV | `cellDeltaProtection` (cell difference protection) | 0–1000 |
| 0x97 | 2 | RW | u16, A | `dischargeOcp` | 1–1000 |
| 0x98 | 2 | RW | u16, s | `dischargeOcpDelay` | document 1–60, captures 3 and 300 |
| 0x99 | 2 | RW | u16, A | `chargeOcp` | 1–1000 |
| 0x9A | 2 | RW | u16, s | `chargeOcpDelay` | document 1–60, captures 5 and 30 |
| 0x9B | 2 | RW | u16, mV | `balanceStartVoltage` | 2000–4500 |
| 0x9C | 2 | RW | u16, mV | `balanceTriggerVoltage` | 10–1000 |
| 0x9D | 1 | RW | u8 | `balancerSwitch` | 0, 1; writes refused by firmware 11 ([SY] switch comment) |
| 0x9E | 2 | RW | u16, °C | `mosOtp` | 0–100 |
| 0x9F | 2 | RW | u16, °C | `mosOtpr` | 0–100 |
| 0xA0 | 2 | RW | u16, °C | `boxOtp` (battery box over temperature) | 40–100 |
| 0xA1 | 2 | RW | u16, °C | `boxOtpr` | 40–100 |
| 0xA2 | 2 | RW | u16, °C | `tempDiffProtection` | 5–20 |
| 0xA3 | 2 | RW | u16, °C | `chargeOtp` | 0–100 |
| 0xA4 | 2 | RW | u16, °C | `dischargeOtp` | 0–100 |
| 0xA5 | 2 | RW | i16, °C | `chargeUtp` | −45–25, signed (no offset) |
| 0xA6 | 2 | RW | i16, °C | `chargeUtpr` | −45–25 |
| 0xA7 | 2 | RW | i16, °C | `dischargeUtp` | −45–25 |
| 0xA8 | 2 | RW | i16, °C | `dischargeUtpr` | −45–25 |
| 0xA9 | 1 | RW | u8 | `cellCountSetting` | 3–32 |
| 0xAA | 4 | RW | u32, Ah | `capacitySetting` | |
| 0xAB | 1 | RW | u8 | `chargeSwitch` | 0, 1 |
| 0xAC | 1 | RW | u8 | `dischargeSwitch` | 0, 1 |
| 0xAD | 2 | RW | u16, mA | `currentCalibration` | 100–20000 |
| 0xAE | 1 | RW | u8 | `boardAddress` | reserved for cascading |
| 0xAF | 1 | RW | u8 | `batteryType` | 0 LiFePO4, 1 ternary (Li-ion), 2 LTO |
| 0xB0 | 2 | RW | u16, s | `sleepWaitTime` | |
| 0xB1 | 1 | RW | u8, % | `lowCapacityAlarm` | 0–80 |
| 0xB2 | 10 | RW | ASCII | `password` (parameter password) | e.g. "123456" |
| 0xB3 | 1 | RW | u8 | `dedicatedCharger` | 0, 1 |
| 0xB4 | 8 | RW | ASCII | `deviceId` | often "Input Us" (the default user data) |
| 0xB5 | 4 | RW | ASCII YYMM | `manufacturingDate` | e.g. "2101" |
| 0xB6 | 4 | RW | u32, min | `systemWorkingMinutes` | |
| 0xB7 | 15 | R | ASCII | `softwareVersion` | hardware and software, e.g. "H6.X__S6.1.3S__", "10.XW_S10.07___", "11.XW_S11.261__" |
| 0xB8 | 1 | RW | u8 | start current calibration | 1 start, 0 stop |
| 0xB9 | 4 | RW | u32, Ah | `actualCapacity` | firmware ≥ 10.10 ([SY] comment) |
| 0xBA | 24 | RW | ASCII | `manufacturerId` | e.g. "BT3072020120000200521001" or "Input UserdaJK-B2A24S15P" |
| 0xBB | 1 | W | u8 | restart | 1 |
| 0xBC | 1 | W | u8 | factory reset (base parameters) | 1 |
| 0xBD | 1 | W | u8 | remote upgrade flag | 1 |
| 0xBE | 2 | W | u16, mV | GPS power off below this cell voltage | |
| 0xBF | 2 | W | u16, mV | GPS power on above this cell voltage | |
| 0xC0 | 1 | R | u8 | `protocolVersion` | 0x01 changes the 0x84 format |

Replies list the IDs in the order of this table. 0x88 and 0x8D are not defined in [JK4E57]; neither they nor the write-only IDs 0xBB..0xBF appeared in captures. Parse by ID ([BM] `parse_tlv_body`) rather than by fixed position ([SY], [DSB] use positions relative to the cell block length). After the last ID come the 4-byte record number, 0x68 and the checksum.

Temperature codes (0x80..0x82): 0–140 represents −40–100 °C; 0–100 are that many °C, values above 100 are negative, 101 = −1 °C ([JK4E57]). This spec uses T = raw if raw ≤ 100, else 100 − raw. Implementations disagree: [SY] `get_temperature_` gives 99 − raw for raw > 99 (100 → −1), [DSB] gives 100 − raw for raw ≥ 99 (99 → 1), [VS] gives −(raw − 101) (101 → 0). No capture below 0 °C was available: **unverified**.

Current (0x84) when 0xC0 = 0x01: bit 15 set = charging, clear = discharging; magnitude = (raw & 0x7FFF) × 0.01 A; `current` = +magnitude when charging, −magnitude when discharging ([JK4E57], [SY] `get_current_`, [DSB], [MPP] jkserial). Example 0x80D0 = +2.08 A, 0x81C5 = +4.53 A, 0x0045 = −0.69 A. When 0xC0 is 0x00 or missing: `current` = (10000 − raw) × 0.01 A, positive = charging ([JK4E57]: raw 11000 = −10.00 A, raw 9500 = +5.00 A); [SY] returns 0 in that case. All captures have 0xC0 = 0x01.

Writes: information field = data ID followed by the value in the width of the table, BE. Only 1-byte writes (0xAB, 0xAC, 0x9D) are confirmed. [JD] quotes JK sales staff saying that newer boards (e.g. JK-B2A8S20P) accept only the MOSFET switches on this port; [SY] notes that firmware 11 refuses 0x9D. Multi-byte writes are **unverified**. The reply to a write is a 21-byte frame ([JD] code reads 21 bytes) whose byte 11 repeats the data ID ([VS] checks it).

### 6.7 JK-PB Modbus registers for live data and device info

Register = 0x1200 + (JK02_32S cell info offset − 6). Main registers ([JKMB], [SY] yaml):

| Register | Bytes | Content |
|---|---|---|
| 0x1200 + 2n | 2 | cell n+1 voltage, mV |
| 0x1240 | 4 | enabled cell mask |
| 0x1244 | 2 | average cell voltage, mV |
| 0x1246 | 2 | cell voltage delta, mV |
| 0x1248 | 1 + 1 | max cell index, min cell index |
| 0x124A + 2n | 2 | cell n+1 lead resistance, mΩ |
| 0x128A | 2 | MOSFET temperature, 0.1 °C |
| 0x128C | 4 | lead resistance warning mask |
| 0x1290 | 4 | pack voltage, mV |
| 0x1294 | 4 | power, mW |
| 0x1298 | 4 | current, mA, signed |
| 0x129C, 0x129E | 2 each | temperature 1, temperature 2 |
| 0x12A0 | 4 | alarm bitmask (section 9.1) |
| 0x12A4 | 2 | balance current, mA |
| 0x12A6 | 1 + 1 | balancing state, SOC |
| 0x12A8 | 4 | remaining capacity, mAh |
| 0x12AC | 4 | full charge capacity, mAh |
| 0x12B0 | 4 | cycle count |
| 0x12B4 | 4 | total cycle capacity, mAh |
| 0x12B8 | 1 + 1 | SOH, precharge |
| 0x12BA | 2 | user alarm |
| 0x12BC | 4 | runtime, s |
| 0x12C0 | 1 + 1 | charge MOS, discharge MOS |
| 0x12C2 | 2 | user alarm 2 ([JKMB]); [SY] reads frame byte 200 as the precharging MOS state (section 6.1), **unverified** |
| 0x12C4..0x12CE | 2 each | release countdowns: discharge OCP, discharge SCP, charge OCP, charge SCP, UV, OV |
| 0x12D0 | 1 + 1 | temperature sensor mask, heating |
| 0x12D4 | 2 | emergency countdown, s |
| 0x12E4 | 2 | pack voltage, 0.01 V |
| 0x12E6 | 2 | heating current, mA |
| 0x12F8, 0x12FA, 0x12FC | 2 each | temperatures 3, 4, 5 |
| 0x1300 | 4 | RTC ticks |
| 0x1308 | 4 | time until sleep, s |
| 0x130C | 1 + 1 | PCL module state, reserved |
| 0x1400 | 16 | model (ASCII) |
| 0x1410 | 8 | hardware version |
| 0x1418 | 8 | software version |
| 0x1420 | 4 | runtime, s |
| 0x1424 | 4 | power-on count |
| 0x1470 | 16 | setup passcode ([SY] yaml) |
| 0x14B2 | 1 + 1 | UART1 protocol, CAN protocol |
| 0x1504 | 1 + 1 | RCV time, RFV time, 0.1 h (byte order **unverified**, section 3.6.2) |

Calibration and control block 0x1600 (write only, [JKMB] V1.1; V1.0 lists other offsets (0, 2, 4, ... 14); **unverified** on hardware): 0x1600 voltage calibration (mV), 0x1604 shutdown, 0x1606 current calibration (mA), 0x160A load Li-ion defaults, 0x160C load LiFePO4 defaults, 0x160E load LTO defaults, 0x1610 emergency, 0x1612 time calibration (u32). The trigger registers 0x161C, 0x161E and 0x1620 are not in either document (section 3.6.3).

## 7. Settings

Encoding for BLE JK02 writes: raw = value ÷ scale as a two's complement integer, LE, in a frame with the listed length (section 3.1). JK04: float32 LE for length 4. PB Modbus: FC 0x10 at the register, BE, 2 registers for 4-byte values. 4E57: ID + BE value of the width in section 6.6.

"Read" names the frame offset (S = settings, C = cell info, D = device info). "Range" is the input range used by the [SY] user interface (CONFIG_SCHEMA defaults) and by [BM]; the BMS's own limits are not documented.

### 7.1 Cell voltage protection

| Setting | Read | BLE 32S | BLE 24S | JK04 | Scale | Range | PB reg | 4E57 |
|---|---|---|---|---|---|---|---|---|
| `cellOvp` | S18 | 0x04, len 4 | 0x04 | | 0.001 V | 1.200–4.350 V | 0x100C | 0x90 |
| `cellOvpr` | S22 | 0x05, len 4 | 0x05 | | 0.001 V | 1.200–4.350 V | 0x1010 | 0x91 |
| `cellUvp` | S10 | 0x02, len 4 | 0x02 | | 0.001 V | 1.200–4.350 V | 0x1004 | 0x93 |
| `cellUvpr` | S14 | 0x03, len 4 | 0x03 | | 0.001 V | 1.200–4.350 V | 0x1008 | 0x94 |
| `powerOffVoltage` | S46 (JK04 S38) | 0x0B, len 4 | 0x0B | 0x20 float | 0.001 V | 1.20–4.35 V (JK04 2.0–3.7 V) | 0x1028 | |
| `smartSleepVoltage` | S6 | 0x01, len 4 | 0x01 | | 0.001 V | 0.003–3.650 V | 0x1000 | |
| `cellSoc100Voltage` | S30 | 0x07, len 4 | 0x07 | | 0.001 V | 0.003–3.650 V ([BM] up to 4.35) | 0x1018 | |
| `cellSoc0Voltage` | S34 | 0x08, len 4 | 0x08 | | 0.001 V | 0.003–3.650 V | 0x101C | |
| `cellRcv` | S38 | 0x09, len 4 | 0x09 | | 0.001 V | 0.003–3.650 V | 0x1020 | |
| `cellRfv` | S42 | 0x0A, len 4 | 0x0A | | 0.001 V | 0.003–3.650 V | 0x1024 | |
| `rcvTime` | D266 | 0xB3, len 1 | | | 0.1 h | 0–18.2 h | 0x1504 | |
| `rfvTime` | D267 | 0xB4, len 1 | | | 0.1 h | 0–18.2 h | 0x1504 | |
| `reBulkSoc` | D278 | 0xB7, len 1 | | | 1 % | 0–50 % | | |
| `packOvp` | | | | | | | | 0x8E (0.01 V) |
| `packUvp` | | | | | | | | 0x8F (0.01 V) |
| `cellOvpDelay` | | | | | | | | 0x92 (s) |
| `cellUvpDelay` | | | | | | | | 0x95 (s) |
| `cellDeltaProtection` | | | | | | | | 0x96 (mV) |

[SY] number table declares length 1 for `smartSleepVoltage` while its own comment shows `01 04 ...`; [BM] verified length 4 on hardware (fw 15.26), matching an app capture in [SY] issue 421. Use length 4.

### 7.2 Current protection

| Setting | Read | BLE 32S | BLE 24S | Scale | Range | PB reg | 4E57 |
|---|---|---|---|---|---|---|---|
| `maxChargeCurrent` | S50 | 0x0C, len 4 | 0x0C | 0.001 A | 1.0–600.1 A | 0x102C | 0x99 (A) |
| `chargeOcpDelay` | S54 | 0x0D, len 4 | 0x0D | 1 s | 2–600 s | 0x1030 | 0x9A |
| `chargeOcpRecoveryTime` | S58 | 0x0E, len 4 | 0x0E | 1 s | 2–600 s | 0x1034 | |
| `maxDischargeCurrent` | S62 | 0x0F, len 4 | 0x0F | 0.001 A | 1.0–1200.1 A | 0x1038 | 0x97 (A) |
| `dischargeOcpDelay` | S66 | 0x10, len 4 | 0x10 | 1 s | 2–600 s | 0x103C | 0x98 |
| `dischargeOcpRecoveryTime` | S70 | 0x11, len 4 | 0x11 | 1 s | 2–600 s | 0x1040 | |
| `scpRecoveryTime` | S74 | 0x12, len 4 | 0x12 | 1 s | 2–600 s | 0x1044 | |
| `scpDelay` | S134 | 0x21, len 4 | 0x25 | 1 µs | 0–1000000 µs | 0x1080 | |
| `prechargeTime` | S274 | 0x25, len 4 | | 1 s | 0–255 s | 0x110C | |
| `dischargeOcp2` (switch) | S282 bit 12 | 0x33 | | | | 0x1114 bit 12 (not in [JKMB]) | |
| `dischargeOcp3` (switch) | S282 bit 13 | 0x34 | | | | 0x1114 bit 13 (not in [JKMB]) | |

### 7.3 Temperature protection and heating

| Setting | Read | BLE 32S | BLE 24S | Scale | Range | PB reg | 4E57 |
|---|---|---|---|---|---|---|---|
| `chargeOtp` | S82 | 0x14, len 4 | 0x14 | 0.1 °C | 30–80 °C | 0x104C | 0xA3 (°C) |
| `chargeOtpr` | S86 | 0x15, len 4 | 0x15 | 0.1 °C | 30–80 °C | 0x1050 | |
| `dischargeOtp` | S90 | 0x16, len 4 | 0x16 | 0.1 °C | 30–80 °C | 0x1054 | 0xA4 |
| `dischargeOtpr` | S94 | 0x17, len 4 | 0x17 | 0.1 °C | 30–80 °C | 0x1058 | |
| `chargeUtp` | S98 | 0x18, len 4 | 0x18 | 0.1 °C | −45–20 °C | 0x105C | 0xA5 |
| `chargeUtpr` | S102 | 0x19, len 4 | 0x19 | 0.1 °C | −45–20 °C | 0x1060 | 0xA6 |
| `dischargeUtp` | S296 | 0x3A, len 1 | | 1 °C (i8) | −40–100 °C | | 0xA7 |
| `dischargeUtpr` | S297 | 0x3B, len 1 | | 1 °C (i8) | −40–100 °C | | 0xA8 |
| `mosOtp` | S106 | 0x1A, len 4 | 0x1A | 0.1 °C | 50–110 °C | 0x1064 | 0x9E |
| `mosOtpr` | S110 | 0x1B, len 4 | 0x1B | 0.1 °C | 50–110 °C | 0x1068 | 0x9F |
| `heatingStartTemperature` | S284 | 0x37, len 1 | | 1 °C (i8) | −40–100 °C | 0x1116 | |
| `heatingStopTemperature` | S285 | 0x38, len 1 | | 1 °C (i8) | −40–100 °C | 0x1116 | |
| `heatingEnabled` (switch) | S282 bit 0 | 0x27 | | | | 0x1114 bit 0 | |
| `disableTemperatureSensors` (switch) | S282 bit 1 | 0x28 | | | | 0x1114 bit 1 | |
| `boxOtp`, `boxOtpr`, `tempDiffProtection` | | | | | | | 0xA0, 0xA1, 0xA2 |

### 7.4 Balancing

| Setting | Read | BLE 32S | BLE 24S | JK04 | Scale | Range | PB reg | 4E57 |
|---|---|---|---|---|---|---|---|---|
| `balanceTriggerVoltage` | S26 (JK04 S106) | 0x06, len 4 | 0x06 | 0x64 float | 0.001 V | 0.003–1.000 V (JK04 0.002–1.0 V) | 0x1014 | 0x9C (mV) |
| `balanceStartVoltage` | S138 (JK04 S98) | 0x22, len 4 | 0x26 | 0x58 float | 0.001 V | 1.20–4.25 V (JK04 1.0–4.2 V) | 0x1084 | 0x9B (mV) |
| `maxBalanceCurrent` | S78 (JK04 S110) | 0x13, len 4 | 0x13 | 0x68 float | 0.001 A | 0.3–15.0 A (JK04 0.1–10.0 A) | 0x1048 | |
| `balancerSwitch` | S126 (JK04 S114) | 0x1F, len 4 | 0x1F | 0x6C, len 1 | 0, 1 | | 0x1078 | 0x9D |

### 7.5 Capacity, cell count, SOC

| Setting | Read | BLE 32S | BLE 24S | JK04 | Scale | Range | PB reg | 4E57 |
|---|---|---|---|---|---|---|---|---|
| `nominalCapacity` | S130 | 0x20, len 4 | 0x20 | | 0.001 Ah | 2–20000 Ah | 0x107C | 0xAA (Ah) |
| `cellCount` | S114 (JK04 S34) | 0x1C, len 4 | 0x1C | 0x1C, len 2 | 1 | 2–32 (24S up to 24, JK04 1–24) | 0x106C | 0xA9 |
| SOC calibration | current SOC in C173 | 0x6E, len 1 | | | 1 % | 0–100 % | | |
| SOH calibration | current SOH in C190 | 0x6F, len 1 | | | 1 % | 0–100 % | | |
| battery type preset | C275 (type) | 0x68 Li-ion, 0x69 LiFePO4, 0x6A LTO (len 0) | | | | | 0x160A, 0x160C, 0x160E | 0xAF (type) |
| `actualCapacity` | | | | | | | | 0xB9 (Ah) |
| `lowCapacityAlarm` | | | | | | | | 0xB1 (%) |

[BM] restricts SOC calibration (0x6E) to the JK02_32S protocol (firmware ≥ 11).

### 7.6 Calibration

| Setting | Read | BLE 32S | BLE 24S | JK04 | Encoding | Range | PB reg | 4E57 |
|---|---|---|---|---|---|---|---|---|
| `voltageCalibration` | not readable (JK04 S74) | 0x64, len 4 | 0x21, len 4 | 0x44 float | 0.001 V of pack voltage (JK04: ADC reference in V) | 1.0–200.0 V (JK04 2.80–3.20) | 0x1600 | |
| `currentCalibration` | not readable | 0x67, len 4 | 0x24, len 4 | | 0.001 A (actual current) | 0–1000 A ([BM] −1000–1000 A) | 0x1606 | 0xAD (mA, 100–20000), start with 0xB8 |

### 7.7 System and communication

| Setting | Read | BLE 32S write | Encoding | Notes |
|---|---|---|---|---|
| `uart1Protocol` | D184 | 0xA5, len 2 | index, section 9.6 | [SY] |
| `uart2Protocol` | D218 | 0xA8, len 2 | index | [SY] |
| `uart3Protocol` | D270 | 0xB6, len 2 | index | [SY] |
| `canProtocol` | D185 | 0xA6, len 2 | index | [SY] |
| multiplexed port mode | S282 bit 3 | 0x2A, len 4 | 0 CAN, 1 RS485 | [SY] |
| `lcdBuzzerTrigger` | D234 | 0xA9, len 2 | index, section 9.6 | [SY] |
| `dry1Trigger` | D235 | 0xAA, len 2 | index | [SY] |
| `dry2Trigger` | D236 | 0xAB, len 2 | index | [SY] |
| trigger and release values | D238..D261 | not known | i32 | |
| `dataStoredPeriod` | D262 | not known | s | |
| `displayAlwaysOn` | S282 bit 4 | 0x2B | switch | |
| `smartSleep` | S282 bit 6 | 0x2D | switch | |
| `smartSleepDelay` | S286 | 0x39, len 1 | h | 1–100 h |
| `disablePclModule` | S282 bit 7 | 0x2E | switch | |
| `timedStoredData` | S282 bit 8 | 0x2F | switch | |
| `chargingFloatMode` | S282 bit 9 | 0x30 | switch | [BM] exposes it as "float charge" on PB1A16S and PB2A16S |
| `emergencyButtonTrigger` | S282 bit 10 | 0x31 | switch | |
| `dryContactAlarmIntermittent` | S282 bit 11 | 0x32 | switch | |
| `gpsLockedCharging` | S282 bit 14 | 0x35 | switch | |
| `gpsLockedDischarging` | S282 bit 15 | 0x36 | switch | |
| `gpsHeartbeat` | S282 bit 2 | 0x29 inferred | switch | **unverified** |
| `specialCharger` | S282 bit 5 | 0x2C inferred | switch | **unverified** |
| `emergencyDuration` | D269 | 0xB5, len 1 | min | 1–255 min |
| `deviceAddress` | S270 | none | | set by DIP switches |
| time calibration | C262 (RTC) | 0x6C, len 4 | u32 seconds since 2020-01-01 00:00 | inferred from [CAP], **unverified** |
| user private data (24S) | | 0x9F, len up to 13 | ASCII | [SY] comment |
| 4E57 only | | | | `sleepWaitTime` 0xB0, `password` 0xB2, `dedicatedCharger` 0xB3, `deviceId` 0xB4, `manufacturingDate` 0xB5, `manufacturerId` 0xBA, `boardAddress` 0xAE, GPS cut-off voltages 0xBE, 0xBF |

Write registers for device name, device passcode, setup passcode and user data on JK02_32S are not known from the reviewed sources.

### 7.8 Dependencies and checks

Rules that [BM] enforces before writing (`_RULES`, `implausible_settings`), mirroring the JK app:
- `cellUvp` < `cellUvpr` < `cellOvpr` < `cellOvp`; also `cellUvp` < `cellOvp` and `cellUvpr` < `cellOvpr`.
- `powerOffVoltage` < `cellUvp`.
- `cellSoc0Voltage` < `cellSoc100Voltage` ≤ `cellRcv` < `cellOvp`, and `cellSoc100Voltage` < `cellOvp`.
- `cellRfv` < `cellRcv` and `cellRfv` < `cellOvp`.
- `balanceStartVoltage` < `cellOvp`.
- `chargeUtp` < `chargeUtpr`, `dischargeUtp` < `dischargeUtpr`.
- `chargeOtpr` < `chargeOtp`, `dischargeOtpr` < `dischargeOtp`, `mosOtpr` < `mosOtp`.
- Write order: to raise a low limit raise its recovery value first; to lower a high limit lower its recovery value first.
- Sanity of a settings frame before using it as a baseline: cell count 1–32 and the four cell voltage limits between 1.0 and 4.5 V in the order above.
- A value of 0 for `cellRcv` or `cellRfv` means the firmware lacks the feature; skip rules that involve it.
- Settings that can disable protection or lock the pack: `cellCount`, `scpDelay`, `disableTemperatureSensors`, `gpsLockedCharging`, `gpsLockedDischarging`, calibrations ([BM] `CRITICAL`).

## 8. Controls and actions

### 8.1 Switches (JK02 BLE)

Value 1 or 0 in 4 bytes, length 4 ([SY] `JkSwitch::write_state`, [BM] `encode_setting`, [MPP]). From 0x27 on the register equals 0x27 + bit number in the controls bitmask (S282).

| Switch | Register | Variant | State read from | Source |
|---|---|---|---|---|
| charging | 0x1D | 24S, 32S | S118; MOSFET state C166 / C198 | [SY], [MPP], [BM] |
| discharging | 0x1E | 24S, 32S | S122; C167 / C199 | same |
| balancer | 0x1F | 24S, 32S | S126 | [SY], [BM] |
| heating | 0x27 | 32S | S282 bit 0 | [SY] |
| disable temperature sensors | 0x28 | 32S | bit 1 | [SY] |
| GPS heartbeat | 0x29 | 32S | bit 2 | inferred, **unverified** |
| port mode (0 CAN, 1 RS485) | 0x2A | 32S | bit 3 | [SY] test |
| display always on | 0x2B | 32S | bit 4 | [SY], [BM] test |
| special charger | 0x2C | 32S | bit 5 | inferred, **unverified** |
| smart sleep | 0x2D | 32S | bit 6 | [SY] |
| disable PCL module | 0x2E | 32S | bit 7 | [SY] |
| timed stored data | 0x2F | 32S | bit 8 | [SY] |
| charging float mode | 0x30 | 32S | bit 9 | [SY], [BM] |
| emergency button trigger | 0x31 | 32S | bit 10 | [SY] test (app capture) |
| dry contact alarm intermittent | 0x32 | 32S | bit 11 | [SY] test (app capture) |
| discharge OCP II | 0x33 | 32S | bit 12 | [SY] test (app capture) |
| discharge OCP III | 0x34 | 32S | bit 13 | [SY] test |
| GPS locked charging | 0x35 | 32S | bit 14 | [SY] test (app capture) |
| GPS locked discharging | 0x36 | 32S | bit 15 | [SY] test (app capture) |
| emergency mode | 0x6B | 32S | C218 countdown > 0 | [SY] |
| balancer (JK04) | 0x6C, length 1 | JK04 | S114 | [SY] test, [BM], [CAP] |

JK-PB over RS485: charging, discharging and balancer are 0x1070, 0x1074 and 0x1078 (4 bytes BE, 0 or 1); the other switches are bits of the 16-bit word at 0x1114, written as a whole (read it first, change the bit, write it back; [TX] `trigger_bms2sniffer_switch16_event`).

4E57: charge 0xAB, discharge 0xAC, balancer 0x9D (1 byte).

### 8.2 Buttons and one-shot actions

| Action | BLE (JK02_32S) | Other links | Source |
|---|---|---|---|
| read settings and start streaming | 0x96, length 0 | RS485 trigger 0x161E / 0x1620 | [SY], [DSB] |
| read device info | 0x97, length 0 | RS485 trigger 0x161C | |
| read event log | 0xA1, length 0 | | [SY] |
| shutdown | 0x65, length 0 | PB 0x1604 (**unverified**) | [SY] |
| restart | 0x66, length 0 | 4E57 0xBB = 1 (**unverified**) | [SY] |
| factory reset | 0x9D, length 0 | 4E57 0xBC = 1 (**unverified**) | [SY] |
| load Li-ion / LiFePO4 / LTO preset | 0x68 / 0x69 / 0x6A, length 0 | PB 0x160A / 0x160C / 0x160E (**unverified**) | [SY] |
| SOC calibration | 0x6E, length 1, % | | [SY], [BM] `set_soc` |
| SOH calibration | 0x6F, length 1, % | | [SY] |
| time calibration | 0x6C, length 4, u32 | PB 0x1612 | [CAP] (sent by the app; meaning inferred, **unverified**) |

Note that 0x9D means "factory reset" over BLE but "balancer switch" in 4E57, and 0x6C is the JK04 balancer switch but "time calibration" on JK02_32S.

Some tools reset the SOC to 100 % by temporarily lowering OVP ([DSB] jkbms_brn `reset_soc_jk`); that is not a protocol command.

## 9. Bits and enumerations

### 9.1 JK02 error and alarm bitmask

C166..C169 (u32) on 32S, C136..C137 (u16, bits 0–15 only) on 24S, PB register 0x12A0.

| Bit | Official name ([JKMB]) | Label in [SY] and [AIO] |
|---|---|---|
| 0 | AlarmWireRes | wire resistance |
| 1 | AlarmMosOTP | MOSFET overtemperature |
| 2 | AlarmCellQuantity | cell count differs from setting |
| 3 | AlarmCurSensorErr | [SY] no label (earlier "current sensor anomaly") |
| 4 | AlarmCellOVP | [SY] "battery is fully charged"; [SY] suggests "cell overvoltage" for older firmware |
| 5 | AlarmBatOVP | pack overvoltage |
| 6 | AlarmChOCP | charge overcurrent |
| 7 | AlarmChSCP | charge short circuit |
| 8 | AlarmChOTP | charge overtemperature |
| 9 | AlarmChUTP | charge undertemperature |
| 10 | AlarmCPUAuxCommuErr | coprocessor communication error |
| 11 | AlarmCellUVP | cell undervoltage |
| 12 | AlarmBatUVP | pack undervoltage |
| 13 | AlarmDchOCP | discharge overcurrent |
| 14 | AlarmDchSCP | discharge short circuit |
| 15 | AlarmDchOTP | discharge overtemperature |
| 16 | AlarmChargeMOS | charging MOSFET abnormal |
| 17 | AlarmDischargeMOS | discharging MOSFET abnormal |
| 18 | GPS disconnected | GPS disconnected |
| 19 | Modify PWD in time | modify password in time |
| 20 | Discharge On Failed | discharge on failed |
| 21 | Battery Over Temp Alarm | battery overtemperature |
| 22 | Temperature sensor anomaly (V1.1) | temperature sensor anomaly |
| 23 | PLCModule anomaly (V1.1) | PL module anomaly |
| 24 | | SCP release failed |
| 25 | | discharge OCP II |
| 26 | | discharge OCP III |
| 27 | | discharge undertemperature |
| 28 | | GPS remote lock |
| 29–31 | | not used |

[DSB] jkbms_pb `to_protection_bits` maps bit 12 to both low SOC and cell undervoltage, which looks like an error in that driver.

### 9.2 4E57 warnings (ID 0x8B)

| Bit | Meaning ([JK4E57], [SY]) |
|---|---|
| 0 | low capacity (warning only) |
| 1 | MOSFET over temperature |
| 2 | charge over voltage |
| 3 | discharge under voltage |
| 4 | battery over temperature |
| 5 | charge over current |
| 6 | discharge over current |
| 7 | cell voltage difference |
| 8 | battery box over temperature |
| 9 | battery low temperature |
| 10 | cell over voltage |
| 11 | cell under voltage |
| 12 | 309_A protection |
| 13 | 309_B protection |
| 14, 15 | reserved |

### 9.3 4E57 status (ID 0x8C)

| Bit | Meaning ([JK4E57], [SY], [DSB]) |
|---|---|
| 0 | charging MOSFET on |
| 1 | discharging MOSFET on |
| 2 | balancing active, **inferred from captures**: [JK4E57] calls it balance switch state, but in all four read-all captures the balancer switch setting 0x9D is 1 while bit 2 is set only in the two where the cell delta exceeds the trigger and the highest cell is above the start voltage. ubms reports it as `balancingActive` and takes the balancer switch from 0x9D. |
| 3 | battery present: 1 normal, 0 dropped / offline ([JK4E57]), **unverified**: 0 in all four captures of a working, connected pack (status 0x0004, 0x0003, 0x0003, 0x0007). ubms does not show it. |
| 4–15 | reserved |

### 9.4 Temperature sensor presence (C182 on 24S, C214 on 32S, PB 0x12D0 high byte)

A set bit means the sensor is present ([SY] note: the vendor document calls the bits "absent", real hardware shows the opposite; [DSB] doc and [AIO] agree). Unused inputs can read 1 too (0xFF seen).

| Bit | JK02_32S ([SY], [AIO], [DSB], [JKMB]) | JK02_24S ([AIO] only, **unverified**) |
|---|---|---|
| 0 | MOSFET sensor (C144) | temperature 1 (C130) |
| 1 | temperature 1 (C162) | temperature 2 (C132) |
| 2 | temperature 2 (C164) | MOSFET (C134) |
| 3 | temperature 3 (C254) | |
| 4 | temperature 4 (C256) | |
| 5 | temperature 5 (C258) | |

A raw temperature of −2000 (0xF830) also marks an absent sensor ([AIO], [BM], [MPP] capture). [SY] names C258 "temperature 3" and C254 "temperature 5", the reverse of [JKMB]; this spec follows [JKMB], [AIO] and [DSB].

### 9.5 Controls bitmask (S282..S283, PB 0x1114)

| Bit | Mask | Meaning | Write register |
|---|---|---|---|
| 0 | 0x0001 | heating enabled | 0x27 |
| 1 | 0x0002 | disable temperature sensors | 0x28 |
| 2 | 0x0004 | GPS heartbeat | 0x29 (inferred) |
| 3 | 0x0008 | port switch: 1 RS485, 0 CAN | 0x2A |
| 4 | 0x0010 | LCD / display always on | 0x2B |
| 5 | 0x0020 | special charger | 0x2C (inferred) |
| 6 | 0x0040 | smart sleep | 0x2D |
| 7 | 0x0080 | disable PCL module | 0x2E |
| 8 | 0x0100 | timed stored data | 0x2F |
| 9 | 0x0200 | charging float mode | 0x30 |
| 10 | 0x0400 | emergency button trigger | 0x31 |
| 11 | 0x0800 | dry contact alarm intermittent | 0x32 |
| 12 | 0x1000 | discharge OCP II | 0x33 |
| 13 | 0x2000 | discharge OCP III | 0x34 |
| 14 | 0x4000 | GPS locked charging | 0x35 |
| 15 | 0x8000 | GPS locked discharging | 0x36 |

Bits 0–6 are in [JKMB] V1.0, bits 7–9 in V1.1, bits 10–15 from [SY] app captures.

### 9.6 Enumerations

| Field | Values | Source |
|---|---|---|
| `balancingAction` | 0 off, 1 charging balancer, 2 discharging balancer | [SY], [JKMB] |
| `chargeStatus` | 0 bulk, 1 absorption, 2 float | [SY], [AIO] |
| `batteryType` (C275, 4E57 0xAF) | 0 LiFePO4, 1 Li-ion (ternary), 2 LTO | [SY], [JK4E57] |
| `dryContactMask` | bit 1 DRY1 active, bit 2 DRY2 active | [SY] |
| port mode | 0 CAN, 1 RS485 | [SY] |

UART protocol index (D184, D218, D270; [SY] select/__init__.py; newer firmware may add entries):

| Index | Protocol | Index | Protocol |
|---|---|---|---|
| 0 | 4G-GPS remote module common protocol V4.2 | 11 | UART1 user customization |
| 1 | JK BMS RS485 Modbus V1.0 | 12 | UART2 user customization |
| 2 | NIU U series | 13 | JK BMS RS485 Modbus V1.0 at 9600 baud |
| 3 | China Tower shared battery cabinet V1.1 | 14 | Pylon low voltage RS485 V3.5 at 9600 baud |
| 4 | PACE RS485 Modbus V1.3 | 15 | JK BMS PBxx series LCD protocol V1.0 |
| 5 | Pylon low voltage RS485 V3.5 | 16 | JK BMS LIN bus V1.0 |
| 6 | Growatt BMS RS485 1xSxxP ESS Rev 2.01 | 17 | RS485 protocol 17 |
| 7 | Voltronic inverter and BMS 485 (2020-03-25) | 18 | RS485 protocol 18 |
| 8 | China Tower shared battery cabinet V2.0 | 19 | RS485 protocol 19 |
| 9 | WOW RS485 Modbus V1.3 | 20 | RS485 protocol 20 |
| 10 | JK BMS LCD protocol V2.0 | | |

CAN protocol index (D185; [SY]): 0 JK BMS CAN 250K V2.0; 1 Deye low-voltage hybrid inverter V1.0; 2 Pylon low voltage V1.2; 3 Growatt BMS CAN-bus low voltage Rev 05; 4 Victron CANbus BMS (2017-07-17); 5 Megarevo hybrid BMS CAN V1.0; 6 JK BMS CAN 500K V2.0; 7 INVT BMS CAN V1.02; 8 GoodWe LV BMS (EX/EM/S-BP/BP); 9 FSS ConnectingBat TI-en-10 V1.0; 10 MUST PV1800F CAN 1.04.04; 11 LuxpowerTek battery CAN V01; 12 CAN user customization 1; 13 CAN user customization 2.

LCD buzzer and DRY trigger index (D234..D236; [SY]): 0 off; 1 low SOC; 2 battery over voltage; 3 battery under voltage; 4 cell over voltage; 5 cell under voltage; 6 charge over current; 7 discharge over current; 8 battery over temperature; 9 MOSFET over temperature; 10 system alarm; 11 battery low temperature; 12 remote control; 13 above SOC; 14 MOSFET abnormal.

### 9.7 Event log codes (frame type 0x05)

From [SY] `LOGBOOK_CODES`:

| Code | Event | Code | Event |
|---|---|---|---|
| 0x01 | boot | 0x26 | discharge over temperature released |
| 0x02 | shutdown | 0x27 | watchdog reset |
| 0x03 | app: charge off | 0x28 | discharge short circuit level 2 |
| 0x04 | app: charge on | 0x29 | emergency mode on (manual) |
| 0x05 | app: discharge off | 0x2A | emergency mode off (manual) |
| 0x06 | app: discharge on | 0x2B | emergency mode off (automatic) |
| 0x07 | remote: charge off | 0x2C | turned off by app |
| 0x08 | remote: charge on | 0x2D | turned off by button |
| 0x09 | remote: discharge off | 0x2E | discharge switch-on failed |
| 0x0A | remote: discharge on | 0x2F | RS485 power off |
| 0x0B | MOSFET over temperature protection | 0x30 | CAN: charge off |
| 0x0C | MOSFET over temperature released | 0x31 | CAN: charge on |
| 0x0D | current sensor fault | 0x32 | CAN: discharge off |
| 0x0E | current sensor fault released | 0x33 | CAN: discharge on |
| 0x0F | coprocessor communication fault | 0x34 | RS485: charge off |
| 0x10 | coprocessor communication fault released | 0x35 | RS485: charge on |
| 0x11 | cell overcharge protection | 0x36 | RS485: discharge off |
| 0x12 | cell overcharge released | 0x37 | RS485: discharge on |
| 0x13 | battery overcharge protection | 0x38 | enter sleep |
| 0x14 | battery overcharge released | 0x39 | charge MOSFET abnormal |
| 0x15 | charge overcurrent protection | 0x3A | discharge MOSFET abnormal |
| 0x16 | charge overcurrent released | 0x3B | time calibration |
| 0x17 | charge short circuit protection | 0x3C | cell count incorrect |
| 0x18 | charge short circuit released | 0x3D | button: emergency on |
| 0x19 | charge over temperature protection | 0x3E | button: emergency off |
| 0x1A | charge over temperature released | 0x3F | button: forced heating |
| 0x1B | charge low temperature protection | 0x40 | discharge OCP II |
| 0x1C | charge low temperature released | 0x41 | discharge OCP III |
| 0x1D | cell undervoltage protection | 0x42 | SCP release failed |
| 0x1E | cell undervoltage released | 0x43 | factory setting Li-ion |
| 0x1F | battery undervoltage protection | 0x44 | factory setting LFP |
| 0x20 | battery undervoltage released | 0x45 | factory setting LTO |
| 0x21 | discharge overcurrent protection | 0x46 | remote: emergency on |
| 0x22 | discharge overcurrent released | 0x47 | remote: emergency off |
| 0x23 | discharge short circuit protection | 0x48 | discharge under temperature protection |
| 0x24 | discharge short circuit released | 0x49 | discharge under temperature released |
| 0x25 | discharge over temperature protection | | |

Codes 0x64..0x83: overcharge protection of cell (code − 0x63), cells 1–32. Codes 0xC8..0xE7: over-discharge protection of cell (code − 0xC7), cells 1–32. Other codes have no known meaning.

## 10. Device information

| Item | BLE / RS485 trigger (frame 0x03) | PB Modbus | 4E57 |
|---|---|---|---|
| model | D6 (16) | 0x1400 | inside 0xBA on some units ("Input UserdaJK-B2A24S15P") |
| hardware version | D22 (8) | 0x1410 | prefix of 0xB7 ("11.XW" in "11.XW_S11.261__", "H6.X") |
| software version | D30 (8) | 0x1418 | after "_S" in 0xB7 ("11.261", "6.1.3S") |
| uptime / runtime | D38, s | 0x1420 | 0xB6 working time, minutes |
| power-on count | D42 | 0x1424 | |
| device name | D46 (16) | | |
| passcodes | D62 (16), D97 (5), D118 (16) | 0x1470 (setup) | 0xB2 (10) |
| manufacturing date | D78, YYMMDD | | 0xB5, YYMM |
| serial number | D86 (up to 16) | | 0xB4 device ID (8) |
| user data | D102, D134 | | |

The BMS bus master never requests 0x161C, and according to [TX] it does not answer that request itself. Parse versions by taking the digits before the first dot as the major number; strings like "10.07D30", "11.21h" and "8.0.3M" occur.

## 11. Detection

### 11.1 BLE scan

- Filter on service 0xFFE0; add manufacturer data 0x0B65 (payload starting `88 A0`) or 0x4B4A to prefer JK devices ([AIO] `matcher_dict_list`). Names are user-defined and not reliable.
- Other devices that use FFE0 / FFE1:
  - ANT BMS (new protocol): names "ANT-BLE24*" or "ANT-BLE3*"; frames start `7E A1` and end `AA 55` ([AIO] ant_bms.py);
  - NEEY / Heltec active balancers: names "EK-*" or "GW-*", advertise FEE7; frames `AA 55 11 01` (command) and `55 AA 11 01` (answer), last byte 0xFF ([AIO] neey_bms.py, [SY] heltec_balancer_ble).

### 11.2 BLE probe

1. Connect, start notifications, send 0x97.
2. JK if within about 3 s a 300-byte frame arrives that starts with `55 AA EB 90`, has type 0x03 and a valid sum8 at byte 299 (the ACK frame `AA 55 90 EB C8 ...` may come too). An ANT or NEEY device answers with its own header or not at all.
3. Read the model, hardware and software version (section 6.3).

### 11.3 Variant

- Software major ≥ 11: JK02_32S; otherwise JK02_24S, unless the device is a JK04 balancer.
- JK04 test on a type 0x02 frame ([BM] `looks_like_jk04_status`): for each of the 24 slots at 6 + 4i that is not all zero, byte 9 + 4i is 0x3F or 0x40 and the float32 value lies between 0.5 and 5.0 V; at least two cells pass. A JK02 frame cannot pass because those bytes are high bytes of u16 millivolt values.
- JK04 test on a settings frame ([BM] `_cells_from_settings_checked`): a JK02 settings frame has the cell count at S114, JK04 has its cell count (1–24) at S34 and the balancer switch at S114. [BM] treats S114 = 0 with S34 in 1–24 as JK04. With the JK04 balancer on, S114 = 1 cannot be told apart from a 1-cell JK02 setting, so prefer the cell info test above.
- [DSB] alternative for 24S against 32S: S287 ≠ 0 means 32S.

### 11.4 JK-PB RS485 probe

Send the 0x1620 or 0x161C trigger to the configured address (1–15). JK-PB if the answer contains `55 AA EB 90`, the expected type, a valid sum8, and an FC 0x10 ACK with the same address, register and a valid CRC. Alternative with FC 0x03: read 8 registers at 0x1400 and expect ASCII starting with "JK" (e.g. "JK_PB2A16S20P", [DSB] doc).

### 11.5 4E57 probe

Send "read all". A valid reply starts with `4E 57`, repeats the command byte of the request (0x06 for read all; a JK_B1A20S15P capture answers a 0x03 read of ID 0x00 with 0x03), has source 0x00, transport type 0x01, the 0x68 marker and a valid checksum, and contains ID 0x79 followed by a byte count divisible by 3.

## 12. Pitfalls and quirks

1. Two characteristics with UUID FFE1 on many units; select by properties (section 2.1).
2. The notification stream contains `AT\r\n` text and ACK frames, and notifications do not align with frames (section 3.4). sum8 is weak; check plausibility.
3. App captures contain random filler before the checksum; zero filler works.
4. Offsets differ between JK02_24S and JK02_32S (section 6.1): resistances and the cell statistics move by 16 bytes, everything from C112 by 32 bytes, the MOSFET temperature moves from C134 to C144, the error bitmask from u16 at C136 to u32 at C166.
5. Register numbers differ between the variants from 0x21 on: 0x21 is voltage calibration on 24S but SCP delay on 32S; 0x25 is SCP delay on 24S but precharge time on 32S; 0x26/0x22 is the balance start voltage. 0x27 is a lead resistance on 24S and the heating switch on 32S. Writing with the wrong variant changes a different setting; [BM] allows settings writes only when JK02_32S is confirmed.
6. 0x96 means "send settings" and "start streaming"; every 0x96 produces another settings frame. JK-PB adds a device info frame.
7. ACK received does not mean applied (section 4.2).
8. `smartSleepVoltage` needs length 4 although the [SY] table says 1.
9. `fullChargeCapacity` (C146 / C178) is not the configured capacity (S130) on firmware ≥ 11.
10. Current sign: JK reports positive for charging; [BM] reports the opposite sign. `powerRaw` has no sign.
11. Temperature naming: C254, C256, C258 are temperature 3, 4, 5 per [JKMB]; [SY] names them 5, 4, 3. C254 equals the MOSFET temperature on several units.
12. A temperature of −2000 raw means "no sensor"; the presence mask can show sensors that are not connected.
13. SOC (C141 / C173) has 1 % resolution; [BM] derives a finer SOC as `capacityRemaining` ÷ `fullChargeCapacity`.
14. The frame counter (byte 5) of RS485 answers was 0x00 in [DSB]'s tests and 0x05 in [MPP]'s captures; [DSB] rejects frames where it is not 0. Do not validate it.
15. JK-PB Modbus registers are byte addresses; FC 0x03 becomes unreliable without FC 0x10 traffic; never use address 0 (bus master) for a pack that a client polls; keep at least 100 ms between requests; expect adapter echo.
16. JK-PB register writes can be refused with exception 0x03 ([TX] capture for 0x1504).
17. 4E57: three different temperature formulas in the field (section 6.6), the current format depends on ID 0xC0, writes beyond the MOSFET switches may be refused, and the VBAT pin on the port carries pack voltage.
18. [BM] needs a BLE scan before some connections succeed (BlueZ "connection abort"), and JK firmware 19 (e.g. 19.24) sometimes returns an empty GATT table, which [BM] attributes to a stale BlueZ cache ([BM] `connect`, `_ensure_services_discovered`).
19. The max/min cell index bytes (C62/C63, C78/C79) did not always match the voltages in the same frame; compute them.
20. Serial number length differs between firmwares (section 6.3).
21. JK-PB heating temperatures are only used on hardware newer than 15A or 15A with firmware ≥ 15.41 ([DSB]).
22. `cellRcv`, `cellRfv` read 0 on firmware without that feature.
23. S6 (`smartSleepVoltage`) reads 600 on sw 10.07 (24S) and sw 11.26 (32S), while sw 11.50 and later show 3285 to 3550 (mV). The meaning of 600 is unknown; do not present it as 0.6 V.
24. `scpDelay` reads 5 on sw 15.26 and later captures (up to 20.19) where earlier firmware (10.07 to 15.10) showed 1000 or 1500; the unit on new firmware is unknown.
25. [MPP] jkpb.py test responses are attached to the wrong commands; its comment block (CMD/RSP pairs) is correct.
26. Event log: only 50 entries per frame; reading older entries is not documented.

## 13. References

All URLs point to the default branch as read on 2026-11-18.

[SY] syssi/esphome-jk-bms, https://github.com/syssi/esphome-jk-bms
- components/jk_bms_ble/jk_bms_ble.cpp: `build_frame`, `crc`, `assemble`, `decode_`, `decode_jk02_cell_info_`, `decode_jk04_cell_info_`, `decode_jk02_settings_`, `decode_jk04_settings_`, `decode_device_info_`, `decode_logbook_`, `LOGBOOK_CODES`, `gattc_event_handler`, `update`, `encode_jk04_payload`
- components/jk_bms_ble/__init__.py (`DEFAULT_ERRORS_JK02`), number/__init__.py (`NUMBERS`, register comments, `CONFIG_SCHEMA` ranges), number/jk_number.cpp, switch/__init__.py (`SWITCHES`), switch/jk_switch.cpp, button/__init__.py (`BUTTONS`), select/__init__.py (`SELECTS`, option lists, `LOAD_CONFIG_PRESET_OPTIONS`), select/jk_select.cpp
- components/jk_bms/jk_bms.cpp (`on_status_data_`), jk_bms.h (`get_temperature_`, `get_current_`), switch/__init__.py; components/jk_modbus/jk_modbus.cpp (`send`, `read_registers`, `parse_jk_modbus_byte_`, `authenticate_`, `write_register`)
- docs/protocol-design-ble.md, docs/protocol-design-uart-ttl-gps-port.md, docs/pdus/*.txt, docs/pb2a16s20p/JK_BMS.RS485.Modbus.v1_0.pdf, docs/pb2a16s20p/BMS RS485 Modbus V1.1.pdf, docs/RS485-english-OBSOLETE.pdf
- [CAP] docs/btsnoop_hci_jk-bd6a24s10p_hw8x_sw806g.log, docs/btsnoop_hci_jk-b2a16s_hw30_sw330.log, docs/btsnoops/heating-start-stop-setting/btsnoop_hci.log, btsnoop_hci-commands.txt, btsnoop_hci-settings.txt, docs/pb2a16s15p-discharge-precharge-time/btsnoop_hci.txt
- tests/components/jk_bms_ble/: frames_jk02_24s_v10.h, frames_jk02_32s_v11.h, frames_jk02_32s_v14.h, frames_jk02_32s_v15.h, frames_jk02_32s_v19.h, frames_jk04.h, frames_jk04_b5a24s.h, frames_logbook.h, jk_bms_ble_test.cpp, jk_bms_ble_jk02_*_test.cpp, jk_bms_ble_jk04_test.cpp, jk_bms_ble_jk04_b5a24s_test.cpp, jk_bms_ble_write_command_test.cpp, jk_bms_ble_protocol_select_test.cpp, jk_bms_ble_errors_test.cpp, jk_bms_ble_logbook_test.cpp
- tests/components/jk_bms/common.h (`STATUS_FRAME_14S`), jk_bms_test.cpp; tests/components/jk_modbus/jk_modbus_test.cpp
- README.md (supported devices), esp32-ble-example.yaml (protocol_version note), esp32-example.yaml, esp32-jk-pb-modbus-example.yaml

[TX] txubelaxu/esphome-jk-bms, https://github.com/txubelaxu/esphome-jk-bms
- components/jk_rs485_sniffer/jk_rs485_sniffer.cpp: `send_request_to_slave`, `send_command_switch_or_number_to_slave_uint32`, `..._uint16`, `manage_rx_buffer_`, `loop`, timing constants
- components/jk_rs485_bms/README.md, jk_rs485_bms.cpp (`on_jk_rs485_sniffer_data`, `decode_jk02_settings_`, `trigger_bms2sniffer_switch16_event`, `trigger_bms2sniffer_number16_event`), number/__init__.py (`NUMBERS`, capture comments), switch/__init__.py (`SWITCHES`, capture comments)
- [JKPB] docs/JK-BMS-User-Manual-for-PB-series-jkbms.com_.pdf

[AIO] patman15/aiobmsble, https://github.com/patman15/aiobmsble
- aiobmsble/bms/jikong_bms.py: `_FIELDS`, `_PROBLEMS`, `matcher_dict_list`, `_init_connection`, `_notification_handler`, `_cmd`, `_temp_pos`, `_conv_data`, `_async_update`
- tests/bms/test_jikong_bms.py: `_PROTO_DEFS`, `_RESULT_DEFS`, `_DEV_DEFS`, test_update, test_stream_update, test_hide_temp_count, test_oversized_response
- aiobmsble/test_data/jikong_bms.json (advertisements); aiobmsble/bms/ant_bms.py and neey_bms.py (headers and name patterns for section 11.1)

[BM] fl4p/batmon-ha, https://github.com/fl4p/batmon-ha
- bmslib/models/jikong.py: `feed_frames`, `JKBt.connect`, `_q`, `_write`, `_settle_after_query`, `_status_frame_implausible`, `_decode_sample`, `_cells_from_settings_checked`, `fetch_device_info`, `set_switch`, `set_soc`, `_write_setting_locked`, `_ensure_services_discovered`
- bmslib/models/jk_settings.py (`_TABLE`, `_RULES`, `implausible_settings`, `CRITICAL`, `UNVERIFIED_WRITE`), bmslib/models/jk04.py (`looks_like_jk04_status`, `decode_jk04_status`, `decode_jk04_settings`), bmslib/models/jk_pb_uart.py, bmslib/models/jikong_uart.py (`REGISTER_WIDTHS`, `parse_tlv_body`), doc/JK-Settings.md
- bmslib/test/data/jk_fixtures.py, jk_issue377.py, jk04_fixtures.py, jk_uart_fixtures.py, jk_432_bd6a32s_*.bin, jk_issue365_*.bin, jk_settings_b2a8s30p_fw15.26.bin, jk_settings_b2a8s30p_fw17.06.bin; bmslib/test/test_jk_settings_encode.py

[DSB] mr-manuel/venus-os_dbus-serialbattery, https://github.com/mr-manuel/venus-os_dbus-serialbattery
- dbus-serialbattery/bms/jkbms.py (`read_status_data`, `to_protection_bits`, `read_serial_data_jkbms`), jkbms_brn.py (`TRANSLATE_*`, `write_register`, `request_bt`, `asy_connect_and_scrape`), jkbms_pb.py (`command_*`, `get_settings`, `read_status_data`, `_send_command`, `_receive_data`, `_validate_response`, `modbusCrc`, `COMMAND_GAP`)
- bms-docs/JKBMS-PB.md

[MPP] jblance/mpp-solar, https://github.com/jblance/mpp-solar
- mppsolar/protocols/jkabstractprotocol.py (`get_full_command`, `get_responses`, `is_record_complete`), jk02.py, jk02_32.py, jk04.py, jkpb.py (CMD/RSP capture comments), jkserial.py (4E57 capture), jk232.py, jk485.py, protocol_helpers.py (`crc8`)
- tests/unit/test_protocol_jk02.py, tests/integration/test_protocol_jk02.py, tests/integration/test_protocol_jk04.py

[JKT] sshoecraft/jktool, https://github.com/sshoecraft/jktool, jk_info.c (`jk_get_info`, `getdata`, `_getvolts`, `_getinfo`)

[JKMB] JK "BMS RS485 Modbus" V1.0 and V1.1 (vendor register map), copies in [SY] docs/pb2a16s20p/

[JK4E57] JK "Communication protocol between monitoring platform and BMS", version 2020-12-17, copy in [MPP] docs/protocols/JKSerial-TTL-20201217.pdf

[JD] JohnDevine/JKBMS2ESPMQTT, https://github.com/JohnDevine/JKBMS2ESPMQTT, Documents/TurnOnOffSwitches.txt (4E57 MOSFET frames and a quote from diysolarforum thread 66034)

[VS] Vasilius-001/JK-BMS-UART, https://github.com/Vasilius-001/JK-BMS-UART, src/JkBmsUart.cpp (4E57 command table, `convertTemperature`, write reply check)
