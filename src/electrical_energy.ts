/**
 * The energy of every electrical channel, day by day. The meters (the PZEM family) count energy since they were last reset and wrap to zero at 9,999.99 kWh, and a node can lose power and
 * start from zero: summing what a reading says would be wrong at exactly those moments. This keeps the last reading of each channel and adds up only the difference between two readings,
 * so a counter that wraps or is reset adds what it counted since, never a negative day and never the whole total again. A day is a calendar day of the server's clock.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export const METER_WRAP_KWH = 9999.99;
const KEEP_DAYS = 400;

export type EnergyDay = { day: string; kwh: number; resets: number };
export type EnergyFile = { channels: Record<string, { last: number | null; days: EnergyDay[] }> };

/** What a meter added between two readings of its counter: the plain difference, the stretch to the wrap plus what it counted after it, or, for a reset, what it counted since. */
export function counterStep(previous: number, current: number): { kwh: number; reset: boolean } {
  if (current >= previous) return { kwh: current - previous, reset: false };
  // a counter that was close to its top and is now low wrapped around; anything else started again from zero
  if (previous >= METER_WRAP_KWH - 100 && current <= 100) return { kwh: METER_WRAP_KWH - previous + current, reset: true };
  return { kwh: current, reset: true };
}

import { dayOf } from "./day.js";
export { dayOf };

export class ElectricalEnergy {
  readonly #channels = new Map<string, { last: number | null; days: EnergyDay[] }>();

  /** One reading of a channel's counter at a time. A reading that is not a number is ignored. */
  add(node: string, channel: string, energyKwh: unknown, atMs: number): void {
    if (typeof energyKwh !== "number" || !Number.isFinite(energyKwh) || energyKwh < 0) return;
    const key = `${node}/${channel}`;
    const entry = this.#channels.get(key) ?? { last: null, days: [] };
    this.#channels.set(key, entry);
    if (entry.last !== null) {
      const { kwh, reset } = counterStep(entry.last, energyKwh);
      const day = dayOf(atMs);
      let today = entry.days[entry.days.length - 1];
      if (!today || today.day !== day) { today = { day, kwh: 0, resets: 0 }; entry.days.push(today); if (entry.days.length > KEEP_DAYS) entry.days.splice(0, entry.days.length - KEEP_DAYS); }
      today.kwh = Math.round((today.kwh + kwh) * 1000) / 1000;
      if (reset) today.resets += 1;
    }
    entry.last = energyKwh;
  }

  /** The days of every channel (the last `days` of them), oldest first. */
  list(days = 30): Array<{ node: string; channel: string; days: EnergyDay[] }> {
    return [...this.#channels.entries()].map(([key, entry]) => {
      const slash = key.indexOf("/");
      return { node: key.slice(0, slash), channel: key.slice(slash + 1), days: entry.days.slice(-Math.max(1, Math.min(KEEP_DAYS, days))) };
    });
  }

  export(): EnergyFile { return { channels: Object.fromEntries([...this.#channels.entries()].map(([key, entry]) => [key, { last: entry.last, days: entry.days }])) }; }

  import(file: EnergyFile | null | undefined): void {
    if (!file || typeof file !== "object" || typeof file.channels !== "object" || file.channels === null) return;
    for (const [key, entry] of Object.entries(file.channels)) {
      if (!/^[^/]+\/.+$/.test(key) || typeof entry !== "object" || entry === null || !Array.isArray(entry.days)) continue;
      const days = entry.days.filter(item => typeof item?.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.day) && typeof item.kwh === "number" && Number.isFinite(item.kwh) && item.kwh >= 0)
        .map(item => ({ day: item.day, kwh: item.kwh, resets: typeof item.resets === "number" ? item.resets : 0 })).slice(-KEEP_DAYS);
      this.#channels.set(key, { last: typeof entry.last === "number" && Number.isFinite(entry.last) ? entry.last : null, days });
    }
  }
}
