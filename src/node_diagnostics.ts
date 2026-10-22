/**
 * The latest diagnostic package and the latest log each node delivered when an administrator asked for them (a `diagnostics` order with `detail` package or log). They are kept in memory only: a
 * restart of the server forgets them, and nothing here is written to a file. What is kept is exactly what the strict reader accepted (see node_diag_contract.ts), so a member a node added on its
 * own is not here; a diagnostic token (see diagnostic_tokens.ts) reads this and nothing else of the node.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import type { DiagnosticPackage } from "./node_diag_contract.js";

export type StoredDiagnostic = { at: string; requested_by: string; data: DiagnosticPackage };
export type NodeDiagnostics = { package?: StoredDiagnostic; log?: StoredDiagnostic };

export class NodeDiagnosticsStore {
  readonly #nodes = new Map<string, NodeDiagnostics>();
  readonly #now: () => number;
  readonly #max: number;

  constructor(options: { now?: () => number; maxNodes?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#max = options.maxNodes ?? 64;
  }

  /** Keeps what a node delivered, in the slot of its kind. Throws when a new node arrives and the store is full. */
  keep(node: string, data: DiagnosticPackage, requestedBy: string): void {
    if (!this.#nodes.has(node) && this.#nodes.size >= this.#max) throw new Error("too many nodes");
    const entry = this.#nodes.get(node) ?? {};
    entry[data.detail] = { at: new Date(this.#now()).toISOString(), requested_by: requestedBy, data: structuredClone(data) };
    this.#nodes.set(node, entry);
  }

  get(node: string): NodeDiagnostics {
    const entry = this.#nodes.get(node);
    return entry ? structuredClone(entry) : {};
  }

  /** When each kind was delivered, without the content (for a list). */
  when(node: string): { package_at?: string; log_at?: string } {
    const entry = this.#nodes.get(node);
    return { ...(entry?.package ? { package_at: entry.package.at } : {}), ...(entry?.log ? { log_at: entry.log.at } : {}) };
  }

  forget(node: string): void { this.#nodes.delete(node); }
}
