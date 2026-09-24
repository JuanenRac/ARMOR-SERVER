/**
 * A.R.M.O.R. trusted boundary validation. These parsers implement the published
 * contracts in ARMOR-COMMON exactly; tests/conformance.test.ts runs the shared
 * vectors against them so the two can not drift apart.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export type RadarTrack = { sensor_id: number; track_id: number; x_mm: number; y_mm: number; speed_mm_s: number };
export type Telemetry = { node_id: string; timestamp_ms: number; lux: number; targets: RadarTrack[] };
export type Health = { node_id: string; timestamp_ms: number; online: boolean };

export const MAX_TARGETS = 15;
export const MAX_LUX = 200_000;
const nodeId = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown): value is number => finite(value) && Number.isInteger(value);

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be an object`);
  return value as Record<string, unknown>;
};

/** Refuse any field the contract does not define (additionalProperties: false). */
const onlyKnown = (body: Record<string, unknown>, allowed: readonly string[], what: string): void => {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new Error(`${what} has an unknown field: ${key}`);
};

const readNodeId = (body: Record<string, unknown>): string => {
  if (typeof body.node_id !== "string" || !nodeId.test(body.node_id)) throw new Error("invalid node_id");
  return body.node_id;
};

const readTimestamp = (body: Record<string, unknown>): number => {
  if (!integer(body.timestamp_ms) || body.timestamp_ms < 0) throw new Error("invalid timestamp_ms");
  return body.timestamp_ms;
};

function parseTrack(value: unknown, index: number): RadarTrack {
  const track = record(value, `target ${index}`);
  onlyKnown(track, ["sensor_id", "track_id", "x_mm", "y_mm", "speed_mm_s"], `target ${index}`);
  for (const key of ["x_mm", "y_mm", "speed_mm_s"] as const) if (!finite(track[key])) throw new Error(`invalid target ${index}.${key}`);
  const { sensor_id: sensorId, track_id: trackId } = track;
  if (!integer(sensorId) || sensorId < 1 || sensorId > 3 || !integer(trackId) || trackId < 1) throw new Error(`invalid target ${index} identifier`);
  return { sensor_id: sensorId, track_id: trackId, x_mm: track.x_mm as number, y_mm: track.y_mm as number, speed_mm_s: track.speed_mm_s as number };
}

export function parseTelemetry(value: unknown): Telemetry {
  const body = record(value, "telemetry");
  onlyKnown(body, ["node_id", "timestamp_ms", "lux", "targets"], "telemetry");
  const node = readNodeId(body);
  const timestamp = readTimestamp(body);
  if (!finite(body.lux) || body.lux < 0 || body.lux > MAX_LUX) throw new Error("invalid lux");
  if (!Array.isArray(body.targets) || body.targets.length > MAX_TARGETS) throw new Error("invalid targets");
  return { node_id: node, timestamp_ms: timestamp, lux: body.lux, targets: body.targets.map(parseTrack) };
}

export function parseHealth(value: unknown): Health {
  const body = record(value, "health");
  onlyKnown(body, ["node_id", "timestamp_ms", "online"], "health");
  const node = readNodeId(body);
  const timestamp = readTimestamp(body);
  if (typeof body.online !== "boolean") throw new Error("invalid online flag");
  return { node_id: node, timestamp_ms: timestamp, online: body.online };
}
