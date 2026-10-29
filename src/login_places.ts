/**
 * The countries each person has signed in from outside the house, kept in the data directory so that a restart does not forget them. The first country of a person is just learned (there is
 * nothing to compare it with); a different one afterwards is "new" once, and is learned too, so it is told one time and not at every sign-in.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";

export const MAX_COUNTRIES_PER_PERSON = 24;
export const MAX_PEOPLE = 200;

export type CountryVerdict = "first" | "known" | "new";

export class LoginCountries {
  #seen = new Map<string, string[]>();
  constructor(private readonly file: string) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
        for (const [person, list] of Object.entries(stored).slice(0, MAX_PEOPLE)) {
          if (Array.isArray(list)) this.#seen.set(person.slice(0, 80), list.filter((code): code is string => typeof code === "string" && /^[A-Z]{2}$/.test(code)).slice(-MAX_COUNTRIES_PER_PERSON));
        }
      }
    } catch { this.#seen = new Map(); }
  }

  /** Notes a sign-in of this person from this country and says whether it was their first ever, one they had signed in from, or a new one. */
  note(person: string, country: string): CountryVerdict {
    const key = person.slice(0, 80);
    const list = this.#seen.get(key) ?? [];
    if (list.includes(country)) return "known";
    if (!this.#seen.has(key) && this.#seen.size >= MAX_PEOPLE) this.#seen.delete(this.#seen.keys().next().value!);
    this.#seen.set(key, [...list, country].slice(-MAX_COUNTRIES_PER_PERSON));
    this.#save();
    return list.length === 0 ? "first" : "new";
  }

  /** The person was removed: what is kept about them goes too. */
  forget(person: string): void { if (this.#seen.delete(person.slice(0, 80))) this.#save(); }

  countriesOf(person: string): string[] { return [...(this.#seen.get(person.slice(0, 80)) ?? [])]; }

  #save(): void {
    const temporary = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.#seen)), { mode: 0o600 });
      durableRename(temporary, this.file);
    } catch { /* the countries stay in memory for this run */ }
  }
}
