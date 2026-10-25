// The panel of a node reached through the server: where the request goes is decided by the server, the cookie of the node never leaves it, the certificate is pinned and
// what changes the node stays in the house unless the installation allows it.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { cleanPanelPath, normaliseFingerprint, PanelRegistry } from "../src/node_panel_proxy.js";
import { SECRETS, startServer, studioCookie } from "./helpers.js";

const json = { "Content-Type": "application/json" };
type Seen = { line: string; headers: http.IncomingHttpHeaders; body: string };

function fakeNode(secure?: { key: string; cert: string }): Promise<{ port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const handler: http.RequestListener = (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      seen.push({ line: `${request.method} ${request.url}`, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (request.url === "/api/v1/login") { response.writeHead(200, { ...json, "Set-Cookie": "armor_session=node-secret; Path=/; HttpOnly" }); return response.end("{\"ok\":true}"); }
      if (request.url === "/old") { response.writeHead(302, { Location: "/new" }); return response.end(); }
      if (request.url === "/") { response.writeHead(200, { "Content-Type": "text/html" }); return response.end("<html>panel</html>"); }
      if (request.url === "/app.js") { const packed = zlib.gzipSync("console.log(\"panel\");"); response.writeHead(200, { "Content-Type": "text/javascript", "Content-Encoding": "gzip", "Content-Length": String(packed.length) }); return response.end(packed); }
      response.writeHead(200, json); response.end(JSON.stringify({ ok: true, cookie: request.headers.cookie ?? null }));
    });
  };
  const server = secure ? https.createServer(secure, handler) : http.createServer(handler);
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, seen, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) })));
}

/** A request written exactly as given (fetch tidies "../" away before it is sent). */
function rawGet(base: string, cookie: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = http.request({ host: url.hostname, port: url.port, path: target, method: "GET", headers: { Cookie: cookie } }, reply => { reply.resume(); resolve(reply.statusCode ?? 0); });
    request.on("error", reject);
    request.end();
  });
}

async function viaServer(base: string, cookie: string, method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${url}`, { method, headers: { Cookie: cookie, ...headers }, body, redirect: "manual" });
}

test("the path of a panel is cleaned and a fingerprint is written one way", () => {
  assert.deepEqual(cleanPanelPath("/"), { path: "/", query: "" });
  assert.deepEqual(cleanPanelPath("/api/v1/session?x=1"), { path: "/api/v1/session", query: "x=1" });
  assert.deepEqual(cleanPanelPath(""), { path: "/", query: "" });
  for (const bad of ["/../x", "/a/%2e%2e/b", "/a/%2E%2E", "//x", "/a\\b", "/a%2fb", "/a%00", "x", "/a b", "/a?x=1\r\n"]) assert.equal(cleanPanelPath(bad), undefined, bad);
  assert.equal(normaliseFingerprint("AB:".repeat(31) + "AB"), "ab".repeat(32));
  assert.equal(normaliseFingerprint("nope"), undefined);
});

test("only an address inside the house is accepted for a panel", () => {
  assert.ok(PanelRegistry.check({ id: "radar-1", address: "192.168.0.50", scheme: "http" }));
  assert.equal(PanelRegistry.check({ id: "radar-1", address: "8.8.8.8", scheme: "http" }), undefined);
  assert.equal(PanelRegistry.check({ id: "radar-1", address: "192.168.0.300", scheme: "http" }), undefined);
  assert.equal(PanelRegistry.check({ id: "radar-1", address: "127.0.0.1", scheme: "http" }), undefined, "the loopback address is for the tests only");
  assert.equal(PanelRegistry.check({ id: "Bad Id", address: "192.168.0.50", scheme: "http" }), undefined);
  assert.equal(PanelRegistry.check({ id: "r", address: "192.168.0.50", scheme: "ftp" }), undefined);
  assert.equal(PanelRegistry.check({ id: "r", address: "192.168.0.50", scheme: "https", fingerprint: "zz" }), undefined);
  assert.equal(PanelRegistry.check({ id: "r", address: "192.168.0.50", scheme: "https" })?.port, 443);
});

test("the panel of a node goes through the server, keeps the cookie of the node and writes down what changes", async () => {
  const node = await fakeNode();
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const put = await fetch(`${running.base}/api/v1/admin/node-panels/radar-salon`, { method: "PUT", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ address: "127.0.0.1", scheme: "http", port: node.port, label: "Salon" }) });
    assert.equal(put.status, 200);
    assert.equal(((await (await fetch(`${running.base}/api/v1/admin/node-panels`, { headers: { Cookie: cookie } })).json()) as { panels: unknown[] }).panels.length, 1);
    assert.equal((await fetch(`${running.base}/api/v1/admin/node-panels/x1`, { method: "PUT", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ address: "8.8.8.8", scheme: "http" }) })).status, 422);

    // the page, the login of the node (its cookie stays here) and a later call that carries it
    assert.equal((await viaServer(running.base, cookie, "GET", "/api/v1/nodes/radar-salon/panel")).status, 308);
    const page = await viaServer(running.base, cookie, "GET", "/api/v1/nodes/radar-salon/panel/");
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<html>panel</html>");
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
    // the compressed script of the node reaches the browser saying it is compressed, so the browser reads it and not the bytes
    const script = await viaServer(running.base, cookie, "GET", "/api/v1/nodes/radar-salon/panel/app.js");
    assert.equal(script.headers.get("content-encoding"), "gzip");
    assert.equal(await script.text(), "console.log(\"panel\");");
    assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
    const login = await viaServer(running.base, cookie, "POST", "/api/v1/nodes/radar-salon/panel/api/v1/login", "{\"user\":\"a\",\"password\":\"b\"}", { ...json, "X-Requested-With": "armor", Origin: "http://evil.example", Referer: "http://evil.example/x" });
    assert.equal(login.status, 200);
    assert.equal(login.headers.getSetCookie().length, 0, "the cookie of the node never reaches the browser");
    const later = await (await viaServer(running.base, cookie, "GET", "/api/v1/nodes/radar-salon/panel/api/v1/status")).json() as { cookie: string };
    assert.equal(later.cookie, "armor_session=node-secret");
    const loginSeen = node.seen.find(item => item.line === "POST /api/v1/login")!;
    assert.equal(loginSeen.headers["x-requested-with"], "armor");
    assert.equal(loginSeen.headers.origin, undefined);
    assert.equal(loginSeen.headers.referer, undefined);
    assert.equal(loginSeen.headers.cookie, undefined, "the cookies of the server never reach the node");
    assert.equal(loginSeen.headers.authorization, undefined);

    // a redirect of the node stays inside the panel
    const redirect = await viaServer(running.base, cookie, "GET", "/api/v1/nodes/radar-salon/panel/old");
    assert.equal(redirect.headers.get("location"), "/api/v1/nodes/radar-salon/panel/new");

    // the address of the node comes from the list, never from the request
    assert.equal((await viaServer(running.base, cookie, "GET", "/api/v1/nodes/unknown/panel/")).status, 404);
    for (const bad of ["/api/v1/nodes/radar-salon/panel/../x", "/api/v1/nodes/radar-salon/panel/%2e%2e/x", "/api/v1/nodes/radar-salon/panel//x"]) assert.equal(await rawGet(running.base, cookie, bad), 400, bad);
    assert.equal((await viaServer(running.base, cookie, "PATCH", "/api/v1/nodes/radar-salon/panel/")).status, 405);

    // a body that is too big is refused
    const big = await viaServer(running.base, cookie, "POST", "/api/v1/nodes/radar-salon/panel/api/v1/log", "x".repeat(70_000), json);
    assert.equal(big.status, 413);

    // nobody but an administrator, and the audit trail has the writes without the content
    assert.equal((await fetch(`${running.base}/api/v1/nodes/radar-salon/panel/`)).status, 401);
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /node-panel\.open/);
    assert.match(audit, /node-panel\.write/);
    assert.doesNotMatch(audit, /node-secret|"password":"b"/);

    // removing it closes it
    assert.equal((await fetch(`${running.base}/api/v1/admin/node-panels/radar-salon`, { method: "DELETE", headers: { Cookie: cookie } })).status, 204);
    assert.equal((await viaServer(running.base, cookie, "GET", "/api/v1/nodes/radar-salon/panel/")).status, 404);
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await node.close(); }
});

test("from outside a new panel asks for a new proof, a viewer cannot open one and the dangerous routes stay in the house", async () => {
  const node = await fakeNode();
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const running = await startServer({ ARMOR_LOCAL_NETWORKS: "10.99.0.0/16", ARMOR_REMOTE_POLICY: "full" });   // the test client is then "outside"
  try {
    const login = async (username: string, password: string) => {
      const reply = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username, password }) });
      assert.equal(reply.status, 201);
      return (reply.headers.getSetCookie()[0] ?? "").split(";")[0]!;
    };
    const elevate = (cookie: string) => fetch(`${running.base}/api/v1/studio/elevate`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ password: SECRETS.ARMOR_STUDIO_PASSWORD }) });
    const first = await login(SECRETS.ARMOR_STUDIO_USERNAME, SECRETS.ARMOR_STUDIO_PASSWORD);
    const entry = JSON.stringify({ address: "127.0.0.1", scheme: "http", port: node.port });
    const refused = await fetch(`${running.base}/api/v1/admin/node-panels/radar-salon`, { method: "PUT", headers: { ...json, Cookie: first }, body: entry });
    assert.deepEqual([refused.status, ((await refused.json()) as { code: string }).code], [403, "elevation_required"]);
    assert.equal((await elevate(first)).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/admin/node-panels/radar-salon`, { method: "PUT", headers: { ...json, Cookie: first }, body: entry })).status, 200);

    // another session of the administrator has to prove who it is before it opens a panel; then it goes on
    const second = await login(SECRETS.ARMOR_STUDIO_USERNAME, SECRETS.ARMOR_STUDIO_PASSWORD);
    const closed = await viaServer(running.base, second, "GET", "/api/v1/nodes/radar-salon/panel/");
    assert.deepEqual([closed.status, ((await closed.json()) as { code: string }).code], [403, "elevation_required"]);
    assert.equal((await elevate(second)).status, 200);
    assert.equal((await viaServer(running.base, second, "GET", "/api/v1/nodes/radar-salon/panel/")).status, 200);

    // a viewer never gets in
    assert.equal((await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: { ...json, Cookie: first }, body: JSON.stringify({ username: "visitor", password: "a-long-password-1", role: "viewer" }) })).status, 201);
    const viewer = await login("visitor", "a-long-password-1");
    assert.equal((await viaServer(running.base, viewer, "GET", "/api/v1/nodes/radar-salon/panel/")).status, 403);
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await node.close(); }

  // with the policy "operate" a session from outside may look at the panel but not change the node, and what could expose or change it stays in the house
  const other = await fakeNode();
  process.env.ARMOR_ADMIN_NODE_PORT = String(other.port);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-test-"));
  fs.writeFileSync(path.join(dataDir, "node_panels.json"), JSON.stringify({ schema: 1, panels: [{ id: "radar-salon", address: "127.0.0.1", scheme: "http", port: other.port }] }));
  const limited = await startServer({ ARMOR_DATA_DIR: dataDir, ARMOR_LOCAL_NETWORKS: "10.99.0.0/16", ARMOR_REMOTE_POLICY: "operate" });
  try {
    const cookie = await studioCookie(limited.base);
    assert.equal((await fetch(`${limited.base}/api/v1/studio/elevate`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ password: SECRETS.ARMOR_STUDIO_PASSWORD }) })).status, 200);
    assert.equal((await viaServer(limited.base, cookie, "GET", "/api/v1/nodes/radar-salon/panel/")).status, 200);
    const export_ = await viaServer(limited.base, cookie, "GET", "/api/v1/nodes/radar-salon/panel/api/v1/config/export");
    assert.deepEqual([export_.status, ((await export_.json()) as { code: string }).code], [403, "remote_policy"]);
    for (const route of ["api/v1/ota", "api/v1/factory-reset", "api/v1/reboot", "api/v1/config"]) assert.equal((await viaServer(limited.base, cookie, "POST", `/api/v1/nodes/radar-salon/panel/${route}`, "{}", json)).status, 403, route);
    assert.equal(other.seen.filter(item => item.line !== "GET /").length, 0, "none of it reached the node");
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await limited.stop(); await other.close(); }
});

test("over HTTPS the certificate is pinned: another one is refused and an untrusted one is not used", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-cert-"));
  // No inherited OPENSSL_CONF (a developer machine can have one that points at another installation), as tls.test.ts does.
  const { OPENSSL_CONF: _unused, ...env } = process.env;
  try { execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=node"], { env: { ...env, MSYS_NO_PATHCONV: "1" }, stdio: "ignore" }); }
  catch { t.skip("openssl is not available"); return; }
  const key = fs.readFileSync(path.join(dir, "k.pem"), "utf8"), cert = fs.readFileSync(path.join(dir, "c.pem"), "utf8");
  const real = normaliseFingerprint(new X509Certificate(cert).fingerprint256)!;
  const node = await fakeNode({ key, cert });
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const set = (fingerprint?: string) => fetch(`${running.base}/api/v1/admin/node-panels/alarm-1`, { method: "PUT", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ address: "127.0.0.1", scheme: "https", port: node.port, ...(fingerprint ? { fingerprint } : {}) }) });
    assert.equal((await set()).status, 200);
    const notTrusted = await viaServer(running.base, cookie, "GET", "/api/v1/nodes/alarm-1/panel/");
    assert.deepEqual([notTrusted.status, ((await notTrusted.json()) as { code: string }).code], [409, "not_pinned"]);
    // the administrator looks at the certificate the node shows, compares it and trusts it
    const seen = await (await fetch(`${running.base}/api/v1/admin/node-panels/alarm-1/fingerprint`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ trust: false }) })).json() as { fingerprint: string; trusted: boolean };
    assert.deepEqual([seen.fingerprint, seen.trusted], [real, false]);
    assert.equal((await set("00".repeat(32))).status, 200);
    const wrong = await viaServer(running.base, cookie, "GET", "/api/v1/nodes/alarm-1/panel/");
    assert.deepEqual([wrong.status, ((await wrong.json()) as { code: string }).code], [502, "fingerprint_mismatch"]);
    const trusted = await (await fetch(`${running.base}/api/v1/admin/node-panels/alarm-1/fingerprint`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ trust: true }) })).json() as { trusted: boolean };
    assert.equal(trusted.trusted, true);
    const good = await viaServer(running.base, cookie, "GET", "/api/v1/nodes/alarm-1/panel/");
    assert.equal(good.status, 200);
    assert.match(fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8"), /node-panel\.fingerprint/);
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await node.close(); }
});
