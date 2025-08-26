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

/** Parse incoming payload -> final mode (ignore transition states) */
function payloadToMode(payload: string | Buffer | undefined): SecuritySystemMode | undefined {
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

  // transitori: non cambiano il mode
  if (['entry_delay', 'exit_delay', 'pending', 'arming', 'disarming'].includes(p))
    return undefined;

  return undefined;
}

/** ----------------- Sensor Support ----------------- */
type SensorKind = 'contact' | 'motion' | 'occupancy';

type SensorTopics = {
  // primary state:
  contact?: string;      // -> EntrySensor.entryOpen
  motion?: string;       // -> MotionSensor.motionDetected
  occupancy?: string;    // -> OccupancySensor.occupied

  // extras:
  batteryLevel?: string; // number 0..100
  lowBattery?: string;   // boolean; usato se manca batteryLevel
  tamper?: string;       // boolean / string
  online?: string;       // "online"/"offline" or bool
};

type SensorConfig = {
  id: string;
  name: string;
  kind: SensorKind;
  topics: SensorTopics;
};

abstract class BaseMqttSensor extends ScryptedDeviceBase implements Online, TamperSensor, Battery {
  protected cfg: SensorConfig;

  constructor(nativeId: string, cfg: SensorConfig) {
    super(nativeId);
    this.cfg = cfg;
    this.online = this.online ?? true;
  }

  /** Called by parent on each MQTT message */
  handleMqtt(topic: string, payload: Buffer) {
    const p = payload?.toString() ?? '';
    const np = normalize(p);

    // online
    if (topic === this.cfg.topics.online) {
      if (truthy(np) || np === 'online') this.online = true;
      if (falsy(np) || np === 'offline') this.online = false;
    }

    // tamper
    if (topic === this.cfg.topics.tamper) {
      if (truthy(np) || ['tamper', 'intrusion', 'cover', 'motion', 'magnetic'].includes(np)) {
        (this as any).tampered = (['cover','intrusion','motion','magnetic'].find(x => x === np) as any) || true;
      } else if (falsy(np)) {
        (this as any).tampered = false;
      }
    }

    // battery
    if (topic === this.cfg.topics.batteryLevel) {
      const n = clamp(parseFloat(p), 0, 100);
      if (isFinite(n)) (this as any).batteryLevel = n;
    } else if (topic === this.cfg.topics.lowBattery && !this.cfg.topics.batteryLevel) {
      // sintetizza se non c'è batteryLevel
      (this as any).batteryLevel = truthy(np) ? 10 : 100;
    }

    // primary handled by subclasses
    this.handlePrimary(topic, np, p);
  }

  protected abstract handlePrimary(topic: string, np: string, raw: string): void;
}

class ContactMqttSensor extends BaseMqttSensor implements EntrySensor {
  constructor(nativeId: string, cfg: SensorConfig) {
    super(nativeId, cfg);
  }
  protected handlePrimary(topic: string, np: string, _raw: string) {
    if (topic === this.cfg.topics.contact) {
      (this as any).entryOpen = truthy(np);
    }
  }
}

class MotionMqttSensor extends BaseMqttSensor implements MotionSensor {
  constructor(nativeId: string, cfg: SensorConfig) {
    super(nativeId, cfg);
  }
  protected handlePrimary(topic: string, np: string, _raw: string) {
    if (topic === this.cfg.topics.motion) {
      (this as any).motionDetected = truthy(np);
    }
  }
}

class OccupancyMqttSensor extends BaseMqttSensor implements OccupancySensor {
  constructor(nativeId: string, cfg: SensorConfig) {
    super(nativeId, cfg);
  }
  protected handlePrimary(topic: string, np: string, _raw: string) {
    if (topic === this.cfg.topics.occupancy) {
      (this as any).occupied = truthy(np);
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
    this.discoverSensors();

    // Connect on start
    this.connectMqtt().catch(e => this.console.error('MQTT connect error:', e));

    // chiusura pulita del client MQTT ai reload/stop del plugin
    try {
      process.once('SIGTERM', () => { try { this.client?.end(true); } catch {} });
      process.once('SIGINT',  () => { try { this.client?.end(true); } catch {} });
      process.on('exit',      () => { try { this.client?.end(true); } catch {} });
    } catch {}
  }

  /** ---- Settings UI ---- */

  async getSettings(): Promise<Setting[]> {
    return [
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

      { group: 'Outgoing Payloads', key: 'payloadDisarm', title: 'Payload Disarm', value: this.storage.getItem('payloadDisarm') || DEFAULT_OUTGOING[SecuritySystemMode.Disarmed] },
      { group: 'Outgoing Payloads', key: 'payloadHome', title: 'Payload HomeArmed', value: this.storage.getItem('payloadHome') || DEFAULT_OUTGOING[SecuritySystemMode.HomeArmed] },
      { group: 'Outgoing Payloads', key: 'payloadAway', title: 'Payload AwayArmed', value: this.storage.getItem('payloadAway') || DEFAULT_OUTGOING[SecuritySystemMode.AwayArmed] },
      { group: 'Outgoing Payloads', key: 'payloadNight', title: 'Payload NightArmed', value: this.storage.getItem('payloadNight') || DEFAULT_OUTGOING[SecuritySystemMode.NightArmed] },

      // Sensors config (JSON)
      {
        group: 'Sensors',
        key: 'sensorsJson',
        title: 'Sensors JSON (contact/motion/occupancy)',
        description: 'Definisci i sensori e i topic MQTT (vedi README).',
        type: 'string',
        multiline: true,
        value: this.storage.getItem('sensorsJson') || '[\n  {\n    "id": "front-door",\n    "name": "Front Door",\n    "kind": "contact",\n    "topics": { "contact": "SYSTEM/zones/front/contact" }\n  }\n]'
      },
    ];
  }

  async putSetting(key: string, value: string | number | boolean): Promise<void> {
    this.storage.setItem(key, String(value));
    if (key === 'sensorsJson') {
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

  private async discoverSensors() {
    const announced = new Set<string>();

    for (const cfg of this.sensorsCfg) {
      const nativeId = `sensor:${cfg.id}`;
      announced.add(nativeId);

      let interfaces: ScryptedInterface[] = [ScryptedInterface.Online, ScryptedInterface.TamperSensor, ScryptedInterface.Battery];
      switch (cfg.kind) {
        case 'contact': interfaces = [ScryptedInterface.EntrySensor, ...interfaces]; break;
        case 'motion': interfaces = [ScryptedInterface.MotionSensor, ...interfaces]; break;
        case 'occupancy': interfaces = [ScryptedInterface.OccupancySensor, ...interfaces]; break;
      }

      deviceManager.onDeviceDiscovered({
        nativeId,
        name: cfg.name,
        type: ScryptedDeviceType.Sensor,
        interfaces,
      });

      // create/update instance
      let dev = this.devices.get(nativeId);
      if (!dev) {
        if (cfg.kind === 'contact') dev = new ContactMqttSensor(nativeId, cfg);
        else if (cfg.kind === 'motion') dev = new MotionMqttSensor(nativeId, cfg);
        else dev = new OccupancyMqttSensor(nativeId, cfg);
        this.devices.set(nativeId, dev);
      } else {
        // update config reference
        (dev as any).cfg = cfg;
      }
    }

    // drop removed sensors
    for (const [nativeId, dev] of this.devices) {
      if (!announced.has(nativeId)) {
        try {
          this.devices.delete(nativeId);
          deviceManager.onDeviceRemoved?.(nativeId);
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
      const t = s.topics;
      [t.contact, t.motion, t.occupancy, t.batteryLevel, t.lowBattery, t.tamper, t.online]
        .filter(Boolean)
        .forEach(x => subs.add(String(x)));
    }

    return Array.from(subs);
  }

  private async connectMqtt(reconnect = false) {
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
      if (subs.length) {
        client.subscribe(subs, { qos: 0 }, (err?: Error | null) => {
          if (err) this.console.error('subscribe error', err);
        });
      }
    });

    client.on('reconnect', () => this.console.log('MQTT reconnecting...'));
    client.on('close', () => { this.console.log('MQTT closed'); this.online = false; });
    client.on('error', (e: Error) => { this.console.error('MQTT error', e); });

    client.on('message', (topic: string, payload: Buffer) => {
      try {
        const p = payload?.toString() ?? '';
        const np = normalize(p);

        // ---- Alarm handling ----
        if (topic === tOnline) {
          if (truthy(np) || np === 'online') this.online = true;
          if (falsy(np) || np === 'offline') this.online = false;
          return;
        }

        if (topic === tTamper) {
          if (truthy(np) || ['tamper', 'intrusion', 'cover'].includes(np)) {
            (this as any).tampered = (['cover','intrusion'].find(x => x === np) as any) || true;
          } else if (falsy(np)) {
            (this as any).tampered = false;
          }
          return;
        }

        if (topic === tCurrent) {
          const mode = payloadToMode(payload);
          const isAlarm = ['alarm', 'triggered'].includes(np);
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
          return;
        }

        if (topic === tTarget) {
          this.pendingTarget = payloadToMode(payload);
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

  private getOutgoing(mode: SecuritySystemMode) {
    const map: Record<SecuritySystemMode, string> = {
      [SecuritySystemMode.Disarmed]: this.storage.getItem('payloadDisarm') || DEFAULT_OUTGOING[SecuritySystemMode.Disarmed],
      [SecuritySystemMode.HomeArmed]: this.storage.getItem('payloadHome') || DEFAULT_OUTGOING[SecuritySystemMode.HomeArmed],
      [SecuritySystemMode.AwayArmed]: this.storage.getItem('payloadAway') || DEFAULT_OUTGOING[SecuritySystemMode.AwayArmed],
      [SecuritySystemMode.NightArmed]: this.storage.getItem('payloadNight') || DEFAULT_OUTGOING[SecuritySystemMode.NightArmed],
    };
    return map[mode];
  }
}

export default ParadoxMqttSecuritySystem;