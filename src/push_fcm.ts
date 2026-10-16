/**
 * Push to the Android phones through Firebase Cloud Messaging, for whoever wants it. It is OFF unless ARMOR_FCM_SERVICE_ACCOUNT names the JSON file of a Firebase service account (the
 * installation's own Firebase project: nothing here goes through anybody else's), and it only ever sends what the other channels send: the line of an alarm. A phone registers the token that
 * Firebase gave its app (POST /api/v1/push/register, with its signed-in session); the server keeps the tokens in its data directory and drops one that Firebase says is gone. The access
 * token for Firebase is made from the service account's private key (a signed JWT exchanged at Google's token endpoint) and kept for most of its hour. Nothing here is written to a log
 * with a token, a key or an address in it.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { alertTitle, type AlertLanguage } from "./alert_text.js";
import { durableRename } from "./durable.js";
import type { NotifyChannel } from "./channels.js";

export class FcmInvalid extends Error {}

export type FcmServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri: string };

export function parseServiceAccount(text: string): FcmServiceAccount {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new FcmInvalid("the service account file is not JSON"); }
  if (typeof value !== "object" || value === null) throw new FcmInvalid("the service account file is not an object");
  const record = value as Record<string, unknown>;
  const field = (name: string): string => {
    const item = record[name];
    if (typeof item !== "string" || !item.trim()) throw new FcmInvalid(`the service account has no ${name}`);
    return item;
  };
  const account = { project_id: field("project_id"), client_email: field("client_email"), private_key: field("private_key"), token_uri: typeof record.token_uri === "string" ? record.token_uri : "https://oauth2.googleapis.com/token" };
  if (!/^[a-z0-9][a-z0-9-]{4,60}$/.test(account.project_id)) throw new FcmInvalid("the project id of the service account is not valid");
  if (!account.private_key.includes("BEGIN PRIVATE KEY")) throw new FcmInvalid("the private key of the service account is not a PEM key");
  if (!/^https:\/\//.test(account.token_uri)) throw new FcmInvalid("the token address of the service account is not HTTPS");
  return account;
}

const TOKEN = /^[A-Za-z0-9:_.\-]{20,4096}$/;
export const MAX_DEVICES = 50;

/** The phones that asked for push: the token of each, kept in a file of the data directory. */
export class FcmDevices {
  #tokens: string[] = [];
  constructor(private readonly file: string) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(stored)) this.#tokens = stored.filter((item): item is string => typeof item === "string" && TOKEN.test(item)).slice(0, MAX_DEVICES);
    } catch { this.#tokens = []; }
  }
  list(): string[] { return [...this.#tokens]; }
  count(): number { return this.#tokens.length; }
  add(token: unknown): boolean {
    if (typeof token !== "string" || !TOKEN.test(token)) throw new FcmInvalid("invalid token");
    if (this.#tokens.includes(token)) return false;
    if (this.#tokens.length >= MAX_DEVICES) this.#tokens.shift();   // the oldest registration makes room for the new one
    this.#tokens.push(token);
    this.#save();
    return true;
  }
  remove(token: string): boolean {
    const before = this.#tokens.length;
    this.#tokens = this.#tokens.filter(item => item !== token);
    if (this.#tokens.length === before) return false;
    this.#save();
    return true;
  }
  #save(): void {
    const temporary = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(this.#tokens), { mode: 0o600 });
    durableRename(temporary, this.file);
  }
}

export type FcmOptions = { account: FcmServiceAccount; devices: FcmDevices; fetchImpl?: typeof fetch; now?: () => number };

const base64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

/** The signed request for an access token (RFC 7523): exported for the tests. */
export function signedAssertion(account: FcmServiceAccount, nowSeconds: number): string {
  const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: account.token_uri, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(account.private_key);
  return `${head}.${claim}.${base64url(signature)}`;
}

export function fcmChannel(options: FcmOptions): NotifyChannel {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let access: { value: string; until: number } | undefined;
  const accessToken = async (signal: AbortSignal): Promise<string> => {
    if (access && access.until > now()) return access.value;
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(options.account, Math.floor(now() / 1000)) });
    const reply = await doFetch(options.account.token_uri, { method: "POST", redirect: "error", signal, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!reply.ok) throw new Error(`token HTTP ${reply.status}`);
    const answer = await reply.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof answer.access_token !== "string") throw new Error("no access token");
    const seconds = typeof answer.expires_in === "number" ? answer.expires_in : 3600;
    access = { value: answer.access_token, until: now() + Math.max(60, seconds - 300) * 1000 };
    return access.value;
  };
  return {
    id: "fcm",
    async deliver(message, text, language: AlertLanguage, signal) {
      const tokens = options.devices.list();
      if (tokens.length === 0) return { ok: true, detail: "no phones registered" };
      try {
        const bearer = await accessToken(signal);
        const critical = message.severity === "critical" || message.event === "alarm.escalated";
        let delivered = 0;
        for (const token of tokens) {
          const reply = await doFetch(`https://fcm.googleapis.com/v1/projects/${options.account.project_id}/messages:send`, {
            method: "POST", redirect: "error", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
            body: JSON.stringify({ message: { token, notification: { title: alertTitle(language), body: text }, data: { event: String(message.event), severity: String(message.severity ?? "") },
              android: { priority: "HIGH", notification: { channel_id: critical ? "armor_critical" : "armor_warning" } } } }),
          });
          if (reply.ok) { delivered += 1; continue; }
          if (reply.status === 404 || reply.status === 410) options.devices.remove(token);   // Firebase says that phone's app is gone
        }
        return delivered > 0 ? { ok: true, detail: `${delivered}/${tokens.length} phone(s)` } : { ok: false, detail: `0/${tokens.length} phone(s)` };
      } catch (error) { return { ok: false, detail: error instanceof Error ? error.name : "network error" }; }
    },
  };
}
