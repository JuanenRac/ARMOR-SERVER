// The diagnostics of the nodes: how a node says it started badly and what its sensors are (health), the events of a radar node's perimeter engine, the diagnostic package a node delivers (and that
// no secret is in it), the read-only diagnostic token (expiry, revocation, scope, hash at rest, rate limits, audit) and the routes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AuditEvent } from "../src/audit.js";
import { bearerOf, DiagnosticError, DiagnosticTokens, hashToken, readTokenRequest, TTL_DEFAULT_S, TTL_MAX_S } from "../src/diagnostic_tokens.js";
import { parseControlResult } from "../src/node_control.js";
import { parseDiagnosticPackage, washCredentials } from "../src/node_diag_contract.js";
import { NodeHealthStore, parseNodeHealth, type NodeHealthMessage } from "../src/node_health.js";
import { parseRadarEvent, radarEventTopic, RadarEventStore } from "../src/radar_events.js";
import { SECRETS, startServer, studioCookie, tempDir } from "./helpers.js";

const directory = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance");
type Vector = { name: string; valid: boolean; payload: unknown };
const vectors = (kind: string): Vector[] => (JSON.parse(fs.readFileSync(path.join(directory, `${kind}.json`), "utf8")) as { vectors: Vector[] }).vectors;
const skip = fs.existsSync(path.join(directory, "radar_event.json")) ? false : "ARMOR-COMMON is not checked out next to this repository";

test("radar events, the token request and the diagnostic package agree with every shared conformance vector", { skip }, () => {
  for (const [kind, parse] of [["radar_event", parseRadarEvent], ["diagnostic_token_request", readTokenRequest]] as const) {
    const all = vectors(kind);
    assert.ok(all.length >= 14, kind);
    for (const vector of all) {
      if (vector.valid) assert.doesNotThrow(() => parse(vector.payload), `${kind} should accept: ${vector.name}`);
      else assert.throws(() => parse(vector.payload), `${kind} should reject: ${vector.name}`);
    }
  }
  // the answers to a diagnostics order that carry a package: the package is read as the contract says
  let packages = 0;
  for (const vector of vectors("node_control_result")) {
    const diagnostics = (vector.payload as { diagnostics?: { package?: unknown } } | null)?.diagnostics;
    if (!diagnostics || !("package" in diagnostics)) continue;
    packages += 1;
    if (vector.valid) assert.doesNotThrow(() => parseControlResult(vector.payload), `should accept: ${vector.name}`);
    else assert.throws(() => parseControlResult(vector.payload), `should reject: ${vector.name}`);
  }
  assert.ok(packages >= 8);
});

test("the objects the server answers carry exactly the members of the shared schemas, never a secret or a hash in the list", { skip }, () => {
  const schemaDir = path.resolve(directory, "..", "src", "armor_common", "schemas");
  const schema = (name: string) => JSON.parse(fs.readFileSync(path.join(schemaDir, `${name}.schema.json`), "utf8")) as { required: string[]; properties: Record<string, unknown> };
  const tokens = new DiagnosticTokens({ audit: { record: () => undefined } });
  const created = tokens.issue({ nodes: ["radar-1"], ttl_s: 600, label: "support" }, "ana");
  const info = tokens.list()[0];
  for (const [name, object] of [["diagnostic_token_created", created], ["diagnostic_token_info", info]] as const) {
    const shape = schema(name);
    for (const key of Object.keys(object)) assert.ok(key in shape.properties, `${name}: ${key} is not in the schema`);
    for (const key of shape.required) assert.ok(key in object, `${name}: ${key} is missing`);
  }
  assert.match(created.token, /^armor-diag-[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(info).includes(created.token) && !JSON.stringify(info).includes(hashToken(created.token)));
});

// ---- the health report: how the last run ended, the gate, the core dump, the sensors ------------------------------------------------------------------------

const report = (extra: Partial<NodeHealthMessage> = {}): NodeHealthMessage => ({
  kind: "node_health", node_id: "radar-1", timestamp_ms: 1000, family: "radar", firmware: "0.7.9", board: "s3-eth", uptime_s: 60, reset_reason: "panic", heap_free: 142_000, heap_min: 98_000, link: "ethernet", link_up: true,
  broker_reconnects: 1, low_stack_tasks: 0, ...extra,
});
const BOOT = { cause: "panic", reset_reason: "panic", uptime_before_s: 4200, heap_internal_free: 52_000, heap_internal_largest: 30_000, coredump: true, deliberate: false, guard: false } as const;
const SENSOR = { sensor_id: 1, model: "ld2450", state: "reporting", firmware_known: true, firmware: "1.02.22062416", bluetooth: "closed" } as const;
const FACTS = { perimeter_enabled: true, masked: false, wifi_jam: false, bridge_open: false, events_buffered: 0, sensor_bluetooth_off: true };

test("a report may carry how the last run ended, the memory gate, the core dump, the checks of the settings and the sensors", () => {
  const full = report({ boot: { ...BOOT }, memory_gate: { closed: false, transitions: 2, close_free: 28_672, close_block: 12_288, open_free: 40_960, open_block: 16_384 }, coredump: { present: true, size: 41_000 },
    config_check: { snapshot: "restored" }, sensors: [{ ...SENSOR }], radar: { ...FACTS } });
  assert.doesNotThrow(() => parseNodeHealth(full));
  const bad: Array<[string, Partial<NodeHealthMessage>]> = [
    ["a cause outside the list", { boot: { ...BOOT, cause: "cosmic_ray" as never } }],
    ["a stack in the boot report", { boot: { ...BOOT, stack: "x" } as never }],
    ["a boot block over the free memory", { boot: { ...BOOT, heap_internal_largest: 99_000 } }],
    ["a size for a dump that is not there", { coredump: { present: false, size: 5 } }],
    ["sensors without the facts", { sensors: [{ ...SENSOR }] }],
    ["sensors on an alarm node", { family: "alarm", sensors: [{ ...SENSOR }], radar: { ...FACTS } }],
    ["a sensor told twice", { sensors: [{ ...SENSOR }, { ...SENSOR }], radar: { ...FACTS } }],
    ["an address while the Bluetooth is closed", { sensors: [{ ...SENSOR, mac: "AA:BB:CC:DD:EE:FF" }], radar: { ...FACTS } }],
    ["a firmware that is not known", { sensors: [{ ...SENSOR, firmware_known: false }], radar: { ...FACTS } }],
    ["a model outside the list", { sensors: [{ ...SENSOR, model: "ld9999" as never }], radar: { ...FACTS } }],
    ["a free text in a sensor", { sensors: [{ ...SENSOR, note: "x" } as never], radar: { ...FACTS } }],
  ];
  for (const [name, change] of bad) assert.throws(() => parseNodeHealth(report(change)), Error, name);
});

test("a dirty start is told once, kept in the log of restarts with what the node said, and a clean one says nothing", () => {
  let clock = 1_800_000_000_000;
  const told: string[] = [];
  const store = new NodeHealthStore({ now: () => clock, onDirtyBoot: (node, _family, firmware, boot) => told.push(`${node} ${firmware} ${boot.cause}`) });
  store.ingest(report({ timestamp_ms: 1, boot: { ...BOOT } }));
  clock += 60_000;
  store.ingest(report({ timestamp_ms: 2, uptime_s: 120, boot: { ...BOOT } }));
  assert.deepEqual(told, ["radar-1 0.7.9 panic"]);
  const detail = store.get("radar-1");
  assert.equal(detail?.restarts.length, 1);
  assert.equal(detail?.restarts[0].boot?.cause, "panic");
  assert.equal(detail?.restarts[0].boot?.coredump, true);
  assert.equal(detail?.restarts[0].uptime_before_s, 4200);
  assert.ok(detail?.warnings.some(warning => warning.code === "node_frequent_resets"), "a crash is a warning");
  // a server that comes up after the restart (the node is older than two minutes) still keeps the dirty start
  const late = new NodeHealthStore({ now: () => clock, onDirtyBoot: (node) => told.push(`late ${node}`) });
  late.ingest(report({ timestamp_ms: 3, uptime_s: 400, boot: { ...BOOT, cause: "guard_low_memory", reset_reason: "software", guard: true } }));
  assert.equal(told.at(-1), "late radar-1");
  assert.equal(late.get("radar-1")?.restarts[0].boot?.cause, "guard_low_memory");
  // a clean start: no boot member, no dirty start
  const clean = new NodeHealthStore({ now: () => clock, onDirtyBoot: () => told.push("clean?") });
  clean.ingest(report({ timestamp_ms: 4, reset_reason: "power_on" }));
  assert.ok(!told.includes("clean?"));
  assert.equal(clean.get("radar-1")?.restarts[0]?.boot, undefined);
  // what a restart of the server keeps
  const again = new NodeHealthStore({ now: () => clock });
  again.import(JSON.parse(JSON.stringify(store.export())));
  assert.equal(again.get("radar-1")?.restarts[0].boot?.cause, "panic");
  const damaged = JSON.parse(JSON.stringify(store.export()));
  damaged.nodes["radar-1"].restarts[0].boot = { cause: "nonsense" };
  const hurt = new NodeHealthStore({ now: () => clock });
  hurt.import(damaged);
  assert.equal(hurt.get("radar-1")?.restarts[0].boot, undefined, "a damaged detail loses only itself");
});

test("a sensor whose own Bluetooth is open raises a warning while it lasts; a covered radar and a jammed network do too", () => {
  let clock = 1_800_000_000_000;
  const store = new NodeHealthStore({ now: () => clock });
  const codes = () => (store.get("radar-1")?.warnings ?? []).map(warning => warning.code);
  store.ingest(report({ timestamp_ms: 1, reset_reason: "power_on", uptime_s: 5000, sensors: [{ ...SENSOR, bluetooth: "open", mac: "8F:27:2E:B8:0F:65", bluetooth_alert: true }], radar: { ...FACTS } }));
  assert.ok(codes().includes("node_sensor_bluetooth_open"));
  const warning = store.get("radar-1")?.warnings.find(item => item.code === "node_sensor_bluetooth_open");
  assert.equal(warning?.detail.sensors, "1");
  assert.ok(!JSON.stringify(warning).includes("8F:27"), "the address of the sensor is not in the warning");
  clock += 60_000;
  store.ingest(report({ timestamp_ms: 2, reset_reason: "power_on", uptime_s: 5060, sensors: [{ ...SENSOR }], radar: { ...FACTS } }));
  assert.ok(!codes().includes("node_sensor_bluetooth_open"));
  // open with the rule to keep it closed: a warning even if the node did not flag it; open on a node whose rule allows it: none
  clock += 60_000;
  store.ingest(report({ timestamp_ms: 3, reset_reason: "power_on", uptime_s: 5120, sensors: [{ ...SENSOR, bluetooth: "open", mac: "8F:27:2E:B8:0F:65" }], radar: { ...FACTS } }));
  assert.ok(codes().includes("node_sensor_bluetooth_open"));
  clock += 60_000;
  store.ingest(report({ timestamp_ms: 4, reset_reason: "power_on", uptime_s: 5180, sensors: [{ ...SENSOR, bluetooth: "open", mac: "8F:27:2E:B8:0F:65" }], radar: { ...FACTS, sensor_bluetooth_off: false } }));
  assert.ok(!codes().includes("node_sensor_bluetooth_open"));
  clock += 60_000;
  store.ingest(report({ timestamp_ms: 5, reset_reason: "power_on", uptime_s: 5240, sensors: [{ ...SENSOR }], radar: { ...FACTS, masked: true, wifi_jam: true } }));
  assert.ok(codes().includes("node_radar_masked") && codes().includes("node_wifi_jam"));
});

// ---- the events of the perimeter engine ---------------------------------------------------------------------------------------------------------------------

test("the topic of a radar event names a node and nothing else", () => {
  assert.equal(radarEventTopic("armor/radar/radar-1/events"), "radar-1");
  for (const topic of ["armor/radar/Radar/events", "armor/radar/radar-1/control/armed", "armor/radar/radar-1", "armor/node/radar-1/events", "armor/radar/a/b/events"]) assert.equal(radarEventTopic(topic), undefined, topic);
});

test("an event is kept once however many times the node sends it, the newest first, and the store is bounded", () => {
  let clock = 1_800_000_000_000;
  const news: string[] = [];
  const store = new RadarEventStore({ now: () => clock, perNode: 3, maxNodes: 2, onNew: event => news.push(`${event.event}#${event.seq}`) });
  const event = (seq: number, extra: Record<string, unknown> = {}) => parseRadarEvent({ kind: "radar_event", node_id: "radar-1", timestamp_ms: 0, boot: 7, seq, event: "masking", value: 10, ...extra });
  assert.equal(store.ingest(event(1)), true);
  assert.equal(store.ingest(event(1)), false, "the same start and sequence number again");
  assert.equal(store.ingest(parseRadarEvent({ kind: "radar_event", node_id: "radar-1", timestamp_ms: 0, boot: 8, seq: 1, event: "masking_end" })), true, "another start counts from one again");
  for (const seq of [2, 3, 4]) { clock += 1000; store.ingest(event(seq)); }
  assert.deepEqual(news, ["masking#1", "masking_end#1", "masking#2", "masking#3", "masking#4"]);
  assert.equal(store.list("radar-1").length, 3);
  assert.equal(store.list("radar-1")[0].seq, 4);
  store.ingest(parseRadarEvent({ kind: "radar_event", node_id: "radar-2", timestamp_ms: 0, boot: 1, seq: 1, event: "wifi_jam" }));
  assert.throws(() => store.ingest(parseRadarEvent({ kind: "radar_event", node_id: "radar-3", timestamp_ms: 0, boot: 1, seq: 1, event: "wifi_jam" })), /too many nodes/);
  assert.deepEqual(store.nodes(), ["radar-1", "radar-2"]);
  store.remove("radar-1");
  assert.deepEqual(store.nodes(), ["radar-2"]);
});

test("an event has no free text, and every member belongs to the events that can carry it", () => {
  const base = { kind: "radar_event", node_id: "radar-1", timestamp_ms: 0, boot: 1, seq: 1, event: "tripwire" };
  assert.doesNotThrow(() => parseRadarEvent({ ...base, direction: "in", count: 3, name: "gate" }));
  assert.throws(() => parseRadarEvent({ ...base, text: "hello" }), /unknown|not/i);
  assert.throws(() => parseRadarEvent({ ...base, event: "zone_occupied", direction: "in" }));
  assert.throws(() => parseRadarEvent({ ...base, event: "zone_occupied", by: "ana" }));
  assert.throws(() => parseRadarEvent({ ...base, event: "sensor_bluetooth_open" }));
  assert.throws(() => parseRadarEvent({ ...base, name: "x".repeat(25) }));
  assert.throws(() => parseRadarEvent({ ...base, event: "bridge_opened", sensor_id: 1, by: "ana maria" }));
});

// ---- the package --------------------------------------------------------------------------------------------------------------------------------------------

const PACKAGE = {
  detail: "package",
  heap: { internal_free: 90_000, internal_min: 70_000, internal_largest: 60_000, total_free: 5_000_000, total_min: 4_000_000, psram_free: 4_900_000 },
  tasks: [{ name: "radar", stack_free: 900, priority: 5, state: "R" }],
  resets: { reason: "panic", uptime_s: 4242, guard_restarts_in_hour: 1 },
  boot: { ...BOOT },
  versions: { firmware: "0.7.9", idf: "v5.5.1", board: "s3-eth", sensors: [{ name: "ld2450-1", version: "V1.02.22062416" }] },
  config: { "wifi.mode": "station", "mqtt.heartbeat_s": "30" },
  coredump: { present: true, size: 41_000, summary: { task: "radar", pc: "0x4200abcd", backtrace: ["0x4200abcd"] } },
  log: "I (100) mqtt: connecting\nW (200) wifi: password=***\n",
  truncated: false,
};

test("the package is read member by member: a member a node adds on its own, or a setting that is not text, number or flag, is refused", () => {
  assert.doesNotThrow(() => parseDiagnosticPackage(PACKAGE));
  assert.doesNotThrow(() => parseDiagnosticPackage({ detail: "log", log: "x", truncated: false }));
  for (const [name, change] of [
    ["a password member", { password: "hunter2" }], ["a member inside the heap", { heap: { ...PACKAGE.heap, secret: 1 } }], ["a setting that is an object", { config: { "wifi.mode": { password: "x" } } }],
    ["a setting with a strange name", { config: { "a b": "x" } }], ["a log that is not text", { log: 5 }], ["a log of forty thousand characters", { log: "x".repeat(40_000) }], ["more tasks than the node keeps", { tasks: Array.from({ length: 41 }, (_, i) => ({ name: `t${i}`, stack_free: 1, priority: 1, state: "B" })) }],
    ["an address that is not one", { coredump: { present: true, summary: { task: "radar", pc: "pc=main" } } }], ["a heap that contradicts itself", { heap: { ...PACKAGE.heap, internal_min: 99_000 } }],
  ] as const) assert.throws(() => parseDiagnosticPackage({ ...PACKAGE, ...change }), Error, name);
  assert.throws(() => parseDiagnosticPackage({ detail: "log", log: "x", truncated: false, heap: PACKAGE.heap }), /carries no/);
});

test("the second wash takes out what looks like a credential, an address with a user and a long run of digits", () => {
  const text = washCredentials("password=abc123 token: zzz9 authorization: Bearer qqq1 mqtts://user:pw@broker:8883 key deadbeefdeadbeefdeadbeefdeadbeefdeadbeef and the pass of the day");
  for (const secret of ["abc123", "zzz9", "qqq1", "user:pw", "deadbeefdeadbeef"]) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes("the pass of the day"), "an ordinary sentence is left as it is");
  assert.ok(text.includes("broker:8883"));
});

// ---- the token ----------------------------------------------------------------------------------------------------------------------------------------------

function tokenBench(options: { perMinute?: number; maxActive?: number; file?: string } = {}) {
  let clock = 1_800_000_000_000;
  const audit: AuditEvent[] = [];
  let counter = 1;
  const random = (bytes: number): Buffer => Buffer.alloc(bytes, counter++ % 250 + 1);
  const make = (file = options.file) => new DiagnosticTokens({ file, now: () => clock, random, audit: { record: event => audit.push(event) }, perMinute: options.perMinute, maxActive: options.maxActive });
  return { tokens: make(), make, audit, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

test("a request for a token is read strictly: the nodes, the time (two hours by default, a day at most) and a plain label", () => {
  assert.deepEqual(readTokenRequest({ nodes: ["radar-1"] }), { nodes: ["radar-1"], ttl_s: TTL_DEFAULT_S });
  assert.equal(TTL_DEFAULT_S, 7200);
  assert.equal(TTL_MAX_S, 86_400);
  assert.equal(readTokenRequest({ nodes: ["a", "b"], ttl_s: 86_400, label: "support team" }).ttl_s, 86_400);
  const code = (body: unknown): string | undefined => { try { readTokenRequest(body); } catch (error) { return error instanceof DiagnosticError ? error.code : "other"; } return undefined; };
  for (const body of [null, [], "x", {}, { nodes: [] }, { nodes: ["radar-1", "radar-1"] }, { nodes: ["all"] }, { nodes: ["Radar"] }, { nodes: [1] }, { nodes: Array.from({ length: 17 }, (_, i) => `n${i}`) },
    { nodes: ["radar-1"], ttl_s: 299 }, { nodes: ["radar-1"], ttl_s: 86_401 }, { nodes: ["radar-1"], ttl_s: 600.5 }, { nodes: ["radar-1"], ttl_s: "600" }, { nodes: ["radar-1"], label: "x".repeat(49) }, { nodes: ["radar-1"], label: "a\nb" },
    { nodes: ["radar-1"], scope: "admin" }, { nodes: ["radar-1"], role: "admin" }]) assert.equal(code(body), "invalid_request", JSON.stringify(body));
});

test("the secret is shown once and only its hash is kept, in memory and in the file", () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  const bench = tokenBench({ file });
  const created = bench.tokens.issue({ nodes: ["radar-1", "solar-1"], ttl_s: 600, label: "support" }, "ana");
  assert.match(created.token, /^armor-diag-[A-Za-z0-9_-]{43}$/);
  assert.equal(created.scope, "read_only");
  const written = fs.readFileSync(file, "utf8");
  assert.ok(!written.includes(created.token), "the secret is not in the file");
  assert.ok(!written.includes(created.token.slice(11)), "nor is the part after the prefix");
  assert.ok(written.includes(hashToken(created.token)), "its hash is");
  for (const line of bench.audit) assert.ok(!JSON.stringify(line).includes(created.token.slice(11)), "the audit trail never carries the secret");
  assert.ok(!JSON.stringify(bench.tokens.list()).includes(created.token.slice(11)));
  assert.ok(!JSON.stringify(bench.tokens.list()).includes(hashToken(created.token)));
  // a restart of the server keeps the token valid without ever having the secret
  const second = bench.make(file);
  assert.deepEqual(second.verify(created.token, "radar-1"), { ok: true, id: created.id, nodes: ["radar-1", "solar-1"] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a token expires, can be revoked, covers only its nodes and cannot be guessed", () => {
  const bench = tokenBench();
  const created = bench.tokens.issue({ nodes: ["radar-1"], ttl_s: 600 }, "ana");
  assert.equal(created.expires_at, new Date(bench.now() + 600_000).toISOString());
  assert.equal(bench.tokens.verify(created.token, "radar-1").ok, true);
  assert.deepEqual(bench.tokens.verify(created.token, "solar-1"), { ok: false, reason: "scope" });
  assert.deepEqual(bench.tokens.verify(created.token.slice(0, -1) + (created.token.endsWith("A") ? "B" : "A"), "radar-1"), { ok: false, reason: "unknown" });
  assert.deepEqual(bench.tokens.verify("armor-diag-" + "A".repeat(43), "radar-1"), { ok: false, reason: "unknown" });
  assert.deepEqual(bench.tokens.verify("hunter2", "radar-1"), { ok: false, reason: "unknown" });
  assert.deepEqual(bench.tokens.verify(undefined, "radar-1"), { ok: false, reason: "unknown" });
  bench.advance(599_000);
  assert.equal(bench.tokens.verify(created.token, "radar-1").ok, true);
  bench.advance(2000);
  assert.deepEqual(bench.tokens.verify(created.token, "radar-1"), { ok: false, reason: "expired" });
  assert.equal(bench.tokens.list()[0].status, "expired");
  // a second token, revoked at once
  const other = bench.tokens.issue({ nodes: ["radar-1"] }, "ana");
  assert.equal(bench.tokens.revoke(other.id, "ana"), true);
  assert.deepEqual(bench.tokens.verify(other.token, "radar-1"), { ok: false, reason: "revoked" });
  assert.equal(bench.tokens.revoke(other.id, "ana"), false, "an ended token is not revoked twice");
  assert.equal(bench.tokens.revoke("zzzz", "ana"), false);
  const line = bench.tokens.list().find(item => item.id === other.id);
  assert.equal(line?.status, "revoked");
  assert.equal(line?.revoked_by, "ana");
  // the audit trail tells what happened to each, without a secret
  const actions = bench.audit.map(entry => `${entry.action}:${entry.outcome}`);
  for (const wanted of ["diagnostics.token_issue:allowed", "diagnostics.token_revoke:allowed", "diagnostics.token_revoke:failed", "diagnostics.token_denied:denied", "diagnostics.token_use:allowed"]) assert.ok(actions.includes(wanted), wanted);
});

test("a token is held back after thirty requests in a minute, there are at most twenty at a time, and what ended is forgotten after a week", () => {
  const bench = tokenBench({ perMinute: 30, maxActive: 3 });
  const created = bench.tokens.issue({ nodes: ["radar-1"], ttl_s: 3600 }, "ana");
  for (let i = 0; i < 30; i += 1) assert.equal(bench.tokens.verify(created.token, "radar-1").ok, true, String(i));
  assert.deepEqual(bench.tokens.verify(created.token, "radar-1"), { ok: false, reason: "rate_limited" });
  bench.advance(61_000);
  assert.equal(bench.tokens.verify(created.token, "radar-1").ok, true);
  assert.equal(bench.tokens.list()[0].uses, 31);
  bench.tokens.issue({ nodes: ["radar-1"] }, "ana");
  bench.tokens.issue({ nodes: ["radar-1"] }, "ana");
  assert.throws(() => bench.tokens.issue({ nodes: ["radar-1"] }, "ana"), (error: unknown) => error instanceof DiagnosticError && error.code === "too_many_tokens");
  bench.advance(8 * 24 * 3_600_000);
  assert.equal(bench.tokens.list().length, 0, "tokens that ended a week ago are gone");
  bench.tokens.issue({ nodes: ["radar-1"] }, "ana");
});

test("a damaged file loses only the damaged token, and a token that claims to live longer than a day is not believed", () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  const bench = tokenBench({ file });
  const good = bench.tokens.issue({ nodes: ["radar-1"], ttl_s: 3600 }, "ana");
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { schema: number; tokens: Array<Record<string, unknown>> };
  const forged = { ...saved.tokens[0], id: "ffffffffffff", hash: "f".repeat(64), expires_at: new Date(bench.now() + 30 * 24 * 3_600_000).toISOString() };
  const broken = { ...saved.tokens[0], id: "eeeeeeeeeeee", hash: "not a hash" };
  fs.writeFileSync(file, JSON.stringify({ schema: 1, tokens: [saved.tokens[0], forged, broken, 7, null] }));
  const reloaded = bench.make(file);
  assert.deepEqual(reloaded.list().map(item => item.id), [good.id]);
  fs.writeFileSync(file, "{not json");
  assert.equal(bench.make(file).list().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the token travels in the Authorization header and nowhere else", () => {
  const token = "armor-diag-" + "A".repeat(43);
  assert.equal(bearerOf(`Bearer ${token}`), token);
  for (const header of [undefined, "", token, `Basic ${token}`, `bearer ${token}`, "Bearer armor-diag-short", "Bearer " + "A".repeat(43)]) assert.equal(bearerOf(header), undefined, String(header));
});

// ---- the routes ---------------------------------------------------------------------------------------------------------------------------------------------

async function bench() {
  let clock = 1_800_000_000_000;
  const running = await startServer({}, { now: () => clock });
  const { context } = running.app;
  const published: Array<{ topic: string; message: Record<string, unknown> }> = [];
  context.controlLink.publish = (topic, payload) => { published.push({ topic, message: JSON.parse(payload) as Record<string, unknown> }); };
  let stamp = 5000;
  for (const [id, family] of [["radar-1", "radar"], ["solar-1", "solar"], ["alarm-1", "alarm"]] as const) {
    context.nodeHealth.ingest({ kind: "node_health", node_id: id, timestamp_ms: stamp++, family, firmware: "0.7.9", board: "s3-eth", uptime_s: 5000, reset_reason: "power_on", heap_free: 142_000, heap_min: 98_000,
      link: "ethernet", link_up: true, broker_reconnects: 1, last_error: id === "radar-1" ? "mqtt: password=hunter2 refused" : undefined, control_by: "ana" } as NodeHealthMessage);
  }
  const cookie = await studioCookie(running.base);
  const send = (method: string, url: string, body?: unknown, headers: Record<string, string> = { cookie }) =>
    fetch(`${running.base}${url}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const elevate = async () => assert.equal((await send("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD })).status, 200);
  const answer = (over: Record<string, unknown>) => context.nodeControl.handleResult(parseControlResult({ kind: "node_control_result", timestamp_ms: 9, accepted: true, refusal: "none", ...over }), String(over.node_id));
  const events = () => context.events.list({ everything: true, limit: 200, order: "asc" }).filter(event => event.type === "system");
  const audit = () => fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
  return { running, context, published, cookie, send, elevate, answer, events, audit, advance: (ms: number) => { clock += ms; } };
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const codeOf = async (response: Response): Promise<[number, string | undefined]> => [response.status, ((await response.json()) as { code?: string }).code];

test("only an administrator with a fresh proof issues a token; the list and the revocation are for administrators; the History tells it all", async () => {
  const b = await bench();
  try {
    const operator = bearer(SECRETS.ARMOR_OPERATOR_TOKEN);
    assert.equal((await b.send("POST", "/api/v1/diagnostics/tokens", { nodes: ["radar-1"] }, {})).status, 401);
    assert.equal((await b.send("POST", "/api/v1/diagnostics/tokens", { nodes: ["radar-1"] }, operator)).status, 401);
    assert.equal((await b.send("GET", "/api/v1/diagnostics/tokens", undefined, operator)).status, 401);
    assert.deepEqual(await codeOf(await b.send("POST", "/api/v1/diagnostics/tokens", { nodes: ["radar-1"] })), [403, "elevation_required"]);
    await b.elevate();
    assert.deepEqual(await codeOf(await b.send("POST", "/api/v1/diagnostics/tokens", { nodes: ["radar-1"], ttl_s: 10 })), [400, "invalid_request"]);
    assert.deepEqual(await codeOf(await b.send("POST", "/api/v1/diagnostics/tokens", { nodes: ["radar-9"] })), [404, "unknown_node"]);
    const made = await b.send("POST", "/api/v1/diagnostics/tokens", { nodes: ["radar-1", "solar-1"], label: "support" });
    assert.equal(made.status, 201);
    const created = (await made.json()) as { id: string; token: string; scope: string; expires_at: string };
    assert.equal(created.scope, "read_only");
    assert.equal(Date.parse(created.expires_at) - 1_800_000_000_000, 7_200_000, "two hours when the request says nothing");
    const list = await (await b.send("GET", "/api/v1/diagnostics/tokens")).json() as { tokens: Array<Record<string, unknown>> };
    assert.equal(list.tokens.length, 1);
    assert.ok(!JSON.stringify(list).includes(created.token.slice(11)) && !JSON.stringify(list).includes(hashToken(created.token)));
    assert.equal((await b.send("DELETE", "/api/v1/diagnostics/tokens/" + created.id, undefined, operator)).status, 401);
    assert.equal((await b.send("DELETE", "/api/v1/diagnostics/tokens/" + created.id)).status, 204);
    assert.deepEqual(await codeOf(await b.send("DELETE", "/api/v1/diagnostics/tokens/" + created.id)), [404, "not_found"]);
    const words = b.events().map(event => (event as { action?: string }).action);
    assert.ok(words.includes("diagnostic_token_issued") && words.includes("diagnostic_token_revoked"));
    const trail = b.audit();
    assert.ok(!trail.includes(created.token.slice(11)), "the secret is not in the audit trail");
    assert.ok(!JSON.stringify(b.events()).includes(created.token.slice(11)), "nor in the History");
  } finally { await b.running.stop(); }
});

test("a token reads the health, the package and the log of its nodes and nothing else, and every refusal of a stranger is the same answer", async () => {
  const b = await bench();
  try {
    await b.elevate();
    const created = (await (await b.send("POST", "/api/v1/diagnostics/tokens", { nodes: ["radar-1"], ttl_s: 600 })).json()) as { id: string; token: string };
    const as = (token: string) => ({ Authorization: `Bearer ${token}` });
    const get = (url: string, headers: Record<string, string>) => fetch(`${b.running.base}${url}`, { headers });
    // the list of its nodes, and the report of a node washed of what looks like a credential and of the name of the person
    const list = await (await get("/api/v1/diagnostics/nodes", as(created.token))).json() as { scope: string; nodes: Array<{ node_id: string }> };
    assert.deepEqual(list.nodes.map(node => node.node_id), ["radar-1"]);
    const health = await get("/api/v1/diagnostics/nodes/radar-1", as(created.token));
    assert.equal(health.status, 200);
    const text = await health.text();
    assert.ok(!text.includes("hunter2"), "the last error is washed");
    assert.ok(!text.includes("\"control_by\""), "the person who ordered the node is not shown");
    assert.ok(text.includes("\"firmware\":\"0.7.9\""));
    assert.deepEqual(await codeOf(await get("/api/v1/diagnostics/nodes/radar-1/package", as(created.token))), [404, "no_package"]);
    assert.deepEqual(await codeOf(await get("/api/v1/diagnostics/nodes/solar-1", as(created.token))), [403, "out_of_scope"]);
    assert.deepEqual(await codeOf(await get("/api/v1/diagnostics/nodes/alarm-1/log", as(created.token))), [403, "out_of_scope"]);
    // a node delivers a package; the token reads it, washed again
    b.context.nodeDiagnostics.keep("radar-1", { detail: "package", heap: { internal_free: 9, internal_min: 8, internal_largest: 7, total_free: 9, total_min: 8 }, tasks: [], resets: { reason: "panic", uptime_s: 1, guard_restarts_in_hour: 0 },
      versions: { firmware: "0.7.9", idf: "v5", sensors: [] }, config: { "wifi.mode": "station" }, coredump: { present: false }, log: "I (1) ok\nW (2) token: leaked-by-mistake-12345\n", truncated: false }, "ana");
    const pack = await get("/api/v1/diagnostics/nodes/radar-1/package", as(created.token));
    assert.equal(pack.status, 200);
    const packText = await pack.text();
    assert.ok(!packText.includes("leaked-by-mistake"), "the package is washed a second time");
    assert.ok(!packText.includes("\"requested_by\""), "who asked for it is not shown to a token");
    const log = await (await get("/api/v1/diagnostics/nodes/radar-1/log", as(created.token))).json() as { log: string };
    assert.ok(log.log.includes("I (1) ok") && !log.log.includes("leaked-by-mistake"));
    // everything a stranger can try is one answer
    const unknown = "armor-diag-" + "Z".repeat(43);
    for (const headers of [{}, as("hunter2"), as(unknown), { Authorization: `Basic ${created.token}` }]) assert.deepEqual(await codeOf(await get("/api/v1/diagnostics/nodes/radar-1", headers)), [401, "invalid_token"]);
    b.advance(61_000);   // the refused attempts above are forgotten after a minute
    // the token is no credential anywhere else
    for (const [method, url] of [["GET", "/api/v1/node-health"], ["GET", "/api/v1/diagnostics/tokens"], ["POST", "/api/v1/diagnostics/tokens"], ["GET", "/api/v1/nodes/radar-1/diagnostics"], ["GET", "/api/v1/nodes/radar-1/diagnostics/package"],
      ["POST", "/api/v1/nodes/radar-1/control"], ["GET", "/api/v1/alarms"], ["GET", "/api/v1/users"], ["GET", "/api/v1/history"], ["DELETE", "/api/v1/diagnostics/tokens/" + created.id]] as const) {
      const answer = await fetch(`${b.running.base}${url}`, { method, headers: { ...as(created.token), "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.ok(answer.status === 401 || answer.status === 403, `${method} ${url} answered ${answer.status}`);
    }
    // and it only reads
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const answer = await fetch(`${b.running.base}/api/v1/diagnostics/nodes/radar-1`, { method, headers: { ...as(created.token), "Content-Type": "application/json" }, body: method === "DELETE" ? undefined : "{}" });
      assert.ok(answer.status >= 400, `${method} answered ${answer.status}`);
    }
    // expiry and revocation end it
    b.advance(601_000);
    assert.deepEqual(await codeOf(await get("/api/v1/diagnostics/nodes/radar-1", as(created.token))), [401, "invalid_token"]);
    const second = (await (await b.send("POST", "/api/v1/diagnostics/tokens", { nodes: ["radar-1"] })).json()) as { id: string; token: string };
    assert.equal((await get("/api/v1/diagnostics/nodes/radar-1", as(second.token))).status, 200);
    assert.equal((await b.send("DELETE", "/api/v1/diagnostics/tokens/" + second.id)).status, 204);
    assert.deepEqual(await codeOf(await get("/api/v1/diagnostics/nodes/radar-1", as(second.token))), [401, "invalid_token"]);
    const words = b.events().map(event => (event as { action?: string }).action);
    assert.ok(words.includes("diagnostic_token_used") && words.includes("diagnostic_token_denied"));
    assert.ok(!b.audit().includes(created.token.slice(11)) && !b.audit().includes(second.token.slice(11)));
  } finally { await b.running.stop(); }
});

test("guessing tokens is slowed down: after twenty refused attempts in a minute even a good token waits", async () => {
  const b = await bench();
  try {
    await b.elevate();
    const good = (await (await b.send("POST", "/api/v1/diagnostics/tokens", { nodes: ["radar-1"] })).json()) as { token: string };
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
      const answer = await fetch(`${b.running.base}/api/v1/diagnostics/nodes/radar-1`, { headers: bearer("armor-diag-" + String(i).padStart(43, "G")) });
      if (answer.status === 429) limited += 1;
      else assert.equal(answer.status, 401);
    }
    assert.ok(limited > 0, "the guesses are stopped");
    assert.equal((await fetch(`${b.running.base}/api/v1/diagnostics/nodes/radar-1`, { headers: bearer(good.token) })).status, 429);
    b.advance(61_000);
  } finally { await b.running.stop(); }
});

test("an administrator asks a node for its package or its log; the answer is kept, read, downloaded and checked", async () => {
  const b = await bench();
  try {
    await b.elevate();
    assert.deepEqual(await codeOf(await b.send("POST", "/api/v1/nodes/radar-1/control", { operation: "restart", confirm: "radar-1", detail: "log" })), [400, "invalid_request"]);
    assert.deepEqual(await codeOf(await b.send("POST", "/api/v1/nodes/radar-1/control", { operation: "diagnostics", detail: "everything" })), [400, "invalid_request"]);
    assert.deepEqual(await codeOf(await b.send("POST", "/api/v1/nodes/control", { operation: "diagnostics", mode: "now", detail: "package" })), [400, "invalid_request"]);
    const started = await b.send("POST", "/api/v1/nodes/radar-1/control", { operation: "diagnostics", detail: "package" });
    assert.equal(started.status, 202);
    const arm = b.published.at(-1)!;
    assert.equal(arm.message.action, "arm");
    assert.equal("detail" in arm.message, false, "the arm carries no detail");
    b.answer({ node_id: "radar-1", command_id: arm.message.command_id, action: "arm", operation: "diagnostics", stage: "armed", token: "t".repeat(24), token_ttl_s: 30 });
    const execute = b.published.at(-1)!;
    assert.equal(execute.message.action, "execute");
    assert.equal(execute.message.detail, "package");
    const delivered = { ...PACKAGE, config: { "wifi.mode": "station" }, boot: undefined };
    delete (delivered as Record<string, unknown>).boot;
    b.answer({ node_id: "radar-1", command_id: execute.message.command_id, action: "execute", operation: "diagnostics", stage: "diagnostics", diagnostics: {
      firmware: "0.7.9", uptime_s: 5000, reset_reason: "power_on", heap_free: 1, heap_min: 1, mqtt_connected: true, state: "running", maintenance: false, package: delivered } });
    const line = (await (await b.send("GET", "/api/v1/nodes/control/operations")).json() as { operations: Array<{ nodes: Array<{ stage: string; delivered?: string; diagnostics?: Record<string, unknown> }> }> }).operations[0].nodes[0];
    assert.equal(line.stage, "applied");
    assert.equal(line.delivered, "package");
    assert.equal(line.diagnostics && "package" in line.diagnostics, false, "the package is not copied into the list of operations");
    const kept = (await (await b.send("GET", "/api/v1/nodes/radar-1/diagnostics")).json()) as { node_id: string; package?: { requested_by: string; data: { detail: string } } };
    assert.equal(kept.package?.requested_by, "admin");
    assert.equal(kept.package?.data.detail, "package");
    const download = await b.send("GET", "/api/v1/nodes/radar-1/diagnostics/package?download=1");
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /attachment; filename="armor-diagnostics-radar-1\.json"/);
    assert.equal((await b.send("GET", "/api/v1/nodes/radar-1/diagnostics/log?download=1")).status, 200);
    assert.deepEqual(await codeOf(await b.send("GET", "/api/v1/nodes/solar-1/diagnostics/package")), [404, "no_package"]);
    assert.equal((await b.send("GET", "/api/v1/nodes/radar-1/diagnostics", undefined, {})).status, 401);
    assert.equal((await b.send("GET", "/api/v1/nodes/radar-9/diagnostics")).status, 404);
    // a node that answers with a member of its own, or with a secret-looking setting, is not believed
    assert.throws(() => parseControlResult({ kind: "node_control_result", node_id: "radar-1", timestamp_ms: 9, command_id: "abcdefgh1234", action: "execute", operation: "diagnostics", stage: "diagnostics", accepted: true, refusal: "none",
      diagnostics: { firmware: "0.7.9", uptime_s: 1, reset_reason: "power_on", heap_free: 1, heap_min: 1, mqtt_connected: true, state: "running", maintenance: false, package: { ...delivered, wifi_password: "x" } } }));
    // the log alone
    const logStart = await b.send("POST", "/api/v1/nodes/solar-1/control", { operation: "diagnostics", detail: "log" });
    assert.equal(logStart.status, 202);
  } finally { await b.running.stop(); }
});

test("the events of a radar node reach the History where they matter, and the list answers an operator", async () => {
  const b = await bench();
  try {
    const { context } = b;
    const event = (seq: number, extra: Record<string, unknown>) => parseRadarEvent({ kind: "radar_event", node_id: "radar-1", timestamp_ms: 0, boot: 3, seq, ...extra });
    context.radarEvents.ingest(event(1, { event: "zone_occupied", name: "garden", sensor_id: 1, track_id: 1 }));
    context.radarEvents.ingest(event(2, { event: "sensor_bluetooth_open", name: "ld2450", sensor_id: 1 }));
    context.radarEvents.ingest(event(2, { event: "sensor_bluetooth_open", name: "ld2450", sensor_id: 1 }));
    context.radarEvents.ingest(event(3, { event: "sensor_bluetooth_closed", name: "ld2450", sensor_id: 1 }));
    context.radarEvents.ingest(event(4, { event: "masking", value: 5 }));
    context.radarEvents.ingest(event(5, { event: "tripwire", name: "gate", direction: "in", count: 1 }));
    const history = b.events() as Array<{ action: string; subject?: string; profile?: string }>;
    assert.deepEqual(history.filter(item => item.action === "sensor_bluetooth_open").map(item => `${item.subject} ${item.profile}`), ["radar-1:1 ld2450"]);
    assert.equal(history.filter(item => item.action === "sensor_bluetooth_closed").length, 1);
    assert.deepEqual(history.filter(item => item.action === "radar_event").map(item => item.profile), ["masking", "tripwire"]);
    assert.equal(history.some(item => item.profile === "zone_occupied"), false, "a zone taken stays in the list of the node");
    const listed = await (await b.send("GET", "/api/v1/radar/events?node=radar-1&limit=3")).json() as { events: Array<{ seq: number }>; nodes: string[] };
    assert.equal(listed.events.length, 3);
    assert.deepEqual(listed.nodes, ["radar-1"]);
    assert.equal((await b.send("GET", "/api/v1/radar/events?node=Radar")).status, 400);
    assert.equal((await b.send("GET", "/api/v1/radar/events", undefined, {})).status, 401);
    // forgetting the node takes its events, its package and its place in the tokens with it
    await b.elevate();
    const made = (await (await b.send("POST", "/api/v1/diagnostics/tokens", { nodes: ["radar-1"] })).json()) as { id: string };
    assert.equal((await b.send("DELETE", "/api/v1/node-health/radar-1")).status, 204);
    assert.deepEqual(context.radarEvents.nodes(), []);
    assert.equal(context.diagnosticTokens.list().find(item => item.id === made.id)?.status, "revoked");
  } finally { await b.running.stop(); }
});

test("the Bluetooth address of a sensor is shown to administrators only: an operator, a viewer and a diagnostic token read the report without it", async () => {
  const b = await bench();
  try {
    b.context.nodeHealth.ingest(report({ node_id: "radar-2", timestamp_ms: 9000, reset_reason: "power_on", uptime_s: 5000, sensors: [{ ...SENSOR, bluetooth: "open", mac: "8F:27:2E:B8:0F:65", bluetooth_alert: true }], radar: { ...FACTS } }));
    const asAdmin = await (await b.send("GET", "/api/v1/node-health/radar-2")).text();
    assert.ok(asAdmin.includes("8F:27:2E:B8:0F:65"), "an administrator sees the address");
    const operator = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };
    const asOperator = await b.send("GET", "/api/v1/node-health/radar-2", undefined, operator);
    assert.equal(asOperator.status, 200);
    const operatorText = await asOperator.text();
    assert.ok(!operatorText.includes("8F:27:2E:B8:0F:65") && operatorText.includes("\"bluetooth\":\"open\""), "the state of the Bluetooth stays, the address goes");
    assert.ok(!(await (await b.send("GET", "/api/v1/node-health", undefined, operator)).text()).includes("8F:27"));
    await b.elevate();
    const made = (await (await b.send("POST", "/api/v1/diagnostics/tokens", { nodes: ["radar-2"] })).json()) as { token: string };
    const asToken = await (await fetch(`${b.running.base}/api/v1/diagnostics/nodes/radar-2`, { headers: bearer(made.token) })).text();
    assert.ok(asToken.includes("\"bluetooth\":\"open\"") && !asToken.includes("8F:27"), "a token reads the state without the address");
  } finally { await b.running.stop(); }
});
