// The owner chooses how the arming modes reach the alarm panels: which profile each mode arms (default away->away, home->stay, night->night) and which panels are asked (default all of them),
// both kept in the arming-modes document and both behind the existing setting alarm.mode_panel_sync. Characterization of the defaults first, then the document, the engine and the route.
import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "../src/audit.js";
import { AlarmStore, parseAlarmCommand, type AlarmMessage } from "../src/alarm.js";
import { AlarmCommands } from "../src/alarm_commands.js";
import { defaultProfiles } from "../src/arm_profiles.js";
import { ModesInvalid, parseArmingModes, type ArmedMode, type PanelSyncConfig } from "../src/arming_modes.js";
import { MODE_PROFILE, ModePanelSync } from "../src/mode_panel_sync.js";
import { startServer, studioCookie, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const panelState = (node: string): AlarmMessage => ({
  kind: "alarm", node_id: node, timestamp_ms: 1000, phase: "disarmed", mode: "disarmed", siren: false, locked_out: false, commands_enabled: true, arm_profiles: true,
  zones: [{ id: "front-door", kind: "entry", state: "normal", bypassed: false }], open_zones: [], events: [],
});

function bench(config: () => PanelSyncConfig = () => ({}), panels = ["alarm-1", "alarm-2", "alarm-3"]) {
  const sent: Array<{ topic: string; payload: string }> = [];
  const audit: AuditEvent[] = [];
  const nodes = new AlarmStore({ now: () => 1_000_000 });
  const profiles = defaultProfiles();
  let counter = 0;
  const commands = new AlarmCommands({ enabled: true, nodes, audit: { record: event => { audit.push(event); } }, now: () => 1_000_000, random: () => (++counter).toString(16).padStart(16, "0"), publish: (topic, payload) => { sent.push({ topic, payload }); } });
  const sync = new ModePanelSync({
    enabled: () => true, now: () => 1_000_000, audit: { record: event => { audit.push(event); } },
    panels: () => nodes.list().map(node => node.node_id), profile: id => profiles.find(item => item.id === id),
    profileFor: mode => config().profiles?.[mode], only: () => config().only,
    arm: (node, base, actor, profile) => commands.request(node, "arm", base, false, actor, profile),
  });
  for (const panel of panels) nodes.ingest(panelState(panel));
  const profileOf = (index: number) => parseAlarmCommand(JSON.parse(sent[index]!.payload)).profile?.id;
  return { sync, sent, audit, profileOf, topics: () => sent.map(item => item.topic) };
}

test("characterization: with nothing configured every panel is asked and the modes arm away, stay and night", () => {
  assert.deepEqual(MODE_PROFILE, { away: "away", home: "stay", night: "night" });
  for (const [mode, profile] of Object.entries(MODE_PROFILE)) {
    const b = bench();
    b.sync.sync(mode as ArmedMode, "ana");
    assert.equal(b.sent.length, 3, mode);
    assert.deepEqual([0, 1, 2].map(i => b.profileOf(i)), [profile, profile, profile], mode);
    assert.equal(b.sync.view()?.profile, profile);
  }
});

test("the document keeps the mapping and the list, validates them, and a document without them is the one it always was", () => {
  const bare = parseArmingModes({ modes: { away: {}, home: {}, night: {} } });
  assert.equal("panel_map" in bare, false);
  const full = parseArmingModes({ modes: { away: {}, home: {}, night: {} }, panel_map: { profiles: { home: "away", night: "stay" }, only: ["alarm-1", "alarm-2"] } });
  assert.deepEqual(full.panel_map, { profiles: { home: "away", night: "stay" }, only: ["alarm-1", "alarm-2"] });
  assert.deepEqual(parseArmingModes({ modes: { away: {}, home: {}, night: {} }, panel_map: { only: [] } }).panel_map, { only: [] }, "an empty list is kept: it means no panel");
  const modes = { away: {}, home: {}, night: {} };
  for (const bad of [[], "x", { other: 1 }, { profiles: [] }, { profiles: { day: "away" } }, { profiles: { home: "Away" } }, { profiles: { home: "a".repeat(17) } }, { profiles: { home: 5 } }, { profiles: { home: "" } },
    { only: "alarm-1" }, { only: [5] }, { only: ["bad name"] }, { only: ["a", "a"] }, { only: Array.from({ length: 33 }, (_, i) => `p${i}`) }, { only: ["../x"] }]) {
    assert.throws(() => parseArmingModes({ modes, panel_map: bad }), ModesInvalid, JSON.stringify(bad));
  }
});

test("the mapping decides the profile of each mode, and a mode without an entry keeps its own", () => {
  const b = bench(() => ({ profiles: { home: "away", night: "stay" } }));
  b.sync.sync("home", "ana");
  assert.deepEqual([b.profileOf(0), b.sync.view()?.profile], ["away", "away"]);
  const c = bench(() => ({ profiles: { home: "away", night: "stay" } }));
  c.sync.sync("away", "ana");
  assert.equal(c.profileOf(0), "away");
  const d = bench(() => ({ profiles: { night: "stay" } }));
  d.sync.sync("night", "ana");
  assert.equal(d.profileOf(0), "stay");
});

test("a profile that does not exist is a failed panel with its reason, and the mode is never held back", () => {
  const b = bench(() => ({ profiles: { home: "gone" } }));
  b.sync.sync("home", "ana");
  assert.equal(b.sent.length, 0);
  assert.deepEqual([b.sync.view()?.status, b.sync.view()?.nodes.map(node => node.reason)], ["failed", ["unknown_profile", "unknown_profile", "unknown_profile"]]);
});

test("the list limits the panels asked; a panel it names that the server does not know is a failure, never a silent skip; an empty list asks nobody", () => {
  const only = bench(() => ({ only: ["alarm-2"] }));
  only.sync.sync("away", "ana");
  assert.equal(only.sent.length, 1);
  assert.match(only.topics()[0]!, /alarm-2/);
  assert.deepEqual(only.sync.view()?.nodes.map(node => node.node_id), ["alarm-2"]);

  const typo = bench(() => ({ only: ["alarm-2", "alarm-9"] }));
  typo.sync.sync("away", "ana");
  assert.equal(typo.sent.length, 1, "the known one is asked");
  assert.deepEqual([typo.sync.view()?.status, typo.sync.view()?.nodes.find(node => node.node_id === "alarm-9")?.reason], ["pending", "unknown_panel"]);   // it ends failed as soon as the known one answers

  const nobody = bench(() => ({ only: [] }));
  nobody.sync.sync("away", "ana");
  assert.equal(nobody.sent.length, 0);
  assert.equal(nobody.sync.view()?.status, "none");

  const all = bench(() => ({}));
  all.sync.sync("away", "ana");
  assert.equal(all.sent.length, 3, "no list is every panel, also the ones that appear later");
});

test("property: whatever the mapping and the list, only the listed known panels are asked, each with the profile of the mode", () => {
  let seed = 3;
  const random = (limit: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % limit; };
  const ids = ["alarm-1", "alarm-2", "alarm-3"], profileIds = ["away", "stay", "night"];
  for (let round = 0; round < 120; round += 1) {
    const only = random(3) === 0 ? undefined : ids.filter(() => random(2) === 0);
    const profiles: Partial<Record<ArmedMode, string>> = {};
    for (const mode of ["away", "home", "night"] as const) if (random(2) === 0) profiles[mode] = profileIds[random(3)]!;
    const mode = (["away", "home", "night"] as const)[random(3)]!;
    const b = bench(() => ({ ...(only ? { only } : {}), profiles }));
    b.sync.sync(mode, "ana");
    const expectedPanels = only ?? ids, expectedProfile = profiles[mode] ?? MODE_PROFILE[mode];
    assert.equal(b.sent.length, expectedPanels.length);
    for (let i = 0; i < b.sent.length; i += 1) assert.equal(b.profileOf(i), expectedProfile);
  }
});

// ------------------------------------------------------------------ the route

const call = async (running: Running, cookie: string, method: string, route: string, body?: unknown) => {
  const response = await fetch(`${running.base}${route}`, { method, headers: { ...json, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

test("route: the document is saved and read with the mapping and the list, the engine uses them, and nothing changes while the setting is off", async () => {
  const running = await startServer({ ARMOR_ALARM_COMMANDS: "1", ARMOR_ALERT_DWELL_MS: "0" });
  try {
    const cookie = await studioCookie(running.base);
    const published: Array<{ topic: string; payload: string }> = [];
    running.app.context.alarmLink.publish = (topic, payload) => { if (topic.endsWith("/command")) published.push({ topic, payload }); };
    for (const node of ["alarm-1", "alarm-2"]) running.app.context.alarmNodes.ingest(panelState(node));
    running.app.context.devices.create({ id: "front-door", name: "Front door", kind: "door", location: "Hall" });
    const read = (await call(running, cookie, "GET", "/api/v1/alarm/modes")).body;
    assert.deepEqual(read.panel_map, {}, "the defaults are an empty object");
    const modes = { away: {}, home: { defends: ["zone:Hall"] }, night: { defends: ["zone:Hall"] } };
    const saved = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { revision: read.revision, modes, panel_map: { profiles: { home: "away" }, only: ["alarm-2"] } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.panel_map, { profiles: { home: "away" }, only: ["alarm-2"] });
    assert.equal((await call(running, cookie, "PUT", "/api/v1/alarm/modes", { revision: saved.body.revision, modes, panel_map: { only: ["bad name"] } })).status, 400);
    assert.equal((await call(running, cookie, "GET", "/api/v1/alarm/modes")).body.panel_map.only[0], "alarm-2", "a refused save changes nothing");
    // setting off: the mode is chosen and no panel is asked
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.arming_modes": true })).status, 200);
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" })).status, 200);
    assert.equal(published.length, 0);
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed" });
    // setting on: only alarm-2, with the profile away
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.mode_panel_sync": true })).status, 200);
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" })).status, 200);
    assert.equal(published.length, 1);
    assert.match(published[0]!.topic, /alarm-2/);
    assert.equal(parseAlarmCommand(JSON.parse(published[0]!.payload)).profile?.id, "away");
    // it survives a restart of the store (the file)
    assert.deepEqual(running.app.context.armingModes.get().panel_map, { profiles: { home: "away" }, only: ["alarm-2"] });
  } finally { await running.stop(); }
});

test("route: only an administrator saves the mapping and the list", async () => {
  const running = await startServer({ ARMOR_ALERT_DWELL_MS: "0" });
  try {
    const admin = await studioCookie(running.base);
    const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: { ...json, cookie: admin }, body: JSON.stringify({ username: "u-op", password: "operator-password-123", role: "operator" }) });
    assert.equal(made.status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "u-op", password: "operator-password-123" }) });
    const operator = (login.headers.getSetCookie()[0] ?? "").split(";")[0]!;
    const body = { revision: 0, modes: { away: {}, home: {}, night: {} }, panel_map: { only: [] } };
    assert.ok((await call(running, operator, "PUT", "/api/v1/alarm/modes", body)).status >= 401);
    assert.equal((await call(running, admin, "GET", "/api/v1/alarm/modes")).body.panel_map.only, undefined);
  } finally { await running.stop(); }
});
