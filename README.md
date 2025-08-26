# Paradox MQTT SecuritySystem (Scrypted)

Controlla e sincronizza un sistema Paradox via MQTT (PAI) esponendolo come **SecuritySystem** in Scrypted.

## Installazione
1. `npm i`
2. `npm run build` → genera `dist/plugin.zip`
3. **Scrypted → Manage Plugins → Install from file** e carica `dist/plugin.zip`  
   Oppure: `npm run deploy` (richiede `npx scrypted-cli login` una volta)

## Configurazione (Settings)
### MQTT
- **Broker URL** es. `mqtt://0.0.0.0:1883`
- Username/Password (se necessari)
- Client ID, TLS, Reject Unauthorized

### Topics
- **Set Target State (publish)**: es. `SYSTEM/control/partitions/Area_1`
- **Get Target State (subscribe)**: `SYSTEM/states/partitions/Area_1/target_state`
- **Get Current State (subscribe)**: `SYSTEM/states/partitions/Area_1/current_state`
- **Get Status Tampered (subscribe)**: `SYSTEM/states/system/troubles/zone_tamper_trouble`
- **Get Online (subscribe)**: `SYSTEM/interface/availability`

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
- **Set**: `SYSTEM/control/partitions/Area_1`
  - Disarm → `disarm`
  - Home → `arm_home`
  - Away → `arm_away`
  - Night → `arm_night`
- **Get Target**: `SYSTEM/states/partitions/Area_1/target_state`
- **Get Current**: `SYSTEM/states/partitions/Area_1/current_state`
- **Tamper**: `SYSTEM/states/system/troubles/zone_tamper_trouble` (`true`/`false`)
- **Online**: `SYSTEM/interface/availability` (`online`/`offline`)

