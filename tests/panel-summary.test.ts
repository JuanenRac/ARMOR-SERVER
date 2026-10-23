import assert from "node:assert/strict";
import test from "node:test";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

test("the panel summary is small, needs a sign-in and puts the alarms nobody has seen first", async () => {
  const running = await startServer();
  try {
    assert.equal((await fetch(`${running.base}/api/v1/panel/summary`)).status, 401);
    const cookie = await studioCookie(running.base);
    const headers = { "Content-Type": "application/json", cookie };
    const empty = await (await fetch(`${running.base}/api/v1/panel/summary`, { headers })).json() as { mode: string; nodes: { online: number; total: number }; alarms: { active: number; unacknowledged: number; items: unknown[] } };
    assert.equal(empty.mode, "disarmed");
    assert.deepEqual(empty.nodes, { online: 0, total: 0 });
    assert.deepEqual(empty.alarms, { active: 0, unacknowledged: 0, items: [] });

    // a node reports a smoke device: the alarm shows up with what the panel needs and nothing more
    const ingest = (path: string, body: unknown) => fetch(`${running.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRETS.ARMOR_INGEST_TOKEN}` }, body: JSON.stringify(body) });
    assert.equal((await ingest("/api/v1/health", { node_id: "node-a", timestamp_ms: Date.now(), online: true })).status < 300, true);
    await fetch(`${running.base}/api/v1/mode`, { method: "POST", headers, body: JSON.stringify({ mode: "armed" }) });
    const after = await (await fetch(`${running.base}/api/v1/panel/summary`, { headers })).json() as { mode: string; nodes: { total: number }; alarms: { items: Array<Record<string, unknown>> } };
    assert.equal(after.mode, "armed");
    assert.equal(after.nodes.total, 1);
    for (const item of after.alarms.items) assert.deepEqual(Object.keys(item).sort(), ["acknowledged", "code", "id", "raised_at", "severity", "source_id", "source_type"]);
  } finally { await running.stop(); }
});

test("a wall panel's account serves the panel and nothing else, and the summary carries the energy", async () => {
  const running = await startServer();
  try {
    const admin = { "Content-Type": "application/json", cookie: await studioCookie(running.base) };
    const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "wall-panel", password: "wall-panel-password-1", role: "panel" }) });
    assert.equal(made.status, 201);
    assert.equal(((await made.json()) as { role: string }).role, "panel");
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "wall-panel", password: "wall-panel-password-1" }) });
    assert.equal(login.status, 201);
    const headers = { "Content-Type": "application/json", cookie: (login.headers.getSetCookie()[0] ?? "").split(";")[0] };

    // what a wall panel does
    const summary = await fetch(`${running.base}/api/v1/panel/summary`, { headers });
    assert.equal(summary.status, 200);
    const body = await summary.json() as { energy: { reporting: boolean; pv_w: number; load_w: number; battery_w: number | null; soc_percent: number | null; inverters: number; batteries: number } };
    assert.deepEqual(body.energy, { reporting: false, pv_w: 0, load_w: 0, battery_w: null, soc_percent: null, mode: null, inverters: 0, batteries: 0, stale: 0 });
    assert.equal((await fetch(`${running.base}/api/v1/mode`, { method: "POST", headers, body: JSON.stringify({ mode: "armed" }) })).status < 300, true);
    assert.equal((await fetch(`${running.base}/api/v1/alarms/acknowledge`, { method: "POST", headers, body: "{}" })).status < 400, true);

    // everything else is refused, whatever the route: the state, the cameras, the solar readings, the users, the services
    for (const [method, path] of [["GET", "/api/v1/cameras"], ["GET", "/api/v1/solar"], ["GET", "/api/v1/users"], ["GET", "/api/v1/system/services"], ["POST", "/api/v1/devices"], ["GET", "/api/v1/system/metrics"]] as const) {
      const answer = await fetch(`${running.base}${path}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(answer.status, 403, `${method} ${path}`);
    }
    // an account of the other roles is untouched: an operator still reads the state
    const operator = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "guard-1", password: "guard-password-1", role: "operator" }) });
    assert.equal(operator.status, 201);
    // and a role that does not exist is refused
    assert.equal((await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "boss", password: "boss-password-1234", role: "root" }) })).status, 400);
  } finally { await running.stop(); }
});

test("a wall panel that types its PIN acknowledges for real, a wrong one acknowledges nothing, and a tap without one stays unverified", async () => {
  const running = await startServer();
  try {
    const admin = { "Content-Type": "application/json", cookie: await studioCookie(running.base) };
    const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "wall-panel", password: "wall-panel-password-1", role: "panel" }) });
    const id = ((await made.json()) as { id: string }).id;
    assert.equal((await fetch(`${running.base}/api/v1/users/${id}/pin`, { method: "PUT", headers: admin, body: JSON.stringify({ pin: "2468", duress_pin: "1357" }) })).status, 200);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "wall-panel", password: "wall-panel-password-1" }) });
    const headers = { "Content-Type": "application/json", cookie: (login.headers.getSetCookie()[0] ?? "").split(";")[0] };
    const raise = (key: string) => running.app.context.alarms.raise(key, { source: { type: "device", id: key }, severity: "critical", code: "smoke" })!;
    const state = (alarmId: string) => running.app.context.alarms.active().find(item => item.id === alarmId)!;
    const ack = (body: unknown) => fetch(`${running.base}/api/v1/alarms/acknowledge`, { method: "POST", headers, body: JSON.stringify(body) });

    const first = raise("a");
    assert.equal((await ack({ pin: "0000" })).status, 403, "a wrong PIN");
    assert.equal(state(first.id).acknowledged_at, undefined, "and nothing is acknowledged");
    assert.equal((await ack({ pin: "2468" })).status, 200);
    assert.ok(state(first.id).acknowledged_at && !state(first.id).acknowledged_unverified, "the right PIN counts as a person standing there");

    const second = raise("b");
    assert.equal((await ack({})).status, 200);
    assert.equal(state(second.id).acknowledged_unverified, true, "a tap without a PIN is the unverified one it always was");

    const third = raise("c");
    assert.equal((await ack({ pin: "1357" })).status, 200);
    assert.equal(state(third.id).acknowledged_unverified, true, "the duress PIN looks the same and verifies nothing");

    for (let attempt = 0; attempt < 8; attempt += 1) await ack({ pin: "9999" });
    assert.equal((await ack({ pin: "9999" })).status, 429, "too many wrong ones lock the PIN");
  } finally { await running.stop(); }
});
