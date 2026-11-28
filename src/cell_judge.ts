/**
 * When the difference between the cells of a battery says something, and what it was at each full charge.
 *
 * A gap measured at the ends of the charge, or in the cold, is naturally wide and does not by itself mean an unbalanced battery. Such a gap is neither raised nor taken
 * as cleared. It never hides much: a gap of `hard_factor` times the level is judged whatever the conditions, a reading that does not give the state of charge, the current
 * or the temperature is judged as before, and the protections and faults of the battery do not pass through here. The levels are those of `cell-judge.json` in the data
 * directory (they are starting values, not a maker's figures; the history of the full charges is there to compare them with).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { JsonFile } from "./history.js";

export type CellJudgeSettings = {
  /** The state of charge between which a battery that is charging or discharging is judged. */
  soc_min: number; soc_max: number;
  /** The same for a battery at rest (under `rest_current_a` either way). */
  rest_soc_min: number; rest_soc_max: number; rest_current_a: number;
  /** At or under this temperature (degrees) the gap is not judged. */
  temp_min_c: number;
  /** A gap of this many times the level is judged always. 1 judges everything, as without these conditions. */
  hard_factor: number;
  /** A charge counts as full from this state of charge; its figures are those of its last `full_minutes`. */
  full_soc: number; full_minutes: number;
};

export const CELL_JUDGE_DEFAULTS: CellJudgeSettings = { soc_min: 15, soc_max: 95, rest_soc_min: 10, rest_soc_max: 85, rest_current_a: 0.5, temp_min_c: 5, hard_factor: 2, full_soc: 98, full_minutes: 15 };

const RANGES: Record<keyof CellJudgeSettings, readonly [number, number]> = {
  soc_min: [0, 100], soc_max: [0, 100], rest_soc_min: [0, 100], rest_soc_max: [0, 100], rest_current_a: [0, 100], temp_min_c: [-40, 40], hard_factor: [1, 10], full_soc: [50, 100], full_minutes: [1, 240],
};

/** The settings of a file's content: each value that is missing or out of its range keeps its default. */
export function parseCellJudgeSettings(value: unknown): CellJudgeSettings {
  const out = { ...CELL_JUDGE_DEFAULTS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(RANGES) as Array<keyof CellJudgeSettings>) {
    const item = body[key], [low, high] = RANGES[key];
    if (typeof item === "number" && Number.isFinite(item) && item >= low && item <= high) out[key] = item;
  }
  return out;
}

export type CellReading = { soc_percent?: number | undefined; current_a?: number | undefined; temperature_min_c?: number | undefined };

/** Whether a gap of `spreadMv` over a level of `levelMv` can be judged with this reading. */
export function gapCanBeJudged(reading: CellReading, spreadMv: number, levelMv: number, settings: CellJudgeSettings = CELL_JUDGE_DEFAULTS): boolean {
  if (spreadMv >= levelMv * settings.hard_factor) return true;
  const { soc_percent: soc, current_a: current, temperature_min_c: cold } = reading;
  if (soc === undefined || current === undefined || cold === undefined) return true;
  if (cold <= settings.temp_min_c) return false;
  const resting = Math.abs(current) < settings.rest_current_a;
  return resting ? soc >= settings.rest_soc_min && soc <= settings.rest_soc_max : soc >= settings.soc_min && soc <= settings.soc_max;
}

export type FullCharge = { ended_ms: number; minutes: number; mean_gap_mv: number; max_gap_mv: number };
type Running = { since: number; samples: Array<[number, number]>; max: number };
type Saved = { id: string; charges: FullCharge[] };

const MAX_BATTERIES = 64, MAX_CHARGES = 30, MAX_SAMPLES = 2000;
/** A stretch with no reading for this long is another charge. */
const SILENCE_MS = 10 * 60_000;

/** Follows every full charge of every battery stack: the mean and widest cell gap of its last minutes. Kept in the data directory. */
export class FullCharges {
  readonly #charges = new Map<string, FullCharge[]>();
  readonly #running = new Map<string, Running>();
  readonly #file: JsonFile<Saved[]> | undefined;

  constructor(file?: string, private readonly settings: CellJudgeSettings = CELL_JUDGE_DEFAULTS) {
    if (!file) return;
    this.#file = new JsonFile<Saved[]>(file);
    const saved = this.#file.read();
    if (Array.isArray(saved)) for (const item of saved.slice(0, MAX_BATTERIES)) if (typeof item?.id === "string" && Array.isArray(item.charges)) this.#charges.set(item.id, item.charges.slice(-MAX_CHARGES));
  }

  /** One reading of a stack: its state of charge and the gap between its highest and lowest cell (millivolts). */
  note(id: string, at: number, soc: number | undefined, gapMv: number | undefined): void {
    let running = this.#running.get(id);
    if (running && at - running.samples[running.samples.length - 1]![0] > SILENCE_MS) { this.#close(id, running); running = undefined; }
    if (soc === undefined) return;
    if (soc >= this.settings.full_soc && gapMv !== undefined) {
      if (!running) {
        if (this.#running.size >= MAX_BATTERIES) return;
        running = { since: at, samples: [], max: 0 };
        this.#running.set(id, running);
      }
      running.samples.push([at, gapMv]);
      if (running.samples.length > MAX_SAMPLES) running.samples.shift();
      running.max = Math.max(running.max, gapMv);
    } else if (running && soc < this.settings.full_soc - 1) this.#close(id, running);
  }

  list(): Array<{ id: string; charges: FullCharge[] }> {
    return [...this.#charges].sort(([a], [b]) => a.localeCompare(b)).map(([id, charges]) => ({ id, charges }));
  }

  #close(id: string, running: Running): void {
    this.#running.delete(id);
    const end = running.samples[running.samples.length - 1]![0];
    const last = running.samples.filter(([at]) => at >= end - this.settings.full_minutes * 60_000);
    const mean = Math.round(last.reduce((sum, [, gap]) => sum + gap, 0) / last.length);
    const charge = { ended_ms: end, minutes: Math.round((end - running.since) / 60_000), mean_gap_mv: mean, max_gap_mv: Math.round(running.max) };
    if (!this.#charges.has(id) && this.#charges.size >= MAX_BATTERIES) return;
    this.#charges.set(id, [...(this.#charges.get(id) ?? []), charge].slice(-MAX_CHARGES));
    this.#file?.write([...this.#charges].map(([key, charges]) => ({ id: key, charges })));
  }
}
