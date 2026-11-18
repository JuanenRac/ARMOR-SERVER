/**
 * The second origin of the node panels. A node serves its own pages and scripts; through the proxy they used to be answered under the origin of the API, so the script of a node
 * ran with the session of the administrator who opened it. While the option panel.separate_origin is on, the panels are answered by a second listener (another port, or another
 * name through ARMOR_PANEL_ORIGIN) that holds no session of the API: a page of a node there has nothing to ask the API with, and the API refuses what comes from that origin.
 *
 * The way in is a ticket: the administrator asks the API for one (it checks the session, the proof of identity and the panel), it is good for one use and a few seconds, and the
 * panel origin exchanges it for a cookie of its own, valid for that node only, and sends the browser on to the panel with the ticket gone from the address.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import express, { type Express, type Request, type Response } from "express";
import type { ArmorConfig } from "./config.js";
import { requestCookies } from "./http/auth.js";

/** How long a ticket can be exchanged, how long a panel session lives without being used, and how many of each are kept. */
export const PANEL_TICKET_TTL_MS = 30_000;
export const PANEL_SESSION_IDLE_MS = 15 * 60_000;
const MAX_TICKETS = 64, MAX_SESSIONS = 32;
export const PANEL_COOKIE = "armor_panel_sid";
const TICKET_SHAPE = /^[A-Za-z0-9_-]{20,64}$/;

/** What a ticket and the session made from it stand for: the node, the session of Studio that asked and where it came from. */
export type PanelGrant = { nodeId: string; handle: string; actor: string | undefined; remote: boolean };

/** Only a digest is kept: the ticket itself exists in the answer to the administrator and in one request, and nowhere else. */
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Tickets of one use. */
export class PanelTickets {
  readonly #entries = new Map<string, PanelGrant & { expires: number }>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  constructor(now: () => number = Date.now, ttlMs: number = PANEL_TICKET_TTL_MS) { this.#now = now; this.#ttlMs = ttlMs; }

  get size(): number { return this.#entries.size; }
  get ttlMs(): number { return this.#ttlMs; }

  issue(grant: PanelGrant): string {
    this.sweep();
    while (this.#entries.size >= MAX_TICKETS) { const oldest = this.#entries.keys().next().value; if (oldest === undefined) break; this.#entries.delete(oldest); }
    const ticket = randomBytes(32).toString("base64url");
    this.#entries.set(digest(ticket), { ...grant, expires: this.#now() + this.#ttlMs });
    return ticket;
  }

  /** The grant of a ticket that is valid now; the ticket is spent whatever the answer (a second try, or a late one, finds nothing). */
  consume(ticket: string): PanelGrant | undefined {
    const key = digest(ticket);
    const found = this.#entries.get(key);
    this.#entries.delete(key);
    if (!found || found.expires <= this.#now()) return undefined;
    return { nodeId: found.nodeId, handle: found.handle, actor: found.actor, remote: found.remote };
  }

  sweep(): void { const now = this.#now(); for (const [key, entry] of this.#entries) if (entry.expires <= now) this.#entries.delete(key); }
  clear(): void { this.#entries.clear(); }
}

/** The panels that are open: the cookie of the panel origin stands for one of these. */
export class PanelSessions {
  readonly #entries = new Map<string, PanelGrant & { last: number }>();
  readonly #now: () => number;
  readonly #idleMs: number;
  constructor(now: () => number = Date.now, idleMs: number = PANEL_SESSION_IDLE_MS) { this.#now = now; this.#idleMs = idleMs; }

  get size(): number { return this.#entries.size; }

  create(grant: PanelGrant): string {
    this.sweep();
    while (this.#entries.size >= MAX_SESSIONS) { const oldest = this.#entries.keys().next().value; if (oldest === undefined) break; this.#entries.delete(oldest); }
    const id = randomBytes(32).toString("base64url");
    this.#entries.set(digest(id), { ...grant, last: this.#now() });
    return id;
  }

  /** The grant of an open session for that node (a cookie made for one node opens no other), renewed by being used. */
  get(id: string, nodeId: string): PanelGrant | undefined {
    const key = digest(id);
    const found = this.#entries.get(key);
    if (!found) return undefined;
    if (this.#now() - found.last > this.#idleMs) { this.#entries.delete(key); return undefined; }
    if (found.nodeId !== nodeId) return undefined;
    found.last = this.#now();
    return { nodeId: found.nodeId, handle: found.handle, actor: found.actor, remote: found.remote };
  }

  end(id: string): void { this.#entries.delete(digest(id)); }
  endNode(nodeId: string): void { for (const [key, entry] of this.#entries) if (entry.nodeId === nodeId) this.#entries.delete(key); }
  sweep(): void { const now = this.#now(); for (const [key, entry] of this.#entries) if (now - entry.last > this.#idleMs) this.#entries.delete(key); }
  clear(): void { this.#entries.clear(); }
}

/** Whether an Origin header names the origin that is asked (its host and port are the Host of the request, or it is the public address that was configured). */
export function isOwnOrigin(origin: string, host: string | undefined, publicOrigin: string | null): boolean {
  try {
    const parsed = new URL(origin);
    return (host !== undefined && parsed.host === host) || (publicOrigin !== null && parsed.origin === publicOrigin);
  } catch { return false; }
}

export type PanelOriginDeps = {
  tickets: PanelTickets;
  sessions: PanelSessions;
  /** The option panel.separate_origin, read at every request: turned off, the origin answers nothing even before its listener is closed. */
  enabled: () => boolean;
  cookieSecure: boolean;
  publicOrigin: string | null;
  /** Whether the session of Studio that asked for the panel is still open. */
  alive: (handle: string) => boolean;
  record: (action: string, outcome: "allowed" | "denied", actor: string | undefined, target: string, detail?: string) => void;
  /** Passes the request on to the node (the same proxy the API used), with the grant that was made for it. */
  serve: (request: Request, response: Response, grant: PanelGrant) => Promise<unknown>;
};

/** The application of the second origin: the exchange of a ticket and the panels. Nothing else is answered, and no CORS header is ever given. */
export function buildPanelOriginApp(deps: PanelOriginDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "no-store" });
    if (!deps.enabled()) return response.status(404).json({ error: "not_found" });
    // A page of another origin (the API, Studio or any other) may not use the cookie of a panel: what the browser sends from elsewhere is refused before anything is read.
    const origin = request.headers.origin;
    if (origin !== undefined && !isOwnOrigin(origin, request.headers.host, deps.publicOrigin)) {
      deps.record("node-panel.blocked", "denied", undefined, "panel-origin", `origin ${String(origin).slice(0, 80)}`);
      return response.status(403).json({ error: "this origin is not the one of the panels", code: "origin_mismatch" });
    }
    return next();
  });

  app.get("/enter/:ticket", (request, response) => {
    const ticket = String(request.params.ticket ?? "");
    const grant = TICKET_SHAPE.test(ticket) ? deps.tickets.consume(ticket) : undefined;
    if (!grant || !deps.alive(grant.handle)) {
      deps.record("node-panel.ticket", "denied", grant?.actor, grant?.nodeId ?? "?", "not valid");
      return response.status(403).json({ error: "this ticket is not valid any more: open the panel again from Studio", code: "ticket_invalid" });
    }
    const id = deps.sessions.create(grant);
    // The cookie belongs to this origin and to the path of this node only; the address the browser ends on does not carry the ticket.
    response.cookie(PANEL_COOKIE, id, { httpOnly: true, sameSite: "strict", secure: deps.cookieSecure, maxAge: PANEL_SESSION_IDLE_MS, path: `/panel/${grant.nodeId}` });
    deps.record("node-panel.ticket", "allowed", grant.actor, grant.nodeId, "exchanged");
    return response.redirect(303, `/panel/${grant.nodeId}/`);
  });

  app.all(["/panel/:nodeId", "/panel/:nodeId/*rest"], (request, response) => {
    const nodeId = String(request.params.nodeId ?? "");
    const id = requestCookies(request)[PANEL_COOKIE];
    const grant = id ? deps.sessions.get(id, nodeId) : undefined;
    if (!id || !grant) return response.status(401).json({ error: "open the panel again from Studio", code: "ticket_required" });
    if (!deps.alive(grant.handle)) { deps.sessions.end(id); return response.status(401).json({ error: "the session of Studio that opened this panel ended", code: "session_ended" }); }
    void deps.serve(request, response, grant);
    return undefined;
  });

  app.use((_request, response) => { response.status(404).json({ error: "not_found" }); });
  app.use((_error: unknown, _request: Request, response: Response, _next: express.NextFunction) => { response.status(500).json({ error: "internal error" }); });
  return app;
}

/** The listener of the second origin: open while the option is on, closed (and everything it held forgotten) when it is not. */
export class PanelOrigin {
  readonly #options: { config: ArmorConfig; enabled: () => boolean; app: Express; onClosed: () => void; warn: (message: string) => void };
  #server: Server | undefined;
  #opening: Promise<void> | undefined;
  #retryAt = 0;

  constructor(options: { config: ArmorConfig; enabled: () => boolean; app: Express; onClosed: () => void; warn: (message: string) => void }) { this.#options = options; }

  /** The port it listens on, or undefined while it is closed. */
  get port(): number | undefined {
    const address = this.#server?.address();
    return address && typeof address === "object" ? (address as AddressInfo).port : undefined;
  }

  /** Brings the listener to what the option says. Safe to call as often as wanted. */
  async sync(): Promise<void> {
    if (this.#options.enabled()) { await this.#open(); return; }
    await this.close();
  }

  #open(): Promise<void> {
    if (this.#server) return Promise.resolve();
    if (this.#opening) return this.#opening;
    if (Date.now() < this.#retryAt) return Promise.resolve();
    const { config, app } = this.#options;
    const server = config.tls
      ? (createHttpsServer({ cert: fs.readFileSync(config.tls.certPath), key: fs.readFileSync(config.tls.keyPath) }, app) as unknown as Server)
      : createServer(app);
    this.#opening = new Promise<void>(resolve => {
      server.once("error", error => {
        // The port is taken or cannot be opened: said once, tried again in half a minute, and the tickets are refused meanwhile (the API answers 503).
        this.#retryAt = Date.now() + 30_000;
        this.#options.warn(`ARMOR_PANEL_ORIGIN=UNAVAILABLE port=${config.panelPort} ${error instanceof Error ? error.message : "cannot listen"}`);
        this.#opening = undefined;
        resolve();
      });
      server.listen(config.panelPort, config.host, () => {
        this.#server = server;
        server.on("error", () => undefined);   // a socket that fails later is that socket's loss, not the server's
        this.#opening = undefined;
        resolve();
      });
    });
    return this.#opening;
  }

  async close(): Promise<void> {
    if (this.#opening) await this.#opening;
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    this.#options.onClosed();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
