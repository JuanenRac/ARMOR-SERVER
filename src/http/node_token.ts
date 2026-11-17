/**
 * A token of its own for each node. The shared ingest token sits in the flash of every board, so whoever reads one board can speak as any node over HTTP. A node's own token is
 * HMAC-SHA256(key of this server, "armor-node:" + node id): the key is a file of this server (`node-token.key`, 64 hex digits, 0600, made the first time it is needed) that is never
 * given to a board, so the token of a node cannot be worked out from the shared token or from another board. An administrator reads the token to provision a node, and it is good only
 * for that node's id. With ARMOR_INGEST_STRICT=1 the shared token is no longer accepted by the routes nodes speak to, and a node that does not hold its own cannot read what another
 * node should see (the logins of the network inspection).
 * The tokens that older versions handed out were HMAC-SHA256(shared ingest token, "armor-node:" + node id). While the strict mode is off they are still taken, but as the shared token
 * is (they prove nothing a board with the shared token could not prove), and the node is listed as one that still has to be given its new token; with the strict mode on they are refused.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { durableRename } from "../durable.js";
import { hasBearer, type HeaderSource } from "./auth.js";

/** The token an older version derived from the shared ingest token. */
export const legacyNodeTokenFor = (ingestToken: string, nodeId: string): string => createHmac("sha256", ingestToken).update(`armor-node:${nodeId}`).digest("hex");

/** The token of a node under a key of this server (64 hex digits). */
export const nodeTokenOf = (keyHex: string, nodeId: string): string => createHmac("sha256", Buffer.from(keyHex, "hex")).update(`armor-node:${nodeId}`).digest("hex");

/** The key the node tokens come from: a file of this server, made the first time a token is asked for or checked and never given to a board. */
export class NodeTokens {
  #key: string | undefined;
  constructor(private readonly file: string) { this.#key = this.#read(); }

  #read(): string | undefined {
    try { const text = fs.readFileSync(this.file, "utf8").trim(); return /^[0-9a-f]{64}$/.test(text) ? text : undefined; } catch { return undefined; }
  }

  #ensure(): string {
    if (this.#key) return this.#key;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, randomBytes(32).toString("hex"), { mode: 0o600 });
    durableRename(temporary, this.file);
    this.#key = this.#read();
    if (!this.#key) throw new Error("the key of the node tokens cannot be read");
    return this.#key;
  }

  /** The token of one node, to be given to that node and no other. */
  tokenFor(nodeId: string): string { return nodeTokenOf(this.#ensure(), nodeId); }
}

export type IngestCaller = "node" | "shared" | null;

/** Who speaks: the node itself (its own token for the id it claims), the shared token (a board that was provisioned the old way), or nobody. */
export function ingestCaller(request: HeaderSource, ingestToken: string, strict: boolean, nodeId: unknown, tokens: Pick<NodeTokens, "tokenFor">): IngestCaller {
  const valid = typeof nodeId === "string" && /^[a-z0-9][a-z0-9:._-]{0,63}$/.test(nodeId);
  if (valid && hasBearer(request, tokens.tokenFor(nodeId))) return "node";
  if (!strict && (hasBearer(request, ingestToken) || (valid && hasBearer(request, legacyNodeTokenFor(ingestToken, nodeId))))) return "shared";
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
