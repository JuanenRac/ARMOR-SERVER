/**
 * What the ARMOR-NETWORK nodes see on the local network (armor/network/{node_id}/state): the strict parser of the message, the store that keeps the latest state of every
 * node, a short history of the internet and of the traffic, the list of outages, and the notes an operator keeps about the devices (their name, whether they are known).
 * The parser implements ARMOR-COMMON's network schema exactly (tests/network.test.ts runs the shared vectors). Nothing here sends anything to a node: a node observes.
 *
 * Everything a node reports is a finding about the network, never a fact the server relies on for anything but showing it and raising alarms: the kind of a device, its
 * operating system and its maker are guesses, and an address or a MAC can be lied about by whoever owns the device.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { checkAgainstContract, onlyKnown, record } from "./contracts.js";
import { durableRename } from "./durable.js";
import { refresh, sweepStale } from "./staleness.js";
import type * as Generated from "./armor-contracts.js";

export const DEVICE_KINDS = ["router", "computer", "phone", "tv", "printer", "camera", "iot", "server", "nas", "network", "unknown"] as const;
export type DeviceKind = NonNullable<Generated.NetworkDevice["kind"]>;
export const INTERNET_STATES = ["up", "degraded", "down", "lan_down", "unknown"] as const;
export type InternetState = Generated.NetworkInternet["state"];
export const EVENT_KINDS = ["new_device", "device_online", "device_offline", "ip_changed", "arp_conflict", "port_opened", "port_closed", "internet_down", "internet_up", "gateway_down", "gateway_up"] as const;
export type NetworkEventKind = Generated.NetworkEvent["kind"];
const INTERNET_EVENTS: readonly string[] = ["internet_down", "internet_up", "gateway_down", "gateway_up"];

/** The shapes of the network messages are the ones ARMOR-COMMON generates from its schemas. */
export type NetworkProbe = Generated.NetworkProbe;
export type NetworkPort = Generated.NetworkPort;
export type NetworkDevice = Generated.NetworkDevice;
export type NetworkEvent = Generated.NetworkEvent;
export type NetworkInternet = Generated.NetworkInternet;
/** What the internet sees of the connection, asked of a public service by the node now and then. */
export type NetworkPublic = Generated.NetworkPublic;
export const COMMAND_TYPES = ["scan_now", "ping", "traceroute", "wake", "ports", "http", "inspect"] as const;
export type CommandType = Generated.NetworkResults["type"];
/** What a node did with a manual order the server handed it. */
export type NetworkResult = Generated.NetworkResults;
/** The version of the network contract this server speaks. A node that says a lower number (or none, which is the first version) is older than the server and is shown as outdated. */
export const NETWORK_CONTRACT = 1;
/** Whether a node that says it speaks `said` (or says nothing: the first version) is older than `current`. */
export const outdatedContract = (said: number | undefined, current: number = NETWORK_CONTRACT): boolean => (said ?? 1) < current;
export type NetworkMessage = Generated.Network;

const DEVICE_ID = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
export const MAX_DEVICES = 512;
export const MAX_EVENTS = 64;

const length = (value: string): number => Array.from(value).length;
const whole = (value: unknown, low: number, high = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;

/** Whether `cidr` (already well formed) lies inside 10/8, 172.16/12 or 192.168/16: the nodes never scan anything else. */
function insidePrivateRange(cidr: string): boolean {
  const [address, bits] = cidr.split("/") as [string, string];
  const prefix = Number(bits);
  const value = address.split(".").reduce((total, part) => total * 256 + Number(part), 0);
  return ([[0x0a000000, 8], [0xac100000, 12], [0xc0a80000, 16]] as const).some(([base, length]) => prefix >= length && Math.floor(value / 2 ** (32 - length)) === base / 2 ** (32 - length));
}

/** The objects inside a message never carry a field the contract does not define, even when the server reads a node's message forgivingly: they are refused before the generated reader looks at the rest. */
function onlyKnownIn(value: unknown, allowed: readonly string[], what: string): void {
  if (value && typeof value === "object" && !Array.isArray(value)) onlyKnown(value as Record<string, unknown>, allowed, what);
}
function onlyKnownEach(values: unknown, allowed: readonly string[], what: string): void {
  if (Array.isArray(values)) values.forEach((value, index) => onlyKnownIn(value, allowed, `${what} ${index}`));
}

/** The rules that join fields or reach beyond one field; every single field is checked by the reader ARMOR-COMMON generates. */
function checkNetworkRules(body: Record<string, unknown>): { devices: NetworkDevice[]; events: NetworkEvent[] | undefined; results: NetworkResult[] | undefined } {
  const iface = body.interface as NetworkMessage["interface"];
  if (!insidePrivateRange(iface.cidr)) throw new Error("the network a node watches is a private range (10/8, 172.16/12 or 192.168/16)");
  const devices = body.devices as NetworkDevice[];
  devices.forEach((device, index) => {
    // a device with a MAC has it as its id (or is still known by its address), and it was not first seen after it was last seen
    if (typeof device.mac === "string" && device.id !== device.mac && !device.id.startsWith("ip-")) throw new Error(`device ${index} has a MAC that is not its id`);
    if (device.first_seen_ms > device.last_seen_ms) throw new Error(`device ${index} was first seen after it was last seen`);
  });
  if (new Set(devices.map(device => device.id)).size !== devices.length) throw new Error("a device id must appear once");
  const events = body.events as NetworkEvent[] | undefined;
  if (events) {
    events.forEach((event, index) => {
      const internet = INTERNET_EVENTS.includes(event.kind);
      if (internet && ("device_id" in event || "port" in event)) throw new Error(`event ${index} is about the internet, not a device or a port`);
      if (!internet && !("device_id" in event)) throw new Error(`event ${index} is about a device and names none`);
      if ("outage_s" in event && event.kind !== "internet_up" && event.kind !== "gateway_up") throw new Error(`event ${index} says how long it was down but is not an end`);
      if ((event.kind === "port_opened" || event.kind === "port_closed") && !("port" in event)) throw new Error(`event ${index} is about a port and names none`);
    });
    if (new Set(events.map(event => event.id)).size !== events.length) throw new Error("an event id must appear once");
  }
  // the schema of the DNS check gives only the longest a name and an address may be; an empty one says nothing and is refused here
  const dns = (body.public as NetworkPublic | undefined)?.dns;
  if (dns && (dns.name === "" || dns.addresses.some(address => address === ""))) throw new Error("invalid public.dns");
  const results = body.results as NetworkResult[] | undefined;
  if (results && new Set(results.map(result => result.id)).size !== results.length) throw new Error("a result id must appear once");
  return { devices, events, results };
}

export function parseNetworkMessage(value: unknown): NetworkMessage {
  const body = record(value, "network message");
  onlyKnown(body, ["kind", "node_id", "contract", "timestamp_ms", "interface", "internet", "devices", "events", "scan", "public", "results"], "network message");
  onlyKnownIn(body.interface, ["name", "ip", "cidr", "gateway", "rx_bps", "tx_bps"], "interface");
  const internet = body.internet as Record<string, unknown> | undefined;
  onlyKnownIn(internet, ["state", "since_ms", "gateway_ok", "latency_ms", "loss_percent", "probes", "last_outage", "outages_24h", "downtime_24h_s"], "internet");
  if (internet && typeof internet === "object") {
    onlyKnownEach(internet.probes, ["target", "kind", "ok", "latency_ms"], "probe");
    onlyKnownIn(internet.last_outage, ["started_ms", "ended_ms", "duration_s"], "last_outage");
  }
  onlyKnownEach(body.devices, ["id", "ip", "mac", "randomized_mac", "vendor", "hostname", "kind", "os", "online", "first_seen_ms", "last_seen_ms", "latency_ms", "ports", "services"], "device");
  if (Array.isArray(body.devices)) for (const device of body.devices) if (device && typeof device === "object") onlyKnownEach((device as Record<string, unknown>).ports, ["port", "proto", "service", "banner"], "port");
  onlyKnownEach(body.events, ["id", "kind", "at_ms", "device_id", "port", "outage_s", "detail"], "event");
  onlyKnownIn(body.scan, ["last_ms", "hosts", "duration_ms"], "scan");
  const publicInfo = body.public as Record<string, unknown> | undefined;
  onlyKnownIn(publicInfo, ["ip", "hostname", "city", "region", "country", "org", "timezone", "checked_ms", "changed_ms", "dns"], "public");
  if (publicInfo && typeof publicInfo === "object") onlyKnownIn(publicInfo.dns, ["name", "addresses", "matches"], "public.dns");
  onlyKnownEach(body.results, ["id", "type", "ok", "finished_ms", "device_id", "output", "ports", "latency_ms"], "result");
  if (Array.isArray(body.results)) for (const result of body.results) if (result && typeof result === "object") onlyKnownEach((result as Record<string, unknown>).ports, ["port", "proto", "service", "banner"], "port");
  checkAgainstContract("network", body);
  checkNetworkRules(body);
  return body as unknown as NetworkMessage;
}

/** armor/network/{node_id}/state as node_id, or undefined when the topic is not one. */
export function networkTopic(topic: string): string | undefined {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== "armor" || parts[1] !== "network" || parts[3] !== "state") return undefined;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[2]) ? parts[2] : undefined;
}

// ---- what an operator knows about a device -------------------------------------------------------------------------------------------------

export type DeviceNote = { name?: string; notes?: string; trusted?: boolean; kind?: DeviceKind; /** Left out of the list (still known to the node). */ hidden?: boolean; /** Tell me the next time it comes onto the network (once). */ watch?: boolean; updated_at: string };
export class NoteInvalid extends Error {}

/** The names, notes and "known" marks an operator gives devices, by device id, kept in a file. The nodes never see them. */
export class DeviceNotes {
  readonly #file: string | undefined;
  readonly #now: () => Date;
  readonly #notes = new Map<string, DeviceNote>();
  static readonly MAX = 2000;

  constructor(file?: string, now: () => Date = () => new Date()) {
    this.#file = file; this.#now = now;
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { notes?: Record<string, DeviceNote> };
      for (const [id, note] of Object.entries(raw.notes ?? {})) if (DEVICE_ID.test(id) && typeof note === "object" && note !== null) this.#notes.set(id, note);
    } catch { /* nothing kept yet */ }
  }

  get(id: string): DeviceNote | undefined { return this.#notes.get(id); }
  all(): Record<string, DeviceNote> { return Object.fromEntries(this.#notes); }
  isTrusted(id: string): boolean { return this.#notes.get(id)?.trusted === true; }
  isWatched(id: string): boolean { return this.#notes.get(id)?.watch === true; }
  /** A watched device came back: the watch is spent (it is asked for again when wanted). */
  spendWatch(id: string): void {
    const note = this.#notes.get(id);
    if (!note?.watch) return;
    delete note.watch; note.updated_at = this.#now().toISOString();
    this.#save();
  }

  /** Change what is kept about a device. Only the fields given change; an empty name or note removes it. Refuses what does not look like a note. */
  set(id: string, changes: unknown): DeviceNote {
    if (!DEVICE_ID.test(id)) throw new NoteInvalid("invalid device id");
    const input = record(changes, "the notes");
    onlyKnown(input, ["name", "notes", "trusted", "kind", "hidden", "watch"], "the notes");
    const next: DeviceNote = { ...(this.#notes.get(id) ?? { updated_at: "" }), updated_at: this.#now().toISOString() };
    if ("name" in input) { if (typeof input.name !== "string" || length(input.name) > 48) throw new NoteInvalid("the name is up to 48 characters"); if (input.name.trim()) next.name = input.name.trim(); else delete next.name; }
    if ("notes" in input) { if (typeof input.notes !== "string" || length(input.notes) > 300) throw new NoteInvalid("the notes are up to 300 characters"); if (input.notes.trim()) next.notes = input.notes.trim(); else delete next.notes; }
    if ("trusted" in input) { if (typeof input.trusted !== "boolean") throw new NoteInvalid("trusted is true or false"); if (input.trusted) next.trusted = true; else delete next.trusted; }
    for (const flag of ["hidden", "watch"] as const) {
      if (flag in input) { if (typeof input[flag] !== "boolean") throw new NoteInvalid(`${flag} is true or false`); if (input[flag]) next[flag] = true; else delete next[flag]; }
    }
    if ("kind" in input) { if (input.kind === "" || input.kind === null) delete next.kind; else if (typeof input.kind !== "string" || !(DEVICE_KINDS as readonly string[]).includes(input.kind)) throw new NoteInvalid("unknown kind of device"); else next.kind = input.kind as DeviceKind; }
    if (!this.#notes.has(id) && this.#notes.size >= DeviceNotes.MAX) throw new NoteInvalid("too many devices with notes");
    this.#notes.set(id, next);
    this.#save();
    return next;
  }

  remove(id: string): boolean { const done = this.#notes.delete(id); if (done) this.#save(); return done; }

  #save(): void {
    if (!this.#file) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, notes: Object.fromEntries(this.#notes) }), { encoding: "utf8", mode: 0o600 });
      durableRename(temporary, this.#file);
    } catch { /* losing the file only loses the names */ }
  }
}

// ---- the store ---------------------------------------------------------------------------------------------------------------------------------

export type NetworkOutage = { node_id: string; kind: "internet" | "gateway"; started_ms: number; ended_ms: number; duration_s: number };
export type NetworkSample = { t: number; state: InternetState; latency_ms?: number; loss_percent?: number; rx_bps?: number; tx_bps?: number };
export type NetworkEventView = NetworkEvent & { node_id: string };
export type NetworkNodeView = { node_id: string; state: NetworkMessage; received_at: string; stale: boolean };
export type NetworkTotals = { nodes: number; stale: number; devices: number; online: number; unknown: number; internet: InternetState | null };

export type NetworkStoreOptions = {
  now?: () => number;
  /** A node that has not reported for this long is stale (it reports every ten seconds or so). */
  staleAfterMs?: number;
  sampleEveryMs?: number;
  keepSamples?: number;
  maxNodes?: number;
  /** Where the outages are kept, so a restart of the server does not forget them. */
  outagesFile?: string;
  notes?: DeviceNotes;
  /** Every message, and every event that is new (an event is told once even though the nodes repeat it in every message). */
  onMessage?: (message: NetworkMessage) => void;
  onEvent?: (node: string, event: NetworkEvent) => void;
  onStale?: (node: string, stale: boolean) => void;
};
type Entry = { state: NetworkMessage; receivedAtMs: number; stale: boolean; samples: NetworkSample[]; lastSampleMs: number };

export class NetworkStore {
  readonly #entries = new Map<string, Entry>();
  readonly #seen = new Map<string, Set<string>>();         // per node, the ids of the events already told
  readonly #events: NetworkEventView[] = [];
  #outages: NetworkOutage[] = [];
  readonly #options: Required<Pick<NetworkStoreOptions, "now" | "staleAfterMs" | "sampleEveryMs" | "keepSamples" | "maxNodes">> & NetworkStoreOptions;

  constructor(options: NetworkStoreOptions = {}) {
    this.#options = { ...options, now: options.now ?? (() => Date.now()), staleAfterMs: options.staleAfterMs ?? 90_000, sampleEveryMs: options.sampleEveryMs ?? 30_000, keepSamples: options.keepSamples ?? 2880, maxNodes: options.maxNodes ?? 16 };
    if (options.outagesFile) {
      try { this.#outages = (JSON.parse(fs.readFileSync(options.outagesFile, "utf8")) as { outages?: NetworkOutage[] }).outages?.filter(o => whole(o?.started_ms, 0) && whole(o?.ended_ms, 0)).slice(-200) ?? []; } catch { /* none kept yet */ }
    }
  }

  get notes(): DeviceNotes | undefined { return this.#options.notes; }

  /** A device as the latest message of a node lists it (what an alarm about it should say). */
  device(node: string, id: string): NetworkDevice | undefined { return this.#entries.get(node)?.state.devices.find(device => device.id === id); }

  /** Keep a message and tell the events in it that were not told before. Refuses (throws) a new node when the store is full. */
  ingest(message: NetworkMessage): void {
    const now = this.#options.now();
    let entry = this.#entries.get(message.node_id);
    if (!entry) {
      if (this.#entries.size >= this.#options.maxNodes) throw new Error("too many network nodes");
      entry = { state: message, receivedAtMs: now, stale: false, samples: [], lastSampleMs: 0 };
      this.#entries.set(message.node_id, entry);
    }
    entry.state = message;
    const wasStale = refresh(entry, now);
    if (now - entry.lastSampleMs >= this.#options.sampleEveryMs) {
      const sample: NetworkSample = { t: now, state: message.internet.state };
      if (message.internet.latency_ms !== undefined) sample.latency_ms = message.internet.latency_ms;
      if (message.internet.loss_percent !== undefined) sample.loss_percent = message.internet.loss_percent;
      if (message.interface.rx_bps !== undefined) sample.rx_bps = message.interface.rx_bps;
      if (message.interface.tx_bps !== undefined) sample.tx_bps = message.interface.tx_bps;
      entry.samples.push(sample);
      if (entry.samples.length > this.#options.keepSamples) entry.samples.splice(0, entry.samples.length - this.#options.keepSamples);
      entry.lastSampleMs = now;
    }
    if (wasStale) this.#options.onStale?.(message.node_id, false);
    const seen = this.#seen.get(message.node_id) ?? new Set<string>();
    this.#seen.set(message.node_id, seen);
    const firstMessage = seen.size === 0;
    for (const event of message.events ?? []) {
      // An event is the same one when its id AND its time are: a node that restarts counts its ids again from e1, and those new events must not be taken for the old ones.
      const key = `${event.id}@${event.at_ms}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (firstMessage && !this.#recent(event, message.timestamp_ms)) continue;     // the backlog of a node the server has just met is history, not news
      this.#events.push({ ...event, node_id: message.node_id });
      if (this.#events.length > 300) this.#events.splice(0, this.#events.length - 300);
      if (event.kind === "internet_up" || event.kind === "gateway_up") this.#outage(message.node_id, event);
      this.#options.onEvent?.(message.node_id, event);
    }
    if (seen.size > 512) for (const id of [...seen].slice(0, seen.size - 256)) seen.delete(id);
    this.#options.onMessage?.(message);
  }

  #recent(event: NetworkEvent, nowMs: number): boolean { return nowMs - event.at_ms <= 120_000; }

  #outage(node: string, event: NetworkEvent): void {
    if (event.outage_s === undefined) return;
    this.#outages.push({ node_id: node, kind: event.kind === "internet_up" ? "internet" : "gateway", started_ms: event.at_ms - event.outage_s * 1000, ended_ms: event.at_ms, duration_s: event.outage_s });
    this.#outages = this.#outages.slice(-200);
    const file = this.#options.outagesFile;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, outages: this.#outages }), { encoding: "utf8", mode: 0o600 });
      durableRename(temporary, file);
    } catch { /* the totals of the next messages still say it */ }
  }

  remove(node: string): boolean { this.#seen.delete(node); return this.#entries.delete(node); }

  /** Mark the nodes that went quiet (and tell), called now and then. */
  sweep(): void {
    sweepStale(this.#entries.values(), this.#options.now(), this.#options.staleAfterMs, entry => this.#options.onStale?.(entry.state.node_id, true));
  }

  list(): NetworkNodeView[] {
    this.sweep();
    return [...this.#entries.values()].map(entry => ({ node_id: entry.state.node_id, state: entry.state, received_at: new Date(entry.receivedAtMs).toISOString(), stale: entry.stale }))
      .sort((a, b) => a.node_id.localeCompare(b.node_id));
  }

  totals(): NetworkTotals {
    this.sweep();
    let stale = 0, devices = 0, online = 0, unknown = 0;
    let internet: InternetState | null = null;
    const order: InternetState[] = ["lan_down", "down", "degraded", "unknown", "up"];
    for (const entry of this.#entries.values()) {
      if (entry.stale) { stale += 1; continue; }
      for (const device of entry.state.devices) {
        devices += 1;
        if (device.online) online += 1;
        if (!this.#options.notes?.isTrusted(device.id)) unknown += 1;
      }
      if (internet === null || order.indexOf(entry.state.internet.state) < order.indexOf(internet)) internet = entry.state.internet.state;
    }
    return { nodes: this.#entries.size, stale, devices, online, unknown, internet };
  }

  events(limit = 100): NetworkEventView[] { return this.#events.slice(-limit).reverse(); }
  outages(): NetworkOutage[] { return [...this.#outages].reverse(); }

  history(node: string, minutes: number): NetworkSample[] | undefined {
    const entry = this.#entries.get(node);
    if (!entry) return undefined;
    const since = this.#options.now() - minutes * 60_000;
    return entry.samples.filter(sample => sample.t >= since);
  }
}

// A list that misses a value of the generated type, or holds one it does not have, stops the build here.
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const listsMatchContract: [Exactly<DeviceKind, (typeof DEVICE_KINDS)[number]>, Exactly<InternetState, (typeof INTERNET_STATES)[number]>, Exactly<NetworkEventKind, (typeof EVENT_KINDS)[number]>, Exactly<CommandType, (typeof COMMAND_TYPES)[number]>] = [true, true, true, true];
void listsMatchContract;
