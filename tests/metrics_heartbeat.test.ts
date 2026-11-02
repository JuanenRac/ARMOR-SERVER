import assert from "node:assert/strict";
import test from "node:test";
import { Heartbeat, parseHeartbeatUrl } from "../src/heartbeat.js";
import { metricsTokenOk, renderPrometheus } from "../src/metrics_export.js";
import { SECURITY_DEFAULTS } from "../src/security_settings.js";
import { startServer, studioCookie } from "./helpers.js";

const TOKEN = "m".repeat(32);

test("both options are off by default", () => {
  assert.equal(SECURITY_DEFAULTS["metrics.prometheus"], false);
  assert.equal(SECURITY_DEFAULTS["heartbeat.enabled"], false);
});

test("the text page escapes labels and holds no secret", () => {
  const page = renderPrometheus({
    sample: { at_ms: 1, cpu: { percent: 12.5, cores: 4, load: [0, 0, 0] }, memory: { total: 100, used: 40, available: 60, swap_total: 0, swap_used: 0 }, temperatures: [{ name: 'a"b', celsius: 50 }], disks: [], network: [], uptime_s: 1 },
    nodes: [{ online: true }, { online: false }], activeAlarms: 2, ingest: [{ topic: "armor/x", accepted: 3, rejected: 1, ignored_fields: [], last_ok_at: null, last_error: "secret text", last_error_at: null, last_payload: "secret payload" }],
    version: "1.2.3", startedMs: 0, nowMs: 5000,
  });
  assert.match(page, /armor_nodes\{state="online"\} 1/);
  assert.match(page, /armor_alarms_active 2/);
  assert.match(page, /armor_temperature_celsius\{zone="a\\"b"\} 50/);
  assert.match(page, /armor_ingest_rejected_total\{topic="armor\/x"\} 1/);
  assert.doesNotMatch(page, /secret/);
});

test("the bearer token is compared exactly and an empty token never matches", () => {
  assert.equal(metricsTokenOk(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(metricsTokenOk(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(metricsTokenOk(undefined, TOKEN), false);
  assert.equal(metricsTokenOk("Bearer ", ""), false);
  assert.equal(metricsTokenOk("Bearer a", ""), false);
});

test("/metrics answers 404 while off or with no token, 401 for a wrong token, and the page for the right one", async () => {
  const noToken = await startServer();
  try { assert.equal((await fetch(`${noToken.base}/metrics`)).status, 404); } finally { await noToken.stop(); }
  const running = await startServer({ ARMOR_METRICS_TOKEN: TOKEN });
  try {
    assert.equal((await fetch(`${running.base}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 404, "off by default");
    const cookie = await studioCookie(running.base);
    const put = await fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ "metrics.prometheus": true }) });
    assert.equal(put.status, 200);
    assert.equal((await fetch(`${running.base}/metrics`)).status, 401);
    assert.equal((await fetch(`${running.base}/metrics`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const ok = await fetch(`${running.base}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /text\/plain/);
    assert.match(await ok.text(), /^# HELP armor_build_info/m);
  } finally { await running.stop(); }
});

test("the heartbeat address is checked and a ping is sent only while the option is on", async () => {
  assert.equal(parseHeartbeatUrl("https://hc-ping.example.org/abc"), "https://hc-ping.example.org/abc");
  assert.equal(parseHeartbeatUrl("ftp://x/y"), undefined);
  assert.equal(parseHeartbeatUrl("https://user:pw@x.org/"), undefined);
  assert.equal(parseHeartbeatUrl("https://x.org/a b"), undefined);
  let on = false;
  const seen: string[] = [];
  const fake = (async (url: string) => { seen.push(String(url)); return { ok: seen.length !== 3, status: 500 } as Response; }) as unknown as typeof fetch;
  const beat = new Heartbeat({ url: "https://hc-ping.example.org/abc", everyS: 60, enabled: () => on, fetchImpl: fake, now: () => 0 });
  assert.equal(await beat.beat(), false);
  assert.equal(seen.length, 0, "off: nothing leaves");
  on = true;
  assert.equal(await beat.beat(), true);
  assert.equal(await beat.beat(), true);
  assert.equal(await beat.beat(), false, "a 500 is a failure, counted, not thrown");
  assert.deepEqual([beat.state.sent, beat.state.failed], [3, 1]);
  assert.doesNotMatch(beat.state.last_error ?? "", /hc-ping/);
  assert.equal(await new Heartbeat({ url: "", everyS: 60, enabled: () => true, fetchImpl: fake }).beat(), false, "no address: nothing leaves");
});
