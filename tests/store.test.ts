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

test("the latest targets are exposed with their positions, and stay through a heartbeat", () => {
  const store = new ArmorStore();
  store.telemetry(parseTelemetry({ node_id: "gate", timestamp_ms: 5, lux: 10, targets: [{ sensor_id: 2, track_id: 7, x_mm: -400, y_mm: 2500, speed_mm_s: 120 }] }));
  const seen = store.snapshot().nodes.gate.targets;
  assert.deepEqual(seen, [{ sensor_id: 2, track_id: 7, x_mm: -400, y_mm: 2500, speed_mm_s: 120, counted: true }]);
  store.health(parseHealth({ node_id: "gate", timestamp_ms: 6, online: true }));
  assert.equal(store.snapshot().nodes.gate.targets.length, 1);
  store.telemetry(parseTelemetry({ node_id: "gate", timestamp_ms: 7, lux: 10, targets: [] }));
  assert.deepEqual(store.snapshot().nodes.gate.targets, []);
});

test("a target inside an ignore zone is shown but not counted", () => {
  const store = new ArmorStore(undefined, { rules: () => ({ schema: 1, dwell_ms: 0, zones: [{ id: "z", name: "road", action: "ignore", x_min_mm: 0, x_max_mm: 1000, y_min_mm: 0, y_max_mm: 1000 }] }) });
  store.telemetry(parseTelemetry({ node_id: "gate", timestamp_ms: 5, lux: 10, targets: [{ sensor_id: 1, track_id: 1, x_mm: 500, y_mm: 500, speed_mm_s: 0 }, { sensor_id: 1, track_id: 2, x_mm: 2000, y_mm: 500, speed_mm_s: 0 }] }));
  const node = store.snapshot().nodes.gate;
  assert.equal(node.target_count, 1);
  assert.deepEqual(node.targets.map(target => target.counted), [false, true]);
});

test("a node's own panel address is kept beside its state, and repeating it does not spend a revision", () => {
  const store = new ArmorStore();
  store.health({ node_id: "north-1", timestamp_ms: 10, online: true });
  assert.equal(store.snapshot().nodes["north-1"].panel, null);
  const info = { node_id: "north-1", timestamp_ms: 11, name: "North gate", firmware: "0.2.3", ip: "192.168.0.181", port: 80 };
  const before = store.snapshot().revision;
  store.info(info);
  assert.deepEqual(store.snapshot().nodes["north-1"].panel, { name: "North gate", firmware: "0.2.3", ip: "192.168.0.181", port: 80 });
  assert.equal(store.snapshot().revision, before + 1);
  store.info({ ...info, timestamp_ms: 12 });
  assert.equal(store.snapshot().revision, before + 1, "the same words again change nothing");
  store.info({ ...info, ip: "192.168.0.190" });
  assert.equal(store.snapshot().nodes["north-1"].panel?.ip, "192.168.0.190");
  assert.equal(store.snapshot().revision, before + 2);
});

test("a node that only sent its info does not appear, and forgetting a node forgets its panel", () => {
  const store = new ArmorStore();
  store.info({ node_id: "quiet", timestamp_ms: 1, name: "Quiet", firmware: "0.2.3", ip: "10.0.0.5", port: 80 });
  assert.deepEqual(Object.keys(store.snapshot().nodes), []);
  store.health({ node_id: "quiet", timestamp_ms: 2, online: true });
  assert.equal(store.snapshot().nodes.quiet.panel?.ip, "10.0.0.5", "the address said before the node appeared is there when it does");
  assert.equal(store.removeNode("quiet"), true);
  store.health({ node_id: "quiet", timestamp_ms: 3, online: true });
  assert.equal(store.snapshot().nodes.quiet.panel, null);
});
