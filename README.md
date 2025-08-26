# Paradox MQTT SecuritySystem (Scrypted)

Expose and control a **Paradox** alarm via **MQTT (PAI/PAI-MQTT style)** as a Scrypted **SecuritySystem**.

---

## Features
- Bidirectional sync: target & current state
- Custom MQTT topics (publish/subscribe)
- Tamper & online status support
- QoS / Retain options for outgoing messages
- Fully customizable outgoing payloads

---

## Requirements
- **Scrypted** (server up and running)
- An MQTT broker (e.g., Mosquitto)
- A Paradox ↔︎ MQTT bridge (e.g., **PAI**)

---

## Installation

```bash
npm i
npm run build        # → generates dist/plugin.zip
```

- In Scrypted: **Manage Plugins → Install from file** and upload `dist/plugin.zip`  
  _Or_:
```bash
npm run deploy       # requires: npx scrypted-cli login  (one time)
```

---

## Configuration (Scrypted → your device → Settings)

### MQTT
- **Broker URL**: e.g. `mqtt://0.0.0.0:1883`
- **Username / Password** (if required)
- **Client ID**, **TLS**, **Reject Unauthorized**

### Topics
| Purpose                          | Direction | Example Topic                                             |
|----------------------------------|-----------|-----------------------------------------------------------|
| Set Target State                 | publish   | `SYSTEM/control/partitions/Area_1`                        |
| Get Target State                 | subscribe | `SYSTEM/states/partitions/Area_1/target_state`            |
| Get Current State                | subscribe | `SYSTEM/states/partitions/Area_1/current_state`           |
| Get Status Tampered              | subscribe | `SYSTEM/states/system/troubles/zone_tamper_trouble`       |
| Get Online                       | subscribe | `SYSTEM/interface/availability`                           |

### Publish Options
- **QoS** (0/1/2)  
- **Retain** (true/false)

### Outgoing Payloads (customizable)
- **Disarm**: `disarm`
- **Home**: `arm_home`
- **Away**: `arm_away`
- **Night**: `arm_night`

---

## Payload Notes

**Incoming (subscribe):** the plugin also recognizes common synonyms, e.g.
- `disarmed`, `off`, `idle`, `ready` → **Disarmed**
- `armed_home`, `home`, `stay` → **Home**
- `armed_away`, `away`, `arming`, `exit_delay` → **Away**
- `armed_night`, `night` → **Night**
- `alarm`, `triggered` → sets `triggered: true`
- Transitional states (e.g., `entry_delay`, `pending`) are ignored for mode changes.

**Outgoing (publish):** change payload strings in Settings to match your PAI mapping.

---

## Recommended PAI Mapping (example)

**Publish (Set):**
```
SYSTEM/control/partitions/Area_1
  Disarm -> disarm
  Home   -> arm_home
  Away   -> arm_away
  Night  -> arm_night
```

**Subscribe (Get):**
```
Target  -> SYSTEM/states/partitions/Area_1/target_state
Current -> SYSTEM/states/partitions/Area_1/current_state
Tamper  -> SYSTEM/states/system/troubles/zone_tamper_trouble   (true/false)
Online  -> SYSTEM/interface/availability                       (online/offline)
```

---

## Tips

- If you use Scrypted’s **HomeKit** plugin to expose this device:
  - Enable the **Security System** extension/mapping inside the HomeKit plugin.
  - Ensure your Scrypted container runs with **host networking** so mDNS/Bonjour works (for pairing).

---
