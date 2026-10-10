/**
 * The levels at which the batteries and inverters raise alarms, kept by the server so that an operator can change them from Studio (they used to be fixed in the code): the state of charge that is
 * low and the one that is enough again, the spread of the cells of a battery, its temperature, how worn it is and how hot an inverter may get.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { JsonFile } from "./history.js";

export type EnergyAlarmSettings = {
  /** A battery under this charge (percent) raises "low"; it ends when it is back at `soc_ok`. */
  soc_low: number; soc_ok: number;
  /** The difference between the highest and the lowest cell of a battery (millivolts) above which the cells are unbalanced. */
  cell_spread_mv: number;
  /** A battery above `battery_temp_high_c` is hot; a battery that is charging below `battery_temp_low_c` is too cold to charge (degrees). */
  battery_temp_high_c: number; battery_temp_low_c: number;
  /** An inverter whose heat sink is above this is hot (degrees). */
  heatsink_high_c: number;
  /** A battery that holds less than this of what it was made to (percent) is worn. */
  health_low_percent: number;
};

export const ENERGY_ALARM_DEFAULTS: EnergyAlarmSettings = { soc_low: 20, soc_ok: 30, cell_spread_mv: 100, battery_temp_high_c: 55, battery_temp_low_c: 0, heatsink_high_c: 85, health_low_percent: 60 };

const RANGES: Record<keyof EnergyAlarmSettings, readonly [number, number]> = {
  soc_low: [1, 90], soc_ok: [2, 100], cell_spread_mv: [10, 1000], battery_temp_high_c: [30, 90], battery_temp_low_c: [-20, 15], heatsink_high_c: [50, 120], health_low_percent: [10, 95],
};

export class EnergySettingsInvalid extends Error {}

/** The settings in `value` (a field that is left out keeps its default), or throws what is wrong. */
export function parseEnergyAlarmSettings(value: unknown): EnergyAlarmSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EnergySettingsInvalid("the settings must be an object");
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!(key in RANGES)) throw new EnergySettingsInvalid(`unknown setting: ${key}`);
  const out = { ...ENERGY_ALARM_DEFAULTS };
  for (const key of Object.keys(RANGES) as Array<keyof EnergyAlarmSettings>) {
    if (!(key in body)) continue;
    const item = body[key], [low, high] = RANGES[key];
    if (typeof item !== "number" || !Number.isFinite(item) || item < low || item > high) throw new EnergySettingsInvalid(`${key} must be a number from ${low} to ${high}`);
    out[key] = Math.round(item * 10) / 10;
  }
  if (out.soc_ok <= out.soc_low) throw new EnergySettingsInvalid("soc_ok must be higher than soc_low (the alarm ends above it)");
  return out;
}

export class EnergyAlarmStore {
  #settings: EnergyAlarmSettings = { ...ENERGY_ALARM_DEFAULTS };
  readonly #file?: JsonFile<EnergyAlarmSettings>;

  constructor(file?: string) {
    if (!file) return;
    this.#file = new JsonFile<EnergyAlarmSettings>(file);
    const saved = this.#file.read();
    if (saved) { try { this.#settings = parseEnergyAlarmSettings(saved); } catch { /* a damaged file: the defaults */ } }
  }

  get(): EnergyAlarmSettings { return this.#settings; }

  set(value: unknown): EnergyAlarmSettings {
    this.#settings = parseEnergyAlarmSettings(value);
    this.#file?.write(this.#settings);
    return this.#settings;
  }
}
