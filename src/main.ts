// --- Preload: silenzia SOLO il warning facoltativo di sdk.json ---
(() => {
  const swallow = (orig: (...args: any[]) => any) => (...args: any[]) => {
    const txt = args.map(a => typeof a === 'string' ? a : (a?.message || '')).join(' ');
    if (txt.includes('failed to load custom interface descriptors')) return;
    return orig(...args);
  };
  console.error = swallow(console.error.bind(console));
  console.warn  = swallow(console.warn.bind(console));
})();

// Runtime SDK via require (evita esecuzione anticipata del bundler)
const sdk = require('@scrypted/sdk');
const {
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  SecuritySystemMode,
  systemManager,
} = sdk;

import type {
  Settings, Setting, SecuritySystem, TamperSensor, Online, DeviceProvider,
  EntrySensor, MotionSensor, OccupancySensor, Battery,
  ScryptedInterface as TScryptedInterface,
  SecuritySystemMode as TSecuritySystemMode,
} from '@scrypted/sdk';

import mqtt, { MqttClient, IClientOptions } from 'mqtt';

/** utils */
function normalize(s: string) { return (s || '').trim().toLowerCase(); }
function truthy(v?: string) {
  if (!v) return false;
  const s = normalize(v);
  return s === '1' || s === 'true' || s === 'online' || s === 'yes' || s === 'on' || s === 'ok' || s === 'open';
}
function falsy(v?: string) {
  if (!v) return false;
  const s = normalize(v);
  return s === '0' || s === 'false' || s === 'offline' || s === 'no' || s === 'off' || s === 'closed' || s === 'close';
}
function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, n)); }
function deepEqual(a: any, b: any) { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return a === b; } }

/** Match topic con wildcard MQTT (+, #) oppure confronto esatto */
function topicMatches(topic: string, pattern?: string): boolean {
  if (!pattern) return false;
  if (pattern === topic) return true;
  if (!pattern.includes('+') && !pattern.includes('#')) return false;
  // Escapa tutto tranne '/'
  const esc = pattern.replace(/[-/\\^$*?.()|[\]{}]/g, '\\$&');
  const rx = '^' + esc
    .replace(/\\\+/g, '[^/]+')  // '+' => un segmento
    .replace(/\\\#/g, '.+');    // '#" => qualsiasi suffisso
  try { return new RegExp(rx + '$').test(topic); } catch { return false; }
}

/** set + emit evento scrypted */
function setAndEmit(dev: any, key: string, value: any, iface: TScryptedInterface, log?: string) {
  if (dev[key] === value) return;
  dev[key] = value;
  try { dev.onDeviceEvent?.(iface, value); } catch {}
  try { if (log) dev.console?.log?.(log); } catch {}
}

/** Outgoing predefiniti (PAI-like). Chiavi numeriche per compat enum */
const DEFAULT_OUTGOING: Record<number, string> = {
  [SecuritySystemMode.Disarmed]: 'disarm',
  [SecuritySystemMode.HomeArmed]: 'arm_home',
  [SecuritySystemMode.AwayArmed]: 'arm_away',
  [SecuritySystemMode.NightArmed]: 'arm_night',
};

function payloadToMode(payload: string | Buffer | undefined): TSecuritySystemMode | undefined {
  if (payload == null) return;
  const p = normalize(payload.toString());
  if (['disarm','disarmed','off','0','idle','ready'].includes(p)) return SecuritySystemMode.Disarmed;
  if (['arm_home','home','stay','armed_home'].includes(p)) return SecuritySystemMode.HomeArmed;
  if (['arm_away','away','armed_away','away_armed'].includes(p)) return SecuritySystemMode.AwayArmed;
  if (['arm_night','night','armed_night','sleep','arm_sleep','armed_sleep'].includes(p)) return SecuritySystemMode.NightArmed;
  if (['entry_delay','exit_delay','pending','arming','disarming'].includes(p)) return undefined;
  return undefined;
}

/** ----------------- Sensor Support ----------------- */
type SensorKind = 'contact' | 'motion' | 'occupancy';
type SensorTopics = {
  contact?: string; motion?: string; occupancy?: string;
  batteryLevel?: string; lowBattery?: string; tamper?: string; online?: string;
};
type SensorConfig = { id: string; name: string; kind: SensorKind; topics: SensorTopics; };

abstract class BaseMqttSensor extends ScryptedDeviceBase implements Online, TamperSensor, Battery {
  protected cfg: SensorConfig;
  online?: boolean; tampered?: any; batteryLevel?: number;

  constructor(nativeId: string, cfg: SensorConfig) {
    super(nativeId);
    this.cfg = cfg;
  }

  handleMqtt(topic: string, payload: Buffer) {
    const raw = payload?.toString() ?? '';
    const np = normalize(raw);

    // Online
    if (topicMatches(topic, this.cfg.topics.online)) {
      if (truthy(np) || np === 'online') setAndEmit(this, 'online', true, ScryptedInterface.Online, `[${this.name}] online=true`);
      else if (falsy(np) || np === 'offline') setAndEmit(this, 'online', false, ScryptedInterface.Online, `[${this.name}] online=false`);
    }

    // Tamper
    if (topicMatches(topic, this.cfg.topics.tamper)) {
      if (truthy(np) || ['tamper','intrusion','cover','motion','magnetic'].includes(np)) {
        const t = (['cover','intrusion','motion','magnetic'].find(x => x === np) as any) || true;
        setAndEmit(this, 'tampered', t, ScryptedInterface.TamperSensor, `[${this.name}] tampered=${t}`);
      } else if (falsy(np)) {
        setAndEmit(this, 'tampered', false, ScryptedInterface.TamperSensor, `[${this.name}] tampered=false`);
      }
    }

    // Battery
    if (topicMatches(topic, this.cfg.topics.batteryLevel)) {
      const n = clamp(parseFloat(raw), 0, 100);
      if (isFinite(n)) setAndEmit(this, 'batteryLevel', n, ScryptedInterface.Battery, `[${this.name}] batteryLevel=${n}`);
    } else if (topicMatches(topic, this.cfg.topics.lowBattery) && !this.cfg.topics.batteryLevel) {
      const n = truthy(np) ? 10 : 100;
      setAndEmit(this, 'batteryLevel', n, ScryptedInterface.Battery, `[${this.name}] batteryLevel=${n} (lowBattery)`);
    }

    // Primario
    this.handlePrimary(topic, np, raw);
  }

  protected abstract handlePrimary(topic: string, np: string, raw: string): void;
}

/** === SENSORI: parsing robusto + eventi === */
class ContactMqttSensor extends BaseMqttSensor implements EntrySensor {
  entryOpen?: boolean;

  protected handlePrimary(topic: string, np: string, raw: string) {
    if (!topicMatches(topic, this.cfg.topics.contact)) return;

    let val: boolean | undefined;

    // stringhe comuni (True/False compresi via normalize)
    if (['open','opened','1','true','on','yes'].includes(np)) val = true;
    else if (['closed','close','0','false','off','no','shut'].includes(np)) val = false;

    // JSON comuni
    if (val === undefined) {
      try {
        const j = JSON.parse(raw);
        if (typeof j?.open === 'boolean') val = !!j.open;
        else if (typeof j?.opened === 'boolean') val = !!j.opened;
        else if (typeof j?.contact === 'boolean') val = !j.contact; // contact:false => aperto
        else if (typeof j?.state === 'string') {
          const s = normalize(j.state);
          if (s === 'open') val = true;
          if (s === 'closed') val = false;
        }
      } catch {}
    }

    if (val !== undefined) {
      setAndEmit(this, 'entryOpen', val, ScryptedInterface.EntrySensor, `[${this.name}] entryOpen=${val} (${topic})`);
    } else {
      this.console?.debug?.(`Contact payload non gestito (${this.cfg.id}) topic=${topic} raw="${raw}"`);
    }
  }
}

class MotionMqttSensor extends BaseMqttSensor implements MotionSensor {
  motionDetected?: boolean;

  protected handlePrimary(topic: string, np: string, raw: string) {
    if (!topicMatches(topic, this.cfg.topics.motion)) return;

    let val: boolean | undefined;
    if (['motion','detected','active','1','true','on','yes'].includes(np)) val = true;
    else if (['clear','inactive','no_motion','none','0','false','off','no'].includes(np)) val = false;

    if (val === undefined) {
      try {
        const j = JSON.parse(raw);
        if (typeof j?.motion === 'boolean') val = !!j.motion;
        else if (typeof j?.occupancy === 'boolean') val = !!j.occupancy;
        else if (typeof j?.presence === 'boolean') val = !!j.presence;
        else if (typeof j?.state === 'string') {
          const s = normalize(j.state);
          if (['on','motion','detected','active'].includes(s)) val = true;
          if (['off','clear','inactive'].includes(s)) val = false;
        }
      } catch {}
    }

    if (val !== undefined) {
      setAndEmit(this, 'motionDetected', val, ScryptedInterface.MotionSensor, `[${this.name}] motionDetected=${val} (${topic})`);
    } else {
      this.console?.debug?.(`Motion payload non gestito (${this.cfg.id}) topic=${topic} raw="${raw}"`);
    }
  }
}

class OccupancyMqttSensor extends BaseMqttSensor implements OccupancySensor {
  occupied?: boolean;

  protected handlePrimary(topic: string, np: string, raw: string) {
    if (!topicMatches(topic, this.cfg.topics.occupancy)) return;

    let val: boolean | undefined;
    if (['occupied','presence','present','1','true','on','yes'].includes(np)) val = true;
    else if (['unoccupied','vacant','absent','0','false','off','no','clear'].includes(np)) val = false;

    if (val === undefined) {
      try {
        const j = JSON.parse(raw);
        if (typeof j?.occupied === 'boolean') val = !!j.occupied;
        else if (typeof j?.presence === 'boolean') val = !!j.presence;
        else if (typeof j?.occupancy === 'boolean') val = !!j.occupancy;
        else if (typeof j?.state === 'string') {
          const s = normalize(j.state);
          if (['occupied','presence','present','on'].includes(s)) val = true;
          if (['vacant','absent','clear','off'].includes(s)) val = false;
        }
      } catch {}
    }

    if (val !== undefined) {
      setAndEmit(this, 'occupied', val, ScryptedInterface.OccupancySensor, `[${this.name}] occupied=${val} (${topic})`);
    } else {
      this.console?.debug?.(`Occupancy payload non gestito (${this.cfg.id}) topic=${topic} raw="${raw}"`);
    }
  }
}

/** ----------------- Main Plugin ----------------- */
class ParadoxMqttSecuritySystem extends ScryptedDeviceBase
  implements SecuritySystem, Settings, TamperSensor, Online, DeviceProvider {

  private client?: MqttClient;
  private sensorsCfg: SensorConfig[] = [];
  private devices = new Map<string, BaseMqttSensor>();
  private pendingTarget?: TSecuritySystemMode;

  online?: boolean;
  tampered?: any;
  securitySystemState?: any;

  private discoveryPostponed = false;

  constructor() {
    super();

    // Tipo in UI (best-effort)
    setTimeout(() => {
      try { (systemManager.getDeviceById(this.id) as any)?.setType?.(ScryptedDeviceType.SecuritySystem); } catch {}
    });

    // Stato di default
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

    this.loadSensorsFromStorage();
    this.safeDiscoverSensors();

    this.connectMqtt().catch((e: any) => this.console.error('MQTT connect error:', e));

    try {
      process.once('SIGTERM', () => { try { this.client?.end(true); } catch {} });
      process.once('SIGINT',  () => { try { this.client?.end(true); } catch {} });
      process.on('exit',      () => { try { this.client?.end(true); } catch {} });
    } catch {}
  }

  /** ---- Settings ---- */
  private saveSensorsToStorage() {
    try { this.storage.setItem('sensorsJson', JSON.stringify(this.sensorsCfg)); }
    catch (e) { this.console.error('saveSensorsToStorage error', e); }
  }

  async getSettings(): Promise<Setting[]> {
    const out: Setting[] = [
      { group: 'MQTT', key: 'brokerUrl', title: 'Broker URL', placeholder: 'mqtt://127.0.0.1:1883', value: this.storage.getItem('brokerUrl') || 'mqtt://127.0.0.1:1883' },
      { group: 'MQTT', key: 'username', title: 'Username', type: 'string', value: this.storage.getItem('username') || '' },
      { group: 'MQTT', key: 'password', title: 'Password', type: 'password', value: this.storage.getItem('password') || '' },
      { group: 'MQTT', key: 'clientId', title: 'Client ID', placeholder: 'scrypted-paradox', value: this.storage.getItem('clientId') || 'scrypted-paradox' },
      { group: 'MQTT', key: 'tls', title: 'Use TLS', type: 'boolean', value: this.storage.getItem('tls') === 'true' },
      { group: 'MQTT', key: 'rejectUnauthorized', title: 'Reject Unauthorized (TLS)', type: 'boolean', value: this.storage.getItem('rejectUnauthorized') !== 'false', description: 'Disattiva solo con broker self-signed.' },

      { group: 'Alarm Topics', key: 'topicSetTarget', title: 'Set Target State (publish)', placeholder: 'paradox/control/partitions/Area_1', value: this.storage.getItem('topicSetTarget') || '' },
      { group: 'Alarm Topics', key: 'topicGetTarget', title: 'Get Target State (subscribe)', placeholder: 'paradox/states/partitions/Area_1/target_state', value: this.storage.getItem('topicGetTarget') || '' },
      { group: 'Alarm Topics', key: 'topicGetCurrent', title: 'Get Current State (subscribe)', placeholder: 'paradox/states/partitions/Area_1/current_state', value: this.storage.getItem('topicGetCurrent') || '' },
      { group: 'Alarm Topics', key: 'topicTamper',  title: 'Get Status Tampered (subscribe)', placeholder: 'paradox/states/system/troubles/zone_tamper_trouble', value: this.storage.getItem('topicTamper') || '' },
      { group: 'Alarm Topics', key: 'topicOnline',  title: 'Get Online (subscribe)', placeholder: 'paradox/interface/availability', value: this.storage.getItem('topicOnline') || '' },

      { group: 'Publish Options', key: 'qos', title: 'QoS', type: 'integer', value: parseInt(this.storage.getItem('qos') || '0') },
      { group: 'Publish Options', key: 'retain', title: 'Retain', type: 'boolean', value: this.storage.getItem('retain') === 'true' },
    ];

    // Add Sensor
    out.push(
      { group: 'Add Sensor', key: 'new.id',   title: 'New Sensor ID', placeholder: 'porta-ingresso', value: this.storage.getItem('new.id') || '' },
      { group: 'Add Sensor', key: 'new.name', title: 'Name',          placeholder: 'Porta Ingresso', value: this.storage.getItem('new.name') || '' },
      { group: 'Add Sensor', key: 'new.kind', title: 'Type',          value: this.storage.getItem('new.kind') || 'contact', choices: ['contact','motion','occupancy'] as any },
      { group: 'Add Sensor', key: 'new.create', title: 'Create sensor', type: 'boolean', description: 'Toggle ON to create the sensor.' },
    );

    for (const cfg of this.sensorsCfg) {
      const gid = `Sensor: ${cfg.name} [${cfg.id}]`;
      out.push(
        { group: gid, key: `sensor.${cfg.id}.name`, title: 'Name', value: cfg.name },
        { group: gid, key: `sensor.${cfg.id}.kind`, title: 'Type', value: cfg.kind, choices: ['contact','motion','occupancy'] as any },
      );
      if (cfg.kind === 'contact')
        out.push({ group: gid, key: `sensor.${cfg.id}.topic.contact`,   title: 'Contact State Topic',   value: cfg.topics.contact || '', placeholder: 'paradox/states/zones/XYZ/open (supporta +/#)' });
      else if (cfg.kind === 'motion')
        out.push({ group: gid, key: `sensor.${cfg.id}.topic.motion`,    title: 'Motion Detected Topic', value: cfg.topics.motion || '' });
      else
        out.push({ group: gid, key: `sensor.${cfg.id}.topic.occupancy`, title: 'Occupancy Detected Topic', value: cfg.topics.occupancy || '' });

      out.push(
        { group: gid, key: `sensor.${cfg.id}.topic.batteryLevel`, title: 'Battery Level Topic (0..100)', value: cfg.topics.batteryLevel || '' },
        { group: gid, key: `sensor.${cfg.id}.topic.lowBattery`,  title: 'Low Battery Topic (bool)',      value: cfg.topics.lowBattery || '' },
        { group: gid, key: `sensor.${cfg.id}.topic.tamper`,      title: 'Tamper Topic',                  value: cfg.topics.tamper || '' },
        { group: gid, key: `sensor.${cfg.id}.topic.online`,      title: 'Online Topic',                  value: cfg.topics.online || '' },
        { group: gid, key: `sensor.${cfg.id}.remove`,            title: 'Remove sensor', type: 'boolean' },
      );
    }
    return out;
  }

  async putSetting(key: string, value: string | number | boolean): Promise<void> {
    this.storage.setItem(key, String(value));

    if (key === 'new.create' && String(value) === 'true') {
      const id   = (this.storage.getItem('new.id') || '').trim();
      const name = (this.storage.getItem('new.name') || '').trim() || id;
      const kind = (this.storage.getItem('new.kind') || 'contact').trim() as SensorKind;
      if (!id) { this.console.warn('Create sensor: id mancante'); return; }
      if (this.sensorsCfg.find(s => s.id === id)) { this.console.warn('Create sensor: id già esistente'); return; }

      this.sensorsCfg.push({ id, name, kind, topics: {} });
      this.saveSensorsToStorage();

      this.storage.removeItem('new.id'); this.storage.removeItem('new.name');
      this.storage.removeItem('new.kind'); this.storage.removeItem('new.create');

      this.safeDiscoverSensors(true);
      await this.connectMqtt(true);
      return;
    }

    const m = key.match(/^sensor\.([^\.]+)\.(.+)$/);
    if (m) {
      const sid = m[1];
      const prop = m[2];
      const cfg = this.sensorsCfg.find(s => s.id === sid);
      if (!cfg) { this.console.warn('putSetting: sensor non trovato', sid); return; }

      if (prop === 'remove' && String(value) === 'true') {
        this.sensorsCfg = this.sensorsCfg.filter(s => s.id !== sid);
        this.saveSensorsToStorage();
        try { (sdk as any)?.deviceManager?.onDeviceRemoved?.(`sensor:${sid}`); } catch {}
        this.storage.removeItem(key);
        this.safeDiscoverSensors(true);
        await this.connectMqtt(true);
        return;
      }

      if (prop === 'name') cfg.name = String(value);
      else if (prop === 'kind') cfg.kind = String(value) as SensorKind;
      else if (prop.startsWith('topic.')) {
        const tk = prop.substring('topic.'.length) as keyof SensorTopics;
        (cfg.topics as any)[tk] = String(value).trim();
      }

      this.saveSensorsToStorage();
      this.safeDiscoverSensors(true);
      await this.connectMqtt(true);
      return;
    }

    if (key === 'sensorsJson') {
      this.loadSensorsFromStorage();
      this.safeDiscoverSensors(true);
      await this.connectMqtt(true);
    } else {
      await this.connectMqtt(true);
    }
  }

  /** ---- DeviceProvider ---- */
  async getDevice(nativeId: string) { return this.devices.get(nativeId); }
  async releaseDevice(_id: string, nativeId: string): Promise<void> {
    try {
      const dev = this.devices.get(nativeId);
      if (dev) this.devices.delete(nativeId);
      try { (sdk as any)?.deviceManager?.onDeviceRemoved?.(nativeId); } catch {}
    } catch (e) {
      this.console.warn('releaseDevice error', e);
    }
  }

  private loadSensorsFromStorage() {
    try {
      const raw = this.storage.getItem('sensorsJson') || '[]';
      const parsed: SensorConfig[] = JSON.parse(raw);
      this.sensorsCfg = (parsed || []).filter(x => x && x.id && x.name && x.kind && x.topics);
    } catch (e) {
      this.console.error('Invalid sensorsJson:', e);
      this.sensorsCfg = [];
    }
  }

  private safeDiscoverSensors(triggeredByChange = false) {
    const dmAny: any = (sdk as any)?.deviceManager;
    if (!dmAny) {
      if (!this.discoveryPostponed) {
        this.console.log('Device discovery postponed: deviceManager not ready yet.');
        this.discoveryPostponed = true;
      }
      return;
    }
    this.discoveryPostponed = false;
    this.discoverSensors(dmAny);
    if (triggeredByChange) this.console.log('Sensors discovered/updated.');
  }

  private discoverSensors(dmAny: any) {
    const manifests = this.sensorsCfg.map(cfg => {
      const nativeId = `sensor:${cfg.id}`;
      const t = cfg.topics || {};
      const interfaces: TScryptedInterface[] = [ ScryptedInterface.Online ];
      if (t.tamper) interfaces.push(ScryptedInterface.TamperSensor);
      if (cfg.kind === 'contact') interfaces.unshift(ScryptedInterface.EntrySensor);
      else if (cfg.kind === 'motion') interfaces.unshift(ScryptedInterface.MotionSensor);
      else interfaces.unshift(ScryptedInterface.OccupancySensor);
      if (t.batteryLevel || t.lowBattery) interfaces.push(ScryptedInterface.Battery);
      return { nativeId, name: cfg.name, type: ScryptedDeviceType.Sensor, interfaces };
    });

    if (typeof dmAny.onDevicesChanged === 'function') dmAny.onDevicesChanged({ devices: manifests });
    else if (typeof dmAny.onDeviceDiscovered === 'function') for (const m of manifests) dmAny.onDeviceDiscovered(m);

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
      const hasBattery = !!(cfg.topics.batteryLevel || cfg.topics.lowBattery);
      if (hasBattery && (dev as any).batteryLevel === undefined)
        setAndEmit(dev, 'batteryLevel', 100, ScryptedInterface.Battery, `[${cfg.name}] batteryLevel=100 (default)`);
    }

    const announced = new Set(manifests.map(m => m.nativeId));
    for (const [nativeId] of this.devices) {
      if (!announced.has(nativeId)) {
        try { this.devices.delete(nativeId); dmAny.onDeviceRemoved?.(nativeId); } catch {}
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
    const opts: IClientOptions = { clientId, username, password, clean: true, reconnectPeriod: 3000 };
    if (tls) { (opts as any).protocol = 'mqtts'; (opts as any).rejectUnauthorized = rejectUnauthorized; }
    return { url, opts };
  }

  private collectAllSubscriptions(): string[] {
    const subs = new Set<string>();
    for (const k of ['topicGetTarget','topicGetCurrent','topicTamper','topicOnline'] as const) {
      const v = this.storage.getItem(k); if (v) subs.add(v);
    }
    for (const s of this.sensorsCfg) {
      const t = s.topics || {};
      [t.contact, t.motion, t.occupancy, t.batteryLevel, t.lowBattery, t.tamper, t.online]
        .filter(Boolean).forEach(x => subs.add(String(x)));
    }
    return Array.from(subs);
  }

  private async connectMqtt(_reconnect = false) {
    const subs = this.collectAllSubscriptions();
    if (!subs.length && !this.storage.getItem('topicSetTarget'))
      this.console.warn('Configura almeno un topic nelle impostazioni.');

    if (this.client) { try { this.client.end(true); } catch {}; this.client = undefined; }

    const { url, opts } = this.getMqttOptions();
    this.console.log(`Connecting MQTT ${url} ...`);
    const client = mqtt.connect(url, opts);
    this.client = client;

    const tTarget = this.storage.getItem('topicGetTarget') || '';
    const tCurrent = this.storage.getItem('topicGetCurrent') || '';
    const tTamper = this.storage.getItem('topicTamper') || '';
    const tOnline = this.storage.getItem('topicOnline') || '';

    client.on('connect', () => {
      this.console.log('MQTT connected');
      setAndEmit(this, 'online', true, ScryptedInterface.Online, `[Alarm] online=true`);
      if (subs.length) client.subscribe(subs, { qos: 0 }, (err?: Error | null) => { if (err) this.console.error('subscribe error', err); });
      this.safeDiscoverSensors(true);
    });

    client.on('reconnect', () => this.console.log('MQTT reconnecting...'));
    client.on('close', () => { this.console.log('MQTT closed'); setAndEmit(this, 'online', false, ScryptedInterface.Online, `[Alarm] online=false`); });
    client.on('error', (e: Error) => { this.console.error('MQTT error', e); });

    client.on('message', (topic: string, payload: Buffer) => {
      try {
        const raw = payload?.toString() ?? '';
        const np = normalize(raw);

        if (topicMatches(topic, tOnline)) {
          if (truthy(np) || np === 'online') setAndEmit(this, 'online', true, ScryptedInterface.Online, `[Alarm] online=true (${topic})`);
          else if (falsy(np) || np === 'offline') setAndEmit(this, 'online', false, ScryptedInterface.Online, `[Alarm] online=false (${topic})`);
          return;
        }

        if (topicMatches(topic, tTamper)) {
          if (truthy(np) || ['tamper','intrusion','cover'].includes(np)) {
            const t = (['cover','intrusion'].find(x => x === np) as any) || true;
            setAndEmit(this, 'tampered', t, ScryptedInterface.TamperSensor, `[Alarm] tampered=${t} (${topic})`);
          } else if (falsy(np)) {
            setAndEmit(this, 'tampered', false, ScryptedInterface.TamperSensor, `[Alarm] tampered=false (${topic})`);
          }
          return;
        }

        if (topicMatches(topic, tCurrent)) {
          const mode = payloadToMode(payload);
          const isAlarm = ['alarm','triggered'].includes(np);
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
          if (!deepEqual(this.securitySystemState, newState)) {
            this.securitySystemState = newState;
            try { this.onDeviceEvent?.(ScryptedInterface.SecuritySystem, newState); } catch {}
            this.console.log(`[Alarm] currentState=${JSON.stringify(newState)} (${topic})`);
          }
          return;
        }

        if (topicMatches(topic, tTarget)) {
          this.pendingTarget = payloadToMode(payload);
          this.console.log(`[Alarm] target reported: "${raw}" -> ${this.pendingTarget} (${topic})`);
          return;
        }

        // Sensors: se discovery rimandata, riprova
        if (this.discoveryPostponed) this.safeDiscoverSensors(true);

        for (const dev of this.devices.values())
          dev.handleMqtt(topic, payload);

      } catch (e) {
        this.console.error('MQTT message handler error', e);
      }
    });
  }

  /** ---- SecuritySystem commands ---- */
  private publishSetTarget(payload: string) {
    const topic = this.storage.getItem('topicSetTarget');
    if (!topic || !this.client) { this.console.warn('topicSetTarget o MQTT non configurati.'); return; }
    const retain = this.storage.getItem('retain') === 'true';
    const qosNum = Number(this.storage.getItem('qos') || 0);
    const qos = Math.max(0, Math.min(2, isFinite(qosNum) ? qosNum : 0)) as 0 | 1 | 2;
    this.client.publish(topic, payload, { qos, retain }, (err?: Error | null) => {
      if (err) this.console.error('publish error', err);
    });
  }

  async armSecuritySystem(mode: TSecuritySystemMode): Promise<void> {
    const payload = this.getOutgoing(mode);
    this.console.log('armSecuritySystem', mode, '->', payload);
    this.pendingTarget = mode;
    this.publishSetTarget(payload);
  }

  async disarmSecuritySystem(): Promise<void> {
    const payload = this.getOutgoing(SecuritySystemMode.Disarmed);
    this.console.log('disarmSecuritySystem ->', payload);
    this.pendingTarget = SecuritySystemMode.Disarmed;
    this.publishSetTarget(payload);
  }

  private getOutgoing(mode: TSecuritySystemMode) {
    const map: Record<number, string> = {
      [SecuritySystemMode.Disarmed]: this.storage.getItem('payloadDisarm') || DEFAULT_OUTGOING[SecuritySystemMode.Disarmed],
      [SecuritySystemMode.HomeArmed]: this.storage.getItem('payloadHome')  || DEFAULT_OUTGOING[SecuritySystemMode.HomeArmed],
      [SecuritySystemMode.AwayArmed]: this.storage.getItem('payloadAway')  || DEFAULT_OUTGOING[SecuritySystemMode.AwayArmed],
      [SecuritySystemMode.NightArmed]: this.storage.getItem('payloadNight')|| DEFAULT_OUTGOING[SecuritySystemMode.NightArmed],
    };
    return map[mode as unknown as number];
  }
}

export default ParadoxMqttSecuritySystem;