import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CountLines, CountLinesInvalid, MAX_COUNT_LINES, parseCountLines } from "../src/count_lines.js";
import { startServer, studioCookie } from "./helpers.js";

const gate = { id: "gate", a: [0.3, 0.7], b: [0.9, 0.7] };

test("a line has a name and two different ends inside the picture, and what is not is refused", () => {
  assert.deepEqual(parseCountLines([gate]), [gate]);
  assert.deepEqual(parseCountLines([{ ...gate, labels: ["person", "person", "vehicle"] }]), [{ ...gate, labels: ["person", "vehicle"] }]);
  assert.deepEqual(parseCountLines([{ ...gate, labels: [] }]), [gate]);
  assert.deepEqual(parseCountLines([]), []);
  const bad: unknown[] = ["x", null, [null], [{ ...gate, id: "Gate" }], [{ ...gate, id: "" }], [{ ...gate, a: [0.3] }], [{ ...gate, a: [2, 0] }], [{ ...gate, a: ["0", 0] }], [{ ...gate, b: gate.a }],
    [{ ...gate, extra: 1 }], [gate, gate], [{ ...gate, labels: "person" }], [{ ...gate, labels: ["Person"] }], [{ ...gate, labels: Array.from({ length: 9 }, (_, i) => `l${i}`) }]];
  for (const value of bad) assert.throws(() => parseCountLines(value), CountLinesInvalid, JSON.stringify(value));
  assert.throws(() => parseCountLines(Array.from({ length: MAX_COUNT_LINES + 1 }, (_, i) => ({ ...gate, id: `l${i}` }))), CountLinesInvalid);
});

test("the lines of a camera are kept, survive a restart, and go with the camera", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-lines-")), "lines.json");
  const lines = new CountLines(file);
  assert.deepEqual(lines.get("door"), []);
  lines.set("door", [gate]);
  assert.deepEqual(new CountLines(file).get("door"), [gate]);
  lines.set("door", []);
  assert.deepEqual(new CountLines(file).get("door"), []);
  lines.set("garden", [gate]);
  lines.forget("garden");
  assert.deepEqual(new CountLines(file).get("garden"), []);
  assert.throws(() => lines.set("bad id", []), CountLinesInvalid);
});

test("everybody who may look reads the lines of a camera, only an administrator sets them, and an unknown camera is a 404", async () => {
  const running = await startServer();
  try {
    const admin = { "Content-Type": "application/json", cookie: await studioCookie(running.base) };
    const made = await fetch(`${running.base}/api/v1/cameras/configure`, { method: "POST", headers: admin, body: JSON.stringify({ id: "porch", name: "Porch", host: "192.168.0.50", snapshotUrl: "", rtspPath: "", previewPath: "", username: "u", password: "p", onvifPort: 80, rtspPort: 554 }) });
    assert.ok(made.status === 200 || made.status === 201, `configure answered ${made.status}`);
    assert.equal((await fetch(`${running.base}/api/v1/cameras/nope/count-lines`, { headers: admin })).status, 404);
    const empty = await (await fetch(`${running.base}/api/v1/cameras/porch/count-lines`, { headers: admin })).json() as { lines: unknown[] };
    assert.deepEqual(empty.lines, []);
    assert.equal((await fetch(`${running.base}/api/v1/cameras/porch/count-lines`, { method: "PUT", headers: admin, body: JSON.stringify({ lines: [{ ...gate, b: gate.a }] }) })).status, 400);
    const saved = await fetch(`${running.base}/api/v1/cameras/porch/count-lines`, { method: "PUT", headers: admin, body: JSON.stringify({ lines: [gate] }) });
    assert.equal(saved.status, 200);
    const again = await (await fetch(`${running.base}/api/v1/cameras/porch/count-lines`, { headers: admin })).json() as { lines: unknown[] };
    assert.deepEqual(again.lines, [gate]);
    const created = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "family", password: "family-password-1", role: "viewer" }) });
    assert.equal(created.status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "family", password: "family-password-1" }) });
    const viewer = { "Content-Type": "application/json", cookie: (login.headers.getSetCookie()[0] ?? "").split(";")[0] };
    assert.equal((await fetch(`${running.base}/api/v1/cameras/porch/count-lines`, { headers: viewer })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/cameras/porch/count-lines`, { method: "PUT", headers: viewer, body: JSON.stringify({ lines: [] }) })).status, 403);
  } finally { await running.stop(); }
});
