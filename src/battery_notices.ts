/**
 * How a battery alarm calls for attention. In the mode "once" (the default) every battery alarm is discreet (the clients make no sound, voice, pop-up, blinking or red) and a problem
 * is told as new only the first time, or when it gets worse; the same problem again is only "known". A problem that has been over for `forget_after_h` hours is forgotten, so a reading
 * that goes up and down around a level is one problem and not many. A battery, or one module of it, can be silenced. Nothing here changes which alarms are raised or what the history keeps.
 * Also the plausible range of a cell voltage and the rule that a wide gap between cells must be seen in two readings. Kept in the data directory.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Alarm } from "./alarms.js";
import { JsonFile } from "./history.js";

export type BatteryNoticeSettings = { mode: "once" | "classic"; forget_after_h: number; cell_min_plausible_v: number; cell_max_plausible_v: number };
export const BATTERY_NOTICE_DEFAULTS: BatteryNoticeSettings = { mode: "once", forget_after_h: 24, cell_min_plausible_v: 1, cell_max_plausible_v: 4.5 };
export type Silenced = { id: string; since: string; by: string };
export type Quiet = "new" | "known" | "silenced";

export const BATTERY_CODES: ReadonlySet<string> = new Set(["solar_battery_alarm", "solar_battery_low", "solar_battery_overvoltage", "solar_cells_unbalanced", "solar_battery_hot",
  "solar_battery_cold", "solar_cell_soh_abnormal", "solar_module_overcurrent", "solar_counter_rose", "solar_battery_worn"]);
const ID = /^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,31}(\/([1-9]|[12][0-9]|3[0-2]))?$/;
const RANK = { warning: 0, high: 1, critical: 2 } as const;
const MAX_PROBLEMS = 512, MAX_ALARMS = 2000, MAX_SILENCED = 128;

/** The problem an alarm key stands for: a protection counter that goes up again is the same problem, whatever its new value. */
export const problemOf = (key: string): string => key.replace(/(:counter:\d+:[^:]+):\d+$/, "$1");

type Problem = { rank: number; subjects: string[]; ended_at?: number };
type File = { settings: BatteryNoticeSettings; silenced: Silenced[]; problems: Array<[string, Problem]>; alarms: Array<[string, "new" | "known"]> };

export class BatteryNoticesInvalid extends Error {}

export function parseNoticeSettings(value: unknown, current: BatteryNoticeSettings = BATTERY_NOTICE_DEFAULTS): BatteryNoticeSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BatteryNoticesInvalid("the settings must be an object");
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!(key in BATTERY_NOTICE_DEFAULTS)) throw new BatteryNoticesInvalid(`unknown setting: ${key}`);
  const out = { ...current };
  if (body.mode !== undefined) {
    if (body.mode !== "once" && body.mode !== "classic") throw new BatteryNoticesInvalid("mode is once or classic");
    out.mode = body.mode;
  }
  const number = (key: "forget_after_h" | "cell_min_plausible_v" | "cell_max_plausible_v", low: number, high: number): void => {
    const item = body[key];
    if (item === undefined) return;
    if (typeof item !== "number" || !Number.isFinite(item) || item < low || item > high) throw new BatteryNoticesInvalid(`${key} must be a number from ${low} to ${high}`);
    out[key] = item;
  };
  number("forget_after_h", 1, 720);
  number("cell_min_plausible_v", 0, 3);
  number("cell_max_plausible_v", 3.6, 10);
  return out;
}

export class BatteryNotices {
  #settings: BatteryNoticeSettings = { ...BATTERY_NOTICE_DEFAULTS };
  #silenced: Silenced[] = [];
  readonly #problems = new Map<string, Problem>();
  readonly #alarms = new Map<string, "new" | "known">();
  readonly #file?: JsonFile<File>;
  readonly #now: () => number;

  constructor(file?: string, now: () => number = Date.now) {
    this.#now = now;
    if (!file) return;
    this.#file = new JsonFile<File>(file);
    const saved = this.#file.read();
    if (!saved) return;
    try { this.#settings = parseNoticeSettings(saved.settings); } catch { /* damaged: the defaults */ }
    if (Array.isArray(saved.silenced)) this.#silenced = saved.silenced.filter(item => typeof item?.id === "string" && ID.test(item.id)).slice(0, MAX_SILENCED);
    if (Array.isArray(saved.problems)) for (const item of saved.problems.slice(-MAX_PROBLEMS)) if (Array.isArray(item) && typeof item[0] === "string" && item[1] && Array.isArray(item[1].subjects)) this.#problems.set(item[0], item[1]);
    if (Array.isArray(saved.alarms)) for (const item of saved.alarms.slice(-MAX_ALARMS)) if (Array.isArray(item) && typeof item[0] === "string") this.#alarms.set(item[0], item[1] === "new" ? "new" : "known");
  }

  #save(): void {
    this.#file?.write({ settings: this.#settings, silenced: this.#silenced, problems: [...this.#problems], alarms: [...this.#alarms] });
  }

  settings(): BatteryNoticeSettings { return this.#settings; }
  silenced(): Silenced[] { return this.#silenced.map(item => ({ ...item })); }

  set(value: unknown): BatteryNoticeSettings {
    this.#settings = parseNoticeSettings(value, this.#settings);
    this.#save();
    return this.#settings;
  }

  silence(id: unknown, silenced: unknown, by: string): void {
    if (typeof id !== "string" || !ID.test(id) || typeof silenced !== "boolean") throw new BatteryNoticesInvalid("id is node/device or node/device/module, and silenced is true or false");
    const rest = this.#silenced.filter(item => item.id !== id);
    if (silenced) {
      if (rest.length >= MAX_SILENCED) throw new BatteryNoticesInvalid("too many silenced batteries");
      rest.push({ id, since: new Date(this.#now()).toISOString(), by: by.slice(0, 60) });
    }
    this.#silenced = rest;
    this.#save();
  }

  /** A battery alarm was raised: whether its problem is new (or worse than what was told) or already known. */
  raised(alarm: Alarm): void {
    if (!BATTERY_CODES.has(alarm.code)) return;
    const now = this.#now(), problem = problemOf(alarm.key), rank = RANK[alarm.severity];
    const before = this.#problems.get(problem);
    const forgotten = before?.ended_at !== undefined && now - before.ended_at >= this.#settings.forget_after_h * 3_600_000;
    const fresh = !before || forgotten || rank > before.rank;
    // an event (an alarm born already ended) is over now; a condition is not
    this.#problems.delete(problem);
    this.#problems.set(problem, { rank, subjects: fresh ? [] : before.subjects, ...(alarm.cleared_at ? { ended_at: now } : {}) });
    while (this.#problems.size > MAX_PROBLEMS) this.#problems.delete(this.#problems.keys().next().value as string);
    this.#alarms.set(alarm.id, fresh ? "new" : "known");
    while (this.#alarms.size > MAX_ALARMS) this.#alarms.delete(this.#alarms.keys().next().value as string);
    this.#save();
  }

  /** The cause of an alarm ended: from now the time to forget its problem counts. */
  cleared(alarm: Alarm): void {
    const problem = this.#problems.get(problemOf(alarm.key));
    if (!problem || !BATTERY_CODES.has(alarm.code)) return;
    problem.ended_at = this.#now();
    this.#save();
  }

  /** What an open problem touches now (cells, a protection that tripped...). Anything not told before makes it worse: its open alarm is new again. */
  observe(key: string, openId: string | undefined, subjects: readonly string[]): void {
    const problem = this.#problems.get(problemOf(key));
    if (!problem || openId === undefined) return;
    const added = subjects.filter(item => !problem.subjects.includes(item));
    if (added.length === 0) return;
    problem.subjects = [...problem.subjects, ...added].slice(-64);
    this.#alarms.set(openId, "new");
    this.#save();
  }

  /** The alarm as a client reads it: a battery alarm says how discreet it is. */
  view(alarm: Alarm): Alarm & { quiet?: Quiet } {
    if (!BATTERY_CODES.has(alarm.code) || alarm.source.type !== "solar") return alarm;
    const module = alarm.detail?.module;
    if (this.#silenced.some(item => item.id === alarm.source.id || (typeof module === "number" && item.id === `${alarm.source.id}/${module}`))) return { ...alarm, quiet: "silenced" };
    if (this.#settings.mode === "classic") return alarm;
    return { ...alarm, quiet: this.#alarms.get(alarm.id) ?? "known" };
  }
}

/**
 * A wide gap between cells is believed only when two different readings in a row show it (a reading repeated as it was counts after ten minutes), so one spoiled reading fixes nothing.
 * A gap within the level is believed at once.
 */
export class GapGate {
  readonly #pending = new Map<string, { gap: number; signature: string; at: number }>();

  /** The gap to believe (the smaller of the two readings), `undefined` while it waits. `dropped` is the gap that the next reading did not repeat. */
  judge(key: string, gapMv: number, signature: string, levelMv: number, at: number): { gap?: number; dropped?: number } {
    const before = this.#pending.get(key);
    if (gapMv <= levelMv) {
      this.#pending.delete(key);
      return before ? { gap: gapMv, ...(before.signature !== "" ? { dropped: before.gap } : {}) } : { gap: gapMv };
    }
    if (!before) { this.#pending.set(key, { gap: gapMv, signature, at }); return {}; }
    if (before.signature !== "" && before.signature === signature && at - before.at < 600_000) return {};
    // confirmed: it stays so until a reading is back within the level
    this.#pending.set(key, { gap: gapMv, signature: "", at });
    return { gap: Math.min(before.gap, gapMv) };
  }

  forget(prefix: string): void { for (const key of [...this.#pending.keys()]) if (key.startsWith(prefix)) this.#pending.delete(key); }
}
