/**
 * What is wrong with a battery module, in three levels, from what the node sends: a notice (the battery's own "High" or "Low": not an alarm), a protection or an alarm (OV, UV, OC,
 * temperature, and any word that is not known: nothing a BMS says is hidden) and a fault of the battery's electronics (SysError, or cells it does not read). The words are the
 * battery's own. A cell that reads 0 V is a fault when the node says so (`cells_unread`) or when it reads 0 V in two readings in a row: one spoiled reading is not a fault.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { SolarModule } from "./solar.js";

export type Level = 1 | 2 | 3;
/** `cell` counts from 0, as in the message. */
export type BatteryState = { column: string; word: string; cell?: number };
/** A cell below this is not being read: no cell of a working pack is there. */
export const UNREAD_BELOW_V = 0.1;

export const levelOf = (state: BatteryState): Level => (state.word === "SysError" ? 3 : /^(High|Low|COCAlm|DOCAlm)$/.test(state.word) && state.column !== "system" ? 1 : 2);

export type ModuleFault = { cells: number[]; word?: string };

/** Remembers which cells of each module read 0 V in the last reading, so that only a 0 V that repeats is a fault. */
export class UnreadCells {
  readonly #seen = new Map<string, { zeros: number[]; at: number; confirmed: number[] }>();

  /** The cells (from 0) of a module that are not being read. `at` is the reading's own time: the same reading seen twice does not confirm itself. */
  judge(key: string, module: SolarModule, at: number): number[] {
    const zeros = (module.cells_v ?? []).flatMap((v, index) => (v < UNREAD_BELOW_V ? [index] : []));
    const before = this.#seen.get(key);
    if (before && before.at === at) return before.confirmed;
    const repeated = before ? zeros.filter(cell => before.zeros.includes(cell)) : [];
    const confirmed = [...new Set([...(module.cells_unread ?? []), ...repeated])].sort((a, b) => a - b);
    if (this.#seen.size < 2048 || before) this.#seen.set(key, { zeros, at, confirmed });
    return confirmed;
  }
}

/** The fault of a module's electronics, if it has one. */
export function moduleFault(module: SolarModule, unread: number[]): ModuleFault | undefined {
  const system = (module.flags ?? []).some(state => state.word === "SysError") || module.state === "SysError";
  if (!system && unread.length === 0) return undefined;
  return { cells: unread, ...(system ? { word: "SysError" } : {}) };
}

/** The first protection or alarm a stack's modules say, so that an alarm can name the module, the column, the cell and the word. */
export function firstProtection(stack: readonly SolarModule[]): (BatteryState & { module: number }) | undefined {
  for (const module of stack) {
    if (!module.present) continue;
    const state = (module.flags ?? []).find(item => levelOf(item) === 2);
    if (state) return { ...state, module: module.n };
  }
  return undefined;
}
