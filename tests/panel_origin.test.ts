// The panels of the nodes served from a second origin (panel.separate_origin): the way in is a ticket of one use that dies in seconds, the cookie of the panel origin is its own and
// opens one node only, the API has nothing to do with that origin and the panel origin has nothing of the API.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isOwnOrigin, PANEL_COOKIE, PANEL_SESSION_IDLE_MS, PANEL_TICKET_TTL_MS, PanelSessions, PanelTickets, type PanelGrant } from "../src/panel_origin.js";
import { lowers, SECURITY_DEFAULTS } from "../src/security_settings.js";
import { SECRETS, startServer, studioCookie, testConfig } from "./helpers.js";

const json = { "Content-Type": "application/json" };
type Seen = { line: string; headers: http.IncomingHttpHeaders; body: string };

function fakeNode(): Promise<{ port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      seen.push({ line: `${request.method} ${request.url}`, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (request.url === "/api/v1/login") { response.writeHead(200, { ...json, "Set-Cookie": "armor_session=node-secret; Path=/; HttpOnly" }); return response.end("{\"ok\":true}"); }
      if (request.url === "/") { response.writeHead(200, { "Content-Type": "text/html" }); return response.end("<html>panel</html>"); }
      response.writeHead(200, json);
      return response.end(JSON.stringify({ ok: true, cookie: request.headers.cookie ?? null }));
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, seen, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) })));
}

/** A port nobody uses right now, for the second origin of a test. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
  });
}

const put = (base: string, cookie: string, route: string, body: unknown, method = "PUT") => fetch(`${base}${route}`, { method, headers: { ...json, Cookie: cookie }, body: JSON.stringify(body) });
const setOption = async (base: string, cookie: string, settings: Record<string, boolean>) => assert.equal((await put(base, cookie, "/api/v1/security/settings", settings)).status, 200);
const grant = (nodeId = "radar-1", handle = "h1"): PanelGrant => ({ nodeId, handle, actor: "admin", remote: false });

test("the option is off by default and turning it off is the loss", () => {
  assert.equal(SECURITY_DEFAULTS["panel.separate_origin"], false);
  assert.equal(lowers("panel.separate_origin", true, false), true);
  assert.equal(lowers("panel.separate_origin", false, true), false);
});

test("the port and the address of the second origin come from the environment, with the port next to the server's as the start", () => {
  const plain = testConfig({ ARMOR_PORT: "18080" });
  assert.equal(plain.panelPort, 18081);
  assert.equal(plain.panelOrigin, null);
  assert.equal(testConfig({ ARMOR_PORT: "65535" }).panelPort, 65534);
  assert.equal(testConfig({ ARMOR_PANEL_PORT: "19000" }).panelPort, 19000);
  assert.equal(testConfig({ ARMOR_PANEL_ORIGIN: "https://panels.example.org:8443/" }).panelOrigin, "https://panels.example.org:8443");
  assert.throws(() => testConfig({ ARMOR_PANEL_PORT: "70000" }), /ARMOR_PANEL_PORT/);
  assert.throws(() => testConfig({ ARMOR_PANEL_ORIGIN: "panels.example.org" }), /ARMOR_PANEL_ORIGIN/);
  assert.throws(() => testConfig({ ARMOR_PANEL_ORIGIN: "https://u:p@panels.example.org" }), /ARMOR_PANEL_ORIGIN/);
});

test("a ticket is good once, and only until it expires", () => {
  let now = 1_000_000;
  const tickets = new PanelTickets(() => now);
  const first = tickets.issue(grant());
  assert.match(first, /^[A-Za-z0-9_-]{43}$/, "32 random bytes");
  assert.deepEqual(tickets.consume(first), grant());
  assert.equal(tickets.consume(first), undefined, "the second use finds nothing");
  const late = tickets.issue(grant());
  now += PANEL_TICKET_TTL_MS;
  assert.equal(tickets.consume(late), undefined, "a ticket that waited its whole life is dead");
  const justInTime = tickets.issue(grant());
  now += PANEL_TICKET_TTL_MS - 1;
  assert.deepEqual(tickets.consume(justInTime), grant());
  assert.equal(tickets.consume("x".repeat(43)), undefined);
  assert.equal(tickets.consume(""), undefined);
  assert.equal(PANEL_TICKET_TTL_MS <= 60_000, true, "seconds, not minutes");
});

test("a failed exchange also spends the ticket, and the number kept is bounded", () => {
  let now = 0;
  const tickets = new PanelTickets(() => now);
  const old = tickets.issue(grant());
  now += PANEL_TICKET_TTL_MS + 1;
  assert.equal(tickets.consume(old), undefined);
  assert.equal(tickets.size, 0);
  for (let index = 0; index < 200; index += 1) tickets.issue(grant(`node-${index}`));
  assert.ok(tickets.size <= 64, `at most 64 wait at once (${tickets.size})`);
  tickets.clear();
  assert.equal(tickets.size, 0);
});

test("a panel session opens one node only and goes after it sat unused", () => {
  let now = 0;
  const sessions = new PanelSessions(() => now);
  const id = sessions.create(grant("radar-1"));
  assert.deepEqual(sessions.get(id, "radar-1"), grant("radar-1"));
  assert.equal(sessions.get(id, "radar-2"), undefined, "the cookie of a node opens no other");
  assert.equal(sessions.get("nope", "radar-1"), undefined);
  now += PANEL_SESSION_IDLE_MS - 1;
  assert.ok(sessions.get(id, "radar-1"), "being used renews it");
  now += PANEL_SESSION_IDLE_MS - 1;
  assert.ok(sessions.get(id, "radar-1"));
  now += PANEL_SESSION_IDLE_MS + 1;
  assert.equal(sessions.get(id, "radar-1"), undefined);
  const other = sessions.create(grant("radar-1"));
  sessions.endNode("radar-1");
  assert.equal(sessions.get(other, "radar-1"), undefined, "changing or removing a panel ends what was open");
  for (let index = 0; index < 100; index += 1) sessions.create(grant(`node-${index}`));
  assert.ok(sessions.size <= 32);
});

test("an Origin is the panel's own only when its host is the one asked, or the public address that was configured", () => {
  assert.equal(isOwnOrigin("http://127.0.0.1:18081", "127.0.0.1:18081", null), true);
  assert.equal(isOwnOrigin("http://127.0.0.1:18080", "127.0.0.1:18081", null), false, "the API is another origin");
  assert.equal(isOwnOrigin("http://evil.example", "127.0.0.1:18081", null), false);
  assert.equal(isOwnOrigin("null", "127.0.0.1:18081", null), false);
  assert.equal(isOwnOrigin("https://panels.example.org", "10.0.0.5:18081", "https://panels.example.org"), true);
  assert.equal(isOwnOrigin("https://panels.example.org", undefined, null), false);
});

test("off, the panels stay where they were: no second origin, no ticket", async () => {
  const node = await fakeNode();
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const running = await startServer({ ARMOR_PANEL_PORT: String(await freePort()) });
  try {
    const cookie = await studioCookie(running.base);
    await setOption(running.base, cookie, { "panel.proxy_http": true });
    assert.equal((await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1", { address: "127.0.0.1", scheme: "http", port: node.port })).status, 200);
    assert.equal(running.app.panelOrigin.port(), undefined, "nothing listens");
    const ticket = await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST");
    assert.deepEqual([ticket.status, ((await ticket.json()) as { code: string }).code], [409, "panel_origin_off"]);
    const page = await fetch(`${running.base}/api/v1/nodes/radar-1/panel/`, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200, "through the API as always");
    assert.equal(await page.text(), "<html>panel</html>");
    assert.equal((await fetch(`${running.base}/api/v1/admin/node-panels/radar-1/ticket`, { method: "POST" })).status, 401, "only an administrator asks, on or off");
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await node.close(); }
});

test("on, a panel is entered with a ticket of one use and then lives on its own origin", async () => {
  const node = await fakeNode();
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const running = await startServer({ ARMOR_PANEL_PORT: String(await freePort()) });
  try {
    const cookie = await studioCookie(running.base);
    await setOption(running.base, cookie, { "panel.proxy_http": true, "panel.separate_origin": true });
    assert.equal((await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1", { address: "127.0.0.1", scheme: "http", port: node.port })).status, 200);

    // the API no longer serves the panel: its script would run with the session of the administrator
    const viaApi = await fetch(`${running.base}/api/v1/nodes/radar-1/panel/`, { headers: { Cookie: cookie } });
    assert.deepEqual([viaApi.status, ((await viaApi.json()) as { code: string }).code], [403, "panel_origin_required"]);
    assert.equal(node.seen.length, 0, "nothing reached the node through the API");

    const asked = await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST");
    assert.equal(asked.status, 201);
    assert.equal(asked.headers.get("cache-control"), "no-store");
    const answer = (await asked.json()) as { url: string; origin: string; expires_in_s: number };
    const port = running.app.panelOrigin.port();
    assert.ok(port, "it listens");
    assert.notEqual(String(port), new URL(running.base).port, "a port of its own");
    assert.equal(answer.origin, `http://127.0.0.1:${port}`);
    assert.equal(answer.expires_in_s, PANEL_TICKET_TTL_MS / 1000);
    assert.match(answer.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/enter/[A-Za-z0-9_-]{43}$`));
    assert.notEqual(new URL(answer.url).origin, new URL(running.base).origin, "not the origin of the API");

    // the exchange: a cookie of the panel origin, for this node only, and an address without the ticket
    const entered = await fetch(answer.url, { redirect: "manual" });
    assert.equal(entered.status, 303);
    assert.equal(entered.headers.get("location"), "/panel/radar-1/", "the ticket is not in the address the browser ends on");
    assert.equal(entered.headers.get("cache-control"), "no-store");
    assert.equal(entered.headers.get("referrer-policy"), "no-referrer");
    assert.equal(entered.headers.get("access-control-allow-origin"), null, "no CORS on the panel origin");
    const setCookie = entered.headers.getSetCookie();
    assert.equal(setCookie.length, 1);
    assert.match(setCookie[0]!, new RegExp(`^${PANEL_COOKIE}=`));
    assert.match(setCookie[0]!, /HttpOnly/i);
    assert.match(setCookie[0]!, /SameSite=Strict/i);
    assert.match(setCookie[0]!, /Path=\/panel\/radar-1(;|$)/);
    assert.doesNotMatch(setCookie[0]!, /Domain=/i, "a cookie for this host alone");
    const panelCookie = setCookie[0]!.split(";")[0]!;

    // the ticket does not open a second time, nor does a made-up one
    const again = await fetch(answer.url, { redirect: "manual" });
    assert.deepEqual([again.status, ((await again.json()) as { code: string }).code], [403, "ticket_invalid"]);
    assert.equal(again.headers.getSetCookie().length, 0);
    assert.equal((await fetch(`${answer.origin}/enter/${"A".repeat(43)}`, { redirect: "manual" })).status, 403);
    assert.equal((await fetch(`${answer.origin}/enter/short`, { redirect: "manual" })).status, 403);

    // the panel, with the cookie of the panel origin; the Studio cookie travels too (the browser sends the cookies of a host to all its ports) and goes nowhere
    const page = await fetch(`${answer.origin}/panel/radar-1/`, { headers: { Cookie: `${cookie}; ${panelCookie}` } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<html>panel</html>");
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("access-control-allow-origin"), null);
    assert.equal(page.headers.get("cross-origin-resource-policy"), "same-origin");
    const login = await fetch(`${answer.origin}/panel/radar-1/api/v1/login`, { method: "POST", headers: { ...json, Cookie: `${cookie}; ${panelCookie}`, "X-Requested-With": "armor" }, body: "{}" });
    assert.equal(login.status, 200);
    assert.equal(login.headers.getSetCookie().length, 0, "the cookie of the node stays on the server");
    const later = await (await fetch(`${answer.origin}/panel/radar-1/api/v1/status`, { headers: { Cookie: `${cookie}; ${panelCookie}` } })).json() as { cookie: string };
    assert.equal(later.cookie, "armor_session=node-secret", "the node gets its own cookie and none of the browser's");
    for (const item of node.seen) assert.ok(item.headers.cookie === undefined || item.headers.cookie === "armor_session=node-secret", `${item.line} carried ${item.headers.cookie}`);

    // without the cookie, or with the cookie of another node, or on a path of the API: nothing
    assert.equal((await fetch(`${answer.origin}/panel/radar-1/`)).status, 401);
    assert.equal((await fetch(`${answer.origin}/panel/radar-1/`, { headers: { Cookie: cookie } })).status, 401, "the session of Studio is not a key to the panels");
    assert.equal((await fetch(`${answer.origin}/panel/radar-2/`, { headers: { Cookie: panelCookie } })).status, 401, "the cookie of a node opens no other");
    for (const route of ["/api/v1/studio/session", "/api/v1/admin/node-panels", "/api/v1/nodes/radar-1/panel/", "/"]) assert.equal((await fetch(`${answer.origin}${route}`, { headers: { Cookie: `${cookie}; ${panelCookie}` } })).status, 404, route);

    // the API does not know the cookie of the panel origin
    assert.equal((await fetch(`${running.base}/api/v1/admin/node-panels`, { headers: { Cookie: panelCookie } })).status, 401);
    assert.equal((await fetch(`${running.base}/api/v1/studio/session`, { headers: { Cookie: panelCookie } })).status !== 200, true);

    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /node-panel\.ticket/);
    assert.match(audit, /node-panel\.open/);
    assert.doesNotMatch(audit, /enter\/[A-Za-z0-9_-]{43}|node-secret/, "neither the ticket nor the cookie of the node is written down");
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await node.close(); }
});

test("a page of another origin is refused on both sides: the panel origin does not take it and the API does not take the panel origin", async () => {
  const node = await fakeNode();
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const running = await startServer({ ARMOR_PANEL_PORT: String(await freePort()) });
  try {
    const cookie = await studioCookie(running.base);
    await setOption(running.base, cookie, { "panel.proxy_http": true, "panel.separate_origin": true });
    await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1", { address: "127.0.0.1", scheme: "http", port: node.port });
    const { url, origin } = (await (await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST")).json()) as { url: string; origin: string };
    const panelCookie = (await fetch(url, { redirect: "manual" })).headers.getSetCookie()[0]!.split(";")[0]!;

    // from the panel origin to the API: the script of a node cannot use the session of Studio, which the browser would attach (same host, another port)
    for (const [method, route] of [["GET", "/api/v1/admin/node-panels"], ["POST", "/api/v1/admin/node-panels/radar-1/ticket"], ["PUT", "/api/v1/security/settings"], ["GET", "/api/v1/studio/session"]] as const) {
      const reply = await fetch(`${running.base}${route}`, { method, headers: { ...json, Cookie: cookie, Origin: origin }, body: method === "GET" ? undefined : "{}" });
      assert.deepEqual([reply.status, ((await reply.json()) as { code: string }).code], [403, "panel_origin_forbidden"], `${method} ${route}`);
    }
    const options = await fetch(`${running.base}/api/v1/security/settings`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "PUT" } });
    assert.equal(options.headers.get("access-control-allow-origin"), null, "no CORS answer for the panel origin");
    assert.equal(options.status, 403);
    // the other origins are not touched: Studio on its own origin still works
    assert.equal((await fetch(`${running.base}/api/v1/admin/node-panels`, { headers: { Cookie: cookie, Origin: "http://127.0.0.1:5178" } })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/admin/node-panels`, { headers: { Cookie: cookie } })).status, 200);

    // into the panel origin: a page of any other origin, the API included, cannot use its cookie
    for (const foreign of ["http://evil.example", running.base, "null", "http://127.0.0.1:5178"]) {
      const reply = await fetch(`${origin}/panel/radar-1/`, { headers: { Cookie: panelCookie, Origin: foreign } });
      assert.deepEqual([reply.status, ((await reply.json()) as { code: string }).code], [403, "origin_mismatch"], foreign);
    }
    assert.equal((await fetch(`${origin}/panel/radar-1/`, { headers: { Cookie: panelCookie, Origin: origin } })).status, 200, "its own origin is fine");
    assert.equal(node.seen.filter(item => item.line !== "GET /").length, 0, "nothing of that reached the node");
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await node.close(); }
});

test("the ticket and the panel live and die with the session of Studio that asked", async () => {
  const node = await fakeNode();
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const running = await startServer({ ARMOR_PANEL_PORT: String(await freePort()) });
  try {
    const cookie = await studioCookie(running.base);
    await setOption(running.base, cookie, { "panel.proxy_http": true, "panel.separate_origin": true });
    await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1", { address: "127.0.0.1", scheme: "http", port: node.port });
    const ask = async () => ((await (await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST")).json()) as { url: string }).url;

    // a panel that is open stops when the session that opened it ends
    const open = await fetch(await ask(), { redirect: "manual" });
    const panelCookie = open.headers.getSetCookie()[0]!.split(";")[0]!;
    const origin = `http://127.0.0.1:${running.app.panelOrigin.port()}`;
    const spare = await ask();   // asked while the session still stood, used after it ended
    assert.equal((await fetch(`${origin}/panel/radar-1/`, { headers: { Cookie: panelCookie } })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/studio/session`, { method: "DELETE", headers: { Cookie: cookie } })).status < 300, true);
    const closed = await fetch(`${origin}/panel/radar-1/`, { headers: { Cookie: panelCookie } });
    assert.deepEqual([closed.status, ((await closed.json()) as { code: string }).code], [401, "session_ended"]);
    const late = await fetch(spare, { redirect: "manual" });
    assert.deepEqual([late.status, ((await late.json()) as { code: string }).code], [403, "ticket_invalid"], "a ticket of a session that ended opens nothing");
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await node.close(); }
});

test("turning the option off closes the panels that were open, and they do not come back when it is turned on again", async () => {
  const node = await fakeNode();
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const running = await startServer({ ARMOR_PANEL_PORT: String(await freePort()) });
  try {
    const cookie = await studioCookie(running.base);
    await setOption(running.base, cookie, { "panel.proxy_http": true, "panel.separate_origin": true });
    await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1", { address: "127.0.0.1", scheme: "http", port: node.port });
    const { url, origin } = (await (await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST")).json()) as { url: string; origin: string };
    const panelCookie = (await fetch(url, { redirect: "manual" })).headers.getSetCookie()[0]!.split(";")[0]!;
    const waiting = (await (await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST")).json()) as { url: string };
    assert.equal((await fetch(`${origin}/panel/radar-1/`, { headers: { Cookie: panelCookie } })).status, 200);

    await setOption(running.base, cookie, { "panel.separate_origin": false });
    // before the listener is closed the origin already answers nothing
    const refused = await fetch(`${origin}/panel/radar-1/`, { headers: { Cookie: panelCookie } }).catch(() => undefined);
    assert.ok(refused === undefined || refused.status === 404, "closed or answering 404");
    await running.app.panelOrigin.sync();
    assert.equal(running.app.panelOrigin.port(), undefined, "the listener is closed");
    assert.equal((await fetch(`${running.base}/api/v1/nodes/radar-1/panel/`, { headers: { Cookie: cookie } })).status, 200, "the API serves the panel again, as before");

    await setOption(running.base, cookie, { "panel.separate_origin": true });
    const fresh = (await (await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST")).json()) as { origin: string };
    assert.equal((await fetch(`${fresh.origin}/panel/radar-1/`, { headers: { Cookie: panelCookie } })).status, 401, "the old panel session is gone");
    assert.equal((await fetch(waiting.url, { redirect: "manual" })).status, 403, "so is the ticket that was waiting");
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await node.close(); }
});

test("a panel that is changed or removed ends what was open on it, and an unknown or http-less one gets no ticket", async () => {
  const node = await fakeNode();
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const running = await startServer({ ARMOR_PANEL_PORT: String(await freePort()) });
  try {
    const cookie = await studioCookie(running.base);
    await setOption(running.base, cookie, { "panel.proxy_http": true, "panel.separate_origin": true });
    assert.equal((await put(running.base, cookie, "/api/v1/admin/node-panels/unknown/ticket", {}, "POST")).status, 404);
    assert.equal((await put(running.base, cookie, "/api/v1/admin/node-panels/Bad%20Id/ticket", {}, "POST")).status, 404);
    await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1", { address: "127.0.0.1", scheme: "http", port: node.port });
    const { url, origin } = (await (await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST")).json()) as { url: string; origin: string };
    const panelCookie = (await fetch(url, { redirect: "manual" })).headers.getSetCookie()[0]!.split(";")[0]!;
    assert.equal((await fetch(`${origin}/panel/radar-1/`, { headers: { Cookie: panelCookie } })).status, 200);
    await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1", { address: "127.0.0.1", scheme: "http", port: node.port, label: "Other" });
    assert.equal((await fetch(`${origin}/panel/radar-1/`, { headers: { Cookie: panelCookie } })).status, 401, "changed: opened again");
    // plain http panels need panel.proxy_http, ticket or not
    await setOption(running.base, cookie, { "panel.proxy_http": false });
    const noHttp = await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST");
    assert.deepEqual([noHttp.status, ((await noHttp.json()) as { code: string }).code], [403, "panel_http_disabled"]);
    await setOption(running.base, cookie, { "panel.proxy_http": true });
    const second = (await (await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST")).json()) as { url: string };
    const secondCookie = (await fetch(second.url, { redirect: "manual" })).headers.getSetCookie()[0]!.split(";")[0]!;
    assert.equal((await fetch(`${running.base}/api/v1/admin/node-panels/radar-1`, { method: "DELETE", headers: { Cookie: cookie } })).status, 204);
    assert.equal((await fetch(`${origin}/panel/radar-1/`, { headers: { Cookie: secondCookie } })).status, 401, "removed: closed");
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await node.close(); }
});

test("from outside the house the ticket asks for a new proof, and what changes the node stays in the house", async () => {
  const node = await fakeNode();
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "armor-test-"));
  fs.writeFileSync(path.join(dataDir, "node_panels.json"), JSON.stringify({ schema: 1, panels: [{ id: "radar-1", address: "127.0.0.1", scheme: "http", port: node.port }] }));
  fs.writeFileSync(path.join(dataDir, "security-settings.json"), JSON.stringify({ schema: 1, settings: { "panel.proxy_http": true, "panel.separate_origin": true } }));
  const running = await startServer({ ARMOR_DATA_DIR: dataDir, ARMOR_PANEL_PORT: String(await freePort()), ARMOR_LOCAL_NETWORKS: "10.99.0.0/16", ARMOR_REMOTE_POLICY: "operate" });   // the test client is then "outside"
  try {
    await running.app.panelOrigin.sync();
    assert.ok(running.app.panelOrigin.port(), "an installation that had the option on opens the second origin when it starts");
    const cookie = await studioCookie(running.base);
    const refused = await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST");
    assert.deepEqual([refused.status, ((await refused.json()) as { code: string }).code], [403, "elevation_required"]);
    assert.equal((await put(running.base, cookie, "/api/v1/studio/elevate", { password: SECRETS.ARMOR_STUDIO_PASSWORD }, "POST")).status, 200);
    const { url, origin } = (await (await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST")).json()) as { url: string; origin: string };
    const panelCookie = (await fetch(url, { redirect: "manual" })).headers.getSetCookie()[0]!.split(";")[0]!;
    assert.equal((await fetch(`${origin}/panel/radar-1/`, { headers: { Cookie: panelCookie } })).status, 200);
    // the same limits as through the API: a session from outside may look, not change the node
    const exported = await fetch(`${origin}/panel/radar-1/api/v1/config/export`, { headers: { Cookie: panelCookie } });
    assert.deepEqual([exported.status, ((await exported.json()) as { code: string }).code], [403, "remote_policy"]);
    for (const route of ["api/v1/ota", "api/v1/reboot", "api/v1/log"]) assert.equal((await fetch(`${origin}/panel/radar-1/${route}`, { method: "POST", headers: { ...json, Cookie: panelCookie }, body: "{}" })).status, 403, route);
    assert.equal(node.seen.filter(item => item.line !== "GET /").length, 0, "none of it reached the node");
    assert.match(fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8"), /node-panel\.blocked/);
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await node.close(); }
});

test("a viewer or an operator gets no ticket", async () => {
  const running = await startServer({ ARMOR_PANEL_PORT: String(await freePort()) });
  try {
    const cookie = await studioCookie(running.base);
    await setOption(running.base, cookie, { "panel.separate_origin": true });
    assert.equal((await put(running.base, cookie, "/api/v1/users", { username: "visitor", password: "a-long-password-1", role: "viewer" }, "POST")).status, 201);
    const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "visitor", password: "a-long-password-1" }) });
    const viewer = (login.headers.getSetCookie()[0] ?? "").split(";")[0]!;
    assert.equal((await put(running.base, viewer, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST")).status, 403);
    assert.equal((await fetch(`${running.base}/api/v1/admin/node-panels/radar-1/ticket`, { method: "POST", headers: { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` } })).status >= 400, true);
  } finally { await running.stop(); }
});

test("when the port of the second origin is taken the ticket is refused with 503 and nothing else breaks", async () => {
  const blocker = net.createServer();
  await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const taken = (blocker.address() as net.AddressInfo).port;
  const node = await fakeNode();
  process.env.ARMOR_ADMIN_NODE_PORT = String(node.port);
  const running = await startServer({ ARMOR_PANEL_PORT: String(taken), ARMOR_HOST: "127.0.0.1" });
  try {
    const cookie = await studioCookie(running.base);
    await setOption(running.base, cookie, { "panel.proxy_http": true, "panel.separate_origin": true });
    await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1", { address: "127.0.0.1", scheme: "http", port: node.port });
    const refused = await put(running.base, cookie, "/api/v1/admin/node-panels/radar-1/ticket", {}, "POST");
    assert.deepEqual([refused.status, ((await refused.json()) as { code: string }).code], [503, "panel_origin_unavailable"]);
    assert.equal(running.app.panelOrigin.port(), undefined);
    assert.equal((await fetch(`${running.base}/api/v1/admin/node-panels`, { headers: { Cookie: cookie } })).status, 200, "the API goes on");
  } finally { delete process.env.ARMOR_ADMIN_NODE_PORT; await running.stop(); await node.close(); await new Promise<void>(resolve => blocker.close(() => resolve())); }
});
