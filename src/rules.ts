/**
 * A.R.M.O.R. alert rules: how long a condition must persist before it
 * escalates, and rectangular zones whose targets are ignored (a road, a tree
 * that sways). Zone coordinates are in the reporting sensor's own frame.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";

export type Zone = {
  id: string; name: string;
  node_id?: string; sensor_id?: number;
  x_min_mm: number; x_max_mm: number; y_min_mm: number; y_max_mm: number;
  action: "ignore";
};
export type Rules = { schema: 1; dwell_ms: number; zones: Zone[] };

export const MAX_ZONES = 64;
export const MAX_DWELL_MS = 60_000;
const ZONE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COORDINATE_LIMIT = 100_000;
const ZONE_KEYS = new Set(["id", "name", "node_id", "sensor_id", "x_min_mm", "x_max_mm", "y_min_mm", "y_max_mm", "action"]);

export const defaultRules = (dwellMs = 0): Rules => ({ schema: 1, dwell_ms: dwellMs, zones: [] });

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= COORDINATE_LIMIT;

/** Strict validation: unknown fields, bad ranges and inverted rectangles are refused. */
export function parseRules(body: unknown): Rules | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "schema" && key !== "dwell_ms" && key !== "zones")) return null;
  if (input.schema !== undefined && input.schema !== 1) return null;
  const dwell = input.dwell_ms;
  if (typeof dwell !== "number" || !Number.isInteger(dwell) || dwell < 0 || dwell > MAX_DWELL_MS) return null;
  if (!Array.isArray(input.zones) || input.zones.length > MAX_ZONES) return null;
  const zones: Zone[] = [];
  const seen = new Set<string>();
  for (const raw of input.zones) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const zone = raw as Record<string, unknown>;
    if (Object.keys(zone).some(key => !ZONE_KEYS.has(key))) return null;
    if (typeof zone.id !== "string" || !ZONE_ID.test(zone.id) || seen.has(zone.id)) return null;
    if (typeof zone.name !== "string" || !zone.name.trim() || zone.name.length > 80) return null;
    if (zone.action !== "ignore") return null;
    if (zone.node_id !== undefined && (typeof zone.node_id !== "string" || !NODE_ID.test(zone.node_id))) return null;
    if (zone.sensor_id !== undefined && (typeof zone.sensor_id !== "number" || !Number.isInteger(zone.sensor_id) || zone.sensor_id < 1 || zone.sensor_id > 3)) return null;
    if (![zone.x_min_mm, zone.x_max_mm, zone.y_min_mm, zone.y_max_mm].every(finite)) return null;
    if ((zone.x_min_mm as number) >= (zone.x_max_mm as number) || (zone.y_min_mm as number) >= (zone.y_max_mm as number)) return null;
    seen.add(zone.id);
    zones.push({
      id: zone.id, name: zone.name.trim(), action: "ignore",
      ...(zone.node_id !== undefined ? { node_id: zone.node_id as string } : {}),
      ...(zone.sensor_id !== undefined ? { sensor_id: zone.sensor_id as number } : {}),
      x_min_mm: zone.x_min_mm as number, x_max_mm: zone.x_max_mm as number, y_min_mm: zone.y_min_mm as number, y_max_mm: zone.y_max_mm as number,
    });
  }
  return { schema: 1, dwell_ms: dwell, zones };
}

export type TargetPoint = { sensor_id: number; x_mm: number; y_mm: number };

/** True when a target counts toward the alert level (it is in no ignore zone). */
export function targetCounts(rules: Rules, nodeId: string, target: TargetPoint): boolean {
  return !rules.zones.some(zone =>
    (zone.node_id === undefined || zone.node_id === nodeId) &&
    (zone.sensor_id === undefined || zone.sensor_id === target.sensor_id) &&
    target.x_mm >= zone.x_min_mm && target.x_mm <= zone.x_max_mm &&
    target.y_mm >= zone.y_min_mm && target.y_mm <= zone.y_max_mm);
}

/** The rules, kept in one atomically written file. A damaged file falls back to the defaults. */
export class RulesFile {
  readonly #file: string;
  #rules: Rules;

  constructor(file: string, defaultDwellMs: number, warn: (message: string) => void = () => undefined) {
    this.#file = file;
    this.#rules = defaultRules(defaultDwellMs);
    try {
      const parsed = parseRules(JSON.parse(fs.readFileSync(file, "utf8")));
      if (parsed) this.#rules = parsed;
      else warn("rules.json is invalid; using the default rules");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn("rules.json could not be read; using the default rules");
    }
  }

  get(): Rules { return this.#rules; }

  set(rules: Rules): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(rules, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.#file);
    this.#rules = rules;
  }
}
