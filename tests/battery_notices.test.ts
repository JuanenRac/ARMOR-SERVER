// Battery alarms told once and discreet, silenced batteries, and a single spoiled reading that must not fix the day's widest gap.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AlarmCentre, AlarmRules } from "../src/alarms.js";
import { BatteryNotices, BatteryNoticesInvalid, GapGate, problemOf } from "../src/battery_notices.js";
import { ENERGY_ALARM_DEFAULTS } from "../src/energy_alarms.js";
import type { SolarBattery } from "../src/solar.js";
import { CellExtremes } from "../src/solar_cells.js";
import { tempDir } from "./helpers.js";

const HOUR = 3_600_000;
const battery = (cells: number[][], extra: Partial<SolarBattery> = {}): SolarBattery => ({
  kind: "battery", node_id: "solar-1", device: "bank-1", timestamp_ms: 1000, modules: cells.length, stack: cells.map((list, index) => ({ n: index + 1, present: true, cells_v: list })), ...extra,
});

function rig(dir = tempDir(), clock = { now: 1_000_000 }) {
  const notices = new BatteryNotices(path.join(dir, "battery-notices.json"), () => clock.now);
  const centre = new AlarmCentre({ file: path.join(dir, "alarms.json"), onRaised: alarm => notices.raised(alarm), onCleared: alarm => notices.cleared(alarm) });
  const rules = new AlarmRules(centre, () => "disarmed", () => ENERGY_ALARM_DEFAULTS);
  rules.batteryWorse = (key, id, subjects) => { if (notices.observe(key, id, subjects) && id) centre.waitAgain(id); };
  const quiet = () => centre.active().filter(alarm => !alarm.cleared_at).map(alarm => `${alarm.code}:${notices.view(alarm).quiet}`).sort();
  return { notices, centre, rules, quiet, clock, dir };
}

test("a problem is new once; the same one again is known, until it has been over for a day", () => {
  const { rules, quiet, clock } = rig();
  const on = battery([[3.33, 3.34]], { alarm: true }), off = battery([[3.33, 3.34]], { alarm: false });
  rules.handleSolar(on);
  assert.deepEqual(quiet(), ["solar_battery_alarm:new"]);
  for (let i = 0; i < 5; i += 1) { rules.handleSolar(off); clock.now += 60_000; rules.handleSolar(on); assert.deepEqual(quiet(), ["solar_battery_alarm:known"], "a reading that goes up and down is not news"); }
  rules.handleSolar(off);
  clock.now += 25 * HOUR;
  rules.handleSolar(on);
  assert.deepEqual(quiet(), ["solar_battery_alarm:new"]);
});

test("a problem that gets worse is new again: a protection that trips, another weak cell", () => {
  const { rules, quiet } = rig();
  const on = (extra: Partial<SolarBattery>, soh: number[] = [2]) => ({ ...battery([[3.33, 3.34, 3.33, 3.34]], { alarm: true, ...extra }), stack: [{ n: 1, present: true, soh_counts: [0], soh_abnormal: soh }] });
  rules.handleSolar(on({}));
  rules.handleSolar({ ...on({}), alarm: false });
  rules.handleSolar(on({}));
  assert.deepEqual(quiet(), ["solar_battery_alarm:known", "solar_cell_soh_abnormal:new"]);
  for (const alarm of centre.active()) centre.acknowledge(alarm.id, "owner");
  rules.handleSolar(on({ protecting: true }));
  assert.equal(centre.active().filter(alarm => !alarm.acknowledged_at).length, 1, "the one that got worse waits again");
  assert.ok(quiet().includes("solar_battery_alarm:new"));
});

test("what was told survives a restart, a silenced battery or module says so, and classic is as before", () => {
  const first = rig();
  first.rules.handleSolar(battery([[3.33, 3.34]], { alarm: true }));
  first.rules.handleSolar(battery([[3.33, 3.34]], { alarm: false }));
  first.centre.flush();
  const second = rig(first.dir, first.clock);
  second.rules.handleSolar(battery([[3.33, 3.34]], { alarm: true }));
  assert.deepEqual(second.quiet(), ["solar_battery_alarm:known"]);
  second.notices.silence("solar-1/bank-1", true, "owner");
  assert.deepEqual(second.quiet(), ["solar_battery_alarm:silenced"]);
  second.notices.silence("solar-1/bank-1", false, "owner");
  second.notices.silence("solar-1/bank-1/2", true, "owner");
  assert.deepEqual(second.quiet(), ["solar_battery_alarm:known"], "a silenced module does not silence the alarm of the whole stack");
  second.notices.set({ mode: "classic" });
  assert.deepEqual(second.quiet(), ["solar_battery_alarm:undefined"]);
  assert.throws(() => second.notices.silence("../x", true, "owner"), BatteryNoticesInvalid);
  assert.throws(() => second.notices.set({ mode: "loud" }), BatteryNoticesInvalid);
  assert.equal(problemOf("solar:a/b:counter:2:bat ov times:7"), "solar:a/b:counter:2:bat ov times");
});

test("one spoiled reading (a gap of 1851 mV) fixes no maximum and raises nothing; it is listed", () => {
  const extremes = new CellExtremes({ dayOf: () => "2026-01-01" });
  const good = battery([[3.340, 3.350], [3.341, 3.352]]);
  extremes.observe("solar-1/bank-1", good, 1);
  extremes.observe("solar-1/bank-1", battery([[3.340, 3.350], [1.501, 3.352]]), 2);
  extremes.observe("solar-1/bank-1", good, 3);
  const day = extremes.get("solar-1/bank-1", 4)!;
  assert.equal(day.bank_delta_v, 0.012);
  assert.deepEqual([day.bank!.low.module, day.bank!.low.cell, day.bank!.high.module], [1, 1, 2]);
  assert.deepEqual(day.discarded, [{ at: 3, module: 2, delta_v: 1.851, reason: "unconfirmed" }]);
  extremes.observe("solar-1/bank-1", battery([[0, 3.350], [3.341, 3.352]]), 5);
  assert.ok(day.discarded!.some(item => item.reason === "range" && item.module === 1 && item.cell === 1));
  assert.equal(extremes.get("solar-1/bank-1", 6)!.bank_delta_v, 0.012, "a voltage no cell can have is left out");
  const { rules, quiet } = rig();
  rules.handleSolar(battery([[1.501, 3.352]]));
  rules.handleSolar(good);
  assert.deepEqual(quiet(), []);
});

test("a cell that really is out shows in two readings, and the day can be started again", () => {
  const extremes = new CellExtremes({ dayOf: () => "2026-01-01" });
  extremes.observe("solar-1/bank-1", battery([[3.350, 3.590]]), 1);
  extremes.observe("solar-1/bank-1", battery([[3.351, 3.589]]), 2);
  assert.equal(extremes.get("solar-1/bank-1", 3)!.modules[0]!.delta_v, 0.238);
  extremes.observe("solar-1/bank-1", battery([[3.352, 3.588]]), 4);
  assert.equal(extremes.get("solar-1/bank-1", 5)!.bank_delta_v, 0.236);
  assert.equal(extremes.reset("solar-1/bank-1", 6), true);
  assert.deepEqual(extremes.get("solar-1/bank-1", 7), { date: "2026-01-01", modules: [], bank_delta_v: 0, reset_at: 6 });
  assert.equal(extremes.reset("solar-1/none", 8), false);
  const gate = new GapGate();
  assert.deepEqual(gate.judge("k", 300, "same", 100, 0), {});
  assert.deepEqual(gate.judge("k", 300, "same", 100, 60_000), {}, "the same reading repeated is not a second reading");
  assert.deepEqual(gate.judge("k", 300, "same", 100, 600_000), { gap: 300 });
});
