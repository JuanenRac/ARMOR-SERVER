import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { ALERT_LANGUAGES, alertText } from "../src/alert_text.js";
import { telegramChannel, validTelegramChat, validTelegramToken, validWebhookId } from "../src/channels.js";
import { readConfig } from "../src/config.js";
import type { AlertMessage } from "../src/notify.js";
import os from "node:os";
import { SECRETS, startServer, studioCookie, type Running } from "./helpers.js";

const TOKEN = "123456789:AAH-abcdefghijklmnopqrstuvwxyz012345";
const json = { "Content-Type": "application/json" };

type Seen = { url: string; body: Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any

/** A stand-in for the places that receive an alarm: Telegram's API and a Home Assistant webhook. */
async function fakePlaces(options: { telegramStatus?: number } = {}) {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({ url: request.url ?? "", body: raw ? JSON.parse(raw) : {} });
      if ((request.url ?? "").startsWith("/bot")) {
        const status = options.telegramStatus ?? 200;
        response.writeHead(status, json);
        response.end(JSON.stringify(status === 200 ? { ok: true } : { ok: false, description: `Unauthorized: bad token ${TOKEN}` }));
        return;
      }
      response.writeHead(200, json); response.end("{}");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const call = async (running: Running, cookie: string, method: string, url: string, body?: unknown) => {
  const reply = await fetch(`${running.base}${url}`, { method, headers: { ...json, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: reply.status, body: await reply.json().catch(() => ({})) as Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
};

test("every alarm is told in every language, with its numbers and nothing left to fill", () => {
  const base = { service: "armor-server" as const, at: "2000-01-01T10:00:00.000Z", mode: "armed" as const };
  const messages: AlertMessage[] = [
    { ...base, event: "alert.raised", node_id: "nodo-radar-1", targets: 3 }, { ...base, event: "alert.cleared", node_id: "nodo-radar-1" },
    { ...base, event: "node.offline", node_id: "nodo-radar-1" }, { ...base, event: "node.stale", node_id: "nodo-radar-1" }, { ...base, event: "camera.offline", camera_id: "cam-01" },
    { ...base, event: "alarm.raised", severity: "critical", code: "smoke", device_id: "humo-cocina" }, { ...base, event: "automation.notify", automation: "aviso-puerta" }, { ...base, event: "alert.test" },
  ];
  for (const language of ALERT_LANGUAGES) {
    for (const message of messages) {
      const text = alertText(message, language);
      assert.doesNotMatch(text, /\{\d\}/, `${language} ${message.event}`);
      assert.ok(text.includes(base.at), `${language} ${message.event}`);
    }
    assert.ok(alertText(messages[0], language).includes("nodo-radar-1") && alertText(messages[0], language).includes("3"), language);
    assert.ok(alertText(messages[5], language).includes("smoke") && alertText(messages[5], language).includes("humo-cocina"), language);
  }
  assert.match(alertText(messages[0], "es"), /ALERTA en el nodo nodo-radar-1: 3 personas/);
  assert.match(alertText(messages[0], "en"), /ALERT on node nodo-radar-1: 3 people/);
});

test("what Telegram and Home Assistant are given is checked when the server starts", () => {
  assert.equal(validTelegramToken(TOKEN), true);
  assert.equal(validTelegramToken("not-a-token"), false);
  assert.equal(validTelegramChat("-1001234567890") && validTelegramChat("123456789") && validTelegramChat("@mi_canal"), true);
  assert.equal(validTelegramChat("hello"), false);
  assert.equal(validWebhookId("armor-alerts-8f3a2c1d"), true);
  assert.equal(validWebhookId("short"), false);
  const env = { ...SECRETS, ARMOR_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "armor-notify-")) };
  assert.equal(readConfig(env).telegram, null);
  const good = readConfig({ ...env, ARMOR_TELEGRAM_BOT_TOKEN: TOKEN, ARMOR_TELEGRAM_CHAT_IDS: "123456789, -1001234567890", ARMOR_HOMEASSISTANT_URL: "http://192.168.0.20:8123/", ARMOR_HOMEASSISTANT_WEBHOOK_ID: "armor-alerts-8f3a2c1d", ARMOR_ALERT_LANGUAGE: "DE" });
  assert.deepEqual([good.telegram?.chatIds, good.homeAssistant?.url, good.alertLanguage], [["123456789", "-1001234567890"], "http://192.168.0.20:8123", "de"]);
  for (const bad of [
    { ARMOR_TELEGRAM_BOT_TOKEN: TOKEN },
    { ARMOR_TELEGRAM_BOT_TOKEN: "nope", ARMOR_TELEGRAM_CHAT_IDS: "123456789" },
    { ARMOR_TELEGRAM_BOT_TOKEN: TOKEN, ARMOR_TELEGRAM_CHAT_IDS: "hello" },
    { ARMOR_HOMEASSISTANT_URL: "http://192.168.0.20:8123" },
    { ARMOR_HOMEASSISTANT_URL: "ftp://x", ARMOR_HOMEASSISTANT_WEBHOOK_ID: "armor-alerts-8f3a2c1d" },
    { ARMOR_HOMEASSISTANT_URL: "http://user:pass@192.168.0.20:8123", ARMOR_HOMEASSISTANT_WEBHOOK_ID: "armor-alerts-8f3a2c1d" },
    { ARMOR_ALERT_LANGUAGE: "xx" },
  ]) assert.throws(() => readConfig({ ...env, ...bad }), `${JSON.stringify(Object.keys(bad))}`);
});

test("a Telegram refusal is told without the token in it, and a wrong token is not tried again", async () => {
  const places = await fakePlaces({ telegramStatus: 401 });
  try {
    const channel = telegramChannel({ token: TOKEN, chatIds: ["123456789"], api: places.base });
    const attempt = await channel.deliver({ service: "armor-server", event: "alert.test", at: "x", mode: "armed" }, "hello", "en", AbortSignal.timeout(3000));
    assert.equal(attempt.ok, false);
    assert.equal(attempt.final, true);
    assert.match(attempt.detail, /HTTP 401/);
    assert.doesNotMatch(attempt.detail, new RegExp(TOKEN.split(":")[1]));
  } finally { await places.close(); }
});

test("the alarms reach Telegram and Home Assistant, in the language of the installation, and the test button says what each did", async () => {
  const places = await fakePlaces();
  process.env.ARMOR_TELEGRAM_API = places.base;
  const running = await startServer({
    ARMOR_TELEGRAM_BOT_TOKEN: TOKEN, ARMOR_TELEGRAM_CHAT_IDS: "123456789,-1001234567890", ARMOR_HOMEASSISTANT_URL: places.base, ARMOR_HOMEASSISTANT_WEBHOOK_ID: "armor-alerts-8f3a2c1d", ARMOR_ALERT_LANGUAGE: "es",
  });
  try {
    const cookie = await studioCookie(running.base);
    assert.equal((await call(running, "", "GET", "/api/v1/admin/notifications")).status, 401);
    const status = await call(running, cookie, "GET", "/api/v1/admin/notifications");
    assert.deepEqual(status.body, { webhook: false, mqtt: false, telegram: true, homeassistant: true, language: "es" });
    assert.doesNotMatch(JSON.stringify(status.body), /AAH|armor-alerts/);

    // a real alarm
    running.app.context.notifier.send({ service: "armor-server", event: "node.offline", at: "2000-01-01T10:00:00.000Z", mode: "armed", node_id: "nodo-radar-2" });
    await running.app.context.notifier.idle();
    const telegram = places.seen.filter(item => item.url.startsWith(`/bot${TOKEN}/sendMessage`));
    assert.deepEqual(telegram.map(item => item.body.chat_id), ["123456789", "-1001234567890"]);
    assert.match(telegram[0].body.text, /El nodo nodo-radar-2 está sin conexión con el sistema armado/);
    const home = places.seen.find(item => item.url === "/api/webhook/armor-alerts-8f3a2c1d");
    assert.ok(home);
    assert.deepEqual([home.body.event, home.body.node_id, home.body.title], ["node.offline", "nodo-radar-2", "A.R.M.O.R."]);
    assert.match(home.body.text, /nodo-radar-2/);

    // the test button: every place, or the one asked for
    places.seen.length = 0;
    const all = await call(running, cookie, "POST", "/api/v1/admin/notifications/test", {});
    assert.deepEqual(all.body.results.map((item: { channel: string; ok: boolean }) => [item.channel, item.ok]), [["telegram", true], ["homeassistant", true]]);
    assert.match(places.seen[0].body.text, /mensaje de prueba/);
    places.seen.length = 0;
    const one = await call(running, cookie, "POST", "/api/v1/admin/notifications/test", { channel: "homeassistant" });
    assert.deepEqual(one.body.results.map((item: { channel: string }) => item.channel), ["homeassistant"]);
    assert.equal(places.seen.length, 1);
    assert.equal((await call(running, cookie, "POST", "/api/v1/admin/notifications/test", { channel: "fax" })).body.error, "unknown_channel");

    // the audit trail has what was sent where, never the token nor the webhook id
    const audit = fs.readFileSync(path.join(running.config.dataDir, "audit.log"), "utf8");
    assert.match(audit, /alert\.telegram/);
    assert.match(audit, /alert\.homeassistant/);
    assert.match(audit, /alert\.test/);
    assert.doesNotMatch(audit, /AAH-abcdef|armor-alerts-8f3a2c1d/);
  } finally { delete process.env.ARMOR_TELEGRAM_API; await running.stop(); await places.close(); }
});

test("without any place configured the test says so, and the secrets of the settings file are masked", async () => {
  const running = await startServer();
  try {
    const cookie = await studioCookie(running.base);
    const reply = await call(running, cookie, "POST", "/api/v1/admin/notifications/test", {});
    assert.deepEqual([reply.status, reply.body.error], [409, "nothing_configured"]);
  } finally { await running.stop(); }
  const { maskEnv } = await import("../src/admin.js");
  const masked = maskEnv("ARMOR_TELEGRAM_BOT_TOKEN=abc\nARMOR_HOMEASSISTANT_WEBHOOK_ID=secret-id-1234\nARMOR_TELEGRAM_CHAT_IDS=123456789\nARMOR_ALERT_LANGUAGE=es\n");
  assert.doesNotMatch(masked, /abc|secret-id-1234/);
  assert.match(masked, /ARMOR_TELEGRAM_CHAT_IDS=123456789/);
});
