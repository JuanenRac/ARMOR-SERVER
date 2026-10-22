/**
 * Read-only diagnostic tokens: what an administrator hands to a person (or a tool) that has to look at why a node misbehaves without being given an account.
 *
 * What a token IS: a secret of 32 random bytes (`armor-diag-` and 43 characters), shown ONCE when it is issued. The server keeps only its SHA-256, so a copy of the data folder does not
 * contain a token that can be used, and a lost token cannot be shown again: it is revoked and replaced.
 * What it can do: read, with GET and nothing else, the health, the latest diagnostic package and the latest log of the nodes the administrator chose, until it expires (300 s to 24 h, 2 h when
 * the request says nothing) or is revoked. What it cannot do: order anything to any node, change anything, read another node, read anything of the house (alarms, cameras, users, settings),
 * issue or revoke a token, or reach the panel of a node. It never reaches a node at all: it reads what the server already holds.
 * Every issue, revocation, first use (and one use in ten minutes after that) and every refusal goes to the audit trail and the History; the token itself goes nowhere.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuditLog } from "./audit.js";
import { JsonFile } from "./history.js";
import { NODE_ID, PERSON } from "./node_control.js";

export const TOKEN_PREFIX = "armor-diag-";
const TOKEN_SHAPE = /^armor-diag-[A-Za-z0-9_-]{43}$/;
export const TTL_MIN_S = 300;
export const TTL_MAX_S = 86_400;
export const TTL_DEFAULT_S = 7_200;
export const MAX_NODES_PER_TOKEN = 16;
export const MAX_ACTIVE_TOKENS = 20;
/** How long a token that ended (expired or revoked) stays in the list, so the list says what happened to it. */
export const KEEP_ENDED_MS = 7 * 24 * 3_600_000;
const USE_AUDIT_EVERY_MS = 10 * 60_000;
const LABEL = /^[A-Za-z0-9._@ -]{1,48}$/;
const ID = /^[a-f0-9]{12}$/;

export class DiagnosticError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export type TokenRecord = {
  id: string; hash: string; nodes: string[]; label?: string; created_at: string; expires_at: string; created_by: string; revoked_at?: string; revoked_by?: string; uses: number; last_used_at?: string;
};
/** One line of the list (ARMOR-COMMON's diagnostic_token_info): never the secret and never its hash. */
export type TokenInfo = {
  id: string; scope: "read_only"; nodes: string[]; label?: string; created_at: string; expires_at: string; created_by: string; status: "active" | "expired" | "revoked"; revoked_at?: string; revoked_by?: string; uses: number; last_used_at?: string;
};
/** The answer to an issue (ARMOR-COMMON's diagnostic_token_created): the only moment the secret is shown. */
export type TokenCreated = { id: string; token: string; scope: "read_only"; nodes: string[]; label?: string; created_at: string; expires_at: string; created_by: string };
export type TokenRequest = { nodes: string[]; ttl_s?: number; label?: string };

export type TokenCheck = { ok: true; id: string; nodes: string[] } | { ok: false; reason: "unknown" | "expired" | "revoked" | "scope" | "rate_limited" };

/** The body of a request for a token, read strictly: only the three names, one to sixteen different valid nodes, a time inside the limits and a plain label. */
export function readTokenRequest(body: unknown): TokenRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new DiagnosticError("invalid_request", "the request must be an object");
  const given = body as Record<string, unknown>;
  for (const key of Object.keys(given)) if (!["nodes", "ttl_s", "label"].includes(key)) throw new DiagnosticError("invalid_request", `${key} is not a field of this request`);
  const nodes = given.nodes;
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > MAX_NODES_PER_TOKEN) throw new DiagnosticError("invalid_request", `nodes must name one to ${MAX_NODES_PER_TOKEN} nodes`);
  if (nodes.some(node => typeof node !== "string" || !NODE_ID.test(node) || node === "all")) throw new DiagnosticError("invalid_request", "a node is named by its id (letters, digits, - and _)");
  if (new Set(nodes).size !== nodes.length) throw new DiagnosticError("invalid_request", "a node is named once");
  let ttl = TTL_DEFAULT_S;
  if (given.ttl_s !== undefined) {
    if (typeof given.ttl_s !== "number" || !Number.isInteger(given.ttl_s) || given.ttl_s < TTL_MIN_S || given.ttl_s > TTL_MAX_S) throw new DiagnosticError("invalid_request", `ttl_s is ${TTL_MIN_S} to ${TTL_MAX_S} seconds`);
    ttl = given.ttl_s;
  }
  let label: string | undefined;
  if (given.label !== undefined) {
    if (typeof given.label !== "string" || !LABEL.test(given.label)) throw new DiagnosticError("invalid_request", "the label is up to 48 letters, digits, spaces and . _ @ -");
    label = given.label;
  }
  return { nodes: [...nodes] as string[], ttl_s: ttl, ...(label !== undefined ? { label } : {}) };
}

export const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** The token as it travels: `Authorization: Bearer armor-diag-...`. Anything else is not a token. */
export function bearerOf(header: string | undefined): string | undefined {
  if (!header || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice(7).trim();
  return TOKEN_SHAPE.test(token) ? token : undefined;
}

export type DiagnosticTokensOptions = {
  file?: string;
  now?: () => number;
  /** 32 random bytes for a token and 6 for its id; replaceable by a test. */
  random?: (bytes: number) => Buffer;
  audit: AuditLog;
  /** How many requests one token may make in a minute (default 30). */
  perMinute?: number;
  maxActive?: number;
};

export class DiagnosticTokens {
  readonly #records = new Map<string, TokenRecord>();
  readonly #byHash = new Map<string, string>();
  readonly #uses = new Map<string, number[]>();
  readonly #auditedUse = new Map<string, number>();
  readonly #failures = new Map<string, number[]>();
  readonly #file?: JsonFile<{ schema: 1; tokens: TokenRecord[] }>;
  readonly #o: Required<Omit<DiagnosticTokensOptions, "file">>;

  constructor(options: DiagnosticTokensOptions) {
    this.#o = { now: options.now ?? Date.now, random: options.random ?? (bytes => randomBytes(bytes)), audit: options.audit, perMinute: options.perMinute ?? 30, maxActive: options.maxActive ?? MAX_ACTIVE_TOKENS };
    if (options.file) {
      this.#file = new JsonFile(options.file);
      this.#load();
    }
  }

  #load(): void {
    const saved = this.#file?.read();
    if (!saved || typeof saved !== "object" || !Array.isArray(saved.tokens)) return;
    for (const item of saved.tokens.slice(0, 200)) {
      const record = readRecord(item);
      if (record) { this.#records.set(record.id, record); this.#byHash.set(record.hash, record.id); }
    }
    this.sweep();
  }

  #save(): void {
    try { this.#file?.write({ schema: 1, tokens: [...this.#records.values()] }); } catch { /* the tokens are also in memory; the next change writes again */ }
  }

  #statusOf(record: TokenRecord, now: number): TokenInfo["status"] {
    if (record.revoked_at) return "revoked";
    return Date.parse(record.expires_at) <= now ? "expired" : "active";
  }

  /** Issues a token for the nodes asked: the secret is in the answer and nowhere else. Throws a DiagnosticError when there are too many active tokens. */
  issue(request: TokenRequest, actor: string): TokenCreated {
    const now = this.#o.now();
    const ttl = request.ttl_s ?? TTL_DEFAULT_S;
    if (!Number.isInteger(ttl) || ttl < TTL_MIN_S || ttl > TTL_MAX_S) throw new DiagnosticError("invalid_request", `ttl_s is ${TTL_MIN_S} to ${TTL_MAX_S} seconds`);
    this.sweep();
    const active = [...this.#records.values()].filter(record => this.#statusOf(record, now) === "active").length;
    if (active >= this.#o.maxActive) throw new DiagnosticError("too_many_tokens", `there are already ${this.#o.maxActive} active tokens: revoke one first`, 409);
    let id = this.#o.random(6).toString("hex");
    while (this.#records.has(id)) id = this.#o.random(6).toString("hex");
    const token = TOKEN_PREFIX + this.#o.random(32).toString("base64url");
    const created = new Date(now).toISOString(), expires = new Date(now + ttl * 1000).toISOString();
    const by = PERSON.test(actor) ? actor : "administrator";
    const record: TokenRecord = { id, hash: hashToken(token), nodes: [...request.nodes].sort(), ...(request.label !== undefined ? { label: request.label } : {}), created_at: created, expires_at: expires, created_by: by, uses: 0 };
    this.#records.set(id, record);
    this.#byHash.set(record.hash, id);
    this.#save();
    this.#o.audit.record({ action: "diagnostics.token_issue", outcome: "allowed", actor: by, target: id, detail: `read-only, ${request.nodes.length} node(s), ${ttl}s` });
    return { id, token, scope: "read_only", nodes: [...record.nodes], ...(record.label !== undefined ? { label: record.label } : {}), created_at: created, expires_at: expires, created_by: by };
  }

  list(): TokenInfo[] {
    this.sweep();
    const now = this.#o.now();
    return [...this.#records.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(record => ({
      id: record.id, scope: "read_only" as const, nodes: [...record.nodes], ...(record.label !== undefined ? { label: record.label } : {}), created_at: record.created_at, expires_at: record.expires_at, created_by: record.created_by,
      status: this.#statusOf(record, now), ...(record.revoked_at ? { revoked_at: record.revoked_at, revoked_by: record.revoked_by } : {}), uses: record.uses, ...(record.last_used_at ? { last_used_at: record.last_used_at } : {}),
    }));
  }

  /** Ends a token now. False when there is none of that id or it had ended already. */
  revoke(id: string, actor: string): boolean {
    const record = ID.test(id) ? this.#records.get(id) : undefined;
    const by = PERSON.test(actor) ? actor : "administrator";
    if (!record || this.#statusOf(record, this.#o.now()) !== "active") {
      this.#o.audit.record({ action: "diagnostics.token_revoke", outcome: "failed", actor: by, target: ID.test(id) ? id : undefined });
      return false;
    }
    record.revoked_at = new Date(this.#o.now()).toISOString();
    record.revoked_by = by;
    this.#save();
    this.#o.audit.record({ action: "diagnostics.token_revoke", outcome: "allowed", actor: by, target: id });
    return true;
  }

  /**
   * Whether a secret is a token that may read `node` now. A refusal says why to the caller of this class (the route answers the same words for every refusal, so a stranger learns nothing about which
   * tokens exist). A token that is good is counted, and one that makes more than `perMinute` requests in a minute is held back.
   */
  verify(secret: string | undefined, node?: string): TokenCheck {
    const now = this.#o.now();
    if (!secret || !TOKEN_SHAPE.test(secret)) return { ok: false, reason: "unknown" };
    const hash = hashToken(secret);
    const id = this.#byHash.get(hash);
    const record = id ? this.#records.get(id) : undefined;
    // The comparison is made on the hashes, in constant time, even though the lookup already found it: nothing about a near miss is learnt from the time.
    if (!record || !timingSafeEqual(Buffer.from(record.hash, "hex"), Buffer.from(hash, "hex"))) return { ok: false, reason: "unknown" };
    const status = this.#statusOf(record, now);
    if (status === "revoked") return { ok: false, reason: "revoked" };
    if (status === "expired") return { ok: false, reason: "expired" };
    if (node !== undefined && !record.nodes.includes(node)) { this.#denied(record.id, "scope"); return { ok: false, reason: "scope" }; }
    const recent = (this.#uses.get(record.id) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= this.#o.perMinute) { this.#uses.set(record.id, recent); return { ok: false, reason: "rate_limited" }; }
    recent.push(now);
    this.#uses.set(record.id, recent);
    record.uses += 1;
    record.last_used_at = new Date(now).toISOString();
    if (now - (this.#auditedUse.get(record.id) ?? -Infinity) >= USE_AUDIT_EVERY_MS) {
      this.#auditedUse.set(record.id, now);
      this.#o.audit.record({ action: "diagnostics.token_use", outcome: "allowed", actor: `token ${record.id}`, target: record.id });
      this.#save();
    }
    return { ok: true, id: record.id, nodes: [...record.nodes] };
  }

  /**
   * Whether an address has made too many refused attempts lately (twenty in a minute): a stranger guessing tokens is slowed down, and a good token held by the same address waits with it.
   * A refused attempt weighs five (an unknown, expired or revoked secret) or one (a good token asked for a node it does not cover).
   */
  blocked(key: string): boolean {
    const now = this.#o.now();
    return (this.#failures.get(key) ?? []).filter(at => now - at < 60_000).length >= 20;
  }

  failed(key: string, weight = 5): void {
    const now = this.#o.now();
    const recent = (this.#failures.get(key) ?? []).filter(at => now - at < 60_000);
    for (let i = 0; i < weight; i += 1) recent.push(now);
    this.#failures.set(key, recent);
    if (this.#failures.size > 2000) for (const [name, list] of this.#failures) if (list.every(at => now - at >= 60_000)) this.#failures.delete(name);
  }

  /** The id of the token a secret is, when it is one that exists (for the audit line of a refusal); never says anything of a secret that is not. */
  idOf(secret: string | undefined): string | undefined {
    return secret && TOKEN_SHAPE.test(secret) ? this.#byHash.get(hashToken(secret)) : undefined;
  }

  #denied(id: string, why: string): void {
    this.#o.audit.record({ action: "diagnostics.token_denied", outcome: "denied", actor: `token ${id}`, target: id, detail: why });
  }

  /** Audits a refusal of a token that exists (an expired or revoked one, or one asked for a node it does not cover). A secret that is not a token is not audited one by one: the rate limit of the route holds it. */
  refused(id: string | undefined, why: string): void {
    if (id) this.#denied(id, why);
  }

  /** Forgets what ended a week ago and what a restart should not keep. */
  sweep(): void {
    const now = this.#o.now();
    let changed = false;
    for (const [id, record] of this.#records) {
      const ended = record.revoked_at ? Date.parse(record.revoked_at) : Date.parse(record.expires_at);
      if (this.#statusOf(record, now) !== "active" && now - ended > KEEP_ENDED_MS) { this.#records.delete(id); this.#byHash.delete(record.hash); this.#uses.delete(id); this.#auditedUse.delete(id); changed = true; }
    }
    if (changed) this.#save();
  }

  /** A node taken away is taken out of the tokens that named it; a token with no node left is revoked. */
  forgetNode(node: string, actor = "administrator"): void {
    for (const record of this.#records.values()) {
      if (!record.nodes.includes(node)) continue;
      record.nodes = record.nodes.filter(item => item !== node);
      if (record.nodes.length === 0 && !record.revoked_at) { record.revoked_at = new Date(this.#o.now()).toISOString(); record.revoked_by = actor; }
    }
    this.#save();
  }

  flush(): void { this.#save(); }
}

const ISO = /^\d{4}-\d{2}-\d{2}T[0-9:.]{8,12}Z$/;

/** A record read back from the file, or nothing when it is damaged (one damaged token loses only itself). */
function readRecord(value: unknown): TokenRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id) || typeof r.hash !== "string" || !/^[a-f0-9]{64}$/.test(r.hash)) return undefined;
  if (!Array.isArray(r.nodes) || r.nodes.length > MAX_NODES_PER_TOKEN || r.nodes.some(node => typeof node !== "string" || !NODE_ID.test(node))) return undefined;
  if (typeof r.created_at !== "string" || !ISO.test(r.created_at) || typeof r.expires_at !== "string" || !ISO.test(r.expires_at) || typeof r.created_by !== "string" || !PERSON.test(r.created_by)) return undefined;
  if (r.revoked_at !== undefined && (typeof r.revoked_at !== "string" || !ISO.test(r.revoked_at))) return undefined;
  if (r.revoked_by !== undefined && (typeof r.revoked_by !== "string" || !PERSON.test(r.revoked_by))) return undefined;
  if (r.label !== undefined && (typeof r.label !== "string" || !LABEL.test(r.label))) return undefined;
  if (typeof r.uses !== "number" || !Number.isInteger(r.uses) || r.uses < 0) return undefined;
  if (r.last_used_at !== undefined && (typeof r.last_used_at !== "string" || !ISO.test(r.last_used_at))) return undefined;
  // A token never lives longer than a day: a file that says otherwise was not written by this server.
  if (Date.parse(r.expires_at) - Date.parse(r.created_at) > TTL_MAX_S * 1000) return undefined;
  return {
    id: r.id, hash: r.hash, nodes: [...(r.nodes as string[])], ...(r.label !== undefined ? { label: r.label as string } : {}), created_at: r.created_at, expires_at: r.expires_at, created_by: r.created_by,
    ...(r.revoked_at !== undefined ? { revoked_at: r.revoked_at as string } : {}), ...(r.revoked_by !== undefined ? { revoked_by: r.revoked_by as string } : {}), uses: r.uses, ...(r.last_used_at !== undefined ? { last_used_at: r.last_used_at as string } : {}),
  };
}
