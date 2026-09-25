/**
 * A.R.M.O.R. event projection: the current state of the perimeter, the events
 * that describe its changes, and (through an adapter) its persistence.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Health, Telemetry } from "./contracts.js";
import type { ArmorEventBody, NodeStatus } from "./events.js";
import type { PersistedState, StatePersistence } from "./persistence.js";
import { defaultRules, targetCounts, type Rules } from "./rules.js";

export type SecurityMode = "disarmed" | "armed";
export type AlertLevel = "normal" | "review" | "high";
export type NodeState = {
  node_id: string;
  /** Reported online AND heard from recently: a silent node is never shown as online. */
  online: boolean;
  /** True when the node has not sent anything within the staleness window. */
  stale: boolean;
  timestamp_ms: number;
  lux: number | null;
  target_count: number;
  alert_level: AlertLevel;
};
export type SystemState = { mode: SecurityMode; revision: number; nodes: Record<string, NodeState>; updated_at: string };

type StoredNode = Omit<NodeState, "stale"> & { received_at_ms: number; status: NodeStatus; high_since_ms: number | null };

/** Two or more targets while armed is high, any target is a review, none is normal. */
export const alertLevelFor = (mode: SecurityMode, targetCount: number): AlertLevel =>
  targetCount >= 2 && mode === "armed" ? "high" : targetCount > 0 ? "review" : "normal";

/** More distinct nodes than this is a mistake or an attack, not a perimeter. */
export const MAX_NODES = 256;

export type StoreOptions = {
  staleAfterMs?: number;
  now?: () => number;
  /** The live rules (dwell time and ignore zones). Read on every observation. */
  rules?: () => Rules;
  onEvent?: (event: ArmorEventBody) => void;
  persistence?: StatePersistence;
};

export class ArmorStore {
  #mode: SecurityMode = "disarmed";
  #revision = 0;
  #updatedAt = new Date(0).toISOString();
  readonly #nodes = new Map<string, StoredNode>();
  readonly #onChange: ((state: SystemState) => void) | undefined;
  readonly #onEvent: ((event: ArmorEventBody) => void) | undefined;
  readonly #staleAfterMs: number;
  readonly #now: () => number;
  readonly #rules: () => Rules;
  readonly #persistence: StatePersistence | undefined;

  constructor(onChange?: (state: SystemState) => void, options: StoreOptions = {}) {
    this.#onChange = onChange;
    this.#onEvent = options.onEvent;
    this.#staleAfterMs = options.staleAfterMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#rules = options.rules ?? (() => defaultRules());
    this.#persistence = options.persistence;
    this.#restore(this.#persistence?.load());
  }

  snapshot(): SystemState {
    const now = this.#now();
    const nodes: Record<string, NodeState> = {};
    for (const [id, node] of this.#nodes) {
      const { received_at_ms, status: _status, high_since_ms: _since, ...visible } = node;
      const stale = now - received_at_ms > this.#staleAfterMs;
      nodes[id] = { ...visible, stale, online: visible.online && !stale };
    }
    return { mode: this.#mode, revision: this.#revision, nodes, updated_at: this.#updatedAt };
  }

  arm(mode: SecurityMode): SystemState {
    const changed = mode !== this.#mode;
    this.#mode = mode;
    if (changed) this.#onEvent?.({ type: "mode", mode });
    // A mode change re-evaluates every node: disarming clears "high" at once.
    const now = this.#now();
    for (const [id, node] of this.#nodes) {
      const next = this.#evaluated(node, node.target_count, now);
      if (next.alert_level !== node.alert_level) this.#onEvent?.({ type: "alert", node_id: id, from: node.alert_level, to: next.alert_level, targets: next.target_count });
      this.#nodes.set(id, next);
    }
    return this.#bump(true);
  }

  telemetry(message: Telemetry): SystemState {
    const previous = this.#nodes.get(message.node_id);
    if (!previous && this.#nodes.size >= MAX_NODES) throw new Error("too many nodes");
    if (previous && message.timestamp_ms < previous.timestamp_ms) return this.snapshot();
    const now = this.#now();
    const rules = this.#rules();
    const counted = message.targets.filter(target => targetCounts(rules, message.node_id, target)).length;
    const node = this.#evaluated({
      node_id: message.node_id, online: previous?.online ?? true, timestamp_ms: message.timestamp_ms, lux: message.lux,
      target_count: counted, alert_level: previous?.alert_level ?? "normal", received_at_ms: now,
      status: "online", high_since_ms: previous?.high_since_ms ?? null,
    }, counted, now);
    return this.#store(node, previous);
  }

  health(message: Health): SystemState {
    const previous = this.#nodes.get(message.node_id);
    if (!previous && this.#nodes.size >= MAX_NODES) throw new Error("too many nodes");
    // An "offline" message is always applied: it is normally the MQTT last will, which the node had to write
    // before it knew the time of its own death, so its timestamp is necessarily older than the node's last
    // message. An older "online" message is still ignored. The stored timestamp never moves backwards, and
    // the next fresh heartbeat brings a node that is really alive back online.
    if (previous && message.timestamp_ms < previous.timestamp_ms && message.online) return this.snapshot();
    const timestamp = Math.max(message.timestamp_ms, previous?.timestamp_ms ?? 0);
    const node: StoredNode = {
      node_id: message.node_id, online: message.online, timestamp_ms: timestamp, lux: previous?.lux ?? null,
      target_count: previous?.target_count ?? 0, alert_level: previous?.alert_level ?? "normal", received_at_ms: this.#now(),
      status: message.online ? "online" : "offline", high_since_ms: previous?.high_since_ms ?? null,
    };
    return this.#store(node, previous);
  }

  /**
   * Time-driven changes: a node going silent, or a persistent target reaching
   * the dwell time, happen without any message. Call this on a timer. Returns
   * true when something changed.
   */
  sweep(): boolean {
    const now = this.#now();
    let changed = false;
    for (const [id, node] of this.#nodes) {
      const stale = now - node.received_at_ms > this.#staleAfterMs;
      const status: NodeStatus = !node.online ? "offline" : stale ? "stale" : "online";
      const next = this.#evaluated({ ...node, status }, node.target_count, now);
      if (status !== node.status) this.#onEvent?.({ type: "node", node_id: id, from: node.status, to: status });
      if (next.alert_level !== node.alert_level) this.#onEvent?.({ type: "alert", node_id: id, from: node.alert_level, to: next.alert_level, targets: next.target_count });
      if (status !== node.status || next.alert_level !== node.alert_level || next.high_since_ms !== node.high_since_ms) {
        this.#nodes.set(id, next);
        changed = true;
      }
    }
    if (changed) this.#bump(false);
    return changed;
  }

  /** Forget a decommissioned node. Returns false when the node is unknown. A node that speaks again is simply new. */
  removeNode(nodeId: string): boolean {
    if (!this.#nodes.delete(nodeId)) return false;
    this.#bump(false);
    return true;
  }

  /** Write any pending state now (used on shutdown). */
  flush(): void { this.#persistence?.flush(); }

  /** The level a node should have now: "high" needs the condition to have held for the dwell time. */
  #evaluated(node: StoredNode, count: number, now: number): StoredNode {
    const raw = alertLevelFor(this.#mode, count);
    const highSince = raw === "high" ? node.high_since_ms ?? now : null;
    const level: AlertLevel = raw === "high" && now - (highSince ?? now) < this.#rules().dwell_ms ? "review" : raw;
    return { ...node, target_count: count, alert_level: level, high_since_ms: highSince };
  }

  #store(node: StoredNode, previous: StoredNode | undefined): SystemState {
    this.#nodes.set(node.node_id, node);
    if (node.status !== (previous?.status ?? null)) this.#onEvent?.({ type: "node", node_id: node.node_id, from: previous?.status ?? null, to: node.status });
    const from = previous?.alert_level ?? "normal";
    if (node.alert_level !== from) this.#onEvent?.({ type: "alert", node_id: node.node_id, from, to: node.alert_level, targets: node.target_count });
    return this.#bump(false);
  }

  #bump(immediate: boolean): SystemState {
    this.#revision += 1;
    this.#updatedAt = new Date(this.#now()).toISOString();
    this.#persistence?.save(this.#persisted(), immediate);
    const state = this.snapshot();
    this.#onChange?.(state);
    return state;
  }

  #persisted(): PersistedState {
    return { schema: 1, mode: this.#mode, revision: this.#revision, nodes: [...this.#nodes.values()] };
  }

  #restore(state: PersistedState | undefined): void {
    if (!state) return;
    this.#mode = state.mode;
    this.#revision = state.revision;
    for (const node of state.nodes) this.#nodes.set(node.node_id, node);
    this.#updatedAt = new Date(this.#now()).toISOString();
  }
}
