import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DetectionZones, DetectionZonesInvalid, MAX_DETECTION_ZONES, parseCameraDetection, polygonArea, selfIntersects, watchedZones } from "../src/detection_zones.js";
import { startServer, studioCookie } from "./helpers.js";

const square = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, points: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]], ...extra });
const json = { "Content-Type": "application/json" };

test("a zone is a polygon inside the picture with its labels and times, and a bad shape is refused", () => {
  const parsed = parseCameraDetection({ zones: [square("gate", { labels: ["person", "person", "dog"], kind: "detection", min_frames: 3, min_seconds: 1.5 })] });
  assert.deepEqual(parsed.zones[0]!.labels, ["person", "dog"]);
  assert.equal(parsed.zones[0]!.kind, "detection");
  assert.equal(parseCameraDetection({ zones: [square("a")] }).zones[0]!.kind, "alert", "alert is the default");
  assert.ok(Math.abs(polygonArea([[0, 0], [1, 0], [1, 1], [0, 1]]) - 1) < 1e-9);
  assert.equal(selfIntersects([[0, 0], [1, 1], [1, 0], [0, 1]]), true, "a bow tie");
  const bad: unknown[] = [null, { zones: "x" }, { zones: [null] }, { zones: [square("a", { points: [[0, 0], [1, 1]] })] }, { zones: [square("a", { points: [[0, 0], [1, 1], [2, 0]] })] },
    { zones: [square("a", { points: [[0, 0], [0.5, 0.5], [1, 1]] })] }, { zones: [square("a", { points: [[0, 0], [1, 1], [1, 0], [0, 1]] })] }, { zones: [square("A B")] },
    { zones: [square("a", { kind: "other" })] }, { zones: [square("a", { labels: ["Person!"] })] }, { zones: [square("a", { min_frames: 0 })] }, { zones: [square("a", { min_seconds: -1 })] },
    { zones: [square("a", { extra: 1 })] }, { zones: [square("a"), square("a")] }, { zones: [], extra: 1 },
    { zones: [square("a")], profiles: { holiday: { watch: [] } } }, { zones: [square("a")], profiles: { away: { watch: ["missing"] } } },
    { zones: [square("a")], profiles: { away: { watch: ["a"], sensitivity: "max" } } }, { zones: [square("a")], profiles: { away: { watch: ["a"], notify: "yes" } } }];
  for (const value of bad) assert.throws(() => parseCameraDetection(value), DetectionZonesInvalid, JSON.stringify(value));
  assert.throws(() => parseCameraDetection({ zones: Array.from({ length: MAX_DETECTION_ZONES + 1 }, (_, index) => square(`z${index}`)) }), DetectionZonesInvalid);
});

test("each arming mode watches what its profile lists, and a mode without a profile watches everything", () => {
  const detection = parseCameraDetection({ zones: [square("door"), square("garden")], profiles: { home: { watch: ["door"], sensitivity: "low", notify: false }, night: { watch: ["door", "garden"] } } });
  assert.deepEqual(watchedZones(detection, "home").map(zone => zone.id), ["door"]);
  assert.deepEqual(detection.profiles.home, { watch: ["door"], sensitivity: "low", notify: false });
  assert.deepEqual(detection.profiles.night, { watch: ["door", "garden"], sensitivity: "normal", notify: true });
  assert.deepEqual(watchedZones(detection, "away").map(zone => zone.id), ["door", "garden"], "no profile for away: every zone");
  assert.deepEqual(watchedZones(detection, "something-new").map(zone => zone.id), ["door", "garden"], "an unknown mode never watches less");
  assert.deepEqual(watchedZones(detection, null).map(zone => zone.id), ["door", "garden"]);
});

test("the zones are kept, survive a restart and go with the camera", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-dz-")), "zones.json");
  const store = new DetectionZones(file);
  assert.deepEqual(store.get("door"), { zones: [], profiles: {} });
  store.set("door", { zones: [square("a")], profiles: { home: { watch: ["a"] } } });
  assert.equal(new DetectionZones(file).get("door").zones.length, 1);
  store.set("door", { zones: [] });
  assert.deepEqual(new DetectionZones(file).get("door"), { zones: [], profiles: {} });
  store.set("garden", { zones: [square("b")] });
  store.forget("garden");
  assert.equal(new DetectionZones(file).get("garden").zones.length, 0);
  assert.throws(() => store.set("bad id", { zones: [] }), DetectionZonesInvalid);
});

test("the route and the export of the installation carry the zones and the profiles, and an import brings them back", async () => {
  const origin = await startServer();
  let bundle: Record<string, unknown> = {};
  try {
    const admin = { ...json, cookie: await studioCookie(origin.base) };
    const camera = { id: "porch", name: "Porch", host: "192.168.0.50", snapshotUrl: "", rtspPath: "stream1", previewPath: "", username: "u", password: "p-secret-1", onvifPort: 8899, rtspPort: 554 };
    assert.ok((await fetch(`${origin.base}/api/v1/cameras/configure`, { method: "POST", headers: admin, body: JSON.stringify(camera) })).status < 300);
    assert.equal((await fetch(`${origin.base}/api/v1/cameras/nope/detection-zones`, { headers: admin })).status, 404);
    assert.equal((await fetch(`${origin.base}/api/v1/cameras/porch/detection-zones`, { method: "PUT", headers: admin, body: JSON.stringify({ zones: [square("a", { points: [[0, 0], [1, 1]] })] }) })).status, 400);
    const body = { zones: [square("door", { labels: ["person"] })], profiles: { home: { watch: [], sensitivity: "low", notify: false } } };
    assert.equal((await fetch(`${origin.base}/api/v1/cameras/porch/detection-zones`, { method: "PUT", headers: admin, body: JSON.stringify(body) })).status, 200);
    const read = await (await fetch(`${origin.base}/api/v1/cameras/porch/detection-zones`, { headers: admin })).json() as { zones: unknown[]; profiles: Record<string, unknown> };
    assert.equal(read.zones.length, 1);
    assert.deepEqual(Object.keys(read.profiles), ["home"]);
    assert.equal((await fetch(`${origin.base}/api/v1/cameras/porch/ignore-zones`, { method: "PUT", headers: admin, body: JSON.stringify({ zones: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] }) })).status, 200);
    const text = await (await fetch(`${origin.base}/api/v1/admin/installation`, { headers: admin })).text();
    assert.equal(text.includes("p-secret-1"), false);
    bundle = JSON.parse(text) as Record<string, unknown>;
    const cameras = (bundle.parts as { cameras: Array<{ overlays?: { ignore_zones?: unknown[]; detection?: { zones: unknown[] } } }> }).cameras;
    assert.equal(cameras[0]!.overlays?.ignore_zones?.length, 1);
    assert.equal(cameras[0]!.overlays?.detection?.zones.length, 1);
  } finally { await origin.stop(); }

  const target = await startServer();
  try {
    const admin = { ...json, cookie: await studioCookie(target.base) };
    const report = await (await fetch(`${target.base}/api/v1/admin/installation`, { method: "POST", headers: admin, body: JSON.stringify({ bundle, parts: ["cameras"] }) })).json() as { applied: Record<string, string> };
    assert.equal(report.applied.cameras, "1 added, 0 already there");
    const read = await (await fetch(`${target.base}/api/v1/cameras/porch/detection-zones`, { headers: admin })).json() as { zones: unknown[]; profiles: Record<string, { notify: boolean }> };
    assert.equal(read.zones.length, 1);
    assert.equal(read.profiles.home!.notify, false);
    const ignore = await (await fetch(`${target.base}/api/v1/cameras/porch/ignore-zones`, { headers: admin })).json() as { zones: unknown[] };
    assert.equal(ignore.zones.length, 1, "the parts to leave out come back with the camera");
  } finally { await target.stop(); }
});
