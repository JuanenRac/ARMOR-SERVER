// The signed copy of an alarm state: the bytes are the ones the shared vectors of ARMOR-COMMON hold, the key is made only when it is needed, the copy is made only while the setting is on,
// and the server does not take its own copy as a new state.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseAlarmMessage, type AlarmMessage } from "../src/alarm.js";
import { AlarmStateSigner, alarmStateCanonical, alarmStateSignature } from "../src/alarm_state_signature.js";
import { routeMessage } from "../src/mqtt_router.js";
import { startServer, studioCookie, tempDir } from "./helpers.js";

const shared = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance", "signatures", "alarm_state.json");
const skip = fs.existsSync(shared) ? false : "ARMOR-COMMON is not checked out next to this repository";

type Shared = { key: string; cases: Array<{ name: string; message: AlarmMessage & { seq: number }; canonical: string; sig: string }>; tampered: Array<{ name: string; message: AlarmMessage & { seq: number }; sig: string }> };

test("the bytes and the signatures are the ones the shared vectors hold", { skip }, () => {
  const document = JSON.parse(fs.readFileSync(shared, "utf8")) as Shared;
  assert.ok(document.cases.length >= 5);
  for (const item of document.cases) {
    assert.equal(alarmStateCanonical(item.message, item.message.seq), item.canonical, item.name);
    assert.equal(alarmStateSignature(document.key, item.message, item.message.seq), item.sig, item.name);
  }
  for (const item of document.tampered) assert.notEqual(alarmStateSignature(document.key, item.message, item.message.seq), item.sig, item.name);
});

const state = (extra: Partial<AlarmMessage> = {}): AlarmMessage => ({
  kind: "alarm", node_id: "alarm-1", timestamp_ms: 1000, phase: "armed", mode: "away", siren: false, locked_out: false, commands_enabled: true,
  zones: [{ id: "front-door", kind: "entry", state: "normal", bypassed: false }], open_zones: [], events: [], ...extra,
});

test("the key is made the first time a state is signed, seq only goes up and the copy is recognised as its own", () => {
  const file = path.join(tempDir(), "alarm-state.key");
  let clock = 5000;
  const signer = new AlarmStateSigner(file, () => clock);
  assert.equal(fs.existsSync(file), false, "nothing is made before it is needed");
  assert.equal(signer.isOwn(state({ seq: 1, sig: "a".repeat(64) })), false);
  const first = signer.sign(state());
  assert.match(fs.readFileSync(file, "utf8").trim(), /^[0-9a-f]{64}$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0, "only the owner can read it");
  const second = signer.sign(state());
  assert.equal(first.seq, 5000);
  assert.equal(second.seq, 5001, "two states in the same millisecond still go up");
  clock = 9000;
  assert.equal(signer.sign(state()).seq, 9000);
  assert.equal(signer.isOwn(JSON.parse(JSON.stringify(first))), true);
  assert.equal(signer.isOwn({ ...first, phase: "disarmed" }), false, "an altered copy is not its own");
  assert.equal(signer.isOwn({ ...first, seq: first.seq + 1 }), false);
  assert.equal(new AlarmStateSigner(file).isOwn(first), true, "the key survives a restart");
  assert.equal(new AlarmStateSigner(path.join(tempDir(), "other.key")).isOwn(first), false, "another installation's copy is not its own");
  assert.equal(parseAlarmMessage(first).sig, first.sig, "the parser takes the signed form");
});

test("the parser takes seq and sig only together and in their form", () => {
  const sig = "a".repeat(64);
  assert.doesNotThrow(() => parseAlarmMessage({ ...state(), seq: 1, sig }));
  assert.throws(() => parseAlarmMessage({ ...state(), sig }), /come together/);
  assert.throws(() => parseAlarmMessage({ ...state(), seq: 1 }), /come together/);
  assert.throws(() => parseAlarmMessage({ ...state(), seq: -1, sig }), /seq/);
  assert.throws(() => parseAlarmMessage({ ...state(), seq: 1, sig: "A".repeat(64) }), /sig/);
  assert.throws(() => parseAlarmMessage({ ...state(), seq: 1, sig: "a".repeat(63) }), /sig/);
});

test("with the setting on the server publishes a signed copy of each state, never of a copy, and with it off nothing", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const context = running.app.context;
    const published: Array<[string, string]> = [];
    context.alarmLink.publish = (topic, payload) => { published.push([topic, payload]); };
    const put = (value: boolean) => fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ "server.alarm_state_signature": value }) });
    context.alarmNodes.ingest(state());
    assert.equal(published.filter(([topic]) => topic.endsWith("/state")).length, 0, "off by default: nothing is published");
    assert.equal(fs.existsSync(running.config.alarmStateKeyFile), false, "and no key is made");
    assert.equal((await put(true)).status, 200);
    published.length = 0;
    context.alarmNodes.ingest(state({ phase: "alarm", siren: true, zones: [{ id: "front-door", kind: "entry", state: "triggered", bypassed: false }], open_zones: ["front-door"] }));
    const copies = published.filter(([topic]) => topic === "armor/alarm/alarm-1/state");
    assert.equal(copies.length, 1);
    const copy = JSON.parse(copies[0]![1]) as AlarmMessage & { seq: number; sig: string };
    const key = fs.readFileSync(running.config.alarmStateKeyFile, "utf8").trim();
    assert.equal(copy.sig, alarmStateSignature(key, copy, copy.seq), "a reader with the key can verify it");
    assert.equal(copy.phase, "alarm");
    // the copy comes back from the broker: it is the server's own, so it neither becomes a state nor is copied again
    published.length = 0;
    assert.equal(context.alarmStateSigner.isOwn(copy), true);
    // the router: a state that is its own is taken without being parsed as a new one
    const ingested: AlarmMessage[] = [];
    const before = context.alarmNodes.list()[0]!.state;
    const table = [{ subscribe: ["armor/alarm/+/state"], named: (topic: string) => topic.split("/")[2], parse: parseAlarmMessage, fallback: "invalid alarm payload", matches: () => true,
      intercept: (body: unknown) => context.alarmStateSigner.isOwn(body), apply: (message: AlarmMessage) => { ingested.push(message); } }];
    assert.equal(routeMessage(table as never, { ok: () => undefined } as never, () => undefined, "armor/alarm/alarm-1/state", Buffer.from(JSON.stringify(copy))), true);
    assert.equal(ingested.length, 0);
    assert.equal(published.length, 0);
    assert.equal(context.alarmNodes.list()[0]!.state, before);
    // a state that already carries a signature is not copied
    context.alarmNodes.ingest({ ...state({ timestamp_ms: 2000 }), seq: 7, sig: "b".repeat(64) });
    assert.equal(published.length, 0);
    // off again
    assert.equal((await put(false)).status, 200);
    published.length = 0;
    context.alarmNodes.ingest(state({ timestamp_ms: 3000 }));
    assert.equal(published.filter(([topic]) => topic.endsWith("/state")).length, 0);
    // a broker that is not connected costs the copy and nothing else
    assert.equal((await put(true)).status, 200);
    context.alarmLink.publish = undefined;
    assert.doesNotThrow(() => context.alarmNodes.ingest(state({ timestamp_ms: 4000 })));
  } finally { await running.stop(); }
});
