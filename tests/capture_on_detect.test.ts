import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuditLog } from "../src/audit.js";
import type { CameraConnection } from "../src/cameras/model.js";
import { CaptureOnDetect, CaptureSettingsInvalid, DEFAULT_CAPTURE, parseCaptureSettings, type CaptureTools } from "../src/capture_on_detect.js";
import { startServer, studioCookie } from "./helpers.js";

const camera = (id: string) => ({ id, name: id } as unknown as CameraConnection);

function build(overrides: Partial<CaptureTools> = {}) {
  const calls: string[] = [];
  const waits: number[] = [];
  const audits: Array<{ action: string; outcome: string; detail?: string }> = [];
  let clock = 1_000_000;
  const tools: CaptureTools = {
    snapshot: async c => { calls.push(`photo:${c.id}`); return { id: "p" }; },
    startRecording: async c => { calls.push(`start:${c.id}`); },
    stopRecording: async id => { calls.push(`stop:${id}`); return { id: "v" }; },
    isRecording: () => false,
    ...overrides,
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-capture-")), "settings.json");
  const capture = new CaptureOnDetect({ file, tools, audit: { record: (entry: { action: string; outcome: string; detail?: string }) => { audits.push(entry); } } as unknown as AuditLog, now: () => clock, sleep: async ms => { waits.push(ms); } });
  return { capture, calls, waits, audits, file, advance: (ms: number) => { clock += ms; } };
}

test("the settings are validated: types, whole numbers in range and no unknown keys", () => {
  assert.deepEqual(parseCaptureSettings({}), DEFAULT_CAPTURE);
  assert.equal(parseCaptureSettings({ photo_count: 5, photo_interval_s: 10, video_seconds: 30, cooldown_s: 60, video: false }).photo_count, 5);
  for (const bad of [{ photo_count: 0 }, { photo_count: 61 }, { photo_interval_s: 1.5 }, { video_seconds: 2 }, { cooldown_s: 4 }, { enabled: "yes" }, { surprise: 1 }, [], "x", null]) {
    assert.throws(() => parseCaptureSettings(bad), CaptureSettingsInvalid, JSON.stringify(bad));
  }
});

test("a detection takes a photo and records a video of the configured length", async () => {
  const { capture, calls, waits, audits } = build();
  capture.set({ video_seconds: 12 });
  const record = await capture.trigger(camera("door"));
  assert.deepEqual(record && { photos: record.photos, video: record.video }, { photos: 1, video: true });
  assert.deepEqual([...calls].sort(), ["photo:door", "start:door", "stop:door"]);
  assert.deepEqual(waits, [12_000]);
  assert.equal(audits.at(-1)?.action, "evidence.auto_capture");
  assert.equal(audits.at(-1)?.outcome, "allowed");
});

test("several photos are taken a few seconds apart, the first at once", async () => {
  const { capture, calls, waits } = build();
  capture.set({ video: false, photo_count: 4, photo_interval_s: 7 });
  const record = await capture.trigger(camera("garden"));
  assert.equal(record?.photos, 4);
  assert.equal(record?.video, false);
  assert.deepEqual(calls, ["photo:garden", "photo:garden", "photo:garden", "photo:garden"]);
  assert.deepEqual(waits, [7_000, 7_000, 7_000]);
});

test("a camera is left alone during its cooldown, and the others are not", async () => {
  const { capture, advance, calls } = build();
  capture.set({ video: false, cooldown_s: 30 });
  assert.ok(await capture.trigger(camera("a")));
  assert.equal(await capture.trigger(camera("a")), null);
  assert.ok(await capture.trigger(camera("b")));
  advance(29_000);
  assert.equal(await capture.trigger(camera("a")), null);
  advance(2_000);
  assert.ok(await capture.trigger(camera("a")));
  assert.equal(calls.filter(call => call === "photo:a").length, 2);
});

test("it does nothing when it is off or when there is nothing to take", async () => {
  const { capture, calls } = build();
  capture.set({ enabled: false });
  assert.equal(await capture.trigger(camera("a")), null);
  capture.set({ enabled: true, photo: false, video: false });
  assert.equal(await capture.trigger(camera("a")), null);
  assert.deepEqual(calls, []);
});

test("a failing photo or recording is skipped and audited, and a recording started by a person is left alone", async () => {
  let failures = 0;
  const { capture, calls, audits } = build({ snapshot: async () => { failures += 1; throw new Error("no frame"); }, startRecording: async () => { throw new Error("no ffmpeg"); } });
  capture.set({ photo_count: 2 });
  const record = await capture.trigger(camera("a"));
  assert.deepEqual(record && { photos: record.photos, video: record.video }, { photos: 0, video: false });
  assert.equal(failures, 2);
  assert.equal(audits.at(-1)?.outcome, "failed");
  const manual = build({ isRecording: () => true });
  manual.capture.set({ photo: false });
  const kept = await manual.capture.trigger(camera("m"));
  assert.equal(kept?.video, false);
  assert.deepEqual(manual.calls, []);
  assert.ok(calls.length === 0);
});

test("the settings survive a restart", () => {
  const first = build();
  first.capture.set({ photo_count: 9, video_seconds: 45 });
  const again = new CaptureOnDetect({ file: first.file, tools: {} as CaptureTools, audit: {} as unknown as AuditLog });
  assert.equal(again.get().photo_count, 9);
  assert.equal(again.get().video_seconds, 45);
});

test("everybody who may look reads the settings, only an administrator sets them, and a bad body is a 400", async () => {
  const running = await startServer();
  try {
    const admin = { "Content-Type": "application/json", cookie: await studioCookie(running.base) };
    assert.equal((await fetch(`${running.base}/api/v1/capture-settings`)).status, 401);
    const read = await (await fetch(`${running.base}/api/v1/capture-settings`, { headers: admin })).json() as { settings: { enabled: boolean; video_seconds: number } };
    assert.equal(read.settings.enabled, true);
    assert.equal((await fetch(`${running.base}/api/v1/capture-settings`, { method: "PUT", headers: admin, body: JSON.stringify({ video_seconds: 1 }) })).status, 400);
    const saved = await fetch(`${running.base}/api/v1/capture-settings`, { method: "PUT", headers: admin, body: JSON.stringify({ video_seconds: 25, photo_count: 3 }) });
    assert.equal(saved.status, 200);
    const again = await (await fetch(`${running.base}/api/v1/capture-settings`, { headers: admin })).json() as { settings: { video_seconds: number; photo_count: number } };
    assert.deepEqual([again.settings.video_seconds, again.settings.photo_count], [25, 3]);
    const created = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "family", password: "family-password-1", role: "viewer" }) });
    assert.equal(created.status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "family", password: "family-password-1" }) });
    const viewer = { "Content-Type": "application/json", cookie: (login.headers.getSetCookie()[0] ?? "").split(";")[0] };
    assert.equal((await fetch(`${running.base}/api/v1/capture-settings`, { headers: viewer })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/capture-settings`, { method: "PUT", headers: viewer, body: JSON.stringify({ enabled: false }) })).status, 403);
  } finally { await running.stop(); }
});
