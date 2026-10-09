/**
 * Solar inverters and batteries as gateway nodes report them (armor/solar/{node_id}/{device}/state): the strict parsers of the two
 * messages, and the store that keeps the latest reading of every device, a short history of a few numbers, and the sums Studio shows.
 * The parsers implement ARMOR-COMMON's solar_inverter and solar_battery schemas exactly (tests/conformance.test.ts runs the shared vectors).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { finite, integer, onlyKnown, readNodeId, readTimestamp, record } from "./contracts.js";
import { CoarseTier, type Sample } from "./history.js";

export type SolarMode = "power_on" | "standby" | "line" | "battery" | "fault" | "power_saving" | "shutdown" | "unknown";
export const SOLAR_MODES: readonly SolarMode[] = ["power_on", "standby", "line", "battery", "fault", "power_saving", "shutdown", "unknown"];
export type SolarInverter = {
  kind: "inverter"; node_id: string; device: string; timestamp_ms: number; mode: SolarMode;
  grid_v: number; grid_hz: number; out_v: number; out_hz: number; out_va: number; out_w: number; load_percent: number;
  battery_v: number; battery_a: number; battery_percent: number; pv_v: number; pv_a: number; pv_w: number; heatsink_c: number;
  ac_charging: boolean; pv_charging: boolean; load_on: boolean; warnings: string[];
  /** A second PV input (pv_w is already the sum of both) and, for a parallel system, the totals and the units the node reads (QPGS). */
  pv2_v?: number; pv2_a?: number; pv2_w?: number;
  /** The DC bus voltage inside the inverter, when the dialect says it. */
  bus_v?: number;
  total_out_w?: number; total_out_va?: number; total_load_percent?: number; total_charging_a?: number;
  units?: SolarUnit[];
};
export type SolarUnit = {
  unit: number; mode: SolarMode; serial?: string; fault_code?: string; grid_v?: number; out_v?: number; out_va?: number; out_w?: number;
  load_percent?: number; battery_v?: number; battery_percent?: number; pv_v?: number; charging_a?: number;
};
export type SolarModule = {
  n: number; present: boolean; voltage_v?: number; current_a?: number; temperature_c?: number; soc_percent?: number; state?: string;
  cells_v?: number[]; temperatures_c?: number[]; capacity_ah?: number; full_capacity_ah?: number; cycles?: number; health_percent?: number;
};
export type SolarBattery = {
  kind: "battery"; node_id: string; device: string; timestamp_ms: number; modules: number; stack: SolarModule[];
  state?: "charging" | "discharging" | "idle"; voltage_v?: number; current_a?: number; temperature_min_c?: number; temperature_max_c?: number;
  cell_min_v?: number; cell_max_v?: number; soc_percent?: number; alarm?: boolean;
  model?: string; capacity_ah?: number; full_capacity_ah?: number; energy_kwh?: number; cycles?: number; health_percent?: number;
  /** What a battery management system adds: its own power reading (negative while discharging), the cells being balanced, a protection active and the status codes of its MOSFETs. */
  power_w?: number; balancing?: number; protecting?: boolean; charge_mos?: number; discharge_mos?: number;
};
export type SolarMessage = SolarInverter | SolarBattery;

const deviceName = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const warningName = /^[a-z][a-z0-9_]{0,39}$/;
const INVERTER_KEYS = ["kind", "node_id", "device", "timestamp_ms", "mode", "grid_v", "grid_hz", "out_v", "out_hz", "out_va", "out_w", "load_percent", "battery_v", "battery_a", "battery_percent",
  "pv_v", "pv_a", "pv_w", "heatsink_c", "ac_charging", "pv_charging", "load_on", "warnings"] as const;
const INVERTER_OPTIONAL_KEYS = ["bus_v", "pv2_v", "pv2_a", "pv2_w", "total_out_w", "total_out_va", "total_load_percent", "total_charging_a", "units"] as const;
const INVERTER_OPTIONAL_RANGES: Record<string, readonly [number, number]> = {
  bus_v: [0, 1500], pv2_v: [0, 1500], pv2_a: [0, 500], pv2_w: [0, 100_000], total_out_w: [0, 1_000_000], total_out_va: [0, 1_000_000], total_load_percent: [0, 200], total_charging_a: [0, 10_000],
};
const UNIT_KEYS = ["unit", "serial", "mode", "fault_code", "grid_v", "out_v", "out_va", "out_w", "load_percent", "battery_v", "battery_percent", "pv_v", "charging_a"] as const;
const UNIT_RANGES: Record<string, readonly [number, number]> = {
  grid_v: [0, 600], out_v: [0, 600], out_va: [0, 100_000], out_w: [0, 100_000], load_percent: [0, 200], battery_v: [0, 1000], battery_percent: [0, 100], pv_v: [0, 1500], charging_a: [0, 1000],
};
/** The bounds of every number of an inverter message: [minimum, maximum]. */
const INVERTER_RANGES: Record<string, readonly [number, number]> = {
  grid_v: [0, 600], grid_hz: [0, 100], out_v: [0, 600], out_hz: [0, 100], out_va: [0, 100_000], out_w: [0, 100_000], load_percent: [0, 200], battery_v: [0, 1000], battery_a: [-1000, 1000],
  battery_percent: [0, 100], pv_v: [0, 1500], pv_a: [0, 500], pv_w: [0, 100_000], heatsink_c: [-50, 200],
};
const inRange = (value: unknown, low: number, high: number): value is number => finite(value) && value >= low && value <= high;

function readDevice(body: Record<string, unknown>): string {
  if (typeof body.device !== "string" || !deviceName.test(body.device)) throw new Error("invalid device");
  return body.device;
}

function parseUnit(value: unknown, index: number): SolarUnit {
  const unit = record(value, `unit ${index}`);
  onlyKnown(unit, UNIT_KEYS, `unit ${index}`);
  if (!integer(unit.unit) || unit.unit < 0 || unit.unit > 9) throw new Error(`invalid unit ${index}.unit`);
  if (typeof unit.mode !== "string" || !(SOLAR_MODES as readonly string[]).includes(unit.mode)) throw new Error(`invalid unit ${index}.mode`);
  if ("serial" in unit && (typeof unit.serial !== "string" || unit.serial.length > 24)) throw new Error(`invalid unit ${index}.serial`);
  if ("fault_code" in unit && (typeof unit.fault_code !== "string" || !/^[0-9]{2}$/.test(unit.fault_code))) throw new Error(`invalid unit ${index}.fault_code`);
  for (const [key, [low, high]] of Object.entries(UNIT_RANGES)) if (key in unit && !inRange(unit[key], low, high)) throw new Error(`invalid unit ${index}.${key}`);
  return unit as unknown as SolarUnit;
}

export function parseSolarInverter(value: unknown): SolarInverter {
  const body = record(value, "inverter");
  onlyKnown(body, [...INVERTER_KEYS, ...INVERTER_OPTIONAL_KEYS], "inverter");
  for (const key of INVERTER_KEYS) if (!(key in body)) throw new Error(`inverter is missing ${key}`);
  for (const [key, [low, high]] of Object.entries(INVERTER_OPTIONAL_RANGES)) if (key in body && !inRange(body[key], low, high)) throw new Error(`invalid ${key}`);
  if ("units" in body && (!Array.isArray(body.units) || body.units.length > 10)) throw new Error("invalid units");
  const units = Array.isArray(body.units) ? body.units.map(parseUnit) : undefined;
  if (body.kind !== "inverter") throw new Error("invalid kind");
  const node = readNodeId(body), device = readDevice(body), timestamp = readTimestamp(body);
  if (typeof body.mode !== "string" || !(SOLAR_MODES as readonly string[]).includes(body.mode)) throw new Error("invalid mode");
  for (const [key, [low, high]] of Object.entries(INVERTER_RANGES)) if (!inRange(body[key], low, high)) throw new Error(`invalid ${key}`);
  for (const key of ["ac_charging", "pv_charging", "load_on"]) if (typeof body[key] !== "boolean") throw new Error(`invalid ${key}`);
  if (!Array.isArray(body.warnings) || body.warnings.length > 32 || !body.warnings.every(name => typeof name === "string" && warningName.test(name))) throw new Error("invalid warnings");
  return { ...(body as unknown as SolarInverter), node_id: node, device, timestamp_ms: timestamp, warnings: [...(body.warnings as string[])], ...(units ? { units } : {}) };
}

const BATTERY_OPTIONAL_RANGES: Record<string, readonly [number, number]> = {
  voltage_v: [0, 1000], current_a: [-1000, 1000], temperature_min_c: [-50, 200], temperature_max_c: [-50, 200], cell_min_v: [0, 10], cell_max_v: [0, 10],
};

function parseModule(value: unknown, index: number): SolarModule {
  const module = record(value, `module ${index}`);
  onlyKnown(module, ["n", "present", "voltage_v", "current_a", "temperature_c", "soc_percent", "state", "cells_v", "temperatures_c", "capacity_ah", "full_capacity_ah", "cycles", "health_percent"], `module ${index}`);
  if (!integer(module.n) || module.n < 1 || module.n > 16) throw new Error(`invalid module ${index}.n`);
  if (typeof module.present !== "boolean") throw new Error(`invalid module ${index}.present`);
  if ("voltage_v" in module && !inRange(module.voltage_v, 0, 1000)) throw new Error(`invalid module ${index}.voltage_v`);
  if ("current_a" in module && !inRange(module.current_a, -1000, 1000)) throw new Error(`invalid module ${index}.current_a`);
  if ("temperature_c" in module && !inRange(module.temperature_c, -50, 200)) throw new Error(`invalid module ${index}.temperature_c`);
  if ("soc_percent" in module && (!integer(module.soc_percent) || module.soc_percent < 0 || module.soc_percent > 100)) throw new Error(`invalid module ${index}.soc_percent`);
  if ("state" in module && (typeof module.state !== "string" || Array.from(module.state).length < 1 || Array.from(module.state).length > 16)) throw new Error(`invalid module ${index}.state`);
  if ("cells_v" in module && (!Array.isArray(module.cells_v) || module.cells_v.length > 32 || !module.cells_v.every(v => inRange(v, 0, 10)))) throw new Error(`invalid module ${index}.cells_v`);
  if ("temperatures_c" in module && (!Array.isArray(module.temperatures_c) || module.temperatures_c.length > 8 || !module.temperatures_c.every(v => inRange(v, -50, 200)))) throw new Error(`invalid module ${index}.temperatures_c`);
  for (const key of ["capacity_ah", "full_capacity_ah"]) if (key in module && !inRange(module[key], 0, 100_000)) throw new Error(`invalid module ${index}.${key}`);
  if ("cycles" in module && (!integer(module.cycles) || module.cycles < 0 || module.cycles > 1_000_000)) throw new Error(`invalid module ${index}.cycles`);
  if ("health_percent" in module && (!integer(module.health_percent) || module.health_percent < 0 || module.health_percent > 100)) throw new Error(`invalid module ${index}.health_percent`);
  return module as unknown as SolarModule;
}

export function parseSolarBattery(value: unknown): SolarBattery {
  const body = record(value, "battery");
  onlyKnown(body, ["kind", "node_id", "device", "timestamp_ms", "modules", "stack", "state", "voltage_v", "current_a", "temperature_min_c", "temperature_max_c", "cell_min_v", "cell_max_v", "soc_percent", "alarm", "model", "capacity_ah", "full_capacity_ah", "energy_kwh", "cycles", "health_percent", "power_w", "balancing", "protecting", "charge_mos", "discharge_mos"], "battery");
  for (const key of ["kind", "node_id", "device", "timestamp_ms", "modules", "stack"]) if (!(key in body)) throw new Error(`battery is missing ${key}`);
  if (body.kind !== "battery") throw new Error("invalid kind");
  const node = readNodeId(body), device = readDevice(body), timestamp = readTimestamp(body);
  if (!integer(body.modules) || body.modules < 0 || body.modules > 16) throw new Error("invalid modules");
  if (!Array.isArray(body.stack) || body.stack.length > 16) throw new Error("invalid stack");
  const stack = body.stack.map(parseModule);
  if ("state" in body && body.state !== "charging" && body.state !== "discharging" && body.state !== "idle") throw new Error("invalid state");
  for (const [key, [low, high]] of Object.entries(BATTERY_OPTIONAL_RANGES)) if (key in body && !inRange(body[key], low, high)) throw new Error(`invalid ${key}`);
  if ("soc_percent" in body && (!integer(body.soc_percent) || body.soc_percent < 0 || body.soc_percent > 100)) throw new Error("invalid soc_percent");
  if ("alarm" in body && typeof body.alarm !== "boolean") throw new Error("invalid alarm");
  if ("model" in body && (typeof body.model !== "string" || Array.from(body.model).length < 1 || Array.from(body.model).length > 24)) throw new Error("invalid model");
  for (const [key, high] of [["capacity_ah", 100_000], ["full_capacity_ah", 100_000], ["energy_kwh", 10_000]] as const) if (key in body && !inRange(body[key], 0, high)) throw new Error(`invalid ${key}`);
  if ("cycles" in body && (!integer(body.cycles) || body.cycles < 0 || body.cycles > 1_000_000)) throw new Error("invalid cycles");
  if ("health_percent" in body && (!integer(body.health_percent) || body.health_percent < 0 || body.health_percent > 100)) throw new Error("invalid health_percent");
  if ("power_w" in body && !inRange(body.power_w, -1_000_000, 1_000_000)) throw new Error("invalid power_w");
  if ("balancing" in body && (!integer(body.balancing) || body.balancing < 0 || body.balancing > 64)) throw new Error("invalid balancing");
  if ("protecting" in body && typeof body.protecting !== "boolean") throw new Error("invalid protecting");
  for (const key of ["charge_mos", "discharge_mos"]) if (key in body && (!integer(body[key]) || (body[key] as number) < 0 || (body[key] as number) > 255)) throw new Error(`invalid ${key}`);
  return { ...(body as unknown as SolarBattery), node_id: node, device, timestamp_ms: timestamp, stack };
}

/** A solar message of either kind; the payload's own `kind` picks the parser. */
export function parseSolarMessage(value: unknown): SolarMessage {
  const body = record(value, "solar message");
  if (body.kind === "inverter") return parseSolarInverter(body);
  if (body.kind === "battery") return parseSolarBattery(body);
  throw new Error("kind must be inverter or battery");
}

/** armor/solar/{node_id}/{device}/state as [node_id, device], or undefined when the topic is not one. */
export function solarTopic(topic: string): [string, string] | undefined {
  const parts = topic.split("/");
  if (parts.length !== 5 || parts[0] !== "armor" || parts[1] !== "solar" || parts[4] !== "state") return undefined;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[2]) && deviceName.test(parts[3]) ? [parts[2], parts[3]] : undefined;
}

// ---- the store --------------------------------------------------------------------------------------------------------------------------

export type SolarDeviceView = { node_id: string; device: string; kind: "inverter" | "battery"; reading: SolarMessage; received_at: string; stale: boolean; example: boolean };
export type SolarTotals = {
  inverters: number; batteries: number; stale: number;
  /** Power from the panels and drawn by the load, in watts, summed over the inverters that are not stale. */
  pv_w: number; load_w: number;
  /** Battery power in watts: positive while charging (the stacks' own figures when there are any, else the inverters'); null when nothing reports it. */
  battery_w: number | null;
  /** Mean state of charge in percent; null when nothing reports it. */
  soc_percent: number | null;
  /** What the battery stacks hold: remaining and full capacity in ampere-hours and the energy left in kilowatt-hours (null when no stack says). */
  capacity_ah: number | null; full_capacity_ah: number | null; energy_kwh: number | null;
  /** Whether any inverter sees the grid. */
  grid_present: boolean;
  /** The mode of the first inverter that is not stale, or null. */
  mode: SolarMode | null;
};
export type SolarSample = { t: number } & Record<string, number | string>;
/** What one local day added up to, in watt-hours: the panels, the load, and the battery taking charge or giving it (read from the battery stacks, and from the inverters as a second opinion). */
export type EnergyDay = { pv: number; load: number; bin: number; bout: number; ibin: number; ibout: number };
export type SolarEnergyDay = { date: string; pv_kwh: number; load_kwh: number; battery_in_kwh: number; battery_out_kwh: number };
/** What is kept of the history of the devices and of the energy between runs. */
export type SolarHistoryFile = { devices: Record<string, { samples: SolarSample[]; coarse: SolarSample[] }>; energy: Record<string, EnergyDay> };
const KEEP_ENERGY_DAYS = 400, MAX_ENERGY_GAP_MS = 120_000;
const dateOf = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export type SolarStoreOptions = {
  now?: () => number;
  /** A device that has not reported for this long is stale. */
  staleAfterMs?: number;
  /** At most one sample of history per device in this time. */
  sampleEveryMs?: number;
  /** How many samples of history a device keeps (2880 at 30 s is a day). */
  keepSamples?: number;
  maxDevices?: number;
  /** Told when a message is accepted, and when a device goes stale or comes back. */
  onMessage?: (message: SolarMessage) => void;
  onStale?: (node: string, device: string, stale: boolean) => void;
};

type Entry = { reading: SolarMessage; receivedAtMs: number; stale: boolean; samples: SolarSample[]; coarse: CoarseTier; lastSampleMs: number; example: boolean };

const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;

export class SolarStore {
  readonly #entries = new Map<string, Entry>();
  /** History read from the file before the device has reported again: it is given to the device when it does. */
  readonly #pending = new Map<string, { samples: SolarSample[]; coarse: SolarSample[] }>();
  readonly #energy = new Map<string, EnergyDay>();
  readonly #options: Required<Pick<SolarStoreOptions, "now" | "staleAfterMs" | "sampleEveryMs" | "keepSamples" | "maxDevices">> & SolarStoreOptions;

  constructor(options: SolarStoreOptions = {}) {
    // an option given as undefined (a test that leaves the clock alone) means the default
    this.#options = {
      ...options, now: options.now ?? (() => Date.now()), staleAfterMs: options.staleAfterMs ?? 120_000, sampleEveryMs: options.sampleEveryMs ?? 30_000,
      keepSamples: options.keepSamples ?? 2880, maxDevices: options.maxDevices ?? 64,
    };
  }

  /**
   * Keep a message. Refuses (throws) a new device when the store is full, so a broker full of noise cannot grow it without limit.
   * An `example` reading (made by the server to try the menus) is marked as such, raises no alarm and gives way to the first real one.
   */
  ingest(message: SolarMessage, options: { example?: boolean } = {}): void {
    const key = `${message.node_id}/${message.device}`;
    const now = this.#options.now();
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= this.#options.maxDevices) throw new Error("too many solar devices");
      entry = { reading: message, receivedAtMs: now, stale: false, samples: [], coarse: new CoarseTier(), lastSampleMs: 0, example: options.example === true };
      const kept = this.#pending.get(key);
      if (kept && options.example !== true) { entry.samples = kept.samples; entry.coarse.load(kept.coarse); this.#pending.delete(key); }
      this.#entries.set(key, entry);
    }
    const wasStale = entry.stale;
    if (options.example !== true && !entry.example && !wasStale) this.#addEnergy(message, now - entry.receivedAtMs, now);
    const modeChanged = entry.reading.kind === "inverter" && message.kind === "inverter" && entry.reading.mode !== message.mode;
    if (entry.example && options.example !== true) { entry.samples = []; entry.coarse = new CoarseTier(); entry.lastSampleMs = 0; }   // the first real reading replaces the example, history included
    entry.example = options.example === true;
    entry.reading = message;
    entry.receivedAtMs = now;
    entry.stale = false;
    if (modeChanged || now - entry.lastSampleMs >= this.#options.sampleEveryMs) {
      const sample = sampleOf(message, now);
      entry.samples.push(sample);
      if (options.example !== true) entry.coarse.add(sample);
      entry.lastSampleMs = now;
      if (entry.samples.length > this.#options.keepSamples) entry.samples.splice(0, entry.samples.length - this.#options.keepSamples);
    }
    if (options.example === true) return;
    if (wasStale) this.#options.onStale?.(message.node_id, message.device, false);
    this.#options.onMessage?.(message);
  }

  /** Forget a device (its reading and its history). */
  remove(node: string, device: string): boolean { return this.#entries.delete(`${node}/${device}`); }

  /** Mark the devices that went quiet (and tell), or came back. Called now and then. */
  sweep(): void {
    const now = this.#options.now();
    for (const entry of this.#entries.values()) {
      if (!entry.stale && !entry.example && now - entry.receivedAtMs > this.#options.staleAfterMs) {
        entry.stale = true;
        this.#options.onStale?.(entry.reading.node_id, entry.reading.device, true);
      }
    }
  }

  list(): SolarDeviceView[] {
    this.sweep();
    return [...this.#entries.values()].map(entry => ({
      node_id: entry.reading.node_id, device: entry.reading.device, kind: entry.reading.kind, reading: entry.reading,
      received_at: new Date(entry.receivedAtMs).toISOString(), stale: entry.stale, example: entry.example,
    })).sort((a, b) => (a.kind === b.kind ? `${a.node_id}/${a.device}`.localeCompare(`${b.node_id}/${b.device}`) : a.kind === "inverter" ? -1 : 1));
  }

  totals(): SolarTotals {
    this.sweep();
    let pv = 0, load = 0, inverters = 0, batteries = 0, stale = 0;
    let stackPower = 0, stackCount = 0, inverterPower = 0, inverterCount = 0;
    let capacity: number | null = null, full: number | null = null, energy: number | null = null;
    const socStacks: number[] = [], socInverters: number[] = [];
    let grid = false;
    let mode: SolarMode | null = null;
    for (const entry of this.#entries.values()) {
      if (entry.stale) { stale += 1; }
      const reading = entry.reading;
      if (reading.kind === "inverter") {
        inverters += 1;
        if (entry.stale) continue;
        pv += reading.pv_w; load += reading.out_w;
        inverterPower += reading.battery_v * reading.battery_a; inverterCount += 1;
        socInverters.push(reading.battery_percent);
        if (reading.grid_v > 100) grid = true;
        if (mode === null) mode = reading.mode;
      } else {
        batteries += 1;
        if (entry.stale || reading.modules === 0) continue;
        if (reading.voltage_v !== undefined && reading.current_a !== undefined) { stackPower += reading.voltage_v * reading.current_a; stackCount += 1; }
        if (reading.soc_percent !== undefined) socStacks.push(reading.soc_percent);
        if (reading.capacity_ah !== undefined) capacity = (capacity ?? 0) + reading.capacity_ah;
        if (reading.full_capacity_ah !== undefined) full = (full ?? 0) + reading.full_capacity_ah;
        if (reading.energy_kwh !== undefined) energy = (energy ?? 0) + reading.energy_kwh;
      }
    }
    const soc = socStacks.length ? socStacks : socInverters;
    return {
      inverters, batteries, stale, pv_w: round(pv, 0), load_w: round(load, 0),
      battery_w: stackCount > 0 ? round(stackPower, 0) : inverterCount > 0 ? round(inverterPower, 0) : null,
      soc_percent: soc.length ? Math.round(soc.reduce((sum, value) => sum + value, 0) / soc.length) : null,
      capacity_ah: capacity === null ? null : round(capacity, 1), full_capacity_ah: full === null ? null : round(full, 1), energy_kwh: energy === null ? null : round(energy, 2),
      grid_present: grid, mode,
    };
  }

  /** The recent samples of one device, oldest first; `minutes` bounds how far back. Past a day the five-minute averages answer. */
  history(node: string, device: string, minutes: number): { kind: "inverter" | "battery"; samples: SolarSample[] } | undefined {
    const entry = this.#entries.get(`${node}/${device}`);
    if (!entry) return undefined;
    const since = this.#options.now() - minutes * 60_000;
    return { kind: entry.reading.kind, samples: (minutes > 1440 ? entry.coarse.all() : entry.samples).filter(sample => sample.t >= since) };
  }

  /** Adds what the last stretch of time was worth (the reading times the time since the one before, when that was not long ago) to the day it belongs to. */
  #addEnergy(message: SolarMessage, gapMs: number, now: number): void {
    if (!(gapMs > 0) || gapMs > MAX_ENERGY_GAP_MS) return;
    const date = dateOf(now);
    let day = this.#energy.get(date);
    if (!day) {
      day = { pv: 0, load: 0, bin: 0, bout: 0, ibin: 0, ibout: 0 };
      this.#energy.set(date, day);
      const keep = [...this.#energy.keys()].sort();
      for (const old of keep.slice(0, Math.max(0, keep.length - KEEP_ENERGY_DAYS))) this.#energy.delete(old);
    }
    const hours = gapMs / 3_600_000;
    if (message.kind === "inverter") {
      day.pv += Math.max(0, message.pv_w) * hours; day.load += Math.max(0, message.out_w) * hours;
      const battery = message.battery_v * message.battery_a;
      if (battery > 0) day.ibin += battery * hours; else day.ibout += -battery * hours;
    } else if (message.voltage_v !== undefined && message.current_a !== undefined) {
      const power = message.voltage_v * message.current_a;
      if (power > 0) day.bin += power * hours; else day.bout += -power * hours;
    }
  }

  /** The energy of each of the last `days` days (today included), oldest first; the battery's figures come from the stacks when there are any and from the inverters otherwise. */
  energy(days: number): SolarEnergyDay[] {
    const kwh = (wh: number): number => Math.round(wh) / 1000;
    return [...this.#energy.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-Math.max(1, days)).map(([date, day]) => {
      const stacks = day.bin + day.bout > 0;
      return { date, pv_kwh: kwh(day.pv), load_kwh: kwh(day.load), battery_in_kwh: kwh(stacks ? day.bin : day.ibin), battery_out_kwh: kwh(stacks ? day.bout : day.ibout) };
    });
  }

  /** What has to be kept between runs: the history of every device (real ones only) and the energy of the days. */
  exportHistory(): SolarHistoryFile {
    const devices: SolarHistoryFile["devices"] = {};
    for (const [key, entry] of this.#entries) if (!entry.example) devices[key] = { samples: entry.samples, coarse: entry.coarse.all() };
    for (const [key, kept] of this.#pending) if (!(key in devices)) devices[key] = kept;
    return { devices, energy: Object.fromEntries(this.#energy) };
  }

  /** Takes back what `exportHistory` made. It only gives the history to devices as they report again. */
  importHistory(file: SolarHistoryFile | undefined): void {
    if (!file || typeof file !== "object") return;
    const good = (list: unknown): SolarSample[] => (Array.isArray(list) ? list.filter((s): s is SolarSample => typeof s === "object" && s !== null && finite((s as { t?: unknown }).t)) : []);
    for (const [key, value] of Object.entries(file.devices ?? {})) {
      if (!/^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(key) || this.#pending.size >= this.#options.maxDevices) continue;
      this.#pending.set(key, { samples: good(value?.samples).slice(-this.#options.keepSamples), coarse: good(value?.coarse) });
    }
    for (const [date, day] of Object.entries(file.energy ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof day !== "object" || day === null) continue;
      const read = (value: unknown): number => (finite(value) && value >= 0 ? value : 0);
      this.#energy.set(date, { pv: read(day.pv), load: read(day.load), bin: read(day.bin), bout: read(day.bout), ibin: read(day.ibin), ibout: read(day.ibout) });
    }
  }
}

/** The few numbers of a message that are worth a curve. */
function sampleOf(message: SolarMessage, t: number): Sample {
  if (message.kind === "inverter") {
    return { t, pv_w: message.pv_w, out_w: message.out_w, battery_v: message.battery_v, battery_a: message.battery_a, battery_percent: message.battery_percent, grid_v: message.grid_v, mode: message.mode };
  }
  const sample: SolarSample = { t, modules: message.modules };
  for (const key of ["soc_percent", "voltage_v", "current_a", "temperature_max_c", "cell_min_v", "cell_max_v", "energy_kwh"] as const) if (message[key] !== undefined) sample[key] = message[key] as number;
  return sample;
}
