import assert from "node:assert/strict";
import test from "node:test";
import type { AuditLog } from "../src/audit.js";
import type { CameraConnection } from "../src/cameras/model.js";
import { AlarmCapture, nodeOfAlarmEvent } from "../src/capture_on_alarm.js";
import type { ArmorEvent } from "../src/events.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";

// A house 20 m wide and deep: camera cam-1 at the corner of node "radar-a", camera cam-2 far away at the opposite corner, next to "radar-b".
const design = {
  dimensions: { width: 20, depth: 20 },
  cameras: [{ id: "cam-1", x: 5, y: 5 }, { id: "cam-2", x: 95, y: 95 }],
  sensors: [{ node: "radar-a", x: 6, y: 6 }, { node: "radar-b", x: 94, y: 94 }],
};
const cam = (id: string) => ({ id, name: id } as unknown as CameraConnection);
const at = "2026-01-01T00:00:00.000Z";
const alarm = (over: Record<string, unknown> = {}): ArmorEvent => ({ id: 1, at, type: "alarm", alarm_id: "alm-00001", state: "raised", severity: "high", source: "radar-a", source_type: "node", code: "intrusion", ...over }) as ArmorEvent;

function build(over: { enabled?: boolean; perMinute?: number; site?: Record<string, unknown> | null } = {}) {
  const asked: string[] = [];
  const audits: Array<{ outcome: string; target?: string }> = [];
  let clock = 1_000_000;
  const capture = new AlarmCapture({
    enabled: () => over.enabled ?? true, perMinute: () => over.perMinute ?? 6, site: () => (over.site === undefined ? design : over.site),
    cameras: () => [cam("cam-1"), cam("cam-2"), cam("cam-3")], trigger: async camera => { asked.push(camera.id); return null; },
    audit: { record: (entry: { outcome: string; target?: string }) => { audits.push(entry); } } as unknown as AuditLog, now: () => clock,
  });
  return { capture, asked, audits, advance: (ms: number) => { clock += ms; } };
}

test("the option is off by default and turning it on counts as a loss of protection", () => {
  assert.equal(SECURITY_DEFAULTS["capture.on_alarm"], false);
  assert.equal(SECURITY_DEFAULTS["capture.on_alarm_per_min"], 6);
  assert.equal(lowers("capture.on_alarm", false, true), true);
  assert.equal(lowers("capture.on_alarm", true, false), false);
  assert.equal(lowers("capture.on_alarm_per_min", 6, 60), false);
});

test("a high alarm of a node starts the cameras that cover it and only them", () => {
  const { capture, asked, audits } = build();
  assert.equal(capture.handle(alarm()), 1);
  assert.deepEqual(asked, ["cam-1"]);
  assert.deepEqual(audits.map(item => `${item.outcome}:${item.target}`), ["allowed:cam-1"]);
  asked.length = 0;
  assert.equal(capture.handle(alarm({ source: "radar-b", severity: "critical", id: 2 })), 1);
  assert.deepEqual(asked, ["cam-2"]);
});

test("the alert level of a node going to high starts it, going anywhere else does not", () => {
  const { capture, asked } = build();
  const alert = (to: string) => ({ id: 3, at, type: "alert", node_id: "radar-a", from: "normal", to, targets: 1 }) as unknown as ArmorEvent;
  assert.equal(capture.handle(alert("normal")), 0);
  assert.equal(capture.handle(alert("review")), 0);
  assert.equal(capture.handle(alert("high")), 1);
  assert.deepEqual(asked, ["cam-1"]);
});

test("nothing starts when it is off, for a silent alarm, a camera, a lower severity or an alarm that ends", () => {
  assert.equal(build({ enabled: false }).capture.handle(alarm()), 0);
  const { capture, asked } = build();
  for (const event of [alarm({ silent: true }), alarm({ source_type: "camera", source: "cam-1" }), alarm({ severity: "warning" }), alarm({ state: "cleared" }), alarm({ state: "acknowledged" }),
    { id: 9, at, type: "mode", mode: "armed" } as ArmorEvent]) assert.equal(capture.handle(event), 0);
  assert.deepEqual(asked, []);
  assert.equal(nodeOfAlarmEvent(alarm({ silent: true })), undefined);
});

test("a design that cannot place the camera, or no design at all, starts nothing", () => {
  assert.equal(build({ site: null }).capture.handle(alarm()), 0);
  assert.equal(build({ site: { dimensions: { width: 20, depth: 20 }, cameras: [{ id: "cam-1", x: 5, y: 5 }], sensors: [] } }).capture.handle(alarm()), 0);
  assert.equal(build().capture.handle(alarm({ source: "unknown-node" })), 0);
});

test("no more than the limit of captures start in a minute, and the limit is audited", () => {
  const { capture, asked, audits, advance } = build({ perMinute: 2 });
  assert.equal(capture.handle(alarm()), 1);
  assert.equal(capture.handle(alarm({ id: 2 })), 1);
  assert.equal(capture.handle(alarm({ id: 3 })), 0);
  assert.equal(asked.length, 2);
  assert.equal(audits.at(-1)?.outcome, "denied");
  advance(60_000);
  assert.equal(capture.handle(alarm({ id: 4 })), 1);
});

test("a capture that fails, or a settings reader that throws, never reaches the caller", () => {
  const failing = new AlarmCapture({ enabled: () => { throw new Error("boom"); }, perMinute: () => 1, site: () => design, cameras: () => [], trigger: async () => null, audit: { record: () => undefined } as unknown as AuditLog });
  assert.equal(failing.handle(alarm()), 0);
  const rejecting = new AlarmCapture({ enabled: () => true, perMinute: () => 1, site: () => design, cameras: () => [cam("cam-1")], trigger: () => Promise.reject(new Error("camera down")), audit: { record: () => undefined } as unknown as AuditLog });
  assert.equal(rejecting.handle(alarm()), 1);
});
