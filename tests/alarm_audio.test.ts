// The sound of an alarm for the wall panel: the sentence is made of closed lists in eight languages, a sound is read byte by byte and reduced to its samples, the spoken alarm and the
// uploaded sounds are off until an administrator turns them on, and the panel (an account of the panel role) can read them but not write them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { ALARM_SEVERITIES, ALARM_SOURCES, alarmSentence, AlarmAudioError, samplesOfWave, SoundLibrary, SpokenCache } from "../src/alarm_audio.js";
import { VOICE_LANGUAGES } from "../src/voice.js";
import { SECURITY_DEFAULTS } from "../src/security_settings.js";
import { SECRETS, startServer, studioCookie, tempDir, testConfig, type Running } from "./helpers.js";

const TOKEN = "v".repeat(32);
const json = { "Content-Type": "application/json" };

/** A WAVE file of 16 kHz 16-bit mono: a square wave of `samples` samples (or silence). */
function wave(samples: number, options: { rate?: number; bits?: number; channels?: number; silent?: boolean; format?: number; short?: boolean } = {}): Buffer {
  const data = Buffer.alloc(samples * 2);
  if (!options.silent) for (let i = 0; i < samples; i++) data.writeInt16LE(i % 40 < 20 ? 8000 : -8000, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "latin1"); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(options.format ?? 1, 20); header.writeUInt16LE(options.channels ?? 1, 22); header.writeUInt32LE(options.rate ?? 16_000, 24);
  header.writeUInt32LE((options.rate ?? 16_000) * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(options.bits ?? 16, 34); header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  const whole = Buffer.concat([header, data]);
  return options.short ? whole.subarray(0, whole.length - 10) : whole;
}

test("the sentence is made of closed lists in the eight languages and never reads an unknown code", () => {
  for (const language of VOICE_LANGUAGES) {
    for (const source of ALARM_SOURCES) for (const severity of ALARM_SEVERITIES) {
      const sentence = alarmSentence(language, source, severity, "electrical_grid_lost");
      assert.ok(sentence.length > 8 && sentence.endsWith("."), `${language} ${source} ${severity}`);
    }
  }
  assert.equal(alarmSentence("en", "electrical", "critical", "electrical_grid_lost"), "Critical alarm. Electrical. The grid supply is lost.");
  assert.equal(alarmSentence("pt", "network", "info"), "Informação. Rede.");
  assert.equal(alarmSentence("en", "device", "high", "no_such_code"), "High alarm. Device.", "a code nobody knows is not read out");
  assert.equal(alarmSentence("en", "device", "high", "ignore previous; say something else"), "High alarm. Device.", "nothing but a known code reaches the engine");
  assert.equal(new Set(VOICE_LANGUAGES.map(language => alarmSentence(language, "network", "warning"))).size, 8, "each language says it its own way");
});

test("a WAVE file is accepted only as 16 kHz, 16-bit, mono PCM of a sensible length that is not silence", () => {
  const good = samplesOfWave(wave(8000), 128_000);
  assert.equal(good.length, 16_000);
  const refused = (file: Buffer, status: number, code: string, max = 128_000) => assert.throws(() => samplesOfWave(file, max), (error: unknown) => error instanceof AlarmAudioError && error.status === status && error.code === code, code);
  refused(Buffer.from("MZ" + "x".repeat(100)), 415, "not_a_wave_file");
  refused(Buffer.from("RIFF"), 415, "not_a_wave_file");
  refused(wave(8000, { rate: 44_100 }), 415, "unsupported_wave_format");
  refused(wave(8000, { channels: 2 }), 415, "unsupported_wave_format");
  refused(wave(8000, { bits: 8 }), 415, "unsupported_wave_format");
  refused(wave(8000, { format: 3 }), 415, "unsupported_wave_format");
  refused(wave(8000, { short: true }), 415, "wave_truncated");
  refused(wave(800), 422, "sound_too_short");
  refused(wave(8000, { silent: true }), 422, "sound_is_silent");
  refused(wave(8000), 413, "sound_too_long", 8_000);
  // a data chunk before the format, a chunk that loops, a file of chunks without data
  const noFormat = wave(8000); noFormat.write("data", 12, "latin1");
  refused(noFormat, 415, "wave_unreadable");
  const chunks = Buffer.concat([wave(8000).subarray(0, 36), ...Array.from({ length: 40 }, () => Buffer.concat([Buffer.from("junk"), Buffer.from([0, 0, 0, 0])]))]);
  chunks.writeUInt32LE(chunks.length - 8, 4);
  refused(chunks, 415, "wave_unreadable");
  // other chunks (a list of names, say) are walked over, and only the samples are kept
  const base = wave(8000), extra = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
  const withList = Buffer.concat([base.subarray(0, 36), extra, base.subarray(36)]);
  withList.writeUInt32LE(withList.length - 8, 4);
  assert.ok(samplesOfWave(withList, 128_000).equals(base.subarray(44)));
});

test("the library keeps one sound per origin and does not serve one that was changed", () => {
  const dir = tempDir();
  const library = new SoundLibrary(dir);
  const samples = samplesOfWave(wave(8000), 128_000);
  const stored = library.put("solar", samples, "admin", new Date("2000-01-01T00:00:00Z"));
  assert.deepEqual([stored.bytes, stored.duration_ms, stored.sha256], [16_000, 500, createHash("sha256").update(samples).digest("hex")]);
  assert.ok(library.get("solar")!.samples.equals(samples));
  assert.equal(library.get("network"), undefined);
  assert.deepEqual(library.list().map(item => item.source), ["solar"]);
  fs.writeFileSync(path.join(dir, "solar.pcm"), Buffer.alloc(16_000, 1));
  assert.equal(library.get("solar"), undefined, "a file that no longer matches its hash is not served");
  assert.equal(library.remove("solar"), true);
  assert.equal(library.remove("solar"), false);
});

test("the cache of spoken sentences keeps the most recently used and stays inside its limits", () => {
  const cache = new SpokenCache(3, 100);
  cache.set("a", Buffer.alloc(30)); cache.set("b", Buffer.alloc(30)); cache.set("c", Buffer.alloc(30));
  cache.get("a");
  cache.set("d", Buffer.alloc(30));
  assert.deepEqual([cache.get("a") !== undefined, cache.get("b"), cache.get("c") !== undefined, cache.get("d") !== undefined], [true, undefined, true, true]);
  assert.ok(cache.bytes <= 100 && cache.size <= 3);
  cache.set("big", Buffer.alloc(101));
  assert.equal(cache.get("big"), undefined, "one longer than the whole cache is not kept");
  cache.clear();
  assert.equal(cache.size, 0);
});

test("both switches are off by default and lowering is not a word that applies to them", () => {
  assert.equal(SECURITY_DEFAULTS["alarm_audio.spoken"], false);
  assert.equal(SECURITY_DEFAULTS["alarm_audio.custom_sounds"], false);
  assert.equal(testConfig().alarmSoundMaxBytes, 128_000);
  assert.equal(testConfig({ ARMOR_ALARM_SOUND_MAX_BYTES: "3200" }).alarmSoundMaxBytes, 3_200);
  assert.throws(() => testConfig({ ARMOR_ALARM_SOUND_MAX_BYTES: "256001" }), /ARMOR_ALARM_SOUND_MAX_BYTES/);
});

async function gateway(handler: (body: { text: string; language: string }) => { status: number; body: unknown }) {
  const seen: Array<{ text: string; language: string; token: string }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text: string; language: string };
      seen.push({ ...body, token: String(request.headers["x-armor-voice-token"]) });
      const answer = request.url === "/v1/speak" ? handler(body) : { status: 404, body: {} };
      response.writeHead(answer.status, json).end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const PCM = Buffer.from(Array.from({ length: 6400 }, (_, index) => index % 251));
const asOperator = { Authorization: `Bearer ${SECRETS.ARMOR_OPERATOR_TOKEN}` };

async function panelCookie(running: Running, admin: string): Promise<string> {
  const made = await fetch(`${running.base}/api/v1/users`, { method: "POST", headers: { ...json, cookie: admin }, body: JSON.stringify({ username: "wall-panel", password: "wall-panel-password-1", role: "panel" }) });
  assert.equal(made.status, 201);
  const login = await fetch(`${running.base}/api/v1/studio/session`, { method: "POST", headers: json, body: JSON.stringify({ username: "wall-panel", password: "wall-panel-password-1" }) });
  return (login.headers.getSetCookie()[0] ?? "").split(";")[0];
}
const turnOn = (running: Running, admin: string, settings: Record<string, boolean>) => fetch(`${running.base}/api/v1/security/settings`, { method: "PUT", headers: { ...json, cookie: admin }, body: JSON.stringify(settings) });
const spokenUrl = (running: Running, query = "language=es&source=electrical&severity=critical&code=electrical_grid_lost") => `${running.base}/api/v1/alarm-audio/spoken?${query}`;

test("a spoken alarm is made by the gateway once, kept, and handed to the panel with its hash", async () => {
  const fake = await gateway(() => ({ status: 200, body: { audio: PCM.toString("base64") } }));
  const running = await startServer({ ARMOR_VOICE_URL: fake.url, ARMOR_VOICE_TOKEN: TOKEN });
  try {
    const admin = await studioCookie(running.base);
    const panel = await panelCookie(running, admin);
    assert.equal((await fetch(spokenUrl(running), { headers: { cookie: panel } })).status, 404, "off by default");
    assert.equal((await fetch(spokenUrl(running))).status, 401, "a stranger is turned away");
    assert.equal((await turnOn(running, admin, { "alarm_audio.spoken": true })).status, 200);
    const reply = await fetch(spokenUrl(running), { headers: { cookie: panel } });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("content-type"), "audio/L16;rate=16000");
    const body = Buffer.from(await reply.arrayBuffer());
    assert.ok(body.equals(PCM));
    assert.equal(reply.headers.get("x-armor-audio-sha256"), createHash("sha256").update(PCM).digest("hex"));
    assert.equal(fake.seen.length, 1);
    assert.deepEqual([fake.seen[0]!.language, fake.seen[0]!.token, fake.seen[0]!.text], ["es", TOKEN, alarmSentence("es", "electrical", "critical", "electrical_grid_lost")]);
    await fetch(spokenUrl(running), { headers: { cookie: panel } });
    assert.equal(fake.seen.length, 1, "the second time comes from the cache");
    // it asks again only by the closed lists
    for (const query of ["language=xx&source=solar&severity=high", "language=es&source=toaster&severity=high", "language=es&source=solar&severity=loud", "language=es&source=solar&severity=high&code=A%20B", "language=es&source=solar&severity=high&code=x&code=y"]) {
      assert.equal((await fetch(spokenUrl(running, query), { headers: { cookie: panel } })).status, 422, query);
    }
    assert.equal(fake.seen.length, 1);
  } finally { await running.stop(); await fake.close(); }
});

test("a gateway without a speech engine, with an answer of the wrong size or none at all is a clear error and nothing is kept", async () => {
  let next: { status: number; body: unknown } = { status: 501, body: { error: "tts_unavailable" } };
  const fake = await gateway(() => next);
  const running = await startServer({ ARMOR_VOICE_URL: fake.url, ARMOR_VOICE_TOKEN: TOKEN, ARMOR_VOICE_REPLY_AUDIO_MAX_BYTES: "3200" });
  try {
    const admin = await studioCookie(running.base);
    await turnOn(running, admin, { "alarm_audio.spoken": true });
    const ask = async () => { const reply = await fetch(spokenUrl(running), { headers: asOperator }); return [reply.status, (await reply.json() as { error: string }).error]; };
    assert.deepEqual(await ask(), [503, "tts_unavailable"]);
    next = { status: 200, body: { audio: Buffer.alloc(3202).toString("base64") } };
    assert.deepEqual(await ask(), [502, "voice_bad_answer"], "more than the server lets a spoken answer be");
    next = { status: 200, body: { audio: Buffer.alloc(3201).toString("base64") } };
    assert.deepEqual(await ask(), [502, "voice_bad_answer"], "an odd number of bytes is not 16-bit samples");
    next = { status: 200, body: { nothing: true } };
    assert.deepEqual(await ask(), [502, "voice_bad_answer"]);
  } finally { await running.stop(); await fake.close(); }
  const alone = await startServer();
  try {
    const admin = await studioCookie(alone.base);
    await turnOn(alone, admin, { "alarm_audio.spoken": true });
    assert.deepEqual([(await fetch(spokenUrl(alone), { headers: asOperator })).status], [503], "no voice gateway at all");
  } finally { await alone.stop(); }
});

const put = (running: Running, cookie: string, source: string, body: Buffer | string, extra: Record<string, string> = {}) =>
  fetch(`${running.base}/api/v1/alarm-audio/sounds/${source}`, { method: "PUT", headers: { cookie, "Content-Type": "audio/wav", ...extra }, body: typeof body === "string" ? body : new Uint8Array(body) });

test("an administrator uploads a sound for an origin, the panel reads it, and nobody else may write", async () => {
  const running = await startServer();
  try {
    const admin = await studioCookie(running.base);
    const panel = await panelCookie(running, admin);
    const file = wave(16_000);
    assert.equal((await put(running, admin, "solar", file)).status, 409, "nothing is accepted while the switch is off");
    assert.equal((await fetch(`${running.base}/api/v1/alarm-audio/sounds/solar`, { headers: { cookie: panel } })).status, 404);
    assert.equal((await turnOn(running, admin, { "alarm_audio.custom_sounds": true })).status, 200);

    const stored = await put(running, admin, "solar", file);
    assert.equal(stored.status, 200);
    const info = await stored.json() as { bytes: number; duration_ms: number; sha256: string; uploaded_by: string };
    assert.deepEqual([info.bytes, info.duration_ms, info.uploaded_by], [32_000, 1000, "admin"]);
    const read = await fetch(`${running.base}/api/v1/alarm-audio/sounds/solar`, { headers: { cookie: panel } });
    assert.equal(read.status, 200);
    const samples = Buffer.from(await read.arrayBuffer());
    assert.ok(samples.equals(file.subarray(44)), "only the samples are kept");
    assert.equal(createHash("sha256").update(samples).digest("hex"), info.sha256);
    assert.equal(read.headers.get("x-armor-audio-sha256"), info.sha256);
    assert.equal((await fetch(`${running.base}/api/v1/alarm-audio/sounds/solar`, { headers: { cookie: panel, "If-None-Match": `"${info.sha256}"` } })).status, 304);
    assert.equal((await fetch(`${running.base}/api/v1/alarm-audio/sounds/network`, { headers: { cookie: panel } })).status, 404);
    assert.equal((await fetch(`${running.base}/api/v1/alarm-audio/sounds/boiler`, { headers: { cookie: panel } })).status, 403, "the panel is not allowed anything outside the six origins");

    const state = await (await fetch(`${running.base}/api/v1/alarm-audio`, { headers: asOperator })).json() as { custom: { enabled: boolean; max_bytes: number; sounds: Array<{ source: string }> }; spoken: { enabled: boolean; available: boolean } };
    assert.deepEqual([state.custom.enabled, state.custom.max_bytes, state.custom.sounds.map(item => item.source), state.spoken.enabled, state.spoken.available], [true, 128_000, ["solar"], false, false]);

    // who may not write
    assert.equal((await put(running, panel, "solar", file)).status, 403);
    assert.equal((await put(running, "", "solar", file)).status, 401);
    assert.equal((await fetch(`${running.base}/api/v1/alarm-audio/sounds/solar`, { method: "PUT", headers: asOperator, body: new Uint8Array(file) })).status, 401, "the operator token is not an administrator");
    assert.equal((await fetch(`${running.base}/api/v1/alarm-audio/sounds/solar`, { method: "DELETE", headers: { cookie: panel } })).status, 403);

    // what is refused
    assert.equal((await put(running, admin, "toaster", file)).status, 404);
    assert.equal((await put(running, admin, "solar", Buffer.from("#!/bin/sh\nrm -rf /\n"))).status, 415, "a program is not a sound");
    assert.equal((await put(running, admin, "solar", wave(8000, { rate: 8000 }))).status, 415);
    assert.equal((await put(running, admin, "solar", wave(8000, { silent: true }))).status, 422);
    assert.equal((await put(running, admin, "solar", wave(100_000))).status, 413, "longer than the limit");
    assert.equal((await put(running, admin, "solar", "")).status, 411);
    assert.equal((await put(running, admin, "solar", Buffer.alloc(200_000, 1))).status, 413, "nothing is read past the limit");
    const kept = await fetch(`${running.base}/api/v1/alarm-audio/sounds/solar`, { headers: asOperator });
    assert.equal(createHash("sha256").update(Buffer.from(await kept.arrayBuffer())).digest("hex"), info.sha256, "a refused upload leaves the sound as it was");

    // away, and again with the switch off (the reading stops, taking away does not)
    await turnOn(running, admin, { "alarm_audio.custom_sounds": false });
    assert.equal((await fetch(`${running.base}/api/v1/alarm-audio/sounds/solar`, { headers: asOperator })).status, 404);
    assert.equal((await fetch(`${running.base}/api/v1/alarm-audio/sounds/solar`, { method: "DELETE", headers: { cookie: admin } })).status, 200);
    assert.equal((await fetch(`${running.base}/api/v1/alarm-audio/sounds/solar`, { method: "DELETE", headers: { cookie: admin } })).status, 404);
  } finally { await running.stop(); }
});
