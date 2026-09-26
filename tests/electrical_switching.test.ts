// The way a command reaches the switch of an electrical node: the parsers against the shared vectors, every refusal of the service, the one-time token, the alarms of a
// switch, and the routes (off by default). No node that switches exists yet: the node's answers here are made by the tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuditEvent, AuditLog } from "../src/audit.js";
import { ElectricalStore, parseElectricalCommand, parseElectricalMessage, parseElectricalResult, electricalTopic, type ElectricalMessage, type ElectricalResult, type ElectricalSwitch } from "../src/electrical.js";
import { SwitchingError, SwitchingService } from "../src/electrical_switching.js";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

const directory = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance");
type Vector = { name: string; valid: boolean; payload: unknown };
const vectors = (kind: string): Vector[] => (JSON.parse(fs.readFileSync(path.join(directory, `${kind}.json`), "utf8")) as { vectors: Vector[] }).vectors;
const skip = fs.existsSync(path.join(directory, "electrical_command.json")) ? false : "ARMOR-COMMON is not checked out next to this repository";

for (const [kind, parse] of [["electrical_command", parseElectricalCommand], ["electrical_result", parseElectricalResult], ["electrical", parseElectricalMessage]] as const) {
  test(`${kind} parsing agrees with every shared conformance vector`, { skip }, () => {
    const all = vectors(kind);
    assert.ok(all.length >= 26);
    for (const vector of all) {
      if (vector.valid) assert.doesNotThrow(() => parse(vector.payload), `should accept: ${vector.name}`);
      else assert.throws(() => parse(vector.payload), `should reject: ${vector.name}`);
    }
  });
}

test("the topics of a command and of an answer name a node and nothing else", () => {
  assert.equal(electricalTopic("armor/electrical/electrical-1/command", "command"), "electrical-1");
  assert.equal(electricalTopic("armor/electrical/electrical-1/result", "result"), "electrical-1");
  assert.equal(electricalTopic("armor/electrical/electrical-1/command", "state"), undefined);
  assert.equal(electricalTopic("armor/electrical/electrical-1/state", "result"), undefined);
  for (const topic of ["armor/electrical/Node/command", "armor/electrical/-x/command", "armor/electrical/a/b/command", "armor/electrical/command"]) assert.equal(electricalTopic(topic, "command"), undefined, topic);
});

// ---- the service -------------------------------------------------------------------------------------------------------------------------

const swtch = (extra: Partial<ElectricalSwitch> = {}): ElectricalSwitch => ({ id: "transfer", kind: "transfer", a_closed: true, b_closed: false, selected: "a", wanted: "a", closing: false, armed: false, fault: "none", ...extra });
const reading = (extra: Partial<ElectricalMessage> = {}): ElectricalMessage => ({ kind: "electrical", node_id: "electrical-1", timestamp_ms: 1000, switching_enabled: true, channels: [], switches: [swtch()], ...extra });

function bench(options: { enabled?: boolean; publishFails?: boolean } = {}) {
  let clock = 1_000_000;
  const sent: Array<{ topic: string; payload: string }> = [];
  const audit: AuditEvent[] = [];
  const log: AuditLog = { record: event => { audit.push(event); } };
  const nodes = new ElectricalStore({ now: () => clock });
  let counter = 0;
  const service = new SwitchingService({
    enabled: options.enabled ?? true, nodes, audit: log, now: () => clock, random: () => `c${String(++counter).padStart(15, "0")}`,
    publish: (topic, payload) => { if (options.publishFails) throw new Error("down"); sent.push({ topic, payload }); },
  });
  const answer = (over: Partial<ElectricalResult> & Pick<ElectricalResult, "command_id" | "action">): ElectricalResult => ({ kind: "electrical_result", node_id: "electrical-1", timestamp_ms: 9, switch: "transfer", accepted: true, refusal: "none", ...over });
  return { service, nodes, sent, audit, tick: (ms: number) => { clock += ms; }, answer, last: () => JSON.parse(sent[sent.length - 1].payload) as Record<string, unknown> };
}
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (error) { return error instanceof SwitchingError ? error.code : `other:${String(error)}`; } return undefined; };

test("switching off, nothing is sent, not even an open, and the refusal is audited", () => {
  const b = bench({ enabled: false });
  b.nodes.ingest(reading());
  for (const action of ["arm", "close_a", "open", "acknowledge"] as const) assert.equal(code(() => b.service.request("electrical-1", "transfer", action, "admin")), "switching_disabled");
  assert.equal(b.sent.length, 0);
  assert.equal(b.audit.filter(event => event.outcome === "denied").length, 4);
  assert.equal(b.service.status().enabled, false);
});

test("a command needs a node that is there, awake, allowed to switch, and that has that switch", () => {
  const b = bench();
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "arm", "admin")), "unknown_node");
  b.nodes.ingest(reading({ switching_enabled: false }));
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "arm", "admin")), "node_not_switching");
  b.nodes.ingest(reading({ switching_enabled: undefined }));
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "arm", "admin")), "node_not_switching");
  b.nodes.ingest(reading());
  assert.equal(code(() => b.service.request("electrical-1", "nothing", "arm", "admin")), "unknown_switch");
  b.nodes.ingest(reading({ switches: undefined }));
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "arm", "admin")), "unknown_switch");
  b.nodes.ingest(reading());
  b.tick(120_000);                                              // the node has said nothing for two minutes
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "arm", "admin")), "node_unavailable");
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "toggle" as never, "admin")), "invalid_action");
  assert.equal(b.sent.length, 0);
});

test("closing is arm, then close with the token the node gave, once", () => {
  const b = bench();
  b.nodes.ingest(reading());
  // a close with no arm is refused here, before it is sent
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "close_a", "admin")), "not_armed");
  assert.equal(b.sent.length, 0);
  // arm: sent without a token, to the node's own command topic, and it is waiting for the node's answer
  const armed = b.service.request("electrical-1", "transfer", "arm", "admin");
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].topic, "armor/electrical/electrical-1/command");
  const command = parseElectricalCommand(JSON.parse(b.sent[0].payload));
  assert.deepEqual([command.action, command.switch, command.command_id, "token" in command], ["arm", "transfer", armed.command_id, false]);
  assert.equal(b.service.status().pending.length, 1);
  // the answer holds the token; it is kept, and shown to nobody
  const TOKEN = "0123456789abcdef";
  b.service.handleResult(b.answer({ command_id: armed.command_id, action: "arm", token: TOKEN }), "electrical-1");
  assert.equal(b.service.status().pending.length, 0);
  assert.equal(b.service.status().recent[0].accepted, true);
  assert.equal(JSON.stringify(b.service.status()).includes(TOKEN), false);
  // the close carries the token, and it is spent at once
  const closing = b.service.request("electrical-1", "transfer", "close_b", "admin");
  assert.equal(b.last().token, TOKEN);
  assert.doesNotThrow(() => parseElectricalCommand(b.last()));
  b.service.handleResult(b.answer({ command_id: closing.command_id, action: "close_b" }), "electrical-1");
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "close_b", "admin")), "not_armed");
  // the token is in no audit line
  assert.equal(JSON.stringify(b.audit).includes(TOKEN), false);
});

test("an arm nobody used expires, a refused arm arms nothing, and an open withdraws the arm", () => {
  const b = bench();
  b.nodes.ingest(reading());
  const TOKEN = "0123456789abcdef";
  const arm = () => { const sent = b.service.request("electrical-1", "transfer", "arm", "admin"); b.service.handleResult(b.answer({ command_id: sent.command_id, action: "arm", token: TOKEN }), "electrical-1"); };
  arm();
  b.tick(11_000);
  b.nodes.ingest(reading());
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "close_a", "admin")), "not_armed");
  // the node refuses the arm: nothing to close with
  const refused = b.service.request("electrical-1", "transfer", "arm", "admin");
  b.service.handleResult(b.answer({ command_id: refused.command_id, action: "arm", accepted: false, refusal: "disabled" }), "electrical-1");
  assert.equal(b.service.status().recent[0].refusal, "disabled");
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "close_a", "admin")), "not_armed");
  // an open withdraws an arm that was accepted
  arm();
  const open = b.service.request("electrical-1", "transfer", "open", "admin");
  b.service.handleResult(b.answer({ command_id: open.command_id, action: "open" }), "electrical-1");
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "close_a", "admin")), "not_armed");
});

test("one command at a time per switch, except opening, and a fault only lets open and acknowledge through", () => {
  const b = bench();
  b.nodes.ingest(reading());
  b.service.request("electrical-1", "transfer", "arm", "admin");
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "arm", "admin")), "busy");
  assert.doesNotThrow(() => b.service.request("electrical-1", "transfer", "open", "admin"));   // opening is never made to wait
  const c = bench();
  c.nodes.ingest(reading({ switches: [swtch({ fault: "did_not_open", a_closed: true, selected: "a", wanted: "none" })] }));
  assert.equal(code(() => c.service.request("electrical-1", "transfer", "arm", "admin")), "switch_fault");
  assert.equal(code(() => c.service.request("electrical-1", "transfer", "close_a", "admin")), "switch_fault");
  assert.doesNotThrow(() => c.service.request("electrical-1", "transfer", "open", "admin"));
  c.tick(6000);
  c.service.sweep();
  assert.doesNotThrow(() => c.service.request("electrical-1", "transfer", "acknowledge", "admin"));
});

test("an answer that does not match a command that is waiting is dropped, and a command with no answer times out", () => {
  const b = bench();
  b.nodes.ingest(reading());
  const sent = b.service.request("electrical-1", "transfer", "arm", "admin");
  const TOKEN = "0123456789abcdef";
  b.service.handleResult(b.answer({ command_id: "c999999999999999", action: "arm", token: TOKEN }), "electrical-1");                // an id nobody sent
  b.service.handleResult(b.answer({ command_id: sent.command_id, action: "arm", token: TOKEN, node_id: "electrical-2" }), "electrical-1");   // another node in the body
  b.service.handleResult(b.answer({ command_id: sent.command_id, action: "arm", token: TOKEN }), "electrical-2");                 // another node's topic
  b.service.handleResult(b.answer({ command_id: sent.command_id, action: "open" }), "electrical-1");                              // not the action that was asked
  b.service.handleResult(b.answer({ command_id: sent.command_id, action: "arm", token: TOKEN, switch: "other" }), "electrical-1");
  assert.equal(b.service.status().pending.length, 1);
  assert.equal(b.audit.filter(event => event.action === "electrical.switch.result" && event.outcome === "denied").length, 5);
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "close_a", "admin")), "busy");     // nothing was armed by them
  b.tick(6000);
  const status = b.service.status();
  assert.deepEqual([status.pending.length, status.recent[0].refusal, status.recent[0].accepted], [0, "timeout", false]);
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "close_a", "admin")), "not_armed");
  // the genuine answer arriving after the timeout finds nothing waiting: it is dropped, and arms nothing
  b.service.handleResult(b.answer({ command_id: sent.command_id, action: "arm", token: TOKEN }), "electrical-1");
  assert.equal(code(() => b.service.request("electrical-1", "transfer", "close_a", "admin")), "not_armed");
});

test("when the broker is not there the command is not sent and nothing waits", () => {
  const down = bench({ publishFails: true });
  down.nodes.ingest(reading());
  assert.equal(code(() => down.service.request("electrical-1", "transfer", "arm", "admin")), "mqtt_unavailable");
  assert.equal(down.service.status().pending.length, 0);
  assert.equal(down.audit.at(-1)?.outcome, "failed");
});

test("the alarm of a switch: a latched fault, or both contacts closed, is high and ends when it is gone", async () => {
  const { AlarmCentre, AlarmRules } = await import("../src/alarms.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-switch-alarms-"));
  const centre = new AlarmCentre({ file: path.join(dir, "alarms.json") });
  const rules = new AlarmRules(centre, () => "disarmed");
  const active = () => centre.active().filter(alarm => !alarm.cleared_at).map(alarm => `${alarm.code}:${alarm.severity}:${alarm.source.id}`);
  rules.handleElectrical(reading());
  assert.deepEqual(active(), []);
  rules.handleElectrical(reading({ switches: [swtch({ armed: true, closing: true, a_closed: false, selected: "none", wanted: "b" })] }));
  assert.deepEqual(active(), []);                                                   // armed or closing is what was asked, not a fault
  rules.handleElectrical(reading({ switches: [swtch({ fault: "did_not_close", a_closed: false, selected: "none", wanted: "none" })] }));
  assert.deepEqual(active(), ["electrical_switch_fault:high:electrical-1/transfer"]);
  rules.handleElectrical(reading({ switches: [swtch({ a_closed: true, b_closed: true, selected: "none" })] }));   // both closed with the node saying nothing
  assert.deepEqual(active(), ["electrical_switch_fault:high:electrical-1/transfer"]);
  rules.handleElectrical(reading());
  assert.deepEqual(active(), []);
});

// ---- the routes ---------------------------------------------------------------------------------------------------------------------------

test("by default the server sends nothing to any switch: the route refuses, and the status says it is off", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const post = (body: unknown, headers: Record<string, string> = { cookie }) => fetch(`${running.base}/api/v1/electrical/switch`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ node: "electrical-1", switch: "transfer", action: "open" }, {})).status, 401);
    const off = await post({ node: "electrical-1", switch: "transfer", action: "open" });
    assert.deepEqual([off.status, ((await off.json()) as { code: string }).code], [403, "switching_disabled"]);
    assert.equal((await post({ node: "Bad Node", switch: "transfer", action: "open" })).status, 400);
    assert.equal((await post({ node: "electrical-1", switch: "transfer", action: "toggle" })).status, 400);
    assert.equal((await post("no")).status, 400);
    const status = await fetch(`${running.base}/api/v1/electrical/switching`, { headers: { cookie } });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { enabled: false, pending: [], recent: [] });
    assert.equal((await fetch(`${running.base}/api/v1/electrical/switching`)).status, 401);
    // the operator token is enough to look, and not enough to switch
    const operator = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };
    assert.equal((await fetch(`${running.base}/api/v1/electrical/switching`, { headers: operator })).status, 200);
    assert.equal((await post({ node: "electrical-1", switch: "transfer", action: "open" }, operator)).status, 401);
  } finally { await running.stop(); }
});

test("turned on, the route still refuses what the node does not allow, and with no broker it sends nothing", async () => {
  const running = await startServer({ ARMOR_ELECTRICAL_SWITCHING: "1" });
  try {
    assert.ok(running.config.warnings.some(warning => warning.includes("ARMOR_ELECTRICAL_SWITCHING")));
    const cookie = await studioCookie(running.base);
    const post = (body: unknown) => fetch(`${running.base}/api/v1/electrical/switch`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
    const ingest = (message: ElectricalMessage) => fetch(`${running.base}/api/v1/electrical/readings`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify(message) });
    const codeOf = async (response: Response) => ((await response.json()) as { code: string }).code;
    const body = { node: "electrical-1", switch: "transfer", action: "arm" };
    assert.equal(await codeOf(await post(body)), "unknown_node");
    assert.equal((await ingest(reading({ switching_enabled: false }))).status, 202);
    assert.equal(await codeOf(await post(body)), "node_not_switching");
    assert.equal((await ingest(reading())).status, 202);
    const noBroker = await post(body);
    assert.deepEqual([noBroker.status, await codeOf(noBroker)], [503, "mqtt_unavailable"]);
    assert.equal((await ingest({ ...reading(), switches: [swtch(), swtch()] })).status, 400);       // a switch named twice is refused at the door
    assert.equal((await ingest({ ...reading(), switches: [{ ...swtch(), coil_pin: 4 } as never] })).status, 400);
  } finally { await running.stop(); }
});
