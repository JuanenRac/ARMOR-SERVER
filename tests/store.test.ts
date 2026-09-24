import assert from "node:assert/strict";
import test from "node:test";
import { parseHealth, parseTelemetry } from "../src/contracts.js";
import { alertLevelFor, ArmorStore } from "../src/store.js";

const telemetry = (node: string, timestamp: number, targets: number, lux = 100) =>
  parseTelemetry({ node_id: node, timestamp_ms: timestamp, lux, targets: Array.from({ length: targets }, (_, index) => ({ sensor_id: 1, track_id: index + 1, x_mm: 1, y_mm: 2, speed_mm_s: 3 })) });

test("alert level follows target count and the security mode", () => {
  assert.equal(alertLevelFor("armed", 0), "normal");
  assert.equal(alertLevelFor("armed", 1), "review");
  assert.equal(alertLevelFor("armed", 2), "high");
  assert.equal(alertLevelFor("disarmed", 5), "review");
});

test("stale telemetry never replaces newer state", () => {
  const store = new ArmorStore();
  store.telemetry(telemetry("north-1", 2, 0, 2));
  store.telemetry(telemetry("north-1", 1, 0, 1));
  assert.equal(store.snapshot().nodes["north-1"].lux, 2);
});

test("a node that goes silent is reported stale and offline, then recovers", () => {
  let now = 1_000_000;
  const store = new ArmorStore(undefined, { staleAfterMs: 30_000, now: () => now });
  store.health(parseHealth({ node_id: "north-1", timestamp_ms: 1, online: true }));
  assert.equal(store.snapshot().nodes["north-1"].online, true);
  now += 30_001;
  const silent = store.snapshot().nodes["north-1"];
  assert.equal(silent.stale, true);
  assert.equal(silent.online, false);
  store.telemetry(telemetry("north-1", 2, 0));
  assert.equal(store.snapshot().nodes["north-1"].stale, false);
  assert.equal(store.snapshot().nodes["north-1"].online, true);
});

test("a node that reports itself offline stays offline even when heard from", () => {
  const store = new ArmorStore();
  store.health(parseHealth({ node_id: "north-1", timestamp_ms: 1, online: false }));
  assert.equal(store.snapshot().nodes["north-1"].online, false);
});

test("disarming clears a high alert immediately and arming re-raises it", () => {
  const store = new ArmorStore();
  store.arm("armed");
  store.telemetry(telemetry("north-1", 1, 3));
  assert.equal(store.snapshot().nodes["north-1"].alert_level, "high");
  store.arm("disarmed");
  assert.equal(store.snapshot().nodes["north-1"].alert_level, "review");
  store.arm("armed");
  assert.equal(store.snapshot().nodes["north-1"].alert_level, "high");
});

test("every change bumps the revision and notifies once", () => {
  const seen: number[] = [];
  const store = new ArmorStore(state => seen.push(state.revision));
  store.arm("armed");
  store.telemetry(telemetry("north-1", 1, 1));
  assert.deepEqual(seen, [1, 2]);
  assert.equal(store.snapshot().revision, 2);
});

test("the projection cannot be mutated from outside", () => {
  const store = new ArmorStore();
  store.telemetry(telemetry("north-1", 1, 1));
  const view = store.snapshot();
  view.nodes["north-1"].target_count = 99;
  assert.equal(store.snapshot().nodes["north-1"].target_count, 1);
});

test("telemetry validation refuses out-of-range and malformed input", () => {
  assert.throws(() => parseTelemetry({ node_id: "north-1", timestamp_ms: 1, lux: 1, targets: new Array(16).fill({}) }));
  assert.throws(() => parseTelemetry({ node_id: "Bad Node", timestamp_ms: 1, lux: 1, targets: [] }));
  assert.throws(() => parseTelemetry({ node_id: "n", timestamp_ms: -1, lux: 1, targets: [] }));
  assert.throws(() => parseTelemetry({ node_id: "n", timestamp_ms: 1, lux: 999999, targets: [] }));
  assert.throws(() => parseTelemetry({ node_id: "n", timestamp_ms: 1, lux: 1, targets: [{ sensor_id: 4, track_id: 1, x_mm: 0, y_mm: 0, speed_mm_s: 0 }] }));
  assert.throws(() => parseHealth({ node_id: "n", timestamp_ms: 1, online: "yes" }));
});

test("an offline message (the node's last will) is applied even though it is older, and never moves time backwards", () => {
  const store = new ArmorStore();
  store.health(parseHealth({ node_id: "north-1", timestamp_ms: 5000, online: true }));
  store.health(parseHealth({ node_id: "north-1", timestamp_ms: 100, online: false }));
  const node = store.snapshot().nodes["north-1"];
  assert.equal(node.online, false);
  assert.equal(node.timestamp_ms, 5000);
  // A fresh heartbeat brings it back; an older "online" message does not.
  store.health(parseHealth({ node_id: "north-1", timestamp_ms: 200, online: true }));
  assert.equal(store.snapshot().nodes["north-1"].online, false);
  store.health(parseHealth({ node_id: "north-1", timestamp_ms: 6000, online: true }));
  assert.equal(store.snapshot().nodes["north-1"].online, true);
});
