/**
 * The arming profiles: the named ways of arming an alarm panel (Away, Home, Night, the ones the owner makes), kept on the server and sent inside the arm command (ARMOR-COMMON's
 * arm_profile schema; alarm_command.schema.json carries one as `profile`). A profile says which zones guard, which ones alarm at once and which after the entry delay, the two delays,
 * whether an intrusion sounds the siren and how loudly the server tells people about it. It never changes who may disarm, the PIN, the lockout or a forced arming: the node enforces that.
 *
 * Three profiles exist from the start (away, stay and night); away and stay cannot be removed, so that an arm always has a plain way to be asked. The list has a revision, so that two
 * consoles never overwrite each other silently.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";

export class ProfilesInvalid extends Error {}
export class ProfilesConflict extends Error {
  constructor(readonly current: ProfilesDocument) { super("the profiles changed since they were read"); }
}

export type ZoneOverride = { id: string; armed?: boolean; delay?: "instant" | "entry" };
export type ArmProfile = {
  id: string; name: string; base: "away" | "stay"; exit_delay_s?: number; entry_delay_s?: number; siren?: boolean; notify?: "urgent" | "normal"; zones?: ZoneOverride[];
};
export type ProfilesDocument = { revision: number; updated_at: string; updated_by: string; profiles: ArmProfile[] };

export const MAX_PROFILES = 8;
export const MAX_PROFILE_ZONES = 16;
export const MAX_PROFILE_DELAY_S = 300;
/** These two always exist: an arm can always be asked for the plain way. */
export const RESERVED_PROFILES = ["away", "stay"] as const;
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,15}$/;
const ZONE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const chars = (text: string): number => Array.from(text).length;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One profile, as the contract has it, with the rules that join fields: a zone is named once and a zone that is left out has no delay. Throws ProfilesInvalid. */
export function parseArmProfile(value: unknown, where = "profile"): ArmProfile {
  if (!isRecord(value)) throw new ProfilesInvalid(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!["id", "name", "base", "exit_delay_s", "entry_delay_s", "siren", "notify", "zones"].includes(key)) throw new ProfilesInvalid(`${where} has an unknown field: ${key}`);
  if (typeof value.id !== "string" || !PROFILE_ID.test(value.id)) throw new ProfilesInvalid(`${where}: invalid id (lowercase letters, digits, - and _, at most 16)`);
  if (typeof value.name !== "string" || chars(value.name.trim()) < 1 || chars(value.name) > 32) throw new ProfilesInvalid(`${where}: the name has 1 to 32 characters`);
  if (value.base !== "away" && value.base !== "stay") throw new ProfilesInvalid(`${where}: the base is away or stay`);
  const out: ArmProfile = { id: value.id, name: value.name.trim(), base: value.base };
  for (const key of ["exit_delay_s", "entry_delay_s"] as const) {
    if (!(key in value)) continue;
    const delay = value[key];
    if (typeof delay !== "number" || !Number.isInteger(delay) || delay < 0 || delay > MAX_PROFILE_DELAY_S) throw new ProfilesInvalid(`${where}: ${key} is a whole number of seconds from 0 to ${MAX_PROFILE_DELAY_S}`);
    out[key] = delay;
  }
  if ("siren" in value) { if (typeof value.siren !== "boolean") throw new ProfilesInvalid(`${where}: siren is true or false`); out.siren = value.siren; }
  if ("notify" in value) { if (value.notify !== "urgent" && value.notify !== "normal") throw new ProfilesInvalid(`${where}: notify is urgent or normal`); out.notify = value.notify; }
  if ("zones" in value) {
    if (!Array.isArray(value.zones) || value.zones.length > MAX_PROFILE_ZONES) throw new ProfilesInvalid(`${where}: zones is a list of at most ${MAX_PROFILE_ZONES}`);
    const seen = new Set<string>();
    out.zones = value.zones.map((item, index) => {
      if (!isRecord(item)) throw new ProfilesInvalid(`${where}: zone ${index} must be an object`);
      for (const key of Object.keys(item)) if (!["id", "armed", "delay"].includes(key)) throw new ProfilesInvalid(`${where}: zone ${index} has an unknown field: ${key}`);
      if (typeof item.id !== "string" || !ZONE_ID.test(item.id)) throw new ProfilesInvalid(`${where}: zone ${index} has an invalid id`);
      if (seen.has(item.id)) throw new ProfilesInvalid(`${where}: the zone ${item.id} is named twice`);
      seen.add(item.id);
      const zone: ZoneOverride = { id: item.id };
      if ("armed" in item) { if (typeof item.armed !== "boolean") throw new ProfilesInvalid(`${where}: zone ${index}: armed is true or false`); zone.armed = item.armed; }
      if ("delay" in item) { if (item.delay !== "instant" && item.delay !== "entry") throw new ProfilesInvalid(`${where}: zone ${index}: delay is instant or entry`); zone.delay = item.delay; }
      if (zone.armed === false && zone.delay !== undefined) throw new ProfilesInvalid(`${where}: zone ${item.id} is left out, so it has no delay`);
      return zone;
    });
  }
  return out;
}

/** The list of profiles, checked as a whole: at most eight, an id once, and the reserved away and stay present with their own base. */
export function parseProfileList(value: unknown): ArmProfile[] {
  if (!Array.isArray(value)) throw new ProfilesInvalid("profiles must be a list");
  if (value.length > MAX_PROFILES) throw new ProfilesInvalid(`at most ${MAX_PROFILES} profiles`);
  const list = value.map((item, index) => parseArmProfile(item, `profile ${index}`));
  const ids = list.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new ProfilesInvalid("a profile id must appear once");
  for (const reserved of RESERVED_PROFILES) {
    const found = list.find(item => item.id === reserved);
    if (!found) throw new ProfilesInvalid(`the profile ${reserved} cannot be removed`);
    if (found.base !== reserved) throw new ProfilesInvalid(`the profile ${reserved} keeps the base ${reserved}`);
  }
  return list;
}

/** What a house has before anybody edits anything: the plain away and stay, and a night that is stay with a little longer to get to the door. */
export const defaultProfiles = (): ArmProfile[] => [
  { id: "away", name: "Away", base: "away" },
  { id: "stay", name: "Home", base: "stay" },
  { id: "night", name: "Night", base: "stay", entry_delay_s: 45, notify: "urgent" },
];

export class ArmProfileStore {
  #doc: ProfilesDocument;

  constructor(private readonly file: string, private readonly now: () => Date = () => new Date(), private readonly warn: (message: string) => void = () => undefined) {
    this.#doc = { revision: 0, updated_at: new Date(0).toISOString(), updated_by: "", profiles: defaultProfiles() };
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProfilesDocument>;
      this.#doc = { revision: Number.isInteger(stored.revision) ? Number(stored.revision) : 0, updated_at: typeof stored.updated_at === "string" ? stored.updated_at : this.#doc.updated_at,
        updated_by: typeof stored.updated_by === "string" ? stored.updated_by.slice(0, 60) : "", profiles: parseProfileList(stored.profiles) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(`ARMOR_ARM_PROFILES=DEFAULTS the saved profiles could not be read (${error instanceof Error ? error.message : "unknown error"}): the defaults are used`);
    }
  }

  get(): ProfilesDocument { return { ...this.#doc, profiles: structuredClone(this.#doc.profiles) }; }

  find(id: string): ArmProfile | undefined {
    const found = this.#doc.profiles.find(item => item.id === id);
    return found ? structuredClone(found) : undefined;
  }

  /** The list is replaced as a whole. `revision` is the one the editor read: another editor's change in between is a conflict, never a silent overwrite. */
  replace(profiles: unknown, revision: unknown, by: string): ProfilesDocument {
    const list = parseProfileList(profiles);
    if (revision !== undefined && revision !== this.#doc.revision) throw new ProfilesConflict(this.get());
    this.#doc = { revision: this.#doc.revision + 1, updated_at: this.now().toISOString(), updated_by: by.slice(0, 60), profiles: list };
    this.#save();
    return this.get();
  }

  #save(): void {
    const temporary = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(this.#doc, null, 2), { mode: 0o600 });
    durableRename(temporary, this.file);
  }
}
