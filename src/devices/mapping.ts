/**
 * Turns what a device publishes into the canonical state: a dotted path into its JSON payload (or the whole payload, for a device that
 * sends a bare word such as ON) is read, converted to a boolean or number, and optionally inverted. Presets for common ecosystems
 * (Zigbee2MQTT, Tasmota, Shelly, ESPHome) are only sets of these entries, chosen in Studio.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { cleanState, STATE_FIELDS, type DeviceState } from "./catalog.js";

export type MapEntry = { field: string; path: string; invert?: boolean };
export const MAX_MAP_ENTRIES = 12;

const TRUE_WORDS = new Set(["on", "true", "1", "open", "opened", "detected", "alarm", "triggered", "motion", "wet", "leak", "active", "pressed", "smoke", "gas"]);
const FALSE_WORDS = new Set(["off", "false", "0", "closed", "clear", "cleared", "normal", "no_motion", "dry", "inactive", "idle", "released", "safe"]);

/** The value at a dotted path ("contact", "sensor.temperature", "a.0.b"); "$" is the whole payload. */
export function readPath(payload: unknown, path: string): unknown {
  if (path === "$" || path === "") return payload;
  let current: unknown = payload;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** For a lock the words mean the opposite way round: "locked" is true. */
const LOCK_TRUE = new Set(["locked", "lock", "true", "1", "on"]), LOCK_FALSE = new Set(["unlocked", "unlock", "false", "0", "off"]);
export function toLockBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") { const word = value.trim().toLowerCase(); if (LOCK_TRUE.has(word)) return true; if (LOCK_FALSE.has(word)) return false; }
  return undefined;
}

export function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
  }
  return undefined;
}

const BOOLEAN_FIELDS = new Set(["triggered", "open", "on", "locked", "tamper"]);

/** Parse an MQTT payload: JSON when it is JSON, otherwise the trimmed text. */
export function parsePayload(raw: Buffer | string): unknown {
  const text = (typeof raw === "string" ? raw : raw.toString("utf8")).trim();
  if (text.length > 4096) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * The canonical state in a payload. Without a map, a JSON object that already uses the canonical names is taken as it is; with one,
 * only the mapped fields are read.
 */
export function stateFromPayload(payload: unknown, map: readonly MapEntry[] | undefined): DeviceState {
  if (!map || map.length === 0) return cleanState(payload);
  const raw: Record<string, unknown> = {};
  for (const entry of map.slice(0, MAX_MAP_ENTRIES)) {
    if (!STATE_FIELDS.includes(entry.field)) continue;
    const value = readPath(payload, entry.path);
    if (value === undefined) continue;
    if (BOOLEAN_FIELDS.has(entry.field)) {
      const flag = entry.field === "locked" ? toLockBoolean(value) : toBoolean(value);
      if (flag !== undefined) raw[entry.field] = entry.invert ? !flag : flag;
    } else {
      const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (Number.isFinite(number)) raw[entry.field] = number;
    }
  }
  return cleanState(raw);
}

/** A map entry the operator typed, checked. */
export function cleanMap(input: unknown): MapEntry[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const entries: MapEntry[] = [];
  for (const item of input.slice(0, MAX_MAP_ENTRIES)) {
    const entry = item as Partial<MapEntry>;
    if (typeof entry?.field === "string" && STATE_FIELDS.includes(entry.field) && typeof entry.path === "string" && entry.path.length <= 80 && /^(\$|[A-Za-z0-9_.-]*)$/.test(entry.path)) {
      entries.push({ field: entry.field, path: entry.path, ...(entry.invert === true ? { invert: true } : {}) });
    }
  }
  return entries;
}
