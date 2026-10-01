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
