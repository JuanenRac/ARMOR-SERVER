import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { buildPanelSummary } from "../src/panel_feed.js";
import { lowers, SECURITY_DEFAULTS } from "../src/security_settings.js";
import { startServer, studioCookie, type Running } from "./helpers.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const json = { "Content-Type": "application/json" };

async function wallPanel(running: Running, admin: string): Promise<{ "Content-Type": string; cookie: string }> {
  const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: { ...json, cookie: admin }, body: JSON.stringify({ username: "wall-panel", password: "wall-panel-password-1", role: "panel" }) });
  assert.equal(made.status, 201);
  const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "wall-panel", password: "wall-panel-password-1" }) });
  assert.equal(login.status, 201);
  return { ...json, cookie: (login.headers.getSetCookie()[0] ?? "").split(";")[0] };
}

const setOption = (running: Running, admin: string, values: Record<string, boolean>) =>
  fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify(values) });

test("both options are off by default and turning one on counts as lowering a protection", () => {
  assert.equal(SECURITY_DEFAULTS["panel.preflight"], false);
  assert.equal(SECURITY_DEFAULTS["panel.camera_view"], false);
  for (const key of ["panel.preflight", "panel.camera_view"] as const) {
    assert.equal(lowers(key, false, true), true, `${key}: on is the loss`);
    assert.equal(lowers(key, true, false), false, `${key}: off is not`);
  }
});

test("a wall panel reads the check before arming only while panel.preflight is on", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const panel = await wallPanel(running, admin);
    assert.equal((await fetch(`${running.base}/api/v1/preflight`, { headers: panel })).status, 403, "off: refused");
    assert.equal((await fetch(`${running.base}/api/v1/preflight`, { headers: { ...json, cookie: admin } })).status, 200, "an administrator still reads it");
    assert.equal((await setOption(running, admin, { "panel.preflight": true })).status, 200);
    const answer = await fetch(`${running.base}/api/v1/preflight`, { headers: panel });
    assert.equal(answer.status, 200, "on: the panel reads it");
    const body = await answer.json() as { ready: boolean; issues: unknown[] };
    assert.equal(typeof body.ready, "boolean");
    assert.ok(Array.isArray(body.issues));
    // the other option does not open it, and the panel still reaches nothing else
    assert.equal((await setOption(running, admin, { "panel.preflight": false })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/preflight`, { headers: panel })).status, 403, "off again: refused again");
    assert.equal((await fetch(`${running.base}/api/v1/cameras`, { headers: panel })).status, 403);
  } finally { await running.stop(); }
});

test("a wall panel reads a camera still only while panel.camera_view is on, at most one every two seconds, and nothing is saved", async () => {
  let hits = 0;
  const camera: Server = createServer((_request, response) => { hits += 1; response.writeHead(200, { "Content-Type": "image/jpeg" }).end(JPEG); });
  await new Promise<void>(resolve => camera.listen(0, "127.0.0.1", resolve));
  const port = (camera.address() as AddressInfo).port;
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const adminHeaders = { ...json, cookie: admin };
    running.app.context.vault.save({ id: "gate", name: "Gate", host: "127.0.0.1", snapshotUrl: `http://127.0.0.1:${port}/snap.jpg`, rtspPath: "", onvifPort: port, rtspPort: 554 });
    running.app.context.vault.save({ id: "blind", name: "Blind", host: "127.0.0.1", snapshotUrl: "", rtspPath: "", onvifPort: port, rtspPort: 554 });
    const panel = await wallPanel(running, admin);
    const still = (id: string, headers: Record<string, string>) => fetch(`${running.base}/api/v1/cameras/${id}/snapshot`, { headers });
    assert.equal((await still("gate", panel)).status, 403, "off: refused");
    assert.equal(hits, 0, "and the camera was not asked");
    assert.equal((await setOption(running, admin, { "panel.camera_view": true })).status, 200);
    const first = await still("gate", panel);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), JPEG);
    const second = await still("gate", panel);
    assert.equal(second.status, 429, "a second picture right away is refused");
    assert.ok(Number(second.headers.get("retry-after")) >= 1);
    assert.equal(hits, 1, "the camera was asked once");
    assert.equal((await still("gate", adminHeaders)).status, 429, "the gap is for the camera, whoever asks");
    assert.equal((await still("none", panel)).status, 404);
    assert.equal((await still("blind", panel)).status, 422, "a camera with no snapshot address");
    // nothing was saved as evidence, and the panel still cannot take one or list the cameras
    assert.equal((await fetch(`${running.base}/api/v1/cameras/gate/snapshot`, { method: "POST", headers: panel })).status, 403);
    assert.equal((await fetch(`${running.base}/api/v1/cameras`, { headers: panel })).status, 403);
    assert.equal((await setOption(running, admin, { "panel.camera_view": false })).status, 200);
    assert.equal((await still("gate", panel)).status, 403, "off again: refused again");
  } finally { await running.stop(); await new Promise<void>(resolve => { camera.close(() => resolve()); camera.closeAllConnections(); }); }
});

test("the panel summary carries a countdown only while one runs", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const idle = await (await fetch(`${running.base}/api/v1/panel/summary`, { headers: { ...json, cookie: admin } })).json() as Record<string, unknown>;
    assert.equal("delay" in idle, false, "no countdown, no member");
    const context = running.app.context;
    assert.equal(context.armingModes.countdown(), undefined);
    const summary = buildPanelSummary({ ...context, armingModes: { countdown: () => ({ phase: "exit", remaining_s: 25 }) } });
    assert.deepEqual(summary.delay, { phase: "exit", remaining_s: 25 });
    assert.equal("delay" in buildPanelSummary(context), false);
  } finally { await running.stop(); }
});
