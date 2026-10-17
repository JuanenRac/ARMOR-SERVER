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
/** One person's phones: a person has a few, and a viewer's account must not be able to push everybody else's out. */
export const MAX_PER_USER = 5;

/** There is no room for another phone (the list is full of other people's). */
export class FcmFull extends FcmInvalid {}

/** A phone that asked for push: the token of its app, who registered it, and when. A token with no user was registered with the operator token of a service. */
export type FcmDevice = { token: string; user: string; registered_at: string };

/** The phones that asked for push, kept in a file of the data directory and bound to the person who registered each, so that taking the person away takes their phones away. */
export class FcmDevices {
  #devices: FcmDevice[] = [];
  constructor(private readonly file: string) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(stored)) {
        for (const item of stored.slice(0, MAX_DEVICES)) {
          // The first versions kept bare tokens; those are kept with no user (they are rebound when the phone's app registers again).
          if (typeof item === "string" && TOKEN.test(item)) this.#devices.push({ token: item, user: "", registered_at: "" });
          else if (typeof item === "object" && item !== null) {
            const { token, user, registered_at: at } = item as Record<string, unknown>;
            if (typeof token === "string" && TOKEN.test(token)) this.#devices.push({ token, user: typeof user === "string" ? user.slice(0, 60) : "", registered_at: typeof at === "string" ? at : "" });
          }
        }
      }
    } catch { this.#devices = []; }
  }
  list(): string[] { return this.#devices.map(device => device.token); }
  entries(): FcmDevice[] { return this.#devices.map(device => ({ ...device })); }
  count(): number { return this.#devices.length; }
  forUser(user: string): number { return this.#devices.filter(device => device.user === user).length; }
  /** Registers (or rebinds) a phone. True when the token is new. At most MAX_PER_USER per person (the oldest of theirs makes room); a full list is not emptied of other people's phones. */
  add(token: unknown, user = ""): boolean {
    if (typeof token !== "string" || !TOKEN.test(token)) throw new FcmInvalid("invalid token");
    const existing = this.#devices.find(device => device.token === token);
    const now = new Date().toISOString();
    if (existing) {
      if (existing.user === user) return false;
      existing.user = user; existing.registered_at = now;
      this.#save();
      return false;
    }
    if (user !== "") {
      const own = this.#devices.filter(device => device.user === user);
      if (own.length >= MAX_PER_USER) this.#devices = this.#devices.filter(device => device !== own[0]);   // the oldest of this person's phones makes room
    }
    if (this.#devices.length >= MAX_DEVICES) {
      const unbound = this.#devices.findIndex(device => device.user === "");
      if (unbound < 0) throw new FcmFull("too many phones");
      this.#devices.splice(unbound, 1);
    }
    this.#devices.push({ token, user, registered_at: now });
    this.#save();
    return true;
  }
  remove(token: string): boolean {
    const before = this.#devices.length;
    this.#devices = this.#devices.filter(item => item.token !== token);
    if (this.#devices.length === before) return false;
    this.#save();
    return true;
  }
  /** The person was removed, or their password or role changed (their sessions were closed): their phones stop receiving until the app registers again with a new session. */
  removeUser(user: string): number {
    if (user === "") return 0;
    const before = this.#devices.length;
    this.#devices = this.#devices.filter(item => item.user !== user);
    if (this.#devices.length !== before) this.#save();
    return before - this.#devices.length;
  }
  /** The person changed their user name: their phones stay theirs. */
  rename(from: string, to: string): void {
    if (from === "" || from === to) return;
    let changed = false;
    for (const device of this.#devices) if (device.user === from) { device.user = to.slice(0, 60); changed = true; }
    if (changed) this.#save();
  }
  #save(): void {
    const temporary = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(this.#devices), { mode: 0o600 });
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

/** The notification channels the Android app creates (ARMOR-ANDROID-CONTROL, AlarmNotifier): the id the server names is the one the phone has, or Android drops the message into a silent default. */
export const FCM_CHANNEL = { critical: "armor_alarm_critical", warning: "armor_alarm_warning", other: "armor_alarm" } as const;
export const fcmChannelFor = (message: { severity?: string; event?: string }): string =>
  message.severity === "critical" || message.event === "alarm.escalated" ? FCM_CHANNEL.critical : message.severity === "warning" ? FCM_CHANNEL.warning : FCM_CHANNEL.other;

const REQUEST_TIMEOUT_MS = 8_000;
const CONCURRENCY = 4;

export function fcmChannel(options: FcmOptions): NotifyChannel {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let access: { value: string; until: number } | undefined;
  /** Which phones already got which message, so a retry after a partial failure goes only to the ones that did not. */
  const delivered = new WeakMap<object, Set<string>>();
  const accessToken = async (): Promise<string> => {
    if (access && access.until > now()) return access.value;
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(options.account, Math.floor(now() / 1000)) });
    const reply = await doFetch(options.account.token_uri, { method: "POST", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!reply.ok) throw new Error(`token HTTP ${reply.status}`);
    const answer = await reply.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof answer.access_token !== "string") throw new Error("no access token");
    const seconds = typeof answer.expires_in === "number" ? answer.expires_in : 3600;
    access = { value: answer.access_token, until: now() + Math.max(60, seconds - 300) * 1000 };
    return access.value;
  };
  return {
    id: "fcm",
    async deliver(message, text, language: AlertLanguage) {
      const got = delivered.get(message) ?? new Set<string>();
      delivered.set(message, got);
      const pending = options.devices.list().filter(token => !got.has(token));
      if (pending.length === 0) return { ok: true, detail: got.size > 0 ? `${got.size} phone(s)` : "no phones registered" };
      try {
        const bearer = await accessToken();
        const channelId = fcmChannelFor(message);
        let failed = 0, retry = false;
        const send = async (token: string): Promise<void> => {
          // Each phone has its own time limit: one that does not answer must not cut the others short, or make the retry send the message again to the ones that already have it.
          try {
            const reply = await doFetch(`https://fcm.googleapis.com/v1/projects/${options.account.project_id}/messages:send`, {
              method: "POST", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
              body: JSON.stringify({ message: { token, notification: { title: alertTitle(language), body: text }, data: { event: String(message.event), severity: String(message.severity ?? "") },
                android: { priority: "HIGH", notification: { channel_id: channelId } } } }),
            });
            if (reply.ok) { got.add(token); return; }
            const reason = (await reply.text().catch(() => "")).slice(0, 500);
            // Firebase says that phone's app is gone (404/410), or that the token is not a registration token at all (400): either way it is never going to work.
            if (reply.status === 404 || reply.status === 410 || (reply.status === 400 && /registration token|UNREGISTERED/i.test(reason))) { options.devices.remove(token); return; }
            failed += 1;
            if (reply.status >= 500 || reply.status === 429 || reply.status === 401) retry = true;
          } catch { failed += 1; retry = true; }
        };
        for (let index = 0; index < pending.length; index += CONCURRENCY) await Promise.all(pending.slice(index, index + CONCURRENCY).map(send));
        if (failed === 0) return { ok: true, detail: `${got.size} phone(s)` };
        return { ok: false, detail: `${got.size}/${got.size + failed} phone(s)`, final: !retry };
      } catch (error) { return { ok: false, detail: error instanceof Error ? error.name : "network error" }; }
    },
  };
}
