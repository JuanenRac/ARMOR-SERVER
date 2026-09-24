/**
 * A.R.M.O.R. authentication primitives: constant-time comparison, cookie
 * parsing and bounded, expiring session tables.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
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

export type SessionOptions = { cookieName: string; cookiePath: string; ttlMs: number; secure: boolean; capacity?: number };

/** In-memory sessions: random ids, absolute expiry, a hard cap and lazy pruning. */
export class SessionStore {
  readonly #sessions = new Map<string, number>();
  readonly #options: SessionOptions;
  readonly #now: () => number;

  constructor(options: SessionOptions, now: () => number = Date.now) {
    this.#options = options;
    this.#now = now;
  }

  get size(): number { return this.#sessions.size; }

  #prune(): void {
    const now = this.#now();
    for (const [id, expiry] of this.#sessions) if (expiry <= now) this.#sessions.delete(id);
    const capacity = this.#options.capacity ?? 256;
    // The oldest sessions go first, so a flood of logins cannot grow memory without bound.
    while (this.#sessions.size >= capacity) this.#sessions.delete(this.#sessions.keys().next().value!);
  }

  /** Create a session and set its HttpOnly cookie. Returns the expiry as an ISO date. */
  open(response: Response): string {
    this.#prune();
    const id = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + this.#options.ttlMs;
    this.#sessions.set(id, expiresAt);
    response.cookie(this.#options.cookieName, id, {
      httpOnly: true, sameSite: "strict", secure: this.#options.secure, maxAge: this.#options.ttlMs, path: this.#options.cookiePath,
    });
    return new Date(expiresAt).toISOString();
  }

  has(request: HeaderSource): boolean {
    const id = requestCookies(request)[this.#options.cookieName];
    const expiry = id ? this.#sessions.get(id) : undefined;
    if (!expiry || expiry <= this.#now()) {
      if (id) this.#sessions.delete(id);
      return false;
    }
    return true;
  }

  close(request: HeaderSource, response: Response): void {
    const id = requestCookies(request)[this.#options.cookieName];
    if (id) this.#sessions.delete(id);
    response.clearCookie(this.#options.cookieName, { path: this.#options.cookiePath });
  }
}
