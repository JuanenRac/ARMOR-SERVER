/**
 * A token of its own for each node. The shared ingest token sits in the flash of every board, so whoever reads one board can speak as any node over HTTP. A node's own token is
 * HMAC-SHA256(ingest token, "armor-node:" + node id): the server works it out from the shared one (nothing more to store), an administrator reads it to provision a node, and it is
 * good only for that node's id. With ARMOR_INGEST_STRICT=1 the shared token is no longer accepted by the routes nodes speak to, and a node that does not hold its own cannot read what
 * another node should see (the logins of the network inspection).
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHmac } from "node:crypto";
import { hasBearer, type HeaderSource } from "./auth.js";

export const nodeTokenFor = (ingestToken: string, nodeId: string): string => createHmac("sha256", ingestToken).update(`armor-node:${nodeId}`).digest("hex");

export type IngestCaller = "node" | "shared" | null;

/** Who speaks: the node itself (its own token for the id it claims), the shared token (a board that was provisioned the old way), or nobody. */
export function ingestCaller(request: HeaderSource, ingestToken: string, strict: boolean, nodeId: unknown): IngestCaller {
  if (typeof nodeId === "string" && /^[a-z0-9][a-z0-9:._-]{0,63}$/.test(nodeId) && hasBearer(request, nodeTokenFor(ingestToken, nodeId))) return "node";
  if (!strict && hasBearer(request, ingestToken)) return "shared";
  return null;
}

/**
 * Which nodes still speak with the shared token. Every message that is accepted on the shared token is noted by node id (the id the message claims, when it has a valid one),
 * so Studio can list the boards that have to be given their own token before the strict mode is turned on. A node that later speaks with its own token leaves the list.
 */
export class SharedTokenWatch {
  readonly #seen = new Map<string, { last: number; count: number }>();
  readonly #onFirst: (nodeId: string) => void;
  constructor(onFirst: (nodeId: string) => void = () => undefined, readonly max = 256) { this.#onFirst = onFirst; }

  /** Notes who spoke and how: only the shared token adds to the list, a node's own token removes the node from it. */
  note(nodeId: unknown, caller: IngestCaller, now: number): void {
    const id = typeof nodeId === "string" && /^[a-z0-9][a-z0-9:._-]{0,63}$/.test(nodeId) ? nodeId : "";
    if (caller === "node") { if (id) this.#seen.delete(id); return; }
    if (caller !== "shared") return;
    const key = id || "(no node id)";
    const entry = this.#seen.get(key);
    if (entry) { entry.last = now; entry.count++; return; }
    if (this.#seen.size >= this.max) return;
    this.#seen.set(key, { last: now, count: 1 });
    this.#onFirst(key);
  }

  list(): { node_id: string; last_seen: string; messages: number }[] {
    return [...this.#seen.entries()].map(([node_id, value]) => ({ node_id, last_seen: new Date(value.last).toISOString(), messages: value.count })).sort((a, b) => a.node_id.localeCompare(b.node_id));
  }
}
