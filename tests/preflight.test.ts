import assert from "node:assert/strict";
import test from "node:test";
import { buildPreflight } from "../src/preflight.js";

const empty = { nodes: [], panels: [], cameras: [], devices: [], alarms: [] };

test("a quiet installation is ready to arm", () => {
  const result = buildPreflight({ ...empty, nodes: [{ node_id: "radar-1", online: true }], panels: [{ node_id: "alarm-1", stale: false, open_zones: [] }], now: new Date("2000-01-01T00:00:00Z") });
  assert.deepEqual(result, { ready: true, checked_at: "2000-01-01T00:00:00.000Z", blocking: 0, warnings: 0, issues: [] });
});

test("a radar that does not answer, a silent panel and an open zone block; a camera that is down only warns", () => {
  const result = buildPreflight({
    nodes: [{ node_id: "radar-2", online: false }],
    panels: [{ node_id: "alarm-1", stale: true, open_zones: ["z1"] }, { node_id: "alarm-2", stale: false, open_zones: ["z3"] }],
    cameras: [{ id: "cam-01", status: "offline" }, { id: "cam-02", status: "online" }],
    devices: [], alarms: [],
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.issues.map(issue => `${issue.code}:${issue.id}${issue.detail ? "/" + issue.detail : ""}`), ["node_offline:radar-2", "panel_silent:alarm-1", "zone_open:alarm-2/z3", "camera_down:cam-01"]);
  assert.equal(result.blocking, 3);
  assert.equal(result.warnings, 1);
});

test("an open door blocks, a silent device that is expected to report warns, an unseen warning only warns", () => {
  const result = buildPreflight({
    ...empty,
    devices: [
      { id: "door-1", kind: "door", online: true, state: { open: true } },
      { id: "door-2", kind: "door", online: true, state: { open: false } },
      { id: "temp-1", kind: "climate", online: false, state: {}, expected_interval_s: 3600 },
      { id: "temp-2", kind: "climate", online: false, state: {} },
    ],
    alarms: [{ id: "a1", severity: "warning" }, { id: "a2", severity: "critical", acknowledged_at: "x" }, { id: "a3", severity: "high" }],
  });
  assert.deepEqual(result.issues.map(issue => `${issue.level}:${issue.code}:${issue.id}`), ["block:opening_open:door-1", "warn:device_offline:temp-1", "warn:alarm_unseen:a1", "block:alarm_unseen:a3"]);
});
