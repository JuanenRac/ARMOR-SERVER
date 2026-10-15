/**
 * A.R.M.O.R. state persistence: the security mode and the last observation of
 * every node survive a restart. The file is written atomically; a damaged or
 * foreign file is ignored, never trusted.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { durableRename, keepBackup } from "./durable.js";

export type PersistedNode = {
  node_id: string; online: boolean; timestamp_ms: number; lux: number | null;
  target_count: number; alert_level: "normal" | "review" | "high"; received_at_ms: number;
  status: "online" | "offline" | "stale"; high_since_ms: number | null;
};
/** Where a node's own web panel is, as the node said itself: kept so that a node switched off while the server restarts is still known by its address. */
export type PersistedPanel = { name: string; firmware: string; ip: string; port: number };
export type PersistedState = { schema: 1; mode: "disarmed" | "armed"; revision: number; nodes: PersistedNode[]; panels?: Record<string, PersistedPanel> };

export interface StatePersistence {
  load(): PersistedState | undefined;
  /** `immediate` is for the security mode, which must never be lost; node data may be coalesced. */
  save(state: PersistedState, immediate: boolean): void;
  flush(): void;
}

const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const isNode = (value: unknown): value is PersistedNode => {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  return typeof node.node_id === "string" && NODE_ID.test(node.node_id) && typeof node.online === "boolean"
    && Number.isFinite(node.timestamp_ms) && Number.isFinite(node.received_at_ms) && Number.isInteger(node.target_count)
    && (node.lux === null || Number.isFinite(node.lux)) && ["normal", "review", "high"].includes(node.alert_level as string)
    && ["online", "offline", "stale"].includes(node.status as string)
    && (node.high_since_ms === null || Number.isFinite(node.high_since_ms));
};

export function parsePersisted(text: string): PersistedState | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.schema !== 1 || (value.mode !== "armed" && value.mode !== "disarmed") || !Number.isInteger(value.revision) || !Array.isArray(value.nodes)) return undefined;
    if (!value.nodes.every(isNode)) return undefined;
    // The addresses of the panels are an extra: an entry that is not well formed is dropped, never the whole file.
    const panels: Record<string, PersistedPanel> = {};
    if (value.panels && typeof value.panels === "object") {
      for (const [id, panel] of Object.entries(value.panels as Record<string, unknown>)) {
        const item = panel as Record<string, unknown> | null;
        if (NODE_ID.test(id) && item && typeof item.name === "string" && typeof item.firmware === "string" && typeof item.ip === "string" && Number.isInteger(item.port)) panels[id] = { name: item.name, firmware: item.firmware, ip: item.ip, port: item.port as number };
      }
    }
    return { ...(value as unknown as PersistedState), panels };
  } catch { return undefined; }
}

export class FileStatePersistence implements StatePersistence {
  readonly #file: string;
  readonly #delayMs: number;
  readonly #warn: (message: string) => void;
  #pending: PersistedState | undefined;
  /** The file on the disk is one this run wrote or read well: only then does it become the backup (a damaged file never replaces a good copy). */
  #goodOnDisk = true;
  #timer: NodeJS.Timeout | undefined;

  constructor(file: string, options: { delayMs?: number; warn?: (message: string) => void } = {}) {
    this.#file = file;
    this.#delayMs = options.delayMs ?? 750;
    this.#warn = options.warn ?? (() => undefined);
  }

  /**
   * The state of the last run. A file that is there but cannot be read or understood is not "nothing": the previous good copy (state.json.bak) is used, and when there is none either
   * the server starts ARMED, because starting disarmed after a power cut that damaged the file is exactly how a house ends up open.
   */
  load(): PersistedState | undefined {
    let text: string | undefined;
    try { text = fs.readFileSync(this.#file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;   // first start
      this.#warn("state.json could not be read");
      this.#goodOnDisk = false;
    }
    const state = text === undefined ? undefined : parsePersisted(text);
    if (state) return state;
    if (text !== undefined) { this.#warn("state.json is damaged or unrecognised"); this.#goodOnDisk = false; }
    try {
      const backup = parsePersisted(fs.readFileSync(`${this.#file}.bak`, "utf8"));
      if (backup) { this.#warn("the previous good copy (state.json.bak) is used"); return backup; }
    } catch { /* there is no copy */ }
    this.#warn("there is no readable copy of the state: starting ARMED, with no nodes");
    return { schema: 1, mode: "armed", revision: 0, nodes: [], panels: {} };
  }

  save(state: PersistedState, immediate: boolean): void {
    this.#pending = state;
    if (immediate) return this.flush();
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.flush(), this.#delayMs);
    this.#timer.unref();
  }

  flush(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    const state = this.#pending;
    if (!state) return;
    this.#pending = undefined;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      if (this.#goodOnDisk) keepBackup(this.#file);
      durableRename(temporary, this.#file);
      this.#goodOnDisk = true;
    } catch { this.#warn("state.json could not be written"); }
  }
}
