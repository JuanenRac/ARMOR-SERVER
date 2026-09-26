/**
 * Solar inverters and batteries as gateway nodes report them (armor/solar/{node_id}/{device}/state): the strict parsers of the two
 * messages, and the store that keeps the latest reading of every device, a short history of a few numbers, and the sums Studio shows.
 * The parsers implement ARMOR-COMMON's solar_inverter and solar_battery schemas exactly (tests/conformance.test.ts runs the shared vectors).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { finite, integer, onlyKnown, readNodeId, readTimestamp, record } from "./contracts.js";

export type SolarMode = "power_on" | "standby" | "line" | "battery" | "fault" | "power_saving" | "shutdown" | "unknown";
export const SOLAR_MODES: readonly SolarMode[] = ["power_on", "standby", "line", "battery", "fault", "power_saving", "shutdown", "unknown"];
export type SolarInverter = {
  kind: "inverter"; node_id: string; device: string; timestamp_ms: number; mode: SolarMode;
  grid_v: number; grid_hz: number; out_v: number; out_hz: number; out_va: number; out_w: number; load_percent: number;
  battery_v: number; battery_a: number; battery_percent: number; pv_v: number; pv_a: number; pv_w: number; heatsink_c: number;
  ac_charging: boolean; pv_charging: boolean; load_on: boolean; warnings: string[];
};
export type SolarModule = {
  n: number; present: boolean; voltage_v?: number; current_a?: number; temperature_c?: number; soc_percent?: number; state?: string;
  cells_v?: number[]; temperatures_c?: number[]; capacity_ah?: number; full_capacity_ah?: number; cycles?: number;
};
export type SolarBattery = {
  kind: "battery"; node_id: string; device: string; timestamp_ms: number; modules: number; stack: SolarModule[];
  state?: "charging" | "discharging" | "idle"; voltage_v?: number; current_a?: number; temperature_min_c?: number; temperature_max_c?: number;
  cell_min_v?: number; cell_max_v?: number; soc_percent?: number; alarm?: boolean;
  model?: string; capacity_ah?: number; full_capacity_ah?: number; energy_kwh?: number; cycles?: number;
};
export type SolarMessage = SolarInverter | SolarBattery;

const deviceName = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const warningName = /^[a-z][a-z0-9_]{0,39}$/;
const INVERTER_KEYS = ["kind", "node_id", "device", "timestamp_ms", "mode", "grid_v", "grid_hz", "out_v", "out_hz", "out_va", "out_w", "load_percent", "battery_v", "battery_a", "battery_percent",
  "pv_v", "pv_a", "pv_w", "heatsink_c", "ac_charging", "pv_charging", "load_on", "warnings"] as const;
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

export function parseSolarInverter(value: unknown): SolarInverter {
  const body = record(value, "inverter");
  onlyKnown(body, INVERTER_KEYS, "inverter");
  for (const key of INVERTER_KEYS) if (!(key in body)) throw new Error(`inverter is missing ${key}`);
  if (body.kind !== "inverter") throw new Error("invalid kind");
  const node = readNodeId(body), device = readDevice(body), timestamp = readTimestamp(body);
  if (typeof body.mode !== "string" || !(SOLAR_MODES as readonly string[]).includes(body.mode)) throw new Error("invalid mode");
  for (const [key, [low, high]] of Object.entries(INVERTER_RANGES)) if (!inRange(body[key], low, high)) throw new Error(`invalid ${key}`);
  for (const key of ["ac_charging", "pv_charging", "load_on"]) if (typeof body[key] !== "boolean") throw new Error(`invalid ${key}`);
  if (!Array.isArray(body.warnings) || body.warnings.length > 32 || !body.warnings.every(name => typeof name === "string" && warningName.test(name))) throw new Error("invalid warnings");
  return { ...(body as unknown as SolarInverter), node_id: node, device, timestamp_ms: timestamp, warnings: [...(body.warnings as string[])] };
}

const BATTERY_OPTIONAL_RANGES: Record<string, readonly [number, number]> = {
  voltage_v: [0, 1000], current_a: [-1000, 1000], temperature_min_c: [-50, 200], temperature_max_c: [-50, 200], cell_min_v: [0, 10], cell_max_v: [0, 10],
};

function parseModule(value: unknown, index: number): SolarModule {
  const module = record(value, `module ${index}`);
  onlyKnown(module, ["n", "present", "voltage_v", "current_a", "temperature_c", "soc_percent", "state", "cells_v", "temperatures_c", "capacity_ah", "full_capacity_ah", "cycles"], `module ${index}`);
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
  return module as unknown as SolarModule;
}

export function parseSolarBattery(value: unknown): SolarBattery {
  const body = record(value, "battery");
  onlyKnown(body, ["kind", "node_id", "device", "timestamp_ms", "modules", "stack", "state", "voltage_v", "current_a", "temperature_min_c", "temperature_max_c", "cell_min_v", "cell_max_v", "soc_percent", "alarm", "model", "capacity_ah", "full_capacity_ah", "energy_kwh", "cycles"], "battery");
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

export type SolarDeviceView = { node_id: string; device: string; kind: "inverter" | "battery"; reading: SolarMessage; received_at: string; stale: boolean };
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

type Entry = { reading: SolarMessage; receivedAtMs: number; stale: boolean; samples: SolarSample[]; lastSampleMs: number };

const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;

export class SolarStore {
  readonly #entries = new Map<string, Entry>();
  readonly #options: Required<Pick<SolarStoreOptions, "now" | "staleAfterMs" | "sampleEveryMs" | "keepSamples" | "maxDevices">> & SolarStoreOptions;

  constructor(options: SolarStoreOptions = {}) {
    // an option given as undefined (a test that leaves the clock alone) means the default
    this.#options = {
      ...options, now: options.now ?? (() => Date.now()), staleAfterMs: options.staleAfterMs ?? 120_000, sampleEveryMs: options.sampleEveryMs ?? 30_000,
      keepSamples: options.keepSamples ?? 2880, maxDevices: options.maxDevices ?? 64,
    };
  }

  /** Keep a message. Refuses (throws) a new device when the store is full, so a broker full of noise cannot grow it without limit. */
  ingest(message: SolarMessage): void {
    const key = `${message.node_id}/${message.device}`;
    const now = this.#options.now();
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= this.#options.maxDevices) throw new Error("too many solar devices");
      entry = { reading: message, receivedAtMs: now, stale: false, samples: [], lastSampleMs: 0 };
      this.#entries.set(key, entry);
    }
    const wasStale = entry.stale;
    const modeChanged = entry.reading.kind === "inverter" && message.kind === "inverter" && entry.reading.mode !== message.mode;
    entry.reading = message;
    entry.receivedAtMs = now;
    entry.stale = false;
    if (modeChanged || now - entry.lastSampleMs >= this.#options.sampleEveryMs) {
      entry.samples.push(sampleOf(message, now));
      entry.lastSampleMs = now;
      if (entry.samples.length > this.#options.keepSamples) entry.samples.splice(0, entry.samples.length - this.#options.keepSamples);
    }
    if (wasStale) this.#options.onStale?.(message.node_id, message.device, false);
    this.#options.onMessage?.(message);
  }

  /** Mark the devices that went quiet (and tell), or came back. Called now and then. */
  sweep(): void {
    const now = this.#options.now();
    for (const entry of this.#entries.values()) {
      if (!entry.stale && now - entry.receivedAtMs > this.#options.staleAfterMs) {
        entry.stale = true;
        this.#options.onStale?.(entry.reading.node_id, entry.reading.device, true);
      }
    }
  }

  list(): SolarDeviceView[] {
    this.sweep();
    return [...this.#entries.values()].map(entry => ({
      node_id: entry.reading.node_id, device: entry.reading.device, kind: entry.reading.kind, reading: entry.reading,
      received_at: new Date(entry.receivedAtMs).toISOString(), stale: entry.stale,
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

  /** The recent samples of one device, oldest first; `minutes` bounds how far back. */
  history(node: string, device: string, minutes: number): { kind: "inverter" | "battery"; samples: SolarSample[] } | undefined {
    const entry = this.#entries.get(`${node}/${device}`);
    if (!entry) return undefined;
    const since = this.#options.now() - minutes * 60_000;
    return { kind: entry.reading.kind, samples: entry.samples.filter(sample => sample.t >= since) };
  }
}

/** The few numbers of a message that are worth a curve. */
function sampleOf(message: SolarMessage, t: number): SolarSample {
  if (message.kind === "inverter") {
    return { t, pv_w: message.pv_w, out_w: message.out_w, battery_v: message.battery_v, battery_a: message.battery_a, battery_percent: message.battery_percent, grid_v: message.grid_v, mode: message.mode };
  }
  const sample: SolarSample = { t, modules: message.modules };
  for (const key of ["soc_percent", "voltage_v", "current_a", "temperature_max_c", "cell_min_v", "cell_max_v", "energy_kwh"] as const) if (message[key] !== undefined) sample[key] = message[key] as number;
  return sample;
}
