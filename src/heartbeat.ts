/**
 * The dead-man ping: while the option `heartbeat.enabled` is on and an address was given (ARMOR_HEARTBEAT_URL), the server asks that address with a plain GET every
 * ARMOR_HEARTBEAT_INTERVAL_S seconds. A service outside the house (healthchecks.io, ntfy, a Home Assistant webhook) that stops hearing it tells the owner that the server is
 * down, which nothing inside a dead server can do. The request carries nothing of the installation: no name, state or token, only the address itself (which may hold the
 * secret path some of those services use, so it is never shown, logged or put in the settings). A failure is counted and never reaches what the server does.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export type HeartbeatState = { enabled: boolean; configured: boolean; last_ok_at: string | null; last_error: string | null; sent: number; failed: number };

/** An address the ping may use: http or https, no sign-in in it, at most 300 characters; undefined when it is not one. */
export function parseHeartbeatUrl(value: string): string | undefined {
  if (value.length === 0 || value.length > 300 || /\s/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export class Heartbeat {
  readonly #options: { url: string; everyS: number; enabled: () => boolean; fetchImpl?: typeof fetch; now?: () => number };
  #timer: NodeJS.Timeout | undefined;
  #sent = 0; #failed = 0;
  #lastOk: string | null = null; #lastError: string | null = null;

  constructor(options: { url: string; everyS: number; enabled: () => boolean; fetchImpl?: typeof fetch; now?: () => number }) { this.#options = options; }

  /** One ping if the option is on and there is an address. Returns whether it was sent and answered 2xx. */
  async beat(): Promise<boolean> {
    if (!this.#options.url || !this.#options.enabled()) return false;
    this.#sent += 1;
    try {
      const reply = await (this.#options.fetchImpl ?? fetch)(this.#options.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "armor-server-heartbeat" } });
      if (!reply.ok) throw new Error(`answered ${reply.status}`);
      this.#lastOk = new Date((this.#options.now ?? Date.now)()).toISOString(); this.#lastError = null;
      return true;
    } catch (error) {
      this.#failed += 1;
      this.#lastError = (error instanceof Error ? error.message : "failed").replace(/https?:\/\/\S+/g, "<address>").slice(0, 120);
      return false;
    }
  }

  start(): void {
    if (this.#timer || !this.#options.url) return;
    this.#timer = setInterval(() => void this.beat(), this.#options.everyS * 1000);
    this.#timer.unref();
  }

  stop(): void { if (this.#timer) { clearInterval(this.#timer); this.#timer = undefined; } }

  get state(): HeartbeatState {
    return { enabled: this.#options.enabled(), configured: this.#options.url !== "", last_ok_at: this.#lastOk, last_error: this.#lastError, sent: this.#sent, failed: this.#failed };
  }
}
