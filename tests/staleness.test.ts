import assert from "node:assert/strict";
import test from "node:test";
import { sweepStale } from "../src/staleness.js";

test("an entry quiet for longer than it is allowed is marked and told once, and the ones skipped or still fresh are left alone", () => {
  const entries = [{ id: "old", stale: false, receivedAtMs: 0 }, { id: "fresh", stale: false, receivedAtMs: 900 }, { id: "example", stale: false, receivedAtMs: 0 }, { id: "told", stale: true, receivedAtMs: 0 }, { id: "edge", stale: false, receivedAtMs: 500 }];
  const told: string[] = [];
  sweepStale(entries, 1000, 500, entry => told.push(entry.id), entry => entry.id === "example");
  assert.deepEqual(told, ["old"], "the one exactly at the limit is not yet quiet");
  assert.deepEqual(entries.map(entry => entry.stale), [true, false, false, true, false]);
  sweepStale(entries, 1000, 500, entry => told.push(entry.id), entry => entry.id === "example");
  assert.deepEqual(told, ["old"], "it is told once");
});
