import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AiGateway, FRAME_BYTES } from "../src/ai.js";
import type { AuditLog } from "../src/audit.js";
import type { CameraConnection } from "../src/cameras/model.js";
import { CaptureOnDetect } from "../src/capture_on_detect.js";
import { SECURITY_DEFAULTS, VISION_TIMELINE_DAYS, lowers } from "../src/security_settings.js";
import { TIMELINE_LIMIT, TimelineQueryInvalid, VisionTimeline, parseTimelineQuery } from "../src/vision_timeline.js";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

const entry = (over: Partial<{ camera_id: string; level: "alert" | "detection"; zone_id: string }> = {}) => ({ camera_id: "cam-gate", level: "alert" as const, zone_id: "drive", zone_name: "Driveway", label: "person", ...over });

function build(options: { on?: boolean; days?: number; max?: number; file?: string } = {}) {
  let clock = Date.parse("2030-01-10T12:00:00Z");
  let on = options.on ?? true;
  const file = options.file ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-timeline-")), "vision-timeline.json");
  const make = () => new VisionTimeline({ file, enabled: () => on, days: () => options.days ?? 30, maxEntries: options.max ?? 100, now: () => clock });
  return { timeline: make(), make, file, advanceMs: (ms: number) => { clock += ms; }, setOn: (value: boolean) => { on = value; } };
}

test("the option is off by default and nothing is kept while it is off", () => {
  assert.equal(SECURITY_DEFAULTS["vision.timeline"], false);
  assert.equal(SECURITY_DEFAULTS["vision.timeline_days"], 30);
  const { timeline, setOn } = build({ on: false });
  assert.equal(timeline.add(entry()), null);
  setOn(true);
  assert.deepEqual(timeline.list(), []);
});

test("turning the timeline on, or keeping it longer, is a loss of security; turning it off or keeping it for less is not", () => {
  assert.equal(lowers("vision.timeline", false, true), true);
  assert.equal(lowers("vision.timeline", true, false), false);
  assert.equal(lowers("vision.timeline_days", 30, 60), true);
  assert.equal(lowers("vision.timeline_days", 30, 7), false);
  assert.deepEqual([VISION_TIMELINE_DAYS.min, VISION_TIMELINE_DAYS.max], [1, 3650]);
});

test("entries come newest first with an id of the contract, and the filters narrow them", () => {
  const { timeline, advanceMs } = build();
  const first = timeline.add(entry())!;
  advanceMs(60_000);
  const second = timeline.add(entry({ level: "detection", zone_id: "garden", camera_id: "cam-back" }))!;
  advanceMs(60_000);
  const third = timeline.add(entry())!;
  assert.match(first.id, /^vt-[0-9a-f]{16}$/);
  assert.deepEqual(timeline.list().map(item => item.id), [third.id, second.id, first.id]);
  assert.deepEqual(timeline.list({ level: "detection" }).map(item => item.id), [second.id]);
  assert.deepEqual(timeline.list({ camera_id: "cam-gate" }).map(item => item.id), [third.id, first.id]);
  assert.deepEqual(timeline.list({ since: second.at }).map(item => item.id), [third.id], "since is exclusive");
  assert.deepEqual(timeline.list({ limit: 1 }).map(item => item.id), [third.id]);
  assert.equal(first.alarm_id, null);
  assert.equal(first.snapshot_id, null);
});

test("an entry older than the days kept is pruned, and the most entries is a ceiling", () => {
  const { timeline, advanceMs } = build({ days: 2, max: 3 });
  const old = timeline.add(entry())!;
  advanceMs(3 * 86_400_000);
  assert.deepEqual(timeline.list(), [], "pruned by age");
  assert.equal(timeline.remove(old.id), false);
  for (let index = 0; index < 5; index += 1) { timeline.add(entry()); advanceMs(1_000); }
  assert.equal(timeline.list().length, 3, "the oldest go first");
});

test("evidence and the alarm are added later, and an entry deleted meanwhile is left alone", () => {
  const { timeline } = build();
  const item = timeline.add(entry())!;
  assert.equal(timeline.setEvidence(item.id, { snapshot_id: "photo-1.jpg", clip_id: null }), true);
  timeline.setAlarm(item.id, "alarm-7");
  const [stored] = timeline.list();
  assert.deepEqual([stored!.snapshot_id, stored!.clip_id, stored!.alarm_id], ["photo-1.jpg", null, "alarm-7"]);
  assert.equal(timeline.remove(item.id), true);
  assert.equal(timeline.setEvidence(item.id, { snapshot_id: "x" }), false);
  timeline.setAlarm(item.id, "alarm-8");
  assert.deepEqual(timeline.list(), []);
});

test("delete one, delete all, and the entries survive a restart; a damaged file is an empty timeline", () => {
  const { timeline, make, file } = build();
  const a = timeline.add(entry())!;
  timeline.add(entry());
  assert.equal(make().list().length, 2, "read back from the file");
  assert.equal(timeline.remove(a.id), true);
  assert.equal(timeline.clear(), 1);
  assert.equal(timeline.clear(), 0);
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(make().list(), []);
  fs.writeFileSync(file, JSON.stringify({ items: [{ id: "bad", at: "x" }, 7] }));
  assert.deepEqual(make().list(), [], "an entry that is not an entry is dropped");
});

test("the filters of the query are read strictly", () => {
  assert.deepEqual(parseTimelineQuery({}), {});
  assert.deepEqual(parseTimelineQuery({ since: "2030-01-01T00:00:00Z", level: "alert", camera_id: "cam-gate", limit: "50" }), { since: "2030-01-01T00:00:00.000Z", level: "alert", camera_id: "cam-gate", limit: 50 });
  for (const bad of [{ since: "yesterday" }, { since: "2030-13-45T00:00:00Z" }, { level: "other" }, { camera_id: "a b" }, { camera_id: "x".repeat(81) }, { limit: "0" }, { limit: "501" }, { limit: "1.5" }, { limit: "abc" }, { level: ["alert", "detection"] }]) {
    assert.throws(() => parseTimelineQuery(bad), TimelineQueryInvalid, JSON.stringify(bad));
  }
  assert.equal(TIMELINE_LIMIT.max, 500);
});

test("the automatic capture says which photo and which recording it took", async () => {
  let clock = 1_000_000;
  const tools = { snapshot: async () => ({ id: "photo-9.jpg" }), startRecording: async () => undefined, stopRecording: async () => ({ id: "clip-9.mp4" }), isRecording: () => false };
  const capture = new CaptureOnDetect({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-capture-")), "s.json"), tools, audit: { record: () => undefined } as unknown as AuditLog, now: () => clock, sleep: async () => undefined });
  const record = await capture.trigger({ id: "cam-gate", name: "Gate" } as unknown as CameraConnection);
  clock += 1;
  assert.deepEqual([record?.snapshot_id, record?.clip_id], ["photo-9.jpg", "clip-9.mp4"]);
});

const AI_TOKEN = "a".repeat(32);
const camera = { id: "cam-gate", name: "Gate", host: "192.168.0.203", username: "admin", password: "s3cret-pw", rtspPath: "/live", onvifPort: 80, rtspPort: 554 };
const square = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
const zones = [
  { id: "drive", name: "Driveway", points: square, kind: "alert", labels: [], min_frames: 1, min_seconds: 0 },
  { id: "garden", name: "Garden", points: square, kind: "detection", labels: [], min_frames: 1, min_seconds: 0 },
];
const event = (over: Record<string, unknown> = {}) => ({ schema: "armor.vision.activity/v1", type: "zone_enter", camera_id: "cam-gate", track_id: 3, label: "person", timestamp: 12.5, timestamp_ms: 12500, authorizes_action: false, zone_id: "drive", zone_name: "Driveway", ...over });
const json = { "Content-Type": "application/json" };

async function withServer(run: (running: Running, admin: string) => Promise<void>): Promise<void> {
  const fake = new AiGateway({ ffmpegPath: "/usr/bin/ffmpeg", run: async () => Buffer.alloc(FRAME_BYTES, 9) });
  const running = await startServer({ ARMOR_AI_TOKEN: AI_TOKEN }, { ai: fake });
  try {
    const configured = await fetch(`${running.base}/api/v1/cameras/configure`, { method: "POST", headers: { ...json, Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` }, body: JSON.stringify(camera) });
    assert.ok(configured.status < 300);
    running.app.context.detectionZones.set("cam-gate", { zones, profiles: {} });
    running.app.context.securitySettings.update({ "vision.activity_events": true });
    await run(running, await studioCookie(running.base));
  } finally { await running.stop(); }
}

const send = (running: Running, body: unknown) => fetch(`${running.base}/api/v1/ai/activity-events`, { method: "POST", headers: { ...json, Authorization: `Bearer ${AI_TOKEN}` }, body: JSON.stringify(body) });
const operator = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };

test("with the option off the route answers an empty timeline; on, the events of the known zones are listed and an administrator deletes them", async () => {
  await withServer(async (running, admin) => {
    const get = async (query = "") => { const reply = await fetch(`${running.base}/api/v1/vision/timeline${query}`, { headers: operator }); return { status: reply.status, body: await reply.json() as Record<string, any> }; };   // eslint-disable-line @typescript-eslint/no-explicit-any
    await send(running, event());
    assert.deepEqual((await get()).body, { enabled: false, days: 30, items: [] }, "nothing was kept while it was off");

    running.app.context.securitySettings.update({ "vision.timeline": true });
    assert.equal((await send(running, event())).status, 200);
    assert.equal((await send(running, event({ zone_id: "garden", zone_name: "Garden", type: "loiter", seconds: 20 }))).status, 200);
    await send(running, event({ type: "zone_exit" }));
    await send(running, event({ zone_id: "unknown", zone_name: "Nowhere" }));
    const all = await get();
    assert.deepEqual([all.body.enabled, all.body.days, all.body.items.length], [true, 30, 2], "an exit and an unknown zone are not entries");
    assert.deepEqual(all.body.items.map((item: { level: string }) => item.level).sort(), ["alert", "detection"]);
    assert.equal((await get("?level=alert")).body.items.length, 1);
    assert.equal((await get("?level=bad")).status, 422);
    assert.equal((await get("?limit=0")).status, 422);
    assert.equal((await fetch(`${running.base}/api/v1/vision/timeline`)).status, 401, "nobody anonymous");

    const id = all.body.items[0].id as string;
    const remove = (route: string, headers: Record<string, string>) => fetch(`${running.base}${route}`, { method: "DELETE", headers });
    assert.equal((await remove(`/api/v1/vision/timeline/${id}`, operator)).status, 401, "an operator may look, not delete");
    assert.equal((await remove("/api/v1/vision/timeline/vt-00000000", { cookie: admin })).status, 404);
    assert.equal((await remove("/api/v1/vision/timeline/not-an-id", { cookie: admin })).status, 404);
    assert.deepEqual(await (await remove(`/api/v1/vision/timeline/${id}`, { cookie: admin })).json(), { deleted: 1 });
    assert.deepEqual(await (await remove("/api/v1/vision/timeline", { cookie: admin })).json(), { deleted: 1 });
    assert.equal((await get()).body.items.length, 0);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /vision\.timeline/);
  });
});

test("an alert event while armed keeps the alarm it raised in the entry", async () => {
  await withServer(async running => {
    running.app.context.securitySettings.update({ "vision.timeline": true });
    running.app.context.store.arm("armed");
    const answer = await (await send(running, event())).json() as { raised: boolean; alarm_id?: string };
    assert.equal(answer.raised, true);
    const [item] = running.app.context.visionTimeline.list();
    assert.equal(item?.alarm_id, answer.alarm_id);
  });
});
