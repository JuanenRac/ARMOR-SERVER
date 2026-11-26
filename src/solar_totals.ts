/**
 * What the sums of the solar menus count. A node adds up the capacities of a stack over the modules that happen to say each one, so the charge that is left and the full capacity can come
 * from different modules; here they are taken from the same modules. The charge of several stacks is weighted by what each one holds, an example stands in only while nothing real
 * reports, and an inverter of a parallel system counts the system's output once.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { SolarBattery, SolarInverter } from "./solar.js";

export type StackCapacity = { capacity_ah: number | null; full_capacity_ah: number | null; energy_kwh: number | null };

/**
 * The charge left and the full capacity of one stack, both over the same modules. A module that says its full capacity and its state of charge but not its remaining charge counts with
 * the share its state of charge says. The node's own figures are kept when every module says both sides or neither.
 */
export function stackCapacity(reading: SolarBattery): StackCapacity {
  const present = reading.stack.filter(module => module.present);
  const judged = present.filter(module => module.full_capacity_ah !== undefined && (module.capacity_ah !== undefined || module.soc_percent !== undefined));
  // the node's own pair is only wrong when some module says one side and not the other; otherwise it is kept
  const mismatched = present.some(module => (module.capacity_ah === undefined) !== (module.full_capacity_ah === undefined));
  if (!mismatched || judged.length === 0) return { capacity_ah: reading.capacity_ah ?? null, full_capacity_ah: reading.full_capacity_ah ?? null, energy_kwh: reading.energy_kwh ?? null };
  let remaining = 0, full = 0, estimated = false;
  for (const module of judged) {
    const whole = module.full_capacity_ah as number;
    full += whole;
    if (module.capacity_ah !== undefined) remaining += module.capacity_ah;
    else { remaining += whole * (module.soc_percent as number) / 100; estimated = true; }
  }
  const complete = judged.length === present.length && !estimated;
  const energy = complete && reading.energy_kwh !== undefined ? reading.energy_kwh : reading.voltage_v !== undefined ? remaining * reading.voltage_v / 1000 : null;
  return { capacity_ah: remaining, full_capacity_ah: full, energy_kwh: energy };
}

/** The mean state of charge of the stacks, each weighted by its full capacity; by its number of modules when a stack does not say its capacity. */
export function weightedSoc(stacks: ReadonlyArray<{ soc: number; full_capacity_ah: number | null; modules: number }>): number | null {
  if (stacks.length === 0) return null;
  const byCapacity = stacks.every(item => item.full_capacity_ah !== null && item.full_capacity_ah > 0);
  const weight = (item: (typeof stacks)[number]): number => (byCapacity ? item.full_capacity_ah as number : Math.max(1, item.modules));
  const total = stacks.reduce((sum, item) => sum + weight(item), 0);
  return Math.round(stacks.reduce((sum, item) => sum + item.soc * weight(item), 0) / total);
}

/** The entries the sums are made of: an example is left out as soon as something real of its kind is there. */
export function countable<T extends { reading: { kind: string }; example: boolean }>(entries: readonly T[]): T[] {
  const real = new Set(entries.filter(entry => !entry.example).map(entry => entry.reading.kind));
  return entries.filter(entry => !entry.example || !real.has(entry.reading.kind));
}

/**
 * The output of one inverter entry for the sum of the loads. The port of a parallel system says the output of the whole system (total_out_w); a system seen from two ports (the same
 * units by their serial numbers) is counted once. `seen` carries the units already counted.
 */
export function inverterLoad(reading: SolarInverter, seen: Set<string>): number {
  const serials = (reading.units ?? []).map(unit => unit.serial).filter((serial): serial is string => typeof serial === "string" && serial !== "");
  if (serials.some(serial => seen.has(serial))) return 0;
  serials.forEach(serial => seen.add(serial));
  return reading.total_out_w ?? reading.out_w;
}
