/**
 * Controlling the nodes from Studio and the phone, the server's part that keeps state: one order (to one node, or to every node that reports), arm -> token -> execute for each node, the
 * line of each node followed from "pending" to what it did (it said it is restarting and came back, it applied a pause, it refused ...), the operations kept for a few weeks, and the
 * state of each node as the orders left it (paused, standby, in maintenance) for the consoles and for the alerts that must not ring while a node is being worked on.
 *
 * What it enforces, each refusal audited:
 *   - only a node that reports (a radar, solar, electrical, alarm or hmi node) is ever ordered: the server and the CM5 are not nodes and have no health report;
 *   - one order at a time per node; a restart at most once a minute per node; no more than ten orders a minute altogether;
 *   - the order is checked against the shared contract before it is published, and an execute carries the one-time token the node gave to the arm, bound to the operation;
 *   - the token never leaves this object: it is not in a response, an audit line, the history, a log or the file the operations are kept in.
 * What it does not do: decide anything about a node. An order that was sent is not an order that was done; only the node's own answer says that, and for a restart only its next report.
 * There is no operation that erases a node's settings, none that puts it to deep sleep and none that sets a wake timer: the contract has no such word.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { randomBytes } from "node:crypto";
import type { AuditLog } from "./audit.js";
import type { SystemInput } from "./connections.js";
import { JsonFile } from "./history.js";
import type { NodeHealthDetail, NodeHealthMessage, NodeHealthView } from "./node_health.js";
import {
  ControlError, DURATIONS, MAX_SLOT, NODE_ID, ROLLING_GAP_S, parseControlCommand, personFor, rollingSchedule, type ControlCommand, type ControlMode, type ControlOperation, type ControlRefusal, type ControlResult,
  type NodeControlState,
} from "./node_control.js";

export type LineStage = "pending" | "armed" | "sent" | "acknowledged" | "applied" | "offline" | "back" | "refused" | "no_answer" | "not_back";
const ACTIVE: readonly LineStage[] = ["pending", "armed", "sent", "acknowledged", "offline"];

export type ControlLine = {
  node_id: string; family: string; stage: LineStage; state?: NodeControlState; maintenance?: boolean; refusal?: string; slot?: number; restart_in_s?: number; until_s?: number;
  firmware_before?: string; firmware_after?: string; acknowledged_at?: string; applied_at?: string; offline_at?: string; back_at?: string; back_after_s?: number; diagnostics?: Record<string, unknown>;
};
export type ControlOperationRecord = {
  id: string; scope: "node" | "all"; operation: ControlOperation; mode: ControlMode; duration_s?: number; actor: string; origin?: string; created_at: string; updated_at: string;
  state: "arming" | "running" | "done"; nodes: ControlLine[];
};

/** What the server remembers of the orders it gave a node: the state they left it in. */
export type NodeMemory = { state: NodeControlState; since_ms?: number; by?: string; until_ms?: number; maintenance_until_ms?: number };
/** The state of a node as the orders left it, for a console (see NodeHealthStore's `remembered`). */
export type RememberedControl = { state: NodeControlState; maintenance: boolean; since_ms?: number; by?: string; until_s?: number; maintenance_until_s?: number };

export type ControlTarget = { id: string; family: string };
export type ControlInput = { scope: "node" | "all"; operation: ControlOperation; mode: ControlMode; duration_s?: number; actor: string; origin?: string; targets: ControlTarget[] };

export type NodeControlOptions = {
  /** Publish to the broker; throws when it is not connected. */
  publish: (topic: string, payload: string) => void;
  audit: AuditLog;
  /** Writes an event of the system in the history (fixed words, never free text). */
  history: (input: SystemInput) => void;
  /** The health of a node, as the store keeps it: who is a node at all, whether it reports, what it runs and how long it has been up. */
  health: (node: string) => NodeHealthDetail | undefined;
  /** Every node that has a health report. */
  nodes: () => NodeHealthView[];
  file?: string;
  now?: () => number;
  random?: () => string;
  /** Called when the alerts about a node's silence must stop (a restart or a maintenance began) and when they may come back. */
  onHold?: (node: string, held: boolean) => void;
  armWaitMs?: number;
  /** How long after a restart was acknowledged the node may take to report again. */
  backWaitMs?: number;
  keep?: number;
  keepMs?: number;
  /** Orders accepted in a minute, over all nodes. */
  perMinute?: number;
};

type Private = { armId?: string; execId?: string; token?: string; createdMs: number; sentMs?: number; ackMs?: number; uptimeAtAck?: number; deadlineMs?: number; waitUntilMs?: number };
type Pending = { op: string; node: string; action: "arm" | "execute" };
type Saved = { schema: 1; operations: ControlOperationRecord[]; memory: Record<string, NodeMemory>; restarts: Record<string, number> };

const WEEKS_MS = 28 * 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

export class NodeControlService {
  readonly #o: Required<Omit<NodeControlOptions, "file" | "onHold">> & Pick<NodeControlOptions, "file" | "onHold">;
  readonly #records = new Map<string, ControlOperationRecord>();
  readonly #private = new Map<string, Map<string, Private>>();
  readonly #pending = new Map<string, Pending>();
  readonly #memory = new Map<string, NodeMemory>();
  readonly #restartedAt = new Map<string, number>();
  readonly #created: number[] = [];
  readonly #held = new Set<string>();
  readonly #file?: JsonFile<Saved>;
  #dirty = false;

  constructor(options: NodeControlOptions) {
    this.#o = {
      ...options, now: options.now ?? (() => Date.now()), random: options.random ?? (() => randomBytes(8).toString("hex")), armWaitMs: options.armWaitMs ?? 20_000, backWaitMs: options.backWaitMs ?? 240_000,
      keep: options.keep ?? 300, keepMs: options.keepMs ?? WEEKS_MS, perMinute: options.perMinute ?? 10,
    };
    if (options.file) {
      this.#file = new JsonFile(options.file);
      const saved = this.#file.read();
      const now = this.#o.now();
      if (saved && Array.isArray(saved.operations)) {
        for (const item of saved.operations.slice(-this.#o.keep)) {
          if (typeof item !== "object" || item === null || typeof item.id !== "string" || !Array.isArray(item.nodes)) continue;
          // An order that was on its way when the server stopped: what had not been sent is over; a restart that was acknowledged is still waited for.
          const secrets = new Map<string, Private>();
          for (const line of item.nodes) {
            if (line.stage === "pending" || line.stage === "armed" || line.stage === "sent") { line.stage = "no_answer"; line.refusal = "server_restarted"; }
            else if (line.stage === "acknowledged" || line.stage === "offline") secrets.set(line.node_id, { createdMs: now, ackMs: now, deadlineMs: now + this.#o.backWaitMs });
          }
          if (secrets.size > 0) this.#private.set(item.id, secrets);
          this.#recompute(item);
          this.#records.set(item.id, item);
        }
      }
      for (const [node, memory] of Object.entries(saved?.memory ?? {}).slice(0, 256)) if (NODE_ID.test(node) && memory && typeof memory.state === "string") this.#memory.set(node, memory);
      for (const [node, at] of Object.entries(saved?.restarts ?? {}).slice(0, 256)) if (NODE_ID.test(node) && typeof at === "number") this.#restartedAt.set(node, at);
    }
    this.#syncHolds();
  }

  // ---- what is known ------------------------------------------------------------------------------------------------------------------------

  list(): ControlOperationRecord[] { return [...this.#records.values()].reverse().map(item => structuredClone(item)); }
  get(id: string): ControlOperationRecord | undefined { const item = this.#records.get(id); return item ? structuredClone(item) : undefined; }

  /** True while the alerts about this node's silence must not ring: it is in maintenance, or a restart that was ordered is under way. */
  isHeld(node: string): boolean {
    const memory = this.#memory.get(node);
    if (memory?.maintenance_until_ms !== undefined && memory.maintenance_until_ms > this.#o.now()) return true;
    return this.#restarting(node);
  }

  /** The state the orders left a node in, or undefined while it is simply running. */
  memoryOf(node: string): RememberedControl | undefined {
    const memory = this.#memory.get(node);
    if (!memory) return undefined;
    const now = this.#o.now();
    const paused = memory.state === "paused" && memory.until_ms !== undefined && memory.until_ms <= now;
    const state: NodeControlState = paused ? "running" : memory.state;
    const maintenance = memory.maintenance_until_ms !== undefined && memory.maintenance_until_ms > now;
    if (state === "running" && !maintenance) return undefined;
    return {
      state, maintenance, ...(state !== "running" && memory.since_ms ? { since_ms: memory.since_ms } : {}), ...(state !== "running" && memory.by ? { by: memory.by } : {}),
      ...(state === "paused" && memory.until_ms !== undefined ? { until_s: Math.max(0, Math.round((memory.until_ms - now) / 1000)) } : {}),
      ...(maintenance && memory.maintenance_until_ms !== undefined ? { maintenance_until_s: Math.max(0, Math.round((memory.maintenance_until_ms - now) / 1000)) } : {}),
    };
  }

  #restarting(node: string): boolean {
    for (const [id, lines] of this.#private) {
      const record = this.#records.get(id);
      if (!record || record.operation !== "restart") continue;
      const line = record.nodes.find(item => item.node_id === node);
      if (line && lines.has(node) && (line.stage === "sent" || line.stage === "acknowledged" || line.stage === "offline")) return true;
    }
    return false;
  }

  #busy(node: string): boolean {
    for (const record of this.#records.values()) for (const line of record.nodes) if (line.node_id === node && ACTIVE.includes(line.stage)) return true;
    return false;
  }

  // ---- the order ------------------------------------------------------------------------------------------------------------------------------

  /** Whether the node's own report says it is already as the order would leave it (a node whose firmware does not report it is never judged here: it decides for itself). */
  static alreadyIn(operation: ControlOperation, view: NodeHealthView | undefined): boolean {
    const control = view?.control;
    if (!control || view?.stale) return false;
    switch (operation) {
      case "pause": return control.state === "paused";
      case "standby": return control.state === "standby";
      case "resume": return control.state === "running";
      case "maintenance_on": return control.maintenance;
      case "maintenance_off": return !control.maintenance && control.source === "node";
      default: return false;
    }
  }

  /**
   * Gives the order to the nodes and returns the operation (the nodes' answers arrive later, see `handleResult`). Throws a ControlError when it must not be sent. The targets are the nodes
   * that report; the caller has chosen them, this checks them again (a node that is not one, one that is busy, one restarted a moment ago).
   */
  start(input: ControlInput): ControlOperationRecord {
    const now = this.#o.now();
    const denied = (code: string, message: string, status: number): never => {
      this.#o.audit.record({ action: "node_control.request", outcome: "denied", actor: input.actor, target: input.scope === "all" ? "all" : input.targets[0]?.id, detail: `${input.operation}: ${code}` });
      throw new ControlError(code, message, status);
    };
    if (input.targets.length === 0) return denied("no_nodes", "no node has reported lately", 409);
    for (const target of input.targets) if (!NODE_ID.test(target.id) || target.id === "all") return denied("invalid_request", "that is not the name of a node", 400);
    while (this.#created.length > 0 && now - this.#created[0] > 60_000) this.#created.shift();
    if (this.#created.length >= this.#o.perMinute) return denied("rate_limited", "too many orders to nodes in the last minute", 429);
    for (const target of input.targets) if (this.#busy(target.id)) return denied("busy", `an order for ${target.id} is still under way`, 409);
    if (input.operation === "restart") for (const target of input.targets) if (now - (this.#restartedAt.get(target.id) ?? -Infinity) < 60_000) return denied("rate_limited", `${target.id} was restarted less than a minute ago`, 429);
    let slots = new Map<string, number>();
    if (input.mode === "rolling") {
      try { slots = rollingSchedule(input.targets.map(item => ({ id: item.id, family: item.family }))); } catch (error) { if (error instanceof ControlError) return denied(error.code, error.message, error.status); throw error; }
    }
    const record: ControlOperationRecord = {
      id: this.#o.random(), scope: input.scope, operation: input.operation, mode: input.mode, ...(input.duration_s !== undefined ? { duration_s: input.duration_s } : {}), actor: input.actor,
      ...(input.origin ? { origin: input.origin } : {}), created_at: iso(now), updated_at: iso(now), state: "arming",
      nodes: input.targets.map(target => ({ node_id: target.id, family: target.family, stage: "pending" as LineStage, ...(slots.has(target.id) ? { slot: slots.get(target.id) } : {}) })),
    };
    const secrets = new Map<string, Private>();
    for (const line of record.nodes) secrets.set(line.node_id, { createdMs: now });
    this.#records.set(record.id, record);
    this.#private.set(record.id, secrets);
    // Nothing is sent to anybody until every line exists, so a failure half way leaves no line without an owner.
    let sent = 0;
    for (const line of record.nodes) {
      this.#history("control_requested", record, line, "allowed");
      try { this.#publishArm(record, line); sent += 1; } catch { this.#finishLine(record, line, "no_answer", "mqtt_unavailable"); }
    }
    if (sent === 0) {
      this.#records.delete(record.id); this.#private.delete(record.id);
      for (const [commandId, pending] of this.#pending) if (pending.op === record.id) this.#pending.delete(commandId);
      this.#o.audit.record({ action: "node_control.request", outcome: "failed", actor: input.actor, target: input.scope === "all" ? "all" : input.targets[0].id, detail: `${input.operation}: the broker is not connected` });
      throw new ControlError("mqtt_unavailable", "the order could not be sent: the broker is not connected", 503);
    }
    this.#created.push(now);
    this.#o.audit.record({ action: "node_control.request", outcome: "allowed", actor: input.actor, target: input.scope === "all" ? `all (${record.nodes.length} nodes)` : record.nodes[0].node_id, detail: `${input.operation} ${record.id} ${input.mode}${input.duration_s ? ` ${input.duration_s}s` : ""}${input.origin ? ` from ${input.origin}` : ""}` });
    this.#recompute(record);
    this.#syncHolds();
    this.#save(true);
    return structuredClone(record);
  }

  #command(record: ControlOperationRecord, node: string, action: "arm" | "execute", extra: Partial<ControlCommand> = {}): { id: string; message: ControlCommand } {
    const id = this.#o.random();
    const message: ControlCommand = {
      kind: "node_control_command", node_id: node, timestamp_ms: this.#o.now(), command_id: id, action, operation: record.operation, mode: record.mode, requested_by: personFor(record.actor), ...extra,
    };
    parseControlCommand(message);   // nothing leaves this server that the shared contract would refuse
    return { id, message };
  }

  #publishArm(record: ControlOperationRecord, line: ControlLine): void {
    const { id, message } = this.#command(record, line.node_id, "arm");
    this.#o.publish(`armor/control/${line.node_id}/command`, JSON.stringify(message));
    this.#private.get(record.id)!.get(line.node_id)!.armId = id;
    this.#pending.set(id, { op: record.id, node: line.node_id, action: "arm" });
  }

  /** The node armed: its token goes back in the execute, at once, together with what the operation needs (a slot, a duration). */
  #publishExecute(record: ControlOperationRecord, line: ControlLine, token: string): void {
    const secret = this.#private.get(record.id)!.get(line.node_id)!;
    const extra: Partial<ControlCommand> = { token };
    if (record.operation === "restart" && record.mode === "rolling") extra.slot = Math.min(line.slot ?? 0, MAX_SLOT);
    if (record.duration_s !== undefined && DURATIONS[record.operation]) extra.duration_s = record.duration_s;
    const { id, message } = this.#command(record, line.node_id, "execute", extra);
    this.#o.publish(`armor/control/${line.node_id}/command`, JSON.stringify(message));
    const now = this.#o.now();
    secret.execId = id; secret.sentMs = now;
    secret.waitUntilMs = now + 30_000 + (record.mode === "rolling" ? (line.slot ?? 0) * ROLLING_GAP_S * 1000 : 0);
    this.#pending.set(id, { op: record.id, node: line.node_id, action: "execute" });
    line.stage = "sent";
    if (record.operation === "restart") this.#restartedAt.set(line.node_id, now);
  }

  // ---- the node's answers -------------------------------------------------------------------------------------------------------------------

  /** The answer of a node. One that answers an order this server did not send, or does not match it, is dropped and audited (a repeated answer finds nothing waiting). */
  handleResult(result: ControlResult, topicNode: string): void {
    const pending = this.#pending.get(result.command_id);
    const record = pending ? this.#records.get(pending.op) : undefined;
    const line = record?.nodes.find(item => item.node_id === topicNode);
    if (!pending || !record || !line || pending.node !== topicNode || result.node_id !== topicNode || pending.action !== result.action || result.operation !== record.operation) {
      this.#o.audit.record({ action: "node_control.result", outcome: "denied", target: topicNode, detail: `${result.action} ${result.operation}: not an answer to an order that is waiting` });
      return;
    }
    this.#pending.delete(result.command_id);
    const now = this.#o.now();
    const secrets = this.#private.get(record.id)?.get(topicNode);
    if (!secrets || !ACTIVE.includes(line.stage)) return;
    if (!result.accepted) { this.#finishLine(record, line, "refused", result.refusal); this.#after(record); return; }
    if (result.action === "arm") {
      if (line.stage !== "pending" || !result.token) return;
      line.stage = "armed";
      try { this.#publishExecute(record, line, result.token); } catch { this.#finishLine(record, line, "no_answer", "mqtt_unavailable"); }
      this.#after(record);
      return;
    }
    if (line.stage !== "sent") return;
    if (result.stage === "restarting") {
      line.stage = "acknowledged"; line.acknowledged_at = iso(now);
      if (result.restart_in_s !== undefined) line.restart_in_s = result.restart_in_s;
      if (result.firmware) line.firmware_before = result.firmware;
      secrets.ackMs = now; secrets.uptimeAtAck = result.uptime_s;
      secrets.deadlineMs = now + (result.restart_in_s ?? 0) * 1000 + this.#o.backWaitMs;
      this.#history("control_acknowledged", record, line, "allowed");
    } else if (result.stage === "diagnostics") {
      line.stage = "applied"; line.applied_at = iso(now);
      if (result.diagnostics) { line.diagnostics = { ...result.diagnostics }; line.state = result.diagnostics.state; line.maintenance = result.diagnostics.maintenance; }
      this.#history("control_applied", record, line, "allowed");
    } else {
      line.stage = "applied"; line.applied_at = iso(now);
      if (result.state) line.state = result.state;
      if (result.maintenance !== undefined) line.maintenance = result.maintenance;
      if (result.until_s !== undefined) line.until_s = result.until_s;
      this.#remember(record.operation, topicNode, result, now);
      this.#history("control_applied", record, line, "allowed");
    }
    secrets.token = undefined;
    this.#after(record);
  }

  /** What an applied order leaves in the server's memory of the node. */
  #remember(operation: ControlOperation, node: string, result: ControlResult, now: number): void {
    const memory: NodeMemory = { ...(this.#memory.get(node) ?? { state: "running" as NodeControlState }) };
    if (result.state) {
      memory.state = result.state;
      if (result.state === "running") { delete memory.since_ms; delete memory.by; delete memory.until_ms; }
      else { memory.since_ms = result.since_ms || now; memory.by = result.requested_by; if (result.state === "paused" && operation === "pause" && result.until_s !== undefined) memory.until_ms = now + result.until_s * 1000; else delete memory.until_ms; }
    }
    if (result.maintenance === false) delete memory.maintenance_until_ms;
    else if (result.maintenance === true && operation === "maintenance_on") memory.maintenance_until_ms = now + (result.until_s ?? DURATIONS.maintenance_on![2]) * 1000;
    this.#memory.set(node, memory);
  }

  // ---- the health of the nodes --------------------------------------------------------------------------------------------------------------

  /** The node's own report: what it says of its state is the truth, and a restart is over when a report comes from a node that has started again. */
  handleReport(report: NodeHealthMessage): void {
    const now = this.#o.now();
    const memory = this.#memory.get(report.node_id);
    if (report.control_state !== undefined || report.maintenance !== undefined) {
      const next: NodeMemory = { ...(memory ?? { state: "running" as NodeControlState }) };
      if (report.control_state !== undefined) {
        next.state = report.control_state;
        if (report.control_state === "running") { delete next.since_ms; delete next.by; delete next.until_ms; }
        else { if (report.control_since_ms !== undefined) next.since_ms = report.control_since_ms || next.since_ms; if (report.control_by !== undefined) next.by = report.control_by; if (report.control_until_s !== undefined) next.until_ms = now + report.control_until_s * 1000; }
      }
      if (report.maintenance === false) delete next.maintenance_until_ms;
      else if (report.maintenance === true && report.maintenance_until_s !== undefined) next.maintenance_until_ms = now + report.maintenance_until_s * 1000;
      this.#memory.set(report.node_id, next);
      this.#dirty = true;
    }
    for (const [id, secrets] of this.#private) {
      const record = this.#records.get(id);
      if (!record || record.operation !== "restart") continue;
      const line = record.nodes.find(item => item.node_id === report.node_id);
      const secret = secrets.get(report.node_id);
      if (!line || !secret || (line.stage !== "acknowledged" && line.stage !== "offline")) continue;
      // The node has started again when its uptime is less than it was when it said it was going (it can not have been up that long since).
      const before = secret.uptimeAtAck ?? Infinity;
      const since = secret.ackMs !== undefined ? Math.round((now - secret.ackMs) / 1000) : 0;
      if (report.uptime_s + 8 >= before + since) continue;
      line.stage = "back"; line.back_at = iso(now); line.firmware_after = report.firmware;
      if (secret.sentMs !== undefined) line.back_after_s = Math.max(0, Math.round((now - secret.sentMs) / 1000));
      this.#history("control_back", record, line, "allowed", report.firmware);
      this.#o.audit.record({ action: "node_control.result", outcome: "allowed", actor: record.actor, target: line.node_id, detail: `restart ${record.id}: back after ${line.back_after_s ?? 0}s` });
      this.#after(record);
    }
    this.#syncHolds();
  }

  /** The broker says a node was lost without a goodbye (its last will). */
  handleOffline(node: string): void {
    const now = this.#o.now();
    for (const record of this.#records.values()) {
      if (record.operation !== "restart") continue;
      const line = record.nodes.find(item => item.node_id === node);
      if (line?.stage === "acknowledged") { line.stage = "offline"; line.offline_at = iso(now); record.updated_at = iso(now); this.#dirty = true; }
    }
  }

  // ---- time -----------------------------------------------------------------------------------------------------------------------------------

  /** Call now and then: an order nobody answered is over, a restart whose node does not come back is lost, a pause or a maintenance window that ended is forgotten, the old are dropped. */
  sweep(): void {
    const now = this.#o.now();
    for (const record of this.#records.values()) {
      if (record.state === "done") continue;
      const secrets = this.#private.get(record.id);
      for (const line of record.nodes) {
        const secret = secrets?.get(line.node_id);
        if (!secret) continue;
        if (line.stage === "pending" && now - secret.createdMs > this.#o.armWaitMs) this.#finishLine(record, line, "no_answer", "no_arm_answer");
        else if (line.stage === "sent" && secret.waitUntilMs !== undefined && now > secret.waitUntilMs) this.#finishLine(record, line, "no_answer", "no_answer");
        if (line.stage === "acknowledged" && this.#o.health(line.node_id)?.stale && secret.ackMs !== undefined && now - secret.ackMs > 5_000) { line.stage = "offline"; line.offline_at = iso(now); record.updated_at = iso(now); this.#dirty = true; }
        if ((line.stage === "acknowledged" || line.stage === "offline") && secret.deadlineMs !== undefined && now > secret.deadlineMs) this.#finishLine(record, line, "not_back", "not_back");
      }
      this.#recompute(record);
    }
    for (const [node, memory] of this.#memory) {
      if (memory.state === "paused" && memory.until_ms !== undefined && memory.until_ms <= now) { memory.state = "running"; delete memory.since_ms; delete memory.by; delete memory.until_ms; this.#dirty = true; }
      if (memory.maintenance_until_ms !== undefined && memory.maintenance_until_ms <= now) { delete memory.maintenance_until_ms; this.#dirty = true; }
      if (memory.state === "running" && memory.maintenance_until_ms === undefined) { this.#memory.delete(node); this.#dirty = true; }
    }
    for (const [id, record] of this.#records) {
      if (record.state === "done" && (now - Date.parse(record.updated_at) > this.#o.keepMs || this.#records.size > this.#o.keep)) { this.#records.delete(id); this.#private.delete(id); this.#dirty = true; }
    }
    for (const [node, at] of this.#restartedAt) if (now - at > 3_600_000) this.#restartedAt.delete(node);
    this.#syncHolds();
    this.#save(false);
  }

  // ---- bookkeeping --------------------------------------------------------------------------------------------------------------------------

  #finishLine(record: ControlOperationRecord, line: ControlLine, stage: LineStage, refusal?: string): void {
    line.stage = stage;
    if (refusal && refusal !== "none") line.refusal = refusal;
    const secret = this.#private.get(record.id)?.get(line.node_id);
    if (secret) { secret.token = undefined; if (stage !== "not_back") this.#private.get(record.id)?.delete(line.node_id); }
    for (const [commandId, pending] of this.#pending) if (pending.op === record.id && pending.node === line.node_id) this.#pending.delete(commandId);
    if (stage === "refused") this.#history("control_refused", record, line, "denied");
    else if (stage === "no_answer") this.#history("control_refused", record, line, "failed");
    else if (stage === "not_back") this.#history("control_lost", record, line, "failed");
    this.#o.audit.record({ action: "node_control.result", outcome: stage === "refused" ? "denied" : "failed", actor: record.actor, target: line.node_id, detail: `${record.operation} ${record.id}: ${stage}${line.refusal ? ` ${line.refusal}` : ""}` });
  }

  /** A line moved: the operation's own state, the holds, the file. */
  #after(record: ControlOperationRecord): void {
    record.updated_at = iso(this.#o.now());
    this.#recompute(record);
    this.#syncHolds();
    this.#save(record.state === "done");
  }

  #recompute(record: ControlOperationRecord): void {
    const active = record.nodes.some(line => ACTIVE.includes(line.stage));
    const next = !active ? "done" : record.nodes.every(line => line.stage === "pending") ? "arming" : "running";
    if (next !== record.state) { record.state = next; record.updated_at = iso(this.#o.now()); this.#dirty = true; }
    if (record.state === "done") for (const [commandId, pending] of this.#pending) if (pending.op === record.id) this.#pending.delete(commandId);
    if (record.state === "done") this.#private.delete(record.id);
  }

  #history(action: "control_requested" | "control_acknowledged" | "control_refused" | "control_applied" | "control_back" | "control_lost", record: ControlOperationRecord, line: ControlLine, outcome: "allowed" | "denied" | "failed", firmware?: string): void {
    try {
      const version = firmware ?? line.firmware_before ?? this.#o.health(line.node_id)?.firmware;
      // The operation travels in the field the history has for a name of this kind (the same fixed words as the contract's operations, which fit the pattern of a profile): no free text can get in.
      this.#o.history({ category: "node", action, subject: line.node_id, by: record.actor, profile: record.operation, outcome, ...(version ? { version } : {}) });
    } catch { /* the history never breaks what it records */ }
  }

  /** The nodes whose silence must not be news have changed: tell whoever listens. */
  #syncHolds(): void {
    const now = new Set<string>();
    for (const node of new Set([...this.#memory.keys(), ...this.#restartedAt.keys()])) if (this.isHeld(node)) now.add(node);
    for (const node of now) if (!this.#held.has(node)) { this.#held.add(node); this.#o.onHold?.(node, true); }
    for (const node of [...this.#held]) if (!now.has(node)) { this.#held.delete(node); this.#o.onHold?.(node, false); }
  }

  #save(now: boolean): void {
    if (!this.#file || (!this.#dirty && !now)) return;
    this.#dirty = false;
    try {
      const operations = [...this.#records.values()].slice(-this.#o.keep);
      this.#file.write({ schema: 1, operations, memory: Object.fromEntries(this.#memory), restarts: Object.fromEntries(this.#restartedAt) });
    } catch { /* the operations are also in memory; the next change writes again */ }
  }

  flush(): void { this.#save(true); }
}
