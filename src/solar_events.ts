/**
 * The event log of the battery modules, as far as the solar node has read it: a node asks each module for the newest entry of its own log now and then, so a message carries one entry
 * per module (last_event). Here every entry that is new (a different item index) is kept, newest first, with the time the server saw it, so Studio and the app can show a short log
 * that is read-only and keeps the console's own words (the mnemonics of the protections are never decoded). The log is bounded in modules, in entries and in time.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { SolarEvent, SolarMessage } from "./solar.js";

export type LoggedEvent = { n: number; seen_at: number; event: SolarEvent };
export type EventsFile = Record<string, LoggedEvent[]>;

const KEEP_PER_DEVICE = 60;
const MAX_DEVICES = 64;
const SHOWN = 30;

export class SolarEventLog {
  readonly #log = new Map<string, LoggedEvent[]>();

  /** Looks at a battery message: every module whose newest entry is not the one already kept is added. */
  observe(key: string, message: SolarMessage, at: number): void {
    if (message.kind !== "battery") return;
    for (const module of message.stack) {
      const event = module.last_event;
      if (!module.present || !event) continue;
      let list = this.#log.get(key);
      if (!list) {
        if (this.#log.size >= MAX_DEVICES) return;
        list = [];
        this.#log.set(key, list);
      }
      if (list.some(item => item.n === module.n && item.event.index === event.index && item.event.time === event.time)) continue;
      list.unshift({ n: module.n, seen_at: at, event });
      if (list.length > KEEP_PER_DEVICE) list.length = KEEP_PER_DEVICE;
    }
  }

  /** The newest entries of a battery, newest first (at most thirty). */
  list(key: string): LoggedEvent[] { return (this.#log.get(key) ?? []).slice(0, SHOWN); }

  forget(key: string): void { this.#log.delete(key); }

  export(): EventsFile { return Object.fromEntries(this.#log); }

  import(file: unknown): void {
    if (typeof file !== "object" || file === null || Array.isArray(file)) return;
    for (const [key, list] of Object.entries(file as Record<string, unknown>).slice(0, MAX_DEVICES)) {
      if (!/^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(key) || !Array.isArray(list)) continue;
      const kept: LoggedEvent[] = [];
      for (const raw of list.slice(0, KEEP_PER_DEVICE)) {
        const item = raw as Partial<LoggedEvent> | null;
        const event = item?.event as Partial<SolarEvent> | undefined;
        if (!item || typeof item.n !== "number" || !Number.isInteger(item.n) || item.n < 1 || item.n > 16 || typeof item.seen_at !== "number" || !Number.isFinite(item.seen_at)) continue;
        if (!event || typeof event !== "object" || typeof event.index !== "number" || !Number.isInteger(event.index) || typeof event.time !== "string" || event.time.length > 40) continue;
        kept.push({ n: item.n, seen_at: item.seen_at, event: event as SolarEvent });
      }
      if (kept.length > 0) this.#log.set(key, kept);
    }
  }
}
