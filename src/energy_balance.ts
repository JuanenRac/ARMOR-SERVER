/**
 * The energy balance of the house, worked out from what the solar plant and the electrical nodes already report, for information only (it never switches anything):
 *
 *   consumption = production + grid draw - battery charge        (watts; the grid draw is negative when the house feeds the grid)
 *   import      = the grid draw when positive;  export = minus the grid draw when negative
 *   self-consumption % = (production - export) / production       (what the house itself used of what the panels made, the battery included)
 *   autarky %   = 1 - import / consumption                        (how much of the use did not come from the grid)
 *
 * and three things it watches while the option `electrical.balance` is on (off by default):
 *   - an unexpected export: the house feeds the grid by more than `export_alert_w` for `hold_s` seconds although `allow_export` is off (an installation that must not inject);
 *   - a meter that disagrees: the consumption the balance works out differs from the load the inverters report by more than `mismatch_pct` and `mismatch_min_w` for `hold_s` seconds;
 *   - anomalies in the history of a channel: a channel in `watch_channels` ("node/channel", for instance a fridge) that was drawing power and has been flat at zero for `stopped_h` hours, a
 *     night standby that is higher than it used to be (the lowest draw of the last three hours against the low end of the hours before), and a phase of a three-phase node whose voltage fell
 *     to less than half of the others'.
 * What it finds is told as a warning in the alarm centre with its own code (grid_export_unexpected, meter_mismatch, consumption_appliance_stopped, consumption_standby_high,
 * consumption_phase_down), once while it lasts. The settings are a file (`energy-balance.json`); the thresholds are not in the code.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename } from "./durable.js";

export class BalanceInvalid extends Error {
  constructor(message: string, readonly code = "invalid_settings") { super(message); }
}

export type BalanceSettings = {
  allow_export: boolean;
  export_alert_w: number;
  hold_s: number;
  mismatch_pct: number;
  mismatch_min_w: number;
  stopped_h: number;
  /** "node/channel" of the channels whose history is looked at for anomalies. */
  watch_channels: string[];
};
export const DEFAULT_BALANCE: BalanceSettings = { allow_export: true, export_alert_w: 300, hold_s: 120, mismatch_pct: 40, mismatch_min_w: 500, stopped_h: 6, watch_channels: [] };
const RANGES = { export_alert_w: [10, 50_000], hold_s: [10, 3600], mismatch_pct: [10, 90], mismatch_min_w: [50, 50_000], stopped_h: [1, 48] } as const;
const WATCH = /^[a-z0-9][a-z0-9_-]{0,63}\/[A-Za-z0-9._-]{1,40}$/;
export const MAX_WATCH = 8;

export function parseBalanceSettings(value: unknown, base: BalanceSettings = DEFAULT_BALANCE): BalanceSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BalanceInvalid("the settings must be an object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!(key in DEFAULT_BALANCE)) throw new BalanceInvalid(`unknown setting ${key}`);
  const out: BalanceSettings = { ...base, watch_channels: [...base.watch_channels] };
  if ("allow_export" in input) { if (typeof input.allow_export !== "boolean") throw new BalanceInvalid("allow_export must be true or false"); out.allow_export = input.allow_export; }
  for (const key of ["export_alert_w", "hold_s", "mismatch_pct", "mismatch_min_w", "stopped_h"] as const) {
    if (!(key in input)) continue;
    const number = input[key], [low, high] = RANGES[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < low || number > high) throw new BalanceInvalid(`${key} must be a whole number from ${low} to ${high}`);
    out[key] = number;
  }
  if ("watch_channels" in input) {
    const list = input.watch_channels;
    if (!Array.isArray(list) || list.length > MAX_WATCH || !list.every(item => typeof item === "string" && WATCH.test(item)) || new Set(list).size !== list.length) throw new BalanceInvalid(`watch_channels is a list of up to ${MAX_WATCH} different "node/channel" names`);
    out.watch_channels = [...list as string[]];
  }
  return out;
}

export type BalanceInput = { production_w: number | null; battery_w: number | null; grid_w: number | null; load_w: number | null };
export type Balance = {
  production_w: number | null; consumption_w: number | null; import_w: number | null; export_w: number | null; battery_charge_w: number | null;
  self_consumption_pct: number | null; autarky_pct: number | null; reported_load_w: number | null;
};
const round = (value: number, digits = 0): number => { const f = 10 ** digits; return Math.round(value * f) / f; };

/** The balance of a moment. A figure that cannot be worked out from what is reported is null, never a guess. */
export function balanceOf(input: BalanceInput): Balance {
  const { production_w: pv, battery_w: battery, grid_w: grid, load_w: load } = input;
  const consumption = grid === null ? null : Math.max(0, (pv ?? 0) + grid - (battery ?? 0));
  const importW = grid === null ? null : Math.max(0, grid);
  const exportW = grid === null ? null : Math.max(0, -grid);
  return {
    production_w: pv === null ? null : round(pv), consumption_w: consumption === null ? null : round(consumption), import_w: importW === null ? null : round(importW), export_w: exportW === null ? null : round(exportW),
    battery_charge_w: battery === null ? null : round(battery), reported_load_w: load === null ? null : round(load),
    self_consumption_pct: pv !== null && pv > 50 && exportW !== null ? round(Math.min(100, Math.max(0, ((pv - exportW) / pv) * 100)), 1) : null,
    autarky_pct: consumption !== null && consumption > 50 && importW !== null ? round(Math.min(100, Math.max(0, (1 - importW / consumption) * 100)), 1) : null,
  };
}

export type PowerSample = { t: number; power_w?: number };
export type Anomaly = { kind: "appliance_stopped" | "standby_high"; channel: string; detail: Record<string, number> };

/** A channel that was drawing power and has been flat at zero for `stoppedH` hours. `samples` cover at least a day, oldest first. */
export function applianceStopped(samples: PowerSample[], nowMs: number, stoppedH: number): boolean {
  const cut = nowMs - stoppedH * 3_600_000;
  const recent = samples.filter(sample => sample.t >= cut && typeof sample.power_w === "number");
  const before = samples.filter(sample => sample.t < cut && typeof sample.power_w === "number");
  if (recent.length < 3 || before.length < 10 || samples[0].t > cut - 3_600_000) return false;     // not enough history on either side
  const active = before.filter(sample => (sample.power_w as number) >= 30).length / before.length;
  return active >= 0.05 && recent.every(sample => (sample.power_w as number) < 5);
}

/** The lowest draw of the last three hours against the low end (10th percentile) of the hours before: higher by more than 50 W and by half again means something stays on. */
export function standbyHigh(samples: PowerSample[], nowMs: number): { recent_min_w: number; baseline_w: number } | null {
  const cut = nowMs - 3 * 3_600_000;
  const recent = samples.filter(sample => sample.t >= cut && typeof sample.power_w === "number").map(sample => sample.power_w as number);
  const before = samples.filter(sample => sample.t < cut && typeof sample.power_w === "number").map(sample => sample.power_w as number).sort((a, b) => a - b);
  if (recent.length < 6 || before.length < 20 || samples[0].t > cut - 6 * 3_600_000) return null;
  const baseline = before[Math.floor(before.length * 0.1)];
  const recentMin = Math.min(...recent);
  return recentMin > baseline + 50 && recentMin > baseline * 1.5 ? { recent_min_w: round(recentMin), baseline_w: round(baseline) } : null;
}

/** The phases of a three-phase node whose voltage fell to less than half of the others' (which are all of a mains level). */
export function phaseDown(channels: Array<{ id: string; voltage_v?: number }>): string[] {
  const phases = channels.filter(channel => /^(l[123]|phase[ _-]?[123])$/i.test(channel.id) && typeof channel.voltage_v === "number");
  if (phases.length < 2) return [];
  const volts = phases.map(channel => channel.voltage_v as number).sort((a, b) => a - b);
  const median = volts[Math.floor(volts.length / 2)];
  if (median < 180) return [];
  return phases.filter(channel => (channel.voltage_v as number) < median / 2).map(channel => channel.id);
}

export type BalanceFinding = { code: "grid_export_unexpected" | "meter_mismatch" | "consumption_appliance_stopped" | "consumption_standby_high" | "consumption_phase_down"; key: string; source: string; detail: Record<string, number | string> };

export type WatcherOptions = {
  file: string;
  enabled: () => boolean;
  /** The figures of this moment (null when not reported). */
  inputs: () => BalanceInput;
  /** The history of a channel of a node over `minutes`, oldest first; undefined when there is none. */
  history: (node: string, channel: string, minutes: number) => PowerSample[] | undefined;
  /** The channels (id and voltage) of every electrical node that reports. */
  nodes: () => Array<{ node_id: string; channels: Array<{ id: string; voltage_v?: number }> }>;
  /** Raises (active) or ends (not active) a warning with this key. */
  report: (finding: BalanceFinding, active: boolean) => void;
  now?: () => number;
};

export class BalanceWatcher {
  readonly #o: WatcherOptions;
  #settings: BalanceSettings = { ...DEFAULT_BALANCE, watch_channels: [] };
  readonly #since = new Map<string, number>();
  readonly #active = new Map<string, BalanceFinding>();
  #lastHistoryCheck = 0;

  constructor(options: WatcherOptions) {
    this.#o = options;
    try { this.#settings = parseBalanceSettings((JSON.parse(fs.readFileSync(options.file, "utf8")) as { settings?: unknown }).settings ?? {}); } catch { /* none yet */ }
  }

  get settings(): BalanceSettings { return { ...this.#settings, watch_channels: [...this.#settings.watch_channels] }; }

  configure(value: unknown): BalanceSettings {
    this.#settings = parseBalanceSettings(value, this.#settings);
    fs.mkdirSync(path.dirname(this.#o.file), { recursive: true });
    const temporary = `${this.#o.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, settings: this.#settings }, null, 2), { encoding: "utf8", mode: 0o600 });
    durableRename(temporary, this.#o.file);
    return this.settings;
  }

  status(): { enabled: boolean; settings: BalanceSettings; balance: Balance; findings: BalanceFinding[] } {
    return { enabled: this.#o.enabled(), settings: this.settings, balance: balanceOf(this.#o.inputs()), findings: [...this.#active.values()] };
  }

  /** A condition that has to last `hold_s` before it is told, and ends the moment it does not hold. */
  #hold(finding: BalanceFinding, holds: boolean, now: number): void {
    const key = finding.key;
    if (!holds) { this.#since.delete(key); if (this.#active.delete(key)) this.#o.report(finding, false); return; }
    const since = this.#since.get(key) ?? now;
    this.#since.set(key, since);
    if (now - since >= this.#settings.hold_s * 1000 && !this.#active.has(key)) { this.#active.set(key, finding); this.#o.report(finding, true); }
  }

  /** Once a few seconds. Never throws. */
  tick(): void {
    try {
      if (!this.#o.enabled()) { for (const finding of [...this.#active.values()]) this.#o.report(finding, false); this.#active.clear(); this.#since.clear(); return; }
      const now = (this.#o.now ?? Date.now)();
      const balance = balanceOf(this.#o.inputs());
      const settings = this.#settings;
      this.#hold({ code: "grid_export_unexpected", key: "balance:export", source: "grid", detail: { export_w: balance.export_w ?? 0 } }, !settings.allow_export && (balance.export_w ?? 0) > settings.export_alert_w, now);
      const reported = balance.reported_load_w, worked = balance.consumption_w;
      const off = reported !== null && worked !== null ? Math.abs(worked - reported) : 0;
      this.#hold({ code: "meter_mismatch", key: "balance:mismatch", source: "meters", detail: { worked_w: worked ?? 0, reported_w: reported ?? 0 } },
        reported !== null && worked !== null && off >= settings.mismatch_min_w && off >= (Math.max(worked, reported) * settings.mismatch_pct) / 100, now);
      if (now - this.#lastHistoryCheck >= 60_000) { this.#lastHistoryCheck = now; this.#checkHistory(now); }
    } catch { /* a failed look never stops the next */ }
  }

  #checkHistory(now: number): void {
    for (const name of this.#settings.watch_channels) {
      const [node, channel] = name.split("/");
      const samples = this.#o.history(node, channel, 1440);
      const stopped = samples !== undefined && applianceStopped(samples, now, this.#settings.stopped_h);
      this.#set({ code: "consumption_appliance_stopped", key: `balance:stopped:${name}`, source: name, detail: { hours: this.#settings.stopped_h } }, stopped);
      const standby = samples === undefined ? null : standbyHigh(samples, now);
      this.#set({ code: "consumption_standby_high", key: `balance:standby:${name}`, source: name, detail: standby ?? {} }, standby !== null);
    }
    const down = new Set<string>();
    for (const node of this.#o.nodes()) for (const id of phaseDown(node.channels)) down.add(`${node.node_id}/${id}`);
    for (const key of [...this.#active.keys()]) if (key.startsWith("balance:phase:") && !down.has(key.slice("balance:phase:".length))) { const finding = this.#active.get(key) as BalanceFinding; this.#active.delete(key); this.#o.report(finding, false); }
    for (const name of down) this.#set({ code: "consumption_phase_down", key: `balance:phase:${name}`, source: name, detail: {} }, true);
  }

  #set(finding: BalanceFinding, active: boolean): void {
    const was = this.#active.has(finding.key);
    if (active && !was) { this.#active.set(finding.key, finding); this.#o.report(finding, true); }
    else if (!active && was) { this.#active.delete(finding.key); this.#o.report(finding, false); }
  }
}
