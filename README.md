# Paradox MQTT SecuritySystem (Scrypted)

Controlla e sincronizza un sistema Paradox via MQTT (PAI) esponendolo come **SecuritySystem** in Scrypted.

## Installazione
1. `npm i`
2. `npm run build` → genera `dist/plugin.zip`
3. **Scrypted → Manage Plugins → Install from file** e carica `dist/plugin.zip`  
   Oppure: `npm run deploy` (richiede `npx scrypted-cli login` una volta)

## Configurazione (Settings)
### MQTT
- **Broker URL** es. `mqtt://192.168.1.10:1883`
- Username/Password (se necessari)
- Client ID, TLS, Reject Unauthorized

### Topics
- **Set Target State (publish)**: es. `paradox/control/partitions/Area_1`
- **Get Target State (subscribe)**: `paradox/states/partitions/Area_1/target_state`
- **Get Current State (subscribe)**: `paradox/states/partitions/Area_1/current_state`
- **Get Status Tampered (subscribe)**: `paradox/states/system/troubles/zone_tamper_trouble`
- **Get Online (subscribe)**: `paradox/interface/availability`

### Publish Options
- QoS / Retain

### Outgoing Payloads
- Disarm: `disarm`
- Home: `arm_home`
- Away: `arm_away`
- Night: `arm_night`

## Note sui payload
- In ingresso, il plugin riconosce anche sinonimi (es. `disarmed`, `alarm`, `armed_home`, `entry_delay`, ecc.).
- In uscita, puoi cambiare i payload per aderire al tuo PAI.

## Mappa consigliata per PAI (esempio)
- **Set**: `paradox/control/partitions/Area_1`
  - Disarm → `disarm`
  - Home → `arm_home`
  - Away → `arm_away`
  - Night → `arm_night`
- **Get Target**: `paradox/states/partitions/Area_1/target_state`
- **Get Current**: `paradox/states/partitions/Area_1/current_state`
- **Tamper**: `paradox/states/system/troubles/zone_tamper_trouble` (`true`/`false`)
- **Online**: `paradox/interface/availability` (`online`/`offline`)

