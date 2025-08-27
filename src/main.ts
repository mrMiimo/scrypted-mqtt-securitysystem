import sdk, {
  ScryptedDeviceBase,
  ScryptedDeviceType,
  Settings,
  Setting,
  SecuritySystem,
  SecuritySystemMode,
  TamperSensor,
  Online,
  DeviceProvider,
  EntrySensor,
  MotionSensor,
  OccupancySensor,
  Battery,
  ScryptedInterface,
} from '@scrypted/sdk';

import mqtt, { MqttClient, IClientOptions } from 'mqtt';

const { systemManager, deviceManager } = sdk;

/** utils */
function truthy(v?: string) {
  if (!v) return false;
  const s = v.toString().trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'online' || s === 'yes' || s === 'on' || s === 'ok';
}
function falsy(v?: string) {
  if (!v) return false;
  const s = v.toString().trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'offline' || s === 'no' || s === 'off';
}
function normalize(s: string) {
  return (s || '').trim().toLowerCase();
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/** SecuritySystem outgoing defaults (PAI-like) */
const DEFAULT_OUTGOING: Record<SecuritySystemMode, string> = {
  [SecuritySystemMode.Disarmed]: 'disarm',
  [SecuritySystemMode.HomeArmed]: 'arm_home',
  [SecuritySystemMode.AwayArmed]: 'arm_away',
  [SecuritySystemMode.NightArmed]: 'arm_night',
};

/** Fallback (non-strict) parser con sinonimi */
function payloadToModeLoose(payload: string | Buffer | undefined): SecuritySystemMode | undefined {
  if (payload == null) return;
  const p = normalize(payload.toString());
  if (['disarm', 'disarmed', 'off', '0', 'idle', 'ready'].includes(p))
    return SecuritySystemMode.Disarmed;
  if (['arm_home', 'home', 'stay', 'armed_home'].includes(p))
    return SecuritySystemMode.HomeArmed;
  if (['arm_away', 'away', 'armed_away', 'away_armed'].includes(p))
    return SecuritySystemMode.AwayArmed;
  if (['arm_night', 'night', 'armed_night', 'sleep', 'arm_sleep', 'armed_sleep'].includes(p))
    return SecuritySystemMode.NightArmed;
  if (['entry_delay', 'exit_delay', 'pending', 'arming', 'disarming'].includes(p))
    return undefined;
  return undefined;
}

/** ----------------- Sensor Support ----------------- */
type SensorKind = 'contact' | 'motion' | 'occupancy';

type SensorTopics = {
  // primary:
  contact?: string;
  motion?: string;
  occupancy?: string;
  // extras:
  batteryLevel?: string; // number 0..100
  lowBattery?: string;   // bool (usato se manca batteryLevel)
  tamper?: string;
  online?: string;
};

type SensorConfig = {
  id: string;
  name: string;
  kind: SensorKind;
  topics: SensorTopics;
};

abstract class BaseMqttSensor extends ScryptedDeviceBase implements Online, TamperSensor, Battery {
  protected cfg: SensorConfig;

  online?: boolean;
  tampered?: any;
  batteryLevel?: number;

  constructor(nativeId: string, cfg: SensorConfig) {
    super(nativeId);
    this.cfg = cfg;
  }

  /** setter centralizzato + evento */
  private setAndEmit(
    prop: 'online'|'tampered'|'batteryLevel'|'entryOpen'|'motionDetected'|'occupied',
    val: any,
    iface: ScryptedInterface,
  ) {
    const prev = (this as any)[prop];
    if (prev === val) return;
    (this as any)[prop] = val;
    try { this.onDeviceEvent(iface, val); } catch (e) { this.console?.warn?.('onDeviceEvent error', iface, e); }
  }

  /** Called by parent on each MQTT message */
  handleMqtt(topic: string, payload: Buffer) {
    const raw = payload?.toString() ?? '';
    const np = normalize(raw);

    // online
    if (topic === this.cfg.topics.online) {
      if (truthy(np) || np === 'online') this.setAndEmit('online', true,  ScryptedInterface.Online);
      if (falsy(np)  || np === 'offline') this.setAndEmit('online', false, ScryptedInterface.Online);
    }

    // tamper
    if (topic === this.cfg.topics.tamper) {
      if (truthy(np) || ['tamper', 'intrusion', 'cover', 'motion', 'magnetic'].includes(np)) {
        const value = (['cover','intrusion','motion','magnetic'].find(x => x === np) as any) || true;
        this.setAndEmit('tampered', value, ScryptedInterface.TamperSensor);
      } else if (falsy(np)) {
        this.setAndEmit('tampered', false, ScryptedInterface.TamperSensor);
      }
    }

    // battery
    if (topic === this.cfg.topics.batteryLevel) {
      const n = clamp(parseFloat(raw), 0, 100);
      if (Number.isFinite(n)) this.setAndEmit('batteryLevel', n, ScryptedInterface.Battery);
    } else if (topic === this.cfg.topics.lowBattery && !this.cfg.topics.batteryLevel) {
      // Se abbiamo solo lowBattery: true => 10%, false => 100% (ma solo se non c'è già un valore)
      if (truthy(np)) this.setAndEmit('batteryLevel', 10, ScryptedInterface.Battery);
      else if (falsy(np) && this.batteryLevel === undefined) this.setAndEmit('batteryLevel', 100, ScryptedInterface.Battery);
    }

    // primary handled by subclasses
    this.handlePrimary(topic, np, raw);
  }

  protected abstract handlePrimary(topic: string, np: string, raw: string): void;
}

class ContactMqttSensor extends BaseMqttSensor implements EntrySensor {
  entryOpen?: boolean;
  protected handlePrimary(topic: string, np: string) {
    if (topic === this.cfg.topics.contact) {
      const v = truthy(np);
      (this as any).setAndEmit?.('entryOpen', v, ScryptedInterface.EntrySensor);
      if ((this as any).setAndEmit === undefined) {
        if (this.entryOpen !== v) { this.entryOpen = v; this.onDeviceEvent(ScryptedInterface.EntrySensor, v); }
      }
    }
  }
}

class MotionMqttSensor extends BaseMqttSensor implements MotionSensor {
  motionDetected?: boolean;
  protected handlePrimary(topic: string, np: string) {
    if (topic === this.cfg.topics.motion) {
      const v = truthy(np);
      (this as any).setAndEmit?.('motionDetected', v, ScryptedInterface.MotionSensor);
      if ((this as any).setAndEmit === undefined) {
        if (this.motionDetected !== v) { this.motionDetected = v; this.onDeviceEvent(ScryptedInterface.MotionSensor, v); }
      }
    }
  }
}

class OccupancyMqttSensor extends BaseMqttSensor implements OccupancySensor {
  occupied?: boolean;
  protected handlePrimary(topic: string, np: string) {
    if (topic === this.cfg.topics.occupancy) {
      const v = truthy(np);
      (this as any).setAndEmit?.('occupied', v, ScryptedInterface.OccupancySensor);
      if ((this as any).setAndEmit === undefined) {
        if (this.occupied !== v) { this.occupied = v; this.onDeviceEvent(ScryptedInterface.OccupancySensor, v); }
      }
    }
  }
}

/** ----------------- Main Plugin ----------------- */

class ParadoxMqttSecuritySystem extends ScryptedDeviceBase
  implements SecuritySystem, Settings, TamperSensor, Online, DeviceProvider {

  private client?: MqttClient;

  // sensor management
  private sensorsCfg: SensorConfig[] = [];
  private devices = new Map<string, BaseMqttSensor>();

  // remember target while waiting current
  private pendingTarget?: SecuritySystemMode;

  constructor() {
    super();

    // (facoltativo) Imposta il device type in UI
    setTimeout(() => {
      try {
        (systemManager.getDeviceById(this.id) as any)?.setType?.(ScryptedDeviceType.SecuritySystem);
      } catch {}
    });

    // Default state
    this.securitySystemState = this.securitySystemState || {
      mode: SecuritySystemMode.Disarmed,
      supportedModes: [
        SecuritySystemMode.Disarmed,
        SecuritySystemMode.HomeArmed,
        SecuritySystemMode.AwayArmed,
        SecuritySystemMode.NightArmed,
      ],
    };
    this.online = this.online ?? false;

    // Load sensors config and announce devices
    this.loadSensorsFromStorage();
    this.discoverSensors().catch(e => this.console.error('discoverSensors error', e));

    // Connect on start
    this.connectMqtt().catch(e => this.console.error('MQTT connect error:', e));

    // chiusura pulita del client MQTT ai reload/stop del plugin
    try {
      process.once('SIGTERM', () => { try { this.client?.end(true); } catch {} });
      process.once('SIGINT',  () => { try { this.client?.end(true); } catch {} });
      process.on('exit',      () => { try { this.client?.end(true); } catch {} });
    } catch {}
  }

  // ====== Strict parsing helpers ======
  private parseJsonArray(key: string, fallback: string[]): string[] {
    try {
      const raw = (this.storage.getItem(key) || '').trim();
      if (!raw) return fallback;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return fallback;
      return arr.map((x: any) => normalize(String(x))).filter(Boolean);
    } catch { return fallback; }
  }
  private useStrict(): boolean {
    return this.storage.getItem('strictParsing') === 'true';
  }
  private parseIncomingMode(payload: string | Buffer | undefined): SecuritySystemMode | undefined {
    const np = normalize(payload?.toString?.() ?? String(payload ?? ''));
    if (!this.useStrict()) return payloadToModeLoose(np);

    const currentVals = new Set(this.parseJsonArray('currentStateValues',
      ['armed_home','armed_away','armed_night','disarmed','triggered']));

    if (currentVals.has('disarmed')    && np === 'disarmed')    return SecuritySystemMode.Disarmed;
    if (currentVals.has('armed_home')  && np === 'armed_home')  return SecuritySystemMode.HomeArmed;
    if (currentVals.has('armed_away')  && np === 'armed_away')  return SecuritySystemMode.AwayArmed;
    if (currentVals.has('armed_night') && np === 'armed_night') return SecuritySystemMode.NightArmed;
    return undefined;
  }
  private isTriggeredToken(np: string): boolean {
    if (this.useStrict()) {
      const triggered = new Set(this.parseJsonArray('triggeredValues', ['triggered','alarm']));
      return triggered.has(np);
    }
    return np === 'triggered' || np === 'alarm';
  }
  /** Sceglie il token di publish preferito per ciascuna modalità usando targetStateValues quando strict=ON */
  private preferredTokenForMode(mode: SecuritySystemMode): string {
    const t = this.parseJsonArray('targetStateValues',
      ['armed_home','armed_away','armed_night','disarmed']);

    const pick = (...cands: string[]) => cands.find(c => t.includes(c));
    switch (mode) {
      case SecuritySystemMode.Disarmed:
        return pick('disarmed', 'disarm') || 'disarmed';
      case SecuritySystemMode.HomeArmed:
        return pick('armed_home', 'arm_home', 'home', 'stay') || 'armed_home';
      case SecuritySystemMode.AwayArmed:
        return pick('armed_away', 'arm_away', 'away') || 'armed_away';
      case SecuritySystemMode.NightArmed:
        return pick('armed_night', 'arm_night', 'night', 'sleep') || 'armed_night';
    }
  }

  // helpers persistenza
  private saveSensorsToStorage() {
    try {
      this.storage.setItem('sensorsJson', JSON.stringify(this.sensorsCfg));
    } catch (e) {
      this.console.error('saveSensorsToStorage error', e);
    }
  }

  /** ---- Settings UI ---- */
  async getSettings(): Promise<Setting[]> {
    const out: Setting[] = [
      // MQTT Core
      { group: 'MQTT', key: 'brokerUrl', title: 'Broker URL', placeholder: 'mqtt://127.0.0.1:1883', value: this.storage.getItem('brokerUrl') || 'mqtt://127.0.0.1:1883' },
      { group: 'MQTT', key: 'username', title: 'Username', type: 'string', value: this.storage.getItem('username') || '' },
      { group: 'MQTT', key: 'password', title: 'Password', type: 'password', value: this.storage.getItem('password') || '' },
      { group: 'MQTT', key: 'clientId', title: 'Client ID', placeholder: 'scrypted-paradox', value: this.storage.getItem('clientId') || 'scrypted-paradox' },
      { group: 'MQTT', key: 'tls', title: 'Use TLS', type: 'boolean', value: this.storage.getItem('tls') === 'true' },
      { group: 'MQTT', key: 'rejectUnauthorized', title: 'Reject Unauthorized (TLS)', type: 'boolean', value: this.storage.getItem('rejectUnauthorized') !== 'false', description: 'Disattiva solo con broker self-signed.' },

      // Alarm Topics
      { group: 'Alarm Topics', key: 'topicSetTarget', title: 'Set Target State (publish)', placeholder: 'paradox/control/partitions/Area_1', value: this.storage.getItem('topicSetTarget') || '' },
      { group: 'Alarm Topics', key: 'topicGetTarget', title: 'Get Target State (subscribe)', placeholder: 'paradox/states/partitions/Area_1/target_state', value: this.storage.getItem('topicGetTarget') || '' },
      { group: 'Alarm Topics', key: 'topicGetCurrent', title: 'Get Current State (subscribe)', placeholder: 'paradox/states/partitions/Area_1/current_state', value: this.storage.getItem('topicGetCurrent') || '' },
      { group: 'Alarm Topics', key: 'topicTamper', title: 'Get Status Tampered (subscribe)', placeholder: 'paradox/states/system/troubles/zone_tamper_trouble', value: this.storage.getItem('topicTamper') || '' },
      { group: 'Alarm Topics', key: 'topicOnline', title: 'Get Online (subscribe)', placeholder: 'paradox/interface/availability', value: this.storage.getItem('topicOnline') || '' },

      { group: 'Publish Options', key: 'qos', title: 'QoS', type: 'integer', value: parseInt(this.storage.getItem('qos') || '0') },
      { group: 'Publish Options', key: 'retain', title: 'Retain', type: 'boolean', value: this.storage.getItem('retain') === 'true' },

      // --- Parsing / State tokens ---
      { group: 'Parsing / State tokens', key: 'strictParsing', title: 'Use strict tokens (disable synonyms)', type: 'boolean', value: this.storage.getItem('strictParsing') === 'true' },
      { group: 'Parsing / State tokens', key: 'targetStateValues', title: 'Accepted Target State Values (JSON array)', placeholder: '["armed_home","armed_away","armed_night","disarmed"]', value: this.storage.getItem('targetStateValues') || '["armed_home","armed_away","armed_night","disarmed"]' },
      { group: 'Parsing / State tokens', key: 'currentStateValues', title: 'Accepted Current State Values (JSON array)', placeholder: '["armed_home","armed_away","armed_night","disarmed","triggered"]', value: this.storage.getItem('currentStateValues') || '["armed_home","armed_away","armed_night","disarmed","triggered"]' },
      { group: 'Parsing / State tokens', key: 'triggeredValues', title: 'Triggered tokens (JSON array)', placeholder: '["triggered","alarm"]', value: this.storage.getItem('triggeredValues') || '["triggered","alarm"]' },

      // --- Publish Payloads (override) ---
      { group: 'Publish Payloads (override)', key: 'payloadDisarm', title: 'Payload for Disarm', placeholder: 'disarmed', value: this.storage.getItem('payloadDisarm') || '' , description: 'Se vuoto: usa targetStateValues (strict ON) o i default arm_*/disarm (strict OFF).' },
      { group: 'Publish Payloads (override)', key: 'payloadHome',  title: 'Payload for Home Armed', placeholder: 'armed_home', value: this.storage.getItem('payloadHome') || '' },
      { group: 'Publish Payloads (override)', key: 'payloadAway',  title: 'Payload for Away Armed', placeholder: 'armed_away', value: this.storage.getItem('payloadAway') || '' },
      { group: 'Publish Payloads (override)', key: 'payloadNight', title: 'Payload for Night Armed', placeholder: 'armed_night', value: this.storage.getItem('payloadNight') || '' },
    ];

    // ---- UI Add Sensor ----
    out.push(
      { group: 'Add Sensor', key: 'new.id', title: 'New Sensor ID', placeholder: 'porta-ingresso', value: this.storage.getItem('new.id') || '' },
      { group: 'Add Sensor', key: 'new.name', title: 'Name', placeholder: 'Porta Ingresso', value: this.storage.getItem('new.name') || '' },
      { group: 'Add Sensor', key: 'new.kind', title: 'Type', value: this.storage.getItem('new.kind') || 'contact', choices: ['contact', 'motion', 'occupancy'] as any },
      { group: 'Add Sensor', key: 'new.create', title: 'Create sensor', type: 'boolean', description: 'Fill the fields above and toggle this on to create the sensor. After creation, restart this plugin to see the accessory listed below. To show it in HomeKit, restart the HomeKit plugin as well.' },
    );

    // ---- UI per sensori esistenti ----
    for (const cfg of this.sensorsCfg) {
      const gid = `Sensor: ${cfg.name} [${cfg.id}]`;

      out.push(
        { group: gid, key: `sensor.${cfg.id}.name`, title: 'Name', value: cfg.name },
        { group: gid, key: `sensor.${cfg.id}.kind`, title: 'Type', value: cfg.kind, choices: ['contact', 'motion', 'occupancy'] as any },
      );

      // primary per tipo
      if (cfg.kind === 'contact') {
        out.push({ group: gid, key: `sensor.${cfg.id}.topic.contact`, title: 'Contact State Topic', value: cfg.topics.contact || '', placeholder: 'paradox/states/zones/XYZ/open' });
      } else if (cfg.kind === 'motion') {
        out.push({ group: gid, key: `sensor.${cfg.id}.topic.motion`, title: 'Motion Detected Topic', value: cfg.topics.motion || '', placeholder: 'paradox/states/zones/XYZ/open' });
      } else {
        out.push({ group: gid, key: `sensor.${cfg.id}.topic.occupancy`, title: 'Occupancy Detected Topic', value: cfg.topics.occupancy || '', placeholder: 'paradox/states/zones/XYZ/open' });
      }

      // extra opzionali
      out.push(
        { group: gid, key: `sensor.${cfg.id}.topic.batteryLevel`, title: 'Battery Level Topic (0..100)', value: cfg.topics.batteryLevel || '' },
        { group: gid, key: `sensor.${cfg.id}.topic.lowBattery`,  title: 'Low Battery Topic (bool)', value: cfg.topics.lowBattery || '' },
        { group: gid, key: `sensor.${cfg.id}.topic.tamper`,      title: 'Tamper Topic', value: cfg.topics.tamper || '' },
        { group: gid, key: `sensor.${cfg.id}.topic.online`,      title: 'Online Topic', value: cfg.topics.online || '' },
        { group: gid, key: `sensor.${cfg.id}.remove`,            title: 'Remove sensor', type: 'boolean' },
      );
    }

    return out;
  }

  async putSetting(key: string, value: string | number | boolean): Promise<void> {
    // salva sempre nella storage la value del campo (così resta in UI)
    this.storage.setItem(key, String(value));

    // --- Add Sensor workflow ---
    if (key === 'new.create' && String(value) === 'true') {
      const id = (this.storage.getItem('new.id') || '').trim();
      const name = (this.storage.getItem('new.name') || '').trim() || id;
      const kind = (this.storage.getItem('new.kind') || 'contact').trim() as SensorKind;

      if (!id) {
        this.console.warn('Create sensor: id mancante');
        return;
      }
      if (this.sensorsCfg.find(s => s.id === id)) {
        this.console.warn('Create sensor: id già esistente');
        return;
      }

      this.sensorsCfg.push({ id, name, kind, topics: {} });
      this.saveSensorsToStorage();

      // pulisci i campi "new.*"
      this.storage.removeItem('new.id');
      this.storage.removeItem('new.name');
      this.storage.removeItem('new.kind');
      this.storage.removeItem('new.create');

      await this.discoverSensors();
      await this.connectMqtt(true);
      return;
    }

    // --- Edit/Remove sensore esistente ---
    const m = key.match(/^sensor\.([^\.]+)\.(.+)$/);
    if (m) {
      const sid = m[1];
      const prop = m[2];
      const cfg = this.sensorsCfg.find(s => s.id === sid);
      if (!cfg) {
        this.console.warn('putSetting: sensor non trovato', sid);
        return;
      }

      if (prop === 'remove' && String(value) === 'true') {
        // elimina
        this.sensorsCfg = this.sensorsCfg.filter(s => s.id !== sid);
        this.saveSensorsToStorage();

        try {
          this.devices.delete(`sensor:${sid}`);
          deviceManager.onDeviceRemoved?.(`sensor:${sid}`);
        } catch {}

        // pulisci flag
        this.storage.removeItem(key);

        await this.discoverSensors();
        await this.connectMqtt(true);
        return;
      }

      if (prop === 'name') {
        cfg.name = String(value);
      } else if (prop === 'kind') {
        cfg.kind = String(value) as SensorKind;
      } else if (prop.startsWith('topic.')) {
        const tk = prop.substring('topic.'.length) as keyof SensorTopics;
        (cfg.topics as any)[tk] = String(value).trim();
      }

      this.saveSensorsToStorage();
      await this.discoverSensors();
      await this.connectMqtt(true);
      return;
    }

    // --- Altro (MQTT / Alarm settings / parsing / payloads) ---
    if (key === 'sensorsJson') {
      // non più mostrato, ma se presente da vecchie versioni
      this.loadSensorsFromStorage();
      await this.discoverSensors();
      await this.connectMqtt(true);
    } else {
      await this.connectMqtt(true);
    }
  }

  /** ---- DeviceProvider ---- */

  async getDevice(nativeId: string) {
    return this.devices.get(nativeId);
  }

  async releaseDevice(_id: string, nativeId: string): Promise<void> {
    try {
      const dev = this.devices.get(nativeId);
      if (dev) {
        this.devices.delete(nativeId);
      }
      try { deviceManager.onDeviceRemoved?.(nativeId); } catch {}
    } catch (e) {
      this.console.warn('releaseDevice error', e);
    }
  }

  private loadSensorsFromStorage() {
    try {
      const raw = this.storage.getItem('sensorsJson') || '[]';
      const parsed: SensorConfig[] = JSON.parse(raw);
      // sanitize
      this.sensorsCfg = (parsed || []).filter(x => x && x.id && x.name && x.kind && x.topics);
    } catch (e) {
      this.console.error('Invalid sensorsJson:', e);
      this.sensorsCfg = [];
    }
  }

  /** ===== discoverSensors: annuncia PRIMA, istanzia DOPO ===== */
  private async discoverSensors() {
    // 1) Prepara i manifest (niente istanze qui)
    const manifests = this.sensorsCfg.map(cfg => {
      const nativeId = `sensor:${cfg.id}`;
      const t = cfg.topics || {};

      const interfaces: ScryptedInterface[] = [ ScryptedInterface.Online ];

      // Tamper solo se c'è un topic tamper
      if (t.tamper) interfaces.push(ScryptedInterface.TamperSensor);

      // Interfaccia primaria
      if (cfg.kind === 'contact') interfaces.unshift(ScryptedInterface.EntrySensor);
      else if (cfg.kind === 'motion') interfaces.unshift(ScryptedInterface.MotionSensor);
      else interfaces.unshift(ScryptedInterface.OccupancySensor);

      // Battery solo se previsto
      if ((t.batteryLevel && t.batteryLevel.trim()) || (t.lowBattery && t.lowBattery.trim())) {
        interfaces.push(ScryptedInterface.Battery);
      }

      return { nativeId, name: cfg.name, type: ScryptedDeviceType.Sensor, interfaces };
    });

    // 2) Annuncio
    const dmAny: any = deviceManager as any;
    if (typeof dmAny.onDevicesChanged === 'function') {
      dmAny.onDevicesChanged({ devices: manifests });
      this.console.log('Annunciati (batch):', manifests.map(m => m.nativeId).join(', '));
    } else {
      for (const m of manifests) {
        deviceManager.onDeviceDiscovered(m);
        this.console.log('Annunciato:', m.nativeId);
      }
    }

    // 3) Istanzia/aggiorna DOPO l’annuncio
    for (const cfg of this.sensorsCfg) {
      const nativeId = `sensor:${cfg.id}`;
      let dev = this.devices.get(nativeId);
      if (!dev) {
        if (cfg.kind === 'contact') dev = new ContactMqttSensor(nativeId, cfg);
        else if (cfg.kind === 'motion') dev = new MotionMqttSensor(nativeId, cfg);
        else dev = new OccupancyMqttSensor(nativeId, cfg);
        this.devices.set(nativeId, dev);
      } else {
        (dev as any).cfg = cfg;
      }

      // Default “OK” se abbiamo Battery ma nessun valore ancora ricevuto
      const hasBattery = !!(cfg.topics.batteryLevel && cfg.topics.batteryLevel.trim()) || !!(cfg.topics.lowBattery && cfg.topics.lowBattery.trim());
      if (hasBattery && (dev as any).batteryLevel === undefined) {
        (dev as any).batteryLevel = 100;
        try { dev.onDeviceEvent(ScryptedInterface.Battery, 100); } catch {}
      }
    }

    // 4) Rimuovi quelli spariti
    const announced = new Set(manifests.map(m => m.nativeId));
    for (const [nativeId] of this.devices) {
      if (!announced.has(nativeId)) {
        try {
          this.devices.delete(nativeId);
          deviceManager.onDeviceRemoved?.(nativeId);
          this.console.log('Rimosso:', nativeId);
        } catch {}
      }
    }
  }

  /** ---- MQTT ---- */

  private getMqttOptions(): { url: string, opts: IClientOptions } {
    const url = this.storage.getItem('brokerUrl') || 'mqtt://127.0.0.1:1883';
    const username = this.storage.getItem('username') || undefined;
    const password = this.storage.getItem('password') || undefined;
    const clientId = this.storage.getItem('clientId') || 'scrypted-paradox';
    const tls = this.storage.getItem('tls') === 'true';
    const rejectUnauthorized = this.storage.getItem('rejectUnauthorized') !== 'false';

    const opts: IClientOptions = {
      clientId,
      username,
      password,
      clean: true,
      reconnectPeriod: 3000,
    };

    if (tls) {
      (opts as any).protocol = 'mqtts';
      (opts as any).rejectUnauthorized = rejectUnauthorized;
    }

    return { url, opts };
  }

  private collectAllSubscriptions(): string[] {
    const subs = new Set<string>();

    // alarm
    for (const k of ['topicGetTarget', 'topicGetCurrent', 'topicTamper', 'topicOnline']) {
      const v = this.storage.getItem(k);
      if (v) subs.add(v);
    }

    // sensors
    for (const s of this.sensorsCfg) {
      const t = s.topics || {};
      [t.contact, t.motion, t.occupancy, t.batteryLevel, t.lowBattery, t.tamper, t.online]
        .filter((x) => !!x && String(x).trim().length > 0)
        .forEach(x => subs.add(String(x)));
    }

    return Array.from(subs);
  }

  private async connectMqtt(_reconnect = false) {
    const subs = this.collectAllSubscriptions();

    if (!subs.length && !this.storage.getItem('topicSetTarget')) {
      this.console.warn('Configura almeno un topic nelle impostazioni.');
    }

    if (this.client) {
      try { this.client.end(true); } catch {}
      this.client = undefined;
    }

    const { url, opts } = this.getMqttOptions();
    this.console.log(`Connecting MQTT ${url} ...`);
    const client = mqtt.connect(url, opts);
    this.client = client;

    // cache alarm topics for fast compare
    const tTarget = this.storage.getItem('topicGetTarget') || '';
    const tCurrent = this.storage.getItem('topicGetCurrent') || '';
    const tTamper  = this.storage.getItem('topicTamper') || '';
    const tOnline  = this.storage.getItem('topicOnline') || '';

    client.on('connect', () => {
      this.console.log('MQTT connected');
      this.online = true;
      try { this.onDeviceEvent(ScryptedInterface.Online, true); } catch {}
      if (subs.length) {
        client.subscribe(subs, { qos: 0 }, (err?: Error | null) => {
          if (err) this.console.error('subscribe error', err);
        });
      }
    });

    client.on('reconnect', () => this.console.log('MQTT reconnecting...'));
    client.on('close', () => { 
      this.console.log('MQTT closed'); 
      this.online = false; 
      try { this.onDeviceEvent(ScryptedInterface.Online, false); } catch {}
    });
    client.on('error', (e: Error) => { this.console.error('MQTT error', e); });

    client.on('message', (topic: string, payload: Buffer) => {
      try {
        const p = payload?.toString() ?? '';
        const np = normalize(p);

        // ---- Alarm handling ----
        if (topic === tOnline) {
          if (truthy(np) || np === 'online') { this.online = true;  try { this.onDeviceEvent(ScryptedInterface.Online, true); } catch {} }
          if (falsy(np)  || np === 'offline') { this.online = false; try { this.onDeviceEvent(ScryptedInterface.Online, false); } catch {} }
          return;
        }

        if (topic === tTamper) {
          if (truthy(np) || ['tamper', 'intrusion', 'cover'].includes(np)) {
            const val = (['cover','intrusion'].find(x => x === np) as any) || true;
            (this as any).tampered = val;
            try { this.onDeviceEvent(ScryptedInterface.TamperSensor, val); } catch {}
          } else if (falsy(np)) {
            (this as any).tampered = false;
            try { this.onDeviceEvent(ScryptedInterface.TamperSensor, false); } catch {}
          }
          return;
        }

        if (topic === tCurrent) {
          const mode = this.parseIncomingMode(payload);
          const isAlarm = this.isTriggeredToken(np);
          const current = this.securitySystemState || { mode: SecuritySystemMode.Disarmed };

          const newState = {
            mode: mode ?? current.mode,
            supportedModes: current.supportedModes ?? [
              SecuritySystemMode.Disarmed,
              SecuritySystemMode.HomeArmed,
              SecuritySystemMode.AwayArmed,
              SecuritySystemMode.NightArmed,
            ],
            triggered: isAlarm || undefined,
          };

          this.securitySystemState = newState;
          try { this.onDeviceEvent(ScryptedInterface.SecuritySystem, newState); } catch {}
          return;
        }

        if (topic === tTarget) {
          this.pendingTarget = this.parseIncomingMode(payload);
          this.console.log('Target state reported:', p, '->', this.pendingTarget);
          return;
        }

        // ---- Sensor dispatch ----
        for (const dev of this.devices.values()) {
          dev.handleMqtt(topic, payload);
        }
      } catch (e) {
        this.console.error('MQTT message handler error', e);
      }
    });
  }

  /** ---- SecuritySystem commands ---- */

  private publishSetTarget(payload: string) {
    const topic = this.storage.getItem('topicSetTarget');
    if (!topic || !this.client) {
      this.console.warn('topicSetTarget o MQTT non configurati.');
      return;
    }
    const retain = this.storage.getItem('retain') === 'true';
    const qosNum = Number(this.storage.getItem('qos') || 0);
    const qos = Math.max(0, Math.min(2, isFinite(qosNum) ? qosNum : 0)) as 0 | 1 | 2;

    this.client.publish(
      topic,
      payload,
      { qos, retain },
      (err?: Error | null) => {
        if (err) this.console.error('publish error', err);
      }
    );
  }

  /** Sceglie il payload di publish rispettando override → strict tokens → default arm_* */
  private getOutgoing(mode: SecuritySystemMode) {
    const overrides: Record<SecuritySystemMode, string | null> = {
      [SecuritySystemMode.Disarmed]: this.storage.getItem('payloadDisarm') || null,
      [SecuritySystemMode.HomeArmed]: this.storage.getItem('payloadHome')  || null,
      [SecuritySystemMode.AwayArmed]: this.storage.getItem('payloadAway')  || null,
      [SecuritySystemMode.NightArmed]: this.storage.getItem('payloadNight')|| null,
    };
    const override = overrides[mode];
    if (override && override.trim().length) return override.trim();

    if (this.useStrict()) return this.preferredTokenForMode(mode);

    return DEFAULT_OUTGOING[mode];
  }

  async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
    const payload = this.getOutgoing(mode);
    this.console.log('armSecuritySystem', mode, '->', payload);
    this.pendingTarget = mode;     // memorizza target, ma NON cambiare il current
    this.publishSetTarget(payload);
  }

  async disarmSecuritySystem(): Promise<void> {
    const payload = this.getOutgoing(SecuritySystemMode.Disarmed);
    this.console.log('disarmSecuritySystem ->', payload);
    this.pendingTarget = SecuritySystemMode.Disarmed;
    this.publishSetTarget(payload);
  }
}

export default ParadoxMqttSecuritySystem;