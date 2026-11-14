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

type Seen = { method: string; url: string; body: Record<string, unknown>; token: string; sensitive: string; totp: string };

/** A stand-in for the admin agent: the same paths and answers, recording what it was asked. */
async function fakeAgent(options: { status?: boolean; rotation?: boolean; hides?: boolean } = {}): Promise<{ socket: string; seen: Seen[]; files: Record<string, string>; accounts: string[]; close: () => Promise<void> }> {
  const socket = socketName(), seen: Seen[] = [], accounts = ["field-node-north-1"];
  let fieldHttp = false;
  const files: Record<string, string> = { "server.env": "ARMOR_PORT=18080\nARMOR_STUDIO_PASSWORD=hunter2-hunter2\nARMOR_INGEST_TOKEN=\n", "mosquitto.conf": "listener 18883\n" };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const token = String(request.headers["x-armor-admin-token"] ?? "");
      seen.push({ method: request.method ?? "", url: request.url ?? "", body, token, sensitive: String(request.headers["x-armor-admin-sensitive-token"] ?? ""), totp: String(request.headers["x-armor-maint-totp"] ?? "") });
      const send = (status: number, payload: unknown) => { response.writeHead(status, json); response.end(JSON.stringify(payload)); };
      if (token !== TOKEN) return send(401, { error: "unauthorized" });
      const url = request.url ?? "";
      if (request.method === "GET" && url === "/v1/status" && options.status !== false) return send(200, { approval: "totp", sensitive_writes: { mode: "second_token", protected: true, files: ["server.env"], warning: "" } });
      if (request.method === "GET" && url === "/v1/services") return send(200, { services: [{ id: "mosquitto", unit: "armor-mosquitto", active: "active" }] });
      if (request.method === "POST" && url.startsWith("/v1/services/")) return send(url.includes("sshd") ? 404 : 200, url.includes("sshd") ? { error: "unknown_service" } : { ok: true });
      if (request.method === "GET" && url === "/v1/files") return send(200, { files: Object.keys(files).map(id => ({ id })) });
      if (request.method === "GET" && url.startsWith("/v1/files/")) { const id = url.slice(10); if (files[id] === undefined) return send(404, { error: "unknown_file" }); const env = id.endsWith(".env"); return send(200, { id, format: env ? "env" : "conf", content: options.hides && env ? maskEnv(files[id]) : files[id], mtime: 5, ...(options.hides && env ? { masked: true } : {}) }); }
      if (request.method === "PUT" && url.startsWith("/v1/files/")) { const id = url.slice(10); let text = String(body.content); if (options.hides && text.includes(MASK)) { const given = unmaskEnv(text, files[id] ?? ""); if ("missing" in given) return send(422, { error: "masked_value_without_original", key: given.missing }); text = given.content; } files[id] = text; return send(200, { ok: true, restarted: body.restart ? ["server"] : [] }); }
      if (request.method === "GET" && url === "/v1/mqtt/relays") return send(200, { installed: true, battery_write: ["bat-1"], alarm_state_relay: false, approval: "totp" });
      if (request.method === "POST" && url.startsWith("/v1/mqtt/relays/")) {
        if (!String(request.headers["x-armor-maint-totp"] ?? "")) return send(401, { error: "totp_required" });
        return send(200, { ok: true, relay: url.slice(16), node: String(body.node ?? ""), state: body.state, installed: true, battery_write: body.node ? [String(body.node)] : [], alarm_state_relay: url.endsWith("alarm-state-relay") && body.state === "on", approval: "totp" });
      }
      if (request.method === "GET" && url === "/v1/firewall") return send(200, { installed: true, field_http: fieldHttp, approval: "totp" });
      if (request.method === "POST" && url === "/v1/firewall/field-http") {
        if (!String(request.headers["x-armor-maint-totp"] ?? "")) return send(401, { error: "totp_required" });
        fieldHttp = body.state === "on";
        return send(200, { ok: true, state: body.state, installed: true, field_http: fieldHttp, approval: "totp" });
      }
      if (request.method === "GET" && url === "/v1/lan-ca") return send(200, { installed: true, enabled: true, authority: { days_left: 3000, sha256: "AA:BB" }, certificate: { days_left: 12, sha256: "CC:DD" }, renew_days: 30, expiring: ["certificate"], approval: "totp" });
      if (request.method === "POST" && url === "/v1/lan-ca") {
        if (!String(request.headers["x-armor-maint-totp"] ?? "")) return send(401, { error: "totp_required" });
        return send(200, { ok: true, action: body.action, devices_must_reinstall: body.action === "rotate" });
      }
      if (request.method === "GET" && url === "/v1/mqtt/accounts") return send(200, { accounts: accounts.map(user => ({ user, role: "field-node", manageable: true, topics: [] })) });
      if (request.method === "POST" && url === "/v1/mqtt/accounts") {
        const user = `${body.role === "node" ? "field-node" : String(body.role)}-${String(body.name)}`;
        if (accounts.includes(user) && body.rotate === true && options.rotation) return send(200, { ok: true, user, password: `new-${user}` });
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
    { const state = (await call(running, cookie, "GET", "/api/v1/admin/status")).body; assert.deepEqual([state.available, state.approval], [true, "totp"]); }
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
  const seen: Array<{ url: string; cookie: string; body: string; marker: string }> = [];
  const panel = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const marker = String(request.headers["x-requested-with"] ?? "");
      seen.push({ url: `${request.method} ${request.url}`, cookie: String(request.headers.cookie ?? ""), body, marker });
      // like a real node: a request that changes anything without the marker a page from another site cannot add is refused
      if (request.method !== "GET" && marker !== "armor") { response.writeHead(403, json); return response.end(JSON.stringify({ error: "forbidden" })); }
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
    assert.ok(put && put.cookie === "armor_session=abc123" && put.marker === "armor", "the node is told with the marker it demands");
    assert.deepEqual(JSON.parse(put.body).mqtt, { enabled: true, uri: "mqtt://192.168.0.180:18883", username: "field-node-nodo-radar-2", password: "pw-field-node-nodo-radar-2" });
    assert.ok(seen.some(item => item.url === "POST /api/v1/reboot"));

    // a node that already has an account gets a new one (the old password cannot be read back), and a wrong panel login leaves the account for typing by hand
    const again = await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "nodo-radar-2", address: "127.0.0.1", panel_user: "admin", panel_password: "wrong", broker_host: "192.168.0.180" });
    assert.deepEqual([again.status, again.body.written, again.body.why], [200, false, "panel_login_refused"]);
    assert.match(again.body.broker.password, /^pw-/);
    const manual = await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "nodo-radar-3", address: "127.0.0.1", broker_host: "192.168.0.180" });
    assert.deepEqual([manual.body.written, manual.body.why], [false, "no_panel_login"]);

    // the kind of node decides the identity the account gets (it was always the radar's)
    const alarm = await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "alarm-9", kind: "alarm", address: "127.0.0.1", broker_host: "192.168.0.180" });
    assert.equal(alarm.body.broker.username, "alarm-node-alarm-9");
    const solar = await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "solar-9", kind: "solar", address: "127.0.0.1", broker_host: "192.168.0.180" });
    assert.equal(solar.body.broker.username, "solar-node-solar-9");
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "x-9", kind: "toaster", address: "127.0.0.1", broker_host: "192.168.0.180" })).status, 422);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "Bad Id", address: "127.0.0.1", broker_host: "x" })).status, 422);
    delete process.env.ARMOR_ADMIN_NODE_PORT;
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "n1", address: "8.8.8.8", broker_host: "192.168.0.180" })).status, 422);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.doesNotMatch(audit, /node-admin-pass|pw-field-node/, "neither the node's login nor the new password is written in the audit trail");
    assert.ok(SECRETS.ARMOR_STUDIO_USERNAME);
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await agent.close(); await new Promise<void>(resolve => panel.close(() => resolve())); }
});

test("a node adopted again gets a new password in one step when the agent can rotate, and is never left without an account", async () => {
  const agent = await fakeAgent({ rotation: true });
  const running = await startServer({ ARMOR_ADMIN_SOCKET: agent.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const again = await call(running, cookie, "POST", "/api/v1/admin/nodes/provision", { node_id: "north-1", address: "192.168.0.50", broker_host: "192.168.0.180" });
    assert.deepEqual([again.status, again.body.broker.username, again.body.broker.password], [200, "field-node-north-1", "new-field-node-north-1"]);
    assert.equal(agent.seen.some(item => item.method === "DELETE"), false, "the account was not removed on the way");
    assert.ok(agent.accounts.includes("field-node-north-1"));
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /account renewed/);
    assert.doesNotMatch(audit, /new-field-node/);
  } finally { await running.stop(); await agent.close(); }
});

test("an address that carries a login is shown without it and goes back whole when it was not touched", () => {
  const current = "ARMOR_MQTT_URL=mqtt://armor:s3cret-pass@127.0.0.1:1883\nARMOR_ALERT_WEBHOOK_URL=https://hooks.example/x?token=abc123&a=1\nARMOR_PORT=18080\n";
  const shown = maskEnv(current);
  assert.doesNotMatch(shown, /s3cret-pass|abc123/);
  assert.match(shown, /mqtt:\/\/armor:\*\*\*@127\.0\.0\.1:1883/);
  assert.match(shown, /token=\*\*\*&a=1/);
  assert.deepEqual(unmaskEnv(shown.replace("18080", "19090"), current), { content: current.replace("18080", "19090") }, "what was not touched is given back as it was");
  const edited = unmaskEnv(shown.replace("127.0.0.1:1883", "10.0.0.5:1883"), current);
  assert.ok("content" in edited && edited.content.includes("mqtt://armor:s3cret-pass@10.0.0.5:1883"), "editing around a hidden login keeps the login");
});

test("the console learns whether the admin agent locks the broker rules and the env files, and hands on the second secret it is given for one change", async () => {
  const agent = await fakeAgent();
  const running = await startServer({ ARMOR_ADMIN_SOCKET: agent.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const status = (await call(running, cookie, "GET", "/api/v1/admin/status")).body;
    assert.deepEqual([status.available, status.sensitive_writes], [true, { mode: "second_token", protected: true }]);
    // the second secret is given with the change, handed to the agent for that request, and kept nowhere
    const secret = "s".repeat(30);
    const send = (method: string, route: string, payload: unknown, extra: Record<string, string> = {}) => fetch(`${running.base}${route}`, { method, headers: { ...json, cookie, ...extra }, body: JSON.stringify(payload) });
    assert.equal((await send("PUT", "/api/v1/admin/files/server.env", { content: "ARMOR_PORT=18081\n" }, { "X-Armor-Admin-Sensitive-Token": secret })).status, 200);
    assert.equal((await send("PUT", "/api/v1/admin/files/mosquitto.conf", { content: "listener 18883\n" })).status, 200);
    assert.equal((await send("POST", "/api/v1/admin/mqtt/accounts", { role: "node", name: "north-2" }, { "X-Armor-Admin-Sensitive-Token": secret })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/admin/mqtt/accounts/field-node-north-2`, { method: "DELETE", headers: { ...json, cookie, "X-Armor-Admin-Sensitive-Token": secret } })).status, 200);
    const put = agent.seen.filter(item => item.method === "PUT"), post = agent.seen.filter(item => item.method === "POST"), del = agent.seen.filter(item => item.method === "DELETE");
    assert.deepEqual([put[0]?.sensitive, put[1]?.sensitive, post[0]?.sensitive, del[0]?.sensitive], [secret, "", secret, secret]);
    assert.ok(agent.seen.every(item => item.method === "PUT" || item.method === "POST" || item.method === "DELETE" || item.sensitive === ""), "a read never carries it");
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.ok(!audit.includes(secret), "the secret is not in the audit trail");
  } finally { await running.stop(); await agent.close(); }
});

test("an older admin agent that does not report its protection leaves it unknown, not open", async () => {
  const agent = await fakeAgent({ status: false });
  const running = await startServer({ ARMOR_ADMIN_SOCKET: agent.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const status = (await call(running, cookie, "GET", "/api/v1/admin/status")).body;
    assert.deepEqual([status.available, status.sensitive_writes], [true, null]);
  } finally { await running.stop(); await agent.close(); }
});

test("the login limit of a node is read and written through the node's own panel with the login given, which is never kept", async () => {
  const seen: Array<{ url: string; cookie: string; body: string }> = [];
  let limit = 30;
  const panel = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ url: `${request.method} ${request.url}`, cookie: String(request.headers.cookie ?? ""), body });
      if (request.method !== "GET" && request.headers["x-requested-with"] !== "armor") { response.writeHead(403, json); return response.end("{}"); }
      if (request.url === "/api/v1/login") {
        const ok = JSON.parse(body).password === "node-admin-pass";
        response.writeHead(ok ? 200 : 401, ok ? { ...json, "Set-Cookie": "armor_session=abc123; Path=/" } : json);
        return response.end(JSON.stringify({ ok }));
      }
      if (request.url === "/api/v1/config" && request.method === "PUT") { limit = JSON.parse(body).system.login_limit_per_minute; response.writeHead(200, json); return response.end('{"ok":true}'); }
      if (request.url === "/api/v1/config") { response.writeHead(200, json); return response.end(JSON.stringify({ system: { login_limit_per_minute: limit } })); }
      response.writeHead(404, json); response.end("{}");
    });
  });
  await new Promise<void>(resolve => panel.listen(0, "127.0.0.1", resolve));
  process.env.ARMOR_ADMIN_NODE_PORT = String((panel.address() as { port: number }).port);
  const running = await startServer({});
  try {
    const cookie = await studioCookie(running.base);
    const login = { node_id: "nodo-hmi-1", address: "127.0.0.1", panel_user: "admin", panel_password: "node-admin-pass" };
    const read = await call(running, cookie, "POST", "/api/v1/admin/nodes/settings", login);
    assert.deepEqual([read.status, read.body.ok, read.body.login_limit_per_minute, read.body.written], [200, true, 30, false]);
    const wrote = await call(running, cookie, "POST", "/api/v1/admin/nodes/settings", { ...login, login_limit_per_minute: 0 });
    assert.deepEqual([wrote.body.ok, wrote.body.written, wrote.body.login_limit_per_minute], [true, true, 0]);
    assert.deepEqual(JSON.parse(seen.find(item => item.url === "PUT /api/v1/config")!.body), { system: { login_limit_per_minute: 0 } });
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/nodes/settings", { ...login, panel_password: "wrong" })).body.why, "panel_login_refused");
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/nodes/settings", { ...login, login_limit_per_minute: 121 })).status, 422);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/nodes/settings", { ...login, login_limit_per_minute: 1.5 })).status, 422);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/nodes/settings", { node_id: "x", address: "127.0.0.1" })).status, 422);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/nodes/settings", { ...login, node_id: "Bad Id" })).status, 422);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /login_limit_per_minute=0/);
    assert.doesNotMatch(audit, /node-admin-pass/);
    delete process.env.ARMOR_ADMIN_NODE_PORT;
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/nodes/settings", { ...login, address: "8.8.8.8" })).status, 422);
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await new Promise<void>(resolve => panel.close(() => resolve())); }
});

test("the vectors of the shared masking rules hold for the server", { skip: fs.existsSync(path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "src", "armor_common", "env_masking.json")) ? false : "ARMOR-COMMON is not checked out next to this repository" }, () => {
  const rules = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "src", "armor_common", "env_masking.json"), "utf8"));
  assert.equal(rules.mask, MASK);
  for (const item of rules.mask_vectors) assert.equal(maskEnv(item.input), item.output, item.name);
  for (const item of rules.unmask_vectors) {
    const got = unmaskEnv(item.edited, item.current);
    assert.deepEqual(got, item.missing === undefined ? { content: item.content } : { missing: item.missing }, item.name);
  }
});

test("an agent that hides the secrets itself: the server forwards the masked text and never has the originals", async () => {
  const agent = await fakeAgent({ hides: true });
  const running = await startServer({ ARMOR_ADMIN_SOCKET: agent.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const read = await call(running, cookie, "GET", "/api/v1/admin/files/server.env");
    assert.equal(read.body.masked, true);
    assert.doesNotMatch(String(read.body.content), /hunter2/);
    const saved = await call(running, cookie, "PUT", "/api/v1/admin/files/server.env", { content: String(read.body.content).replace("18080", "19090") });
    assert.equal(saved.status, 200);
    const put = agent.seen.find(item => item.method === "PUT");
    assert.ok(String(put?.body.content).includes(`ARMOR_STUDIO_PASSWORD=${MASK}`), "the mask goes to the agent as it is");
    assert.equal(agent.files["server.env"], "ARMOR_PORT=19090\nARMOR_STUDIO_PASSWORD=hunter2-hunter2\nARMOR_INGEST_TOKEN=\n", "the agent put the original back");
    assert.equal((await call(running, cookie, "PUT", "/api/v1/admin/files/server.env", { content: `BRAND_NEW_TOKEN=${MASK}\n` })).status, 422);
  } finally { await running.stop(); await agent.close(); }
});

test("the two switches of the broker rules are off until an administrator turns the setting on, then need two confirmations and the code, and are in the audit trail", async () => {
  const agent = await fakeAgent();
  const running = await startServer({ ARMOR_ADMIN_SOCKET: agent.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const relays = (kind: string, input: Record<string, unknown>, code?: string) => fetch(`${running.base}/api/v1/admin/mqtt/relays/${kind}`, { method: "POST", headers: { ...json, cookie, ...(code ? { "X-Armor-Maint-Totp": code } : {}) }, body: JSON.stringify(input) }).then(async answer => ({ status: answer.status, body: await answer.json() as Record<string, any> }));
    assert.deepEqual((await call(running, cookie, "GET", "/api/v1/admin/mqtt/relays")).body, { enabled: false });
    assert.deepEqual([(await relays("alarm-state-relay", { state: "on", confirm: true, confirm_text: "alarm-state-relay" }, "123456")).status, agent.seen.length > 0 && agent.seen.some(item => item.url.includes("relays/"))], [403, false], "off: the agent is not even asked");
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "admin.acl_relays": true })).status, 200);

    assert.equal((await relays("bogus", { state: "on" })).status, 404);
    assert.deepEqual((await relays("battery-write", { node: "bat-1", state: "maybe", confirm: true, confirm_text: "bat-1" }, "123456")).body, { error: "invalid_state" });
    assert.deepEqual((await relays("battery-write", { node: "Bad Node", state: "on", confirm: true, confirm_text: "Bad Node" }, "123456")).body, { error: "invalid_node_id" });
    assert.deepEqual((await relays("battery-write", { node: "bat-1", state: "on" }, "123456")).body, { error: "confirmation_required" });
    assert.deepEqual((await relays("battery-write", { node: "bat-1", state: "on", confirm: true, confirm_text: "bat-2" }, "123456")).body, { error: "confirmation_mismatch" });
    assert.deepEqual((await relays("alarm-state-relay", { state: "on", confirm: true, confirm_text: "bat-1" }, "123456")).body, { error: "confirmation_mismatch" });
    assert.equal(agent.seen.some(item => item.url.includes("relays/")), false, "no refusal here reaches the agent");

    const status = await call(running, cookie, "GET", "/api/v1/admin/mqtt/relays");
    assert.deepEqual([status.body.enabled, status.body.battery_write, status.body.approval], [true, ["bat-1"], "totp"]);
    assert.equal((await relays("battery-write", { node: "bat-1", state: "on", confirm: true, confirm_text: "bat-1" })).body.error, "totp_required", "the agent's own refusal is handed on");
    assert.equal((await relays("battery-write", { node: "bat-1", state: "on", confirm: true, confirm_text: "bat-1" })).status, 403, "an agent's 401 reaches the console as a 403: a 401 would read as a session that ended");
    const done = await relays("battery-write", { node: "bat-1", state: "on", confirm: true, confirm_text: "bat-1" }, "654321");
    assert.deepEqual([done.status, done.body.ok, done.body.relay, done.body.node, done.body.state], [200, true, "battery-write", "bat-1", "on"]);
    const alarm = await relays("alarm-state-relay", { state: "on", confirm: true, confirm_text: "alarm-state-relay" }, "111111");
    assert.deepEqual([alarm.status, alarm.body.alarm_state_relay], [200, true]);
    assert.equal((await relays("alarm-state-relay", { state: "on", confirm: true, confirm_text: "alarm-state-relay" }, "12345")).body.error, "totp_required", "a code that is not six digits is not handed on");
    assert.deepEqual(agent.seen.filter(item => item.method === "POST" && item.url.includes("relays/")).map(item => item.totp), ["", "", "654321", "111111", ""]);

    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /admin\.acl_relay/);
    assert.match(audit, /acl_relays_disabled/);
    assert.match(audit, /battery-write on/);
    assert.doesNotMatch(audit, /654321|111111|123456/, "the code is never written down");
  } finally { await running.stop(); await agent.close(); }
});

test("the orders for the local authority of the LAN are off until the option is on, then need a confirmation and the code of the authenticator, and the expiry reaches the console", async () => {
  const agent = await fakeAgent();
  const running = await startServer({ ARMOR_ADMIN_SOCKET: agent.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const order = (input: Record<string, unknown>, code?: string) => fetch(`${running.base}/api/v1/admin/lan-ca`, { method: "POST", headers: { ...json, cookie, ...(code ? { "X-Armor-Maint-Totp": code } : {}) }, body: JSON.stringify(input) }).then(async answer => ({ status: answer.status, body: await answer.json() as Record<string, any> }));
    const good = { action: "rotate", ip: "192.168.0.180", names: ["armor.lan"], confirm: true, confirm_text: "lan-ca" };
    assert.deepEqual((await call(running, cookie, "GET", "/api/v1/admin/lan-ca")).body, { enabled: false });
    assert.deepEqual([(await order(good, "123456")).body.error, agent.seen.some(item => item.url.includes("lan-ca"))], ["lan_ca_disabled", false], "off: the agent is not even asked");
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "network.lan_ca": true })).status, 200);
    assert.deepEqual((await order({ ...good, action: "burn" }, "123456")).body, { error: "invalid_action" });
    assert.deepEqual((await order({ ...good, ip: "192.168.0.1; id" }, "123456")).body, { error: "invalid_ip" });
    assert.deepEqual((await order({ ...good, confirm: false }, "123456")).body, { error: "confirmation_required" });
    assert.deepEqual((await order({ ...good, confirm_text: "other" }, "123456")).body, { error: "confirmation_mismatch" });
    assert.equal(agent.seen.some(item => item.url.includes("lan-ca")), false, "no refusal here reaches the agent");
    const status = await call(running, cookie, "GET", "/api/v1/admin/lan-ca");
    assert.deepEqual([status.body.enabled, status.body.expiring, status.body.renew_days], [true, ["certificate"], 30]);
    const refused = await order(good);
    assert.deepEqual([refused.status, refused.body.error], [403, "totp_required"]);
    const done = await order(good, "654321");
    assert.deepEqual([done.status, done.body.ok, done.body.devices_must_reinstall], [200, true, true]);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /admin\.lan_ca/);
    assert.doesNotMatch(audit, /654321|123456/, "the code is never written down");
  } finally { await running.stop(); await agent.close(); }
});

test("the field-http switch of the firewall is off until the option is on, then needs a confirmation and the code of the authenticator", async () => {
  const agent = await fakeAgent();
  const running = await startServer({ ARMOR_ADMIN_SOCKET: agent.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const change = (input: Record<string, unknown>, code?: string) => fetch(`${running.base}/api/v1/admin/firewall/field-http`, { method: "POST", headers: { ...json, cookie, ...(code ? { "X-Armor-Maint-Totp": code } : {}) }, body: JSON.stringify(input) }).then(async answer => ({ status: answer.status, body: await answer.json() as Record<string, any> }));
    assert.deepEqual((await call(running, cookie, "GET", "/api/v1/admin/firewall")).body, { enabled: false });
    assert.deepEqual([(await change({ state: "on", confirm: true, confirm_text: "field-http" }, "123456")).body.error, agent.seen.some(item => item.url.includes("firewall"))], ["field_http_disabled", false], "off: the agent is not even asked");
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "admin.field_http": true })).status, 200);
    assert.deepEqual((await change({ state: "maybe", confirm: true, confirm_text: "field-http" }, "123456")).body, { error: "invalid_state" });
    assert.deepEqual((await change({ state: "on" }, "123456")).body, { error: "confirmation_required" });
    assert.deepEqual((await change({ state: "on", confirm: true, confirm_text: "other" }, "123456")).body, { error: "confirmation_mismatch" });
    assert.equal(agent.seen.some(item => item.url.includes("firewall")), false, "no refusal here reaches the agent");
    const status = await call(running, cookie, "GET", "/api/v1/admin/firewall");
    assert.deepEqual([status.body.enabled, status.body.installed, status.body.field_http, status.body.approval], [true, true, false, "totp"]);
    const refused = await change({ state: "on", confirm: true, confirm_text: "field-http" });
    assert.deepEqual([refused.status, refused.body.error], [403, "totp_required"], "the agent's 401 reaches the console as a 403");
    const done = await change({ state: "on", confirm: true, confirm_text: "field-http" }, "654321");
    assert.deepEqual([done.status, done.body.ok, done.body.field_http], [200, true, true]);
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/firewall")).body.field_http, true);
    assert.equal((await change({ state: "off", confirm: true, confirm_text: "field-http" }, "111111")).body.field_http, false);
    assert.deepEqual(agent.seen.filter(item => item.method === "POST" && item.url.includes("firewall")).map(item => item.totp), ["", "654321", "111111"]);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /admin\.firewall/);
    assert.match(audit, /field_http_disabled/);
    assert.doesNotMatch(audit, /654321|111111|123456/, "the code is never written down");
  } finally { await running.stop(); await agent.close(); }
});

test("with admin.require_masked_agent off an agent that does not hide the secrets is accepted, and on it is refused before any secret is relayed", async () => {
  const old = await fakeAgent();   // an older agent: its answer does not say that it hides the secrets
  const running = await startServer({ ARMOR_ADMIN_SOCKET: old.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    const settings = (await call(running, cookie, "GET", "/api/v1/security/settings")).body.settings as Record<string, unknown>;
    assert.equal(settings["admin.require_masked_agent"], false, "off by default: nothing that worked before stops working");
    const open = await call(running, cookie, "GET", "/api/v1/admin/files/server.env");
    assert.equal(open.status, 200);
    assert.doesNotMatch(String(open.body.content), /hunter2/, "this server hides the secrets itself when the agent does not");
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "admin.require_masked_agent": true })).status, 200);
    const refused = await call(running, cookie, "GET", "/api/v1/admin/files/server.env");
    assert.deepEqual([refused.status, refused.body], [409, { error: "agent_not_masking" }], "no content and no secret is relayed");
    const before = old.seen.filter(item => item.method === "PUT").length;
    assert.deepEqual((await call(running, cookie, "PUT", "/api/v1/admin/files/server.env", { content: `ARMOR_PORT=19090\nARMOR_STUDIO_PASSWORD=${MASK}\n` })).body, { error: "agent_not_masking" });
    assert.equal(old.seen.filter(item => item.method === "PUT").length, before, "nothing is saved through an agent that would hand the originals to this server");
    assert.equal((await call(running, cookie, "GET", "/api/v1/admin/files/mosquitto.conf")).status, 200, "a file with no secrets is still read");
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.doesNotMatch(audit, /hunter2/);
  } finally { await running.stop(); await old.close(); }
  const modern = await fakeAgent({ hides: true });
  const again = await startServer({ ARMOR_ADMIN_SOCKET: modern.socket, ARMOR_ADMIN_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(again.base);
    assert.equal((await call(again, cookie, "PUT", "/api/v1/security/settings", { "admin.require_masked_agent": true })).status, 200);
    const read = await call(again, cookie, "GET", "/api/v1/admin/files/server.env");
    assert.equal(read.status, 200);
    assert.equal(read.body.masked, true);
    assert.doesNotMatch(String(read.body.content), /hunter2/);
    assert.equal((await call(again, cookie, "PUT", "/api/v1/admin/files/server.env", { content: String(read.body.content).replace("18080", "19090") })).status, 200);
  } finally { await again.stop(); await modern.close(); }
});
