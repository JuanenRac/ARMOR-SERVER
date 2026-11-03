// The panic phrase on the spoken turn of the wall panel: the voice gateway transcribes and, before it interprets the order, asks this route whether the words are somebody's panic phrase.
// The answer is always the same; a match only raises the silent alarm (option on, once per quiet time) and the trail never holds the words.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

const json = { "Content-Type": "application/json" };
const PHRASE = "The blue heron flies at midnight!";
const check = (running: Running, text: unknown, token: string | undefined = SECRETS.ARMOR_OPERATOR_TOKEN, panel?: string) =>
  fetch(`${running.base}/api/v1/voice/panic-check`, { method: "POST", headers: { ...json, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(panel ? { "X-Armor-Panel": panel } : {}) }, body: JSON.stringify({ text }) })
    .then(async reply => ({ status: reply.status, body: await reply.json().catch(() => ({})) as Record<string, unknown> }));
const raised = new WeakMap<object, number>();
const watch = (running: Running) => { const centre = running.app.context.alarms, original = centre.raiseDuress.bind(centre); centre.raiseDuress = who => { raised.set(centre, (raised.get(centre) ?? 0) + 1); return original(who); }; };
const duress = (running: Running) => raised.get(running.app.context.alarms) ?? 0;
const withPhrase = async (running: Running, on: boolean) => {
  const cookie = await studioCookie(running.base);
  const put = (url: string, body: unknown) => fetch(`${running.base}${url}`, { method: "PUT", headers: { ...json, Cookie: cookie }, body: JSON.stringify(body) });
  assert.equal((await put("/api/v1/account/panic-phrase", { currentPassword: running.config.studioPassword, phrase: PHRASE })).status, 200);
  if (on) assert.equal((await put("/api/v1/security/settings", { "voice.panic_phrase": true })).status, 200);
  return cookie;
};

test("a match raises the silent alarm once per quiet time and the answer is the same as for any other words", async () => {
  const running = await startServer();
  try {
    watch(running);
    await withPhrase(running, true);
    const mode = running.app.context.store.snapshot().mode;
    const miss = await check(running, "open the garage door please");
    assert.equal((await check(running, PHRASE, "")).status, 401, "no token, no answer");
    const first = await check(running, "  THE BLUE HERON, flies at midnight  ", SECRETS.ARMOR_OPERATOR_TOKEN, "wall-1");
    const again = await check(running, PHRASE);
    assert.deepEqual([miss.status, miss.body], [first.status, first.body]);
    assert.deepEqual(again.body, miss.body);
    assert.deepEqual(miss.body, { ok: true });
    assert.equal(duress(running), 1, "the second time inside the quiet time raises nothing");
    assert.equal(running.app.context.store.snapshot().mode, mode, "the mode is not touched");
    const trail = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(trail, /"action":"voice\.panic","outcome":"allowed"[^\n]*via wall-1/);
    assert.match(trail, /"action":"voice\.panic","outcome":"denied"/);
    assert.doesNotMatch(trail, /heron/i);
  } finally { await running.stop(); }
});

test("switched off, nothing is looked for and the answer is the same", async () => {
  const running = await startServer();
  try {
    watch(running);
    await withPhrase(running, false);
    assert.deepEqual((await check(running, PHRASE)).body, { ok: true });
    assert.equal(duress(running), 0);
  } finally { await running.stop(); }
});

test("a wrong token, a person's session and a bad text are refused; the phrase is not a way to guess who has one", async () => {
  const running = await startServer();
  try {
    watch(running);
    const cookie = await withPhrase(running, true);
    assert.equal((await check(running, PHRASE, "x".repeat(32))).status, 401);
    const session = await fetch(`${running.base}/api/v1/voice/panic-check`, { method: "POST", headers: { ...json, Cookie: cookie, "X-Requested-With": "armor" }, body: JSON.stringify({ text: PHRASE }) });
    assert.ok([401, 403].includes(session.status), `a session is not the gateway (${session.status})`);
    assert.equal((await check(running, "")).status, 422);
    assert.equal((await check(running, 42)).status, 422);
    assert.equal((await check(running, "a ".repeat(200))).status, 422);
    assert.equal(duress(running), 0);
  } finally { await running.stop(); }
});
