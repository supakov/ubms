# ANT BMS protocol specification (ANT_NEW and ANT_OLD)

Implementation reference for the ubms ANT driver (Web Bluetooth, Web Serial, later Rust/Tauri).
Vendor: Shenzhen ANT ("ANT BMS", Chinese name MaYi; Android app `com.mayi.bms` / "ANT BMS", Windows tool `MaYiSystem.exe`).

Status of this document: compiled from open source implementations, vendor documents, decompiled app notes and raw
captures (see section 13). Every statement is traceable to a source. Statements marked **unverified** come from a
single source without a capture, or are inferred. Where sources disagree, the disagreement and the evidence used to
resolve it are given (section 12.1).

Test vectors: `packages/bms-drivers/test/vectors/ant.json` (213 frames, every CRC and checksum validated).

Conventions: byte offsets are counted from the first byte of the frame (offset 0 = `7E` or `AA`). `u16le` = unsigned
16 bit little endian, `i16be` = signed 16 bit big endian, and so on. "raw" is the integer read from the frame;
"value = raw x scale".

---

## 1. Overview

### 1.1 Two protocol generations

| Generation id | Also called | Frame shape | Byte order | Integrity | Used by |
|---|---|---|---|---|---|
| `ANT_NEW` | "2021 protocol", "v2021", "7E A1 protocol" | `7E A1 <func> <addr lo> <addr hi> <len> <data> <crc lo> <crc hi> [extra section] AA 55` | little endian | CRC-16/MODBUS | boards from about mid 2021 (16ZMB, 24AHA, 24BH, 32BH, 20PH, 22AA, 04DM, ...) |
| `ANT_OLD` | "legacy", "pre-2021", "AA 55 protocol" | requests: 6 bytes `HH HH addr vh vl sum`; status answer: 140 bytes starting `AA 55 AA FF` | big endian | 8 bit sum (requests), 16 bit sum (status) | boards up to about 2020 ("ANT 16S 100A", "ANT 24S 200A", "ANT 32S 300A", BMS-ANT24C) |

Key facts:

* Most 2021+ boards also answer the old status request (read only). In that mode the power field reads 9999
  (placeholder) and writes with the old protocol are not accepted (ESPHome issues #5, #37). At least one 2021 board did
  not answer the old request at all (ESPHome issue #18, dl4mea). Old boards do not speak `ANT_NEW`.
* `ANT_NEW` is request/response (polling); some 2024 firmware keeps streaming status frames about every 0.5 s after the
  first request (ESPHome issue #174).
* The BLE module is a transparent UART bridge: the same frames are used over BLE and over the wired UART (batmon-ha
  `bmslib/models/ant_uart.py` docstring; identical frames in ESPHome `ant_bms` and `ant_bms_ble`).

### 1.2 Model families seen in sources

| Name / model string | Link seen | Generation | Source |
|---|---|---|---|
| `ANT-BLE16ZMUB`, HW `16ZM` / `16ZMB0TB120A`, SW `16ZMUB00-211026A`, `16ZMUB00-220501A` | BLE | NEW | ESPHome README, `docs/pdus/btsnoop_hci_ANT-BLE16ZMUB*.txt` |
| `ANT-BLE24BHUB`, `ANT-BLE24BHUB-5300`, HW `24BH` / `24BHA0TB120A`, SW `24BHUB00-211026A`, `24BHUB00-220301A` | BLE, UART | NEW | ESPHome README, issues #18, #84, aiobmsble test |
| HW `32BHA0TB120A`, SW `32BHUB00-211005A` (30S pack) | BLE | NEW | ESPHome issue #78 |
| `ANT-BLE04DMUB`, SW `04DMUB00-240122B` | BLE | NEW | ESPHome README |
| `ANT@BLE22AAUB-Q2U3`, HW `22PHB8TB130A`, SW `22AAUB00-241008A` | BLE | NEW | ESPHome issues #172, #174 |
| `ANT-BLE22AAUB-YCE7`, HW `22PHA1TB080A`, SW `22AAUB00-240510A`, boot `BT22AAUB-240606A` | BLE | NEW | yosle/ant-bms-ble PROTOCOL.md |
| `ANT@BLE24CBUB-1231\r` (name ends with a carriage return) | BLE | NEW (assumed by aiobmsble) | BMS_BLE-HA issue #675 |
| `ANT-BLE22AACB-0489` | BLE | unclear (aiobmsble maps `ANT-BLE22*` to legacy; connection never worked) | BMS_BLE-HA issue #668 |
| 20PHB, SW `20PHUB00-211026A`, `20PHUB00-220716B` | BLE | NEW | batmon-ha `ant.py`, ESPHome issue #42 |
| 16ZMB-TB-7-16S-300A (2021-08), 24AHA-TB-24S-200A (2021-09) | UART | NEW | ESPHome README |
| `ANT-BLE24C` (BLE) + `BMS-ANT24C` (Bluetooth classic SPP, PIN 1234) on one board | BLE, SPP | OLD | ESPHome issue #61, `docs/pdus/btsnoop_hci_model2019-BMS-ANT24C-rfcomm.txt` |
| `ANT-BLE16S` | BLE | OLD (aiobmsble legacy driver) | aiobmsble `test_data/ant_leg_bms.json` |
| ANT 16S 100A (2020), ANT 24S 200A (2020) | UART | OLD | ESPHome README, issue #28 |
| ANT 32S 300A (UART on pins labelled A/B), ANT 32S 200A (works with the OLD BLE component) | UART, BLE | 300A: not stated; 200A: OLD | ESPHome issue #70 |

The HW string encodes the board (`24BHA0TB120A`: up to 24 cells, 120 A variant); the SW string ends with a build date
(`24BHUB00-220301A` = 2022-03-01). This decoding is an observation, **unverified**.

### 1.3 Telling them apart at runtime

1. BLE name: `ANT-BLE` / `ANT@BLE` followed by a long model code (for example `ANT-BLE24BHUB`, `ANT-BLE22AAUB-YCE7`)
   means NEW. The vendor app asks "use old protocol?" when the name is exactly 10 characters long and starts with
   `ANT-BLE` (`ANT-BLE16S`, `ANT-BLE24C`) or when character index 10 is `-` (yosle PROTOCOL.md "Protocol selection").
2. Probe (authoritative): send the NEW status request; a valid `7E A1 11` frame within about 1.5 s means NEW. Otherwise
   send the OLD status request and expect a 140 byte `AA 55 AA FF` frame. Details in section 11.

---

## 2. Physical links

### 2.1 BLE (both generations)

GATT table (identical for NEW modules and the OLD `ANT-BLE24C` module; ESPHome `ant_bms_ble.cpp` and `ant_bms_old_ble.cpp`
comments, ESPHome issue #61 log, ATT discovery in `docs/btsnoop_hci_ANT-BLE24BHUB*.log`, batmon-ha `ant.py` docstring):

| Element | UUID | Handle | Properties | Use |
|---|---|---|---|---|
| Service | `0000ffe0-0000-1000-8000-00805f9b34fb` (0xFFE0) | 0x000E..0xFFFF | | vendor service |
| Characteristic | `0000ffe1-0000-1000-8000-00805f9b34fb` (0xFFE1) | value 0x0010 | 0x1C = write without response, write, notify | all requests and all responses |
| CCCD of FFE1 | 0x2902 | 0x0011 | | write `01 00` to enable notifications |
| Characteristic | 0xFFE2 | value 0x0013 | 0x0C = write without response, write | not used by any implementation |
| Services 0x1800 / 0x1801 | | 0x0001..0x0009 / 0x000A..0x000D | | GAP (device name 0x2A00), GATT (service changed) |

* Requests are written to FFE1; responses arrive as notifications on FFE1.
* Write type: the vendor Android app uses write with response (yosle "BLE connection"); ESPHome, aiobmsble and
  batmon-ha use write without response. batmon-ha forces write without response because write with response through an
  ESPHome Bluetooth proxy failed with ATT error "Insufficient authorization (8)". ant-bms-web (Web Bluetooth) uses
  `writeValueWithResponse` successfully. Recommendation: prefer `writeValueWithoutResponse`, fall back to with response.
* MTU and fragmentation: captures with Android show no MTU exchange; notifications are at most 20 bytes (ATT MTU 23).
  The vendor app requests MTU 512 (yosle); Windows keeps 20 byte notifications (yosle); an ESP32 negotiated MTU 136
  with an old `ANT-BLE24C` module (ESPHome issue #61). A 168 byte status frame arrives as 8 or 9 notifications.
  Notification boundaries are not frame boundaries: one notification can carry the tail of one frame and the head of the
  next (`docs/btsnoop_hci_ANT-BLE24BHUB-commands.log`, notification 35: `...FF 0B 00 00 41 F2 AA 55 7E A1 11 00 00 9E...`).
* No BLE pairing is needed in the captures. One unresolved report (`ANT-BLE22AACB-0489`, BMS_BLE-HA issue #668) got
  "Insufficient authorization" when enabling notifications through an ESPHome proxy; **unverified** whether that module
  requires bonding.
* Single connection: the module accepts one central and stops advertising while connected (ESPHome issue #168, yosle
  app guide). Packs may stop advertising when asleep (yosle).
* Radio is weak (yosle measured -92 to -99 dBm at a few meters); expect lost notifications and CRC failures.

Advertising data observed:

| Name | Service UUIDs | Manufacturer data (company id: payload) | Source |
|---|---|---|---|
| `ANT-BLE24C-001` | FFE0 | 0x2313: `88 A0 AA BB CC 90 00 01` | aiobmsble `test_data/ant_bms.json` |
| `ANT@BLE24CBUB-1231\r` | FFE0 | 0x1388: `64 9B F8 2E A6 6A 22 11 33 22` (first 6 bytes = MAC) | aiobmsble `test_data/ant_bms.json`, raw adv in BMS_BLE-HA #675 |
| `ANT-BLE16S` | FFE0, FEE7 | 0x0657: `88 A0 AA BB CC A1 23 45` | aiobmsble `test_data/ant_leg_bms.json` |
| `ANT-BLE22AACB-0489` | FFE0, FEE7 | 0x279B: `88 A0 22 DD 65 00 04 89` | aiobmsble `test_data/ant_leg_bms.json` |
| `ANT-BLE24C` | FFE0, FEE7 | not logged | ESPHome issue #61 |

The company id varies per unit, so manufacturer data is not a usable identifier. Two payload styles exist: `88 A0` +
6 MAC-like bytes, and MAC + `22 11 33 22`. The raw advertisement of `ANT@BLE24CBUB-1231` is
`0dff8813649bf82ea66a22113322 020106 0302e0ff 1409414e5440424c453234434255422d313233310d`: the complete local name
contains a trailing `0x0D`. Trim names before matching.

Bluetooth classic: old boards also expose `BMS-ANT<model>` as an SPP (RFCOMM) serial port, pairing PIN `1234`
(ESPHome issue #61; vendor manual `24+32sBMS newer docs.pdf` in Sgw32/BMSCtl). The bytes on that port are the OLD
protocol (`docs/pdus/btsnoop_hci_model2019-BMS-ANT24C-rfcomm.txt`). Web Bluetooth cannot open SPP; Web Serial can use it
only after the OS pairs it and creates a virtual COM port.

### 2.2 UART / RS485

| Item | Value | Source |
|---|---|---|
| Connector | 4 pin JST 1.25 mm "Comm": VCC (3.3 V), GND, RX, TX | ESPHome README, issues #9, #40 |
| Power | VCC must be connected, otherwise the BMS does not answer; the line also wakes the BMS | ESPHome README, issue #34 |
| Levels | 3.3 V TTL. One board with a 6 pin display connector (GND, BAT+, GND, RX, TX, 3.3 V) had only 1.16 V swing on TX and needed a level shifter | ESPHome issue #90 |
| Baud rate (de facto) | 19200 8N1, no flow control, both generations | ESPHome `ant_bms/__init__.py` and `ant_bms_old/__init__.py` (`FINAL_VALIDATE_SCHEMA`), batmon-ha `ant_uart.py`, dbus-serialbattery (`{"bms": ANT, "baud": 19200}`), imval/AntBMS, RoboDurden/AntBms-Arduino |
| Baud rate (vendor documents) | 9600 8N1 | vendor PDF `docs/ANT_communication_protocol_EN.1.pdf`; batmon-ha says the vendor PC tool defaults to 9600 |
| Addressing | none, point to point. The NEW `addr` field is a register address, not a device address | all sources |
| Inter byte timeout | ESPHome drops a partial frame after 50 ms of silence (`rx_timeout`) | ESPHome `ant_bms.cpp` `loop()` |
| RS485 | only through an external TTL to RS485 transceiver; no native RS485 framing or multi drop addressing is documented. **unverified** | batmon-ha `ant_uart.py` docstring |
| Pin labels | on a 32S 300A board the pins labelled `A` and `B` are TTL RX and TX, not RS485 (worked with a plain FTDI adapter) | ESPHome issue #70 |

Recommendation for Web Serial: open at 19200 8N1; if no valid frame after two polls, retry at 9600.

---

## 3. Frame formats

### 3.1 ANT_NEW request frame

```
offset 0    1    2      3        4        5     6 .. 5+P        6+P     7+P     8+P  9+P
       7E   A1   func   addr_lo  addr_hi  len   payload (P)     crc_lo  crc_hi  AA   55
```

* `func`: function code (section 5).
* `addr`: u16le. Meaning depends on `func`: parameter byte address for 0x02/0x22/0x23, action code for 0x51, log index
  for 0x03, 0 otherwise.
* `len`: for reads (0x01..0x06) the number of data bytes requested, no payload follows (P = 0). For writes (0x22,
  0x23) the payload length (P = len). For 0x51 it is 0.
* Request frames are therefore `10 + P` bytes.

### 3.2 ANT_NEW response frame

```
offset 0  1  2      3..4   5    6 .. 5+r   6+r     7+r     [extra section]                          last 2
       7E A1 func   addr   r    data (r)   crc_lo  crc_hi  [FF st 00 h  data(h)  ecrc_lo ecrc_hi]    AA 55
```

* `r` (offset 5) = number of data bytes.
* Case B (no extra section): total length `10 + r`, `AA 55` at `8+r`.
* Case C (extra section): total length `16 + r + h`. At `8+r` follows `FF`, a status byte, `00`, `h` (count of extra
  data bytes), `h` bytes, a CRC over those `4 + h` bytes, then `AA 55` (yosle PROTOCOL.md "Long frame layout", verified
  on every captured Case C frame in the vectors file).

### 3.3 CRC (ANT_NEW)

* Algorithm: CRC-16/MODBUS: polynomial 0x8005 reflected (0xA001 in the shift right form), init 0xFFFF, input and output
  reflected, no final XOR. Check value for ASCII `123456789` is 0x4B37 (computed).
* Coverage: from offset 1 (`A1`) through the last data or payload byte, that is `5 + r` bytes for a response and
  `5 + P` bytes for a request. `7E`, the CRC itself and `AA 55` are not covered.
* Byte order: the CRC register is transmitted low byte first. Example: CRC over `A1 01 00 00 BE` = 0x5518, sent as
  `18 55` (ESPHome `ant_bms_ble.h` `crc16()`, `build_frame()`; aiobmsble `_cmd()` with `crc_modbus` "little").
* yosle PROTOCOL.md calls the order "big endian" because the vendor table driven routine returns the bytes swapped
  (`(s << 8) | n` = 0x1855); the bytes on the wire are identical.
* Extra section CRC: same algorithm over the 4 header bytes plus the `h` data bytes, low byte first. Examples:
  `FF 0B 00 00` gives `41 F2`, `FF 0A 00 00` gives `10 32`, `FF 05 00 00` gives `20 31`.

Reference implementation (shift form, equivalent to the vendor table form):

```
crc = 0xFFFF
for each byte b: crc ^= b; repeat 8 times: crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1
```

### 3.4 Extra section contents (ANT_NEW)

| Seen after | Bytes | Seen on | Source |
|---|---|---|---|
| 0x12 device info and all 0x12 reads on 2021/2022 firmware | `FF 0B 00 00` + `41 F2` | 16ZMUB, 24BHUB, 32BHUB, 22AAUB device info | captures, ESPHome tests |
| 0x12 block reads on 2024 firmware | `FF 01 00 04` + 4 bytes + CRC | 22AAUB 240510A | yosle PROTOCOL.md, ant-bms-web tests |
| 0x42 write response | `FF 0A 00 00` + `10 32` | 16ZMUB, 24BHUB | captures |
| 0x43 auth response | `FF 05 00 00` + `20 31` (also seen without extra section) | 24BHUB | ESPHome issue #18 |

yosle's decoding for status `0x01` with h = 4: data[0] = low byte of the last parameter address served, data[1] = page
(`lastAddr >> 5`), data[2] = firmware group id (3, 5 or 9), data[3] = 0; status `0x0B` = "range outside the parameter
area". This decoding is **unverified** on 2021 firmware, which returns `0x0B` for valid ranges too. The vendor app
`MY-APP-1116` called this part a "second packet" and passed the u16 at extra offset 1..2 to
`bmsPermissionCallback.onError()` (ESPHome issue #18, syssi). Treat the extra section as opaque metadata: validate its
CRC, then ignore it.

Frames without extra section in every capture: 0x11 status, 0x61 control ACK, 0x14 chip id, 0x15 system info.

### 3.5 Reassembly (ANT_NEW)

Byte stream reassembly works for BLE (chunks of 20 to MTU-3 bytes) and UART alike:

```
on data(chunk): buf += chunk
loop:
  i = index of bytes 7E A1 in buf
  if none: keep the last byte if it is 7E, drop the rest; stop
  drop buf[0..i)
  if len(buf) < 6: stop (wait)
  r = buf[5]; if len(buf) < 8 + r: stop (wait)
  if CRC16(buf[1 .. 5+r]) != buf[6+r] | buf[7+r] << 8: drop 1 byte; continue
  if len(buf) < 10 + r: stop (wait)
  if buf[8+r] == AA and buf[9+r] == 55: frame = buf[0 .. 10+r)          (Case B)
  elif buf[8+r] == FF:                                                   (Case C)
      if len(buf) < 12 + r: stop (wait)
      h = buf[11+r]; need 16 + r + h bytes, else stop (wait)
      require buf[14+r+h] == AA, buf[15+r+h] == 55 and the extra CRC
      frame = buf[0 .. 16+r+h)
  else: drop 1 byte; continue
  emit frame; drop it from buf
```

Rules derived from sources:

* Never decide "frame complete" from a trailing `0x55` alone: ASCII `U` inside version strings (`22AAUB00-...`) caused
  out of bounds reads and crashes when a notification ended on it (ESPHome issues #172, #174; batmon-ha #431 test
  `test_ant_reassembly_fragment_ending_in_0x55`).
* Do not clear the buffer only when a chunk starts with `7E A1`: frames can start inside a chunk (24BHUB capture).
* A chunk can contain a single `7E` (ESPHome test `OneBytePreambleFragmentDoesNotCrash`).
* Drop the buffer after about 4 s without a complete frame (ant-bms-web `ble.js`) and after a request timeout
  (yosle `reset_buffer()`), so a corrupted header cannot wedge the parser.
* Cap the buffer (ant-bms-web: 1024 bytes). Largest legal frame: 6 + 255 + 2 + extra + 2; the largest status frame is
  6 + (106 + 64 + 12 + 14) + 4 = 206 bytes for 32 cells, 6 NTC and the 14 byte optional block.
* An alternative used by batmon-ha accepts a frame once the primary CRC matches and discards everything up to the next
  `7E A1`. It works because the extra section never contains `7E A1` in captures.

### 3.6 ANT_OLD frames

Command (host to BMS), always 6 bytes (vendor PDF "Setting parameters and reading parameters", klotztech VBMS wiki
"Basic frame structure", ESPHome `ant_bms_old.cpp` `send_()`):

| Offset | Size | Meaning |
|---|---|---|
| 0 | 2 | header: `A5 A5` = write to BMS, `5A 5A` = read from BMS, `DB DB` = "write data to the main board" (used as the status request over Bluetooth) |
| 2 | 1 | address (parameter number or control code) |
| 3 | 2 | value u16be |
| 5 | 1 | checksum = (address + value_hi + value_lo) & 0xFF |

Status answer: 140 bytes (section 6.8). `AA 55 AA FF` header, data at offsets 4..137, checksum u16be at 138..139 =
sum of bytes 4..137 modulo 65536 (VBMS wiki, `BcService.java` excerpt; ESPHome `chksum_()`; batmon-ha
`old_checksum_ok()`; yosle `decode_old()`; verified on every old frame in the vectors file).

Parameter read answer: 6 bytes `5A 5A addr vh vl sum`, same layout as the request (ESPHome issue #18, bchiu; the 2019
SPP capture shows `5A5AFF0000FF` answered with the same 6 bytes). **unverified** beyond these two sources.

Write answers seen in captures: an accepted write is echoed byte for byte; a rejected write (no or wrong password) is
answered with `A5 A5 F5 00 01 F6` (2019 SPP capture; ESPHome issue #28 UART log shows echoes after a successful
password). The meaning "rejected" is inferred, **unverified**.

Reassembly: search `AA 55 AA FF`, take 140 bytes, verify the sum; on failure drop one byte and search again (batmon-ha
`feed_old_frames()`). Adapters may append junk bytes (10 x `FF` in an issue #28 capture) and echoed command bytes may
precede the answer (issue #28 UART log). Over BLE the 140 bytes arrive in several notifications; ESPHome resets the
buffer when a notification starts with `AA 55 AA`.

---

## 4. Session flow

### 4.1 ANT_NEW over BLE

1. `requestDevice` with name prefix filters `ANT-BLE` and `ANT@BLE`, `optionalServices: [0xFFE0]`.
2. Connect, get service 0xFFE0, characteristic 0xFFE1, `startNotifications()`.
3. Send device info request `7EA1026C022058C4AA55` (ESPHome sends it right after enabling notifications; aiobmsble
   before the first status).
4. Optional authentication (section 4.3).
5. Poll status `7EA1010000BE1855AA55`. Intervals used: vendor app 500 ms (yosle), ant-bms-web 500 ms, ESPHome BLE
   default 2 s (`polling_component_schema("2s")`), ESPHome examples 5 s. One request, one 0x11 answer, except 2024
   firmware that streams 0x11 frames every 0.2 to 0.5 s after a request (ESPHome issue #174): accept unsolicited 0x11
   frames and rate limit downstream (ESPHome `throttle`).
6. Settings and controls: section 4.3.

Vendor app timing after connect (yosle "App flow"): level 1 password at 100 ms (only if the permission byte of the last
status frame is below 1), version read `ReadData(620, 32, 2)` at 200 ms, then status every 500 ms.

### 4.2 ANT_NEW over UART

Same frames. ESPHome polls status every 5 s by default (`ant_bms`), waits for silence of 50 ms between frames. The
vendor PC tool sends on port open `7EA10400000C98ECAA55` (chip id) and `7EA1010000BE1855AA55`, then status every
0.5 s; the System Info tab sends 0x05, 0x02 @262, 0x04, 0x02 @620, 0x01; the Log tab reads entries 1..10 with 1 s
between requests; the GPRS tab polls 0x06 every 1 s (ESPHome issue #20).

### 4.3 Authentication, settings and controls (ANT_NEW)

* Permission byte: offset 6 of every status frame (`sysOperatingAut`, app name). Values 0, 1 and 5 seen.
* At permission level 0 an ANT-BLE20PHUB answered every parameter read (0x02 at 0, 56, 104, 140, 152, 262, 378 and the
  version page at 620) with a valid 0x12 frame whose data bytes were all 0xFF, extra section status 1, so the reads looked
  successful but every register read as "not configured" (ubms field log `ubms-log-2026-11-20T10-26-50.json`, status
  `...0008...` with byte 6 = 0). This matches the vendor app, which sends the level 1 password before the version read
  when the permission byte is below 1 (below). ubms therefore logs in before reading when the status reports level 0:
  first the default level 1 password, then the password of the settings as level 5 and, when it has at most 8
  characters (the size of the level 1 field), as level 1 (users who changed the app password know it, not its level).
  When the BMS answered these logins and granted nothing, they are not sent again on later reads until the user
  changes the password; a BMS that answered none of them gets them again. When every page still comes back as 0xFF
  bytes, the Settings tab says that
  read access was not granted and asks for the password right there. A single 0xFF page is normal (a page that is not
  configured). The same user reported that the values appeared after logging in with the vendor app first, so the
  access level outlives the vendor app's connection.
* The permission byte does not tell whether the parameters can be read. In a second log of that board
  (`ubms-log-2026-11-20T12-19-52.json`) the status reported level 1; the pack id (262) and the version page (620) were
  served with extra section status 0x0B, while the parameter pages (0, 56, 104, 140, 152, 378) still came back as 0xFF
  bytes with extra section status 0x01 and group 3. Which level the parameters need and which password the vendor app
  sends for it is **unverified**, so ubms decides by the pages: when the first parameter block (address 0, always
  configured on a working BMS) is blank, it sends the password of the settings as level 5 and, when it has at most 8
  characters, as levels 1 to 4 (addresses 330, 338, 346, 354), then the factory passwords at the same addresses,
  reading block 0 after each attempt. A password that unlocked nothing is not tried again until the user changes it;
  the Settings tab then shows the password field.
* Settings reads by ubms: a parameter block that failed in two settings reads in a row while the BMS answered is left
  out of the next three settings reads and then requested again. When neither the status request of a settings read
  nor the first block is answered, the BMS is taken as silent (asleep, restarting, out of range): the other blocks are
  not requested, nothing is counted against the blocks and the Settings tab reports that the BMS did not answer. The
  legacy driver (ANT_OLD) likewise stops after the first unanswered parameter read without a fresh status, and marks
  the parameters as not readable for the connection only when the same settings read got a status answer.
* Level 1 password (default `12345678`): function 0x23 at address 0x014A (330), 8 ASCII bytes. Per the 2024 app it only
  unlocks reading the parameter pages (yosle). A user reported that `12345678` was enough to switch MOSFETs and balancing
  from the app, while changing parameters needed `123456789abc` (ESPHome issue #5, lucasimons).
* Level 5 password (factory `123456789abc`): function 0x23 at address 0x016A (362), 12 ASCII bytes (vendor PC tool,
  ESPHome issue #20). ESPHome (`send_(..., authenticate=true)`) and batmon-ha send it immediately before every 0x51
  control. batmon-ha: without it a 20PHUB board accepted charge off but reverted within seconds.
* Levels 2, 3, 4: addresses 338, 346, 354 (8 bytes); level 5 at 362 (12 bytes) (yosle "Passwords"). Passwords are
  changed with function 0x22 to the same addresses (yosle; **unverified**).
* Answer: function 0x43 with data u16le = granted level (`7EA1436A010205001E5CAA55` = level 5). A 24BHUB answered level 5
  to the level 1 password (ESPHome issue #18); the 22AAUB answered level 1 for all addresses (yosle).
* The 16ZMUB capture shows parameter writes without any 0x23 frame while the status permission byte was 5
  (`docs/pdus/btsnoop_hci_ANT-BLE16ZMUB.txt`). Safe sequence: send level 5 auth, then the write, then `0x51/0x07` save.

Write flow observed (16ZMUB app capture):

```
-> 7EA122000002420EBDECAA55        write 0x0000 = 3650 (3.650 V)
<- 7EA142000002420EB44CFF0A00001032AA55
-> 7EA15107000038E4AA55            save / apply
<- 7EA1610700020100B62BAA55
```

Read flow: block reads with function 0x02. Keep each read at 64 bytes or less, retry up to 4 times (yosle `_read_block()`);
firmware may clamp long ranges and return fewer bytes (yosle). The first parameter read after connect was sometimes lost
and had to be repeated (ESPHome issue #18, bchiu).

Serialize all traffic: one outstanding request, wait for its answer (or about 1 s timeout) before the next. Do not let a
status poll land between the auth frame and the write it unlocks (batmon-ha `_write_lock`, test
`test_status_poll_does_not_split_auth_and_write`). ESPHome lists "command queue / scheduling" as a known issue because
controls interleaved with polls were unreliable (ESPHome README, issue #5).

No keepalive frame is needed; polling keeps the link up. Authentication lifetime is unknown; re-authenticate before each
write.

### 4.4 ANT_OLD

* Status poll: `DBDB00000000` over Bluetooth (BLE and SPP), `5A5A00000101` on UART (ESPHome, batmon-ha, imval). The
  vendor PDF names `5A5A00000000` for the serial port; dbus-serialbattery and BMSCtl send `DBDB00000000` on UART too.
  ESPHome polls every 5 s.
* Writes: password (if any), command, apply. ESPHome `write_register()` sends
  `A5A5F1 c1 c2 sum`, `A5A5F2 c3 c4 sum`, `A5A5F3 c5 c6 sum`, `A5A5F4 c7 c8 sum`, then `A5A5 addr vh vl sum`, then
  `A5A5FF0000FF`. With this sequence the BMS beeped once (accepted) instead of three times (ESPHome issue #61).
* The 2019 app polled `5A5AFF0000FF` repeatedly while connected over SPP.

---

## 5. Commands (exact bytes)

All frames below are in the vectors file with their source. Hex is the complete frame.

### 5.1 ANT_NEW function codes

| Request | Response | Purpose | Status |
|---|---|---|---|
| 0x01 | 0x11 | status (real time) | verified |
| 0x02 | 0x12 | read parameter block, device info | verified |
| 0x03 | 0x13 | read system log entry (addr = index 1..10) | request verified, answer layout unknown |
| 0x04 | 0x14 | read chip id (12 bytes) | verified |
| 0x05 | 0x15 | read system info (40 bytes) | verified, meaning unknown |
| 0x06 | 0x16 | read GPRS/GPS data (108 bytes) | request seen in PC tool, answer unknown |
| 0x22 | 0x42 | write parameter(s) | verified |
| 0x23 | 0x43 | authenticate (password) | verified |
| 0x51 | 0x61 | control action (addr = action code) | verified |
| 0x53 | unknown | factory reset (2024 app, addr 1) | **unverified** |
| 0x57 | unknown | firmware block transfer (addr 61700) | never send |

### 5.2 ANT_NEW read requests

| Purpose | Frame |
|---|---|
| Status | `7EA1010000BE1855AA55` |
| Device info (32 bytes at 0x026C) | `7EA1026C022058C4AA55` |
| Chip id | `7EA10400000C98ECAA55` |
| System info | `7EA105000028990BAA55` |
| GPRS / GPS | `7EA10600006C997CAA55` |
| Log entry 1 | `7EA103010000C85DAA55` |
| Log entry 2 | `7EA103020000385DAA55` |
| Log entry 3 | `7EA103030000699DAA55` |
| Log entry 4 | `7EA103040000D85CAA55` |
| Log entry 5 | `7EA103050000899CAA55` |
| Log entry 6 | `7EA103060000799CAA55` |
| Log entry 7 | `7EA103070000285CAA55` |
| Log entry 8 | `7EA103080000185FAA55` |
| Log entry 9 | `7EA103090000499FAA55` |
| Log entry 10 | `7EA1030A0000B99FAA55` |
| Pack ID (262, 32 bytes) | `7EA1020601207828AA55` |
| Block 0, 56 bytes (vendor app) | `7EA10200003899B3AA55` |

Single register reads: `7E A1 02 <addr lo> <addr hi> <02 or 04> <crc lo> <crc hi> AA 55`. All 56 registers documented
by ESPHome are in the vectors (`new-req-read-*`). Examples: register 0x0000 `7EA10200000219A0AA55`, register 0x0068
`7EA102680002987CAA55`, register 0x00A2 (u32, length 4) `7EA102A200043840AA55`. Any other address or block: build
with section 3.1 and the CRC of section 3.3.

### 5.3 ANT_NEW authentication

| Purpose | Frame |
|---|---|
| Level 1, `12345678` @0x014A | `7EA1234A01083132333435363738DB50AA55` |
| Level 5, `123456789abc` @0x016A | `7EA1236A010C3132333435363738396162632062AA55` |
| aiobmsble variant (address bytes swapped, `01 6A`) | `7EA123016A083132333435363738D9EEAA55` (**unverified**, do not use) |

### 5.4 ANT_NEW parameter write

`7E A1 22 <addr lo> <addr hi> <P> <value bytes, little endian> <crc lo> <crc hi> AA 55`, P = 2 for u16/i16, 4 for u32,
8/12/32 for strings. Captured examples:

| Register | Value | Frame | Source |
|---|---|---|---|
| 0x0000 cell OVP | 3650 = 3.650 V | `7EA122000002420EBDECAA55` | 16ZMUB capture |
| 0x0002 cell OVP recovery | 3550 = 3.550 V | `7EA122020002DE0DED2DAA55` | 16ZMUB capture |
| 0x0068 charge OCP | 500 = 50.0 A | `7EA122680002F401EA41AA55` | issue #18 |
| 0x006A charge OCP delay | 5 s | `7EA1226A0002050017D1AA55` | issue #18 |
| 0x006C discharge OCP | 3000 = 300.0 A | `7EA1226C0002B80BAF46AA55` | issue #18 |
| 0x006E discharge OCP delay | 5 s | `7EA1226E00020500E611AA55` | issue #18 |

After writes send `7EA15107000038E4AA55` (save / apply), as the app does.

### 5.5 ANT_NEW control actions (function 0x51, len 0)

| Action | addr | Frame | Notes |
|---|---|---|---|
| Discharge MOSFET off | 0x01 | `7EA151010000D8E5AA55` | |
| Discharge MOSFET on | 0x03 | `7EA1510300007925AA55` | |
| Charge MOSFET off | 0x04 | `7EA151040000C8E4AA55` | |
| Charge MOSFET on | 0x06 | `7EA1510600006924AA55` | |
| Save / apply parameters | 0x07 | `7EA15107000038E4AA55` | |
| Current zero calibration | 0x08 | `7EA15108000008E7AA55` | |
| Restart | 0x09 | `7EA1510900005927AA55` | |
| Firmware upgrade start | 0x0A | 24 byte payload | never send (yosle) |
| Shutdown ("stop" in the 2024 app) | 0x0B | `7EA1510B0000F8E7AA55` | BMS powers off |
| Factory reset | 0x0C | `7EA1510C00004926AA55` | |
| Manual balance on | 0x0D | `7EA1510D000018E6AA55` | balance state becomes 4 (capture) |
| Manual balance off | 0x0E | `7EA1510E0000E8E6AA55` | |
| Clear system log | 0x0F | `7EA1510F0000B926AA55` | ACK result 3 |
| Bluetooth initialization | 0x10 | `7EA15110000088E0AA55` | |
| Bluetooth off | 0x1C | `7EA1511C000048E3AA55` | drops the BLE link |
| Bluetooth on | 0x1D | `7EA1511D00001923AA55` | |
| Buzzer on | 0x1E | `7EA1511E0000E923AA55` | |
| Buzzer off | 0x1F | `7EA1511F0000B8E3AA55` | |
| Clear discharge cycle Ah | 0x20 | `7EA15120000088EFAA55` | |
| Clear charge cycle Ah | 0x21 | `7EA151210000D92FAA55` | |
| Clear discharge time | 0x22 | `7EA151220000292FAA55` | |
| Clear charge time | 0x23 | `7EA15123000078EFAA55` | |
| Clear running time | 0x24 | `7EA151240000C92EAA55` | |
| Clear protect time | 0x25 | `7EA15125000098EEAA55` | |
| Load LTO defaults ("TiLion") | 0x26 | `7EA15126000068EEAA55` | |
| Load ternary defaults ("Lion") | 0x27 | `7EA151270000392EAA55` | |
| Load LiFePO4 defaults | 0x28 | `7EA151280000092DAA55` | |
| Reset hardware | 0x2A | `7EA1512A0000A8EDAA55` | |
| Save customer data | 0x2C | `7EA1512C000048ECAA55` | |
| User parameters ("UserPareme") | 0x2D | `7EA1512D0000192CAA55` | |
| Factory reset (2024 app) | function 0x53, addr 1 | `7EA153010000D95DAA55` | computed, **unverified** |

Sources: vendor PC tool capture table (ESPHome issue #20), ESPHome `button/__init__.py` and `switch/__init__.py`,
yosle "Write commands", 24BHUB and 16ZMUB captures (ACKs). Each is acknowledged with function 0x61 (section 6.6).

### 5.6 ANT_OLD commands

| Purpose | Frame | Source |
|---|---|---|
| Status over Bluetooth (BLE and SPP); also works on UART | `DBDB00000000` | vendor PDF, VBMS wiki, ESPHome `ant_bms_old_ble`, dbus-serialbattery |
| Status on UART | `5A5A00000101` | ESPHome `ant_bms_old`, batmon-ha, imval/AntBMS |
| Status on UART (vendor PDF) | `5A5A00000000` | vendor PDF, VBMS wiki, RoboDurden |
| Read parameter N | `5A5A NN 0000 NN` (sum = N) | ESPHome issue #18 (bchiu), dbus-serialbattery comments |
| Read parameter 31 / 32 (capacity low / high) | `5A5A1F00001F`, `5A5A20000020` | dbus-serialbattery comments |
| Read 0xFF (app poll) | `5A5AFF0000FF` | 2019 SPP capture |
| Write parameter N = V | `A5A5 NN VH VL sum`, then `A5A5FF0000FF` | ESPHome `write_register()`, issue #18 |
| Charge MOSFET on / off | `A5A5FA0001FB` / `A5A5FA0000FA` | ESPHome issue #5, SPP capture |
| Discharge MOSFET on / off | `A5A5F90001FA` / `A5A5F90000F9` | ESPHome issue #5, SPP capture |
| Automatic balancing (toggle button) | `A5A5FC0000FC` | ESPHome issue #5, `ant_bms_old/button` |
| Factory defaults | `A5A5FD0000FD` | vendor PDF (253) |
| Reboot | `A5A5FE0000FE` | vendor PDF (254), ESPHome issue #5 |
| Apply | `A5A5FF0000FF` | vendor PDF (255), ESPHome |
| BMS power off | `A5A5F70000F7` | vendor PDF (247) |
| Current zero ("clear counter" in ESPHome) | `A5A5F80000F8` | vendor PDF (248) |
| LiFePO4 parameter set | `A5A5FB0000FB` | vendor PDF (251) |
| LTO parameter set | `A5A5F00000F0` | ESPHome `ant_bms_old/button` comment, decompiled enum `LithiumTitanate(240)` |
| Password `12345678` | `A5A5F1313254`, `A5A5F2333459`, `A5A5F335365E`, `A5A5F4373863` | ESPHome issue #61 capture, `authenticate_()` |

ESPHome also lists `EF 1A 01` "request upgrade" and `F6 00 00` "change MAC address" without captures; never send.

---

## 6. Responses

### 6.1 ANT_NEW 0x11 status

Let `n` = cell count (offset 9), `m` = NTC count (offset 8), `o = 34 + 2n + 2m`. Data length (offset 5):
`r = 106 + 2n + 2m` without optional block, `r = 118 + 2n + 2m` with the 12 byte block, `r = 120 + 2n + 2m` with the
14 byte variant. Frame length `r + 10`; CRC at `6 + r`.

Fixed part:

| Offset dec | hex | Len | Type | Scale / unit | Field | Notes |
|---|---|---|---|---|---|---|
| 0 | 0x00 | 2 | | | `7E A1` | |
| 2 | 0x02 | 1 | u8 | | function `0x11` | |
| 3 | 0x03 | 2 | u16le | | address, `00 00` | |
| 5 | 0x05 | 1 | u8 | bytes | data length r | |
| 6 | 0x06 | 1 | u8 | | permission level | 1 or 5 seen |
| 7 | 0x07 | 1 | u8 | enum | system state | table 9.1 |
| 8 | 0x08 | 1 | u8 | count | m, NTC probes | excludes MOSFET and balancer sensors; seen 2 and 4 |
| 9 | 0x09 | 1 | u8 | count | n, cells | up to 32 |
| 10 | 0x0A | 4 | u32le | bits | protection mask, bits 0..31 | table 9.5 |
| 14 | 0x0E | 4 | u32le | bits | protection mask, bits 32..63 | |
| 18 | 0x12 | 4 | u32le | bits | warning / status mask, bits 0..31 | table 9.6 |
| 22 | 0x16 | 4 | u32le | bits | warning / status mask, bits 32..63 | |
| 26 | 0x1A | 8 | u64le | | unknown | "PushMack_Bit" in a C# port (ESPHome issue #52), "balancing? bitmask" (ESPHome comment), reserved (yosle). Zero in all captures |
| 34 + 2i | 0x22 + 2i | 2 | u16le | 0.001 V | cell voltage i (i = 0..n-1) | |
| 34 + 2n + 2j | | 2 | i16le | 1 degC | NTC temperature j (j = 0..m-1) | -40 (0xFFD8) = probe absent |

Dynamic part, offset = `o + k`:

| k dec | k hex | Len | Type | Scale / unit | Field | Notes |
|---|---|---|---|---|---|---|
| 0 | 0x00 | 2 | i16le | 1 degC | MOSFET temperature | |
| 2 | 0x02 | 2 | i16le | 1 degC | balancer temperature | |
| 4 | 0x04 | 2 | u16le | 0.01 V | pack voltage | |
| 6 | 0x06 | 2 | i16le | 0.1 A | current | positive = discharging, negative = charging (12.2) |
| 8 | 0x08 | 2 | u16le | 1 % | SOC | ESPHome reads it as i16 |
| 10 | 0x0A | 2 | u16le | 1 % | SOH | |
| 12 | 0x0C | 1 | u8 | enum | discharge MOSFET state | table 9.2. ESPHome swaps 12 and 13 (12.1) |
| 13 | 0x0D | 1 | u8 | enum | charge MOSFET state | table 9.3 |
| 14 | 0x0E | 2 | u16le | enum | balance state | table 9.4; ESPHome reads byte 14 only, byte 15 "reserved" (0) |
| 16 | 0x10 | 4 | u32le | 1e-6 Ah | full (physical) capacity | |
| 20 | 0x14 | 4 | u32le | 1e-6 Ah | remaining capacity | |
| 24 | 0x18 | 4 | u32le | 0.001 Ah | cycle capacity (lifetime Ah counter) | yosle: lifetime counter, not current capacity |
| 28 | 0x1C | 4 | i32le | 1 W | power | positive = discharging; the 2024 app reads it unsigned (bug) |
| 32 | 0x20 | 4 | u32le | 1 s | total runtime | app variable `allTimerMs` but unit is seconds (ESPHome, yosle) |
| 36 | 0x24 | 4 | u32le | bits | balancing cell mask, bit 0 = cell 1 | non zero while balancing (24BHUB capture) |
| 40 | 0x28 | 2 | u16le | 0.001 V | max cell voltage | |
| 42 | 0x2A | 2 | u16le | | max cell number, 1 based | |
| 44 | 0x2C | 2 | u16le | 0.001 V | min cell voltage | |
| 46 | 0x2E | 2 | u16le | | min cell number, 1 based | |
| 48 | 0x30 | 2 | u16le | 0.001 V | cell voltage delta | the 2024 app recomputes max minus min |
| 50 | 0x32 | 2 | u16le | 0.001 V | average cell voltage | |
| 52 | 0x34 | 2 | u16le | 0.1 V (**unverified**) | discharge MOSFET D-S voltage | i16 in the C# port |
| 54 | 0x36 | 2 | u16le | 0.1 V (**unverified**) | discharge MOSFET gate drive voltage | seen 112..130 |
| 56 | 0x38 | 2 | u16le | 0.1 V (**unverified**) | charge MOSFET gate drive voltage | seen 107..126 |
| 58 | 0x3A | 2 | u16le | raw | "F40com" (ESPHome) / `voltageNhMos` (yosle) | seen 527..687; probably the zero current comparator value of the old frame (offset 130), **unverified** |
| 60 | 0x3C | 2 | u16le | enum | battery type | table 9.7; 0 on one older unit |
| 62 | 0x3E | 4 | u32le | 0.001 Ah | total discharged Ah | ESPHome scale; yosle leaves it unscaled. On 22AAUB 240510A raw values were 4120 / 4180 (scale **unverified** there) |
| 66 | 0x42 | 4 | u32le | 0.001 Ah | total charged Ah | as above |
| 70 | 0x46 | 4 | u32le | 1 s | total discharge time | |
| 74 | 0x4A | 4 | u32le | 1 s | total charge time | |
| 78 | 0x4E | | | | end of standard fields: CRC here if `r == 106 + 2n + 2m` | |

Optional block, present only when `r > 106 + 2n + 2m` (yosle PROTOCOL.md "Remaining time"; same condition in the C# port
of the PC tool, ESPHome issue #52):

| k dec | k hex | Len | Type | Unit | Field | Evidence |
|---|---|---|---|---|---|---|
| 78 | 0x4E | 4 | u32le | s | charge duration (`NewCHtime`, `CHG_duration`) | 11587 s while charging (issue #78) |
| 82 | 0x52 | 4 | u32le | s | charge interval (`CHtimeintervar`, `CHG_interval`) | |
| 86 | 0x56 | 2 | u16le | min | charge time remaining | 148 min while charging at 12.6 A with 31 Ah missing (issue #78) |
| 88 | 0x58 | 2 | u16le | min | discharge time remaining | 251 min at 18 A with 75.6 Ah left (ant-bms-web vector) |
| 90 | 0x5A | 2 | | | unknown, only in the 14 byte variant | seen 0 (issues #78, #174) |

Example offsets for n = 16, m = 2 (o = 70, r = 142, frame 152 bytes): MOSFET temperature 70, pack voltage 74, current 76,
SOC 78, discharge MOS 82, charge MOS 83, balance 84, capacity 86, remaining 90, cycle 94, power 98, runtime 102, balance
mask 106, max cell 110/112, min cell 114/116, delta 118, average 120, battery type 130, totals 132/136/140/144, CRC 148.

Validation: function 0x11, CRC ok, `1 <= n <= 32`, `m <= 6` (batmon-ha caps m at 8 because one unit reported a bogus
count), `r` equals one of the three formulas.

### 6.2 ANT_NEW 0x12 parameter block and device info

| Offset | Len | Type | Field |
|---|---|---|---|
| 0 | 2 | | `7E A1` |
| 2 | 1 | u8 | `0x12` |
| 3 | 2 | u16le | start address as requested |
| 5 | 1 | u8 | r, number of data bytes |
| 6 | r | | parameter bytes; register at address `A` is at offset `6 + (A - start)`; u16le unless noted in section 7 |
| 6 + r | 2 | u16le | CRC |
| 8 + r | | | extra section (always present in captures) then `AA 55` |

`0xFFFF` in a u16 register means "not configured" (yosle "Why many blocks return 0xFFFF"); show it as empty, never as
65535. ASCII registers are NUL padded.

Device info is the 0x12 answer to `7EA1026C022058C4AA55`:

| Offset | Len | Type | Field | Example |
|---|---|---|---|---|
| 6 | 16 | ASCII, NUL padded | hardware version / model | `24BHA0TB120A`, `16ZM`, `22PHB8TB130A` |
| 22 | 16 | ASCII, NUL padded | software version | `24BHUB00-220301A` |
| 38 | 2 | u16le | CRC | |
| 40 | 6 | | extra section `FF 0B 00 00 41 F2` | |
| 46 | 2 | | `AA 55` | total 48 bytes |

ESPHome and aiobmsble skip the length check for this frame ("data_len value of the device info frame is wrong"); the
extra section explains the 6 additional bytes.

### 6.3 ANT_NEW 0x42 write response

Echo of the write: offset 3 address, offset 5 length, offset 6 the written bytes, CRC, extra section `FF 0A 00 00 10 32`,
`AA 55`. bchiu saw the same `0x0A` code whether authenticated or not and the value was written anyway (ESPHome issue
#18). A newer app decodes the echoed value as u32 when length > 2, as i16 for addresses 68..98, otherwise as u16
(decompiled excerpt in ESPHome issue #18).

### 6.4 ANT_NEW 0x43 auth response

`7E A1 43 <addr lo> <addr hi> 02 <level lo> <level hi> <crc> [FF 05 00 00 20 31] AA 55`. Level is u16le.

### 6.5 ANT_NEW 0x14 chip id, 0x15 system info

* 0x14: `r = 12`, 12 bytes printed by the app as dot separated decimals (`SocId`); address 4096 gives `SysID2` (yosle).
  Example `7EA11400000C40703B18DC8F9E1137428401A8F9AA55`.
* 0x15: `r = 40`, meaning unknown. Example (24BHUB): ten u32le values 10, 10, 10, 0, 0, 0, 0, 10, 7, 2.

### 6.6 ANT_NEW 0x61 control ACK

`7E A1 61 <action lo> <action hi> 02 <result u16le> <crc> AA 55`, no extra section. Result `01 00` for every action in
the captures, `03 00` for clear system log (meaning unknown).

### 6.7 ANT_NEW 0x13 log, 0x16 GPS

No captured answers. **unverified**.

### 6.8 ANT_OLD 140 byte status

All multi byte values big endian. Sources: vendor PDF, klotztech VBMS wiki, ESPHome `ant_bms_old.cpp` and README table,
yosle appendix, preussal `get_ant-BMS.py`, RoboDurden `include.h`, batmon-ha `decode_old_status()`.

| Offset dec | hex | Len | Type | Scale / unit | Field | Notes |
|---|---|---|---|---|---|---|
| 0 | 0x00 | 4 | | | `AA 55 AA FF` | |
| 4 | 0x04 | 2 | u16be | 0.1 V | pack voltage | |
| 6 | 0x06 | 64 | u16be x 32 | 0.001 V | cell voltages 1..32 | use the first `cell count` entries |
| 70 | 0x46 | 4 | i32be | 0.1 A | current | positive = discharging (12.2) |
| 74 | 0x4A | 1 | u8 | 1 % | SOC | |
| 75 | 0x4B | 4 | u32be | 1e-6 Ah | physical capacity | 0 on some 2020 boards |
| 79 | 0x4F | 4 | u32be | 1e-6 Ah | remaining capacity | |
| 83 | 0x53 | 4 | u32be | 0.001 Ah | cycle capacity (lifetime) | |
| 87 | 0x57 | 4 | u32be | 1 s | runtime since power on | |
| 91 | 0x5B | 2 | i16be | 1 degC | MOSFET (power) temperature | yosle, preussal; ESPHome calls it temperature 1 |
| 93 | 0x5D | 2 | i16be | 1 degC | balancer temperature | ESPHome temperature 2 |
| 95 | 0x5F | 2 | i16be | 1 degC | NTC 1 | ESPHome temperature 3 |
| 97 | 0x61 | 2 | i16be | 1 degC | NTC 2 | |
| 99 | 0x63 | 2 | i16be | 1 degC | NTC 3 | -40 = absent on 2021 boards; 2020 boards fill 0 |
| 101 | 0x65 | 2 | i16be | 1 degC | NTC 4 | |
| 103 | 0x67 | 1 | u8 | enum | charge MOSFET state | table 9.8 |
| 104 | 0x68 | 1 | u8 | enum | discharge MOSFET state | table 9.9 |
| 105 | 0x69 | 1 | u8 | enum | balance state | table 9.10 |
| 106 | 0x6A | 2 | u16be | mm | wheel circumference ("tire length") | yosle's APK labels 106/108 as MOS voltages; data (1000 mm, 23) fits the PDF |
| 108 | 0x6C | 2 | u16be | count | pulses per wheel revolution | PDF says "per week", a mistranslation of 一周 |
| 110 | 0x6E | 1 | u8 | | relay switch | "do not display" |
| 111 | 0x6F | 4 | i32be | 1 W | power | 9999 = placeholder on 2021 boards; compute V x I |
| 115 | 0x73 | 1 | u8 | | max cell number | |
| 116 | 0x74 | 2 | u16be | 0.001 V | max cell voltage | |
| 118 | 0x76 | 1 | u8 | | min cell number | |
| 119 | 0x77 | 2 | u16be | 0.001 V | min cell voltage | |
| 121 | 0x79 | 2 | u16be | 0.001 V | average cell voltage | |
| 123 | 0x7B | 1 | u8 | | cell count | read it before decoding cells (the app reads it last, a bug) |
| 124 | 0x7C | 2 | u16be | 0.1 V | discharge MOSFET D-S voltage | |
| 126 | 0x7E | 2 | u16be | 0.1 V | discharge MOSFET gate drive | |
| 128 | 0x80 | 2 | u16be | 0.1 V | charge MOSFET gate drive | |
| 130 | 0x82 | 2 | u16be | raw | comparator initial value at zero current | |
| 132 | 0x84 | 4 | u32be | bits | balancing mask, bit 0 = cell 1 | |
| 136 | 0x88 | 2 | u16be | bits | system log word: bits 0..4 status, 5..9 battery number, 10..14 sequence, 15 = 1 discharge / 0 charge | |
| 138 | 0x8A | 2 | u16be | | checksum = sum(bytes 4..137) & 0xFFFF | |

---

## 7. Settings

### 7.1 ANT_NEW parameter map

Read with function 0x02, write with function 0x22, then `0x51/0x07` save. Address = byte address, registers are 2 bytes
wide. Value encoding: `raw = round(value / scale)`, little endian. u32 registers use length 4 (low word at the lower
address). Source keys: E = ESPHome `SETTINGS_REGISTERS`; B = vendor PC tool lists by bchiu (ESPHome issue #18);
Y = 2024 Android app map (yosle `params_full.json`, 186 entries); C = value seen in a capture. Ranges and factory
defaults are not documented anywhere (the app map stores 0 as default); the "seen" column gives values read from real
packs (16ZMUB LiFePO4 16S capture / 24BHUB ternary dump of bchiu).

Voltage group (block 0, 52 bytes):

| Addr | Hex | Parameter | Type | Scale | Unit | Seen 16ZMUB / 24BHUB | Src |
|---|---|---|---|---|---|---|---|
| 0 | 0x0000 | cell overvoltage protection | u16 | 0.001 | V | 3.650 / 4.150 | E B Y C |
| 2 | 0x0002 | cell overvoltage recovery | u16 | 0.001 | V | 3.550 / 4.100 | E B Y C |
| 4 | 0x0004 | cell overvoltage protection, level 2 | u16 | 0.001 | V | 3.800 / 4.300 | E B Y C |
| 6 | 0x0006 | cell overvoltage recovery, level 2 | u16 | 0.001 | V | 3.700 / 4.200 | E B Y C |
| 8 | 0x0008 | pack overvoltage protection | u16 | 0.1 | V | 60.8 / 60.0 | E B Y C |
| 10 | 0x000A | pack overvoltage recovery | u16 | 0.1 | V | 58.4 / 58.0 | E B Y C |
| 12 | 0x000C | cell undervoltage protection | u16 | 0.001 | V | 2.100 / 2.900 | E B Y C |
| 14 | 0x000E | cell undervoltage recovery | u16 | 0.001 | V | 2.500 / 3.200 | E B Y C |
| 16 | 0x0010 | cell undervoltage protection, level 2 | u16 | 0.001 | V | 2.000 / 2.600 | E B Y C |
| 18 | 0x0012 | cell undervoltage recovery, level 2 | u16 | 0.001 | V | 2.500 / 2.900 | E B Y C |
| 20 | 0x0014 | pack undervoltage protection | u16 | 0.1 | V | 20.0 / 36.0 | E B Y C |
| 22 | 0x0016 | pack undervoltage recovery | u16 | 0.1 | V | 20.0 / 38.0 | E B Y C |
| 24 | 0x0018 | cell voltage difference protection | u16 | 0.001 | V | 0.800 / 1.000 | E B Y C |
| 26 | 0x001A | cell voltage difference recovery | u16 | 0.001 | V | 0.600 / 0.800 | E B Y C |
| 28, 30 | 0x001C, 0x001E | reserved | | | | 0xFFFF | Y C |
| 32 | 0x0020 | cell overvoltage warning | u16 | 0.001 | V | 3.600 / 4.250 | E B Y C |
| 34 | 0x0022 | cell overvoltage warning recovery | u16 | 0.001 | V | 3.500 / 4.200 | E B Y C |
| 36 | 0x0024 | pack overvoltage warning | u16 | 0.1 | V | 58.4 / 60.0 | E B Y C |
| 38 | 0x0026 | pack overvoltage warning recovery | u16 | 0.1 | V | 55.2 / 58.0 | E B Y C |
| 40 | 0x0028 | cell undervoltage warning | u16 | 0.001 | V | 3.000 / 3.200 | E B Y C |
| 42 | 0x002A | cell undervoltage warning recovery | u16 | 0.001 | V | 3.100 / 3.300 | E B Y C |
| 44 | 0x002C | pack undervoltage warning | u16 | 0.1 | V | 20.0 / 36.0 | E B Y C |
| 46 | 0x002E | pack undervoltage warning recovery | u16 | 0.1 | V | 20.0 / 38.0 | E B Y C |
| 48 | 0x0030 | cell voltage difference warning | u16 | 0.001 | V | 0.600 / 0.800 | E B Y C |
| 50 | 0x0032 | cell voltage difference warning recovery | u16 | 0.001 | V | 0.400 / 0.700 | E B Y C |
| 52, 54 | 0x0034, 0x0036 | reserved | | | | 0xFFFF | C |

Temperature group (block 56, 44 bytes). Only in Y; bchiu marked the PC tool Temperature tab "not implemented". Signedness:
the newer app decodes write echoes of addresses 68..98 as i16 (ESPHome issue #18 excerpt); treat 56..66 as u16 and
68..98 as i16 (**unverified**).

Hardware note (2026-11-23): on an ANT-BLE20PHUB the whole block read plausible values. ubms writes it since then (u16 for
56..66, i16 for 68..94, function 0x22 with the length of one register, then 0x51/0x07 save, like the other registers) and
relies on the read-back of every write; no capture of the vendor app writing this block is known. The battery ID (262,
32 ASCII bytes) is written the same way as one 32 byte write, NUL padded, printable ASCII only.

| Addr | Hex | Parameter | Type | Unit |
|---|---|---|---|---|
| 56 | 0x0038 | battery high temperature, charge protection | u16 | degC |
| 58 | 0x003A | battery high temperature, charge recovery | u16 | degC |
| 60 | 0x003C | battery high temperature, discharge protection | u16 | degC |
| 62 | 0x003E | battery high temperature, discharge recovery | u16 | degC |
| 64 | 0x0040 | MOSFET (power stage) high temperature protection | u16 | degC |
| 66 | 0x0042 | MOSFET high temperature recovery | u16 | degC |
| 68 | 0x0044 | battery low temperature, charge protection | i16 | degC |
| 70 | 0x0046 | battery low temperature, charge recovery | i16 | degC |
| 72 | 0x0048 | battery low temperature, discharge protection | i16 | degC |
| 74 | 0x004A | battery low temperature, discharge recovery | i16 | degC |
| 76 | 0x004C | charge high temperature warning | i16 | degC |
| 78 | 0x004E | charge high temperature warning recovery | i16 | degC |
| 80 | 0x0050 | discharge high temperature warning | i16 | degC |
| 82 | 0x0052 | discharge high temperature warning recovery | i16 | degC |
| 84 | 0x0054 | MOSFET high temperature warning | i16 | degC |
| 86 | 0x0056 | MOSFET high temperature warning recovery | i16 | degC |
| 88 | 0x0058 | charge low temperature warning | i16 | degC |
| 90 | 0x005A | charge low temperature warning recovery | i16 | degC |
| 92 | 0x005C | discharge low temperature warning | i16 | degC |
| 94 | 0x005E | discharge low temperature warning recovery | i16 | degC |
| 96, 98 | 0x0060, 0x0062 | reserved | | |

Current group (block 104, 32 bytes):

| Addr | Hex | Parameter | Type | Scale | Unit | Src |
|---|---|---|---|---|---|---|
| 104 | 0x0068 | charge overcurrent protection | u16 | 0.1 | A | E B Y C (write 50.0 A) |
| 106 | 0x006A | charge overcurrent protection delay | u16 | 1 | s | E B Y C |
| 108 | 0x006C | discharge overcurrent protection | u16 | 0.1 | A | E B Y C (write 300.0 A) |
| 110 | 0x006E | discharge overcurrent protection delay | u16 | 1 | s | E B Y C |
| 112 | 0x0070 | discharge overcurrent protection, level 2 | u16 | 0.1 | A | E B Y |
| 114 | 0x0072 | discharge overcurrent level 2 delay | u16 | 1 | ms (E, B) | E B Y |
| 116 | 0x0074 | short circuit protection current | u16 | 1 | A | E B Y |
| 118 | 0x0076 | short circuit protection delay | u16 | 1 | us | E B Y |
| 120, 122 | 0x0078, 0x007A | reserved | | | | Y |
| 124 | 0x007C | charge overcurrent warning | u16 | 0.1 | A | E B Y |
| 126 | 0x007E | charge overcurrent warning recovery | u16 | 0.1 | A | E B Y |
| 128 | 0x0080 | discharge overcurrent warning | u16 | 0.1 | A | E B Y |
| 130 | 0x0082 | discharge overcurrent warning recovery | u16 | 0.1 | A | E B Y |
| 132 | 0x0084 | SOC low warning, level 1 | u16 | 1 | % | E B Y |
| 134 | 0x0086 | SOC low warning, level 2 | u16 | 1 | % | E B Y |
| 136, 138 | 0x0088, 0x008A | reserved | | | | Y |

Balance group (block 140, 12 bytes):

| Addr | Hex | Parameter | Type | Scale | Unit | Src |
|---|---|---|---|---|---|---|
| 140 | 0x008C | balance limit voltage (no balancing above) | u16 | 0.001 | V | E B Y |
| 142 | 0x008E | balance start voltage while charging | u16 | 0.001 | V | E B Y |
| 144 | 0x0090 | balance start voltage difference | u16 | 0.001 | V | E B Y |
| 146 | 0x0092 | balance stop voltage difference | u16 | 0.001 | V | E B Y |
| 148 | 0x0094 | balance current | u16 | 1 | mA (E, B; Y unit "N") | E B Y |
| 150 | 0x0096 | balance charging current | u16 | 0.1 | A | E B Y |

Battery group (block 152, 142 bytes requested; firmware clamps at address 260, yosle):

| Addr | Hex | Parameter | Type | Scale | Unit | Src / notes |
|---|---|---|---|---|---|---|
| 152 | 0x0098 | cell type | u16 | | enum | E B Y; value encoding **unverified** (status uses 0xFAF1.. codes, table 9.7). Prefer actions 0x26/0x27/0x28 |
| 154 | 0x009A | cell count (series) | u16 | 1 | S | E B Y |
| 156 | 0x009C | undervoltage internal resistance compensation | u16 | 0.1 (Y) or 1 (E) | mOhm | scale disputed |
| 158 | 0x009E | automatic shutdown voltage | u16 | 0.001 | V | E B Y |
| 160 | 0x00A0 | maximum requested charge current | u16 | 0.1 | A | E B Y |
| 162 | 0x00A2 | physical (nominal) capacity | u32, len 4 | 1 (E, B) or 1e-6 (Y) | Ah | unit disputed, 7.3 |
| 166 | 0x00A6 | remaining capacity | u32, len 4 | 1 (E, B) or 1e-6 (Y) | Ah | used to set SOC, 7.3 |
| 170 | 0x00AA | total cycle capacity | u32, len 4 | 1 (E, B) or 1e-6 (Y) | Ah | |
| 174..194 | 0x00AE..0x00C2 | SOC versus OCV table: cell voltage at 100 %, 90 %, ..., 0 % (11 registers) | u16 | 0.001 | V | Y |
| 196 | 0x00C4 | SOC calibration method | u16 | | enum | E B Y; values unknown |
| 198..260 | 0x00C6..0x0104 | connection (wire) resistance cell 1..32 | u16 | 0.1 | mOhm | Y |
| 262..293 | 0x0106..0x0125 | pack ID / battery ID, 32 ASCII bytes | bytes | | | B Y C (`DOGATI`) |
| 294, 296 | 0x0126, 0x0128 | reserved | | | | Y |

System group (block 298, 34 bytes, Y only):

| Addr | Hex | Parameter | Type | Scale | Unit |
|---|---|---|---|---|---|
| 298 | 0x012A | current sensor range | u16 | 0.1 | A |
| 300 | 0x012C | no current automatic standby time | u16 | 1 | s |
| 302 | 0x012E | Bluetooth address code | u16 | | |
| 304 | 0x0130 | static current consumption | u16 | 0.1 | mA |
| 306 | 0x0132 | battery temperature sensor mask | u16 | | bits |
| 308 | 0x0134 | startup (precharge) current | u16 | 1 | A |
| 310 | 0x0136 | system reference voltage | u16 | 0.001 | V |
| 312 | 0x0138 | pack voltage conversion parameter | u16 | | |
| 314 | 0x013A | system running time | u16 | | |
| 316 | 0x013C | discharge forbidden duration | u16 | 1 | min |
| 318 | 0x013E | charge forbidden duration | u16 | 1 | min |
| 320 | 0x0140 | discharge allowed duration | u16 | 1 | min |
| 322 | 0x0142 | charge allowed duration | u16 | 1 | min |
| 324, 326 | 0x0144, 0x0146 | jumper configuration low / high | u16 | | |
| 328 | 0x0148 | automatic off time | u16 | 1 | h |

Passwords (write with 0x22 to change, 0x23 to authenticate; Y): level 1 at 330 (0x014A, 8 bytes), level 2 at 338
(0x0152), level 3 at 346 (0x015A), level 4 at 354 (0x0162), level 5 at 362 (0x016A, 12 bytes). yosle also lists 374
without detail.

Other group (block 378, 18 bytes):

| Addr | Hex | Parameter | Type | Unit | Src |
|---|---|---|---|---|---|
| 378 | 0x017A | wheel circumference ("tire length") | u16 | mm | E B Y |
| 380 | 0x017C | pulses per wheel revolution | u16 | count | E B Y |
| 382 | 0x017E | number of slave modules | u16 | count | E B Y |
| 384..394 | 0x0180..0x018A | attached parameters 1..6 | u16 | | Y |

Identity and factory blocks (read only for a client; Y):

| Addr | Len | Content |
|---|---|---|
| 470 | 32 | "customize" block, no parameters defined |
| 528 | 16 | boot loader version string (`BT22AAUB-240606A`) |
| 544 | 16 | check code (binary) |
| 576 | 16 | system id / check code |
| 592..618 | 2 each | UART 1..4 baud, CAN baud, function config 1 and 2, current info, max cell number (608), temperature sensor count (610), reference voltage calibration (612, 0.001 V), pack voltage calibration (614), current sensor calibration (616, 0.1), DTU serial (618). Only 608..614 exist on the 22AAUB |
| 620 | 32 | hardware version (16) + software version (16): the device info block |
| 636 | 16 | user facing software version |
| 700..706 | 2 each | ex factory, ex factory time, mail address, ANT address |

### 7.2 Dependencies (ANT_NEW)

No source documents firmware side validation. Logical constraints a UI should enforce (derived from parameter
semantics, **unverified** on hardware):

* overvoltage: protection > recovery; level 2 protection > level 1 protection; warning <= protection.
* undervoltage: protection < recovery; level 2 protection < level 1 protection; warning >= protection.
* pack thresholds are consistent with `cell threshold x cell count`.
* temperature: high protection > high recovery; low protection < low recovery.
* balance: stop difference < start difference; start voltage <= limit voltage.
* SOC level 2 warning <= level 1 warning.
* Read back after write (0x42 echo plus a fresh 0x02 read) and compare.

### 7.3 Capacity and SOC (ANT_NEW)

* There is no dedicated "set SOC" command in any source. SOC follows remaining capacity / physical capacity. Write
  register 166 (remaining) to adjust SOC, 162 for the nominal capacity.
* Unit dispute: ESPHome and bchiu use scale 1 Ah; the 2024 app map uses iTimes 1e6 (micro Ah), the same unit as the
  status frame fields. No capture of these registers exists. Before writing, read 162 (length 4) and compare with the
  status field "full capacity": raw equal to status raw means micro Ah, raw equal to status Ah means Ah.
* Counters: actions 0x20..0x25 clear cycle Ah and time counters.

### 7.4 ANT_OLD parameter list

Read: `5A5A NN 0000 NN`. Write: `A5A5 NN VH VL sum` then `A5A5FF0000FF`, after the password frames. Value u16be.
Sources: vendor PDF (`AtyParam.java` list) = P, VBMS wiki = V, decompiled enum in ESPHome issue #18 = J, bchiu list in
ESPHome issue #18 = B. Scales disagree in a few rows (marked). None of these writes is captured except the control
addresses.

| N | Parameter | Scale J | Scale B | Unit | Src |
|---|---|---|---|---|---|
| 1 | cell overvoltage warning | 0.001 | 0.001 | V | P V J B |
| 2 | cell undervoltage warning | 0.001 | 0.001 | V | P V J B |
| 3 | cell overvoltage protection | 0.001 | 0.001 | V | P V J B |
| 4 | cell undervoltage protection | 0.001 | 0.001 | V | P V J B |
| 5 | cell overvoltage recovery | 0.001 | 0.001 | V | P V J B |
| 6 | cell undervoltage recovery | 0.001 | 0.001 | V | P V J B |
| 7 | pack overvoltage protection | 0.1 | 0.1 | V | P V J B |
| 8 | pack undervoltage protection | 0.1 | 0.1 | V | P V J B |
| 9 | charge overcurrent protection | 0.1 | 0.1 | A | P V J B |
| 10 | charge overcurrent delay | 1 | 1 | s | P V J B |
| 11 | discharge overcurrent protection | 0.1 | 0.1 | A | P V J B |
| 12 | discharge overcurrent delay | 1 | 1 | s | P V J B |
| 13 | balance voltage limit | 0.001 | 0.001 | V | P V J B |
| 14 | balance start voltage while charging | 0.001 | 0.001 | V | P V J B |
| 15 | balance voltage difference (window) | 0.001 | 0.001 | V | P V J B |
| 16 | balance current | 10 | 10 | mA (PDF: "1-20") | P V J B |
| 17 | system reference voltage | 0.001 | 0.001 | V | P V J B |
| 18 | current sensor range | 0.1 | 0.1 | A | P V J B |
| 19 | start (power on) current | 1 | 1 | A | P V J B |
| 20 | short circuit protection current | 1 | 0.1 | A | disputed |
| 21 | short circuit protection delay | 1 | 1 | us | P V J B |
| 22 | no current automatic standby time | 1 | 1 | s | P V J B |
| 23 | total voltage AD conversion parameter | 1 | 1 | | P V J B |
| 24 | cell count | 1 | 1 | S | P V J B |
| 25 | battery high temperature charge protection | 1 | 1 | degC | P V J B |
| 26 | battery high temperature charge recovery | 1 | 1 | degC | P V J B |
| 27 | battery high temperature discharge protection | 1 | 1 | degC | P V J B |
| 28 | battery high temperature discharge recovery | 1 | 1 | degC | P V J B |
| 29 | MOSFET high temperature protection | 1 | 1 | degC | P V J B |
| 30 | MOSFET high temperature recovery | 1 | 1 | degC | P V J B |
| 31, 32 | physical capacity, u32 split: 31 = low word, 32 = high word (names in J and dbus-serialbattery) | 1e-6 | | Ah | P V J |
| 33, 34 | remaining capacity, low / high word | 0.001 (J) or 1e-6 (P) | | Ah | disputed |
| 35, 36 | total cycle capacity, low / high word | 0.001 | | Ah | P V J |
| 37 | charge low temperature protection | 1 | | degC | J only |
| 38 | charge low temperature recovery | 1 | | degC | J only |
| 39 | discharge low temperature protection | 1 | | degC | J only |
| 40 | discharge low temperature recovery | 1 | | degC | J only |
| 41 | wheel circumference | 1 | 1 | mm | P V J B |
| 42 | pulses per wheel revolution | 1 | 1 | | P V J B |
| 43 | automatic shutdown voltage | 0.001 | 0.001 | V | J B |
| 44 | cell voltage difference protection | 0.001 | 0.001 | V | J B |
| 45 | number of slave modules | 1 | 1 | | J B |
| 46 | undervoltage internal resistance compensation | 0.1 | 1 | mOhm | disputed |
| 47 | static current consumption | 0.1 | 10 | mA | disputed |
| 48 | temperature sensor mask | 1 | 1 | | J B |
| 49 | Bluetooth address code | 1 | 1 | | J B |
| 51..74 | internal resistance cell 1..24 | | 1 | mOhm | P B |
| 90 | firmware version | 1 | 1 | | J B |
| 100 | running time | 1 | | | P J |
| 150 | initial SOC | 1 | | % | J only, **unverified** |
| 162 | discharge overcurrent level 2 | 0.1 | 0.1 | A | J B |
| 163 | discharge overcurrent level 2 delay | 1 | 10 | J unit "us", B unit ms | disputed |
| 241..244 | password characters (2 per address, u16be = char1 << 8 + char2) | | | | captures |
| 245 | password check / write status (`A5A5F50001F6` seen as rejection) | | | | J, capture |

### 7.5 Setting the SOC (ANT_OLD)

Write remaining capacity (33/34) or initial SOC (150). Neither is captured; **unverified**.

---

## 8. Controls and actions

ANT_NEW: section 5.5. Switch semantics used by ESPHome, batmon-ha and the PC tool:

| Switch | On | Off | State readback |
|---|---|---|---|
| Charging | 0x51 addr 0x06 | 0x51 addr 0x04 | charge MOS state (status `o+13`) == 1 |
| Discharging | 0x51 addr 0x03 | 0x51 addr 0x01 | discharge MOS state (status `o+12`) == 1 |
| Balancer (manual balance) | 0x51 addr 0x0D | 0x51 addr 0x0E | balance state == 4 (seen) or 5 |
| Buzzer | 0x51 addr 0x1E | 0x51 addr 0x1F | no readback known |
| Bluetooth | 0x51 addr 0x1D | 0x51 addr 0x1C | warning bit 38 "Bluetooth off" (Y) |

After "off" commands the MOS state becomes 0x0F and protection bit 17 (discharge) or 21 (charge) is set (24BHUB capture).
Buttons: current zero 0x08, restart 0x09, shutdown 0x0B, factory reset 0x0C, clear log 0x0F, Bluetooth init 0x10,
counters 0x20..0x25, default sets 0x26/0x27/0x28, reset hardware 0x2A, save customer data 0x2C, user parameters 0x2D,
save 0x07.

ANT_OLD control addresses (value 0 unless noted; always followed by apply `A5A5FF0000FF`; vendor PDF "BMS control
address", VBMS wiki, ESPHome):

| N | Hex | Action |
|---|---|---|
| 240 | 0xF0 | apply LTO parameter set (ESPHome comment, J) |
| 241..245 | 0xF1..0xF5 | password, password check |
| 246 | 0xF6 | change MAC address (ESPHome comment, **unverified**) |
| 247 | 0xF7 | BMS power off |
| 248 | 0xF8 | current to zero (ESPHome: "clear counter") |
| 249 | 0xF9 | discharge MOSFET: value 1 = on, 0 = off |
| 250 | 0xFA | charge MOSFET: value 1 = on, 0 = off |
| 251 | 0xFB | apply LiFePO4 parameter set |
| 252 | 0xFC | automatic balancing (toggle) |
| 253 | 0xFD | factory default settings |
| 254 | 0xFE | reboot |
| 255 | 0xFF | apply (commit previous write) |

---

## 9. Code tables

### 9.1 ANT_NEW system state (status offset 7)

| Value | Meaning | Evidence |
|---|---|---|
| 0 | none / unknown | Y |
| 1 | idle | captures (16ZMUB at rest) |
| 2 | charging | issue #78 frame: state 2 with -12.6 A |
| 3 | standby | issue #174 frame: state 3, warning bit 26 "sleep" |
| 4 | discharging | 24BHUB capture: state 4 with +2.2 A and warning bit 19 "discharging"; ant-bms-web vector +18 A |
| 5 | fault / exception | Y, E |

ESPHome uses 3 = discharge, 4 = standby; contradicted by the captures above.

### 9.2 ANT_NEW discharge MOSFET state (status `o+12`)

Same table in E (issue #52) and Y.

| Value | Meaning |
|---|---|
| 0 | off |
| 1 | on |
| 2 | cell undervoltage protection |
| 3 | overcurrent protection |
| 4 | overcurrent level 2 |
| 5 | pack undervoltage |
| 6 | battery over temperature |
| 7 | MOSFET over temperature |
| 8 | abnormal current |
| 9 | balance wire disconnected |
| 10 | board over temperature |
| 11 | charge MOSFET on (charger connected) |
| 12 | short circuit protection |
| 13 | discharge MOSFET abnormal |
| 14 | failed to open (start exception) |
| 15 | manually turned off (verified: 24BHUB capture after `0x51/0x01`) |
| 16 | undervoltage level 2 |
| 17 | low temperature protection |
| 18 | voltage difference exceeded |
| 19 | self test error |

### 9.3 ANT_NEW charge MOSFET state (status `o+13`)

E (issue #52, ESPHome `CHARGE_MOSFET_STATUS`) has a reserved entry at 11; Y, aiobmsble and ant-bms-web omit it, which
shifts their entries 11..18 down by one. The 24BHUB capture shows 15 after `0x51/0x04` (charge off), which matches E
("manually turned off") and contradicts Y (15 = "level 2 overvoltage"). Use E:

| Value | Meaning |
|---|---|
| 0 | off |
| 1 | on |
| 2 | cell overvoltage protection |
| 3 | overcurrent protection |
| 4 | battery full |
| 5 | pack overvoltage |
| 6 | battery over temperature |
| 7 | MOSFET over temperature |
| 8 | abnormal current |
| 9 | balance wire disconnected |
| 10 | board over temperature |
| 11 | reserved |
| 12 | failed to open |
| 13 | discharge MOSFET abnormal |
| 14 | waiting |
| 15 | manually turned off (verified) |
| 16 | overvoltage level 2 |
| 17 | low temperature protection |
| 18 | voltage difference exceeded |
| 19 | reserved |
| 20 | self test error |

### 9.4 ANT_NEW balance state (status `o+14`)

| Value | Meaning | Src |
|---|---|---|
| 0 | off | E Y |
| 1 | exceeding limit triggers balance | E Y |
| 2 | voltage difference while charging | E Y |
| 3 | balance over temperature | E Y |
| 4 | automatic balancing (also shown after manual balance on, capture) | E Y |
| 5 | manual balancing | Y |
| 10 | board over temperature | E, vendor PDF (old) |

### 9.5 ANT_NEW protection bits (status offsets 10..17, u64le)

From the 2024 app (yosle, ant-bms-web `PROTECT_BITS`). Bits 1, 17 and 21 verified by captures; others **unverified**.

| Bit | Meaning | Bit | Meaning |
|---|---|---|---|
| 0 | cell type setting | 23 | manual charge MOS 3 off |
| 1 | cell overvoltage (verified) | 24 | manual charge MOS 4 off |
| 2 | cell overvoltage level 2 | 25 | open line |
| 3 | pack overvoltage | 26 | current error |
| 4 | cell undervoltage | 27 | discharge MOS error |
| 5 | cell undervoltage level 2 | 28 | charge MOS error |
| 6 | pack undervoltage | 29 | internal communication error |
| 7 | cell voltage difference | 30 | precharge failure |
| 8 | charge high temperature | 31 | starting |
| 9 | discharge high temperature | 32 | check 1 |
| 10 | MOS high temperature | 33 | check 2 |
| 11 | charge low temperature | 34 | charger connected |
| 12 | discharge low temperature | 35 | DTU lost |
| 13 | charge overcurrent | 36 | ignition prevention |
| 14 | discharge overcurrent | 37 | check 3 |
| 15 | discharge overcurrent level 2 | 38 | firmware upgrade required |
| 16 | short circuit | 39 | relay precharge failure |
| 17 | manual discharge MOS 1 off (verified) | 40 | relay stuck |
| 18 | manual discharge MOS 2 off | 41 | abnormal discharge fuse |
| 19 | manual discharge MOS 3 off | 42 | abnormal charge fuse |
| 20 | manual discharge MOS 4 off | 43 | module loss |
| 21 | manual charge MOS 1 off (verified) | 44 | device expired |
| 22 | manual charge MOS 2 off | 45..63 | unknown |

### 9.6 ANT_NEW warning / status bits (status offsets 18..25, u64le)

Same origin. Verified by captures: 7, 12, 13, 19, 23, 24, 26, 29.

| Bit | Meaning | Bit | Meaning |
|---|---|---|---|
| 0 | cell overvoltage warning | 23 | charge MOS on (verified) |
| 1 | pack overvoltage warning | 24 | discharge MOS on (verified) |
| 2 | cell undervoltage warning | 25 | balancing on |
| 3 | pack undervoltage warning | 26 | sleep (verified, with state 3) |
| 4 | cell difference warning | 27 | balance limit |
| 5 | charge high temperature warning | 28 | balance difference |
| 6 | discharge high temperature warning | 29 | automatic balancing (verified) |
| 7 | charge low temperature warning (verified at 1 to 2 degC) | 30 | balance high temperature |
| 8 | discharge low temperature warning | 31 | cell or pack voltage protection active |
| 9 | MOS high temperature warning | 32 | temperature protection active |
| 10 | charge overcurrent warning | 33 | system error |
| 11 | discharge overcurrent warning | 34 | DTU lost |
| 12 | SOC low level 1 (verified at 4 %) | 35 | balance test |
| 13 | SOC low level 2 (verified at 4 %) | 36 | electric heating |
| 14 | wrong cell voltage | 37 | forced output |
| 15 | wrong cell count | 38 | Bluetooth off |
| 16 | precharge failure | 39 | relay precharging |
| 17 | battery full | 40 | MOS precharging |
| 18 | charging | 41 | charge relay on |
| 19 | discharging (verified) | 42 | discharge relay on |
| 20 | CAN charger input | 43 | crystal (XTAL) error |
| 21 | RS485 charger input | 44 | forced charging |
| 22 | charger input | 45..63 | unknown |

### 9.7 Battery type (ANT_NEW status `o+60`)

| Value | Meaning | Src |
|---|---|---|
| 0xFAF1 (64241) | ternary lithium (NMC) | E Y, captures |
| 0xFAF2 (64242) | LiFePO4 | E Y, captures |
| 0xFAF3 (64243) | lithium titanate (LTO) | E Y, capture (2.3 V cells) |
| 0xFAF4 (64244) | custom | E Y |
| 0xFAF5 (64245) | none | Y |
| 0xFAF6 (64246) | sodium ion | Y |

### 9.8 ANT_OLD charge MOSFET state (offset 103)

Vendor PDF and VBMS wiki: 0 off, 1 on, 2 overcharge (cell) protection, 3 overcurrent, 4 battery full, 5 pack
overvoltage, 6 battery over temperature, 7 MOSFET over temperature, 8 abnormal current, 9 balance wire disconnected,
10 board over temperature, 13 discharge MOSFET abnormal, 15 manually off. 11, 12, 14 undefined.

### 9.9 ANT_OLD discharge MOSFET state (offset 104)

0 off, 1 on, 2 cell overdischarge, 3 overcurrent, 5 pack overdischarge, 6 battery over temperature, 7 MOSFET over
temperature, 8 abnormal current, 9 balance wire disconnected, 10 board over temperature, 11 charge MOSFET on, 12 short
circuit, 13 discharge MOSFET abnormal, 14 start exception, 15 manually off. 4 undefined.

### 9.10 ANT_OLD balance state (offset 105)

0 off, 1 exceeding limit triggers balance, 2 voltage difference too big while charging, 3 balance over temperature,
4 automatic balance, 10 board over temperature.

---

## 10. Device info

| Item | ANT_NEW | ANT_OLD |
|---|---|---|
| Model / hardware version | device info 0x12 at 0x026C, bytes 6..21 | not available |
| Software version | device info bytes 22..37; also parameter block 636 (16 bytes) | parameter 90 "firmware version" (**unverified**) |
| Boot loader version | parameter block 528 (16 bytes) | |
| Pack ID | parameter block 262 (32 bytes ASCII) | |
| Chip id | function 0x04 (12 bytes), `SysID2` with address 4096 | |
| Cell count | status offset 9; register 154 | status offset 123; parameter 24 |
| NTC count | status offset 8 | fixed 6 slots (MOS, balancer, 4 NTC) |
| Bluetooth address code | register 302 | parameter 49 |
| Permission level | status offset 6 | |

---

## 11. Detection

### 11.1 Candidates

* BLE: name (trimmed) starts with `ANT-BLE` or `ANT@BLE`, advertises service 0xFFE0 (often also 0xFEE7). aiobmsble
  matches `ANT?BLE24*`, `ANT?BLE3*` (new) and `ANT-BLE[01]*`, `ANT-BLE22*` (legacy); that split is a heuristic and is
  contradicted by the `ANT-BLE22AAUB` units (NEW). ESPHome's scanner example lists all names starting with `ANT-`.
* Classic Bluetooth: `BMS-ANT*` (SPP, OLD protocol). Not reachable with Web Bluetooth.
* UART: no identification frame; use the probes.

### 11.2 Probe sequence (read only, safe)

1. Subscribe to notifications (BLE) or open the port at 19200 8N1.
2. Send `7EA1010000BE1855AA55`. Accept as ANT_NEW when within 1.5 s a frame validates: `7E A1 11 00 00`, CRC ok, `AA 55`
   tail, `1 <= n <= 32`, `m <= 6`, `r` = 106 + 2n + 2m (+12 or +14). Retry once (the first request is sometimes lost).
3. Otherwise send `DBDB00000000` (BLE) or `5A5A00000101` then `DBDB00000000` (UART). Accept as ANT_OLD when a 140 byte
   frame starts `AA 55 AA FF`, the 16 bit sum over 4..137 matches 138..139 and byte 123 is 1..32.
4. On UART with no answer, repeat at 9600 baud.
5. A board that answers both is ANT_NEW; use the old frame only as a fallback (power field unusable).
6. Optionally read device info (`7EA1026C022058C4AA55`) to show model and version.

### 11.3 Distinguishing other BMS on FFE0/FFE1

* JK BMS uses the same service and characteristic (aiobmsble `jikong_bms.py`: service `ffe0`, char `ffe1`), but answers
  start `55 AA EB 90` and commands start `AA 55 90 EB`. An ANT probe answer always starts `7E A1` (NEW) or `AA 55 AA FF`
  (OLD). Note: the OLD answer header and JK command header share `AA 55`; check all four bytes.
* Many other devices use HM-10 style FFE0/FFE1 bridges; rely on the validated probe answer, never on UUIDs alone.
* Never send write (0x22, 0x51, `A5 A5`) frames during detection.

---

## 12. Pitfalls and quirks

### 12.1 Source disagreements and resolution

| Topic | Disagreement | Resolution and evidence |
|---|---|---|
| NEW MOSFET state order | ESPHome: charge at `o+12`, discharge at `o+13`. yosle, aiobmsble, batmon-ha, ant-bms-web, C# port of the PC tool: discharge first | Discharge first. 24BHUB capture: after discharge off only, `o+12` = 0x0F and `o+13` = 0x01 with protection bit 17; batmon-ha 14S and 8S frames show `01 02` with protection bit 1 (cell overvoltage = charge MOS state 2) |
| NEW system state 3 and 4 | ESPHome 3 = discharge, 4 = standby; yosle 3 = standby, 4 = discharging | yosle (section 9.1 evidence) |
| NEW charge MOS enum above 10 | ESPHome has reserved at 11 and 19; yosle/aiobmsble/ant-bms-web do not | ESPHome table (15 = manual off seen in capture) |
| Current sign | ESPHome publishes raw and calls -10.7 A "discharging" in an OLD test frame; aiobmsble (legacy) and dbus-serialbattery invert the OLD value; batmon-ha documents positive = discharging | Raw value: positive = discharging, negative = charging, both generations. NEW: issue #78 charging at -12.6 A with state 2, 24BHUB discharging at +2.2 A with warning bit 19. OLD: batmon-ha shows remaining charge rising while the frame reads -7.4 / -10.7 A; the issue #28 reporter expected negative power while charging from solar |
| CRC byte order | yosle says "big endian" | same bytes on the wire; describe as CRC-16/MODBUS low byte first |
| Device info length | ESPHome/aiobmsble: "data_len is wrong" | extra section (Case C) explains it |
| OLD temperatures 91..101 | ESPHome: temperature 1..6 | yosle APK and preussal: MOS, balancer, NTC 1..4; 2021 boards report -40 only in the last two slots |
| OLD offsets 106..109 | APK (yosle): MOS voltages | PDF/VBMS/ESPHome: wheel circumference and pulses; data 1000 / 23 fits |
| Auth address | ESPHome/PC tool 0x016A + 12 bytes; yosle 0x014A + 8 bytes; aiobmsble bytes `01 6A` | 0x014A is level 1, 0x016A level 5 (yosle password table); aiobmsble byte order unverified |
| UART baud | vendor PDF 9600; all implementations 19200 | try 19200 first |
| Capacity register unit (162/166/170) | E/B: Ah; Y: micro Ah | unresolved; read and compare (7.3) |
| Totals at `o+62`, `o+66` | ESPHome x 0.001 Ah; yosle unscaled | ESPHome scale fits 2021 firmware data; 2024 data inconclusive |
| Optional status block | yosle and C# port: 12 bytes | 12 bytes on 22AAUB 240510A; 14 bytes (2 unknown) on a 15S 2023 unit and on 22AAUB 241008A |

### 12.2 Other quirks

1. Notifications are not frames; frames can share a notification (3.5).
2. `0x55` inside ASCII versions ("U") breaks naive end detection (3.5).
3. 0x12, 0x42, 0x43 answers carry the extra section; frame length is not `10 + r` for them.
4. Some 2024 firmware streams 0x11 frames continuously after one request (issue #174); rate limit.
5. The BLE module allows one connection and stops advertising while connected; packs may sleep and stop advertising.
6. Weak radio: expect CRC failures; retry reads up to 4 times; split block reads at 64 bytes.
7. The first parameter read after connect can be lost (bchiu).
8. Authenticate (level 5) right before each control; otherwise a MOSFET change may revert after a few seconds
   (batmon-ha on 20PHUB).
9. Keep auth and its write adjacent; serialize all requests.
10. `0xFFFF` registers are "not configured", not 65535.
11. NTC value -40 means "probe absent" (NEW and 2021 boards in OLD mode); 2020 OLD boards report 0 for absent probes.
12. `n` and `m` change all later offsets of the NEW status; never use fixed offsets after byte 33.
13. The NEW status `power` is signed; the vendor app shows huge numbers while charging because it reads it unsigned.
14. Some units report a bogus NTC count (batmon-ha caps it); validate `r` against the formula.
15. The NEW battery type can be 0 on early firmware (issue #18 frame).
16. OLD: power reads 9999 on 2021 boards answering the old request; compute V x I.
17. OLD: physical capacity can be 0 on some 2020 boards; aiobmsble derives it from remaining / SOC.
18. OLD: every write needs the apply frame `A5A5FF0000FF`; wrong or missing password gives three beeps and
    `A5A5F50001F6`; ESPHome requires an 8 character password (a 4 digit value seen by users is the SPP pairing PIN).
19. OLD over UART: the adapter may echo commands or append `FF` bytes; sync on `AA 55 AA FF` and the checksum.
20. The BMS needs VCC on the Comm connector to talk; some display connectors have weak TX levels; pins labelled `A`/`B`
    can be TTL, not RS485 (ESPHome issue #70).
21. Bluetooth off (0x51/0x1C) via BLE cuts the link; only offer it on UART.
22. Names can end with `\r` (`ANT@BLE24CBUB-1231\r`); trim before matching and display.
23. Status byte 26..33 (8 bytes) meaning unknown; preserve raw.
24. The vendor 2024 app parser advances only `10 + r` after a Case C frame and resynchronizes on the next `7E A1`
    (yosle); do not copy that behavior.

---

## 13. References

All accessed 2026-11-18. "ESPHome" below = https://github.com/syssi/esphome-ant-bms (branch `main`).

1. ESPHome `components/ant_bms_ble/ant_bms_ble.cpp`: `assemble()`, `on_status_data_()`, `on_device_info_data_()`,
   `on_settings_data_()`, `build_frame()`, `authenticate_()`, `SETTINGS_REGISTERS`, status enums.
2. ESPHome `components/ant_bms_ble/ant_bms_ble.h`: `crc16()`.
3. ESPHome `components/ant_bms/ant_bms.cpp`: UART NEW protocol, `parse_ant_bms_byte_()`, response comments
   (`Password ACK`, `Register 0x04 ACK`), `read_registers_()`, `build_settings_frame()`; `ant_bms/__init__.py` (19200).
4. ESPHome `components/ant_bms_old/ant_bms_old.cpp` and `.h`: `chksum_()`, `send_()`, `write_register()`,
   `authenticate_()`, `read_registers_()`, 140 byte table; `ant_bms_old/__init__.py` (19200, password length);
   `ant_bms_old/button/__init__.py`, `switch/__init__.py` (control addresses).
5. ESPHome `components/ant_bms_old_ble/ant_bms_old_ble.cpp`: `assemble()`, `read_registers_()` (`DBDB00000000`),
   GATT log comment.
6. ESPHome `components/ant_bms_ble/button/__init__.py`, `switch/__init__.py`, `select/__init__.py`: control and register
   addresses with full frames.
7. ESPHome tests: `tests/components/ant_bms_ble/frames_16s_status.h`, `frames_settings.h`, `ant_bms_ble_test.cpp`;
   `tests/components/ant_bms_old/frames_8s.h`, `ant_bms_old_test.cpp`; `tests/components/ant_bms_old_ble/frames_14s.h`,
   `ant_bms_old_ble_test.cpp`; `tests/esp8266-test-protocols.yaml`, `tests/esp8266-fake-bms-v2021.yaml`.
8. ESPHome `docs/ANT_communication_protocol_EN.1.pdf` (vendor document, OLD protocol, 9600 baud, control addresses,
   parameter list `AtyParam.java`).
9. ESPHome captures: `docs/pdus/btsnoop_hci_ANT-BLE16ZMUB.txt`, `btsnoop_hci_ANT-BLE16ZMUB-reduced.txt`,
   `model2021-req-7ea1010000be1855aa55.txt`, `model2021-req-5a5a00000101.txt`, `model2021-req-dbdb00000000.txt`,
   `model2019-req-dbdb00000000.txt`, `btsnoop_hci_model2019-BMS-ANT24C-rfcomm.txt`; binary btsnoop logs
   `docs/btsnoop_hci_ANT-BLE24BHUB-commands.log`, `btsnoop_hci_ANT-BLE24BHUB.log`, `btsnoop_hci_ANT-BLE16ZMUB.log`,
   `docs/pdus/btsnoop_hci_model2019-BMS-ANT24C-rfcomm.log` (decoded for this spec: ATT discovery, notifications, RFCOMM
   payloads).
10. ESPHome README (supported devices, wiring, OLD status table) and `esp32-ble-example.yaml` (`throttle`).
11. ESPHome issues: #1, #5 (2021 control, passwords), #9 and #40 (connector), #18 (register reads and writes, PC tool
    captures by bchiu, dl4mea frame, decompiled snippets), #20 (PC tool command table, ACKs), #28 (2020 control, echo,
    sign of power), #34 (VCC wake), #37 (power 9999), #52 (enum tables, C# port), #61 (old BLE, SPP, password), #70
    (pins A/B are TTL), #78
    (30S and 15S frames), #84, #87, #90 (levels), #91 (password length), #121, #168 (single connection), #172, #174
    (streaming firmware, 20S frame), #196 (yosle spec announcement).
12. yosle/ant-bms-ble (https://github.com/yosle/ant-bms-ble): `PROTOCOL.md` (frame cases, CRC tables, real time layout,
    enums, bit tables, blocks, auth, app flow, write commands, old appendix), `src/antbms/protocol.py` (`find_frames`,
    `decode_realtime`, `decode_old`, `decode_extra`), `src/antbms/params_full.json` and `params.py` (parameter map),
    `docs/official-app-guide.md`, `tests/test_protocol.py` (Case C frames).
13. yosle/ant-bms-web (https://github.com/yosle/ant-bms-web): `js/ble.js` (Web Bluetooth flow), `js/protocol.js`,
    `tests/protocol.test.js` (real 16S frame, Case C frames).
14. patman15/aiobmsble (https://github.com/patman15/aiobmsble): `aiobmsble/bms/ant_bms.py` (`_FIELDS`, `_PROBLEMS`,
    `_notification_handler`, `_cmd`, `matcher_dict_list`), `aiobmsble/bms/ant_leg_bms.py`, `aiobmsble/test_data/ant_bms.json`,
    `ant_leg_bms.json`, `tests/bms/test_ant_bms.py` (22S frame, device info, password frame),
    `aiobmsble/bms/jikong_bms.py` (JK headers).
15. fl4p/batmon-ha (https://github.com/fl4p/batmon-ha): `bmslib/models/ant.py` (`AntBt`, `_ant_auth_frame`,
    `set_switch`, write without response note), `bmslib/models/ant_uart.py` (`feed_frames`, `decode_old_status`, sign
    note, baud note), `bmslib/test/data/ant_fixtures.py`, `ant_uart_fixtures.py`, `test_ant_decode.py`,
    `test_ant_uart.py`, `test_ant_ble_switch.py`.
16. mr-manuel/venus-os_dbus-serialbattery: `dbus-serialbattery/bms/ant.py` (`command_general`, current inversion,
    capacity read comments), `dbus-serialbattery/dbus-serialbattery.py` (baud 19200).
17. klotztech/VBMS wiki "Serial protocol" (https://github.com/klotztech/VBMS/wiki/Serial-protocol): OLD frames,
    checksums, enums, control and parameter addresses.
18. preussal/ant_bms `get_ant-BMS.py` (OLD temperature mapping), juamiso/ANT_BMS `bms_post.py` (DBDB over RFCOMM),
    RoboDurden/AntBms-Arduino `include.h` (OLD decoding, 19200), imval/AntBMS `AntBMS.cpp` (`5A5A00000101`, 19200),
    Sgw32/BMSCtl `Form1.cs` (DBDB over serial) and `24+32sBMS newer docs.pdf` (user manual: SPP PIN 1234, auto off).
19. patman15/BMS_BLE-HA issues #366, #668, #675 (advertisements, authorization problem, `ANT@BLE` name with CR).
