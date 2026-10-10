/**
 * What the ARMOR-ALARM nodes say about the house's alarm (armor/alarm/{node_id}/state): the strict parser of the message, and the store that keeps the latest state of
 * every node. The parsers implement ARMOR-COMMON's alarm schemas exactly (tests/alarm.test.ts runs the shared vectors), and so do the parsers of a command to the panel and
 * of the node's answer. Nothing in this file sends anything: the command path is alarm_commands.ts, and it is off unless the operator turned it on.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { onlyKnown, readNodeId, readTimestamp, record, integer } from "./contracts.js";

export const PHASES = ["disarmed", "exit_delay", "armed", "entry_delay", "alarm"] as const;
export type Phase = (typeof PHASES)[number];
export const MODES = ["disarmed", "away", "stay"] as const;
export type Mode = (typeof MODES)[number];
export const ZONE_KINDS = ["instant", "entry", "interior", "always"] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];
export const ZONE_STATES = ["normal", "triggered", "tamper"] as const;
export type ZoneState = (typeof ZONE_STATES)[number];
export const EVENT_KINDS = ["armed", "exit_delay_started", "entry_delay_started", "alarm", "siren_timed_out", "disarmed", "bad_pin", "locked_out", "zone_bypassed"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const ACTIONS = ["arm", "disarm"] as const;
export type AlarmAction = (typeof ACTIONS)[number];
export const REFUSALS = ["none", "not_disarmed", "zones_open", "not_armed", "bad_pin", "locked_out"] as const;
export type AlarmRefusal = (typeof REFUSALS)[number];

export type AlarmZone = { id: string; name?: string; kind: ZoneKind; state: ZoneState; bypassed: boolean };
export type AlarmEvent = { ago_s: number; kind: EventKind; zone?: string };
export type AlarmMessage = {
  kind: "alarm"; node_id: string; timestamp_ms: number; phase: Phase; mode: Mode; siren: boolean; locked_out: boolean; commands_enabled: boolean;
  zones: AlarmZone[]; open_zones: string[]; events: AlarmEvent[];
};
export type AlarmCommand = { kind: "alarm_command"; node_id: string; timestamp_ms: number; command_id: string; action: AlarmAction; mode?: "away" | "stay"; force?: boolean };
export type AlarmResult = { kind: "alarm_result"; node_id: string; timestamp_ms: number; command_id: string; action: AlarmAction; accepted: boolean; refusal: AlarmRefusal; phase: Phase };

const zoneId = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** A command id is sixteen lowercase hexadecimal digits. */
export const commandIdPattern = /^[0-9a-f]{16}$/;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

function parseZone(value: unknown, index: number): AlarmZone {
  const zone = record(value, `zone ${index}`);
  onlyKnown(zone, ["id", "name", "kind", "state", "bypassed"], `zone ${index}`);
  for (const key of ["id", "kind", "state", "bypassed"]) if (!(key in zone)) throw new Error(`zone ${index} is missing ${key}`);
  if (typeof zone.id !== "string" || !zoneId.test(zone.id)) throw new Error(`invalid zone ${index}.id`);
  if ("name" in zone && (typeof zone.name !== "string" || Array.from(zone.name).length < 1 || Array.from(zone.name).length > 160)) throw new Error(`invalid zone ${index}.name`);
  if (!oneOf(ZONE_KINDS, zone.kind)) throw new Error(`invalid zone ${index}.kind`);
  if (!oneOf(ZONE_STATES, zone.state)) throw new Error(`invalid zone ${index}.state`);
  if (typeof zone.bypassed !== "boolean") throw new Error(`invalid zone ${index}.bypassed`);
  return zone as unknown as AlarmZone;
}

function parseEvent(value: unknown, index: number): AlarmEvent {
  const event = record(value, `event ${index}`);
  onlyKnown(event, ["ago_s", "kind", "zone"], `event ${index}`);
  if (!integer(event.ago_s) || event.ago_s < 0) throw new Error(`invalid event ${index}.ago_s`);
  if (!oneOf(EVENT_KINDS, event.kind)) throw new Error(`invalid event ${index}.kind`);
  if ("zone" in event && (typeof event.zone !== "string" || !zoneId.test(event.zone))) throw new Error(`invalid event ${index}.zone`);
  return event as unknown as AlarmEvent;
}

/** The state of a node, with the rules that join fields: a zone named once, an open zone is a zone of the message, the mode is disarmed exactly when the phase is, a siren only in the alarm phase. */
export function parseAlarmMessage(value: unknown): AlarmMessage {
  const body = record(value, "alarm message");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "phase", "mode", "siren", "locked_out", "commands_enabled", "zones", "open_zones", "events"], "alarm message");
  for (const key of ["kind", "node_id", "timestamp_ms", "phase", "mode", "siren", "locked_out", "commands_enabled", "zones", "open_zones", "events"]) if (!(key in body)) throw new Error(`the alarm message is missing ${key}`);
  if (body.kind !== "alarm") throw new Error("invalid kind");
  const node = readNodeId(body), timestamp = readTimestamp(body);
  if (!oneOf(PHASES, body.phase)) throw new Error("invalid phase");
  if (!oneOf(MODES, body.mode)) throw new Error("invalid mode");
  for (const key of ["siren", "locked_out", "commands_enabled"]) if (typeof body[key] !== "boolean") throw new Error(`invalid ${key}`);
  if (!Array.isArray(body.zones) || body.zones.length > 16) throw new Error("invalid zones");
  const zones = body.zones.map(parseZone);
  const ids = zones.map(zone => zone.id);
  if (new Set(ids).size !== ids.length) throw new Error("a zone id must appear once");
  if (!Array.isArray(body.open_zones) || body.open_zones.length > 16 || body.open_zones.some(item => typeof item !== "string" || !zoneId.test(item))) throw new Error("invalid open_zones");
  const open = body.open_zones as string[];
  if (new Set(open).size !== open.length) throw new Error("an open zone is named once");
  if (open.some(item => !ids.includes(item))) throw new Error("an open zone must be a zone of the message");
  if (!Array.isArray(body.events) || body.events.length > 10) throw new Error("invalid events");
  const events = body.events.map(parseEvent);
  if (events.some(event => event.zone !== undefined && !ids.includes(event.zone))) throw new Error("an event about a zone names a zone of the message");
  if ((body.phase === "disarmed") !== (body.mode === "disarmed")) throw new Error("the mode is disarmed exactly when the phase is");
  if (body.siren === true && body.phase !== "alarm") throw new Error("the siren sounds only in the alarm phase");
  return { ...(body as unknown as AlarmMessage), node_id: node, timestamp_ms: timestamp, zones, events };
}

function readCommonFields(body: Record<string, unknown>, what: string): void {
  for (const key of ["kind", "node_id", "timestamp_ms", "command_id", "action"]) if (!(key in body)) throw new Error(`the ${what} is missing ${key}`);
  if (typeof body.command_id !== "string" || !commandIdPattern.test(body.command_id)) throw new Error("invalid command_id");
  if (!oneOf(ACTIONS, body.action)) throw new Error("invalid action");
}

/** A command to the panel, as the contract has it: a mode exactly on an arm, force only on an arm. The server builds these; the parser is what the shared vectors check. */
export function parseAlarmCommand(value: unknown): AlarmCommand {
  const body = record(value, "alarm command");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "command_id", "action", "mode", "force"], "alarm command");
  readCommonFields(body, "alarm command");
  if (body.kind !== "alarm_command") throw new Error("invalid kind");
  const node = readNodeId(body), timestamp = readTimestamp(body);
  if ("mode" in body && body.mode !== "away" && body.mode !== "stay") throw new Error("invalid mode");
  if ("force" in body && typeof body.force !== "boolean") throw new Error("invalid force");
  if ((body.action === "arm") !== ("mode" in body)) throw new Error("a mode goes on an arm and on nothing else");
  if (body.action !== "arm" && body.force === true) throw new Error("force goes on an arm and on nothing else");
  return { ...(body as unknown as AlarmCommand), node_id: node, timestamp_ms: timestamp };
}

/** The answer of a node: the refusal is none exactly when it accepted. */
export function parseAlarmResult(value: unknown): AlarmResult {
  const body = record(value, "alarm result");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "command_id", "action", "accepted", "refusal", "phase"], "alarm result");
  readCommonFields(body, "alarm result");
  for (const key of ["accepted", "refusal", "phase"]) if (!(key in body)) throw new Error(`the alarm result is missing ${key}`);
  if (body.kind !== "alarm_result") throw new Error("invalid kind");
  const node = readNodeId(body), timestamp = readTimestamp(body);
  if (typeof body.accepted !== "boolean") throw new Error("invalid accepted");
  if (!oneOf(REFUSALS, body.refusal)) throw new Error("invalid refusal");
  if (!oneOf(PHASES, body.phase)) throw new Error("invalid phase");
  if (body.accepted !== (body.refusal === "none")) throw new Error("the refusal is none exactly when the request was accepted");
  return { ...(body as unknown as AlarmResult), node_id: node, timestamp_ms: timestamp };
}

/** armor/alarm/{node_id}/{leaf} as node_id, or undefined when the topic is not one; the leaf is state (a node's state), command or result. */
export function alarmTopic(topic: string, leaf: "state" | "command" | "result" = "state"): string | undefined {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== "armor" || parts[1] !== "alarm" || parts[3] !== leaf) return undefined;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[2]) ? parts[2] : undefined;
}

// ---- the latest state of every node -----------------------------------------------------------------------------------------------------

export type AlarmNodeView = { node_id: string; state: AlarmMessage; received_at: string; stale: boolean };
export type AlarmTotals = { nodes: number; stale: number; armed: number; sounding: number };
export type AlarmStoreOptions = {
  now?: () => number;
  /** A node that has not reported for this long is stale (the node says its state every five seconds). */
  staleAfterMs?: number;
  maxNodes?: number;
  onMessage?: (message: AlarmMessage, previous: AlarmMessage | undefined) => void;
  onStale?: (node: string, stale: boolean) => void;
};
type Entry = { state: AlarmMessage; receivedAtMs: number; stale: boolean };

export class AlarmStore {
  readonly #entries = new Map<string, Entry>();
  readonly #options: Required<Pick<AlarmStoreOptions, "now" | "staleAfterMs" | "maxNodes">> & AlarmStoreOptions;

  constructor(options: AlarmStoreOptions = {}) {
    this.#options = { ...options, now: options.now ?? (() => Date.now()), staleAfterMs: options.staleAfterMs ?? 30_000, maxNodes: options.maxNodes ?? 64 };
  }

  /** Keep a message. Refuses (throws) a new node when the store is full, so a broker full of noise cannot grow it without limit. */
  ingest(message: AlarmMessage): void {
    const entry = this.#entries.get(message.node_id);
    if (!entry && this.#entries.size >= this.#options.maxNodes) throw new Error("too many alarm nodes");
    const previous = entry?.state;
    const wasStale = entry?.stale ?? false;
    this.#entries.set(message.node_id, { state: message, receivedAtMs: this.#options.now(), stale: false });
    if (wasStale) this.#options.onStale?.(message.node_id, false);
    this.#options.onMessage?.(message, previous);
  }

  remove(node: string): boolean { return this.#entries.delete(node); }

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

  list(): AlarmNodeView[] {
    this.sweep();
    return [...this.#entries.values()].map(entry => ({ node_id: entry.state.node_id, state: entry.state, received_at: new Date(entry.receivedAtMs).toISOString(), stale: entry.stale }))
      .sort((a, b) => a.node_id.localeCompare(b.node_id));
  }

  totals(): AlarmTotals {
    this.sweep();
    let stale = 0, armed = 0, sounding = 0;
    for (const entry of this.#entries.values()) {
      if (entry.stale) { stale += 1; continue; }
      if (entry.state.phase === "armed" || entry.state.phase === "entry_delay" || entry.state.phase === "exit_delay") armed += 1;
      if (entry.state.phase === "alarm") sounding += 1;
    }
    return { nodes: this.#entries.size, stale, armed, sounding };
  }
}
