import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { cleanState, isTriggered } from "../src/devices/catalog.js";
import { cleanMap, readPath, stateFromPayload, toBoolean } from "../src/devices/mapping.js";
import { DeviceError, DeviceRegistry, isLanUrl } from "../src/devices/registry.js";
import { alertMessageFor } from "../src/notify.js";
import { SECRETS, startServer, studioCookie, tempDir } from "./helpers.js";

const json = { "Content-Type": "application/json" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = { status: number; body: Record<string, any> };
const call = async (base: string, cookie: string, method: string, route: string, body?: unknown): Promise<Answer> => {
  const response = await fetch(`${base}${route}`, { method, headers: { ...json, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
};
const registry = (extra: Partial<ConstructorParameters<typeof DeviceRegistry>[0]> = {}) => new DeviceRegistry({ file: path.join(tempDir(), "devices.json"), ...extra });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("a device report keeps only the fields it may have, with valid values", () => {
  assert.deepEqual(cleanState({ open: true, battery: 88.456, evil: "x", humidity: 500, on: "yes", temperature: -300 }), { open: true, battery: 88.46 });
  assert.deepEqual(cleanState("nope"), {});
  assert.equal(isTriggered("door", { open: true }), true);
  assert.equal(isTriggered("door", { triggered: true }), false);
  assert.equal(isTriggered("smoke", { triggered: true }), true);
  assert.equal(isTriggered("smart_plug", { on: true }), false);
});

test("a device's own payload is translated into the canonical state", () => {
  assert.equal(readPath({ a: { b: [1, { c: 5 }] } }, "a.b.1.c"), 5);
  assert.equal(readPath("ON", "$"), "ON");
  assert.equal(toBoolean("ON"), true);
  assert.equal(toBoolean("closed"), false);
  assert.equal(toBoolean("banana"), undefined);
  assert.equal(toBoolean(0), false);
  // Zigbee2MQTT contact sensor: contact=false means open
  assert.deepEqual(stateFromPayload({ contact: false, battery: 97, linkquality: 60 }, [{ field: "open", path: "contact", invert: true }, { field: "battery", path: "battery" }]), { open: true, battery: 97 });
  assert.deepEqual(stateFromPayload({ POWER: "ON", ENERGY: { Power: 12.5 } }, [{ field: "on", path: "POWER" }, { field: "power_w", path: "ENERGY.Power" }]), { on: true, power_w: 12.5 });
  assert.deepEqual(stateFromPayload({ state: "LOCK" }, [{ field: "locked", path: "state" }]), { locked: true });
  assert.deepEqual(stateFromPayload({ state: "UNLOCK" }, [{ field: "locked", path: "state" }]), { locked: false });
  assert.deepEqual(stateFromPayload({ triggered: true, junk: 1 }, undefined), { triggered: true });
  assert.deepEqual(cleanMap([{ field: "open", path: "contact" }, { field: "bogus", path: "x" }, { field: "on", path: "a;b" }, { field: "on", path: "$", invert: true }]), [{ field: "open", path: "contact" }, { field: "on", path: "$", invert: true }]);
});

test("the registry validates a device, gives it an id and refuses what does not make sense", () => {
  const devices = registry();
  const code = (action: () => unknown) => { try { action(); } catch (error) { return (error as DeviceError).code; } return "ok"; };
  assert.equal(code(() => devices.create({ name: "x", kind: "toaster" as never })), "invalid_kind");
  assert.equal(code(() => devices.create({ name: "  ", kind: "smoke" })), "invalid_name");
  assert.equal(code(() => devices.create({ name: "Hall", kind: "smoke", source: { type: "mqtt", topic: "a/#" } })), "invalid_topic");
  assert.equal(code(() => devices.create({ name: "Plug", kind: "smart_plug", commands: { http: { on: "http://example.com/on" } } })), "invalid_url");
  const smoke = devices.create({ name: "Kitchen smoke", kind: "smoke", protocol: "zigbee", location: "Kitchen" });
  assert.equal(smoke.id, "kitchen-smoke");
  assert.equal(devices.create({ name: "Kitchen smoke", kind: "smoke" }).id, "kitchen-smoke-2");
  assert.equal(code(() => devices.create({ id: "kitchen-smoke", name: "Again", kind: "smoke" })), "id_taken");
  // a sensor has nothing to command
  const door = devices.create({ name: "Door", kind: "door", commands: { mqtt: { topic: "x/set", on: "ON" } } });
  assert.deepEqual(door.commands, {});
  assert.equal(devices.update(smoke.id, { name: "Hall smoke" }).name, "Hall smoke");
  devices.remove(smoke.id);
  assert.equal(code(() => devices.remove(smoke.id)), "not_found");
});

test("a report tells what changed, when a device becomes triggered, and comes back online", () => {
  const seen: string[] = [];
  const devices = registry({ onChange: change => seen.push(`${change.device.id}:${change.changes.map(item => `${item.field}=${item.to}`).join(",")}:${change.triggered ?? "-"}:${change.onlineChanged ? "online" : "-"}`) });
  devices.create({ name: "Front door", kind: "door" });
  devices.applyState("front-door", { open: false });
  devices.applyState("front-door", { open: true, battery: 90 });
  devices.applyState("front-door", { open: true });
  devices.applyState("front-door", { open: false });
  assert.deepEqual(seen, ["front-door:open=false:-:online", "front-door:open=true,battery=90:true:-", "front-door::-:-", "front-door:open=false:false:-"]);
  assert.equal(devices.applyState("nobody", { open: true }), undefined);
});

test("MQTT messages reach the device that listens on the topic, whatever its payload looks like", () => {
  const devices = registry();
  devices.create({ id: "hall-door", name: "Hall door", kind: "door", source: { type: "mqtt", topic: "z2m/hall", availability_topic: "z2m/hall/availability", map: [{ field: "open", path: "contact", invert: true }] } });
  devices.create({ id: "lamp", name: "Lamp", kind: "smart_light", source: { type: "mqtt", topic: "stat/lamp/POWER" } });
  assert.deepEqual(devices.topics().sort(), ["stat/lamp/POWER", "z2m/hall", "z2m/hall/availability"]);
  devices.ingestMqtt("z2m/hall", JSON.stringify({ contact: false }));
  assert.equal(devices.get("hall-door")?.state.open, true);
  devices.ingestMqtt("stat/lamp/POWER", "ON");                       // a bare word is read as the kind's main field
  assert.equal(devices.get("lamp")?.state.on, true);
  devices.ingestMqtt("z2m/hall/availability", JSON.stringify({ state: "offline" }));
  assert.equal(devices.get("hall-door")?.online, false);
  assert.deepEqual(devices.ingestMqtt("other/topic", "{}"), []);
  assert.deepEqual(devices.ingestMqtt("z2m/hall", "x".repeat(5000)), []);
});

test("a device that goes silent is marked offline, but only when it was told how often to speak", () => {
  let now = new Date("2026-01-01T00:00:00Z");
  const devices = registry({ now: () => now });
  devices.create({ id: "quiet", name: "Quiet", kind: "door", expected_interval_s: 60 });
  devices.create({ id: "lazy", name: "Lazy", kind: "door" });
  devices.applyState("quiet", { open: false });
  devices.applyState("lazy", { open: false });
  now = new Date(now.getTime() + 61_000);
  assert.deepEqual(devices.sweep().map(change => change.device.id), ["quiet"]);
  assert.equal(devices.get("lazy")?.online, true);
});

test("a command URL must be on the local network", () => {
  for (const good of ["http://192.168.0.50/relay/0?turn=on", "http://10.0.0.5/on", "https://plug.local/on", "http://localhost:8080/x", "http://172.20.1.1/x"]) assert.equal(isLanUrl(good), true, good);
  for (const bad of ["http://example.com/on", "http://8.8.8.8/x", "ftp://192.168.0.5/x", "http://169.254.169.254/latest", "http://user:pw@192.168.0.5/x", "http://172.32.0.1/x", "not a url"]) assert.equal(isLanUrl(bad), false, bad);
});

test("registry, state and alarms over HTTP: a door while armed, smoke at any time, acknowledging, and disarming", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running.base, "", "GET", "/api/v1/devices")).status, 401);
    const door = await call(running.base, cookie, "POST", "/api/v1/devices", { name: "Back door", kind: "door", protocol: "zigbee" });
    assert.equal(door.status, 201);
    await call(running.base, cookie, "POST", "/api/v1/devices", { name: "Hall smoke", kind: "smoke", protocol: "wifi" });
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/devices", { name: "Bad", kind: "toaster" })).status, 400);
    const ingest = (device_id: string, state: unknown) => fetch(`${running.base}/api/v1/devices/state`, { method: "POST", headers: { ...json, Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify({ device_id, state }) });
    assert.equal((await fetch(`${running.base}/api/v1/devices/state`, { method: "POST", headers: json, body: "{}" })).status, 401);
    assert.equal((await ingest("nobody", { open: true })).status, 404);
    assert.equal((await ingest("back-door", { junk: 1 })).status, 400);

    // disarmed: an open door is only a state
    assert.equal((await ingest("back-door", { open: false })).status, 202);
    assert.equal((await ingest("back-door", { open: true })).status, 202);
    assert.equal((await call(running.base, cookie, "GET", "/api/v1/alarms")).body.active.length, 0);
    // smoke is an alarm at any time
    await ingest("hall-smoke", { triggered: true });
    let alarms = (await call(running.base, cookie, "GET", "/api/v1/alarms")).body;
    assert.equal(alarms.active.length, 1);
    assert.deepEqual([alarms.active[0].code, alarms.active[0].severity, alarms.active[0].source], ["smoke", "critical", { type: "device", id: "hall-smoke" }]);
    // the operator arms from Studio; the door closes and opens again: intrusion
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/mode", { mode: "armed" })).status, 200);
    await ingest("back-door", { open: false });
    await ingest("back-door", { open: true });
    alarms = (await call(running.base, cookie, "GET", "/api/v1/alarms")).body;
    assert.deepEqual(alarms.active.map((alarm: { code: string }) => alarm.code).sort(), ["door_open", "smoke"]);
    // the smoke clears, but it stays on the list until someone acknowledges it
    await ingest("hall-smoke", { triggered: false });
    alarms = (await call(running.base, cookie, "GET", "/api/v1/alarms")).body;
    const smoke = alarms.active.find((alarm: { code: string }) => alarm.code === "smoke");
    assert.ok(smoke.cleared_at && !smoke.acknowledged_at);
    assert.equal((await call(running.base, cookie, "POST", `/api/v1/alarms/${smoke.id}/acknowledge`)).status, 200);
    alarms = (await call(running.base, cookie, "GET", "/api/v1/alarms")).body;
    assert.equal(alarms.recent.length, 1);
    assert.equal(alarms.recent[0].acknowledged_by, "admin");
    // disarming ends the intrusion alarm
    await call(running.base, cookie, "POST", "/api/v1/mode", { mode: "disarmed" });
    alarms = (await call(running.base, cookie, "GET", "/api/v1/alarms")).body;
    assert.ok(alarms.active[0].cleared_at, "the door alarm ended with the disarm");
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/alarms/acknowledge")).body.acknowledged, 1);
    assert.equal((await call(running.base, cookie, "GET", "/api/v1/alarms")).body.active.length, 0);
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/alarms/alm-99999/acknowledge")).status, 404);
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/mode", { mode: "loud" })).status, 400);
    // it all reached the history
    const history = (await call(running.base, cookie, "GET", "/api/v1/history?type=alarm&limit=50")).body;
    assert.ok(history.events.some((event: { type: string; state: string; code: string }) => event.type === "alarm" && event.state === "raised" && event.code === "smoke"));
    assert.ok((await call(running.base, cookie, "GET", "/api/v1/history?type=device&limit=50")).body.events.length >= 4);
  } finally { await running.stop(); }
});

test("a device alarm is announced, and a node or camera alarm is not announced twice", () => {
  const message = alertMessageFor({ id: 1, at: "2026-01-01T00:00:00Z", type: "alarm", alarm_id: "alm-00001", state: "raised", severity: "critical", source: "hall-smoke", source_type: "device", code: "smoke" }, "disarmed");
  assert.deepEqual([message?.event, message?.device_id, message?.severity], ["alarm.raised", "hall-smoke", "critical"]);
  assert.equal(alertMessageFor({ id: 2, at: "x", type: "alarm", alarm_id: "a", state: "raised", severity: "high", source: "north-1", source_type: "node", code: "intrusion" }, "armed"), null);
});

test("commands go to the device over MQTT or HTTP, are refused for a sensor, and a toggle is worked out from the state", async () => {
  const running = await startServer();
  const published: Array<[string, string]> = [];
  running.app.context.deviceLink.publish = (topic, payload) => { published.push([topic, payload]); };
  const hits: string[] = [];
  const lan = createServer((request, response) => { hits.push(request.url ?? ""); response.end("ok"); });
  await new Promise<void>(resolve => lan.listen(0, "127.0.0.1", resolve));
  const port = (lan.address() as { port: number }).port;
  try {
    const cookie = await studioCookie(running.base);
    await call(running.base, cookie, "POST", "/api/v1/devices", { id: "siren", name: "Siren", kind: "siren", commands: { mqtt: { topic: "armor/device/siren/set", on: "ON", off: "OFF", assume_state: true } } });
    await call(running.base, cookie, "POST", "/api/v1/devices", { id: "plug", name: "Plug", kind: "smart_plug", commands: { http: { on: `http://127.0.0.1:${port}/on`, off: `http://127.0.0.1:${port}/off` } } });
    await call(running.base, cookie, "POST", "/api/v1/devices", { id: "door", name: "Door", kind: "door" });
    const on = await call(running.base, cookie, "POST", "/api/v1/devices/siren/command", { command: "on" });
    assert.equal(on.status, 200);
    assert.deepEqual(published, [["armor/device/siren/set", "ON"]]);
    assert.equal(on.body.device.state.on, true, "assume_state records it at once");
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/devices/siren/command", { command: "toggle" })).status, 400, "a siren is switched on or off, not toggled");
    await call(running.base, cookie, "POST", "/api/v1/devices", { id: "lamp", name: "Lamp", kind: "smart_light", commands: { mqtt: { topic: "armor/device/lamp/set", on: "ON", off: "OFF", assume_state: true } } });
    await call(running.base, cookie, "POST", "/api/v1/devices/lamp/command", { command: "on" });
    await call(running.base, cookie, "POST", "/api/v1/devices/lamp/command", { command: "toggle" });
    assert.deepEqual(published.at(-1), ["armor/device/lamp/set", "OFF"]);
    await call(running.base, cookie, "POST", "/api/v1/devices/lamp/command", { command: "toggle" });
    assert.deepEqual(published.at(-1), ["armor/device/lamp/set", "ON"]);
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/devices/plug/command", { command: "on" })).body.via, "http");
    assert.deepEqual(hits, ["/on"]);
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/devices/door/command", { command: "on" })).status, 400);
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/devices/siren/command", { command: "explode" })).status, 400);
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/devices/nobody/command", { command: "on" })).status, 404);
    // a command URL is never sent back to a client
    assert.equal(JSON.stringify((await call(running.base, cookie, "GET", "/api/v1/devices")).body).includes(String(port)), false);
  } finally { lan.close(); await running.stop(); }
});

test("an automation turns a siren on when smoke is detected, only in the mode it is limited to, and cannot flap", async () => {
  const running = await startServer();
  const published: Array<[string, string]> = [];
  running.app.context.deviceLink.publish = (topic, payload) => { published.push([topic, payload]); };
  try {
    const cookie = await studioCookie(running.base);
    await call(running.base, cookie, "POST", "/api/v1/devices", { id: "smoke", name: "Smoke", kind: "smoke" });
    await call(running.base, cookie, "POST", "/api/v1/devices", { id: "siren", name: "Siren", kind: "siren", commands: { mqtt: { topic: "s/set", on: "ON", off: "OFF" } } });
    const bad = await call(running.base, cookie, "POST", "/api/v1/automations", { name: "Bad", trigger: { type: "device", device_id: "smoke" }, actions: [] });
    assert.equal(bad.status, 400);
    const made = await call(running.base, cookie, "POST", "/api/v1/automations", { name: "Smoke sounds the siren", trigger: { type: "device", device_id: "smoke", field: "triggered", equals: true }, when_mode: "any", actions: [{ type: "device", device_id: "siren", command: "on" }] });
    assert.equal(made.status, 201);
    const state = (value: boolean) => call(running.base, cookie, "POST", "/api/v1/devices/smoke/state", { state: { triggered: value } });
    await state(true);
    await pause(60);
    assert.deepEqual(published, [["s/set", "ON"]]);
    // limited to the armed mode, it does nothing while disarmed
    await call(running.base, cookie, "PATCH", `/api/v1/automations/${made.body.id}`, { when_mode: "armed" });
    await state(false);
    await state(true);
    await pause(60);
    assert.equal(published.length, 1);
    // a flapping sensor cannot run it more than a few times a minute
    await call(running.base, cookie, "PATCH", `/api/v1/automations/${made.body.id}`, { when_mode: "any" });
    for (let index = 0; index < 20; index += 1) { await state(false); await state(true); }
    await pause(100);
    assert.ok(published.length <= 1 + 6, `ran ${published.length} times`);
    assert.equal((await call(running.base, cookie, "POST", "/api/v1/automations/nope/run")).status, 404);
    assert.equal((await call(running.base, cookie, "DELETE", `/api/v1/automations/${made.body.id}`)).status, 204);
    assert.equal((await call(running.base, cookie, "GET", "/api/v1/automations")).body.automations.length, 0);
  } finally { await running.stop(); }
});

test("the site design is kept on the server and a save from an out-of-date copy is refused", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running.base, "", "GET", "/api/v1/site")).status, 401);
    const empty = (await call(running.base, cookie, "GET", "/api/v1/site")).body;
    assert.deepEqual([empty.revision, empty.site], [0, null]);
    const first = await call(running.base, cookie, "PUT", "/api/v1/site", { revision: 0, site: { terrain: { points: [] }, note: "a" } });
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 1);
    const stale = await call(running.base, cookie, "PUT", "/api/v1/site", { revision: 0, site: { note: "b" } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.site.note, "a");
    assert.equal((await call(running.base, cookie, "PUT", "/api/v1/site", { revision: 1, site: [] })).status, 400);
    // a design bigger than the general request limit is fine
    const big = { items: Array.from({ length: 4000 }, (_, index) => ({ id: `item-${index}`, x: index, y: index * 2, text: "x".repeat(10) })) };
    assert.equal((await call(running.base, cookie, "PUT", "/api/v1/site", { revision: 1, site: big })).status, 200);
    assert.equal((await call(running.base, cookie, "PUT", "/api/v1/site", { revision: 2, site: { blob: "x".repeat(800_000) } })).status, 413);
  } finally { await running.stop(); }
});

test("the system page counts what the server holds, and only an administrator reads the audit trail", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running.base, "", "GET", "/api/v1/system")).status, 401);
    await call(running.base, cookie, "POST", "/api/v1/devices", { name: "Door", kind: "door" });
    const system = (await call(running.base, cookie, "GET", "/api/v1/system")).body;
    assert.equal(system.service, "armor-server");
    assert.deepEqual([system.counts.devices, system.counts.users, system.counts.alarms_active], [1, 1, 0]);
    assert.equal(typeof system.storage.media_bytes, "number");
    const audit = (await call(running.base, cookie, "GET", "/api/v1/audit?limit=20")).body;
    assert.ok(audit.entries.some((entry: { action: string }) => entry.action === "device.create"));
    assert.equal(JSON.stringify(audit).toLowerCase().includes("password"), false);
    await call(running.base, cookie, "POST", "/api/v1/users", { username: "guard", password: "guard-password-1", role: "operator" });
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "guard", password: "guard-password-1" }) });
    const operator = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    assert.equal((await call(running.base, operator, "GET", "/api/v1/system")).status, 200);
    assert.equal((await call(running.base, operator, "GET", "/api/v1/audit")).status, 403);
  } finally { await running.stop(); }
});
