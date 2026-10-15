import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const TOKEN = "m".repeat(32);
const socketName = () => (process.platform === "win32" ? `\\\\.\\pipe\\armor-maint-test-${process.pid}-${Date.now()}` : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-msock-")), "m.sock"));

type Seen = { method: string; url: string; body: Record<string, unknown>; token: string };

/** A stand-in for the maintenance agent: the same paths and answers, recording what it was asked. */
async function fakeAgent(consoleEnabled = true): Promise<{ socket: string; seen: Seen[]; close: () => Promise<void> }> {
  const socket = socketName(), seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const token = String(request.headers["x-armor-maint-token"] ?? "");
      seen.push({ method: request.method ?? "", url: request.url ?? "", body, token });
      const send = (status: number, payload: unknown) => { response.writeHead(status, json); response.end(JSON.stringify(payload)); };
      if (token !== TOKEN) return send(401, { error: "unauthorized" });
      const url = request.url ?? "";
      if (request.method === "GET" && url.startsWith("/v1/overview")) return send(200, { agent: "0.1.0", components: [{ id: "server", installed: "0.5.4", latest: "0.5.5", status: "update_available" }], os: { packages: [] }, console: consoleEnabled, running: [], history: [] });
      if (request.method === "POST" && url === "/v1/updates") return send(202, { id: "job-1", kind: "update", state: "running", percent: 0, steps: [], log: [] });
      if (request.method === "POST" && url.endsWith("/rollback")) return send(202, { id: "job-2", state: "running" });
      if (request.method === "POST" && url.startsWith("/v1/system/")) return send(202, { id: "job-3", state: "running" });
      if (request.method === "GET" && url.startsWith("/v1/jobs/")) return send(200, { id: "job-1", state: "done", percent: 100, log: ["x"], log_total: 1 });
      if (request.method === "POST" && url === "/v1/history/clear") return send(200, { ok: true, cleared: 3 });
      if (request.method === "GET" && url === "/v1/console") return send(200, { enabled: consoleEnabled });
      if (request.method === "POST" && url === "/v1/console/run") return consoleEnabled ? send(202, { id: "c1", state: "running", output: "", offset: 0 }) : send(403, { error: "console_disabled" });
      if (request.method === "GET" && url.startsWith("/v1/console/jobs/")) return send(200, { id: "c1", state: "done", code: 0, output: "hi\n", offset: 3, cwd: "/tmp" });
      if (request.method === "POST" && url.includes("/cancel")) return send(200, { ok: true });
      return send(404, { error: "not_found" });
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  return { socket, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const call = async (running: Running, cookie: string, method: string, route: string, body?: unknown) => {
  const response = await fetch(`${running.base}${route}`, { method, headers: { ...json, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
};

test("without a maintenance agent the screens say so and do nothing", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/maintenance/status")).body.available, false);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/updates")).status, 503);
    assert.equal((await fetch(`${running.base}/api/v1/admin/updates`)).status, 401);
  } finally { await running.stop(); }
});

test("an administrator checks, installs, rolls back and upgrades the system, with the token, and all of it is in the audit trail", async () => {
  const agent = await fakeAgent();
  const running = await startServer({ ARMOR_MAINT_SOCKET: agent.socket, ARMOR_MAINT_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/maintenance/status")).body.available, true);
    const overview = await call(running, cookie, "GET", "/api/v1/admin/updates?force=1");
    assert.equal(overview.status, 200);
    assert.equal(overview.body.components[0].status, "update_available");
    assert.ok(agent.seen.some(item => item.url === "/v1/overview?force=1"));
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/updates", { components: ["server", "studio"] })).status, 202);
    assert.deepEqual(agent.seen.at(-1)?.body, { components: ["server", "studio"], force: false });
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/updates", { components: ["server", "../etc"] })).status, 422);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/updates", { components: [] })).status, 422);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/updates/studio/rollback")).status, 202);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/updates/shell/rollback")).status, 404);
    assert.equal((await call(running, cookie, "DELETE", "/api/v1/admin/updates/history")).body.cleared, 3);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/system/check")).status, 202);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/system/upgrade")).status, 202);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/system/upgrade", { mode: "full" })).status, 202);
    assert.deepEqual(agent.seen.at(-1)?.body, { mode: "full" });
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/system/upgrade", { mode: "repair" })).status, 202);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/system/upgrade", { mode: "rm -rf" })).status, 422);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/system/reboot")).status, 202);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/maintenance/jobs/job-1?since=0")).body.state, "done");
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/maintenance/jobs/..%2Fx")).status, 404);
    assert.ok(agent.seen.every(item => item.token === TOKEN), "every request carries the token");
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    for (const action of ["maintenance.check", "maintenance.update", "maintenance.rollback", "maintenance.system.check", "maintenance.system.upgrade", "maintenance.system.reboot", "maintenance.history.clear"]) assert.match(audit, new RegExp(action.replace(/\./g, "\\.")));
  } finally { await running.stop(); await agent.close(); }
});

test("an operator who is not an administrator cannot reach any of it", async () => {
  const agent = await fakeAgent();
  const running = await startServer({ ARMOR_MAINT_SOCKET: agent.socket, ARMOR_MAINT_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running, cookie, "POST", "/api/v1/users", { username: "guard", password: "guard-password-1", role: "operator" })).status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "guard", password: "guard-password-1" }) });
    const guard = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    for (const [method, route] of [["GET", "/api/v1/admin/updates"], ["POST", "/api/v1/admin/updates"], ["POST", "/api/v1/admin/system/upgrade"], ["POST", "/api/v1/admin/system/reboot"], ["DELETE", "/api/v1/admin/updates/history"], ["POST", "/api/v1/admin/console/unlock"], ["POST", "/api/v1/admin/console/run"], ["GET", "/api/v1/admin/console"]]) {
      assert.equal((await call(running, guard, method, route, method === "GET" ? undefined : {})).status, 403, route);
    }
    assert.equal(agent.seen.length, 0, "the agent was never asked");
  } finally { await running.stop(); await agent.close(); }
});

test("the console is locked until the password is given again, and every command is written down", async () => {
  const agent = await fakeAgent();
  const running = await startServer({ ARMOR_MAINT_SOCKET: agent.socket, ARMOR_MAINT_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const before = await call(running, cookie, "GET", "/api/v1/admin/console");
    assert.deepEqual([before.body.available, before.body.enabled, before.body.unlocked_until], [true, true, 0]);
    // locked: nothing reaches the agent
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/console/run", { command: "id" })).status, 403);
    assert.equal(agent.seen.filter(item => item.url.startsWith("/v1/console/run")).length, 0);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/console/unlock", { password: "not the password" })).status, 403);
    const opened = await call(running, cookie, "POST", "/api/v1/admin/console/unlock", { password: SECRETS.ARMOR_STUDIO_PASSWORD });
    assert.equal(opened.status, 200);
    assert.ok(opened.body.unlocked_until > Date.now());
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/console/run", { command: "   " })).status, 422);
    const run = await call(running, cookie, "POST", "/api/v1/admin/console/run", { command: "systemctl restart armor-server", cwd: "/etc", timeout: 30 });
    assert.equal(run.status, 202);
    assert.deepEqual(agent.seen.find(item => item.url === "/v1/console/run")?.body, { command: "systemctl restart armor-server", cwd: "/etc", timeout: 30 });
    const polled = await call(running, cookie, "GET", "/api/v1/admin/console/jobs/c1?since=0");
    assert.equal(polled.body.output, "hi\n");
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/console/jobs/c1/cancel")).status, 200);
    // locking again shuts it
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/console/lock")).body.unlocked_until, 0);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/console/run", { command: "id" })).status, 403);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /console\.unlock/);
    assert.match(audit, /systemctl restart armor-server/);
    assert.match(audit, /console\.exit/);
    assert.doesNotMatch(audit, /not the password|correct-horse-battery/, "no password is written in the audit trail");
  } finally { await running.stop(); await agent.close(); }
});

test("five wrong passwords close the console's door for a while, and a console the agent keeps off says so", async () => {
  const agent = await fakeAgent(false);
  const running = await startServer({ ARMOR_MAINT_SOCKET: agent.socket, ARMOR_MAINT_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await call(running, cookie, "POST", "/api/v1/admin/console/unlock", { password: "nope" + attempt })).status, 403);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/console/unlock", { password: SECRETS.ARMOR_STUDIO_PASSWORD })).status, 429, "even the right one waits");
    const state = await call(running, cookie, "GET", "/api/v1/admin/console");
    assert.equal(state.body.enabled, false);
  } finally { await running.stop(); await agent.close(); }
});
