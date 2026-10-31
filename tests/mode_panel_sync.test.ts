// Choosing an arming mode on the server also arms the alarm panels with the profile that goes with it (away -> away, home -> stay, night -> night), behind the setting
// alarm.mode_panel_sync. First what the server did before it (characterization, the setting OFF), then the matrix mode x profile x answer of the node (accepts, refuses, silent, cannot be
// asked), then the route: access, audit, the state a client reads, and the fail-closed rule (the mode of the server never claims what a panel did not confirm).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AuditEvent, AuditLog } from "../src/audit.js";
import { AlarmStore, parseAlarmCommand, type AlarmMessage, type AlarmRefusal } from "../src/alarm.js";
import { AlarmCommands, type AlarmRecord } from "../src/alarm_commands.js";
import { defaultProfiles } from "../src/arm_profiles.js";
import { ARMED_MODES } from "../src/arming_modes.js";
import { MODE_PROFILE, ModePanelSync } from "../src/mode_panel_sync.js";
import { lowers, SECURITY_DEFAULTS } from "../src/security_settings.js";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = { status: number; body: Record<string, any> };
const call = async (running: Running, cookie: string, method: string, route: string, body?: unknown): Promise<Answer> => {
  const response = await fetch(`${running.base}${route}`, { method, headers: { ...json, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
};
const auditText = (running: Running): string => fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
const panelState = (node: string, extra: Partial<AlarmMessage> = {}): AlarmMessage => ({
  kind: "alarm", node_id: node, timestamp_ms: 1000, phase: "disarmed", mode: "disarmed", siren: false, locked_out: false, commands_enabled: true, arm_profiles: true,
  zones: [{ id: "front-door", kind: "entry", state: "normal", bypassed: false }], open_zones: [], events: [], ...extra,
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The bench: the real command service and the real profiles, a clock that is ours.
// ---------------------------------------------------------------------------------------------------------------------------------------------------
function bench(options: { enabled?: boolean; commands?: boolean; profiles?: ReturnType<typeof defaultProfiles> } = {}) {
  let clock = 1_000_000;
  const sent: Array<{ topic: string; payload: string }> = [];
  const audit: AuditEvent[] = [];
  const log: AuditLog = { record: event => { audit.push(event); } };
  const nodes = new AlarmStore({ now: () => clock });
  const profiles = options.profiles ?? defaultProfiles();
  let counter = 0;
  const changes: number[] = [];
  // eslint-disable-next-line prefer-const
  let sync: ModePanelSync;
  const commands = new AlarmCommands({
    enabled: options.commands ?? true, nodes, audit: log, now: () => clock, random: () => (++counter).toString(16).padStart(16, "0"),
    publish: (topic, payload) => { sent.push({ topic, payload }); }, onSettled: record => sync.settled(record),
  });
  sync = new ModePanelSync({
    enabled: () => options.enabled ?? true, now: () => clock, audit: log, changed: () => { changes.push(clock); },
    panels: () => nodes.list().map(node => node.node_id), profile: id => profiles.find(item => item.id === id),
    arm: (node, base, actor, profile) => commands.request(node, "arm", base, false, actor, profile),
  });
  const answer = (index: number, accepted: boolean, refusal: AlarmRefusal = "none"): void => {
    const command = parseAlarmCommand(JSON.parse(sent[index].payload));
    commands.handleResult({ kind: "alarm_result", node_id: command.node_id, timestamp_ms: 9, command_id: command.command_id, action: "arm", accepted, refusal, phase: accepted ? "exit_delay" : "disarmed" }, command.node_id);
  };
  return { sync, commands, nodes, sent, audit, changes, answer, advance: (ms: number) => { clock += ms; commands.sweep(); }, clock: () => clock };
}
const sentProfile = (b: ReturnType<typeof bench>, index: number): [string | undefined, string | undefined, string | undefined] => {
  const command = parseAlarmCommand(JSON.parse(b.sent[index].payload));
  return [b.sent[index].topic, command.mode, command.profile?.id];
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 1. What the server did before this (the setting is OFF by default, and that is how it must stay)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

test("characterization: the setting is off by default, lowers nothing, and with it off a mode touches no panel and adds no field", async () => {
  assert.equal(SECURITY_DEFAULTS["alarm.mode_panel_sync"], false);
  assert.equal(lowers("alarm.mode_panel_sync", true, false), false);
  assert.equal(lowers("alarm.mode_panel_sync", false, true), false);
  const running = await startServer({ ARMOR_ALARM_COMMANDS: "1", ARMOR_ALERT_DWELL_MS: "0" });
  try {
    const cookie = await studioCookie(running.base);
    const published: string[] = [];
    running.app.context.alarmLink.publish = (topic, payload) => { if (topic.endsWith("/command")) published.push(`${topic} ${payload}`); };   // the policy and the zone feed use the same link
    running.app.context.alarmNodes.ingest(panelState("alarm-1"));
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.arming_modes": true })).status, 200);
    running.app.context.devices.create({ id: "front-door", name: "Front door", kind: "door", location: "Hall" });
    const put = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: { away: {}, home: { defends: ["zone:Hall"] }, night: { defends: ["zone:Hall"] } } });
    assert.equal(put.status, 200);
    assert.equal(put.body.panel_sync_enabled, false);
    for (const mode of ["home", "night", "away"]) {
      const answer = await call(running, cookie, "POST", "/api/v1/mode", { mode });
      assert.equal(answer.status, 200);
      assert.equal(answer.body.arming_mode, mode);
      assert.equal("panel_sync" in answer.body, false, "a client that knows nothing of the panel sync sees no new field");
    }
    assert.deepEqual(published, [], "no panel is asked while the setting is off");
    assert.equal("panel_sync" in (await call(running, cookie, "GET", "/api/v1/alarm/modes")).body, false);
    assert.equal(auditText(running).includes("control.mode_panel"), false);
  } finally { await running.stop(); }
});

test("the profiles and the modes stay two things: the map of mode to profile is fixed and every profile it names is one that exists from the start", () => {
  assert.deepEqual({ ...MODE_PROFILE }, { away: "away", home: "stay", night: "night" });
  const ids = defaultProfiles().map(item => item.id);
  for (const mode of ARMED_MODES) assert.ok(ids.includes(MODE_PROFILE[mode]), `${mode} -> ${MODE_PROFILE[mode]} exists by default`);
  assert.deepEqual(defaultProfiles().map(item => item.base), ["away", "stay", "stay"]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 2. The matrix: mode x profile x what the node does
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const EXPECTED: Record<string, [string, string]> = { away: ["away", "away"], home: ["stay", "stay"], night: ["stay", "night"] };   // mode -> [base the node is asked, profile id]

for (const mode of ARMED_MODES) {
  const [base, profile] = EXPECTED[mode];
  test(`matrix ${mode}: the panel is asked to arm ${base} with the profile ${profile}, and it is confirmed only when the node says accepted`, () => {
    const b = bench();
    b.nodes.ingest(panelState("alarm-1"));
    b.sync.sync(mode, "ana");
    assert.deepEqual(sentProfile(b, 0), ["armor/alarm/alarm-1/command", base, profile]);
    assert.ok(!b.sent[0].payload.includes("pin"), "no PIN travels");
    assert.deepEqual([b.sync.view()?.status, b.sync.view()?.nodes[0].status, b.sync.view()?.profile, b.sync.view()?.by], ["pending", "pending", profile, "ana"]);
    assert.equal(b.sync.view()?.settled_at, undefined, "asked is not confirmed");
    b.answer(0, true);
    assert.deepEqual([b.sync.view()?.status, b.sync.view()?.nodes[0].status], ["confirmed", "confirmed"]);
    assert.ok(b.sync.view()?.settled_at);
    assert.ok(b.audit.some(event => event.action === "control.mode_panel" && event.outcome === "allowed" && (event.detail ?? "").includes("confirmed")));
  });

  for (const refusal of ["not_disarmed", "zones_open", "locked_out"] as const) {
    test(`matrix ${mode}: a node that refuses (${refusal}) leaves the report failed with the reason and an audit line`, () => {
      const b = bench();
      b.nodes.ingest(panelState("alarm-1"));
      b.sync.sync(mode, "ana");
      b.answer(0, false, refusal);
      const view = b.sync.view();
      assert.deepEqual([view?.status, view?.nodes[0].status, view?.nodes[0].reason], ["failed", "refused", refusal]);
      assert.ok(b.audit.some(event => event.action === "control.mode_panel" && event.outcome === "denied" && (event.detail ?? "").includes(refusal)));
    });
  }

  test(`matrix ${mode}: a node that never answers is pending until the wait is over, then failed (timeout), never confirmed`, () => {
    const b = bench();
    b.nodes.ingest(panelState("alarm-1"));
    b.sync.sync(mode, "ana");
    b.advance(4_000);
    assert.equal(b.sync.view()?.status, "pending");
    b.advance(1_500);
    assert.deepEqual([b.sync.view()?.status, b.sync.view()?.nodes[0].status, b.sync.view()?.nodes[0].reason], ["failed", "timeout", "timeout"]);
    assert.ok(b.audit.some(event => event.action === "control.mode_panel" && event.outcome === "failed"));
    // an answer that comes after the wait is not a confirmation
    b.answer(0, true);
    assert.equal(b.sync.view()?.status, "failed");
  });
}

test("matrix: a panel that cannot be asked is reported with the reason, and nothing is sent to it", () => {
  const stale = bench();
  stale.nodes.ingest(panelState("alarm-1"));
  stale.advance(10 * 60_000);
  stale.sync.sync("home", "ana");
  assert.deepEqual([stale.sync.view()?.status, stale.sync.view()?.nodes[0].reason], ["failed", "node_unavailable"]);
  assert.equal(stale.sent.length, 0);

  const nodeOff = bench();
  nodeOff.nodes.ingest(panelState("alarm-1", { commands_enabled: false }));
  nodeOff.sync.sync("home", "ana");
  assert.equal(nodeOff.sync.view()?.nodes[0].reason, "node_commands_off");

  const oldFirmware = bench();
  oldFirmware.nodes.ingest(panelState("alarm-1", { arm_profiles: false }));
  oldFirmware.sync.sync("night", "ana");
  assert.equal(oldFirmware.sync.view()?.nodes[0].reason, "profiles_unsupported", "a node that does not know profiles is not armed behind the owner's back");
  assert.equal(oldFirmware.sent.length, 0);

  const commandsOff = bench({ commands: false });
  commandsOff.nodes.ingest(panelState("alarm-1"));
  commandsOff.sync.sync("away", "ana");
  assert.equal(commandsOff.sync.view()?.nodes[0].reason, "commands_disabled");
  assert.equal(commandsOff.sent.length, 0);
  assert.ok(commandsOff.audit.some(event => event.action === "control.mode_panel" && event.outcome === "denied"));
});

test("matrix: a night profile the owner removed is a failure said out loud, not a silent arm of another profile", () => {
  const b = bench({ profiles: defaultProfiles().filter(item => item.id !== "night") });
  b.nodes.ingest(panelState("alarm-1"));
  b.sync.sync("night", "ana");
  assert.deepEqual([b.sync.view()?.status, b.sync.view()?.nodes[0].reason], ["failed", "unknown_profile"]);
  assert.equal(b.sent.length, 0);
});

test("matrix: several panels are each asked, and one that fails makes the whole report failed while the others stay confirmed", () => {
  const b = bench();
  b.nodes.ingest(panelState("alarm-1"));
  b.nodes.ingest(panelState("alarm-2"));
  b.sync.sync("home", "ana");
  assert.equal(b.sent.length, 2);
  b.answer(0, true);
  assert.equal(b.sync.view()?.status, "pending", "one answer is not all of them");
  b.answer(1, false, "zones_open");
  assert.deepEqual(b.sync.view()?.nodes.map(node => node.status), ["confirmed", "refused"]);
  assert.equal(b.sync.view()?.status, "failed");
});

test("matrix: no panel known is said as none, and it is not a failure", () => {
  const b = bench();
  b.sync.sync("home", "ana");
  assert.deepEqual([b.sync.view()?.status, b.sync.view()?.nodes.length], ["none", 0]);
  assert.ok(b.audit.some(event => event.action === "control.mode_panel" && event.outcome === "allowed"));
});

test("matrix: choosing the same mode again retries a failure, but never repeats a confirmed or a pending one; a new mode replaces the report and a late answer to the old command is not ours", () => {
  const b = bench();
  b.nodes.ingest(panelState("alarm-1"));
  b.sync.sync("home", "ana");
  b.sync.sync("home", "ana", true);
  assert.equal(b.sent.length, 1, "pending: not asked twice");
  b.answer(0, false, "zones_open");
  b.sync.sync("home", "ana", true);
  assert.equal(b.sent.length, 2, "failed: asked again");
  b.answer(1, true);
  b.sync.sync("home", "ana", true);
  assert.equal(b.sent.length, 2, "confirmed: left alone");
  b.sync.sync("night", "ana");
  assert.equal(b.sent.length, 3);
  assert.deepEqual([b.sync.view()?.mode, b.sync.view()?.profile], ["night", "night"]);
  b.answer(1, true);   // the answer of the old command has been used already and is dropped
  assert.equal(b.sync.view()?.status, "pending");
});

test("matrix: a second mode while the node still waits for the first answer is reported busy, not lost", () => {
  const b = bench();
  b.nodes.ingest(panelState("alarm-1"));
  b.sync.sync("home", "ana");
  b.sync.sync("night", "ana");
  assert.deepEqual([b.sync.view()?.status, b.sync.view()?.nodes[0].reason], ["failed", "busy"]);
  assert.equal(b.sent.length, 1);
});

test("the setting off, or a disarm, leaves no report; the changes of the report are told so that the state is sent again", () => {
  const off = bench({ enabled: false });
  off.nodes.ingest(panelState("alarm-1"));
  off.sync.sync("home", "ana");
  assert.equal(off.sent.length, 0);
  assert.equal(off.sync.view(), undefined);

  const b = bench();
  b.nodes.ingest(panelState("alarm-1"));
  b.sync.sync("away", "ana");
  b.answer(0, true);
  assert.equal(b.changes.length, 2, "asked, then answered");
  b.sync.clear();
  assert.equal(b.sync.view(), undefined);
  assert.equal(b.changes.length, 3);
  b.sync.clear();
  assert.equal(b.changes.length, 3, "nothing to clear, nothing to tell");
});

test("a listener that throws never breaks the record of a command", () => {
  const b = bench();
  const records: AlarmRecord[] = [];
  const commands = new AlarmCommands({ enabled: true, nodes: b.nodes, audit: { record: () => undefined }, publish: () => undefined, onSettled: record => { records.push(record); throw new Error("boom"); }, random: () => "00000000000000aa" });
  b.nodes.ingest(panelState("alarm-1"));
  commands.request("alarm-1", "arm", "away", false, "ana");
  commands.handleResult({ kind: "alarm_result", node_id: "alarm-1", timestamp_ms: 9, command_id: "00000000000000aa", action: "arm", accepted: true, refusal: "none", phase: "exit_delay" }, "alarm-1");
  assert.equal(records.length, 1);
  assert.equal(commands.status().recent.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 3. The route: access, audit, what a client reads, fail-closed
// ---------------------------------------------------------------------------------------------------------------------------------------------------

async function prepared(): Promise<{ running: Running; cookie: string; published: Array<{ topic: string; payload: string }> }> {
  const running = await startServer({ ARMOR_ALARM_COMMANDS: "1", ARMOR_ALERT_DWELL_MS: "0" });
  const cookie = await studioCookie(running.base);
  const published: Array<{ topic: string; payload: string }> = [];
  running.app.context.alarmLink.publish = (topic, payload) => { if (topic.endsWith("/command")) published.push({ topic, payload }); };   // the policy and the zone feed use the same link
  running.app.context.alarmNodes.ingest(panelState("alarm-1"));
  running.app.context.devices.create({ id: "front-door", name: "Front door", kind: "door", location: "Hall" });
  running.app.context.devices.create({ id: "den-motion", name: "Den motion", kind: "motion", location: "Den" });
  const settings = await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.arming_modes": true, "alarm.mode_panel_sync": true });
  assert.equal(settings.status, 200);
  const put = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: { away: {}, home: { defends: ["zone:Hall"] }, night: { defends: ["zone:Hall", "zone:Den"] } } });
  assert.equal(put.status, 200);
  return { running, cookie, published };
}
const answerNode = (running: Running, published: Array<{ payload: string }>, index: number, accepted: boolean, refusal: AlarmRefusal = "none"): void => {
  const command = parseAlarmCommand(JSON.parse(published[index].payload));
  running.app.context.alarmCommands.handleResult({ kind: "alarm_result", node_id: command.node_id, timestamp_ms: 9, command_id: command.command_id, action: "arm", accepted, refusal, phase: "exit_delay" }, command.node_id);
};

test("route: choosing home asks the panel for stay, the answer is pending until the node confirms, and the state, the modes route and the audit say so", async () => {
  const { running, cookie, published } = await prepared();
  try {
    const modes = (await call(running, cookie, "GET", "/api/v1/alarm/modes")).body;
    assert.equal(modes.panel_sync_enabled, true);
    assert.equal("panel_sync" in modes, false, "nothing chosen yet");
    const chosen = await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" });
    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.arming_mode, "home", "the server defends the mode at once");
    assert.equal(published.length, 1);
    assert.deepEqual([published[0].topic, parseAlarmCommand(JSON.parse(published[0].payload)).profile?.id, parseAlarmCommand(JSON.parse(published[0].payload)).mode], ["armor/alarm/alarm-1/command", "stay", "stay"]);
    assert.deepEqual([chosen.body.panel_sync.status, chosen.body.panel_sync.mode, chosen.body.panel_sync.profile, chosen.body.panel_sync.nodes[0].status], ["pending", "home", "stay", "pending"]);
    answerNode(running, published, 0, true);
    const status = (await call(running, cookie, "GET", "/api/v1/status")).body;
    assert.deepEqual([status.arming_mode, status.panel_sync.status, status.panel_sync.nodes[0].status], ["home", "confirmed", "confirmed"]);
    assert.deepEqual((await call(running, cookie, "GET", "/api/v1/alarm/modes")).body.panel_sync.status, "confirmed");
    const audit = auditText(running);
    assert.ok(audit.includes("control.mode_panel") && audit.includes("home -> profile stay"));
  } finally { await running.stop(); }
});

test("route: a refusal or a silent node does not undo the mode of the server and is never shown as confirmed; choosing the mode again asks again", async () => {
  const { running, cookie, published } = await prepared();
  try {
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "night" })).status, 200);
    assert.equal(parseAlarmCommand(JSON.parse(published[0].payload)).profile?.id, "night");
    answerNode(running, published, 0, false, "zones_open");
    let status = (await call(running, cookie, "GET", "/api/v1/status")).body;
    assert.deepEqual([status.arming_mode, status.mode, status.panel_sync.status, status.panel_sync.nodes[0].reason], ["night", "armed", "failed", "zones_open"]);
    const again = await call(running, cookie, "POST", "/api/v1/mode", { mode: "night" });
    assert.equal(again.status, 200);
    assert.equal(published.length, 2, "the same mode is asked again after a failure");
    assert.equal(again.body.panel_sync.status, "pending");
    answerNode(running, published, 1, true);
    status = (await call(running, cookie, "GET", "/api/v1/status")).body;
    assert.equal(status.panel_sync.status, "confirmed");
  } finally { await running.stop(); }
});

test("route: a node that does not take commands is a failed panel in the answer, not an error of the request", async () => {
  const { running, cookie, published } = await prepared();
  try {
    running.app.context.alarmNodes.ingest(panelState("alarm-1", { commands_enabled: false, timestamp_ms: 2000 }));
    const chosen = await call(running, cookie, "POST", "/api/v1/mode", { mode: "away" });
    assert.equal(chosen.status, 200);
    assert.deepEqual([chosen.body.arming_mode, chosen.body.panel_sync.status, chosen.body.panel_sync.nodes[0].reason], ["away", "failed", "node_commands_off"]);
    assert.equal(published.length, 0);
    assert.ok(auditText(running).includes("node_commands_off"));
  } finally { await running.stop(); }
});

test("route: a disarm clears the report and does not disarm the panel; nothing is sent when the mode itself is refused", async () => {
  const { running, cookie, published } = await prepared();
  try {
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "away" })).status, 200);
    answerNode(running, published, 0, true);
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed" })).status, 200);
    assert.equal("panel_sync" in (await call(running, cookie, "GET", "/api/v1/status")).body, false);
    assert.equal(published.length, 1, "only the arm was sent: no disarm travels");
    // a mode that defends nothing is refused before anything is asked of a panel
    await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: { away: {}, home: {}, night: {} } });
    const refused = await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" });
    assert.deepEqual([refused.status, refused.body.code], [409, "no_zones_assigned"]);
    assert.equal(published.length, 1);
    const confirmed = await call(running, cookie, "POST", "/api/v1/mode", { mode: "home", confirm_unassigned: true });
    assert.equal(confirmed.status, 200);
    assert.equal(published.length, 2, "a confirmed mode is a mode: the panel follows");
  } finally { await running.stop(); }
});

test("route: the same access as the mode: nobody signed in, and a viewer, change nothing and ask no panel; a wrong PIN on a downgrade asks none", async () => {
  const { running, cookie, published } = await prepared();
  try {
    const anonymous = await fetch(`${running.base}/api/v1/mode`, { method: "POST", headers: json, body: JSON.stringify({ mode: "home" }) });
    assert.equal(anonymous.status, 401);
    assert.equal(published.length, 0);
    const created = await call(running, cookie, "POST", "/api/v1/users", { username: "guest", password: "a-long-guest-password-1", role: "viewer" });
    assert.equal(created.status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "guest", password: "a-long-guest-password-1" }) });
    const viewer = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    assert.equal((await call(running, viewer, "POST", "/api/v1/mode", { mode: "home" })).status, 403);
    assert.equal(published.length, 0);
    // away -> home defends less: it needs the PIN, and with a PIN set a wrong one changes nothing and asks no panel
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "away" })).status, 200);
    assert.equal(published.length, 1);
    answerNode(running, published, 0, true);
    const me = ((await call(running, cookie, "GET", "/api/v1/users")).body.users as Array<{ id: string; current: boolean }>).find(user => user.current)!.id;
    assert.equal((await call(running, cookie, "PUT", `/api/v1/users/${me}/pin`, { pin: "2468", duress_pin: "1357" })).status, 200);
    const wrong = await call(running, cookie, "POST", "/api/v1/mode", { mode: "home", pin: "0000" });
    assert.deepEqual([wrong.status, wrong.body.code], [403, "wrong_pin"]);
    assert.equal(published.length, 1);
    assert.equal((await call(running, cookie, "GET", "/api/v1/status")).body.arming_mode, "away");
    const right = await call(running, cookie, "POST", "/api/v1/mode", { mode: "home", pin: "2468" });
    assert.equal(right.status, 200);
    assert.equal(published.length, 2);
  } finally { await running.stop(); }
});

test("route: the timetable changes the mode by itself and the panel follows, in the name of the schedule", async () => {
  const { running, cookie, published } = await prepared();
  try {
    await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.mode_schedule": true });
    await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: { away: {}, home: { defends: ["zone:Hall"] }, night: { defends: ["zone:Hall", "zone:Den"] } }, schedule: [{ mode: "night", days: [1, 2, 3, 4, 5, 6, 7], at: "23:00" }] });
    const midnight = new Date("2026-03-04T23:00:30Z");   // the minute only has to match in the time zone of the server
    const zone = process.env.ARMOR_TZ;
    process.env.ARMOR_TZ = "UTC";
    try { running.app.context.armingModes.tick(midnight); } finally { if (zone === undefined) delete process.env.ARMOR_TZ; else process.env.ARMOR_TZ = zone; }
    assert.equal(published.length, 1);
    assert.equal(parseAlarmCommand(JSON.parse(published[0].payload)).profile?.id, "night");
    assert.equal(running.app.context.modePanelSync.view()?.by, "schedule");
  } finally { await running.stop(); }
});

test("route: the setting needs the modes: with the modes off nothing is asked, whatever the setting says", async () => {
  const { running, cookie, published } = await prepared();
  try {
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.arming_modes": false })).status, 200);
    const armed = await call(running, cookie, "POST", "/api/v1/mode", { mode: "armed" });
    assert.equal(armed.status, 200);
    assert.equal("panel_sync" in armed.body, false);
    assert.equal(published.length, 0);
    assert.equal((await call(running, cookie, "GET", "/api/v1/alarm/modes")).body.panel_sync_enabled, false);
  } finally { await running.stop(); }
});

void SECRETS;
