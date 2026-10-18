// The health of the nodes: the parser against the shared vectors, the store (restarts, the four warnings and their levels, what a restart of the server keeps), the alarms the warnings raise
// and the routes. No node sends these reports yet from a board: the reports here are made by the tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { healthTopic, HEALTH_LEVELS, NodeHealthStore, parseNodeHealth, type NodeHealthMessage, type NodeHealthView } from "../src/node_health.js";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

const directory = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance");
type Vector = { name: string; valid: boolean; payload: unknown };
const skip = fs.existsSync(path.join(directory, "node_health.json")) ? false : "ARMOR-COMMON is not checked out next to this repository";

test("node health parsing agrees with every shared conformance vector", { skip }, () => {
  const all = (JSON.parse(fs.readFileSync(path.join(directory, "node_health.json"), "utf8")) as { vectors: Vector[] }).vectors;
  assert.ok(all.length >= 30);
  for (const vector of all) {
    if (vector.valid) assert.doesNotThrow(() => parseNodeHealth(vector.payload), `should accept: ${vector.name}`);
    else assert.throws(() => parseNodeHealth(vector.payload), `should reject: ${vector.name}`);
  }
});

test("the topic of a report names a node and nothing else", () => {
  assert.equal(healthTopic("armor/health/alarm-1"), "alarm-1");
  for (const topic of ["armor/health/Alarm", "armor/health/-x", "armor/health/a/b", "armor/health", "armor/node/alarm-1/health", "armor/alarm/alarm-1/state"]) assert.equal(healthTopic(topic), undefined);
});

const report = (extra: Partial<NodeHealthMessage> = {}): NodeHealthMessage => ({
  kind: "node_health", node_id: "alarm-1", timestamp_ms: 1000, family: "alarm", firmware: "0.3.6", board: "s3-eth", uptime_s: 3600, reset_reason: "power_on",
  heap_free: 142_000, heap_min: 98_000, link: "ethernet", link_up: true, broker_reconnects: 1, low_stack_tasks: 0, ...extra,
});
const wifi = (extra: Partial<NodeHealthMessage> = {}): NodeHealthMessage => report({ link: "wifi", rssi_dbm: -60, ...extra });

function bench(options: { maxNodes?: number } = {}) {
  let clock = 1_800_000_000_000;
  let stamp = 1000;
  const views: NodeHealthView[] = [];
  const forgotten: string[] = [];
  const store = new NodeHealthStore({ now: () => clock, maxNodes: options.maxNodes, onReport: view => views.push(view), onForget: node => forgotten.push(node) });
  /** Say a report `afterS` seconds after the last one (the uptime of the node grows with it unless the report says otherwise). */
  const say = (afterS: number, extra: Partial<NodeHealthMessage> = {}, base: NodeHealthMessage = report()) => {
    clock += afterS * 1000;
    stamp += afterS * 1000;
    return store.ingest({ ...base, timestamp_ms: stamp, ...extra });
  };
  return { store, say, views, forgotten, advance: (s: number) => { clock += s * 1000; } };
}
const codes = (view: NodeHealthView): string[] => view.warnings.map(item => item.code).sort();

test("a healthy node is ok, and the view tells what the node said", () => {
  const b = bench();
  const view = b.say(0, { uptime_s: 100_000 });
  assert.deepEqual([view.status, view.warnings, view.restarts_24h, view.stale, view.family, view.firmware, view.board], ["ok", [], 0, false, "alarm", "0.3.6", "s3-eth"]);
  assert.equal(b.store.totals().nodes, 1);
  assert.equal(b.store.get("alarm-1")?.samples.length, 1);
  assert.equal(b.store.get("nobody"), undefined);
});

test("low memory warns below the line and clears only above the higher one, and a task short of stack warns at once", () => {
  const b = bench();
  b.say(0, { uptime_s: 100_000 });
  assert.deepEqual(codes(b.say(60, { uptime_s: 100_060, heap_free: HEALTH_LEVELS.low_heap_b - 1, heap_min: 10_000 })), ["node_low_memory"]);
  assert.deepEqual(codes(b.say(60, { uptime_s: 100_120, heap_free: HEALTH_LEVELS.low_heap_b + 1_000, heap_min: 10_000 })), ["node_low_memory"]);   // hovering around the line: still warned
  assert.deepEqual(codes(b.say(60, { uptime_s: 100_180, heap_free: HEALTH_LEVELS.low_heap_clear_b, heap_min: 10_000 })), []);
  assert.deepEqual(codes(b.say(60, { uptime_s: 100_240, low_stack_tasks: 1 })), ["node_low_memory"]);
  assert.equal(b.store.list()[0].warnings[0].detail.low_stack_tasks, 1);
  assert.deepEqual(codes(b.say(60, { uptime_s: 100_300, low_stack_tasks: 0 })), []);
});

test("a restart is seen when the uptime goes back, and three in a day (or a crash in the last hour) warn", () => {
  const b = bench();
  b.say(0, { uptime_s: 100_000 });
  assert.equal(b.say(60, { uptime_s: 100_060 }).restarts_24h, 0);
  assert.equal(b.say(60, { uptime_s: 5, reset_reason: "software", broker_reconnects: 1 }).restarts_24h, 1);       // an update: normal
  assert.deepEqual(codes(b.say(60, { uptime_s: 65 })), []);
  b.say(3600, { uptime_s: 3_700 });
  assert.equal(b.say(60, { uptime_s: 3 , reset_reason: "power_on" }).restarts_24h, 2);
  b.say(3600, { uptime_s: 3_660 });
  const third = b.say(60, { uptime_s: 3, reset_reason: "external" });
  assert.deepEqual([third.restarts_24h, codes(third)], [3, ["node_frequent_resets"]]);
  assert.equal(third.warnings[0].detail.restarts_24h, 3);
  // a day later the three are old: the warning goes
  b.advance(25 * 3600);
  assert.deepEqual(codes(b.say(0, { uptime_s: 90_000 })), []);
  // a crash warns by itself for an hour
  const crash = b.say(60, { uptime_s: 4, reset_reason: "task_wdt" });
  assert.deepEqual([crash.restarts_24h, codes(crash), crash.last_restart?.abnormal, crash.last_restart?.reason], [1, ["node_frequent_resets"], true, "task_wdt"]);
  assert.deepEqual(codes(b.say(61 * 60, { uptime_s: 3_700 })), []);
});

test("a node first heard just after it started counts one restart, and only once", () => {
  const b = bench();
  const first = b.say(0, { uptime_s: 20, reset_reason: "panic" });
  assert.deepEqual([first.restarts_24h, codes(first)], [1, ["node_frequent_resets"]]);
  b.say(60, { uptime_s: 80, reset_reason: "panic" });
  assert.equal(b.store.get("alarm-1")?.restarts.length, 1);
  // a node first heard long after it started is not a restart
  const other = bench();
  assert.equal(other.say(0, { uptime_s: 50_000 }).restarts_24h, 0);
  // the count of connections going back also says the node restarted
  const reconnects = bench();
  reconnects.say(0, { uptime_s: 50_000, broker_reconnects: 7 });
  assert.equal(reconnects.say(60, { uptime_s: 50_060, broker_reconnects: 1 }).restarts_24h, 1);
});

test("a node that keeps losing the broker is flapping, and a restart is not a lost broker", () => {
  const b = bench();
  b.say(0, { uptime_s: 100_000, broker_reconnects: 1 });
  assert.deepEqual(codes(b.say(60, { uptime_s: 100_060, broker_reconnects: 2 })), []);
  assert.deepEqual(codes(b.say(60, { uptime_s: 100_120, broker_reconnects: 3 })), []);
  const flapping = b.say(60, { uptime_s: 100_180, broker_reconnects: 4 });
  assert.deepEqual(codes(flapping), ["node_link_flapping"]);
  assert.equal(flapping.warnings[0].detail.reconnects, 3);
  // quiet for a while: the window slides past and the warning ends
  assert.deepEqual(codes(b.say(20 * 60, { uptime_s: 101_400, broker_reconnects: 4 })), []);
  // a restart brings the count back to 1: not three losses
  const restarted = bench();
  restarted.say(0, { uptime_s: 100_000, broker_reconnects: 2 });
  restarted.say(60, { uptime_s: 100_060, broker_reconnects: 2 });
  const afterRestart = restarted.say(60, { uptime_s: 10, broker_reconnects: 1, reset_reason: "software" });
  assert.deepEqual(codes(afterRestart), []);
  // a cable that is down in two of the last reports is flapping too
  const cable = bench();
  cable.say(0, { uptime_s: 100_000 });
  cable.say(60, { uptime_s: 100_060, link_up: false });
  assert.deepEqual(codes(cable.say(60, { uptime_s: 100_120, link_up: false })), ["node_link_flapping"]);
});

test("a Wi-Fi signal that stays at -80 dBm or worse warns, and a better one clears it", () => {
  const b = bench();
  const weak = (extra: Partial<NodeHealthMessage> = {}) => b.say(60, { uptime_s: 100_000, ...extra }, wifi());
  b.say(0, { uptime_s: 100_000, rssi_dbm: -85 }, wifi());
  assert.deepEqual(codes(weak({ rssi_dbm: -85 })), []);                                   // two weak reports are not yet a trend
  assert.deepEqual(codes(weak({ rssi_dbm: -81 })), ["node_weak_signal"]);
  assert.deepEqual(codes(weak({ rssi_dbm: -79 })), []);
  // a cable never has a signal, so it never warns of one
  const cable = bench();
  for (let i = 0; i < 4; i += 1) assert.deepEqual(codes(cable.say(60, { uptime_s: 100_000 + i })), []);
});

test("a node that stops reporting is shown as stale with its last report, and nothing else changes", () => {
  const b = bench();
  b.say(0, { uptime_s: 100_000, heap_free: 1_000 });
  b.advance(HEALTH_LEVELS.silent_after_s + 1);
  const [view] = b.store.list();
  assert.deepEqual([view.stale, view.status, view.warnings.length, view.report.heap_free], [true, "stale", 1, 1_000]);
  assert.equal(b.store.totals().stale, 1);
});

test("an older report is dropped, the store is bounded, a node can be forgotten and the restarts survive a restart of the server", () => {
  const b = bench({ maxNodes: 2 });
  b.say(0, { uptime_s: 100_000 });
  const old = b.store.ingest(report({ timestamp_ms: 5, uptime_s: 1 }));
  assert.equal(old.report.uptime_s, 100_000);
  b.store.ingest(report({ node_id: "solar-1", family: "solar", timestamp_ms: 1 }));
  assert.throws(() => b.store.ingest(report({ node_id: "radar-1", family: "radar" })), /too many/);
  b.say(60, { uptime_s: 4, reset_reason: "brownout" });
  const saved = JSON.parse(JSON.stringify(b.store.export())) as ReturnType<typeof b.store.export>;
  const again = new NodeHealthStore({ now: () => 1_800_000_000_000 + 400_000 });
  again.import(saved);
  const back = again.get("alarm-1");
  assert.ok(back);
  assert.deepEqual([back.report.node_id, back.restarts.length, back.restarts[0].reason, back.samples.length], ["alarm-1", 1, "brownout", 0]);
  again.import({ nodes: { "bad id": { report: report({ node_id: "x" }), received_at_ms: 1, restarts: [] }, other: { report: { nonsense: true } as never, received_at_ms: 1, restarts: [] } } });   // damaged entries are skipped
  assert.equal(again.list().length, 2);
  assert.equal(b.store.remove("solar-1"), true);
  assert.equal(b.store.remove("solar-1"), false);
  assert.deepEqual(b.forgotten, ["solar-1"]);
});

// ---- the alarms the warnings raise ----------------------------------------------------------------------------------------------------

test("each warning is raised in the alarm centre while it lasts, as a warning, and cleared when it ends or the node is forgotten", async () => {
  const { AlarmCentre, AlarmRules } = await import("../src/alarms.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-health-"));
  const centre = new AlarmCentre({ file: path.join(dir, "alarms.json") });
  const rules = new AlarmRules(centre, () => "disarmed");
  const open = () => centre.active().filter(alarm => !alarm.cleared_at).map(alarm => `${alarm.code}:${alarm.severity}:${alarm.source.type}/${alarm.source.id}`).sort();
  const b = bench();
  const store = new NodeHealthStore({ now: () => 1_800_000_000_000, onReport: view => rules.handleNodeHealth(view), onForget: node => rules.forgetNodeHealth(node) });
  void b;
  store.ingest(report({ uptime_s: 100_000, heap_free: 5_000, heap_min: 4_000 }));
  assert.deepEqual(open(), ["node_low_memory:warning:node/alarm-1"]);
  store.ingest(report({ timestamp_ms: 2000, uptime_s: 100_060, heap_free: 150_000, heap_min: 4_000 }));
  assert.deepEqual(open(), []);
  store.ingest(report({ timestamp_ms: 3000, uptime_s: 100_120, heap_free: 5_000, heap_min: 4_000 }));
  assert.equal(open().length, 1);
  store.remove("alarm-1");
  assert.deepEqual(open(), []);
});

// ---- the routes -----------------------------------------------------------------------------------------------------------------------

test("a node posts its report with the ingest token, an operator reads them, and an administrator forgets a node", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const post = (body: unknown, token: string | null = SECRETS.ARMOR_INGEST_TOKEN) => fetch(`${running.base}/api/v1/node-health`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post(report(), null)).status, 401);
    assert.equal((await post(report(), "wrong-token-wrong-token-wrong-token-1")).status, 401);
    const accepted = await post(report({ timestamp_ms: 0, uptime_s: 100_000, heap_free: 5_000, heap_min: 3_000 }));
    assert.equal(accepted.status, 202);
    const newer = await post({ ...report({ node_id: "solar-1", family: "solar", uptime_s: 100_000 }), cpu_c: 41 });                    // a node newer than the server: the field is dropped and said
    assert.deepEqual([newer.status, ((await newer.json()) as { ignored: string[] }).ignored], [202, ["node health.cpu_c"]]);
    assert.equal((await post({ ...report(), heap_min: 999_999 })).status, 400);                                                          // a rule that joins two fields
    assert.equal((await post({ ...report(), reset_reason: "cosmic_ray" })).status, 400);
    assert.equal((await post("nonsense")).status, 400);

    assert.equal((await fetch(`${running.base}/api/v1/node-health`)).status, 401);                                                       // not for strangers
    const listed = (await (await fetch(`${running.base}/api/v1/node-health`, { headers: { cookie } })).json()) as {
      nodes: Array<{ node_id: string; status: string; warnings: Array<{ code: string }> }>; waiting: unknown[]; totals: { nodes: number; with_warnings: number }; levels: { low_heap_b: number } };
    assert.deepEqual(listed.nodes.map(node => `${node.node_id}:${node.status}`), ["alarm-1:warning", "solar-1:ok"]);
    assert.deepEqual(listed.nodes[0].warnings.map(item => item.code), ["node_low_memory"]);
    assert.deepEqual([listed.totals.nodes, listed.totals.with_warnings, listed.levels.low_heap_b], [2, 1, 30_000]);

    const alarms = (await (await fetch(`${running.base}/api/v1/alarms`, { headers: { cookie } })).json()) as { active: Array<{ code: string; severity: string; source: { type: string; id: string } }> };
    assert.ok(alarms.active.some(alarm => alarm.code === "node_low_memory" && alarm.severity === "warning" && alarm.source.id === "alarm-1"));

    // a node that has spoken in its own way and sent no report is said to be waiting
    const telemetry = await fetch(`${running.base}/api/v1/telemetry`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify({ node_id: "north-1", timestamp_ms: 0, lux: 3, targets: [] }) });
    assert.equal(telemetry.status, 202);
    const again = (await (await fetch(`${running.base}/api/v1/node-health`, { headers: { cookie } })).json()) as { waiting: Array<{ node_id: string; family: string }> };
    assert.deepEqual(again.waiting, [{ node_id: "north-1", family: "radar" }]);

    const detail = (await (await fetch(`${running.base}/api/v1/node-health/alarm-1`, { headers: { cookie } })).json()) as { samples: unknown[]; restarts: unknown[]; report: { heap_free: number } };
    assert.deepEqual([detail.samples.length, detail.report.heap_free], [1, 5_000]);
    assert.equal((await fetch(`${running.base}/api/v1/node-health/nobody`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${running.base}/api/v1/node-health/Bad%20Id`, { headers: { cookie } })).status, 404);

    assert.equal((await fetch(`${running.base}/api/v1/node-health/alarm-1`, { method: "DELETE" })).status, 401);
    assert.equal((await fetch(`${running.base}/api/v1/node-health/alarm-1`, { method: "DELETE", headers: { cookie } })).status, 204);
    assert.equal((await fetch(`${running.base}/api/v1/node-health/alarm-1`, { method: "DELETE", headers: { cookie } })).status, 404);
    const after = (await (await fetch(`${running.base}/api/v1/alarms`, { headers: { cookie } })).json()) as { active: Array<{ code: string; cleared_at?: string }> };
    assert.ok(after.active.filter(alarm => alarm.code === "node_low_memory").every(alarm => alarm.cleared_at));
  } finally { await running.stop(); }
});
