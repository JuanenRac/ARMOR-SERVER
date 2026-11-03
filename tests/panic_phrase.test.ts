// The silent panic phrase: off by default, valid only when it is long enough and not an example or a plain command, recognised through the written command route, silent, rate limited,
// never reaching the voice gateway and never written to the trail.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { normalisePhrase, phraseProblem, PANIC_EXAMPLE_PHRASES } from "../src/panic_phrase.js";
import { SECURITY_DEFAULTS } from "../src/security_settings.js";
import { startServer, studioCookie, type Running } from "./helpers.js";

const TOKEN = "v".repeat(32);
const json = { "Content-Type": "application/json" };
const PHRASE = "The blue heron flies at midnight!";

async function gateway() {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      seen.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text: string }).text);
      response.writeHead(200, json);
      response.end(JSON.stringify({ accepted: false, requires_confirmation: false, intent: null, outcome: "not-understood", speech: "Command not recognised" }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const call = async (running: Running, cookie: string, method: string, url: string, body?: unknown) => {
  const reply = await fetch(`${running.base}${url}`, { method, headers: { ...json, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: reply.status, body: await reply.json().catch(() => ({})) as Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
};
/** How many times the silent duress alarm was raised (an event is born ended and unread, so it is counted at the call). */
const raised = new WeakMap<object, number>();
const watch = (running: Running) => { const centre = running.app.context.alarms, original = centre.raiseDuress.bind(centre); centre.raiseDuress = who => { raised.set(centre, (raised.get(centre) ?? 0) + 1); return original(who); }; };
const duressAlarms = (running: Running) => raised.get(running.app.context.alarms) ?? 0;
const setPhrase = (running: Running, cookie: string, phrase: unknown) => call(running, cookie, "PUT", "/api/v1/account/panic-phrase", { currentPassword: running.config.studioPassword, phrase });

test("it is off by default, with a quiet time of a minute", () => {
  assert.equal(SECURITY_DEFAULTS["voice.panic_phrase"], false);
  assert.equal(SECURITY_DEFAULTS["voice.panic_cooldown_s"], 60);
});

test("the rules of a phrase: enough words, no example, no plain command, normalised the same in every language", () => {
  assert.equal(phraseProblem(PHRASE), undefined);
  assert.equal(phraseProblem("auxilio ahora"), "phrase_too_short");
  assert.equal(phraseProblem(""), "phrase_too_short");
  assert.equal(phraseProblem(42), "invalid_phrase");
  assert.equal(phraseProblem("a ".repeat(100)), "phrase_too_long");
  assert.equal(phraseProblem("disarm the system please"), "phrase_too_common");
  assert.equal(phraseProblem("supercalifragilisticoespialidoso"), "phrase_too_short", "one long word is one word");
  assert.equal(phraseProblem("青い鷺は夜中に飛ぶ"), undefined, "a script without spaces counts characters");
  assert.equal(phraseProblem("青い鷺"), "phrase_too_short");
  for (const example of PANIC_EXAMPLE_PHRASES) assert.equal(phraseProblem(example.toUpperCase() + "!"), "phrase_is_example", example);
  assert.equal(normalisePhrase("  The  BLUE, heron…  "), "the blue heron");
});

test("switched off (the default) the phrase is just another command and reaches the gateway", async () => {
  const fake = await gateway();
  const running = await startServer({ ARMOR_VOICE_URL: fake.url, ARMOR_VOICE_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await setPhrase(running, cookie, PHRASE)).body.hasPanicPhrase, true);
    const said = await call(running, cookie, "POST", "/api/v1/voice/command", { text: PHRASE, language: "en" });
    assert.equal(said.body.outcome, "not-understood");
    assert.deepEqual(fake.seen, [PHRASE]);
    assert.equal(duressAlarms(running), 0);
  } finally { await running.stop(); await fake.close(); }
});

test("switched on, the phrase raises the silent alarm once per quiet time, looks like a command not understood, never reaches the gateway and is not in the trail", async () => {
  const fake = await gateway();
  const running = await startServer({ ARMOR_VOICE_URL: fake.url, ARMOR_VOICE_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    watch(running);
    await setPhrase(running, cookie, PHRASE);
    assert.equal((await call(running, cookie, "PUT", "/api/v1/security/settings", { "voice.panic_phrase": true })).status, 200);
    const modeBefore = running.app.context.store.snapshot().mode;
    for (const text of ["the blue heron flies at midnight", "  THE BLUE HERON, flies at midnight  "]) {
      const said = await call(running, cookie, "POST", "/api/v1/voice/command", { text, language: "pt" });
      assert.deepEqual(said.body, { accepted: false, executed: false, intent: null, outcome: "", speech: "" });
    }
    assert.equal(duressAlarms(running), 1, "the second time inside the quiet time raises nothing");
    assert.equal(running.app.context.store.snapshot().mode, modeBefore);
    assert.deepEqual(fake.seen, [], "the gateway never heard it");
    // other words, and a near miss, are ordinary commands
    for (const text of ["the blue heron flies", "arm"]) await call(running, cookie, "POST", "/api/v1/voice/command", { text, language: "en" });
    assert.deepEqual(fake.seen, ["the blue heron flies", "arm"]);
    assert.equal(duressAlarms(running), 1);
    const trail = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(trail, /"action":"voice\.panic","outcome":"allowed"/);
    assert.match(trail, /"action":"voice\.panic","outcome":"denied"/);
    assert.doesNotMatch(trail, /heron/i);
    assert.doesNotMatch(fs.readFileSync(path.join(running.config.dataDir, "users.json"), "utf8"), /heron/i);
  } finally { await running.stop(); await fake.close(); }
});

test("a phrase that is too short or an example is refused, and the password is asked", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    assert.deepEqual([(await setPhrase(running, cookie, "help me")).status, (await setPhrase(running, cookie, "help me")).body.code], [400, "phrase_too_short"]);
    assert.equal((await setPhrase(running, cookie, "Hoje esta bom tempo")).body.code, "phrase_is_example");
    assert.equal((await call(running, cookie, "PUT", "/api/v1/account/panic-phrase", { currentPassword: "wrong", phrase: PHRASE })).status, 403);
    assert.equal((await setPhrase(running, cookie, PHRASE)).status, 200);
    assert.equal((await call(running, cookie, "PUT", "/api/v1/account/panic-phrase", { currentPassword: running.config.studioPassword, clear: true })).body.hasPanicPhrase, false);
  } finally { await running.stop(); }
});
