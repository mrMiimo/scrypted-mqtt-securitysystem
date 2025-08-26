import sdk, {
  ScryptedDeviceBase,
  ScryptedDeviceType,
  Settings,
  Setting,
  SecuritySystem,
  SecuritySystemMode,
  TamperSensor,
  Online,
} from '@scrypted/sdk';

import mqtt, { MqttClient, IClientOptions } from 'mqtt';

const { systemManager } = sdk;

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

/** Default payloads for PAI/PAI-MQTT-like setups */
const DEFAULT_OUTGOING: Record<SecuritySystemMode, string> = {
  [SecuritySystemMode.Disarmed]: 'disarm',
  [SecuritySystemMode.HomeArmed]: 'arm_home',
  [SecuritySystemMode.AwayArmed]: 'arm_away',
  [SecuritySystemMode.NightArmed]: 'arm_night',
};

/** Common incoming synonyms → SecuritySystemMode */
function payloadToMode(payload: string | Buffer | undefined): SecuritySystemMode | undefined {
  if (payload == null) return;
  const p = normalize(payload.toString());

  if (['disarm', 'disarmed', 'off', '0', 'idle', 'ready'].includes(p)) return SecuritySystemMode.Disarmed;
  if (['arm_home', 'home', 'stay', 'armed_home'].includes(p)) return SecuritySystemMode.HomeArmed;
  if (['arm_away', 'away', 'armed_away', 'arming', 'exit_delay'].includes(p)) return SecuritySystemMode.AwayArmed;
  if (['arm_night', 'night', 'armed_night'].includes(p)) return SecuritySystemMode.NightArmed;

  // Sometimes current_state may be 'alarm', 'entry_delay', etc.
  if (['entry_delay', 'pending', 'arming'].includes(p)) return undefined;

  return undefined;
}

class ParadoxMqttSecuritySystem extends ScryptedDeviceBase
  implements SecuritySystem, Settings, TamperSensor, Online {

  private client?: MqttClient;

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

    // Connect on start
    this.connectMqtt().catch(e => this.console.error('MQTT connect error:', e));

    // 🔻 chiusura pulita del client MQTT ai reload/stop del plugin
    process.once('SIGTERM', () => { try { this.client?.end(true); } catch {} });
    process.once('SIGINT',  () => { try { this.client?.end(true); } catch {} });
    process.on('exit',      () => { try { this.client?.end(true); } catch {} });
  }

  // --- Settings UI ---

  async getSettings(): Promise<Setting[]> {
    return [
      { group: 'MQTT', key: 'brokerUrl', title: 'Broker URL', placeholder: 'mqtt://127.0.0.1:1883', value: this.storage.getItem('brokerUrl') || 'mqtt://127.0.0.1:1883' },
      { group: 'MQTT', key: 'username', title: 'Username', type: 'string', value: this.storage.getItem('username') || '' },
      { group: 'MQTT', key: 'password', title: 'Password', type: 'password', value: this.storage.getItem('password') || '' },
      { group: 'MQTT', key: 'clientId', title: 'Client ID', placeholder: 'scrypted-paradox', value: this.storage.getItem('clientId') || 'scrypted-paradox' },
      { group: 'MQTT', key: 'tls', title: 'Use TLS', type: 'boolean', value: this.storage.getItem('tls') === 'true' },
      { group: 'MQTT', key: 'rejectUnauthorized', title: 'Reject Unauthorized (TLS)', type: 'boolean', value: this.storage.getItem('rejectUnauthorized') !== 'false', description: 'Disattiva solo con broker self-signed.' },

      { group: 'Topics', key: 'topicSetTarget', title: 'Set Target State (publish)', placeholder: 'paradox/control/partitions/Area_1', value: this.storage.getItem('topicSetTarget') || '' },
      { group: 'Topics', key: 'topicGetTarget', title: 'Get Target State (subscribe)', placeholder: 'paradox/states/partitions/Area_1/target_state', value: this.storage.getItem('topicGetTarget') || '' },
      { group: 'Topics', key: 'topicGetCurrent', title: 'Get Current State (subscribe)', placeholder: 'paradox/states/partitions/Area_1/current_state', value: this.storage.getItem('topicGetCurrent') || '' },
      { group: 'Topics', key: 'topicTamper', title: 'Get Status Tampered (subscribe)', placeholder: 'paradox/states/system/troubles/zone_tamper_trouble', value: this.storage.getItem('topicTamper') || '' },
      { group: 'Topics', key: 'topicOnline', title: 'Get Online (subscribe)', placeholder: 'paradox/interface/availability', value: this.storage.getItem('topicOnline') || '' },

      { group: 'Publish Options', key: 'qos', title: 'QoS', type: 'integer', value: parseInt(this.storage.getItem('qos') || '0') },
      { group: 'Publish Options', key: 'retain', title: 'Retain', type: 'boolean', value: this.storage.getItem('retain') === 'true' },

      { group: 'Outgoing Payloads', key: 'payloadDisarm', title: 'Payload Disarm', value: this.storage.getItem('payloadDisarm') || DEFAULT_OUTGOING[SecuritySystemMode.Disarmed] },
      { group: 'Outgoing Payloads', key: 'payloadHome', title: 'Payload HomeArmed', value: this.storage.getItem('payloadHome') || DEFAULT_OUTGOING[SecuritySystemMode.HomeArmed] },
      { group: 'Outgoing Payloads', key: 'payloadAway', title: 'Payload AwayArmed', value: this.storage.getItem('payloadAway') || DEFAULT_OUTGOING[SecuritySystemMode.AwayArmed] },
      { group: 'Outgoing Payloads', key: 'payloadNight', title: 'Payload NightArmed', value: this.storage.getItem('payloadNight') || DEFAULT_OUTGOING[SecuritySystemMode.NightArmed] },
    ];
  }

  async putSetting(key: string, value: string | number | boolean): Promise<void> {
    this.storage.setItem(key, String(value));
    await this.connectMqtt(true);
  }

  // --- MQTT ---

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

  private async connectMqtt(reconnect = false) {
    const subs = [
      this.storage.getItem('topicGetTarget'),
      this.storage.getItem('topicGetCurrent'),
      this.storage.getItem('topicTamper'),
      this.storage.getItem('topicOnline'),
    ].filter(Boolean) as string[];

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
        // Online
        if (topic === this.storage.getItem('topicOnline')) {
          if (truthy(p) || p.toLowerCase() === 'online') this.online = true;
          if (falsy(p) || p.toLowerCase() === 'offline') this.online = false;
          return;
        }

        // Tamper
        if (topic === this.storage.getItem('topicTamper')) {
          const np = normalize(p);
          if (truthy(np) || ['tamper', 'intrusion', 'cover', 'motion', 'magnetic'].includes(np)) {
            (this as any).tampered = (['cover','intrusion','motion','magnetic'].find(x => x === np) as any) || true;
          } else if (falsy(np)) {
            (this as any).tampered = false;
          }
          return;
        }

        // Target/Current → mode/triggered
        if ([this.storage.getItem('topicGetTarget'), this.storage.getItem('topicGetCurrent')].includes(topic)) {
          const mode = payloadToMode(payload);
          const isAlarm = ['alarm', 'triggered'].includes(normalize(p));
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
      } catch (e) {
        this.console.error('MQTT message handler error', e);
      }
    });
  }

  // --- SecuritySystem commands ---

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
    this.publishSetTarget(payload);

    // Optimistic UI update until broker echoes target/current state
    const st = this.securitySystemState || { mode: SecuritySystemMode.Disarmed };
    this.securitySystemState = { ...st, mode, triggered: false };
  }

  async disarmSecuritySystem(): Promise<void> {
    const payload = this.getOutgoing(SecuritySystemMode.Disarmed);
    this.console.log('disarmSecuritySystem ->', payload);
    this.publishSetTarget(payload);

    const st = this.securitySystemState || { mode: SecuritySystemMode.Disarmed };
    this.securitySystemState = { ...st, mode: SecuritySystemMode.Disarmed, triggered: false };
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
