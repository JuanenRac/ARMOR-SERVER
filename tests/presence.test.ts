// The presence by person: only the word home or away, off by default (404), a word that grows old is not counted, and the automations with a presence trigger follow the sum.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AutomationEngine, AutomationError } from "../src/automations.js";
import { PRESENCE_FRESH_MS, PresenceStore } from "../src/presence.js";
import { SECURITY_DEFAULTS, lowers } from "../src/security_settings.js";
import { startServer, studioCookie, tempDir, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const call = (running: Running, method: string, route: string, cookie: string, body?: unknown) => fetch(`${running.base}${route}`, { method, headers: { ...json, Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  .then(async reply => ({ status: reply.status, body: await reply.json().catch(() => ({})) as Record<string, unknown> }));
const setting = (running: Running, cookie: string, change: Record<string, unknown>) => call(running, "PUT", "/api/v1/security/settings", cookie, change);

test("the option is off by default and turning it on is not a loss of protection", () => {
  assert.equal(SECURITY_DEFAULTS["presence.by_user"], false);
  assert.equal(lowers("presence.by_user", false, true), false);
  assert.equal(lowers("presence.by_user", true, false), false);
});

test("the sum is unknown with no word, home when one person is home, away when all fresh words are away", () => {
  let now = 1_000_000;
  const store = new PresenceStore(path.join(tempDir(), "presence.json"), () => now);
  assert.equal(store.sum(), "unknown");
  assert.deepEqual(store.set("ana", "away"), { before: "unknown", after: "everyone_away" });
  assert.deepEqual(store.set("luis", "home"), { before: "everyone_away", after: "someone_home" });
  assert.deepEqual(store.set("luis", "away"), { before: "someone_home", after: "everyone_away" });
  assert.deepEqual(store.set("luis", "away"), { before: "everyone_away", after: "everyone_away" }, "the same word again is no change");
  now += 1000;
  assert.equal(store.mine("ana").state, "away");
});

test("a word older than a day is not counted, and a person who is deleted leaves none", () => {
  let now = 5_000_000;
  const store = new PresenceStore(path.join(tempDir(), "presence.json"), () => now);
  store.set("ana", "home");
  store.set("luis", "away");
  now += PRESENCE_FRESH_MS - 1;
  assert.equal(store.sum(), "someone_home");
  now += 2;
  assert.equal(store.sum(), "unknown", "both words are a day old");
  assert.deepEqual(store.mine("ana"), { state: null, since: null });
  store.set("luis", "away");
  store.remove("ana");
  assert.deepEqual(store.summary(id => (id === "luis" ? "Luis" : undefined)).people.map(person => person.user), ["Luis"]);
  assert.equal(store.summary(() => undefined).people.length, 0, "a person who no longer exists is left out");
});

test("the words survive a restart in a file only the server can read, and hold nothing but the word and the moment", () => {
  const file = path.join(tempDir(), "presence.json");
  new PresenceStore(file).set("ana", "home");
  const again = new PresenceStore(file);
  assert.equal(again.mine("ana").state, "home");
  const text = fs.readFileSync(file, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(text).users.ana).sort(), ["at", "state"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
});

test("a damaged file is ignored", () => {
  const file = path.join(tempDir(), "presence.json");
  fs.writeFileSync(file, "{ not json");
  assert.equal(new PresenceStore(file).sum(), "unknown");
  fs.writeFileSync(file, JSON.stringify({ schema: 1, users: { a: { state: "somewhere", at: 1 }, b: { state: "home", at: "x" } } }));
  assert.equal(new PresenceStore(file).sum(), "unknown");
});

test("an automation with a presence trigger runs only when the sum becomes the one it waits for", async () => {
  const ran: string[] = [];
  const engine = new AutomationEngine({ file: path.join(tempDir(), "automations.json"), mode: () => "disarmed", run: async (_action, automation) => { ran.push(automation.id); } });
  engine.create({ id: "left", name: "all left", trigger: { type: "presence", state: "everyone_away" }, actions: [{ type: "notify" }] } as never);
  engine.create({ id: "back", name: "someone back", trigger: { type: "presence", state: "someone_home" }, actions: [{ type: "notify" }] } as never);
  engine.handlePresence("everyone_away");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ran, ["left"]);
  engine.handlePresence("someone_home");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ran, ["left", "back"]);
  assert.throws(() => engine.create({ name: "bad", trigger: { type: "presence", state: "nobody" }, actions: [{ type: "notify" }] } as never), (error: unknown) => error instanceof AutomationError && error.code === "invalid_trigger");
  engine.close();
});

test("while the option is off every route answers 404 and nothing is kept", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running, "PUT", "/api/v1/presence/me", cookie, { state: "away" })).status, 404);
    assert.equal((await call(running, "GET", "/api/v1/presence/me", cookie)).status, 404);
    assert.equal((await call(running, "GET", "/api/v1/presence", cookie)).status, 404);
    assert.equal(running.app.context.presence.sum(), "unknown");
  } finally { await running.stop(); }
});

test("on, the phone tells the word, the administrator reads the sum, the audit trail has the fact and the trigger runs once", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await setting(running, cookie, { "presence.by_user": true })).status, 200);
    const fired: string[] = [];
    const engine = running.app.context.automations, original = engine.handlePresence.bind(engine);
    engine.handlePresence = state => { fired.push(state); original(state); };
    assert.deepEqual((await call(running, "GET", "/api/v1/presence/me", cookie)).body, { state: null, since: null });
    const bad = await call(running, "PUT", "/api/v1/presence/me", cookie, { state: "at the gym" });
    assert.deepEqual({ status: bad.status, code: bad.body.code }, { status: 400, code: "invalid_state" });
    const away = await call(running, "PUT", "/api/v1/presence/me", cookie, { state: "away" });
    assert.equal(away.status, 200);
    assert.equal(away.body.state, "away");
    await call(running, "PUT", "/api/v1/presence/me", cookie, { state: "away" });
    assert.deepEqual(fired, ["everyone_away"], "the same word again changes nothing");
    await call(running, "PUT", "/api/v1/presence/me", cookie, { state: "home" });
    assert.deepEqual(fired, ["everyone_away", "someone_home"]);
    const summary = await call(running, "GET", "/api/v1/presence", cookie);
    assert.equal(summary.body.state, "someone_home");
    assert.deepEqual((summary.body.people as Array<{ user: string; state: string }>).map(person => [person.user, person.state]), [["admin", "home"]]);
  } finally { await running.stop(); }
});

test("a body with anything but the word is not stored beyond the word", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    await setting(running, cookie, { "presence.by_user": true });
    await call(running, "PUT", "/api/v1/presence/me", cookie, { state: "away", latitude: 38.1, longitude: -1.2 });
    const text = fs.readFileSync(path.join(running.config.dataDir, "presence.json"), "utf8");
    assert.doesNotMatch(text, /latitude|longitude|38\.1/);
  } finally { await running.stop(); }
});
