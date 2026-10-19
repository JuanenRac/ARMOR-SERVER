// The extremes of the cells of each battery module over the day, and the alarm that wants the gap between the cells to last.
import assert from "node:assert/strict";
import test from "node:test";
import { AlarmCentre, AlarmRules } from "../src/alarms.js";
import { ENERGY_ALARM_DEFAULTS, parseEnergyAlarmSettings } from "../src/energy_alarms.js";
import { SolarStore, type SolarBattery } from "../src/solar.js";
import { CellExtremes } from "../src/solar_cells.js";
import { tempDir } from "./helpers.js";
import path from "node:path";

const stackOf = (modules: Array<number[] | null>): SolarBattery["stack"] => modules.map((cells, index) => (cells ? { n: index + 1, present: true, cells_v: cells } : { n: index + 1, present: false }));
const battery = (cells: Array<number[] | null>, extra: Partial<SolarBattery> = {}): SolarBattery => ({
  kind: "battery", node_id: "solar-1", device: "us3000-1", timestamp_ms: 3000, modules: cells.length, stack: stackOf(cells), ...extra,
});

test("the lowest and the highest cell of each module are kept with the cell and the moment, and the widest gap of the bank", () => {
  const extremes = new CellExtremes({ dayOf: ms => (ms < 1_000_000 ? "2026-01-01" : "2026-01-02") });
  extremes.observe("solar-1/us3000-1", battery([[3.32, 3.33, 3.34], [3.30, 3.31, 3.36]]), 100);
  extremes.observe("solar-1/us3000-1", battery([[3.31, 3.34, 3.35], [3.33, 3.31, 3.34]]), 200);
  const day = extremes.get("solar-1/us3000-1", 300)!;
  assert.equal(day.date, "2026-01-01");
  assert.deepEqual(day.modules[0], { n: 1, min: { v: 3.31, cell: 1, at: 200 }, max: { v: 3.35, cell: 3, at: 200 }, delta_v: 0.04 });
  assert.deepEqual(day.modules[1], { n: 2, min: { v: 3.3, cell: 1, at: 100 }, max: { v: 3.36, cell: 3, at: 100 }, delta_v: 0.06 });
  assert.equal(day.bank_delta_v, 0.06, "the bank's widest gap is the widest between the lowest and the highest cell of all the modules at one moment");
});

test("a module that is not there, sends no cells or sends nonsense changes nothing, and a new day starts again", () => {
  const extremes = new CellExtremes({ dayOf: ms => (ms < 1000 ? "2026-01-01" : "2026-01-02") });
  extremes.observe("solar-1/us3000-1", battery([null, [] ]), 10);
  extremes.observe("solar-1/us3000-1", { ...battery([[3.3]]), stack: [{ n: 1, present: true, cells_v: [Number.NaN] }] }, 20);
  assert.deepEqual(extremes.get("solar-1/us3000-1", 30)?.modules ?? [], []);
  extremes.observe("solar-1/us3000-1", battery([[3.3, 3.4]]), 40);
  assert.equal(extremes.get("solar-1/us3000-1", 50)!.modules.length, 1);
  assert.equal(extremes.get("solar-1/us3000-1", 5000), undefined, "yesterday's extremes are not today's");
  extremes.observe("solar-1/us3000-1", battery([[3.2, 3.5]]), 5000);
  assert.deepEqual(extremes.get("solar-1/us3000-1", 5001)!.modules[0]!.min, { v: 3.2, cell: 1, at: 5000 });
});

test("the extremes survive a restart and a damaged file is ignored", () => {
  const first = new CellExtremes({ dayOf: () => "2026-01-01" });
  first.observe("solar-1/us3000-1", battery([[3.3, 3.4]]), 10);
  const copy = JSON.parse(JSON.stringify(first.export()));
  const second = new CellExtremes({ dayOf: () => "2026-01-01" });
  second.import(copy);
  assert.deepEqual(second.get("solar-1/us3000-1", 20), first.get("solar-1/us3000-1", 20));
  const third = new CellExtremes({ dayOf: () => "2026-01-01" });
  third.import({ "solar-1/us3000-1": { date: "2026-01-01", modules: [{ n: 1, min: { v: 99, cell: 1, at: 1 }, max: { v: 3, cell: 1, at: 1 }, delta_v: 0 }] }, "../bad": {}, "x/y": 5 });
  assert.deepEqual(third.get("solar-1/us3000-1", 20)?.modules, []);
  third.import(null); third.import("text");
});

test("the store shows the extremes of today on a battery and nothing on an example reading", () => {
  let now = Date.parse("2026-03-01T12:00:00Z");
  const store = new SolarStore({ now: () => now });
  store.ingest(battery([[3.3, 3.31, 3.4]], { timestamp_ms: now }));
  const view = store.list().find(item => item.kind === "battery")!;
  assert.equal(view.day_cells?.modules[0]?.max.cell, 3);
  const exported = store.exportHistory();
  const again = new SolarStore({ now: () => now });
  again.importHistory(exported);
  again.ingest(battery([[3.35, 3.36]], { timestamp_ms: now }));
  assert.equal(again.list()[0]!.day_cells?.modules[0]?.max.v, 3.4, "what was seen before the restart is still counted");
  now += 1;
});

test("an unbalanced bank raises the alarm at once by default and only after the minutes the operator set when it is persistent", () => {
  const centre = new AlarmCentre({ file: path.join(tempDir(), "alarms.json") });
  let level = { ...ENERGY_ALARM_DEFAULTS };
  const rules = new AlarmRules(centre, () => "disarmed", () => level);
  const codes = () => centre.active().filter(alarm => !alarm.cleared_at).map(alarm => alarm.code).sort();
  const at = (minutes: number, max: number) => battery([[3.3]], { cell_min_v: 3.32, cell_max_v: max, timestamp_ms: 1_000_000 + minutes * 60_000 });
  rules.handleSolar(at(0, 3.46));
  assert.deepEqual(codes(), ["solar_cells_unbalanced"], "0 minutes: at once, as before");
  rules.handleSolar(at(1, 3.33));
  assert.deepEqual(codes(), []);
  level = { ...level, cell_spread_minutes: 10 };
  rules.handleSolar(at(2, 3.46));
  rules.handleSolar(at(8, 3.46));
  assert.deepEqual(codes(), [], "only six minutes");
  rules.handleSolar(at(9, 3.40));                                                  // back under 100 mV: the stretch starts again
  rules.handleSolar(at(10, 3.46));
  rules.handleSolar(at(19, 3.46));
  assert.deepEqual(codes(), [], "nine minutes since it started again");
  rules.handleSolar(at(20, 3.46));
  assert.deepEqual(codes(), ["solar_cells_unbalanced"]);
});

test("the persistence of the gap is a setting from 0 to 240 minutes", () => {
  assert.equal(parseEnergyAlarmSettings({}).cell_spread_minutes, 0);
  assert.equal(parseEnergyAlarmSettings({ cell_spread_minutes: 30 }).cell_spread_minutes, 30);
  for (const bad of [-1, 241, "5", null, Number.NaN]) assert.throws(() => parseEnergyAlarmSettings({ cell_spread_minutes: bad }), /cell_spread_minutes/);
});
