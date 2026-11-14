/**
 * Load shedding: when the house draws more from the grid than an administrator allows, the loads that the administrator named as not critical are switched off, one at a time, and
 * switched on again, in the opposite order, once the draw is well below the limit. It is behind a security option (`electrical.load_shedding`, off by default) and it only ever touches
 * a device that is in the explicit list of the settings (never a critical circuit, whatever the list says), it only switches on what it switched off itself, and everything it does is
 * written in a log that Studio shows. It reads the grid power the electrical nodes report (`grid_w`, positive when the house draws from the grid) and acts on the devices the registry
 * knows (smart plugs and relays), so it does not replace the interlock of a transfer switch, which it never touches.
 *
 * The limits live in the settings file `load-shedding.json`: `limit_w` (shed above it), `restore_w` (switch on again below it: the hysteresis, at least `min_gap_w` under the limit),
 * `hold_s` (how long the draw must stay beyond a limit before anything is done), `step_s` (the least time between two actions) and `loads` (up to 16 devices, the first is the first to
 * be shed). A reading that is old or missing does nothing; turning the option off, or removing a load from the list, switches back on what was shed.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";

export class SheddingInvalid extends Error {
  constructor(message: string, readonly code = "invalid_settings") { super(message); }
}

export type SheddingSettings = {
  limit_w: number;
  restore_w: number;
  hold_s: number;
  step_s: number;
  /** The devices that may be switched off, in the order they are shed. */
  loads: string[];
};
export const MAX_LOADS = 16;
export const MIN_GAP_W = 100;
export const DEFAULT_SHEDDING: SheddingSettings = { limit_w: 5000, restore_w: 3500, hold_s: 30, step_s: 20, loads: [] };
const RANGES = { limit_w: [200, 100_000], restore_w: [100, 100_000], hold_s: [5, 3600], step_s: [5, 3600] } as const;
const DEVICE_ID = /^[A-Za-z0-9._-]{1,80}$/;

export function parseSheddingSettings(value: unknown, base: SheddingSettings = DEFAULT_SHEDDING): SheddingSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SheddingInvalid("the settings must be an object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!(key in DEFAULT_SHEDDING)) throw new SheddingInvalid(`unknown setting ${key}`);
  const out: SheddingSettings = { ...base, loads: [...base.loads] };
  for (const key of ["limit_w", "restore_w", "hold_s", "step_s"] as const) {
    if (!(key in input)) continue;
    const number = input[key];
    const [low, high] = RANGES[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < low || number > high) throw new SheddingInvalid(`${key} must be a whole number from ${low} to ${high}`);
    out[key] = number;
  }
  if ("loads" in input) {
    const loads = input.loads;
    if (!Array.isArray(loads) || loads.length > MAX_LOADS || !loads.every(item => typeof item === "string" && DEVICE_ID.test(item)) || new Set(loads).size !== loads.length) throw new SheddingInvalid(`loads is a list of up to ${MAX_LOADS} different device ids`);
    out.loads = [...loads as string[]];
  }
  if (out.restore_w > out.limit_w - MIN_GAP_W) throw new SheddingInvalid(`restore_w must be at least ${MIN_GAP_W} W under limit_w, or the loads would be switched on and off over and over`);
  return out;
}

export type SheddingLogEntry = { at: string; action: "shed" | "restore" | "refused" | "failed" | "released"; device: string; grid_w: number | null; detail?: string };

export type SheddingOptions = {
  file: string;
  /** The option `electrical.load_shedding`. */
  enabled: () => boolean;
  /** The power drawn from the grid in watts (negative when the house feeds it); null when nothing reports it or the reading is old. */
  gridW: () => number | null;
  /** What the registry says about a device: whether it exists, whether it is a critical circuit and whether it can be switched. */
  device: (id: string) => { exists: boolean; critical: boolean } | undefined;
  /** Switches a device; rejects when it cannot. */
  command: (id: string, command: "on" | "off") => Promise<unknown>;
  now?: () => number;
  /** Told of what was done, for the history of the system. */
  onEvent?: (entry: SheddingLogEntry) => void;
};

export class LoadShedding {
  readonly #o: SheddingOptions;
  #settings: SheddingSettings = { ...DEFAULT_SHEDDING, loads: [] };
  /** The devices this module switched off and has not yet switched on again, in the order they were shed. */
  #shed: string[] = [];
  #log: SheddingLogEntry[] = [];
  #over = 0;        // since when the draw is above the limit (ms), 0 = not
  #under = 0;       // since when it is below the restore level
  #lastAction = 0;
  /** The devices already told as refused during this stretch over the limit (one line in the log, not one a second). */
  readonly #refused = new Set<string>();
  #busy = false;

  constructor(options: SheddingOptions) {
    this.#o = options;
    try {
      const raw = JSON.parse(fs.readFileSync(options.file, "utf8")) as { settings?: unknown; shed?: unknown };
      this.#settings = parseSheddingSettings(raw.settings ?? {});
      if (Array.isArray(raw.shed)) this.#shed = raw.shed.filter((item): item is string => typeof item === "string" && DEVICE_ID.test(item));
    } catch { /* none yet */ }
  }

  #now(): number { return (this.#o.now ?? Date.now)(); }
  get settings(): SheddingSettings { return { ...this.#settings, loads: [...this.#settings.loads] }; }

  #save(): void {
    try {
      fs.mkdirSync(path.dirname(this.#o.file), { recursive: true });
      const temporary = `${this.#o.file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, settings: this.#settings, shed: this.#shed }, null, 2), { encoding: "utf8", mode: 0o600 });
      durableRename(temporary, this.#o.file);
    } catch { /* the state is still held in memory */ }
  }

  configure(value: unknown): SheddingSettings {
    const next = parseSheddingSettings(value, this.#settings);
    this.#settings = next;
    this.#save();
    return this.settings;
  }

  status(): { enabled: boolean; settings: SheddingSettings; shed: string[]; grid_w: number | null; log: SheddingLogEntry[] } {
    return { enabled: this.#o.enabled(), settings: this.settings, shed: [...this.#shed], grid_w: this.#o.gridW(), log: [...this.#log].reverse() };
  }

  #record(entry: Omit<SheddingLogEntry, "at">): void {
    const full: SheddingLogEntry = { at: new Date(this.#now()).toISOString(), ...entry };
    this.#log.push(full);
    if (this.#log.length > 100) this.#log.splice(0, this.#log.length - 100);
    try { this.#o.onEvent?.(full); } catch { /* whoever listens must not stop the module */ }
  }

  /** Once a second or so. Does at most one switch per call; never throws. Returns what it did. */
  async tick(): Promise<"shed" | "restore" | "released" | null> {
    if (this.#busy) return null;
    this.#busy = true;
    try {
      const now = this.#now();
      if (!this.#o.enabled()) return await this.#releaseAll("the option is off");
      // a device that left the list is given back to its owner
      const gone = this.#shed.find(id => !this.#settings.loads.includes(id));
      if (gone !== undefined) return await this.#restore(gone, "removed from the list");
      const grid = this.#o.gridW();
      if (grid === null) { this.#over = 0; this.#under = 0; return null; }
      this.#over = grid > this.#settings.limit_w ? this.#over || now : 0;
      if (!this.#over) this.#refused.clear();
      this.#under = grid < this.#settings.restore_w ? this.#under || now : 0;
      if (now - this.#lastAction < this.#settings.step_s * 1000) return null;
      if (this.#over && now - this.#over >= this.#settings.hold_s * 1000) {
        for (const id of this.#settings.loads) {
          if (this.#shed.includes(id)) continue;
          const info = this.#o.device(id);
          if (!info?.exists || info.critical) {
            if (!this.#refused.has(id)) { this.#refused.add(id); this.#record({ action: "refused", device: id, grid_w: grid, detail: info?.exists ? "a critical circuit is never shed" : "not a known device" }); }
            continue;
          }
          this.#lastAction = now;
          try { await this.#o.command(id, "off"); } catch (error) { this.#record({ action: "failed", device: id, grid_w: grid, detail: error instanceof Error ? error.message : "not switched" }); return null; }
          this.#shed.push(id);
          this.#save();
          this.#record({ action: "shed", device: id, grid_w: grid });
          return "shed";
        }
        return null;
      }
      if (this.#under && now - this.#under >= this.#settings.hold_s * 1000 && this.#shed.length > 0) return await this.#restore(this.#shed[this.#shed.length - 1], undefined);
      return null;
    } finally { this.#busy = false; }
  }

  async #restore(id: string, why: string | undefined): Promise<"restore" | null> {
    this.#lastAction = this.#now();
    try { await this.#o.command(id, "on"); } catch (error) { this.#record({ action: "failed", device: id, grid_w: this.#o.gridW(), detail: error instanceof Error ? error.message : "not switched on" }); return null; }
    this.#shed = this.#shed.filter(item => item !== id);
    this.#save();
    this.#record({ action: "restore", device: id, grid_w: this.#o.gridW(), ...(why ? { detail: why } : {}) });
    return "restore";
  }

  async #releaseAll(why: string): Promise<"released" | null> {
    if (this.#shed.length === 0) return null;
    this.#over = 0; this.#under = 0;
    for (const id of [...this.#shed].reverse()) {
      try { await this.#o.command(id, "on"); this.#shed = this.#shed.filter(item => item !== id); this.#record({ action: "released", device: id, grid_w: this.#o.gridW(), detail: why }); }
      catch (error) { this.#record({ action: "failed", device: id, grid_w: this.#o.gridW(), detail: error instanceof Error ? error.message : "not switched on" }); }
    }
    this.#save();
    return "released";
  }
}
