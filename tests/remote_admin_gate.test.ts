// From outside the house, with the remote policy operate or view, a route that asks for an administrator is closed by the route itself: the test walks the routes the server registers.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// @ts-expect-error a plain script, not a typed module
import { routes } from "../tools/routes_table.mjs";
import { REMOTE_OPERATE_ADMIN_ROUTES, REMOTE_SECRET_READS, remoteMayUseAdminRoute } from "../src/remote_admin_gate.js";
import { SECRETS, startServer } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const administering = () => (routes() as Array<{ method: string; route: string; access: string }>).filter(item => item.access === "administrator");

test("every administrator route is closed from outside under operate unless it operates the house, and under view all of them are", () => {
  const list = administering();
  assert.ok(list.length > 80);
  for (const item of list) {
    const key = `${item.method} ${item.route}`;
    const open = remoteMayUseAdminRoute("operate", item.method, item.route);
    if (REMOTE_OPERATE_ADMIN_ROUTES.includes(key)) assert.equal(open, true, key);
    else if (item.method === "GET" && !REMOTE_SECRET_READS.includes(key)) assert.equal(open, true, `${key}: looking stays possible`);
    else assert.equal(open, false, `${key}: administering is for the house`);
    assert.equal(remoteMayUseAdminRoute("view", item.method, item.route), false, key);
    assert.equal(remoteMayUseAdminRoute("full", item.method, item.route), true, key);
  }
});

test("the lists of the gate name routes that exist and ask for an administrator", () => {
  const known = new Set(administering().map(item => `${item.method} ${item.route}`));
  for (const key of [...REMOTE_OPERATE_ADMIN_ROUTES, ...REMOTE_SECRET_READS]) assert.ok(known.has(key), `${key} is not an administrator route`);
  for (const key of REMOTE_SECRET_READS) assert.ok(key.startsWith("GET "), key);
});

test("from outside under operate the settings, the connection and the secrets are closed, operating is open, and the option can give the old behaviour back", async () => {
  for (const gate of [true, false]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-test-"));
    fs.writeFileSync(path.join(dataDir, "security-settings.json"), JSON.stringify({ schema: 1, settings: { "remote.gate_by_route": gate } }));
    const running = await startServer({ ARMOR_DATA_DIR: dataDir, ARMOR_LOCAL_NETWORKS: "10.99.0.0/16", ARMOR_REMOTE_POLICY: "operate" });   // the test client is then "outside"
    try {
      const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: SECRETS.ARMOR_STUDIO_USERNAME, password: SECRETS.ARMOR_STUDIO_PASSWORD }) });
      const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
      const call = (method: string, url: string, body?: unknown) => fetch(`${running.base}${url}`, { method, headers: { ...json, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal((await call("POST", "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD })).status, 200);
      const refusedBy = async (reply: Response): Promise<string | undefined> => (reply.status === 403 ? ((await reply.json().catch(() => ({}))) as { code?: string }).code : undefined);
      assert.equal((await call("GET", "/api/v1/security/settings")).status, 200, "looking at the settings stays possible");
      for (const [method, url, body] of [["PUT", "/api/v1/security/settings", { "alarm.arming_modes": true }], ["PUT", "/api/v1/alarm/profiles", {}], ["DELETE", "/api/v1/history", undefined], ["GET", "/api/v1/alarm/zone-feed/key/alarm-1", undefined]] as const) {
        const code = await refusedBy(await call(method, url, body));
        if (gate) assert.equal(code, "remote_policy", `${method} ${url}`); else assert.notEqual(code, "remote_policy", `${method} ${url}`);
      }
      assert.notEqual(await refusedBy(await call("POST", "/api/v1/alarm/command", { command: "arm" })), "remote_policy", "operating the alarm stays open");
      assert.notEqual(await refusedBy(await call("POST", "/api/v1/electrical/switch", {})), "remote_policy", "switching a circuit stays open");
    } finally { await running.stop(); }
  }
});
