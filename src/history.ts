/**
 * The long memory of the readings: a fine history (one sample every few seconds, kept for a day) and, behind it, the same numbers averaged over five minutes and kept for a month, so the
 * charts can reach back days. It is kept in a file and read again when the server starts, so a restart does not empty the charts.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";

export type Sample = { t: number } & Record<string, number | string>;
export const COARSE_EVERY_MS = 5 * 60_000;
export const COARSE_KEEP = 30 * 24 * 12;   // a month of five-minute averages

/** Averages the samples that arrive into buckets of `COARSE_EVERY_MS`; a bucket is closed (and kept) when a sample of a later one comes. Text values keep the last one. */
export class CoarseTier {
  readonly samples: Sample[] = [];
  #bucket = -1;
  #sums = new Map<string, number>();
  #count = 0;
  #last = new Map<string, string>();

  add(sample: Sample): void {
    const bucket = Math.floor(sample.t / COARSE_EVERY_MS);
    if (bucket !== this.#bucket) { this.#close(); this.#bucket = bucket; }
    this.#count += 1;
    for (const [key, value] of Object.entries(sample)) {
      if (key === "t") continue;
      if (typeof value === "number") this.#sums.set(key, (this.#sums.get(key) ?? 0) + value); else this.#last.set(key, value);
    }
  }

  #close(): void {
    if (this.#bucket < 0 || this.#count === 0) return;
    const sample: Sample = { t: this.#bucket * COARSE_EVERY_MS + COARSE_EVERY_MS / 2 };
    for (const [key, sum] of this.#sums) sample[key] = Math.round((sum / this.#count) * 1000) / 1000;
    for (const [key, text] of this.#last) sample[key] = text;
    this.samples.push(sample);
    if (this.samples.length > COARSE_KEEP) this.samples.splice(0, this.samples.length - COARSE_KEEP);
    this.#sums.clear(); this.#last.clear(); this.#count = 0;
  }

  /** The closed buckets plus the one that is still filling, as they stand now. */
  all(): Sample[] {
    if (this.#count === 0) return this.samples;
    const open: Sample = { t: this.#bucket * COARSE_EVERY_MS + COARSE_EVERY_MS / 2 };
    for (const [key, sum] of this.#sums) open[key] = Math.round((sum / this.#count) * 1000) / 1000;
    for (const [key, text] of this.#last) open[key] = text;
    return [...this.samples, open];
  }

  load(samples: readonly Sample[]): void { this.samples.splice(0, this.samples.length, ...samples.slice(-COARSE_KEEP)); }
}

/** A file that holds one JSON document, written whole through a temporary file so a power cut never leaves half of it. */
export class JsonFile<T> {
  constructor(readonly file: string) {}
  read(): T | undefined {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")) as T; } catch { return undefined; }
  }
  write(value: T): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
