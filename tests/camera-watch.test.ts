import assert from "node:assert/strict";
import test from "node:test";
import { CameraWatcher } from "../src/cameras/health.js";
import type { CameraConnection } from "../src/cameras/model.js";
import type { ArmorEventBody } from "../src/events.js";
import { alertMessageFor } from "../src/notify.js";
import type { ArmorEvent } from "../src/events.js";

const camera = (id: string, extra: Partial<CameraConnection> = {}): CameraConnection => ({ id, name: id, host: "192.168.0.50", snapshotUrl: "", rtspPath: "", onvifPort: 80, rtspPort: 554, ...extra });

function setup(cameras: CameraConnection[]) {
  const events: ArmorEventBody[] = [];
  const up = new Set<string>();
  let now = 1_000;
  const watcher = new CameraWatcher({
    list: () => cameras, onEvent: event => events.push(event), now: () => now,
    probe: async (host, port) => up.has(`${host}:${port}`),
  });
  return { watcher, events, up, cameras, tick: (ms: number) => { now += ms; } };
}

test("one failed check is not an outage: a camera goes offline only after consecutive failures", async () => {
  const { watcher, events, up } = setup([camera("cam-01")]);
  up.add("192.168.0.50:554");
  await watcher.check();
  assert.equal(watcher.snapshot()[0].status, "online");
  assert.deepEqual(events, [], "the first sighting of a healthy camera is not news");
  up.clear();
  await watcher.check();
  assert.equal(watcher.snapshot()[0].status, "online");
  await watcher.check();
  assert.equal(watcher.snapshot()[0].status, "offline");
  assert.deepEqual(events, [{ type: "camera", camera_id: "cam-01", from: "online", to: "offline" }]);
  await watcher.check();
  assert.equal(events.length, 1, "an ongoing outage is reported once");
  up.add("192.168.0.50:80");
  await watcher.check();
  assert.equal(watcher.snapshot()[0].status, "online");
  assert.deepEqual(events[events.length - 1] as unknown, { type: "camera", camera_id: "cam-01", from: "offline", to: "online" });
});

test("either service answering proves the camera is alive", async () => {
  const { watcher, up } = setup([camera("cam-01")]);
  up.add("192.168.0.50:80");
  await watcher.check();
  assert.equal(watcher.snapshot()[0].status, "online");
});

test("a camera that was never reachable is reported offline after the threshold", async () => {
  const { watcher, events } = setup([camera("cam-01")]);
  await watcher.check();
  assert.equal(watcher.snapshot()[0].status, "unknown");
  await watcher.check();
  assert.deepEqual(events, [{ type: "camera", camera_id: "cam-01", from: "unknown", to: "offline" }]);
});

test("removed cameras are forgotten and a slow pass is never started twice", async () => {
  const cams = [camera("cam-01"), camera("cam-02", { host: "192.168.0.51" })];
  const { watcher } = setup(cams);
  await watcher.check();
  cams.pop();
  await watcher.check();
  assert.deepEqual(watcher.snapshot().map(item => item.id), ["cam-01"]);
  let probes = 0;
  const slow = new CameraWatcher({ list: () => [camera("cam-01")], onEvent: () => undefined, probe: async () => { probes += 1; await new Promise(resolve => setTimeout(resolve, 30)); return true; } });
  await Promise.all([slow.check(), slow.check()]);
  assert.equal(probes, 2, "one pass probes RTSP and ONVIF once each");
});

test("a probe that throws counts as a failure, never as a crash", async () => {
  const watcher = new CameraWatcher({ list: () => [camera("cam-01")], onEvent: () => undefined, probe: async () => { throw new Error("boom"); }, failuresToOffline: 1 });
  await watcher.check();
  assert.equal(watcher.snapshot()[0].status, "offline");
});

test("an offline camera is an alarm only while the system is armed", () => {
  const event = { id: 1, at: "2026-01-01T00:00:00.000Z", type: "camera", camera_id: "cam-01", from: "online", to: "offline" } as ArmorEvent;
  assert.deepEqual(alertMessageFor(event, "armed")?.event, "camera.offline");
  assert.equal(alertMessageFor(event, "armed")?.camera_id, "cam-01");
  assert.equal(alertMessageFor(event, "disarmed"), null);
  assert.equal(alertMessageFor({ ...event, to: "online" } as ArmorEvent, "armed"), null);
});
