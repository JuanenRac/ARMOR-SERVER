/**
 * A.R.M.O.R. event history: what changed and when (alert level, node status,
 * security mode). One JSON line per event in the data directory with rotation,
 * plus a bounded in-memory window for the API. Never holds a secret.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import type { AlertLevel, SecurityMode } from "./store.js";
import { durableRename } from "./durable.js";

export type NodeStatus = "online" | "offline" | "stale";
export type ClientKind = "studio" | "android" | "node" | "voice" | "other";
export type ConnectionAction = "first_seen" | "login" | "login_failed" | "second_factor_failed" | "logout" | "session_ended" | "session_expired" | "panel_opened";
export type SystemCategory = "node" | "broker" | "settings" | "service" | "update" | "alarm" | "backup";
export type SystemAction = "appeared" | "returned" | "disappeared" | "firmware_changed" | "connected" | "disconnected" | "created" | "changed" | "removed" | "started" | "stopped" | "restarted" | "checked" | "installed" | "rolled_back"
  | "armed" | "disarmed" | "silenced" | "acknowledged" | "arm_requested" | "disarm_requested" | "silence_requested" | "backup_made" | "backup_restored";
export type ArmorEventBody =
  | { type: "alert"; node_id: string; from: AlertLevel; to: AlertLevel; targets: number }
  | { type: "node"; node_id: string; from: NodeStatus | null; to: NodeStatus }
  | { type: "camera"; camera_id: string; from: "unknown" | "online" | "offline"; to: "unknown" | "online" | "offline" }
  | { type: "mode"; mode: SecurityMode }
  /** A device changed: a binary field (triggered, open, on, locked, tamper) or whether it is online. */
  | { type: "device"; device_id: string; kind: string; field: string; from: boolean | number | null; to: boolean | number }
  /**
   * A client that connects to the server (a Studio session, the Android app, the panel of a node, the voice service...). Never a password, token, cookie or PIN. `ip` and `agent` are written here and
   * taken out of what anybody but an administrator reads (see `redactEvent`).
   */
  | { type: "connection"; action: ConnectionAction; client_kind: ClientKind; client_id: string; user?: string; origin?: "local" | "remote"; two_factor?: boolean; app_version?: string; subject?: string; ip?: string; agent?: string }
  /** The system itself: a node that appears, the broker, a setting that changed (who and what, never the value), a service, an update, the alarm armed or silenced. A fixed vocabulary: no free text. */
  | { type: "system"; category: SystemCategory; action: SystemAction; subject?: string; by?: string; version?: string; previous_version?: string; profile?: string; outcome?: "allowed" | "denied" | "failed" }
  /** The life of an alarm: raised, acknowledged by someone, or cleared because its cause ended. */
  | { type: "alarm"; alarm_id: string; state: "raised" | "acknowledged" | "cleared"; severity: "critical" | "high" | "warning"; source: string; source_type: "node" | "camera" | "device" | "solar" | "electrical" | "network" | "alarm"; code: string; /** A silent alarm: told only to the places nobody at the panel can see, never written in the history (see alarms.ts). */ silent?: true };
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
    case "connection": return event.subject ?? event.user ?? event.client_kind;
    case "system": return event.subject ?? event.category;
  }
}

/** What the people who are not administrators may read of an event: a connection loses the address and the user agent of the client. */
export function redactEvent<T extends ArmorEvent>(event: T, admin: boolean): T {
  if (admin || event.type !== "connection") return event;
  const { ip: _ip, agent: _agent, ...rest } = event;
  return rest as unknown as T;
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
  list(options: { limit?: number; before?: number; type?: ArmorEvent["type"]; node?: string; since?: number; until?: number; q?: string; level?: AlertLevel; order?: "asc" | "desc"; category?: SystemCategory; kind?: ClientKind; client?: string; user?: string; /** Without it the connection and system events are left out (a client that only knows the older kinds of event does not meet new ones). */ everything?: boolean } = {}): ArmorEvent[] {
    const limit = Math.max(1, Math.min(MAX_PAGE, Math.trunc(options.limit ?? 50)));
    const ascending = options.order === "asc";
    const matches = (event: ArmorEvent): boolean => {
      if (options.before !== undefined && (ascending ? event.id <= options.before : event.id >= options.before)) return false;
      if (options.type && event.type !== options.type) return false;
      if (!options.type && !options.everything && (event.type === "connection" || event.type === "system")) return false;
      if (options.category && !(event.type === "system" && event.category === options.category)) return false;
      if (options.kind && !(event.type === "connection" && event.client_kind === options.kind)) return false;
      if (options.client && !(event.type === "connection" && event.client_id === options.client)) return false;
      if (options.user) {
        const wanted = options.user.toLowerCase();
        if (!((event.type === "connection" && event.user?.toLowerCase() === wanted) || (event.type === "system" && event.by?.toLowerCase() === wanted))) return false;
      }
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
    // The total and the last day count the events the history shows by default; the connections and the events of the system are counted apart, in `by_type`.
    const shown = this.#events.filter(event => event.type !== "connection" && event.type !== "system");
    const summary: EventSummary = {
      total: shown.length, oldest_at: shown[0]?.at ?? null, newest_at: shown.at(-1)?.at ?? null,
      by_type: { alert: 0, node: 0, camera: 0, mode: 0, device: 0, alarm: 0, connection: 0, system: 0 },
      last_24h: { events: 0, high_alerts: 0, node_incidents: 0, camera_incidents: 0 },
    };
    for (const event of this.#events) {
      summary.by_type[event.type] += 1;
      if (event.type === "connection" || event.type === "system") continue;
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
      durableRename(temporary, this.#file);
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
