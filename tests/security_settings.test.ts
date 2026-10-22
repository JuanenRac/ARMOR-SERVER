import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { AlarmZoneFeed, ZoneFeedSigner, zoneFeedSignature } from "../src/alarm_zone_feed.js";
import type { Device } from "../src/devices/registry.js";
import { SECURITY_DEFAULTS, SecuritySettings, SecuritySettingsInvalid } from "../src/security_settings.js";
import { startServer, studioCookie, tempDir, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const call = async (running: Running, cookie: string, method: string, url: string, body?: unknown) => {
  const reply = await fetch(`${running.base}${url}`, { method, headers: { ...json, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: reply.status, body: await reply.json().catch(() => ({})) as Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
};
const meId = async (running: Running, cookie: string) => ((await call(running, cookie, "GET", "/api/v1/users")).body.users as Array<{ id: string; current: boolean }>).find(user => user.current)!.id;

test("the defaults are the way the server always behaved, and a bad value or an unknown name changes nothing", () => {
  const file = path.join(tempDir(), "security-settings.json");
  const settings = new SecuritySettings(file);
  assert.deepEqual(settings.effective, SECURITY_DEFAULTS);
  assert.equal(settings.get("alarm.disarm_pin"), "if_set");
  assert.equal(settings.get("voice.silence_confirmation"), "off");
  assert.throws(() => settings.update({ "voice.silence_confirmation": "sometimes" }), SecuritySettingsInvalid);
  assert.throws(() => settings.update({ "alarm.disarm_pin": true }), SecuritySettingsInvalid);
  assert.throws(() => settings.update({ "alarm.config_hash": "yes" }), SecuritySettingsInvalid);
  assert.throws(() => settings.update({ "nothing.here": true }), SecuritySettingsInvalid);
  assert.throws(() => settings.update([]), SecuritySettingsInvalid);
  assert.throws(() => settings.update({ "alarm.config_hash": false, "voice.silence_confirmation": "x" }), SecuritySettingsInvalid);
  assert.equal(settings.get("alarm.config_hash"), true, "a refused request changes none of its parts");
  assert.deepEqual(settings.update({ "voice.silence_confirmation": "pin", "server.zone_feed": false }), { "voice.silence_confirmation": "pin", "server.zone_feed": false });
  assert.deepEqual(settings.update({ "voice.silence_confirmation": "pin" }), {}, "the same value again is no change");
  // it is kept, and a damaged value in the file is not believed
  assert.equal(new SecuritySettings(file).get("voice.silence_confirmation"), "pin");
  fs.writeFileSync(file, JSON.stringify({ schema: 1, settings: { "voice.silence_confirmation": "sometimes", "server.zone_feed": false } }));
  const reread = new SecuritySettings(file);
  assert.equal(reread.get("voice.silence_confirmation"), "off");
  assert.equal(reread.get("server.zone_feed"), false);
});

test("only an administrator reads or changes the settings, and the change is in the audit trail", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const read = await call(running, cookie, "GET", "/api/v1/security/settings");
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.settings, SECURITY_DEFAULTS);
    assert.deepEqual(read.body.locked, []);
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "voice.silence_confirmation": "nope" })).status, 400);
    const put = await call(running, cookie, "PUT", "/api/v1/security/settings", { "voice.silence_confirmation": "double_turn", "alarm.disarm_pin": "never" });
    assert.equal(put.status, 200);
    assert.equal(put.body.settings["voice.silence_confirmation"], "double_turn");
    assert.equal(put.body.settings["alarm.disarm_pin"], "never");
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /security\.setting.*alarm\.disarm_pin.*if_set -> never \(lowers the security\)/);
    // a viewer and an operator are refused
    for (const role of ["viewer", "operator"]) {
      assert.equal((await call(running, cookie, "POST", "/api/v1/users", { username: `u-${role}`, password: `${role}-password-12345`, role })).status, 201);
      const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: `u-${role}`, password: `${role}-password-12345` }) });
      const other = (login.headers.getSetCookie()[0] ?? "").split(";")[0]!;
      assert.equal((await call(running, other, "GET", "/api/v1/security/settings")).status, 403, role);
      assert.equal((await call(running, other, "PUT", "/api/v1/security/settings", { "alarm.disarm_pin": "if_set" })).status, 403, role);
      assert.equal((await call(running, other, "GET", "/api/v1/alarm/zone-feed/key/alarm-1")).status, 403, role);
    }
    assert.equal(running.app.context.securitySettings.get("alarm.disarm_pin"), "never", "nothing changed by them");
    // kept across a restart of the store
    assert.equal(new SecuritySettings(path.join(running.config.dataDir, "security-settings.json")).get("alarm.disarm_pin"), "never");
  } finally { await running.stop(); }
});

test("the session announces what the person may do and the settings in force; the field is new, so an older server lacks it", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const session = (await call(running, cookie, "GET", "/api/v1/studio/session")).body;
    assert.equal(session.capabilities.version, 1);
    assert.deepEqual(Object.keys(session.capabilities.actions).sort(), ["acknowledge", "administer", "arm", "camera_control", "disarm", "manage_users", "operate", "security_settings"]);
    assert.ok(Object.values(session.capabilities.actions).every(value => value === true), "an administrator may everything");
    assert.ok(session.capabilities.features.includes("security_settings"));
    assert.equal(session.capabilities.security["alarm.disarm_pin"], "if_set");
    await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.disarm_pin": "always" });
    assert.equal((await call(running, cookie, "GET", "/api/v1/studio/session")).body.capabilities.security["alarm.disarm_pin"], "always");
    await call(running, cookie, "POST", "/api/v1/users", { username: "family", password: "family-password-1", role: "viewer" });
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "family", password: "family-password-1" }) });
    const viewer = (await call(running, (login.headers.getSetCookie()[0] ?? "").split(";")[0]!, "GET", "/api/v1/studio/session")).body.capabilities.actions;
    assert.deepEqual(viewer, { arm: false, disarm: false, acknowledge: false, operate: false, camera_control: false, administer: false, manage_users: false, security_settings: false });
    assert.equal((await call(running, "", "GET", "/api/v1/studio/session")).body.capabilities, undefined, "nobody signed in, nothing announced");
  } finally { await running.stop(); }
});

test("alarm.disarm_pin: if_set keeps the way it was, never asks nothing, always also closes the door to a user without a PIN", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const id = await meId(running, cookie);
    const disarm = (pin?: string) => call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed", ...(pin === undefined ? {} : { pin }) });
    const arm = () => call(running, cookie, "POST", "/api/v1/mode", { mode: "armed" });
    const set = (value: string) => call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.disarm_pin": value });
    await call(running, cookie, "PUT", `/api/v1/users/${id}/pin`, { pin: "2468", duress_pin: "1357" });
    // the default: a user with a PIN needs it
    await arm();
    assert.equal((await disarm()).body.code, "wrong_pin");
    assert.equal((await disarm("2468")).status, 200);
    // never: no PIN is asked, even a wrong one lets through, and the duress PIN still raises its silent alarm
    assert.equal((await set("never")).status, 200);
    await arm();
    assert.equal((await disarm()).status, 200);
    await arm();
    assert.equal((await disarm("0000")).status, 200, "a wrong PIN stops nothing when none is asked");
    await arm();
    assert.equal((await disarm("1357")).status, 200);
    assert.deepEqual(running.app.context.alarms.active({ silent: true }).map(alarm => alarm.code), ["duress_disarm"], "the duress PIN is never changed by the setting");
    // always: also a user without a PIN is refused
    await call(running, cookie, "DELETE", `/api/v1/users/${id}/pin`);
    assert.equal((await set("always")).status, 200);
    await arm();
    const refused = await disarm();
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "pin_not_set");
    assert.equal((await set("if_set")).status, 200);
    assert.equal((await disarm()).status, 200, "back to the default: a user without a PIN disarms");
  } finally { await running.stop(); }
});

test("ARMOR_DISARM_PIN wins over the setting, and the setting cannot be moved against it", async () => {
  const running = await startServer({ ARMOR_DISARM_PIN: "required" });
  try {
    const cookie = await studioCookie(running.base);
    const read = (await call(running, cookie, "GET", "/api/v1/security/settings")).body;
    assert.equal(read.settings["alarm.disarm_pin"], "always");
    assert.deepEqual(read.locked, ["alarm.disarm_pin"]);
    const refused = await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.disarm_pin": "never" });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.setting, "alarm.disarm_pin");
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.disarm_pin": "always" })).status, 200, "saying the same thing is allowed");
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "armed" });
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed" })).body.code, "pin_not_set");
    assert.deepEqual((await call(running, cookie, "GET", "/api/v1/studio/session")).body.capabilities.security.locked, ["alarm.disarm_pin"]);
  } finally { await running.stop(); }
  const other = await startServer({ ARMOR_DISARM_PIN: "optional" });
  try {
    const cookie = await studioCookie(other.base);
    assert.equal((await call(other, cookie, "GET", "/api/v1/security/settings")).body.settings["alarm.disarm_pin"], "if_set");
  } finally { await other.stop(); }
});

test("the voice service gets the policy of the server with every turn of audio", async () => {
  const seen: Array<string | undefined> = [];
  const gateway = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => { seen.push(request.headers["x-armor-policy"] as string | undefined); response.writeHead(200, json); response.end("{}"); });
  });
  await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const token = "v".repeat(32);
  const running = await startServer({ ARMOR_VOICE_URL: `http://127.0.0.1:${(gateway.address() as { port: number }).port}`, ARMOR_VOICE_TOKEN: token });
  try {
    const cookie = await studioCookie(running.base);
    const turn = () => fetch(`${running.base}/api/v1/voice/v1/turn`, { method: "POST", headers: { "X-Armor-Voice-Token": token, "Content-Type": "audio/L16;rate=16000" }, body: new Uint8Array(3200) });
    assert.equal((await turn()).status, 200);
    assert.deepEqual(JSON.parse(seen[0]!), { silence_confirmation: "off" }, "the default is off");
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "voice.silence_confirmation": "double_turn" })).status, 200);
    await turn();
    assert.deepEqual(JSON.parse(seen[1]!), { silence_confirmation: "double_turn" });
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "voice.silence_confirmation": "pin" })).status, 200);
    await turn();
    assert.deepEqual(JSON.parse(seen[2]!), { silence_confirmation: "pin" });
  } finally { await running.stop(); await new Promise<void>(resolve => gateway.close(() => resolve())); }
});

test("the signature is the one the shared contract defines", () => {
  // the same key, message and value as the contract's own test
  const key = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  assert.equal(zoneFeedSignature(key, "alarm-1", { zone: "z1", state: "triggered", battery_low: false }, 1700000000000), "330aa293a19d730d0deede3598b3efbed43887483298f15832c9ba4bfbda0378");
});

const door = (open: boolean): Device => ({ id: "door-1", kind: "door", online: true, state: { open } } as unknown as Device);

test("the zone feed can be turned off and can be signed so a panel knows it came from this server", () => {
  const dir = tempDir();
  const signer = new ZoneFeedSigner(path.join(dir, "zone-feed.key"));
  const sent: Array<[string, Record<string, unknown>]> = [];
  let enabled = true, signed = true;
  const feed = new AlarmZoneFeed(path.join(dir, "links.json"), {
    publish: (topic, payload) => { sent.push([topic, JSON.parse(payload)]); }, devices: () => [door(true)], now: () => 1_700_000_000_000,
    enabled: () => enabled, signer: () => (signed ? signer : undefined),
    panels: () => ["alarm-2"], policy: () => ({ config_hash: true, zone_feed: enabled, zone_feed_signature: signed }),
  });
  feed.set([{ device_id: "door-1", node_id: "alarm-1", zone_id: "z1" }]);
  const message = sent.find(([topic]) => topic === "armor/alarm/alarm-1/zigbee")![1];
  assert.equal(message.seq, 1_700_000_000_000);
  const expected = createHmac("sha256", Buffer.from(signer.keyFor("alarm-1"), "hex")).update(`alarm-1|z1|triggered|0|${message.seq}`).digest("hex");
  assert.equal(message.sig, expected, "a panel with its key can verify it");
  assert.notEqual(signer.keyFor("alarm-1"), signer.keyFor("alarm-2"), "each panel has its own key");
  assert.equal(new ZoneFeedSigner(path.join(dir, "zone-feed.key")).keyFor("alarm-1"), signer.keyFor("alarm-1"), "the key survives a restart");
  // unsigned when the signature is off
  sent.length = 0; signed = false; feed.refresh();
  assert.equal(sent[0]![1].sig, undefined);
  assert.equal(sent[0]![1].seq, undefined);
  // nothing at all when the feed is off
  sent.length = 0; enabled = false; feed.refresh(); feed.handleDevice(door(false));
  assert.equal(sent.length, 0);
  // the policy reaches the panels of the links and the ones the server knows
  feed.publishPolicy();
  assert.deepEqual(sent.map(([topic]) => topic).sort(), ["armor/alarm/alarm-1/policy", "armor/alarm/alarm-2/policy"]);
  assert.deepEqual(sent[0]![1], { config_hash: true, zone_feed: false, zone_feed_signature: false });
});

test("a panel's zone-feed key is given to an administrator only, and the settings reach the broker as the policy", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const published: Array<[string, string]> = [];
    running.app.context.alarmLink.publish = (topic, payload) => { published.push([topic, payload]); };
    const key = await call(running, cookie, "GET", "/api/v1/alarm/zone-feed/key/alarm-1");
    assert.equal(key.status, 200);
    assert.match(key.body.key, /^[0-9a-f]{64}$/);
    assert.equal(key.body.key, running.app.context.zoneFeedSigner.keyFor("alarm-1"));
    assert.equal((await call(running, cookie, "GET", "/api/v1/alarm/zone-feed/key/Bad Node")).status, 400);
    await call(running, cookie, "PUT", "/api/v1/alarm/zone-links", { links: [{ device_id: "door-1", node_id: "alarm-1", zone_id: "z1" }] });
    published.length = 0;
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.config_hash": false, "server.zone_feed_signature": false })).status, 200);
    const policy = published.find(([topic]) => topic === "armor/alarm/alarm-1/policy");
    assert.deepEqual(JSON.parse(policy![1]), { config_hash: false, zone_feed: true, zone_feed_signature: false });
  } finally { await running.stop(); }
});
