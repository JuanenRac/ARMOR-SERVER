/**
 * Writing to a Pylontech battery through a gateway node, the server's part: the one place that sends a node an order to change what a battery keeps, and it is OFF unless the operator
 * turned it on (ARMOR_BATTERY_WRITE=1). It is the server's layer of the protection and never the only one: the node has its own setting (and keeps the battery's service password, which
 * never reaches the server), its own preconditions, its one-time token and its pause after a write; the broker's access list has to allow the two topics.
 *
 * What it enforces before an order is published, each refusal audited:
 *   - writing is turned on in this server; the caller is an administrator who proved themselves again a moment ago (routes/battery_ops.ts);
 *   - the node has a battery that reports, the operation is one of the table's and its values are inside the ranges, and the serial number is well formed;
 *   - one operation at a time per node and port; an execute follows an arm the node ACCEPTED a moment ago, carries the one-time token the node gave then and the serial number typed again.
 * The token never leaves this object: it is not in a response, an audit line, a log or the file the operations are kept in. Every operation is kept (what was read before and after, the
 * difference, the transcript the node sent, already without the password) so that the history can show who did what to which battery and how it ended.
 * What it does not do: decide anything about the battery. An accepted order is not an operation that worked; only the node's final answer, with its read-back, says that.
 * Nothing here has ever been connected to a node that writes to a battery.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { randomBytes } from "node:crypto";
import type { AuditLog } from "./audit.js";
import { BATTERY_CATALOG } from "./battery_catalog.js";
import {
  BatteryOpsError, describeImage, differences, opSpec, outputBefore, parseBatteryCommand, validNode, validSerial, validateBatteryParams,
  type BatteryIdentity, type BatteryResult, type Difference, type ImageInfo,
} from "./battery_ops.js";
import { JsonFile } from "./history.js";
import type { SolarStore } from "./solar.js";

export type BatteryStage = "arming" | "armed" | "starting" | "running" | "done" | "rejected" | "expired" | "lost" | "withdrawn";
export type BatteryOperation = {
  id: string; node: string; port: number; op: string; params: Record<string, unknown>; actor: string; created_at: string; updated_at: string; stage: BatteryStage;
  summary?: string; risk?: "low" | "medium" | "high" | "irreversible"; atomic?: boolean; canonical?: string; battery?: BatteryIdentity; refusal?: string; snapshot_before?: string;
  outcome?: "running" | "ok" | "failed" | "partial" | "retry" | "rejected"; code?: string; steps_done?: number; steps_total?: number; packets_sent?: number; packets_total?: number;
  before?: string; after?: string; diff?: Difference[]; transcript?: string; armed_until?: string; restore?: { op: string; params: Record<string, unknown> } | null;
  staging?: { sent: number; total: number }; writes_started?: boolean; image?: { id: string; board: string; version: string; sha256: string; size: number }; cancel_requested?: boolean;
};

export type BatteryWriteOptions = {
  /** The operator's decision: false unless ARMOR_BATTERY_WRITE=1. */
  enabled: boolean;
  solar: SolarStore;
  /** Publish to the broker; throws when it is not connected. */
  publish: (topic: string, payload: string) => void;
  audit: AuditLog;
  /** The file where the operations are kept; without it they are kept in memory only. */
  file?: string;
  now?: () => number;
  random?: () => string;
  /** How long an arm is good for here (the node's own window is two minutes). */
  armWindowMs?: number;
  /** How long a node may be silent while it works before the operation is called lost. */
  silenceMs?: number;
  keep?: number;
  imageTtlMs?: number;
  /** How long to wait for the node to keep one piece of an image. */
  pieceWaitMs?: number;
};

type Private = { token?: string; serial: string; sentParams: Record<string, unknown>; imageId?: string; lastMessageMs: number; armedAtMs?: number; commandIds: Set<string> };
type Pending = { id: string; kind: "arm" | "execute" | "cancel" | "stage" };
type Kept = { bytes: Buffer; info: ImageInfo; atMs: number };

const CHUNK = BATTERY_CATALOG.limits.chunk_bytes;

export class BatteryWriteService {
  readonly #o: Required<Omit<BatteryWriteOptions, "file">> & { file?: string };
  readonly #records = new Map<string, BatteryOperation>();
  readonly #private = new Map<string, Private>();
  readonly #pending = new Map<string, Pending>();
  readonly #images = new Map<string, Kept>();
  readonly #waiting = new Map<string, (answer: BatteryResult) => void>();
  readonly #file?: JsonFile<{ schema: 1; operations: BatteryOperation[] }>;

  constructor(options: BatteryWriteOptions) {
    this.#o = {
      ...options, now: options.now ?? (() => Date.now()), random: options.random ?? (() => randomBytes(8).toString("hex")), armWindowMs: options.armWindowMs ?? 115_000,
      silenceMs: options.silenceMs ?? 120_000, keep: options.keep ?? 200, imageTtlMs: options.imageTtlMs ?? 3_600_000, pieceWaitMs: options.pieceWaitMs ?? 8_000,
    };
    if (options.file) {
      this.#file = new JsonFile(options.file);
      const stored = this.#file.read();
      if (stored && Array.isArray(stored.operations)) {
        for (const item of stored.operations.slice(-this.#o.keep)) {
          if (typeof item !== "object" || item === null || typeof item.id !== "string") continue;
          // an operation that was on its way when the server stopped is over as far as anybody can tell: the node's answer, if it comes, finds nothing waiting
          if (["arming", "armed", "starting", "running"].includes(item.stage)) { item.stage = "lost"; item.code = "server_restarted"; }
          this.#records.set(item.id, item);
        }
      }
    }
  }

  get enabled(): boolean { return this.#o.enabled; }

  catalog(): { enabled: boolean; catalog: typeof BATTERY_CATALOG } { return { enabled: this.#o.enabled, catalog: BATTERY_CATALOG }; }

  list(): BatteryOperation[] { return [...this.#records.values()].reverse().map(item => ({ ...item })); }
  get(id: string): BatteryOperation | undefined { const item = this.#records.get(id); return item ? { ...item } : undefined; }

  // ---- images -------------------------------------------------------------------------------------------------------------------------------

  /** Keeps a firmware image in memory for an hour. Throws a BatteryOpsError when it is not an image of the family. Nothing is sent to anybody. */
  storeImage(actor: string, bytes: Buffer): ImageInfo & { image_id: string } {
    this.#requireEnabled(actor, "battery.image");
    const info = (() => { try { return describeImage(bytes); } catch (error) { this.#o.audit.record({ action: "battery.image", outcome: "denied", actor, detail: error instanceof Error ? error.message : "refused" }); throw error; } })();
    const now = this.#o.now();
    for (const [id, kept] of this.#images) if (now - kept.atMs > this.#o.imageTtlMs) this.#images.delete(id);
    if (this.#images.size >= 2) { const oldest = [...this.#images.entries()].sort((a, b) => a[1].atMs - b[1].atMs)[0]; this.#images.delete(oldest[0]); }
    const id = this.#o.random();
    this.#images.set(id, { bytes: Buffer.from(bytes), info, atMs: now });
    this.#o.audit.record({ action: "battery.image", outcome: "allowed", actor, detail: `${info.board} ${info.version} ${info.size} bytes sha256 ${info.sha256}` });
    return { ...info, image_id: id };
  }

  // ---- the order: arm ---------------------------------------------------------------------------------------------------------------------------

  /** Step one. Resolves with the operation (still arming: the node's answer arrives later, see `handleResult`); throws a BatteryOpsError when it must not be sent. */
  arm(actor: string, input: { node: unknown; port: unknown; op: unknown; params?: unknown; serial: unknown }): BatteryOperation {
    this.#requireEnabled(actor, "battery.arm");
    const denied = (code: string, message: string, status = 400): never => {
      this.#o.audit.record({ action: "battery.arm", outcome: "denied", actor, target: `${String(input.node)}/${String(input.port)}`, detail: `${String(input.op)}: ${code}` });
      throw new BatteryOpsError(code, message, status);
    };
    if (!validNode(input.node) || typeof input.port !== "number" || !Number.isInteger(input.port) || input.port < 1 || input.port > 10 || typeof input.op !== "string" || !opSpec(input.op) || !validSerial(input.serial)) {
      return denied("invalid_request", "a node, a port from 1 to 10, an operation of the table and the battery's serial number are required");
    }
    const node = input.node, port = input.port, op = input.op, serial = input.serial;
    let imageId: string | undefined;
    let sentParams: Record<string, unknown>;
    try {
      if (op === "firmware_update") {
        const given = (typeof input.params === "object" && input.params !== null ? input.params : {}) as Record<string, unknown>;
        imageId = typeof given.image_id === "string" ? given.image_id : undefined;
        const kept = imageId ? this.#images.get(imageId) : undefined;
        if (!kept || this.#o.now() - kept.atMs > this.#o.imageTtlMs) return denied("image_missing", "keep the firmware image first (it is kept for an hour)", 409);
        sentParams = validateBatteryParams(op, { image_size: kept.info.size, image_crc32: kept.info.crc32, image_version: kept.info.version, ...(given.clear_eeprom === true ? { clear_eeprom: true } : {}) });
      } else {
        sentParams = validateBatteryParams(op, input.params);
      }
    } catch (error) {
      if (error instanceof BatteryOpsError) return denied(error.code, error.message, error.status);
      throw error;
    }
    if (!this.#o.solar.list().some(view => view.node_id === node && view.kind === "battery" && !view.stale && !view.example)) return denied("unknown_node", "no battery of that node is reporting", 404);
    this.#sweepNow();
    for (const record of this.#records.values()) {
      if (record.node !== node || record.port !== port) continue;
      if (record.stage === "arming" || record.stage === "starting" || record.stage === "running") return denied("busy", "an operation on this battery is still under way", 409);
      if (record.stage === "armed") { record.stage = "withdrawn"; record.updated_at = new Date(this.#o.now()).toISOString(); this.#private.delete(record.id); }
    }
    const now = this.#o.now();
    const id = this.#o.random();
    const record: BatteryOperation = { id, node, port, op, params: sentParams, actor, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), stage: "arming" };
    if (imageId) { const kept = this.#images.get(imageId)!; record.image = { id: imageId, board: kept.info.board, version: kept.info.version, sha256: kept.info.sha256, size: kept.info.size }; }
    this.#remember(record, { serial, sentParams, imageId, lastMessageMs: now, commandIds: new Set() });
    if (op === "firmware_update") {
      this.#o.audit.record({ action: "battery.arm", outcome: "allowed", actor, target: `${node}/${port}`, detail: `${op} ${id} (staging the image)` });
      void this.#stageThenArm(record);
    } else {
      this.#sendArm(record);
      this.#o.audit.record({ action: "battery.arm", outcome: "allowed", actor, target: `${node}/${port}`, detail: `${op} ${id}` });
    }
    return { ...record };
  }

  #sendArm(record: BatteryOperation): void {
    const secret = this.#private.get(record.id)!;
    this.#publishCommand(record, "arm", { op: record.op, params: secret.sentParams, serial: secret.serial });
  }

  #publishCommand(record: BatteryOperation, action: "arm" | "execute" | "cancel", fields: Record<string, unknown>): string {
    const secret = this.#private.get(record.id);
    const commandId = this.#o.random();
    const message = { kind: "solar_battery_command", node_id: record.node, timestamp_ms: this.#o.now(), command_id: commandId, port: record.port, action, ...fields };
    try {
      parseBatteryCommand(message);   // nothing leaves this server that the shared contract would refuse
      this.#o.publish(`armor/solar/${record.node}/maintenance/command`, JSON.stringify(message));
    } catch (error) {
      this.#finish(record, "rejected", { refusal: "no_answer", code: "mqtt_unavailable" });
      this.#o.audit.record({ action: `battery.${action}`, outcome: "failed", actor: record.actor, target: `${record.node}/${record.port}`, detail: error instanceof Error ? error.message : "not sent" });
      throw new BatteryOpsError("mqtt_unavailable", "the order could not be sent: the broker is not connected", 503);
    }
    this.#pending.set(commandId, { id: record.id, kind: action });
    secret?.commandIds.add(commandId);
    return commandId;
  }

  /** Sends the pieces of the image one by one (each is acknowledged before the next), then the arm. A piece that is refused or not acknowledged ends the operation. */
  async #stageThenArm(record: BatteryOperation): Promise<void> {
    const secret = this.#private.get(record.id);
    const kept = secret?.imageId ? this.#images.get(secret.imageId) : undefined;
    if (!secret || !kept) { this.#finish(record, "rejected", { refusal: "image_missing" }); return; }
    const total = Math.ceil(kept.bytes.length / CHUNK);
    const stageId = this.#o.random();
    record.staging = { sent: 0, total };
    for (let index = 0; index < total; index += 1) {
      if (this.#records.get(record.id)?.stage !== "arming") return;   // withdrawn or lost meanwhile
      const piece = kept.bytes.subarray(index * CHUNK, (index + 1) * CHUNK);
      const commandId = this.#o.random();
      const message = { kind: "solar_battery_command", node_id: record.node, timestamp_ms: this.#o.now(), command_id: commandId, port: record.port, action: "stage",
        stage: { id: stageId, index, total, size: kept.bytes.length, crc32: kept.info.crc32, data: piece.toString("base64") } };
      const answer = new Promise<BatteryResult | undefined>(resolve => {
        const timer = setTimeout(() => { this.#waiting.delete(commandId); resolve(undefined); }, this.#o.pieceWaitMs);
        this.#waiting.set(commandId, result => { clearTimeout(timer); resolve(result); });
      });
      this.#pending.set(commandId, { id: record.id, kind: "stage" });
      try { parseBatteryCommand(message); this.#o.publish(`armor/solar/${record.node}/maintenance/command`, JSON.stringify(message)); } catch { this.#waiting.delete(commandId); this.#finish(record, "rejected", { refusal: "no_answer", code: "mqtt_unavailable" }); return; }
      const result = await answer;
      this.#pending.delete(commandId);
      if (!result) { this.#finish(record, "rejected", { refusal: "no_answer", code: "image_piece_not_acknowledged" }); return; }
      if (!result.accepted) { this.#finish(record, "rejected", { refusal: result.refusal, code: "image_piece_refused" }); return; }
      record.staging = { sent: index + 1, total };
      secret.lastMessageMs = this.#o.now();
      record.updated_at = new Date(secret.lastMessageMs).toISOString();
    }
    delete record.staging;
    if (this.#records.get(record.id)?.stage !== "arming") return;
    try { this.#sendArm(record); } catch { /* the operation was finished by #publishCommand */ }
  }

  // ---- the order: execute -----------------------------------------------------------------------------------------------------------------------

  /** Step two: the operation must be armed and not expired, and the serial number is typed again. */
  execute(actor: string, id: string, serial: unknown): BatteryOperation {
    this.#requireEnabled(actor, "battery.execute");
    const record = this.#records.get(id);
    const denied = (code: string, message: string, status = 409): never => {
      this.#o.audit.record({ action: "battery.execute", outcome: "denied", actor, target: record ? `${record.node}/${record.port}` : undefined, detail: `${record?.op ?? "?"} ${id}: ${code}` });
      throw new BatteryOpsError(code, message, status);
    };
    if (!record) return denied("unknown_operation", "no such operation", 404);
    this.#sweepNow();
    const secret = this.#private.get(id);
    if (record.stage === "expired") return denied("expired", "the operation was armed too long ago: arm it again");
    if (record.stage !== "armed" || !secret?.token || secret.armedAtMs === undefined) return denied("not_armed", "arm the operation first, and wait for the node to accept it");
    if (record.actor !== actor) return denied("not_armed", "an operation is executed by the administrator who armed it");
    if (!validSerial(serial) || serial !== secret.serial) return denied("serial_mismatch", "the serial number is not the one typed to arm", 400);
    if (this.#o.now() - secret.armedAtMs > this.#o.armWindowMs) { this.#finish(record, "expired", {}); return denied("expired", "the operation was armed too long ago: arm it again"); }
    const token = secret.token;
    delete secret.token;   // one arm, one execute
    record.stage = "starting";
    record.updated_at = new Date(this.#o.now()).toISOString();
    secret.lastMessageMs = this.#o.now();
    this.#publishCommand(record, "execute", { op: record.op, params: secret.sentParams, serial: secret.serial, token });
    this.#o.audit.record({ action: "battery.execute", outcome: "allowed", actor, target: `${record.node}/${record.port}`, detail: `${record.op} ${id}${record.canonical ? ` (${record.canonical.slice(0, 120)})` : ""}` });
    this.#save();
    return { ...record };
  }

  /** Withdraws an armed operation, or asks the node to stop one that is running (it refuses when it has gone too far). */
  cancel(actor: string, id: string): BatteryOperation {
    const record = this.#records.get(id);
    if (!record) throw new BatteryOpsError("unknown_operation", "no such operation", 404);
    if (record.stage === "arming" || record.stage === "armed") {
      this.#finish(record, "withdrawn", {});
      this.#o.audit.record({ action: "battery.cancel", outcome: "allowed", actor, target: `${record.node}/${record.port}`, detail: `${record.op} ${id} withdrawn` });
      return { ...record };
    }
    if (record.stage !== "starting" && record.stage !== "running") throw new BatteryOpsError("not_cancellable", "that operation is over", 409);
    if (record.atomic && (record.writes_started === true)) throw new BatteryOpsError("not_cancellable", "that operation can no longer be stopped", 409);
    this.#publishCommand(record, "cancel", {});
    this.#o.audit.record({ action: "battery.cancel", outcome: "allowed", actor, target: `${record.node}/${record.port}`, detail: `${record.op} ${id} stop asked` });
    return { ...record };
  }

  /** Arms the operation that puts back what an earlier one changed. */
  restore(actor: string, id: string, serial: unknown): BatteryOperation {
    const record = this.#records.get(id);
    if (!record) throw new BatteryOpsError("unknown_operation", "no such operation", 404);
    if (!record.restore) throw new BatteryOpsError("not_restorable", "that operation has nothing to put back", 409);
    return this.arm(actor, { node: record.node, port: record.port, op: record.restore.op, params: record.restore.params, serial });
  }

  // ---- the node's answers -----------------------------------------------------------------------------------------------------------------------

  /** The answer of a node. One that answers an order this server did not send, or does not match it, is dropped and audited. */
  handleResult(result: BatteryResult, topicNode: string): void {
    const pending = this.#pending.get(result.command_id);
    const record = pending ? this.#records.get(pending.id) : undefined;
    if (!pending || !record || record.node !== topicNode || result.node_id !== topicNode || record.port !== result.port || pending.kind !== result.action) {
      this.#o.audit.record({ action: "battery.result", outcome: "denied", target: `${topicNode}/${result.port}`, detail: `${result.action}: not an answer to an order that is waiting` });
      return;
    }
    const secret = this.#private.get(record.id);
    const now = this.#o.now();
    if (secret) secret.lastMessageMs = now;
    record.updated_at = new Date(now).toISOString();
    if (pending.kind === "stage") {
      this.#pending.delete(result.command_id);
      this.#waiting.get(result.command_id)?.(result);
      this.#waiting.delete(result.command_id);
      return;
    }
    switch (result.stage) {
      case "armed": {
        this.#pending.delete(result.command_id);
        if (record.stage !== "arming" || !secret) return;
        record.stage = "armed";
        record.summary = result.summary; record.risk = result.risk; record.atomic = result.atomic; record.canonical = result.canonical; record.battery = result.battery;
        if (result.snapshot_before) record.snapshot_before = result.snapshot_before;
        secret.token = result.token; secret.armedAtMs = now;
        record.armed_until = new Date(now + this.#o.armWindowMs).toISOString();
        this.#o.audit.record({ action: "battery.armed", outcome: "allowed", actor: record.actor, target: `${record.node}/${record.port}`, detail: `${record.op} ${record.id}: ${record.canonical ?? ""}`.slice(0, 240) });
        break;
      }
      case "rejected": {
        this.#pending.delete(result.command_id);
        if (pending.kind === "cancel") { this.#o.audit.record({ action: "battery.cancel", outcome: "denied", actor: record.actor, target: `${record.node}/${record.port}`, detail: `${record.op} ${record.id}: ${result.refusal}` }); break; }
        this.#finish(record, "rejected", { refusal: result.refusal });
        break;
      }
      case "started": record.stage = "running"; break;   // the execute stays pending: its progress and its final answer carry its command id
      case "cancel_requested": this.#pending.delete(result.command_id); record.cancel_requested = true; break;
      case "progress": {
        record.stage = "running";
        if (result.steps_done !== undefined) record.steps_done = result.steps_done;
        if (result.steps_total !== undefined) record.steps_total = result.steps_total;
        if (result.packets_sent !== undefined) record.packets_sent = result.packets_sent;
        if (result.packets_total !== undefined) record.packets_total = result.packets_total;
        if (record.atomic && (result.writes_done ?? 0) > 0) record.writes_started = true;
        record.outcome = "running";
        break;
      }
      case "final": {
        for (const [commandId, item] of this.#pending) if (item.id === record.id) this.#pending.delete(commandId);
        const outcome = result.outcome ?? "failed";
        this.#finish(record, "done", { outcome, code: result.code, steps_done: result.steps_done, steps_total: result.steps_total, packets_sent: result.packets_sent, packets_total: result.packets_total,
          before: result.before, after: result.after, transcript: result.transcript });
        record.diff = differences(record.before ?? record.snapshot_before ?? "", record.after ?? "");
        record.restore = outcome === "ok" ? this.#restoreOf(record) : null;
        this.#o.audit.record({ action: "battery.result", outcome: outcome === "ok" ? "allowed" : "failed", actor: record.actor, target: `${record.node}/${record.port}`, detail: `${record.op} ${record.id}: ${outcome}${result.code ? ` ${result.code}` : ""}`.slice(0, 240) });
        break;
      }
      default: break;
    }
    this.#save();
  }

  #restoreOf(record: BatteryOperation): BatteryOperation["restore"] {
    if (record.op !== "output_set") return null;
    const output = String(record.params.output ?? "");
    const previous = outputBefore(record.before ?? record.snapshot_before ?? "", output);
    return previous && previous !== record.params.state ? { op: "output_set", params: { output, state: previous } } : null;
  }

  /** Call now and then: an arm nobody used expires, and an operation whose node went quiet is lost. */
  sweep(): void { this.#sweepNow(); }

  #sweepNow(): void {
    const now = this.#o.now();
    for (const record of this.#records.values()) {
      const secret = this.#private.get(record.id);
      if (!secret) { if (record.stage === "arming" || record.stage === "armed" || record.stage === "starting" || record.stage === "running") this.#finish(record, "lost", { code: "no_state" }); continue; }
      if (record.stage === "armed" && secret.armedAtMs !== undefined && now - secret.armedAtMs > this.#o.armWindowMs) this.#finish(record, "expired", {});
      else if (record.stage === "arming" && now - secret.lastMessageMs > (record.staging ? 30_000 : 60_000)) this.#finish(record, "lost", { refusal: "no_answer", code: "no_answer_to_arm" });
      else if (record.stage === "starting" && now - secret.lastMessageMs > 30_000) this.#finish(record, "lost", { code: "no_answer_to_execute" });
      else if (record.stage === "running" && now - secret.lastMessageMs > this.#o.silenceMs) this.#finish(record, "lost", { code: "node_went_quiet" });
    }
    for (const [id, kept] of this.#images) if (now - kept.atMs > this.#o.imageTtlMs) this.#images.delete(id);
  }

  /** A node that is forgotten leaves nothing armed behind. */
  forget(node: string): void {
    for (const record of this.#records.values()) if (record.node === node && (record.stage === "armed" || record.stage === "arming")) this.#finish(record, "withdrawn", {});
  }

  // ---- bookkeeping ---------------------------------------------------------------------------------------------------------------------------------

  #requireEnabled(actor: string, action: string): void {
    if (this.#o.enabled) return;
    this.#o.audit.record({ action, outcome: "denied", actor, detail: "battery_write_disabled" });
    throw new BatteryOpsError("battery_write_disabled", "writing to batteries is not turned on in this server", 403);
  }

  #remember(record: BatteryOperation, secret: Omit<Private, "commandIds"> & { commandIds: Set<string> }): void {
    this.#records.set(record.id, record);
    this.#private.set(record.id, secret);
    while (this.#records.size > this.#o.keep) { const oldest = this.#records.keys().next().value as string; this.#records.delete(oldest); this.#private.delete(oldest); }
    this.#save();
  }

  #finish(record: BatteryOperation, stage: BatteryStage, fields: Partial<BatteryOperation>): void {
    record.stage = stage;
    Object.assign(record, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
    record.updated_at = new Date(this.#o.now()).toISOString();
    delete record.staging;
    const secret = this.#private.get(record.id);
    if (secret) { delete secret.token; for (const commandId of secret.commandIds) this.#pending.delete(commandId); }
    if (stage === "rejected" || stage === "expired" || stage === "lost" || stage === "withdrawn") this.#o.audit.record({ action: "battery.result", outcome: stage === "withdrawn" ? "allowed" : "failed", actor: record.actor, target: `${record.node}/${record.port}`, detail: `${record.op} ${record.id}: ${stage}${record.refusal ? ` ${record.refusal}` : ""}${record.code ? ` ${record.code}` : ""}`.slice(0, 240) });
    this.#save();
  }

  #save(): void {
    if (!this.#file) return;
    try { this.#file.write({ schema: 1, operations: [...this.#records.values()] }); } catch { /* the operations are also in memory and in the audit trail */ }
  }
}
