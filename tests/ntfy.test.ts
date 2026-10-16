import assert from "node:assert/strict";
import test from "node:test";
import { ntfyChannel } from "../src/channels.js";
import { readConfig } from "../src/config.js";
import type { AlertMessage } from "../src/notify.js";

const message = (patch: Partial<AlertMessage>): AlertMessage => ({ service: "armor-server", event: "alarm.raised", at: "2000-01-01T00:00:00.000Z", mode: "armed", severity: "critical", code: "smoke", ...patch });

test("ntfy gets the sentence as the body, the title of the system and the highest priority for a critical alarm", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const channel = ntfyChannel({ url: "https://ntfy.example/armor-topic", token: "secret-token", fetchImpl: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch });
  const result = await channel.deliver(message({}), "Smoke in the kitchen", "en", AbortSignal.timeout(2000));
  assert.deepEqual(result, { ok: true, detail: "HTTP 200" });
  assert.equal(calls[0].url, "https://ntfy.example/armor-topic");
  assert.equal(calls[0].init.body, "Smoke in the kitchen");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Priority, "5");
  assert.equal(headers.Authorization, "Bearer secret-token");
  const warning = await channel.deliver(message({ severity: "warning" }), "x", "en", AbortSignal.timeout(2000));
  assert.equal(warning.ok, true);
  assert.equal((calls[1].init.headers as Record<string, string>).Priority, "3");
});

test("a refused topic is final, a network failure is retried and the address never appears in the detail", async () => {
  const refuse = ntfyChannel({ url: "https://ntfy.example/armor-topic", fetchImpl: (async () => new Response("no", { status: 403 })) as unknown as typeof fetch });
  assert.deepEqual(await refuse.deliver(message({}), "x", "en", AbortSignal.timeout(2000)), { ok: false, detail: "HTTP 403", final: true });
  const down = ntfyChannel({ url: "https://ntfy.example/armor-topic", fetchImpl: (async () => { throw new TypeError("fetch failed https://ntfy.example/armor-topic"); }) as unknown as typeof fetch });
  const lost = await down.deliver(message({}), "x", "en", AbortSignal.timeout(2000));
  assert.equal(lost.ok, false);
  assert.equal(lost.final, undefined);
  assert.equal(lost.detail.includes("armor-topic"), false);
});

test("the address of the topic is checked when the server starts", () => {
  const base = { ARMOR_INGEST_TOKEN: "i".repeat(30), ARMOR_CONTROL_TOKEN: "c".repeat(30) + "1", ARMOR_STUDIO_USERNAME: "admin", ARMOR_STUDIO_PASSWORD: "a-long-enough-password-1" } as NodeJS.ProcessEnv;
  assert.throws(() => readConfig({ ...base, ARMOR_NTFY_URL: "ftp://x/y" }), /ARMOR_NTFY_URL/);
  assert.throws(() => readConfig({ ...base, ARMOR_NTFY_URL: "https://user:pw@ntfy.sh/topic" }), /ARMOR_NTFY_URL/);
  assert.throws(() => readConfig({ ...base, ARMOR_NTFY_URL: "https://ntfy.sh/" }), /ARMOR_NTFY_URL/);
  assert.equal(readConfig({ ...base, ARMOR_NTFY_URL: "https://ntfy.sh/my-topic" }).ntfy?.url, "https://ntfy.sh/my-topic");
});
