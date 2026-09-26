/**
 * The way a command reaches the switch of an electrical node: the one place in the server that can send anything towards mains equipment, and it is OFF unless the
 * operator turned it on (ARMOR_ELECTRICAL_SWITCHING=1). It is the server's layer of the protection and never the only one: the node has its own rules (dead time,
 * confirmation by the auxiliary contacts, latched faults, a one-time token) and the installation has its mechanical interlock and its breakers. See ARMOR-ELECTRICAL's
 * docs/SWITCHING.md and docs/SAFETY.md.
 *
 * What it enforces before a command is published, each refusal audited:
 *   - the switching is turned on in this server; the caller is an administrator (routes/electrical.ts);
 *   - the node is not stale, and says in its own reading that it may switch (`switching_enabled`) and that it has that switch;
 *   - no fault is latched (except to acknowledge it), and one command at a time per switch;
 *   - a close only follows an arm the node ACCEPTED a moment ago, and carries the one-time token the node gave then. The token never leaves the server: it is not in
 *     a response, an audit line or a log.
 * What it does not do: decide anything about the installation. What a switch shows is what the node's reading says; a command that was accepted is not a switch that
 * closed. Nothing here has ever been connected to a node that switches.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { randomBytes } from "node:crypto";
import type { AuditLog } from "./audit.js";
import { SWITCH_ACTIONS, type ElectricalResult, type ElectricalStore, type Refusal, type SwitchAction } from "./electrical.js";

export class SwitchingError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

export type SwitchOutcome = Refusal | "timeout";
/** What became of a command, as shown to an operator. Never carries a token. */
export type SwitchRecord = { command_id: string; node_id: string; switch: string; action: SwitchAction; accepted: boolean; refusal: SwitchOutcome; actor: string; at: string };
export type PendingSwitch = { command_id: string; node_id: string; switch: string; action: SwitchAction; actor: string; at: string };

export type SwitchingOptions = {
  /** The operator's decision: false unless ARMOR_ELECTRICAL_SWITCHING=1. */
  enabled: boolean;
  nodes: ElectricalStore;
  /** Publish to the broker; throws when it is not connected. */
  publish: (topic: string, payload: string) => void;
  audit: AuditLog;
  now?: () => number;
  /** How long an arm's token is good for (the node's window is ten seconds). */
  armWindowMs?: number;
  /** How long to wait for the node's answer before calling it lost. */
  answerTimeoutMs?: number;
  /** Ids and the like; injectable for tests. */
  random?: () => string;
  keepRecords?: number;
};

type Pending = PendingSwitch & { startedMs: number };
type Armed = { token: string; atMs: number };

export class SwitchingService {
  readonly #options: Required<Omit<SwitchingOptions, "nodes" | "publish" | "audit">> & Pick<SwitchingOptions, "nodes" | "publish" | "audit">;
  readonly #pending = new Map<string, Pending>();       // by command id
  readonly #armed = new Map<string, Armed>();           // by node/switch
  readonly #records: SwitchRecord[] = [];

  constructor(options: SwitchingOptions) {
    this.#options = {
      ...options, now: options.now ?? (() => Date.now()), armWindowMs: options.armWindowMs ?? 10_000, answerTimeoutMs: options.answerTimeoutMs ?? 5_000,
      random: options.random ?? (() => randomBytes(8).toString("hex")), keepRecords: options.keepRecords ?? 50,
    };
  }

  get enabled(): boolean { return this.#options.enabled; }

  /**
   * Ask a node's switch to do something. Resolves with the id of the command that was published (the node's answer arrives later, see `handleResult`); throws a
   * `SwitchingError` when it must not be sent. `actor` is who asked, for the audit.
   */
  request(node: string, target: string, action: SwitchAction, actor: string): { command_id: string } {
    const denied = (code: string, message: string, status = 409): never => {
      this.#options.audit.record({ action: "electrical.switch", outcome: "denied", actor, target: `${node}/${target}`, detail: `${action}: ${code}` });
      throw new SwitchingError(code, message, status);
    };
    if (!this.#options.enabled) return denied("switching_disabled", "switching is not turned on in this server", 403);
    if (!(SWITCH_ACTIONS as readonly string[]).includes(action)) return denied("invalid_action", "the action is arm, close_a, close_b, open or acknowledge", 400);
    const view = this.#options.nodes.list().find(item => item.node_id === node);
    if (!view) return denied("unknown_node", "no such electrical node", 404);
    if (view.stale) return denied("node_unavailable", "the node has not reported lately", 409);
    if (view.reading.switching_enabled !== true) return denied("node_not_switching", "the node says it may not switch", 409);
    const found = view.reading.switches?.find(item => item.id === target);
    if (!found) return denied("unknown_switch", "the node has no such switch", 404);
    if (found.fault !== "none" && action !== "acknowledge" && action !== "open") return denied("switch_fault", "the switch has a latched fault", 409);
    // one command at a time per switch, except opening: opening is never made to wait
    if (action !== "open") for (const pending of this.#pending.values()) if (pending.node_id === node && pending.switch === target) return denied("busy", "a command to this switch is still waiting for its answer", 409);

    const now = this.#options.now();
    const key = `${node}/${target}`;
    let token: string | undefined;
    if (action === "close_a" || action === "close_b") {
      const armed = this.#armed.get(key);
      if (!armed || now - armed.atMs > this.#options.armWindowMs) { this.#armed.delete(key); return denied("not_armed", "arm the switch first: a close follows an accepted arm", 409); }
      token = armed.token;
      this.#armed.delete(key);   // one arm, one close
    }
    if (action === "open") this.#armed.delete(key);

    const id = this.#options.random();
    const command = { kind: "electrical_command", node_id: node, timestamp_ms: now, command_id: id, switch: target, action, ...(token ? { token } : {}) };
    try {
      this.#options.publish(`armor/electrical/${node}/command`, JSON.stringify(command));
    } catch (error) {
      this.#options.audit.record({ action: "electrical.switch", outcome: "failed", actor, target: key, detail: `${action}: ${error instanceof Error ? error.message : "not sent"}` });
      throw new SwitchingError("mqtt_unavailable", "the command could not be sent: the broker is not connected", 503);
    }
    this.#pending.set(id, { command_id: id, node_id: node, switch: target, action, actor, at: new Date(now).toISOString(), startedMs: now });
    this.#options.audit.record({ action: "electrical.switch", outcome: "allowed", actor, target: key, detail: `${action} ${id}` });
    return { command_id: id };
  }

  /** The answer of a node. One that answers a command this server did not send, or does not match it, is dropped and audited. */
  handleResult(result: ElectricalResult, topicNode: string): void {
    const now = this.#options.now();
    const pending = this.#pending.get(result.command_id);
    if (!pending || pending.node_id !== topicNode || result.node_id !== topicNode || pending.switch !== result.switch || pending.action !== result.action) {
      this.#options.audit.record({ action: "electrical.switch.result", outcome: "denied", target: `${topicNode}/${result.switch}`, detail: `${result.action}: not an answer to a command that is waiting` });
      return;
    }
    this.#pending.delete(result.command_id);
    const key = `${result.node_id}/${result.switch}`;
    if (result.accepted && result.action === "arm" && result.token) this.#armed.set(key, { token: result.token, atMs: now });
    if (result.action === "open" || (!result.accepted && result.action !== "arm")) this.#armed.delete(key);
    this.#keep({ command_id: result.command_id, node_id: result.node_id, switch: result.switch, action: result.action, accepted: result.accepted, refusal: result.refusal, actor: pending.actor, at: new Date(now).toISOString() });
    this.#options.audit.record({ action: "electrical.switch.result", outcome: result.accepted ? "allowed" : "denied", actor: pending.actor, target: key, detail: `${result.action} ${result.command_id}: ${result.refusal}` });
  }

  /** Call now and then: a command whose answer never came is over, and an arm nobody used expires. */
  sweep(): void {
    const now = this.#options.now();
    for (const [id, pending] of this.#pending) {
      if (now - pending.startedMs < this.#options.answerTimeoutMs) continue;
      this.#pending.delete(id);
      this.#keep({ command_id: id, node_id: pending.node_id, switch: pending.switch, action: pending.action, accepted: false, refusal: "timeout", actor: pending.actor, at: new Date(now).toISOString() });
      this.#options.audit.record({ action: "electrical.switch.result", outcome: "failed", actor: pending.actor, target: `${pending.node_id}/${pending.switch}`, detail: `${pending.action} ${id}: no answer` });
    }
    for (const [key, armed] of this.#armed) if (now - armed.atMs > this.#options.armWindowMs) this.#armed.delete(key);
  }

  /** What an operator sees: whether it is on, the commands waiting for an answer, and what became of the latest ones (newest first). Never a token. */
  status(): { enabled: boolean; pending: PendingSwitch[]; recent: SwitchRecord[] } {
    this.sweep();
    return { enabled: this.#options.enabled, pending: [...this.#pending.values()].map(({ startedMs: _startedMs, ...rest }) => rest), recent: [...this.#records].reverse() };
  }

  /** A node that is forgotten leaves nothing armed behind. */
  forget(node: string): void { for (const key of this.#armed.keys()) if (key.startsWith(`${node}/`)) this.#armed.delete(key); }

  #keep(record: SwitchRecord): void {
    this.#records.push(record);
    if (this.#records.length > this.#options.keepRecords) this.#records.splice(0, this.#records.length - this.#options.keepRecords);
  }
}
