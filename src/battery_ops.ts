/**
 * Writing to a Pylontech battery, the server's part that needs no state: the values of an operation checked against the table, the answers of a node read strictly, the header of a
 * firmware image, and the small pieces of text work (the difference between two reads, the state an output had).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHash } from "node:crypto";
import { BATTERY_CATALOG } from "./battery_catalog.js";

export type BatteryOpId = (typeof BATTERY_CATALOG.ops)[number]["id"];
export const BATTERY_OP_IDS: readonly string[] = BATTERY_CATALOG.ops.map(item => item.id);
export const BATTERY_REFUSALS: readonly string[] = BATTERY_CATALOG.refusals;
export const NO_SERIAL = BATTERY_CATALOG.limits.no_serial;
const SERIAL = new RegExp(BATTERY_CATALOG.limits.serial_pattern);
const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COMMAND_ID = /^[a-z0-9]{8,32}$/;

export class BatteryOpsError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

type Spec = { type: string; required?: boolean; values?: readonly string[]; minimum?: number; maximum?: number; maxLength?: number };
export const opSpec = (op: string) => BATTERY_CATALOG.ops.find(item => item.id === op);

/** The line of the expert console, cleaned, or "" when it may not be sent: one command, ASCII, at most 48 characters, no word of the block list. */
export function expertLine(text: unknown): string {
  if (typeof text !== "string") return "";
  const words: string[] = [];
  let current = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return "";
    if (char === " ") { if (current) { words.push(current); current = ""; } continue; }
    if (!/[A-Za-z0-9\-_.:/]/.test(char)) return "";
    current += char;
  }
  if (current) words.push(current);
  const line = words.join(" ");
  if (!line || line.length > 48) return "";
  const blocked: readonly string[] = BATTERY_CATALOG.expert_blocked;
  return words.some(word => blocked.includes(word.toLowerCase())) ? "" : line;
}

/** The values of an operation against the table: only its own names, every required one, each inside its range, a group of limits whole and in order. Returns them as they are to be sent. */
export function validateBatteryParams(op: string, params: unknown): Record<string, unknown> {
  const spec = opSpec(op);
  if (!spec) throw new BatteryOpsError("invalid_request", "unknown operation");
  const body = params === undefined ? {} : params;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BatteryOpsError("invalid_params", "params must be an object");
  const values = body as Record<string, unknown>;
  const wanted = spec.params as Record<string, Spec>;
  for (const name of Object.keys(values)) if (!(name in wanted)) throw new BatteryOpsError("invalid_params", `${op} has no value called ${name}`);
  for (const [name, rule] of Object.entries(wanted)) {
    if (!(name in values)) { if (rule.required) throw new BatteryOpsError("invalid_params", `${op} needs ${name}`); continue; }
    const value = values[name];
    switch (rule.type) {
      case "enum": if (typeof value !== "string" || !rule.values?.includes(value)) throw new BatteryOpsError("invalid_params", `${name} is not one of the allowed values`); break;
      case "boolean": if (typeof value !== "boolean") throw new BatteryOpsError("invalid_params", `${name} must be true or false`); break;
      case "integer": if (typeof value !== "number" || !Number.isInteger(value) || value < (rule.minimum ?? 0) || value > (rule.maximum ?? 0)) throw new BatteryOpsError("invalid_params", `${name} is out of range`); break;
      case "string": if (typeof value !== "string" || !value || value.length > (rule.maxLength ?? 0)) throw new BatteryOpsError("invalid_params", `${name} must be a short text`); break;
      case "serial": if (typeof value !== "string" || !SERIAL.test(value)) throw new BatteryOpsError("invalid_params", "a serial number is 10 to 24 letters, digits, - or _"); break;
      case "limits": {
        const group = BATTERY_CATALOG.limit_groups.find(item => item.name === values.group);
        if (!group || typeof value !== "object" || value === null || Array.isArray(value)) throw new BatteryOpsError("invalid_params", "limits need a group and its values");
        const given = value as Record<string, unknown>;
        const keys = group.keys.map(pair => pair[0]);
        if (Object.keys(given).sort().join() !== [...keys].sort().join()) throw new BatteryOpsError("invalid_params", "a group of limits is sent whole, with its own names");
        for (const key of keys) {
          const number = given[key];
          if (typeof number !== "number" || !Number.isInteger(number) || number < group.lowest || number > group.highest) throw new BatteryOpsError("invalid_params", `${key} is outside the range the maker's tool states`);
        }
        for (const [low, high] of group.orders) if ((given[low] as number) > (given[high] as number)) throw new BatteryOpsError("invalid_params", `${low} may not be above ${high}`);
        break;
      }
      case "protections": {
        const protections: readonly string[] = BATTERY_CATALOG.protections;
        if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length === 0 || Object.keys(value).length > protections.length) throw new BatteryOpsError("invalid_params", "protections need at least one item");
        for (const [key, state] of Object.entries(value as Record<string, unknown>)) if (!protections.includes(key) || (state !== "en" && state !== "dis")) throw new BatteryOpsError("invalid_params", "a protection is named from the list and set en or dis");
        if (Object.values(value as Record<string, unknown>).includes("dis") && values.accept_risk !== true) throw new BatteryOpsError("invalid_params", "switching a protection off needs the risk accepted");
        break;
      }
      default: throw new BatteryOpsError("invalid_params", "unknown kind of value");
    }
  }
  if (op === "expert_command" && !expertLine(values.line)) throw new BatteryOpsError("invalid_params", "that line may not be sent through the expert console");
  return values;
}

export const validSerial = (serial: unknown): serial is string => typeof serial === "string" && (serial === NO_SERIAL || SERIAL.test(serial));
export const validNode = (node: unknown): node is string => typeof node === "string" && NODE.test(node);

// ---- what a node answers ----------------------------------------------------------------------------------------------------------------------

export type BatteryIdentity = { model: string; serial: string; soft_version: string; board: string; capacity_ah?: number };
export type BatteryResult = {
  kind: "solar_battery_result"; node_id: string; timestamp_ms: number; command_id: string; port: number; action: "arm" | "execute" | "cancel" | "stage"; op?: string;
  stage: "armed" | "started" | "progress" | "cancel_requested" | "final" | "rejected" | "staged"; accepted: boolean; refusal: string; token?: string;
  canonical?: string; summary?: string; risk?: "low" | "medium" | "high" | "irreversible"; atomic?: boolean; battery?: BatteryIdentity; snapshot_before?: string;
  outcome?: "running" | "ok" | "failed" | "partial" | "retry" | "rejected"; code?: string; steps_done?: number; steps_total?: number; writes_done?: number; packets_sent?: number; packets_total?: number;
  truncated?: boolean; before?: string; after?: string; transcript?: string; received?: number;
};

const KNOWN = new Set(["kind", "node_id", "timestamp_ms", "command_id", "port", "action", "op", "stage", "accepted", "refusal", "token", "canonical", "summary", "risk", "atomic", "battery", "snapshot_before", "outcome", "code",
  "steps_done", "steps_total", "writes_done", "packets_sent", "packets_total", "truncated", "before", "after", "transcript", "received"]);
const STAGES = ["armed", "started", "progress", "cancel_requested", "final", "rejected", "staged"];
const TEXT_LIMITS: Record<string, number> = { op: 32, canonical: 600, summary: 300, snapshot_before: 4000, code: 96, before: 4000, after: 4000, transcript: 8000 };

/** The answer of a node, read strictly and with the rules that join its fields (see ARMOR-COMMON's validate_solar_battery_result). */
export function parseBatteryResult(value: unknown): BatteryResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the battery result must be an object");
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!KNOWN.has(key)) throw new Error(`the battery result has an unknown field ${key}`);
  if (body.kind !== "solar_battery_result") throw new Error("invalid kind");
  if (typeof body.node_id !== "string" || !NODE.test(body.node_id)) throw new Error("invalid node_id");
  if (typeof body.timestamp_ms !== "number" || !Number.isInteger(body.timestamp_ms) || body.timestamp_ms < 0) throw new Error("invalid timestamp_ms");
  if (typeof body.command_id !== "string" || !COMMAND_ID.test(body.command_id)) throw new Error("invalid command_id");
  if (typeof body.port !== "number" || !Number.isInteger(body.port) || body.port < 1 || body.port > 10) throw new Error("invalid port");
  if (!["arm", "execute", "cancel", "stage"].includes(body.action as string)) throw new Error("invalid action");
  if (!STAGES.includes(body.stage as string)) throw new Error("invalid stage");
  if (typeof body.accepted !== "boolean") throw new Error("invalid accepted");
  if (typeof body.refusal !== "string" || !BATTERY_REFUSALS.includes(body.refusal)) throw new Error("invalid refusal");
  if (body.accepted !== (body.refusal === "none")) throw new Error("the refusal is none exactly when the order was accepted");
  if ((body.stage === "rejected") === body.accepted) throw new Error("a rejected answer is one that was not accepted");
  if (("token" in body) !== (body.stage === "armed")) throw new Error("a token is given only in the answer to an accepted arm");
  if (body.token !== undefined && (typeof body.token !== "string" || !/^[0-9a-f]{32}$/.test(body.token))) throw new Error("invalid token");
  for (const [key, limit] of Object.entries(TEXT_LIMITS)) if (key in body && (typeof body[key] !== "string" || (body[key] as string).length > limit)) throw new Error(`invalid ${key}`);
  if ("risk" in body && !["low", "medium", "high", "irreversible"].includes(body.risk as string)) throw new Error("invalid risk");
  if ("atomic" in body && typeof body.atomic !== "boolean") throw new Error("invalid atomic");
  if ("truncated" in body && typeof body.truncated !== "boolean") throw new Error("invalid truncated");
  const COUNT_LIMITS: Record<string, number> = { steps_done: 200, steps_total: 200, writes_done: 200, packets_sent: 2048, packets_total: 2048, received: 524_288 };
  for (const [key, limit] of Object.entries(COUNT_LIMITS)) {
    if (key in body && (typeof body[key] !== "number" || !Number.isInteger(body[key]) || (body[key] as number) < 0 || (body[key] as number) > limit)) throw new Error(`invalid ${key}`);
  }
  if ("battery" in body) {
    const battery = body.battery as Record<string, unknown> | null;
    if (typeof battery !== "object" || battery === null || Array.isArray(battery)) throw new Error("invalid battery");
    for (const key of ["model", "serial", "soft_version", "board"]) if (typeof battery[key] !== "string" || (battery[key] as string).length > 32) throw new Error(`invalid battery ${key}`);
    for (const key of Object.keys(battery)) if (!["model", "serial", "soft_version", "board", "capacity_ah"].includes(key)) throw new Error("the battery has an unknown field");
  }
  if (body.stage === "armed" && !(typeof body.canonical === "string" && typeof body.summary === "string" && typeof body.risk === "string" && typeof body.battery === "object")) throw new Error("an armed answer names the operation, its risk and the battery");
  if ("outcome" in body && !["running", "ok", "failed", "partial", "retry", "rejected"].includes(body.outcome as string)) throw new Error("invalid outcome");
  if (body.stage === "progress" && body.outcome !== "running") throw new Error("a progress answer says running");
  if (body.stage === "final" && !["ok", "failed", "partial", "retry", "rejected"].includes(body.outcome as string)) throw new Error("a final answer says how it ended");
  if (body.stage !== "progress" && body.stage !== "final" && "outcome" in body) throw new Error("only progress and final answers carry an outcome");
  if (body.stage === "staged" && typeof body.received !== "number") throw new Error("a staged answer says how much was received");
  if (typeof body.steps_done === "number" && typeof body.steps_total === "number" && body.steps_done > body.steps_total) throw new Error("steps_done may not exceed steps_total");
  return body as unknown as BatteryResult;
}

/** armor/solar/{node_id}/maintenance/{leaf} as node_id, or undefined when the topic is not one. */
export function batteryTopic(topic: string, leaf: "command" | "result"): string | undefined {
  const parts = topic.split("/");
  if (parts.length !== 5 || parts[0] !== "armor" || parts[1] !== "solar" || parts[3] !== "maintenance" || parts[4] !== leaf) return undefined;
  return NODE.test(parts[2]) ? parts[2] : undefined;
}

// ---- a firmware image ----------------------------------------------------------------------------------------------------------------------------

export type ImageInfo = { size: number; crc32: number; sha256: string; board: string; major: number; minor: number; version: string };

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** What the image says about itself: its size, CRC-32, SHA-256, the board it is for (11 bytes at 0x418) and its version (the minor at 0x400, the major at 0x401). Throws a BatteryOpsError when it is not an image of the family. */
export function describeImage(bytes: Buffer): ImageInfo {
  const { image_min_bytes: minimum, image_max_bytes: maximum } = BATTERY_CATALOG.limits;
  if (bytes.length < minimum || bytes.length > maximum) throw new BatteryOpsError("image_size", `a firmware image is ${minimum} to ${maximum} bytes`);
  let board = "";
  for (let index = 0; index < 11; index += 1) {
    const byte = bytes[0x418 + index];
    if (byte === 0) break;
    if (byte < 0x21 || byte > 0x7e) throw new BatteryOpsError("image_header", "that is not a firmware image of the family");
    board += String.fromCharCode(byte);
  }
  if (!board) throw new BatteryOpsError("image_header", "that is not a firmware image of the family");
  const minor = bytes[0x400], major = bytes[0x401];
  return { size: bytes.length, crc32: crc32(bytes), sha256: createHash("sha256").update(bytes).digest("hex"), board, major, minor, version: `${major}.${minor}` };
}

// ---- reads before and after ------------------------------------------------------------------------------------------------------------------------

export type Difference = { label: string; before: string; after: string };

function sections(text: string): Map<string, string> {
  const found = new Map<string, string>();
  let label = "", lines: string[] = [];
  const close = () => { if (label) found.set(label, lines.join("\n").trim()); };
  for (const line of text.split(/\r?\n/)) {
    const head = /^## (.+)$/.exec(line);
    if (head) { close(); label = head[1]; lines = []; } else lines.push(line);
  }
  close();
  return found;
}

/** The reads taken after the writes (the sections of `after`) that differ from the same read before, for the person to see what an operation changed; a read that was not taken before is a difference too. */
export function differences(before: string, after: string): Difference[] {
  const left = sections(before), right = sections(after);
  const out: Difference[] = [];
  for (const label of right.keys()) {
    const a = left.get(label) ?? "", b = right.get(label) ?? "";
    if (a !== b) out.push({ label, before: a.slice(0, 1200), after: b.slice(0, 1200) });
  }
  return out;
}

/** The state an output had in a read: the section "## output" of the text before, a line like "cfet   : ON". undefined when the read does not say. */
export function outputBefore(before: string, output: string): "on" | "off" | undefined {
  const text = sections(before).get("output");
  if (!text) return undefined;
  const found = new RegExp(`^\\s*${output}\\s*:\\s*(ON|OFF)\\b`, "im").exec(text);
  return found ? (found[1].toUpperCase() === "ON" ? "on" : "off") : undefined;
}

// ---- an order, as the server itself builds it (checked before it is published, and against the shared vectors) -------------------------------------------------------------

export type BatteryCommand = {
  kind: "solar_battery_command"; node_id: string; timestamp_ms: number; command_id: string; port: number; action: "arm" | "execute" | "cancel" | "stage";
  op?: string; params?: Record<string, unknown>; serial?: string; token?: string;
  stage?: { id: string; index: number; total: number; size: number; crc32: number; data: string };
};

const COMMAND_FIELDS = new Set(["kind", "node_id", "timestamp_ms", "command_id", "port", "action", "op", "params", "serial", "token", "stage"]);
const NEEDS: Record<string, string[]> = { arm: ["op", "serial"], execute: ["op", "serial", "token"], cancel: [], stage: ["stage"] };

/** An order, read as strictly as ARMOR-COMMON's validate_solar_battery_command does. */
export function parseBatteryCommand(value: unknown): BatteryCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the order must be an object");
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!COMMAND_FIELDS.has(key)) throw new Error(`the order has an unknown field ${key}`);
  if (body.kind !== "solar_battery_command") throw new Error("invalid kind");
  if (typeof body.node_id !== "string" || !NODE.test(body.node_id)) throw new Error("invalid node_id");
  if (typeof body.timestamp_ms !== "number" || !Number.isInteger(body.timestamp_ms) || body.timestamp_ms < 0) throw new Error("invalid timestamp_ms");
  if (typeof body.command_id !== "string" || !COMMAND_ID.test(body.command_id)) throw new Error("invalid command_id");
  if (typeof body.port !== "number" || !Number.isInteger(body.port) || body.port < 1 || body.port > 10) throw new Error("invalid port");
  if (typeof body.action !== "string" || !(body.action in NEEDS)) throw new Error("invalid action");
  const needs = NEEDS[body.action];
  const allowed = [...needs, ...(body.action === "arm" || body.action === "execute" ? ["params"] : [])];
  const present = ["op", "params", "serial", "token", "stage"].filter(key => key in body);
  if (!needs.every(key => present.includes(key)) || !present.every(key => allowed.includes(key))) throw new Error(`a ${body.action} carries ${allowed.join(", ") || "nothing more"}`);
  if ("serial" in body && (typeof body.serial !== "string" || !/^[A-Za-z0-9_-]{8,24}$/.test(body.serial))) throw new Error("invalid serial");
  if ("token" in body && (typeof body.token !== "string" || !/^[0-9a-f]{32}$/.test(body.token))) throw new Error("invalid token");
  if ("op" in body) {
    if (typeof body.op !== "string" || !BATTERY_OP_IDS.includes(body.op)) throw new Error("invalid op");
    validateBatteryParams(body.op, body.params ?? {});
  }
  if ("stage" in body) {
    const piece = body.stage as Record<string, unknown> | null;
    if (typeof piece !== "object" || piece === null || Array.isArray(piece)) throw new Error("invalid stage");
    for (const key of Object.keys(piece)) if (!["id", "index", "total", "size", "crc32", "data"].includes(key)) throw new Error("the piece has an unknown field");
    const whole = (key: string, low: number, high: number) => { const n = piece[key]; if (typeof n !== "number" || !Number.isInteger(n) || n < low || n > high) throw new Error(`invalid ${key}`); };
    if (typeof piece.id !== "string" || !COMMAND_ID.test(piece.id)) throw new Error("invalid id");
    whole("index", 0, 2047); whole("total", 1, 2048); whole("size", BATTERY_CATALOG.limits.image_min_bytes, BATTERY_CATALOG.limits.image_max_bytes); whole("crc32", 0, 4_294_967_295);
    if (typeof piece.data !== "string" || piece.data.length < 4 || piece.data.length > 344 || !/^[A-Za-z0-9+/]+={0,2}$/.test(piece.data)) throw new Error("invalid data");
  }
  return body as unknown as BatteryCommand;
}
