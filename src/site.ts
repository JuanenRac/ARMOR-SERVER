/**
 * The site design (terrain, buildings, cameras' and radars' places, devices' places) kept on the server, so every browser and the phone
 * see the same one. The server does not interpret it: it only checks that it is a JSON object of reasonable size, versions it, and refuses
 * a save made from an out-of-date copy (two people editing) instead of overwriting it silently. The electrical design uses the same store
 * under its own file and name.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";

export const MAX_SITE_BYTES = 768 * 1024;
export type SiteDocument = { revision: number; updated_at: string | null; updated_by: string | null; site: Record<string, unknown> | null };
export class SiteConflict extends Error { constructor(readonly current: SiteDocument, label = "site") { super(`the ${label} was changed by someone else`); } }
export class SiteInvalid extends Error {}

export class SiteStore {
  readonly #file: string;
  readonly #now: () => Date;
  readonly #label: string;
  #doc: SiteDocument = { revision: 0, updated_at: null, updated_by: null, site: null };

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
    this.#doc = { revision: this.#doc.revision + 1, updated_at: this.#now().toISOString(), updated_by: by.slice(0, 60), site: site as Record<string, unknown> };
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.#doc), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.#file);
    return this.#doc;
  }
}
