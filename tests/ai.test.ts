import assert from "node:assert/strict";
import test from "node:test";
import { AiGateway, FRAME_BYTES, parseObservation } from "../src/ai.js";
import { alertMessageFor } from "../src/notify.js";
import { SECRETS, startServer, type Running } from "./helpers.js";

const AI_TOKEN = "a".repeat(32);
const json = { "Content-Type": "application/json" };

const call = async (running: Running, method: string, url: string, options: { bearer?: string; body?: unknown } = {}) => {
  const reply = await fetch(`${running.base}${url}`, { method, headers: { ...json, ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const bytes = Buffer.from(await reply.arrayBuffer());
  let body: Record<string, any> = {};   // eslint-disable-line @typescript-eslint/no-explicit-any
  try { body = JSON.parse(bytes.toString("utf8")); } catch { /* a frame is not JSON */ }
  return { status: reply.status, body, bytes, headers: reply.headers };
};

const camera = { id: "cam-gate", name: "Gate", host: "192.168.0.203", username: "admin", password: "s3cret-pw", rtspPath: "/live", onvifPort: 80, rtspPort: 554 };

async function withServer(frame: Buffer | Error, run: (running: Running) => Promise<void>): Promise<void> {
  const fake = new AiGateway({ ffmpegPath: "/usr/bin/ffmpeg", run: async () => { if (frame instanceof Error) throw frame; return frame; } });
  const running = await startServer({ ARMOR_AI_TOKEN: AI_TOKEN }, { ai: fake });
  try {
    const configured = await call(running, "POST", "/api/v1/cameras/configure", { bearer: SECRETS.ARMOR_OPERATOR_TOKEN, body: camera });
    assert.ok(configured.status < 300, `configure: ${configured.status}`);
    await run(running);
  } finally { await running.stop(); }
}

test("the observation service has its own token, and the operator's does not open its routes", async () => {
  await withServer(Buffer.alloc(FRAME_BYTES, 9), async running => {
    for (const url of ["/api/v1/ai/context", "/api/v1/ai/cameras/cam-gate/frame"]) {
      assert.equal((await call(running, "GET", url)).status, 401, url);
      assert.equal((await call(running, "GET", url, { bearer: SECRETS.ARMOR_OPERATOR_TOKEN })).status, 401, `${url} with the operator token`);
      assert.equal((await call(running, "GET", url, { bearer: "b".repeat(32) })).status, 401, url);
    }
    assert.equal((await call(running, "POST", "/api/v1/ai/observations", { body: {} })).status, 401);
    // and its token opens nothing else
    assert.equal((await call(running, "POST", "/api/v1/mode", { bearer: AI_TOKEN, body: { mode: "armed" } })).status, 401);
    assert.equal((await call(running, "GET", "/api/v1/cameras", { bearer: AI_TOKEN })).status, 401);
  });
  const without = await startServer();
  try { assert.equal((await call(without, "GET", "/api/v1/ai/context", { bearer: AI_TOKEN })).status, 401); } finally { await without.stop(); }
});

test("the context tells the mode, the radar nodes and the cameras that can be looked at - without a password", async () => {
  await withServer(Buffer.alloc(FRAME_BYTES, 9), async running => {
    const reply = await call(running, "GET", "/api/v1/ai/context", { bearer: AI_TOKEN });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.mode, "disarmed");
    assert.deepEqual(reply.body.cameras, [{ id: "cam-gate", name: "Gate" }]);
    assert.deepEqual(reply.body.nodes, []);
    assert.doesNotMatch(JSON.stringify(reply.body), /s3cret-pw|192\.168\.0\.203/);
  });
});

test("a frame is 64 x 36 grey bytes, and what goes wrong with the camera is told without its address or password", async () => {
  await withServer(Buffer.alloc(FRAME_BYTES, 9), async running => {
    const frame = await call(running, "GET", "/api/v1/ai/cameras/cam-gate/frame", { bearer: AI_TOKEN });
    assert.deepEqual([frame.status, frame.bytes.length, frame.headers.get("x-frame-width"), frame.headers.get("x-frame-height")], [200, FRAME_BYTES, "64", "36"]);
    assert.equal((await call(running, "GET", "/api/v1/ai/cameras/nope-1/frame", { bearer: AI_TOKEN })).status, 404);
  });
  await withServer(new Error("Command failed: ffmpeg -i rtsp://admin:s3cret-pw@192.168.0.203:554/live"), async running => {
    const broken = await call(running, "GET", "/api/v1/ai/cameras/cam-gate/frame", { bearer: AI_TOKEN });
    assert.deepEqual([broken.status, broken.body.error], [502, "camera_not_answering"]);
    assert.doesNotMatch(JSON.stringify(broken.body), /s3cret-pw|192\.168/);
  });
  await withServer(Buffer.alloc(10), async running => {
    assert.equal((await call(running, "GET", "/api/v1/ai/cameras/cam-gate/frame", { bearer: AI_TOKEN })).body.error, "bad_frame");
  });
  const noFfmpeg = new AiGateway({ ffmpegPath: "" });
  await assert.rejects(noFfmpeg.frame({ id: "c", name: "c", host: "h", snapshotUrl: "", rtspPath: "x", onvifPort: 80, rtspPort: 554, secrets: { username: "u", password: "p" } }), /ffmpeg_not_configured/);
});

test("an observation raises an alarm only while the system is armed, once until it is closed", async () => {
  await withServer(Buffer.alloc(FRAME_BYTES, 9), async running => {
    const observation = { camera_id: "cam-gate", severity: "review", reasons: ["movement on the camera", "1 radar track(s) agree"], profile: "low-light", motion: 0.12, radar_tracks: 1 };
    const disarmed = await call(running, "POST", "/api/v1/ai/observations", { bearer: AI_TOKEN, body: observation });
    assert.deepEqual([disarmed.status, disarmed.body], [200, { raised: false, reason: "disarmed" }]);
    assert.equal(running.app.context.alarms.active().length, 0);

    running.app.context.store.arm("armed");
    const armed = await call(running, "POST", "/api/v1/ai/observations", { bearer: AI_TOKEN, body: observation });
    assert.equal(armed.body.raised, true);
    const [alarm] = running.app.context.alarms.active();
    assert.deepEqual([alarm.code, alarm.severity, alarm.source], ["camera_motion", "warning", { type: "camera", id: "cam-gate" }]);
    assert.equal(alarm.detail?.radar_tracks, 1);
    const again = await call(running, "POST", "/api/v1/ai/observations", { bearer: AI_TOKEN, body: { ...observation, severity: "high" } });
    assert.deepEqual(again.body, { raised: false, reason: "already_open" });
    assert.equal(running.app.context.alarms.active().length, 1);

    for (const bad of [{ ...observation, camera_id: "x" }, { ...observation, severity: "ignore" }, { ...observation, motion: 2 }, { ...observation, profile: "dusk" }, { ...observation, reasons: ["x".repeat(201)] }, { camera_id: 5 }]) {
      assert.equal((await call(running, "POST", "/api/v1/ai/observations", { bearer: AI_TOKEN, body: bad })).status, 422);
    }
    assert.equal((await call(running, "POST", "/api/v1/ai/observations", { bearer: AI_TOKEN, body: { ...observation, camera_id: "cam-nope" } })).status, 404);
  });
});

test("a movement alarm of a camera is announced with its camera, and the camera that stops answering keeps its own message", () => {
  const motion = alertMessageFor({ id: 1, at: "2000-01-01T00:00:00Z", type: "alarm", alarm_id: "alm-00001", state: "raised", severity: "high", source: "cam-gate", source_type: "camera", code: "camera_motion" }, "armed");
  assert.deepEqual([motion?.event, motion?.camera_id, motion?.severity, motion?.code], ["alarm.raised", "cam-gate", "high", "camera_motion"]);
  const down = alertMessageFor({ id: 2, at: "2000-01-01T00:00:00Z", type: "alarm", alarm_id: "alm-00002", state: "raised", severity: "warning", source: "cam-gate", source_type: "camera", code: "camera_down" }, "armed");
  assert.equal(down, null, "the camera that stops answering is announced by its own event, not twice");
  assert.equal(parseObservation({ camera_id: "cam-gate", severity: "high", reasons: [], profile: "daylight", motion: 0.5, radar_tracks: 0 })?.severity, "high");
  assert.equal(parseObservation(null), undefined);
});
