/**
 * Load and chaos tests: random garbage, bursts, crashes and restarts. They are
 * seeded, so a failure reproduces exactly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createArmorApp } from "../src/app.js";
import { parseHealth, parseTelemetry } from "../src/contracts.js";
import type { ArmorEvent } from "../src/events.js";
import { AlertNotifier } from "../src/notify.js";
import { FileStatePersistence } from "../src/persistence.js";
import { alertLevelFor, ArmorStore, MAX_NODES } from "../src/store.js";
import { SECRETS, startServer, tempDir } from "./helpers.js";

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, items: T[]): T => items[Math.floor(rand() * items.length)];
const JUNK: unknown[] = [null, undefined, true, false, 0, -1, 1e308, -1e308, NaN, "", "x", "../../etc/passwd", "a".repeat(5000), [], {}, [[]], { __proto__: { admin: true } }, "\u0000", 2 ** 53, 1.5];

function mutate(rand: () => number, base: Record<string, unknown>): unknown {
  const copy: Record<string, unknown> = structuredClone(base);
  const keys = Object.keys(copy);
  const steps = 1 + Math.floor(rand() * 3);
  for (let step = 0; step < steps; step += 1) {
    const roll = rand();
    if (roll < 0.45) copy[pick(rand, keys)] = pick(rand, JUNK);
    else if (roll < 0.6) delete copy[pick(rand, keys)];
    else if (roll < 0.75) copy[`extra${Math.floor(rand() * 5)}`] = pick(rand, JUNK);
    else if (roll < 0.9 && Array.isArray(copy.targets)) copy.targets = Array.from({ length: Math.floor(rand() * 40) }, () => pick(rand, [...JUNK, { sensor_id: 1, track_id: 1, x_mm: 1, y_mm: 1, speed_mm_s: 1 }]));
    else return pick(rand, JUNK);
  }
  return copy;
}

const goodTelemetry = { node_id: "north-1", timestamp_ms: 10, lux: 5, targets: [{ sensor_id: 1, track_id: 1, x_mm: 1, y_mm: 2, speed_mm_s: 3 }] };
const goodHealth = { node_id: "north-1", timestamp_ms: 10, online: true };

test("fuzzed payloads are either rejected with an Error or fully valid, never half-accepted", () => {
  const rand = random(20260925);
  let accepted = 0;
  for (let index = 0; index < 4000; index += 1) {
    for (const [parse, base] of [[parseTelemetry, goodTelemetry], [parseHealth, goodHealth]] as const) {
      const input = mutate(rand, base);
      try {
        const value = parse(input) as Record<string, unknown>;
        accepted += 1;
        assert.match(String(value.node_id), /^[a-z0-9][a-z0-9_-]{0,63}$/);
        assert.ok(Number.isInteger(value.timestamp_ms) && (value.timestamp_ms as number) >= 0);
        if ("targets" in value) {
          assert.ok((value.targets as unknown[]).length <= 15);
          assert.ok(Number.isFinite(value.lux) && (value.lux as number) >= 0 && (value.lux as number) <= 200_000);
        }
      } catch (error) {
        assert.ok(error instanceof Error, `a non-Error was thrown for ${JSON.stringify(input)?.slice(0, 80)}`);
      }
    }
  }
  assert.ok(accepted > 0, "the generator must also produce valid messages");
});

test("garbage sent over HTTP never causes a server error or takes the server down", async () => {
  const running = await startServer();
  try {
    const rand = random(7);
    const headers = { Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}`, "Content-Type": "application/json" };
    const statuses = new Map<number, number>();
    for (let index = 0; index < 250; index += 1) {
      const kind = index % 2 ? "telemetry" : "health";
      const roll = rand();
      const body = roll < 0.2 ? "{not json" : roll < 0.3 ? "" : roll < 0.35 ? "x".repeat(200_000) : JSON.stringify(mutate(rand, kind === "telemetry" ? goodTelemetry : goodHealth));
      const response = await fetch(`${running.base}/api/v1/${kind}`, { method: "POST", headers, body });
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      assert.ok(response.status < 500, `HTTP ${response.status} for a fuzzed ${kind}`);
    }
    assert.ok((statuses.get(400) ?? 0) > 0);
    assert.equal((await fetch(`${running.base}/healthz`)).status, 200);
  } finally { await running.stop(); }
});

test("a burst from many nodes is accepted completely and lands in the state", async () => {
  const running = await startServer();
  try {
    const headers = { Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}`, "Content-Type": "application/json" };
    const nodes = 40, perNode = 25;
    const jobs: Array<() => Promise<number>> = [];
    for (let n = 0; n < nodes; n += 1) {
      for (let m = 0; m < perNode; m += 1) {
        jobs.push(async () => (await fetch(`${running.base}/api/v1/telemetry`, { method: "POST", headers, body: JSON.stringify({ node_id: `node-${n}`, timestamp_ms: 100 + m, lux: m, targets: [] }) })).status);
      }
    }
    const results: number[] = [];
    const started = Date.now();
    await Promise.all(Array.from({ length: 30 }, async () => { for (let job = jobs.shift(); job; job = jobs.shift()) results.push(await job()); }));
    assert.equal(results.length, nodes * perNode);
    assert.ok(results.every(status => status === 202), `statuses: ${[...new Set(results)].join(",")}`);
    assert.ok(Date.now() - started < 30_000, "1000 messages took too long");
    const state = await (await fetch(`${running.base}/api/v1/status`, { headers: { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` } })).json() as { nodes: Record<string, { timestamp_ms: number }> };
    assert.equal(Object.keys(state.nodes).length, nodes);
    assert.ok(Object.values(state.nodes).every(node => node.timestamp_ms === 100 + perNode - 1));
  } finally { await running.stop(); }
});

test("inventing node names cannot grow the state without bound", () => {
  const store = new ArmorStore();
  for (let index = 0; index < MAX_NODES; index += 1) store.health(parseHealth({ node_id: `node-${index}`, timestamp_ms: 1, online: true }));
  assert.throws(() => store.telemetry(parseTelemetry({ node_id: "one-too-many", timestamp_ms: 1, lux: 1, targets: [] })), /too many nodes/);
  assert.throws(() => store.health(parseHealth({ node_id: "one-too-many", timestamp_ms: 1, online: true })), /too many nodes/);
  store.telemetry(parseTelemetry({ node_id: "node-0", timestamp_ms: 2, lux: 1, targets: [] }));
  assert.equal(Object.keys(store.snapshot().nodes).length, MAX_NODES);
  assert.equal(store.removeNode("node-0"), true);
  store.health(parseHealth({ node_id: "one-too-many", timestamp_ms: 1, online: true }));
});

test("random operations keep the state consistent: monotonic revision and levels that follow the rules", () => {
  const rand = random(99);
  let now = 5_000_000;
  const store = new ArmorStore(undefined, { now: () => now, staleAfterMs: 30_000, rules: () => ({ schema: 1, dwell_ms: 1_500, zones: [] }) });
  let revision = 0;
  const lastTimestamp = new Map<string, number>();
  for (let index = 0; index < 4000; index += 1) {
    now += Math.floor(rand() * 900);
    const node = `n${Math.floor(rand() * 6)}`;
    const roll = rand();
    if (roll < 0.5) {
      const targets = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => ({ sensor_id: 1, track_id: i + 1, x_mm: i, y_mm: i, speed_mm_s: 0 }));
      store.telemetry(parseTelemetry({ node_id: node, timestamp_ms: Math.floor(rand() * 1e6), lux: 1, targets }));
    } else if (roll < 0.7) store.health(parseHealth({ node_id: node, timestamp_ms: Math.floor(rand() * 1e6), online: rand() < 0.7 }));
    else if (roll < 0.8) store.arm(rand() < 0.5 ? "armed" : "disarmed");
    else if (roll < 0.9) store.sweep();
    else if (roll < 0.92) store.removeNode(node);
    const state = store.snapshot();
    assert.ok(state.revision >= revision, "the revision went backwards");
    revision = state.revision;
    for (const [id, item] of Object.entries(state.nodes)) {
      assert.ok(item.timestamp_ms >= (lastTimestamp.get(id) ?? 0) || !lastTimestamp.has(id), "a node timestamp went backwards");
      lastTimestamp.set(id, item.timestamp_ms);
      // "high" is only ever the result of two or more targets while armed; anything else must be lower.
      if (item.alert_level === "high") assert.equal(alertLevelFor(state.mode, item.target_count), "high");
      assert.equal(item.online && item.stale, false, "a stale node was shown online");
    }
    for (const id of [...lastTimestamp.keys()]) if (!(id in state.nodes)) lastTimestamp.delete(id);
  }
});

test("a crash in the middle of a write, or leftover temporary files, never stop a restart", () => {
  const dir = tempDir();
  const file = path.join(dir, "state.json");
  const first = new ArmorStore(undefined, { persistence: new FileStatePersistence(file, { delayMs: 10_000 }) });
  first.arm("armed");
  first.telemetry(parseTelemetry({ node_id: "north-1", timestamp_ms: 1, lux: 1, targets: [] }));
  // No flush: node data was still pending. The mode was written at once.
  fs.writeFileSync(`${file}.tmp`, '{"schema":1,"mode":"disar');
  const second = new ArmorStore(undefined, { persistence: new FileStatePersistence(file) });
  assert.equal(second.snapshot().mode, "armed", "the security mode must survive a crash");
  // The pending timer of the first store is unref'ed and must not keep the process alive.
  first.flush();
});

test("restarting the whole server repeatedly keeps the last mode", async () => {
  const seed = await startServer();
  const config = seed.config;
  await seed.stop();
  const rand = random(5);
  let expected: "armed" | "disarmed" = "disarmed";
  for (let round = 0; round < 6; round += 1) {
    const app = createArmorApp(config, "test");
    assert.equal(app.context.store.snapshot().mode, expected);
    expected = rand() < 0.5 ? "armed" : "disarmed";
    app.context.store.arm(expected);
    await app.close();
  }
});

test("an unreachable webhook under a flood of alarms stays bounded and quiet", async () => {
  const outcomes: string[] = [];
  let attempts = 0;
  const notifier = new AlertNotifier({
    webhookUrl: "http://127.0.0.1:9/hook", audit: { record: event => { outcomes.push(event.outcome); } }, retryDelaysMs: [1],
    fetchImpl: async () => { attempts += 1; throw new Error("down"); },
  });
  for (let index = 0; index < 400; index += 1) {
    notifier.notify({ id: index, at: "2026-01-01T00:00:00.000Z", type: "alert", node_id: "n", from: "review", to: "high", targets: 2 } as ArmorEvent, "armed");
  }
  await notifier.idle();
  assert.ok(attempts <= 2 * 400, "retries are bounded");
  assert.ok(outcomes.length >= 100 && outcomes.every(outcome => outcome === "failed"));
  notifier.close();
});
