// The conditions under which a cell gap is judged, and the record of the full charges. Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AlarmCentre, AlarmRules } from "../src/alarms.js";
import { CELL_JUDGE_DEFAULTS, FullCharges, gapCanBeJudged, parseCellJudgeSettings } from "../src/cell_judge.js";

const reading = (soc: number, current: number, cold = 20) => ({ soc_percent: soc, current_a: current, temperature_min_c: cold });

test("a gap is judged inside the window of its state of charge, current and temperature", () => {
  const judged = (soc: number, current: number, cold = 20) => gapCanBeJudged(reading(soc, current, cold), 120, 100);
  assert.equal(judged(50, 10), true);
  assert.equal(judged(95, 10), true);
  assert.equal(judged(97, 10), false);
  assert.equal(judged(14, -10), false);
  assert.equal(judged(90, 0.2), false);
  assert.equal(judged(85, 0.2), true);
  assert.equal(judged(11, 0), true);
  assert.equal(judged(50, 10, 5), false);
});

test("a wide gap and a reading that does not say enough are always judged", () => {
  assert.equal(gapCanBeJudged(reading(100, 0), 200, 100), true);
  assert.equal(gapCanBeJudged(reading(100, 0), 199, 100), false);
  assert.equal(gapCanBeJudged({ current_a: 0, temperature_min_c: 20 }, 120, 100), true);
  assert.equal(gapCanBeJudged({ soc_percent: 100, temperature_min_c: 20 }, 120, 100), true);
  assert.equal(gapCanBeJudged({ soc_percent: 100, current_a: 0 }, 120, 100), true);
  assert.equal(gapCanBeJudged(reading(100, 0), 120, 100, { ...CELL_JUDGE_DEFAULTS, hard_factor: 1 }), true);
});

test("the settings of the file keep their default when missing, of another kind or out of range", () => {
  assert.deepEqual(parseCellJudgeSettings(undefined), CELL_JUDGE_DEFAULTS);
  assert.deepEqual(parseCellJudgeSettings([1]), CELL_JUDGE_DEFAULTS);
  const read = parseCellJudgeSettings({ soc_max: 99, hard_factor: 0, temp_min_c: "5", other: 1 });
  assert.deepEqual(read, { ...CELL_JUDGE_DEFAULTS, soc_max: 99 });
});

test("each full charge is recorded with the gap of its last minutes, and kept on disk", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-full-")), "full-charges.json");
  const charges = new FullCharges(file);
  const minute = 60_000;
  for (let i = 0; i < 40; i += 1) charges.note("n/bank", i * minute, 99, i < 20 ? 200 : 30);
  assert.deepEqual(charges.list(), []);
  charges.note("n/bank", 40 * minute, 98, 40);
  charges.note("n/bank", 41 * minute, 97, 40);
  charges.note("n/bank", 42 * minute, 96, 40);
  const [bank] = charges.list();
  assert.equal(bank!.id, "n/bank");
  assert.equal(bank!.charges.length, 1);
  assert.equal(bank!.charges[0]!.max_gap_mv, 200);
  assert.equal(bank!.charges[0]!.mean_gap_mv, 31);
  assert.equal(bank!.charges[0]!.minutes, 40);
  // a long silence closes a charge too; a reading with no state of charge changes nothing
  charges.note("n/bank", 60 * minute, 100, 50);
  charges.note("n/bank", 61 * minute, undefined, 50);
  charges.note("n/bank", 200 * minute, 50, 10);
  assert.equal(charges.list()[0]!.charges.length, 2);
  assert.deepEqual(new FullCharges(file).list(), charges.list());
});

test("outside the window a gap neither raises nor clears the alarm", () => {
  const centre = new AlarmCentre({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-gap-")), "alarms.json") });
  const rules = new AlarmRules(centre, () => "disarmed");
  let at = 1_000_000;
  const send = (soc: number, high: number) => {
    at += 10_000;
    const message = { kind: "battery" as const, node_id: "solar-1", device: "bank-1", timestamp_ms: at, modules: 1, soc_percent: soc, current_a: 10, temperature_min_c: 20, temperature_max_c: 22, cell_min_v: 3.3, cell_max_v: high + at / 1e12, stack: [{ n: 1, present: true }] };
    rules.handleSolar(message);
  };
  const open = () => centre.active().some(alarm => alarm.code === "solar_cells_unbalanced" && !alarm.cleared_at);
  send(99, 3.42); send(99, 3.42); send(99, 3.42);
  assert.equal(open(), false);
  send(50, 3.42); send(50, 3.42);
  assert.equal(open(), true);
  send(99, 3.31); send(99, 3.31);
  assert.equal(open(), true);
  send(50, 3.31); send(50, 3.31);
  assert.equal(open(), false);
  send(99, 3.55); send(99, 3.55);
  assert.equal(open(), true);
});
