/**
 * The panel of a field node, reached through the server: an administrator who is outside the house opens /api/v1/nodes/<id>/panel/ and sees the web panel of that node without
 * the node being published anywhere. The server decides where the request goes (the address of the node comes from a list kept by an administrator, never from the request, so
 * the proxy cannot be used to reach the router or any other machine), talks to the node over HTTPS pinned to the fingerprint of its certificate, keeps the cookie of the node on
 * its own side (the browser never sees it and the node never sees the cookies of the server) and writes down every change.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import type { Express, Request, Response } from "express";
import type { AppContext } from "./context.js";
import { durableRename } from "./durable.js";

export type PanelScheme = "http" | "https";
export type PanelEntry = { id: string; address: string; scheme: PanelScheme; port: number; /** SHA-256 of the certificate the node showed when the administrator trusted it, 64 lowercase hexadecimal digits. */ fingerprint?: string; label?: string };

const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;
const MAX_PANELS = 64;
/** Open panels at the same time (one per person and node), how long a panel lives without being used, and how long the node may take to answer. */
const MAX_JARS = 10;
const JAR_IDLE_MS = 15 * 60_000;
const READ_TIMEOUT_MS = 15_000, UPLOAD_TIMEOUT_MS = 120_000;
const SMALL_BODY = 64 * 1024, BIG_BODY = 8 * 1024 * 1024;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE"]);
/** What a session from outside the house may not touch unless the policy of the installation is "full": the things that change the node itself. */
const DANGEROUS = /^api\/v1\/(ota|factory-reset|reboot|users|account|ble-pin|setup|config)(\/|$)/;

/** 64 hexadecimal digits (with or without colons, in any case) written the one way. */
export function normaliseFingerprint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.replace(/:/g, "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/** The part of the path after "/panel", checked: no ".." in any disguise, no double slash, no backslash and no control character. Returns the path and the query, or undefined. */
export function cleanPanelPath(rest: string): { path: string; query: string } | undefined {
  const cut = rest.indexOf("?");
  const pathPart = cut < 0 ? rest : rest.slice(0, cut), query = cut < 0 ? "" : rest.slice(cut + 1);
  if (pathPart !== "" && !pathPart.startsWith("/")) return undefined;
  if (query.length > 2048 || /[\r\n\0 ]/.test(query)) return undefined;
  const target = pathPart === "" ? "/" : pathPart;
  if (target.length > 512 || target.includes("//") || !/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(target)) return undefined;
  for (const segment of target.split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return undefined; }
    if (decoded === ".." || decoded === "." || /[\\/\0-\x1f\x7f]/.test(decoded)) return undefined;
  }
  return { path: target, query };
}

/** The list of the nodes whose panel may be opened, kept by an administrator. */
export class PanelRegistry {
  readonly #file: string;
  readonly #entries = new Map<string, PanelEntry>();
  constructor(file: string, allowLoopback = false) {
    this.#file = file;
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { panels?: unknown };
      if (Array.isArray(stored.panels)) {
        for (const item of stored.panels.slice(0, MAX_PANELS)) {
          const entry = PanelRegistry.check(item, allowLoopback);
          if (entry) this.#entries.set(entry.id, entry);
        }
      }
    } catch { /* nothing registered yet */ }
  }

  /** An entry as it must be, or undefined. The loopback address is accepted only when the tests ask for it. */
  static check(item: unknown, allowLoopback = false): PanelEntry | undefined {
    if (typeof item !== "object" || item === null) return undefined;
    const { id, address, scheme, port, fingerprint, label } = item as Record<string, unknown>;
    if (typeof id !== "string" || !NODE_ID.test(id)) return undefined;
    if (typeof address !== "string" || !(PRIVATE_V4.test(address) || (allowLoopback && address === "127.0.0.1"))) return undefined;
    if (address.split(".").some(part => Number(part) > 255)) return undefined;
    if (scheme !== "http" && scheme !== "https") return undefined;
    const number = port === undefined ? (scheme === "https" ? 443 : 80) : Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65_535) return undefined;
    const pinned = fingerprint === undefined ? undefined : normaliseFingerprint(fingerprint);
    if (fingerprint !== undefined && !pinned) return undefined;
    return { id, address, scheme, port: number, ...(pinned ? { fingerprint: pinned } : {}), ...(typeof label === "string" && label.trim() ? { label: label.trim().slice(0, 60) } : {}) };
  }

  list(): PanelEntry[] { return [...this.#entries.values()].map(entry => ({ ...entry })); }
  get(id: string): PanelEntry | undefined { const entry = this.#entries.get(id); return entry ? { ...entry } : undefined; }
  set(entry: PanelEntry): boolean {
    if (!this.#entries.has(entry.id) && this.#entries.size >= MAX_PANELS) return false;
    this.#entries.set(entry.id, entry);
    this.#save();
    return true;
  }
  remove(id: string): boolean { const gone = this.#entries.delete(id); if (gone) this.#save(); return gone; }

  #save(): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, panels: [...this.#entries.values()] }), { encoding: "utf8", mode: 0o600 });
    durableRename(temporary, this.#file);
  }
}

/** Asks a node for the certificate it shows (nothing is sent to it), to show the administrator the fingerprint before it is trusted. */
export function fetchFingerprint(address: string, port: number, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: address, port, rejectUnauthorized: false, servername: "", timeout: timeoutMs }, () => {
      const hex = normaliseFingerprint(socket.getPeerCertificate().fingerprint256);
      socket.end();
      if (hex) resolve(hex); else reject(new Error("no certificate"));
    });
    socket.on("timeout", () => { socket.destroy(); reject(new Error("timeout")); });
    socket.on("error", error => reject(error));
  });
}

type Jar = { cookies: Map<string, string>; last: number };

/** What the node answered, or why it could not be reached. */
class UpstreamError extends Error { constructor(readonly code: "fingerprint_mismatch" | "not_pinned" | "unreachable" | "timeout" | "too_large") { super(code); } }

export function registerNodePanelRoutes(app: Express, context: AppContext): void {
  const { config, audit, studioUser, studioSessions, requireAdmin, requireElevated } = context;
  const testPort = () => (process.env.ARMOR_ADMIN_NODE_PORT ? Number(process.env.ARMOR_ADMIN_NODE_PORT) : 0);
  const registry = new PanelRegistry(path.join(config.dataDir, "node_panels.json"), testPort() > 0);
  const jars = new Map<string, Jar>();
  const busyWrites = new Set<string>();
  const actor = (request: Request) => studioUser(request)?.username;
  const body = (request: Request): Record<string, unknown> => (typeof request.body === "object" && request.body !== null && !Buffer.isBuffer(request.body) ? request.body as Record<string, unknown> : {});
  const elevatedOrNot = (request: Request, response: Response): boolean => { let ok = false; requireElevated(request, response, () => { ok = true; }); return ok; };

  const sweep = (): void => {
    const now = Date.now();
    for (const [key, jar] of jars) if (now - jar.last > JAR_IDLE_MS) jars.delete(key);
  };

  // ---- the list of nodes whose panel can be opened (administrators; changing it asks for a new proof of identity from outside) ------------------------------
  app.get("/api/v1/admin/node-panels", requireAdmin, (_request, response) => { response.setHeader("Cache-Control", "no-store"); return response.json({ panels: registry.list() }); });

  app.put("/api/v1/admin/node-panels/:id", requireAdmin, requireElevated, (request, response) => {
    const input = body(request);
    const entry = PanelRegistry.check({ ...input, id: String(request.params.id ?? "") }, testPort() > 0);
    if (!entry) return response.status(422).json({ error: "invalid_panel" });
    // An address or a scheme that changed needs the certificate to be trusted again.
    const before = registry.get(entry.id);
    if (before && (before.address !== entry.address || before.port !== entry.port) && !("fingerprint" in input)) delete entry.fingerprint;
    if (!registry.set(entry)) return response.status(409).json({ error: "too_many_panels" });
    for (const key of [...jars.keys()]) if (key.endsWith(`|${entry.id}`)) jars.delete(key);
    audit.record({ action: "admin.node-panel.set", outcome: "allowed", actor: actor(request), target: entry.id, detail: `${entry.scheme} ${entry.address}:${entry.port}${entry.fingerprint ? " pinned" : ""}` });
    return response.json(entry);
  });

  /** Looks at the certificate the node shows now and (when `trust` is true) remembers it: the first time it is trusted from inside the house, the administrator comparing it with the one the node shows in its panel. */
  app.post("/api/v1/admin/node-panels/:id/fingerprint", requireAdmin, requireElevated, async (request, response) => {
    const entry = registry.get(String(request.params.id ?? ""));
    if (!entry) return response.status(404).json({ error: "unknown_panel" });
    if (entry.scheme !== "https") return response.status(422).json({ error: "not_https" });
    try {
      const seen = await fetchFingerprint(entry.address, entry.port);
      const trust = body(request).trust === true;
      if (trust) {
        registry.set({ ...entry, fingerprint: seen });
        for (const key of [...jars.keys()]) if (key.endsWith(`|${entry.id}`)) jars.delete(key);
        audit.record({ action: "admin.node-panel.trust", outcome: "allowed", actor: actor(request), target: entry.id, detail: seen.slice(0, 16) });
      }
      return response.json({ fingerprint: seen, trusted: trust, previous: entry.fingerprint ?? null, changed: entry.fingerprint !== undefined && entry.fingerprint !== seen });
    } catch { return response.status(502).json({ error: "unreachable" }); }
  });

  app.delete("/api/v1/admin/node-panels/:id", requireAdmin, requireElevated, (request, response) => {
    const id = String(request.params.id ?? "");
    if (!registry.remove(id)) return response.status(404).json({ error: "unknown_panel" });
    for (const key of [...jars.keys()]) if (key.endsWith(`|${id}`)) jars.delete(key);
    audit.record({ action: "admin.node-panel.remove", outcome: "allowed", actor: actor(request), target: id });
    return response.sendStatus(204);
  });

  // ---- the proxy ----------------------------------------------------------------------------------------------------------------------------------------
  const forward = (entry: PanelEntry, request: Request, target: { path: string; query: string }, jar: Jar, limit: number, timeoutMs: number): Promise<http.IncomingMessage> => new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: entry.address, "User-Agent": "armor-server", Connection: "close", Accept: String(request.header("accept") ?? "*/*").slice(0, 200) };
    if (jar.cookies.size > 0) headers.Cookie = [...jar.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    // Only what the panel needs: the type and length of a body, the language and the marker the node asks for against forged requests. Never the cookies, Origin, Referer or Authorization of the browser.
    const contentType = request.header("content-type"), length = request.header("content-length"), marker = request.header("x-requested-with");
    if (contentType) headers["Content-Type"] = contentType.slice(0, 200);
    if (length && /^\d{1,9}$/.test(length)) headers["Content-Length"] = length;
    if (marker) headers["X-Requested-With"] = marker.slice(0, 40);
    const language = request.header("accept-language");
    if (language) headers["Accept-Language"] = language.slice(0, 80);
    const options: http.RequestOptions = { host: entry.address, port: entry.port, method: request.method, path: target.path + (target.query ? `?${target.query}` : ""), headers, timeout: timeoutMs };
    const start = (connection?: tls.TLSSocket) => {
      // The socket is already connected and checked: the request only writes on it (the check of the name and of the chain is the one made above, by fingerprint).
      const outgoing = connection ? https.request({ ...options, rejectUnauthorized: false, checkServerIdentity: () => undefined, agent: false, createConnection: () => connection }) : http.request(options);
      let sent = 0;
      outgoing.on("response", reply => resolve(reply));
      outgoing.on("timeout", () => { outgoing.destroy(); reject(new UpstreamError("timeout")); });
      outgoing.on("error", () => reject(new UpstreamError("unreachable")));
      if (request.method === "GET" || request.method === "HEAD" || request.method === "DELETE") { outgoing.end(); return; }
      request.on("data", (chunk: Buffer) => {
        sent += chunk.length;
        if (sent > limit) { request.unpipe(outgoing); outgoing.destroy(); reject(new UpstreamError("too_large")); }
      });
      request.pipe(outgoing);
    };
    if (entry.scheme !== "https") return start();
    if (!entry.fingerprint) return reject(new UpstreamError("not_pinned"));
    // The certificate of a node is its own: nothing is sent until the connection is made and the certificate is the one the administrator trusted (Node does not ask the
    // name of a certificate it already refuses, so the check is made here, on the connected socket, before the request is written).
    const pinned = entry.fingerprint;
    const socket = tls.connect({ host: entry.address, port: entry.port, rejectUnauthorized: false, servername: "", timeout: timeoutMs }, () => {
      if (normaliseFingerprint(socket.getPeerCertificate().fingerprint256) !== pinned) { socket.destroy(); return reject(new UpstreamError("fingerprint_mismatch")); }
      start(socket);
    });
    socket.on("timeout", () => { socket.destroy(); reject(new UpstreamError("timeout")); });
    socket.on("error", () => reject(new UpstreamError("unreachable")));
  });

  const handle = async (request: Request, response: Response): Promise<unknown> => {
    const id = String(request.params.nodeId ?? "");
    const entry = NODE_ID.test(id) ? registry.get(id) : undefined;
    if (!entry) return response.status(404).json({ error: "unknown_panel" });
    if (!METHODS.has(request.method)) return response.status(405).json({ error: "method_not_allowed" });
    const prefix = `/api/v1/nodes/${id}/panel`;
    const rest = request.originalUrl.slice(prefix.length);
    if (rest === "") return response.redirect(308, `${prefix}/`);
    const target = cleanPanelPath(rest);
    if (!target) return response.status(400).json({ error: "bad_path" });
    const relative = target.path.replace(/^\//, "");
    const write = request.method !== "GET" && request.method !== "HEAD";
    const remote = studioSessions.originOf(request) === "remote";
    // The things that change the node itself stay in the house (or on the VPN) unless the installation allows everything from outside.
    if (remote && config.remotePolicy !== "full" && (DANGEROUS.test(relative) || (write && relative.startsWith("api/")) )) {
      audit.record({ action: "node-panel.blocked", outcome: "denied", actor: actor(request), target: id, detail: `${request.method} ${relative}` });
      return response.status(403).json({ error: "this is only possible from the house or over the VPN", code: "remote_policy", needs: "vpn" });
    }
    sweep();
    const handleOf = studioSessions.handleOf(request);
    if (!handleOf) return response.status(401).json({ error: "sign in first" });
    const key = `${handleOf}|${id}`;
    let jar = jars.get(key);
    // A new panel from outside the house asks for a new proof of identity; the open panel then goes on without asking again until it has sat unused.
    if (!jar) {
      if (!elevatedOrNot(request, response)) return undefined;
      if (jars.size >= MAX_JARS) { const oldest = [...jars.entries()].sort((a, b) => a[1].last - b[1].last)[0]; if (oldest) jars.delete(oldest[0]); }
      jar = { cookies: new Map(), last: Date.now() };
      jars.set(key, jar);
      try { context.connections.panelOpened(context.sightingOf(request, actor(request)), id); } catch { /* the history never stops the panel */ }
      audit.record({ action: "node-panel.open", outcome: "allowed", actor: actor(request), target: id, detail: `${studioSessions.originOf(request)} ${request.ip ?? ""}` });
    }
    jar.last = Date.now();
    const upload = relative === "api/v1/ota" || relative === "api/v1/config/import";
    if (write && Number(request.header("content-length") ?? 0) > (upload ? BIG_BODY : SMALL_BODY)) return response.status(413).set("Connection", "close").json({ error: "too_large" });
    if (write && busyWrites.has(id)) return response.status(429).set("Retry-After", "2").json({ error: "node_busy" });
    if (write) busyWrites.add(id);
    try {
      const reply = await forward(entry, request, target, jar, upload ? BIG_BODY : SMALL_BODY, upload ? UPLOAD_TIMEOUT_MS : READ_TIMEOUT_MS);
      // The cookie of the node stays here: it is kept for this person and this node only.
      for (const cookie of reply.headers["set-cookie"] ?? []) {
        const pair = cookie.split(";")[0] ?? "";
        const cut = pair.indexOf("=");
        if (cut < 1) continue;
        const name = pair.slice(0, cut).trim(), value = pair.slice(cut + 1).trim();
        if (/^Max-Age=0$/im.test(cookie) || value === "") jar.cookies.delete(name); else if (jar.cookies.size < 8 && value.length <= 512) jar.cookies.set(name, value);
      }
      if (write && relative.startsWith("api/")) {
        audit.record({ action: "node-panel.write", outcome: (reply.statusCode ?? 500) < 400 ? "allowed" : "failed", actor: actor(request), target: id, detail: `${request.method} ${relative} ${reply.statusCode ?? 0} ${request.ip ?? ""}` });
      }
      const status = reply.statusCode ?? 502;
      const location = reply.headers.location;
      for (const name of ["content-type", "content-length", "content-disposition", "etag", "last-modified"]) { const value = reply.headers[name]; if (typeof value === "string") response.setHeader(name, value); }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Frame-Options", "SAMEORIGIN");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'");
      // A redirect of the node (always to a path of the node) is kept inside the panel.
      if (status >= 300 && status < 400 && typeof location === "string" && /^\/(?!\/)/.test(location)) response.setHeader("Location", `${prefix}${location}`);
      response.status(status);
      if (request.method === "HEAD") return response.end();
      reply.pipe(response);
      return undefined;
    } catch (error) {
      if (!(error instanceof UpstreamError)) return response.status(502).json({ error: "unreachable" });
      if (error.code === "fingerprint_mismatch") {
        audit.record({ action: "node-panel.fingerprint", outcome: "denied", actor: actor(request), target: id, detail: `the certificate of ${entry.address} is not the one that was trusted` });
        return response.status(502).json({ error: "the node shows a different certificate from the one that was trusted", code: "fingerprint_mismatch" });
      }
      if (error.code === "not_pinned") return response.status(409).json({ error: "trust the certificate of the node first", code: "not_pinned" });
      if (error.code === "too_large") return response.status(413).set("Connection", "close").json({ error: "too_large" });
      return response.status(error.code === "timeout" ? 504 : 502).json({ error: error.code });
    } finally { if (write) busyWrites.delete(id); }
  };

  app.all(["/api/v1/nodes/:nodeId/panel", "/api/v1/nodes/:nodeId/panel/*rest"], requireAdmin, (request, response) => { void handle(request, response); });
}
