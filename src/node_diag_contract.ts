/**
 * What a node says about how it last started, how its memory gate stands, whether it holds a core dump, what its sensors are and the diagnostic package it builds when it is asked: the strict
 * readers of those members of ARMOR-COMMON's node_health and node_control_result, with the rules that join their fields. The package is the delicate one: it is read member by member (an
 * unknown member is refused, never copied), so nothing a node adds to it ever reaches a console or a diagnostic token.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { integer, onlyKnown, record } from "./contracts.js";

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
const chars = (text: string): number => Array.from(text).length;
const nonNegative = (value: unknown): value is number => integer(value) && value >= 0;
const FIRMWARE = /^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$/;
const SENSOR_TEXT = /^[0-9A-Za-z._:-]{1,24}$/;
const MAC_TEXT = /^[0-9A-Za-z:._-]{1,17}$/;
const ADDRESS = /^0x[0-9a-fA-F]{1,16}$/;

export const RESET_REASON_WORDS = ["power_on", "external", "software", "panic", "int_wdt", "task_wdt", "other_wdt", "deep_sleep", "brownout", "sdio", "usb", "jtag", "efuse", "power_glitch", "cpu_lockup", "unknown"] as const;
export const BOOT_CAUSES = ["panic", "task_watchdog", "interrupt_watchdog", "other_watchdog", "brownout", "power_glitch", "cpu_lockup", "out_of_memory", "guard_missing_task", "guard_low_memory", "guard_dead_man", "guard"] as const;
export type BootCause = (typeof BOOT_CAUSES)[number];
export const SENSOR_MODELS = ["ld2450", "ld2461", "ld2410", "ld2412", "ld2410s", "mr24hpc1"] as const;
export const SENSOR_STATES = ["reporting", "no_data", "garbled", "silent", "bridge"] as const;
export const SENSOR_BLUETOOTH = ["unknown", "open", "closed", "none"] as const;
export const SENSOR_QUIRKS = ["ld2412_bad_firmware", "ld2412_unknown_firmware"] as const;

export type BootReport = {
  cause: BootCause; reset_reason: (typeof RESET_REASON_WORDS)[number]; uptime_before_s?: number; heap_internal_free?: number; heap_internal_largest?: number; coredump: boolean; deliberate: boolean; guard: boolean;
};
export type MemoryGate = { closed: boolean; transitions: number; close_free: number; close_block: number; open_free: number; open_block: number };
export type CoredumpFact = { present: boolean; size?: number };
export type ConfigCheck = { snapshot?: "restored" | "failed"; reverted?: "reapplied" | "failed" };
export type SensorHealth = {
  sensor_id: number; model: (typeof SENSOR_MODELS)[number]; state: (typeof SENSOR_STATES)[number]; firmware_known: boolean; firmware?: string; bluetooth: (typeof SENSOR_BLUETOOTH)[number]; mac?: string;
  bluetooth_alert?: boolean; quirk?: (typeof SENSOR_QUIRKS)[number];
};
export type RadarFacts = { perimeter_enabled: boolean; masked: boolean; wifi_jam: boolean; bridge_open: boolean; events_buffered: number; sensor_bluetooth_off: boolean };

export function parseBootReport(value: unknown): BootReport {
  const body = record(value, "boot");
  onlyKnown(body, ["cause", "reset_reason", "uptime_before_s", "heap_internal_free", "heap_internal_largest", "coredump", "deliberate", "guard"], "boot");
  if (!oneOf(BOOT_CAUSES, body.cause)) throw new Error("invalid boot cause");
  if (!oneOf(RESET_REASON_WORDS, body.reset_reason)) throw new Error("invalid boot reset_reason");
  for (const key of ["uptime_before_s", "heap_internal_free", "heap_internal_largest"] as const) if (key in body && !nonNegative(body[key])) throw new Error(`invalid boot ${key}`);
  for (const key of ["coredump", "deliberate", "guard"] as const) if (typeof body[key] !== "boolean") throw new Error(`invalid boot ${key}`);
  if (("heap_internal_free" in body) !== ("heap_internal_largest" in body)) throw new Error("the boot heap figures come together");
  if ("heap_internal_free" in body && (body.heap_internal_largest as number) > (body.heap_internal_free as number)) throw new Error("the biggest internal block is never more than the internal memory free");
  if (body.cause === "panic" && body.guard === true) throw new Error("a panic is not a restart of the guard");
  return body as unknown as BootReport;
}

export function parseMemoryGate(value: unknown): MemoryGate {
  const body = record(value, "memory_gate");
  onlyKnown(body, ["closed", "transitions", "close_free", "close_block", "open_free", "open_block"], "memory_gate");
  if (typeof body.closed !== "boolean") throw new Error("invalid memory_gate closed");
  for (const key of ["transitions", "close_free", "close_block", "open_free", "open_block"] as const) if (!nonNegative(body[key])) throw new Error(`invalid memory_gate ${key}`);
  return body as unknown as MemoryGate;
}

export function parseCoredumpFact(value: unknown): CoredumpFact {
  const body = record(value, "coredump");
  onlyKnown(body, ["present", "size"], "coredump");
  if (typeof body.present !== "boolean") throw new Error("invalid coredump present");
  if ("size" in body && (!integer(body.size) || body.size < 1)) throw new Error("invalid coredump size");
  if ("size" in body && body.present !== true) throw new Error("a core dump size goes with a core dump that is present");
  return body as unknown as CoredumpFact;
}

export function parseConfigCheck(value: unknown): ConfigCheck {
  const body = record(value, "config_check");
  onlyKnown(body, ["snapshot", "reverted"], "config_check");
  if ("snapshot" in body && !oneOf(["restored", "failed"] as const, body.snapshot)) throw new Error("invalid config_check snapshot");
  if ("reverted" in body && !oneOf(["reapplied", "failed"] as const, body.reverted)) throw new Error("invalid config_check reverted");
  return body as unknown as ConfigCheck;
}

export function parseSensors(value: unknown): SensorHealth[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error("sensors must be a list of at most three");
  const seen = new Set<number>();
  return value.map((item, index) => {
    const body = record(item, `sensor ${index}`);
    onlyKnown(body, ["sensor_id", "model", "state", "firmware_known", "firmware", "bluetooth", "mac", "bluetooth_alert", "quirk"], `sensor ${index}`);
    if (!integer(body.sensor_id) || body.sensor_id < 1 || body.sensor_id > 3) throw new Error(`invalid sensor ${index} sensor_id`);
    if (seen.has(body.sensor_id)) throw new Error("a sensor is told once");
    seen.add(body.sensor_id);
    if (!oneOf(SENSOR_MODELS, body.model)) throw new Error(`invalid sensor ${index} model`);
    if (!oneOf(SENSOR_STATES, body.state)) throw new Error(`invalid sensor ${index} state`);
    if (typeof body.firmware_known !== "boolean") throw new Error(`invalid sensor ${index} firmware_known`);
    if ("firmware" in body && (typeof body.firmware !== "string" || !SENSOR_TEXT.test(body.firmware))) throw new Error(`invalid sensor ${index} firmware`);
    if (body.firmware_known !== ("firmware" in body)) throw new Error("a firmware version goes with firmware_known and nothing else");
    if (!oneOf(SENSOR_BLUETOOTH, body.bluetooth)) throw new Error(`invalid sensor ${index} bluetooth`);
    if ("mac" in body && (typeof body.mac !== "string" || !MAC_TEXT.test(body.mac))) throw new Error(`invalid sensor ${index} mac`);
    if ("mac" in body && body.bluetooth !== "open") throw new Error("a Bluetooth address is told only while the sensor's Bluetooth is open");
    if ("bluetooth_alert" in body && typeof body.bluetooth_alert !== "boolean") throw new Error(`invalid sensor ${index} bluetooth_alert`);
    if (body.bluetooth_alert === true && body.bluetooth !== "open" && body.bluetooth !== "unknown") throw new Error("a Bluetooth alert needs a Bluetooth that is open or cannot be told closed");
    if ("quirk" in body && !oneOf(SENSOR_QUIRKS, body.quirk)) throw new Error(`invalid sensor ${index} quirk`);
    return body as unknown as SensorHealth;
  });
}

export function parseRadarFacts(value: unknown): RadarFacts {
  const body = record(value, "radar");
  onlyKnown(body, ["perimeter_enabled", "masked", "wifi_jam", "bridge_open", "events_buffered", "sensor_bluetooth_off"], "radar");
  for (const key of ["perimeter_enabled", "masked", "wifi_jam", "bridge_open", "sensor_bluetooth_off"] as const) if (typeof body[key] !== "boolean") throw new Error(`invalid radar ${key}`);
  if (!integer(body.events_buffered) || body.events_buffered < 0 || body.events_buffered > 1000) throw new Error("invalid radar events_buffered");
  return body as unknown as RadarFacts;
}

// ---- the diagnostic package ------------------------------------------------------------------------------------------------------------------

export type PackageTask = { name: string; stack_free: number; priority: number; state: "R" | "r" | "B" | "S" | "D" | "?" };
export type CoreSummary = { task: string; reason?: string; pc?: string; backtrace?: string[]; app_sha256?: string };
export type DiagnosticPackage = {
  detail: "package" | "log";
  heap?: { internal_free: number; internal_min: number; internal_largest: number; total_free: number; total_min: number; psram_free?: number };
  tasks?: PackageTask[];
  resets?: { reason: (typeof RESET_REASON_WORDS)[number]; uptime_s: number; guard_restarts_in_hour: number };
  boot?: BootReport;
  memory_gate?: MemoryGate;
  versions?: { firmware: string; idf: string; board?: string; sensors: Array<{ name: string; version: string }> };
  config?: Record<string, string>;
  coredump?: { present: boolean; size?: number; summary?: CoreSummary };
  log: string;
  truncated: boolean;
};
/** The most characters the log of a package may have here (the node cuts at 5000 bytes; a little room for the escapes). */
export const MAX_PACKAGE_LOG = 6000;

export function parseDiagnosticPackage(value: unknown): DiagnosticPackage {
  const body = record(value, "package");
  onlyKnown(body, ["detail", "heap", "tasks", "resets", "boot", "memory_gate", "versions", "config", "coredump", "log", "truncated"], "package");
  if (body.detail !== "package" && body.detail !== "log") throw new Error("invalid package detail");
  if (typeof body.log !== "string" || chars(body.log) > MAX_PACKAGE_LOG) throw new Error("invalid package log");
  if (typeof body.truncated !== "boolean") throw new Error("invalid package truncated");
  if (body.detail === "log") {
    for (const key of Object.keys(body)) if (key !== "detail" && key !== "log" && key !== "truncated") throw new Error(`a log carries no ${key}`);
    return body as unknown as DiagnosticPackage;
  }
  for (const key of ["heap", "tasks", "resets", "versions", "config", "coredump"]) if (!(key in body)) throw new Error(`a package carries ${key}`);
  const heap = record(body.heap, "package heap");
  onlyKnown(heap, ["internal_free", "internal_min", "internal_largest", "total_free", "total_min", "psram_free"], "package heap");
  for (const key of ["internal_free", "internal_min", "internal_largest", "total_free", "total_min"]) if (!nonNegative(heap[key])) throw new Error(`invalid package heap ${key}`);
  if ("psram_free" in heap && !nonNegative(heap.psram_free)) throw new Error("invalid package heap psram_free");
  if ((heap.internal_min as number) > (heap.internal_free as number) || (heap.internal_largest as number) > (heap.internal_free as number) || (heap.total_min as number) > (heap.total_free as number)) {
    throw new Error("the least memory and the biggest block are never more than what is free now");
  }
  if (!Array.isArray(body.tasks) || body.tasks.length > 40) throw new Error("invalid package tasks");
  body.tasks.forEach((item, index) => {
    const task = record(item, `package task ${index}`);
    onlyKnown(task, ["name", "stack_free", "priority", "state"], `package task ${index}`);
    if (typeof task.name !== "string" || chars(task.name) < 1 || chars(task.name) > 15) throw new Error(`invalid package task ${index} name`);
    if (!nonNegative(task.stack_free)) throw new Error(`invalid package task ${index} stack_free`);
    if (!integer(task.priority) || task.priority < 0 || task.priority > 63) throw new Error(`invalid package task ${index} priority`);
    if (!oneOf(["R", "r", "B", "S", "D", "?"] as const, task.state)) throw new Error(`invalid package task ${index} state`);
  });
  const resets = record(body.resets, "package resets");
  onlyKnown(resets, ["reason", "uptime_s", "guard_restarts_in_hour"], "package resets");
  if (!oneOf(RESET_REASON_WORDS, resets.reason) || !nonNegative(resets.uptime_s) || !integer(resets.guard_restarts_in_hour) || resets.guard_restarts_in_hour < 0 || resets.guard_restarts_in_hour > 3) throw new Error("invalid package resets");
  if ("boot" in body) parseBootReport(body.boot);
  if ("memory_gate" in body) parseMemoryGate(body.memory_gate);
  const versions = record(body.versions, "package versions");
  onlyKnown(versions, ["firmware", "idf", "board", "sensors"], "package versions");
  if (typeof versions.firmware !== "string" || !FIRMWARE.test(versions.firmware)) throw new Error("invalid package firmware");
  if (typeof versions.idf !== "string" || chars(versions.idf) > 32) throw new Error("invalid package idf");
  if ("board" in versions && (typeof versions.board !== "string" || chars(versions.board) < 1 || chars(versions.board) > 32)) throw new Error("invalid package board");
  if (!Array.isArray(versions.sensors) || versions.sensors.length > 8) throw new Error("invalid package sensors");
  versions.sensors.forEach((item, index) => {
    const sensor = record(item, `package sensor ${index}`);
    onlyKnown(sensor, ["name", "version"], `package sensor ${index}`);
    if (typeof sensor.name !== "string" || chars(sensor.name) > 32 || typeof sensor.version !== "string" || chars(sensor.version) > 32) throw new Error(`invalid package sensor ${index}`);
  });
  const config = record(body.config, "package config");
  const names = Object.keys(config);
  if (names.length > 64) throw new Error("too many settings in the package");
  for (const name of names) if (!/^[A-Za-z0-9_.]{1,80}$/.test(name) || typeof config[name] !== "string" || chars(config[name] as string) > 96) throw new Error("invalid package config");
  const core = record(body.coredump, "package coredump");
  onlyKnown(core, ["present", "size", "summary"], "package coredump");
  if (typeof core.present !== "boolean") throw new Error("invalid package coredump present");
  if ("size" in core && (!integer(core.size) || core.size < 1)) throw new Error("invalid package coredump size");
  if (("size" in core || "summary" in core) && core.present !== true) throw new Error("a core dump size and summary go with a core dump that is present");
  if ("summary" in core) {
    const summary = record(core.summary, "package coredump summary");
    onlyKnown(summary, ["task", "reason", "pc", "backtrace", "app_sha256"], "package coredump summary");
    if (typeof summary.task !== "string" || chars(summary.task) > 16) throw new Error("invalid package coredump task");
    if ("reason" in summary && (typeof summary.reason !== "string" || chars(summary.reason) > 96)) throw new Error("invalid package coredump reason");
    if ("pc" in summary && (typeof summary.pc !== "string" || !ADDRESS.test(summary.pc))) throw new Error("invalid package coredump pc");
    if ("app_sha256" in summary && (typeof summary.app_sha256 !== "string" || chars(summary.app_sha256) > 16)) throw new Error("invalid package coredump app_sha256");
    if ("backtrace" in summary && (!Array.isArray(summary.backtrace) || summary.backtrace.length > 16 || summary.backtrace.some(address => typeof address !== "string" || !ADDRESS.test(address)))) throw new Error("invalid package coredump backtrace");
  }
  return body as unknown as DiagnosticPackage;
}

/**
 * The Bluetooth address of a sensor is what a phone needs to reach it: it is shown to administrators and to nobody else (an operator, a viewer or a diagnostic token reads the report without it).
 * Works on a report or on a view that holds one; returns what it was given when there is nothing to take out.
 */
export function withoutSensorAddresses<T extends { sensors?: SensorHealth[] }>(report: T): T {
  if (!report.sensors || !report.sensors.some(sensor => sensor.mac !== undefined)) return report;
  return { ...report, sensors: report.sensors.map(({ mac: _address, ...rest }) => rest) };
}

// ---- washing text a second time ---------------------------------------------------------------------------------------------------------------

const CREDENTIAL_WORD = /\b(password|passwd|pass|secret|token|psk|apikey|api_key|authorization|cookie|pin|credential|login)(["']?\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;"']+/gi;
const BEARER = /\bbearer\s+[^\s,;"']+/gi;

/**
 * The server washes what a node sent a second time before it shows it to a diagnostic token: the node already washed it, and this is the belt to its braces. A value that follows a word like
 * password, token or bearer, a user and password in an address and a long run of hexadecimal digits are replaced.
 */
export function washCredentials(text: string): string {
  return text
    .replace(CREDENTIAL_WORD, "$1$2***")
    .replace(BEARER, "bearer ***")
    .replace(/:\/\/[^\s/@]+@/g, "://***@")
    .replace(/(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g, "<hex>");
}
