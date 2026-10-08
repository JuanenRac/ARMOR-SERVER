import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { maskEnv, unmaskEnv, MASK } from "../src/admin.js";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const TOKEN = "a".repeat(32);
const socketName = () => (process.platform === "win32" ? `\\\\.\\pipe\\armor-admin-test-${process.pid}-${Date.now()}` : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armor-sock-")), "agent.sock"));

type Seen = { method: string; url: string; body: Record<string, unknown>; token: string };

/** A stand-in for the admin agent: the same paths and answers, recording what it was asked. */
async function fakeAgent(): Promise<{ socket: string; seen: Seen[]; files: Record<string, string>; accounts: string[]; close: () => Promise<void> }> {
  const socket = socketName(), seen: Seen[] = [], accounts = ["field-node-north-1"];
  const files: Record<string, string> = { "server.env": "ARMOR_PORT=18080\nARMOR_STUDIO_PASSWORD=hunter2-hunter2\nARMOR_INGEST_TOKEN=\n", "mosquitto.conf": "listener 18883\n" };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const token = String(request.headers["x-armor-admin-token"] ?? "");
      seen.push({ method: request.method ?? "", url: request.url ?? "", body, token });
      const send = (status: number, payload: unknown) => { response.writeHead(status, json); response.end(JSON.stringify(payload)); };
      if (token !== TOKEN) return send(401, { error: "unauthorized" });
      const url = request.url ?? "";
      if (request.method === "GET" && url === "/v1/services") return send(200, { services: [{ id: "mosquitto", unit: "armor-mosquitto", active: "active" }] });
      if (request.method === "POST" && url.startsWith("/v1/services/")) return send(url.includes("sshd") ? 404 : 200, url.includes("sshd") ? { error: "unknown_service" } : { ok: true });
      if (request.method === "GET" && url === "/v1/files") return send(200, { files: Object.keys(files).map(id => ({ id })) });
      if (request.method === "GET" && url.startsWith("/v1/files/")) { const id = url.slice(10); return files[id] === undefined ? send(404, { error: "unknown_file" }) : send(200, { id, format: id.endsWith(".env") ? "env" : "conf", content: files[id], mtime: 5 }); }
      if (request.method === "PUT" && url.startsWith("/v1/files/")) { files[url.slice(10)] = String(body.content); return send(200, { ok: true, restarted: body.restart ? ["server"] : [] }); }
      if (request.method === "GET" && url === "/v1/mqtt/accounts") return send(200, { accounts: accounts.map(user => ({ user, role: "field-node", manageable: true, topics: [] })) });
      if (request.method === "POST" && url === "/v1/mqtt/accounts") {
        const user = `field-node-${String(body.name)}`;
        if (accounts.includes(user)) return send(409, { error: "identity_failed" });
        accounts.push(user); return send(200, { ok: true, user, password: `pw-${user}` });
      }
      if (request.method === "DELETE" && url.startsWith("/v1/mqtt/accounts/")) { const user = url.slice(18); accounts.splice(accounts.indexOf(user), 1); return send(200, { ok: true, user }); }
      return send(404, { error: "not_found" });
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  return { socket, seen, files, accounts, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const call = async (running: Running, cookie: string, method: string, route: string, body?: unknown) => {
  const response = await fetch(`${running.base}${route}`, { method, headers: { ...json, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, any> : {} };
};

test("secrets in an environment file are masked, and a masked line keeps its real value when the file is saved", () => {
  const current = "ARMOR_PORT=18080\nARMOR_STUDIO_PASSWORD=hunter2-hunter2\nARMOR_INGEST_TOKEN=\n# comment\n";
  const shown = maskEnv(current);
  assert.equal(shown, `ARMOR_PORT=18080\nARMOR_STUDIO_PASSWORD=${MASK}\nARMOR_INGEST_TOKEN=\n# comment\n`);
  assert.deepEqual(unmaskEnv(shown.replace("18080", "19090"), current), { content: "ARMOR_PORT=19090\nARMOR_STUDIO_PASSWORD=hunter2-hunter2\nARMOR_INGEST_TOKEN=\n# comment\n" });
  assert.deepEqual(unmaskEnv(`NEW_SECRET=${MASK}\n`, current), { missing: "NEW_SECRET" });
});

test("without an admin agent the administration says so and does nothing", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/status")).body.available, false);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/services")).status, 503);
    const anonymous = await fetch(`${running.base}/api/v1/admin/services`);
    assert.equal(anonymous.status, 401);
  } finally { await running.stop(); }
});

test("an administrator lists and controls the services, edits files without seeing secrets, and manages the broker accounts - all in the audit trail", async () => {
  const agent = await fakeAgent();
  const running = await startServer({ ARMOR_ADMIN_SOCKET: agent.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/status")).body.available, true);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/services")).body.services[0].id, "mosquitto");
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/services/mosquitto/restart")).status, 200);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/services/sshd/stop")).status, 404);

    const read = await call(running, cookie, "GET", "/api/v1/admin/files/server.env");
    assert.equal(read.body.masked, true);
    assert.doesNotMatch(String(read.body.content), /hunter2/);
    assert.match(String(read.body.content), /ARMOR_PORT=18080/);
    const edited = String(read.body.content).replace("18080", "19090");
    const saved = await call(running, cookie, "PUT", "/api/v1/admin/files/server.env", { content: edited, restart: true });
    assert.deepEqual([saved.status, saved.body.restarted], [200, ["server"]]);
    assert.equal(agent.files["server.env"], "ARMOR_PORT=19090\nARMOR_STUDIO_PASSWORD=hunter2-hunter2\nARMOR_INGEST_TOKEN=\n");
    assert.equal((await call(running, cookie, "PUT", "/api/v1/admin/files/server.env", { content: `BRAND_NEW_TOKEN=${MASK}\n` })).status, 422);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/files/passwd")).status, 404);

    const added = await call(running, cookie, "POST", "/api/v1/admin/mqtt/accounts", { role: "node", name: "south-2" });
    assert.deepEqual([added.status, added.body.user, added.body.password], [200, "field-node-south-2", "pw-field-node-south-2"]);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/mqtt/accounts", { role: "node", name: "south-2" })).status, 409);
    assert.equal((await call(running, cookie, "DELETE", "/api/v1/admin/mqtt/accounts/field-node-south-2")).status, 200);

    assert.ok(agent.seen.every(item => item.token === TOKEN), "every request carries the token");
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /admin\.service/);
    assert.match(audit, /admin\.file/);
    assert.match(audit, /admin\.mqtt\.add/);
    assert.doesNotMatch(audit, /pw-field-node|hunter2/, "no password is written in the audit trail");
  } finally { await running.stop(); await agent.close(); }
});

test("an operator who is not an administrator cannot reach any of it", async () => {
  const agent = await fakeAgent();
  const running = await startServer({ ARMOR_ADMIN_SOCKET: agent.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const created = await call(running, cookie, "POST", "/api/v1/users", { username: "guard", password: "guard-password-1", role: "operator" });
    assert.equal(created.status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "guard", password: "guard-password-1" }) });
    const guard = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    for (const [method, route] of [["GET", "/api/v1/admin/services"], ["POST", "/api/v1/admin/services/server/restart"], ["GET", "/api/v1/admin/files/server.env"], ["POST", "/api/v1/admin/mqtt/accounts"]]) {
      assert.equal((await call(running, guard, method, route, method === "GET" ? undefined : {})).status, 403, route);
    }
    assert.equal(agent.seen.length, 0, "the agent was never asked");
  } finally { await running.stop(); await agent.close(); }
});

test("adopting a node makes its account, writes the broker into the node's panel with its own login and restarts it", async () => {
  const agent = await fakeAgent();
  const seen: Array<{ url: string; cookie: string; body: string }> = [];
  const panel = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ url: `${request.method} ${request.url}`, cookie: String(request.headers.cookie ?? ""), body });
      if (request.url === "/api/v1/login") {
        const ok = JSON.parse(body).password === "node-admin-pass";
        response.writeHead(ok ? 200 : 401, ok ? { ...json, "Set-Cookie": "armor_session=abc123; Path=/" } : json);
        return response.end(JSON.stringify(ok ? { ok: true } : { error: "wrong_credentials" }));
      }
      response.writeHead(200, json); response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>(resolve => panel.listen(0, "127.0.0.1", resolve));
  process.env.ARMOR_ADMIN_NODE_PORT = String((panel.address() as { port: number }).port);
  const running = await startServer({ ARMOR_ADMIN_SOCKET: agent.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const good = await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "nodo-radar-2", address: "127.0.0.1", panel_user: "admin", panel_password: "node-admin-pass", broker_host: "192.168.0.180" });
    assert.equal(good.status, 200);
    assert.deepEqual([good.body.written, good.body.broker.uri, good.body.broker.username], [true, "mqtt://192.168.0.180:18883", "field-node-nodo-radar-2"]);
    const put = seen.find(item => item.url === "PUT /api/v1/config");
    assert.ok(put && put.cookie === "armor_session=abc123");
    assert.deepEqual(JSON.parse(put.body).mqtt, { enabled: true, uri: "mqtt://192.168.0.180:18883", username: "field-node-nodo-radar-2", password: "pw-field-node-nodo-radar-2" });
    assert.ok(seen.some(item => item.url === "POST /api/v1/reboot"));

    // a node that already has an account gets a new one (the old password cannot be read back), and a wrong panel login leaves the account for typing by hand
    const again = await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "nodo-radar-2", address: "127.0.0.1", panel_user: "admin", panel_password: "wrong", broker_host: "192.168.0.180" });
    assert.deepEqual([again.status, again.body.written, again.body.why], [200, false, "panel_login_refused"]);
    assert.match(again.body.broker.password, /^pw-/);
    const manual = await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "nodo-radar-3", address: "127.0.0.1", broker_host: "192.168.0.180" });
    assert.deepEqual([manual.body.written, manual.body.why], [false, "no_panel_login"]);

    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "Bad Id", address: "127.0.0.1", broker_host: "x" })).status, 422);
    delete process.env.ARMOR_ADMIN_NODE_PORT;
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "n1", address: "8.8.8.8", broker_host: "192.168.0.180" })).status, 422);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.doesNotMatch(audit, /node-admin-pass|pw-field-node/, "neither the node's login nor the new password is written in the audit trail");
    assert.ok(SECRETS.ARMOR_STUDIO_USERNAME);
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await agent.close(); await new Promise<void>(resolve => panel.close(() => resolve())); }
});
