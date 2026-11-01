/**
 * The daily log: a small record of what the summary of a day needs and the alarms do not hold, the readings of the sensors and the power of the house. It keeps, for each of the last few days,
 * a thin series of samples (a reading of a sensor at most once every `readingEveryS` seconds, the power of the house at most once every `powerEveryS`), in `daily-log.json` in the data
 * directory (atomic write, mode 0600). Nothing is recorded unless the summary of a day (`summary.daily`) is on; a fault in the log never reaches what it observes.
 *
 * The bounds are settings, none of them a constant of the code: the days kept (`summary.log_days`), the two sampling intervals (`summary.reading_every_s`, `summary.power_every_s`), and, from
 * the environment, the most events of a day (ARMOR_DAILY_LOG_MAX_EVENTS) and the most bytes of the file (ARMOR_DAILY_LOG_MAX_BYTES) and which fields of a sensor are readings
 * (ARMOR_DAILY_LOG_SENSORS). Past a bound the oldest day goes first and a day that is full stops taking samples. Only a name that is a plain identifier, a field on the list and a finite
 * number are ever recorded: no text, no address, no secret.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { dayOf, secondOfDay } from "./day.js";
import { JsonFile } from "./history.js";

export type LogEvent = { t_s: number; type: "reading" | "power"; node?: string; sensor?: string; value?: number; watts?: number };
type LogFile = { schema: 1; days: Record<string, LogEvent[]> };

export const DEFAULT_SENSOR_FIELDS = ["temperature", "humidity", "battery", "lux", "pressure", "co2", "rssi", "voltage"] as const;
const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type DailyLogOptions = {
  file: string;
  /** Recording is on only while this says so (the option summary.daily). */
  enabled: () => boolean;
  days: () => number;
  readingEveryS: () => number;
  powerEveryS: () => number;
  maxEventsPerDay: number;
  maxBytes: number;
  sensorFields: readonly string[];
  /** How often the file is written at most. */
  saveEveryMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
};

/** The bytes of one event in the file (its text is plain ASCII: identifiers and numbers) and the comma that follows it. */
const weigh = (event: LogEvent): number => JSON.stringify(event).length + 1;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export class DailyLog {
  #days = new Map<string, LogEvent[]>();
  readonly #last = new Map<string, number>();
  /** The bytes each day takes in the file, kept as events come so that the size bound never serialises the whole log. */
  readonly #weights = new Map<string, number>();
  readonly #file: JsonFile<LogFile>;
  readonly #o: DailyLogOptions;
  readonly #now: () => number;
  #dirty = false;
  #timer: NodeJS.Timeout | undefined;
  dropped = 0;

  constructor(options: DailyLogOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#file = new JsonFile<LogFile>(options.file);
    const stored = this.#file.read();
    if (stored && typeof stored === "object" && stored.days && typeof stored.days === "object") {
      for (const [day, events] of Object.entries(stored.days)) {
        if (!DAY.test(day) || !Array.isArray(events)) continue;
        const clean = events.filter((event): event is LogEvent => this.#valid(event)).slice(0, options.maxEventsPerDay);
        if (clean.length) { this.#days.set(day, clean); this.#weights.set(day, clean.reduce((sum, event) => sum + weigh(event), 0)); }
      }
      this.#trim();
    }
  }

  #valid(event: unknown): boolean {
    if (!event || typeof event !== "object") return false;
    const e = event as Record<string, unknown>;
    if (!finite(e.t_s) || e.t_s < 0 || e.t_s >= 86_400) return false;
    if (e.type === "reading") return typeof e.node === "string" && IDENTIFIER.test(e.node) && typeof e.sensor === "string" && IDENTIFIER.test(e.sensor) && finite(e.value) && Math.abs(e.value) <= 1e12;
    if (e.type === "power") return finite(e.watts) && e.watts >= 0 && e.watts <= 1e9;
    return false;
  }

  /** One reading of a field of a sensor (a device, a node). Recorded when the field is on the list, the names are plain, and the last one of that sensor is older than the interval. */
  reading(node: string, sensor: string, value: unknown, at = this.#now()): void {
    try {
      if (!this.#o.enabled() || !this.#o.sensorFields.includes(sensor) || !finite(value) || Math.abs(value) > 1e12 || !IDENTIFIER.test(node)) return;
      const key = `r:${node}:${sensor}`;
      if (!this.#due(key, at, this.#o.readingEveryS())) return;
      this.#add(at, { t_s: secondOfDay(at), type: "reading", node, sensor, value: Math.round(value * 1000) / 1000 }, key);
    } catch (error) { this.#o.warn?.(`the daily log could not take a reading: ${error instanceof Error ? error.message : "unknown error"}`); }
  }

  /** The power of the house, in watts. */
  power(watts: unknown, at = this.#now()): void {
    try {
      if (!this.#o.enabled() || !finite(watts) || watts < 0 || watts > 1e9) return;
      if (!this.#due("p", at, this.#o.powerEveryS())) return;
      this.#add(at, { t_s: secondOfDay(at), type: "power", watts: Math.round(watts * 10) / 10 }, "p");
    } catch (error) { this.#o.warn?.(`the daily log could not take a power sample: ${error instanceof Error ? error.message : "unknown error"}`); }
  }

  #due(key: string, at: number, everyS: number): boolean {
    const before = this.#last.get(key);
    return before === undefined || at - before >= everyS * 1000 || at < before;
  }

  #add(at: number, event: LogEvent, key: string): void {
    const day = dayOf(at);
    this.#trim();
    const list = this.#days.get(day) ?? [];
    if (list.length >= this.#o.maxEventsPerDay) { this.dropped += 1; return; }
    list.push(event);
    this.#days.set(day, list);
    this.#weights.set(day, (this.#weights.get(day) ?? 0) + weigh(event));
    this.#last.set(key, at);
    this.#trim();
    this.#dirty = true;
    this.#schedule();
  }

  /** The days beyond the limit go, oldest first; so does the file when it is over its size (a day at a time). */
  #trim(): void {
    const limit = Math.max(1, this.#o.days());
    const names = [...this.#days.keys()].sort();
    const drop = (name: string): void => { this.#days.delete(name); this.#weights.delete(name); };
    while (names.length > limit) drop(names.shift()!);
    let size = this.#size();
    while (names.length > 1 && size > this.#o.maxBytes) { drop(names.shift()!); size = this.#size(); }
  }

  /** The size of the file, from the weights of the days (at most a few dozen): the fixed frame plus, per day, its name, its brackets and its events. */
  #size(): number {
    let total = 24;
    for (const [day, weight] of this.#weights) total += day.length + 6 + weight;
    return total;
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; this.flush(); }, this.#o.saveEveryMs ?? 30_000);
    this.#timer.unref();
  }

  /** Writes the file now if anything changed. */
  flush(): void {
    if (!this.#dirty) return;
    try { this.#file.write({ schema: 1, days: Object.fromEntries(this.#days) }); this.#dirty = false; }
    catch (error) { this.#o.warn?.(`the daily log could not be saved: ${error instanceof Error ? error.message : "unknown error"}`); }
  }

  /** The events of one day (YYYY-MM-DD), oldest first. Copies. */
  events(day: string): LogEvent[] {
    return (this.#days.get(day) ?? []).map(event => ({ ...event })).sort((a, b) => a.t_s - b.t_s);
  }

  /** Days held and events held, for the status. */
  size(): { days: number; events: number } {
    return { days: this.#days.size, events: [...this.#days.values()].reduce((sum, list) => sum + list.length, 0) };
  }
}
