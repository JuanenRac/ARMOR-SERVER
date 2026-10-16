import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IgnoreZones, IgnoreZonesInvalid, MAX_IGNORE_ZONES, parseIgnoreZones } from "../src/ignore_zones.js";
import { startServer, studioCookie } from "./helpers.js";

test("a zone is a rectangle inside the picture, and what is not is refused", () => {
  assert.deepEqual(parseIgnoreZones([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }]), [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }]);
  assert.deepEqual(parseIgnoreZones([]), []);
  for (const bad of ["x", null, [null], [{ x: 0, y: 0, w: 0, h: 0.5 }], [{ x: -0.1, y: 0, w: 0.5, h: 0.5 }], [{ x: 0.8, y: 0, w: 0.5, h: 0.5 }], [{ x: 0, y: 0, w: 0.5 }], [{ x: 0, y: 0, w: 0.5, h: 0.5, extra: 1 }], [{ x: "0", y: 0, w: 0.5, h: 0.5 }]]) {
    assert.throws(() => parseIgnoreZones(bad), IgnoreZonesInvalid, JSON.stringify(bad));
  }
  assert.throws(() => parseIgnoreZones(Array.from({ length: MAX_IGNORE_ZONES + 1 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 }))), IgnoreZonesInvalid);
});

test("the zones of a camera are kept, survive a restart, and go with the camera", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-zones-")), "zones.json");
  const zones = new IgnoreZones(file);
  assert.deepEqual(zones.get("door"), []);
  zones.set("door", [{ x: 0, y: 0, w: 0.5, h: 1 }]);
  assert.equal(new IgnoreZones(file).get("door").length, 1);
  zones.set("door", []);
  assert.deepEqual(new IgnoreZones(file).get("door"), []);
  zones.set("garden", [{ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }]);
  zones.forget("garden");
  assert.deepEqual(new IgnoreZones(file).get("garden"), []);
  assert.throws(() => zones.set("bad id", []), IgnoreZonesInvalid);
});

test("everybody who may look reads the zones of a camera, only an administrator sets them, and an unknown camera is a 404", async () => {
  const running = await startServer();
  try {
    const admin = { "Content-Type": "application/json", cookie: await studioCookie(running.base) };
    const made = await fetch(`${running.base}/api/v1/cameras/configure`, { method: "POST", headers: admin, body: JSON.stringify({ id: "porch", name: "Porch", host: "192.168.0.50", snapshotUrl: "", rtspPath: "", previewPath: "", username: "u", password: "p", onvifPort: 80, rtspPort: 554 }) });
    assert.ok(made.status === 200 || made.status === 201, `configure answered ${made.status}`);
    assert.equal((await fetch(`${running.base}/api/v1/cameras/nope/ignore-zones`, { headers: admin })).status, 404);
    const empty = await (await fetch(`${running.base}/api/v1/cameras/porch/ignore-zones`, { headers: admin })).json() as { zones: unknown[] };
    assert.deepEqual(empty.zones, []);
    assert.equal((await fetch(`${running.base}/api/v1/cameras/porch/ignore-zones`, { method: "PUT", headers: admin, body: JSON.stringify({ zones: [{ x: 2, y: 0, w: 0.5, h: 0.5 }] }) })).status, 400);
    const saved = await fetch(`${running.base}/api/v1/cameras/porch/ignore-zones`, { method: "PUT", headers: admin, body: JSON.stringify({ zones: [{ x: 0, y: 0.5, w: 0.5, h: 0.5 }] }) });
    assert.equal(saved.status, 200);
    const again = await (await fetch(`${running.base}/api/v1/cameras/porch/ignore-zones`, { headers: admin })).json() as { zones: unknown[] };
    assert.equal(again.zones.length, 1);
    const created = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "family", password: "family-password-1", role: "viewer" }) });
    assert.equal(created.status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "family", password: "family-password-1" }) });
    const viewer = { "Content-Type": "application/json", cookie: (login.headers.getSetCookie()[0] ?? "").split(";")[0] };
    assert.equal((await fetch(`${running.base}/api/v1/cameras/porch/ignore-zones`, { headers: viewer })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/cameras/porch/ignore-zones`, { method: "PUT", headers: viewer, body: JSON.stringify({ zones: [] }) })).status, 403);
  } finally { await running.stop(); }
});
