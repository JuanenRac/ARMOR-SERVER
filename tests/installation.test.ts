import assert from "node:assert/strict";
import test from "node:test";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

const json = { "Content-Type": "application/json" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = { status: number; body: Record<string, any> };
const call = async (base: string, cookie: string, method: string, route: string, body?: unknown): Promise<Answer> => {
  const response = await fetch(`${base}${route}`, { method, headers: { ...json, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
};

const PASSWORD = "the-camera-password-that-must-never-leave";

async function furnish(base: string, cookie: string): Promise<void> {
  assert.equal((await call(base, cookie, "POST", "/api/v1/cameras/configure", { id: "gate", name: "Gate", host: "192.168.0.203", snapshotUrl: "", rtspPath: "stream1", username: "admin", password: PASSWORD, onvifPort: 8899, rtspPort: 554 })).status < 300, true);
  assert.equal((await call(base, cookie, "POST", "/api/v1/devices", { id: "smoke", name: "Smoke", kind: "smoke" })).status, 201);
  assert.equal((await call(base, cookie, "POST", "/api/v1/devices", { id: "siren", name: "Siren", kind: "siren", commands: { mqtt: { topic: "s/set", on: "ON", off: "OFF" } } })).status, 201);
  assert.equal((await call(base, cookie, "POST", "/api/v1/automations", { name: "Smoke sounds the siren", trigger: { type: "device", device_id: "smoke", field: "triggered", equals: true }, when_mode: "any", actions: [{ type: "device", device_id: "siren", command: "on" }] })).status, 201);
  assert.equal((await call(base, cookie, "PUT", "/api/v1/site", { site: { buildings: [{ id: "house", name: "House" }], terrain: { width: 30 } }, revision: 0 })).status < 300, true);
  assert.equal((await call(base, cookie, "POST", "/api/v1/solar/devices", { node_id: "solar-1", device: "axpert-1", kind: "inverter", name: "Roof inverter", model: "voltronic", connection: "rs232" })).status < 400, true);
}

test("the installation is exported without a single secret and imported on another machine", async () => {
  const origin = await startServer();
  let bundleText = "";
  let bundle: Record<string, unknown> = {};
  try {
    const cookie = await studioCookie(origin.base);
    await furnish(origin.base, cookie);
    assert.equal((await call(origin.base, "", "GET", "/api/v1/admin/installation")).status, 401);   // nobody anonymous
    const response = await fetch(`${origin.base}/api/v1/admin/installation`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /armor-installation\.json/);
    bundleText = await response.text();
    bundle = JSON.parse(bundleText) as Record<string, unknown>;
  } finally { await origin.stop(); }

  // no secret anywhere: not the camera's password, not a token, not a hash
  assert.equal(bundleText.includes(PASSWORD), false);
  assert.equal(bundleText.includes(SECRETS.ARMOR_STUDIO_PASSWORD), false);
  assert.equal(bundleText.includes(SECRETS.ARMOR_INGEST_TOKEN), false);
  assert.equal(/"(salt|hash|password|token|secrets)"\s*:/.test(bundleText), false);
  assert.equal(bundle.format, "armor-installation");
  const parts = bundle.parts as Record<string, unknown>;
  assert.equal((parts.cameras as Array<{ id: string; username: string }>)[0].id, "gate");
  assert.deepEqual((parts.users as Array<{ username: string; role: string }>).map(user => user.role), ["admin"]);
  assert.equal((parts.devices as unknown[]).length, 2);
  assert.equal((parts.automations as unknown[]).length, 1);
  assert.equal((parts.solar_devices as unknown[]).length, 1);

  // another machine: it gets everything back, except the camera's password
  const target = await startServer();
  try {
    const cookie = await studioCookie(target.base);
    assert.equal((await call(target.base, "", "POST", "/api/v1/admin/installation", { bundle })).status, 401);
    const report = (await call(target.base, cookie, "POST", "/api/v1/admin/installation", { bundle })).body;
    assert.equal(report.applied.cameras, "1 added, 0 already there");
    assert.deepEqual(report.cameras_need_credentials, ["gate"]);
    assert.match(report.applied.site, /replaced/);
    assert.equal(report.applied.devices, "2 added, 0 already there");
    assert.equal(report.applied.automations, "1 added, 0 already there");
    assert.equal(report.applied.solar_devices, "1 added, 0 already there");
    assert.match(report.skipped.users, /not imported/);
    assert.deepEqual(report.failed, {});
    const cameras = (await call(target.base, cookie, "GET", "/api/v1/cameras")).body.cameras as Array<{ id: string; hasCredentials: boolean }>;
    assert.equal(cameras.find(camera => camera.id === "gate")?.hasCredentials, false);   // the password never travelled
    assert.equal((await call(target.base, cookie, "GET", "/api/v1/devices")).body.devices.length, 2);
    assert.equal((await call(target.base, cookie, "GET", "/api/v1/site")).body.site.buildings[0].id, "house");

    // importing again only adds what is missing: nothing changes, and nothing is duplicated
    const again = (await call(target.base, cookie, "POST", "/api/v1/admin/installation", { bundle, parts: ["cameras", "devices", "automations"] })).body;
    assert.equal(again.applied.cameras, "0 added, 1 already there");
    assert.equal(again.applied.devices, "0 added, 2 already there");
    assert.equal(again.applied.automations, "0 added, 1 already there");
    assert.equal(again.applied.site, undefined);   // a part that was not asked for is not touched
    assert.equal((await call(target.base, cookie, "GET", "/api/v1/devices")).body.devices.length, 2);
  } finally { await target.stop(); }
});

test("a file that is not an installation, or a part that does not check out, is refused without harm", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    for (const bad of [null, "text", [], {}, { format: "something-else", version: 1, parts: {} }, { format: "armor-installation", version: 99, parts: {} }, { format: "armor-installation", version: 1, parts: [] }]) {
      assert.equal((await call(running.base, cookie, "POST", "/api/v1/admin/installation", { bundle: bad })).status, 400);
    }
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/admin/installation", { bundle: { format: "armor-installation", version: 1, parts: {} }, parts: ["nothing-of-that-name"] })).status, 400);
    // a bad part is reported and skipped; the good ones still apply
    const mixed = (await call(running.base, cookie, "POST", "/api/v1/admin/installation", {
      bundle: { format: "armor-installation", version: 1, parts: { rules: { zones: "not a list" }, cameras: "not a list", devices: [{ id: "lamp", name: "Lamp", kind: "smart_plug" }, 7, { id: 5 }, { id: "BAD ID", name: "x", kind: "smart_plug" }] } },
    })).body;
    assert.match(report(mixed, "failed", "rules"), /not valid rules/);
    assert.match(report(mixed, "failed", "cameras"), /not a list/);
    assert.match(report(mixed, "applied", "devices"), /^1 added, 0 already there, 3 refused$/);
    assert.equal((await call(running.base, cookie, "GET", "/api/v1/devices")).body.devices.length, 1);
    // the designs REPLACE what is there, and the version that was there is kept
    assert.equal((await call(running.base, cookie, "PUT", "/api/v1/site", { site: { buildings: [{ id: "old" }] }, revision: 0 })).status < 300, true);
    const replaced = (await call(running.base, cookie, "POST", "/api/v1/admin/installation", { bundle: { format: "armor-installation", version: 1, parts: { site: { buildings: [{ id: "new" }] } } }, parts: ["site"] })).body;
    assert.match(replaced.applied.site, /replaced/);
    assert.equal((await call(running.base, cookie, "GET", "/api/v1/site")).body.site.buildings[0].id, "new");
  } finally { await running.stop(); }
});

function report(body: Record<string, Record<string, string>>, group: "applied" | "failed", part: string): string { return body[group]?.[part] ?? ""; }
