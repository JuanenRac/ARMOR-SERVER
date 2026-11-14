/**
 * The word "home" or "away" that the phone of each signed-in person tells the server (security option `presence.by_user`, off by default). Only the word and the moment it was told are kept:
 * the position of the phone never reaches the server. A word older than a day is not counted (a phone that went silent says nothing). The sum of the fresh words is what the automations with a
 * presence trigger follow: `everyone_away` when there is at least one fresh word and all of them are away, `someone_home` when one is home, `unknown` when there is none.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";

export type PresenceWord = "home" | "away";
export type PresenceSum = "everyone_away" | "someone_home" | "unknown";
export const PRESENCE_FRESH_MS = 24 * 3600_000;
const MAX_PEOPLE = 200;

export const isPresenceWord = (value: unknown): value is PresenceWord => value === "home" || value === "away";

export class PresenceStore {
  readonly #words = new Map<string, { state: PresenceWord; at: number }>();
  readonly #file: string;
  readonly #now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { schema?: unknown; users?: Record<string, { state?: unknown; at?: unknown }> };
      if (raw?.schema === 1 && raw.users && typeof raw.users === "object") {
        for (const [id, value] of Object.entries(raw.users).slice(0, MAX_PEOPLE)) {
          if (isPresenceWord(value?.state) && typeof value.at === "number" && Number.isFinite(value.at)) this.#words.set(id, { state: value.state, at: value.at });
        }
      }
    } catch { /* none yet */ }
  }

  #fresh(id: string): { state: PresenceWord; at: number } | undefined {
    const word = this.#words.get(id);
    return word && this.#now() - word.at < PRESENCE_FRESH_MS ? word : undefined;
  }

  /** The sum of the fresh words. */
  sum(): PresenceSum {
    let any = false;
    for (const id of this.#words.keys()) {
      const word = this.#fresh(id);
      if (!word) continue;
      if (word.state === "home") return "someone_home";
      any = true;
    }
    return any ? "everyone_away" : "unknown";
  }

  /** Keeps the word of one person; returns the sum before and after, so the caller can tell whether it changed. */
  set(id: string, state: PresenceWord): { before: PresenceSum; after: PresenceSum } {
    const before = this.sum();
    if (!this.#words.has(id) && this.#words.size >= MAX_PEOPLE) this.#words.delete(this.#words.keys().next().value as string);
    this.#words.set(id, { state, at: this.#now() });
    this.#save();
    return { before, after: this.sum() };
  }

  /** The fresh word of one person, or nulls when there is none. */
  mine(id: string): { state: PresenceWord | null; since: string | null } {
    const word = this.#fresh(id);
    return word ? { state: word.state, since: new Date(word.at).toISOString() } : { state: null, since: null };
  }

  /** The fresh words with the name of each person (`nameOf` gives undefined for a person who no longer exists, who is left out). */
  summary(nameOf: (id: string) => string | undefined): { state: PresenceSum; people: Array<{ user: string; state: PresenceWord; since: string }> } {
    const people: Array<{ user: string; state: PresenceWord; since: string }> = [];
    for (const id of this.#words.keys()) {
      const word = this.#fresh(id), user = nameOf(id);
      if (word && user) people.push({ user, state: word.state, since: new Date(word.at).toISOString() });
    }
    return { state: this.sum(), people };
  }

  /** A person who is deleted leaves no word behind. */
  remove(id: string): void {
    if (this.#words.delete(id)) this.#save();
  }

  #save(): void {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, users: Object.fromEntries(this.#words) }, null, 1), { encoding: "utf8", mode: 0o600 });
      durableRename(temporary, this.#file);
    } catch { /* the word stays in memory; the next change tries again */ }
  }
}
