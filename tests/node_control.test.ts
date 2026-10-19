// Controlling the nodes from Studio and the phone: the shared vectors, the words of the contract, the rolling schedule, every operation of the service from the arm to the node's answer with a
// fake broker, the refusals, the one-time token (never in an answer, a log, the history or the file), the restart that comes back or does not, maintenance, persistence and the routes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AuditEvent, AuditLog } from "../src/audit.js";
import type { SystemInput } from "../src/connections.js";
import { routeMessage } from "../src/mqtt_router.js";
import {
  CONTROL_OPERATIONS, CONTROL_REFUSALS, ControlError, DURATIONS, SAME_FAMILY_WINDOW_S, ROLLING_GAP_S, controlTopic, redactToken, parseControlCommand, parseControlResult, readControlRequest, rollingSchedule,
  type ControlOperation, type ControlResult,
} from "../src/node_control.js";
import { NodeControlService, type ControlOperationRecord } from "../src/node_control_service.js";
import { NodeHealthStore, type NodeHealthMessage } from "../src/node_health.js";
import { SECRETS, startServer, studioCookie, tempDir } from "./helpers.js";

const directory = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance");
type Vector = { name: string; valid: boolean; payload: unknown };
const vectors = (kind: string): Vector[] => (JSON.parse(fs.readFileSync(path.join(directory, `${kind}.json`), "utf8")) as { vectors: Vector[] }).vectors;
const skip = fs.existsSync(path.join(directory, "node_control_command.json")) ? false : "ARMOR-COMMON is not checked out next to this repository";

for (const [kind, parse] of [["node_control_command", parseControlCommand], ["node_control_result", parseControlResult]] as const) {
  test(`${kind} parsing agrees with every shared conformance vector`, { skip }, () => {
    const all = vectors(kind);
    assert.ok(all.length >= 60);
    for (const vector of all) {
      if (vector.valid) assert.doesNotThrow(() => parse(vector.payload), `should accept: ${vector.name}`);
      else assert.throws(() => parse(vector.payload), `should reject: ${vector.name}`);
    }
  });
}

test("the topics of an order and of an answer name a node and nothing else, and `all` never answers", () => {
  assert.equal(controlTopic("armor/control/radar-1/result", "result"), "radar-1");
  assert.equal(controlTopic("armor/control/radar-1/command", "command"), "radar-1");
  assert.equal(controlTopic("armor/control/all/command", "command"), "all");
  assert.equal(controlTopic("armor/control/all/result", "result"), undefined);
  for (const topic of ["armor/control/Radar/result", "armor/control/radar-1/state", "armor/control/result", "armor/control/a/b/result", "armor/restart/radar-1/result", "armor/electrical/radar-1/result"]) assert.equal(controlTopic(topic, "result"), undefined, topic);
});

test("the list of operations is closed: nothing erases a node, sleeps it or sets a wake timer", () => {
  assert.deepEqual([...CONTROL_OPERATIONS], ["restart", "pause", "resume", "standby", "identify", "diagnostics", "maintenance_on", "maintenance_off"]);
  for (const word of ["factory_reset", "reset", "erase", "wipe", "wipe_wifi", "erase_flash", "deep_sleep", "sleep", "radio_sleep", "wake", "wake_timer", "reboot"]) {
    assert.throws(() => readControlRequest({ operation: word, confirm: "x" }, "node", ["x"]), /operation must be one of/, word);
    assert.throws(() => parseControlCommand({ kind: "node_control_command", node_id: "radar-1", timestamp_ms: 1, command_id: "abcdefgh1234", action: "arm", operation: word, mode: "now", requested_by: "ana" }), /invalid operation/, word);
  }
  for (const field of ["wake_s", "sleep_s", "wake_timer_s", "factory"]) assert.throws(() => readControlRequest({ operation: "pause", confirm: "x", [field]: 5 }, "node", ["x"]), /not a field/, field);
  assert.ok(!(CONTROL_REFUSALS as readonly string[]).includes("sleeping"));
});

test("the sample kept of a refused answer has no token in it", () => {
  const raw = Buffer.from(JSON.stringify({ kind: "node_control_result", token: SECRET_TOKEN, stage: "bogus" }));
  assert.ok(!redactToken("armor/control/radar-1/result", raw).toString().includes(SECRET_TOKEN));
  assert.ok(!redactToken("armor/solar/solar-1/maintenance/result", Buffer.from(`{"token": "${SECRET_TOKEN}"}`)).toString().includes(SECRET_TOKEN));
  assert.equal(redactToken("armor/health/radar-1", raw), raw, "other topics are left as they are");
});

// ---- the request ------------------------------------------------------------------------------------------------------------------------------

test("a request names an operation, the typed confirmation where the house is left less guarded, and a duration only where it means something", () => {
  const code = (body: unknown, scope: "node" | "all" = "node"): string | undefined => { try { readControlRequest(body, scope, ["radar-1"]); } catch (error) { return error instanceof ControlError ? error.code : "other"; } return undefined; };
  assert.equal(code({ operation: "restart", confirm: "radar-1" }), undefined);
  assert.equal(code({ operation: "restart", confirm: "radar-2" }), "invalid_request");
  assert.equal(code({ operation: "restart" }), "invalid_request");
  assert.equal(code({ operation: "pause", confirm: "radar-1", duration_s: 600 }), undefined);
  assert.equal(code({ operation: "pause", confirm: "radar-1", duration_s: 59 }), "invalid_request");
  assert.equal(code({ operation: "pause", confirm: "radar-1", duration_s: 3601 }), "invalid_request");
  assert.equal(code({ operation: "pause", confirm: "radar-1", duration_s: 60.5 }), "invalid_request");
  assert.equal(code({ operation: "pause", confirm: "radar-1", duration_s: "60" }), "invalid_request");
  assert.equal(code({ operation: "standby", confirm: "radar-1" }), undefined);
  assert.equal(code({ operation: "standby", confirm: "radar-1", duration_s: 600 }), "invalid_request");   // standby has no end
  assert.equal(code({ operation: "resume" }), undefined);
  assert.equal(code({ operation: "resume", duration_s: 60 }), "invalid_request");
  assert.equal(code({ operation: "identify" }), undefined);
  assert.equal(code({ operation: "identify", duration_s: 4 }), "invalid_request");
  assert.equal(code({ operation: "identify", duration_s: 300 }), undefined);
  assert.equal(code({ operation: "diagnostics" }), undefined);
  assert.equal(code({ operation: "maintenance_on", duration_s: 28_800 }), undefined);
  assert.equal(code({ operation: "maintenance_on", duration_s: 28_801 }), "invalid_request");
  assert.equal(code({ operation: "maintenance_off", duration_s: 60 }), "invalid_request");
  assert.equal(code({ operation: "restart", confirm: "radar-1", mode: "rolling" }), "invalid_request");   // a node is not ordered in a mode
  assert.equal(code([]), "invalid_request");
  assert.equal(code("restart"), "invalid_request");
  assert.equal(code({ operation: "restart", mode: "now", confirm: "RESTART" }, "all"), undefined);
  assert.equal(code({ operation: "restart", mode: "rolling", confirm: "RESTART" }, "all"), undefined);
  assert.equal(code({ operation: "restart", mode: "rolling", confirm: "restart" }, "all"), "invalid_request");
  assert.equal(code({ operation: "restart", mode: "rolling", confirm: "radar-1" }, "all"), "invalid_request");
  assert.equal(code({ operation: "restart", confirm: "RESTART" }, "all"), "invalid_request");            // the mode is asked for
  assert.equal(code({ operation: "pause", mode: "rolling", confirm: "PAUSE" }, "all"), "invalid_request");
  assert.equal(code({ operation: "standby", mode: "now", confirm: "STANDBY" }, "all"), undefined);
  assert.equal(code({ operation: "standby", mode: "now", confirm: "PAUSE" }, "all"), "invalid_request");
  assert.equal(code({ operation: "resume", mode: "now" }, "all"), undefined);
  assert.equal(code({ operation: "diagnostics", mode: "bogus" }, "all"), "invalid_request");
});

// ---- the rolling schedule ---------------------------------------------------------------------------------------------------------------------

test("a rolling restart is sorted by node id inside the family, the alarm panel is last, and no two nodes go in the same window", () => {
  const nodes = [
    { id: "alarm-1", family: "alarm" }, { id: "radar-2", family: "radar" }, { id: "solar-1", family: "solar" }, { id: "radar-1", family: "radar" }, { id: "hmi-1", family: "hmi" },
    { id: "electrical-2", family: "electrical" }, { id: "electrical-1", family: "electrical" }, { id: "alarm-0", family: "alarm" }, { id: "radar-10", family: "radar" },
  ];
  const plan = rollingSchedule(nodes);
  assert.equal(plan.size, nodes.length);
  assert.deepEqual([...plan.values()].sort((a, b) => a - b), nodes.map((_, index) => index), "every node has its own place, from 0");
  const order = [...plan.entries()].sort((a, b) => a[1] - b[1]).map(item => item[0]);
  assert.deepEqual(order, ["radar-1", "radar-10", "radar-2", "solar-1", "electrical-1", "electrical-2", "hmi-1", "alarm-0", "alarm-1"]);
  assert.deepEqual(order.slice(-2), ["alarm-0", "alarm-1"]);
  // the same plan whatever the order the nodes came in
  assert.deepEqual([...rollingSchedule([...nodes].reverse()).entries()].sort(), [...plan.entries()].sort());
  const byFamily = new Map(nodes.map(node => [node.id, node.family]));
  const slots = [...plan.entries()];
  for (const [a, slotA] of slots) for (const [b, slotB] of slots) {
    if (a >= b) continue;
    const apart = Math.abs(slotA - slotB) * ROLLING_GAP_S;
    assert.ok(apart >= ROLLING_GAP_S, `${a} and ${b} are ${apart}s apart`);
    if (byFamily.get(a) === byFamily.get(b)) assert.ok(apart >= SAME_FAMILY_WINDOW_S);
  }
  assert.equal(rollingSchedule([]).size, 0);
  assert.equal(rollingSchedule([{ id: "radar-1", family: "radar" }]).get("radar-1"), 0);
  assert.equal(rollingSchedule(Array.from({ length: 64 }, (_, index) => ({ id: `radar-${String(index).padStart(2, "0")}`, family: "radar" }))).size, 64);
  assert.throws(() => rollingSchedule(Array.from({ length: 65 }, (_, index) => ({ id: `radar-${String(index).padStart(2, "0")}`, family: "radar" }))), (error: unknown) => error instanceof ControlError && error.code === "too_many_nodes");
});

// ---- the service with a fake broker -----------------------------------------------------------------------------------------------------------

const SECRET_TOKEN = "abcdef0123456789abcdef0123456789";
const report = (id: string, family: NodeHealthMessage["family"], extra: Partial<NodeHealthMessage> = {}): NodeHealthMessage => ({
  kind: "node_health", node_id: id, timestamp_ms: 1000, family, firmware: "0.3.6", board: "s3-eth", uptime_s: 3600, reset_reason: "power_on", heap_free: 142_000, heap_min: 98_000, link: "ethernet", link_up: true,
  broker_reconnects: 1, low_stack_tasks: 0, ...extra,
});
type Sent = { topic: string; message: Record<string, unknown> };

function bench(options: { nodes?: Array<[string, NodeHealthMessage["family"]]>; publishFails?: boolean; file?: string; perMinute?: number } = {}) {
  let clock = 1_800_000_000_000;
  let stamp = 1000;
  const audits: AuditEvent[] = [];
  const history: SystemInput[] = [];
  const holds: Array<[string, boolean]> = [];
  const sent: Sent[] = [];
  const state = { fails: options.publishFails === true };
  const health = new NodeHealthStore({ now: () => clock, remembered: node => service.memoryOf(node) });
  const audit: AuditLog = { record: event => { audits.push(event); } };
  const service: NodeControlService = new NodeControlService({
    publish: (topic, payload) => { if (state.fails) throw new Error("down"); sent.push({ topic, message: JSON.parse(payload) as Record<string, unknown> }); }, audit, history: input => { history.push(input); },
    health: node => health.get(node), nodes: () => health.list(), now: () => clock, file: options.file, onHold: (node, held) => { holds.push([node, held]); }, perMinute: options.perMinute,
    random: (() => { let n = 0; return () => `c${String(++n).padStart(15, "0")}`; })(),
  });
  const nodes = options.nodes ?? [["radar-1", "radar"], ["solar-1", "solar"], ["electrical-1", "electrical"], ["alarm-1", "alarm"], ["hmi-1", "hmi"]];
  for (const [id, family] of nodes) health.ingest(report(id, family, { timestamp_ms: stamp++ }));
  const tick = (ms: number): void => { clock += ms; };
  const hear = (id: string, family: NodeHealthMessage["family"], extra: Partial<NodeHealthMessage> = {}): void => { health.ingest(report(id, family, { timestamp_ms: stamp++, ...extra })); service.handleReport(health.get(id)!.report); };
  const answer = (over: Record<string, unknown>): void => { service.handleResult(parseControlResult({ kind: "node_control_result", timestamp_ms: 9, accepted: true, refusal: "none", ...over }), String(over.node_id)); };
  /** The node arms: returns the execute published to it. */
  const armed = (node: string, operation: ControlOperation, token = SECRET_TOKEN): Record<string, unknown> => {
    const arm = [...sent].reverse().find(item => item.topic === `armor/control/${node}/command` && item.message.action === "arm" && item.message.operation === operation)!.message;
    answer({ node_id: node, command_id: arm.command_id, action: "arm", operation, stage: "armed", token, token_ttl_s: 30 });
    return [...sent].reverse().find(item => item.topic === `armor/control/${node}/command` && item.message.action === "execute")!.message;
  };
  const target = (id: string) => ({ id, family: health.get(id)!.family });
  return { service, health, audits, history, holds, sent, state, tick, hear, answer, armed, target, now: () => clock };
}

const one = (b: ReturnType<typeof bench>, node: string, operation: ControlOperation, extra: { duration_s?: number } = {}): ControlOperationRecord =>
  b.service.start({ scope: "node", operation, mode: "now", actor: "ana", origin: "local", targets: [b.target(node)], ...extra });
const code = (run: () => unknown): string | undefined => { try { run(); } catch (error) { return error instanceof ControlError ? `${error.status} ${error.code}` : "other"; } return undefined; };

test("every operation goes arm, token, execute, answer for one node, with the token of the arm and nothing else", () => {
  const cases: Array<{ op: ControlOperation; duration?: number; reply: Record<string, unknown>; execute?: Record<string, unknown> }> = [
    { op: "pause", duration: 600, reply: { stage: "applied", state: "paused", maintenance: false, requested_by: "ana", until_s: 600, since_ms: 5 }, execute: { duration_s: 600 } },
    { op: "pause", reply: { stage: "applied", state: "paused", maintenance: false, requested_by: "ana", until_s: 3600, since_ms: 5 } },
    { op: "resume", reply: { stage: "applied", state: "running", maintenance: false, requested_by: "ana" } },
    { op: "standby", reply: { stage: "applied", state: "standby", maintenance: false, requested_by: "ana", since_ms: 5 } },
    { op: "identify", duration: 20, reply: { stage: "applied", state: "running", maintenance: false, requested_by: "ana", until_s: 20 }, execute: { duration_s: 20 } },
    { op: "maintenance_on", duration: 1800, reply: { stage: "applied", state: "running", maintenance: true, requested_by: "ana", until_s: 1800 }, execute: { duration_s: 1800 } },
    { op: "maintenance_off", reply: { stage: "applied", state: "running", maintenance: false, requested_by: "ana" } },
    { op: "diagnostics", reply: { stage: "diagnostics", diagnostics: { firmware: "0.3.6", uptime_s: 99, reset_reason: "power_on", heap_free: 1000, heap_min: 900, mqtt_connected: true, state: "running", maintenance: false } } },
  ];
  for (const item of cases) {
    const b = bench();
    const started = one(b, "radar-1", item.op, { duration_s: item.duration });
    assert.equal(started.state, "arming");
    assert.deepEqual(started.nodes.map(line => [line.node_id, line.family, line.stage]), [["radar-1", "radar", "pending"]]);
    assert.equal(b.sent.length, 1);
    assert.equal(b.sent[0].topic, "armor/control/radar-1/command");
    assert.equal(b.sent[0].message.action, "arm");
    assert.equal(b.sent[0].message.operation, item.op);
    assert.equal(b.sent[0].message.requested_by, "ana");
    assert.ok(!("token" in b.sent[0].message) && !("duration_s" in b.sent[0].message), "an arm carries no token and no duration");
    const execute = b.armed("radar-1", item.op);
    assert.equal(b.sent.length, 2);
    assert.equal(execute.action, "execute");
    assert.equal(execute.token, SECRET_TOKEN, "the execute carries the token the node gave");
    assert.equal(execute.operation, item.op);
    for (const [key, value] of Object.entries(item.execute ?? {})) assert.equal(execute[key], value, `${item.op} ${key}`);
    if (!item.execute) assert.ok(!("duration_s" in execute));
    assert.ok(!("slot" in execute) && !("delay_s" in execute));
    assert.equal(b.service.get(started.id)!.nodes[0].stage, "sent");
    b.answer({ node_id: "radar-1", command_id: execute.command_id, action: "execute", operation: item.op, ...item.reply });
    const done = b.service.get(started.id)!;
    assert.equal(done.state, "done", item.op);
    assert.equal(done.nodes[0].stage, "applied", item.op);
    assert.ok(done.nodes[0].applied_at);
    const everywhere = JSON.stringify([b.service.list(), b.audits, b.history, b.holds]);
    assert.ok(!everywhere.includes(SECRET_TOKEN), `${item.op}: a token is never kept or shown`);
    assert.deepEqual(b.history.map(event => [event.category, event.action, event.subject, event.by, event.profile, event.outcome]), [
      ["node", "control_requested", "radar-1", "ana", item.op, "allowed"], ["node", "control_applied", "radar-1", "ana", item.op, "allowed"],
    ]);
  }
});

test("a restart is acknowledged, the node goes quiet and comes back; the line says each step with its time", () => {
  const b = bench();
  const started = one(b, "alarm-1", "restart");
  const execute = b.armed("alarm-1", "restart");
  assert.equal(execute.mode, "now");
  b.tick(1000);
  b.answer({ node_id: "alarm-1", command_id: execute.command_id, action: "execute", operation: "restart", stage: "restarting", reason: "requested_by_server", mode: "now", restart_in_s: 0, uptime_s: 3600, firmware: "0.3.6", requested_by: "ana" });
  let line = b.service.get(started.id)!.nodes[0];
  assert.equal(line.stage, "acknowledged");
  assert.equal(line.firmware_before, "0.3.6");
  assert.equal(b.service.get(started.id)!.state, "running");
  assert.equal(b.service.isHeld("alarm-1"), true, "the silence of a node that is restarting is no alarm");
  assert.deepEqual(b.holds, [["alarm-1", true]]);
  // it keeps reporting for a moment with the old uptime: not back yet
  b.tick(1000);
  b.hear("alarm-1", "alarm", { uptime_s: 3602 });
  assert.equal(b.service.get(started.id)!.nodes[0].stage, "acknowledged");
  // the broker's last will: it went
  b.tick(1000);
  b.service.handleOffline("alarm-1");
  line = b.service.get(started.id)!.nodes[0];
  assert.equal(line.stage, "offline");
  assert.ok(line.offline_at);
  // it comes back with a new uptime
  b.tick(15_000);
  b.hear("alarm-1", "alarm", { uptime_s: 6, firmware: "0.3.7", reset_reason: "software", broker_reconnects: 0 });
  line = b.service.get(started.id)!.nodes[0];
  assert.equal(line.stage, "back");
  assert.equal(line.firmware_after, "0.3.7");
  assert.ok(line.back_at && typeof line.back_after_s === "number" && line.back_after_s >= 15);
  assert.equal(b.service.get(started.id)!.state, "done");
  assert.equal(b.service.isHeld("alarm-1"), false);
  assert.deepEqual(b.holds, [["alarm-1", true], ["alarm-1", false]]);
  assert.deepEqual(b.history.map(event => event.action), ["control_requested", "control_acknowledged", "control_back"]);
  assert.equal(b.history[2].version, "0.3.7");
});

test("a restarted node that does not come back is lost, and one that never answers is no_answer", () => {
  const b = bench();
  const started = one(b, "solar-1", "restart");
  const execute = b.armed("solar-1", "restart");
  b.answer({ node_id: "solar-1", command_id: execute.command_id, action: "execute", operation: "restart", stage: "restarting", reason: "requested_by_server", mode: "now", restart_in_s: 0, uptime_s: 100, firmware: "0.3.6", requested_by: "ana" });
  b.tick(100_000);
  b.service.sweep();
  assert.equal(b.service.get(started.id)!.nodes[0].stage, "acknowledged");
  b.tick(200_000);
  b.service.sweep();
  assert.equal(b.service.get(started.id)!.nodes[0].stage, "not_back");
  assert.equal(b.service.get(started.id)!.state, "done");
  assert.deepEqual(b.history.map(event => [event.action, event.outcome]), [["control_requested", "allowed"], ["control_acknowledged", "allowed"], ["control_lost", "failed"]]);
  assert.equal(b.service.isHeld("solar-1"), false);
  // a node that does not answer the arm
  const second = one(b, "radar-1", "pause");
  b.tick(25_000);
  b.service.sweep();
  assert.equal(b.service.get(second.id)!.nodes[0].stage, "no_answer");
  assert.equal(b.service.get(second.id)!.nodes[0].refusal, "no_arm_answer");
  // and one that armed but never answered the execute
  const third = one(b, "hmi-1", "standby");
  b.armed("hmi-1", "standby");
  b.tick(31_000);
  b.service.sweep();
  assert.equal(b.service.get(third.id)!.nodes[0].stage, "no_answer");
  assert.equal(b.service.get(third.id)!.state, "done");
  assert.ok(!JSON.stringify([b.service.list(), b.audits, b.history]).includes(SECRET_TOKEN));
});

test("a node that is silent after it said it is restarting is marked offline by the health store too", () => {
  const b = bench();
  const started = one(b, "radar-1", "restart");
  const execute = b.armed("radar-1", "restart");
  b.answer({ node_id: "radar-1", command_id: execute.command_id, action: "execute", operation: "restart", stage: "restarting", reason: "requested_by_server", mode: "now", restart_in_s: 0, uptime_s: 100, firmware: "0.3.6", requested_by: "ana" });
  b.tick(200_000);   // the store calls a node stale after 180 s of silence
  b.service.sweep();
  assert.equal(b.service.get(started.id)!.nodes[0].stage, "offline");
});

test("a node that refuses says why, and the refusals of the contract end the line", () => {
  for (const refusal of CONTROL_REFUSALS.filter(word => word !== "none")) {
    const b = bench();
    const started = one(b, "radar-1", refusal === "already_restarting" ? "restart" : "pause");
    const arm = b.sent[0].message;
    b.answer({ node_id: "radar-1", command_id: arm.command_id, action: "arm", operation: arm.operation, stage: "rejected", accepted: false, refusal });
    const record = b.service.get(started.id)!;
    assert.equal(record.nodes[0].stage, "refused", refusal);
    assert.equal(record.nodes[0].refusal, refusal);
    assert.equal(record.state, "done");
    assert.deepEqual(b.history.map(event => [event.action, event.outcome]), [["control_requested", "allowed"], ["control_refused", "denied"]]);
    assert.equal(b.sent.length, 1, "nothing is executed after a refused arm");
  }
  // refused at the execute (the token was old)
  const b = bench();
  const started = one(b, "radar-1", "standby");
  const execute = b.armed("radar-1", "standby");
  b.answer({ node_id: "radar-1", command_id: execute.command_id, action: "execute", operation: "standby", stage: "rejected", accepted: false, refusal: "token_expired" });
  assert.deepEqual([b.service.get(started.id)!.nodes[0].stage, b.service.get(started.id)!.nodes[0].refusal], ["refused", "token_expired"]);
  assert.equal(b.service.memoryOf("radar-1"), undefined, "a refused order changes nothing the server remembers");
});

test("an answer is used once, only for the order it answers, the node it came from and the operation it was armed for", () => {
  const b = bench();
  const started = one(b, "radar-1", "pause");
  const arm = b.sent[0].message;
  const armedAnswer = { node_id: "radar-1", command_id: arm.command_id, action: "arm", operation: "pause", stage: "armed", token: SECRET_TOKEN, token_ttl_s: 30 };
  // an answer for another operation, for an order never sent, or from another node, is dropped
  b.answer({ ...armedAnswer, operation: "restart" });
  b.answer({ ...armedAnswer, command_id: "zzzzzzzz9999" });
  b.service.handleResult(parseControlResult({ kind: "node_control_result", timestamp_ms: 9, accepted: true, refusal: "none", ...armedAnswer }), "solar-1");
  assert.equal(b.sent.length, 1, "nothing was executed");
  assert.equal(b.service.get(started.id)!.nodes[0].stage, "pending");
  assert.ok(b.audits.filter(event => event.action === "node_control.result" && event.outcome === "denied").length >= 3);
  // the right answer arms and executes once; the same answer again (a replay) executes nothing
  b.answer(armedAnswer);
  assert.equal(b.sent.length, 2);
  b.answer(armedAnswer);
  assert.equal(b.sent.length, 2, "a replayed arm answer sends no second execute");
  const execute = b.sent[1].message;
  const applied = { node_id: "radar-1", command_id: execute.command_id, action: "execute", operation: "pause", stage: "applied", state: "paused", maintenance: false, requested_by: "ana", until_s: 3600, since_ms: 5 };
  b.answer(applied);
  assert.equal(b.service.memoryOf("radar-1")?.state, "paused");
  b.answer({ ...applied, state: "running" });   // replayed with another content: ignored
  assert.equal(b.service.memoryOf("radar-1")?.state, "paused");
  assert.equal(b.service.get(started.id)!.nodes[0].state, "paused");
});

test("one order at a time per node, a restart at most once a minute, a limit over all nodes, and the broker down sends nothing", () => {
  const b = bench();
  const first = one(b, "radar-1", "identify");
  assert.equal(code(() => one(b, "radar-1", "pause")), "409 busy", "an order for the node is still under way");
  assert.equal(code(() => one(b, "solar-1", "diagnostics")), undefined, "another node is free");
  const execute = b.armed("radar-1", "identify");
  b.answer({ node_id: "radar-1", command_id: execute.command_id, action: "execute", operation: "identify", stage: "applied", state: "running", maintenance: false, requested_by: "ana", until_s: 30 });
  assert.equal(b.service.get(first.id)!.state, "done");
  // a restart: refused for a minute after it was sent
  const restart = one(b, "hmi-1", "restart");
  const exec2 = b.armed("hmi-1", "restart");
  b.answer({ node_id: "hmi-1", command_id: exec2.command_id, action: "execute", operation: "restart", stage: "rejected", accepted: false, refusal: "busy_update" });
  assert.equal(b.service.get(restart.id)!.nodes[0].stage, "refused");
  assert.equal(code(() => one(b, "hmi-1", "restart")), "429 rate_limited");
  b.tick(61_000);
  assert.equal(code(() => one(b, "hmi-1", "restart")), undefined);
  // the limit over all nodes
  const limited = bench({ perMinute: 3 });
  assert.equal(code(() => one(limited, "radar-1", "diagnostics")), undefined);
  assert.equal(code(() => one(limited, "solar-1", "diagnostics")), undefined);
  assert.equal(code(() => one(limited, "hmi-1", "diagnostics")), undefined);
  assert.equal(code(() => one(limited, "alarm-1", "diagnostics")), "429 rate_limited");
  limited.tick(61_000);
  assert.equal(code(() => one(limited, "alarm-1", "diagnostics")), undefined);
  // the broker is down: nothing is kept, nothing sent
  const down = bench({ publishFails: true });
  assert.equal(code(() => one(down, "radar-1", "restart")), "503 mqtt_unavailable");
  assert.equal(down.service.list().length, 0);
  assert.equal(down.sent.length, 0);
  assert.equal(code(() => down.service.start({ scope: "all", operation: "diagnostics", mode: "now", actor: "ana", targets: [] })), "409 no_nodes");
  assert.equal(code(() => down.service.start({ scope: "node", operation: "diagnostics", mode: "now", actor: "ana", targets: [{ id: "all", family: "radar" }] })), "400 invalid_request");
  assert.equal(code(() => down.service.start({ scope: "node", operation: "diagnostics", mode: "now", actor: "ana", targets: [{ id: "Bad Node", family: "radar" }] })), "400 invalid_request");
});

test("an order to every node arms each node itself and executes each with its own token; a rolling restart gives each node its place", () => {
  const b = bench({ nodes: [["alarm-1", "alarm"], ["radar-2", "radar"], ["radar-1", "radar"], ["solar-1", "solar"]] });
  const targets = b.health.list().map(view => ({ id: view.node_id, family: view.family }));
  const started = b.service.start({ scope: "all", operation: "restart", mode: "rolling", actor: "ana", origin: "local", targets });
  assert.equal(started.scope, "all");
  assert.deepEqual(started.nodes.map(line => [line.node_id, line.slot]).sort(), [["alarm-1", 3], ["radar-1", 0], ["radar-2", 1], ["solar-1", 2]]);
  assert.equal(b.sent.length, 4, "one arm for each node, to its own topic");
  assert.deepEqual(b.sent.map(item => item.topic).sort(), ["armor/control/alarm-1/command", "armor/control/radar-1/command", "armor/control/radar-2/command", "armor/control/solar-1/command"]);
  assert.ok(b.sent.every(item => item.message.action === "arm" && item.message.mode === "rolling" && !("slot" in item.message) && item.message.node_id !== "all"));
  const tokens: Record<string, string> = { "alarm-1": "a1a1a1a1a1a1a1a1a1", "radar-1": "r1r1r1r1r1r1r1r1r1", "radar-2": "r2r2r2r2r2r2r2r2r2", "solar-1": "s1s1s1s1s1s1s1s1s1" };
  const executes = new Map<string, Record<string, unknown>>();
  for (const node of Object.keys(tokens)) executes.set(node, b.armed(node, "restart", tokens[node]));
  for (const [node, message] of executes) {
    assert.equal(message.token, tokens[node], `${node} is executed with its own token`);
    assert.equal(message.mode, "rolling");
    assert.equal(message.slot, started.nodes.find(line => line.node_id === node)!.slot);
  }
  assert.equal(executes.get("alarm-1")!.slot, 3, "the alarm panel goes last");
  assert.ok(!JSON.stringify([b.service.list(), b.audits, b.history]).includes("r1r1r1r1"));
  // the operation is done only when every node has finished
  for (const [node, message] of executes) {
    assert.equal(b.service.get(started.id)!.state, "running");
    b.answer({ node_id: node, command_id: message.command_id, action: "execute", operation: "restart", stage: "restarting", reason: "requested_by_server", mode: "rolling", restart_in_s: Number(message.slot) * 30, uptime_s: 500, firmware: "0.3.6", requested_by: "ana" });
  }
  for (const node of Object.keys(tokens)) { b.tick(40_000); b.hear(node, b.health.get(node)!.family, { uptime_s: 5, broker_reconnects: 0 }); }
  const done = b.service.get(started.id)!;
  assert.equal(done.state, "done");
  assert.deepEqual(done.nodes.map(line => line.stage), ["back", "back", "back", "back"]);
});

test("a pause is forgotten when its time is up, maintenance holds back the silence alerts until it ends, and standby stays until a resume", () => {
  const b = bench();
  const run = (node: string, operation: ControlOperation, reply: Record<string, unknown>, duration?: number) => {
    one(b, node, operation, { duration_s: duration });
    const execute = b.armed(node, operation);
    b.answer({ node_id: node, command_id: execute.command_id, action: "execute", operation, stage: "applied", maintenance: false, requested_by: "ana", ...reply });
  };
  run("radar-1", "pause", { state: "paused", until_s: 120, since_ms: 5 }, 120);
  assert.deepEqual(b.service.memoryOf("radar-1"), { state: "paused", maintenance: false, since_ms: 5, by: "ana", until_s: 120 });
  assert.equal(b.service.isHeld("radar-1"), false, "a paused node is still connected: its silence still counts");
  b.tick(121_000);
  b.service.sweep();
  assert.equal(b.service.memoryOf("radar-1"), undefined, "the node resumed by itself");
  run("solar-1", "standby", { state: "standby", since_ms: 7 });
  b.tick(7 * 86_400_000);
  b.service.sweep();
  assert.equal(b.service.memoryOf("solar-1")?.state, "standby", "standby has no end");
  b.tick(61_000);
  run("solar-1", "resume", { state: "running" });
  assert.equal(b.service.memoryOf("solar-1"), undefined);
  // maintenance
  b.tick(61_000);
  run("electrical-1", "maintenance_on", { state: "running", maintenance: true, until_s: 300 }, 300);
  assert.equal(b.service.isHeld("electrical-1"), true);
  assert.deepEqual(b.holds.filter(item => item[0] === "electrical-1"), [["electrical-1", true]]);
  assert.equal(b.service.memoryOf("electrical-1")?.maintenance, true);
  assert.equal(b.health.get("electrical-1")!.control?.maintenance, true, "the node health the consoles read says so");
  b.tick(301_000);
  b.service.sweep();
  assert.equal(b.service.isHeld("electrical-1"), false);
  assert.deepEqual(b.holds.filter(item => item[0] === "electrical-1"), [["electrical-1", true], ["electrical-1", false]]);
  // ended on request
  b.tick(61_000);
  run("alarm-1", "maintenance_on", { state: "running", maintenance: true, until_s: 3600 });
  assert.equal(b.service.isHeld("alarm-1"), true);
  b.tick(61_000);
  run("alarm-1", "maintenance_off", { state: "running", maintenance: false });
  assert.equal(b.service.isHeld("alarm-1"), false);
  // a node that reports its own maintenance flag is believed over the server's memory
  b.tick(61_000);
  run("hmi-1", "maintenance_on", { state: "running", maintenance: true, until_s: 3600 });
  b.hear("hmi-1", "hmi", { control_state: "running", maintenance: false });
  assert.equal(b.service.isHeld("hmi-1"), false);
});

test("the node health the consoles read carries the control state, from the node's report or from what the server remembers", () => {
  const b = bench();
  b.hear("radar-1", "radar", { control_state: "paused", control_since_ms: 1_760_000_000_000, control_by: "ana", control_until_s: 600 });
  assert.deepEqual(b.health.get("radar-1")!.control, { state: "paused", maintenance: false, since_ms: 1_760_000_000_000, by: "ana", until_s: 600, source: "node" });
  b.hear("solar-1", "solar", { control_state: "standby", control_since_ms: 0, control_by: "ana", maintenance: true, maintenance_until_s: 900 });
  assert.deepEqual(b.health.get("solar-1")!.control, { state: "standby", maintenance: true, since_ms: 0, by: "ana", maintenance_until_s: 900, source: "node" });
  assert.equal(b.health.get("hmi-1")!.control, undefined, "nothing is known of a node that never was ordered");
  assert.equal(b.health.list().find(view => view.node_id === "radar-1")!.control?.state, "paused");
});

test("the operations are kept in a file without any token, and a restart of the server loses the orders that were on their way", () => {
  const file = path.join(tempDir(), "node_control.json");
  const b = bench({ file });
  const sentOne = one(b, "radar-1", "standby");
  b.armed("radar-1", "standby");   // the token is in memory only
  const done = one(b, "solar-1", "maintenance_on", { duration_s: 600 });
  const execute = b.armed("solar-1", "maintenance_on", "tttttttttttttttttt");
  b.answer({ node_id: "solar-1", command_id: execute.command_id, action: "execute", operation: "maintenance_on", stage: "applied", state: "running", maintenance: true, requested_by: "ana", until_s: 600 });
  const restarting = one(b, "hmi-1", "restart");
  const exec3 = b.armed("hmi-1", "restart", "hhhhhhhhhhhhhhhhhh");
  b.answer({ node_id: "hmi-1", command_id: exec3.command_id, action: "execute", operation: "restart", stage: "restarting", reason: "requested_by_server", mode: "now", restart_in_s: 0, uptime_s: 9, firmware: "0.3.6", requested_by: "ana" });
  b.service.flush();
  const text = fs.readFileSync(file, "utf8");
  for (const token of [SECRET_TOKEN, "tttttttttttttttttt", "hhhhhhhhhhhhhhhhhh"]) assert.ok(!text.includes(token), "no token in the file");
  assert.ok(!/"token"/.test(text));
  const again = new NodeControlService({ publish: () => undefined, audit: { record: () => undefined }, history: () => undefined, health: node => b.health.get(node), nodes: () => b.health.list(), now: () => b.now(), file });
  assert.equal(again.list().length, 3);
  assert.equal(again.get(sentOne.id)!.nodes[0].stage, "no_answer", "an order that was on its way is over");
  assert.equal(again.get(sentOne.id)!.nodes[0].refusal, "server_restarted");
  assert.equal(again.get(done.id)!.nodes[0].stage, "applied");
  assert.equal(again.memoryOf("solar-1")?.maintenance, true, "the node's maintenance is remembered");
  assert.equal(again.get(restarting.id)!.nodes[0].stage, "acknowledged", "a restart that was acknowledged is still waited for");
  assert.equal(again.isHeld("solar-1"), true);
});

test("operations are listed newest first and the old ones are dropped after a few weeks", () => {
  const b = bench();
  const ids: string[] = [];
  for (let index = 0; index < 4; index += 1) { ids.push(one(b, "radar-1", "diagnostics").id); b.tick(25_000); b.service.sweep(); b.tick(40_000); }
  assert.deepEqual(b.service.list().map(item => item.id).slice(0, 2), [ids[3], ids[2]]);
  b.tick(40 * 86_400_000);
  b.service.sweep();
  assert.equal(b.service.list().length, 0, "operations older than a few weeks are gone");
});

test("the table of durations is the contract's", () => {
  assert.deepEqual(DURATIONS, { pause: [60, 3600, 3600], identify: [5, 300, 30], maintenance_on: [60, 28_800, 3600] });
});

// ---- the alarms ---------------------------------------------------------------------------------------------------------------------------------

test("alarm rules: the silence of a held node is not raised, other nodes still are, and a hold ends the alarm that was up", async () => {
  const running = await startServer();
  try {
    const { alarmRules } = running.app.context;
    const open = () => running.app.context.alarms.active().filter(alarm => !alarm.cleared_at);
    const held = new Set<string>(["electrical-1", "solar-1", "alarm-1", "network-1"]);
    alarmRules.held = node => held.has(node);
    alarmRules.handleElectricalStale("electrical-1", true);
    alarmRules.handleAlarmNodeStale("alarm-1", true, "armed");
    alarmRules.handleSolarStale("solar-1", "inverter", true);
    alarmRules.handleNetworkStale("network-1", true);
    assert.equal(open().length, 0, "nothing is raised for a held node");
    alarmRules.handleElectricalStale("electrical-2", true);
    alarmRules.handleSolarStale("solar-2", "inverter", true);
    alarmRules.handleAlarmNodeStale("alarm-2", true, "armed");
    assert.deepEqual(open().map(alarm => alarm.code).sort(), ["alarm_offline", "electrical_offline", "solar_offline"]);
    for (const node of ["electrical-2", "solar-2", "alarm-2"]) alarmRules.holdOffline(node);
    assert.equal(open().length, 0);
    // a held node's recovery still clears an alarm
    held.clear();
    alarmRules.handleElectricalStale("electrical-3", true);
    assert.equal(open().length, 1);
    alarmRules.handleElectricalStale("electrical-3", false);
    assert.equal(open().length, 0);
  } finally { await running.stop(); }
});

test("through the server: a node in maintenance raises no offline alarm, and when it ends and the node is still silent the alarm is raised", async () => {
  let clock = Date.now();
  const running = await startServer({}, { now: () => clock });
  try {
    const { context } = running.app;
    const open = (code: string) => context.alarms.active().some(alarm => alarm.code === code && !alarm.cleared_at);
    const published: Array<Record<string, unknown>> = [];
    context.controlLink.publish = (_topic, payload) => { published.push(JSON.parse(payload) as Record<string, unknown>); };
    context.nodeHealth.ingest(report("electrical-1", "electrical", { timestamp_ms: 1 }));
    context.alarmRules.handleElectricalStale("electrical-1", true);
    assert.ok(open("electrical_offline"));
    context.nodeControl.start({ scope: "node", operation: "maintenance_on", mode: "now", duration_s: 60, actor: "ana", targets: [{ id: "electrical-1", family: "electrical" }] });
    const answer = (over: Record<string, unknown>) => context.nodeControl.handleResult(parseControlResult({ kind: "node_control_result", node_id: "electrical-1", timestamp_ms: 9, accepted: true, refusal: "none", operation: "maintenance_on", ...over }), "electrical-1");
    answer({ command_id: published[0].command_id, action: "arm", stage: "armed", token: SECRET_TOKEN, token_ttl_s: 30 });
    answer({ command_id: published[1].command_id, action: "execute", stage: "applied", state: "running", maintenance: true, requested_by: "ana", until_s: 60 });
    assert.equal(open("electrical_offline"), false, "the alarm that was up ended");
    context.alarmRules.handleElectricalStale("electrical-1", true);
    assert.equal(open("electrical_offline"), false, "and none is raised while it lasts");
    clock += 200_000;   // the window is over and the node has been silent for longer than the store allows
    context.nodeControl.sweep();
    assert.equal(open("electrical_offline"), true, "the node is still silent: the alarm comes");
  } finally { await running.stop(); }
});

// ---- the broker ---------------------------------------------------------------------------------------------------------------------------------

test("the answers on the broker go through the table: another node's name, a token in a refused answer and an answer of `all`", async () => {
  const running = await startServer();
  try {
    const { context } = running.app;
    const published: Array<Record<string, unknown>> = [];
    context.controlLink.publish = (_topic, payload) => { published.push(JSON.parse(payload) as Record<string, unknown>); };
    context.nodeHealth.ingest(report("radar-1", "radar", { timestamp_ms: 1 }));
    const routes = [{ subscribe: ["armor/control/+/result"], named: (topic: string) => controlTopic(topic, "result"), parse: parseControlResult, fallback: "invalid control result",
      matches: (message: ControlResult, named: string) => message.node_id === named, apply: (message: ControlResult, named: string) => context.nodeControl.handleResult(message, named) }];
    const rejected: unknown[] = [];
    const take = (topic: string, body: unknown): boolean => routeMessage(routes, context.ingestLog, (_t, _r, error) => rejected.push(error), topic, Buffer.from(JSON.stringify(body)));
    const started = context.nodeControl.start({ scope: "node", operation: "standby", mode: "now", actor: "ana", targets: [{ id: "radar-1", family: "radar" }] });
    const arm = { kind: "node_control_result", node_id: "radar-1", timestamp_ms: 9, command_id: published[0].command_id, action: "arm", operation: "standby", stage: "armed", accepted: true, refusal: "none", token: SECRET_TOKEN, token_ttl_s: 30 };
    assert.equal(take("armor/control/solar-1/result", arm), true);   // it names another node than its topic
    assert.equal(rejected.length, 1);
    assert.equal(published.length, 1);
    assert.equal(take("armor/control/all/result", arm), false);
    assert.equal(published.length, 1);
    assert.equal(take("armor/control/radar-1/result", arm), true);
    assert.equal(published.length, 2, "the execute went out");
    assert.equal(context.nodeControl.get(started.id)!.nodes[0].stage, "sent");
  } finally { await running.stop(); }
});

// ---- the routes -------------------------------------------------------------------------------------------------------------------------------

async function routeBench() {
  const running = await startServer();
  const published: Array<{ topic: string; message: Record<string, unknown> }> = [];
  running.app.context.controlLink.publish = (topic, payload) => { published.push({ topic, message: JSON.parse(payload) as Record<string, unknown> }); };
  let stamp = 5000;
  for (const [id, family] of [["radar-1", "radar"], ["alarm-1", "alarm"], ["solar-1", "solar"], ["electrical-1", "electrical"]] as const) running.app.context.nodeHealth.ingest(report(id, family, { timestamp_ms: stamp++ }));
  const cookie = await studioCookie(running.base);
  const send = (method: string, url: string, body?: unknown, headers: Record<string, string> = { cookie }) => fetch(`${running.base}${url}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const elevate = async () => assert.equal((await send("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD })).status, 200);
  const answer = (over: Record<string, unknown>) => running.app.context.nodeControl.handleResult(parseControlResult({ kind: "node_control_result", timestamp_ms: 9, accepted: true, refusal: "none", ...over }), String(over.node_id));
  return { running, published, cookie, send, elevate, answer };
}
const codeOf = async (response: Response): Promise<[number, string | undefined]> => [response.status, ((await response.json()) as { code?: string }).code];

test("the routes ask for an administrator and a fresh proof, and every refusal has its code", async () => {
  const { running, send, elevate, published } = await routeBench();
  try {
    const operator = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };
    assert.equal((await send("POST", "/api/v1/nodes/radar-1/control", { operation: "diagnostics" }, {})).status, 401);
    assert.equal((await send("POST", "/api/v1/nodes/radar-1/control", { operation: "diagnostics" }, operator)).status, 401);   // the operator token is not an administrator
    assert.equal((await send("POST", "/api/v1/nodes/control", { operation: "diagnostics", mode: "now" }, operator)).status, 401);
    assert.equal((await send("GET", "/api/v1/nodes/control/operations", undefined, operator)).status, 401);
    assert.equal((await send("GET", "/api/v1/nodes/control/operations", undefined, {})).status, 401);
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/radar-1/control", { operation: "diagnostics" })), [403, "elevation_required"]);
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/control", { operation: "diagnostics", mode: "now" })), [403, "elevation_required"]);
    assert.equal(published.length, 0);
    await elevate();
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/radar-1/control", { operation: "restart", confirm: "radar-2" })), [400, "invalid_request"]);
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/radar-1/control", { operation: "restart" })), [400, "invalid_request"]);
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/radar-1/control", { operation: "factory_reset", confirm: "radar-1" })), [400, "invalid_request"]);
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/radar-1/control", { operation: "pause", confirm: "radar-1", duration_s: 5 })), [400, "invalid_request"]);
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/radar-1/control", { operation: "pause", confirm: "radar-1", mode: "rolling" })), [400, "invalid_request"]);
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/all/control", { operation: "diagnostics" })), [400, "invalid_request"]);
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/control", { operation: "restart", mode: "now", confirm: "radar-1" })), [400, "invalid_request"]);
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/control", { operation: "pause", mode: "rolling", confirm: "PAUSE" })), [400, "invalid_request"]);
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/control", { operation: "restart", confirm: "RESTART" })), [400, "invalid_request"]);
    assert.equal((await send("POST", "/api/v1/nodes/radar-1/control", "restart")).status, 400);
    for (const id of ["nobody", "armor-server", "server", "cm5", "localhost"]) assert.deepEqual(await codeOf(await send("POST", `/api/v1/nodes/${id}/control`, { operation: "diagnostics" })), [404, "unknown_node"], id);
    assert.equal((await send("GET", "/api/v1/nodes/control/operations/aaaaaaaaaaaa")).status, 404);
    assert.equal((await send("GET", "/api/v1/nodes/control/operations/short")).status, 404);
    assert.equal(published.length, 0, "nothing was sent for any refusal");
  } finally { await running.stop(); }
});

test("one order through the routes, the node's answers made here, the operation as it shows, and the history says who did what", async () => {
  const { running, send, elevate, published, answer } = await routeBench();
  try {
    await elevate();
    const response = await send("POST", "/api/v1/nodes/alarm-1/control", { operation: "pause", confirm: "alarm-1", duration_s: 900 });
    assert.equal(response.status, 202);
    const started = (await response.json()) as ControlOperationRecord;
    assert.equal(started.scope, "node");
    assert.equal(started.actor, "admin");
    assert.equal(started.origin, "local");
    assert.deepEqual(started.nodes.map(line => [line.node_id, line.family, line.stage]), [["alarm-1", "alarm", "pending"]]);
    assert.equal(published.length, 1);
    answer({ node_id: "alarm-1", command_id: published[0].message.command_id, action: "arm", operation: "pause", stage: "armed", token: SECRET_TOKEN, token_ttl_s: 30 });
    assert.equal(published[1].message.token, SECRET_TOKEN);
    assert.equal(published[1].message.duration_s, 900);
    assert.equal(published[1].message.requested_by, "admin");
    assert.equal((await send("POST", "/api/v1/nodes/alarm-1/control", { operation: "identify" })).status, 409, "another order for the node while this one is under way");
    answer({ node_id: "alarm-1", command_id: published[1].message.command_id, action: "execute", operation: "pause", stage: "applied", state: "paused", maintenance: false, requested_by: "admin", until_s: 900, since_ms: 5 });
    const shown = await send("GET", `/api/v1/nodes/control/operations/${started.id}`);
    const text = await shown.text();
    assert.ok(!text.includes(SECRET_TOKEN), "a token is never in an answer");
    assert.ok(!/token/i.test(text), "not even the word");
    const record = JSON.parse(text) as ControlOperationRecord;
    assert.deepEqual([record.state, record.nodes[0].stage, record.nodes[0].state], ["done", "applied", "paused"]);
    const listText = await (await send("GET", "/api/v1/nodes/control/operations")).text();
    assert.ok(!listText.includes(SECRET_TOKEN) && !/token/i.test(listText));
    assert.equal((JSON.parse(listText) as { operations: unknown[] }).operations.length, 1);
    // the node's state is in the node health the consoles read
    const health = (await (await send("GET", "/api/v1/node-health")).json()) as { nodes: Array<{ node_id: string; control?: { state: string; by: string; source: string; until_s: number } }> };
    const view = health.nodes.find(node => node.node_id === "alarm-1")!;
    assert.deepEqual([view.control?.state, view.control?.by, view.control?.source], ["paused", "admin", "server"]);
    assert.ok(view.control!.until_s > 0 && view.control!.until_s <= 900);
    // the history
    const history = (await (await send("GET", "/api/v1/history?category=node&all=1")).json()) as { events: Array<{ category: string; action: string; subject: string; by: string; profile: string; outcome: string }> };
    const control = history.events.filter(event => event.action.startsWith("control_"));
    assert.ok(control.some(event => event.action === "control_requested" && event.subject === "alarm-1" && event.by === "admin" && event.profile === "pause" && event.outcome === "allowed"));
    assert.ok(control.some(event => event.action === "control_applied" && event.subject === "alarm-1" && event.by === "admin" && event.profile === "pause"));
    assert.ok(!JSON.stringify(history).includes(SECRET_TOKEN));
    // the audit file says who, from where, and no token
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /"action":"node_control.request","outcome":"allowed","actor":"admin","target":"alarm-1","detail":"pause [a-z0-9]+ now 900s from local"/);
    assert.ok(!audit.includes(SECRET_TOKEN));
  } finally { await running.stop(); }
});

test("an order to every node: the word is typed, a rolling restart is planned with the alarm panel last, and a node already in the state is skipped", async () => {
  const first = await routeBench();
  try {
    await first.elevate();
    assert.equal((await first.send("POST", "/api/v1/nodes/control", { operation: "restart", mode: "rolling" })).status, 400);
    const response = await first.send("POST", "/api/v1/nodes/control", { operation: "restart", mode: "rolling", confirm: "RESTART" });
    assert.equal(response.status, 202);
    const started = (await response.json()) as ControlOperationRecord;
    assert.equal(started.scope, "all");
    assert.equal(started.mode, "rolling");
    assert.deepEqual(started.nodes.map(line => [line.node_id, line.slot]).sort(), [["alarm-1", 3], ["electrical-1", 2], ["radar-1", 0], ["solar-1", 1]]);
    assert.equal(first.published.length, 4);
    for (const arm of [...first.published]) first.answer({ node_id: arm.message.node_id, command_id: arm.message.command_id, action: "arm", operation: "restart", stage: "armed", token: `tok${String(arm.message.node_id).replace(/[^a-z0-9]/g, "")}0000000000`.slice(0, 20), token_ttl_s: 30 });
    const executes = first.published.filter(item => item.message.action === "execute");
    assert.equal(executes.length, 4);
    assert.equal(executes.find(item => item.message.node_id === "alarm-1")!.message.slot, 3);
    assert.ok(executes.every(item => item.message.mode === "rolling"));
    assert.equal(new Set(executes.map(item => item.message.token)).size, 4, "each node has its own token");
    assert.equal((await first.send("POST", "/api/v1/nodes/control", { operation: "diagnostics", mode: "now" })).status, 409, "a second order is refused while the first is under way");
    const text = await (await first.send("GET", `/api/v1/nodes/control/operations/${started.id}`)).text();
    for (const item of executes) assert.ok(!text.includes(String(item.message.token)));
  } finally { await first.running.stop(); }
  // skipped
  const second = await routeBench();
  try {
    await second.elevate();
    const family = (id: string) => (id.startsWith("radar") ? "radar" : id.startsWith("alarm") ? "alarm" : id.startsWith("solar") ? "solar" : "electrical") as NodeHealthMessage["family"];
    for (const id of ["radar-1", "alarm-1", "solar-1", "electrical-1"]) second.running.app.context.nodeHealth.ingest(report(id, family(id), { timestamp_ms: 6000, control_state: "standby", control_since_ms: 0, control_by: "ana" }));
    assert.deepEqual(await codeOf(await second.send("POST", "/api/v1/nodes/control", { operation: "standby", mode: "now", confirm: "STANDBY" })), [409, "already_in_state"]);
    second.running.app.context.nodeHealth.ingest(report("radar-1", "radar", { timestamp_ms: 6100, control_state: "running" }));
    const some = await second.send("POST", "/api/v1/nodes/control", { operation: "standby", mode: "now", confirm: "STANDBY" });
    assert.equal(some.status, 202);
    assert.deepEqual(((await some.json()) as ControlOperationRecord).nodes.map(line => line.node_id), ["radar-1"], "only the node that works is asked");
    assert.equal((await second.send("POST", "/api/v1/nodes/solar-1/control", { operation: "standby", confirm: "solar-1" })).status, 409);
  } finally { await second.running.stop(); }
  // no nodes at all
  const empty = await startServer();
  try {
    const cookie = await studioCookie(empty.base);
    const send = (method: string, url: string, body?: unknown) => fetch(`${empty.base}${url}`, { method, headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
    await send("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD });
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/control", { operation: "diagnostics", mode: "now" })), [409, "no_nodes"]);
  } finally { await empty.stop(); }
});

test("the broker down answers 503, and nothing that erases or sleeps a node can be reached by any route", async () => {
  const { running, send, elevate } = await routeBench();
  try {
    await elevate();
    running.app.context.controlLink.publish = undefined;
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/radar-1/control", { operation: "diagnostics" })), [503, "mqtt_unavailable"]);
    assert.deepEqual(await (await send("GET", "/api/v1/nodes/control/operations")).json(), { operations: [] });
    running.app.context.controlLink.publish = () => undefined;
    for (const route of ["/api/v1/nodes/radar-1/factory-reset", "/api/v1/nodes/radar-1/erase", "/api/v1/nodes/radar-1/sleep", "/api/v1/nodes/radar-1/restart", "/api/v1/nodes/restart", "/api/v1/nodes/radar-1/wake"]) {
      const result = await send("POST", route, { operation: "restart", confirm: "radar-1" });
      assert.equal(result.status, 404, route);
    }
    for (const word of ["factory_reset", "erase_flash", "wipe_wifi", "deep_sleep", "sleep", "wake_timer"]) assert.equal((await send("POST", "/api/v1/nodes/radar-1/control", { operation: word, confirm: "radar-1" })).status, 400, word);
  } finally { await running.stop(); }
});

test("a silent node is 409 node_unavailable, and a refused body leaves a line in the audit without any token", async () => {
  let clock = Date.now();
  const running = await startServer({}, { now: () => clock });
  try {
    running.app.context.controlLink.publish = () => undefined;
    running.app.context.nodeHealth.ingest(report("radar-1", "radar", { timestamp_ms: 1 }));
    const cookie = await studioCookie(running.base);
    const send = (method: string, url: string, body?: unknown) => fetch(`${running.base}${url}`, { method, headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
    await send("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD });
    assert.equal((await send("POST", "/api/v1/nodes/radar-1/control", { operation: "restart", confirm: "wrong" })).status, 400);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /"action":"node_control.request","outcome":"denied","actor":"admin","target":"radar-1"/);
    clock += 600_000;
    assert.deepEqual(await codeOf(await send("POST", "/api/v1/nodes/radar-1/control", { operation: "diagnostics" })), [409, "node_unavailable"]);
  } finally { await running.stop(); }
});
