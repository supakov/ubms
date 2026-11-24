# ubms

Universal BMS viewer and configurator that runs in the browser. It connects to battery management
systems, active balancers and meters over **Bluetooth** (Web Bluetooth) or a **serial port** (Web Serial:
UART and RS485 through USB adapters), shows live data and reads and writes the device settings.

- Works offline: the whole app is one HTML file. Copy it to a phone or laptop and open it.
- Phone friendly: bottom navigation, large touch targets, light and dark themes.
- One core for all devices: a unified data model and a settings schema; device specific
  parameters appear automatically.
- Automatic device type detection, or an explicit choice of brand and protocol.
- Protocol log down to single bytes, with decoded frames, filters and export.
- Languages: English, Ukrainian, Russian, German, French.
- Demo mode with simulated devices that speak the real protocols.

Supported devices: **JK BMS** (Jikong), **ANT BMS**, **Daly BMS**, **JBD BMS** (and the brands built
on it), **Seplos BMS**, **KS BMS** boards (KS48100 and similar, experimental), **Deye** batteries, active balancers from **JK**, **NEEY** (Heltec) and **Daly**, **Atorch** meters
and electronic loads.

| Driver | Devices and protocol | Links | Settings (writable / read only / actions) |
| --- | --- | --- | --- |
| `jk-ble` | JK BMS JK02 (24S and 32S, hardware and firmware 11+ incl. JK-PB) and JK04 | Bluetooth | 32S: 64 / 30 / 9, 24S: 32 / 19 / 0, JK04: 6 / 1 / 0 |
| `jk-pb-rs485` | JK-PB inverter BMS, frame triggers and Modbus writes | RS485 | 47 / 45 / 0 |
| `jk-uart` | JK-B series, "4E 57" protocol on the GPS/UART port | UART, RS485 | 3 / 35 / 0 |
| `ant` | ANT BMS from about 2021 (7E A1 frames) | Bluetooth, UART | 49 + switches / 36 / 14 |
| `ant-legacy` | ANT BMS up to about 2020 (140-byte status) | Bluetooth, UART | switches / 34 / 2 |
| `daly-modbus` | Daly BMS with the newer Modbus protocol (D2 and 0x81 flavours) | Bluetooth, UART, RS485 | D2: 35 / 5 / 3, 0x81: 7 / 50 / 0 |
| `daly` | Daly BMS, classic 13-byte A5 protocol | Bluetooth, UART, RS485 | 37 / 14 / 1 |
| `jk-balancer-ble` | JK active balancers with the JK04 protocol (JK-B2A16S, JK-B2A24S, JK-B5A24S) | Bluetooth | 6 / 1 / 0 |
| `jk-balancer-rs485` | JK-DZ11-B2A24S active balancer, "55 AA" requests and "EB 90" answers | RS485 | 4 / 1 / 0 |
| `atorch` | Atorch DC and AC meters, USB testers and DL24 electronic loads, "FF 55" protocol (load control over PX100 is experimental) | Bluetooth | AC: 2 / 0 / 7, DC: 2 / 0 / 8, USB: 0 / 1 / 8 |
| `neey-ble` | NEEY (Heltec, EnerKey) active balancers GW-24S4EB, EK-24S4EB, EK-16S2EB and newer, two settings layouts | Bluetooth | V1: 6 / 3–4 / 0, V2: 1 / 33 / 0 |
| `daly-balancer` | Daly active balancers, Modbus D2 protocol | Bluetooth, UART | 4 / 2 / 0 |
| `jbd` | JBD (Jiabaida) BMS and the brands built on it (Xiaoxiang app, Overkill Solar and others), "DD A5" protocol | Bluetooth, UART, RS485 | 59 / 26 / 2 (serial 57 / 26 / 2) |
| `jbd-up-rs485` | JBD UP series, Modbus style protocol (experimental) | RS485 | read only |
| `seplos-v3` | Seplos BMS version 3, Modbus RTU | Bluetooth, RS485 | 170 / 8 / 2 |
| `seplos-v2-ble` | Seplos BMS version 2 through its Bluetooth module (binary 7E frames) | Bluetooth | 150 / 1 / 0 |
| `seplos-v2` | Seplos BMS version 2, ASCII "~20" protocol | RS485, RS232 | 150 / 1 / 0 |
| `ks-ble` | KS BMS boards KS48100, KS48200, KS48300 in wall mounted 16S LiFePO4 packs ("lithium battery wifi" app), "7B" frames through the Bluetooth module (experimental) | Bluetooth | 0 / 43 / 0 |
| `deye-rs485` | Deye low voltage batteries (LVESS BMS: SE-G5.1 Pro, SE-F Pro-C, RW-M6.1, AI-W5.1 and others), "AA 55" protocol on the RS485 pins of the PCS port | RS485 | read only |
| `deye-ble` | Deye batteries with Bluetooth (names `BAT...`), the same frames in an AES encrypted session | Bluetooth | read only |
| `deye-can` | Deye batteries over the inverter CAN bus (Pylontech style frames) through an SLCAN USB-CAN adapter; chosen explicitly, never auto-detected | CAN (SLCAN adapter) | read only |

Parameters whose encoding is not confirmed by captures or vendor documents are shown read only.

Tested with real devices (2026-11-23): connecting and reading ANT (ANT-BLE20PHUB), Daly, JK and JBD
BMS. Logins with passwords other than the built-in defaults have not been tested yet.
Most drivers ship a simulator, so the demo mode shows their protocol without hardware (all except
`jk-balancer-ble`, `jk-pb-rs485`, `jk-uart` and `ant-legacy`). See
[docs/protocols](docs/protocols/) for the details and sources.

## Use

Online: **https://ubms-html.vercel.app** (always the latest build of `main`; it also works offline
once opened, and Chrome can install it as an app).

1. Get `ubms.html` from the [releases](https://github.com/supakov/ubms/releases) (or build it:
   `npm install && npm run build`, file `dist/ubms.html`).
2. Open it in Chrome, Edge or another Chromium browser on a computer or an Android phone.
   On iPhone and iPad use a browser with Web Bluetooth support such as Bluefy.
3. Choose Bluetooth or Serial, optionally the BMS type, and connect.

Browser support for device access:

| Platform | Bluetooth | Serial |
| --- | --- | --- |
| Chrome, Edge, Opera on Windows, macOS, Linux, ChromeOS | yes | yes |
| Chrome on Android | yes | recent versions |
| Safari, Firefox | no | no |
| iOS with Bluefy | yes | no |

Device access needs a secure context: `https://`, `http://localhost` or a local file.

> Changing BMS settings is at your own risk. Wrong values can damage cells, the BMS or connected
> equipment.

## Desktop app

`apps/desktop` wraps the same app in Tauri 2 with native Bluetooth (bluest) and serial ports
(serialport): devices are found by an in-app scan and a port list, no browser needed.

Downloads on the [releases](https://github.com/supakov/ubms/releases) page:

| File | System |
| --- | --- |
| `ubms_<version>_x64-setup.exe` | Windows installer (per user) |
| `ubms_<version>_x64_en-US.msi` | Windows installer (MSI, per machine) |
| `ubms_<version>_x64_portable.exe` | Windows, no installation: keeps its data in `ubms-data` next to the exe |
| `ubms_<version>_amd64.deb`, `ubms-<version>-1.x86_64.rpm` | Linux packages |
| `ubms_<version>_amd64.AppImage` | Linux, no installation |
| `ubms_<version>_universal.dmg` | macOS 10.15 or newer, Apple silicon and Intel |
| `ubms_<version>_android.apk` | Android 8 or newer with Chrome: the web app as a full screen app, see [docs/android.md](docs/android.md) |
| `ubms.html` | any Chromium browser, see Use |

The builds are not code signed, so Windows SmartScreen asks for confirmation on the first start.
On macOS open the app the first time with right click, Open (or run
`xattr -dr com.apple.quarantine /Applications/ubms.app`), and allow Bluetooth when asked.
The installed app keeps the chart history in the user profile, the portable one next to itself
(see [docs/decisions/0011-history-and-charts.md](docs/decisions/0011-history-and-charts.md)).
Every push builds the same files as artifacts of the workflow "Desktop"; see
[docs/tauri.md](docs/tauri.md) to build locally.

### Plugins

The desktop app loads drivers for more devices from plugins: one `.js` file per plugin in a
folder named `plugins` next to the app (next to the `.AppImage` file on Linux, next to `ubms.app`
on macOS). Plugin drivers appear in the device type list, in automatic detection and, with a
simulator, in the demo list; More, Plugins shows the folders, what was loaded and what failed.
[docs/plugins.md](docs/plugins.md) describes the file format and the API, and
[examples/plugins/example-bms.js](examples/plugins/example-bms.js) is a complete example for a
made up protocol. A plugin runs with the full rights of the app: install only plugins you trust.

## Develop

```
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # dist/index.html (also as dist/ubms.html), single file
npm run smoke      # headless smoke test with screenshots
```

Read [AGENTS.md](AGENTS.md) and [docs/development.md](docs/development.md) before contributing.

## Documentation

- [Architecture](docs/architecture.md) and [decision records](docs/decisions/)
- [UI structure and navigation](docs/ui.md)
- [Protocols](docs/protocols/)
- [Translations](docs/i18n.md)
- [Desktop app (Tauri)](docs/tauri.md)
- [Desktop plugins](docs/plugins.md)

## Repository layout

```
apps/web               the application
apps/desktop           Tauri 2 desktop shell (Rust: bluest, serialport)
packages/transport     device link layer: Web Bluetooth, Web Serial, Tauri bridge, framing, log
packages/ui            UI kit: Lit components, theme, i18n, router, store
packages/bms-core      BMS model, catalogs, driver contract, detection, session
packages/bms-drivers   protocol drivers with simulators and test vectors
docs                   documentation
examples/plugins       example plugin for the desktop app
scripts                smoke test and checks
```

`packages/transport` and `packages/ui` contain nothing BMS specific and are meant to become a
separate base for other device web apps.

## License

[MIT](LICENSE). The protocol specifications in `docs/protocols` describe public facts from the
sources listed in each document; no third-party source code is copied into this repository.
