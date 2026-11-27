/**
 * The extremes of the cells of each battery module over the day: the lowest and the highest cell voltage seen, which cell it was and when, and the widest gap between the highest and the
 * lowest cell of the whole bank at one moment. A cell that sits at the edge for a minute is not news; one that reaches the same extreme every day is: this is what tells which module
 * to look at. The day is the server's day (day.ts), so it ends when the energy of the day ends.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { dayOf } from "./day.js";
import type { SolarMessage, SolarModule } from "./solar.js";
import { BATTERY_NOTICE_DEFAULTS, GapGate } from "./battery_notices.js";

export type CellReach = { v: number; cell: number; at: number };
export type ModuleExtremes = { n: number; min: CellReach; max: CellReach; delta_v: number };
export type BankEnd = { module: number; cell: number; v: number };
/** A reading left out of the extremes: a voltage no cell can have (range), or a wide gap that the next reading did not repeat (unconfirmed). */
export type Discarded = { at: number; module: number; cell?: number; v?: number; delta_v?: number; reason: "range" | "unconfirmed" };
export type DayCells = { date: string; modules: ModuleExtremes[]; bank_delta_v: number; bank?: { at: number; low: BankEnd; high: BankEnd }; reset_at?: number; discarded?: Discarded[] };
/** The plausible range of a cell voltage and the gap (millivolts) from which two readings are asked for. */
export type CellRules = { min_v: number; max_v: number; gap_mv: number };
export type CellsFile = Record<string, DayCells>;

const MAX_MODULES = 32, MAX_DISCARDED = 20;
const round = (value: number): number => Math.round(value * 1000) / 1000;

export class CellExtremes {
  readonly #days = new Map<string, DayCells>();
  readonly #gate = new GapGate();

  constructor(private readonly options: { dayOf?: (ms: number) => string; rules?: () => CellRules } = {}) {}

  #discard(day: DayCells, item: Discarded): void {
    const list = day.discarded ?? [];
    // the same bad voltage of the same cell, read again and again, is one line
    if (list.some(other => other.module === item.module && other.reason === item.reason && other.cell === item.cell && other.v === item.v && other.delta_v === item.delta_v)) return;
    day.discarded = [item, ...list].slice(0, MAX_DISCARDED);
  }

  /** Starts today again for one battery (a person looked at what was there). False when nothing was seen today. */
  reset(key: string, at: number): boolean {
    const day = this.get(key, at);
    if (!day) return false;
    this.#days.set(key, { date: day.date, modules: [], bank_delta_v: 0, reset_at: at });
    this.#gate.forget(`${key}/`);
    return true;
  }

  /** Looks at the cells of a battery message (nothing happens for an inverter or a module that did not send its cells). */
  observe(key: string, message: SolarMessage, at: number): void {
    if (message.kind !== "battery") return;
    const date = (this.options.dayOf ?? dayOf)(at);
    let day = this.#days.get(key);
    if (!day || day.date !== date) { day = { date, modules: [], bank_delta_v: 0 }; this.#days.set(key, day); }
    const rules = this.options.rules?.() ?? { min_v: BATTERY_NOTICE_DEFAULTS.cell_min_plausible_v, max_v: BATTERY_NOTICE_DEFAULTS.cell_max_plausible_v, gap_mv: 100 };
    let bankLow: BankEnd | undefined, bankHigh: BankEnd | undefined;
    const believed: string[] = [];
    for (const module of message.stack.slice(0, MAX_MODULES)) {
      const cells = (module as SolarModule).cells_v;
      if (!module.present || !Array.isArray(cells) || cells.length === 0) continue;
      let low = Infinity, high = -Infinity, lowCell = 0, highCell = 0;
      cells.forEach((value, index) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        if (value < rules.min_v || value > rules.max_v) { this.#discard(day, { at, module: module.n, cell: index + 1, v: value, reason: "range" }); return; }
        if (value < low) { low = value; lowCell = index + 1; }
        if (value > high) { high = value; highCell = index + 1; }
      });
      if (!Number.isFinite(low)) continue;
      const judged = this.#gate.judge(`${key}/${module.n}`, Math.round((high - low) * 1000), cells.join(","), rules.gap_mv, at);
      if (judged.dropped !== undefined) this.#discard(day, { at, module: module.n, delta_v: judged.dropped / 1000, reason: "unconfirmed" });
      if (judged.gap === undefined) continue;
      believed.push(cells.join(","));
      if (!bankLow || low < bankLow.v) bankLow = { module: module.n, cell: lowCell, v: low };
      if (!bankHigh || high > bankHigh.v) bankHigh = { module: module.n, cell: highCell, v: high };
      let entry = day.modules.find(item => item.n === module.n);
      if (!entry) {
        entry = { n: module.n, min: { v: low, cell: lowCell, at }, max: { v: high, cell: highCell, at }, delta_v: 0 };
        day.modules.push(entry);
        day.modules.sort((a, b) => a.n - b.n);
      }
      if (low < entry.min.v) entry.min = { v: low, cell: lowCell, at };
      if (high > entry.max.v) entry.max = { v: high, cell: highCell, at };
      entry.delta_v = Math.max(entry.delta_v, round(judged.gap / 1000));
    }
    if (!bankLow || !bankHigh) return;
    // the gap between modules is asked for twice as well
    const gap = round(bankHigh.v - bankLow.v);
    const bank = this.#gate.judge(`${key}/bank`, Math.round(gap * 1000), believed.join(";"), rules.gap_mv, at);
    if (bank.gap === undefined) return;
    if (round(bank.gap / 1000) > day.bank_delta_v) { day.bank_delta_v = round(bank.gap / 1000); day.bank = { at, low: bankLow, high: bankHigh }; }
  }

  /** Today's extremes of a battery, or undefined when none were seen today. */
  get(key: string, at: number): DayCells | undefined {
    const day = this.#days.get(key);
    return day && day.date === (this.options.dayOf ?? dayOf)(at) ? day : undefined;
  }

  forget(key: string): void { this.#days.delete(key); }

  export(): CellsFile { return Object.fromEntries(this.#days); }

  import(file: unknown): void {
    if (typeof file !== "object" || file === null) return;
    const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
    const reach = (value: unknown): CellReach | undefined => {
      const r = value as Partial<CellReach> | undefined;
      return r && finite(r.v) && finite(r.cell) && finite(r.at) && r.v >= 0 && r.v <= 10 ? { v: r.v, cell: r.cell, at: r.at } : undefined;
    };
    for (const [key, day] of Object.entries(file as Record<string, unknown>).slice(0, 64)) {
      if (!/^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(key) || typeof day !== "object" || day === null) continue;
      const item = day as Partial<DayCells>;
      if (typeof item.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Array.isArray(item.modules)) continue;
      const modules: ModuleExtremes[] = [];
      for (const raw of item.modules.slice(0, MAX_MODULES)) {
        const m = raw as Partial<ModuleExtremes>, min = reach(m.min), max = reach(m.max);
        if (finite(m.n) && min && max && finite(m.delta_v) && m.delta_v >= 0) modules.push({ n: m.n, min, max, delta_v: m.delta_v });
      }
      const end = (value: BankEnd | undefined): boolean => !!value && finite(value.module) && finite(value.cell) && finite(value.v);
      const bank = item.bank && finite(item.bank.at) && end(item.bank.low) && end(item.bank.high) ? item.bank : undefined;
      const discarded = Array.isArray(item.discarded) ? item.discarded.filter(d => d && finite(d.at) && finite(d.module) && (d.reason === "range" || d.reason === "unconfirmed")).slice(0, MAX_DISCARDED) : [];
      this.#days.set(key, { date: item.date, modules, bank_delta_v: finite(item.bank_delta_v) && item.bank_delta_v >= 0 ? item.bank_delta_v : 0, ...(bank ? { bank } : {}), ...(finite(item.reset_at) ? { reset_at: item.reset_at } : {}), ...(discarded.length ? { discarded } : {}) });
    }
  }
}
