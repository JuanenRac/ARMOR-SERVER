import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { agentFamily, ClientRegistry, clientIdOf, identify, NodeLife, systemBody, systemFromAudit, type SystemInput } from "../src/connections.js";
import { redactEvent, type ArmorEvent } from "../src/events.js";
import { SessionStore } from "../src/http/auth.js";
import { SECRETS, startServer, studioCookie, tempDir } from "./helpers.js";

const json = { "Content-Type": "application/json" };
type Row = Record<string, unknown>;
const history = async (base: string, headers: Record<string, string>, query = ""): Promise<Row[]> =>
  ((await (await fetch(`${base}/api/v1/history?limit=200${query}`, { headers })).json()) as { events: Row[] }).events;

async function login(base: string, username: string, password: string, extra: Record<string, string> = {}): Promise<string> {
  const response = await fetch(`${base}/api/v1/studio/session`, { method: "POST", headers: { ...json, ...extra }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 201);
  return (response.headers.getSetCookie()[0] ?? "").split(";")[0];
}

// ---- the clients -------------------------------------------------------------------------------------------------------------------

test("a client says what it is, or its user agent shows it", () => {
  const request = (headers: Record<string, string>) => ({ header: (name: string) => headers[name.toLowerCase()] });
  assert.deepEqual(identify(request({ "x-armor-client": "android/0.6.6", "user-agent": "okhttp/4.12" })), { kind: "android", version: "0.6.6", agent: "okhttp/4.12" });
  assert.equal(identify(request({ "x-armor-client": "studio/0.8.0.3" })).kind, "studio");
  assert.equal(identify(request({ "user-agent": "ARMOR-ANDROID-CONTROL/0.5.3" })).version, "0.5.3");
  assert.equal(identify(request({ "user-agent": "Dalvik/2.1.0 (Linux; U; Android 14)" })).kind, "android");
  assert.equal(identify(request({ "user-agent": "curl/8.5.0" })).kind, "other");
  assert.equal(identify(request({ "x-armor-client": "toaster/1" })).kind, "other", "a name outside the list is not believed");
  assert.equal(identify(request({ "x-armor-client": "android/1 2" })).kind, "other", "a version with a space is not a version");
});

test("one browser is one client, whatever its version", () => {
  const chrome = (version: string) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  assert.equal(agentFamily(chrome("120.0.0.0")), agentFamily(chrome("131.0.0.0")));
  assert.notEqual(agentFamily(chrome("120.0.0.0")), agentFamily("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0"));
  const a = clientIdOf({ kind: "studio", user: "Ana", agent: chrome("120.0.0.0") }), b = clientIdOf({ kind: "studio", user: "ana", agent: chrome("131.0.0.0") });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, clientIdOf({ kind: "android", user: "ana", agent: chrome("131.0.0.0") }));
});

test("the registry is bounded, kept in a file, and shows addresses to administrators only", () => {
  const dir = tempDir(), file = path.join(dir, "connections.json");
  let now = Date.parse("2026-03-01T10:00:00Z");
  const registry = new ClientRegistry({ file, now: () => now, capacity: 3 });
  for (const user of ["a", "b", "c", "d"]) { registry.touch({ kind: "studio", user, ip: "192.168.0.9", agent: "Mozilla/5.0 Chrome/1 Safari/1" }, { ok: true }); now += 1000; }
  const all = registry.list(() => 0, true);
  assert.equal(all.length, 3, "the least recently seen client went");
  assert.deepEqual(all.map(client => client.user), ["d", "c", "b"]);
  assert.equal(all[0].ip, "192.168.0.9");
  assert.equal(registry.list(() => 0, false)[0].ip, undefined);
  assert.equal(registry.list(() => 0, false)[0].agent, undefined);
  assert.equal(registry.list(() => 2, false, { active: true }).length, 3);
  assert.equal(registry.list(() => 0, false, { active: true }).length, 0);
  registry.flush();
  const again = new ClientRegistry({ file, now: () => now, capacity: 3 });
  assert.deepEqual(again.list(() => 0, true).map(client => client.user), ["d", "c", "b"]);
  now += 130 * 86_400_000;
  assert.equal(new ClientRegistry({ file, now: () => now }).list(() => 0, true).length, 0, "a client not seen for months is forgotten");
});

// ---- the events of the system ------------------------------------------------------------------------------------------------------------

test("a node appears once, comes back, changes firmware and disappears, and a restart does not make it appear again", () => {
  const dir = tempDir(), file = path.join(dir, "node-life.json");
  const seen: SystemInput[] = [];
  let life = new NodeLife(file, input => seen.push(input));
  life.report("alarm-1", "0.3.6");
  life.report("alarm-1", "0.3.6");
  life.gone("alarm-1");
  life.gone("alarm-1");
  life.report("alarm-1", "0.3.7");
  assert.deepEqual(seen.map(item => item.action), ["appeared", "disappeared", "returned", "firmware_changed"]);
  assert.equal(seen[3].previous_version, "0.3.6");
  life.flush();
  seen.length = 0;
  life = new NodeLife(file, input => seen.push(input));
  life.report("alarm-1", "0.3.7");
  assert.deepEqual(seen, [], "a node that was already there is not news");
  life.report("my node", "1.0.0");
  assert.deepEqual(seen, [], "an id that is not an id is not written");
});

test("the audit trail reaches the history in a fixed vocabulary, without its free text", () => {
  assert.deepEqual(systemFromAudit({ action: "control.arm", outcome: "allowed", actor: "ana" }), { category: "alarm", action: "armed", by: "ana" });
  assert.equal(systemFromAudit({ action: "control.disarm", outcome: "allowed", actor: "ana", detail: "duress" }), undefined, "a duress disarm is never written");
  assert.equal(systemFromAudit({ action: "control.disarm", outcome: "allowed", actor: "ana", detail: "voice, duress" }), undefined);
  assert.deepEqual(systemFromAudit({ action: "alarm.command", outcome: "allowed", actor: "ana", target: "alarm-1", detail: "arm away profile night: sent 0123abcd" }),
    { category: "alarm", action: "arm_requested", by: "ana", subject: "alarm-1", profile: "night" });
  assert.equal(systemFromAudit({ action: "alarm.command", outcome: "denied", actor: "ana", target: "alarm-1", detail: "arm away: busy" }), undefined);
  assert.deepEqual(systemFromAudit({ action: "alarm.command", outcome: "allowed", actor: "ana", target: "alarm-1", detail: "silence: sent 0123abcd" }), { category: "alarm", action: "silence_requested", by: "ana", subject: "alarm-1", profile: undefined });
  assert.deepEqual(systemFromAudit({ action: "admin.service", outcome: "allowed", actor: "ana", target: "armor-server", detail: "restart" }), { category: "service", action: "restarted", by: "ana", subject: "armor-server", outcome: "allowed" });
  assert.deepEqual(systemFromAudit({ action: "rules.update", outcome: "allowed", actor: "ana", detail: "3 zones, dwell 5000 ms" }), { category: "settings", action: "changed", by: "ana", subject: "rules", outcome: "allowed" });
  assert.equal(systemFromAudit({ action: "studio.login", outcome: "allowed", actor: "ana" }), undefined, "the sign-ins are connection events, not system events");
  // the detail is never copied
  const mapped = systemFromAudit({ action: "admin.mqtt.add", outcome: "allowed", actor: "ana", target: "node-1", detail: "password=hunter2 token=abc" });
  assert.ok(!JSON.stringify(mapped).includes("hunter2") && !JSON.stringify(mapped).includes("token"));
});

test("a system event never carries a field that does not look like what it should", () => {
  const body = systemBody({ category: "settings", action: "changed", subject: "password=hunter2 secret", by: "ana smith; DROP", version: "latest", profile: "Night", previous_version: "1.0" });
  assert.deepEqual(body, { type: "system", category: "settings", action: "changed" });
  assert.deepEqual(systemBody({ category: "node", action: "appeared", subject: "alarm-1", by: "ana", version: "0.3.7" }), { type: "system", category: "node", action: "appeared", subject: "alarm-1", by: "ana", version: "0.3.7" });
});

test("only an administrator reads the address and the user agent of a connection", () => {
  const event = { id: 1, at: "2026-03-01T10:00:00.000Z", type: "connection", action: "login", client_kind: "studio", client_id: "0123456789abcdef", user: "ana", ip: "10.0.0.5", agent: "Mozilla/5.0" } as ArmorEvent;
  assert.equal((redactEvent(event, true) as Row).ip, "10.0.0.5");
  const other = redactEvent(event, false) as Row;
  assert.equal(other.ip, undefined);
  assert.equal(other.agent, undefined);
  assert.equal(other.user, "ana");
  assert.equal((event as Row).ip, "10.0.0.5", "the stored event is not touched");
});

test("a session that runs out or is ended is told", () => {
  let now = 1_000_000;
  const told: string[] = [];
  const store = new SessionStore({ cookieName: "s", cookiePath: "/", ttlMs: 60_000, secure: false, onEnd: (info, reason) => told.push(`${reason}:${info.userId}:${info.agent}`) }, () => now);
  const response = { cookie() { /* no cookie jar in a test */ } } as unknown as Parameters<SessionStore["open"]>[0];
  store.open(response, "u1", { agent: "agent-a", ip: "10.0.0.1", origin: "local" });
  store.open(response, "u2", { agent: "agent-b" });
  assert.equal(store.openFor("u1", agent => agent === "agent-a"), 1);
  now += 61_000;
  store.sweep();
  assert.deepEqual(told.sort(), ["expired:u1:agent-a", "expired:u2:agent-b"]);
  assert.equal(store.openFor("u1", () => true), 0);
});

// ---- through the server ------------------------------------------------------------------------------------------------------------------

test("signing in, failing, signing out and the list of clients are in the history, and the secrets are nowhere", async () => {
  const running = await startServer();
  try {
    const cookie = await login(running.base, SECRETS.ARMOR_STUDIO_USERNAME, SECRETS.ARMOR_STUDIO_PASSWORD, { "X-Armor-Client": "studio/0.8.0.3", "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36" });
    const admin = { ...json, cookie };
    // a refused sign-in with the name of a real account, and one where somebody typed their password in the user box
    await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "admin", password: "wrong-password-1" }) });
    await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "my-secret-pass-123", password: "x" }) });

    assert.equal((await history(running.base, admin)).some(event => event.type === "connection"), false, "a client that only knows the older events does not meet the new ones");
    const connections = await history(running.base, admin, "&type=connection");
    const login1 = connections.find(event => event.action === "login")!;
    assert.equal(login1.client_kind, "studio");
    assert.equal(login1.app_version, "0.8.0.3");
    assert.equal(login1.user, "admin");
    assert.ok(typeof login1.ip === "string" && typeof login1.agent === "string", "the administrator sees the address and the agent");
    const failures = connections.filter(event => event.action === "login_failed");
    assert.equal(failures.length, 2);
    assert.ok(failures.some(event => event.user === "admin"));
    assert.ok(failures.some(event => event.user === undefined), "what was typed in the user box of a stranger is not kept");
    const everything = JSON.stringify(connections) + fs.readFileSync(path.join(running.config.dataDir, "events.log"), "utf8") + fs.readFileSync(path.join(running.config.dataDir, "connections.json"), "utf8");
    for (const secret of ["my-secret-pass-123", "wrong-password-1", SECRETS.ARMOR_STUDIO_PASSWORD, SECRETS.ARMOR_CONTROL_TOKEN, SECRETS.ARMOR_OPERATOR_TOKEN, cookie.split("=")[1]]) assert.ok(!everything.includes(secret), `${secret.slice(0, 6)} must not be in the history`);

    // filters
    assert.equal((await history(running.base, admin, "&kind=android")).length, 0);
    assert.ok((await history(running.base, admin, "&kind=studio")).length >= 1);
    assert.ok((await history(running.base, admin, "&user=admin")).length >= 1);
    assert.equal((await history(running.base, admin, "&all=1")).some(event => event.type === "connection"), true);

    // a viewer sees the connections without the addresses or the agents of anybody
    await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "family", password: "family-password-1", role: "viewer" }) });
    const viewerCookie = await login(running.base, "family", "family-password-1", { "X-Armor-Client": "android/0.6.6", "User-Agent": "okhttp/4.12.0" });
    const viewer = { ...json, cookie: viewerCookie };
    const seenByViewer = await history(running.base, viewer, "&type=connection");
    assert.ok(seenByViewer.length >= 2);
    for (const event of seenByViewer) { assert.equal(event.ip, undefined); assert.equal(event.agent, undefined); }
    const list = ((await (await fetch(`${running.base}/api/v1/history/connections`, { headers: viewer })).json()) as { clients: Row[] }).clients;
    assert.ok(list.some(client => client.kind === "android" && client.user === "family" && client.app_version === "0.6.6" && client.active_sessions === 1));
    for (const client of list) { assert.equal(client.ip, undefined); assert.equal(client.agent, undefined); }
    const full = ((await (await fetch(`${running.base}/api/v1/history/connections?kind=studio`, { headers: admin })).json()) as { clients: Row[] }).clients;
    assert.equal(full.length, 1);
    assert.equal(typeof full[0].ip, "string");
    assert.equal((await fetch(`${running.base}/api/v1/history/connections?kind=toaster`, { headers: admin })).status, 400);
    assert.equal((await fetch(`${running.base}/api/v1/history?type=nonsense`, { headers: admin })).status, 400);

    // signing out is a line
    await fetch(`${running.base}/api/v1/studio/session`, { method: "DELETE", headers: viewer });
    const after = await history(running.base, admin, "&type=connection&user=family");
    assert.ok(after.some(event => event.action === "logout"));
  } finally { await running.stop(); }
});

test("a service with the operator token is a client of its own and is seen once", async () => {
  const running = await startServer();
  try {
    const headers = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}`, "User-Agent": "armor-aux/0.2.1" };
    for (let i = 0; i < 3; i += 1) await fetch(`${running.base}/api/v1/alarms`, { headers });
    const admin = { cookie: await studioCookie(running.base) };
    const first = (await history(running.base, admin, "&type=connection")).filter(event => event.action === "first_seen");
    assert.equal(first.length, 1);
    assert.equal(first[0].client_kind, "other");
    // a request that is not signed in leaves nothing
    await fetch(`${running.base}/api/v1/alarms`, { headers: { "User-Agent": "scanner/1.0" } });
    const list = ((await (await fetch(`${running.base}/api/v1/history/connections`, { headers: admin })).json()) as { clients: Row[] }).clients;
    assert.ok(!list.some(client => String(client.agent ?? "").includes("scanner")));
  } finally { await running.stop(); }
});

test("settings, arming and a duress disarm in the history", async () => {
  const running = await startServer();
  try {
    const admin = { ...json, cookie: await studioCookie(running.base) };
    const rules = (await (await fetch(`${running.base}/api/v1/rules`, { headers: admin })).json()) as Row;
    assert.equal((await fetch(`${running.base}/api/v1/rules`, { method: "PUT", headers: admin, body: JSON.stringify(rules) })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/mode`, { method: "POST", headers: admin, body: JSON.stringify({ mode: "armed" }) })).status, 200);
    const system = await history(running.base, admin, "&type=system");
    assert.ok(system.some(event => event.category === "settings" && event.subject === "rules"));
    assert.ok(system.some(event => event.category === "alarm" && event.action === "armed" && event.by === "admin"));
    assert.deepEqual((await history(running.base, admin, "&category=alarm")).map(event => event.category), ["alarm"]);
    assert.equal((await history(running.base, admin, "&category=settings")).every(event => event.type === "system"), true);
    assert.equal((await fetch(`${running.base}/api/v1/history?category=weather`, { headers: admin })).status, 400);
    // the values of the settings are not in the history
    assert.ok(!JSON.stringify(system).includes("dwell"));
    // history pages
    const page = (await (await fetch(`${running.base}/api/v1/history?type=system&limit=1`, { headers: admin })).json()) as { events: Row[]; next_before: number };
    assert.equal(page.events.length, 1);
    const older = (await (await fetch(`${running.base}/api/v1/history?type=system&limit=5&before=${page.next_before}`, { headers: admin })).json()) as { events: Row[] };
    assert.ok(older.events.every(event => Number(event.id) < page.next_before));
  } finally { await running.stop(); }
});
