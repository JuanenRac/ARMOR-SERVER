// The counters of the life of a battery module (what its console prints in `stat`): they are checked on arrival, and a protection counter that goes up is told.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AlarmCentre, AlarmRules, type Alarm } from "../src/alarms.js";
import { parseSolarMessage, SEVERE_COUNTERS, type SolarBattery } from "../src/solar.js";
import { tempDir } from "./helpers.js";

const withCounters = (counters: unknown): unknown => ({ kind: "battery", node_id: "solar-1", device: "us3000-1", timestamp_ms: 5, modules: 1, stack: [{ n: 1, present: true, counters }] });

test("counters with the console's names and whole numbers are accepted, anything else is not", () => {
  assert.doesNotThrow(() => parseSolarMessage(withCounters({ bat_ov_times: 755, coc_times: 0, dsg_cap: 149287073 })));
  assert.doesNotThrow(() => parseSolarMessage(withCounters({})));
  for (const bad of [[1], "x", null, { Bat_OV: 1 }, { "bat ov": 1 }, { bat_ov_times: -1 }, { bat_ov_times: 1.5 }, { bat_ov_times: "5" }, { bat_ov_times: 10_000_000_000 }, Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`c${i}`, 1]))]) {
    assert.throws(() => parseSolarMessage(withCounters(bad)), /counters/);
  }
});

test("a protection counter that goes up raises an event, once for each new value, and the first sight and the other counters raise nothing", () => {
  const raised: Alarm[] = [];
  const centre = new AlarmCentre({ file: path.join(tempDir(), "alarms.json"), onRaised: alarm => { raised.push(alarm); } });
  const rules = new AlarmRules(centre, () => "disarmed");
  const codes = () => raised.filter(alarm => alarm.code === "solar_counter_rose");
  const at = (counters: Record<string, number>): SolarBattery => ({ kind: "battery", node_id: "solar-1", device: "us3000-1", timestamp_ms: 1, modules: 1, stack: [{ n: 1, present: true, counters }] });
  rules.handleSolar(at({ bat_ov_times: 755, data_items: 10 }));
  assert.equal(codes().length, 0, "the first time a counter is seen it is only remembered");
  rules.handleSolar(at({ bat_ov_times: 755, data_items: 11 }));
  assert.equal(codes().length, 0, "a counter of use going up is not a protection");
  rules.handleSolar(at({ bat_ov_times: 756, data_items: 12 }));
  assert.equal(codes().length, 1);
  rules.handleSolar(at({ bat_ov_times: 756, data_items: 13 }));
  assert.equal(codes().length, 1, "the same value is not told again");
  rules.handleSolar(at({ bat_ov_times: 0, data_items: 14 }));
  rules.handleSolar(at({ bat_ov_times: 1, data_items: 15 }));
  assert.equal(codes().length, 2, "a reset and a new rise are a new event");
  const detail = codes()[0]!.detail!;
  assert.deepEqual([detail.module, detail.counter, detail.from, detail.to], [1, "bat_ov_times", 755, 756]);
});

test("the severe counters are only counters of protections and errors", () => {
  for (const name of SEVERE_COUNTERS) assert.match(name, /^(lifealarm_times|bat_|input_|pwr_|coc|doc|sc_|cot|dot|bmicerr|system_error)/);
  assert.equal(SEVERE_COUNTERS.has("data_items"), false);
});
