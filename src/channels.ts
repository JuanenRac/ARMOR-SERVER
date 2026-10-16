/**
 * Where else an alarm is sent, besides the signed webhook and MQTT: a Telegram chat (through a bot of the installation) and Home Assistant (through the address of one of its
 * webhooks, which an automation of Home Assistant listens to). Each channel makes one attempt; the notifier (notify.ts) retries and audits.
 * A secret - the bot token, the id of the webhook - is part of the address it is sent to, so it is never written in the audit trail or in an error.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { alertTitle, type AlertLanguage } from "./alert_text.js";
import type { AlertMessage } from "./notify.js";

export type Attempt = { ok: boolean; /** What happened, without any secret. */ detail: string; /** A client error will not get better by trying again. */ final?: boolean };
export type NotifyChannel = { id: "telegram" | "homeassistant" | "ntfy" | "fcm"; deliver(message: AlertMessage, text: string, language: AlertLanguage, signal: AbortSignal): Promise<Attempt> };

export type TelegramOptions = { token: string; chatIds: string[]; api?: string; fetchImpl?: typeof fetch };
export type NtfyOptions = { /** The address of the topic, such as https://ntfy.sh/my-armor-topic or the one of a self-hosted ntfy. */ url: string; token?: string; fetchImpl?: typeof fetch };
export type HomeAssistantOptions = { url: string; webhookId: string; fetchImpl?: typeof fetch };

const TELEGRAM_TOKEN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_CHAT = /^(-?\d{3,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const WEBHOOK_ID = /^[A-Za-z0-9_-]{8,128}$/;

export const validTelegramToken = (value: string) => TELEGRAM_TOKEN.test(value);
export const validTelegramChat = (value: string) => TELEGRAM_CHAT.test(value);
export const validWebhookId = (value: string) => WEBHOOK_ID.test(value);

/**
 * One message to every chat of the list. A chat that refuses it (a bot thrown out of a group, an id typed wrong) does not stop the others from getting it, and a retry after a failure
 * of the network or a 429 goes only to the chats that did not get it yet. It is delivered when every chat took it; it is given up (final) when what is left can never work.
 */
export function telegramChannel(options: TelegramOptions): NotifyChannel {
  const doFetch = options.fetchImpl ?? fetch;
  const api = (options.api ?? "https://api.telegram.org").replace(/\/$/, "");
  const delivered = new WeakMap<object, Set<string>>();
  return {
    id: "telegram",
    async deliver(message, text, language, signal) {
      const got = delivered.get(message) ?? new Set<string>();
      delivered.set(message, got);
      let failed = "", retry = false;
      for (const chat of options.chatIds) {
        if (got.has(chat)) continue;
        try {
          const response = await doFetch(`${api}/bot${options.token}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "armor-server" }, redirect: "error", signal,
            body: JSON.stringify({ chat_id: chat, text: `${alertTitle(language)}
${text}`, disable_web_page_preview: true }),
          });
          if (response.ok) { got.add(chat); continue; }
          // Telegram says why in the body (a wrong token, a chat that never talked to the bot); that is worth saying, minus anything that could be the token.
          const reason = ((await response.json().catch(() => ({}))) as { description?: string }).description ?? "";
          failed = `chat ${chat}: HTTP ${response.status}${reason ? ` ${reason.replace(options.token, "***").slice(0, 120)}` : ""}`;
          if (response.status < 400 || response.status >= 500 || response.status === 429) retry = true;
        } catch (error) { failed = `chat ${chat}: ${error instanceof Error ? error.name : "network error"}`; retry = true; }
      }
      return failed ? { ok: false, detail: failed, final: !retry } : { ok: true, detail: `${options.chatIds.length} chat(s)` };
    },
  };
}

/** Home Assistant: the message as JSON on the address of a webhook (`/api/webhook/<id>`), with the sentence for a person added as `text` and `title`. */
export function homeAssistantChannel(options: HomeAssistantOptions): NotifyChannel {
  const doFetch = options.fetchImpl ?? fetch;
  const address = `${options.url.replace(/\/$/, "")}/api/webhook/${options.webhookId}`;
  return {
    id: "homeassistant",
    async deliver(message, text, language, signal) {
      try {
        const response = await doFetch(address, {
          method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "armor-server" }, redirect: "error", signal,
          body: JSON.stringify({ ...message, title: alertTitle(language), text }),
        });
        if (response.ok) return { ok: true, detail: `HTTP ${response.status}` };
        return { ok: false, detail: `HTTP ${response.status}`, final: response.status >= 400 && response.status < 500 && response.status !== 429 };
      } catch (error) { return { ok: false, detail: error instanceof Error ? error.name : "network error" }; }
    },
  };
}

/**
 * ntfy (https://ntfy.sh, or one of your own): a push to the phone with no app of ours - the phone's ntfy app subscribes to the topic. The sentence is the body, the title is the system's,
 * and a critical alarm goes with the highest priority so the phone sounds even in silent mode. The topic address is a secret of the installation: it is never written in an error.
 */
export function ntfyChannel(options: NtfyOptions): NotifyChannel {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    id: "ntfy",
    async deliver(message, text, language, signal) {
      try {
        const priority = message.severity === "critical" || message.event === "alarm.escalated" ? "5" : message.severity === "warning" ? "3" : "4";
        const response = await doFetch(options.url, {
          method: "POST", redirect: "error", signal, body: text,
          headers: { "User-Agent": "armor-server", Title: Buffer.from(alertTitle(language), "utf8").toString("latin1"), Priority: priority, Tags: priority === "5" ? "rotating_light" : "warning",
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
        });
        if (response.ok) return { ok: true, detail: `HTTP ${response.status}` };
        return { ok: false, detail: `HTTP ${response.status}`, final: response.status >= 400 && response.status < 500 && response.status !== 429 };
      } catch (error) { return { ok: false, detail: error instanceof Error ? error.name : "network error" }; }
    },
  };
}
