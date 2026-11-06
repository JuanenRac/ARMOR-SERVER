// The optional copy of the node traffic: off by default, JSON lines the simulator plays, no secrets, a size limit with rotation, and an administrator-only switch that is written in the audit trail.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { IngestRecorder, withoutSecrets } from "../src/ingest_recorder.js";
import { readConfig } from "../src/config.js";
import { SECRETS, startServer, studioCookie, tempDir, testConfig } from "./helpers.js";

const reading = (extra: Record<string, unknown> = {}) => JSON.stringify({ node_id: "north-1", timestamp_ms: 1000, lux: 120, targets: [], ...extra });
const lines = (file: string) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);

test("nothing is written while the option is off", () => {
  const dir = path.join(tempDir(), "rec");
  const recorder = new IngestRecorder({ dir, enabled: () => false, maxBytes: 100_000, maxFiles: 2 });
  recorder.record("armor/node/north-1/telemetry", reading(), true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(recorder.state().enabled, false);
});

test("a line has the topic and payload the simulator plays, and when, whether and why", () => {
  const dir = path.join(tempDir(), "rec");
  let on = true;
  const recorder = new IngestRecorder({ dir, enabled: () => on, maxBytes: 100_000, maxFiles: 2, now: () => Date.parse("2026-01-02T03:04:05Z") });
  recorder.record("armor/node/north-1/telemetry", reading(), true);
  recorder.record("armor/node/north-1/telemetry", reading({ lux: "bright" }), false, "lux must be a number");
  on = false;
  recorder.record("armor/node/north-1/telemetry", reading(), true);
  const written = lines(path.join(dir, "ingest.jsonl"));
  assert.equal(written.length, 2);
  assert.deepEqual(Object.keys(written[0]).sort(), ["accepted", "at", "payload", "topic"]);
  assert.equal(written[0].at, "2026-01-02T03:04:05.000Z");
  assert.equal(written[1].accepted, false);
  assert.equal(written[1].reason, "lux must be a number");
});

test("what the simulator cannot play is not written, and no secret is", () => {
  const dir = path.join(tempDir(), "rec");
  const recorder = new IngestRecorder({ dir, enabled: () => true, maxBytes: 100_000, maxFiles: 2 });
  recorder.record("http:alarm/a", reading(), true);                              // not an armor/ topic
  recorder.record("armor/node/a/telemetry", "{not json", false, "x");           // not JSON
  recorder.record("armor/node/a/telemetry", "[1,2]", false, "x");               // not an object
  recorder.record("armor/control/a/command", JSON.stringify({ token: "one-time-abc", action: "x" }), true);   // an order to a node
  recorder.record("armor/solar/n/maintenance/x", JSON.stringify({ token: "one-time-abc" }), true);
  recorder.record("armor/node/a/info", JSON.stringify({ node_id: "a", wifi_password: "hunter2", api_token: "t0k3n", nested: { secret_key: "k", ok: 1 }, list: [{ pin: "1234", v: 2 }] }), true);
  const written = lines(path.join(dir, "ingest.jsonl"));
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].payload, { node_id: "a", nested: { ok: 1 }, list: [{ v: 2 }] });
  assert.equal(recorder.state().skipped, 2);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "ingest.jsonl"), "utf8"), /hunter2|t0k3n|one-time|1234/);
  assert.deepEqual(withoutSecrets({ a: { Authorization: "x", b: 1 } }), { a: { b: 1 } });
});

test("the file is rotated at the limit and no more than the configured files are kept", () => {
  const dir = path.join(tempDir(), "rec");
  const recorder = new IngestRecorder({ dir, enabled: () => true, maxBytes: 1000, maxFiles: 3 });
  for (let index = 0; index < 60; index += 1) recorder.record("armor/node/north-1/telemetry", reading({ lux: index }), true);
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ["ingest.1.jsonl", "ingest.2.jsonl", "ingest.jsonl"]);
  for (const name of names) assert.ok(fs.statSync(path.join(dir, name)).size <= 1000, name);
  assert.ok(recorder.state().rotations > 1);
  assert.equal(recorder.state().max_files, 3);
});

test("the limits come from the configuration and a wrong one is refused", () => {
  const config = testConfig({ ARMOR_INGEST_RECORD_MAX_BYTES: "100000", ARMOR_INGEST_RECORD_FILES: "2" });
  assert.deepEqual([config.ingestRecordMaxBytes, config.ingestRecordFiles], [100000, 2]);
  assert.deepEqual([testConfig().ingestRecordMaxBytes, testConfig().ingestRecordFiles], [8 * 1024 * 1024, 4]);
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_DATA_DIR: tempDir(), ARMOR_INGEST_RECORD_MAX_BYTES: "10" }), /ARMOR_INGEST_RECORD_MAX_BYTES/);
  assert.throws(() => readConfig({ ...SECRETS, ARMOR_DATA_DIR: tempDir(), ARMOR_INGEST_RECORD_FILES: "0" }), /ARMOR_INGEST_RECORD_FILES/);
});

test("the route is for an administrator, is off by default, copies what arrives only when on, and is audited", async () => {
  const running = await startServer();
  try {
    const url = `${running.base}/api/v1/system/ingest/recording`;
    const json = { "Content-Type": "application/json" };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: "PUT", headers: json, body: JSON.stringify({ enabled: true }) })).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` } })).status >= 400, true);   // an operator is not an administrator
    const cookie = await studioCookie(running.base);
    const state = await (await fetch(url, { headers: { cookie } })).json() as { enabled: boolean; lines: number; max_bytes: number };
    assert.equal(state.enabled, false);
    const send = (body: unknown) => fetch(`${running.base}/api/v1/telemetry`, { method: "POST", headers: { ...json, Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify(body) });
    const message = { node_id: "north-1", timestamp_ms: Date.now(), lux: 120, targets: [] };
    assert.equal((await send(message)).status, 202);
    assert.equal(fs.existsSync(path.join(running.config.dataDir, "ingest-recording")), false);
    assert.equal((await fetch(url, { method: "PUT", headers: { ...json, cookie }, body: JSON.stringify({ enabled: "yes" }) })).status, 400);
    const on = await fetch(url, { method: "PUT", headers: { ...json, cookie }, body: JSON.stringify({ enabled: true }) });
    assert.equal(on.status, 200);
    assert.equal(((await on.json()) as { enabled: boolean }).enabled, true);
    assert.equal((await send(message)).status, 202);
    assert.equal((await send({ ...message, lux: "bright" })).status, 400);
    const written = lines(path.join(running.config.dataDir, "ingest-recording", "ingest.jsonl"));
    assert.deepEqual(written.map(line => [line.topic, line.accepted]), [["armor/node/north-1/telemetry", true], ["armor/node/north-1/telemetry", false]]);
    assert.match(String(written[1].reason), /lux/);
    assert.equal(((await (await fetch(url, { headers: { cookie } })).json()) as { lines: number }).lines, 2);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /ingest\.recording/);
    assert.equal(((await (await fetch(url, { method: "PUT", headers: { ...json, cookie }, body: JSON.stringify({ enabled: false }) })).json()) as { enabled: boolean }).enabled, false);
  } finally { await running.stop(); }
});
