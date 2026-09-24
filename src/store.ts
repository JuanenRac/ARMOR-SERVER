/**
 * A.R.M.O.R. in-memory event projection. Persistence is an adapter's concern.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Health, Telemetry } from "./contracts.js";

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

type StoredNode = Omit<NodeState, "stale"> & { received_at_ms: number };

/** Two or more targets while armed is high, any target is a review, none is normal. */
export const alertLevelFor = (mode: SecurityMode, targetCount: number): AlertLevel =>
  targetCount >= 2 && mode === "armed" ? "high" : targetCount > 0 ? "review" : "normal";

export type StoreOptions = { staleAfterMs?: number; now?: () => number };

export class ArmorStore {
  #mode: SecurityMode = "disarmed";
  #revision = 0;
  #updatedAt = new Date(0).toISOString();
  readonly #nodes = new Map<string, StoredNode>();
  readonly #onChange: ((state: SystemState) => void) | undefined;
  readonly #staleAfterMs: number;
  readonly #now: () => number;

  constructor(onChange?: (state: SystemState) => void, options: StoreOptions = {}) {
    this.#onChange = onChange;
    this.#staleAfterMs = options.staleAfterMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  snapshot(): SystemState {
    const now = this.#now();
    const nodes: Record<string, NodeState> = {};
    for (const [id, node] of this.#nodes) {
      const { received_at_ms, ...visible } = node;
      const stale = now - received_at_ms > this.#staleAfterMs;
      nodes[id] = { ...visible, stale, online: visible.online && !stale };
    }
    return { mode: this.#mode, revision: this.#revision, nodes, updated_at: this.#updatedAt };
  }

  arm(mode: SecurityMode): SystemState {
    this.#mode = mode;
    // A mode change re-evaluates every node: disarming clears "high" at once.
    for (const [id, node] of this.#nodes) this.#nodes.set(id, { ...node, alert_level: alertLevelFor(mode, node.target_count) });
    return this.#bump();
  }

  telemetry(message: Telemetry): SystemState {
    const previous = this.#nodes.get(message.node_id);
    if (previous && message.timestamp_ms < previous.timestamp_ms) return this.snapshot();
    this.#nodes.set(message.node_id, {
      node_id: message.node_id, online: previous?.online ?? true, timestamp_ms: message.timestamp_ms, lux: message.lux,
      target_count: message.targets.length, alert_level: alertLevelFor(this.#mode, message.targets.length), received_at_ms: this.#now(),
    });
    return this.#bump();
  }

  health(message: Health): SystemState {
    const previous = this.#nodes.get(message.node_id);
    // An "offline" message is always applied: it is normally the MQTT last will, which the node had to write
    // before it knew the time of its own death, so its timestamp is necessarily older than the node's last
    // message. An older "online" message is still ignored. The stored timestamp never moves backwards, and
    // the next fresh heartbeat brings a node that is really alive back online.
    if (previous && message.timestamp_ms < previous.timestamp_ms && message.online) return this.snapshot();
    const timestamp = Math.max(message.timestamp_ms, previous?.timestamp_ms ?? 0);
    this.#nodes.set(message.node_id, {
      node_id: message.node_id, online: message.online, timestamp_ms: timestamp, lux: previous?.lux ?? null,
      target_count: previous?.target_count ?? 0, alert_level: previous?.alert_level ?? "normal", received_at_ms: this.#now(),
    });
    return this.#bump();
  }

  #bump(): SystemState {
    this.#revision += 1;
    this.#updatedAt = new Date(this.#now()).toISOString();
    const state = this.snapshot();
    this.#onChange?.(state);
    return state;
  }
}
