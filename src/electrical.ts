/**
 * What the ARMOR-NODE-ELECTRICAL nodes measure on the house's electrical network (armor/electrical/{node_id}/state): the strict parser of the message, and the
 * store that keeps the latest reading of every node, a short history of a few numbers per channel, and the few sums Studio shows.
 * The parser implements ARMOR-COMMON's electrical schema exactly (tests/electrical.test.ts runs the shared vectors), and so do the parsers of a command to a
 * switch and of the node's answer. Nothing in this file sends anything: the command path is electrical_switching.ts, and it is off unless the operator turned it on.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Electrical, ElectricalChannel, ElectricalCommand, ElectricalResult, ElectricalSwitch } from "./armor-contracts.js";
import { CoarseTier } from "./history.js";
import { checkAgainstContract, onlyKnown, record } from "./contracts.js";
import { refresh, sweepStale } from "./staleness.js";

/** The shapes of the electrical messages are the ones ARMOR-COMMON generates from its schemas. */
export type { ElectricalChannel, ElectricalCommand, ElectricalResult, ElectricalSwitch };
export type ElectricalMessage = Electrical;
export type Side = ElectricalSwitch["selected"];
export type SwitchFault = ElectricalSwitch["fault"];

const CHANNEL_KEYS = ["id", "domain", "label", "voltage_v", "current_a", "power_w", "energy_kwh", "power_estimated", "frequency_hz", "power_factor", "state", "alarm", "alarm_code", "reading_age_ms", "errors"] as const;

const SWITCH_KEYS = ["id", "kind", "label", "source_a", "source_b", "a_closed", "b_closed", "selected", "wanted", "closing", "armed", "fault"] as const;
export const MAX_SWITCHES = 4;

/** The unknown fields of a channel or a switch are never forgiven: they are refused before the generated reader looks at the rest. */
function onlyKnownItems(items: unknown, allowed: readonly string[], what: string): void {
  if (!Array.isArray(items)) return;
  items.forEach((item, index) => { if (item && typeof item === "object" && !Array.isArray(item)) onlyKnown(item as Record<string, unknown>, allowed, `${what} ${index}`); });
}

export function parseElectricalMessage(value: unknown): ElectricalMessage {
  const body = record(value, "electrical message");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "switching_enabled", "channels", "switches"], "electrical message");
  onlyKnownItems(body.channels, CHANNEL_KEYS, "channel");
  onlyKnownItems(body.switches, SWITCH_KEYS, "switch");
  checkAgainstContract("electrical", body);
  const channels = body.channels as ElectricalChannel[];
  if (new Set(channels.map(channel => channel.id)).size !== channels.length) throw new Error("a channel id must appear once");
  if ("switches" in body) {
    const switches = body.switches as ElectricalSwitch[];
    if (new Set(switches.map(item => item.id)).size !== switches.length) throw new Error("a switch id must appear once");
  }
  return body as unknown as ElectricalMessage;
}

// ---- the command to a switch, and the node's answer ---------------------------------------------------------------------------------------

export const SWITCH_ACTIONS = ["arm", "close_a", "close_b", "open", "acknowledge"] as const;
export type SwitchAction = ElectricalCommand["action"];
export const REFUSALS = ["none", "disabled", "fault", "not_armed", "not_confirmed_open", "unknown_switch", "bad_token", "not_supported"] as const;
export type Refusal = ElectricalResult["refusal"];
/** A token: lowercase letters and digits, eight to thirty-two. */
export const codePattern = /^[a-z0-9]{8,32}$/;
/** The id of a command: sixteen lowercase hexadecimal digits, the one format of every command in the family. */
export const commandIdPattern = /^[0-9a-f]{16}$/;



/** A command to a switch, as the contract has it: a token exactly on close_a and close_b. The server builds these; the parser is what the shared vectors check. */
export function parseElectricalCommand(value: unknown): ElectricalCommand {
  const body = record(value, "electrical command");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "command_id", "switch", "action", "token"], "electrical command");
  checkAgainstContract("electrical_command", body);
  if ((body.action === "close_a" || body.action === "close_b") !== ("token" in body)) throw new Error("a token goes on close_a and close_b and on nothing else");
  return body as unknown as ElectricalCommand;
}

/** The answer of a node: the refusal is none exactly when it accepted, and a token comes only with an accepted arm. */
export function parseElectricalResult(value: unknown): ElectricalResult {
  const body = record(value, "electrical result");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "command_id", "switch", "action", "accepted", "refusal", "token"], "electrical result");
  checkAgainstContract("electrical_result", body);
  if (body.accepted !== (body.refusal === "none")) throw new Error("the refusal is none exactly when the request was accepted");
  if (("token" in body) !== (body.accepted && body.action === "arm")) throw new Error("a token is given only in the result of an accepted arm");
  return body as unknown as ElectricalResult;
}

/** armor/electrical/{node_id}/{leaf} as node_id, or undefined when the topic is not one; the leaf is state (a node's reading), command or result. */
export function electricalTopic(topic: string, leaf: "state" | "command" | "result" = "state"): string | undefined {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== "armor" || parts[1] !== "electrical" || parts[3] !== leaf) return undefined;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[2]) ? parts[2] : undefined;
}

// ---- the store --------------------------------------------------------------------------------------------------------------------------

export type ElectricalNodeView = { node_id: string; reading: ElectricalMessage; received_at: string; stale: boolean; /** The channels whose own reading is older than the node tolerates (see STALE_READING_MS): their numbers are the last good ones, not a measurement of now. Only given while the option to set them aside is on. */ stale_channels?: string[] };
export type ElectricalTotals = {
  nodes: number; channels: number; stale: number;
  /** Channels of nodes that are not stale whose own reading is old and that are therefore left out of the grid figure (0 when the option is off). */
  stale_readings: number;
  /** The power drawn from the grid in watts (negative when the house feeds it), from the channel called `grid` of the nodes that are not stale; null when none reports it. */
  grid_w: number | null;
  /** True when the grid figure includes a channel the node only estimated (apparent power from a current and a nominal voltage). */
  grid_estimated: boolean;
  /** The energy that has passed through the grid channel, in kilowatt-hours; null when none says. */
  grid_kwh: number | null;
  /** Channels that raised an alarm. */
  alarms: number;
};
export type ElectricalSample = { t: number } & Partial<Record<"voltage_v" | "current_a" | "power_w" | "energy_kwh", number>>;

export type ElectricalStoreOptions = {
  now?: () => number;
  /** Whether a channel whose own reading is old is set aside (not counted in the grid figure, not written to the history, listed in `stale_channels`). Asked each time; on when not given. */
  setAsideOldReadings?: () => boolean;
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
/** How old (in milliseconds) the reading of one channel may be before its numbers are no longer a measurement of now: a meter that stopped answering keeps its last good numbers, with a growing age. */
export const STALE_READING_MS = 60_000;
const oldReading = (channel: ElectricalChannel): boolean => channel.reading_age_ms !== undefined && channel.reading_age_ms > STALE_READING_MS;
const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;

export class ElectricalStore {
  readonly #entries = new Map<string, Entry>();
  /** History read from the file before the node has reported again: it is given to the node when it does. */
  readonly #pending = new Map<string, Record<string, { samples: ElectricalSample[]; coarse: ElectricalSample[] }>>();
  readonly #options: Required<Pick<ElectricalStoreOptions, "now" | "staleAfterMs" | "sampleEveryMs" | "keepSamples" | "maxNodes">> & ElectricalStoreOptions;

  constructor(options: ElectricalStoreOptions = {}) {
    this.#options = { ...options, now: options.now ?? (() => Date.now()), staleAfterMs: options.staleAfterMs ?? 60_000, sampleEveryMs: options.sampleEveryMs ?? 30_000, keepSamples: options.keepSamples ?? 2880, maxNodes: options.maxNodes ?? 32 };
  }

  #aside(): boolean { return this.#options.setAsideOldReadings?.() ?? true; }

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
    entry.reading = message;
    const wasStale = refresh(entry, now);
    const aside = this.#aside();
    for (const channel of message.channels) {
      if (aside && oldReading(channel)) continue;   // an old number is not a point of the graph
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
    sweepStale(this.#entries.values(), this.#options.now(), this.#options.staleAfterMs, entry => this.#options.onStale?.(entry.reading.node_id, true));
  }

  list(): ElectricalNodeView[] {
    this.sweep();
    const aside = this.#aside();
    return [...this.#entries.values()].map(entry => ({ node_id: entry.reading.node_id, reading: entry.reading, received_at: new Date(entry.receivedAtMs).toISOString(), stale: entry.stale, ...(aside ? { stale_channels: entry.reading.channels.filter(oldReading).map(channel => channel.id) } : {}) }))
      .sort((a, b) => a.node_id.localeCompare(b.node_id));
  }

  totals(): ElectricalTotals {
    this.sweep();
    const aside = this.#aside();
    let channels = 0, stale = 0, staleReadings = 0, alarms = 0, grid: number | null = null, gridEnergy: number | null = null, gridEstimated = false;
    for (const entry of this.#entries.values()) {
      channels += entry.reading.channels.length;
      if (entry.stale) { stale += 1; continue; }
      for (const channel of entry.reading.channels) {
        if (channel.alarm === true) alarms += 1;
        if (aside && oldReading(channel)) { staleReadings += 1; continue; }
        if (channel.id === "grid" && channel.domain === "ac") {
          if (channel.power_w !== undefined) { grid = (grid ?? 0) + channel.power_w; if (channel.power_estimated === true) gridEstimated = true; }
          if (channel.energy_kwh !== undefined) gridEnergy = (gridEnergy ?? 0) + channel.energy_kwh;
        }
      }
    }
    return { nodes: this.#entries.size, channels, stale, stale_readings: staleReadings, grid_w: grid === null ? null : round(grid, 0), grid_estimated: gridEstimated, grid_kwh: gridEnergy === null ? null : round(gridEnergy, 2), alarms };
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


// A list that misses a value of the generated type, or holds one it does not have, stops the build here.
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const listsMatchContract: [Exactly<SwitchAction, (typeof SWITCH_ACTIONS)[number]>, Exactly<Refusal, (typeof REFUSALS)[number]>] = [true, true];
void listsMatchContract;
