import assert from "node:assert/strict";
import test from "node:test";
import { startServer, studioCookie } from "./helpers.js";

type Role = "admin" | "operator" | "viewer" | "panel";
const ROLES: Role[] = ["admin", "operator", "viewer", "panel"];

// What each role is meant to reach. `true` = the route lets it in (whatever the route then answers: a 404 or a 400 for a made-up id is fine), `false` = refused with 401 or 403.
const MATRIX: Array<{ method: string; path: string; body?: unknown; allow: Record<Role, boolean> }> = [
  // reading the state
  { method: "GET", path: "/api/v1/alarms", allow: { admin: true, operator: true, viewer: true, panel: false } },
  { method: "GET", path: "/api/v1/cameras", allow: { admin: true, operator: true, viewer: true, panel: false } },
  { method: "GET", path: "/api/v1/devices", allow: { admin: true, operator: true, viewer: true, panel: false } },
  { method: "GET", path: "/api/v1/solar", allow: { admin: true, operator: true, viewer: true, panel: false } },
  { method: "GET", path: "/api/v1/electrical/energy", allow: { admin: true, operator: true, viewer: true, panel: false } },
  { method: "GET", path: "/api/v1/preflight", allow: { admin: true, operator: true, viewer: true, panel: false } },
  { method: "GET", path: "/api/v1/system/metrics", allow: { admin: true, operator: true, viewer: true, panel: false } },
  { method: "GET", path: "/api/v1/panel/summary", allow: { admin: true, operator: true, viewer: true, panel: true } },
  // the wall panel's own three things, and nobody else's reach beyond their role
  { method: "POST", path: "/api/v1/mode", body: { mode: "armed" }, allow: { admin: true, operator: true, viewer: false, panel: true } },
  { method: "POST", path: "/api/v1/alarms/acknowledge", body: {}, allow: { admin: true, operator: true, viewer: false, panel: true } },
  // watching a camera needs a ticket, which a viewer may ask for
  { method: "POST", path: "/api/v1/cameras/cam-x/stream-ticket", body: {}, allow: { admin: true, operator: true, viewer: true, panel: false } },
  // changing things
  { method: "POST", path: "/api/v1/devices", body: {}, allow: { admin: true, operator: true, viewer: false, panel: false } },
  { method: "POST", path: "/api/v1/cameras/configure", body: {}, allow: { admin: true, operator: true, viewer: false, panel: false } },
  { method: "DELETE", path: "/api/v1/alarms/none", allow: { admin: true, operator: true, viewer: false, panel: false } },
  // what holds secrets or manages the installation
  { method: "GET", path: "/api/v1/system/ingest", allow: { admin: true, operator: true, viewer: false, panel: false } },
  { method: "GET", path: "/api/v1/users", allow: { admin: true, operator: false, viewer: false, panel: false } },
  { method: "GET", path: "/api/v1/admin/status", allow: { admin: true, operator: false, viewer: false, panel: false } },
];

test("every role reaches what its role says and nothing else", async () => {
  const running = await startServer();
  try {
    const admin = { "Content-Type": "application/json", cookie: await studioCookie(running.base) };
    const headers: Record<Role, Record<string, string>> = { admin, operator: admin, viewer: admin, panel: admin };
    for (const role of ROLES.filter(item => item !== "admin")) {
      const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: `u-${role}`, password: `${role}-password-12345`, role }) });
      assert.equal(made.status, 201, role);
      const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `u-${role}`, password: `${role}-password-12345` }) });
      assert.equal(login.status, 201, role);
      headers[role] = { "Content-Type": "application/json", cookie: (login.headers.getSetCookie()[0] ?? "").split(";")[0] };
    }
    const wrong: string[] = [];
    for (const row of MATRIX) {
      for (const role of ROLES) {
        const answer = await fetch(`${running.base}${row.path}`, { method: row.method, headers: headers[role], ...(row.body !== undefined ? { body: JSON.stringify(row.body) } : {}) });
        const allowed = answer.status !== 401 && answer.status !== 403;
        if (allowed !== row.allow[role]) wrong.push(`${role} ${row.method} ${row.path}: expected ${row.allow[role] ? "in" : "refused"}, got ${answer.status}`);
      }
    }
    assert.deepEqual(wrong, []);
  } finally { await running.stop(); }
});
