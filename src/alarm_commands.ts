/**
 * The way a command reaches the panel of an alarm node: the server may arm and disarm it, and it is OFF unless the operator turned it on (ARMOR_ALARM_COMMANDS=1). It is the
 * server's layer of the protection and never the only one: the node has its own setting (`server.commands`), the broker has its access list (`mqtt_identity.sh alarm-commands`)
 * and a disarm from here carries no PIN at all, which is why all three must agree. See ARMOR-ALARM's docs/ALARM_MESSAGES.md and docs/SAFETY.md.
 *
 * What it enforces before a command is published, each refusal audited:
 *   - the commands are turned on in this server; the caller is an administrator (routes/alarm.ts);
 *   - the node is not stale, and says in its own state that it accepts commands (`commands_enabled`);
 *   - one command at a time per node.
 * What it does not do: decide anything about the installation. A command that was accepted is not an alarm that is armed: only the node's state says that.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { randomBytes } from "node:crypto";
import type { AuditLog } from "./audit.js";
import { ACTIONS, type AlarmAction, type AlarmRefusal, type AlarmResult, type AlarmStore, type Phase } from "./alarm.js";

export class AlarmCommandError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

export type AlarmOutcome = AlarmRefusal | "timeout";
/** What became of a command, as shown to an operator. */
export type AlarmRecord = { command_id: string; node_id: string; action: AlarmAction; mode?: "away" | "stay"; accepted: boolean; refusal: AlarmOutcome; phase?: Phase; actor: string; at: string };
export type PendingAlarm = { command_id: string; node_id: string; action: AlarmAction; mode?: "away" | "stay"; actor: string; at: string };

export type AlarmCommandsOptions = {
  /** The operator's decision: false unless ARMOR_ALARM_COMMANDS=1. */
  enabled: boolean;
  nodes: AlarmStore;
  /** Publish to the broker; throws when it is not connected. */
  publish: (topic: string, payload: string) => void;
  audit: AuditLog;
  now?: () => number;
  /** How long to wait for the node's answer before calling it lost. */
  answerTimeoutMs?: number;
  /** Ids; injectable for tests. Sixteen lowercase hexadecimal digits. */
  random?: () => string;
  keepRecords?: number;
};

type Pending = PendingAlarm & { startedMs: number };

export class AlarmCommands {
  readonly #options: Required<Omit<AlarmCommandsOptions, "nodes" | "publish" | "audit">> & Pick<AlarmCommandsOptions, "nodes" | "publish" | "audit">;
  readonly #pending = new Map<string, Pending>();       // by command id
  readonly #records: AlarmRecord[] = [];

  constructor(options: AlarmCommandsOptions) {
    this.#options = { ...options, now: options.now ?? (() => Date.now()), answerTimeoutMs: options.answerTimeoutMs ?? 5_000, random: options.random ?? (() => randomBytes(8).toString("hex")), keepRecords: options.keepRecords ?? 50 };
  }

  get enabled(): boolean { return this.#options.enabled; }

  /**
   * Ask a node's panel to arm (`away` or `stay`, optionally forcing) or to disarm. Returns the id of the command that was published (the node's answer arrives later, see
   * `handleResult`); throws an `AlarmCommandError` when it must not be sent. `actor` is who asked, for the audit.
   */
  request(node: string, action: AlarmAction, mode: "away" | "stay" | undefined, force: boolean, actor: string): { command_id: string } {
    const detail = (text: string): string => `${action}${mode ? ` ${mode}` : ""}${force ? " forced" : ""}: ${text}`;
    const denied = (code: string, message: string, status = 409): never => {
      this.#options.audit.record({ action: "alarm.command", outcome: "denied", actor, target: node, detail: detail(code) });
      throw new AlarmCommandError(code, message, status);
    };
    if (!this.#options.enabled) return denied("commands_disabled", "alarm commands are not turned on in this server", 403);
    if (!(ACTIONS as readonly string[]).includes(action)) return denied("invalid_action", "the action is arm or disarm", 400);
    if (action === "arm" && mode !== "away" && mode !== "stay") return denied("invalid_mode", "an arm says away or stay", 400);
    if (action === "disarm" && (mode !== undefined || force)) return denied("invalid_request", "a disarm has no mode and no force", 400);
    const view = this.#options.nodes.list().find(item => item.node_id === node);
    if (!view) return denied("unknown_node", "no such alarm node", 404);
    if (view.stale) return denied("node_unavailable", "the node has not reported lately", 409);
    if (!view.state.commands_enabled) return denied("node_commands_off", "the node does not accept commands from the server", 409);
    for (const pending of this.#pending.values()) if (pending.node_id === node) return denied("busy", "a command to this node is still waiting for its answer", 409);

    const now = this.#options.now();
    const id = this.#options.random();
    const command = { kind: "alarm_command", node_id: node, timestamp_ms: now, command_id: id, action, ...(action === "arm" ? { mode, ...(force ? { force: true } : {}) } : {}) };
    try {
      this.#options.publish(`armor/alarm/${node}/command`, JSON.stringify(command));
    } catch (error) {
      this.#options.audit.record({ action: "alarm.command", outcome: "failed", actor, target: node, detail: detail(error instanceof Error ? error.message : "not sent") });
      throw new AlarmCommandError("mqtt_unavailable", "the command could not be sent: the broker is not connected", 503);
    }
    this.#pending.set(id, { command_id: id, node_id: node, action, ...(mode ? { mode } : {}), actor, at: new Date(now).toISOString(), startedMs: now });
    this.#options.audit.record({ action: "alarm.command", outcome: "allowed", actor, target: node, detail: `${detail("sent")} ${id}` });
    return { command_id: id };
  }

  /** The answer of a node. One that answers a command this server did not send, or does not match it, is dropped and audited. */
  handleResult(result: AlarmResult, topicNode: string): void {
    const now = this.#options.now();
    const pending = this.#pending.get(result.command_id);
    if (!pending || pending.node_id !== topicNode || result.node_id !== topicNode || pending.action !== result.action) {
      this.#options.audit.record({ action: "alarm.command.result", outcome: "denied", target: topicNode, detail: `${result.action}: not an answer to a command that is waiting` });
      return;
    }
    this.#pending.delete(result.command_id);
    this.#keep({ command_id: result.command_id, node_id: result.node_id, action: result.action, ...(pending.mode ? { mode: pending.mode } : {}), accepted: result.accepted, refusal: result.refusal, phase: result.phase, actor: pending.actor, at: new Date(now).toISOString() });
    this.#options.audit.record({ action: "alarm.command.result", outcome: result.accepted ? "allowed" : "denied", actor: pending.actor, target: result.node_id, detail: `${result.action} ${result.command_id}: ${result.refusal}` });
  }

  /** Call now and then: a command whose answer never came is over. */
  sweep(): void {
    const now = this.#options.now();
    for (const [id, pending] of this.#pending) {
      if (now - pending.startedMs < this.#options.answerTimeoutMs) continue;
      this.#pending.delete(id);
      this.#keep({ command_id: id, node_id: pending.node_id, action: pending.action, ...(pending.mode ? { mode: pending.mode } : {}), accepted: false, refusal: "timeout", actor: pending.actor, at: new Date(now).toISOString() });
      this.#options.audit.record({ action: "alarm.command.result", outcome: "failed", actor: pending.actor, target: pending.node_id, detail: `${pending.action} ${id}: no answer` });
    }
  }

  /** What an operator sees: whether it is on, the commands waiting for an answer, and what became of the latest ones (newest first). */
  status(): { enabled: boolean; pending: PendingAlarm[]; recent: AlarmRecord[] } {
    this.sweep();
    return { enabled: this.#options.enabled, pending: [...this.#pending.values()].map(({ startedMs: _startedMs, ...rest }) => rest), recent: [...this.#records].reverse() };
  }

  #keep(record: AlarmRecord): void {
    this.#records.push(record);
    if (this.#records.length > this.#options.keepRecords) this.#records.splice(0, this.#records.length - this.#options.keepRecords);
  }
}
