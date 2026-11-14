import assert from "node:assert/strict";
import test from "node:test";
import { AiGateway, FRAME_BYTES } from "../src/ai.js";
import { renderPrometheus } from "../src/metrics_export.js";
import type { MetricsSample } from "../src/system_metrics.js";
import { VisionCounters, VISION_KINDS, VISION_OUTCOMES, type VisionKind, type VisionOutcome } from "../src/vision_counters.js";
import { SECRETS, startServer } from "./helpers.js";

const AI_TOKEN = "a".repeat(32);
const SAMPLE: MetricsSample = { at_ms: 1, cpu: { percent: 1, cores: 1, load: [0, 0, 0] }, memory: { total: 10, used: 5, available: 5, swap_total: 0, swap_used: 0 }, temperatures: [], disks: [], network: [], uptime_s: 1 };
const page = (vision?: ReturnType<VisionCounters["rows"]>): string => renderPrometheus({ sample: SAMPLE, nodes: [], activeAlarms: 0, ingest: [], vision, version: "1.0.0", startedMs: 0, nowMs: 1000 });

test("every kind and outcome is listed from the start, in a fixed order, at zero", () => {
  const rows = new VisionCounters().rows();
  assert.equal(rows.length, VISION_KINDS.length * VISION_OUTCOMES.length);
  assert.deepEqual(rows.map(row => `${row.kind}/${row.outcome}`).slice(0, 4), ["alert/raised", "alert/recorded", "alert/ignored", "detection/raised"]);
  assert.ok(rows.every(row => row.count === 0));
});

test("an event is counted once in its own kind and outcome, and a name that is not a fixed one is dropped", () => {
  const counters = new VisionCounters();
  counters.record("alert", "raised"); counters.record("alert", "raised"); counters.record("activity", "ignored");
  counters.record("person" as VisionKind, "raised"); counters.record("alert", "anything" as VisionOutcome);
  const count = (kind: string, outcome: string): number => counters.rows().find(row => row.kind === kind && row.outcome === outcome)?.count ?? -1;
  assert.deepEqual([count("alert", "raised"), count("activity", "ignored"), count("detection", "recorded")], [2, 1, 0]);
  assert.equal(counters.rows().reduce((sum, row) => sum + row.count, 0), 3);
});

test("the page carries the vision counters only when it is given them, with a fixed label set", () => {
  assert.doesNotMatch(page(), /armor_vision_events_total/);
  const counters = new VisionCounters();
  counters.record("detection", "recorded");
  const text = page(counters.rows());
  assert.match(text, /# TYPE armor_vision_events_total counter/);
  assert.match(text, /armor_vision_events_total\{kind="detection",outcome="recorded"\} 1/);
  assert.match(text, /armor_vision_events_total\{kind="alert",outcome="raised"\} 0/);
  assert.equal(text.split("\n").filter(line => line.startsWith("armor_vision_events_total{")).length, 9);
});

test("the vision routes count what they do with each event", async () => {
  const fake = new AiGateway({ ffmpegPath: "/usr/bin/ffmpeg", run: async () => Buffer.alloc(FRAME_BYTES, 9) });
  const running = await startServer({ ARMOR_AI_TOKEN: AI_TOKEN }, { ai: fake });
  try {
    const send = async (url: string, bearer: string, body: unknown) => (await fetch(`${running.base}${url}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) })).status;
    const camera = { id: "cam-gate", name: "Gate", host: "192.168.0.203", username: "admin", password: "pw-for-test", rtspPath: "/live", onvifPort: 80, rtspPort: 554 };
    assert.ok(await send("/api/v1/cameras/configure", SECRETS.ARMOR_OPERATOR_TOKEN, camera) < 300);
    const event = { schema: "armor.vision.event/v1", type: "alert", camera_id: "cam-gate", zone_id: "driveway", zone_name: "Driveway", track_id: 3, label: "person", confidence: 0.87,
      box: [0.1, 0.2, 0.3, 0.6], timestamp: 1000.5, timestamp_ms: 1000500, authorizes_action: false };
    const count = (kind: string, outcome: string): number => running.app.context.visionCounters.rows().find(row => row.kind === kind && row.outcome === outcome)?.count ?? -1;

    assert.equal(await send("/api/v1/ai/vision-events", AI_TOKEN, event), 200);                       // disarmed
    assert.equal(await send("/api/v1/ai/vision-events", AI_TOKEN, { ...event, type: "detection" }), 200);
    assert.deepEqual([count("alert", "ignored"), count("detection", "recorded"), count("alert", "raised")], [1, 1, 0]);

    running.app.context.store.arm("armed");
    assert.equal(await send("/api/v1/ai/vision-events", AI_TOKEN, event), 200);                       // raises
    assert.equal(await send("/api/v1/ai/vision-events", AI_TOKEN, event), 200);                       // one is already open
    assert.deepEqual([count("alert", "raised"), count("alert", "ignored")], [1, 2]);

    assert.equal(await send("/api/v1/ai/vision-events", AI_TOKEN, { ...event, authorizes_action: true }), 422);   // refused events are not counted
    assert.equal(running.app.context.visionCounters.rows().reduce((sum, row) => sum + row.count, 0), 4);
  } finally { await running.stop(); }
});
