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
  | { type: "camera"; camera_id: string; from: "unknown" | "online" | "offline"; to: "unknown" | "online" | "offline" }
  | { type: "mode"; mode: SecurityMode }
  /** A device changed: a binary field (triggered, open, on, locked, tamper) or whether it is online. */
  | { type: "device"; device_id: string; kind: string; field: string; from: boolean | number | null; to: boolean | number }
  /** The life of an alarm: raised, acknowledged by someone, or cleared because its cause ended. */
  | { type: "alarm"; alarm_id: string; state: "raised" | "acknowledged" | "cleared"; severity: "critical" | "high" | "warning"; source: string; source_type: "node" | "camera" | "device"; code: string };
export type ArmorEvent = ArmorEventBody & { id: number; at: string };

const MAX_BYTES = 5 * 1024 * 1024;
const KEPT_FILES = 3;
export const MAX_PAGE = 200;

/** What an event is about: a node, a camera, a device, an alarm's source, or the mode. */
export function subjectOf(event: ArmorEvent): string {
  switch (event.type) {
    case "alert": case "node": return event.node_id;
    case "camera": return event.camera_id;
    case "device": return event.device_id;
    case "alarm": return event.source;
    case "mode": return event.mode;
  }
}

export type EventSummary = {
  total: number; oldest_at: string | null; newest_at: string | null;
  by_type: Record<ArmorEvent["type"], number>;
  last_24h: { events: number; high_alerts: number; node_incidents: number; camera_incidents: number };
};

export type EventLogOptions = { file: string; capacity?: number; now?: () => Date };

export class EventLog {
  readonly #file: string;
  readonly #capacity: number;
  readonly #now: () => Date;
  #events: ArmorEvent[] = [];
  #nextId = 1;

  constructor(options: EventLogOptions) {
    this.#file = options.file;
    this.#capacity = options.capacity ?? 5000;
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

  /**
   * Newest first (oldest first with `order: "asc"`). `before` is an event id: only older events are
   * returned. `since` and `until` are times in milliseconds; `q` matches the node or camera id (or the
   * mode) as a case-insensitive substring; `level` matches the level an alert moved to.
   */
  list(options: { limit?: number; before?: number; type?: ArmorEvent["type"]; node?: string; since?: number; until?: number; q?: string; level?: AlertLevel; order?: "asc" | "desc" } = {}): ArmorEvent[] {
    const limit = Math.max(1, Math.min(MAX_PAGE, Math.trunc(options.limit ?? 50)));
    const ascending = options.order === "asc";
    const matches = (event: ArmorEvent): boolean => {
      if (options.before !== undefined && (ascending ? event.id <= options.before : event.id >= options.before)) return false;
      if (options.type && event.type !== options.type) return false;
      if (options.node && subjectOf(event) !== options.node) return false;
      if (options.level && !(event.type === "alert" && event.to === options.level)) return false;
      if (options.since !== undefined || options.until !== undefined) {
        const time = Date.parse(event.at);
        if (options.since !== undefined && time < options.since) return false;
        if (options.until !== undefined && time > options.until) return false;
      }
      if (options.q) {
        if (!subjectOf(event).toLowerCase().includes(options.q.toLowerCase())) return false;
      }
      return true;
    };
    const out: ArmorEvent[] = [];
    if (ascending) {
      for (let index = 0; index < this.#events.length && out.length < limit; index += 1) if (matches(this.#events[index])) out.push(this.#events[index]);
    } else {
      for (let index = this.#events.length - 1; index >= 0 && out.length < limit; index -= 1) if (matches(this.#events[index])) out.push(this.#events[index]);
    }
    return out;
  }

  /** Counts for the summary strip: everything held, and what happened in the last day. */
  summary(now = this.#now().getTime()): EventSummary {
    const dayAgo = now - 86_400_000;
    const summary: EventSummary = {
      total: this.#events.length, oldest_at: this.#events[0]?.at ?? null, newest_at: this.#events.at(-1)?.at ?? null,
      by_type: { alert: 0, node: 0, camera: 0, mode: 0, device: 0, alarm: 0 },
      last_24h: { events: 0, high_alerts: 0, node_incidents: 0, camera_incidents: 0 },
    };
    for (const event of this.#events) {
      summary.by_type[event.type] += 1;
      if (Date.parse(event.at) < dayAgo) continue;
      summary.last_24h.events += 1;
      if (event.type === "alert" && event.to === "high") summary.last_24h.high_alerts += 1;
      if (event.type === "node" && (event.to === "offline" || event.to === "stale")) summary.last_24h.node_incidents += 1;
      if (event.type === "camera" && event.to === "offline") summary.last_24h.camera_incidents += 1;
    }
    return summary;
  }

  /**
   * Remove events for good, from memory and from every log file: those older than `before` (a time in
   * milliseconds), those of one `type`, or both together; with neither, all of them. Event numbers are
   * never reused. Returns how many were removed and how many remain.
   */
  delete(options: { before?: number; type?: ArmorEvent["type"] } = {}): { deleted: number; remaining: number } {
    const doomed = (event: ArmorEvent): boolean =>
      (options.type === undefined || event.type === options.type) && (options.before === undefined || Date.parse(event.at) < options.before);
    const all = this.#readFromDisk();
    // Whatever is still only in memory (a failed write) counts too.
    const known = new Set(all.map(event => event.id));
    for (const event of this.#events) if (!known.has(event.id)) all.push(event);
    all.sort((a, b) => a.id - b.id);
    const kept = all.filter(event => !doomed(event));
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.tmp`;
      fs.writeFileSync(temporary, kept.map(event => JSON.stringify(event) + "\n").join(""), { encoding: "utf8", mode: 0o600 });
      for (let index = 1; index <= KEPT_FILES; index += 1) fs.rmSync(`${this.#file}.${index}`, { force: true });
      fs.renameSync(temporary, this.#file);
      // Numbers of removed events must never come back, even if the newest ones were the ones removed.
      fs.writeFileSync(`${this.#file}.next`, String(this.#nextId), { encoding: "utf8", mode: 0o600 });
    } catch { /* If the rewrite fails the memory below still reflects the request; the next start reads what is on disk. */ }
    this.#events = kept.slice(-this.#capacity);
    return { deleted: all.length - kept.length, remaining: kept.length };
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

  /** Every event in the log files, oldest first (the rotated files, then the current one). */
  #readFromDisk(): ArmorEvent[] {
    const events: ArmorEvent[] = [];
    const files = Array.from({ length: KEPT_FILES }, (_, index) => `${this.#file}.${KEPT_FILES - index}`).concat(this.#file);
    for (const file of files) {
      let text: string;
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as ArmorEvent;
          if (Number.isInteger(event.id) && typeof event.at === "string" && typeof event.type === "string") events.push(event);
        } catch { /* A torn last line after a crash is skipped. */ }
      }
    }
    return events;
  }

  #restore(): void {
    const events = this.#readFromDisk();
    for (const event of events) this.#nextId = Math.max(this.#nextId, event.id + 1);
    try {
      const floor = Number(fs.readFileSync(`${this.#file}.next`, "utf8").trim());
      if (Number.isInteger(floor) && floor > this.#nextId) this.#nextId = floor;
    } catch { /* No deletion has happened yet. */ }
    this.#events = events.length > this.#capacity ? events.slice(-this.#capacity) : events;
  }
}
