// The cap on the maintenance a node may announce is a setting of Studio (nodes.maintenance_max_s): its range, its start from the environment, the cut of a longer report and the value in force.
import assert from "node:assert/strict";
import test from "node:test";
import { lowers, NODE_MAINTENANCE_MAX_S, SECURITY_DEFAULTS } from "../src/security_settings.js";
import { startServer, studioCookie } from "./helpers.js";

const json = { "Content-Type": "application/json" };

test("the cap of maintenance: default 600, range 60 to 86400, and a longer cap is the loss", () => {
  assert.deepEqual(NODE_MAINTENANCE_MAX_S, { min: 60, max: 86_400, default: 600 });
  assert.equal(SECURITY_DEFAULTS["nodes.maintenance_max_s"], 600);
  assert.equal(lowers("nodes.maintenance_max_s", 600, 3600), true);
  assert.equal(lowers("nodes.maintenance_max_s", 3600, 600), false);
});

test("the cap starts from the environment, Studio changes it within the range and the answer shows the value in force", async () => {
  const running = await startServer({ ARMOR_NODE_MAINTENANCE_MAX_S: "1800" });
  try {
    const admin = await studioCookie(running.base);
    const settings = running.app.context.securitySettings;
    assert.equal(settings.get("nodes.maintenance_max_s"), 1800, "the environment is where it starts");
    const set = (body: Record<string, unknown>) => fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify(body) });
    for (const bad of [59, 86_401, 1.5, "600", null]) assert.equal((await set({ "nodes.maintenance_max_s": bad })).status, 400, String(bad));
    assert.equal(settings.get("nodes.maintenance_max_s"), 1800);
    assert.equal((await set({ "nodes.maintenance_max_s": 90 })).status, 200);
    assert.equal(settings.get("nodes.maintenance_max_s"), 90);
    const answer = await (await fetch(`${running.base}/api/v1/security/settings`, { headers: { cookie: admin } })).json() as { settings: Record<string, unknown>; defaults: Record<string, unknown> };
    assert.equal(answer.settings["nodes.maintenance_max_s"], 90);
    assert.equal(answer.defaults["nodes.maintenance_max_s"], 600);
  } finally { await running.stop(); }
});

const health = (id: string, family: string, extra: Record<string, unknown> = {}) => ({
  kind: "node_health", node_id: id, timestamp_ms: 1000, family, firmware: "0.3.6", board: "s3-eth", uptime_s: 3600, reset_reason: "power_on", heap_free: 142_000, heap_min: 98_000, link: "ethernet", link_up: true,
  broker_reconnects: 1, low_stack_tasks: 0, ...extra,
}) as never;

test("a node that announces or reports a maintenance longer than the cap is cut to the cap, and the cap changed in Studio acts at once", async () => {
  const running = await startServer({});
  try {
    const { context } = running.app;
    assert.equal(context.securitySettings.get("nodes.maintenance_max_s"), 600, "no variable: the default");
    context.nodeHealth.ingest(health("radar-1", "radar"));
    context.nodeControl.handleMaintenance({ kind: "node_maintenance", node_id: "radar-1", timestamp_ms: 2000, active: true, reason: "update", expected_s: 3600, firmware: "0.3.6" } as never, "radar-1");
    assert.equal(context.nodeControl.windowOf("radar-1")!.expires_in_s, 600, "the announcement is cut to the default cap");
    context.nodeHealth.ingest(health("solar-1", "solar", { control_state: "running", maintenance: true, maintenance_until_s: 86_400 }));
    assert.ok((context.nodeHealth.get("solar-1")!.control?.maintenance_until_s ?? 0) <= 600, "the health report is cut to the cap too");
    context.securitySettings.update({ "nodes.maintenance_max_s": 1800 });
    context.nodeHealth.ingest(health("electrical-1", "electrical"));
    context.nodeControl.handleMaintenance({ kind: "node_maintenance", node_id: "electrical-1", timestamp_ms: 2000, active: true, reason: "update", expected_s: 3600, firmware: "0.3.6" } as never, "electrical-1");
    assert.equal(context.nodeControl.windowOf("electrical-1")!.expires_in_s, 1800, "the new cap is in force without a restart");
  } finally { await running.stop(); }
});
