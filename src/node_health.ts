/**
 * The health of the nodes, in the same words for every family (radar, solar, electrical, alarm, hmi): the strict parser of the report a node publishes to armor/health/{node_id}
 * (ARMOR-COMMON's node_health schema), and the store that keeps the latest report of each node, a short history of its memory and signal, and the log of its restarts.
 *
 * The node only tells; this file judges. From what it was told it derives four warnings, each of which the alarm centre raises and clears (see AlarmRules.handleNodeHealth):
 *   - node_low_memory      the heap is nearly used up, or a task is short of stack;
 *   - node_frequent_resets the node restarted three times in a day, or crashed (a panic, a watchdog, a brown-out) in the last hour;
 *   - node_link_flapping   the node keeps losing the broker (three reconnections in a quarter of an hour);
 *   - node_weak_signal     the Wi-Fi signal has stayed at -80 dBm or worse.
 * A report is information: it never moves anything. A node that falls silent is the business of the checks that already exist (the radar's heartbeat, the state of each family);
 * here it is only shown as "no report" after a few minutes.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { integer, onlyKnown, readNodeId, readTimestamp, record } from "./contracts.js";

export const HEALTH_FAMILIES = ["radar", "solar", "electrical", "alarm", "hmi"] as const;
export type HealthFamily = (typeof HEALTH_FAMILIES)[number];
export const RESET_REASONS = ["power_on", "external", "software", "panic", "int_wdt", "task_wdt", "other_wdt", "deep_sleep", "brownout", "sdio", "usb", "jtag", "efuse", "power_glitch", "cpu_lockup", "unknown"] as const;
export type ResetReason = (typeof RESET_REASONS)[number];
export const HEALTH_LINKS = ["wifi", "ethernet", "none"] as const;
/** A restart nobody asked for: a crash, a watchdog, a sag of the supply. */
export const ABNORMAL_RESETS: readonly ResetReason[] = ["panic", "int_wdt", "task_wdt", "other_wdt", "brownout", "power_glitch", "cpu_lockup"];

export type NodeHealthMessage = {
  kind: "node_health"; node_id: string; timestamp_ms: number; family: HealthFamily; firmware: string; board?: string; uptime_s: number; reset_reason: ResetReason;
  heap_free: number; heap_min: number;
  /** The internal memory on its own (heap_free counts the external RAM too, so it never looks short on a board that has 8 MB of it); the three come together. */
  heap_internal_free?: number; heap_internal_min?: number; heap_internal_largest?: number; psram_free?: number;
  link: (typeof HEALTH_LINKS)[number]; link_up: boolean; rssi_dbm?: number; broker_reconnects: number; low_stack_tasks?: number; last_error?: string;
  /** What remote control has done to the node (see node_control.ts): running, paused for a while or in standby, and the maintenance flag. Absent on a firmware that can not be controlled. */
  control_state?: ControlState; control_since_ms?: number; control_by?: string; control_until_s?: number; maintenance?: boolean; maintenance_until_s?: number;
};
export const CONTROL_STATES = ["running", "paused", "standby"] as const;
export type ControlState = (typeof CONTROL_STATES)[number];
const CONTROL_PERSON = /^[A-Za-z0-9._@ -]{1,64}$/;

export const HEALTH_CODES = ["node_low_memory", "node_frequent_resets", "node_link_flapping", "node_weak_signal"] as const;
export type HealthCode = (typeof HEALTH_CODES)[number];
export type HealthWarning = { code: HealthCode; detail: Record<string, string | number | boolean> };

/** The levels the server judges by (sent to the consoles with the report, so they can say what "low" means). */
export const HEALTH_LEVELS = {
  low_heap_b: 30_000, low_heap_clear_b: 40_000, low_internal_b: 40_960, low_internal_clear_b: 49_152, low_block_b: 8_192, restarts_per_day: 3, abnormal_window_min: 60, flap_reconnects: 3, flap_window_min: 15, weak_signal_dbm: -80, weak_signal_reports: 3, silent_after_s: 180,
} as const;

const FIRMWARE = /^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$/;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
const chars = (text: string): number => Array.from(text).length;
const INTERNAL = ["heap_internal_free", "heap_internal_min", "heap_internal_largest"] as const;
const REQUIRED = ["kind", "node_id", "timestamp_ms", "family", "firmware", "uptime_s", "reset_reason", "heap_free", "heap_min", "link", "link_up", "broker_reconnects"] as const;

/** A report as the contract has it, with the rules that join fields: the least heap is never more than the heap free, a signal strength goes only with a Wi-Fi link that is up, no link is a link that is down. */
export function parseNodeHealth(value: unknown): NodeHealthMessage {
  const body = record(value, "node health");
  onlyKnown(body, [...REQUIRED, "board", "rssi_dbm", "low_stack_tasks", "last_error", ...INTERNAL, "psram_free", "control_state", "control_since_ms", "control_by", "control_until_s", "maintenance", "maintenance_until_s"], "node health");
  for (const key of REQUIRED) if (!(key in body)) throw new Error(`the node health is missing ${key}`);
  if (body.kind !== "node_health") throw new Error("invalid kind");
  const node = readNodeId(body), timestamp = readTimestamp(body);
  if (!oneOf(HEALTH_FAMILIES, body.family)) throw new Error("invalid family");
  if (typeof body.firmware !== "string" || !FIRMWARE.test(body.firmware)) throw new Error("invalid firmware");
  if ("board" in body && (typeof body.board !== "string" || chars(body.board) < 1 || chars(body.board) > 32)) throw new Error("invalid board");
  for (const key of ["uptime_s", "heap_free", "heap_min", "broker_reconnects"] as const) if (!integer(body[key]) || (body[key] as number) < 0) throw new Error(`invalid ${key}`);
  if (!oneOf(RESET_REASONS, body.reset_reason)) throw new Error("invalid reset_reason");
  for (const key of [...INTERNAL, "psram_free"] as const) if (key in body && (!integer(body[key]) || (body[key] as number) < 0)) throw new Error(`invalid ${key}`);
  if (!oneOf(HEALTH_LINKS, body.link)) throw new Error("invalid link");
  if (typeof body.link_up !== "boolean") throw new Error("invalid link_up");
  if ("rssi_dbm" in body && (!integer(body.rssi_dbm) || body.rssi_dbm < -120 || body.rssi_dbm > 0)) throw new Error("invalid rssi_dbm");
  if ("low_stack_tasks" in body && (!integer(body.low_stack_tasks) || body.low_stack_tasks < 0 || body.low_stack_tasks > 64)) throw new Error("invalid low_stack_tasks");
  if ("last_error" in body && (typeof body.last_error !== "string" || chars(body.last_error) < 1 || chars(body.last_error) > 96)) throw new Error("invalid last_error");
  if ((body.heap_min as number) > (body.heap_free as number)) throw new Error("the least heap is never more than the heap free now");
  const told = INTERNAL.filter(key => key in body).length;
  if (told !== 0 && told !== INTERNAL.length) throw new Error("the internal memory is told whole: heap_internal_free, heap_internal_min and heap_internal_largest together");
  if (told !== 0 && ((body.heap_internal_min as number) > (body.heap_internal_free as number) || (body.heap_internal_largest as number) > (body.heap_internal_free as number))) throw new Error("the least internal memory and its biggest block are never more than the internal memory free now");
  if (body.link === "none" && body.link_up !== false) throw new Error("no link means a link that is down");
  if ("rssi_dbm" in body && !(body.link === "wifi" && body.link_up === true)) throw new Error("a signal strength goes only with a Wi-Fi link that is up");
  if ("control_state" in body && !oneOf(CONTROL_STATES, body.control_state)) throw new Error("invalid control_state");
  if ("control_since_ms" in body && (!integer(body.control_since_ms) || body.control_since_ms < 0)) throw new Error("invalid control_since_ms");
  if ("control_by" in body && (typeof body.control_by !== "string" || !CONTROL_PERSON.test(body.control_by))) throw new Error("invalid control_by");
  if ("control_until_s" in body && (!integer(body.control_until_s) || body.control_until_s < 0 || body.control_until_s > 86_400)) throw new Error("invalid control_until_s");
  if ("maintenance" in body && typeof body.maintenance !== "boolean") throw new Error("invalid maintenance");
  if ("maintenance_until_s" in body && (!integer(body.maintenance_until_s) || body.maintenance_until_s < 0 || body.maintenance_until_s > 86_400)) throw new Error("invalid maintenance_until_s");
  if (("control_since_ms" in body || "control_by" in body) && body.control_state !== "paused" && body.control_state !== "standby") throw new Error("since and by go with a paused or standby node");
  if ("control_until_s" in body && body.control_state !== "paused") throw new Error("the time left goes with a paused node: standby has no end");
  if ("maintenance_until_s" in body && body.maintenance !== true) throw new Error("the maintenance time left goes with the maintenance flag on");
  return { ...(body as unknown as NodeHealthMessage), node_id: node, timestamp_ms: timestamp };
}

/** armor/health/{node_id} as the node id, or undefined when the topic is not one. */
export function healthTopic(topic: string): string | undefined {
  const parts = topic.split("/");
  if (parts.length !== 3 || parts[0] !== "armor" || parts[1] !== "health") return undefined;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[2]) ? parts[2] : undefined;
}

/**
 * The last will of a node: the broker publishes it on armor/health/{node_id} when the node's connection is lost without a goodbye. It is {"node_id": "...", "online": false} and nothing
 * else, so no health report can be mistaken for it. True when `body` is the will of the node the topic names (a will that names another node is not one).
 */
export function isNodeWill(body: unknown, named: string): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  const record = body as Record<string, unknown>;
  return keys.length === 2 && record.online === false && record.node_id === named;
}

/**
 * The other half of the will: each time a node connects it says {"node_id": "...", "online": true} on the same topic, and the broker keeps it (retained) until the will replaces it, so the last
 * message on armor/health/{node_id} always tells whether the node is there, also to a server that starts later. Nothing else in the body, like the will; it is never a report.
 */
export function isNodeBirth(body: unknown, named: string): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  const record = body as Record<string, unknown>;
  return keys.length === 2 && record.online === true && record.node_id === named;
}

export type RestartRecord = { at: string; reason: ResetReason; abnormal: boolean; uptime_before_s?: number; boot_at_ms: number };
/** What a console is told of a restart (the moment the node booted is the server's own bookkeeping). */
export type RestartPublic = Omit<RestartRecord, "boot_at_ms">;
const publicRestart = ({ boot_at_ms: _boot, ...rest }: RestartRecord): RestartPublic => rest;
/** One point of the history a console draws. */
export type HealthSample = { at: number; heap_free: number; heap_min: number; heap_internal_free?: number; heap_internal_largest?: number; rssi_dbm?: number; link_up: boolean; uptime_s: number; broker_reconnects: number };

export type NodeHealthView = {
  node_id: string; family: HealthFamily; firmware: string; board?: string; report: NodeHealthMessage; received_at: string;
  /** No report for a few minutes: what is shown is the last one. */
  stale: boolean;
  status: "ok" | "warning" | "stale";
  warnings: HealthWarning[];
  restarts_24h: number;
  last_restart?: RestartPublic;
  /** What remote control has done to the node, in the words the consoles show ("paused", "standby since ... by ...", "maintenance"); absent while nothing is known. */
  control?: ControlView;
};
/** The control state of a node as a console reads it. `source` says who knows: the node's own report, or what the server remembers of the orders it gave (an older firmware). */
export type ControlView = { state: ControlState; maintenance: boolean; since_ms?: number; by?: string; until_s?: number; maintenance_until_s?: number; source: "node" | "server" };
export type NodeHealthDetail = NodeHealthView & { samples: HealthSample[]; restarts: RestartPublic[] };
export type NodeHealthTotals = { nodes: number; stale: number; with_warnings: number };

type Entry = { report: NodeHealthMessage; receivedAtMs: number; samples: HealthSample[]; restarts: RestartRecord[]; warnings: HealthWarning[] };
export type NodeHealthSaved = { nodes: Record<string, { report: NodeHealthMessage; received_at_ms: number; restarts: RestartRecord[] }> };

export type NodeHealthOptions = {
  now?: () => number;
  maxNodes?: number;
  /** Called after every report with the node's view (the alarm centre raises and clears its warnings from it). */
  onReport?: (view: NodeHealthView) => void;
  onForget?: (node: string) => void;
  /** What the server remembers of the control orders it gave a node, for a firmware that does not report it (see NodeControlService.memoryOf). */
  remembered?: (node: string) => Omit<ControlView, "source"> | undefined;
};

const DAY_MS = 24 * 3_600_000;
const MAX_SAMPLES = 120;
const MAX_RESTARTS = 30;

export class NodeHealthStore {
  readonly #entries = new Map<string, Entry>();
  readonly #options: NodeHealthOptions;
  readonly #now: () => number;
  readonly #max: number;

  constructor(options: NodeHealthOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#max = options.maxNodes ?? 128;
  }

  /** Keep a report. Refuses (throws) a new node when the store is full, so a broker full of noise cannot grow it without limit. A report older than the last one is dropped (a retry that arrived late). */
  ingest(report: NodeHealthMessage): NodeHealthView {
    const now = this.#now();
    let entry = this.#entries.get(report.node_id);
    if (!entry && this.#entries.size >= this.#max) throw new Error("too many nodes");
    if (entry && report.timestamp_ms < entry.report.timestamp_ms) return this.#view(report.node_id, entry, now);
    const previous = entry?.report;
    if (!entry) { entry = { report, receivedAtMs: now, samples: [], restarts: [], warnings: [] }; this.#entries.set(report.node_id, entry); }
    // A restart: the uptime went back, or the count of connections to the broker did. A node first heard just after it started counts once (a server that was restarted meanwhile keeps its own log, so it is not counted twice).
    const bootAtMs = now - report.uptime_s * 1000;
    const restarted = previous !== undefined ? report.uptime_s + 5 < previous.uptime_s || report.broker_reconnects < previous.broker_reconnects : report.uptime_s < 120;
    const repeated = entry.restarts.some(item => Math.abs(item.boot_at_ms - bootAtMs) < 45_000);
    if (restarted && !repeated) {
      entry.restarts.push({ at: new Date(now).toISOString(), reason: report.reset_reason, abnormal: ABNORMAL_RESETS.includes(report.reset_reason), boot_at_ms: bootAtMs, ...(previous ? { uptime_before_s: previous.uptime_s } : {}) });
      if (entry.restarts.length > MAX_RESTARTS) entry.restarts.splice(0, entry.restarts.length - MAX_RESTARTS);
    }
    entry.report = report;
    entry.receivedAtMs = now;
    entry.samples.push({ at: now, heap_free: report.heap_free, heap_min: report.heap_min, ...(report.heap_internal_free !== undefined ? { heap_internal_free: report.heap_internal_free, heap_internal_largest: report.heap_internal_largest } : {}), ...(report.rssi_dbm !== undefined ? { rssi_dbm: report.rssi_dbm } : {}), link_up: report.link_up, uptime_s: report.uptime_s, broker_reconnects: report.broker_reconnects });
    if (entry.samples.length > MAX_SAMPLES) entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
    entry.warnings = this.#judge(entry, now);
    const view = this.#view(report.node_id, entry, now);
    this.#options.onReport?.(view);
    return view;
  }

  /** The warnings a node deserves now, from its reports. The low-memory warning has two levels so that a heap that hovers around the line does not raise and clear it all day. */
  #judge(entry: Entry, now: number): HealthWarning[] {
    const out: HealthWarning[] = [];
    const report = entry.report;
    const had = (code: HealthCode): boolean => entry.warnings.some(item => item.code === code);
    const lowHeap = report.heap_free < HEALTH_LEVELS.low_heap_b || (had("node_low_memory") && report.heap_free < HEALTH_LEVELS.low_heap_clear_b);
    // A node that tells its internal memory is judged on that too: the total above adds the external RAM, so on a board with 8 MB of it the total never runs short while the internal memory does.
    const lowInternal = report.heap_internal_free !== undefined && (report.heap_internal_free < HEALTH_LEVELS.low_internal_b || (had("node_low_memory") && report.heap_internal_free < HEALTH_LEVELS.low_internal_clear_b) || (report.heap_internal_largest ?? Infinity) < HEALTH_LEVELS.low_block_b);
    const lowStack = (report.low_stack_tasks ?? 0) > 0;
    if (lowHeap || lowInternal || lowStack) {
      out.push({ code: "node_low_memory", detail: { heap_free: report.heap_free, heap_min: report.heap_min, low_stack_tasks: report.low_stack_tasks ?? 0,
        ...(report.heap_internal_free !== undefined ? { heap_internal_free: report.heap_internal_free, heap_internal_min: report.heap_internal_min ?? 0, heap_internal_largest: report.heap_internal_largest ?? 0 } : {}) } });
    }

    const day = entry.restarts.filter(item => now - Date.parse(item.at) < DAY_MS);
    const crashed = entry.restarts.filter(item => item.abnormal && now - Date.parse(item.at) < HEALTH_LEVELS.abnormal_window_min * 60_000);
    if (day.length >= HEALTH_LEVELS.restarts_per_day || crashed.length > 0) {
      out.push({ code: "node_frequent_resets", detail: { restarts_24h: day.length, last_reason: (crashed.at(-1) ?? day.at(-1) ?? entry.restarts.at(-1))?.reason ?? report.reset_reason } });
    }

    const windowStart = now - HEALTH_LEVELS.flap_window_min * 60_000;
    const recent = entry.samples.filter(item => item.at >= windowStart);
    let reconnects = 0;
    for (let index = 1; index < recent.length; index += 1) {
      const before = recent[index - 1], after = recent[index];
      if (after.uptime_s + 5 >= before.uptime_s && after.broker_reconnects > before.broker_reconnects) reconnects += after.broker_reconnects - before.broker_reconnects;   // a restart is not a lost broker
    }
    const linkDown = recent.slice(-6).filter(item => !item.link_up).length;
    if (reconnects >= HEALTH_LEVELS.flap_reconnects || linkDown >= 2) out.push({ code: "node_link_flapping", detail: { reconnects, minutes: HEALTH_LEVELS.flap_window_min, link_down_reports: linkDown } });

    const lastSignals = entry.samples.slice(-HEALTH_LEVELS.weak_signal_reports);
    if (lastSignals.length === HEALTH_LEVELS.weak_signal_reports && lastSignals.every(item => item.rssi_dbm !== undefined && item.rssi_dbm <= HEALTH_LEVELS.weak_signal_dbm)) {
      out.push({ code: "node_weak_signal", detail: { rssi_dbm: lastSignals[lastSignals.length - 1].rssi_dbm ?? 0, limit_dbm: HEALTH_LEVELS.weak_signal_dbm } });
    }
    return out;
  }

  #view(id: string, entry: Entry, now: number): NodeHealthView {
    const stale = now - entry.receivedAtMs > HEALTH_LEVELS.silent_after_s * 1000;
    const last = entry.restarts.at(-1);
    return {
      node_id: id, family: entry.report.family, firmware: entry.report.firmware, ...(entry.report.board !== undefined ? { board: entry.report.board } : {}), report: entry.report,
      received_at: new Date(entry.receivedAtMs).toISOString(), stale, status: stale ? "stale" : entry.warnings.length > 0 ? "warning" : "ok", warnings: entry.warnings,
      restarts_24h: entry.restarts.filter(item => now - Date.parse(item.at) < DAY_MS).length,
      ...(last ? { last_restart: publicRestart(last) } : {}),
      ...this.#control(id, entry.report),
    };
  }

  #control(id: string, report: NodeHealthMessage): { control?: ControlView } {
    if (report.control_state !== undefined || report.maintenance !== undefined) {
      const kept = this.#options.remembered?.(id);
      const state = report.control_state ?? kept?.state ?? "running";
      return { control: {
        state, maintenance: report.maintenance ?? kept?.maintenance ?? false, source: "node",
        ...(report.control_since_ms !== undefined ? { since_ms: report.control_since_ms } : {}), ...(report.control_by !== undefined ? { by: report.control_by } : {}),
        ...(report.control_until_s !== undefined ? { until_s: report.control_until_s } : {}), ...(report.maintenance_until_s !== undefined ? { maintenance_until_s: report.maintenance_until_s } : {}),
      } };
    }
    const kept = this.#options.remembered?.(id);
    return kept ? { control: { ...kept, source: "server" } } : {};
  }

  get(node: string): NodeHealthDetail | undefined {
    const entry = this.#entries.get(node);
    return entry ? { ...this.#view(node, entry, this.#now()), samples: [...entry.samples], restarts: entry.restarts.map(publicRestart).reverse() } : undefined;
  }

  list(): NodeHealthView[] {
    const now = this.#now();
    return [...this.#entries.entries()].map(([id, entry]) => this.#view(id, entry, now)).sort((a, b) => a.node_id.localeCompare(b.node_id));
  }

  totals(): NodeHealthTotals {
    const views = this.list();
    return { nodes: views.length, stale: views.filter(view => view.stale).length, with_warnings: views.filter(view => view.warnings.length > 0).length };
  }

  /** Forget a node that was taken away; its warnings go too. */
  remove(node: string): boolean {
    const removed = this.#entries.delete(node);
    if (removed) this.#options.onForget?.(node);
    return removed;
  }

  export(): NodeHealthSaved {
    return { nodes: Object.fromEntries([...this.#entries.entries()].map(([id, entry]) => [id, { report: entry.report, received_at_ms: entry.receivedAtMs, restarts: entry.restarts }])) };
  }

  /** Read back what a restart of the server must not forget: the latest report of each node and its log of restarts. Damaged entries are skipped one by one. */
  import(saved: NodeHealthSaved | undefined): void {
    if (!saved || typeof saved !== "object" || typeof saved.nodes !== "object" || saved.nodes === null) return;
    for (const [id, item] of Object.entries(saved.nodes).slice(0, this.#max)) {
      try {
        const report = parseNodeHealth(item.report);
        if (report.node_id !== id || typeof item.received_at_ms !== "number" || !Number.isFinite(item.received_at_ms)) continue;
        const restarts = (Array.isArray(item.restarts) ? item.restarts : []).filter((r): r is RestartRecord =>
          typeof r === "object" && r !== null && typeof r.at === "string" && Number.isFinite(Date.parse(r.at)) && oneOf(RESET_REASONS, r.reason) && typeof r.abnormal === "boolean" && typeof r.boot_at_ms === "number").slice(-MAX_RESTARTS);
        this.#entries.set(id, { report, receivedAtMs: item.received_at_ms, samples: [], restarts, warnings: [] });
      } catch { /* one damaged entry loses only its own node */ }
    }
  }
}
