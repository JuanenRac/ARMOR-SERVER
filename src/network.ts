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
import { finite, integer, onlyKnown, readNodeId, readTimestamp, record } from "./contracts.js";

export const DEVICE_KINDS = ["router", "computer", "phone", "tv", "printer", "camera", "iot", "server", "nas", "network", "unknown"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const INTERNET_STATES = ["up", "degraded", "down", "lan_down", "unknown"] as const;
export type InternetState = (typeof INTERNET_STATES)[number];
export const EVENT_KINDS = ["new_device", "device_online", "device_offline", "ip_changed", "arp_conflict", "port_opened", "port_closed", "internet_down", "internet_up", "gateway_down", "gateway_up"] as const;
export type NetworkEventKind = (typeof EVENT_KINDS)[number];
const INTERNET_EVENTS: readonly string[] = ["internet_down", "internet_up", "gateway_down", "gateway_up"];

export type NetworkProbe = { target: string; kind: "icmp" | "tcp" | "dns" | "http"; ok: boolean; latency_ms?: number };
export type NetworkPort = { port: number; proto: "tcp" | "udp"; service?: string; banner?: string };
export type NetworkDevice = {
  id: string; ip: string; mac?: string; randomized_mac?: boolean; vendor?: string; hostname?: string; kind?: DeviceKind; os?: string; online: boolean;
  first_seen_ms: number; last_seen_ms: number; latency_ms?: number; ports?: NetworkPort[]; services?: string[];
};
export type NetworkEvent = { id: string; kind: NetworkEventKind; at_ms: number; device_id?: string; port?: number; outage_s?: number; detail?: string };
export type NetworkInternet = {
  state: InternetState; since_ms?: number; gateway_ok?: boolean; latency_ms?: number; loss_percent?: number; probes?: NetworkProbe[];
  last_outage?: { started_ms: number; ended_ms: number; duration_s: number }; outages_24h?: number; downtime_24h_s?: number;
};
export type NetworkMessage = {
  kind: "network"; node_id: string; timestamp_ms: number;
  interface: { name: string; ip: string; cidr: string; gateway?: string; rx_bps?: number; tx_bps?: number };
  internet: NetworkInternet; devices: NetworkDevice[]; events?: NetworkEvent[]; scan?: { last_ms: number; hosts: number; duration_ms?: number };
};

const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const IPV4 = new RegExp(`^(?:${OCTET}\\.){3}${OCTET}$`);
const CIDR = new RegExp(`^(?:${OCTET}\\.){3}${OCTET}/(?:3[0-2]|[12]?[0-9])$`);
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const DEVICE_ID = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const EVENT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MAX_DEVICES = 512;
export const MAX_EVENTS = 64;

const length = (value: string): number => Array.from(value).length;
const text = (value: unknown, min: number, max: number): value is string => typeof value === "string" && length(value) >= min && length(value) <= max;
const bounded = (value: unknown, low: number, high: number): value is number => finite(value) && value >= low && value <= high;
const whole = (value: unknown, low: number, high = Number.MAX_SAFE_INTEGER): value is number => integer(value) && value >= low && value <= high;

function parseInterface(value: unknown): NetworkMessage["interface"] {
  const item = record(value, "interface");
  onlyKnown(item, ["name", "ip", "cidr", "gateway", "rx_bps", "tx_bps"], "interface");
  for (const key of ["name", "ip", "cidr"]) if (!(key in item)) throw new Error(`the interface is missing ${key}`);
  if (!text(item.name, 1, 64)) throw new Error("invalid interface.name");
  if (typeof item.ip !== "string" || !IPV4.test(item.ip)) throw new Error("invalid interface.ip");
  if (typeof item.cidr !== "string" || !CIDR.test(item.cidr)) throw new Error("invalid interface.cidr");
  if ("gateway" in item && (typeof item.gateway !== "string" || !IPV4.test(item.gateway))) throw new Error("invalid interface.gateway");
  for (const key of ["rx_bps", "tx_bps"]) if (key in item && !whole(item[key], 0)) throw new Error(`invalid interface.${key}`);
  return item as unknown as NetworkMessage["interface"];
}

function parseInternet(value: unknown): NetworkInternet {
  const item = record(value, "internet");
  onlyKnown(item, ["state", "since_ms", "gateway_ok", "latency_ms", "loss_percent", "probes", "last_outage", "outages_24h", "downtime_24h_s"], "internet");
  if (!("state" in item)) throw new Error("the internet block is missing state");
  if (typeof item.state !== "string" || !(INTERNET_STATES as readonly string[]).includes(item.state)) throw new Error("invalid internet.state");
  if ("since_ms" in item && !whole(item.since_ms, 0)) throw new Error("invalid internet.since_ms");
  if ("gateway_ok" in item && typeof item.gateway_ok !== "boolean") throw new Error("invalid internet.gateway_ok");
  if ("latency_ms" in item && !bounded(item.latency_ms, 0, 60_000)) throw new Error("invalid internet.latency_ms");
  if ("loss_percent" in item && !bounded(item.loss_percent, 0, 100)) throw new Error("invalid internet.loss_percent");
  if ("outages_24h" in item && !whole(item.outages_24h, 0)) throw new Error("invalid internet.outages_24h");
  if ("downtime_24h_s" in item && !whole(item.downtime_24h_s, 0, 86_400)) throw new Error("invalid internet.downtime_24h_s");
  if ("probes" in item) {
    if (!Array.isArray(item.probes) || item.probes.length > 8) throw new Error("invalid internet.probes");
    item.probes.forEach((raw, index) => {
      const probe = record(raw, `probe ${index}`);
      onlyKnown(probe, ["target", "kind", "ok", "latency_ms"], `probe ${index}`);
      for (const key of ["target", "kind", "ok"]) if (!(key in probe)) throw new Error(`probe ${index} is missing ${key}`);
      if (!text(probe.target, 1, 64)) throw new Error(`invalid probe ${index}.target`);
      if (typeof probe.kind !== "string" || !["icmp", "tcp", "dns", "http"].includes(probe.kind)) throw new Error(`invalid probe ${index}.kind`);
      if (typeof probe.ok !== "boolean") throw new Error(`invalid probe ${index}.ok`);
      if ("latency_ms" in probe && !bounded(probe.latency_ms, 0, 60_000)) throw new Error(`invalid probe ${index}.latency_ms`);
    });
  }
  if ("last_outage" in item) {
    const outage = record(item.last_outage, "last_outage");
    onlyKnown(outage, ["started_ms", "ended_ms", "duration_s"], "last_outage");
    for (const key of ["started_ms", "ended_ms", "duration_s"]) if (!(key in outage) || !whole(outage[key], 0)) throw new Error(`invalid last_outage.${key}`);
  }
  return item as unknown as NetworkInternet;
}

function parsePort(raw: unknown, device: number, index: number): NetworkPort {
  const port = record(raw, `port ${index} of device ${device}`);
  onlyKnown(port, ["port", "proto", "service", "banner"], `port ${index}`);
  if (!whole(port.port, 1, 65_535)) throw new Error(`invalid port ${index} of device ${device}`);
  if (port.proto !== "tcp" && port.proto !== "udp") throw new Error(`invalid proto of port ${index} of device ${device}`);
  if ("service" in port && !text(port.service, 1, 32)) throw new Error(`invalid service of port ${index} of device ${device}`);
  if ("banner" in port && !text(port.banner, 1, 80)) throw new Error(`invalid banner of port ${index} of device ${device}`);
  return port as unknown as NetworkPort;
}

function parseDevice(raw: unknown, index: number): NetworkDevice {
  const device = record(raw, `device ${index}`);
  onlyKnown(device, ["id", "ip", "mac", "randomized_mac", "vendor", "hostname", "kind", "os", "online", "first_seen_ms", "last_seen_ms", "latency_ms", "ports", "services"], `device ${index}`);
  for (const key of ["id", "ip", "online", "first_seen_ms", "last_seen_ms"]) if (!(key in device)) throw new Error(`device ${index} is missing ${key}`);
  if (typeof device.id !== "string" || !DEVICE_ID.test(device.id)) throw new Error(`invalid device ${index}.id`);
  if (typeof device.ip !== "string" || !IPV4.test(device.ip)) throw new Error(`invalid device ${index}.ip`);
  if ("mac" in device && (typeof device.mac !== "string" || !MAC.test(device.mac))) throw new Error(`invalid device ${index}.mac`);
  if ("randomized_mac" in device && typeof device.randomized_mac !== "boolean") throw new Error(`invalid device ${index}.randomized_mac`);
  if ("vendor" in device && !text(device.vendor, 1, 64)) throw new Error(`invalid device ${index}.vendor`);
  if ("hostname" in device && !text(device.hostname, 1, 64)) throw new Error(`invalid device ${index}.hostname`);
  if ("os" in device && !text(device.os, 1, 32)) throw new Error(`invalid device ${index}.os`);
  if ("kind" in device && (typeof device.kind !== "string" || !(DEVICE_KINDS as readonly string[]).includes(device.kind))) throw new Error(`invalid device ${index}.kind`);
  if (typeof device.online !== "boolean") throw new Error(`invalid device ${index}.online`);
  if (!whole(device.first_seen_ms, 0) || !whole(device.last_seen_ms, 0)) throw new Error(`invalid time of device ${index}`);
  if ("latency_ms" in device && !bounded(device.latency_ms, 0, 60_000)) throw new Error(`invalid device ${index}.latency_ms`);
  if ("ports" in device) {
    if (!Array.isArray(device.ports) || device.ports.length > 64) throw new Error(`invalid ports of device ${index}`);
    device.ports.forEach((port, at) => parsePort(port, index, at));
  }
  if ("services" in device) {
    if (!Array.isArray(device.services) || device.services.length > 16 || !device.services.every(service => text(service, 1, 48))) throw new Error(`invalid services of device ${index}`);
  }
  // the rules that join fields: a device with a MAC has it as its id (or is still known by its address), and it was not first seen after it was last seen
  if (typeof device.mac === "string" && device.id !== device.mac && !device.id.startsWith("ip-")) throw new Error(`device ${index} has a MAC that is not its id`);
  if ((device.first_seen_ms as number) > (device.last_seen_ms as number)) throw new Error(`device ${index} was first seen after it was last seen`);
  return device as unknown as NetworkDevice;
}

function parseEvent(raw: unknown, index: number): NetworkEvent {
  const event = record(raw, `event ${index}`);
  onlyKnown(event, ["id", "kind", "at_ms", "device_id", "port", "outage_s", "detail"], `event ${index}`);
  for (const key of ["id", "kind", "at_ms"]) if (!(key in event)) throw new Error(`event ${index} is missing ${key}`);
  if (typeof event.id !== "string" || !EVENT_ID.test(event.id)) throw new Error(`invalid event ${index}.id`);
  if (typeof event.kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(event.kind)) throw new Error(`invalid event ${index}.kind`);
  if (!whole(event.at_ms, 0)) throw new Error(`invalid event ${index}.at_ms`);
  if ("device_id" in event && (typeof event.device_id !== "string" || !DEVICE_ID.test(event.device_id))) throw new Error(`invalid event ${index}.device_id`);
  if ("port" in event && !whole(event.port, 1, 65_535)) throw new Error(`invalid event ${index}.port`);
  if ("outage_s" in event && !whole(event.outage_s, 0)) throw new Error(`invalid event ${index}.outage_s`);
  if ("detail" in event && !text(event.detail, 1, 120)) throw new Error(`invalid event ${index}.detail`);
  const internet = INTERNET_EVENTS.includes(event.kind);
  if (internet && ("device_id" in event || "port" in event)) throw new Error(`event ${index} is about the internet, not a device or a port`);
  if (!internet && !("device_id" in event)) throw new Error(`event ${index} is about a device and names none`);
  if ("outage_s" in event && event.kind !== "internet_up" && event.kind !== "gateway_up") throw new Error(`event ${index} says how long it was down but is not an end`);
  if ((event.kind === "port_opened" || event.kind === "port_closed") && !("port" in event)) throw new Error(`event ${index} is about a port and names none`);
  return event as unknown as NetworkEvent;
}

export function parseNetworkMessage(value: unknown): NetworkMessage {
  const body = record(value, "network message");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "interface", "internet", "devices", "events", "scan"], "network message");
  for (const key of ["kind", "node_id", "timestamp_ms", "interface", "internet", "devices"]) if (!(key in body)) throw new Error(`the network message is missing ${key}`);
  if (body.kind !== "network") throw new Error("invalid kind");
  const node = readNodeId(body), timestamp = readTimestamp(body);
  const iface = parseInterface(body.interface), internet = parseInternet(body.internet);
  if (!Array.isArray(body.devices) || body.devices.length > MAX_DEVICES) throw new Error("invalid devices");
  const devices = body.devices.map(parseDevice);
  if (new Set(devices.map(device => device.id)).size !== devices.length) throw new Error("a device id must appear once");
  let events: NetworkEvent[] | undefined;
  if ("events" in body) {
    if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS) throw new Error("invalid events");
    events = body.events.map(parseEvent);
    if (new Set(events.map(event => event.id)).size !== events.length) throw new Error("an event id must appear once");
  }
  let scan: NetworkMessage["scan"];
  if ("scan" in body) {
    const item = record(body.scan, "scan");
    onlyKnown(item, ["last_ms", "hosts", "duration_ms"], "scan");
    if (!whole(item.last_ms, 0) || !whole(item.hosts, 0, 1024) || ("duration_ms" in item && !whole(item.duration_ms, 0))) throw new Error("invalid scan");
    scan = item as unknown as NetworkMessage["scan"];
  }
  return { kind: "network", node_id: node, timestamp_ms: timestamp, interface: iface, internet, devices, ...(events ? { events } : {}), ...(scan ? { scan } : {}) };
}

/** armor/network/{node_id}/state as node_id, or undefined when the topic is not one. */
export function networkTopic(topic: string): string | undefined {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== "armor" || parts[1] !== "network" || parts[3] !== "state") return undefined;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[2]) ? parts[2] : undefined;
}

// ---- what an operator knows about a device -------------------------------------------------------------------------------------------------

export type DeviceNote = { name?: string; notes?: string; trusted?: boolean; kind?: DeviceKind; updated_at: string };
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

  /** Change what is kept about a device. Only the fields given change; an empty name or note removes it. Refuses what does not look like a note. */
  set(id: string, changes: unknown): DeviceNote {
    if (!DEVICE_ID.test(id)) throw new NoteInvalid("invalid device id");
    const input = record(changes, "the notes");
    onlyKnown(input, ["name", "notes", "trusted", "kind"], "the notes");
    const next: DeviceNote = { ...(this.#notes.get(id) ?? { updated_at: "" }), updated_at: this.#now().toISOString() };
    if ("name" in input) { if (typeof input.name !== "string" || length(input.name) > 48) throw new NoteInvalid("the name is up to 48 characters"); if (input.name.trim()) next.name = input.name.trim(); else delete next.name; }
    if ("notes" in input) { if (typeof input.notes !== "string" || length(input.notes) > 300) throw new NoteInvalid("the notes are up to 300 characters"); if (input.notes.trim()) next.notes = input.notes.trim(); else delete next.notes; }
    if ("trusted" in input) { if (typeof input.trusted !== "boolean") throw new NoteInvalid("trusted is true or false"); if (input.trusted) next.trusted = true; else delete next.trusted; }
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
      fs.renameSync(temporary, this.#file);
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
    const wasStale = entry.stale;
    entry.state = message; entry.receivedAtMs = now; entry.stale = false;
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
      if (seen.has(event.id)) continue;
      seen.add(event.id);
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
      fs.renameSync(temporary, file);
    } catch { /* the totals of the next messages still say it */ }
  }

  remove(node: string): boolean { this.#seen.delete(node); return this.#entries.delete(node); }

  /** Mark the nodes that went quiet (and tell), called now and then. */
  sweep(): void {
    const now = this.#options.now();
    for (const entry of this.#entries.values()) {
      if (!entry.stale && now - entry.receivedAtMs > this.#options.staleAfterMs) {
        entry.stale = true;
        this.#options.onStale?.(entry.state.node_id, true);
      }
    }
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
