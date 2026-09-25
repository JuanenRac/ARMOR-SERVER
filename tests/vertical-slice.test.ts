import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SECRETS, startServer } from "./helpers.js";

const family = path.resolve(import.meta.dirname, "..", "..");
const common = path.join(family, "ARMOR-COMMON", "src");
const simulator = path.join(family, "ARMOR-SIMULATOR", "src");
const python = process.env.ARMOR_PYTHON || (process.platform === "win32" ? "python" : "python3");
const probe = fs.existsSync(common) && fs.existsSync(simulator) ? spawnSync(python, ["--version"]) : undefined;
const available = Boolean(probe && probe.status === 0);

test("the simulator, the shared contract and the real server agree end to end", { skip: available ? false : "the sibling ARMOR repositories or Python are not available" }, async () => {
  const running = await startServer({ ARMOR_ALERT_DWELL_MS: "0" });
  try {
    await fetch(`${running.base}/api/v1/control/arm`, { method: "POST", headers: { Authorization: `Bearer ${SECRETS.ARMOR_CONTROL_TOKEN}` } });
    // Asynchronous on purpose: the server under test lives in this process and must keep answering.
    const run = await new Promise<{ status: number | null; stderr: string }>(resolve => {
      const child = spawn(python, [
        "-m", "armor_simulator", "--node-id", "north-1", "--count", "30", "--scenario", "two-intruders", "--seed", "3", "--validate",
        "--server-url", running.base, "--ingest-token", SECRETS.ARMOR_INGEST_TOKEN,
      ], { env: { ...process.env, PYTHONPATH: [simulator, common].join(path.delimiter) } });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdout.resume();
      const timer = setTimeout(() => child.kill(), 60_000);
      child.on("close", status => { clearTimeout(timer); resolve({ status, stderr }); });
    });
    assert.equal(run.status, 0, `${run.stderr}`);
    const state = await (await fetch(`${running.base}/api/v1/status`, { headers: { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` } })).json() as { mode: string; nodes: Record<string, { online: boolean; alert_level: string; target_count: number }> };
    assert.equal(state.mode, "armed");
    assert.ok(state.nodes["north-1"], "the node reached the server");
    assert.equal(state.nodes["north-1"].online, true);
    const history = await (await fetch(`${running.base}/api/v1/history?limit=50`, { headers: { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` } })).json() as { events: Array<{ type: string }> };
    assert.ok(history.events.some(event => event.type === "node"), "the node's first message was recorded");
  } finally { await running.stop(); }
});
