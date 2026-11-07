/**
 * A.R.M.O.R. trusted boundary validation. These parsers implement the published
 * contracts in ARMOR-COMMON exactly; tests/conformance.test.ts runs the shared
 * vectors against them so the two can not drift apart.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { checkMessage, type MessageName } from "./armor-parsers.js";
import { MAX_LUX, MAX_TARGETS, NODE_ID_PATTERN, type Health, type Info, type RadarTrack, type Telemetry } from "./armor-contracts.js";
/** The shapes of the messages and their limits are the ones ARMOR-COMMON generates from its schemas (src/armor-contracts.ts is that file; tests/conformance.test.ts keeps them equal). */
export type { Health, Info, RadarTrack, Telemetry };
export { MAX_LUX, MAX_TARGETS };

const nodeId = NODE_ID_PATTERN;
export const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const integer = (value: unknown): value is number => finite(value) && Number.isInteger(value);

export const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be an object`);
  return value as Record<string, unknown>;
};

/** While a message from a node is read for live use (see `forwardCompatible`), the fields this server does not know are collected here instead of refusing the message. */
let ignoredFields: string[] | null = null;

/** Refuse any field the contract does not define (additionalProperties: false); in forward-compatible reading, drop it and say so instead. */
/** (What can move a switch is never read forgivingly: a field called command or commands, the objects of a switch, and commands and results are always exact.) */
const ALWAYS_EXACT = /^switch |command$|result$/;
export const onlyKnown = (body: Record<string, unknown>, allowed: readonly string[], what: string): void => {
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    if (ignoredFields === null || key === "command" || key === "commands" || ALWAYS_EXACT.test(what)) throw new Error(`${what} has an unknown field: ${key}`);
    ignoredFields.push(`${what}.${key}`);
    delete body[key];
  }
};

/**
 * Reads a message of a node for live use: a field this server's contract does not define (a node with newer firmware than the server) is dropped and reported in `ignored`
 * instead of making the whole message refused. Everything the server does know is checked exactly as always, so a missing field, a wrong type or a number out of range is still refused.
 * The conformance tests use the plain parsers, which stay strict.
 */
export function forwardCompatible<T>(read: () => T): { value: T; ignored: string[] } {
  const outer = ignoredFields;
  ignoredFields = [];
  try { const value = read(); return { value, ignored: ignoredFields }; } finally { ignoredFields = outer; }
}

export const readNodeId = (body: Record<string, unknown>): string => {
  if (typeof body.node_id !== "string" || !nodeId.test(body.node_id)) throw new Error("invalid node_id");
  return body.node_id;
};

export const readTimestamp = (body: Record<string, unknown>): number => {
  if (!integer(body.timestamp_ms) || body.timestamp_ms < 0) throw new Error("invalid timestamp_ms");
  return body.timestamp_ms;
};

/** Checks a message (after the fields this server does not know were dropped) with the reader that ARMOR-COMMON generates from the schema; the refusal names the first wrong field, like `invalid lux`. */
export function checkAgainstContract(name: MessageName, body: Record<string, unknown>): void {
  const error = checkMessage(name, body);
  if (error) throw new Error(`invalid ${error.path.replace(/^\//, "").replace(/\//g, ".") || name}`);
}

function parseTrack(value: unknown, index: number): RadarTrack {
  const track = record(value, `target ${index}`);
  onlyKnown(track, ["sensor_id", "track_id", "x_mm", "y_mm", "speed_mm_s"], `target ${index}`);
  for (const key of ["x_mm", "y_mm", "speed_mm_s"] as const) if (!finite(track[key])) throw new Error(`invalid target ${index}.${key}`);
  const { sensor_id: sensorId, track_id: trackId } = track;
  if (!integer(sensorId) || sensorId < 1 || sensorId > 3 || !integer(trackId) || trackId < 1) throw new Error(`invalid target ${index} identifier`);
  return { sensor_id: sensorId, track_id: trackId, x_mm: track.x_mm as number, y_mm: track.y_mm as number, speed_mm_s: track.speed_mm_s as number };
}

/** A message may say its own kind (the contract allows it since 0.8.0.6 of ARMOR-COMMON), and then it has to be the kind of the topic it came on. */
function ownKind(body: Record<string, unknown>, expected: string): void {
  if ("kind" in body && body.kind !== expected) throw new Error("invalid kind");
}

export function parseTelemetry(value: unknown): Telemetry {
  const body = record(value, "telemetry");
  onlyKnown(body, ["node_id", "timestamp_ms", "lux", "targets", "kind"], "telemetry");
  ownKind(body, "telemetry");
  checkAgainstContract("telemetry", body);
  const targets = (body.targets as unknown[]).map(parseTrack);
  return { node_id: body.node_id as string, timestamp_ms: body.timestamp_ms as number, lux: body.lux as number, targets };
}

export function parseHealth(value: unknown): Health {
  const body = record(value, "health");
  onlyKnown(body, ["node_id", "timestamp_ms", "online", "kind"], "health");
  checkAgainstContract("health", body);
  return { node_id: body.node_id as string, timestamp_ms: body.timestamp_ms as number, online: body.online as boolean, ...(body.kind === "panel" ? { kind: "panel" as const } : {}) };
}

export const MAX_NAME = 48;

export function parseInfo(value: unknown): Info {
  const body = record(value, "info");
  onlyKnown(body, ["node_id", "timestamp_ms", "name", "firmware", "ip", "port", "kind", "contract"], "info");
  ownKind(body, "info");
  checkAgainstContract("info", body);
  return { node_id: body.node_id as string, timestamp_ms: body.timestamp_ms as number, name: body.name as string, firmware: body.firmware as string, ip: body.ip as string, port: body.port as number, ...(body.contract === undefined ? {} : { contract: body.contract as string }) };
}
