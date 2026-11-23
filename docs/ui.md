# UI structure and navigation

The UI is designed for phones first: one hand, a bottom tab bar, large touch targets (44 px),
safe-area insets for notches and home indicators. Wide screens (900 px and more) get a side rail
and multi-column layouts.

## Modes

| Mode | Navigation items | Notes |
| --- | --- | --- |
| Not connected | Connect, Charts, Log, More | Device screens redirect to Connect. Charts shows the stored history. |
| Connected / reconnecting | Overview, Cells, Charts, Settings, More | Overview shows a badge with the number of active alarms. The protocol log is under More (the bottom bar has room for five items). Meters have no Cells item. |

The desktop side rail shows the same items. After a successful connection the app opens Overview;
after disconnecting it returns to Connect (Charts and Log stay open).

## Screens

| Route | Screen | Content |
| --- | --- | --- |
| `#/connect` | Connect | Connection type (Bluetooth, Serial, Demo), BMS type (auto, brand, protocol), chooser options, browser support notices, detection progress, recent devices. |
| `#/overview` | Overview | SOC ring and state, voltage, current, power, remaining capacity; alarms; switches (toggles when the driver can write them); cell summary with bars; temperatures; battery details (cycles, SOH, capacities, time to full or empty); 10 minute trend; driver specific values; at the end a quiet "Connect another device" button that disconnects and opens Connect in one step. |
| `#/cells` | Cells | Count, average, min, max, delta, balancer state; a tile per cell with voltage or deviation from average, balancing flag, connection resistance; min and max highlighted. |
| `#/charts` | Charts | Recorded readings of the connected device (live) and of every device with stored history. Device picker, range (5, 10, 15, 30 min, 1 h, 2 h, All), value chips, one chart card per group with a shared crosshair, export CSV and PNG, clear the history of a device, where and how much is stored. See below. |
| `#/settings` | Settings groups | Generated from the driver schema. Toolbar: reload, export to JSON, import from JSON (shown as pending changes). |
| `#/settings/<group>` | Settings group | Fields with limits and help; pending changes are highlighted, validated (field limits and cross-field rules) and applied in one batch after a confirmation that lists old and new values. Each field shows whether the device confirmed the value. Actions (restart, reset, calibration) need confirmation. |
| `#/info` | Device information | Identity reported by the device and connection details (GATT service and characteristics or port and baud rate, traffic counters). |
| `#/log` | Protocol log | Live list with filters (sent, raw received, frames, events, warnings, errors, debug), text or hex search, pause, expandable entries (hex dump, decoded fields, copy), export JSON or text, open saved logs. |
| `#/prefs` | Preferences | Language, theme, refresh interval, keep screen on, advanced settings; history: save on or off, recording interval, how long to keep it, storage location; log size, reset. |
| `#/plugins` | Plugins | Desktop app only (linked from More): security note, plugin folders, loaded plugins with their drivers, files that were not loaded with the reason. In the browser the view only says that plugins need the desktop app. See [plugins.md](plugins.md). |
| `#/more` | More | Device information, preferences, log, plugins (desktop app), disconnect, about. |

## Charts

- **Device picker**: the connected device ("Live") first, then every stored device by name and
  the time of its last record (newest first); two devices with the same name get their serial
  number or bus address added. The view follows a new connection; after a disconnect it keeps
  showing that device from the store, or says that nothing of it was saved.
- **Range**: segmented control with localized short durations (5 min to 2 h) and All, remembered
  in the preferences. Live ranges end at the current time and move with the clock; a stored
  device's range ends at its last record; All shows everything stored plus the readings of the
  current connection that are not written yet. Period shows From and To fields (local date and
  time, remembered in the preferences as chartFrom and chartTo): a fixed window that does not
  move with the clock; new readings of the connection appear when they fall inside it. It starts
  with the window shown before, and the CSV and PNG exports use it like any other range.
- **Values**: chips for the groups that have data (voltage, current, power, state of charge, cell
  voltages, cell difference, temperatures, balance current, remaining capacity, and the extra
  values a driver marks with `chart`, such as energy, capacity and duration of Atorch meters,
  each with its own chart); power and
  remaining capacity are off by default. The choice is remembered. The cell chart switches
  between "Min, max, average" and "Every cell" in its own header.
- **Charts**: one card per group, stacked, all with the same time window and the same width for
  the y labels, so the time axes line up. Moving the pointer (or a finger) over one chart shows
  the crosshair and the values in every chart. On touch screens the crosshair stays after the
  finger lifts; a tap on it again, a tap outside the plot or a scroll that starts on a chart hides
  it. Single value cards show the latest value while live. Gaps appear where readings are missing
  (more than three recording intervals). Legends toggle single series; each card keeps its own
  choice while other cards are switched on or off.
- **Export**: CSV of the records in the window (time with UTC offset, unix ms, every value with
  data, each cell and sensor by name); PNG of the visible chart cards with a header (device,
  range, export time), drawn in the current theme. The desktop app saves into Downloads and shows
  the path.
- **Clear history** (trash button): deletes the stored readings of the chosen device after a
  confirmation.
- **Footer**: where the data is stored (desktop: the folder and "Portable" or "User profile";
  browser: "Browser storage on this device", and a note when the browser has not granted
  persistent storage; demo sessions: memory only; no usable browser storage: lost when the page
  closes), how much (records or file size) and how many records are in view.
- Empty states: nothing recorded yet (with a Connect button), nothing of the disconnected device
  was saved, waiting for the first reading, no readings in the range, no value chosen.
- Reading a week of records every 2 s takes a few seconds in browser storage; the footer shows
  "Loading…" meanwhile. See [decisions/0011](decisions/0011-history-and-charts.md).

## Device types

The views render only data that is present in the snapshot, so a balancer (no current, no
MOSFETs) or a BMS without temperature sensors gets a shorter screen automatically. Meters and
electronic loads (`deviceType: 'meter'`, for example Atorch) have no cells: the Cells tab is
hidden for them and their readings (energy, capacity, duration, load settings) appear as values
and settings of the driver. Device specific
parameters come from the driver schema as extra fields and groups. Drivers can add specific values
to `snapshot.extra`; Overview lists them under "More values".

## Real time behaviour

- The session emits a snapshot per poll or streamed frame; views subscribe to store slices and
  re-render only changed parts (Lit templates).
- The header shows a live indicator with SOC while data is fresh and "No data" when nothing
  arrived for four poll intervals (at least 8 s).
- The log view batches updates to one render per animation frame.
- The Charts view gets new readings from the recorder's live tail (no storage reads) and moves
  its window once per second.
- Optional screen wake lock while a device is connected and the app is visible.
