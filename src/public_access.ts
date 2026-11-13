/**
 * Hardening of the server when its port is opened to the Internet (router port forwarding). Nothing here opens a port: it decides what a request from outside the house may do.
 *
 *   - The Studio option `network.public_access` (off, the default) lets requests from outside the house in at all. Off, every one of them is answered 403 `public_access_off`.
 *   - It concerns requests that reach the port itself (a router forwarding it). A request through the reverse proxy of ARMOR_TRUST_PROXY, the documented door, is not touched.
 *   - Even when it is on, such a request must have come over TLS (the server's own certificate),
 *     and the server must have strong secrets (control token of 32 characters or more, sign-in password of 12 or more); if not, the answer is 403 `public_access_unsafe` with the reasons.
 *   - Failed sign-ins from outside are counted by address: ARMOR_PUBLIC_LOGIN_ATTEMPTS failures inside ARMOR_PUBLIC_LOGIN_WINDOW_S seconds close that address with 429 until the window passes.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */

export interface PublicAccessFacts {
  /** The server has its own HTTPS listener (a request that reaches the port itself needs it; behind a reverse proxy this check does not apply). */
  ownTls: boolean;
  controlTokenLength: number;
  studioPasswordLength: number;
  cookieSecure: boolean;
}

export const MIN_PUBLIC_TOKEN_LENGTH = 32;
export const MIN_PUBLIC_PASSWORD_LENGTH = 12;

/** Why the server must not take requests from the Internet yet (empty: nothing in the way). The codes are stable: Studio and the guide name them. */
export function publicAccessProblems(facts: PublicAccessFacts): string[] {
  const problems: string[] = [];
  if (!facts.ownTls) problems.push("tls_missing");
  if (facts.controlTokenLength < MIN_PUBLIC_TOKEN_LENGTH) problems.push("control_token_short");
  if (facts.studioPasswordLength < MIN_PUBLIC_PASSWORD_LENGTH) problems.push("password_short");
  if (!facts.cookieSecure) problems.push("cookie_not_secure");
  return problems;
}

export type PublicDecision =
  | { allow: true }
  | { allow: false; status: 403; error: "public_access_off" | "public_access_unsafe" | "tls_required"; problems?: string[] };

/** What to do with a request: `remote` is its origin (not the house, not the VPN), `secure` whether it arrived over TLS. */
export function decidePublicRequest(input: { remote: boolean; secure: boolean; enabled: boolean; problems: string[] }): PublicDecision {
  if (!input.remote) return { allow: true };
  if (!input.enabled) return { allow: false, status: 403, error: "public_access_off" };
  if (input.problems.length > 0) return { allow: false, status: 403, error: "public_access_unsafe", problems: input.problems };
  if (!input.secure) return { allow: false, status: 403, error: "tls_required" };
  return { allow: true };
}

/** Counts failed sign-ins by address inside a window; the clock is given so that a test needs no waiting. */
export class PublicLoginLimiter {
  readonly #failures = new Map<string, number[]>();
  constructor(private readonly maxFailures: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  #recent(address: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.#failures.get(address) ?? []).filter(at => at > cutoff);
    if (kept.length === 0) this.#failures.delete(address); else this.#failures.set(address, kept);
    return kept;
  }

  /** Seconds the address must wait (0: it may try). */
  retryAfterS(address: string): number {
    const kept = this.#recent(address);
    if (kept.length < this.maxFailures) return 0;
    const first = kept[kept.length - this.maxFailures] ?? this.now();
    return Math.max(1, Math.ceil((first + this.windowMs - this.now()) / 1000));
  }

  fail(address: string): void {
    const kept = this.#recent(address);
    kept.push(this.now());
    this.#failures.set(address, kept.slice(-Math.max(this.maxFailures, 1) * 2));
    if (this.#failures.size > 10_000) this.#failures.delete(this.#failures.keys().next().value as string);   // an address flood must not grow the table without end
  }

  succeed(address: string): void { this.#failures.delete(address); }
}
