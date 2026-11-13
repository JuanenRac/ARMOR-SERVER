import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AuditLog } from "../src/audit.js";
import { AlarmCommands } from "../src/alarm_commands.js";
import { AlarmStore, type AlarmMessage } from "../src/alarm.js";
import { CommandSigner, canonicalJson, commandCanonical } from "../src/command_signature.js";
import { ElectricalStore, type ElectricalMessage } from "../src/electrical.js";
import { SwitchingService } from "../src/electrical_switching.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { tempDir } from "./helpers.js";

const command = { kind: "alarm_command", node_id: "alarm-1", timestamp_ms: 1_000_000, command_id: "c000000000000001", action: "arm", mode: "away", force: true };
const keyFile = (): string => path.join(tempDir(), "command-signature.key");
const log: AuditLog = { record: () => undefined };

test("the option is off by default and giving it up is a loss of protection", () => {
  assert.equal(SECURITY_DEFAULTS["commands.require_sig"], false);
  assert.equal(lowers("commands.require_sig", true, false), true);
  assert.equal(lowers("commands.require_sig", false, true), false);
});

test("the canonical form sorts every level, and the signed bytes name the kind, the node, the time, the command and the nonce", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: "é" } }), '{"a":{"c":"é","d":[3,{"x":2,"y":1}]},"b":1}');
  assert.equal(commandCanonical({ ...command, profile: { id: "p", base: "away" } }, "0123456789abcdef"),
    'armor-command|alarm_command|alarm-1|1000000|c000000000000001|0123456789abcdef|{"action":"arm","force":true,"mode":"away","profile":{"base":"away","id":"p"}}');
  assert.equal(commandCanonical({ ...command, sig: "x", nonce: "y" }, "0123456789abcdef"), commandCanonical(command, "0123456789abcdef"), "a signature already there is not signed over");
});

test("a signed command verifies, and any change of it, of its nonce or of its key does not", () => {
  const file = keyFile();
  const signer = new CommandSigner(file);
  assert.equal(fs.existsSync(file), false, "no key until the first command is signed");
  const signed = signer.sign(command);
  assert.match(signed.nonce, /^[0-9a-f]{16}$/);
  assert.match(signed.sig, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(file, "utf8").length, 64);
  assert.equal(signer.verify(signed), true);
  for (const forged of [{ ...signed, action: "disarm" }, { ...signed, node_id: "alarm-2" }, { ...signed, timestamp_ms: signed.timestamp_ms + 1 }, { ...signed, command_id: "c000000000000002" },
    { ...signed, mode: "stay" }, { ...signed, nonce: "0".repeat(16) }, { ...signed, sig: "0".repeat(64) }, { ...signed, sig: "zz" }, { ...signed, extra: 1 }, { ...command }, null, "text"]) {
    assert.equal(signer.verify(forged), false, JSON.stringify(forged));
  }
  const other = new CommandSigner(keyFile());
  other.sign(command);
  assert.equal(other.verify(signed), false, "another installation's key does not accept it");
  assert.equal(new CommandSigner(file).verify(signed), true, "and the key survives a restart");
});

test("every signed command has its own nonce, so a replay of one is told apart from a new command", () => {
  const signer = new CommandSigner(keyFile());
  const nonces = new Set(Array.from({ length: 50 }, () => signer.sign(command).nonce));
  assert.equal(nonces.size, 50);
});

const alarmState: AlarmMessage = { kind: "alarm", node_id: "alarm-1", timestamp_ms: 1000, phase: "disarmed", mode: "disarmed", siren: false, locked_out: false, commands_enabled: true, zones: [], open_zones: [], events: [] };
const reading: ElectricalMessage = { kind: "electrical", node_id: "electrical-1", timestamp_ms: 1000, switching_enabled: true, channels: [],
  switches: [{ id: "transfer", kind: "transfer", a_closed: true, b_closed: false, selected: "a", wanted: "a", closing: false, armed: false, fault: "none" }] } as unknown as ElectricalMessage;

test("the alarm commands are published signed while the option is on, and unsigned when it is off", () => {
  const signer = new CommandSigner(keyFile());
  let required = true;
  const sent: string[] = [];
  const nodes = new AlarmStore({ now: () => 1_000_000 });
  nodes.ingest(alarmState);
  const service = new AlarmCommands({ enabled: true, nodes, audit: log, now: () => 1_000_000, publish: (_topic, payload) => { sent.push(payload); }, sign: body => (required ? signer.sign(body) : body) });
  service.request("alarm-1", "arm", "away", false, "admin");
  const first = JSON.parse(sent[0]) as Record<string, unknown>;
  assert.equal(signer.verify(first), true);
  assert.equal(first.action, "arm");
  service.handleResult({ kind: "alarm_result", node_id: "alarm-1", timestamp_ms: 9, command_id: String(first.command_id), action: "arm", accepted: true, refusal: "none", phase: "exit_delay" }, "alarm-1");
  required = false;
  service.request("alarm-1", "disarm", undefined, false, "admin");
  const second = JSON.parse(sent[1]) as Record<string, unknown>;
  assert.equal("sig" in second || "nonce" in second, false);
});

test("the electrical commands are signed too, the token of a close included, and a signer that fails sends nothing", () => {
  const signer = new CommandSigner(keyFile());
  const sent: string[] = [];
  let broken = false;
  const nodes = new ElectricalStore({ now: () => 1_000_000 });
  nodes.ingest(reading);
  const audits: string[] = [];
  const service = new SwitchingService({ enabled: true, nodes, audit: { record: event => { audits.push(`${event.outcome}:${event.detail}`); } }, now: () => 1_000_000, publish: (_topic, payload) => { sent.push(payload); },
    sign: body => { if (broken) throw new Error("no key"); return signer.sign(body); } });
  service.request("electrical-1", "transfer", "open", "admin");
  const opened = JSON.parse(sent[0]) as Record<string, unknown>;
  assert.equal(opened.kind, "electrical_command");
  assert.equal(signer.verify(opened), true);
  assert.equal(signer.verify({ ...opened, switch: "other" }), false, "the switch is signed over");
  broken = true;
  assert.throws(() => service.request("electrical-1", "transfer", "open", "admin"), { code: "signing_unavailable" });
  assert.equal(sent.length, 1, "a command that cannot be signed is not published");
  assert.ok(audits.some(item => item.startsWith("failed:")), audits.join(" | "));
});
