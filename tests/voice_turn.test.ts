// The binary voice turn: the reader agrees with the shared byte-level cases of ARMOR-COMMON, and the route takes a multipart turn, hands the audio to the gateway as before, shapes the answer as the panel asked,
// keeps its limits (settings of the server) and can be turned off.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { lowers, SECURITY_DEFAULTS } from "../src/security_settings.js";
import {
  boundaryOf, buildVoiceTurnReply, buildVoiceTurnRequest, isMultipartForm, parseVoiceTurnReply, parseVoiceTurnRequest, shapeReply, VoiceTurnError, type VoiceTurnMeta,
} from "../src/voice_turn.js";
import { startServer, testConfig } from "./helpers.js";

const TOKEN = "v".repeat(32);
const META: VoiceTurnMeta = { language: "es", encoding: "pcm_s16le", sample_rate: 16000, channels: 1 };
const PCM = Buffer.from(Array.from({ length: 3200 }, (_, index) => index % 251));

const cases = path.resolve(import.meta.dirname, "..", "..", "ARMOR-COMMON", "conformance", "voice", "turn_multipart.json");
type SharedCase = { name: string; direction: "request" | "reply"; content_type: string; body: string; max_audio_bytes?: number;
  expect: { error?: { status: number; code: string }; meta?: unknown; audio?: string | null; result?: unknown } };

test("the reader agrees with every shared byte-level case", { skip: fs.existsSync(cases) ? false : "ARMOR-COMMON is not checked out next to this repository" }, () => {
  const all = (JSON.parse(fs.readFileSync(cases, "utf8")) as { cases: SharedCase[] }).cases;
  assert.ok(all.length >= 40);
  for (const item of all) {
    const body = Buffer.from(item.body, "base64");
    const run = () => item.direction === "request" ? parseVoiceTurnRequest(item.content_type, body, item.max_audio_bytes ?? 480_000) : parseVoiceTurnReply(item.content_type, body, item.max_audio_bytes ?? 200_000);
    if (item.expect.error) {
      assert.throws(run, (error: unknown) => error instanceof VoiceTurnError && error.status === item.expect.error!.status && error.code === item.expect.error!.code, item.name);
    } else if (item.direction === "request") {
      const got = run() as { meta: unknown; audio: Buffer };
      assert.deepEqual(got.meta, item.expect.meta, item.name);
      assert.equal(got.audio.toString("base64"), item.expect.audio, item.name);
    } else {
      const got = run() as { result: unknown; audio: Buffer | null };
      assert.deepEqual(got.result, item.expect.result, item.name);
      assert.equal(got.audio ? got.audio.toString("base64") : null, item.expect.audio, item.name);
    }
  }
});

test("what the writer builds the reader takes back", () => {
  const built = buildVoiceTurnRequest(PCM, { ...META, reply_audio: "binary" });
  assert.ok(isMultipartForm(built.contentType));
  assert.equal(isMultipartForm("audio/L16;rate=16000"), false);
  const back = parseVoiceTurnRequest(built.contentType, built.body, 480_000);
  assert.deepEqual(back.meta, { ...META, reply_audio: "binary" });
  assert.ok(back.audio.equals(PCM));
  const plain = buildVoiceTurnRequest(PCM);
  assert.equal(parseVoiceTurnRequest(plain.contentType, plain.body, 480_000).meta, null);
  const reply = buildVoiceTurnReply({ heard: "status", reply: "all quiet" }, PCM);
  const parsed = parseVoiceTurnReply(reply.contentType, reply.body, 200_000);
  assert.deepEqual(parsed.result, { heard: "status", reply: "all quiet" });
  assert.ok(parsed.audio!.equals(PCM));
  const textOnly = buildVoiceTurnReply({ heard: "a", reply: "b" });
  assert.equal(parseVoiceTurnReply(textOnly.contentType, textOnly.body, 200_000).audio, null);
  assert.throws(() => buildVoiceTurnReply({ heard: "a", reply: "b", audio: "AAAA" }), VoiceTurnError);
  assert.throws(() => buildVoiceTurnRequest(Buffer.from("--abc\u0000"), undefined, "abc"), VoiceTurnError);
  assert.equal(boundaryOf('multipart/form-data; boundary="abc123"', "form-data"), "abc123");
});

test("the gateway's answer is shaped as the panel asked", () => {
  const gateway = JSON.stringify({ heard: "arm", reply: "Arm the system?", audio: PCM.toString("base64") });
  const binary = shapeReply(gateway, "binary", 200_000)!;
  const parsed = parseVoiceTurnReply(binary.contentType, binary.body as Buffer, 200_000);
  assert.deepEqual(parsed.result, { heard: "arm", reply: "Arm the system?" });
  assert.ok(parsed.audio!.equals(PCM));
  assert.deepEqual(JSON.parse(String(shapeReply(gateway, "none", 200_000)!.body)), { heard: "arm", reply: "Arm the system?" });
  // a spoken answer above the limit is left out and the text still goes, with the reason
  const small = shapeReply(gateway, "binary", 3000)!;
  const tooLarge = parseVoiceTurnReply(small.contentType, small.body as Buffer, 200_000);
  assert.deepEqual(tooLarge.result, { heard: "arm", reply: "Arm the system?", audio_omitted: "too_large" });
  assert.equal(tooLarge.audio, null);
  // a gateway answer that is not a voice reply is nothing to hand on
  for (const bad of ["not json", "[]", "{}", JSON.stringify({ heard: 1, reply: "x" }), JSON.stringify({ heard: "a", reply: "b", audio: "not base64!" })]) assert.equal(shapeReply(bad, "binary", 200_000), null, bad);
  // the texts are cut at the contract's length
  const cut = shapeReply(JSON.stringify({ heard: "h".repeat(5000), reply: "r" }), "binary", 1)!;
  const long = parseVoiceTurnReply(cut.contentType, cut.body as Buffer, 200_000);
  assert.equal(long.result.heard.length, 2000);
});

/** A stand-in for the voice gateway: it keeps what it was sent and answers `{heard, reply, audio}` with audio. */
async function gateway(answer: () => { status: number; body: unknown } = () => ({ status: 200, body: { heard: "status", reply: "all quiet", audio: PCM.toString("base64") } })) {
  const seen: Array<{ bytes: number; language: string; type: string; token: string; policy: string; first: number }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ bytes: body.length, language: String(request.headers["x-armor-language"]), type: String(request.headers["content-type"]), token: String(request.headers["x-armor-voice-token"]), policy: String(request.headers["x-armor-policy"]), first: body[0] ?? -1 });
      const out = answer();
      response.writeHead(out.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const post = (base: string, body: Buffer, contentType: string, headers: Record<string, string> = {}, route = "/api/v1/voice/turn") =>
  fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": contentType, "X-Armor-Voice-Token": TOKEN, ...headers }, body: new Uint8Array(body) });

test("a multipart turn reaches the gateway as raw audio with the language of its meta, and the answer follows reply_audio", async () => {
  const fake = await gateway();
  const running = await startServer({ ARMOR_VOICE_URL: fake.url, ARMOR_VOICE_TOKEN: TOKEN });
  try {
    // binary: multipart/mixed with the result and the audio
    const asked = buildVoiceTurnRequest(PCM, { ...META, language: "de", reply_audio: "binary" });
    const binary = await post(running.base, asked.body, asked.contentType, { "X-Armor-Language": "fr" });
    assert.equal(binary.status, 200);
    assert.match(binary.headers.get("content-type") ?? "", /^multipart\/mixed; boundary=/);
    const parsed = parseVoiceTurnReply(binary.headers.get("content-type")!, Buffer.from(await binary.arrayBuffer()), 200_000);
    assert.deepEqual(parsed.result, { heard: "status", reply: "all quiet" });
    assert.ok(parsed.audio!.equals(PCM));
    // the meta wins over the header, and the gateway gets what it always got: the PCM as the body, the token, the policy
    assert.deepEqual(fake.seen[0], { bytes: PCM.length, language: "de", type: "audio/L16;rate=16000", token: TOKEN, policy: JSON.stringify({ silence_confirmation: "off" }), first: PCM[0] });

    // none: JSON without audio
    const none = buildVoiceTurnRequest(PCM, { ...META, reply_audio: "none" });
    const text = await post(running.base, none.body, none.contentType, {}, "/api/v1/voice/v1/turn");
    assert.deepEqual([text.status, await text.json()], [200, { heard: "status", reply: "all quiet" }]);

    // base64 (the default, with or without meta): the gateway's JSON as it is
    for (const request of [buildVoiceTurnRequest(PCM, META), buildVoiceTurnRequest(PCM)]) {
      const plain = await post(running.base, request.body, request.contentType, { "X-Armor-Language": "it" });
      assert.deepEqual([plain.status, await plain.json()], [200, { heard: "status", reply: "all quiet", audio: PCM.toString("base64") }]);
    }
    assert.equal(fake.seen[3]!.language, "it", "without a meta the language is the one of the header");

    // the older raw request is exactly what it was
    const raw = await post(running.base, PCM, "audio/L16;rate=16000", { "X-Armor-Language": "es" });
    assert.deepEqual([raw.status, (await raw.json() as { audio: string }).audio], [200, PCM.toString("base64")]);
    assert.deepEqual([fake.seen[4]!.bytes, fake.seen[4]!.language], [PCM.length, "es"]);
  } finally { await running.stop(); await fake.close(); }
});

test("a spoken answer above the limit of the server is left out and the text goes", async () => {
  const fake = await gateway(() => ({ status: 200, body: { heard: "status", reply: "all quiet", audio: Buffer.alloc(3202).toString("base64") } }));
  const running = await startServer({ ARMOR_VOICE_URL: fake.url, ARMOR_VOICE_TOKEN: TOKEN, ARMOR_VOICE_REPLY_AUDIO_MAX_BYTES: "3200" });
  try {
    const asked = buildVoiceTurnRequest(PCM, { ...META, reply_audio: "binary" });
    const reply = await post(running.base, asked.body, asked.contentType);
    const parsed = parseVoiceTurnReply(reply.headers.get("content-type")!, Buffer.from(await reply.arrayBuffer()), 200_000);
    assert.deepEqual(parsed.result, { heard: "status", reply: "all quiet", audio_omitted: "too_large" });
    assert.equal(parsed.audio, null);
  } finally { await running.stop(); await fake.close(); }
});

test("a gateway that answers something that is not a voice reply is a 502 in binary and its own answer otherwise", async () => {
  let next: { status: number; body: unknown } = { status: 200, body: { nothing: true } };
  const fake = await gateway(() => next);
  const running = await startServer({ ARMOR_VOICE_URL: fake.url, ARMOR_VOICE_TOKEN: TOKEN });
  try {
    const asked = buildVoiceTurnRequest(PCM, { ...META, reply_audio: "binary" });
    const bad = await post(running.base, asked.body, asked.contentType);
    assert.deepEqual([bad.status, await bad.json()], [502, { error: "voice_bad_reply" }]);
    next = { status: 422, body: { error: "unsupported language" } };
    const refused = await post(running.base, asked.body, asked.contentType);
    assert.deepEqual([refused.status, await refused.json()], [422, { error: "unsupported language" }], "the gateway's own refusal is handed on");
  } finally { await running.stop(); await fake.close(); }
});

test("a turn that breaks the contract is refused with the status and code of the contract, and nothing reaches the gateway", async () => {
  const fake = await gateway();
  const running = await startServer({ ARMOR_VOICE_URL: fake.url, ARMOR_VOICE_TOKEN: TOKEN });
  try {
    const good = buildVoiceTurnRequest(PCM, META);
    const answer = async (body: Buffer, contentType: string, headers: Record<string, string> = {}) => { const reply = await post(running.base, body, contentType, headers); return [reply.status, (await reply.json() as { error: string }).error]; };
    assert.deepEqual(await answer(Buffer.from("junk"), "multipart/form-data; boundary=abc"), [400, "bad_multipart"]);
    assert.deepEqual(await answer(good.body, "multipart/form-data"), [400, "bad_multipart"]);
    assert.deepEqual(await answer(buildVoiceTurnRequest(Buffer.alloc(0), undefined).body, buildVoiceTurnRequest(Buffer.alloc(0)).contentType), [400, "bad_multipart"], "a boundary that is not the one of the body");
    const empty = buildVoiceTurnRequest(Buffer.alloc(0), META);
    assert.deepEqual(await answer(empty.body, empty.contentType), [411, "bad audio length"]);
    const odd = buildVoiceTurnRequest(Buffer.alloc(3), META);
    assert.deepEqual(await answer(odd.body, odd.contentType), [411, "bad audio length"]);
    const withoutAudio = Buffer.from(good.body.toString("latin1").replace(/--(\w+)\r\nContent-Disposition: form-data; name="audio"[\s\S]*?\r\n--\1--/, (_, b: string) => `--${b}--`), "latin1");
    assert.deepEqual(await answer(withoutAudio, good.contentType), [422, "missing_audio"]);
    const badMeta = buildVoiceTurnRequest(PCM, { ...META, sample_rate: 8000 } as unknown as VoiceTurnMeta);
    assert.deepEqual(await answer(badMeta.body, badMeta.contentType), [422, "bad_meta"]);
    const big = buildVoiceTurnRequest(Buffer.alloc(480_002), META);
    assert.deepEqual(await answer(big.body, big.contentType), [413, "audio_too_large"]);
    assert.deepEqual(await answer(Buffer.alloc(0), "audio/L16;rate=16000"), [411, "bad audio length"], "the older request keeps its own answers");
    assert.deepEqual(await answer(Buffer.alloc(500_000), "audio/L16;rate=16000"), [413, "audio_too_large"]);
    // the token is checked before the body is read
    const noToken = await fetch(`${running.base}/api/v1/voice/turn`, { method: "POST", headers: { "Content-Type": good.contentType }, body: new Uint8Array(good.body) });
    assert.equal(noToken.status, 401);
    assert.equal(fake.seen.length, 0);
  } finally { await running.stop(); await fake.close(); }
});

test("the limits are settings of the server and are checked", async () => {
  assert.throws(() => testConfig({ ARMOR_VOICE_TURN_MAX_BYTES: "10" }), /ARMOR_VOICE_TURN_MAX_BYTES/);
  assert.throws(() => testConfig({ ARMOR_VOICE_TURN_MAX_BYTES: "2000000" }), /ARMOR_VOICE_TURN_MAX_BYTES/);
  assert.throws(() => testConfig({ ARMOR_VOICE_REPLY_AUDIO_MAX_BYTES: "abc" }), /ARMOR_VOICE_REPLY_AUDIO_MAX_BYTES/);
  assert.deepEqual([testConfig().voiceTurnMaxBytes, testConfig().voiceReplyAudioMaxBytes], [480_000, 200_000]);
  const fake = await gateway();
  const running = await startServer({ ARMOR_VOICE_URL: fake.url, ARMOR_VOICE_TOKEN: TOKEN, ARMOR_VOICE_TURN_MAX_BYTES: "3200" });
  try {
    assert.equal(running.config.voiceTurnMaxBytes, 3200);
    const fits = buildVoiceTurnRequest(Buffer.alloc(3200), META), over = buildVoiceTurnRequest(Buffer.alloc(3202), META);
    assert.equal((await post(running.base, fits.body, fits.contentType)).status, 200);
    const refused = await post(running.base, over.body, over.contentType);
    assert.deepEqual([refused.status, await refused.json()], [413, { error: "audio_too_large" }]);
    assert.equal((await post(running.base, Buffer.alloc(3202), "audio/L16;rate=16000")).status, 413, "the same limit for the older request");
  } finally { await running.stop(); await fake.close(); }
});

test("the option voice.multipart_turn is on by default and, off, a multipart turn is refused while the raw one still goes", async () => {
  assert.equal(SECURITY_DEFAULTS["voice.multipart_turn"], true);
  const fake = await gateway();
  const running = await startServer({ ARMOR_VOICE_URL: fake.url, ARMOR_VOICE_TOKEN: TOKEN });
  try {
    const good = buildVoiceTurnRequest(PCM, META);
    assert.equal((await post(running.base, good.body, good.contentType)).status, 200);
    running.app.context.securitySettings.update({ "voice.multipart_turn": false });
    const refused = await post(running.base, good.body, good.contentType);
    assert.deepEqual([refused.status, await refused.json()], [415, { error: "multipart_turn_disabled" }]);
    assert.equal((await post(running.base, PCM, "audio/L16;rate=16000")).status, 200);
    running.app.context.securitySettings.update({ "voice.multipart_turn": true });
    assert.equal((await post(running.base, good.body, good.contentType)).status, 200);
  } finally { await running.stop(); await fake.close(); }
});

test("the two sizes can be changed in the settings, are held to the ceilings and start from the environment", async () => {
  const fake = await gateway();
  const running = await startServer({ ARMOR_VOICE_URL: fake.url, ARMOR_VOICE_TOKEN: TOKEN, ARMOR_VOICE_TURN_MAX_BYTES: "6400" });
  try {
    const settings = running.app.context.securitySettings;
    assert.equal(settings.get("voice.turn_max_bytes"), 6400, "the environment is where it starts");
    assert.equal(settings.get("voice.reply_audio_max_bytes"), 200_000);
    assert.equal(SECURITY_DEFAULTS["voice.turn_max_bytes"], 480_000);
    for (const bad of [3199, 1_920_001, 6400.5, "6400", null, true]) assert.throws(() => settings.update({ "voice.turn_max_bytes": bad }), /invalid value/);
    for (const bad of [3199, 1_000_001, "x"]) assert.throws(() => settings.update({ "voice.reply_audio_max_bytes": bad }), /invalid value/);
    assert.equal(settings.get("voice.turn_max_bytes"), 6400, "a refused value changes nothing");
    const over = buildVoiceTurnRequest(Buffer.alloc(6402), META);
    assert.equal((await post(running.base, over.body, over.contentType)).status, 413);
    settings.update({ "voice.turn_max_bytes": 9600 });                                   // counts for the next turn, with no restart
    assert.equal((await post(running.base, over.body, over.contentType)).status, 200);
    settings.update({ "voice.turn_max_bytes": 3200 });
    const small = buildVoiceTurnRequest(Buffer.alloc(3202), META);
    assert.equal((await post(running.base, small.body, small.contentType)).status, 413);
    assert.equal((await post(running.base, Buffer.alloc(3202), "audio/L16;rate=16000")).status, 413);
    assert.equal(lowers("voice.turn_max_bytes", 3200, 9600), true);
    assert.equal(lowers("voice.turn_max_bytes", 9600, 3200), false);
    // only what was set is stored: the other size still follows the environment
    const stored = JSON.parse(fs.readFileSync(path.join(running.config.dataDir, "security-settings.json"), "utf8")).settings;
    assert.equal(stored["voice.turn_max_bytes"], 3200);
    assert.equal("voice.reply_audio_max_bytes" in stored, false);
  } finally { await running.stop(); await fake.close(); }
});
