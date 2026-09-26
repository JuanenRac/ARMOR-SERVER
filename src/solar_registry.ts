/**
 * The solar equipment an operator declares in Studio (an inverter or a battery stack, its model, how it is connected and which gateway node reads it),
 * kept in a file so it survives a restart, and the example readings that let the menus be tried before a real gateway node reports.
 * A declared device shows as "waiting" until its gateway node sends the first real reading.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { parseSolarMessage, type SolarMessage } from "./solar.js";

/**
 * The inverter families the projects that speak to them list (mpp-solar, esphome-pipsolar and others), with the dialect of the serial protocol each one answers in, which
 * is what a gateway node's port has to be set to ("auto" lets the node look for it). A family is a name for a group of look-alike models, not a promise that every unit of it
 * answers: none has been connected yet.
 */
export type InverterDialect = "auto" | "pi30" | "revo" | "pi18";
export const INVERTER_FAMILIES: Record<string, { label: string; dialect: InverterDialect }> = {
  voltronic: { label: "Voltronic (Axpert, PIP)", dialect: "auto" },
  "mpp-solar": { label: "MPP Solar (Axpert, PIP, InfiniSolar)", dialect: "auto" },
  "axpert-vm-ii": { label: "Voltronic Axpert VM II", dialect: "pi30" },
  "axpert-vm-iii": { label: "Voltronic Axpert VM III", dialect: "pi30" },
  "axpert-mks": { label: "Voltronic Axpert MKS / MKS II", dialect: "pi30" },
  "axpert-mks-iv": { label: "Voltronic Axpert MKS IV / MKS V", dialect: "pi30" },
  "axpert-king": { label: "Voltronic Axpert King", dialect: "pi30" },
  "pip-ms": { label: "MPP Solar PIP MS / MSD / MSE / MSX", dialect: "pi30" },
  "pip-hs": { label: "MPP Solar PIP HS / HSE / LV", dialect: "pi30" },
  "pip-gk": { label: "MPP Solar PIP-GK / MK", dialect: "pi30" },
  "easun-isolar": { label: "EASun iSolar SMG II / SMH II", dialect: "pi30" },
  "must-ph18": { label: "Must PV18 / PH18 (PI30 compatible)", dialect: "pi30" },
  "revo-vm-iii": { label: "Revo VM III / Revo II (checksum replies)", dialect: "revo" },
  "infinisolar-v": { label: "MPP Solar InfiniSolar V", dialect: "pi18" },
  "lv5048-hybrid": { label: "MPP Solar LV5048 Hybrid / LV6048", dialect: "pi18" },
  "sungoldpower": { label: "SunGoldPower SPH / SPF hybrid", dialect: "pi18" },
};
export const INVERTER_MODELS = [...Object.keys(INVERTER_FAMILIES), "other"] as const;

/** What a battery model is like: modules of how many cells and ampere-hours, and how many modules an example shows. (Only the example readings use the numbers.) */
type BatteryShape = { modules: number; cells: number; ah: number; label: string };
export const BATTERY_FAMILIES: Record<string, BatteryShape> = {
  "pylontech-us2000": { modules: 2, cells: 15, ah: 50, label: "Pylontech US2000 / US2000B" },
  "pylontech-us2000c": { modules: 2, cells: 15, ah: 50, label: "Pylontech US2000C" },
  "pylontech-us2000b-plus": { modules: 2, cells: 15, ah: 50, label: "Pylontech US2000B Plus" },
  "pylontech-us2kbpl": { modules: 2, cells: 15, ah: 50, label: "Pylontech US2KBPL" },
  "pylontech-us3000": { modules: 2, cells: 15, ah: 74, label: "Pylontech US3000" },
  "pylontech-us3000c": { modules: 2, cells: 15, ah: 74, label: "Pylontech US3000C" },
  "pylontech-us5000": { modules: 3, cells: 15, ah: 100, label: "Pylontech US5000" },
  "pylontech-up2500": { modules: 2, cells: 16, ah: 50, label: "Pylontech UP2500" },
  "pylontech-up5000": { modules: 2, cells: 16, ah: 100, label: "Pylontech UP5000" },
  "pylontech-force-l1": { modules: 2, cells: 15, ah: 74, label: "Pylontech Force L1" },
  "pylontech-force-l2": { modules: 2, cells: 15, ah: 142, label: "Pylontech Force L2" },
  "pytes-e-box": { modules: 2, cells: 16, ah: 100, label: "Pytes E-Box 48100R" },
  "ant-bms": { modules: 1, cells: 16, ah: 100, label: "ANT-BMS (own battery)" },
  other: { modules: 1, cells: 15, ah: 100, label: "Battery" },
};

/**
 * ANT-BMS units differ in the number of cells they watch (a 16S watches sixteen) and the current they carry: `ant-bms-<cells>s-<amps>a`. They all speak the same protocol, so the
 * catalogue offers the usual combinations as presets and any other combination within the limits is accepted.
 */
export const ANT_CELL_COUNTS = [4, 7, 8, 10, 12, 13, 14, 15, 16, 20, 24, 32] as const;
export const ANT_CURRENTS = [40, 60, 100, 120, 150, 200, 250, 300] as const;
const ANT_MODEL = /^ant-bms-(\d{1,2})s-(\d{2,3})a$/;
/** The cells and the rated current a `ant-bms-<cells>s-<amps>a` model names, or undefined when it is not one (or is out of range). */
export function antVariant(model: string): { cells: number; amps: number } | undefined {
  const found = ANT_MODEL.exec(model);
  if (!found) return undefined;
  const cells = Number(found[1]), amps = Number(found[2]);
  return cells >= 4 && cells <= 32 && amps >= 20 && amps <= 500 ? { cells, amps } : undefined;
}
const ANT_PRESETS = ANT_CELL_COUNTS.flatMap(cells => ANT_CURRENTS.map(amps => `ant-bms-${cells}s-${amps}a`));
export const BATTERY_MODELS = [...Object.keys(BATTERY_FAMILIES).filter(id => id !== "other"), ...ANT_PRESETS, "other"] as const;

/** A model as words (brands are the same in every language). An unknown model is its own identifier. */
export function modelLabel(model: string): string {
  const variant = antVariant(model);
  if (variant) return `ANT-BMS ${variant.cells}S · ${variant.amps} A`;
  return INVERTER_FAMILIES[model]?.label ?? BATTERY_FAMILIES[model]?.label ?? model;
}
/** Whether a battery model may be declared: one of the list, or an ANT-BMS combination within the limits. */
export function isBatteryModel(model: string): boolean { return Object.hasOwn(BATTERY_FAMILIES, model) || antVariant(model) !== undefined; }

export const CONNECTIONS = ["rs232", "rs485", "usb", "can", "wifi", "other"] as const;
export type SolarKind = "inverter" | "battery";
export type SolarRegistration = {
  node_id: string; device: string; kind: SolarKind; name: string; model: string; connection: (typeof CONNECTIONS)[number]; notes: string; created_at: string;
};

const NODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEVICE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_DEVICES = 64;

export class SolarRegistryError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

/** A short lowercase identifier from a name ("Casa - inversor 1" becomes "casa-inversor-1"). */
export function slug(text: string): string {
  const base = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "");
  return base || "solar";
}

export class SolarRegistry {
  readonly #file: string;
  readonly #now: () => Date;
  #items: SolarRegistration[] = [];

  constructor(file: string, now: () => Date = () => new Date()) {
    this.#file = file;
    this.#now = now;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { schema?: number; devices?: unknown };
      if (parsed.schema === 1 && Array.isArray(parsed.devices)) this.#items = parsed.devices.filter(isRegistration).slice(0, MAX_DEVICES);
    } catch { /* no file yet, or a damaged one: start empty rather than trust it */ }
  }

  list(): SolarRegistration[] { return this.#items.map(item => ({ ...item })); }

  get(node: string, device: string): SolarRegistration | undefined { return this.#items.find(item => item.node_id === node && item.device === device); }

  /** Declare a device, or change the one with the same node and device. The identifier comes from the name when none is given. */
  save(input: Record<string, unknown>): { registration: SolarRegistration; created: boolean } {
    const kind = input.kind;
    if (kind !== "inverter" && kind !== "battery") throw new SolarRegistryError("kind must be inverter or battery");
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length < 1 || name.length > 60) throw new SolarRegistryError("the name must have 1 to 60 characters");
    const node = typeof input.node_id === "string" ? input.node_id.trim() : "";
    if (!NODE.test(node)) throw new SolarRegistryError("node_id must be lowercase letters, digits, '-' or '_' (at most 64)");
    const device = typeof input.device === "string" && input.device.trim() ? input.device.trim() : slug(name);
    if (!DEVICE.test(device)) throw new SolarRegistryError("device must be lowercase letters, digits, '-' or '_' (at most 32)");
    const model = typeof input.model === "string" ? input.model : "other";
    if (kind === "inverter" ? !(INVERTER_MODELS as readonly string[]).includes(model) : !isBatteryModel(model)) {
      throw new SolarRegistryError(kind === "inverter" ? `model must be one of ${INVERTER_MODELS.join(", ")}` : "model must be one of the catalogue's battery models, or ant-bms-<cells>s-<amps>a (4 to 32 cells, 20 to 500 A)");
    }
    const connection = typeof input.connection === "string" ? input.connection : "rs232";
    if (!(CONNECTIONS as readonly string[]).includes(connection)) throw new SolarRegistryError(`connection must be one of ${CONNECTIONS.join(", ")}`);
    const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 200) : "";
    const existing = this.get(node, device);
    if (existing && existing.kind !== kind) throw new SolarRegistryError("that node and device already exist with another kind", 409);
    if (!existing && this.#items.length >= MAX_DEVICES) throw new SolarRegistryError("too many solar devices", 409);
    const registration: SolarRegistration = { node_id: node, device, kind, name, model, connection: connection as SolarRegistration["connection"], notes, created_at: existing?.created_at ?? this.#now().toISOString() };
    this.#items = existing ? this.#items.map(item => (item === existing ? registration : item)) : [...this.#items, registration];
    this.#write();
    return { registration, created: !existing };
  }

  remove(node: string, device: string): boolean {
    const before = this.#items.length;
    this.#items = this.#items.filter(item => !(item.node_id === node && item.device === device));
    if (this.#items.length === before) return false;
    this.#write();
    return true;
  }

  #write(): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, devices: this.#items }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.#file);
  }
}

function isRegistration(value: unknown): value is SolarRegistration {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (item.kind === "inverter" || item.kind === "battery") && typeof item.node_id === "string" && NODE.test(item.node_id) && typeof item.device === "string" && DEVICE.test(item.device)
    && typeof item.name === "string" && item.name.length >= 1 && item.name.length <= 60 && typeof item.model === "string" && typeof item.connection === "string"
    && typeof item.notes === "string" && typeof item.created_at === "string";
}

// ---- example readings ---------------------------------------------------------------------------------------------------------------------

/** The shape an example reading gives a battery: the family's, or an ANT-BMS combination's own cell count. */
function batteryShape(model: string): BatteryShape {
  const variant = antVariant(model);
  if (variant) return { modules: 1, cells: variant.cells, ah: 100, label: `ANT-BMS ${variant.cells}S` };
  const family = Object.hasOwn(BATTERY_FAMILIES, model) ? BATTERY_FAMILIES[model] : BATTERY_FAMILIES.other;
  return model === "ant-bms" ? { ...family, label: "ANT-BMS 16S" } : { ...family, label: family.label.replace(/^Pylontech /, "").split(" / ")[0] };
}

/**
 * One reading that looks plausible, to try the menus with. It follows the schema of the real messages (it goes through the same parser) and says what
 * it is in the views ("example"); it is not evidence of how a real inverter or battery reports.
 */
export function exampleReading(registration: SolarRegistration, now: number, phase: number = (now / 1000 % 240) / 240): SolarMessage {
  const jitter = (spread: number, salt: number) => Math.sin(now / 1000 * 1.7 + salt) * spread;
  const soc = Math.round(Math.min(100, Math.max(12, 58 + 32 * Math.sin(2 * Math.PI * phase - 1.3))));
  const sun = phase < 0.5 ? Math.max(0, 3200 * Math.sin(Math.PI * phase * 2) + jitter(60, 1)) : 0;
  const load = 700 + 250 * Math.sin(now / 9000) + jitter(40, 2);
  const batteryV = Math.round((48 + 6 * soc / 100 + jitter(0.05, 3)) * 100) / 100;
  const current = Math.round(((sun - load) / batteryV) * 10) / 10;
  if (registration.kind === "inverter") {
    const pvV = sun > 0 ? Math.round((150 + sun / 40) * 10) / 10 : 0;
    return parseSolarMessage({
      kind: "inverter", node_id: registration.node_id, device: registration.device, timestamp_ms: now, mode: "line",
      grid_v: Math.round((230 + jitter(2, 4)) * 10) / 10, grid_hz: 50, out_v: 230, out_hz: 50, out_va: Math.round(load * 1.1), out_w: Math.round(load), load_percent: Math.round(load / 50),
      battery_v: batteryV, battery_a: current, battery_percent: soc, pv_v: pvV, pv_a: pvV ? Math.round((sun / pvV) * 10) / 10 : 0, pv_w: Math.round(sun),
      heatsink_c: Math.round(34 + load / 90 + sun / 300), ac_charging: false, pv_charging: sun > load, load_on: true, warnings: [],
    });
  }
  const shape = batteryShape(registration.model);
  const base = 3.2 + soc / 100 * 0.2;
  const stack = Array.from({ length: shape.modules }, (_, index) => {
    const n = index + 1;
    const cells = Array.from({ length: shape.cells }, (_, i) => Math.round((base + ((i * 7 + n * 3) % 5) * 0.0015 + jitter(0.0008, i + n) + (n === shape.modules && i === 9 ? 0.02 : 0)) * 1000) / 1000);
    return {
      n, present: true, voltage_v: Math.round(cells.reduce((sum, value) => sum + value, 0) * 1000) / 1000, current_a: Math.round((current / shape.modules) * 100) / 100,
      temperature_c: Math.round((21 + n + jitter(0.3, 5)) * 10) / 10, soc_percent: soc, state: current > 0 ? "Charge" : "Dischg", cells_v: cells,
      temperatures_c: [0, 1, 2, 3, 4].map(k => Math.round((21 + n + jitter(0.6, 6 + k)) * 10) / 10),
      capacity_ah: Math.round(shape.ah * soc) / 100, full_capacity_ah: shape.ah, cycles: 180 + n,
    };
  });
  const all = stack.flatMap(module => module.cells_v);
  const voltage = Math.round((stack.reduce((sum, module) => sum + module.voltage_v, 0) / shape.modules) * 1000) / 1000;
  const totalAh = shape.ah * shape.modules;
  return parseSolarMessage({
    kind: "battery", node_id: registration.node_id, device: registration.device, timestamp_ms: now, modules: shape.modules, state: current > 0 ? "charging" : "discharging",
    voltage_v: voltage, current_a: Math.round(current * 100) / 100, temperature_min_c: Math.min(...stack.map(m => m.temperature_c)), temperature_max_c: Math.max(...stack.map(m => m.temperature_c)),
    cell_min_v: Math.min(...all), cell_max_v: Math.max(...all), soc_percent: soc, alarm: false, model: shape.label,
    capacity_ah: Math.round(totalAh * soc) / 100, full_capacity_ah: totalAh, energy_kwh: Math.round(totalAh * soc / 100 * voltage / 10) / 100, cycles: 181, stack,
  });
}
