/**
 * Light load test of the daily log: a log that is full (every day at its event limit) must still take a sample in a small, steady time; the size bound must not make each sample pay for
 * serialising the whole log. The bounds themselves (days, bytes, events per day) must keep holding under a long run of samples.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DailyLog, DEFAULT_SENSOR_FIELDS } from "../src/daily_log.js";

const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 0, 10, 12, 0, 0);

function filled(maxBytes: number, maxEvents: number, days: number): { log: DailyLog; clock: { now: number } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-daily-load-"));
  const clock = { now: START };
  const log = new DailyLog({ file: path.join(dir, "daily-log.json"), enabled: () => true, days: () => days, readingEveryS: () => 10, powerEveryS: () => 5, maxEventsPerDay: maxEvents, maxBytes, sensorFields: DEFAULT_SENSOR_FIELDS, saveEveryMs: 3_600_000, now: () => clock.now });
  return { log, clock };
}

test("a full daily log takes a sample in steady time, whatever it already holds", () => {
  const { log, clock } = filled(64 * 1024 * 1024, 5000, 14);
  for (let day = 0; day < 14; day += 1) {
    for (let index = 0; index < 5000; index += 1) log.power(100 + (index % 7), START - (13 - day) * DAY_MS + index * 5_000);
  }
  assert.equal(log.size().days, 14);
  const started = process.hrtime.bigint();
  for (let index = 0; index < 400; index += 1) { clock.now = START + 14 * DAY_MS + index * 6_000; log.reading(`node${index % 5}`, "temperature", 20 + index % 3, clock.now); }
  const perSampleMs = Number(process.hrtime.bigint() - started) / 1e6 / 400;
  assert.ok(perSampleMs < 2, `a sample into a full log took ${perSampleMs.toFixed(2)} ms on average`);
});

test("the bounds hold over a long run of samples", () => {
  const { log } = filled(256 * 1024, 300, 3);
  for (let index = 0; index < 20_000; index += 1) {
    const at = START + index * 5_000;
    log.power(50 + (index % 11), at);
    log.reading(`n${index % 3}`, "humidity", 40 + (index % 5), at);
  }
  const size = log.size();
  assert.ok(size.days <= 3, `${size.days} days held`);
  assert.ok(size.events <= 3 * 300, `${size.events} events held`);
  assert.ok(log.dropped > 0);
  log.flush();
});
