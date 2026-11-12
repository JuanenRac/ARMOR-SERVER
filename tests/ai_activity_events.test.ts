import assert from "node:assert/strict";
import test from "node:test";
import { AiGateway, FRAME_BYTES, parseActivityEvent } from "../src/ai.js";
import { SECRETS, startServer, type Running } from "./helpers.js";

const AI_TOKEN = "a".repeat(32);
const json = { "Content-Type": "application/json" };
const URL = "/api/v1/ai/activity-events";

const call = async (running: Running, method: string, url: string, options: { bearer?: string; body?: unknown } = {}) => {
  const reply = await fetch(`${running.base}${url}`, { method, headers: { ...json, ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  let body: Record<string, any> = {};   // eslint-disable-line @typescript-eslint/no-explicit-any
  try { body = JSON.parse(await reply.text()); } catch { /* not JSON */ }
  return { status: reply.status, body };
};

const camera = { id: "cam-gate", name: "Gate", host: "192.168.0.203", username: "admin", password: "s3cret-pw", rtspPath: "/live", onvifPort: 80, rtspPort: 554 };
const square = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
const zones = [
  { id: "drive", name: "Driveway", points: square, kind: "alert", labels: [], min_frames: 1, min_seconds: 0 },
  { id: "garden", name: "Garden", points: square, kind: "detection", labels: [], min_frames: 1, min_seconds: 0 },
];

const enter = { schema: "armor.vision.activity/v1", type: "zone_enter", camera_id: "cam-gate", track_id: 3, label: "person", timestamp: 12.5, timestamp_ms: 12500, authorizes_action: false, zone_id: "drive", zone_name: "Driveway" };

async function withServer(run: (running: Running) => Promise<void>): Promise<void> {
  const fake = new AiGateway({ ffmpegPath: "/usr/bin/ffmpeg", run: async () => Buffer.alloc(FRAME_BYTES, 9) });
  const running = await startServer({ ARMOR_AI_TOKEN: AI_TOKEN }, { ai: fake });
  try {
    const configured = await call(running, "POST", "/api/v1/cameras/configure", { bearer: SECRETS.ARMOR_OPERATOR_TOKEN, body: camera });
    assert.ok(configured.status < 300, `configure: ${configured.status}`);
    running.app.context.detectionZones.set("cam-gate", { zones, profiles: {} });
    await run(running);
  } finally { await running.stop(); }
}

const post = (running: Running, body: unknown) => call(running, "POST", URL, { bearer: AI_TOKEN, body });

test("an activity event is recorded whatever happens, and an alert zone raises an alarm only while armed and not told off", async () => {
  await withServer(async running => {
    const context = running.app.context;
    assert.deepEqual((await post(running, enter)).body, { raised: false, reason: "disarmed" });
    assert.equal(context.alarms.active().length, 0);

    context.store.arm("armed");
    // The profile of the mode watches the zone but does not tell anybody: the event is recorded and no alarm is raised.
    assert.deepEqual((await post(running, { ...enter, notify: false })).body, { raised: false, reason: "notify_off" });
    assert.equal(context.alarms.active().length, 0);

    const told = await post(running, { ...enter, notify: true });
    assert.equal(told.body.raised, true);
    const [alarm] = context.alarms.active();
    assert.deepEqual([alarm.code, alarm.severity, alarm.source, alarm.detail?.zone], ["camera_motion", "high", { type: "camera", id: "cam-gate" }, "Driveway"]);
    assert.deepEqual((await post(running, { ...enter, type: "dwell", seconds: 11 })).body, { raised: false, reason: "already_open" });
  });
});

test("a zone that only detects, an unknown zone, an exit and a line crossing are recorded and never raise an alarm", async () => {
  await withServer(async running => {
    running.app.context.store.arm("armed");
    const recorded = { raised: false, reason: "recorded" };
    assert.deepEqual((await post(running, { ...enter, zone_id: "garden", zone_name: "Garden" })).body, recorded);
    assert.deepEqual((await post(running, { ...enter, zone_id: "from-the-config" })).body, recorded);
    assert.deepEqual((await post(running, { ...enter, type: "zone_exit", seconds: 4, zone_name: undefined })).body, recorded);
    const line = { schema: "armor.vision.activity/v1", type: "line_cross", camera_id: "cam-gate", track_id: 3, label: "person", timestamp: 13, timestamp_ms: 13000, authorizes_action: false, line_id: "gate", direction: "to_left" };
    assert.deepEqual((await post(running, line)).body, recorded);
    assert.equal(running.app.context.alarms.active().length, 0);
  });
});

test("an activity event needs the token of the observation service, a known camera and the shape of the contract", async () => {
  await withServer(async running => {
    assert.equal((await call(running, "POST", URL, { body: enter })).status, 401);
    assert.equal((await call(running, "POST", URL, { bearer: SECRETS.ARMOR_OPERATOR_TOKEN, body: enter })).status, 401);
    assert.equal((await post(running, { ...enter, camera_id: "cam-nope" })).status, 404);
    for (const bad of [{ ...enter, authorizes_action: true }, { ...enter, schema: "armor.vision.activity/v2" }, { ...enter, type: "alert" }, { ...enter, notify: "no" }, { ...enter, picture: "AAAA" },
      { ...enter, seconds: 3 }, { ...enter, type: "dwell" }, { ...enter, zone_id: undefined }, { ...enter, line_id: "x" }]) {
      assert.equal((await post(running, bad)).status, 422, JSON.stringify(bad));
    }
  });
});

test("parseActivityEvent keeps what the contract names and nothing else", () => {
  assert.deepEqual(parseActivityEvent(enter), enter);
  assert.deepEqual(parseActivityEvent({ ...enter, notify: false }), { ...enter, notify: false });
  const line = { schema: "armor.vision.activity/v1", type: "line_cross", camera_id: "cam-gate", track_id: 1, label: "car", timestamp: 1, timestamp_ms: 1000, authorizes_action: false, line_id: "gate", direction: "to_right" };
  assert.deepEqual(parseActivityEvent(line), line);
  assert.equal(parseActivityEvent({ ...line, direction: "up" }), undefined);
  assert.equal(parseActivityEvent({ ...line, zone_id: "drive" }), undefined);
  assert.equal(parseActivityEvent({ ...enter, track_id: 0 }), undefined);
  assert.equal(parseActivityEvent({ ...enter, timestamp: -1 }), undefined);
  assert.equal(parseActivityEvent({ ...enter, label: "" }), undefined);
  assert.equal(parseActivityEvent([enter]), undefined);
  assert.equal(parseActivityEvent(null), undefined);
});
