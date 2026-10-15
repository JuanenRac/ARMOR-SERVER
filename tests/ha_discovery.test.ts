import assert from "node:assert/strict";
import test from "node:test";
import { DiscoveryPublisher, discoveryMessages } from "../src/ha_discovery.js";
import type { SolarDeviceView } from "../src/solar.js";
import type { ElectricalNodeView } from "../src/electrical.js";
import type { AlarmNodeView } from "../src/alarm.js";
import { readConfig } from "../src/config.js";

const inverter: SolarDeviceView = {
  node_id: "solar-1", device: "axpert-1", kind: "inverter", received_at: "2026-01-01T00:00:00Z", stale: false, example: false,
  reading: { kind: "inverter", node_id: "solar-1", device: "axpert-1", timestamp_ms: 1, mode: "line", grid_v: 230, grid_hz: 50, out_v: 230, out_hz: 50, out_va: 100, out_w: 80, load_percent: 3, battery_v: 52, battery_a: 1, battery_percent: 90, pv_v: 100, pv_a: 1, pv_w: 100, heatsink_c: 40, ac_charging: false, pv_charging: true, load_on: true, warnings: [], pv_energy_total_wh: 5000 },
};
const stack: SolarDeviceView = {
  node_id: "solar-1", device: "us3000-1", kind: "battery", received_at: "2026-01-01T00:00:00Z", stale: false, example: false,
  reading: { kind: "battery", node_id: "solar-1", device: "us3000-1", timestamp_ms: 1, modules: 1, stack: [], soc_percent: 80, voltage_v: 51, current_a: 2, power_w: 100 },
};
const exampleReading: SolarDeviceView = { ...inverter, device: "demo", example: true };
const electrical: ElectricalNodeView = {
  node_id: "elec-1", received_at: "2026-01-01T00:00:00Z", stale: false,
  reading: { kind: "electrical", node_id: "elec-1", timestamp_ms: 1, channels: [{ id: "grid", domain: "ac", label: "Grid", voltage_v: 230, power_w: 400, energy_kwh: 12.5, frequency_hz: 50 }, { id: "BAD ID", domain: "ac", power_w: 1 }, { id: "heater", domain: "ac", power_w: 1000 }] },
};
const alarm: AlarmNodeView = {
  node_id: "alarm-1", received_at: "2026-01-01T00:00:00Z", stale: false,
  state: { kind: "alarm", node_id: "alarm-1", timestamp_ms: 1, phase: "disarmed", mode: "disarmed", siren: false, locked_out: false, commands_enabled: false, zones: [{ id: "front-door", name: "Front door", kind: "entry", state: "normal", bypassed: false }, { id: "Bad Zone", kind: "instant", state: "normal", bypassed: false }], open_zones: [], events: [] },
};

test("every entity is described once, read-only, under the discovery prefix", () => {
  const messages = discoveryMessages("homeassistant", [inverter, stack, exampleReading], [electrical], [alarm]);
  const topics = messages.map(message => message.topic);
  assert.equal(new Set(topics).size, topics.length);
  for (const topic of topics) assert.match(topic, /^homeassistant\/(sensor|binary_sensor)\/[a-z0-9_]+\/config$/);
  const byTopic = new Map(messages.map(message => [message.topic, JSON.parse(message.payload) as Record<string, unknown>]));
  const solar = byTopic.get("homeassistant/sensor/armor_solar_1_axpert_1_pv_w/config")!;
  assert.equal(solar.state_topic, "armor/solar/solar-1/axpert-1/state");
  assert.equal(solar.value_template, "{{ value_json.pv_w }}");
  assert.equal(solar.unit_of_measurement, "W");
  assert.equal(solar.device_class, "power");
  assert.deepEqual((solar.device as { identifiers: string[] }).identifiers, ["armor_solar_1_axpert_1"]);
  // what the unit says about itself shows up when it said it, in kWh
  assert.equal((byTopic.get("homeassistant/sensor/armor_solar_1_axpert_1_pv_energy_total/config")!).value_template, "{{ value_json.pv_energy_total_wh / 1000 }}");
  assert.equal((byTopic.get("homeassistant/sensor/armor_solar_1_us3000_1_power_w/config")!).device_class, "power");
  // an example reading (made to try the menus) is not an entity
  assert.equal(topics.some(topic => topic.includes("demo")), false);
  // an electrical channel is looked up by its id, and one whose id is not a name is left out
  const grid = byTopic.get("homeassistant/sensor/armor_elec_1_grid_power/config")!;
  assert.match(String(grid.value_template), /selectattr\('id', 'eq', 'grid'\)/);
  assert.equal(grid.name, "Grid power");
  assert.equal(topics.some(topic => topic.includes("bad_id")), false);
  assert.equal((byTopic.get("homeassistant/sensor/armor_elec_1_grid_energy/config")!).state_class, "total_increasing");
  assert.equal(byTopic.has("homeassistant/sensor/armor_elec_1_heater_voltage/config"), false);   // it said no voltage
  // the alarm panel: its state, its siren, and a binary sensor for each zone
  assert.equal((byTopic.get("homeassistant/binary_sensor/armor_alarm_1_siren/config")!).payload_on, "ON");
  const zone = byTopic.get("homeassistant/binary_sensor/armor_alarm_1_zone_front_door/config")!;
  assert.equal(zone.name, "Front door");
  assert.match(String(zone.value_template), /!= 'normal'/);
  assert.equal(topics.some(topic => topic.includes("bad_zone")), false);
  // read-only: nothing here can command anything
  for (const message of messages) assert.equal(/command_topic|set_topic/.test(message.payload), false);
  // another prefix (Home Assistant's can be changed)
  assert.ok(discoveryMessages("ha", [inverter], [], []).every(message => message.topic.startsWith("ha/")));
  assert.deepEqual(discoveryMessages("homeassistant", [], [], []), []);
});

test("the publisher says what changed, everything again on demand, and keeps trying while the broker is away", () => {
  const sent: Array<[string, string]> = [];
  let down = false;
  let views = [inverter];
  const warnings: string[] = [];
  const publisher = new DiscoveryPublisher({
    prefix: "homeassistant", solar: () => views, electrical: () => [], alarm: () => [], warn: message => warnings.push(message),
    publish: (topic, payload) => { if (down) throw new Error("the MQTT broker is not connected"); sent.push([topic, payload]); },
  });
  const first = publisher.round();
  assert.equal(first, sent.length);
  assert.ok(first > 5);
  assert.equal(publisher.round(), 0);                                   // nothing changed: nothing is said again
  views = [inverter, stack];
  const more = publisher.round();                                       // a new device: only it is described
  assert.ok(more > 0);
  assert.ok(sent.slice(first).every(([topic]) => topic.includes("us3000_1")));
  assert.equal(publisher.round(true), first + more);                    // asked to say everything again
  down = true;
  publisher.forget();
  assert.equal(publisher.round(), 0);                                   // the broker is away: it is said once, and the round ends
  assert.equal(warnings.length, 1);
  down = false;
  assert.equal(publisher.round(), first + more);                        // back: everything goes out, since nothing was kept as sent
});

test("it is off unless asked for, and its prefix must be one word", () => {
  const base = { ARMOR_INGEST_TOKEN: "i".repeat(32), ARMOR_CONTROL_TOKEN: "c".repeat(32), ARMOR_STUDIO_USERNAME: "admin", ARMOR_STUDIO_PASSWORD: "p".repeat(16), ARMOR_COOKIE_SECURE: "0" };
  assert.equal(readConfig(base as NodeJS.ProcessEnv).haDiscovery, null);
  assert.deepEqual(readConfig({ ...base, ARMOR_HA_DISCOVERY: "1" } as NodeJS.ProcessEnv).haDiscovery, { prefix: "homeassistant" });
  assert.deepEqual(readConfig({ ...base, ARMOR_HA_DISCOVERY: "1", ARMOR_HA_DISCOVERY_PREFIX: "ha" } as NodeJS.ProcessEnv).haDiscovery, { prefix: "ha" });
  assert.throws(() => readConfig({ ...base, ARMOR_HA_DISCOVERY_PREFIX: "home/assistant" } as NodeJS.ProcessEnv), /one word/);
});
