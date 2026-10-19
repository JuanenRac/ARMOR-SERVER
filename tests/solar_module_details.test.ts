// What a battery module tells about itself and its health: the model and the limits of the module, the state of health of each cell and the newest entry of its event log. They are
// checked on arrival, an abnormal cell and a current beyond the module's limit are told, and the log keeps each new entry once.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AlarmCentre, AlarmRules, type Alarm } from "../src/alarms.js";
import { parseSolarMessage, SolarStore, type SolarBattery } from "../src/solar.js";
import { SolarEventLog } from "../src/solar_events.js";
import { tempDir } from "./helpers.js";

const withModule = (module: Record<string, unknown>): unknown => ({ kind: "battery", node_id: "solar-1", device: "us2000-1", timestamp_ms: 5, modules: 1, stack: [{ n: 1, present: true, ...module }] });
const event = { index: 754, time: "25-03-09 19:01:42", voltage_v: 51.753, current_a: 0, temperature_c: 36, percent: 52, base_state: "Charge", voltage_state: "OV", power_events: "0x2 PHV", battery_events: "0x4 BVNOR", system_fault: "0x0" };

test("the details of a module are accepted when they are in range and refused when they are not", () => {
  assert.doesNotThrow(() => parseSolarMessage(withModule({ model: "US2000", board_version: "V10R04", main_soft_version: "B68.2.0.0", soft_version: "V2.6", cell_count: 15, max_charge_a: 53, max_discharge_a: 55, console_baud: 19200, soh_counts: [0, 13], soh_abnormal: [1], last_event: event })));
  for (const bad of [{ board_version: "" }, { soft_version: "x".repeat(25) }, { main_soft_version: 5 }, { model: "" }, { model: "x".repeat(25) }, { cell_count: 0 }, { cell_count: 33 }, { max_charge_a: -1 }, { max_discharge_a: 1001 }, { console_baud: 100 }, { soh_counts: [-1] }, { soh_abnormal: [32] },
                     { soh_counts: Array.from({ length: 33 }, () => 0) }, { last_event: { index: 1 } }, { last_event: { index: 1, time: "t", decoded: "x" } }, { last_event: { index: -1, time: "t" } }, { last_event: { index: 1, time: "t", percent: 101 } }]) {
    assert.throws(() => parseSolarMessage(withModule(bad)), /invalid module 0|unknown|invalid/, JSON.stringify(bad));
  }
});

test("a cell the console calls abnormal is told, once, and ends when the module is well again", () => {
  const raised: Alarm[] = [];
  const centre = new AlarmCentre({ file: path.join(tempDir(), "alarms.json"), onRaised: alarm => { raised.push(alarm); } });
  const rules = new AlarmRules(centre, () => "disarmed");
  const reading = (abnormal: number[]): SolarBattery => ({ kind: "battery", node_id: "solar-1", device: "us2000-1", timestamp_ms: 1, modules: 1, stack: [{ n: 1, present: true, soh_counts: [0, 0, 13], soh_abnormal: abnormal }] });
  rules.handleSolar(reading([]));
  assert.equal(raised.filter(alarm => alarm.code === "solar_cell_soh_abnormal").length, 0);
  rules.handleSolar(reading([2]));
  rules.handleSolar(reading([2]));
  const told = raised.filter(alarm => alarm.code === "solar_cell_soh_abnormal");
  assert.equal(told.length, 1);
  assert.deepEqual(told[0]!.detail, { module: 1, cell: 3, cells: 1 }, "the cell is told from 1, as a person counts them");
  rules.handleSolar(reading([]));
  assert.equal(centre.active().filter(alarm => alarm.code === "solar_cell_soh_abnormal" && !alarm.cleared_at).length, 0);
});

test("a current beyond the limit the module says is told, and ends with a margin", () => {
  const raised: Alarm[] = [];
  const centre = new AlarmCentre({ file: path.join(tempDir(), "alarms.json"), onRaised: alarm => { raised.push(alarm); } });
  const rules = new AlarmRules(centre, () => "disarmed");
  const reading = (current: number, limits = true): SolarBattery => ({ kind: "battery", node_id: "solar-1", device: "us2000-1", timestamp_ms: 1, modules: 1, stack: [{ n: 1, present: true, current_a: current, ...(limits ? { max_charge_a: 53, max_discharge_a: 55 } : {}) }] });
  const codes = () => raised.filter(alarm => alarm.code === "solar_module_overcurrent");
  rules.handleSolar(reading(40));
  rules.handleSolar(reading(-54));
  assert.equal(codes().length, 0, "inside the limits");
  rules.handleSolar(reading(60));
  assert.equal(codes().length, 1);
  assert.deepEqual([codes()[0]!.detail!.module, codes()[0]!.detail!.limit_a], [1, 53]);
  rules.handleSolar(reading(-60));
  assert.equal(codes().length, 1, "the same module is still over: not told again until it ends");
  rules.handleSolar(reading(10));
  assert.equal(centre.active().filter(alarm => alarm.code === "solar_module_overcurrent" && !alarm.cleared_at).length, 0);
  rules.handleSolar(reading(500, false));
  assert.equal(codes().length, 1, "a module that tells no limit is not judged");
});

test("the event log keeps each new entry once, newest first, and gives it back after a restart", () => {
  const log = new SolarEventLog();
  const message = (index: number, time: string): SolarBattery => ({ kind: "battery", node_id: "solar-1", device: "us2000-1", timestamp_ms: 1, modules: 1, stack: [{ n: 1, present: true, last_event: { ...event, index, time } }] });
  log.observe("solar-1/us2000-1", message(754, "25-03-09 19:01:42"), 1000);
  log.observe("solar-1/us2000-1", message(754, "25-03-09 19:01:42"), 2000);
  log.observe("solar-1/us2000-1", message(755, "25-03-09 20:00:00"), 3000);
  const shown = log.list("solar-1/us2000-1");
  assert.deepEqual(shown.map(item => item.event.index), [755, 754]);
  assert.equal(shown[1]!.event.power_events, "0x2 PHV", "the console's own words, not decoded");
  const again = new SolarEventLog();
  again.import(JSON.parse(JSON.stringify(log.export())));
  assert.deepEqual(again.list("solar-1/us2000-1").map(item => item.seen_at), [3000, 1000]);
  again.import({ "../x": [{ n: 1, seen_at: 1, event }], "a/b": [{ n: 99, seen_at: 1, event }, { n: 1, seen_at: "x", event }, 5, null] });
  assert.deepEqual(again.list("a/b"), [], "entries that are not entries are dropped");
  for (let i = 0; i < 100; i++) log.observe("solar-1/us2000-1", message(1000 + i, `t${i}`), 4000 + i);
  assert.equal(log.list("solar-1/us2000-1").length, 30);
  assert.equal(log.export()["solar-1/us2000-1"]!.length, 60);
  log.forget("solar-1/us2000-1");
  assert.deepEqual(log.list("solar-1/us2000-1"), []);
});

test("the device view carries the log of a battery", () => {
  const store = new SolarStore({ now: () => 1_000_000 });
  store.ingest(parseSolarMessage(withModule({ last_event: event })));
  const view = store.list().find(item => item.device === "us2000-1");
  assert.ok(view);
  assert.equal(view!.events?.length, 1);
  assert.equal(view!.events![0]!.event.battery_events, "0x4 BVNOR");
});
