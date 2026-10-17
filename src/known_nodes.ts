/**
 * The field nodes that have ever spoken (an electrical node, an alarm panel, a network watcher) and when each last did, kept on disk. Their stores live in memory, so
 * after a restart a node that is dead at that moment is simply not there: nothing was ever going to tell that it had gone quiet, and the check before arming saw nothing wrong.
 * This remembers them. A node that has not spoken since the server started, once the time it is allowed to be silent has gone by, is reported as silent (see AlarmRules and
 * the preflight); the first thing it says afterwards brings it back like any other node.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";

export type KnownKind = "electrical" | "alarm" | "network";
const KINDS: readonly string[] = ["electrical", "alarm", "network"];
export type KnownNode = {
  kind: KnownKind; id: string; last_seen_ms: number;
  /** For an alarm panel: what it was doing when it last spoke (a panel that was disarmed is not news when it goes quiet). */
  phase?: string;
};
const MAX_KNOWN = 256;
const SAVE_EVERY_MS = 30_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/;

export type KnownNodesOptions = { file: string; now?: () => number; warn?: (message: string) => void };

export class KnownNodes {
  readonly #options: KnownNodesOptions;
  readonly #now: () => number;
  readonly #nodes = new Map<string, KnownNode>();
  readonly #startedAt: number;
  readonly #spoke = new Set<string>();
  #lastSave = 0;
  #dirty = false;

  constructor(options: KnownNodesOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    try {
      const stored = JSON.parse(fs.readFileSync(options.file, "utf8")) as { nodes?: unknown };
      if (Array.isArray(stored.nodes)) {
        for (const item of stored.nodes.slice(0, MAX_KNOWN)) {
          if (typeof item !== "object" || item === null) continue;
          const { kind, id, last_seen_ms: seen, phase } = item as Record<string, unknown>;
          if (typeof kind !== "string" || !KINDS.includes(kind) || typeof id !== "string" || !ID.test(id) || typeof seen !== "number" || !Number.isFinite(seen)) continue;
          this.#nodes.set(`${kind}/${id}`, { kind: kind as KnownKind, id, last_seen_ms: seen, ...(typeof phase === "string" ? { phase: phase.slice(0, 20) } : {}) });
        }
      }
    } catch { /* nothing remembered yet */ }
  }

  /** A node spoke. Kept in memory at once, written to disk at most every half minute. */
  seen(kind: KnownKind, id: string, phase?: string): void {
    if (!ID.test(id)) return;
    const key = `${kind}/${id}`;
    this.#spoke.add(key);
    if (!this.#nodes.has(key) && this.#nodes.size >= MAX_KNOWN) return;
    const now = this.#now();
    const before = this.#nodes.get(key);
    this.#nodes.set(key, { kind, id, last_seen_ms: now, ...(phase !== undefined ? { phase } : before?.phase !== undefined ? { phase: before.phase } : {}) });
    this.#dirty = true;
    if (now - this.#lastSave >= SAVE_EVERY_MS) this.flush();
  }

  /** The node was taken away on purpose: it is no longer expected to speak. */
  forget(kind: KnownKind, id: string): boolean {
    this.#spoke.delete(`${kind}/${id}`);
    const known = this.#nodes.delete(`${kind}/${id}`);
    if (known) { this.#dirty = true; this.flush(); }
    return known;
  }

  list(): KnownNode[] { return [...this.#nodes.values()].map(node => ({ ...node })); }

  /**
   * The nodes that were there before this run and have said nothing since it started, once `graceMs` has gone by (the time a node may be silent anyway). Empty before then:
   * a node needs a moment to reconnect after the server comes up.
   */
  silent(graceMs: number): KnownNode[] {
    if (this.#now() - this.#startedAt < graceMs) return [];
    return [...this.#nodes.values()].filter(node => !this.#spoke.has(`${node.kind}/${node.id}`)).map(node => ({ ...node }));
  }

  flush(): void {
    this.#lastSave = this.#now();
    if (!this.#dirty) return;
    this.#dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.#options.file), { recursive: true });
      const temporary = `${this.#options.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, nodes: [...this.#nodes.values()] }), { encoding: "utf8", mode: 0o600 });
      durableRename(temporary, this.#options.file);
    } catch (error) { this.#dirty = true; this.#options.warn?.(`the list of known nodes could not be written: ${(error as Error).message}`); }
  }
}
