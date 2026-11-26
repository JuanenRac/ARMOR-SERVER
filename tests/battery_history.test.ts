// The history by battery and cell: what is recorded, how long it is kept, how much room it may take and what a restart finds.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BatteryHistory, type BatteryHistoryOptions } from "../src/battery_history.js";
import type { SolarMessage } from "../src/solar.js";
import { startServer, studioCookie, tempDir } from "./helpers.js";

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 10, 12, 0, 0);

const message = (volts: number, cell = 3.3): SolarMessage => ({
  kind: "battery", node_id: "solar-1", device: "pack", timestamp_ms: START, modules: 1,
  stack: [{ n: 2, present: true, voltage_v: volts, current_a: 2, soc_percent: 80, temperature_c: 21, cells_v: [cell, Number((cell + 0.01).toFixed(3))] }],
}) as unknown as SolarMessage;

function make(extra: Partial<BatteryHistoryOptions> = {}) {
  const clock = { now: START };
  const options: BatteryHistoryOptions = { dir: path.join(tempDir(), "battery-history"), days: 30, everyS: 60, maxBytes: 8 * 1024 ** 2, now: () => clock.now, ...extra };
  return { clock, options, history: new BatteryHistory(options) };
}

test("a module and its cells are recorded at most once an interval, and a restart finds them", async () => {
  const { clock, options, history } = make();
  history.record(message(50));
  clock.now += 10_000;
  history.record(message(51));   // too soon
  clock.now += 60_000;
  history.record(message(52));
  const waiting = await history.query("solar-1", "pack", 2, 60);
  assert.deepEqual(waiting.map(sample => sample.voltage_v), [50, 52], "readable before they are written");
  history.close();
  const again = new BatteryHistory(options);
  const samples = await again.query("solar-1", "pack", 2, 60);
  assert.deepEqual(samples.map(sample => sample.voltage_v), [50, 52]);
  assert.equal(samples[0]!.cell1, 3.3);
  assert.equal(samples[0]!.cell2, 3.31);
  assert.equal(samples[0]!.delta_mv, 10);
  assert.equal(samples[0]!.power_w, 100);
  assert.deepEqual(await again.query("solar-1", "pack", 1, 60), [], "another module has nothing");
});

test("beyond a day the five-minute averages answer", async () => {
  const { clock, history } = make();
  for (const volts of [50, 52]) { history.record(message(volts)); clock.now += 60_000; }
  clock.now += 10 * 60_000;
  history.flush();
  const samples = await history.query("solar-1", "pack", 2, 10_080);
  assert.equal(samples.length, 1);
  assert.equal(samples[0]!.voltage_v, 51);
});

test("what is older than the retention goes away", () => {
  const { clock, options, history } = make({ days: 3 });
  history.record(message(50));
  history.close();
  clock.now += 2 * DAY;
  history.flush();
  assert.deepEqual(fs.readdirSync(options.dir), ["coarse-2026-01-10.jsonl"], "the fine points are kept for a day only");
  clock.now += 3 * DAY;
  history.flush();
  assert.deepEqual(fs.readdirSync(options.dir), []);
});

test("the files never take more than the size limit, the oldest day first", () => {
  const { clock, options, history } = make({ maxBytes: 500, everyS: 10 });
  for (let day = 0; day < 4; day += 1) {
    for (let step = 0; step < 4; step += 1) { history.record(message(50)); clock.now += 20_000; }
    history.close();
    assert.ok(history.size() <= 500, `day ${day}: ${history.size()} bytes`);
    clock.now += DAY;
  }
  assert.ok(!fs.readdirSync(options.dir).some(name => name.includes("2026-01-10")));
});

test("with 0 days nothing is recorded", async () => {
  const { options, history } = make({ days: 0 });
  history.record(message(50));
  history.close();
  assert.equal(fs.existsSync(options.dir), false);
  assert.deepEqual(await history.query("solar-1", "pack", 2, 60), []);
});

test("a line left half written spoils only itself, and a removed device is forgotten", async () => {
  const { clock, options, history } = make();
  history.record(message(50));
  history.flush();
  fs.appendFileSync(path.join(options.dir, "fine-2026-01-10.jsonl"), "[\"solar-1/pack/2\",17");
  clock.now += 60_000;
  history.record(message(52));
  history.flush();
  assert.deepEqual((await history.query("solar-1", "pack", 2, 60)).map(sample => sample.voltage_v), [50, 52]);
  history.forget("solar-1", "pack");
  assert.deepEqual(await history.query("solar-1", "pack", 2, 60), []);
});

test("the history route answers a module and its cells from what the server recorded", async () => {
  const running = await startServer({ ARMOR_BATTERY_HISTORY_EVERY_S: "10" });
  try {
    const cookie = await studioCookie(running.base);
    running.app.context.solar.ingest({ ...message(50), timestamp_ms: Date.now() } as SolarMessage);
    const ask = async (query: string) => {
      const response = await fetch(`${running.base}/api/v1/solar/history?${query}`, { headers: { cookie } });
      return { status: response.status, body: await response.json() as { module?: number; retention_days?: number; every_s?: number; samples: Array<Record<string, number>> } };
    };
    const one = await ask("node=solar-1&device=pack&minutes=60&module=2");
    assert.equal(one.status, 200);
    assert.deepEqual([one.body.module, one.body.retention_days, one.body.every_s, one.body.samples.length, one.body.samples[0]!.cell1], [2, 30, 10, 1, 3.3]);
    assert.equal((await ask("node=solar-1&device=pack&module=99")).status, 400);
    assert.equal((await ask("node=nobody&device=pack&module=1")).status, 404);
    const stack = await ask("node=solar-1&device=pack&minutes=60");
    assert.equal(stack.body.module, undefined);
  } finally { await running.stop(); }
});

test("the limits come from the environment and are checked", async () => {
  await assert.rejects(startServer({ ARMOR_BATTERY_HISTORY_DAYS: "31" }));
  await assert.rejects(startServer({ ARMOR_BATTERY_HISTORY_MAX_BYTES: "10" }));
});
