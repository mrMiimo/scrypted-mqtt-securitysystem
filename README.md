# Paradox MQTT SecuritySystem (Scrypted)

Control and sync a Paradox (PAI/PAI-MQTT–like) alarm via MQTT, exposed in Scrypted as a **SecuritySystem**. Optional child sensors (contact, motion, occupancy) can also be surfaced.

---

## Features
- Arm/Disarm: Disarmed, Home, Away, Night.
- MQTT topics for current/target state, tamper, and online.
- Optional per‑sensor MQTT bindings (contact/motion/occupancy) with battery, tamper, and online status.
- HomeKit: usable through the official Scrypted HomeKit plugin (non-standalone accessory).

---

## Install
```bash
npm i
npm run build       # produces dist/plugin.zip
```
Then in **Scrypted → Manage Plugins → Install

> Alternatively: `npm run deploy` (requires `npx scrypted-cli login` one time).

---

## Configuration (Settings)
### MQTT
- **Broker URL** e.g. `mqtt://127.0.0.1:1883`
- **Username/Password** (if needed)
- **Client ID**
- **TLS / Reject Unauthorized** (when using `mqtts://`)

### Alarm Topics
- **Set Target State (publish)**: where the plugin publishes outgoing arm/disarm payloads.
- **Get Target State (subscribe)**: topic that echoes the intended target from your alarm bridge.
- **Get Current State (subscribe)**: topic reflecting the *actual* alarm state.
- **Get Status Tampered (subscribe)**: tamper status.
- **Get Online (subscribe)**: online/offline indicator of the alarm bridge.

### Publish Options
- **QoS** / **Retain**

### Outgoing Payloads (defaults)
- Disarm → `disarm`
- Home → `arm_home`
- Away → `arm_away`
- Night → `arm_night`

You can change these to match your bridge.

---

## Sensor Support (Optional)
The plugin can expose additional sensors. You may add them from the **Sensors** section in Settings.

Each sensor has:
- **kind**: `contact` | `motion` | `occupancy`
- **topics** (examples):
  - Contact: `your/zones/front-door/open`
  - Motion: `your/zones/hallway/motion`
  - Occupancy: `your/rooms/office/occupied`
  - Optional: `batteryLevel` (0..100), `lowBattery` (boolean), `tamper`, `online`

### Creating Sensors from the UI
- Fill the fields for **ID**, **Name**, **Kind**, and desired **Topics**.
- Toggle **Create Sensor** to “On” and **Save**.
- **Restart this plugin** to have Scrypted show the new accessory under the plugin device.
- If you’re using HomeKit, **restart the HomeKit plugin** to see newly added accessories.

> Only the capabilities for which topics are provided will be exposed (e.g., no low‑battery if no related topic is set).

---

## HomeKit Notes
Add this plugin’s device to the HomeKit plugin **(not as a Standalone accessory)**. A QR code appears in the HomeKit plugin when it is running and configured.

---

## Example Topic Mapping (Generic)
> Replace with your own topics from your bridge.
- **Set Target** (publish): `alarm/control/partition_1`
- **Get Target** (subscribe): `alarm/states/partition_1/target_state`
- **Get Current** (subscribe): `alarm/states/partition_1/current_state`
- **Tamper** (subscribe): `alarm/states/system/tamper`
- **Online** (subscribe): `alarm/interface/availability` (`online`/`offline`)

---

## Behavior & States
- The plugin waits for **Current State** before flipping the alarm mode (so you can see arming delays).
- It accepts common synonyms on incoming states (e.g., `armed_home`, `armed_away`, `armed_night`, `disarmed`).
- For sensors, battery/low‑battery is only reported when the corresponding topic is configured and indicates it.

---

## Troubleshooting
- No HomeKit QR? Ensure the HomeKit plugin is running and this device is added there (not standalone).
- Mode flips instantly? Ensure your bridge publishes **Current State** updates (and optionally `exit_delay` during arming).
- Nothing happens on arm/disarm? Verify the **Set Target** topic and outgoing payloads.
- MQTT connection issues? Check broker URL, credentials, TLS, and network reachability.


---

## License
MIT (or your preferred license).
