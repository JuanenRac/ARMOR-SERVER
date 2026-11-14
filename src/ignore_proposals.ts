/**
 * The areas to ignore that the observation service proposes (a tree that waves, a road) while the setting `ai.learn` is on. One proposal waits per camera until an administrator accepts it
 * (its rectangles are added to the areas the camera ignores) or rejects it (it is dropped and the same rectangles are not proposed again). Nothing is applied by itself.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";
import { CAMERA_ID } from "./cameras/model.js";
import { MAX_IGNORE_ZONES, parseIgnoreZones, type IgnoreZone } from "./ignore_zones.js";

/** How many rejected sets a camera remembers (the oldest are forgotten first). */
const REMEMBERED_REJECTIONS = 20;

export type ProposalReason = "empty" | "rejected_before" | "unchanged";

const keyOf = (zones: IgnoreZone[]): string => JSON.stringify([...zones].sort((a, b) => a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h).map(zone => [zone.x, zone.y, zone.w, zone.h]));

export class IgnoreProposals {
  #pending = new Map<string, IgnoreZone[]>();
  #rejected = new Map<string, string[]>();

  constructor(private readonly file: string) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { pending?: Record<string, unknown>; rejected?: Record<string, unknown> };
      for (const [camera, zones] of Object.entries(stored.pending ?? {})) {
        if (!CAMERA_ID.test(camera)) continue;
        try { const parsed = parseIgnoreZones(zones); if (parsed.length) this.#pending.set(camera, parsed); } catch { /* one damaged entry loses only its own camera's proposal */ }
      }
      for (const [camera, keys] of Object.entries(stored.rejected ?? {})) {
        if (CAMERA_ID.test(camera) && Array.isArray(keys)) this.#rejected.set(camera, keys.filter((key): key is string => typeof key === "string").slice(-REMEMBERED_REJECTIONS));
      }
    } catch { this.#pending = new Map(); this.#rejected = new Map(); }
  }

  /** Keeps the proposal of a camera unless it is empty, the same as the one that waits, or the same as one that was rejected. */
  propose(camera: string, value: unknown): { stored: true } | { stored: false; reason: ProposalReason } {
    const zones = parseIgnoreZones(value);
    if (!zones.length) return { stored: false, reason: "empty" };
    const key = keyOf(zones);
    if (this.#rejected.get(camera)?.includes(key)) return { stored: false, reason: "rejected_before" };
    const waiting = this.#pending.get(camera);
    if (waiting && keyOf(waiting) === key) return { stored: false, reason: "unchanged" };
    this.#pending.set(camera, zones);
    this.#save();
    return { stored: true };
  }

  get(camera: string): IgnoreZone[] | undefined {
    const zones = this.#pending.get(camera);
    return zones ? zones.map(zone => ({ ...zone })) : undefined;
  }

  list(): Array<{ camera_id: string; zones: IgnoreZone[] }> {
    return [...this.#pending].map(([camera_id, zones]) => ({ camera_id, zones: zones.map(zone => ({ ...zone })) }));
  }

  /** Takes the proposal away when it is decided; a rejected one is remembered so that the same rectangles do not come back. */
  decide(camera: string, accepted: boolean): void {
    const zones = this.#pending.get(camera);
    if (!zones) return;
    this.#pending.delete(camera);
    if (!accepted) this.#rejected.set(camera, [...(this.#rejected.get(camera) ?? []), keyOf(zones)].slice(-REMEMBERED_REJECTIONS));
    this.#save();
  }

  /** A camera that is deleted takes its proposals with it. */
  forget(camera: string): void {
    const had = this.#pending.delete(camera);
    const hadRejected = this.#rejected.delete(camera);
    if (had || hadRejected) this.#save();
  }

  /** The areas the camera would ignore after accepting: the ones it has and the new ones, never more than the limit. Undefined when it would pass the limit. */
  static merge(current: IgnoreZone[], proposed: IgnoreZone[]): IgnoreZone[] | undefined {
    const merged = [...current];
    const have = new Set(current.map(zone => keyOf([zone])));
    for (const zone of proposed) if (!have.has(keyOf([zone]))) { merged.push(zone); have.add(keyOf([zone])); }
    return merged.length > MAX_IGNORE_ZONES ? undefined : merged;
  }

  #save(): void {
    const temporary = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ pending: Object.fromEntries(this.#pending), rejected: Object.fromEntries(this.#rejected) }, null, 2), { mode: 0o600 });
    durableRename(temporary, this.file);
  }
}
