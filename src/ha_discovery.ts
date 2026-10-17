/**
 * Home Assistant's MQTT discovery for what the nodes report: the sensors of each solar inverter and battery, the channels of each electrical node and the state of each alarm panel,
 * described once (retained, under `<prefix>/<component>/<id>/config`) so that Home Assistant, which reads the same broker, finds them by itself. Optional and off by default
 * (ARMOR_HA_DISCOVERY=1), and read-only: every entity is a sensor or a binary sensor that reads the topic the node already publishes (armor/solar/..., armor/electrical/...,
 * armor/alarm/...), with a value template that picks one field out of the JSON. Nothing here commands anything: Home Assistant can look at the installation and cannot move it.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { AlarmNodeView } from "./alarm.js";
import { SOLAR_FAULTS } from "./alarms.js";
import type { ElectricalNodeView } from "./electrical.js";
import type { SolarDeviceView } from "./solar.js";

export type DiscoveryMessage = { topic: string; payload: string };

const SAFE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const slug = (...parts: string[]): string => parts.join("_").replace(/[^a-z0-9_]/g, "_");

type Entity = {
  component: "sensor" | "binary_sensor";
  key: string;                         // part of the unique id
  name: string;
  template: string;                    // picks the value out of the node's JSON
  unit?: string;
  deviceClass?: string;
  stateClass?: "measurement" | "total_increasing";
  payloadOn?: string;                  // for a binary sensor: what the template says when it is on
  icon?: string;
};

type Described = { deviceId: string; deviceName: string; model: string; topic: string; entities: Entity[] };

const measurement = (key: string, name: string, field: string, unit: string, deviceClass?: string, stateClass: Entity["stateClass"] = "measurement"): Entity =>
  ({ component: "sensor", key, name, template: `{{ value_json.${field} }}`, unit, deviceClass, stateClass });

function inverter(view: SolarDeviceView): Described {
  const entities: Entity[] = [
    measurement("pv_w", "Solar power", "pv_w", "W", "power"), measurement("out_w", "Load power", "out_w", "W", "power"), measurement("load_percent", "Load", "load_percent", "%"),
    measurement("battery_percent", "Battery charge", "battery_percent", "%", "battery"), measurement("battery_v", "Battery voltage", "battery_v", "V", "voltage"),
    measurement("battery_a", "Battery current", "battery_a", "A", "current"), measurement("grid_v", "Grid voltage", "grid_v", "V", "voltage"), measurement("heatsink_c", "Heat sink temperature", "heatsink_c", "°C", "temperature"),
    { component: "sensor", key: "mode", name: "Mode", template: "{{ value_json.mode }}", icon: "mdi:solar-power" },
    { component: "binary_sensor", key: "grid_charging", name: "Charging from the grid", template: "{{ 'ON' if value_json.ac_charging else 'OFF' }}", payloadOn: "ON" },
    { component: "binary_sensor", key: "fault", name: "Fault", template: `{{ 'ON' if value_json.mode == 'fault' or (value_json.warnings | select('in', [${[...SOLAR_FAULTS].map(name => `'${name}'`).join(", ")}]) | list | length) > 0 else 'OFF' }}`, payloadOn: "ON", deviceClass: "problem" },
  ];
  const r = view.reading;
  if (r.kind === "inverter" && typeof r.pv_energy_total_wh === "number") entities.push(measurement("pv_energy_total", "Energy made in all", "pv_energy_total_wh / 1000", "kWh", "energy", "total_increasing"));
  return { deviceId: slug("armor", view.node_id, view.device), deviceName: `${view.device} (${view.node_id})`, model: "Solar inverter", topic: `armor/solar/${view.node_id}/${view.device}/state`, entities };
}

function battery(view: SolarDeviceView): Described {
  const entities: Entity[] = [
    measurement("soc_percent", "Charge", "soc_percent", "%", "battery"), measurement("voltage_v", "Voltage", "voltage_v", "V", "voltage"), measurement("current_a", "Current", "current_a", "A", "current"),
    measurement("temperature_max_c", "Hottest cell temperature", "temperature_max_c", "°C", "temperature"), measurement("cell_min_v", "Weakest cell", "cell_min_v", "V", "voltage"),
    { component: "binary_sensor", key: "alarm", name: "Alarm", template: "{{ 'ON' if value_json.alarm else 'OFF' }}", payloadOn: "ON", deviceClass: "problem" },
  ];
  const r = view.reading;
  if (r.kind === "battery" && typeof r.power_w === "number") entities.push(measurement("power_w", "Power", "power_w", "W", "power"));
  return { deviceId: slug("armor", view.node_id, view.device), deviceName: `${view.device} (${view.node_id})`, model: "Battery", topic: `armor/solar/${view.node_id}/${view.device}/state`, entities };
}

function electrical(view: ElectricalNodeView): Described {
  const entities: Entity[] = [];
  view.reading.channels.forEach((channel, index) => {
    if (!SAFE.test(channel.id)) return;
    const base = `value_json.channels[${index}]`;
    const title = channel.label || channel.id;
    // the template looks the channel up by its id, so a node that reorders its channels keeps its entities
    const pick = (field: string) => `{{ (value_json.channels | selectattr('id', 'eq', '${channel.id}') | map(attribute='${field}') | first) }}`;
    void base;
    if (channel.power_w !== undefined) entities.push({ component: "sensor", key: `${channel.id}_power`, name: `${title} power`, template: pick("power_w"), unit: "W", deviceClass: "power", stateClass: "measurement" });
    if (channel.voltage_v !== undefined) entities.push({ component: "sensor", key: `${channel.id}_voltage`, name: `${title} voltage`, template: pick("voltage_v"), unit: "V", deviceClass: "voltage", stateClass: "measurement" });
    if (channel.current_a !== undefined) entities.push({ component: "sensor", key: `${channel.id}_current`, name: `${title} current`, template: pick("current_a"), unit: "A", deviceClass: "current", stateClass: "measurement" });
    if (channel.energy_kwh !== undefined) entities.push({ component: "sensor", key: `${channel.id}_energy`, name: `${title} energy`, template: pick("energy_kwh"), unit: "kWh", deviceClass: "energy", stateClass: "total_increasing" });
    if (channel.frequency_hz !== undefined) entities.push({ component: "sensor", key: `${channel.id}_frequency`, name: `${title} frequency`, template: pick("frequency_hz"), unit: "Hz", deviceClass: "frequency", stateClass: "measurement" });
  });
  return { deviceId: slug("armor", view.node_id), deviceName: view.node_id, model: "Electrical node", topic: `armor/electrical/${view.node_id}/state`, entities };
}

function alarmPanel(view: AlarmNodeView): Described {
  const entities: Entity[] = [
    { component: "sensor", key: "phase", name: "State", template: "{{ value_json.phase }}", icon: "mdi:shield-home" },
    { component: "sensor", key: "mode", name: "Mode", template: "{{ value_json.mode }}", icon: "mdi:shield-lock" },
    { component: "binary_sensor", key: "siren", name: "Siren", template: "{{ 'ON' if value_json.siren else 'OFF' }}", payloadOn: "ON", deviceClass: "sound" },
    { component: "binary_sensor", key: "alarm", name: "Alarm", template: "{{ 'ON' if value_json.phase == 'alarm' else 'OFF' }}", payloadOn: "ON", deviceClass: "safety" },
    { component: "binary_sensor", key: "locked_out", name: "Locked out", template: "{{ 'ON' if value_json.locked_out else 'OFF' }}", payloadOn: "ON", deviceClass: "lock" },
  ];
  for (const zone of view.state.zones) {
    if (!SAFE.test(zone.id)) continue;
    entities.push({ component: "binary_sensor", key: `zone_${zone.id}`, name: zone.name || zone.id, template: `{{ 'ON' if (value_json.zones | selectattr('id', 'eq', '${zone.id}') | map(attribute='state') | first) != 'normal' else 'OFF' }}`, payloadOn: "ON", deviceClass: "safety" });
  }
  return { deviceId: slug("armor", view.node_id), deviceName: view.node_id, model: "Alarm panel", topic: `armor/alarm/${view.node_id}/state`, entities };
}

/** The discovery messages for everything the server knows now. `prefix` is Home Assistant's discovery prefix ("homeassistant" unless it was changed there). */
export function discoveryMessages(prefix: string, solar: readonly SolarDeviceView[], electricalNodes: readonly ElectricalNodeView[], alarmNodes: readonly AlarmNodeView[]): DiscoveryMessage[] {
  const described: Described[] = [];
  for (const view of solar) if (!view.example && SAFE.test(view.node_id) && SAFE.test(view.device)) described.push(view.reading.kind === "inverter" ? inverter(view) : battery(view));
  for (const view of electricalNodes) if (SAFE.test(view.node_id)) described.push(electrical(view));
  for (const view of alarmNodes) if (SAFE.test(view.node_id)) described.push(alarmPanel(view));
  const out: DiscoveryMessage[] = [];
  for (const device of described) {
    for (const entity of device.entities) {
      const unique = slug(device.deviceId, entity.key);
      const config: Record<string, unknown> = {
        name: entity.name, unique_id: unique, object_id: unique, state_topic: device.topic, value_template: entity.template,
        device: { identifiers: [device.deviceId], name: device.deviceName, manufacturer: "A.R.M.O.R.", model: device.model },
        origin: { name: "A.R.M.O.R." },
      };
      if (entity.unit) config.unit_of_measurement = entity.unit;
      if (entity.deviceClass) config.device_class = entity.deviceClass;
      if (entity.stateClass) config.state_class = entity.stateClass;
      if (entity.icon) config.icon = entity.icon;
      if (entity.component === "binary_sensor") { config.payload_on = entity.payloadOn ?? "ON"; config.payload_off = "OFF"; }
      out.push({ topic: `${prefix}/${entity.component}/${unique}/config`, payload: JSON.stringify(config) });
    }
  }
  return out;
}

/**
 * Keeps Home Assistant told: says everything now, again every ten minutes (Home Assistant forgets when it restarts) and as soon as something new appears. `publish` sends one retained
 * message; it may throw while the broker is away, and the next round tries again.
 */
export class DiscoveryPublisher {
  readonly #sent = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  constructor(private readonly options: {
    prefix: string; publish: (topic: string, payload: string) => void;
    solar: () => readonly SolarDeviceView[]; electrical: () => readonly ElectricalNodeView[]; alarm: () => readonly AlarmNodeView[];
    everyMs?: number; warn?: (message: string) => void;
  }) {}

  /** One round: what changed since the last one goes out; with `all`, everything does. Returns how many messages were sent. */
  round(all = false): number {
    let sent = 0;
    const current = discoveryMessages(this.options.prefix, this.options.solar(), this.options.electrical(), this.options.alarm());
    for (const message of current) {
      if (!all && this.#sent.get(message.topic) === message.payload) continue;
      try { this.options.publish(message.topic, message.payload); this.#sent.set(message.topic, message.payload); sent += 1; }
      catch (error) { this.options.warn?.(`ARMOR_HA_DISCOVERY=NOT_SENT ${error instanceof Error ? error.message : "unknown error"}`); return sent; }
    }
    // What was announced and is not there any more (a node taken away): an empty retained message makes Home Assistant forget the entity instead of showing it unavailable for ever.
    const still = new Set(current.map(message => message.topic));
    for (const topic of [...this.#sent.keys()]) {
      if (still.has(topic)) continue;
      try { this.options.publish(topic, ""); this.#sent.delete(topic); sent += 1; }
      catch (error) { this.options.warn?.(`ARMOR_HA_DISCOVERY=NOT_SENT ${error instanceof Error ? error.message : "unknown error"}`); return sent; }
    }
    return sent;
  }
  /** Starts the rounds: a quick one every 15 s for what is new, a full one every `everyMs` (ten minutes). */
  start(): void {
    if (this.#timer) return;   // already running (the broker reconnected: this is called again)
    const full = this.options.everyMs ?? 600_000;
    let lastFull = 0;
    this.#timer = setInterval(() => { const all = Date.now() - lastFull >= full; if (all) lastFull = Date.now(); this.round(all); }, 15_000);
    this.#timer.unref();
  }
  /** Forget what was sent: the next round says everything (the broker reconnected). */
  forget(): void { this.#sent.clear(); }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
}
