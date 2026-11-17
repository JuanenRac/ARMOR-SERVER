/**
 * The record kept apart of every silent duress alarm that was raised (a disarm or a lowering of the mode with the duress PIN, a spoken disarm, the hidden gesture, the panic phrase): how many
 * and, for the latest ones, when, who and how. With the option alarm.duress_hide_trail on, the audit trail and the history show a duress disarm exactly as a normal one, so what tells the two
 * apart lives only here, and only an administrator with a recent proof of identity reads it (GET /api/v1/alarm/duress-log). Nothing here is ever shown to a console, a panel or a place
 * the alarms go to.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";

/** How the duress alarm was raised. */
export const DURESS_VIA = ["pin", "mode_pin", "voice_pin", "panic_gesture", "panic_phrase"] as const;
export type DuressVia = (typeof DURESS_VIA)[number];
export type DuressEntry = { at: string; actor: string; via: DuressVia; alarm_id?: string };
export type DuressLogView = { count: number; entries: DuressEntry[] };

/** The latest entries kept (the count goes on past it). */
const MAX_ENTRIES = 200;

export class DuressLog {
  readonly #file: string;
  readonly #now: () => Date;
  readonly #warn: ((message: string) => void) | undefined;
  #count = 0;
  #entries: DuressEntry[] = [];

  constructor(file: string, now: () => Date = () => new Date(), warn?: (message: string) => void) {
    this.#file = file;
    this.#now = now;
    this.#warn = warn;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { count?: unknown; entries?: unknown };
      if (typeof raw.count === "number" && Number.isSafeInteger(raw.count) && raw.count >= 0) this.#count = raw.count;
      if (Array.isArray(raw.entries)) {
        for (const item of raw.entries.slice(-MAX_ENTRIES)) {
          const entry = item as Partial<DuressEntry>;
          if (typeof entry.at === "string" && typeof entry.actor === "string" && (DURESS_VIA as readonly unknown[]).includes(entry.via)) {
            this.#entries.push({ at: entry.at, actor: entry.actor.slice(0, 60), via: entry.via as DuressVia, ...(typeof entry.alarm_id === "string" ? { alarm_id: entry.alarm_id.slice(0, 32) } : {}) });
          }
        }
      }
      this.#count = Math.max(this.#count, this.#entries.length);
    } catch { /* nothing kept yet */ }
  }

  /** One more duress alarm. Written at once: a power cut right after must not lose the only thing that tells it from a normal disarm. */
  add(actor: string, via: DuressVia, alarmId?: string): void {
    this.#count += 1;
    this.#entries.push({ at: this.#now().toISOString(), actor: actor.slice(0, 60), via, ...(alarmId ? { alarm_id: alarmId } : {}) });
    if (this.#entries.length > MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - MAX_ENTRIES);
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, count: this.#count, entries: this.#entries }), { encoding: "utf8", mode: 0o600 });
      durableRename(temporary, this.#file);
    } catch (error) { this.#warn?.(`the duress record could not be written: ${(error as Error).message}`); }
  }

  /** The count and the entries, newest first (copies). */
  view(): DuressLogView { return { count: this.#count, entries: this.#entries.map(entry => ({ ...entry })).reverse() }; }
}
