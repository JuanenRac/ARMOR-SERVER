/**
 * A.R.M.O.R. event projection: the current state of the perimeter, the events
 * that describe its changes, and (through an adapter) its persistence.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { Health, Info, RadarTrack, Telemetry } from "./contracts.js";
import type { ArmorEventBody, NodeStatus } from "./events.js";
import type { PersistedState, StatePersistence } from "./persistence.js";
import { defaultRules, targetCounts, type Rules } from "./rules.js";

export type SecurityMode = "disarmed" | "armed";
export type AlertLevel = "normal" | "review" | "high";
/** A target as the radar last reported it (in the radar's own frame, millimetres); `counted` is false when an ignore zone covers it. */
export type TargetView = RadarTrack & { counted: boolean };
/** Where a node's own web panel is, as the node said itself (kept in the state file, and the node repeats it). */
export type PanelInfo = { name: string; firmware: string; ip: string; port: number };
export type NodeState = {
  node_id: string;
  /** Reported online AND heard from recently: a silent node is never shown as online. */
  online: boolean;
  /** True when the node has not sent anything within the staleness window. */
  stale: boolean;
  timestamp_ms: number;
  lux: number | null;
  target_count: number;
  /** Where the targets of the latest report were: what a live radar map draws. Empty until the node reports. */
  targets: TargetView[];
  alert_level: AlertLevel;
  /** The address of the node's web panel, or null until the node has said it. */
  panel: PanelInfo | null;
};
export type SystemState = {
  mode: SecurityMode;
  /** The arming mode in force (disarmed, away, home or night); only present while the arming modes are turned on, so a client that knows none ignores it and reads `mode`. */
  arming_mode?: string; panel_sync?: unknown; revision: number; nodes: Record<string, NodeState>; updated_at: string };

type StoredNode = Omit<NodeState, "stale" | "panel"> & { received_at_ms: number; status: NodeStatus; high_since_ms: number | null };

/** `minTargets` targets while armed is high, any target is a review, none is normal. This function's own default is 2; the server passes ARMOR_ALERT_MIN_TARGETS, which is 1 unless the installation says otherwise. */
export const alertLevelFor = (mode: SecurityMode, targetCount: number, minTargets = 2): AlertLevel =>
  targetCount >= minTargets && mode === "armed" ? "high" : targetCount > 0 ? "review" : "normal";

/** More distinct nodes than this is a mistake or an attack, not a perimeter. */
export const MAX_NODES = 256;

export type StoreOptions = {
  staleAfterMs?: number;
  now?: () => number;
  /** The live rules (dwell time and ignore zones). Read on every observation. */
  rules?: () => Rules;
  onEvent?: (event: ArmorEventBody) => void;
  persistence?: StatePersistence;
  /** How many targets at once make an alert high while armed (default 2; the server's setting is ARMOR_ALERT_MIN_TARGETS, 1 by default). */
  minTargets?: number;
  /** Whether the armed system defends this node right now (the arming modes: a node outside the mode, or still in the exit delay, does not count as armed). Absent: every node is defended while armed. */
  guards?: (nodeId: string) => boolean;
  /** The arming mode to show in the state, or undefined while the arming modes are off. */
  armingMode?: () => string | undefined;
  /** What the alarm panels did about the mode in force (mode_panel_sync.ts); undefined: nothing to say, and the field is left out. */
  panelSync?: () => unknown;
};

export class ArmorStore {
  #mode: SecurityMode = "disarmed";
  #revision = 0;
  #updatedAt = new Date(0).toISOString();
  readonly #nodes = new Map<string, StoredNode>();
  readonly #panels = new Map<string, PanelInfo>();
  /** The wall panels (ARMOR-NODE-HMI) that said they are alive: they are not radars, so they are not nodes, do not count and cannot be a node that went down. */
  readonly #wallPanels = new Map<string, { online: boolean; timestamp_ms: number }>();
  readonly #minTargets: number;
  readonly #guards: (nodeId: string) => boolean;
  readonly #armingMode: () => string | undefined;
  readonly #panelSync: () => unknown;
  /** The nodes that have sent telemetry since this server started: for them, silence is judged by the telemetry, not by the heartbeat. */
  readonly #telemetrySeen = new Set<string>();
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
    this.#minTargets = options.minTargets ?? 2;
    this.#guards = options.guards ?? (() => true);
    this.#armingMode = options.armingMode ?? (() => undefined);
    this.#panelSync = options.panelSync ?? (() => undefined);
    this.#restore(this.#persistence?.load());
  }

  /** Whether the system is armed, without building the whole state. */
  get armed(): boolean { return this.#mode === "armed"; }

  snapshot(): SystemState {
    const now = this.#now();
    const nodes: Record<string, NodeState> = {};
    for (const [id, node] of this.#nodes) {
      const { received_at_ms, status: _status, high_since_ms: _since, ...visible } = node;
      const stale = now - received_at_ms > this.#staleAfterMs;
      nodes[id] = { ...visible, stale, online: visible.online && !stale, panel: this.#panels.get(id) ?? null };
    }
    const arming = this.#armingMode();
    const panelSync = arming ? this.#panelSync() : undefined;
    return { mode: this.#mode, ...(arming ? { arming_mode: arming } : {}), ...(panelSync ? { panel_sync: panelSync } : {}), revision: this.#revision, nodes, updated_at: this.#updatedAt };
  }

  arm(mode: SecurityMode): SystemState {
    const changed = mode !== this.#mode;
    this.#mode = mode;
    if (changed) this.#onEvent?.({ type: "mode", mode });
    // A mode change re-evaluates every node: disarming clears "high" at once.
    this.#reevaluateNodes();
    return this.#bump(true);
  }

  /** Look at every node again with the rules of the moment (the arming mode changed between two armed modes, or an exit delay ended): the level of each follows what is defended now. */
  reevaluate(): SystemState {
    this.#reevaluateNodes();
    return this.#bump(true);
  }

  #reevaluateNodes(): void {
    const now = this.#now();
    for (const [id, node] of this.#nodes) {
      const next = this.#evaluated(node, node.target_count, now);
      if (next.alert_level !== node.alert_level) this.#onEvent?.({ type: "alert", node_id: id, from: node.alert_level, to: next.alert_level, targets: next.target_count });
      this.#nodes.set(id, next);
    }
  }

  telemetry(message: Telemetry): SystemState {
    const previous = this.#nodes.get(message.node_id);
    if (!previous && this.#nodes.size >= MAX_NODES) throw new Error("too many nodes");
    if (previous && message.timestamp_ms < previous.timestamp_ms) return this.snapshot();
    const now = this.#now();
    this.#telemetrySeen.add(message.node_id);
    const rules = this.#rules();
    const views: TargetView[] = message.targets.map(target => ({ ...target, counted: targetCounts(rules, message.node_id, target) }));
    const counted = views.filter(target => target.counted).length;
    const node = this.#evaluated({
      node_id: message.node_id, online: previous?.online ?? true, timestamp_ms: message.timestamp_ms, lux: message.lux,
      target_count: counted, targets: views, alert_level: previous?.alert_level ?? "normal", received_at_ms: now,
      status: "online", high_since_ms: previous?.high_since_ms ?? null,
    }, counted, now);
    return this.#store(node, previous);
  }

  health(message: Health): SystemState {
    if (message.kind === "panel") {
      if (!this.#wallPanels.has(message.node_id) && this.#wallPanels.size >= 32) throw new Error("too many panels");
      const before = this.#wallPanels.get(message.node_id);
      if (!(before && message.timestamp_ms < before.timestamp_ms && message.online)) this.#wallPanels.set(message.node_id, { online: message.online, timestamp_ms: Math.max(message.timestamp_ms, before?.timestamp_ms ?? 0) });
      return this.snapshot();
    }
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
      target_count: previous?.target_count ?? 0, targets: previous?.targets ?? [], alert_level: previous?.alert_level ?? "normal",
      // A node whose sensors died keeps sending its heartbeat but stops sending telemetry (on purpose, so that the server says the node is quiet): once a node has sent telemetry,
      // only telemetry keeps it from going stale. Otherwise a blind radar would stay online for ever and the perimeter would be unguarded without anyone knowing.
      // (A node that comes back from "offline" - it rebooted or lost its link - has just proved it is alive: its silence is counted from now, not from the telemetry it sent before it went away, or it would be called silent again the moment it reconnects.)
      received_at_ms: previous && this.#telemetrySeen.has(message.node_id) && !(message.online && !previous.online) ? previous.received_at_ms : this.#now(),
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

  /**
   * What a node says about itself. It does not make a node appear (only telemetry and health do) and is kept in the state file (so that a node that is switched off is still known by its address): the node repeats it
   * when it connects and now and then. Nothing changes, and no revision is spent, when it says what it said before.
   */
  info(message: Info): SystemState {
    const known = this.#panels.get(message.node_id);
    if (!known && this.#panels.size >= MAX_NODES) throw new Error("too many nodes");
    const next: PanelInfo = { name: message.name, firmware: message.firmware, ip: message.ip, port: message.port };
    if (known && known.name === next.name && known.firmware === next.firmware && known.ip === next.ip && known.port === next.port) return this.snapshot();
    this.#panels.set(message.node_id, next);
    if (this.#nodes.has(message.node_id)) return this.#bump(false);
    this.#persistence?.save(this.#persisted(), false);   // no node to show yet: the address is still worth keeping
    return this.snapshot();
  }

  /** The wall panels that have spoken: online while their last message is not a goodbye and is recent. */
  wallPanels(nowMs: number = Date.now(), silentAfterMs: number = 120_000): { id: string; online: boolean; last_ms: number }[] {
    return [...this.#wallPanels.entries()].map(([id, item]) => ({ id, online: item.online && nowMs - item.timestamp_ms < silentAfterMs, last_ms: item.timestamp_ms }));
  }

  /** Forget a decommissioned node. Returns false when the node is unknown. A node that speaks again is simply new. */
  removeNode(nodeId: string): boolean {
    const hadPanel = this.#panels.delete(nodeId);
    this.#telemetrySeen.delete(nodeId);
    if (!this.#nodes.delete(nodeId)) { if (hadPanel) this.#persistence?.save(this.#persisted(), false); return false; }
    this.#bump(false);
    return true;
  }

  /** Write any pending state now (used on shutdown). */
  flush(): void { this.#persistence?.flush(); }

  /** The level a node should have now: "high" needs the condition to have held for the dwell time. */
  #evaluated(node: StoredNode, count: number, now: number): StoredNode {
    const raw = alertLevelFor(this.#mode === "armed" && this.#guards(node.node_id) ? "armed" : "disarmed", count, this.#minTargets);
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
    // Positions are only meaningful live: they are not written to disk.
    return { schema: 1, mode: this.#mode, revision: this.#revision, nodes: [...this.#nodes.values()].map(node => ({ ...node, targets: [] })), panels: Object.fromEntries(this.#panels) };
  }

  #restore(state: PersistedState | undefined): void {
    if (!state) return;
    this.#mode = state.mode;
    this.#revision = state.revision;
    for (const node of state.nodes) this.#nodes.set(node.node_id, { ...node, targets: [] });
    for (const [id, panel] of Object.entries(state.panels ?? {})) if (this.#panels.size < MAX_NODES) this.#panels.set(id, panel);
    this.#updatedAt = new Date(this.#now()).toISOString();
  }
}
