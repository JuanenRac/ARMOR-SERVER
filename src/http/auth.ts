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
};

/** What is stored and looked up: never the cookie value itself. */
const keyOf = (id: string): string => createHash("sha256").update(id).digest("hex");

/** In-memory sessions: random ids, absolute expiry, a hard cap and lazy pruning. */
export class SessionStore {
  readonly #sessions = new Map<string, { expiry: number; userId?: string }>();
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
      const saved = JSON.parse(fs.readFileSync(this.#options.file, "utf8")) as { sessions?: Record<string, { expiry?: unknown; userId?: unknown }> };
      const now = this.#now();
      for (const [key, session] of Object.entries(saved.sessions ?? {})) {
        if (/^[0-9a-f]{64}$/.test(key) && typeof session.expiry === "number" && session.expiry > now) this.#sessions.set(key, { expiry: session.expiry, userId: typeof session.userId === "string" ? session.userId : undefined });
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

  #prune(): void {
    const now = this.#now();
    for (const [id, session] of this.#sessions) if (session.expiry <= now) this.#sessions.delete(id);
    const capacity = this.#options.capacity ?? 256;
    // The oldest sessions go first, so a flood of logins cannot grow memory without bound.
    while (this.#sessions.size >= capacity) this.#sessions.delete(this.#sessions.keys().next().value!);
  }

  /** Create a session (for a user, when there is one) and set its HttpOnly cookie. Returns the expiry as an ISO date. */
  open(response: Response, userId?: string): string {
    this.#prune();
    const id = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + this.#options.ttlMs;
    this.#sessions.set(keyOf(id), { expiry: expiresAt, userId });
    this.#save();
    response.cookie(this.#options.cookieName, id, {
      httpOnly: true, sameSite: "strict", secure: this.#options.secure, maxAge: this.#options.ttlMs, path: this.#options.cookiePath,
    });
    return new Date(expiresAt).toISOString();
  }

  has(request: HeaderSource): boolean {
    const id = requestCookies(request)[this.#options.cookieName];
    const key = id ? keyOf(id) : undefined;
    const session = key ? this.#sessions.get(key) : undefined;
    if (!session || session.expiry <= this.#now()) {
      if (key && this.#sessions.delete(key)) this.#save();
      return false;
    }
    return true;
  }

  /** The user a valid session belongs to. */
  userId(request: HeaderSource): string | undefined {
    return this.has(request) ? this.#sessions.get(keyOf(requestCookies(request)[this.#options.cookieName]))?.userId : undefined;
  }

  /** End every session of a user, except the one making this request (so changing your own password does not sign you out). */
  revokeUser(userId: string, keep?: HeaderSource): void {
    const cookie = keep ? requestCookies(keep)[this.#options.cookieName] : undefined, kept = cookie ? keyOf(cookie) : undefined;
    for (const [key, session] of this.#sessions) if (session.userId === userId && key !== kept) this.#sessions.delete(key);
    this.#save();
  }

  close(request: HeaderSource, response: Response): void {
    const id = requestCookies(request)[this.#options.cookieName];
    if (id && this.#sessions.delete(keyOf(id))) this.#save();
    response.clearCookie(this.#options.cookieName, { path: this.#options.cookiePath });
  }
}
