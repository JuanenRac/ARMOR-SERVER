/**
 * A.R.M.O.R. per-account interface preferences: the language, the theme, and the saved weather place. Kept
 * here, tied to the signed-in user, so they travel with the person rather than with the browser or the
 * address used to reach the server (a browser's own storage is separate for every origin it visits).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";

export type WeatherPlace = { name: string; region: string; country: string; lat: number; lon: number };
export type Preferences = { language?: string; theme?: string; weatherPlace?: WeatherPlace | null };

const LANGUAGE = /^[a-z]{2}$/;
const THEME = /^[A-Za-z ]{1,24}$/;

/** `undefined` when the value is not a usable place at all; `null` when it validly means "no place chosen". */
function cleanPlace(value: unknown): WeatherPlace | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  if (typeof p.name !== "string" || typeof p.region !== "string" || typeof p.country !== "string" || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return undefined;
  return { name: p.name.slice(0, 120), region: p.region.slice(0, 120), country: p.country.slice(0, 120), lat: p.lat as number, lon: p.lon as number };
}

export class PreferencesStore {
  readonly #byUser = new Map<string, Preferences>();
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
    this.#load();
  }

  #load(): void {
    let raw: { schema?: unknown; users?: Record<string, unknown> };
    try { raw = JSON.parse(fs.readFileSync(this.#file, "utf8")); } catch { return; }
    if (raw.schema !== 1 || !raw.users || typeof raw.users !== "object") return;
    for (const [userId, value] of Object.entries(raw.users)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const prefs: Preferences = {};
      if (typeof v.language === "string" && LANGUAGE.test(v.language)) prefs.language = v.language;
      if (typeof v.theme === "string" && THEME.test(v.theme)) prefs.theme = v.theme;
      const place = cleanPlace(v.weatherPlace);
      if (place !== undefined) prefs.weatherPlace = place;
      this.#byUser.set(userId, prefs);
    }
  }

  get(userId: string): Preferences { return this.#byUser.get(userId) ?? {}; }

  /** Merges the given fields into the user's preferences; a field left out of `patch` keeps its old value. Throws on a bad value. */
  update(userId: string, patch: { language?: unknown; theme?: unknown; weatherPlace?: unknown }): Preferences {
    const current = { ...this.get(userId) };
    if (patch.language !== undefined) {
      if (typeof patch.language !== "string" || !LANGUAGE.test(patch.language)) throw new Error("invalid_language");
      current.language = patch.language;
    }
    if (patch.theme !== undefined) {
      if (typeof patch.theme !== "string" || !THEME.test(patch.theme)) throw new Error("invalid_theme");
      current.theme = patch.theme;
    }
    if (patch.weatherPlace !== undefined) {
      const place = cleanPlace(patch.weatherPlace);
      if (place === undefined) throw new Error("invalid_weather_place");
      current.weatherPlace = place;
    }
    this.#byUser.set(userId, current);
    this.#save();
    return current;
  }

  #save(): void {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, users: Object.fromEntries(this.#byUser) }, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, this.#file);
    } catch { /* losing this file only means preferences are not kept across a restart */ }
  }
}
