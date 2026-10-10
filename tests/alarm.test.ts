// The alarm nodes: the parsers against the shared vectors, the store, the way a command reaches a panel (off by default, every refusal audited), the alarms their
// states raise, and the routes. No alarm node exists on a board yet: the node's states and answers here are made by the tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuditEvent, AuditLog } from "../src/audit.js";
import { AlarmStore, alarmTopic, parseAlarmCommand, parseAlarmMessage, parseAlarmResult, type AlarmMessage, type AlarmResult } from "../src/alarm.js";
import { AlarmCommandError, AlarmCommands } from "../src/alarm_commands.js";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

const directory = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance");
type Vector = { name: string; valid: boolean; payload: unknown };
const vectors = (kind: string): Vector[] => (JSON.parse(fs.readFileSync(path.join(directory, `${kind}.json`), "utf8")) as { vectors: Vector[] }).vectors;
const skip = fs.existsSync(path.join(directory, "alarm_command.json")) ? false : "ARMOR-COMMON is not checked out next to this repository";

for (const [kind, parse] of [["alarm", parseAlarmMessage], ["alarm_command", parseAlarmCommand], ["alarm_result", parseAlarmResult]] as const) {
  test(`${kind} parsing agrees with every shared conformance vector`, { skip }, () => {
    const all = vectors(kind);
    assert.ok(all.length >= 20);
    for (const vector of all) {
      if (vector.valid) assert.doesNotThrow(() => parse(vector.payload), `should accept: ${vector.name}`);
      else assert.throws(() => parse(vector.payload), `should reject: ${vector.name}`);
    }
  });
}

test("the topics of a state, a command and an answer name a node and nothing else", () => {
  for (const leaf of ["state", "command", "result"] as const) assert.equal(alarmTopic(`armor/alarm/alarm-1/${leaf}`, leaf), "alarm-1");
  assert.equal(alarmTopic("armor/alarm/alarm-1/command", "state"), undefined);
  assert.equal(alarmTopic("armor/alarm/alarm-1/state", "result"), undefined);
  for (const topic of ["armor/alarm/Node/state", "armor/alarm/-x/state", "armor/alarm/a/b/state", "armor/alarm/state", "armor/electrical/alarm-1/state"]) assert.equal(alarmTopic(topic), undefined);
});

const state = (extra: Partial<AlarmMessage> = {}): AlarmMessage => ({
  kind: "alarm", node_id: "alarm-1", timestamp_ms: 1000, phase: "armed", mode: "away", siren: false, locked_out: false, commands_enabled: true,
  zones: [{ id: "front-door", name: "Front door", kind: "entry", state: "normal", bypassed: false }, { id: "window", kind: "instant", state: "normal", bypassed: false }],
  open_zones: [], events: [{ ago_s: 12, kind: "armed" }], ...extra,
});

test("a state must be the contract's: unknown fields and joined rules are refused", () => {
  assert.doesNotThrow(() => parseAlarmMessage(state()));
  assert.throws(() => parseAlarmMessage({ ...state(), pin: "1234" }), /unknown field/);
  assert.throws(() => parseAlarmMessage(state({ phase: "disarmed" })), /exactly when the phase is/);
  assert.throws(() => parseAlarmMessage(state({ siren: true })), /only in the alarm phase/);
  assert.throws(() => parseAlarmMessage(state({ open_zones: ["garage"] })), /zone of the message/);
  assert.throws(() => parseAlarmMessage(state({ zones: [state().zones[0], state().zones[0]] })), /once/);
});

// ---- the store ---------------------------------------------------------------------------------------------------------------------------

test("the store keeps the latest state of each node, marks the quiet ones and counts what is guarding", () => {
  let clock = 1_000_000;
  const stale: string[] = [];
  const store = new AlarmStore({ now: () => clock, staleAfterMs: 30_000, maxNodes: 2, onStale: (node, isStale) => stale.push(`${node}:${isStale}`) });
  store.ingest(state());
  store.ingest(state({ node_id: "alarm-2", phase: "alarm", siren: true }));
  assert.deepEqual(store.totals(), { nodes: 2, stale: 0, armed: 1, sounding: 1 });
  assert.throws(() => store.ingest(state({ node_id: "alarm-3" })), /too many/);
  store.ingest(state({ phase: "disarmed", mode: "disarmed" }));                      // an update replaces the state
  assert.equal(store.list().find(item => item.node_id === "alarm-1")?.state.phase, "disarmed");
  clock += 31_000;
  assert.deepEqual(store.totals(), { nodes: 2, stale: 2, armed: 0, sounding: 0 });
  assert.deepEqual(stale, ["alarm-1:true", "alarm-2:true"]);
  store.ingest(state());
  assert.deepEqual(stale.slice(2), ["alarm-1:false"]);
  assert.equal(store.remove("alarm-2"), true);
});

// ---- the commands ------------------------------------------------------------------------------------------------------------------------

function bench(options: { enabled?: boolean; publishFails?: boolean } = {}) {
  let clock = 1_000_000;
  const sent: Array<{ topic: string; payload: string }> = [];
  const audit: AuditEvent[] = [];
  const log: AuditLog = { record: event => { audit.push(event); } };
  const nodes = new AlarmStore({ now: () => clock });
  let counter = 0;
  const service = new AlarmCommands({
    enabled: options.enabled ?? true, nodes, audit: log, now: () => clock, random: () => `c${String(++counter).padStart(15, "0")}`.replace(/[^0-9a-f]/g, "0"),
    publish: (topic, payload) => { if (options.publishFails) throw new Error("down"); sent.push({ topic, payload }); },
  });
  const answer = (over: Partial<AlarmResult> & Pick<AlarmResult, "command_id" | "action">): AlarmResult => ({ kind: "alarm_result", node_id: "alarm-1", timestamp_ms: 9, accepted: true, refusal: "none", phase: "exit_delay", ...over });
  return { service, nodes, sent, audit, tick: (ms: number) => { clock += ms; }, answer, last: () => JSON.parse(sent[sent.length - 1].payload) as Record<string, unknown> };
}
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (error) { return error instanceof AlarmCommandError ? error.code : `other:${String(error)}`; } return undefined; };

test("commands off, nothing is sent, not even a disarm, and the refusal is audited", () => {
  const b = bench({ enabled: false });
  b.nodes.ingest(state());
  assert.equal(code(() => b.service.request("alarm-1", "arm", "away", false, "admin")), "commands_disabled");
  assert.equal(code(() => b.service.request("alarm-1", "disarm", undefined, false, "admin")), "commands_disabled");
  assert.equal(b.sent.length, 0);
  assert.equal(b.audit.filter(event => event.outcome === "denied").length, 2);
  assert.equal(b.service.status().enabled, false);
});

test("a command needs a node that is there, awake and that takes commands, and one at a time", () => {
  const b = bench();
  assert.equal(code(() => b.service.request("alarm-1", "arm", "away", false, "admin")), "unknown_node");
  b.nodes.ingest(state({ commands_enabled: false }));
  assert.equal(code(() => b.service.request("alarm-1", "arm", "away", false, "admin")), "node_commands_off");
  b.nodes.ingest(state());
  assert.equal(code(() => b.service.request("alarm-1", "arm", undefined, false, "admin")), "invalid_mode");
  assert.equal(code(() => b.service.request("alarm-1", "disarm", "away", false, "admin")), "invalid_request");
  assert.equal(code(() => b.service.request("alarm-1", "disarm", undefined, true, "admin")), "invalid_request");
  assert.equal(b.sent.length, 0);
  const first = b.service.request("alarm-1", "arm", "stay", true, "admin");
  assert.equal(code(() => b.service.request("alarm-1", "disarm", undefined, false, "admin")), "busy");
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].topic, "armor/alarm/alarm-1/command");
  const sentCommand = parseAlarmCommand(JSON.parse(b.sent[0].payload));            // what it sends is the contract's command
  assert.deepEqual([sentCommand.action, sentCommand.mode, sentCommand.force, sentCommand.command_id], ["arm", "stay", true, first.command_id]);
  assert.ok(!b.sent[0].payload.includes("pin"));
  b.tick(40_000);
  assert.equal(code(() => b.service.request("alarm-1", "disarm", undefined, false, "admin")), "node_unavailable");   // a quiet node is not sent anything
});

test("an answer settles the command it answers, and an answer to nothing is dropped and audited", () => {
  const b = bench();
  b.nodes.ingest(state());
  const { command_id: id } = b.service.request("alarm-1", "arm", "away", false, "admin");
  b.service.handleResult(b.answer({ command_id: "0".repeat(16), action: "arm" }), "alarm-1");                 // not waiting
  b.service.handleResult(b.answer({ command_id: id, action: "disarm" }), "alarm-1");                          // another action
  b.service.handleResult(b.answer({ command_id: id, action: "arm", node_id: "alarm-2" }), "alarm-1");         // another node
  assert.equal(b.service.status().pending.length, 1);
  b.service.handleResult(b.answer({ command_id: id, action: "arm", accepted: false, refusal: "zones_open", phase: "disarmed" }), "alarm-1");
  const status = b.service.status();
  assert.equal(status.pending.length, 0);
  assert.deepEqual([status.recent[0].accepted, status.recent[0].refusal, status.recent[0].actor, status.recent[0].mode], [false, "zones_open", "admin", "away"]);
  assert.equal(b.audit.filter(event => event.action === "alarm.command.result" && event.outcome === "denied").length, 4);
  // an answer that never comes is a timeout
  const { command_id: lost } = b.service.request("alarm-1", "disarm", undefined, false, "admin");
  b.tick(6_000);
  b.nodes.ingest(state());
  assert.equal(b.service.status().pending.length, 0);
  assert.deepEqual([b.service.status().recent[0].command_id, b.service.status().recent[0].refusal], [lost, "timeout"]);
});

test("with the broker away the command is not pending and the failure is audited", () => {
  const down = bench({ publishFails: true });
  down.nodes.ingest(state());
  assert.equal(code(() => down.service.request("alarm-1", "disarm", undefined, false, "admin")), "mqtt_unavailable");
  assert.equal(down.service.status().pending.length, 0);
  assert.equal(down.audit.at(-1)?.outcome, "failed");
});

// ---- the alarms a panel raises -------------------------------------------------------------------------------------------------------------

test("a sounding alarm is critical and ends with the disarm; a tamper is high; a lockout and a silent node are warnings", async () => {
  const { AlarmCentre, AlarmRules } = await import("../src/alarms.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-alarm-nodes-"));
  const centre = new AlarmCentre({ file: path.join(dir, "alarms.json") });
  const rules = new AlarmRules(centre, () => "disarmed");
  const active = () => centre.active().filter(alarm => !alarm.cleared_at).map(alarm => `${alarm.code}:${alarm.severity}:${alarm.source.id}`).sort();
  rules.handleAlarmNode(state(), undefined);
  assert.deepEqual(active(), []);
  const alarm = state({ phase: "alarm", siren: true, events: [{ ago_s: 1, kind: "alarm", zone: "window" }] });
  rules.handleAlarmNode(alarm, undefined);
  assert.deepEqual(active(), ["alarm_sounding:critical:alarm-1"]);
  rules.handleAlarmNode({ ...alarm, zones: [alarm.zones[0], { ...alarm.zones[1], state: "tamper" }], locked_out: true }, alarm);
  assert.deepEqual(active(), ["alarm_locked_out:warning:alarm-1", "alarm_sounding:critical:alarm-1", "alarm_tamper:high:alarm-1/window"]);
  rules.handleAlarmNode(state({ phase: "disarmed", mode: "disarmed", events: [] }), alarm);
  assert.deepEqual(active(), []);
  rules.handleAlarmNodeStale("alarm-1", true);
  assert.deepEqual(active(), ["alarm_offline:warning:alarm-1"]);
  rules.handleAlarmNodeStale("alarm-1", false);
  assert.deepEqual(active(), []);
});

// ---- the routes ---------------------------------------------------------------------------------------------------------------------------

test("by default the server sends nothing to any panel: the route refuses, and the status says it is off", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const post = (body: unknown, headers: Record<string, string> = { cookie }) => fetch(`${running.base}/api/v1/alarm/command`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ node: "alarm-1", action: "disarm" }, {})).status, 401);
    const off = await post({ node: "alarm-1", action: "disarm" });
    assert.deepEqual([off.status, ((await off.json()) as { code: string }).code], [403, "commands_disabled"]);
    for (const bad of [{ node: "Bad Node", action: "disarm" }, { node: "alarm-1", action: "silence" }, { node: "alarm-1", action: "arm", mode: "night" }, { node: "alarm-1", action: "disarm", pin: "1234" },
                       { node: "alarm-1", action: "arm", mode: "away", force: "yes" }, "no"]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    const status = await fetch(`${running.base}/api/v1/alarm/commands`, { headers: { cookie } });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { enabled: false, pending: [], recent: [] });
    assert.equal((await fetch(`${running.base}/api/v1/alarm/commands`)).status, 401);
    const operator = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };
    assert.equal((await fetch(`${running.base}/api/v1/alarm/nodes`, { headers: operator })).status, 200);
    assert.equal((await post({ node: "alarm-1", action: "disarm" }, operator)).status, 401);   // the operator token looks, it does not command
  } finally { await running.stop(); }
});

test("turned on, the route still refuses what the node does not allow, and with no broker it sends nothing", async () => {
  const running = await startServer({ ARMOR_ALARM_COMMANDS: "1" });
  try {
    assert.ok(running.config.warnings.some(warning => warning.includes("ARMOR_ALARM_COMMANDS")));
    const cookie = await studioCookie(running.base);
    const post = (body: unknown) => fetch(`${running.base}/api/v1/alarm/command`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
    const ingest = (message: unknown) => fetch(`${running.base}/api/v1/alarm/state`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify(message) });
    const codeOf = async (response: Response) => ((await response.json()) as { code: string }).code;
    const body = { node: "alarm-1", action: "arm", mode: "away" };
    assert.equal(await codeOf(await post(body)), "unknown_node");
    assert.equal((await ingest(state({ commands_enabled: false }))).status, 202);
    assert.equal(await codeOf(await post(body)), "node_commands_off");
    assert.equal((await ingest(state())).status, 202);
    const noBroker = await post(body);
    assert.deepEqual([noBroker.status, await codeOf(noBroker)], [503, "mqtt_unavailable"]);
    const newer = await ingest({ ...state(), siren_volume: 3 });                                   // a node newer than the server: the field is dropped and said, never kept
    assert.deepEqual([newer.status, ((await newer.json()) as { ignored: string[] }).ignored], [202, ["alarm message.siren_volume"]]);
    assert.equal((await ingest({ ...state(), open_zones: ["garage"] })).status, 400);
    assert.equal((await ingest(state())).status, 202);
    const listed = (await (await fetch(`${running.base}/api/v1/alarm/nodes`, { headers: { cookie } })).json()) as { nodes: Array<{ node_id: string; stale: boolean }>; totals: { armed: number } };
    assert.deepEqual([listed.nodes.map(node => node.node_id), listed.totals.armed], [["alarm-1"], 1]);
  } finally { await running.stop(); }
});
