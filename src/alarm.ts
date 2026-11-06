/**
 * What the ARMOR-NODE-ALARM nodes say about the house's alarm (armor/alarm/{node_id}/state): the strict parser of the message, and the store that keeps the latest state of
 * every node. The parsers implement ARMOR-COMMON's alarm schemas exactly (tests/alarm.test.ts runs the shared vectors), and so do the parsers of a command to the panel and
 * of the node's answer. Nothing in this file sends anything: the command path is alarm_commands.ts, and it is off unless the operator turned it on.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { onlyKnown, readNodeId, readTimestamp, record, integer } from "./contracts.js";
import type { Alarm, AlarmCommand, AlarmEvent, AlarmResult, AlarmZone } from "./armor-contracts.js";
import { parseArmProfile, type ArmProfile } from "./arm_profiles.js";

/** The shapes of the alarm messages are the ones ARMOR-COMMON generates from its schemas; the lists below are the values the parsers accept, and the compiler checks that each list holds exactly the values of the generated type. */
export type { AlarmCommand, AlarmEvent, AlarmResult, AlarmZone };
export type AlarmMessage = Alarm;
import { refresh, sweepStale } from "./staleness.js";

export const PHASES = ["disarmed", "exit_delay", "armed", "entry_delay", "alarm"] as const;
export type Phase = Alarm["phase"];
export const MODES = ["disarmed", "away", "stay"] as const;
export type Mode = Alarm["mode"];
export const ZONE_KINDS = ["instant", "entry", "interior", "always"] as const;
export type ZoneKind = AlarmZone["kind"];
export const ZONE_STATES = ["normal", "triggered", "tamper", "trouble"] as const;   // trouble: the zone cannot be read, so it is not guarding
export type ZoneState = AlarmZone["state"];
export const EVENT_KINDS = ["armed", "exit_delay_started", "entry_delay_started", "alarm", "siren_timed_out", "disarmed", "bad_pin", "locked_out", "zone_bypassed", "siren_silenced"] as const;
export type EventKind = AlarmEvent["kind"];
/** The state of the siren's wiring on a node that supervises it: ok the siren is there, open the wire is cut or the siren is gone, short the wire is shorted, unreadable the node cannot read the return line. */
export const SIREN_LOOP_STATES = ["unknown", "ok", "open", "short", "unreadable"] as const;
export type SirenLoopState = NonNullable<Alarm["siren_loop"]>;
export const ACTIONS = ["arm", "disarm", "silence"] as const;
export type AlarmAction = AlarmCommand["action"];
export const REFUSALS = ["none", "not_disarmed", "zones_open", "not_armed", "bad_pin", "locked_out"] as const;
export type AlarmRefusal = AlarmResult["refusal"];

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

/** The state of a node, with the rules that join fields: a zone named once, an open zone is a zone of the message, a disarmed panel has the mode disarmed and an armed one does not, a siren only in the alarm phase. */
export function parseAlarmMessage(value: unknown): AlarmMessage {
  const body = record(value, "alarm message");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "phase", "mode", "siren", "locked_out", "commands_enabled", "zones", "open_zones", "events", "arm_profiles", "profile", "siren_loop", "siren_fault", "seq", "sig"], "alarm message");
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
  // A disarmed panel has the mode disarmed; the alarm phase may carry it too (a 24-hour zone or a tamper sounds with nobody having armed the panel).
  if (body.phase === "disarmed" && body.mode !== "disarmed") throw new Error("a disarmed panel has the mode disarmed");
  if ((body.phase === "exit_delay" || body.phase === "armed" || body.phase === "entry_delay") && body.mode === "disarmed") throw new Error("an arming or armed panel has a mode other than disarmed");
  if (body.siren === true && body.phase !== "alarm") throw new Error("the siren sounds only in the alarm phase");
  if ("arm_profiles" in body && typeof body.arm_profiles !== "boolean") throw new Error("invalid arm_profiles");
  // the siren's wiring: the state and the fault are sent together, and the fault is exactly the states that leave the siren cut, shorted or unsupervised
  if (("siren_loop" in body) !== ("siren_fault" in body)) throw new Error("siren_loop and siren_fault are sent together");
  if ("siren_loop" in body) {
    if (!oneOf(SIREN_LOOP_STATES, body.siren_loop)) throw new Error("invalid siren_loop");
    if (typeof body.siren_fault !== "boolean") throw new Error("invalid siren_fault");
    if (body.siren_fault !== (body.siren_loop === "open" || body.siren_loop === "short" || body.siren_loop === "unreadable")) throw new Error("siren_fault is true exactly when siren_loop is open, short or unreadable");
  }
  if (("seq" in body) !== ("sig" in body)) throw new Error("seq and sig come together");
  if ("seq" in body && (!integer(body.seq) || body.seq < 0 || body.seq > Number.MAX_SAFE_INTEGER)) throw new Error("invalid seq");
  if ("sig" in body && (typeof body.sig !== "string" || !/^[0-9a-f]{64}$/.test(body.sig))) throw new Error("invalid sig");
  if ("profile" in body) {
    if (typeof body.profile !== "string" || !/^[a-z0-9][a-z0-9_-]{0,15}$/.test(body.profile)) throw new Error("invalid profile");
    if (body.mode === "disarmed") throw new Error("a panel that is not armed has no arming profile");
  }
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
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "command_id", "action", "mode", "force", "profile"], "alarm command");
  readCommonFields(body, "alarm command");
  if (body.kind !== "alarm_command") throw new Error("invalid kind");
  const node = readNodeId(body), timestamp = readTimestamp(body);
  if ("mode" in body && body.mode !== "away" && body.mode !== "stay") throw new Error("invalid mode");
  if ("force" in body && typeof body.force !== "boolean") throw new Error("invalid force");
  if ((body.action === "arm") !== ("mode" in body)) throw new Error("a mode goes on an arm and on nothing else");
  if (body.action !== "arm" && body.force === true) throw new Error("force goes on an arm and on nothing else");
  if ("profile" in body) {
    if (body.action !== "arm") throw new Error("a profile goes on an arm and on nothing else");
    const profile = parseArmProfile(body.profile, "profile");
    if (profile.base !== body.mode) throw new Error("the base of the profile is the mode of the arm");
    return { ...(body as unknown as AlarmCommand), node_id: node, timestamp_ms: timestamp, profile };
  }
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
  /** `phase` is the phase of the panel when it fell silent: a panel that was disarmed and goes quiet is not news to wake anybody for. */
  onStale?: (node: string, stale: boolean, phase?: AlarmMessage["phase"]) => void;
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
    let wasStale = false;
    if (entry) { entry.state = message; wasStale = refresh(entry, this.#options.now()); }
    else this.#entries.set(message.node_id, { state: message, receivedAtMs: this.#options.now(), stale: false });
    if (wasStale) this.#options.onStale?.(message.node_id, false);
    this.#options.onMessage?.(message, previous);
  }

  remove(node: string): boolean { return this.#entries.delete(node); }

  /** Mark the nodes that went quiet (and tell), called now and then. */
  sweep(): void {
    sweepStale(this.#entries.values(), this.#options.now(), this.#options.staleAfterMs, entry => this.#options.onStale?.(entry.state.node_id, true, entry.state.phase));
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

// A list that misses a value of the generated type, or holds one it does not have, stops the build here.
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const listsMatchContract: [
  Exactly<Phase, (typeof PHASES)[number]>, Exactly<Mode, (typeof MODES)[number]>, Exactly<ZoneKind, (typeof ZONE_KINDS)[number]>, Exactly<ZoneState, (typeof ZONE_STATES)[number]>,
  Exactly<EventKind, (typeof EVENT_KINDS)[number]>, Exactly<SirenLoopState, (typeof SIREN_LOOP_STATES)[number]>, Exactly<AlarmAction, (typeof ACTIONS)[number]>, Exactly<AlarmRefusal, (typeof REFUSALS)[number]>,
] = [true, true, true, true, true, true, true, true];
void listsMatchContract;
