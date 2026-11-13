/**
 * The live notices of the console channel (`/api/v1/events`): besides the whole state, the server tells the consoles that something they may be showing changed, so that they read
 * that one thing again instead of asking ten routes every few seconds. A notice is `{ "type": "alarm" | "device" | "solar" | "network" | "design", "id": "...", "version": n }` and
 * nothing else: it carries no reading, no name and no detail (a console that is allowed to read the thing asks for it by its own route, with its own rights), and a silent alarm
 * is never announced. `version` goes up with every notice of the server (for a design it is the revision that was saved), so a client can tell it missed some and read everything again.
 * A client that does not know a type ignores it (the older ones only know `state`), and polling stays as the slow safety net. A burst of notices about the same thing is one notice
 * (the newest) per window. The administrator can turn the notices off (`live.events`); the channel then carries the state only, as before.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export const LIVE_KINDS = ["alarm", "device", "solar", "network", "design"] as const;
export type LiveKind = typeof LIVE_KINDS[number];
export type LiveNotice = { type: LiveKind; id: string; version: number };

export const LIVE_WINDOW_MS = 150;
/** More distinct things than this waiting at once are sent at once instead of kept: the memory used by a storm of notices has a top. */
export const LIVE_MAX_PENDING = 256;
const MAX_ID = 64;

export type LiveOptions = {
  /** The option `live.events`. */
  enabled: () => boolean;
  windowMs?: number;
  timers?: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
};

export class LiveNotices {
  readonly #options: LiveOptions;
  readonly #pending = new Map<string, LiveNotice>();
  #send: ((notice: LiveNotice) => void) | null = null;
  #version = 0;
  #timer: unknown = null;

  constructor(options: LiveOptions) { this.#options = options; }

  /** Where the notices go (the sockets of the console channel). */
  attach(send: (notice: LiveNotice) => void): void { this.#send = send; }

  /** Something changed. `version` is given for a design (its revision); otherwise the counter of the server is used. Never throws. */
  notify(type: LiveKind, id: string, version?: number): void {
    try {
      if (!this.#send || !this.#options.enabled()) return;
      this.#version += 1;
      const notice: LiveNotice = { type, id: String(id).slice(0, MAX_ID), version: version ?? this.#version };
      this.#pending.set(`${type}\u0000${notice.id}`, notice);
      if (this.#pending.size >= LIVE_MAX_PENDING) { this.flush(); return; }
      if (this.#timer !== null) return;
      const timers = this.#options.timers ?? { set: (callback: () => void, ms: number) => { const handle = setTimeout(callback, ms); handle.unref(); return handle; }, clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
      this.#timer = timers.set(() => { this.#timer = null; this.flush(); }, this.#options.windowMs ?? LIVE_WINDOW_MS);
    } catch { /* a notice that cannot be made never stops what changed */ }
  }

  /** Sends what is waiting. */
  flush(): void {
    const send = this.#send;
    const notices = [...this.#pending.values()];
    this.#pending.clear();
    if (!send) return;
    for (const notice of notices) { try { send(notice); } catch { /* one socket that fails never stops the others */ } }
  }

  close(): void {
    if (this.#timer !== null) { const timers = this.#options.timers; if (timers) timers.clear(this.#timer); else clearTimeout(this.#timer as NodeJS.Timeout); this.#timer = null; }
    this.#pending.clear();
  }
}
