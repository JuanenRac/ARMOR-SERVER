/** A voice gateway's answer is read up to a limit: a longer one, declared or not, is refused without being held in memory, and a normal one is read whole. */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { askVoice, readCapped, speakVoice, VoiceError } from "../src/voice.js";

test("readCapped reads a short answer whole and refuses one over the limit, declared or streamed", async () => {
  assert.equal(await readCapped(new Response("hello"), 100), "hello");
  assert.equal(await readCapped(new Response("hello"), 4), undefined);
  assert.equal(await readCapped(new Response(null), 4), "");
  const streamed = new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 50; i += 1) controller.enqueue(new Uint8Array(100)); controller.close(); } }));
  assert.equal(await readCapped(streamed, 1000), undefined);
});

test("a gateway that answers far more than it should is a bad answer, not an exhausted server", async () => {
  const server = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ audio: "A".repeat(2_000_000) })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const gateway = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "t" };
  try {
    await assert.rejects(() => speakVoice(gateway, { text: "hi", language: "en" }, 10_000), (error: unknown) => error instanceof VoiceError && error.message === "voice_bad_answer");
    await assert.rejects(() => askVoice(gateway, { text: "hi" }), (error: unknown) => error instanceof VoiceError && error.message === "voice_bad_answer");
  } finally { server.closeAllConnections(); server.close(); }
});
