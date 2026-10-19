/**
 * The extremes of the cells of each battery module over the day: the lowest and the highest cell voltage seen, which cell it was and when, and the widest gap between the highest and the
 * lowest cell of the whole bank at one moment. A cell that sits at the edge for a minute is not news; one that reaches the same extreme every day is: this is what tells which module
 * to look at. The day is the server's day (day.ts), so it ends when the energy of the day ends.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { dayOf } from "./day.js";
import type { SolarMessage, SolarModule } from "./solar.js";

export type CellReach = { v: number; cell: number; at: number };
export type ModuleExtremes = { n: number; min: CellReach; max: CellReach; delta_v: number };
export type DayCells = { date: string; modules: ModuleExtremes[]; bank_delta_v: number };
export type CellsFile = Record<string, DayCells>;

const MAX_MODULES = 32;
const round = (value: number): number => Math.round(value * 1000) / 1000;

export class CellExtremes {
  readonly #days = new Map<string, DayCells>();
  constructor(private readonly options: { dayOf?: (ms: number) => string } = {}) {}

  /** Looks at the cells of a battery message (nothing happens for an inverter or a module that did not send its cells). */
  observe(key: string, message: SolarMessage, at: number): void {
    if (message.kind !== "battery") return;
    const date = (this.options.dayOf ?? dayOf)(at);
    let day = this.#days.get(key);
    if (!day || day.date !== date) { day = { date, modules: [], bank_delta_v: 0 }; this.#days.set(key, day); }
    let bankLow = Infinity, bankHigh = -Infinity;
    for (const module of message.stack.slice(0, MAX_MODULES)) {
      const cells = (module as SolarModule).cells_v;
      if (!module.present || !Array.isArray(cells) || cells.length === 0) continue;
      let low = Infinity, high = -Infinity, lowCell = 0, highCell = 0;
      cells.forEach((value, index) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        if (value < low) { low = value; lowCell = index + 1; }
        if (value > high) { high = value; highCell = index + 1; }
      });
      if (!Number.isFinite(low)) continue;
      bankLow = Math.min(bankLow, low); bankHigh = Math.max(bankHigh, high);
      let entry = day.modules.find(item => item.n === module.n);
      if (!entry) {
        entry = { n: module.n, min: { v: low, cell: lowCell, at }, max: { v: high, cell: highCell, at }, delta_v: 0 };
        day.modules.push(entry);
        day.modules.sort((a, b) => a.n - b.n);
      }
      if (low < entry.min.v) entry.min = { v: low, cell: lowCell, at };
      if (high > entry.max.v) entry.max = { v: high, cell: highCell, at };
      entry.delta_v = Math.max(entry.delta_v, round(high - low));
    }
    if (Number.isFinite(bankLow)) day.bank_delta_v = Math.max(day.bank_delta_v, round(bankHigh - bankLow));
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
      this.#days.set(key, { date: item.date, modules, bank_delta_v: finite(item.bank_delta_v) && item.bank_delta_v >= 0 ? item.bank_delta_v : 0 });
    }
  }
}
