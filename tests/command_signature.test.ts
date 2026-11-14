import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AuditLog } from "../src/audit.js";
import { AlarmCommands } from "../src/alarm_commands.js";
import { AlarmStore, type AlarmMessage } from "../src/alarm.js";
import { CommandSigner, SIGNATURE_PREFIX, bodySignature, nodeKeyOf, splitSigned } from "../src/command_signature.js";
import { ElectricalStore, type ElectricalMessage } from "../src/electrical.js";
import { SwitchingService } from "../src/electrical_switching.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { startServer, studioCookie, tempDir } from "./helpers.js";

const MASTER = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";   // a made-up key for the vectors
const command = { kind: "alarm_command", node_id: "alarm-1", timestamp_ms: 1_000_000, command_id: "c000000000000001", action: "arm", mode: "away", force: true };
const keyFile = (contents?: string): string => { const file = path.join(tempDir(), "command-signature.key"); if (contents) fs.writeFileSync(file, contents); return file; };
const log: AuditLog = { record: () => undefined };

test("the option is off by default and giving it up is a loss of protection", () => {
  assert.equal(SECURITY_DEFAULTS["commands.require_sig"], false);
  assert.equal(lowers("commands.require_sig", true, false), true);
  assert.equal(lowers("commands.require_sig", false, true), false);
});

test("the vector the nodes check against: key of the node, payload and signature are fixed", () => {
  const signer = new CommandSigner(keyFile(MASTER), () => "0123456789abcdef");
  const nodeKey = nodeKeyOf(MASTER, "alarm-1");
  assert.equal(signer.nodeKey("alarm-1"), nodeKey);
  assert.notEqual(nodeKey, nodeKeyOf(MASTER, "alarm-2"), "every node has its own key");
  const payload = signer.sign(command);
  const body = '{"kind":"alarm_command","node_id":"alarm-1","timestamp_ms":1000000,"command_id":"c000000000000001","action":"arm","mode":"away","force":true,"nonce":"0123456789abcdef"}';
  assert.equal(payload, `${body.slice(0, -1)},"sig":"${bodySignature(nodeKey, body)}"}`);
  assert.equal(payload.includes(',"nonce":"0123456789abcdef","sig":"'), true, "the nonce is the last field before the signature");
  assert.match(bodySignature(nodeKey, body), /^[0-9a-f]{64}$/);
  assert.deepEqual(splitSigned(payload), { body, sig: bodySignature(nodeKey, body) });
  assert.equal(SIGNATURE_PREFIX, "armor-command-v2|");
  if (process.env.ARMOR_PRINT_VECTOR) console.log(JSON.stringify({ node_id: "alarm-1", node_key: nodeKey, payload }));
});

test("a signed command verifies, and any change of its bytes, of the node it names or of the key does not", () => {
  const file = keyFile();
  const signer = new CommandSigner(file);
  assert.equal(fs.existsSync(file), false, "no key until the first command is signed");
  const payload = signer.sign(command);
  assert.equal(fs.readFileSync(file, "utf8").length, 64);
  assert.equal(signer.verify(payload), true);
  const forged = [payload.replace('"arm"', '"disarm"'), payload.replace("alarm-1", "alarm-2"), payload.replace("1000000", "1000001"), payload.replace('"away"', '"stay"'), payload.replace(/"nonce":"[0-9a-f]{16}"/, '"nonce":"0000000000000000"'),
    payload.replace(/"sig":"[0-9a-f]{64}"/, `"sig":"${"0".repeat(64)}"`), payload.replace(/"sig":"[0-9a-f]/, '"sig":"Z'), payload.replace(',"sig"', ',"extra":1,"sig"'), JSON.stringify(command), "", "{", payload + " "];
  for (const text of forged) assert.equal(signer.verify(text), false, text);
  assert.equal(signer.verify(null), false);
  assert.equal(signer.verify({ ...command }), false);
  const other = new CommandSigner(keyFile());
  other.sign(command);
  assert.equal(other.verify(payload), false, "another installation's key does not accept it");
  assert.equal(new CommandSigner(file).verify(payload), true, "and the key survives a restart");
});

test("a command is signed for the node it names, and one that names none, or a node that is not an id, is refused", () => {
  const signer = new CommandSigner(keyFile());
  assert.throws(() => signer.sign({ kind: "alarm_command" }), /names its node/);
  assert.throws(() => signer.nodeKey("Not An Id"), /not the id/);
  assert.throws(() => signer.nodeKey("../x"), /not the id/);
});

test("every signed command has its own nonce, so a replay of one is told apart from a new command", () => {
  const signer = new CommandSigner(keyFile());
  const nonces = new Set(Array.from({ length: 50 }, () => /"nonce":"([0-9a-f]{16})"/.exec(signer.sign(command))?.[1]));
  assert.equal(nonces.size, 50);
});

const alarmState: AlarmMessage = { kind: "alarm", node_id: "alarm-1", timestamp_ms: 1000, phase: "disarmed", mode: "disarmed", siren: false, locked_out: false, commands_enabled: true, zones: [], open_zones: [], events: [] };
const reading: ElectricalMessage = { kind: "electrical", node_id: "electrical-1", timestamp_ms: 1000, switching_enabled: true, channels: [],
  switches: [{ id: "transfer", kind: "transfer", a_closed: true, b_closed: false, selected: "a", wanted: "a", closing: false, armed: false, fault: "none" }] } as unknown as ElectricalMessage;

test("the alarm commands are published signed while the option is on, and plain when it is off", () => {
  const signer = new CommandSigner(keyFile());
  let required = true;
  const sent: string[] = [];
  const nodes = new AlarmStore({ now: () => 1_000_000 });
  nodes.ingest(alarmState);
  const service = new AlarmCommands({ enabled: true, nodes, audit: log, now: () => 1_000_000, publish: (_topic, payload) => { sent.push(payload); }, sign: body => (required ? signer.sign(body) : JSON.stringify(body)) });
  service.request("alarm-1", "arm", "away", false, "admin");
  assert.equal(signer.verify(sent[0]), true);
  const first = JSON.parse(sent[0]) as Record<string, unknown>;
  assert.equal(first.action, "arm");
  service.handleResult({ kind: "alarm_result", node_id: "alarm-1", timestamp_ms: 9, command_id: String(first.command_id), action: "arm", accepted: true, refusal: "none", phase: "exit_delay" }, "alarm-1");
  required = false;
  service.request("alarm-1", "disarm", undefined, false, "admin");
  const second = JSON.parse(sent[1]) as Record<string, unknown>;
  assert.equal("sig" in second || "nonce" in second, false);
});

test("the electrical commands are signed too, the switch included, and a signer that fails sends nothing", () => {
  const signer = new CommandSigner(keyFile());
  const sent: string[] = [];
  let broken = false;
  const nodes = new ElectricalStore({ now: () => 1_000_000 });
  nodes.ingest(reading);
  const audits: string[] = [];
  const service = new SwitchingService({ enabled: true, nodes, audit: { record: event => { audits.push(`${event.outcome}:${event.detail}`); } }, now: () => 1_000_000, publish: (_topic, payload) => { sent.push(payload); },
    sign: body => { if (broken) throw new Error("no key"); return signer.sign(body); } });
  service.request("electrical-1", "transfer", "open", "admin");
  assert.equal((JSON.parse(sent[0]) as { kind: string }).kind, "electrical_command");
  assert.equal(signer.verify(sent[0]), true);
  assert.equal(signer.verify(sent[0].replace('"transfer"', '"other"')), false, "the switch is signed over");
  broken = true;
  assert.throws(() => service.request("electrical-1", "transfer", "open", "admin"), { code: "signing_unavailable" });
  assert.equal(sent.length, 1, "a command that cannot be signed is not published");
  assert.ok(audits.some(item => item.startsWith("failed:")), audits.join(" | "));
});

test("an administrator reads the key of one node with its token, only while the option is on, and the master key is never in the answer", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const headers = { "content-type": "application/json", cookie: admin };
    const before = await (await fetch(`${running.base}/api/v1/admin/nodes/alarm-1/token`, { headers })).json() as Record<string, unknown>;
    assert.equal("command_key" in before, false);
    assert.equal((await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers, body: JSON.stringify({ "commands.require_sig": true }) })).status, 200);
    const response = await fetch(`${running.base}/api/v1/admin/nodes/alarm-1/token`, { headers });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const after = await response.json() as { command_key?: string };
    assert.match(after.command_key ?? "", /^[0-9a-f]{64}$/);
    const master = fs.readFileSync(path.join(running.config.dataDir, "command-signature.key"), "utf8").trim();
    assert.equal(after.command_key, nodeKeyOf(master, "alarm-1"));
    assert.notEqual(after.command_key, master);
    assert.equal(JSON.stringify(after).includes(master), false);
    const other = await (await fetch(`${running.base}/api/v1/admin/nodes/alarm-2/token`, { headers })).json() as { command_key?: string };
    assert.notEqual(other.command_key, after.command_key);
    const odd = await (await fetch(`${running.base}/api/v1/admin/nodes/a.b:c/token`, { headers })).json() as Record<string, unknown>;
    assert.equal("command_key" in odd, false, "an id a node cannot have gets no key");
  } finally { await running.stop(); }
});
