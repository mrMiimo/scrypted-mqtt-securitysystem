// --- Preload: silenzia SOLO il warning facoltativo di sdk.json ---
// Copre console.error e console.warn (alcune versioni usano warn).
(() => {
  const swallow = (orig: (...args: any[]) => any) => (...args: any[]) => {
    const txt = args.map(a => typeof a === 'string' ? a : (a?.message || '')).join(' ');
    if (txt.includes('failed to load custom interface descriptors')) return;
    return orig(...args);
  };
  console.error = swallow(console.error.bind(console));
  console.warn  = swallow(console.warn.bind(console));
})();

// Carica lo SDK (runtime only: niente import ESM per evitare che il bundler lo esegua prima del preload)
const sdk = require('@scrypted/sdk');

// Valori runtime dal modulo SDK
const {
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,     // enum (valori)
  SecuritySystemMode,    // enum (valori)
  systemManager,
} = sdk;

// Tipi (spariscono a runtime)
import type {
  Settings, Setting, SecuritySystem, TamperSensor, Online, DeviceProvider,
  EntrySensor, MotionSensor, OccupancySensor, Battery,
  ScryptedInterface as TScryptedInterface,
  SecuritySystemMode as TSecuritySystemMode,
} from '@scrypted/sdk';

import mqtt, { MqttClient, IClientOptions } from 'mqtt';

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
function normalize(s: string) { return (s || '').trim().toLowerCase(); }
function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, n)); }

/** Outgoing predefiniti (PAI-like). Chiavi numeriche per compatibilità enum */
const DEFAULT_OUTGOING: Record<number, string> = {
  [SecuritySystemMode.Disarmed]: 'disarm',
  [SecuritySystemMode.HomeArmed]: 'arm_home',
  [SecuritySystemMode.AwayArmed]: 'arm_away',
  [SecuritySystemMode.NightArmed]: 'arm_night',
};

/** Parse incoming payload -> final mode (ignora transitori) */
function payloadToMode(payload: string | Buffer | undefined): TSecuritySystemMode | undefined {
  if (payload == null) return;
  const p = normalize(payload.toString());
  if (['disarm', 'disarmed', 'off', '0', 'idle', 'ready'].includes(p)) return SecuritySystemMode.Disarmed;
  if (['arm_home', 'home', 'stay', 'armed_home'].includes(p)) return SecuritySystemMode.HomeArmed;
  if (['arm_away', 'away', 'armed_away', 'away_armed'].includes(p)) return SecuritySystemMode.AwayArmed;
  if (['arm_night', 'night', 'armed_night', 'sleep', 'arm_sleep', 'armed_sleep'].includes(p)) return SecuritySystemMode.NightArmed;
  if (['entry_delay', 'exit_delay', 'pending', 'arming', 'disarming'].includes(p)) return undefined;
  return undefined;
}

/** ----------------- Sensor Support ----------------- */
type SensorKind = 'contact' | 'motion' | 'occupancy';

type SensorTopics = {
  contact?: string;
  motion?: string;
  occupancy?: string;
  batteryLevel?: string;
  lowBattery?: string;
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

  handleMqtt(topic: string, payload: Buffer) {
    const p = payload?.toString() ?? '';
    const np = normalize(p);

    if (topic === this.cfg.topics.online) {
      if (truthy(np) || np === 'online') this.online = true;
      if (falsy(np)  || np === 'offline') this.online = false;
    }

    if (topic === this.cfg.topics.tamper) {
      if (truthy(np) || ['tamper','intrusion','cover','motion','magnetic'].includes(np)) {
        this.tampered = (['cover','intrusion','motion','magnetic'].find(x => x === np) as any) || true;
      }
      else if (falsy(np)) this.tampered = false;
    }

    if (topic === this.cfg.topics.batteryLevel) {
      const n = clamp(parseFloat(p), 0, 100);
      if (isFinite(n)) this.batteryLevel = n;
    }
    else if (topic === this.cfg.topics.lowBattery && !this.cfg.topics.batteryLevel) {
      this.batteryLevel = truthy(np) ? 10 : 100;
    }

    this.handlePrimary(topic, np, p);
  }

  protected abstract handlePrimary(topic: string, np: string, raw: string): void;
}

class ContactMqttSensor extends BaseMqttSensor implements EntrySensor {
  entryOpen?: boolean;
  protected handlePrimary(topic: string, np: string) {
    if (topic === this.cfg.topics.contact) this.entryOpen = truthy(np);
  }
}
class MotionMqttSensor extends BaseMqttSensor implements MotionSensor {
  motionDetected?: boolean;
  protected handlePrimary(topic: string, np: string) {
    if (topic === this.cfg.topics.motion) this.motionDetected = truthy(np);
  }
}
class OccupancyMqttSensor extends BaseMqttSensor implements OccupancySensor {
  occupied?: boolean;
  protected handlePrimary(topic: string, np: string) {
    if (topic === this.cfg.topics.occupancy) this.occupied = truthy(np);
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

  // evitiamo spam: ricordiamo se abbiamo già provato ad annunciare
  private triedDiscoveryOnce = false;

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

    // Config sensori e (tentativo) announce
    this.loadSensorsFromStorage();
    this.safeDiscoverSensors(); // non spamma se deviceManager non c'è

    // Connect MQTT
    this.connectMqtt().catch((e: any) => this.console.error('MQTT connect error:', e));

    // Shutdown pulito
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

    // Sensors esistenti
    for (const cfg of this.sensorsCfg) {
      const gid = `Sensor: ${cfg.name} [${cfg.id}]`;
      out.push(
        { group: gid, key: `sensor.${cfg.id}.name`, title: 'Name', value: cfg.name },
        { group: gid, key: `sensor.${cfg.id}.kind`, title: 'Type', value: cfg.kind, choices: ['contact','motion','occupancy'] as any },
      );
      if (cfg.kind === 'contact')
        out.push({ group: gid, key: `sensor.${cfg.id}.topic.contact`,   title: 'Contact State Topic',   value: cfg.topics.contact || '' });
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

  /** Annuncia i sensori SOLO se deviceManager è pronto. Niente loop infinito. */
  private safeDiscoverSensors(triggeredByChange = false) {
    const dmAny: any = (sdk as any)?.deviceManager;
    if (!dmAny) {
      if (!this.triedDiscoveryOnce) {
        this.console.log('Device discovery postponed: deviceManager not ready yet.');
        this.triedDiscoveryOnce = true;
      }
      // Riprovaremo in due casi: a) settaggi cambiati (già chiama safeDiscoverSensors)
      // b) al primo messaggio MQTT (vedi handler sotto).
      return;
    }
    // Se arriviamo qui, il manager c’è: esegui discover.
    this.triedDiscoveryOnce = false;
    this.discoverSensors(dmAny);
  }

  /** discoverSensors con deviceManager garantito */
  private discoverSensors(dmAny: any) {
    // 1) Manifests
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

    // 2) Annuncio
    if (typeof dmAny.onDevicesChanged === 'function') {
      dmAny.onDevicesChanged({ devices: manifests });
    } else if (typeof dmAny.onDeviceDiscovered === 'function') {
      for (const m of manifests) dmAny.onDeviceDiscovered(m);
    }

    // 3) Istanzia/aggiorna
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
        (dev as any).batteryLevel = 100;
    }

    // 4) Cleanup
    const announced = new Set(manifests.map(m => m.nativeId));
    for (const [nativeId] of this.devices) {
      if (!announced.has(nativeId)) {
        try {
          this.devices.delete(nativeId);
          dmAny.onDeviceRemoved?.(nativeId);
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
      this.online = true;
      if (subs.length) client.subscribe(subs, { qos: 0 }, (err?: Error | null) => { if (err) this.console.error('subscribe error', err); });
      // Al primo connect riprova (silenziosamente) ad annunciare i sensori
      this.safeDiscoverSensors(true);
    });

    client.on('reconnect', () => this.console.log('MQTT reconnecting...'));
    client.on('close', () => { this.console.log('MQTT closed'); this.online = false; });
    client.on('error', (e: Error) => { this.console.error('MQTT error', e); });

    client.on('message', (topic: string, payload: Buffer) => {
      try {
        const p = payload?.toString() ?? '';
        const np = normalize(p);

        if (topic === tOnline) {
          if (truthy(np) || np === 'online') this.online = true;
          if (falsy(np)  || np === 'offline') this.online = false;
          return;
        }

        if (topic === tTamper) {
          if (truthy(np) || ['tamper','intrusion','cover'].includes(np))
            this.tampered = (['cover','intrusion'].find(x => x === np) as any) || true;
          else if (falsy(np)) this.tampered = false;
          return;
        }

        if (topic === tCurrent) {
          const mode = payloadToMode(payload);
          const isAlarm = ['alarm','triggered'].includes(np);
          const current = this.securitySystemState || { mode: SecuritySystemMode.Disarmed };
          this.securitySystemState = {
            mode: mode ?? current.mode,
            supportedModes: current.supportedModes ?? [
              SecuritySystemMode.Disarmed,
              SecuritySystemMode.HomeArmed,
              SecuritySystemMode.AwayArmed,
              SecuritySystemMode.NightArmed,
            ],
            triggered: isAlarm || undefined,
          };
          return;
        }

        if (topic === tTarget) {
          this.pendingTarget = payloadToMode(payload);
          this.console.log('Target state reported:', p, '->', this.pendingTarget);
          return;
        }

        // Dispatch ai sensori
        // (E prova ad annunciare se non l’abbiamo ancora fatto e ora il manager è pronto)
        if (this.triedDiscoveryOnce) this.safeDiscoverSensors(true);

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
    if (!topic || !this.client) {
      this.console.warn('topicSetTarget o MQTT non configurati.');
      return;
    }
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