// The orders to the nodes themselves, the battery orders and the policy of a panel, run through their services with the signer the option commands.sign_node_orders gives them:
// what is published carries the signature of the node it names, the policy carries none of the node id, and an order that cannot be signed is not sent.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AlarmZoneFeed } from "../src/alarm_zone_feed.js";
import type { AuditEvent, AuditLog } from "../src/audit.js";
import { BatteryWriteService } from "../src/battery_write.js";
import { CommandSigner, bodySignature, nodeKeyOf, splitSigned } from "../src/command_signature.js";
import { NodeControlService } from "../src/node_control_service.js";
import { NodeHealthStore, type NodeHealthMessage } from "../src/node_health.js";
import { SolarStore, type SolarBattery } from "../src/solar.js";
import { tempDir } from "./helpers.js";

const MASTER = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";   // a made-up key
const signerOf = (): CommandSigner => {
  const file = path.join(tempDir(), "command-signature.key");
  fs.writeFileSync(file, MASTER);
  return new CommandSigner(file);
};

test("an order to a node itself is signed with the key of that node, and one that cannot be signed is not sent", () => {
  const signer = signerOf();
  let clock = 1_800_000_000_000;
  let broken = false;
  const sent: Array<{ topic: string; payload: string }> = [];
  const audits: AuditEvent[] = [];
  const audit: AuditLog = { record: event => { audits.push(event); } };
  const health = new NodeHealthStore({ now: () => clock, remembered: () => undefined });
  const message: NodeHealthMessage = {
    kind: "node_health", node_id: "radar-1", timestamp_ms: 1000, family: "radar", firmware: "0.3.6", board: "s3-eth", uptime_s: 3600, reset_reason: "power_on", heap_free: 142_000, heap_min: 98_000, link: "ethernet",
    broker_reconnects: 1, low_stack_tasks: 0,
  } as unknown as NodeHealthMessage;
  health.ingest(message);
  const service = new NodeControlService({
    publish: (topic, payload) => { sent.push({ topic, payload }); }, audit, history: () => undefined, health: node => health.get(node), nodes: () => health.list(), now: () => clock,
    random: (() => { let n = 0; return () => `c${String(++n).padStart(15, "0")}`; })(),
    sign: command => { if (broken) throw new Error("no key"); return signer.sign(command); },
  });
  service.start({ scope: "node", operation: "diagnostics", mode: "now", actor: "ana", targets: [{ id: "radar-1", family: "radar" }] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.topic, "armor/control/radar-1/command");
  assert.equal(signer.verify(sent[0]!.payload), true, "the arm is signed");
  const parts = splitSigned(sent[0]!.payload);
  assert.ok(parts);
  assert.equal(parts.sig, bodySignature(nodeKeyOf(MASTER, "radar-1"), parts.body), "with the key of the node it names");
  assert.equal(signer.verify(sent[0]!.payload.replace("radar-1", "radar-2")), false, "the node is signed over");
  assert.equal((JSON.parse(sent[0]!.payload) as { action: string }).action, "arm");
  clock += 5000;
  broken = true;
  const before = sent.length;
  try { service.start({ scope: "node", operation: "diagnostics", mode: "now", actor: "ana", targets: [{ id: "radar-1", family: "radar" }] }); } catch { /* a refused start is also a way of not sending */ }
  assert.equal(sent.length, before, "an order that cannot be signed leaves nothing on the broker");
});

const battery = (): SolarBattery => ({ kind: "battery", node_id: "solar-1", device: "pack", timestamp_ms: 1, modules: 1, voltage_v: 51, current_a: 0, stack: [] } as unknown as SolarBattery);

test("a battery order is signed with the key of its node in every message of its way, and one that cannot be signed is not sent", () => {
  const signer = signerOf();
  let broken = false;
  const sent: Array<{ topic: string; payload: string }> = [];
  const solar = new SolarStore({ now: () => 1_000_000 });
  solar.ingest(battery());
  let counter = 0;
  const service = new BatteryWriteService({
    enabled: true, solar, audit: { record: () => undefined }, now: () => 1_000_000, random: () => `c${String(++counter).padStart(15, "0")}`, pieceWaitMs: 5000,
    publish: (topic, payload) => { sent.push({ topic, payload }); },
    sign: command => { if (broken) throw new Error("no key"); return signer.sign(command); },
  });
  const order = { node: "solar-1", port: 2, op: "output_set", params: { output: "cfet", state: "off" }, serial: "PPTBH00000000001" };
  service.arm("ana", order as never);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.topic, "armor/solar/solar-1/maintenance/command");
  assert.equal(signer.verify(sent[0]!.payload), true);
  const parts = splitSigned(sent[0]!.payload);
  assert.ok(parts);
  assert.equal(parts.sig, bodySignature(nodeKeyOf(MASTER, "solar-1"), parts.body));
  assert.equal(signer.verify(sent[0]!.payload.replace('"cfet"', '"dfet"')), false, "the parameters are signed over");
  broken = true;
  const before = sent.length;
  try { service.arm("ana", { ...order, port: 3 } as never); } catch { /* refused */ }
  assert.equal(sent.length, before, "an order that cannot be signed is not sent");
});

test("the policy of a panel is signed for each panel without its id in the body, and a panel that cannot be signed for is skipped with a warning", () => {
  const signer = signerOf();
  const sent: Array<{ topic: string; payload: string }> = [];
  const warnings: string[] = [];
  const policy = { config_hash: true, zone_feed: false, zone_feed_signature: false };
  const feed = new AlarmZoneFeed(path.join(tempDir(), "zone-links.json"), {
    publish: (topic, payload) => { sent.push({ topic, payload }); }, devices: () => [], now: () => 0, warn: message => { warnings.push(message); },
    policy: () => policy as never, panels: () => ["alarm-1", "Not A Node"],
    signPolicy: (node, message) => signer.signFor(node, message),
  });
  feed.publishPolicy();
  assert.equal(sent.length, 1, "the panel whose id cannot hold a key gets nothing");
  assert.equal(sent[0]!.topic, "armor/alarm/alarm-1/policy");
  const parts = splitSigned(sent[0]!.payload);
  assert.ok(parts);
  assert.equal(parts.sig, bodySignature(nodeKeyOf(MASTER, "alarm-1"), parts.body));
  assert.equal(sent[0]!.payload.includes("node_id"), false, "the contract of the policy has no node id");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /alarm policy/);
});
