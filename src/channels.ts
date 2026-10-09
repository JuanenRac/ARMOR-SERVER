/**
 * Where else an alarm is sent, besides the signed webhook and MQTT: a Telegram chat (through a bot of the installation) and Home Assistant (through the address of one of its
 * webhooks, which an automation of Home Assistant listens to). Each channel makes one attempt; the notifier (notify.ts) retries and audits.
 * A secret - the bot token, the id of the webhook - is part of the address it is sent to, so it is never written in the audit trail or in an error.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { alertTitle, type AlertLanguage } from "./alert_text.js";
import type { AlertMessage } from "./notify.js";

export type Attempt = { ok: boolean; /** What happened, without any secret. */ detail: string; /** A client error will not get better by trying again. */ final?: boolean };
export type NotifyChannel = { id: "telegram" | "homeassistant"; deliver(message: AlertMessage, text: string, language: AlertLanguage, signal: AbortSignal): Promise<Attempt> };

export type TelegramOptions = { token: string; chatIds: string[]; api?: string; fetchImpl?: typeof fetch };
export type HomeAssistantOptions = { url: string; webhookId: string; fetchImpl?: typeof fetch };

const TELEGRAM_TOKEN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_CHAT = /^(-?\d{3,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const WEBHOOK_ID = /^[A-Za-z0-9_-]{8,128}$/;

export const validTelegramToken = (value: string) => TELEGRAM_TOKEN.test(value);
export const validTelegramChat = (value: string) => TELEGRAM_CHAT.test(value);
export const validWebhookId = (value: string) => WEBHOOK_ID.test(value);

/** One message to every chat of the list; it is delivered when every chat took it. */
export function telegramChannel(options: TelegramOptions): NotifyChannel {
  const doFetch = options.fetchImpl ?? fetch;
  const api = (options.api ?? "https://api.telegram.org").replace(/\/$/, "");
  return {
    id: "telegram",
    async deliver(_message, text, language, signal) {
      let failed = "";
      for (const chat of options.chatIds) {
        try {
          const response = await doFetch(`${api}/bot${options.token}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "armor-server" }, redirect: "error", signal,
            body: JSON.stringify({ chat_id: chat, text: `${alertTitle(language)}\n${text}`, disable_web_page_preview: true }),
          });
          if (!response.ok) {
            // Telegram says why in the body (a wrong token, a chat that never talked to the bot); that is worth saying, minus anything that could be the token.
            const reason = ((await response.json().catch(() => ({}))) as { description?: string }).description ?? "";
            failed = `chat ${chat}: HTTP ${response.status}${reason ? ` ${reason.replace(options.token, "***").slice(0, 120)}` : ""}`;
            if (response.status >= 400 && response.status < 500 && response.status !== 429) return { ok: false, detail: failed, final: true };
          }
        } catch (error) { failed = `chat ${chat}: ${error instanceof Error ? error.name : "network error"}`; }
      }
      return failed ? { ok: false, detail: failed } : { ok: true, detail: `${options.chatIds.length} chat(s)` };
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
