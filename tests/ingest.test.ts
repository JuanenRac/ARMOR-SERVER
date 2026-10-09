// What a node sent that the server took, ignored or refused: forward-compatible reading and the log Studio shows.
import assert from "node:assert/strict";
import test from "node:test";
import { forwardCompatible } from "../src/contracts.js";
import { IngestLog } from "../src/ingest_log.js";
import { parseSolarMessage } from "../src/solar.js";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

const inverter = (extra: Record<string, unknown> = {}) => ({
  kind: "inverter", node_id: "solar-1", device: "axpert-1", timestamp_ms: 1000, mode: "line", grid_v: 232, grid_hz: 50, out_v: 230, out_hz: 50, out_va: 161, out_w: 119, load_percent: 3,
  battery_v: 57.5, battery_a: 12, battery_percent: 100, pv_v: 103.8, pv_a: 14, pv_w: 856, heatsink_c: 69, ac_charging: false, pv_charging: true, load_on: true, warnings: [], ...extra,
});

test("a field of a newer firmware is dropped and reported, and everything else is still checked", () => {
  const body = inverter({ bus_v: 380, units: [{ unit: 0, mode: "line", extra_unit_field: 1 }] });
  assert.throws(() => parseSolarMessage(structuredClone(body)), /unknown field/);                    // the plain parser stays strict (the conformance tests use it)
  const { value, ignored } = forwardCompatible(() => parseSolarMessage(structuredClone(body)));
  assert.deepEqual(ignored.sort(), ["inverter.bus_v", "unit 0.extra_unit_field"]);
  assert.equal("bus_v" in value, false);
  assert.throws(() => forwardCompatible(() => parseSolarMessage(inverter({ bus_v: 1, pv_w: -5 }))), /pv_w/);   // an unknown field never excuses a wrong known one
  assert.throws(() => forwardCompatible(() => parseSolarMessage({ ...inverter(), mode: "sleeping" })), /mode/);
  assert.throws(() => parseSolarMessage(inverter({ bus_v: 1 })), /unknown field/);                    // and the collector is off again afterwards
});

test("the log counts what was taken and refused, and keeps the last refusal", () => {
  let now = Date.parse("2026-10-10T10:00:00Z");
  const log = new IngestLog(() => now);
  log.ok("armor/solar/a/b/state", ["inverter.bus_v"]);
  log.ok("armor/solar/a/b/state", ["inverter.bus_v", "inverter.fw"]);
  now += 1000;
  log.rejected("armor/solar/a/b/state", "invalid pv_w", "x".repeat(900));
  const [entry] = log.list();
  assert.equal(entry.accepted, 2);
  assert.equal(entry.rejected, 1);
  assert.deepEqual(entry.ignored_fields, ["inverter.bus_v", "inverter.fw"]);
  assert.equal(entry.last_error, "invalid pv_w");
  assert.ok(entry.last_payload!.length <= 401);
  assert.equal(entry.last_error_at, "2026-10-10T10:00:01.000Z");
  for (let index = 0; index < 400; index += 1) log.ok(`t/${index}`);
  assert.ok(log.list().length <= 200);                                                                 // noise cannot grow it without limit
});

test("the route takes a message with an unknown field, and an operator reads the log", async () => {
  const running = await startServer();
  try {
    const post = (body: unknown) => fetch(`${running.base}/api/v1/solar`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify(body) });
    const answer = await post(inverter({ bus_v: 380 }));
    assert.equal(answer.status, 202);
    assert.deepEqual(((await answer.json()) as { ignored: string[] }).ignored, ["inverter.bus_v"]);
    assert.equal((await post(inverter({ pv_w: -1 }))).status, 400);
    assert.equal((await fetch(`${running.base}/api/v1/system/ingest`)).status, 401);
    const cookie = await studioCookie(running.base);
    const { topics } = await (await fetch(`${running.base}/api/v1/system/ingest`, { headers: { cookie } })).json() as { topics: Array<{ topic: string; accepted: number; rejected: number; ignored_fields: string[]; last_error: string | null }> };
    const ok = topics.find(topic => topic.topic === "http:solar/solar-1/axpert-1")!;
    assert.deepEqual([ok.accepted, ok.ignored_fields], [1, ["inverter.bus_v"]]);
    assert.match(topics.find(topic => topic.topic === "http:solar")!.last_error ?? "", /pv_w/);
  } finally { await running.stop(); }
});
