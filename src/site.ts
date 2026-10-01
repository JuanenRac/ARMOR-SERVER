/**
 * The site design (terrain, buildings, cameras' and radars' places, devices' places) kept on the server, so every browser and the phone
 * see the same one. The server does not interpret it: it only checks that it is a JSON object of reasonable size, versions it, and refuses
 * a save made from an out-of-date copy (two people editing) instead of overwriting it silently. The electrical design uses the same store
 * under its own file and name.
 *
 * Nothing it held is ever lost to a later save: before a save changes the design, the design as it was is kept as a version (at most one every
 * five minutes, and always when the save shrinks it a lot), 48 of the latest ones plus the last of each of the past 30 days. A mistake - a
 * deleted house, a save made from a browser that had lost something - is a version away from being undone.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";

export const MAX_SITE_BYTES = 768 * 1024;
export type SiteDocument = { revision: number; updated_at: string | null; updated_by: string | null; site: Record<string, unknown> | null };
export class SiteConflict extends Error { constructor(readonly current: SiteDocument, label = "site") { super(`the ${label} was changed by someone else`); } }
export class SiteInvalid extends Error {}

export type SiteVersion = { id: string; revision: number; saved_at: string; updated_by: string | null; counts: Record<string, number> };
const SNAPSHOT_EVERY_MS = 5 * 60_000, KEEP_LATEST = 48, KEEP_DAYS = 30;
/** How many things each list of the design holds: what a person recognises a version by ("15 openings, 19 objects"). */
const countsOf = (site: Record<string, unknown> | null): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(site ?? {})) if (Array.isArray(value)) counts[key] = value.length;
  return counts;
};
/** A save that takes away a lot of what was there (a third of any list of five or more things, or the whole of one). */
const shrinksALot = (before: Record<string, number>, after: Record<string, number>): boolean =>
  Object.entries(before).some(([key, was]) => was >= 5 && (after[key] ?? 0) <= was * 2 / 3 || was >= 1 && (after[key] ?? 0) === 0 && key in after);

export class SiteStore {
  readonly #file: string;
  readonly #now: () => Date;
  readonly #label: string;
  #doc: SiteDocument = { revision: 0, updated_at: null, updated_by: null, site: null };
  #lastSnapshotAt = 0;
  get #historyDir(): string { return `${this.#file}.history`; }

  constructor(file: string, now: () => Date = () => new Date(), label = "site") {
    this.#file = file; this.#now = now; this.#label = label;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SiteDocument>;
      if (typeof raw.revision === "number" && typeof raw.site === "object") this.#doc = { revision: raw.revision, updated_at: raw.updated_at ?? null, updated_by: raw.updated_by ?? null, site: raw.site };
    } catch { /* no design saved yet */ }
  }

  get(): SiteDocument { return this.#doc; }

  /** Save `site` if the client saw the current revision; returns the new document. */
  save(site: unknown, baseRevision: unknown, by: string): SiteDocument {
    if (typeof site !== "object" || site === null || Array.isArray(site)) throw new SiteInvalid(`the ${this.#label} must be an object`);
    if (JSON.stringify(site).length > MAX_SITE_BYTES) throw new SiteInvalid(`the ${this.#label} is too large`);
    if (baseRevision !== this.#doc.revision) throw new SiteConflict(this.#doc, this.#label);
    this.#snapshot(site as Record<string, unknown>);
    this.#doc = { revision: this.#doc.revision + 1, updated_at: this.#now().toISOString(), updated_by: by.slice(0, 60), site: site as Record<string, unknown> };
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.#doc), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.#file);
    return this.#doc;
  }
  /** Keep the design as it is now, before `incoming` replaces it. */
  #snapshot(incoming: Record<string, unknown>): void {
    const current = this.#doc;
    if (!current.site || current.revision === 0) return;
    const now = this.#now().getTime();
    const due = now - this.#lastSnapshotAt >= SNAPSHOT_EVERY_MS;
    if (!due && !shrinksALot(countsOf(current.site), countsOf(incoming))) return;
    try {
      fs.mkdirSync(this.#historyDir, { recursive: true, mode: 0o700 });
      const stamp = (current.updated_at ?? this.#now().toISOString()).replace(/[:.]/g, "-");
      const name = `${stamp}_r${current.revision}.json`;
      fs.writeFileSync(path.join(this.#historyDir, name), JSON.stringify(current), { encoding: "utf8", mode: 0o600 });
      this.#lastSnapshotAt = now;
      this.#prune();
    } catch { /* Failing to keep a version must never stop the save itself. */ }
  }

  #prune(): void {
    const names = fs.readdirSync(this.#historyDir).filter(name => /^\d{4}-\d{2}-\d{2}T.*_r\d+\.json$/.test(name)).sort().reverse();
    const keep = new Set(names.slice(0, KEEP_LATEST));
    const days = new Set<string>();
    for (const name of names) {
      const day = name.slice(0, 10);
      if (days.size < KEEP_DAYS && !days.has(day)) { days.add(day); keep.add(name); }
    }
    for (const name of names) if (!keep.has(name)) fs.rmSync(path.join(this.#historyDir, name), { force: true });
  }

  /** The versions kept, newest first. */
  versions(): SiteVersion[] {
    try {
      return fs.readdirSync(this.#historyDir).filter(name => /_r\d+\.json$/.test(name)).sort().reverse().flatMap(name => {
        try {
          const doc = JSON.parse(fs.readFileSync(path.join(this.#historyDir, name), "utf8")) as SiteDocument;
          return [{ id: name.replace(/\.json$/, ""), revision: doc.revision, saved_at: doc.updated_at ?? "", updated_by: doc.updated_by, counts: countsOf(doc.site) }];
        } catch { return []; }
      });
    } catch { return []; }
  }

  /** One version, whole (null when there is none by that id). */
  version(id: string): SiteDocument | null {
    if (!/^[0-9TZ-]+_r\d+$/.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.#historyDir, `${id}.json`), "utf8")) as SiteDocument; } catch { return null; }
  }
}
