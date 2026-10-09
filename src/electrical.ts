/**
 * What the ARMOR-ELECTRICAL nodes measure on the house's electrical network (armor/electrical/{node_id}/state): the strict parser of the message, and the
 * store that keeps the latest reading of every node, a short history of a few numbers per channel, and the few sums Studio shows.
 * The parser implements ARMOR-COMMON's electrical schema exactly (tests/electrical.test.ts runs the shared vectors), and so do the parsers of a command to a
 * switch and of the node's answer. Nothing in this file sends anything: the command path is electrical_switching.ts, and it is off unless the operator turned it on.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { CoarseTier } from "./history.js";
import { finite, onlyKnown, readNodeId, readTimestamp, record } from "./contracts.js";

export type ElectricalChannel = {
  id: string; domain: "ac" | "dc"; label?: string; voltage_v?: number; current_a?: number; power_w?: number; energy_kwh?: number; frequency_hz?: number; power_factor?: number;
  state?: "closed" | "open" | "unknown"; alarm?: boolean; alarm_code?: string;
};
export type Side = "none" | "a" | "b";
export type SwitchFault = "none" | "did_not_close" | "did_not_open" | "both_closed" | "disabled";
/** A switch of a node (a source transfer: two contactors onto one line). What it says is what the auxiliary contacts show, never what was asked. */
export type ElectricalSwitch = {
  id: string; kind: "transfer"; label?: string; source_a?: string; source_b?: string; a_closed: boolean; b_closed: boolean;
  selected: Side; wanted: Side; closing: boolean; armed: boolean; fault: SwitchFault;
};
export type ElectricalMessage = { kind: "electrical"; node_id: string; timestamp_ms: number; switching_enabled?: boolean; channels: ElectricalChannel[]; switches?: ElectricalSwitch[] };

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

const SIDES: readonly string[] = ["none", "a", "b"];
const FAULTS: readonly string[] = ["none", "did_not_close", "did_not_open", "both_closed", "disabled"];
const SWITCH_KEYS = ["id", "kind", "label", "source_a", "source_b", "a_closed", "b_closed", "selected", "wanted", "closing", "armed", "fault"] as const;
export const MAX_SWITCHES = 4;

function parseSwitch(value: unknown, index: number): ElectricalSwitch {
  const item = record(value, `switch ${index}`);
  onlyKnown(item, SWITCH_KEYS, `switch ${index}`);
  for (const key of ["id", "kind", "a_closed", "b_closed", "selected", "wanted", "closing", "armed", "fault"]) if (!(key in item)) throw new Error(`switch ${index} is missing ${key}`);
  if (typeof item.id !== "string" || !channelId.test(item.id)) throw new Error(`invalid switch ${index}.id`);
  if (item.kind !== "transfer") throw new Error(`invalid switch ${index}.kind`);
  if ("label" in item && (typeof item.label !== "string" || Array.from(item.label).length < 1 || Array.from(item.label).length > 40)) throw new Error(`invalid switch ${index}.label`);
  for (const key of ["source_a", "source_b"]) if (key in item && (typeof item[key] !== "string" || !channelId.test(item[key] as string))) throw new Error(`invalid switch ${index}.${key}`);
  for (const key of ["a_closed", "b_closed", "closing", "armed"]) if (typeof item[key] !== "boolean") throw new Error(`invalid switch ${index}.${key}`);
  for (const key of ["selected", "wanted"]) if (typeof item[key] !== "string" || !SIDES.includes(item[key] as string)) throw new Error(`invalid switch ${index}.${key}`);
  if (typeof item.fault !== "string" || !FAULTS.includes(item.fault)) throw new Error(`invalid switch ${index}.fault`);
  return item as unknown as ElectricalSwitch;
}

export function parseElectricalMessage(value: unknown): ElectricalMessage {
  const body = record(value, "electrical message");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "switching_enabled", "channels", "switches"], "electrical message");
  for (const key of ["kind", "node_id", "timestamp_ms", "channels"]) if (!(key in body)) throw new Error(`the electrical message is missing ${key}`);
  if (body.kind !== "electrical") throw new Error("invalid kind");
  const node = readNodeId(body), timestamp = readTimestamp(body);
  if ("switching_enabled" in body && typeof body.switching_enabled !== "boolean") throw new Error("invalid switching_enabled");
  if (!Array.isArray(body.channels) || body.channels.length > 16) throw new Error("invalid channels");
  const channels = body.channels.map(parseChannel);
  if (new Set(channels.map(channel => channel.id)).size !== channels.length) throw new Error("a channel id must appear once");
  if ("switches" in body) {
    if (!Array.isArray(body.switches) || body.switches.length > MAX_SWITCHES) throw new Error("invalid switches");
    const switches = body.switches.map(parseSwitch);
    if (new Set(switches.map(item => item.id)).size !== switches.length) throw new Error("a switch id must appear once");
    return { ...(body as unknown as ElectricalMessage), node_id: node, timestamp_ms: timestamp, channels, switches };
  }
  return { ...(body as unknown as ElectricalMessage), node_id: node, timestamp_ms: timestamp, channels };
}

// ---- the command to a switch, and the node's answer ---------------------------------------------------------------------------------------

export const SWITCH_ACTIONS = ["arm", "close_a", "close_b", "open", "acknowledge"] as const;
export type SwitchAction = (typeof SWITCH_ACTIONS)[number];
export const REFUSALS = ["none", "disabled", "fault", "not_armed", "not_confirmed_open", "unknown_switch", "bad_token", "not_supported"] as const;
export type Refusal = (typeof REFUSALS)[number];
/** A command id or a token: lowercase letters and digits, eight to thirty-two. */
export const codePattern = /^[a-z0-9]{8,32}$/;

export type ElectricalCommand = { kind: "electrical_command"; node_id: string; timestamp_ms: number; command_id: string; switch: string; action: SwitchAction; token?: string };
export type ElectricalResult = { kind: "electrical_result"; node_id: string; timestamp_ms: number; command_id: string; switch: string; action: SwitchAction; accepted: boolean; refusal: Refusal; token?: string };

function readCommonSwitchFields(body: Record<string, unknown>, kind: string): void {
  for (const key of ["kind", "node_id", "timestamp_ms", "command_id", "switch", "action"]) if (!(key in body)) throw new Error(`the ${kind} is missing ${key}`);
  if (typeof body.command_id !== "string" || !codePattern.test(body.command_id)) throw new Error("invalid command_id");
  if (typeof body.switch !== "string" || !channelId.test(body.switch)) throw new Error("invalid switch");
  if (typeof body.action !== "string" || !(SWITCH_ACTIONS as readonly string[]).includes(body.action)) throw new Error("invalid action");
  if ("token" in body && (typeof body.token !== "string" || !codePattern.test(body.token))) throw new Error("invalid token");
}

/** A command to a switch, as the contract has it: a token exactly on close_a and close_b. The server builds these; the parser is what the shared vectors check. */
export function parseElectricalCommand(value: unknown): ElectricalCommand {
  const body = record(value, "electrical command");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "command_id", "switch", "action", "token"], "electrical command");
  readCommonSwitchFields(body, "electrical command");
  if (body.kind !== "electrical_command") throw new Error("invalid kind");
  const node = readNodeId(body), timestamp = readTimestamp(body);
  if ((body.action === "close_a" || body.action === "close_b") !== ("token" in body)) throw new Error("a token goes on close_a and close_b and on nothing else");
  return { ...(body as unknown as ElectricalCommand), node_id: node, timestamp_ms: timestamp };
}

/** The answer of a node: the refusal is none exactly when it accepted, and a token comes only with an accepted arm. */
export function parseElectricalResult(value: unknown): ElectricalResult {
  const body = record(value, "electrical result");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "command_id", "switch", "action", "accepted", "refusal", "token"], "electrical result");
  readCommonSwitchFields(body, "electrical result");
  for (const key of ["accepted", "refusal"]) if (!(key in body)) throw new Error(`the electrical result is missing ${key}`);
  if (body.kind !== "electrical_result") throw new Error("invalid kind");
  const node = readNodeId(body), timestamp = readTimestamp(body);
  if (typeof body.accepted !== "boolean") throw new Error("invalid accepted");
  if (typeof body.refusal !== "string" || !(REFUSALS as readonly string[]).includes(body.refusal)) throw new Error("invalid refusal");
  if (body.accepted !== (body.refusal === "none")) throw new Error("the refusal is none exactly when the request was accepted");
  if (("token" in body) !== (body.accepted && body.action === "arm")) throw new Error("a token is given only in the result of an accepted arm");
  return { ...(body as unknown as ElectricalResult), node_id: node, timestamp_ms: timestamp };
}

/** armor/electrical/{node_id}/{leaf} as node_id, or undefined when the topic is not one; the leaf is state (a node's reading), command or result. */
export function electricalTopic(topic: string, leaf: "state" | "command" | "result" = "state"): string | undefined {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== "armor" || parts[1] !== "electrical" || parts[3] !== leaf) return undefined;
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
type Entry = { reading: ElectricalMessage; receivedAtMs: number; stale: boolean; samples: Map<string, ElectricalSample[]>; coarse: Map<string, CoarseTier>; lastSampleMs: Map<string, number> };
/** What is kept of the history of the channels between runs, by node and channel. */
export type ElectricalHistoryFile = { nodes: Record<string, Record<string, { samples: ElectricalSample[]; coarse: ElectricalSample[] }>> };
const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;

export class ElectricalStore {
  readonly #entries = new Map<string, Entry>();
  /** History read from the file before the node has reported again: it is given to the node when it does. */
  readonly #pending = new Map<string, Record<string, { samples: ElectricalSample[]; coarse: ElectricalSample[] }>>();
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
      entry = { reading: message, receivedAtMs: now, stale: false, samples: new Map(), coarse: new Map(), lastSampleMs: new Map() };
      const kept = this.#pending.get(message.node_id);
      if (kept) {
        for (const [channel, value] of Object.entries(kept)) {
          entry.samples.set(channel, value.samples.slice(-this.#options.keepSamples));
          const tier = new CoarseTier(); tier.load(value.coarse); entry.coarse.set(channel, tier);
        }
        this.#pending.delete(message.node_id);
      }
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
      const tier = entry.coarse.get(channel.id) ?? new CoarseTier();
      tier.add(sample as ElectricalSample & Record<string, number>);
      entry.coarse.set(channel.id, tier);
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

  /** The recent samples of one channel, oldest first; `minutes` bounds how far back. Past a day the five-minute averages answer. */
  history(node: string, channel: string, minutes: number): ElectricalSample[] | undefined {
    const entry = this.#entries.get(node);
    if (!entry || !entry.reading.channels.some(item => item.id === channel)) return undefined;
    const since = this.#options.now() - minutes * 60_000;
    const source = minutes > 1440 ? (entry.coarse.get(channel)?.all() ?? []) as ElectricalSample[] : entry.samples.get(channel) ?? [];
    return source.filter(sample => sample.t >= since);
  }

  /** What has to be kept between runs: the history of every channel of every node. */
  exportHistory(): ElectricalHistoryFile {
    const nodes: ElectricalHistoryFile["nodes"] = {};
    for (const [node, entry] of this.#entries) {
      const channels: ElectricalHistoryFile["nodes"][string] = {};
      for (const [channel, samples] of entry.samples) channels[channel] = { samples, coarse: (entry.coarse.get(channel)?.all() ?? []) as ElectricalSample[] };
      nodes[node] = channels;
    }
    for (const [node, kept] of this.#pending) if (!(node in nodes)) nodes[node] = kept;
    return { nodes };
  }

  /** Takes back what `exportHistory` made; each node gets its history when it reports again. */
  importHistory(file: ElectricalHistoryFile | undefined): void {
    if (!file || typeof file !== "object" || typeof file.nodes !== "object" || file.nodes === null) return;
    const good = (list: unknown): ElectricalSample[] => (Array.isArray(list) ? list.filter((s): s is ElectricalSample => typeof s === "object" && s !== null && Number.isFinite((s as { t?: unknown }).t)) : []);
    for (const [node, channels] of Object.entries(file.nodes)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(node) || typeof channels !== "object" || channels === null || this.#pending.size >= this.#options.maxNodes) continue;
      const kept: Record<string, { samples: ElectricalSample[]; coarse: ElectricalSample[] }> = {};
      for (const [channel, value] of Object.entries(channels)) if (/^[a-z0-9_-]{1,32}$/.test(channel)) kept[channel] = { samples: good(value?.samples), coarse: good(value?.coarse) };
      this.#pending.set(node, kept);
    }
  }
}

