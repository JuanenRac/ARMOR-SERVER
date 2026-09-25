/**
 * The kinds of device A.R.M.O.R. knows how to supervise and control, the state each one reports, and what counts as an alarm for it.
 * A device speaks in a few canonical fields, whatever its make or radio: `triggered`, `open`, `on`, `locked`, `tamper` (true / false)
 * and numbers such as `temperature`, `humidity`, `battery`. A device's own payload is translated into these (see `mapping.ts`).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export type Severity = "critical" | "high" | "warning";

export type KindInfo = {
  category: "sensor" | "actuator";
  /** When a triggering state is an alarm: "always" (fire, gas, flood, panic), "armed" (intrusion: only while the system is armed) or never. */
  alarm: "always" | "armed" | "none";
  severity: Severity;
  /** The canonical field that says the device is triggered, and the value that means it is. */
  trigger?: { field: "triggered" | "open"; value: true };
  /** Commands an actuator understands. */
  commands: readonly ("on" | "off" | "toggle")[];
};

export const DEVICE_KINDS = {
  // sensors that mean danger at any time
  smoke: { category: "sensor", alarm: "always", severity: "critical", trigger: { field: "triggered", value: true }, commands: [] },
  co: { category: "sensor", alarm: "always", severity: "critical", trigger: { field: "triggered", value: true }, commands: [] },
  gas: { category: "sensor", alarm: "always", severity: "critical", trigger: { field: "triggered", value: true }, commands: [] },
  water_leak: { category: "sensor", alarm: "always", severity: "high", trigger: { field: "triggered", value: true }, commands: [] },
  panic_button: { category: "sensor", alarm: "always", severity: "critical", trigger: { field: "triggered", value: true }, commands: [] },
  // sensors that mean intrusion, while the system is armed
  door: { category: "sensor", alarm: "armed", severity: "high", trigger: { field: "open", value: true }, commands: [] },
  window: { category: "sensor", alarm: "armed", severity: "high", trigger: { field: "open", value: true }, commands: [] },
  motion: { category: "sensor", alarm: "armed", severity: "high", trigger: { field: "triggered", value: true }, commands: [] },
  glass_break: { category: "sensor", alarm: "armed", severity: "high", trigger: { field: "triggered", value: true }, commands: [] },
  vibration: { category: "sensor", alarm: "armed", severity: "warning", trigger: { field: "triggered", value: true }, commands: [] },
  // measuring sensors
  climate: { category: "sensor", alarm: "none", severity: "warning", commands: [] },
  temperature: { category: "sensor", alarm: "none", severity: "warning", commands: [] },
  humidity: { category: "sensor", alarm: "none", severity: "warning", commands: [] },
  light_level: { category: "sensor", alarm: "none", severity: "warning", commands: [] },
  // things A.R.M.O.R. can switch
  smart_plug: { category: "actuator", alarm: "none", severity: "warning", commands: ["on", "off", "toggle"] },
  smart_light: { category: "actuator", alarm: "none", severity: "warning", commands: ["on", "off", "toggle"] },
  smart_switch: { category: "actuator", alarm: "none", severity: "warning", commands: ["on", "off", "toggle"] },
  siren: { category: "actuator", alarm: "none", severity: "warning", commands: ["on", "off"] },
  lock: { category: "actuator", alarm: "none", severity: "warning", commands: ["on", "off"] },
  valve: { category: "actuator", alarm: "none", severity: "warning", commands: ["on", "off"] },
} as const satisfies Record<string, KindInfo>;

export type DeviceKind = keyof typeof DEVICE_KINDS;
export const KIND_LIST = Object.keys(DEVICE_KINDS) as DeviceKind[];
export const isKind = (value: unknown): value is DeviceKind => typeof value === "string" && Object.hasOwn(DEVICE_KINDS, value);
export const kindInfo = (kind: DeviceKind): KindInfo => DEVICE_KINDS[kind];

export const PROTOCOLS = ["wifi", "bluetooth", "zigbee", "zwave", "thread", "lora", "rf433", "wired", "other"] as const;
export type Protocol = (typeof PROTOCOLS)[number];
export const isProtocol = (value: unknown): value is Protocol => typeof value === "string" && (PROTOCOLS as readonly string[]).includes(value);

export type StateValue = boolean | number;
export type DeviceState = Record<string, StateValue>;

/** Every field a device may report, with its type and range: anything else in a report is dropped, so a device cannot fill the registry with junk. */
const FIELDS: Record<string, { type: "boolean" } | { type: "number"; min: number; max: number }> = {
  triggered: { type: "boolean" }, open: { type: "boolean" }, on: { type: "boolean" }, locked: { type: "boolean" }, tamper: { type: "boolean" },
  temperature: { type: "number", min: -80, max: 200 }, humidity: { type: "number", min: 0, max: 100 }, battery: { type: "number", min: 0, max: 100 },
  brightness: { type: "number", min: 0, max: 100 }, power_w: { type: "number", min: 0, max: 100000 }, energy_kwh: { type: "number", min: 0, max: 10_000_000 },
  lux: { type: "number", min: 0, max: 200000 }, rssi: { type: "number", min: -150, max: 0 }, co_ppm: { type: "number", min: 0, max: 10000 },
};
export const STATE_FIELDS = Object.keys(FIELDS);

/** Keep the known fields with valid values; numbers are rounded to two decimals. */
export function cleanState(input: unknown): DeviceState {
  const state: DeviceState = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) return state;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const field = FIELDS[key];
    if (!field) continue;
    if (field.type === "boolean" && typeof value === "boolean") state[key] = value;
    else if (field.type === "number" && typeof value === "number" && Number.isFinite(value) && value >= field.min && value <= field.max) state[key] = Math.round(value * 100) / 100;
  }
  return state;
}

/** Whether a device in this state is triggered (its kind's trigger field has the alarming value). */
export function isTriggered(kind: DeviceKind, state: DeviceState): boolean {
  const trigger = kindInfo(kind).trigger;
  return Boolean(trigger && state[trigger.field] === trigger.value);
}
