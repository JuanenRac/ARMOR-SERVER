/**
 * The history of every battery module and its cells, kept on disk so that it survives Studio and the server being closed. It is made for a small machine: nothing of it stays in memory
 * but the points of the last minute and the open five-minute averages; the files are only ever appended to (one for each day), and a size limit takes the oldest day away.
 *   fine-DATE.jsonl    one point per module every `everyS` seconds, kept for the last day
 *   coarse-DATE.jsonl  five-minute averages, kept `days` days
 * A line is [key, t, voltage, current, soc, temperature, cells], with key = node/device/module.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { COARSE_EVERY_MS, type Sample } from "./history.js";
import type { SolarMessage } from "./solar.js";

type Tier = "fine" | "coarse";
type Reading = number | null;
/** voltage, current, state of charge, temperature, and the voltage of each cell. */
type Row = [string, number, Reading, Reading, Reading, Reading, Reading[]];
type Average = { bucket: number; sums: number[]; counts: number[] };

const DAY_MS = 86_400_000, MAX_MODULES = 32, MAX_CELLS = 32, MAX_TRACKS = 512;
const NAME = /^(fine|coarse)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const round = (value: number): number => Math.round(value * 1000) / 1000;
const reading = (value: unknown): Reading => (typeof value === "number" && Number.isFinite(value) ? value : null);

export type BatteryHistoryOptions = {
  dir: string;
  /** Days the five-minute averages are kept; 0: nothing is recorded. */
  days: number;
  /** Seconds between two points of the last day. */
  everyS: number;
  /** The most bytes the files may take together. */
  maxBytes: number;
  now?: () => number;
  warn?: (message: string) => void;
};

export class BatteryHistory {
  readonly #options: BatteryHistoryOptions;
  readonly #now: () => number;
  /** Lines waiting for the next flush, by file name. */
  #pending = new Map<string, Row[]>();
  readonly #last = new Map<string, number>();
  readonly #averages = new Map<string, Average>();
  #failing = false;

  constructor(options: BatteryHistoryOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  get days(): number { return this.#options.days; }
  get everyS(): number { return this.#options.everyS; }

  /** Takes a real battery message; a module is recorded at most once every `everyS` seconds. */
  record(message: SolarMessage): void {
    if (message.kind !== "battery" || this.#options.days === 0) return;
    const now = this.#now();
    for (const module of message.stack.slice(0, MAX_MODULES)) {
      if (!module.present || !Number.isInteger(module.n) || module.n < 1 || module.n > MAX_MODULES) continue;
      const key = `${message.node_id}/${message.device}/${module.n}`;
      const last = this.#last.get(key);
      if (last === undefined && this.#last.size >= MAX_TRACKS) continue;
      // a clock that was set back does not stop the recording
      if (last !== undefined && now >= last && now - last < this.#options.everyS * 1000) continue;
      this.#last.set(key, now);
      const cells = Array.isArray(module.cells_v) ? module.cells_v.slice(0, MAX_CELLS).map(reading) : [];
      const row: Row = [key, now, reading(module.voltage_v), reading(module.current_a), reading(module.soc_percent), reading(module.temperature_c), cells];
      this.#push("fine", row);
      this.#average(row);
    }
  }

  /** Writes what is waiting and applies the retention and the size limit. Called now and then and on the way out. */
  flush(): void {
    const now = this.#now(), bucket = Math.floor(now / COARSE_EVERY_MS);
    for (const [key, average] of this.#averages) if (average.bucket < bucket) { this.#push("coarse", rowOf(key, average)); this.#averages.delete(key); }
    if (this.#options.days === 0) return;
    const pending = this.#pending;
    this.#pending = new Map();
    try {
      if (pending.size > 0) fs.mkdirSync(this.#options.dir, { recursive: true });
      for (const [name, rows] of pending) append(path.join(this.#options.dir, name), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      this.#prune(now);
      this.#failing = false;
    } catch (error) {
      if (!this.#failing) this.#options.warn?.(`the battery history could not be written: ${error instanceof Error ? error.message : "unknown error"}`);
      this.#failing = true;
    }
  }

  /** The last flush: the averages that are still filling are written as they stand. */
  close(): void {
    for (const [key, average] of this.#averages) this.#push("coarse", rowOf(key, average));
    this.#averages.clear();
    this.flush();
  }

  /** One module and its cells, oldest first: the points of the last day, or the five-minute averages beyond it. */
  async query(node: string, device: string, module: number, minutes: number): Promise<Sample[]> {
    if (this.#options.days === 0) return [];
    const key = `${node}/${device}/${module}`, now = this.#now();
    const tier: Tier = minutes <= 1440 ? "fine" : "coarse";
    const since = Math.max(now - minutes * 60_000, now - this.#options.days * DAY_MS);
    const rows = new Map<number, Row>();
    const take = (row: Row): void => { if (row[0] === key && row[1] >= since) rows.set(row[1], row); };
    const prefix = `[${JSON.stringify(key)},`;
    // one day at a time, so that a month never sits in memory at once
    for (const file of this.#files().filter(item => item.tier === tier && item.date >= dateOf(since))) {
      let text: string;
      try { text = await fs.promises.readFile(path.join(this.#options.dir, file.name), "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line.startsWith(prefix)) continue;
        const row = parse(line);
        if (row) take(row);
      }
    }
    for (const [name, waiting] of this.#pending) if (name.startsWith(`${tier}-`)) for (const row of waiting) take(row);
    const open = tier === "coarse" ? this.#averages.get(key) : undefined;
    if (open) take(rowOf(key, open));
    return [...rows.values()].sort((a, b) => a[1] - b[1]).map(sampleOf);
  }

  /** Takes away the history of one device (it was removed from the installation). */
  forget(node: string, device: string): void {
    const start = `${node}/${device}/`;
    for (const key of [...this.#last.keys()]) if (key.startsWith(start)) this.#last.delete(key);
    for (const key of [...this.#averages.keys()]) if (key.startsWith(start)) this.#averages.delete(key);
    for (const [name, rows] of this.#pending) this.#pending.set(name, rows.filter(row => !row[0].startsWith(start)));
    const prefix = `["${start}`;
    for (const file of this.#files()) {
      const full = path.join(this.#options.dir, file.name);
      try {
        const lines = fs.readFileSync(full, "utf8").split("\n");
        const kept = lines.filter(line => !line.startsWith(prefix));
        if (kept.length === lines.length) continue;
        const temporary = `${full}.tmp`;
        fs.writeFileSync(temporary, kept.join("\n"), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temporary, full);
      } catch (error) { this.#options.warn?.(`the battery history of ${node}/${device} could not be removed: ${error instanceof Error ? error.message : "unknown error"}`); }
    }
  }

  /** The bytes the files take now. */
  size(): number { return this.#files().reduce((sum, file) => sum + file.bytes, 0); }

  #push(tier: Tier, row: Row): void {
    const name = `${tier}-${dateOf(row[1])}.jsonl`;
    const rows = this.#pending.get(name);
    if (rows) rows.push(row); else this.#pending.set(name, [row]);
  }

  #average(row: Row): void {
    const [key, t] = row, bucket = Math.floor(t / COARSE_EVERY_MS);
    let average = this.#averages.get(key);
    if (average && average.bucket !== bucket) { this.#push("coarse", rowOf(key, average)); average = undefined; }
    if (!average) { average = { bucket, sums: [], counts: [] }; this.#averages.set(key, average); }
    const values = [row[2], row[3], row[4], row[5], ...row[6]];
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      average.sums[index] = (average.sums[index] ?? 0) + (value ?? 0);
      average.counts[index] = (average.counts[index] ?? 0) + (value === null || value === undefined ? 0 : 1);
    }
  }

  /** The files of the history, oldest day first and, within a day, the fine one first (it is the larger and the one that matters least with time). */
  #files(): Array<{ name: string; tier: Tier; date: string; bytes: number }> {
    let names: string[];
    try { names = fs.readdirSync(this.#options.dir); } catch { return []; }
    const files: Array<{ name: string; tier: Tier; date: string; bytes: number }> = [];
    for (const name of names) {
      const match = NAME.exec(name);
      if (!match) continue;
      try { files.push({ name, tier: match[1] as Tier, date: match[2]!, bytes: fs.statSync(path.join(this.#options.dir, name)).size }); } catch { /* gone meanwhile */ }
    }
    return files.sort((a, b) => a.date.localeCompare(b.date) || b.tier.localeCompare(a.tier));
  }

  #prune(now: number): void {
    const oldestFine = dateOf(now - DAY_MS), oldestCoarse = dateOf(now - this.#options.days * DAY_MS);
    const kept = this.#files().filter(file => {
      if (file.date >= (file.tier === "fine" ? oldestFine : oldestCoarse)) return true;
      fs.rmSync(path.join(this.#options.dir, file.name), { force: true });
      return false;
    });
    let total = kept.reduce((sum, file) => sum + file.bytes, 0);
    for (const file of kept) {
      if (total <= this.#options.maxBytes) break;
      fs.rmSync(path.join(this.#options.dir, file.name), { force: true });
      total -= file.bytes;
    }
  }
}

/** Appends whole lines; a line that a power cut left half written is closed first, so that it spoils only itself. */
function append(file: string, text: string): void {
  let torn = false;
  try {
    const descriptor = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(descriptor).size, last = Buffer.alloc(1);
      if (size > 0) { fs.readSync(descriptor, last, 0, 1, size - 1); torn = last[0] !== 10; }
    } finally { fs.closeSync(descriptor); }
  } catch { /* a new file */ }
  fs.appendFileSync(file, torn ? `\n${text}` : text, { encoding: "utf8", mode: 0o600 });
}

function rowOf(key: string, average: Average): Row {
  const mean = (index: number): Reading => ((average.counts[index] ?? 0) > 0 ? round(average.sums[index]! / average.counts[index]!) : null);
  return [key, average.bucket * COARSE_EVERY_MS + COARSE_EVERY_MS / 2, mean(0), mean(1), mean(2), mean(3), average.sums.slice(4).map((_, index) => mean(index + 4))];
}

function parse(line: string): Row | undefined {
  try {
    const row = JSON.parse(line) as unknown;
    if (!Array.isArray(row) || row.length !== 7 || typeof row[0] !== "string" || reading(row[1]) === null || !Array.isArray(row[6])) return undefined;
    return [row[0], row[1] as number, reading(row[2]), reading(row[3]), reading(row[4]), reading(row[5]), row[6].slice(0, MAX_CELLS).map(reading)];
  } catch { return undefined; }
}

/** A recorded line as the sample the charts read: the module's numbers, the extremes of its cells and each cell (cell1, cell2...). */
function sampleOf([, t, voltage, current, soc, temperature, cells]: Row): Sample {
  const sample: Sample = { t };
  if (voltage !== null) sample.voltage_v = voltage;
  if (current !== null) sample.current_a = current;
  if (voltage !== null && current !== null) sample.power_w = round(voltage * current);
  if (soc !== null) sample.soc_percent = soc;
  if (temperature !== null) sample.temperature_c = temperature;
  const read = cells.filter((value): value is number => value !== null);
  if (read.length > 0) {
    sample.cell_min_v = Math.min(...read);
    sample.cell_max_v = Math.max(...read);
    sample.delta_mv = Math.round((Math.max(...read) - Math.min(...read)) * 1000);
  }
  cells.forEach((value, index) => { if (value !== null) sample[`cell${index + 1}`] = value; });
  return sample;
}
