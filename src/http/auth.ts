/**
 * A.R.M.O.R. authentication primitives: constant-time comparison, cookie
 * parsing and bounded, expiring session tables.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { Response } from "express";

/** Anything that can read a request header: an Express request, or a plain HTTP one wrapped by the caller. */
export type HeaderSource = { header(name: string): string | undefined };

/** Compare two secrets without leaking their length or content through timing. */
export function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  // Compare against a same-length buffer so a length mismatch costs the same.
  const padded = Buffer.alloc(a.length);
  b.copy(padded, 0, 0, Math.min(a.length, b.length));
  return timingSafeEqual(a, padded) && a.length === b.length;
}

/** True when the request carries `Authorization: Bearer <token>` for exactly this token. */
export function hasBearer(request: HeaderSource, token: string): boolean {
  const header = request.header("authorization") ?? "";
  return header.startsWith("Bearer ") && secureEquals(header.slice(7), token);
}

export function requestCookies(request: HeaderSource): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const raw of (request.header("cookie") ?? "").split(";")) {
    const part = raw.trim();
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    try { cookies[part.slice(0, separator)] = decodeURIComponent(part.slice(separator + 1)); } catch { /* Ignore an undecodable cookie. */ }
  }
  return cookies;
}

export type SessionOptions = {
  cookieName: string; cookiePath: string; ttlMs: number; secure: boolean; capacity?: number;
  /** Where the sessions are kept so a restart (an update, a reboot) does not sign everyone out. Only a hash of each session id is written. */
  file?: string;
  /** A session that came from outside the house is asked to be used: with no request for this long it ends (milliseconds; none when absent). */
  remoteIdleMs?: number;
  /** Told when a session ends for a reason other than the person asking for a new one: it ran out (`expired`), the person signed out (`logout`) or it was ended from the list of sessions (`revoked`). */
  onEnd?: (ended: EndedSession, reason: "expired" | "logout" | "revoked") => void;
};

/** What is known of a session that has just ended (never its cookie). */
export type EndedSession = { userId?: string; origin?: "local" | "remote"; ip?: string; agent?: string };

/** What is known of a session besides who it belongs to: where it came from and when, so the person can see their sessions and end the ones they do not know. */
export type SessionMeta = { origin?: "local" | "remote"; ip?: string; agent?: string; ttlMs?: number };
type SessionRecord = { expiry: number; userId?: string; origin?: "local" | "remote"; ip?: string; agent?: string; created?: number; lastSeen?: number; ttlMs?: number; elevatedUntil?: number };
export type SessionView = { id: string; created: number; last_seen: number; origin: "local" | "remote"; ip: string; agent: string; current: boolean };

/** What is stored and looked up: never the cookie value itself. */
const keyOf = (id: string): string => createHash("sha256").update(id).digest("hex");

/** In-memory sessions: random ids, absolute expiry, a hard cap and lazy pruning. */
export class SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #options: SessionOptions;
  readonly #now: () => number;

  constructor(options: SessionOptions, now: () => number = Date.now) {
    this.#options = options;
    this.#now = now;
    this.#load();
  }

  #load(): void {
    if (!this.#options.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.#options.file, "utf8")) as { sessions?: Record<string, Record<string, unknown>> };
      const now = this.#now();
      const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
      const text = (value: unknown, max: number): string | undefined => (typeof value === "string" ? value.slice(0, max) : undefined);
      for (const [key, session] of Object.entries(saved.sessions ?? {})) {
        if (/^[0-9a-f]{64}$/.test(key) && typeof session.expiry === "number" && session.expiry > now) {
          this.#sessions.set(key, { expiry: session.expiry, userId: typeof session.userId === "string" ? session.userId : undefined, origin: session.origin === "remote" ? "remote" : session.origin === "local" ? "local" : undefined,
            ip: text(session.ip, 64), agent: text(session.agent, 120), created: num(session.created), lastSeen: num(session.lastSeen), ttlMs: num(session.ttlMs), elevatedUntil: num(session.elevatedUntil) });
        }
      }
    } catch { /* No file yet, or an unreadable one: start with no sessions. */ }
  }

  #timer: NodeJS.Timeout | undefined;
  /** Written a moment after a change, and at most once in that moment. */
  #save(): void {
    const file = this.#options.file;
    if (!file || this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; this.flush(); }, 500);
    this.#timer.unref();
  }

  /** Write the sessions now (also used on shutdown). */
  flush(): void {
    const file = this.#options.file;
    if (!file) return;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    try {
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, sessions: Object.fromEntries(this.#sessions) }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch { /* Losing the file only means signing in again after a restart. */ }
  }

  get size(): number { return this.#sessions.size; }

  /** Ends the sessions whose time is over (and tells `onEnd`), without waiting for someone to use or open a session. Called now and then by the server. */
  sweep(): void {
    const now = this.#now(), idle = this.#options.remoteIdleMs;
    let changed = false;
    for (const [key, session] of this.#sessions) {
      if (session.expiry <= now || (idle && session.origin === "remote" && now - (session.lastSeen ?? session.created ?? 0) > idle)) { this.#drop(key, session, "expired"); changed = true; }
    }
    if (changed) this.#save();
  }

  #drop(key: string, session: SessionRecord, reason: "expired" | "logout" | "revoked"): void {
    this.#sessions.delete(key);
    try { this.#options.onEnd?.({ userId: session.userId, origin: session.origin, ip: session.ip, agent: session.agent }, reason); } catch { /* telling about it never stops it */ }
  }

  /** How many open sessions a user has whose agent is of this family (to count the sessions of a client in the list of connections). */
  openFor(userId: string | undefined, matches: (agent: string) => boolean): number {
    const now = this.#now();
    let count = 0;
    for (const session of this.#sessions.values()) if (session.expiry > now && session.userId === userId && matches(session.agent ?? "")) count += 1;
    return count;
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, session] of this.#sessions) if (session.expiry <= now) this.#drop(id, session, "expired");
    const capacity = this.#options.capacity ?? 256;
    // The oldest sessions go first, so a flood of logins cannot grow memory without bound.
    while (this.#sessions.size >= capacity) this.#sessions.delete(this.#sessions.keys().next().value!);
  }

  /** Create a session (for a user, when there is one) and set its HttpOnly cookie. Returns the expiry as an ISO date. */
  open(response: Response, userId?: string, meta: SessionMeta = {}): string {
    this.#prune();
    const id = randomBytes(32).toString("base64url");
    const ttlMs = meta.ttlMs ?? this.#options.ttlMs;
    const now = this.#now();
    const expiresAt = now + ttlMs;
    this.#sessions.set(keyOf(id), { expiry: expiresAt, userId, origin: meta.origin, ip: meta.ip?.slice(0, 64), agent: meta.agent?.slice(0, 120), created: now, lastSeen: now, ...(meta.ttlMs ? { ttlMs: meta.ttlMs } : {}) });
    this.#save();
    response.cookie(this.#options.cookieName, id, {
      httpOnly: true, sameSite: "strict", secure: this.#options.secure, maxAge: ttlMs, path: this.#options.cookiePath,
    });
    return new Date(expiresAt).toISOString();
  }

  has(request: HeaderSource): boolean {
    const id = requestCookies(request)[this.#options.cookieName];
    const key = id ? keyOf(id) : undefined;
    const session = key ? this.#sessions.get(key) : undefined;
    const idle = this.#options.remoteIdleMs;
    if (!session || session.expiry <= this.#now() || (idle && session.origin === "remote" && this.#now() - (session.lastSeen ?? session.created ?? 0) > idle)) {
      if (key && session) { this.#drop(key, session, "expired"); this.#save(); }
      else if (key && this.#sessions.delete(key)) this.#save();
      return false;
    }
    return true;
  }

  #current(request: HeaderSource): { key: string; session: SessionRecord } | undefined {
    const id = requestCookies(request)[this.#options.cookieName];
    const key = id ? keyOf(id) : undefined;
    const session = key && this.has(request) ? this.#sessions.get(key) : undefined;
    return key && session ? { key, session } : undefined;
  }

  /** Where the session of this request came from; sessions made before this was recorded count as local. */
  originOf(request: HeaderSource): "local" | "remote" | undefined { const found = this.#current(request); return found ? found.session.origin ?? "local" : undefined; }

  /** The sessions of a user, newest first. `id` is a short prefix of the hash of the cookie: enough to end that session, useless to take it over. */
  list(userId: string, request?: HeaderSource): SessionView[] {
    const mine = request ? this.#current(request)?.key : undefined;
    const now = this.#now();
    return [...this.#sessions].filter(([, session]) => session.userId === userId && session.expiry > now)
      .map(([key, session]) => ({ id: key.slice(0, 16), created: session.created ?? 0, last_seen: session.lastSeen ?? session.created ?? 0, origin: session.origin ?? "local" as const, ip: session.ip ?? "", agent: session.agent ?? "", current: key === mine }))
      .sort((a, b) => b.created - a.created);
  }

  /** Ends one session of the user by its short id; false when there is none. */
  revokeId(userId: string, shortId: string): boolean {
    if (!/^[0-9a-f]{16}$/.test(shortId)) return false;
    for (const [key, session] of this.#sessions) if (session.userId === userId && key.startsWith(shortId)) { this.#drop(key, session, "revoked"); this.#save(); return true; }
    return false;
  }

  /** The session of this request has proved itself again (password or second factor) and may do critical things until `untilMs`. */
  elevate(request: HeaderSource, untilMs: number): boolean { const found = this.#current(request); if (!found) return false; found.session.elevatedUntil = untilMs; this.#save(); return true; }
  elevated(request: HeaderSource): boolean { return (this.#current(request)?.session.elevatedUntil ?? 0) > this.#now(); }

  /**
   * A session in use does not run out: once more than half of its life is gone, the next request that carries it gets a full life again
   * (and the cookie is set again with it). A session nobody uses still ends at its time. Returns whether it was renewed.
   */
  renew(request: HeaderSource, response: Response): boolean {
    const id = requestCookies(request)[this.#options.cookieName];
    const session = id ? this.#sessions.get(keyOf(id)) : undefined;
    const now = this.#now();
    if (!id || !session || session.expiry <= now) return false;
    const idle = this.#options.remoteIdleMs;
    if (idle && session.origin === "remote" && now - (session.lastSeen ?? session.created ?? 0) > idle) return false;   // gone: has() ends it
    session.lastSeen = now;
    const ttlMs = session.ttlMs ?? this.#options.ttlMs;
    if (session.expiry - now > ttlMs / 2) return false;
    session.expiry = now + ttlMs;
    this.#save();
    response.cookie(this.#options.cookieName, id, {
      httpOnly: true, sameSite: "strict", secure: this.#options.secure, maxAge: ttlMs, path: this.#options.cookiePath,
    });
    return true;
  }

  /** A stable handle for the session of a request (a hash, never the cookie), to keep something per session. */
  handleOf(request: HeaderSource): string | undefined {
    return this.has(request) ? keyOf(requestCookies(request)[this.#options.cookieName]!) : undefined;
  }

  /** The user a valid session belongs to. */
  userId(request: HeaderSource): string | undefined {
    return this.has(request) ? this.#sessions.get(keyOf(requestCookies(request)[this.#options.cookieName]))?.userId : undefined;
  }

  /** End every session of a user, except the one making this request (so changing your own password does not sign you out). */
  revokeUser(userId: string, keep?: HeaderSource): void {
    const cookie = keep ? requestCookies(keep)[this.#options.cookieName] : undefined, kept = cookie ? keyOf(cookie) : undefined;
    for (const [key, session] of this.#sessions) if (session.userId === userId && key !== kept) this.#drop(key, session, "revoked");
    this.#save();
  }

  close(request: HeaderSource, response: Response): void {
    const id = requestCookies(request)[this.#options.cookieName];
    const session = id ? this.#sessions.get(keyOf(id)) : undefined;
    if (id && session) { this.#drop(keyOf(id), session, "logout"); this.#save(); }
    response.clearCookie(this.#options.cookieName, { path: this.#options.cookiePath });
  }
}
