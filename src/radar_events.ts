/**
 * The events of the perimeter engine of a radar node (armor/radar/{node}/events, ARMOR-COMMON's radar_event): the strict reader of one message, the table of the topic, and the store that
 * keeps the newest events of each node and tells a repeated one from a new one. A node sends an event live and, if the broker could not be reached, again from its own memory when it is
 * back; `boot` (random at each start of the node) and `seq` (counting inside that start) name an event, so the same pair twice is kept once.
 * The words are a fixed list and the message has no free text: nothing secret is in it, and what is kept is only what the message says.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { integer, onlyKnown, readNodeId, readTimestamp, record } from "./contracts.js";

export const RADAR_EVENT_KINDS = [
  "zone_occupied", "zone_clear", "loiter", "tripwire", "path_violation", "masking", "masking_end", "sensor_bluetooth_open", "sensor_bluetooth_closed", "wifi_jam", "wifi_jam_end", "bridge_opened", "bridge_closed",
] as const;
export type RadarEventKind = (typeof RADAR_EVENT_KINDS)[number];
const MOVEMENTS = ["still", "walking", "running"] as const;
const DIRECTIONS = ["in", "out"] as const;
const BY = /^[A-Za-z0-9._-]{1,32}$/;

export type RadarEvent = {
  kind: "radar_event"; node_id: string; timestamp_ms: number; boot: number; seq: number; event: RadarEventKind; name?: string; sensor_id?: number; track_id?: number; movement?: (typeof MOVEMENTS)[number];
  value?: number; count?: number; direction?: (typeof DIRECTIONS)[number]; from?: string; by?: string;
};

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
const chars = (text: string): number => Array.from(text).length;

/** An event as the contract has it, with the rules that join its fields (a direction only on a tripwire, the zone it came from only on a path violation, the administrator only on the bridge ...). */
export function parseRadarEvent(value: unknown): RadarEvent {
  const body = record(value, "radar event");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "boot", "seq", "event", "name", "sensor_id", "track_id", "movement", "value", "count", "direction", "from", "by"], "radar event");
  if (body.kind !== "radar_event") throw new Error("invalid kind");
  const node = readNodeId(body), timestamp = readTimestamp(body);
  if (!integer(body.boot) || body.boot < 0 || body.boot > 4_294_967_295) throw new Error("invalid boot");
  if (!integer(body.seq) || body.seq < 1 || body.seq > 4_294_967_295) throw new Error("invalid seq");
  if (!oneOf(RADAR_EVENT_KINDS, body.event)) throw new Error("invalid event");
  for (const key of ["name", "from"] as const) if (key in body && (typeof body[key] !== "string" || chars(body[key] as string) < 1 || chars(body[key] as string) > 24)) throw new Error(`invalid ${key}`);
  if ("sensor_id" in body && (!integer(body.sensor_id) || body.sensor_id < 1 || body.sensor_id > 3)) throw new Error("invalid sensor_id");
  if ("track_id" in body && (!integer(body.track_id) || body.track_id < 1 || body.track_id > 255)) throw new Error("invalid track_id");
  if ("movement" in body && !oneOf(MOVEMENTS, body.movement)) throw new Error("invalid movement");
  for (const key of ["value", "count"] as const) if (key in body && (!integer(body[key]) || (body[key] as number) < 0)) throw new Error(`invalid ${key}`);
  if ("direction" in body && !oneOf(DIRECTIONS, body.direction)) throw new Error("invalid direction");
  if ("by" in body && (typeof body.by !== "string" || !BY.test(body.by))) throw new Error("invalid by");
  if ("direction" in body && body.event !== "tripwire") throw new Error("a direction goes with a tripwire");
  if ("from" in body && body.event !== "path_violation") throw new Error("the zone it came from goes with a path violation");
  if ("by" in body && body.event !== "bridge_opened" && body.event !== "bridge_closed") throw new Error("an administrator goes with the serial bridge");
  if (["sensor_bluetooth_open", "sensor_bluetooth_closed", "bridge_opened", "bridge_closed"].includes(body.event) && !("sensor_id" in body)) throw new Error("this event is about one sensor");
  if (["wifi_jam", "wifi_jam_end", "masking_end"].includes(body.event) && ("track_id" in body || "movement" in body || "direction" in body)) throw new Error("this event is not about a target");
  return { ...(body as unknown as RadarEvent), node_id: node, timestamp_ms: timestamp };
}

/** armor/radar/{node_id}/events as the node id, or undefined when the topic is not one. */
export function radarEventTopic(topic: string): string | undefined {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== "armor" || parts[1] !== "radar" || parts[3] !== "events") return undefined;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[2]) ? parts[2] : undefined;
}

/** What a console is shown of an event: the message and the moment the server got it. */
export type StoredRadarEvent = RadarEvent & { received_at: string };

export type RadarEventStoreOptions = {
  now?: () => number;
  /** How many events are kept for each node (default 200) and how many nodes (default 64). */
  perNode?: number;
  maxNodes?: number;
  /** Called once for each event that is new (not a repeat of one already seen). */
  onNew?: (event: RadarEvent) => void;
};

export class RadarEventStore {
  readonly #events = new Map<string, StoredRadarEvent[]>();
  readonly #seen = new Map<string, Set<string>>();
  readonly #order = new Map<string, string[]>();
  readonly #now: () => number;
  readonly #perNode: number;
  readonly #maxNodes: number;
  readonly #onNew?: (event: RadarEvent) => void;

  constructor(options: RadarEventStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#perNode = options.perNode ?? 200;
    this.#maxNodes = options.maxNodes ?? 64;
    this.#onNew = options.onNew;
  }

  /** Keeps an event. False for a repeat (the same boot and sequence number from the same node), and the store refuses (throws) a new node when it is full so a broker full of noise cannot grow it. */
  ingest(event: RadarEvent): boolean {
    if (!this.#events.has(event.node_id) && this.#events.size >= this.#maxNodes) throw new Error("too many nodes");
    const key = `${event.boot}:${event.seq}`;
    let seen = this.#seen.get(event.node_id);
    if (!seen) { seen = new Set(); this.#seen.set(event.node_id, seen); this.#order.set(event.node_id, []); }
    if (seen.has(key)) return false;
    seen.add(key);
    const order = this.#order.get(event.node_id) as string[];
    order.push(key);
    // The memory of what was seen is a little bigger than what is shown, so a repeat of a recent event is still known.
    while (order.length > this.#perNode * 3) seen.delete(order.shift() as string);
    const list = this.#events.get(event.node_id) ?? [];
    list.push({ ...event, received_at: new Date(this.#now()).toISOString() });
    if (list.length > this.#perNode) list.splice(0, list.length - this.#perNode);
    this.#events.set(event.node_id, list);
    try { this.#onNew?.(event); } catch { /* what the server does about an event never stops the store */ }
    return true;
  }

  /** The newest events first: of one node, or of all. */
  list(node?: string, limit = 100): StoredRadarEvent[] {
    const all = node !== undefined ? [...(this.#events.get(node) ?? [])] : [...this.#events.values()].flat();
    return all.sort((a, b) => b.received_at.localeCompare(a.received_at) || b.seq - a.seq).slice(0, Math.max(1, Math.min(limit, 500)));
  }

  nodes(): string[] { return [...this.#events.keys()].sort(); }

  remove(node: string): void {
    this.#events.delete(node);
    this.#seen.delete(node);
    this.#order.delete(node);
  }
}
