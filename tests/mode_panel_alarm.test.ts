// A panel that does not confirm the arming mode is an alarm in the alarm centre (code mode_panel_sync_failed), and arming by the control API or by voice is arming the mode away, with the
// same panel sync. First what the server did before (characterization), then the matrix and the properties of the alarm, then the routes.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import type { AuditEvent, AuditLog } from "../src/audit.js";
import { AlarmStore, parseAlarmCommand, type AlarmMessage, type AlarmRefusal } from "../src/alarm.js";
import { AlarmCommands } from "../src/alarm_commands.js";
import { alarmCodeWords } from "../src/alarm_codes.js";
import { defaultProfiles } from "../src/arm_profiles.js";
import { ARMED_MODES } from "../src/arming_modes.js";
import { ModePanelSync, type PanelSync } from "../src/mode_panel_sync.js";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = { status: number; body: Record<string, any> };
const call = async (running: Running, cookie: string, method: string, route: string, body?: unknown): Promise<Answer> => {
  const response = await fetch(`${running.base}${route}`, { method, headers: { ...json, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
};
const control = (running: Running, mode: string, token: string | null = SECRETS.ARMOR_CONTROL_TOKEN): Promise<Response> =>
  fetch(`${running.base}/api/v1/control/${mode}`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} });
const panelState = (node: string, extra: Partial<AlarmMessage> = {}): AlarmMessage => ({
  kind: "alarm", node_id: node, timestamp_ms: 1000, phase: "disarmed", mode: "disarmed", siren: false, locked_out: false, commands_enabled: true, arm_profiles: true,
  zones: [{ id: "front-door", kind: "entry", state: "normal", bypassed: false }], open_zones: [], events: [], ...extra,
});
const KEY = "mode_panel_sync";

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The bench of the unit: the real command service, the real profiles, and spies where the alarm centre would be.
// ---------------------------------------------------------------------------------------------------------------------------------------------------
function bench(options: { enabled?: boolean } = {}) {
  let clock = 1_000_000, counter = 0, enabled = options.enabled ?? true;
  const sent: Array<{ topic: string; payload: string }> = [];
  const audit: AuditEvent[] = [];
  const log: AuditLog = { record: event => { audit.push(event); } };
  const nodes = new AlarmStore({ now: () => clock });
  const profiles = defaultProfiles();
  const raised: PanelSync[] = [];
  let open = 0, ended = 0;
  // eslint-disable-next-line prefer-const
  let sync: ModePanelSync;
  const commands = new AlarmCommands({
    enabled: true, nodes, audit: log, now: () => clock, random: () => (++counter).toString(16).padStart(16, "0"),
    publish: (topic, payload) => { sent.push({ topic, payload }); }, onSettled: record => sync.settled(record),
  });
  sync = new ModePanelSync({
    enabled: () => enabled, now: () => clock, audit: log,
    panels: () => nodes.list().map(node => node.node_id), profile: id => profiles.find(item => item.id === id),
    arm: (node, base, actor, profile) => commands.request(node, "arm", base, false, actor, profile),
    raise: state => { if (open === 0) { open = 1; raised.push(state); } }, end: () => { if (open) { open = 0; ended += 1; } },
  });
  const answer = (index: number, accepted: boolean, refusal: AlarmRefusal = "none"): void => {
    const command = parseAlarmCommand(JSON.parse(sent[index].payload));
    commands.handleResult({ kind: "alarm_result", node_id: command.node_id, timestamp_ms: 9, command_id: command.command_id, action: "arm", accepted, refusal, phase: accepted ? "exit_delay" : "disarmed" }, command.node_id);
  };
  return { sync, nodes, sent, audit, raised, answer, isOpen: () => open === 1, ended: () => ended, advance: (ms: number) => { clock += ms; commands.sweep(); }, setEnabled: (value: boolean) => { enabled = value; } };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 1. The matrix: mode x what the panel does -> is there an alarm
// ---------------------------------------------------------------------------------------------------------------------------------------------------
for (const mode of ARMED_MODES) {
  for (const refusal of ["not_disarmed", "zones_open", "locked_out"] as const) {
    test(`matrix ${mode}: a refusal (${refusal}) raises the alarm once, with the mode, the profile and the panel that failed; the same panel confirming later ends it`, () => {
      const b = bench();
      b.nodes.ingest(panelState("alarm-1"));
      b.sync.sync(mode, "ana");
      assert.equal(b.isOpen(), false, "pending is not a failure");
      b.answer(0, false, refusal);
      assert.equal(b.isOpen(), true);
      assert.equal(b.raised.length, 1);
      assert.deepEqual([b.raised[0].status, b.raised[0].mode, b.raised[0].nodes[0].reason], ["failed", mode, refusal]);
      b.sync.sync(mode, "ana", true);   // the same mode again: a new try
      assert.equal(b.isOpen(), false, "a new try ends the old alarm");
      b.answer(1, true);
      assert.equal(b.isOpen(), false);
      assert.equal(b.raised.length, 1);
    });
  }

  test(`matrix ${mode}: a node that stays silent is an alarm only after the wait, never before`, () => {
    const b = bench();
    b.nodes.ingest(panelState("alarm-1"));
    b.sync.sync(mode, "ana");
    b.advance(4_000);
    assert.equal(b.isOpen(), false);
    b.advance(1_500);
    assert.equal(b.isOpen(), true);
    assert.equal(b.raised[0].nodes[0].status, "timeout");
  });
}

test("matrix: a panel that cannot be asked is an alarm; no panel known (none) and a confirmed one are not", () => {
  const stale = bench();
  stale.nodes.ingest(panelState("alarm-1"));
  stale.advance(10 * 60_000);
  stale.sync.sync("home", "ana");
  assert.equal(stale.isOpen(), true);
  assert.equal(stale.raised[0].nodes[0].reason, "node_unavailable");

  const none = bench();
  none.sync.sync("home", "ana");
  assert.deepEqual([none.sync.view()?.status, none.isOpen()], ["none", false]);

  const confirmed = bench();
  confirmed.nodes.ingest(panelState("alarm-1"));
  confirmed.sync.sync("away", "ana");
  confirmed.answer(0, true);
  assert.equal(confirmed.isOpen(), false);
});

test("matrix: with two panels one alarm is raised for the report, only when every answer is in and one failed", () => {
  const b = bench();
  b.nodes.ingest(panelState("alarm-1"));
  b.nodes.ingest(panelState("alarm-2"));
  b.sync.sync("home", "ana");
  b.answer(0, false, "zones_open");
  assert.equal(b.isOpen(), false, "the other panel has not answered yet");
  b.answer(1, true);
  assert.equal(b.isOpen(), true);
  assert.equal(b.raised.length, 1);
  assert.deepEqual(b.raised[0].nodes.map(node => node.status), ["refused", "confirmed"]);
});

test("a disarm, the setting turned off and a different mode all end the alarm; a disarm never sends anything to a panel", () => {
  const disarm = bench();
  disarm.nodes.ingest(panelState("alarm-1"));
  disarm.sync.sync("away", "ana");
  disarm.answer(0, false, "zones_open");
  assert.equal(disarm.isOpen(), true);
  const sentBefore = disarm.sent.length;
  disarm.sync.clear();
  assert.equal(disarm.isOpen(), false);
  assert.equal(disarm.sent.length, sentBefore);

  const off = bench();
  off.nodes.ingest(panelState("alarm-1"));
  off.sync.sync("away", "ana");
  off.answer(0, false, "locked_out");
  assert.equal(off.isOpen(), true);
  off.setEnabled(false);
  off.sync.reconcile();
  assert.equal(off.isOpen(), false);
  assert.equal(off.sync.view(), undefined);

  const other = bench();
  other.nodes.ingest(panelState("alarm-1"));
  other.sync.sync("home", "ana");
  other.answer(0, false, "zones_open");
  other.sync.sync("night", "ana");
  assert.equal(other.isOpen(), false, "the report of the old mode is gone");
});

test("with the setting off nothing is asked and nothing is raised", () => {
  const b = bench({ enabled: false });
  b.nodes.ingest(panelState("alarm-1"));
  b.sync.sync("home", "ana");
  assert.deepEqual([b.sent.length, b.raised.length, b.isOpen()], [0, 0, false]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 2. The property: whatever happens, the alarm is open exactly while the report says failed
// ---------------------------------------------------------------------------------------------------------------------------------------------------
test("property: over random sequences of choices, answers, silences, disarms and switches, the alarm is open if and only if the report is failed", () => {
  let seed = 20260101;
  const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let round = 0; round < 250; round += 1) {
    const b = bench();
    const panels = 1 + Math.floor(random() * 3);
    for (let index = 0; index < panels; index += 1) b.nodes.ingest(panelState(`alarm-${index + 1}`));
    for (let step = 0; step < 14; step += 1) {
      const pick = random();
      if (pick < 0.3) b.sync.sync(ARMED_MODES[Math.floor(random() * 3)], "ana", random() < 0.5);
      else if (pick < 0.7 && b.sent.length > 0) b.answer(Math.floor(random() * b.sent.length), random() < 0.5, random() < 0.5 ? "zones_open" : "not_disarmed");
      else if (pick < 0.8) b.advance(6_000);
      else if (pick < 0.9) b.sync.clear();
      else { b.setEnabled(random() < 0.7); b.sync.reconcile(); }
      assert.equal(b.isOpen(), b.sync.view()?.status === "failed", `round ${round} step ${step}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 3. The server: the alarm in the centre, and the arming by the control API and by voice
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const VOICE_TOKEN = "v".repeat(32);
async function fakeGateway() {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const send = (status: number, payload: unknown) => { response.writeHead(status, json); response.end(JSON.stringify(payload)); };
      if (request.headers["x-armor-voice-token"] !== VOICE_TOKEN) return send(401, { error: "unauthorized" });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text: string; confirmation?: string };
      if (body.confirmation === undefined) return send(200, { accepted: false, requires_confirmation: true, intent: "arm", outcome: "confirmation-needed", confirmation_token: "tok-arm", speech: "Please confirm" });
      return send(200, { accepted: true, requires_confirmation: false, intent: "arm", outcome: "accepted", speech: "Command accepted" });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function prepared(options: { modes?: boolean; sync?: boolean; extra?: Record<string, string> } = {}): Promise<{ running: Running; cookie: string; published: Array<{ topic: string; payload: string }>; gateway: Awaited<ReturnType<typeof fakeGateway>> }> {
  const gateway = await fakeGateway();
  const running = await startServer({ ARMOR_ALARM_COMMANDS: "1", ARMOR_ALERT_DWELL_MS: "0", ARMOR_VOICE_URL: gateway.url, ARMOR_VOICE_TOKEN: VOICE_TOKEN, ...options.extra });
  const cookie = await studioCookie(running.base);
  const published: Array<{ topic: string; payload: string }> = [];
  running.app.context.alarmLink.publish = (topic, payload) => { if (topic.endsWith("/command")) published.push({ topic, payload }); };
  running.app.context.alarmNodes.ingest(panelState("alarm-1"));
  running.app.context.devices.create({ id: "front-door", name: "Front door", kind: "door", location: "Hall" });
  const settings = await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.arming_modes": options.modes ?? true, "alarm.mode_panel_sync": options.sync ?? true });
  assert.equal(settings.status, 200);
  const put = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { modes: { away: {}, home: { defends: ["zone:Hall"] }, night: { defends: ["zone:Hall"] } } });
  assert.equal(put.status, 200);
  return { running, cookie, published, gateway };
}
const answerNode = (running: Running, published: Array<{ payload: string }>, index: number, accepted: boolean, refusal: AlarmRefusal = "none"): void => {
  const command = parseAlarmCommand(JSON.parse(published[index].payload));
  running.app.context.alarmCommands.handleResult({ kind: "alarm_result", node_id: command.node_id, timestamp_ms: 9, command_id: command.command_id, action: "arm", accepted, refusal, phase: "exit_delay" }, command.node_id);
};
const centre = (running: Running) => running.app.context.alarms.active().filter(alarm => alarm.code === "mode_panel_sync_failed");
const sayArm = async (running: Running, cookie: string): Promise<Answer> => {
  const first = await call(running, cookie, "POST", "/api/v1/voice/command", { text: "arm", language: "en" });
  assert.equal(first.body.outcome, "confirmation-needed");
  return call(running, cookie, "POST", "/api/v1/voice/command", { text: "arm", language: "en", confirmation: first.body.confirmation_token });
};

test("characterization: with the sync off, a panel that refuses raises nothing in the alarm centre and the state is as before", async () => {
  const { running, cookie, published, gateway } = await prepared({ sync: false });
  try {
    running.app.context.alarmNodes.ingest(panelState("alarm-1", { commands_enabled: false, timestamp_ms: 2000 }));
    const chosen = await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" });
    assert.equal(chosen.status, 200);
    assert.equal("panel_sync" in chosen.body, false);
    assert.deepEqual([published.length, centre(running).length], [0, 0]);
  } finally { await running.stop(); await gateway.close(); }
});

test("characterization: with the arming modes off, arming by the control API and by voice is the armed of always and no panel is asked", async () => {
  const { running, cookie, published, gateway } = await prepared({ modes: false, sync: false });
  try {
    assert.equal((await control(running, "arm")).status, 200);
    assert.deepEqual([running.app.context.store.snapshot().mode, "arming_mode" in running.app.context.store.snapshot(), published.length], ["armed", false, 0]);
    assert.equal((await control(running, "disarm")).status, 200);
    const spoken = await sayArm(running, cookie);
    assert.deepEqual([spoken.body.executed, spoken.body.result], [true, { mode: "armed" }]);
    assert.deepEqual([running.app.context.store.snapshot().mode, published.length], ["armed", 0]);
  } finally { await running.stop(); await gateway.close(); }
});

test("route: a refusing panel raises one alarm in the centre, high, with the facts a person needs, and a confirmed retry ends it", async () => {
  const { running, cookie, published, gateway } = await prepared();
  try {
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "night" })).status, 200);
    assert.equal(centre(running).length, 0, "asked, no answer yet");
    answerNode(running, published, 0, false, "zones_open");
    const [alarm] = centre(running);
    assert.ok(alarm);
    assert.deepEqual([alarm.key, alarm.severity, alarm.source, alarm.silent], [KEY, "high", { type: "alarm", id: "mode_panel" }, undefined]);
    assert.deepEqual([alarm.detail?.arming_mode, alarm.detail?.panel_profile, alarm.detail?.panels], ["night", "night", 1]);
    assert.ok(String(alarm.detail?.panel_answers).includes("alarm-1") && String(alarm.detail?.panel_answers).includes("zones_open"));
    assert.equal(alarmCodeWords("mode_panel_sync_failed", "en") === "mode_panel_sync_failed", false, "the code has its words");
    // the list a client reads carries it
    const listed = (await call(running, cookie, "GET", "/api/v1/alarms")).body;
    assert.ok(JSON.stringify(listed).includes("mode_panel_sync_failed"));
    // the same mode again: a new try, the old alarm ends, the confirmed answer leaves none
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "night" })).status, 200);
    assert.equal(centre(running).length, 1, "an alarm that ended stays on the list until somebody acknowledges it");
    assert.ok(centre(running)[0].cleared_at);
    answerNode(running, published, 1, true);
    assert.equal(centre(running).filter(item => !item.cleared_at).length, 0);
  } finally { await running.stop(); await gateway.close(); }
});

test("route: a disarm and turning the sync off end the alarm; the panel is not disarmed", async () => {
  const { running, cookie, published, gateway } = await prepared();
  try {
    await call(running, cookie, "POST", "/api/v1/mode", { mode: "away" });
    answerNode(running, published, 0, false, "locked_out");
    assert.equal(centre(running).filter(item => !item.cleared_at).length, 1);
    const sentBefore = published.length;
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "disarmed" })).status, 200);
    assert.equal(centre(running).filter(item => !item.cleared_at).length, 0);
    assert.equal(published.length, sentBefore, "no disarm goes to the panel");

    await call(running, cookie, "POST", "/api/v1/mode", { mode: "away" });
    answerNode(running, published, 1, false, "locked_out");
    assert.equal(centre(running).filter(item => !item.cleared_at).length, 1);
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "alarm.mode_panel_sync": false })).status, 200);
    assert.equal(centre(running).filter(item => !item.cleared_at).length, 0);
  } finally { await running.stop(); await gateway.close(); }
});

test("route: an alarm left open by a server that stopped is ended when the next one starts, because the report starts empty", async () => {
  const dataDir = fs.mkdtempSync(path.join(fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? ".", "armor-pre-")), "d"));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "alarms.json"), JSON.stringify({ schema: 1, counter: 2, alarms: [{ id: "alm-00001", key: KEY, source: { type: "alarm", id: "mode_panel" }, severity: "high", code: "mode_panel_sync_failed", raised_at: "2026-01-01T00:00:00.000Z" }] }));
  const running = await startServer({ ARMOR_DATA_DIR: dataDir });
  try {
    const [alarm] = centre(running);
    assert.ok(alarm?.cleared_at, "ended");
  } finally { await running.stop(); }
});

test("route: arming by the control API is arming away: the panel is asked for the profile away, the answer carries the report, and a failure is an alarm but never an error", async () => {
  const { running, gateway, published } = await prepared();
  try {
    const armed = await control(running, "arm");
    assert.equal(armed.status, 200);
    const body = await armed.json() as { mode: string; arming_mode?: string; panel_sync?: { status: string; mode: string; profile: string; by: string } };
    assert.deepEqual([body.mode, body.arming_mode, body.panel_sync?.status, body.panel_sync?.mode, body.panel_sync?.profile, body.panel_sync?.by], ["armed", "away", "pending", "away", "away", "control"]);
    assert.equal(published.length, 1);
    assert.deepEqual([parseAlarmCommand(JSON.parse(published[0].payload)).mode, parseAlarmCommand(JSON.parse(published[0].payload)).profile?.id], ["away", "away"]);
    answerNode(running, published, 0, false, "zones_open");
    assert.equal(centre(running).length, 1);
    assert.equal(running.app.context.store.snapshot().mode, "armed", "the server defends all the same");
  } finally { await running.stop(); await gateway.close(); }
});

test("route: arming by voice is arming away with the same sync, from the home mode it raises the defence, and the same mode again retries a failure", async () => {
  const { running, cookie, gateway, published } = await prepared();
  try {
    assert.equal((await call(running, cookie, "POST", "/api/v1/mode", { mode: "home" })).status, 200);
    answerNode(running, published, 0, true);
    const spoken = await sayArm(running, cookie);
    assert.deepEqual([spoken.status, spoken.body.executed, spoken.body.result], [200, true, { mode: "armed" }]);
    const state = running.app.context.store.snapshot();
    assert.deepEqual([state.mode, state.arming_mode, (state.panel_sync as { mode: string; by: string }).mode], ["armed", "away", "away"]);
    assert.equal(published.length, 2);
    assert.equal(parseAlarmCommand(JSON.parse(published[1].payload)).profile?.id, "away");
    answerNode(running, published, 1, false, "locked_out");
    assert.equal(centre(running).filter(item => !item.cleared_at).length, 1);
    await sayArm(running, cookie);
    assert.equal(published.length, 3, "away again after a failure asks again");
    assert.equal(centre(running).filter(item => !item.cleared_at).length, 0);
  } finally { await running.stop(); await gateway.close(); }
});

test("route: access is unchanged: the control route without its token asks no panel, and a viewer cannot arm by voice", async () => {
  const { running, gateway, published } = await prepared();
  try {
    assert.equal((await control(running, "arm", null)).status, 401);
    assert.equal((await control(running, "arm", SECRETS.ARMOR_OPERATOR_TOKEN)).status, 401);
    assert.equal((await control(running, "nonsense")).status, 404);
    const anonymous = await fetch(`${running.base}/api/v1/voice/command`, { method: "POST", headers: json, body: JSON.stringify({ text: "arm" }) });
    assert.ok([401, 403].includes(anonymous.status));
    assert.equal(published.length, 0);
    assert.equal(running.app.context.store.snapshot().mode, "disarmed");
  } finally { await running.stop(); await gateway.close(); }
});

test("route: the exit delay of away applies to arming by the control API while the modes are on", async () => {
  const { running, cookie, gateway } = await prepared();
  try {
    const modes = (await call(running, cookie, "GET", "/api/v1/alarm/modes")).body;
    const put = await call(running, cookie, "PUT", "/api/v1/alarm/modes", { revision: modes.revision, modes: { away: { exit_delay_s: 30 }, home: { defends: ["zone:Hall"] }, night: { defends: ["zone:Hall"] } } });
    assert.equal(put.status, 200);
    assert.equal((await control(running, "arm")).status, 200);
    assert.ok(running.app.context.armingModes.exitUntil() !== undefined, "inside the exit delay");
    assert.equal((await control(running, "disarm")).status, 200);
    assert.equal(running.app.context.armingModes.exitUntil(), undefined);
  } finally { await running.stop(); await gateway.close(); }
});

test("route: disarming by the control API clears the report and sends nothing to the panel", async () => {
  const { running, gateway, published } = await prepared({ extra: { ARMOR_CONTROL_DISARM: "1" } });
  try {
    await control(running, "arm");
    answerNode(running, published, 0, true);
    const sent = published.length;
    const disarmed = await control(running, "disarm");
    assert.equal(disarmed.status, 200);
    const body = await disarmed.json() as Record<string, unknown>;
    assert.deepEqual([body.mode, "panel_sync" in body], ["disarmed", false]);
    assert.equal(published.length, sent);
  } finally { await running.stop(); await gateway.close(); }
});
