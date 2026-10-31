/**
 * The arming modes: away (everything is defended: the way the system always armed), home and night (only what the owner marked for that mode is defended), each with its own exit and
 * entry delay, and an optional timetable that changes the mode by itself. The whole of it is OFF unless an administrator turns it on (setting alarm.arming_modes); off, the server arms and
 * disarms exactly as it always did. Home and night start with nothing marked: the owner assigns zones and sensors in the alarm designer.
 *
 * A mode defends a list of references (`zone:Kitchen` is every device whose location is that text; `device:door-1`, `node:radar-1`, `camera:garden` are one thing each). Smoke, gas, flood,
 * panic and tamper never depend on the mode. A mode that defends nothing is refused ("no zones assigned") unless the caller confirms it, so the system is never armed in silence while
 * defending nothing. Going to a mode that defends LESS than the current one is the same act as disarming for the part that was defended and no longer is: it asks for the PIN (setting
 * alarm.mode_downgrade_pin, "required" by default). Disarming always works.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";

export const ARMED_MODES = ["away", "home", "night"] as const;
export type ArmedMode = (typeof ARMED_MODES)[number];
export type ArmingMode = "disarmed" | ArmedMode;
export type ModeDefinition = { defends?: string[]; entry?: string[]; exit_delay_s?: number; entry_delay_s?: number };
export type ScheduleEntry = { mode: ArmedMode; days: number[]; at: string };
export type ArmingModesDocument = { modes: Record<ArmedMode, ModeDefinition>; schedule: ScheduleEntry[] };
export type StoredModes = ArmingModesDocument & { revision: number; updated_at: string; updated_by: string };
export type Unit = { type: "device" | "node" | "camera"; id: string };

export const MAX_REFS = 64;
export const MAX_SCHEDULE = 16;
export const MAX_MODE_DELAY_S = 300;
const REF = /^(zone|device|node|camera):\S(.{0,62}\S)?$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export class ModesInvalid extends Error {}
export class ModesConflict extends Error {
  constructor(readonly current: StoredModes) { super("the arming modes changed since they were read"); }
}
/** A change of mode that is refused: `code` is what a client reads (modes_disabled, no_zones_assigned, ...). */
export class ModeChangeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseRefs(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_REFS) throw new ModesInvalid(`${where} is a list of at most ${MAX_REFS}`);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !REF.test(item)) throw new ModesInvalid(`${where}: each item is zone:, device:, node: or camera: followed by a name of at most 64 characters`);
    if (seen.has(item)) throw new ModesInvalid(`${where}: ${item} is named twice`);
    seen.add(item);
  }
  return [...value] as string[];
}

/** One mode, as the contract has it. Away defends everything, so it carries no `defends`. */
export function parseModeDefinition(value: unknown, name: ArmedMode): ModeDefinition {
  const where = `mode ${name}`;
  if (!isRecord(value)) throw new ModesInvalid(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!["defends", "entry", "exit_delay_s", "entry_delay_s"].includes(key)) throw new ModesInvalid(`${where} has an unknown field: ${key}`);
  const out: ModeDefinition = {};
  if ("defends" in value) {
    if (name === "away") throw new ModesInvalid("away defends everything, so it has no defends list");
    out.defends = parseRefs(value.defends, `${where}: defends`);
  }
  if ("entry" in value) out.entry = parseRefs(value.entry, `${where}: entry`);
  for (const key of ["exit_delay_s", "entry_delay_s"] as const) {
    if (!(key in value)) continue;
    const delay = value[key];
    if (typeof delay !== "number" || !Number.isInteger(delay) || delay < 0 || delay > MAX_MODE_DELAY_S) throw new ModesInvalid(`${where}: ${key} is a whole number of seconds from 0 to ${MAX_MODE_DELAY_S}`);
    out[key] = delay;
  }
  return out;
}

/** The editable part: the three modes and the timetable. No two entries may change the mode at the same minute of the same day. */
export function parseArmingModes(value: unknown): ArmingModesDocument {
  if (!isRecord(value)) throw new ModesInvalid("the arming modes are an object");
  for (const key of Object.keys(value)) if (!["modes", "schedule"].includes(key)) throw new ModesInvalid(`unknown field: ${key}`);
  const modes = value.modes;
  if (!isRecord(modes)) throw new ModesInvalid("modes is an object with away, home and night");
  for (const key of Object.keys(modes)) if (!(ARMED_MODES as readonly string[]).includes(key)) throw new ModesInvalid(`unknown mode: ${key}`);
  const parsed = {} as Record<ArmedMode, ModeDefinition>;
  for (const name of ARMED_MODES) {
    if (!(name in modes)) throw new ModesInvalid(`the mode ${name} is missing`);
    parsed[name] = parseModeDefinition(modes[name], name);
  }
  const schedule: ScheduleEntry[] = [];
  if ("schedule" in value) {
    if (!Array.isArray(value.schedule) || value.schedule.length > MAX_SCHEDULE) throw new ModesInvalid(`schedule is a list of at most ${MAX_SCHEDULE}`);
    const taken = new Set<string>();
    value.schedule.forEach((item, index) => {
      if (!isRecord(item)) throw new ModesInvalid(`schedule ${index} must be an object`);
      for (const key of Object.keys(item)) if (!["mode", "days", "at"].includes(key)) throw new ModesInvalid(`schedule ${index} has an unknown field: ${key}`);
      if (typeof item.mode !== "string" || !(ARMED_MODES as readonly string[]).includes(item.mode)) throw new ModesInvalid(`schedule ${index}: the mode is away, home or night (a timetable never disarms)`);
      if (!Array.isArray(item.days) || item.days.length < 1 || item.days.length > 7 || item.days.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(item.days).size !== item.days.length) {
        throw new ModesInvalid(`schedule ${index}: days is a list of different numbers from 1 (Monday) to 7 (Sunday)`);
      }
      if (typeof item.at !== "string" || !TIME.test(item.at)) throw new ModesInvalid(`schedule ${index}: at is a time HH:MM`);
      for (const day of item.days as number[]) {
        const slot = `${day} ${item.at}`;
        if (taken.has(slot)) throw new ModesInvalid(`schedule ${index}: two entries change the mode at the same time`);
        taken.add(slot);
      }
      schedule.push({ mode: item.mode as ArmedMode, days: [...(item.days as number[])], at: item.at });
    });
  }
  return { modes: parsed, schedule };
}

/** What a house has before anybody edits anything: away with no delays, and home and night with nothing marked. */
export const defaultModes = (): ArmingModesDocument => ({ modes: { away: {}, home: {}, night: {} }, schedule: [] });

/** The timers, replaceable in tests. */
export type Timers = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const realTimers: Timers = { set: (run, ms) => { const handle = setTimeout(run, ms); handle.unref(); return handle; }, clear: handle => clearTimeout(handle as NodeJS.Timeout) };

export type ArmingOptions = {
  file: string;
  /** The switch of the whole system (alarm.arming_modes). */
  enabled: () => boolean;
  /** The switch of the timetable (alarm.mode_schedule); it needs `enabled` too. */
  scheduleEnabled: () => boolean;
  /** Whether the timetable may go to a mode that defends less (alarm.mode_schedule_lowers); off, it only raises or keeps the defence. */
  scheduleMayLower: () => boolean;
  now?: () => number;
  /** Every thing that can be defended right now, and the location (zone) of a device. */
  universe: () => Unit[];
  locationOf: (unit: Unit) => string | undefined;
  /** The system is armed (the store's own mode), and the way to arm or disarm it. */
  isArmed: () => boolean;
  setArmed: (armed: boolean) => void;
  /** One armed mode became another armed mode / an exit delay ended: the rules and the nodes look again. */
  afterSwitch: () => void;
  afterExit: () => void;
  /** A mode was chosen (by whom: a person, or `schedule`), including choosing the one already in force (`noop`) and disarming. Whoever listens must not make the change fail. */
  afterApplied?: (to: ArmingMode, plan: ModePlan, by: string) => void;
  /** What the timetable did (or could not do), for the audit trail. */
  report?: (what: { applied: boolean; mode: ArmedMode; reason?: string }) => void;
  warn?: (message: string) => void;
  timers?: Timers;
};

export type ModePlan = { from: ArmingMode; to: ArmingMode; kind: "noop" | "arm" | "switch" | "disarm"; empty: boolean; lowers: boolean };

export class ArmingModes {
  #doc: StoredModes;
  #current: ArmingMode = "disarmed";
  #exit: { until: number; from: ArmingMode; handle: unknown } | undefined;
  #delayed = new Map<string, unknown>();
  #lastTick = "";
  readonly #o: ArmingOptions;
  readonly #now: () => number;
  readonly #timers: Timers;

  constructor(options: ArmingOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? realTimers;
    this.#doc = { ...defaultModes(), revision: 0, updated_at: new Date(0).toISOString(), updated_by: "" };
    try {
      const stored = JSON.parse(fs.readFileSync(options.file, "utf8")) as Partial<StoredModes> & { current?: unknown };
      const parsed = parseArmingModes({ modes: stored.modes, schedule: stored.schedule ?? [] });
      this.#doc = { ...parsed, revision: Number.isInteger(stored.revision) ? Number(stored.revision) : 0, updated_at: typeof stored.updated_at === "string" ? stored.updated_at : this.#doc.updated_at,
        updated_by: typeof stored.updated_by === "string" ? stored.updated_by.slice(0, 60) : "" };
      if (typeof stored.current === "string" && (stored.current === "disarmed" || (ARMED_MODES as readonly string[]).includes(stored.current))) this.#current = stored.current as ArmingMode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.warn?.(`ARMOR_ARMING_MODES=DEFAULTS the saved arming modes could not be read (${error instanceof Error ? error.message : "unknown error"}): home and night defend nothing until they are set again`);
    }
  }

  get enabled(): boolean { return this.#o.enabled(); }

  /** The mode in force. With the modes off it is only armed (away) or disarmed. A system that is armed but was never told a mode (an arm from a client that knows no modes) is away: the most it defends. */
  current(): ArmingMode {
    if (!this.#o.isArmed()) return "disarmed";
    return this.#current === "disarmed" || !this.enabled ? "away" : this.#current;
  }

  available(): ArmingMode[] { return this.enabled ? ["disarmed", ...ARMED_MODES] : ["disarmed", "away"]; }

  get(): StoredModes { return structuredClone(this.#doc); }

  /** The modes that defend nothing at this moment (home and night start like that). */
  unassigned(): ArmedMode[] {
    const universe = this.#o.universe();
    return ARMED_MODES.filter(mode => mode !== "away" && !universe.some(unit => this.defends(mode, unit)));
  }

  /** The definitions are replaced as a whole. `revision` is the one the editor read: another editor's change in between is a conflict, never a silent overwrite. */
  replace(value: unknown, revision: unknown, by: string): StoredModes {
    const parsed = parseArmingModes(value);
    if (revision !== undefined && revision !== this.#doc.revision) throw new ModesConflict(this.get());
    this.#doc = { ...parsed, revision: this.#doc.revision + 1, updated_at: new Date(this.#now()).toISOString(), updated_by: by.slice(0, 60) };
    this.#save();
    return this.get();
  }

  #match(ref: string, unit: Unit): boolean {
    const cut = ref.indexOf(":"), kind = ref.slice(0, cut), name = ref.slice(cut + 1);
    if (kind === "zone") {
      const where = this.#o.locationOf(unit);
      return where !== undefined && where.trim().toLowerCase() === name.trim().toLowerCase();
    }
    return kind === unit.type && name === unit.id;
  }

  /** Whether a mode defends a thing. Away defends every one; home and night only what they list; disarmed nothing. */
  defends(mode: ArmingMode, unit: Unit): boolean {
    if (mode === "disarmed") return false;
    if (mode === "away") return true;
    return (this.#doc.modes[mode].defends ?? []).some(ref => this.#match(ref, unit));
  }

  /** Whether the armed system defends a thing at this moment: the mode defends it, and it is not one of the things still in their exit delay. With the modes off, everything is defended. */
  guards(type: Unit["type"], id: string): boolean {
    if (!this.enabled) return true;
    const unit: Unit = { type, id };
    if (!this.defends(this.current(), unit)) return false;
    if (this.#exit && this.#now() < this.#exit.until && !this.defends(this.#exit.from, unit)) return false;
    return true;
  }

  /** How long a sensor waits before it sounds, in the mode in force (0: at once). */
  entryDelayMs(type: Unit["type"], id: string): number {
    if (!this.enabled) return 0;
    const mode = this.current();
    if (mode === "disarmed") return 0;
    const definition = this.#doc.modes[mode];
    const unit: Unit = { type, id };
    return (definition.entry ?? []).some(ref => this.#match(ref, unit)) ? (definition.entry_delay_s ?? 0) * 1000 : 0;
  }

  /** What changing to `to` would be, without doing it: the route asks for the PIN, or refuses, from this. */
  plan(to: ArmingMode): ModePlan {
    const from = this.current(), universe = this.#o.universe();
    const kind = to === from ? "noop" : to === "disarmed" ? "disarm" : from === "disarmed" ? "arm" : "switch";
    const empty = to !== "disarmed" && to !== "away" && !universe.some(unit => this.defends(to, unit));
    const lowers = kind === "switch" && universe.some(unit => this.defends(from, unit) && !this.defends(to, unit));
    return { from, to, kind, empty, lowers };
  }

  /** Do the change. The caller has already checked who may (and the PIN); this refuses what is unsafe by itself: a mode that defends nothing, unless it is confirmed. */
  apply(to: ArmingMode, options: { confirmUnassigned?: boolean; by?: string } = {}): ModePlan {
    const by = options.by ?? "operator";
    const told = (plan: ModePlan): ModePlan => { try { this.#o.afterApplied?.(to, plan, by); } catch { /* a listener never breaks the change */ } return plan; };
    if (to === "disarmed") return told(this.#disarm());
    if (!this.enabled && to !== "away") throw new ModeChangeError("modes_disabled", "the arming modes are not turned on in this server: arm away, or disarm", 400);
    const plan = this.plan(to);
    if (plan.kind === "noop") return told(plan);
    if (plan.empty && options.confirmUnassigned !== true) throw new ModeChangeError("no_zones_assigned", `the mode ${to} has no zones or sensors assigned, so it would defend nothing: assign some in the alarm designer, or confirm`);
    this.#clearExit();
    this.cancelLater();
    const delay = (this.#doc.modes[to].exit_delay_s ?? 0) * 1000;
    if (this.enabled && delay > 0) {
      const handle = this.#timers.set(() => { this.#exit = undefined; this.#o.afterExit(); }, delay);
      this.#exit = { until: this.#now() + delay, from: plan.from, handle };
    }
    this.#current = to;
    this.#save();
    if (plan.kind === "arm") this.#o.setArmed(true);
    else this.#o.afterSwitch();
    return told(plan);
  }

  #disarm(): ModePlan {
    const plan = this.plan("disarmed");
    this.#clearExit();
    this.cancelLater();
    this.#current = "disarmed";
    this.#save();
    this.#o.setArmed(false);
    return plan;
  }

  /** The store's own mode changed by another way (the voice assistant, the control API, an older client): armed without a mode is away, disarmed is disarmed. */
  storeChanged(armed: boolean): void {
    if (!armed) { this.#clearExit(); this.cancelLater(); if (this.#current !== "disarmed") { this.#current = "disarmed"; this.#save(); } }
    else if (this.#current === "disarmed") { this.#current = "away"; this.#save(); }
  }

  #clearExit(): void {
    if (this.#exit) this.#timers.clear(this.#exit.handle);
    this.#exit = undefined;
  }

  // ---- the entry delays (the gate the alarm rules use) ----

  later(key: string, ms: number, run: () => void): void {
    if (this.#delayed.has(key)) return;   // a second opening of the same door does not extend the wait
    const handle = this.#timers.set(() => { this.#delayed.delete(key); run(); }, ms);
    this.#delayed.set(key, handle);
  }

  cancelLater(): void {
    for (const handle of this.#delayed.values()) this.#timers.clear(handle);
    this.#delayed.clear();
  }

  /** Whether an exit delay is running, and when it ends (ms); for the answer to a client. */
  exitUntil(): number | undefined { return this.#exit && this.#now() < this.#exit.until ? this.#exit.until : undefined; }

  // ---- the timetable ----

  /** Call about every few seconds: at the minute an entry names, in the time zone of the server (ARMOR_TZ), the mode changes once. It never disarms and, unless the administrator allowed it, never defends less. */
  tick(date: Date = new Date(this.#now())): void {
    if (!this.enabled || !this.#o.scheduleEnabled() || this.#doc.schedule.length === 0) return;
    const zone = ((): string | undefined => { const name = process.env.ARMOR_TZ?.trim(); try { if (name) { new Intl.DateTimeFormat("en-CA", { timeZone: name }); return name; } } catch { /* the machine's own */ } return undefined; })();
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(date).map(part => [part.type, part.value]));
    const at = `${parts.hour}:${parts.minute}`, day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(String(parts.weekday)) + 1;
    const minute = `${parts.year}-${parts.month}-${parts.day} ${at}`;
    if (minute === this.#lastTick) return;
    this.#lastTick = minute;
    const entry = this.#doc.schedule.find(item => item.at === at && item.days.includes(day));
    if (!entry) return;
    const plan = this.plan(entry.mode);
    if (plan.kind === "noop") return;
    if (plan.empty) { this.#o.report?.({ applied: false, mode: entry.mode, reason: "no_zones_assigned" }); return; }
    if (plan.lowers && !this.#o.scheduleMayLower()) { this.#o.report?.({ applied: false, mode: entry.mode, reason: "would_defend_less" }); return; }
    this.apply(entry.mode, { by: "schedule" });
    this.#o.report?.({ applied: true, mode: entry.mode });
  }

  #save(): void {
    const temporary = `${this.#o.file}.tmp`;
    fs.mkdirSync(path.dirname(this.#o.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, ...this.#doc, current: this.#current }, null, 2), { mode: 0o600 });
    durableRename(temporary, this.#o.file);
  }
}
