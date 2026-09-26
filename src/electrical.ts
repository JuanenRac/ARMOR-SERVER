/**
 * What the ARMOR-ELECTRICAL nodes measure on the house's electrical network (armor/electrical/{node_id}/state): the strict parser of the message, and the
 * store that keeps the latest reading of every node, a short history of a few numbers per channel, and the few sums Studio shows.
 * The parser implements ARMOR-COMMON's electrical schema exactly (tests/electrical.test.ts runs the shared vectors). Reading only: nothing here sends a
 * command to a node.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { finite, onlyKnown, readNodeId, readTimestamp, record } from "./contracts.js";

export type ElectricalChannel = {
  id: string; domain: "ac" | "dc"; label?: string; voltage_v?: number; current_a?: number; power_w?: number; energy_kwh?: number; frequency_hz?: number; power_factor?: number;
  state?: "closed" | "open" | "unknown"; alarm?: boolean; alarm_code?: string;
};
export type ElectricalMessage = { kind: "electrical"; node_id: string; timestamp_ms: number; switching_enabled?: boolean; channels: ElectricalChannel[] };

const channelId = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const alarmCode = /^[a-z][a-z0-9_]{0,39}$/;
const RANGES: Record<string, readonly [number, number]> = {
  voltage_v: [0, 1000], current_a: [-1000, 1000], power_w: [-1_000_000, 1_000_000], energy_kwh: [0, 10_000_000], frequency_hz: [0, 100], power_factor: [-1, 1],
};
const inRange = (value: unknown, low: number, high: number): value is number => finite(value) && value >= low && value <= high;
const CHANNEL_KEYS = ["id", "domain", "label", "voltage_v", "current_a", "power_w", "energy_kwh", "frequency_hz", "power_factor", "state", "alarm", "alarm_code"] as const;

function parseChannel(value: unknown, index: number): ElectricalChannel {
  const channel = record(value, `channel ${index}`);
  onlyKnown(channel, CHANNEL_KEYS, `channel ${index}`);
  if (typeof channel.id !== "string" || !channelId.test(channel.id)) throw new Error(`invalid channel ${index}.id`);
  if (channel.domain !== "ac" && channel.domain !== "dc") throw new Error(`invalid channel ${index}.domain`);
  if ("label" in channel && (typeof channel.label !== "string" || Array.from(channel.label).length < 1 || Array.from(channel.label).length > 40)) throw new Error(`invalid channel ${index}.label`);
  for (const [key, [low, high]] of Object.entries(RANGES)) if (key in channel && !inRange(channel[key], low, high)) throw new Error(`invalid channel ${index}.${key}`);
  if ("state" in channel && channel.state !== "closed" && channel.state !== "open" && channel.state !== "unknown") throw new Error(`invalid channel ${index}.state`);
  if ("alarm" in channel && typeof channel.alarm !== "boolean") throw new Error(`invalid channel ${index}.alarm`);
  if ("alarm_code" in channel && (typeof channel.alarm_code !== "string" || !alarmCode.test(channel.alarm_code))) throw new Error(`invalid channel ${index}.alarm_code`);
  return channel as unknown as ElectricalChannel;
}

export function parseElectricalMessage(value: unknown): ElectricalMessage {
  const body = record(value, "electrical message");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "switching_enabled", "channels"], "electrical message");
  for (const key of ["kind", "node_id", "timestamp_ms", "channels"]) if (!(key in body)) throw new Error(`the electrical message is missing ${key}`);
  if (body.kind !== "electrical") throw new Error("invalid kind");
  const node = readNodeId(body), timestamp = readTimestamp(body);
  if ("switching_enabled" in body && typeof body.switching_enabled !== "boolean") throw new Error("invalid switching_enabled");
  if (!Array.isArray(body.channels) || body.channels.length > 16) throw new Error("invalid channels");
  const channels = body.channels.map(parseChannel);
  if (new Set(channels.map(channel => channel.id)).size !== channels.length) throw new Error("a channel id must appear once");
  return { ...(body as unknown as ElectricalMessage), node_id: node, timestamp_ms: timestamp, channels };
}

/** armor/electrical/{node_id}/state as node_id, or undefined when the topic is not one. */
export function electricalTopic(topic: string): string | undefined {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== "armor" || parts[1] !== "electrical" || parts[3] !== "state") return undefined;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[2]) ? parts[2] : undefined;
}

// ---- the store --------------------------------------------------------------------------------------------------------------------------

export type ElectricalNodeView = { node_id: string; reading: ElectricalMessage; received_at: string; stale: boolean };
export type ElectricalTotals = {
  nodes: number; channels: number; stale: number;
  /** The power drawn from the grid in watts (negative when the house feeds it), from the channel called `grid` of the nodes that are not stale; null when none reports it. */
  grid_w: number | null;
  /** The energy that has passed through the grid channel, in kilowatt-hours; null when none says. */
  grid_kwh: number | null;
  /** Channels that raised an alarm. */
  alarms: number;
};
export type ElectricalSample = { t: number } & Partial<Record<"voltage_v" | "current_a" | "power_w" | "energy_kwh", number>>;

export type ElectricalStoreOptions = {
  now?: () => number;
  /** A node that has not reported for this long is stale. */
  staleAfterMs?: number;
  /** At most one sample of history per channel in this time. */
  sampleEveryMs?: number;
  /** How many samples of history a channel keeps (2880 at 30 s is a day). */
  keepSamples?: number;
  maxNodes?: number;
  onMessage?: (message: ElectricalMessage) => void;
  onStale?: (node: string, stale: boolean) => void;
};
type Entry = { reading: ElectricalMessage; receivedAtMs: number; stale: boolean; samples: Map<string, ElectricalSample[]>; lastSampleMs: Map<string, number> };
const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;

export class ElectricalStore {
  readonly #entries = new Map<string, Entry>();
  readonly #options: Required<Pick<ElectricalStoreOptions, "now" | "staleAfterMs" | "sampleEveryMs" | "keepSamples" | "maxNodes">> & ElectricalStoreOptions;

  constructor(options: ElectricalStoreOptions = {}) {
    this.#options = { ...options, now: options.now ?? (() => Date.now()), staleAfterMs: options.staleAfterMs ?? 60_000, sampleEveryMs: options.sampleEveryMs ?? 30_000, keepSamples: options.keepSamples ?? 2880, maxNodes: options.maxNodes ?? 32 };
  }

  /** Keep a message. Refuses (throws) a new node when the store is full, so a broker full of noise cannot grow it without limit. */
  ingest(message: ElectricalMessage): void {
    const now = this.#options.now();
    let entry = this.#entries.get(message.node_id);
    if (!entry) {
      if (this.#entries.size >= this.#options.maxNodes) throw new Error("too many electrical nodes");
      entry = { reading: message, receivedAtMs: now, stale: false, samples: new Map(), lastSampleMs: new Map() };
      this.#entries.set(message.node_id, entry);
    }
    const wasStale = entry.stale;
    entry.reading = message;
    entry.receivedAtMs = now;
    entry.stale = false;
    for (const channel of message.channels) {
      if (now - (entry.lastSampleMs.get(channel.id) ?? 0) < this.#options.sampleEveryMs) continue;
      const samples = entry.samples.get(channel.id) ?? [];
      const sample: ElectricalSample = { t: now };
      for (const key of ["voltage_v", "current_a", "power_w", "energy_kwh"] as const) if (channel[key] !== undefined) sample[key] = channel[key];
      samples.push(sample);
      if (samples.length > this.#options.keepSamples) samples.splice(0, samples.length - this.#options.keepSamples);
      entry.samples.set(channel.id, samples);
      entry.lastSampleMs.set(channel.id, now);
    }
    if (wasStale) this.#options.onStale?.(message.node_id, false);
    this.#options.onMessage?.(message);
  }

  remove(node: string): boolean { return this.#entries.delete(node); }

  /** Mark the nodes that went quiet (and tell), called now and then. */
  sweep(): void {
    const now = this.#options.now();
    for (const entry of this.#entries.values()) {
      if (!entry.stale && now - entry.receivedAtMs > this.#options.staleAfterMs) {
        entry.stale = true;
        this.#options.onStale?.(entry.reading.node_id, true);
      }
    }
  }

  list(): ElectricalNodeView[] {
    this.sweep();
    return [...this.#entries.values()].map(entry => ({ node_id: entry.reading.node_id, reading: entry.reading, received_at: new Date(entry.receivedAtMs).toISOString(), stale: entry.stale }))
      .sort((a, b) => a.node_id.localeCompare(b.node_id));
  }

  totals(): ElectricalTotals {
    this.sweep();
    let channels = 0, stale = 0, alarms = 0, grid: number | null = null, gridEnergy: number | null = null;
    for (const entry of this.#entries.values()) {
      channels += entry.reading.channels.length;
      if (entry.stale) { stale += 1; continue; }
      for (const channel of entry.reading.channels) {
        if (channel.alarm === true) alarms += 1;
        if (channel.id === "grid" && channel.domain === "ac") {
          if (channel.power_w !== undefined) grid = (grid ?? 0) + channel.power_w;
          if (channel.energy_kwh !== undefined) gridEnergy = (gridEnergy ?? 0) + channel.energy_kwh;
        }
      }
    }
    return { nodes: this.#entries.size, channels, stale, grid_w: grid === null ? null : round(grid, 0), grid_kwh: gridEnergy === null ? null : round(gridEnergy, 2), alarms };
  }

  /** The recent samples of one channel, oldest first; `minutes` bounds how far back. */
  history(node: string, channel: string, minutes: number): ElectricalSample[] | undefined {
    const entry = this.#entries.get(node);
    if (!entry || !entry.reading.channels.some(item => item.id === channel)) return undefined;
    const since = this.#options.now() - minutes * 60_000;
    return (entry.samples.get(channel) ?? []).filter(sample => sample.t >= since);
  }
}

