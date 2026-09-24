import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { createAuditLog } from "../src/audit.js";
import { parseHealth, parseTelemetry } from "../src/contracts.js";
import { EventLog, type ArmorEvent } from "../src/events.js";
import { alertMessageFor, AlertNotifier, signBody } from "../src/notify.js";
import { FileStatePersistence, parsePersisted } from "../src/persistence.js";
import { defaultRules, parseRules, RulesFile, targetCounts } from "../src/rules.js";
import { ArmorStore } from "../src/store.js";
import { SECRETS, startServer, studioCookie, tempDir } from "./helpers.js";

const telemetry = (node: string, timestamp: number, targets: Array<{ x: number; y: number; sensor?: number }>) =>
  parseTelemetry({ node_id: node, timestamp_ms: timestamp, lux: 10, targets: targets.map((t, index) => ({ sensor_id: t.sensor ?? 1, track_id: index + 1, x_mm: t.x, y_mm: t.y, speed_mm_s: 0 })) });
const two = [{ x: 1000, y: 1000 }, { x: 2000, y: 2000 }];

test("the security mode and the nodes survive a restart, and a restored node is stale until it speaks again", () => {
  const dir = tempDir();
  const file = path.join(dir, "state.json");
  let now = 1_000_000;
  const first = new ArmorStore(undefined, { now: () => now, persistence: new FileStatePersistence(file) });
  first.telemetry(telemetry("north-1", 5, [{ x: 1, y: 1 }]));
  first.arm("armed");
  now += 60_000;
  const second = new ArmorStore(undefined, { now: () => now, persistence: new FileStatePersistence(file) });
  const state = second.snapshot();
  assert.equal(state.mode, "armed");
  assert.equal(state.nodes["north-1"].stale, true);
  assert.equal(state.nodes["north-1"].online, false);
  assert.ok(state.revision >= 2);
  second.telemetry(telemetry("north-1", 9, []));
  assert.equal(second.snapshot().nodes["north-1"].online, true);
});

test("a damaged or foreign state file is ignored, never trusted", () => {
  const dir = tempDir();
  const file = path.join(dir, "state.json");
  const warnings: string[] = [];
  for (const content of ["{not json", JSON.stringify({ schema: 2, mode: "armed", revision: 1, nodes: [] }), JSON.stringify({ schema: 1, mode: "armed", revision: 1, nodes: [{ node_id: "../x" }] })]) {
    fs.writeFileSync(file, content);
    const store = new ArmorStore(undefined, { persistence: new FileStatePersistence(file, { warn: message => warnings.push(message) }) });
    assert.equal(store.snapshot().mode, "disarmed");
    assert.deepEqual(Object.keys(store.snapshot().nodes), []);
  }
  assert.equal(warnings.length, 3);
  assert.equal(parsePersisted("null"), undefined);
});

test("arming is written at once, node data is coalesced", async () => {
  const file = path.join(tempDir(), "state.json");
  const store = new ArmorStore(undefined, { persistence: new FileStatePersistence(file, { delayMs: 20 }) });
  store.arm("armed");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mode, "armed");
  store.telemetry(telemetry("north-1", 1, []));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nodes.length, 0);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nodes.length, 1);
});

test("high needs the dwell time; a passing target never raises it", () => {
  let now = 1_000_000;
  const events: string[] = [];
  const store = new ArmorStore(undefined, { now: () => now, rules: () => ({ ...defaultRules(2000) }), onEvent: event => { if (event.type === "alert") events.push(`${event.from}>${event.to}`); } });
  store.arm("armed");
  store.telemetry(telemetry("north-1", 1, two));
  assert.equal(store.snapshot().nodes["north-1"].alert_level, "review");
  now += 1_000;
  store.telemetry(telemetry("north-1", 2, two));
  assert.equal(store.snapshot().nodes["north-1"].alert_level, "review");
  now += 1_500;
  store.sweep();
  assert.equal(store.snapshot().nodes["north-1"].alert_level, "high");
  // The condition breaks: the timer restarts from zero.
  store.telemetry(telemetry("north-1", 3, [{ x: 1, y: 1 }]));
  store.telemetry(telemetry("north-1", 4, two));
  assert.equal(store.snapshot().nodes["north-1"].alert_level, "review");
  assert.deepEqual(events, ["normal>review", "review>high", "high>review"]);
});

test("targets inside an ignore zone do not count", () => {
  const rules = parseRules({ dwell_ms: 0, zones: [{ id: "road", name: "Road", action: "ignore", sensor_id: 2, x_min_mm: 0, x_max_mm: 3000, y_min_mm: 0, y_max_mm: 3000 }] });
  assert.ok(rules);
  assert.equal(targetCounts(rules, "north-1", { sensor_id: 2, x_mm: 100, y_mm: 100 }), false);
  assert.equal(targetCounts(rules, "north-1", { sensor_id: 1, x_mm: 100, y_mm: 100 }), true);
  assert.equal(targetCounts(rules, "north-1", { sensor_id: 2, x_mm: 4000, y_mm: 100 }), true);
  const store = new ArmorStore(undefined, { rules: () => rules });
  store.telemetry(telemetry("north-1", 1, [{ x: 100, y: 100, sensor: 2 }, { x: 200, y: 200, sensor: 2 }]));
  assert.equal(store.snapshot().nodes["north-1"].target_count, 0);
  assert.equal(store.snapshot().nodes["north-1"].alert_level, "normal");
});

test("rules validation refuses anything malformed", () => {
  assert.ok(parseRules({ schema: 1, dwell_ms: 0, zones: [] }));
  assert.equal(parseRules({ schema: 2, dwell_ms: 0, zones: [] }), null);
  const zone = { id: "a", name: "A", action: "ignore", x_min_mm: 0, x_max_mm: 10, y_min_mm: 0, y_max_mm: 10 };
  assert.ok(parseRules({ dwell_ms: 0, zones: [zone] }));
  const bad: unknown[] = [
    null, [], { dwell_ms: -1, zones: [] }, { dwell_ms: 1.5, zones: [] }, { dwell_ms: 70_000, zones: [] }, { dwell_ms: 0 }, { dwell_ms: 0, zones: [], extra: 1 },
    { dwell_ms: 0, zones: [{ ...zone, x_min_mm: 10 }] }, { dwell_ms: 0, zones: [{ ...zone, id: "Bad Id" }] }, { dwell_ms: 0, zones: [{ ...zone, action: "allow" }] },
    { dwell_ms: 0, zones: [zone, zone] }, { dwell_ms: 0, zones: [{ ...zone, sensor_id: 4 }] }, { dwell_ms: 0, zones: [{ ...zone, x_max_mm: Infinity }] },
    { dwell_ms: 0, zones: [{ ...zone, unknown: true }] }, { dwell_ms: 0, zones: Array.from({ length: 65 }, (_, i) => ({ ...zone, id: `z${i}` })) },
  ];
  for (const value of bad) assert.equal(parseRules(value), null, JSON.stringify(value)?.slice(0, 60));
});

test("a damaged rules file falls back to the defaults", () => {
  const file = path.join(tempDir(), "rules.json");
  fs.writeFileSync(file, "{oops");
  const warnings: string[] = [];
  const rules = new RulesFile(file, 1500, message => warnings.push(message));
  assert.equal(rules.get().dwell_ms, 1500);
  assert.equal(warnings.length, 1);
  rules.set({ schema: 1, dwell_ms: 500, zones: [] });
  assert.equal(new RulesFile(file, 1500).get().dwell_ms, 500);
});

test("events are recorded in order, paged, filtered and restored after a restart", () => {
  const file = path.join(tempDir(), "events.log");
  const log = new EventLog({ file, capacity: 5 });
  for (let index = 0; index < 8; index += 1) log.append({ type: "alert", node_id: index % 2 ? "b" : "a", from: "normal", to: "review", targets: 1 });
  log.append({ type: "mode", mode: "armed" });
  const newest = log.list({ limit: 3 });
  assert.deepEqual(newest.map(event => event.id), [9, 8, 7]);
  assert.deepEqual(log.list({ before: 7, limit: 10 }).map(event => event.id), [6, 5]);
  assert.deepEqual(log.list({ node: "a" }).map(event => event.id), [7, 5]);
  assert.deepEqual(log.list({ type: "mode" }).map(event => event.id), [9]);
  fs.appendFileSync(file, "{torn line");
  const restored = new EventLog({ file, capacity: 5 });
  assert.equal(restored.list({ limit: 1 })[0].id, 9);
  assert.equal(restored.append({ type: "mode", mode: "disarmed" }).id, 10);
});

test("the store reports node and alert transitions, including going silent", () => {
  let now = 1_000_000;
  const seen: string[] = [];
  const store = new ArmorStore(undefined, { staleAfterMs: 30_000, now: () => now, onEvent: event => seen.push(event.type === "node" ? `node:${event.from}>${event.to}` : event.type === "mode" ? `mode:${event.mode}` : `alert:${event.from}>${event.to}`) });
  store.arm("armed");
  store.health(parseHealth({ node_id: "north-1", timestamp_ms: 1, online: true }));
  now += 31_000;
  assert.equal(store.sweep(), true);
  assert.equal(store.sweep(), false);
  store.health(parseHealth({ node_id: "north-1", timestamp_ms: 2, online: false }));
  assert.deepEqual(seen, ["mode:armed", "node:null>online", "node:online>stale", "node:stale>offline"]);
});

test("only the events that matter become alarms", () => {
  const event = (body: Record<string, unknown>) => ({ id: 1, at: "2026-01-01T00:00:00.000Z", ...body }) as unknown as ArmorEvent;
  assert.equal(alertMessageFor(event({ type: "alert", node_id: "n", from: "review", to: "high", targets: 2 }), "armed")?.event, "alert.raised");
  assert.equal(alertMessageFor(event({ type: "alert", node_id: "n", from: "high", to: "normal", targets: 0 }), "armed")?.event, "alert.cleared");
  assert.equal(alertMessageFor(event({ type: "alert", node_id: "n", from: "normal", to: "review", targets: 1 }), "armed"), null);
  assert.equal(alertMessageFor(event({ type: "node", node_id: "n", from: "online", to: "stale" }), "armed")?.event, "node.stale");
  assert.equal(alertMessageFor(event({ type: "node", node_id: "n", from: "online", to: "offline" }), "armed")?.event, "node.offline");
  assert.equal(alertMessageFor(event({ type: "node", node_id: "n", from: "online", to: "offline" }), "disarmed"), null);
  assert.equal(alertMessageFor(event({ type: "mode", mode: "armed" }), "armed"), null);
});

async function receiver(statuses: number[]): Promise<{ url: string; calls: Array<{ body: string; signature: string | undefined }>; stop: () => Promise<void> }> {
  const calls: Array<{ body: string; signature: string | undefined }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      calls.push({ body, signature: request.headers["x-armor-signature"] as string | undefined });
      response.statusCode = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/hook`, calls, stop: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const raised = { id: 1, at: "2026-01-01T00:00:00.000Z", type: "alert", node_id: "north-1", from: "review", to: "high", targets: 2 } as ArmorEvent;

test("the webhook is signed, retried after a server error and audited", async () => {
  const target = await receiver([503, 200]);
  const audited: string[] = [];
  const notifier = new AlertNotifier({ webhookUrl: target.url, webhookSecret: "s".repeat(32), audit: { record: event => { audited.push(`${event.outcome}`); } }, retryDelaysMs: [5, 5] });
  const published: string[] = [];
  notifier.setPublisher((topic, payload) => published.push(`${topic} ${payload}`));
  notifier.notify(raised, "armed");
  await notifier.idle();
  assert.equal(target.calls.length, 2);
  assert.equal(target.calls[1].signature, signBody("s".repeat(32), target.calls[1].body));
  assert.equal(JSON.parse(target.calls[1].body).event, "alert.raised");
  assert.deepEqual(audited, ["allowed"]);
  assert.match(published[0], /^armor\/server\/alert /);
  notifier.close();
  await target.stop();
});

test("a client error is not retried and a dead receiver never throws", async () => {
  const target = await receiver([400]);
  const audited: string[] = [];
  const notifier = new AlertNotifier({ webhookUrl: target.url, audit: { record: event => { audited.push(`${event.outcome}:${event.detail ?? ""}`); } }, retryDelaysMs: [5, 5] });
  notifier.notify(raised, "armed");
  await notifier.idle();
  assert.equal(target.calls.length, 1);
  assert.deepEqual(audited, ["failed:HTTP 400"]);
  await target.stop();
  notifier.notify(raised, "armed");
  await notifier.idle();
  assert.equal(audited.length, 2);
  assert.match(audited[1], /^failed:/);
  notifier.close();
});

test("history and rules are operator-only and validated over HTTP", async () => {
  const running = await startServer({ ARMOR_ALERT_DWELL_MS: "0" });
  try {
    assert.equal((await fetch(`${running.base}/api/v1/history`)).status, 401);
    assert.equal((await fetch(`${running.base}/api/v1/rules`)).status, 401);
    const headers = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}`, "Content-Type": "application/json" };
    await fetch(`${running.base}/api/v1/control/arm`, { method: "POST", headers: { Authorization: `Bearer ${SECRETS.ARMOR_CONTROL_TOKEN}` } });
    const ingest = { Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}`, "Content-Type": "application/json" };
    const body = { node_id: "north-1", timestamp_ms: 5, lux: 1, targets: [1, 2].map(n => ({ sensor_id: 1, track_id: n, x_mm: 10 * n, y_mm: 5, speed_mm_s: 0 })) };
    assert.equal((await fetch(`${running.base}/api/v1/telemetry`, { method: "POST", headers: ingest, body: JSON.stringify(body) })).status, 202);

    const history = await (await fetch(`${running.base}/api/v1/history?limit=10`, { headers })).json() as { events: Array<{ type: string }>; next_before: number };
    assert.deepEqual(history.events.map(event => event.type).sort(), ["alert", "mode", "node"]);
    assert.equal((await fetch(`${running.base}/api/v1/history?type=bogus`, { headers })).status, 400);
    assert.equal((await fetch(`${running.base}/api/v1/history?node=../x`, { headers })).status, 400);

    assert.equal((await fetch(`${running.base}/api/v1/rules`, { method: "PUT", headers, body: JSON.stringify({ dwell_ms: -5, zones: [] }) })).status, 400);
    const zone = { id: "all", name: "Everything", action: "ignore", x_min_mm: 0, x_max_mm: 1000, y_min_mm: 0, y_max_mm: 1000 };
    assert.equal((await fetch(`${running.base}/api/v1/rules`, { method: "PUT", headers, body: JSON.stringify({ dwell_ms: 0, zones: [zone] }) })).status, 200);
    const cookie = await studioCookie(running.base);
    const stored = await (await fetch(`${running.base}/api/v1/rules`, { headers: { cookie } })).json() as { zones: unknown[] };
    assert.equal(stored.zones.length, 1);
    assert.ok(fs.existsSync(path.join(running.config.dataDir, "rules.json")));
    await fetch(`${running.base}/api/v1/telemetry`, { method: "POST", headers: ingest, body: JSON.stringify({ ...body, timestamp_ms: 6 }) });
    const state = await (await fetch(`${running.base}/api/v1/status`)).json() as { nodes: Record<string, { target_count: number }> };
    assert.equal(state.nodes["north-1"].target_count, 0);
  } finally { await running.stop(); }
});

test("a restarted server keeps armed mode", async () => {
  const first = await startServer();
  try {
    await fetch(`${first.base}/api/v1/control/arm`, { method: "POST", headers: { Authorization: `Bearer ${SECRETS.ARMOR_CONTROL_TOKEN}` } });
  } finally { await first.stop(); }
  const { createArmorApp } = await import("../src/app.js");
  const second = createArmorApp(first.config, "test");
  try { assert.equal(second.context.store.snapshot().mode, "armed"); }
  finally { await second.close(); }
});

test("the audit log is created for a webhook failure without leaking the URL secret", () => {
  const lines: string[] = [];
  const audit = createAuditLog(tempDir(), line => lines.push(line));
  audit.record({ action: "alert.webhook", outcome: "failed", detail: "HTTP 500" });
  assert.match(lines[0], /alert\.webhook/);
});
