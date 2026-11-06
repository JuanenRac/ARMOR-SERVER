import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, studioCookie, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const TOKEN = "m".repeat(32);
const PLAN = "a1b2c3d4e5f60718293a4b5c";
const socketName = () => (process.platform === "win32" ? `\\\\.\\pipe\\armor-mupd-test-${process.pid}-${Date.now()}` : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-mupd-")), "m.sock"));

type Seen = { method: string; url: string; body: Record<string, unknown>; token: string; totp: string };

/** A stand-in for the maintenance agent: the updater paths, recording what it was asked (and the one-time code header). */
async function fakeAgent(): Promise<{ socket: string; seen: Seen[]; close: () => Promise<void> }> {
  const socket = socketName(), seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      seen.push({ method: request.method ?? "", url: request.url ?? "", body, token: String(request.headers["x-armor-maint-token"] ?? ""), totp: String(request.headers["x-armor-maint-totp"] ?? "") });
      const send = (status: number, payload: unknown) => { response.writeHead(status, json); response.end(JSON.stringify(payload)); };
      const url = request.url ?? "";
      if (request.method === "GET" && url === "/v1/updater") return send(200, { enabled: true, available: true, require_signed: true, min_interval_s: 300, projects: ["ARMOR-SERVER", "ARMOR-STUDIO"] });
      if (request.method === "POST" && url === "/v1/updater/preview") return send(200, { project: body.project, installed: true, local_version: "0.8.1.8", github_version: "0.8.1.9", state: "OUTDATED", update_available: true, signature_policy: "require", plan_id: PLAN, expires_in_s: 300 });
      if (request.method === "POST" && url === "/v1/updater/apply") return body.plan_id === PLAN ? send(202, { id: "job-9", kind: "updater", state: "running", percent: 0, steps: [], log: [] }) : send(404, { error: "no_such_plan" });
      if (request.method === "GET" && url.startsWith("/v1/jobs/")) return send(200, { id: "job-9", state: "done", percent: 100, log: [], log_total: 0 });
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

const ON = (agent: { socket: string }) => ({ ARMOR_MAINT_SOCKET: agent.socket, ARMOR_MAINT_TOKEN: TOKEN, ARMOR_CM5_UPDATE: "1" });

test("the machine update is off unless the switch is on, and the agent is never asked", async () => {
  const agent = await fakeAgent();
  const running = await startServer({ ARMOR_MAINT_SOCKET: agent.socket, ARMOR_MAINT_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const state = await call(running, cookie, "GET", "/api/v1/admin/machine-update");
    assert.deepEqual([state.status, state.body.enabled, state.body.reason], [200, false, "switched_off"]);
    for (const [route, payload] of [["preview", { project: "ARMOR-SERVER" }], ["apply", { project: "ARMOR-SERVER", plan_id: PLAN, confirm: "ARMOR-SERVER" }]] as const) {
      const answer = await call(running, cookie, "POST", `/api/v1/admin/machine-update/${route}`, payload);
      assert.deepEqual([answer.status, answer.body.error], [403, "machine_update_disabled"], route);
    }
    assert.equal(agent.seen.length, 0);
  } finally { await running.stop(); await agent.close(); }
});

test("without a maintenance agent the switch alone does nothing", async () => {
  const running = await startServer({ ARMOR_CM5_UPDATE: "1" });
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/machine-update")).body.reason, "not_configured");
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/machine-update/preview", { project: "ARMOR-SERVER" })).status, 503);
  } finally { await running.stop(); }
});

test("a preview then an apply with the plan, the project typed again and the code, all in the audit trail", async () => {
  const agent = await fakeAgent();
  const running = await startServer(ON(agent));
  try {
    const cookie = await studioCookie(running.base);
    const state = await call(running, cookie, "GET", "/api/v1/admin/machine-update");
    assert.deepEqual([state.body.enabled, state.body.require_signed, state.body.projects], [true, true, ["ARMOR-SERVER", "ARMOR-STUDIO"]]);
    const preview = await call(running, cookie, "POST", "/api/v1/admin/machine-update/preview", { project: "ARMOR-SERVER" });
    assert.equal(preview.status, 200);
    assert.deepEqual([preview.body.local_version, preview.body.github_version, preview.body.plan_id], ["0.8.1.8", "0.8.1.9", PLAN]);
    const applied = await call(running, cookie, "POST", "/api/v1/admin/machine-update/apply", { project: "ARMOR-SERVER", plan_id: PLAN, confirm: "ARMOR-SERVER", totp: "123456" });
    assert.deepEqual([applied.status, applied.body.id], [202, "job-9"]);
    const sent = agent.seen.at(-1);
    assert.deepEqual([sent?.url, sent?.body, sent?.totp, sent?.token], ["/v1/updater/apply", { project: "ARMOR-SERVER", plan_id: PLAN }, "123456", TOKEN]);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/machine-update/jobs/job-9?since=0")).body.state, "done");
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/machine-update/jobs/..%2Fx")).status, 404);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    for (const action of ["machine_update.preview", "machine_update.apply"]) assert.match(audit, new RegExp(action.replace(".", "\\.")), action);
    assert.doesNotMatch(audit, /123456/, "the code is never written down");
  } finally { await running.stop(); await agent.close(); }
});

test("the apply refuses a project that is not typed again, a bad plan, a bad code or a project that is not one", async () => {
  const agent = await fakeAgent();
  const running = await startServer(ON(agent));
  try {
    const cookie = await studioCookie(running.base);
    const apply = (payload: unknown) => call(running, cookie, "POST", "/api/v1/admin/machine-update/apply", payload);
    assert.equal((await apply({ project: "ARMOR-SERVER", plan_id: PLAN })).body.error, "confirmation_mismatch");
    assert.equal((await apply({ project: "ARMOR-SERVER", plan_id: PLAN, confirm: "armor-server" })).body.error, "confirmation_mismatch");
    assert.equal((await apply({ project: "ARMOR-SERVER", plan_id: "../x", confirm: "ARMOR-SERVER" })).body.error, "bad_plan");
    assert.equal((await apply({ project: "ARMOR-SERVER", plan_id: PLAN, confirm: "ARMOR-SERVER", totp: "12ab56" })).body.error, "bad_code");
    assert.equal((await apply({ project: "rm -rf /", plan_id: PLAN, confirm: "rm -rf /" })).body.error, "unknown_project");
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/machine-update/preview", { project: "../ARMOR-SERVER" })).status, 422);
    assert.equal(agent.seen.length, 0, "nothing reached the agent");
    const wrongPlan = await apply({ project: "ARMOR-SERVER", plan_id: "0".repeat(24), confirm: "ARMOR-SERVER" });
    assert.deepEqual([wrongPlan.status, wrongPlan.body.error], [404, "no_such_plan"]);
  } finally { await running.stop(); await agent.close(); }
});

test("a second apply right after the first is held back", async () => {
  const agent = await fakeAgent();
  const running = await startServer(ON(agent));
  try {
    const cookie = await studioCookie(running.base);
    const payload = { project: "ARMOR-STUDIO", plan_id: PLAN, confirm: "ARMOR-STUDIO" };
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/machine-update/apply", payload)).status, 202);
    const second = await call(running, cookie, "POST", "/api/v1/admin/machine-update/apply", payload);
    assert.deepEqual([second.status, second.body.error], [429, "too_soon"]);
    assert.equal(agent.seen.filter(item => item.url === "/v1/updater/apply").length, 1);
  } finally { await running.stop(); await agent.close(); }
});

test("an operator who is not an administrator cannot reach any of it", async () => {
  const agent = await fakeAgent();
  const running = await startServer(ON(agent));
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running, cookie, "POST", "/api/v1/users", { username: "guard", password: "guard-password-1", role: "operator" })).status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "guard", password: "guard-password-1" }) });
    const guard = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    for (const [method, route] of [["GET", "/api/v1/admin/machine-update"], ["POST", "/api/v1/admin/machine-update/preview"], ["POST", "/api/v1/admin/machine-update/apply"], ["GET", "/api/v1/admin/machine-update/jobs/job-9"]]) {
      assert.equal((await call(running, guard, method, route, method === "GET" ? undefined : {})).status, 403, route);
    }
    assert.equal((await fetch(`${running.base}/api/v1/admin/machine-update`)).status, 401);
    assert.equal(agent.seen.length, 0);
  } finally { await running.stop(); await agent.close(); }
});
