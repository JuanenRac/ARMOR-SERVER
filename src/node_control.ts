/**
 * Controlling the nodes from Studio and the phone, the part that needs no state: the words of the contract (ARMOR-COMMON's node_control_command and node_control_result), the strict
 * readers of both, the rules of a request (which operation needs the node's name typed, how long a pause may last) and the rolling schedule of a restart of every node.
 * The operations are restart, pause, resume, standby, identify, diagnostics, maintenance_on and maintenance_off. There is no operation that erases a node's settings or credentials, none
 * that puts it into deep sleep and none that sets a wake timer: the list below is closed, and the readers refuse every other word.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { integer, onlyKnown, record } from "./contracts.js";

export const CONTROL_OPERATIONS = ["restart", "pause", "resume", "standby", "identify", "diagnostics", "maintenance_on", "maintenance_off"] as const;
export type ControlOperation = (typeof CONTROL_OPERATIONS)[number];
export const CONTROL_ACTIONS = ["arm", "execute"] as const;
export const CONTROL_MODES = ["now", "rolling"] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];
export const CONTROL_STAGES = ["armed", "restarting", "applied", "diagnostics", "rejected"] as const;
export const CONTROL_REFUSALS = ["none", "not_armed", "invalid_token", "token_expired", "rate_limited", "already_restarting", "already_in_state", "busy_update", "busy_upload", "busy_slot_copy", "busy_battery", "unavailable"] as const;
export type ControlRefusal = (typeof CONTROL_REFUSALS)[number];
export const CONTROL_STATES = ["running", "paused", "standby"] as const;
export type NodeControlState = (typeof CONTROL_STATES)[number];

/** The operations that leave the house less guarded (an alarm panel that does not watch, a radar that does not see): the node's name is typed again for them. */
export const NEEDS_CONFIRM: readonly ControlOperation[] = ["restart", "pause", "standby"];
/** The word typed for the same three operations when every node is ordered at once. */
export const CONFIRM_WORD: Partial<Record<ControlOperation, string>> = { restart: "RESTART", pause: "PAUSE", standby: "STANDBY" };
/** [lowest, highest, default] seconds of the operations that last a while. */
export const DURATIONS: Partial<Record<ControlOperation, readonly [number, number, number]>> = { pause: [60, 3600, 3600], identify: [5, 300, 30], maintenance_on: [60, 28_800, 3600] };
/** The pause between two nodes of a rolling restart, and the least time between two nodes of one family. */
export const ROLLING_GAP_S = 30;
export const SAME_FAMILY_WINDOW_S = 20;
export const MAX_SLOT = 63;
export const MAX_DELAY_S = 600;
/** How long a token is good for in the node (the contract says thirty seconds). */
export const TOKEN_TTL_S = 30;

export const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const COMMAND_ID = /^[a-z0-9]{8,32}$/;
const TOKEN = /^[a-z0-9]{16,32}$/;
export const PERSON = /^[A-Za-z0-9._@ -]{1,64}$/;
const FIRMWARE = /^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$/;
const RESET_REASONS = ["power_on", "external", "software", "panic", "int_wdt", "task_wdt", "other_wdt", "deep_sleep", "brownout", "sdio", "usb", "jtag", "efuse", "power_glitch", "cpu_lockup", "unknown"];

export class ControlError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

/** The name of a person as the contract allows it in an order: other characters are left out, and a name that has none left is "administrator". */
export function personFor(name: string | undefined): string {
  const cleaned = (name ?? "").replace(/[^A-Za-z0-9._@ -]/g, "").trim().slice(0, 64);
  return cleaned || "administrator";
}

// ---- the order the server sends --------------------------------------------------------------------------------------------------------------

export type ControlCommand = {
  kind: "node_control_command"; node_id: string; timestamp_ms: number; command_id: string; action: "arm" | "execute"; operation: ControlOperation; mode: ControlMode; requested_by: string;
  delay_s?: number; slot?: number; duration_s?: number; token?: string;
};

/** An order as the contract has it, with the rules that join its fields (the same as the node's reader): nothing leaves this server that the contract would refuse. */
export function parseControlCommand(value: unknown): ControlCommand {
  const body = record(value, "control command");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "command_id", "action", "operation", "mode", "requested_by", "delay_s", "slot", "duration_s", "token"], "control command");
  if (body.kind !== "node_control_command") throw new Error("invalid kind");
  if (typeof body.node_id !== "string" || !NODE_ID.test(body.node_id)) throw new Error("invalid node_id");
  if (!integer(body.timestamp_ms) || body.timestamp_ms < 0) throw new Error("invalid timestamp_ms");
  if (typeof body.command_id !== "string" || !COMMAND_ID.test(body.command_id)) throw new Error("invalid command_id");
  if (!oneOf(CONTROL_ACTIONS, body.action)) throw new Error("invalid action");
  if (!oneOf(CONTROL_OPERATIONS, body.operation)) throw new Error("invalid operation");
  if (!oneOf(CONTROL_MODES, body.mode)) throw new Error("invalid mode");
  if (typeof body.requested_by !== "string" || !PERSON.test(body.requested_by)) throw new Error("invalid requested_by");
  if ("delay_s" in body && (!integer(body.delay_s) || body.delay_s < 0 || body.delay_s > MAX_DELAY_S)) throw new Error("invalid delay_s");
  if ("slot" in body && (!integer(body.slot) || body.slot < 0 || body.slot > MAX_SLOT)) throw new Error("invalid slot");
  if ("duration_s" in body && (!integer(body.duration_s) || body.duration_s < 1 || body.duration_s > 86_400)) throw new Error("invalid duration_s");
  if ("token" in body && (typeof body.token !== "string" || !TOKEN.test(body.token))) throw new Error("invalid token");
  const execute = body.action === "execute";
  if (execute !== ("token" in body)) throw new Error("a token goes on an execute and on nothing else");
  if (execute && body.node_id === "all") throw new Error("an execute is for one node: its token is its own");
  if (body.mode === "rolling" && body.operation !== "restart") throw new Error("the rolling mode is only for a restart");
  if (("delay_s" in body || "slot" in body) && !(execute && body.operation === "restart")) throw new Error("a delay and a slot go on the execute of a restart");
  if ("slot" in body && body.mode !== "rolling") throw new Error("a slot goes with the rolling mode");
  if ("duration_s" in body) {
    const span = DURATIONS[body.operation];
    if (!execute || !span) throw new Error("a duration goes on the execute of pause, identify or maintenance_on");
    if ((body.duration_s as number) < span[0] || (body.duration_s as number) > span[1]) throw new Error(`the duration of ${body.operation} is ${span[0]} to ${span[1]} seconds`);
  }
  return body as unknown as ControlCommand;
}

// ---- what a node answers ---------------------------------------------------------------------------------------------------------------------

export type ControlDiagnostics = {
  firmware: string; uptime_s: number; reset_reason: string; heap_free: number; heap_min: number; psram_free?: number; stack_min_free?: number; rssi?: number; mqtt_connected: boolean; state: NodeControlState; maintenance: boolean;
};
export type ControlResult = {
  kind: "node_control_result"; node_id: string; timestamp_ms: number; command_id: string; action: "arm" | "execute"; operation: ControlOperation; stage: (typeof CONTROL_STAGES)[number]; accepted: boolean; refusal: ControlRefusal;
  token?: string; token_ttl_s?: number; reason?: "requested_by_server"; mode?: ControlMode; restart_in_s?: number; uptime_s?: number; firmware?: string; requested_by?: string;
  state?: NodeControlState; maintenance?: boolean; until_s?: number; since_ms?: number; diagnostics?: ControlDiagnostics;
};

const RESULT_KNOWN = ["kind", "node_id", "timestamp_ms", "command_id", "action", "operation", "stage", "accepted", "refusal", "token", "token_ttl_s", "reason", "mode", "restart_in_s", "uptime_s", "firmware", "requested_by", "state", "maintenance", "until_s", "since_ms", "diagnostics"];
const GROUPS: Record<string, { fields: string[]; required: string[] }> = {
  armed: { fields: ["token", "token_ttl_s"], required: ["token", "token_ttl_s"] },
  restarting: { fields: ["reason", "mode", "restart_in_s", "uptime_s", "firmware", "requested_by"], required: ["reason", "mode", "restart_in_s", "uptime_s", "firmware", "requested_by"] },
  applied: { fields: ["state", "maintenance", "requested_by", "until_s", "since_ms"], required: ["state", "maintenance", "requested_by"] },
  diagnostics: { fields: ["diagnostics"], required: ["diagnostics"] },
};

function parseDiagnostics(value: unknown): ControlDiagnostics {
  const body = record(value, "diagnostics");
  onlyKnown(body, ["firmware", "uptime_s", "reset_reason", "heap_free", "heap_min", "psram_free", "stack_min_free", "rssi", "mqtt_connected", "state", "maintenance"], "diagnostics");
  if (typeof body.firmware !== "string" || !FIRMWARE.test(body.firmware)) throw new Error("invalid diagnostics firmware");
  for (const key of ["uptime_s", "heap_free", "heap_min", "psram_free", "stack_min_free"]) if (key in body && (!integer(body[key]) || (body[key] as number) < 0)) throw new Error(`invalid diagnostics ${key}`);
  for (const key of ["uptime_s", "heap_free", "heap_min"]) if (!(key in body)) throw new Error(`diagnostics needs ${key}`);
  if (typeof body.reset_reason !== "string" || !RESET_REASONS.includes(body.reset_reason)) throw new Error("invalid diagnostics reset_reason");
  if ("rssi" in body && (!integer(body.rssi) || body.rssi < -120 || body.rssi > 0)) throw new Error("invalid diagnostics rssi");
  if (typeof body.mqtt_connected !== "boolean" || typeof body.maintenance !== "boolean") throw new Error("invalid diagnostics flag");
  if (!oneOf(CONTROL_STATES, body.state)) throw new Error("invalid diagnostics state");
  return body as unknown as ControlDiagnostics;
}

/** A node's answer, read strictly with the rules that join its fields: refusal none exactly when accepted, the stage that fits the action and the operation, and every field only in its own stage. */
export function parseControlResult(value: unknown): ControlResult {
  const body = record(value, "control result");
  for (const key of Object.keys(body)) if (!RESULT_KNOWN.includes(key)) throw new Error(`the control result has an unknown field ${key}`);
  if (body.kind !== "node_control_result") throw new Error("invalid kind");
  if (typeof body.node_id !== "string" || !NODE_ID.test(body.node_id)) throw new Error("invalid node_id");
  if (!integer(body.timestamp_ms) || body.timestamp_ms < 0) throw new Error("invalid timestamp_ms");
  if (typeof body.command_id !== "string" || !COMMAND_ID.test(body.command_id)) throw new Error("invalid command_id");
  if (!oneOf(CONTROL_ACTIONS, body.action)) throw new Error("invalid action");
  if (!oneOf(CONTROL_OPERATIONS, body.operation)) throw new Error("invalid operation");
  if (!oneOf(CONTROL_STAGES, body.stage)) throw new Error("invalid stage");
  if (typeof body.accepted !== "boolean") throw new Error("invalid accepted");
  if (!oneOf(CONTROL_REFUSALS, body.refusal)) throw new Error("invalid refusal");
  if (body.accepted !== (body.refusal === "none")) throw new Error("the refusal is none exactly when the order was accepted");
  if ((body.stage === "rejected") === body.accepted) throw new Error("a rejected answer is one that was not accepted");
  if (body.refusal === "already_restarting" && body.operation !== "restart") throw new Error("only a restart can find the node already restarting");
  if (body.accepted) {
    const expected = body.action === "arm" ? "armed" : body.operation === "restart" ? "restarting" : body.operation === "diagnostics" ? "diagnostics" : "applied";
    if (body.stage !== expected) throw new Error(`an accepted ${body.action} of ${body.operation} is answered ${expected}`);
  }
  if ("token" in body && (typeof body.token !== "string" || !TOKEN.test(body.token))) throw new Error("invalid token");
  if ("token_ttl_s" in body && (!integer(body.token_ttl_s) || body.token_ttl_s < 1 || body.token_ttl_s > 120)) throw new Error("invalid token_ttl_s");
  if ("reason" in body && body.reason !== "requested_by_server") throw new Error("invalid reason");
  if ("mode" in body && !oneOf(CONTROL_MODES, body.mode)) throw new Error("invalid mode");
  if ("restart_in_s" in body && (!integer(body.restart_in_s) || body.restart_in_s < 0 || body.restart_in_s > 3600)) throw new Error("invalid restart_in_s");
  if ("uptime_s" in body && (!integer(body.uptime_s) || body.uptime_s < 0)) throw new Error("invalid uptime_s");
  if ("firmware" in body && (typeof body.firmware !== "string" || !FIRMWARE.test(body.firmware))) throw new Error("invalid firmware");
  if ("requested_by" in body && (typeof body.requested_by !== "string" || !PERSON.test(body.requested_by))) throw new Error("invalid requested_by");
  if ("state" in body && !oneOf(CONTROL_STATES, body.state)) throw new Error("invalid state");
  if ("maintenance" in body && typeof body.maintenance !== "boolean") throw new Error("invalid maintenance");
  if ("until_s" in body && (!integer(body.until_s) || body.until_s < 0 || body.until_s > 86_400)) throw new Error("invalid until_s");
  if ("since_ms" in body && (!integer(body.since_ms) || body.since_ms < 0)) throw new Error("invalid since_ms");
  if ("diagnostics" in body) parseDiagnostics(body.diagnostics);
  for (const [name, group] of Object.entries(GROUPS)) {
    const present = group.fields.filter(field => field in body);
    if (body.stage === name && !group.required.every(field => present.includes(field))) throw new Error(`a ${name} answer carries ${group.required.join(", ")}`);
    const shared = (name === "restarting" && body.stage === "applied") || (name === "applied" && body.stage === "restarting") ? ["requested_by"] : [];
    if (body.stage !== name && present.some(field => !shared.includes(field))) throw new Error(`${present.join(", ")} belong to a ${name} answer only`);
  }
  return body as unknown as ControlResult;
}

/** armor/control/{node_id}/{leaf} as the node id, or undefined when the topic is not one (`all` is a topic for orders to every node and is never the name of a node that answers). */
export function controlTopic(topic: string, leaf: "command" | "result"): string | undefined {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== "armor" || parts[1] !== "control" || parts[3] !== leaf) return undefined;
  if (parts[2] === "all" && leaf === "result") return undefined;
  return NODE_ID.test(parts[2]) ? parts[2] : undefined;
}

// ---- the planned-maintenance signal of a node ------------------------------------------------------------------------------------------------

export const MAINTENANCE_REASONS = ["restart", "pause", "standby", "update", "upload", "operator"] as const;
export type MaintenanceReason = (typeof MAINTENANCE_REASONS)[number];
/** What a node publishes (retained) to armor/control/{node_id}/maintenance just before it goes quiet on purpose, and again when it is back. */
export type NodeMaintenance = { kind: "node_maintenance"; node_id: string; timestamp_ms: number; active: boolean; reason: MaintenanceReason; expected_s?: number; firmware: string; requested_by?: string };

/** The signal as the contract has it (ARMOR-COMMON's node_maintenance), read strictly: a window that ends carries no expected time. */
export function parseMaintenance(value: unknown): NodeMaintenance {
  const body = record(value, "maintenance signal");
  onlyKnown(body, ["kind", "node_id", "timestamp_ms", "active", "reason", "expected_s", "firmware", "requested_by"], "maintenance signal");
  if (body.kind !== "node_maintenance") throw new Error("invalid kind");
  if (typeof body.node_id !== "string" || !NODE_ID.test(body.node_id)) throw new Error("invalid node_id");
  if (!integer(body.timestamp_ms) || body.timestamp_ms < 0) throw new Error("invalid timestamp_ms");
  if (typeof body.active !== "boolean") throw new Error("invalid active");
  if (!oneOf(MAINTENANCE_REASONS, body.reason)) throw new Error("invalid reason");
  if ("expected_s" in body && (!integer(body.expected_s) || body.expected_s < 1 || body.expected_s > 3600)) throw new Error("invalid expected_s");
  if (typeof body.firmware !== "string" || !FIRMWARE.test(body.firmware)) throw new Error("invalid firmware");
  if ("requested_by" in body && (typeof body.requested_by !== "string" || !PERSON.test(body.requested_by))) throw new Error("invalid requested_by");
  if (!body.active && "expected_s" in body) throw new Error("a window that ends has no expected time");
  return body as unknown as NodeMaintenance;
}

/** armor/control/{node_id}/maintenance as the node id; `all` is the name of no node, so it never announces. */
export function maintenanceTopic(topic: string): string | undefined {
  const parts = topic.split("/");
  if (parts.length !== 4 || parts[0] !== "armor" || parts[1] !== "control" || parts[3] !== "maintenance") return undefined;
  return parts[2] !== "all" && NODE_ID.test(parts[2]) ? parts[2] : undefined;
}

// ---- what a request asks ---------------------------------------------------------------------------------------------------------------------

export type ControlRequest = { operation: ControlOperation; mode: ControlMode; duration_s?: number; confirm?: string };

/**
 * Reads the body of a request: only the allowed names, a known operation, a duration only where the operation takes one and inside its range. `scope` decides what is asked of `mode`
 * (one node is always `now`; every node may be `rolling`, and only for a restart) and what `confirm` has to be: the name of the node, or the word of the operation.
 */
export function readControlRequest(body: unknown, scope: "node" | "all", nodeNames: readonly string[] = []): ControlRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ControlError("invalid_request", "the request must be an object");
  const given = body as Record<string, unknown>;
  const allowed = scope === "all" ? ["operation", "mode", "confirm", "duration_s"] : ["operation", "confirm", "duration_s"];
  for (const key of Object.keys(given)) if (!allowed.includes(key)) throw new ControlError("invalid_request", `${key} is not a field of this request`);
  const operation = given.operation;
  if (!oneOf(CONTROL_OPERATIONS, operation)) throw new ControlError("invalid_request", `operation must be one of ${CONTROL_OPERATIONS.join(", ")}`);
  let mode: ControlMode = "now";
  if (scope === "all") {
    if (!oneOf(CONTROL_MODES, given.mode)) throw new ControlError("invalid_request", "mode must be now or rolling");
    mode = given.mode;
    if (mode === "rolling" && operation !== "restart") throw new ControlError("invalid_request", "the rolling mode is only for a restart");
  }
  let duration: number | undefined;
  if (given.duration_s !== undefined) {
    const span = DURATIONS[operation];
    if (!span) throw new ControlError("invalid_request", `${operation} takes no duration`);
    if (!integer(given.duration_s) || given.duration_s < span[0] || given.duration_s > span[1]) throw new ControlError("invalid_request", `the duration of ${operation} is ${span[0]} to ${span[1]} seconds`);
    duration = given.duration_s;
  }
  let confirm: string | undefined;
  if (NEEDS_CONFIRM.includes(operation)) {
    const wanted = scope === "all" ? [CONFIRM_WORD[operation] as string] : nodeNames;
    if (typeof given.confirm !== "string" || !wanted.includes(given.confirm)) throw new ControlError("invalid_request", scope === "all" ? `type the word ${CONFIRM_WORD[operation]} to confirm` : "type the name of the node to confirm");
    confirm = given.confirm;
  }
  return { operation, mode, ...(duration !== undefined ? { duration_s: duration } : {}), ...(confirm !== undefined ? { confirm } : {}) };
}

// ---- the rolling schedule --------------------------------------------------------------------------------------------------------------------

/** The families in the order a rolling restart goes through them: the alarm panel is always the last, so the house is unguarded for the shortest time. */
const ROLLING_ORDER = ["radar", "solar", "electrical", "hmi", "alarm"];

/**
 * The place of every node in a rolling restart: sorted by node id inside its family, the families in a fixed order with the alarm panels last, one place for each node. The node waits its
 * place times thirty seconds, so two nodes never restart in the same thirty seconds, and two of one family are never closer than the twenty seconds the contract asks for.
 * Throws when there are more nodes than places (64).
 */
export function rollingSchedule(nodes: ReadonlyArray<{ id: string; family: string }>): Map<string, number> {
  if (nodes.length > MAX_SLOT + 1) throw new ControlError("too_many_nodes", "a rolling restart has room for 64 nodes", 409);
  const rank = (family: string): number => { const found = ROLLING_ORDER.indexOf(family); return found < 0 ? ROLLING_ORDER.length - 1 - 0.5 : found; };
  const sorted = [...nodes].sort((a, b) => rank(a.family) - rank(b.family) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(sorted.map((node, index) => [node.id, index]));
}

/** The sample of a refused message that is kept for the System menu: the one-time token of a control or battery order is replaced, whatever else was wrong with the message. */
export function redactToken(topic: string, raw: Buffer): Buffer {
  if (!/^armor\/(control\/|solar\/[^/]+\/maintenance\/)/.test(topic)) return raw;
  return Buffer.from(raw.toString("utf8").replace(/("token"\s*:\s*")[^"]*(")/g, "$1***$2"), "utf8");
}
