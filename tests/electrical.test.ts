// The readings of the ARMOR-ELECTRICAL nodes: the parser against the shared vectors, the store, and the routes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ElectricalStore, electricalTopic, parseElectricalMessage, type ElectricalMessage } from "../src/electrical.js";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

const message = (extra: Partial<ElectricalMessage> = {}): ElectricalMessage => ({
  kind: "electrical", node_id: "electrical-1", timestamp_ms: 5000,
  channels: [{ id: "grid", domain: "ac", voltage_v: 231.4, current_a: 12.6, power_w: 2810.5, energy_kwh: 5230.4, frequency_hz: 49.98, power_factor: 0.97, state: "closed", alarm: false }], ...extra,
});

const directory = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance");
test("electrical parsing agrees with every shared conformance vector", { skip: fs.existsSync(path.join(directory, "electrical.json")) ? false : "ARMOR-COMMON is not checked out next to this repository" }, () => {
  const { vectors } = JSON.parse(fs.readFileSync(path.join(directory, "electrical.json"), "utf8")) as { vectors: Array<{ name: string; valid: boolean; payload: unknown }> };
  assert.ok(vectors.length >= 30);
  for (const vector of vectors) {
    if (vector.valid) assert.doesNotThrow(() => parseElectricalMessage(vector.payload), `should accept: ${vector.name}`);
    else assert.throws(() => parseElectricalMessage(vector.payload), `should reject: ${vector.name}`);
  }
});

test("a channel is named once, and the topic names a node and nothing else", () => {
  assert.throws(() => parseElectricalMessage(message({ channels: [{ id: "grid", domain: "ac" }, { id: "grid", domain: "dc" }] })), /once/);
  assert.equal(electricalTopic("armor/electrical/electrical-1/state"), "electrical-1");
  for (const topic of ["armor/electrical/state", "armor/electrical/electrical-1/set", "armor/solar/electrical-1/state", "armor/electrical/Node/state", "armor/electrical/-x/state", "armor/electrical/a/b/state"]) {
    assert.equal(electricalTopic(topic), undefined, topic);
  }
});

test("the store keeps the latest reading, samples now and then, goes stale, comes back and refuses too many nodes", () => {
  let clock = 1_000_000;
  const told: string[] = [];
  const store = new ElectricalStore({ now: () => clock, staleAfterMs: 60_000, sampleEveryMs: 30_000, maxNodes: 2, onMessage: item => told.push(`message ${item.node_id}`), onStale: (node, stale) => told.push(`${stale ? "stale" : "back"} ${node}`) });
  store.ingest(message());
  clock += 10_000; store.ingest(message({ channels: [{ id: "grid", domain: "ac", power_w: 3000 }] }));   // too soon for another sample
  clock += 30_000; store.ingest(message({ channels: [{ id: "grid", domain: "ac", power_w: 3200, energy_kwh: 5231 }] }));
  assert.equal(store.history("electrical-1", "grid", 60)!.length, 2);
  assert.equal(store.history("electrical-1", "nope", 60), undefined);
  assert.equal(store.history("other", "grid", 60), undefined);
  assert.deepEqual(store.totals(), { nodes: 1, channels: 1, stale: 0, grid_w: 3200, grid_kwh: 5231, alarms: 0 });
  clock += 61_000;
  assert.equal(store.list()[0].stale, true);
  assert.deepEqual(store.totals(), { nodes: 1, channels: 1, stale: 1, grid_w: null, grid_kwh: null, alarms: 0 });   // a silent node counts for nothing
  store.ingest(message({ node_id: "electrical-1" }));
  assert.equal(store.list()[0].stale, false);
  assert.deepEqual(told.filter(item => item !== "message electrical-1"), ["stale electrical-1", "back electrical-1"]);
  store.ingest(message({ node_id: "electrical-2" }));
  assert.throws(() => store.ingest(message({ node_id: "electrical-3" })), /too many/);
  assert.equal(store.remove("electrical-2"), true);
  assert.equal(store.remove("electrical-2"), false);
});

test("the sums count the grid channel of the nodes that report and the alarms they raise", () => {
  const store = new ElectricalStore();
  store.ingest(message({ channels: [{ id: "grid", domain: "ac", power_w: -800, energy_kwh: 10.5 }, { id: "heater", domain: "ac", power_w: 1500, alarm: true, alarm_code: "over_current" }, { id: "dc-bus", domain: "dc", power_w: 400 }] }));
  assert.deepEqual(store.totals(), { nodes: 1, channels: 3, stale: 0, grid_w: -800, grid_kwh: 10.5, alarms: 1 });
});

test("the routes take a node's reading with the ingest token and give it to an operator", async () => {
  const running = await startServer();
  try {
    const post = (body: unknown, token?: string) => fetch(`${running.base}/api/v1/electrical/readings`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post(message())).status, 401);
    assert.equal((await post(message(), "wrong")).status, 401);
    assert.equal((await post({ ...message(), command: "close" }, SECRETS.ARMOR_INGEST_TOKEN)).status, 400);
    assert.equal((await post({ ...message(), channels: [{ id: "grid", domain: "ac", voltage_v: 5000 }] }, SECRETS.ARMOR_INGEST_TOKEN)).status, 400);
    assert.equal((await post(message(), SECRETS.ARMOR_INGEST_TOKEN)).status, 202);
    const cookie = await studioCookie(running.base);
    assert.equal((await fetch(`${running.base}/api/v1/electrical/readings`)).status, 401);
    const seen = await (await fetch(`${running.base}/api/v1/electrical/readings`, { headers: { cookie } })).json() as { nodes: Array<{ node_id: string; stale: boolean; reading: ElectricalMessage }>; totals: { grid_w: number } };
    assert.deepEqual([seen.nodes.length, seen.nodes[0].node_id, seen.nodes[0].stale, seen.totals.grid_w], [1, "electrical-1", false, 2811]);
    const history = await fetch(`${running.base}/api/v1/electrical/history?node=electrical-1&channel=grid&minutes=30`, { headers: { cookie } });
    assert.equal(history.status, 200);
    assert.equal(((await history.json()) as { samples: unknown[] }).samples.length, 1);
    assert.equal((await fetch(`${running.base}/api/v1/electrical/history?node=electrical-1&channel=nope`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${running.base}/api/v1/electrical/history?node=Bad&channel=grid`, { headers: { cookie } })).status, 400);
  } finally { await running.stop(); }
});
