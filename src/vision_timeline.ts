/**
 * The review timeline of the vision service: the events of the zones (a person entered, stayed in or loitered in an alert zone or a detection zone) kept, newest first, with the evidence
 * that was taken when they were seen, so that a person can go through them in Studio. It is a security option (`vision.timeline`, off by default: nothing is kept while it is off) and what
 * it keeps is bounded twice: by age (`vision.timeline_days`, an administrator changes it in Studio) and by number (ARMOR_VISION_TIMELINE_MAX_ENTRIES). It keeps no picture and no box:
 * the evidence is the id of a photo or recording of the evidence library, which has its own retention.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { durableRename } from "./durable.js";

export type TimelineLevel = "alert" | "detection";
export type TimelineItem = {
  id: string; at: string; camera_id: string; level: TimelineLevel; zone_id: string; zone_name: string; label: string;
  confidence?: number; alarm_id: string | null; snapshot_id: string | null; clip_id: string | null;
};
export type TimelineQuery = { since?: string; level?: TimelineLevel; camera_id?: string; limit?: number };
export const TIMELINE_ID = /^vt-[0-9a-f]{8,32}$/;
export const TIMELINE_CAMERA = /^[A-Za-z0-9._-]{1,80}$/;
export const TIMELINE_LIMIT = { min: 1, max: 500, default: 100 } as const;

export class TimelineQueryInvalid extends Error {}

/** Reads the query string of GET /api/v1/vision/timeline; a filter that is not valid is refused, never guessed. */
export function parseTimelineQuery(query: Record<string, unknown>): TimelineQuery {
  const out: TimelineQuery = {};
  const text = (name: string): string | undefined => {
    const value = query[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new TimelineQueryInvalid(`${name} must be a single value`);
    return value;
  };
  const since = text("since");
  if (since !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(since) || Number.isNaN(Date.parse(since))) throw new TimelineQueryInvalid("since must be a date and time such as 2030-01-01T00:00:00Z");
    out.since = new Date(since).toISOString();
  }
  const level = text("level");
  if (level !== undefined) { if (level !== "alert" && level !== "detection") throw new TimelineQueryInvalid("level must be alert or detection"); out.level = level; }
  const camera = text("camera_id");
  if (camera !== undefined) { if (!TIMELINE_CAMERA.test(camera)) throw new TimelineQueryInvalid("camera_id is not valid"); out.camera_id = camera; }
  const limit = text("limit");
  if (limit !== undefined) {
    if (!/^\d{1,4}$/.test(limit) || Number(limit) < TIMELINE_LIMIT.min || Number(limit) > TIMELINE_LIMIT.max) throw new TimelineQueryInvalid(`limit must be a whole number from ${TIMELINE_LIMIT.min} to ${TIMELINE_LIMIT.max}`);
    out.limit = Number(limit);
  }
  return out;
}

export type TimelineOptions = {
  file: string;
  /** The switch `vision.timeline`. */
  enabled: () => boolean;
  /** `vision.timeline_days`. */
  days: () => number;
  /** The most entries kept (the oldest go first). */
  maxEntries: number;
  now?: () => number;
};

export class VisionTimeline {
  #items: TimelineItem[] = [];   // newest first
  readonly #now: () => number;

  constructor(private readonly options: TimelineOptions) {
    this.#now = options.now ?? Date.now;
    try {
      const raw = JSON.parse(fs.readFileSync(options.file, "utf8")) as { items?: unknown };
      if (Array.isArray(raw.items)) this.#items = raw.items.filter(isItem).slice(0, options.maxEntries);
    } catch { this.#items = []; }
  }

  enabled(): boolean { return this.options.enabled(); }
  days(): number { return this.options.days(); }

  /** Keeps one event; null (and nothing kept) while the option is off. The entry is returned so that the evidence can be added when it has been taken. */
  add(entry: Omit<TimelineItem, "id" | "at" | "alarm_id" | "snapshot_id" | "clip_id"> & { alarm_id?: string | null }): TimelineItem | null {
    if (!this.options.enabled()) return null;
    this.#prune();
    const item: TimelineItem = { id: `vt-${randomBytes(8).toString("hex")}`, at: new Date(this.#now()).toISOString(), ...entry, alarm_id: entry.alarm_id ?? null, snapshot_id: null, clip_id: null };
    this.#items.unshift(item);
    if (this.#items.length > this.options.maxEntries) this.#items.length = this.options.maxEntries;
    this.#save();
    return { ...item };
  }

  /** Adds the evidence once it has been taken; an entry that was deleted or pruned meanwhile is left alone. */
  setEvidence(id: string, evidence: { snapshot_id?: string | null; clip_id?: string | null }): boolean {
    const item = this.#items.find(entry => entry.id === id);
    if (!item) return false;
    if (evidence.snapshot_id !== undefined) item.snapshot_id = evidence.snapshot_id;
    if (evidence.clip_id !== undefined) item.clip_id = evidence.clip_id;
    this.#save();
    return true;
  }

  setAlarm(id: string, alarmId: string): void {
    const item = this.#items.find(entry => entry.id === id);
    if (item) { item.alarm_id = alarmId; this.#save(); }
  }

  list(query: TimelineQuery = {}): TimelineItem[] {
    this.#prune();
    const since = query.since === undefined ? undefined : Date.parse(query.since);
    return this.#items
      .filter(item => (since === undefined || Date.parse(item.at) > since) && (query.level === undefined || item.level === query.level) && (query.camera_id === undefined || item.camera_id === query.camera_id))
      .slice(0, query.limit ?? TIMELINE_LIMIT.default).map(item => ({ ...item }));
  }

  remove(id: string): boolean {
    const before = this.#items.length;
    this.#items = this.#items.filter(item => item.id !== id);
    if (this.#items.length === before) return false;
    this.#save();
    return true;
  }

  clear(): number {
    const count = this.#items.length;
    this.#items = [];
    if (count > 0) this.#save();
    return count;
  }

  #prune(): void {
    const cutoff = this.#now() - this.options.days() * 86_400_000;
    const kept = this.#items.filter(item => Date.parse(item.at) > cutoff);
    if (kept.length !== this.#items.length) { this.#items = kept; this.#save(); }
  }

  #save(): void {
    const temporary = `${this.options.file}.tmp`;
    fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ items: this.#items }), { mode: 0o600 });
    durableRename(temporary, this.options.file);
  }
}

function isItem(value: unknown): value is TimelineItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && TIMELINE_ID.test(item.id) && typeof item.at === "string" && !Number.isNaN(Date.parse(item.at)) && typeof item.camera_id === "string"
    && (item.level === "alert" || item.level === "detection") && typeof item.zone_id === "string" && typeof item.zone_name === "string" && typeof item.label === "string";
}
