import assert from "node:assert/strict";
import test from "node:test";
import { startServer, studioCookie } from "./helpers.js";

test("a viewer reads the state and can ask to watch a camera, but changes, arms, switches and administers nothing", async () => {
  const running = await startServer();
  try {
    const admin = { "Content-Type": "application/json", cookie: await studioCookie(running.base) };
    const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "family", password: "family-password-1", role: "viewer" }) });
    assert.equal(made.status, 201);
    assert.equal(((await made.json()) as { role: string }).role, "viewer");
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "family", password: "family-password-1" }) });
    assert.equal(login.status, 201);
    const headers = { "Content-Type": "application/json", cookie: (login.headers.getSetCookie()[0] ?? "").split(";")[0] };

    // what a viewer may read
    for (const path of ["/api/v1/alarms", "/api/v1/cameras", "/api/v1/devices", "/api/v1/solar", "/api/v1/preflight", "/api/v1/status"]) {
      assert.equal((await fetch(`${running.base}${path}`, { headers })).status, 200, path);
    }
    // what it may not read: settings, users, secrets of the installation
    for (const path of ["/api/v1/users", "/api/v1/admin/status", "/api/v1/system/ingest"]) {
      assert.equal((await fetch(`${running.base}${path}`, { headers })).status, 403, path);
    }
    // and nothing that changes anything
    for (const [method, path] of [["POST", "/api/v1/mode"], ["POST", "/api/v1/alarms/acknowledge"], ["POST", "/api/v1/devices"], ["POST", "/api/v1/cameras/configure"], ["DELETE", "/api/v1/alarms/x"]] as const) {
      const answer = await fetch(`${running.base}${path}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(answer.status, 403, `${method} ${path}`);
    }
    // an operator is untouched
    const operator = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "guard-2", password: "guard-password-2", role: "operator" }) });
    assert.equal(operator.status, 201);
  } finally { await running.stop(); }
});
