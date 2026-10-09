import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { isVoiceLanguage, spokenResult, VOICE_LANGUAGES } from "../src/voice.js";
import { startServer, studioCookie, type Running } from "./helpers.js";

const TOKEN = "v".repeat(32);
const json = { "Content-Type": "application/json" };

/** A stand-in for the voice gateway: the same protocol (token header, two turns for arm and disarm), nothing else. */
async function fakeGateway() {
  const seen: Array<{ text: string; language?: string; confirmation?: string }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const send = (status: number, payload: unknown) => { response.writeHead(status, json); response.end(JSON.stringify(payload)); };
      if (request.headers["x-armor-voice-token"] !== TOKEN) return send(401, { error: "unauthorized" });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text: string; language?: string; confirmation?: string };
      seen.push(body);
      const intent = ({ arm: "arm", disarm: "disarm", status: "status", silence: "silence" } as Record<string, string>)[body.text];
      if (!intent) return send(200, { accepted: false, requires_confirmation: false, intent: null, outcome: "not-understood", speech: "Command not recognised", reason: "the phrase is not one of the known commands" });
      if ((intent === "arm" || intent === "disarm") && body.confirmation === undefined) return send(200, { accepted: false, requires_confirmation: true, intent, outcome: "confirmation-needed", confirmation_token: `tok-${intent}`, speech: "Please confirm" });
      if ((intent === "arm" || intent === "disarm") && body.confirmation !== `tok-${intent}`) return send(200, { accepted: false, requires_confirmation: false, intent, outcome: "confirmation-refused", speech: "Confirmation refused" });
      return send(200, { accepted: true, requires_confirmation: false, intent, outcome: "accepted", speech: "Command accepted" });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const call = async (running: Running, cookie: string, method: string, url: string, body?: unknown) => {
  const reply = await fetch(`${running.base}${url}`, { method, headers: { ...json, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: reply.status, body: await reply.json().catch(() => ({})) as Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
};

const mode = (running: Running) => running.app.context.store.snapshot().mode;

test("what is said in every language has its sentences", () => {
  assert.deepEqual([...VOICE_LANGUAGES], ["en", "es", "de", "fr", "it", "ja", "zh"]);
  assert.equal(isVoiceLanguage("fr"), true);
  assert.equal(isVoiceLanguage("xx"), false);
  for (const language of VOICE_LANGUAGES) {
    for (const spoken of [spokenResult(language, { intent: "arm" }), spokenResult(language, { intent: "disarm" }), spokenResult(language, { intent: "silence", acknowledged: 0 }), spokenResult(language, { intent: "silence", acknowledged: 3 })]) assert.ok(spoken.trim().length > 2, language);
    const status = spokenResult(language, { intent: "status", mode: "armed", alarms: 2, online: 3, nodes: 4 });
    assert.doesNotMatch(status, /\{/);
    for (const number of ["2", "3", "4"]) assert.ok(status.includes(number), `${language}: ${status}`);
  }
});

test("a written command is understood by the gateway and carried out by the server with the session of the person", async () => {
  const gateway = await fakeGateway();
  const running = await startServer({ ARMOR_VOICE_URL: gateway.url, ARMOR_VOICE_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(running.base);
    assert.deepEqual((await call(running, cookie, "GET", "/api/v1/voice/status")).body, { available: true });

    // arming asks for a confirmation first, and nothing changes until it comes back
    assert.equal(mode(running), "disarmed");
    const first = await call(running, cookie, "POST", "/api/v1/voice/command", { text: "arm", language: "es" });
    assert.deepEqual([first.status, first.body.outcome, first.body.executed, first.body.confirmation_token], [200, "confirmation-needed", false, "tok-arm"]);
    assert.equal(mode(running), "disarmed");
    const second = await call(running, cookie, "POST", "/api/v1/voice/command", { text: "arm", language: "es", confirmation: first.body.confirmation_token });
    assert.deepEqual([second.body.executed, second.body.intent, second.body.speech, second.body.result], [true, "arm", "Sistema armado.", { mode: "armed" }]);
    assert.equal(mode(running), "armed");
    assert.deepEqual(gateway.seen.map(item => item.language), ["es", "es"]);

    // a wrong confirmation does nothing
    const refused = await call(running, cookie, "POST", "/api/v1/voice/command", { text: "disarm", confirmation: "forged" });
    assert.deepEqual([refused.body.outcome, refused.body.executed], ["confirmation-refused", false]);
    assert.equal(mode(running), "armed");
    const disarmed = await call(running, cookie, "POST", "/api/v1/voice/command", { text: "disarm", confirmation: "tok-disarm", language: "de" });
    assert.deepEqual([disarmed.body.speech, mode(running)], ["System entschärft.", "disarmed"]);

    // the state and the silence need no confirmation and say what they found
    const status = await call(running, cookie, "POST", "/api/v1/voice/command", { text: "status", language: "en" });
    assert.deepEqual([status.body.executed, status.body.result.mode, status.body.result.alarms], [true, "disarmed", 0]);
    assert.match(status.body.speech, /The system is disarmed\. 0 active alarm/);
    const silence = await call(running, cookie, "POST", "/api/v1/voice/command", { text: "silence", language: "en" });
    assert.deepEqual([silence.body.executed, silence.body.speech], [true, "There are no active alarms."]);

    // a phrase that is not a command is an answer, not a failure
    const unknown = await call(running, cookie, "POST", "/api/v1/voice/command", { text: "open the garage" });
    assert.deepEqual([unknown.status, unknown.body.accepted, unknown.body.executed, unknown.body.outcome], [200, false, false, "not-understood"]);

    // the audit trail has the commands and the person, not the words
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /control\.arm.*voice/);
    assert.match(audit, /voice\.command/);
    assert.doesNotMatch(audit, /open the garage|forged/);
  } finally { await running.stop(); await gateway.close(); }
});

test("the checks of the command route", async () => {
  const gateway = await fakeGateway();
  const running = await startServer({ ARMOR_VOICE_URL: gateway.url, ARMOR_VOICE_TOKEN: TOKEN });
  try {
    assert.equal((await call(running, "", "POST", "/api/v1/voice/command", { text: "status" })).status, 401);
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running, cookie, "POST", "/api/v1/voice/command", {})).body.error, "no_text");
    assert.equal((await call(running, cookie, "POST", "/api/v1/voice/command", { text: "x".repeat(201) })).body.error, "text_too_long");
    assert.equal((await call(running, cookie, "POST", "/api/v1/voice/command", { text: "status", language: "xx" })).body.error, "invalid_language");
  } finally { await running.stop(); await gateway.close(); }
  const wrongToken = await fakeGateway();
  const refused = await startServer({ ARMOR_VOICE_URL: wrongToken.url, ARMOR_VOICE_TOKEN: "w".repeat(32) });
  try {
    const cookie = await studioCookie(refused.base);
    assert.deepEqual((await call(refused, cookie, "POST", "/api/v1/voice/command", { text: "status" })).body, { error: "voice_refused_the_token" });
  } finally { await refused.stop(); await wrongToken.close(); }
});

test("without a voice gateway, or with one that does not answer, the commands say so", async () => {
  const none = await startServer();
  try {
    const cookie = await studioCookie(none.base);
    assert.deepEqual((await call(none, cookie, "GET", "/api/v1/voice/status")).body, { available: false });
    assert.deepEqual((await call(none, cookie, "POST", "/api/v1/voice/command", { text: "status" })).body, { error: "voice_unavailable" });
  } finally { await none.stop(); }
  const down = await startServer({ ARMOR_VOICE_URL: "http://127.0.0.1:9", ARMOR_VOICE_TOKEN: TOKEN });
  try {
    const cookie = await studioCookie(down.base);
    const reply = await call(down, cookie, "POST", "/api/v1/voice/command", { text: "status" });
    assert.deepEqual([reply.status, reply.body.error], [503, "voice_not_answering"]);
  } finally { await down.stop(); }
});
