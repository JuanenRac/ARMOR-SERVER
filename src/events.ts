/**
 * A.R.M.O.R. event history: what changed and when (alert level, node status,
 * security mode). One JSON line per event in the data directory with rotation,
 * plus a bounded in-memory window for the API. Never holds a secret.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import type { AlertLevel, SecurityMode } from "./store.js";

export type NodeStatus = "online" | "offline" | "stale";
export type ArmorEventBody =
  | { type: "alert"; node_id: string; from: AlertLevel; to: AlertLevel; targets: number }
  | { type: "node"; node_id: string; from: NodeStatus | null; to: NodeStatus }
  | { type: "mode"; mode: SecurityMode };
export type ArmorEvent = ArmorEventBody & { id: number; at: string };

const MAX_BYTES = 5 * 1024 * 1024;
const KEPT_FILES = 3;
export const MAX_PAGE = 200;

export type EventLogOptions = { file: string; capacity?: number; now?: () => Date };

export class EventLog {
  readonly #file: string;
  readonly #capacity: number;
  readonly #now: () => Date;
  #events: ArmorEvent[] = [];
  #nextId = 1;

  constructor(options: EventLogOptions) {
    this.#file = options.file;
    this.#capacity = options.capacity ?? 1000;
    this.#now = options.now ?? (() => new Date());
    this.#restore();
  }

  append(body: ArmorEventBody): ArmorEvent {
    const event = { ...body, id: this.#nextId, at: this.#now().toISOString() } as ArmorEvent;
    this.#nextId += 1;
    this.#events.push(event);
    if (this.#events.length > this.#capacity) this.#events.splice(0, this.#events.length - this.#capacity);
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      this.#rotate();
      fs.appendFileSync(this.#file, JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
    } catch { /* The history must never break the change it records. */ }
    return event;
  }

  /** Newest first. `before` is an event id: only older events are returned. */
  list(options: { limit?: number; before?: number; type?: ArmorEvent["type"]; node?: string } = {}): ArmorEvent[] {
    const limit = Math.max(1, Math.min(MAX_PAGE, Math.trunc(options.limit ?? 50)));
    const out: ArmorEvent[] = [];
    for (let index = this.#events.length - 1; index >= 0 && out.length < limit; index -= 1) {
      const event = this.#events[index];
      if (options.before !== undefined && event.id >= options.before) continue;
      if (options.type && event.type !== options.type) continue;
      if (options.node && !("node_id" in event && event.node_id === options.node)) continue;
      out.push(event);
    }
    return out;
  }

  #rotate(): void {
    try {
      if (fs.statSync(this.#file).size < MAX_BYTES) return;
      for (let index = KEPT_FILES - 1; index >= 1; index -= 1) {
        if (fs.existsSync(`${this.#file}.${index}`)) fs.renameSync(`${this.#file}.${index}`, `${this.#file}.${index + 1}`);
      }
      fs.renameSync(this.#file, `${this.#file}.1`);
    } catch { /* No file yet, or rotation raced: the next write retries. */ }
  }

  #restore(): void {
    for (const file of [`${this.#file}.1`, this.#file]) {
      let text: string;
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as ArmorEvent;
          if (Number.isInteger(event.id) && typeof event.at === "string" && typeof event.type === "string") {
            this.#events.push(event);
            this.#nextId = Math.max(this.#nextId, event.id + 1);
          }
        } catch { /* A torn last line after a crash is skipped. */ }
      }
    }
    if (this.#events.length > this.#capacity) this.#events = this.#events.slice(-this.#capacity);
  }
}
