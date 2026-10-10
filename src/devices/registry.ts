/**
 * The device registry: every sensor and actuator A.R.M.O.R. supervises besides the radars and the cameras. It keeps what each one is
 * (kind, radio, where it reports, how to command it) and the last state it reported, tells the rest of the server when a state changes,
 * and marks devices that go silent. Persisted in the data directory; a device's own state is written a moment after it changes.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { cleanState, defaultRisk, isKind, isProtocol, isRisk, isTriggered, kindInfo, type DeviceKind, type DeviceState, type Protocol, type Risk } from "./catalog.js";
import { cleanMap, parsePayload, stateFromPayload, type MapEntry } from "./mapping.js";

export type DeviceSource =
  | { type: "push" }
  | { type: "mqtt"; topic: string; map?: MapEntry[]; /** A topic that says "online" / "offline" (Zigbee2MQTT, Tasmota, ESPHome). */ availability_topic?: string };
export type DeviceCommands = {
  mqtt?: { topic: string; on?: string; off?: string; toggle?: string; /** Set the state as soon as the command is sent, for devices that never report back. */ assume_state?: boolean };
  http?: { on?: string; off?: string; toggle?: string };
};
export type Device = {
  id: string; name: string; kind: DeviceKind; protocol: Protocol;
  /** A room or zone, free text ("Kitchen", "Garage door"). */
  location: string;
  source: DeviceSource; commands: DeviceCommands;
  /** Seconds without a report after which the device counts as offline; 0 = never check. */
  expected_interval_s: number;
  /** How much it matters to switch it from afar (see `Risk`); what asks for a confirmation. */
  risk: Risk;
  state: DeviceState; online: boolean; last_seen: string | null; created_at: string;
};
export type DeviceInput = Partial<Pick<Device, "name" | "kind" | "protocol" | "location" | "source" | "commands" | "expected_interval_s" | "risk">>;

export const DEVICE_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
export const MAX_DEVICES = 300;
export class DeviceError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

/** What changed when a report arrived: the fields that differ, and whether the device became triggered or came back. */
export type DeviceChange = {
  device: Device;
  changes: Array<{ field: string; from: boolean | number | null; to: boolean | number }>;
  /** True the moment the device goes from normal to triggered (its kind's trigger field), false when it goes back, undefined when unchanged. */
  triggered?: boolean;
  onlineChanged: boolean;
};

const TOPIC = /^[A-Za-z0-9_\-./+#$ ]{1,200}$/;
const validTopic = (topic: unknown, allowWildcards = false): topic is string =>
  typeof topic === "string" && TOPIC.test(topic) && !topic.startsWith("$") && (allowWildcards || !/[+#]/.test(topic)) && !topic.includes("//");
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");
const payloadWord = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined);

export type RegistryOptions = { file: string; now?: () => Date; warn?: (message: string) => void; onChange?: (change: DeviceChange) => void; onTopics?: () => void };

export class DeviceRegistry {
  readonly #options: RegistryOptions;
  readonly #now: () => Date;
  #devices = new Map<string, Device>();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: RegistryOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#load();
  }

  #load(): void {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.#options.file, "utf8")); } catch { return; }
    const list = (raw as { devices?: unknown } | null)?.devices;
    if (!Array.isArray(list)) return;
    for (const item of list.slice(0, MAX_DEVICES)) {
      try {
        const input = item as Partial<Device>;
        if (typeof input.id !== "string" || !DEVICE_ID.test(input.id)) continue;
        const device = this.#build(input.id, input, input.created_at);
        device.state = cleanState(input.state);
        device.last_seen = typeof input.last_seen === "string" ? input.last_seen : null;
        device.online = input.online === true;
        this.#devices.set(device.id, device);
      } catch { /* A damaged entry is skipped, never the whole file. */ }
    }
  }

  #save(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; this.flush(); }, 750);
    this.#timer.unref();
  }

  flush(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    try {
      fs.mkdirSync(path.dirname(this.#options.file), { recursive: true });
      const temporary = `${this.#options.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schema: 1, devices: [...this.#devices.values()] }, null, 1), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, this.#options.file);
    } catch (error) { this.#options.warn?.(`the devices file could not be written: ${(error as Error).message}`); }
  }

  /** Check a device's description and fill in what is missing. Throws a DeviceError that says what is wrong. */
  #build(id: string, input: DeviceInput & Partial<Pick<Device, "id">>, createdAt?: string): Device {
    if (!isKind(input.kind)) throw new DeviceError("invalid_kind", "unknown kind of device");
    const kind = input.kind;
    const name = text(input.name, 80);
    if (!name) throw new DeviceError("invalid_name", "a device needs a name");
    const protocol: Protocol = isProtocol(input.protocol) ? input.protocol : "other";
    const src = (input.source ?? { type: "push" }) as Record<string, unknown>;
    let source: DeviceSource;
    if (src.type === "mqtt") {
      if (!validTopic(src.topic)) throw new DeviceError("invalid_topic", "the state topic is not a valid MQTT topic");
      if (src.availability_topic !== undefined && src.availability_topic !== "" && !validTopic(src.availability_topic)) throw new DeviceError("invalid_topic", "the availability topic is not a valid MQTT topic");
      const map = cleanMap(src.map);
      source = { type: "mqtt", topic: src.topic, ...(map && map.length ? { map } : {}), ...(src.availability_topic ? { availability_topic: src.availability_topic as string } : {}) };
    } else source = { type: "push" };
    const commands: DeviceCommands = {};
    const c = (input.commands ?? {}) as { mqtt?: Record<string, unknown>; http?: Record<string, unknown> };
    if (c.mqtt && c.mqtt.topic !== undefined && c.mqtt.topic !== "") {
      if (!validTopic(c.mqtt.topic)) throw new DeviceError("invalid_topic", "the command topic is not a valid MQTT topic");
      commands.mqtt = { topic: c.mqtt.topic, ...(payloadWord(c.mqtt.on) ? { on: payloadWord(c.mqtt.on) } : {}), ...(payloadWord(c.mqtt.off) ? { off: payloadWord(c.mqtt.off) } : {}), ...(payloadWord(c.mqtt.toggle) ? { toggle: payloadWord(c.mqtt.toggle) } : {}), ...(c.mqtt.assume_state === true ? { assume_state: true } : {}) };
    }
    if (c.http) {
      const http: NonNullable<DeviceCommands["http"]> = {};
      for (const key of ["on", "off", "toggle"] as const) {
        const url = c.http[key];
        if (url === undefined || url === "") continue;
        if (typeof url !== "string" || !isLanUrl(url)) throw new DeviceError("invalid_url", "a device command URL must be http or https on the local network");
        http[key] = url;
      }
      if (Object.keys(http).length) commands.http = http;
    }
    if (kindInfo(kind).category === "sensor" && (commands.mqtt || commands.http)) { delete commands.mqtt; delete commands.http; }
    const interval = typeof input.expected_interval_s === "number" && Number.isFinite(input.expected_interval_s) ? Math.min(7 * 86400, Math.max(0, Math.round(input.expected_interval_s))) : 0;
    return { id, name, kind, protocol, location: text(input.location, 80), source, commands, expected_interval_s: interval, risk: isRisk(input.risk) ? input.risk : defaultRisk(kind), state: {}, online: false, last_seen: null, created_at: createdAt ?? this.#now().toISOString() };
  }

  list(): Device[] { return [...this.#devices.values()]; }
  get(id: string): Device | undefined { return this.#devices.get(id); }

  create(input: DeviceInput & { id?: string }): Device {
    if (this.#devices.size >= MAX_DEVICES) throw new DeviceError("too_many_devices", `at most ${MAX_DEVICES} devices`, 409);
    const id = input.id ?? this.#freshId(input);
    if (!DEVICE_ID.test(id)) throw new DeviceError("invalid_id", "a device id has 2 to 64 lowercase letters, digits, - or _");
    if (this.#devices.has(id)) throw new DeviceError("id_taken", "that device id is already in use", 409);
    const device = this.#build(id, input);
    this.#devices.set(id, device);
    this.#save(); this.#options.onTopics?.();
    return device;
  }

  #freshId(input: DeviceInput): string {
    const base = (text(input.name, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || String(input.kind ?? "device")).slice(0, 40);
    for (let index = 1; index < 1000; index += 1) { const id = index === 1 ? base : `${base}-${index}`; if (DEVICE_ID.test(id) && !this.#devices.has(id)) return id; }
    return `device-${Date.now()}`;
  }

  update(id: string, input: DeviceInput): Device {
    const current = this.#devices.get(id);
    if (!current) throw new DeviceError("not_found", "no such device", 404);
    const merged = this.#build(id, { ...current, ...input }, current.created_at);
    // A change of kind resets the state (the old fields no longer make sense); anything else keeps it.
    if (merged.kind === current.kind) { merged.state = current.state; merged.online = current.online; merged.last_seen = current.last_seen; }
    this.#devices.set(id, merged);
    this.#save(); this.#options.onTopics?.();
    return merged;
  }

  remove(id: string): void {
    if (!this.#devices.delete(id)) throw new DeviceError("not_found", "no such device", 404);
    this.#save(); this.#options.onTopics?.();
  }

  /** Every MQTT topic the registry wants to hear, to subscribe to. */
  topics(): string[] {
    const topics = new Set<string>();
    for (const device of this.#devices.values()) {
      if (device.source.type === "mqtt") { topics.add(device.source.topic); if (device.source.availability_topic) topics.add(device.source.availability_topic); }
    }
    return [...topics];
  }

  /** A report from a device: merge it into the state and say what changed. Unknown fields and values are dropped. */
  applyState(id: string, report: unknown): DeviceChange | undefined {
    const device = this.#devices.get(id);
    if (!device) return undefined;
    const fields = cleanState(report);
    const before = { ...device.state }, wasTriggered = isTriggered(device.kind, before), wasOnline = device.online;
    const changes: DeviceChange["changes"] = [];
    for (const [field, value] of Object.entries(fields)) {
      if (before[field] !== value) changes.push({ field, from: before[field] ?? null, to: value });
      device.state[field] = value;
    }
    device.online = true;
    device.last_seen = this.#now().toISOString();
    const nowTriggered = isTriggered(device.kind, device.state);
    const change: DeviceChange = { device, changes, onlineChanged: !wasOnline, ...(nowTriggered !== wasTriggered ? { triggered: nowTriggered } : {}) };
    this.#save();
    this.#options.onChange?.(change);
    return change;
  }

  /** Whatever an MQTT device published: match its topic, translate its payload, apply it. */
  ingestMqtt(topic: string, raw: Buffer | string): DeviceChange[] {
    const payload = parsePayload(raw);
    if (payload === undefined) return [];
    const out: DeviceChange[] = [];
    for (const device of this.#devices.values()) {
      if (device.source.type !== "mqtt") continue;
      if (device.source.availability_topic === topic) {
        const word = typeof payload === "string" ? payload : typeof payload === "object" && payload !== null ? String((payload as Record<string, unknown>).state ?? "") : "";
        const online = /^(online|true|1|on)$/i.test(word.trim());
        const change = this.setOnline(device.id, online);
        if (change) out.push(change);
      }
      if (device.source.topic === topic) {
        const state = stateFromPayload(payload, device.source.map ?? defaultMap(device.kind, payload));
        if (Object.keys(state).length > 0) { const change = this.applyState(device.id, state); if (change) out.push(change); }
      }
    }
    return out;
  }

  setOnline(id: string, online: boolean): DeviceChange | undefined {
    const device = this.#devices.get(id);
    if (!device || device.online === online) return undefined;
    device.online = online;
    if (online) device.last_seen = this.#now().toISOString();
    const change: DeviceChange = { device, changes: [], onlineChanged: true };
    this.#save();
    this.#options.onChange?.(change);
    return change;
  }

  /** Mark devices that have not reported within their expected interval as offline. Call it on a timer. */
  sweep(): DeviceChange[] {
    const now = this.#now().getTime(), out: DeviceChange[] = [];
    for (const device of this.#devices.values()) {
      if (device.expected_interval_s <= 0 || !device.online || !device.last_seen) continue;
      if (now - Date.parse(device.last_seen) > device.expected_interval_s * 1000) { const change = this.setOnline(device.id, false); if (change) out.push(change); }
    }
    return out;
  }
}

/** A device that publishes a bare word ("ON", "open", "1") is read as its kind's main field. */
function defaultMap(kind: DeviceKind, payload: unknown): MapEntry[] | undefined {
  if (typeof payload === "object" && payload !== null) return undefined;
  const trigger = kindInfo(kind).trigger;
  if (trigger) return [{ field: trigger.field, path: "$" }];
  if (kindInfo(kind).category === "actuator") return [{ field: kind === "lock" ? "locked" : kind === "valve" ? "open" : "on", path: "$" }];
  return undefined;
}

/** A command URL must be http(s) to a machine on the local network: never the internet, never a metadata address. */
export function isLanUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 169 && b === 254) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
