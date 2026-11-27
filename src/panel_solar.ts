/**
 * What a small wall screen reads of the solar equipment (GET /api/v1/panel/solar and below): the same field names as GET /api/v1/solar, but cut down so that one answer stays well under
 * what the reader of a node takes (64 KB, 4096 values): a list of devices with their figures, then one device at a time with its modules and cells, and a history of a few points.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { SolarDeviceView, SolarSample } from "./solar.js";

/** The most devices a list names; the screen is told how many it does not see. */
export const PANEL_MAX_DEVICES = 32;
/** The most points of a history. */
export const PANEL_HISTORY_POINTS = 96;
/** The most minutes of history a screen may ask for (one day). */
export const PANEL_HISTORY_MINUTES = 1440;

const BATTERY_SUMMARY = ["kind", "model", "state", "alarm", "protecting", "modules", "soc_percent", "voltage_v", "current_a", "power_w", "capacity_ah", "full_capacity_ah", "energy_kwh",
  "temperature_min_c", "temperature_max_c", "cell_min_v", "cell_max_v", "manufacturer", "manufacturer_source"] as const;
const INVERTER_SUMMARY = ["kind", "mode", "grid_v", "out_w", "load_percent", "battery_v", "battery_a", "battery_percent", "pv_w", "heatsink_c", "warnings"] as const;
// A list of what is given, not of what is left out: a field added to the reading (a serial number is private) never reaches a wall screen by itself.
const MODULE_FIELDS = ["n", "present", "model", "state", "voltage_v", "current_a", "temperature_c", "soc_percent", "cells_v", "temperatures_c", "capacity_ah", "full_capacity_ah", "cycles",
  "health_percent", "counters", "manufacturer", "manufacturer_source", "flags", "cells_unread", "left_out"] as const;
/** The most states of one module a wall screen is given (an answer must stay under its limit of values). */
const PANEL_MAX_FLAGS = 8;

const pick = (source: object, fields: readonly string[]): Record<string, unknown> => {
  const from = source as Record<string, unknown>;
  return Object.fromEntries(fields.filter(field => from[field] !== undefined).map(field => [field, from[field]]));
};

export type PanelSolarDevice = { node_id: string; device: string; kind: "inverter" | "battery"; stale: boolean; example: boolean; received_at: string; name?: string; reading: Record<string, unknown> };

function entry(view: SolarDeviceView, reading: Record<string, unknown>, name: string | undefined): PanelSolarDevice {
  return { node_id: view.node_id, device: view.device, kind: view.kind, stale: view.stale, example: view.example, received_at: view.received_at, ...(name ? { name } : {}), reading };
}

/** The list: every device with its own figures and none of the modules. */
export function panelDevices(views: readonly SolarDeviceView[], nameOf: (node: string, device: string) => string | undefined): { devices: PanelSolarDevice[]; omitted: number } {
  const devices = views.slice(0, PANEL_MAX_DEVICES).map(view => entry(view, pick(view.reading, view.kind === "battery" ? BATTERY_SUMMARY : INVERTER_SUMMARY), nameOf(view.node_id, view.device)));
  return { devices, omitted: Math.max(0, views.length - PANEL_MAX_DEVICES) };
}

/** One device whole as far as a screen draws it: a battery with its modules and cells, without the texts of the versions and the events. */
export function panelDevice(view: SolarDeviceView, name: string | undefined): PanelSolarDevice {
  if (view.reading.kind !== "battery") return entry(view, pick(view.reading, INVERTER_SUMMARY), name);
  const stack = view.reading.stack.slice(0, 16).map(module => {
    const out = pick(module, MODULE_FIELDS);
    if (module.flags) out.flags = module.flags.slice(0, PANEL_MAX_FLAGS);
    return out;
  });
  return entry(view, { ...pick(view.reading, BATTERY_SUMMARY), stack }, name);
}

/** At most `most` samples, evenly spread, the newest always among them. */
export function thinHistory(samples: readonly SolarSample[], most: number = PANEL_HISTORY_POINTS): SolarSample[] {
  if (samples.length <= most) return [...samples];
  const step = samples.length / most;
  return Array.from({ length: most }, (_, index) => samples[Math.min(samples.length - 1, Math.floor((index + 1) * step) - 1)]);
}
